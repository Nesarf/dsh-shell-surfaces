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

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');

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
  const nuExe = process.env.DSH_NU ?? join(LOCALAPPDATA, 'Programs', 'nu', 'bin', 'nu.exe');
  return {
    wsl: {
      kind: 'userland',
      exe: 'wsl.exe',
      summary: 'a whole Linux userland (WSL2 distro Nyarch): the real grep -P, GNU sed, /proc, pacman, ffmpeg',
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
        'strings; do not assume a package installed in one is visible in the other.',
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
