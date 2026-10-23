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

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scan } from './discover.js';

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');

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
        '/mnt/<drive>/...; pass `cwd` as a Windows path and the plugin rewrites it. Two measured habits: a cold ' +
        'instance takes 35-60 s to answer, so give a first call a generous timeout; and when a call times out ' +
        'after the output has already arrived, `wsl.exe --shutdown` (7 s) resets the instance and the next call ' +
        'answers in a tenth of a second.',
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
        marker: (nonce) => `printf '%s\\n' '__DSS_END_${nonce}__'`,
      },
      absent: 'set DSH_MSYS_ROOT to the MSYS2 root (default D:\\msys64)',
    },
    zsh: {
      kind: 'shell',
      exe: join(msys, 'usr', 'bin', 'zsh.exe'),
      argv: ['-lc'],
      env: { MSYSTEM: 'MSYS', PATH_PREFIX: join(msys, 'usr', 'bin') },
      loginShell: true,
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
      summary: 'BusyBox sh inside MSYS2: the small POSIX userland, not bash',
      tags: ['busybox', 'ash', 'embedded'],
      guide:
        'Use when the task is BusyBox itself (its ash applets, `busybox --list`). Its `sh` is ash, not bash: ' +
        'bash-isms such as `[[ ... ]]` and arrays are absent, so do not reach for it for a bash script.',
      absent: 'pacman -S busybox in the MSYS2 userland (or set DSH_MSYS_ROOT)',
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
  // A bash that is not MSYS2's is a different userland, so it gets its own id
  // rather than quietly replacing the one the table describes.
  const gitBash = found.shells.find((hit) => hit.source === 'git-for-windows' && hit.name.toLowerCase() === 'bash.exe');
  if (gitBash !== void 0 && specs['git-bash'] === void 0) {
    specs['git-bash'] = {
      kind: 'userland',
      exe: gitBash.path,
      argv: ['-lc'],
      loginShell: true,
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

/** Resolve existence for every surface. Absent entries carry what was looked for. */
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
    out[id] = { ...spec, present, env: { ...utf8Env(), ...(spec.env ?? {}) } };
  }
  return out;
}
