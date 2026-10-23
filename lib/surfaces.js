// The surfaces table: what this machine can run a command in, besides pwsh.
//
// Every fact below was measured on this machine before it was written down
// (2026-10-13 census, re-checked 2026-10-15). Two rules kept this table honest:
//
//   1. A path is a default, never a requirement. Each entry can be redirected by
//      an environment variable, so a machine that moves its MSYS2 root does not
//      need this file edited.
//   2. A surface that is not on this machine is reported as absent, with the
//      path that was looked for. Silence would read as "it worked".
//
// The two traps that shaped the argument lists:
//
//   * MSYS2 entries pass a login flag (`-l`). This machine hands TMPDIR down as a
//     Windows path, so without /etc/profile normalising it, `/tmp` means
//     different places to two neighbouring processes. Measured: `zsh -c` wrote
//     into D:\msys64\tmp while the `cat` beside it said the file was missing.
//   * brush gets NO login flag and no Cygwin assumptions: it is a native Windows
//     binary with no mount table, so `/tmp/x` lands at `<drive>:\tmp\x`. It speaks
//     bash's language and Windows' environment.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scan } from './discover.js';

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');

/**
 * The surfaces that belong to the MSYS2 userland. `msys` itself is the root;
 * everything else here is a shell installed INTO that userland, so it is drawn
 * under it rather than beside it.
 */
const MSYS2_MEMBERS = new Set(['msys', 'zsh', 'fish', 'brush', 'tcsh', 'busybox', 'dash']);

/** One scan per process: finding the machine's shells is a start-up fact, not a per-call one. */
let cachedScan = null;
function scanOnce() {
  if (cachedScan === null) cachedScan = scan();
  return cachedScan;
}

/** Re-scan on the next surfaceSpecs() call (tests, and a future refresh action). */
export function refreshScan() {
  cachedScan = null;
}

/** The scan this process is using: what was found, and where. */
export function lastScan() {
  return scanOnce();
}

/** A stable surface id from a WSL distribution name. */
function distroId(name) {
  return `wsl-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

/** MSYS2 root: one env var moves bash/zsh/fish/brush together. */
function msysRoot() {
  return process.env.DSH_MSYS_ROOT ?? 'D:\\msys64';
}

/**
 * The nonce line a POSIX shell prints when one command's output ends.
 *
 * A shell reading a pipe prints no prompt, so this line is the only boundary a
 * session can trust. It is produced by the shell itself (`printf`), never by the
 * command, so the command's own text cannot imitate it.
 * @param nonce - the random string this session put in its marker.
 */
function posixMarker(nonce) {
  return `printf '%s\\n' '__DSS_END_${nonce}__'`;
}

/**
 * The ssh destinations this machine's own config knows about.
 *
 * A `User git` host speaks the git protocol, not a shell -- `ssh github.com
 * 'echo hi'` is refused by the far side -- and a wildcard is a pattern rather
 * than a destination. Neither can become a surface, so both are dropped here
 * instead of showing up as a face that fails on every call.
 * @returns host aliases that a command can actually be sent to.
 */
export function scanSshHosts(configText) {
  const file = join(homedir(), '.ssh', 'config');
  let text = '';
  if (typeof configText === 'string') {
    text = configText;
  } else {
    if (!existsSync(file)) return [];
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
  }
  const hosts = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const host = /^\s*Host\s+(.+)$/i.exec(line);
    if (host !== null) {
      current = { name: host[1].trim(), user: '' };
      hosts.push(current);
      continue;
    }
    const user = /^\s*User\s+(.+)$/i.exec(line);
    if (user !== null && current !== null) current.user = user[1].trim();
  }
  return hosts.filter((h) => h.user !== 'git' && !/[*?]/.test(h.name)).map((h) => h.name);
}

/** The command-a-file-not-a-string flag every surface is comfortable with. */
function utf8Env() {
  // A reader that decodes UTF-8 should ask the producer for UTF-8: without this,
  // MSYS tools fall back to the code page and a Chinese path comes back mangled.
  return { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
}

/**
 * The surfaces, keyed by the value the tool's `surface` argument accepts.
 * `exe` is resolved lazily by {@link resolveSurfaces} so an env override set
 * after import still applies.
 */
export function surfaceSpecs() {
  const msys = msysRoot();
  const found = scanOnce();
  // A PATH that already answers the name is worth more than a guessed default:
  // take the discovered path when there is one, then let resolveSurfaces decide.
  const pick = (name, fallback) => found.shells.find((hit) => hit.name.toLowerCase() === name)?.path ?? fallback;
  const defaultDistro = process.env.DSH_WSL_DISTRO ?? found.distros[0] ?? 'Nyarch';
  const nuExe = process.env.DSH_NU ?? pick('nu.exe', join(LOCALAPPDATA, 'Programs', 'nu', 'bin', 'nu.exe'));
  const specs = {
    wsl: {
      kind: 'userland',
      exe: 'wsl.exe',
      distro: defaultDistro,
      summary: `a whole Linux userland (WSL2, default distribution ${defaultDistro}): the real grep -P, GNU sed, /proc, pacman, ffmpeg`,
      tags: ['linux', 'posix', 'proc', 'pacman'],
      guide:
        'Use when the job needs something only Linux has: PCRE lookaround in grep, a sed that edits in place, ' +
        '/proc, pacman packages, or a program that was built for Linux. Windows paths are reachable as ' +
        '/mnt/<drive>/...; pass `cwd` as a Windows path and the plugin rewrites it. Pass `session` to keep one ' +
        'login bash alive inside the distribution, so the current directory and exported variables survive ' +
        'between calls. Two measured habits: a cold instance takes 35-60 s to answer, so give a first call a ' +
        'generous timeout; and when a call times out after the output has already arrived, ' +
        '`wsl.exe --shutdown` (7 s) resets the instance and the next call answers in a tenth of a second.',
      // The session is a login bash reading commands from stdin, reached through
      // the launcher -- so it needs its own argv rather than `exe` + `argv`: the
      // distribution is part of the command line, not an environment fact.
      session: {
        argvFor: (spec) => ['wsl.exe', '-d', spec.distro ?? defaultDistro, '--', 'bash', '-l', '-s'],
        marker: (nonce) => `printf '%s\\n' '__DSS_END_${nonce}__'`,
      },
      absent: 'run `wsl.exe -l -q` to see the installed distros',
    },
    nu: {
      kind: 'shell',
      exe: nuExe,
      envVar: 'DSH_NU',
      argv: ['-c'],
      summary: 'nushell: pipelines of structured values, not text (a table in, a table out)',
      tags: ['structured', 'json', 'tables'],
      guide:
        'Use when a pipe should carry data rather than text: parse a JSON or CSV file once and get a table ' +
        'back, or emit `to json` for a result a reader can act on. Do not use it for plain shell one-liners ' +
        '-- bash or zsh express those more directly.',
      absent: 'nushell installs to %LOCALAPPDATA%\\Programs\\nu',
    },
    python: {
      kind: 'interpreter',
      exe: process.env.DSH_PYTHON ?? 'python',
      envVar: 'DSH_PYTHON',
      argv: ['-c'],
      summary: 'Python: a script interpreter, not a shell (python -c "<code>")',
      tags: ['python', 'interpreter'],
      guide:
        'Use when the job is a Python one-liner or a short program: the text after -c runs as Python and its ' +
        'stdout comes back. It is an interpreter rather than a shell, so there is no pipeline to quote around ' +
        'and a Windows path is a Windows path. For a shell job use one of the shells.',
      absent: 'install Python, or set DSH_PYTHON to the interpreter',
    },
    perl: {
      kind: 'interpreter',
      // Perl warns about a locale it cannot honour (this machine has C.UTF-8
      // asked for and a 936 console default: measured, the warning arrives
      // before the program's own output). PERL_BADLANG=0 silences exactly that
      // one warning and changes nothing else.
      exe: process.env.DSH_PERL ?? 'perl',
      envVar: 'DSH_PERL',
      argv: ['-e'],
      env: { PERL_BADLANG: '0' },
      summary: 'Perl: a script interpreter, not a shell (perl -e "<code>")',
      tags: ['perl', 'regex', 'interpreter'],
      guide:
        'Use when the job is a Perl one-liner -- the shortest path to a regex substitution over a file, or to a ' +
        'task whose module ecosystem is the reason to be here. The text after -e runs as Perl and its stdout ' +
        'comes back. It is an interpreter rather than a shell, so a pipeline belongs inside the code.',
      absent: 'install Perl (Strawberry Perl on Windows), or set DSH_PERL',
    },
    cscript: {
      kind: 'interpreter',
      // The one surface whose input is a FILE rather than a command line:
      // `cscript //nologo` takes a .vbs path and has no `-c`. `inlineFile` is that
      // mechanism -- the command is written to a temporary .vbs, cscript runs it,
      // and the file is removed once the run settles. Measured 2026-10-24:
      // `WScript.Echo "vbs-ok"` answered vbs-ok through this exact path.
      exe:
        process.env.DSH_CSCRIPT ??
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cscript.exe'),
      envVar: 'DSH_CSCRIPT',
      argv: ['//nologo'],
      inlineFile: { ext: '.vbs' },
      summary: 'Windows Script Host: VBScript run from a temporary file (cscript //nologo)',
      tags: ['cscript', 'vbscript', 'wsh', 'interpreter'],
      guide:
        'Use when the job is a VBScript or WSH one-liner -- COM automation, a registry read through WScript.Shell, ' +
        'something a Windows administrator already has a .vbs for. The command is the SCRIPT BODY (not a command ' +
        'line): it is written to a temporary .vbs, run, and removed. For JScript, `//E:jscript` is the flag to add ' +
        'inside the code path, not something this table can switch per call.',
      absent: 'cscript ships with Windows; a trimmed image may have removed Windows Script Host',
    },
    node: {
      kind: 'interpreter',
      exe: process.env.DSH_NODE ?? 'node',
      envVar: 'DSH_NODE',
      argv: ['-e'],
      summary: 'Node.js: a script interpreter, not a shell (node -e "<code>")',
      tags: ['node', 'javascript', 'interpreter'],
      guide:
        'Use when the job is a JavaScript one-liner: the text after -e runs as a Node program and its stdout ' +
        'comes back. `-p` is worth remembering for "print this expression". It is an interpreter rather than a ' +
        'shell, so a pipeline belongs inside the code, not around it.',
      absent: 'install Node.js, or set DSH_NODE to the executable',
    },
    msys: {
      kind: 'userland',
      exe: join(msys, 'usr', 'bin', 'bash.exe'),
      argv: ['-lc'],
      env: { MSYSTEM: 'MSYS', PATH_PREFIX: join(msys, 'usr', 'bin') },
      loginShell: true,
      summary: 'the MSYS2 userland bash: a Unix userland on Windows, with pacman for its own packages',
      tags: ['posix-on-windows', 'pacman', 'gnu'],
      guide:
        'Use when a POSIX toolchain must run natively on Windows (or when pacman is the package manager ' +
        'wanted). It is a different userland from git-bash even though both say MSYS in their version ' +
        'strings; do not assume a package installed in one is visible in the other. Pass `session` to keep ' +
        'one login bash alive across calls, with the current directory and exported variables intact.',
      // A session reads commands from stdin (`-s`) under the same login
      // environment the one-shot path uses, so PATH and /tmp mean the same thing
      // in both. The marker is printed by bash itself, never by the command.
      session: {
        argv: ['-l', '-s'],
        marker: posixMarker,
      },
      absent: 'set DSH_MSYS_ROOT to the MSYS2 root (default D:\\msys64)',
    },
    zsh: {
      kind: 'shell',
      exe: join(msys, 'usr', 'bin', 'zsh.exe'),
      argv: ['-lc'],
      env: { MSYSTEM: 'MSYS', PATH_PREFIX: join(msys, 'usr', 'bin') },
      loginShell: true,
      // `zsh -l -s` reads a stdin script under the login environment; measured
      // 2026-10-24 with the marker line, the same shape msys uses.
      session: {
        argv: ['-l', '-s'],
        marker: posixMarker,
      },
      summary: 'zsh inside MSYS2: the same userland as msys, a different shell language',
      tags: ['zsh', 'parameter-expansion'],
      guide:
        'Use when the task is zsh itself -- glob qualifiers, parameter expansion flags, associative arrays -- ' +
        'or when a script is written for zsh. For a POSIX-compatible job use `msys` instead; the userland is ' +
        'the same and bash is the better-known language.',
      absent: 'set DSH_MSYS_ROOT to the MSYS2 root (default D:\\msys64)',
    },
    fish: {
      kind: 'shell',
      exe: join(msys, 'usr', 'bin', 'fish.exe'),
      argv: ['-l', '-c'],
      env: { MSYSTEM: 'MSYS', PATH_PREFIX: join(msys, 'usr', 'bin') },
      loginShell: true,
      // fish treats a piped stdin as a script FILE and waits for EOF before
      // running any of it -- measured 2026-10-24, with `-l` and with `-l -i`
      // alike, a session that writes one command at a time got silence. The
      // opening is to keep stdin away from the script parser: fish reads it
      // itself with `read` and evaluates one line at a time, which is what a
      // session needs. Measured: `cd /tmp` / `set -x DSS_X 41` then
      // `echo "X=$DSS_X;P=$(pwd)"` answered X=41;P=/tmp.
      session: {
        argv: ['-l', '-c', 'while read -l dss_line; eval $dss_line; end'],
        marker: posixMarker,
      },
      summary: 'fish inside MSYS2: a third shell language, with its own arithmetic and command substitution',
      tags: ['fish', 'friendly-syntax'],
      guide:
        'Use when the task is fish itself. Remember its syntax is not POSIX: `set -l x 1`, `math`, `count`, and ' +
        'a bare `*` is a glob rather than multiplication -- quote arithmetic expressions.',
      absent: 'set DSH_MSYS_ROOT to the MSYS2 root (default D:\\msys64)',
    },
    brush: {
      kind: 'shell',
      exe: join(msys, 'ucrt64', 'bin', 'brush.exe'),
      argv: ['-c'],
      // Measured 2026-10-15: the kernel and its builtins are in ucrt64\bin, but
      // the coreutils it calls (`tr`) are only in usr\bin. Without that prefix
      // each coreutils call fails as "command not found" while the shell itself
      // reports a healthy version, which reads as a broken surface.
      env: {
        MSYSTEM: 'UCRT64',
        PATH_PREFIX: `${join(msys, 'ucrt64', 'bin')};${join(msys, 'usr', 'bin')}`,
      },
      loginShell: false,
      // `-s` reads a stdin script without a login environment, which is what
      // brush needs anyway (it has no mount table to log into). Measured
      // 2026-10-24: the exported variable survived; `cd /tmp` did not, because
      // `/tmp` is `<drive>:\tmp` to brush -- a property of the shell, not of the
      // session.
      session: {
        argv: ['-s'],
        marker: posixMarker,
      },
      summary: 'brush: the bash language over Windows paths -- no mount table, no path translation',
      tags: ['bash-syntax', 'windows-paths'],
      guide:
        'Use when bash syntax is wanted for a script that already speaks Windows paths. It does NOT translate ' +
        'paths: `/tmp/x` is `<current drive>:\\tmp\\x`, measured to land at E:\\tmp\\x. Give it Windows paths, ' +
        'or use `msys` when POSIX paths are wanted.',
      absent: 'set DSH_MSYS_ROOT to the MSYS2 root (default D:\\msys64)',
    },
    tcsh: {
      kind: 'shell',
      exe: join(msys, 'usr', 'bin', 'tcsh.exe'),
      argv: ['-c'],
      // This entry was missing the PATH prefix every other MSYS-family surface
      // carries, and a live session found it (measured 2026-10-24): without it
      // tcsh answers "pwd: Command not found" and "printf: Command not found".
      // A one-shot `echo tcsh-ok` never noticed, because echo is a builtin.
      env: { MSYSTEM: 'MSYS', PATH_PREFIX: join(msys, 'usr', 'bin') },
      session: {
        argv: ['-s'],
        marker: posixMarker,
      },
      summary: 'tcsh inside MSYS2: the C shell, with csh variables and backtick substitution',
      tags: ['tcsh', 'csh'],
      guide:
        'Use when the task is tcsh itself: `set name = value`, backtick command substitution, and the csh ' +
        'history model. For a POSIX job use `msys` instead -- the syntax is not shared.',
      absent: 'pacman -S tcsh in the MSYS2 userland (or set DSH_MSYS_ROOT)',
    },
    busybox: {
      kind: 'shell',
      exe: join(msys, 'usr', 'bin', 'busybox.exe'),
      argv: ['sh', '-c'],
      // `busybox sh -s` is ash reading stdin, measured 2026-10-24: cd and the
      // exported variable both survived, and the marker line came back.
      session: {
        argv: ['sh', '-s'],
        marker: posixMarker,
      },
      summary: 'BusyBox sh inside MSYS2: the small POSIX userland, not bash',
      tags: ['busybox', 'ash', 'embedded'],
      guide:
        'Use when the task is BusyBox itself (its ash applets, `busybox --list`). Its `sh` is ash, not bash: ' +
        'bash-isms such as `[[ ... ]]` and arrays are absent, so do not reach for it for a bash script.',
      absent: 'pacman -S busybox in the MSYS2 userland (or set DSH_MSYS_ROOT)',
    },
    dash: {
      kind: 'shell',
      exe: join(msys, 'usr', 'bin', 'dash.exe'),
      argv: ['-c'],
      env: { MSYSTEM: 'MSYS', PATH_PREFIX: join(msys, 'usr', 'bin') },
      // dash has no `-l`: it is the strict POSIX sh by design, so a session is
      // `-s` under the PATH this table sets, not a login environment.
      session: {
        argv: ['-s'],
        marker: posixMarker,
      },
      summary: 'dash inside MSYS2: the strict POSIX sh, where a bash-ism fails instead of being forgiven',
      tags: ['dash', 'posix', 'sh'],
      guide:
        'Use when the question is whether a script is POSIX-clean: dash is Debian\'s /bin/sh and refuses what ' +
        'bash quietly accepts. Measured on this machine: `[[ x = x ]]` fails under dash with "[[: not found". ' +
        'For a script written for bash use `msys` instead. MSYS2 also ships ash.exe and sh.exe beside it; ash ' +
        'behaves the same way here, so the scan reports it rather than the table growing a second identical face.',
      absent: 'pacman -S dash in the MSYS2 userland (or set DSH_MSYS_ROOT)',
    },
    pwsh: {
      kind: 'shell',
      // PowerShell 7 by default; a machine that only has Windows PowerShell can
      // point DSH_PWSH at powershell.exe. Both were measured through a pipe on
      // this machine (2026-10-15) and both answer UTF-8, so the runner's shared
      // decode needs no per-surface exception.
      exe: process.env.DSH_PWSH ?? pick('pwsh.exe', 'pwsh.exe'),
      envVar: 'DSH_PWSH',
      argv: ['-NoProfile', '-NonInteractive', '-Command'],
      // A script file gets `-File`, not `-Command`: PowerShell then sets $args
      // and $MyInvocation the way a .ps1 expects, and the path is not parsed as
      // a command line.
      scriptArgv: ['-NoProfile', '-NonInteractive', '-File'],
      summary: 'PowerShell 7: .NET objects, Windows management providers, modules',
      tags: ['pwsh', 'dotnet', 'windows'],
      guide:
        'Use when the task is PowerShell itself: .NET objects, Windows management providers (registry, CIM), ' +
        'a module only PowerShell provides, or a pipeline whose values are objects. This surface carries the ' +
        'same background-job, escalation and session machinery as every other one; a terminal-style session ' +
        'that keeps a drawn prompt or a cursor is the one shape it does not carry, and the built-in ' +
        'persistent `pwsh` tool is where that lives.',
      // `-Command -` reads commands from stdin, non-interactively: state (the
      // current directory, variables, modules) persists for the session's life,
      // while no prompt and no PSReadLine are involved.
      session: {
        argv: ['-NoProfile', '-NonInteractive', '-Command', '-'],
        marker: (nonce) => `[Console]::WriteLine('__DSS_END_${nonce}__')`,
      },
      absent: 'install PowerShell 7 (`winget install Microsoft.PowerShell`) or set DSH_PWSH to powershell.exe',
    },
    powershell: {
      kind: 'shell',
      // Both PowerShells are on this machine, so they are two surfaces rather
      // than one variable to flip: "does this script still work on 5.1" is a
      // question an agent can only answer if 5.1 is addressable while 7 is the
      // default. Measured 2026-10-15: both answer UTF-8 through a pipe.
      exe:
        process.env.DSH_POWERSHELL ??
        pick('powershell.exe', join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')),
      envVar: 'DSH_POWERSHELL',
      argv: ['-NoProfile', '-NonInteractive', '-Command'],
      scriptArgv: ['-NoProfile', '-NonInteractive', '-File'],
      summary: 'Windows PowerShell 5.1: the .NET Framework one that ships with the OS',
      tags: ['powershell', 'windows', 'dotnet-framework'],
      guide:
        'Use when a script has to run on the Windows PowerShell that is already installed everywhere: 5.1 has ' +
        'no ternary operator, no `??`, no `-Parallel`, and an older JSON/cmdlet set. `pwsh` is PowerShell 7 and ' +
        'is the better default; this surface is how "does it still work on 5.1" gets answered.',
      absent: 'Windows PowerShell ships with Windows; a trimmed image may have removed it',
    },
    wt: {
      kind: 'terminal',
      // A window cannot answer, so a shim answers for it. Windows Terminal opens
      // a tab running `node scripts/dss-exec.mjs`, which runs the command and
      // writes a structured result beside it; the caller polls that file. This
      // is the physical fix for "terminal programs are unusable": the window is
      // only a display, and the result travels on disk.
      shim: true,
      launch: { program: process.env.DSH_WT ?? 'wt.exe', args: ['-w', '-1', 'new-tab', '--'] },
      exe: process.env.DSH_WT ?? 'wt.exe',
      envVar: 'DSH_WT',
      // The window is for the record, not for the reader: `wt` has --maximized
      // and --fullscreen but no "minimized", so the launch goes through
      // `start /min` (see launchArgv in runner.js).
      minimize: true,
      summary: 'Windows Terminal: a real window, with the result brought back by the dss-exec shim',
      tags: ['terminal', 'gui', 'shim'],
      guide:
        'Use when the command should run in a real Windows Terminal window. A tab opens running the dss-exec ' +
        'shim, the shim runs the command and writes {exitCode, stdout, stderr} to a result file, and this tool ' +
        'reads that file and closes nothing (the tab exits on its own). The window appears for the duration of ' +
        'the command; the answer is the same structured result every other surface returns, not a screen ' +
        'transcript.',
      absent: 'Windows Terminal ships with Windows 11; `winget install Microsoft.WindowsTerminal` otherwise',
    },
    mintty: {
      kind: 'terminal',
      // Same shim, a different window. Measured 2026-10-24: `mintty -e node
      // dss-exec.mjs ...` answered its result file in 39 ms, which is what makes
      // "a terminal program has no answer" a solvable problem rather than a
      // limitation to document.
      shim: true,
      launch: {
        program:
          process.env.DSH_MINTTY ??
          join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'mintty.exe'),
        args: ['-e'],
      },
      exe:
        process.env.DSH_MINTTY ??
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'mintty.exe'),
      envVar: 'DSH_MINTTY',
      // mintty has no "minimized" switch either; `start /min` covers it.
      minimize: true,
      summary: 'mintty (Git for Windows): a real window, result brought back by the dss-exec shim',
      tags: ['terminal', 'gui', 'shim'],
      guide:
        'Use when the command should run in a mintty window -- the console that ships beside the Git bash ' +
        'userland. A window opens running the dss-exec shim, the shim runs the command and writes the ' +
        'structured result, and this tool reads it. Same contract as every other surface: exit code, stdout, ' +
        'stderr -- not a screen transcript.',
      absent: 'mintty ships with Git for Windows; set DSH_MINTTY to its path elsewhere',
    },
    tabby: {
      kind: 'terminal',
      // Tabby has no `-e` and no `new-tab -- <program>`, but it does have
      // `tabby profile <name>`, and a local profile carries `options.command` +
      // `options.args`. Those are static, so the profile names
      // scripts/dss-tabby-agent.mjs once, and every call only rewrites the job
      // file that agent reads. Measured 2026-10-24: the agent answered 45 ms after
      // launch. `Tabby.exe profile dss` itself blocks for the app's lifetime, so
      // the launch is detached.
      exe: process.env.DSH_TABBY ?? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tabby', 'Tabby.exe'),
      envVar: 'DSH_TABBY',
      tabbyProfile: 'dss',
      // Its own instance. Driving the user's Tabby would `bringToFront()` on
      // every call -- measured: that method runs on each `profile` open -- and
      // rewriting their config is not this tool's business. A separate
      // `--user-data-dir` keeps both apart: different config, different window,
      // different process tree.
      userDataDir: process.env.DSS_TABBY_DATA ?? 'E:\\DaShaoHuo\\cache\\tabby-dss',
      jobFile: process.env.DSS_TABBY_JOB ?? 'E:\\DaShaoHuo\\cache\\tmp\\dss-tabby-job.json',
      // `tabby profile dss` brings its window to the front on purpose; `start
      // /min` keeps that from stealing focus while a command runs unattended.
      minimize: true,
      summary: 'Tabby: a real tab, driven by a local profile that runs the dss agent',
      tags: ['terminal', 'gui', 'tabby', 'profile'],
      guide:
        'Use when the command should run in a Tabby tab. A local profile named `dss` runs the dss agent: this ' +
        'tool writes the command to the job file that agent reads, opens the profile, and polls the result ' +
        'file. The profile is a one-time install -- `node scripts/tabby-setup.mjs`, which backs the config up ' +
        'and refuses to patch one whose profiles list is not empty. The answer is the same structured result ' +
        'every other surface returns.',
      absent: 'install Tabby, then run `node scripts/tabby-setup.mjs` once to add the dss profile',
    },
    wezterm: {
      kind: 'terminal',
      // The one terminal program that can be driven AND read back. Measured
      // 2026-10-24: `wezterm cli spawn --pane-id 0 -- cmd /k echo hi` answers a
      // pane id, `wezterm cli get-text --pane-id <id>` answers the screen text,
      // and `kill-pane` closes it. wt --help opens a window and never exits, and
      // a command in a wt/tabby/mintty window writes into that window instead of
      // answering the caller, so those get no face at all.
      exe: process.env.DSH_WEZTERM ?? pick('wezterm.exe', 'wezterm.exe'),
      envVar: 'DSH_WEZTERM',
      summary: 'WezTerm: a real terminal pane, read back through its own mux server',
      tags: ['terminal', 'gui', 'pane'],
      guide:
        'Use when the job should run in a real terminal and the screen should come back: a new pane is spawned ' +
        'through `wezterm cli spawn`, the pane text is polled until the command prints its end marker, and the ' +
        'pane is closed. The command is a Windows `cmd` command line (cmd /k), and the answer is a screen ' +
        'transcript -- prompt echo and wrapping included -- so read it as a screen, exactly like the pty ' +
        'surface. A mux server is started automatically by the CLI when none is running.',
      absent: 'install WezTerm, or set DSH_WEZTERM to wezterm.exe',
    },
    pty: {
      kind: 'console',
      exe: 'python',
      summary: 'a real console (ConPTY) for a program that waits for input or addresses the cursor',
      tags: ['interactive', 'tui', 'conpty'],
      guide:
        'Use when a program will not work without a terminal: an install prompt that asks Y/N, a full-screen ' +
        'TUI, anything reading [Console]::In.ReadLine(). A pipe is not a console and installing a terminal ' +
        'emulator does not fix that. Answer prompts with `send` (each entry is typed once the program has ' +
        'settled; a trailing \\n means Enter). Output is a screen transcript, so expect wrapping and prompt ' +
        'echo rather than clean lines.',
      absent: 'the pty surface needs python on PATH plus the pywinpty package',
    },
  };
  // Every other WSL distribution gets its own id, so "the Nyarch distro" and
  // "the Debian distro" are two surfaces rather than one argument to remember.
  for (const distro of found.distros) {
    if (distro === defaultDistro) continue;
    const id = distroId(distro);
    if (specs[id] !== void 0) continue;
    specs[id] = {
      ...specs.wsl,
      distro,
      summary: `the ${distro} WSL distribution, as its own surface`,
      guide:
        `Use when the job needs the ${distro} distribution specifically; the default surface runs ` +
        `${defaultDistro}. Windows paths are reachable as /mnt/<drive>/... and \`cwd\` is rewritten for you.`,
    };
  }
  // A shell that lives INSIDE a distribution is its own face. Without this the
  // only way to reach elvish was `bash -lc 'elvish -c ...'` -- a wrapper the
  // caller had to write and quote correctly every time, for a shell the scan had
  // already found. The list comes from the scan, so a distribution that gains
  // xonsh tomorrow answers for it after the next refresh.
  for (const hit of found.shells) {
    const source = /^wsl:(.+)$/.exec(hit.source ?? '');
    if (source === null) continue;
    const distro = source[1];
    const program = hit.name.replace(/\.exe$/i, '');
    // `bash` already IS the `wsl` surface: a second id for the same program
    // would be two names for one thing, which is exactly the ambiguity a table
    // of surfaces exists to remove.
    if (program === 'bash') continue;
    const id = `wsl-${program.toLowerCase()}`;
    if (specs[id] !== void 0) continue;
    const base = specs[distroId(distro)] ?? specs.wsl;
    specs[id] = {
      ...base,
      kind: 'shell',
      distro,
      // busybox is not a shell by itself: `busybox sh -c` is. Every other one
      // here takes its script after a plain -c (measured for all six).
      wslExec: { program, argv: program === 'busybox' ? ['sh', '-c'] : ['-c'] },
      // No session on a derived face: the session's argv is `bash -l -s`, so a
      // session here would quietly run bash while the row claims this shell.
      session: void 0,
      summary: `${program} inside the ${distro} distribution, as a surface of its own`,
      guide:
        `Use when the command is written for ${program} itself: it runs inside ${distro} under that shell's own ` +
        'syntax, so no bash-only construct gets silently accepted. The command is handed over on stdin, which ' +
        'keeps the outer windows side from expanding its variables first.',
      absent: `install ${program} inside ${distro}`,
    };
  }
  // A container runtime is a place to run a command, so it gets a face -- the
  // same argument the ssh destinations get, with a local container instead of a
  // host. The image is an environment variable because a face id cannot carry a
  // tag, and the default is the smallest image that answers.
  const podmanHit = Array.isArray(found.tools) ? found.tools.find((hit) => hit.name === 'podman') : void 0;
  if (podmanHit !== void 0) {
    const image = process.env.DSH_PODMAN_IMAGE ?? 'docker.io/library/alpine:latest';
    specs.podman = {
      kind: 'container',
      exe: 'wsl.exe',
      distro: defaultDistro,
      // `podman run --rm <image> sh -c '<command>'`, handed over the same way a
      // derived shell is: on stdin, as one `exec` line for the distribution's
      // bash. The container is throwaway by design -- state does not travel
      // between calls, because a face is one command, not a session.
      wslExec: { program: 'podman', argv: ['run', '--rm', image, 'sh', '-c'] },
      summary: `podman inside the distribution (rootless): one throwaway container per call, from ${image}`,
      tags: ['container', 'podman', 'rootless'],
      guide:
        'Use when the command should run in a container rather than on the host or in the distribution itself: ' +
        "the packages, the filesystem and the toolchain are the image's. Each call starts a new container and " +
        'removes it afterwards, so nothing persists between calls -- install what you need inside the one ' +
        'command, or use the `wsl` surface when state matters. The image is `DSH_PODMAN_IMAGE` (default ' +
        `${image}); the first call pulls it. Paths inside the distribution are not mounted by default, so a ` +
        'container cannot see /mnt unless the image mounts it.',
      absent: 'install podman inside the distribution (`pacman -S podman`)',
    };
  }
  // An ssh destination is a surface the same way a WSL distribution is: the
  // host list comes from the user's own config, and `ssh <host> <command>` is
  // exactly the "flags then command" argv shape every shell surface already
  // uses, so nothing new is needed to carry a command there.
  // BatchMode is not a preference: without it a host that wants a password
  // waits at a prompt nobody can type into, which reads as a hung call.
  for (const host of scanSshHosts()) {
    const id = `ssh-${host.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if (specs[id] !== void 0) continue;
    specs[id] = {
      kind: 'remote',
      exe: 'ssh',
      argv: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host],
      summary: `a remote shell on ${host}, reached over ssh`,
      tags: ['ssh', 'remote'],
      guide:
        `Use when the command has to run on ${host}. BatchMode means a host that wants a password fails at once ` +
        'instead of waiting at a prompt nobody can type into; a host with a working key answers normally. The ' +
        'command travels as one argument to the remote shell, so quoting there is the remote side\'s business.',
      absent: `add ${host} to ~/.ssh/config with a key that works`,
    };
  }
  // A bash that is not MSYS2's is a different userland, so it gets its own id
  // rather than quietly replacing the one the table describes.
  const gitBash = found.shells.find((hit) => hit.source === 'git-for-windows' && hit.name.toLowerCase() === 'bash.exe');
  if (gitBash !== void 0 && specs['git-bash'] === void 0) {
    specs['git-bash'] = {
      kind: 'userland',
      exe: gitBash.path,
      argv: ['-lc'],
      loginShell: true,
      // Same shape as msys: a login bash reading commands from stdin. Measured
      // 2026-10-24 through this exact argv.
      session: {
        argv: ['-l', '-s'],
        marker: posixMarker,
      },
      summary: 'Git for Windows bash: a POSIX userland with git on PATH, separate from MSYS2',
      tags: ['posix-on-windows', 'git'],
      guide:
        'Use when the job needs git plus a POSIX shell and the MSYS2 userland is not wanted. It is not the ' +
        'same userland as MSYS2: a package installed in one is not visible in the other.',
      absent: 'install Git for Windows',
    };
  }
  const cmd = found.shells.find((hit) => hit.name.toLowerCase() === 'cmd.exe');
  if (cmd !== void 0 && specs.cmd === void 0) {
    specs.cmd = {
      kind: 'shell',
      exe: cmd.path,
      argv: ['/c'],
      summary: 'the Windows command interpreter (cmd /c)',
      tags: ['cmd', 'windows'],
      guide:
        'Use when a tool documents itself in `cmd /c` form, or a batch file expects the command interpreter\'s ' +
        'quote rules. For anything a person writes today, PowerShell or a POSIX shell expresses it better.',
      absent: 'cmd.exe is part of Windows',
    };
  }
  return specs;
}

/** Is this executable reachable? A bare name is resolved the way a shell would. */
function executableExists(exe) {
  if (/[\\/]/.test(exe)) return existsSync(exe);
  // A bare name follows the shell's own resolution rather than a directory walk.
  // Measured: `existsSync(join('C:\\Windows\\system32', 'wsl.exe'))` answers true,
  // yet the file is a reparse point and the walk that starts from a PATH entry
  // can miss it -- while `where.exe wsl.exe` finds it immediately. Asking the same
  // resolver a shell uses removes that whole class of doubt.
  const probe =
    process.platform === 'win32'
      ? { command: 'where.exe', args: [exe] }
      : { command: 'sh', args: ['-c', `command -v ${JSON.stringify(exe)} >/dev/null 2>&1`] };
  try {
    const result = spawnSync(probe.command, probe.args, { stdio: 'ignore', timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * The surfaces as a tree of text, for `action="surfaces"`.
 *
 * A userland that hosts several shells is one place with children rather than a
 * flat list of unrelated names: the shells under `msys` are installed INTO that
 * userland, and five rows at the same indentation never said so. The same data
 * the client draws from (`family` / `parent` on each row) is what this walks.
 * @param surfaces - the resolved table from {@link resolveSurfaces}.
 */
export function describeSurfaces(surfaces) {
  const lines = [];
  const roots = [];
  const children = new Map();
  for (const [id, spec] of Object.entries(surfaces)) {
    const parent = spec.parent ?? '';
    if (parent === '') {
      roots.push(id);
      continue;
    }
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(id);
  }
  const body = (id, prefix, connector) => {
    const spec = surfaces[id];
    const state = spec.present ? 'available' : `not on this machine (${spec.absent})`;
    // A root says `- id`; a child IS the connector, so it does not get a second
    // dash after `├─` (which is what a naive `connector + "- "` produces).
    const head = connector === '' ? '- ' : connector;
    // Details line up under the row they explain: a nested row's connector
    // becomes blank space, a middle row's becomes a continuing stem.
    const detailPad = prefix + (connector === '' ? '' : connector === '└─ ' ? '   ' : '│  ');
    lines.push(`${prefix}${head}${id} [${spec.kind}] ${state}`);
    lines.push(`${detailPad}  ${spec.summary}`);
    lines.push(`${detailPad}  when: ${spec.guide}`);
  };
  const walk = (id, prefix, connector) => {
    body(id, prefix, connector);
    const kids = children.get(id) ?? [];
    const childPrefix = prefix + (connector === '' ? '' : connector === '└─ ' ? '   ' : '│  ');
    kids.forEach((child, index) => {
      walk(child, childPrefix, index === kids.length - 1 ? '└─ ' : '├─ ');
    });
  };
  for (const id of roots) walk(id, '', '');
  return lines.join('\n');
}

/**
 * Which surface hosts which. A userland that carries several shells is one
 * place with children, not a flat list of unrelated names: `msys` owns the
 * zsh/fish/dash/tcsh/BusyBox installed beside it, and `wsl` owns the shells that
 * live inside the distribution. Derived here rather than written into each
 * entry, so a table row added later cannot forget to say who its parent is.
 * @returns the family name and the id it hangs under ('' for a root).
 */
function familyOf(id) {
  if (id === 'wsl' || id.startsWith('wsl-')) return { family: 'wsl', parent: id === 'wsl' ? '' : 'wsl' };
  if (MSYS2_MEMBERS.has(id)) return { family: 'msys2', parent: id === 'msys' ? '' : 'msys' };
  return { family: '', parent: '' };
}

/**
 * The "open a path" recipe for a program the scan found but the table gives no
 * face. Two answers matter: a program that can launch an executable can carry a
 * command through the dss-exec shim (its result travels on disk rather than on a
 * screen), and a multiplexer is driven headless instead of as a window.
 * @param name - the discovered program's name, e.g. `tabby.exe`.
 * @returns one line a reader can act on.
 */
export function openPathFor(name) {
  const lower = name.toLowerCase();
  if (lower === 'wt.exe' || lower === 'mintty.exe') return 'face: this tool already has one (shim-backed)';
  if (lower === 'wezterm.exe' || lower === 'wezterm') return 'face: `wezterm` (pane spawn + get-text)';
  if (lower === 'tabby.exe' || lower === 'tabby') {
    // Checked 2026-10-24: Tabby takes Electron switches only -- no `-e`, no
    // `new-tab -- <program>`. What it DOES have is `tabby profile <name>` plus a
    // local profile carrying command+args, so the opening is a profile that runs
    // a fixed agent and a per-call job file.
    return 'face: `tabby` (a local profile runs the dss agent; install it with scripts/tabby-setup.mjs)';
  }
  if (lower === 'git-shell' || lower === 'git-shell.exe') {
    // git-shell refuses every non-git command on purpose; no shim can change
    // that. The opening is the git transport itself: a pre-receive hook in a
    // bare repository runs on push, so the command rides in as a ref update and
    // its output comes back in the push report.
    return 'channel: accepts only git transport; a pre-receive hook in a bare repo runs the command and the output rides back on the push';
  }
  if (lower === 'rbash' || lower === 'rbash.exe') {
    return 'channel: refuses cd/PATH changes/redirection; a plain `bash -c` from a non-restricted shell restores them';
  }
  if (lower === 'mshta.exe' || lower === 'mshta') {
    return 'shim: an HTA/VBS host can start `node scripts/dss-exec.mjs`; the result comes back the same way';
  }
  if (lower === 'conhost.exe' || lower === 'conhost') {
    // The console host every Windows window sits on: it has no command line of
    // its own, so a shim recipe would be advice that cannot be followed.
    return 'not a launcher: the console host behind other windows; it takes no command of its own';
  }
  if (lower === 'kitty' || lower === 'gnome-terminal') {
    return 'shim: needs a GUI session to open; launch the shim inside it';
  }
  if (lower === 'tmux' || lower === 'tmux.exe' || lower === 'screen' || lower === 'zellij' || lower === 'abduco' || lower === 'dtach') {
    return 'session host: drive it headless (`new-session -d` + `capture-pane`), not as a window';
  }
  return 'shim: any host that can start a process can carry a command through scripts/dss-exec.mjs';
}

/** The surfaces, resolved: present or not, plus the family tree they hang in. */
export function resolveSurfaces() {
  const specs = surfaceSpecs();
  const out = {};
  for (const [id, spec] of Object.entries(specs)) {
    // A bare command name is resolved against PATH rather than assumed present.
    // CI caught the difference: on a Linux runner this table used to report wsl
    // as available because `wsl.exe` was taken as given, and a surface that
    // claims to be available on a machine that cannot run it is worse than one
    // that says nothing.
    const present = executableExists(spec.exe);
    const family = familyOf(id);
    out[id] = { ...spec, present, family: family.family, parent: family.parent, env: { ...utf8Env(), ...(spec.env ?? {}) } };
  }
  return out;
}
