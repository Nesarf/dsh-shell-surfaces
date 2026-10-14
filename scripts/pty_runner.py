"""Give one command a real console, then report what the screen said.

    python pty_runner.py --timeout-ms 60000 --settle-ms 4000 --send "y\\n" \
        --argv-json <base64 of a JSON argv array>

Why this exists instead of a pipe: a pipe is not a console. Programs that ask a
question with [Console]::In.ReadLine() or Read-Host, full-screen TUIs, and
anything that addresses the cursor need a pseudo-console (ConPTY on Windows).
Installing a terminal emulator does not help -- that draws text for a person and
gives a subprocess nothing.

Two things are deliberate here, both learned by hanging on this machine:

  * Reading happens on a thread that only reads. `PtyProcess.read` is a blocking
    read, so a read loop that also decides when to stop can block the very check
    that would stop it (measured: an interactive prompt sat for 90 s with an 8 s
    budget already expired).
  * The report is printed exactly once, at the end, so a caller can always tell
    the report from the transcript. ANSI escape sequences are stripped, because
    colour and cursor addressing are noise once the screen is flattened.

The last line on stdout is one JSON object containing the transcript.
"""

from __future__ import annotations

import argparse
import json
import queue
import re
import sys
import threading
import time

ANSI = re.compile(
    r"\x1b\[[0-9;?]*[a-zA-Z]"                 # CSI: colour, cursor addressing, erase
    r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"     # OSC: window title, ended by BEL or ST
    r"|\x1b[()][A-Z0-9]"                      # charset selection
    r"|\x1b[=>]"                              # keypad modes
    r"|\r"                                    # carriage returns: the screen overwrote these
)


def strip_ansi(text: str) -> str:
    return ANSI.sub("", text)


class Screen:
    """A reader thread plus a queue: the main loop never blocks on the console."""

    def __init__(self, proc, debug: bool) -> None:
        self.proc = proc
        self.debug = debug
        self.chunks: list[str] = []
        self.queue: queue.Queue[str | None] = queue.Queue()
        self.done = threading.Event()
        self.thread = threading.Thread(target=self._pump, daemon=True)

    def _pump(self) -> None:
        while not self.done.is_set():
            try:
                data = self.proc.read(4096)
            except EOFError:
                break
            except Exception as error:  # noqa: BLE001 - a console that stops talking is not a crash
                if self.debug:
                    print(f"pty_runner: read stopped: {error}", file=sys.stderr)
                break
            if data:
                self.queue.put(data)
            else:
                time.sleep(0.02)
        self.queue.put(None)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.done.set()

    def harvest(self) -> None:
        while True:
            try:
                item = self.queue.get_nowait()
            except queue.Empty:
                return
            if item is None:
                return
            self.chunks.append(item)

    def settle(self, seconds: float) -> None:
        """Drain for a fixed slice of wall time. Used while the program starts
        and right after input is typed; the loop itself never blocks on read."""
        end = time.time() + seconds
        while time.time() < end:
            self.harvest()
            time.sleep(0.05)
        self.harvest()


def main() -> int:
    parser = argparse.ArgumentParser(prog="pty_runner")
    parser.add_argument("--timeout-ms", type=float, default=60000.0)
    parser.add_argument("--settle-ms", type=float, default=4000.0, help="how long to type nothing, so the prompt can appear")
    parser.add_argument("--settle-seconds", type=float, default=None, help="same thing in seconds (dsh-shell.py wording)")
    parser.add_argument("--send", action="append", default=[], help="text to type once settled; \\n means Enter; may repeat")
    parser.add_argument("--argv-json", default="", help="the command as a JSON argv array (base64 on Windows)")
    parser.add_argument("--debug", action="store_true", help="timings to stderr, for when a console will not answer")
    parser.add_argument("argv", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    argv = [a for a in args.argv if a != "--"]
    if args.argv_json:
        import base64

        raw = args.argv_json
        try:
            decoded = base64.b64decode(raw + "=" * (-len(raw) % 4)).decode("utf-8")
        except Exception:  # noqa: BLE001 - not base64? then it may already be JSON
            decoded = raw
        try:
            parsed = json.loads(decoded)
            if isinstance(parsed, list) and all(isinstance(x, str) for x in parsed) and parsed:
                argv = parsed
        except Exception as error:  # noqa: BLE001
            print(json.dumps({"ok": False, "spawnError": "argv-json was not a JSON string array: " + str(error)}))
            return 2
    if not argv:
        print("pty_runner: give a command after --", file=sys.stderr)
        return 2

    def say(message: str) -> None:
        if args.debug:
            print(f"pty_runner: {message}", file=sys.stderr)

    try:
        from winpty import PtyProcess
    except Exception as error:  # noqa: BLE001 - the message is the point
        print(json.dumps({
            "ok": False,
            "spawnError": "pywinpty is not importable by this python: " + str(error),
            "hint": "pip install pywinpty into the python on PATH",
        }))
        return 127

    budget_s = args.timeout_ms / 1000.0
    settle_ms = args.settle_seconds * 1000.0 if args.settle_seconds is not None else args.settle_ms
    started = time.time()
    deadline = started + budget_s

    try:
        # An argv list, not a command string: passing a quoted line here raises
        # FileNotFoundError, which is exactly the quoting trap this avoids.
        proc = PtyProcess.spawn(argv)
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "spawnError": str(error), "argv": argv}))
        return 1

    screen = Screen(proc, args.debug)
    screen.start()
    timed_out = False
    exit_code = None

    try:
        screen.settle(min(settle_ms / 1000.0, budget_s))
        say(f"settled after {time.time() - started:.1f}s")
        for chunk in args.send:
            # A console wants Enter, which is a carriage return -- and the text
            # arrives from a JSON argument, where a newline may be a real one, an
            # escaped one (`\n`), or a literal backslash-n. Measured: typing "y"
            # without the CR leaves Read-Host waiting and echoes the y back, which
            # looks like success in the transcript while the program is stuck.
            text = chunk.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\r")
            if text.endswith("\r\n") or text.endswith("\n"):
                text = text.rstrip("\r\n") + "\r"
            elif text.endswith("\r"):
                text = text[:-1] + "\r"
            else:
                # No newline at all: a bare answer to a prompt still needs Enter.
                text = text + "\r"
            try:
                proc.write(text)
            except Exception as error:  # noqa: BLE001
                say(f"write failed: {error}")
                break
            screen.settle(min(2.0, max(0.2, deadline - time.time())))
            say(f"sent {text!r} at {time.time() - started:.1f}s")
        while time.time() < deadline:
            screen.harvest()
            if not proc.isalive():
                break
            time.sleep(0.05)
        screen.settle(0.2)
        if proc.isalive():
            timed_out = True
        try:
            exit_code = proc.exitstatus
        except Exception as error:  # noqa: BLE001
            say(f"exitstatus unavailable: {error}")
    finally:
        screen.stop()
        # Closing a console that is still open must not become the thing that
        # hangs the caller: each step gets its own guard and the report is
        # printed either way.
        try:
            if proc.isalive():
                proc.terminate(force=True)
        except Exception as error:  # noqa: BLE001
            say(f"terminate failed: {error}")
        try:
            proc.close()
        except Exception as error:  # noqa: BLE001
            say(f"close failed: {error}")

    screen.harvest()
    transcript = strip_ansi("".join(screen.chunks))
    print(json.dumps({
        "ok": True,
        "exitCode": exit_code,
        "timedOut": timed_out,
        "spawnError": "",
        "argv": argv,
        "chars": len(transcript),
        "elapsedMs": int((time.time() - started) * 1000),
        "transcript": transcript,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
