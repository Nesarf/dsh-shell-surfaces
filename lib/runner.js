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
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

/**
 * The argv that starts a window host. No `start /min` wrapper: measured
 * 2026-10-24, `start` takes the quoted program path for its window TITLE and
 * then tries to launch the next word as a file -- it produced a "Windows cannot
 * find 'profile'" dialog and hung the caller. The window is minimised after the
 * fact instead, by {@link minimizeAfterLaunch}.
 * @returns the program and argv to spawn.
 */
function launchArgv(spec, program, args) {
  return [program, ...args];
}

/**
 * Minimise the window a surface opened, and only that one.
 *
 * None of these programs has a "start minimised" flag, so the only honest way is
 * to launch normally and then aim `ShowWindow(SW_MINIMIZE)` at the process this
 * tool started -- never at the user's own window. Fire and forget: a window that
 * stays visible is a cosmetic miss, not a failed run.
 * @param pid - the process this tool spawned.
 * @param match - a command-line substring, for a launch that handed the work to
 *   an instance which was already running (Tabby).
 */
function minimizeAfterLaunch(pid, match) {
  return new Promise((resolve) => {
    try {
      const script = join(import.meta.dirname, '..', 'scripts', 'minimize-window.ps1');
      const argv = [
        'powershell.exe',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-ProcessId',
        String(pid ?? 0),
      ];
      if (typeof match === 'string' && match !== '') argv.push('-Match', match);
      // NOT detached: measured 2026-10-24, a detached helper never got to run --
      // the call had already returned and the helper was gone with it. The wait
      // has to cover a cold start (a private Tabby instance takes ten seconds or
      // more to draw its window); once the window exists this returns in under a
      // second.
      const helper = spawn(argv[0], argv.slice(1), { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => {
        try {
          helper.kill();
        } catch {
          /* already gone */
        }
        resolve();
      }, 25000);
      helper.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      helper.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      /* the window stays visible; the run itself is unaffected */
      resolve();
    }
  });
}

/**
 * Split a command line the way a console expects: quotes group, nothing else does. */function tokenize(text) {
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
 * Write the command to a temporary file for a surface whose input is a FILE
 * rather than a command line. cscript is the one that needs this: `cscript
 * //nologo` takes a .vbs path and has no `-c`, so the code has to land somewhere
 * first. The caller owns the returned path and removes it once the run settles.
 * @returns the absolute path of the file that now holds the command.
 */
function writeInlineFile(command, ext) {
  const file = join(spillDir(), `inline-${randomBytes(6).toString('hex')}${ext}`);
  writeFileSync(file, command, 'utf8');
  return file;
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
  // A surface whose input is a FILE rather than a command line gets the command
  // written to a temporary file with the extension it expects, and that path is
  // what the surface is handed. `cleanup` travels with the argv so the caller can
  // remove it after the run settles.
  if (spec.inlineFile !== void 0 && !script) {
    const file = writeInlineFile(command, spec.inlineFile.ext ?? '.txt');
    return { argv: [spec.exe, ...flags, file], env, cleanup: [file] };
  }
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

/**
 * A terminal program that can be driven AND read back. WezTerm's own mux server
 * answers two questions a window cannot: `spawn` gives a pane a command,
 * `get-text` gives that pane's screen back.
 *
 * The trade is the same one the pty surface makes -- the answer is a screen
 * transcript, not clean stdout. What is different is that the pane must outlive
 * the command or its text is gone before it can be read: `cmd /k` keeps the pane
 * open, an end marker says when the command is done, and the pane is closed once
 * the marker shows up.
 * @returns a run result in the same shape runChild produces.
 */
async function runTerminalSurface(spec, options) {
  const started = Date.now();
  const nonce = randomBytes(6).toString('hex');
  const marker = `__DSS_END_${nonce}__`;
  const rcMarker = `__DSS_RC_${nonce}__`;
  // `%errorlevel%` is expanded when the whole line is PARSED, not when the echo
  // runs, so it reported the pane's starting code (measured: `cmd /c exit 3`
  // came back 0). `!errorlevel!` with /v:on expands at execution time, which is
  // the moment after the command has finished.
  const inner = `${options.command} & echo ${rcMarker}=!errorlevel! & echo ${marker}`;
  const argv = ['cli', 'spawn', '--pane-id', '0', '--', 'cmd', '/v:on', '/k', inner];
  const spawned = spawnSync(spec.exe, argv, { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const paneId =
    String(spawned.stdout ?? '')
      .trim()
      .split(/\r?\n/)
      .at(-1)
      ?.trim() ?? '';
  if (!/^\d+$/.test(paneId)) {
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      spawnError:
        `could not spawn a pane for the ${spec.summary} surface (${spec.exe}): ` +
        `${String(spawned.stderr || spawned.stdout || '').trim() || 'no answer'}`,
      ms: Date.now() - started,
      overflow: false,
      argv: [spec.exe, ...argv],
    };
  }
  let text = '';
  let timedOut = true;
  const deadline = started + options.timeoutMs;
  while (Date.now() < deadline) {
    const read = spawnSync(spec.exe, ['cli', 'get-text', '--pane-id', paneId], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    text = String(read.stdout ?? '');
    if (text.includes(marker)) {
      timedOut = false;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  spawnSync(spec.exe, ['cli', 'kill-pane', '--pane-id', paneId], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  // Everything after the marker is the shell's own prompt coming back, and the
  // marker lines themselves are ours: neither belongs in the answer.
  const upto = timedOut ? text : text.slice(0, text.indexOf(marker));
  const rcMatch = new RegExp(`${rcMarker}=(\\d+)`).exec(text);
  const exitCode = rcMatch === null ? null : Number(rcMatch[1]);
  const withoutRc = upto.replace(new RegExp(`^.*${rcMarker}=\\d+.*$\\n?`, 'm'), '');
  return {
    stdout: withoutRc.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim(),
    stderr: '',
    exitCode,
    timedOut,
    spawnError: '',
    ms: Date.now() - started,
    overflow: false,
    argv: [spec.exe, ...argv],
  };
}

/**
 * A host that can only START a process: a terminal window, an mshta host, a git
 * hook. The shim is the physical piece that lets its answer come back -- the
 * host runs `node scripts/dss-exec.mjs`, the shim runs the command and writes a
 * structured result, and this side polls for that file.
 *
 * This is the "open a path" recipe: any program that can launch an executable
 * can carry a command for this tool, because the result travels on disk instead
 * of on a screen.
 * @returns a run result in the same shape runChild produces.
 */
async function runShimSurface(spec, options) {
  const started = Date.now();
  const out = join(spillDir(), `shim-${randomBytes(6).toString('hex')}.json`);
  const shim = join(import.meta.dirname, '..', 'scripts', 'dss-exec.mjs');
  const argv = launchArgv(spec, spec.launch.program, [
    ...spec.launch.args,
    'node',
    shim,
    '--out',
    out,
    '--timeout',
    String(options.timeoutMs),
    '--cmd',
    options.command,
  ]);
  try {
    // Detached: the window is a display, not a child whose lifetime the caller
    // should be waiting on. The shim's result file is the thing waited for.
    const child = spawn(argv[0], argv.slice(1), { windowsHide: true, detached: true, stdio: 'ignore' });
    child.unref();
    if (spec.minimize === true) await minimizeAfterLaunch(child.pid);
  } catch (error) {
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      spawnError: `could not launch ${spec.summary}: ${String(error?.message ?? error)}`,
      ms: Date.now() - started,
      overflow: false,
      argv,
    };
  }
  // The shim enforces the command's own budget and writes the file when it is
  // done; this deadline is the outer wire, for the case where the window never
  // starts at all.
  const deadline = started + options.timeoutMs + 20000;
  while (Date.now() < deadline) {
    if (existsSync(out)) {
      try {
        const parsed = JSON.parse(readFileSync(out, 'utf8'));
        return {
          stdout: String(parsed.stdout ?? ''),
          stderr: String(parsed.stderr ?? ''),
          exitCode: parsed.exitCode ?? null,
          timedOut: parsed.timedOut === true,
          spawnError: String(parsed.spawnError ?? ''),
          ms: Number(parsed.durationMs ?? Date.now() - started),
          overflow: false,
          argv,
        };
      } catch {
        /* written halfway or not yet: the next round reads a complete file */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return {
    stdout: '',
    stderr: '',
    exitCode: null,
    timedOut: true,
    spawnError: '',
    ms: Date.now() - started,
    overflow: false,
    argv,
  };
}

/**
 * Tabby: a tab driven through its own CLI, using the same "fixed entry point, per
 * call job file" shape as the shim, with one extra hop.
 *
 * Tabby has no `-e` and no `new-tab -- <program>`, but it has `tabby profile
 * <name>`, and a local profile carries `options.command` + `options.args`. Those
 * are static, so the profile names a fixed agent (scripts/dss-tabby-agent.mjs)
 * once and every call only rewrites the job file that agent reads.
 *
 * `Tabby.exe profile dss` BLOCKS for the application's lifetime -- measured
 * 2026-10-24: the tab had already answered in 45 ms, yet the call sat until its
 * budget expired -- so the launch is detached and its output ignored. The result
 * file is the only thing this side waits on.
 * @returns a run result in the same shape runChild produces.
 */
async function runTabbySurface(spec, options) {
  const started = Date.now();
  const jobFile = process.env.DSS_TABBY_JOB ?? spec.jobFile;
  const resultFile = `${jobFile}.result`;
  const id = randomBytes(6).toString('hex');
  const argv = launchArgv(spec, spec.exe, [
    // Its own instance: the user's Tabby is never touched, and `bringToFront()`
    // on every `profile` open can only reach a window this tool owns.
    ...(typeof spec.userDataDir === 'string' ? [`--user-data-dir=${spec.userDataDir}`] : []),
    'profile',
    spec.tabbyProfile,
  ]);
  try {
    mkdirSync(dirname(jobFile), { recursive: true });
    writeFileSync(jobFile, JSON.stringify({ id, command: options.command, timeoutMs: options.timeoutMs }), 'utf8');
  } catch (error) {
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      spawnError: `could not write the Tabby job file (${jobFile}): ${String(error?.message ?? error)}`,
      ms: Date.now() - started,
      overflow: false,
      argv,
    };
  }
  // A stale result from an earlier call would be read as this one's answer.
  try {
    unlinkSync(resultFile);
  } catch {
    /* no previous result, which is the normal case */
  }
  try {
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (error) {
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      spawnError: `could not launch ${spec.summary}: ${String(error?.message ?? error)}`,
      ms: Date.now() - started,
      overflow: false,
      argv,
    };
  }
  // A cold Tabby start is slower than a warm one, so the outer wire is generous;
  // the agent enforces the command's own budget inside it.
  const deadline = started + options.timeoutMs + 30000;
  let answer = null;
  while (Date.now() < deadline) {
    if (existsSync(resultFile)) {
      try {
        const parsed = JSON.parse(readFileSync(resultFile, 'utf8'));
        if (String(parsed.id ?? '') === id) {
          answer = parsed;
          break;
        }
      } catch {
        /* written halfway or a previous call's file: the next round re-reads */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // Minimise AFTER the answer, not before: `handleOpenProfile` in Tabby calls
  // `bringToFront()` while the profile opens, which un-minimises the window --
  // measured 2026-10-24, minimising early left it visible again every time.
  if (spec.minimize === true) await minimizeAfterLaunch(0, spec.userDataDir);
  if (answer !== null) {
    return {
      stdout: String(answer.stdout ?? ''),
      stderr: String(answer.stderr ?? ''),
      exitCode: answer.exitCode ?? null,
      timedOut: answer.timedOut === true,
      spawnError: String(answer.spawnError ?? ''),
      ms: Number(answer.durationMs ?? Date.now() - started),
      overflow: false,
      argv,
    };
  }
  return {
    stdout: '',
    stderr: '',
    exitCode: null,
    timedOut: true,
    spawnError: '',
    ms: Date.now() - started,
    overflow: false,
    argv,
  };
}

export async function runSurface(surfaceId, spec, options) {
  // A tab driven through a static profile: the job file carries the command, and
  // the launch is detached because the CLI does not return.
  if (spec.tabbyProfile !== void 0) {
    return { ...finish(await runTabbySurface(spec, options), options, true), promoted: false };
  }
  // A host that can only launch a process gets the shim, and reads its answer
  // back from the result file the shim writes.
  if (spec.shim === true) {
    return { ...finish(await runShimSurface(spec, options), options, true), promoted: false };
  }
  // A terminal program is driven through its own CLI rather than spawned as a
  // shell: it has no `-c` to hand a command to, and its output has to be read
  // from a pane after the fact.
  if (spec.kind === 'terminal') {
    return { ...finish(await runTerminalSurface(spec, options), options, true), promoted: false };
  }
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

  // An inline file has served its purpose the moment the run settles: the surface
  // read it while it ran, and nothing after this point needs it.
  for (const file of built.cleanup ?? []) {
    try {
      unlinkSync(file);
    } catch {
      /* already gone; the run result is what matters */
    }
  }

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
