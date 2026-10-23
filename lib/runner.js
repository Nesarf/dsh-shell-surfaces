// Running one command on one surface, and turning the process outcome into
// something a reader can act on.
//
// Three decisions are deliberate here:
//
//   * `spawn` with an argv array, never a shell string. The command text is
//     handed to the surface's own shell as a single argument, so nothing on this
//     side gets to re-interpret quotes, pipes or backslashes. This is the whole
//     reason the tool exists: the same thing typed through pwsh into wsl.exe is
//     where `/mnt/e/x.sh` used to become `C:/Program Files/Git/mnt/e/x.sh`.
//   * Output is bounded on this side, with the full text kept in a spill file
//     when it overflows. Returning 40 MB to a model helps nobody.
//   * A timeout is reported as a timeout, not as a failure of the command. The
//     two lead to different next actions.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_BUFFER = 8 * 1024 * 1024;

/** Where spill files go: beside the harness home when one is given, else the user's own directory. */
function spillDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const dir = join(home, 'library', 'tmp', 'shell-surfaces');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* the spill file is a courtesy, not a requirement */
  }
  return dir;
}

export function decode(buffer) {
  // The producers here are asked for UTF-8 (LANG=C.UTF-8 on the MSYS family,
  // native UTF-8 elsewhere). A Windows program reached through a surface may
  // still answer in the OEM code page, which shows up as replacement characters
  // rather than as an exception -- so this is a best effort, and the raw byte
  // count is reported alongside when the text shrinks unexpectedly.
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
}

function bound(text, limit, label) {
  if (text.length <= limit) return { text, truncated: false, spill: '' };
  const dir = spillDir();
  const file = join(dir, `${label}-${Date.now()}.txt`);
  try {
    writeFileSync(file, text, 'utf8');
  } catch {
    return { text: text.slice(0, limit), truncated: true, spill: '(spill file could not be written)' };
  }
  const head = text.slice(0, Math.floor(limit * 0.75));
  const tail = text.slice(-Math.floor(limit * 0.2));
  return {
    text: `${head}\n\n... [${text.length - head.length - tail.length} characters omitted; full output at ${file}] ...\n\n${tail}`,
    truncated: true,
    spill: file,
  };
}

/**
 * Spawn one child and start collecting its output. Returned instead of a bare
 * promise because two callers need the live process: the foreground run, which
 * may hand it over on a timeout, and the background job, which streams it into
 * the job's output ring.
 * @param argv - the executable and its arguments, never a command line.
 * @param options - environment and working directory for the child.
 * @returns the live process, its accumulating output, and a settlement promise.
 */
export function spawnProc(argv, options) {  const started = Date.now();
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd || undefined,
      env: options.env,
      windowsHide: true,
      // A surface may need to hand its command over as DATA rather than as an
      // argument: wsl.exe recomposes the words it was handed into one command
      // line and that line is parsed again inside the distribution, so an
      // argument is not safe for text containing `$`. stdin is a pipe whenever
      // there is something to write there, ignored otherwise.
      stdio: [typeof options.stdin === 'string' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return {
      child: void 0,
      out: [],
      err: [],
      started,
      done: Promise.resolve({ spawnError: String(error?.message ?? error) }),
      snapshot: () => ({ stdout: '', stderr: '', overflow: false }),
    };
  }
  const out = [];
  const err = [];
  let outBytes = 0;
  let errBytes = 0;
  // The command travels as data when the surface asked for that: written once
  // and closed, so the shell reads it as its script and reaches EOF. A write to
  // a child that already exited is not an error worth reporting -- the exit code
  // says what happened.
  if (typeof options.stdin === 'string') {
    try {
      child.stdin.end(options.stdin, 'utf8');
    } catch {
      /* the child may have exited before the write; its exit code is the report */
    }
  }
  child.stdout?.on('data', (chunk) => {
    outBytes += chunk.length;
    if (outBytes <= MAX_BUFFER) out.push(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    errBytes += chunk.length;
    if (errBytes <= MAX_BUFFER) err.push(chunk);
  });
  const done = new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.on('error', (error) => settle({ spawnError: String(error?.message ?? error) }));
    child.on('close', (code) => settle({ exitCode: code }));
  });
  return {
    child,
    out,
    err,
    started,
    done,
    snapshot: () => ({
      stdout: decode(Buffer.concat(out)),
      stderr: decode(Buffer.concat(err)),
      overflow: outBytes > MAX_BUFFER || errBytes > MAX_BUFFER,
    }),
  };
}

function runChild(argv, options) {
  const proc = spawnProc(argv, options);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      // A promoted timeout leaves the process running and hands it to the
      // caller, which registers it as a background job. Everything else keeps
      // the original rule: kill the surface process, and report a grandchild
      // that outlives it as a timeout rather than hiding it.
      if (options.promoteOnTimeout === true && proc.child !== void 0) {
        const snap = proc.snapshot();
        settle({
          stdout: snap.stdout,
          stderr: snap.stderr,
          exitCode: null,
          timedOut: true,
          promoted: true,
          proc,
          ms: Date.now() - proc.started,
          overflow: snap.overflow,
        });
        return;
      }
      try {
        proc.child?.kill();
      } catch {
        /* already gone */
      }
      const snap = proc.snapshot();
      settle({
        stdout: snap.stdout,
        stderr: snap.stderr,
        exitCode: null,
        timedOut: true,
        ms: Date.now() - proc.started,
        overflow: snap.overflow,
      });
    }, options.timeoutMs);
    proc.done.then((outcome) => {
      const snap = proc.snapshot();
      settle({
        stdout: snap.stdout,
        stderr: snap.stderr,
        exitCode: outcome.exitCode ?? null,
        timedOut: false,
        spawnError: outcome.spawnError,
        ms: Date.now() - proc.started,
        overflow: snap.overflow,
      });
    });
  });
}

/** Split a command line the way a console expects: quotes group, nothing else does. */
function tokenize(text) {
  const tokens = [];
  let current = '';
  let quote = '';
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** Map a Windows path to the path the same file has inside a WSL distro. */
export function toWslPath(winPath) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return winPath;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/** Quote text as one POSIX shell word, so a shell that reads it later gets it verbatim. */
function posixQuote(text) {
  return `'${String(text).replace(/'/g, "'\\''")}'`;
}

/**
 * Build the argv for one surface. Exported so the test can assert the shape
 * without running anything.
 */
export function buildArgv(surfaceId, spec, options, baseEnv) {
  const { command, script, cwd, send } = options;
  const env = { ...(baseEnv ?? process.env), ...spec.env };

  if (surfaceId === 'wsl' || spec.distro !== void 0) {
    // The distro rides the surface entry, so `wsl-nyarch` and `wsl-debian` are
    // two surfaces; `wsl` itself keeps the deployment default.
    const distro = spec.distro ?? process.env.DSH_WSL_DISTRO ?? 'Nyarch';
    const argv = ['wsl.exe', '-d', distro];
    // Windows-side paths go in as Windows paths: MSYS is not in this chain (the
    // process tree here is node -> wsl.exe), so nothing rewrites them, and
    // wsl.exe's own --cd accepts a drive path and translates it itself.
    if (cwd) argv.push('--cd', cwd);
    if (script) {
      // A file is preferred over an inline string: no quoting layer at all, and
      // bash is asked to run it as a file rather than to parse it.
      argv.push('--', 'bash', toWslPath(script));
      return { argv, env };
    }
    // The command must NOT travel as an argument. wsl.exe recomposes the words
    // it was handed into one command line and hands that line to the
    // distribution, where it is parsed once more -- so `$VAR` was expanded by a
    // shell that had never run the loop defining it. Measured 2026-10-20:
    //   `for n in alpha beta; do echo "n=[$n]"; done`  printed n=[] twice
    //   `echo 'single=[$HOME]'`                        printed the value, so
    //                                                  even single quotes lost
    // while the same command on the msys surface answered alpha and beta. A
    // base64 wrapper behind `eval` did not help: that wrapper was re-parsed the
    // same way. stdin is the one channel wsl.exe does not rewrite, so the
    // command goes there and the shell reads it as its script.
    argv.push('--', 'bash', '-l', '-s');
    const body =
      spec.wslExec === void 0
        ? command
        : `exec ${[spec.wslExec.program, ...(spec.wslExec.argv ?? ['-c']), posixQuote(command)].join(' ')}`;
    return { argv, env, stdin: `${body}\n` };
  }

  if (surfaceId === 'pty') {
    const runner = join(import.meta.dirname, '..', 'scripts', 'pty_runner.py');
    const argv = [spec.exe, runner, '--timeout-ms', String(options.timeoutMs), '--settle-ms', String(options.settleMs ?? 4000)];
    for (const chunk of send) argv.push('--send', chunk);
    // The console gets an explicit argv list, never a command line: PyWinPTY
    // spawns exactly what it is handed, so "cmd /c ver" has to arrive as three
    // arguments. It travels base64-encoded because a Windows command line would
    // otherwise re-split it on spaces and eat the quotes -- which is the same
    // class of bug this whole plugin exists to remove.
    const ptyArgv = options.ptyArgv?.length ? options.ptyArgv : tokenize(options.script || command);
    if (ptyArgv.length === 0) throw new Error('pty: the command was empty after tokenizing');
    argv.push('--argv-json', Buffer.from(JSON.stringify(ptyArgv), 'utf8').toString('base64'));
    argv.push('--');
    return { argv, env };
  }

  // The shell surfaces: the command (or the script file) is one argv element.
  // A surface may need a different flag for a file than for a command line --
  // PowerShell wants `-File` for a .ps1 and `-Command` for text -- so the
  // script branch asks the surface for its own argv when it declares one.
  const flags = (script && spec.scriptArgv) || spec.argv || [];
  const argv = [spec.exe, ...flags, script || command];
  return { argv, env };
}

/**
 * The environment one surface runs with: its own entries, its PATH prefix, and
 * the UTF-8 request. Exported because the background path builds its argv and
 * spawns through the same rules as the foreground one.
 * @param spec - the surface entry from the table.
 * @returns an environment object safe to hand to `spawn`.
 */
export function prepareEnv(spec) {
  // The MSYS-family entries carry a PATH_PREFIX because their package trees are
  // separate: the shell lives in one bin directory while the coreutils it calls
  // live in another, and without the second the shell reports a healthy version
  // and then fails every external command. Lifted from this machine's dsh-shell.py,
  // which measured it the same way.
  const baseEnv = { ...process.env, ...spec.env };
  if (typeof spec.env?.PATH_PREFIX === 'string' && spec.env.PATH_PREFIX.length > 0) {
    baseEnv.PATH = `${spec.env.PATH_PREFIX};${process.env.PATH ?? ''}`;
  }
  return baseEnv;
}

export async function runSurface(surfaceId, spec, options) {
  const baseEnv = prepareEnv(spec);
  // A script file is handed to the surface as a path rather than as an inline
  // string, wherever the surface can take one: for the shell surfaces that is
  // the final argv element, and for `pty` the runner reads the file itself.
  const built = buildArgv(surfaceId, spec, options, baseEnv);

  // Confinement wraps the exact argv the surface will spawn, so it runs after
  // argv construction and before spawn. The caller supplies the wrap; a
  // provider that cannot enforce the requested mode rejects here, and that
  // rejection is reported rather than turned into an unconfined run.
  let spawnArgv = built.argv;
  let confined;
  if (typeof options.confine === 'function') {
    confined = await options.confine(built.argv);
    spawnArgv = confined.argv;
  }

  const result = await runChild(spawnArgv, {
    env: built.env,
    // A surface whose command travels as data (wsl) hands it over here; every
    // other surface has nothing on stdin and leaves it ignored.
    stdin: built.stdin,
    // The pty runner enforces its own budget and closes the console when it
    // expires; a tighter outer kill would cut the transcript off mid-prompt.
    timeoutMs: surfaceId === 'pty' ? options.timeoutMs + 15000 : options.timeoutMs,
    cwd: options.cwd,
    // Promotion is a shell-surface idea only: a console run has no clean
    // process to hand over, and its transcript belongs to the console.
    promoteOnTimeout: options.promoteOnTimeout === true && surfaceId !== 'pty',
  });

  // The pty runner reports through one JSON object, with the screen text inside
  // it. Unwrap that here so both kinds of surface reach `finish` in the same
  // shape, and so the caller's output budget applies to the transcript too.
  if (surfaceId === 'pty') {
    const report = parsePtyReport(result.stdout ?? '');
    if (report) {
      return finish(
        {
          ...result,
          exitCode: report.exitCode ?? null,
          timedOut: report.timedOut === true || result.timedOut === true,
          stdout: report.transcript ?? '',
          stderr: '',
          spawnError: report.spawnError || result.spawnError,
        },
        options,
        true,
      );
    }
    // No report means the runner itself never got to speak; say so instead of
    // presenting an empty screen as a successful run.
    return finish(
      {
        ...result,
        spawnError:
          result.spawnError ||
          `the pty runner printed no report (byte count ${(result.stdout ?? '').length}); its own error text is in stderr`,
      },
      options,
      true,
    );
  }

  return {
    ...finish({ ...result, argv: built.argv }, options, false),
    // Kept out of the model-facing result (the output schema does not declare
    // them): a promoted process is handed to the job registry, and a confined
    // wrap is explained by the executor, which owns the denial vocabulary.
    promoted: result.promoted === true,
    ...(confined !== void 0 ? { confined } : {}),
    ...(result.proc !== void 0 ? { proc: result.proc } : {}),
  };
}

/** Read the last JSON object the pty runner printed. */
function parsePtyReport(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* keep looking: a transcript line can start with a brace too */
    }
  }
  return null;
}

function finish(result, options, isPty) {
  const stdout = bound(result.stdout ?? '', options.maxOutputChars, 'out');
  const stderr = bound(result.stderr ?? '', Math.min(options.maxOutputChars, 20000), 'err');
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut === true,
    durationMs: result.ms ?? 0,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
    spill: stdout.spill,
    overflow: result.overflow === true,
    spawnError: result.spawnError ?? '',
    // The argv is reported because it is the part a caller cannot see: knowing
    // that the command crossed as one argument is what makes a quoting bug
    // impossible to blame on the surface.
    argv: result.argv ?? [],
    note: isPty
      ? 'the output is a console transcript: prompts are echoed and long lines wrap, so read it as a screen rather than as clean stdout'
      : '',
  };
}
