# dsh-shell-surfaces

[![test](https://github.com/Nesarf/dsh-shell-surfaces/actions/workflows/test.yml/badge.svg)](https://github.com/Nesarf/dsh-shell-surfaces/actions/workflows/test.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

`https://github.com/Nesarf/dsh-shell-surfaces` -- a DSH plugin, installed with
`dsh plugin --profile <profile> add github:Nesarf/dsh-shell-surfaces`.

The badge is the whole test workflow: the pure self-test, and the two-runner
probe that asks every shell on Windows and on Linux what it is. A green badge
therefore means "the table and the argv shape still hold, and both platforms
still answered", not just "the linter passed".

One DSH tool for the execution surfaces this machine has **besides pwsh**: a WSL
Linux userland, nushell's structured pipelines, the MSYS2 userland
(bash / zsh / fish / brush), and a real console for interactive programs.

It exists because a rule that is only written down is not a capability. The
selection rules for these surfaces have been recorded for a while, but a session
could only act on them by composing a command string for pwsh and hoping the
quoting survived the trip. Here they are callable.

```
shell_surfaces(action="surfaces")                    what exists here, and where each was looked for
shell_surfaces(action="run", surface="wsl",  command="grep -P '(?<=Linux )[0-9.]+' /proc/version")
shell_surfaces(action="run", surface="nu",   command="open data.json | where n > 3 | to json")
shell_surfaces(action="run", surface="msys", command="pacman -Q | wc -l")
shell_surfaces(action="run", surface="pty",  command="powershell -File install.ps1", send=["y\n"])
```

## Why one tool and not seven

Every registered tool spends part of the context on its description. Seven tools
would say the same thing seven times. The selection rules -- which surface for a
structured pipe, which for a Linux-only tool, which for a program that waits for
input -- live in this one description, and a session reads them exactly when it
is choosing.

## What it is not

* **No prompt injection and no message hooks.** It registers a tool and nothing
  else, so it cannot be the plugin that writes a malformed message.
* **No terminal emulator.** A terminal emulator draws text for a person and adds
  nothing a subprocess can use. The one surface that needs a console talks to
  ConPTY directly.

## The facts behind the argument lists

Each of these was measured on this machine, and each shapes the argv:

| Fact | Consequence |
| --- | --- |
| A command handed through a shell can be re-parsed twice | The command travels as **one argv element**; a script **file** is preferred over an inline string |
| MSYS2's `/tmp` follows `TMPDIR`, which this machine passes down as a Windows path | msys / zsh / fish run as **login** shells, which normalises the environment |
| brush has no Cygwin runtime beside it, so `/tmp` is `<drive>:\tmp` | brush gets **no** login flag and no POSIX-path assumptions; its PATH needs `usr\bin` as well as `ucrt64\bin`, or every external command fails while the shell reports a healthy version |
| `PtyProcess.read` blocks | Reading happens on its own thread; a read loop that also decides when to stop can block the very check that would stop it |
| A console wants Enter, which is a carriage return | `send` normalises a trailing newline (real, escaped, or literal) to CR, and a bare answer gets one added |
| `wsl.exe` sometimes prints the result and then declines to exit | A timeout **with** output is reported differently from a timeout **without** it; `wsl.exe --shutdown` is the reset (measured: a cold instance answered in 58 s, the same call after a reset in 8 s, and warm in 0.13 s) |

## Layout

| Path | What it is |
| --- | --- |
| `lib/index.js` | the tool: one `shell_surfaces`, actions `run` and `surfaces` |
| `lib/surfaces.js` | the table: paths, arguments, environments, and the absent-reason for each surface |
| `lib/runner.js` | argv construction, bounded output with spill, timeout classification |
| `scripts/pty_runner.py` | the console: pywinpty, a reader thread, ANSI stripping, one JSON report |
| `scripts/live-check.mjs` | runs one real command per surface through the plugin's own code path |
| `scripts/probe-all-shells.ps1` | asks every shell **and** terminal this machine has what it is; platform-shaped, one JSON object out |
| `scripts/probe-posix.sh`, `scripts/probe-wsl.sh` | the POSIX and WSL probes, as files, because an inline command crosses quoting layers and a `$()` gets expanded by the wrong one |
| `scripts/probe-table.mjs` | the probe's JSON as a markdown table, also written to `$GITHUB_STEP_SUMMARY` |
| `scripts/pty-gate.ps1` | the interactive fixture: a `Read-Host` prompt for the pty case |
| `test/surfaces-test.mjs` | the table, the argv shape, the tool contract |

## Verification

```
node test/surfaces-test.mjs          # no host needed; the host validator is asked too when reachable
node scripts/live-check.mjs          # one real command per surface on this machine
node scripts/live-check.mjs wsl nu   # or only some of them
pwsh -File scripts/probe-all-shells.ps1 | node scripts/probe-table.mjs   # every shell and terminal
```

CI runs the self-test, and runs the probe on both a Windows and a Linux runner
(the tables land in the run summary, so "which surfaces exist" is a record with
history rather than something a person measured once). Each runner also runs this
live check against every surface it actually has.

That last step reports four outcomes, not two: **pass**, **fail**, **absent** and
**skipped**. A surface a machine does not have is a fact about the machine
(`absent`, with the path that was looked for); a surface that exists but cannot be
exercised here -- a WSL launcher with no distribution, a python without pywinpty --
is also a fact about the machine (`skipped`, with the reason). A surface that ran
and answered wrongly is a fact about the plugin, and only that fails the job,
because a runner with nothing to run is not a broken build.

A pass also needs the expected *output*, not just exit code 0: `bash -c ""` exits
0, and the failures this check exists to catch (a command mangled by quoting,
output decoded as the wrong encoding) are exactly the ones that keep exit code 0.

Its table goes into the run summary beside the probe's, so "this runner is missing
half the surfaces, and here is why" is answerable without opening the log.


Every surface was also run for real (2026-10-15): wsl returned the kernel and a
`/proc` count, nu returned a number through a structured pipeline, msys returned
its bash version and a package count, zsh its parameter-expansion result, fish
its arithmetic result, brush an uppercased string, and pty answered a
`Read-Host` prompt with `y` and printed the branch it took.

## Honest boundaries

* **Windows-first.** The surfaces it knows about are this class of machine's: a
  WSL distro, MSYS2, nushell, and ConPTY. On POSIX the platform already ships a
  single shell, so most of this is unnecessary there.
* No isolation of its own: a command runs with the harness process's rights.
  The file sandbox and approval policy still apply to the process tree.
* MSYS-family output is assumed UTF-8 (`LANG=C.UTF-8` is set). A Windows program
  reached through a surface may still answer in the OEM code page.
* The MSYS2 surfaces need `DSH_MSYS_ROOT` if MSYS2 is not at `D:\msys64`;
  nushell needs `DSH_NU` if `nu.exe` is not in `%LOCALAPPDATA%\Programs\nu\bin`;
  the pty surface needs `python` on PATH with `pywinpty` installed.
