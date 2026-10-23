// Discovering this machine's shells and terminals, instead of assuming seven
// names on seven paths.
//
// The model is borrowed from mega-index-map's `library_detect`: a built-in
// candidate table (names and usual roots) resolved against PATH and the
// machine's own install locations, with every hit carrying where it was found.
// What this file must not become is a disk walk -- the candidate table is the
// whole search space, so a scan costs one PATH listing per directory plus a few
// `existsSync` calls, not a crawl of the drive.
//
// Two questions, two answers:
//   * scan() finds what EXISTS (paths, names, roots);
//   * surfaces.js decides what that means for the tool (one surface per WSL
//     distribution, one per bash family), and resolveSurfaces() answers whether
//     it is usable right now.

import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** Names worth looking for on PATH, per platform. */
const SHELL_NAMES_WIN = [
  'pwsh.exe',
  'powershell.exe',
  'wsl.exe',
  'cmd.exe',
  'bash.exe',
  'zsh.exe',
  'fish.exe',
  'brush.exe',
  'nu.exe',
  'sh.exe',
  'git.exe',
  'tcsh.exe',
  'busybox.exe',
];

/** Terminal PROGRAMS (draw a window), as opposed to shells (interpret text). */
const TERMINAL_NAMES_WIN = [
  'wt.exe',
  'mintty.exe',
  'wezterm.exe',
  'alacritty.exe',
  'conemu.exe',
  'conhost.exe',
  'tmux.exe',
  'screen.exe',
  'tabby.exe',
  'kitty.exe',
];
const SHELL_NAMES_POSIX = ['bash', 'zsh', 'fish', 'nu', 'sh', 'dash', 'ksh', 'mksh', 'elvish', 'xonsh', 'tcsh', 'yash', 'oksh', 'posh'];
const TERMINAL_NAMES_POSIX = ['tmux', 'screen', 'zellij', 'abduco', 'dtach', 'wezterm', 'alacritty', 'kitty', 'tabby', 'gnome-terminal'];

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Find the first PATH directory holding each wanted name (case-insensitive on Windows). */
function scanPath(names) {
  const wanted = new Map(names.map((name) => [name.toLowerCase(), name]));
  const found = new Map();
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    if (found.size === wanted.size) break;
    for (const entry of listDir(dir)) {
      const lower = entry.toLowerCase();
      if (wanted.has(lower) && !found.has(lower)) found.set(lower, join(dir, entry));
    }
  }
  return found;
}

/**
 * The usual install roots beside PATH. Each entry names the roots to look under
 * and the executables a person would expect there. Every root is overridable,
 * because a moved install is a machine fact, not a table fact.
 */
function installRoots() {
  const localAppData = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const msys = process.env.DSH_MSYS_ROOT ?? 'D:\\msys64';
  return [
    {
      id: 'msys2',
      root: msys,
      executables: [
        'usr\\bin\\bash.exe',
        'usr\\bin\\zsh.exe',
        'usr\\bin\\fish.exe',
        'ucrt64\\bin\\brush.exe',
        'usr\\bin\\pacman.exe',
        'usr\\bin\\tcsh.exe',
        'usr\\bin\\busybox.exe',
      ],
    },
    {
      id: 'git-for-windows',
      root: join(programFiles, 'Git'),
      // mintty rides beside bash in this userland and is not on PATH; the
      // library already records it, so the scan should see it too.
      executables: ['bin\\bash.exe', 'usr\\bin\\sh.exe', 'usr\\bin\\mintty.exe'],
    },
    {
      id: 'cygwin',
      root: 'C:\\cygwin64',
      executables: ['bin\\bash.exe', 'bin\\zsh.exe'],
    },
    {
      id: 'nushell',
      root: join(localAppData, 'Programs', 'nu', 'bin'),
      executables: ['nu.exe'],
    },
    {
      id: 'powershell-7',
      root: join(programFiles, 'PowerShell', '7'),
      executables: ['pwsh.exe'],
    },
    {
      id: 'windows-powershell',
      root: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0'),
      executables: ['powershell.exe'],
    },
    {
      id: 'strawberry-perl',
      root: 'C:\\Strawberry',
      executables: ['bin\\sh.exe'],
    },
  ];
}

/** WSL distributions, as the launcher itself lists them (a UTF-16 pipe with NULs). */
function scanWslDistros() {
  const result = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: 4000, windowsHide: true });
  if (result.status !== 0 || result.stdout === null) return [];
  const text = new TextDecoder('utf-16le', { fatal: false }).decode(result.stdout);
  return [...new Set(text.split(/\r?\n/).map((line) => line.replace(/\u0000/g, '').trim()).filter(Boolean))];
}

/**
 * Terminals inside a WSL distribution. The Windows PATH cannot see them, so the
 * scan asks the distribution itself with `command -v` -- the same question a
 * person would ask. A cold instance can take seconds, so the probe is bounded
 * and a timeout simply reports nothing for that distribution.
 */
function scanDistroTerminals(distro) {
  const names = TERMINAL_NAMES_POSIX.join(' ');
  const result = spawnSync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', `command -v ${names} 2>/dev/null`], {
    encoding: 'utf8',
    // A cold instance answered in 20 s here once; a bounded probe that gives up
    // still reports nothing for that distribution rather than blocking the scan.
    timeout: 8000,
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((path) => ({ name: path.split('/').pop() ?? path, path, source: `wsl:${distro}` }));
}

/**
 * Shells inside a WSL distribution. The same bounded question the terminals
 * get, asked for the shell names this table can describe; the distribution is
 * the source, because the Windows PATH cannot see any of them.
 */
function scanDistroShells(distro) {
  const names = ['elvish', 'ksh', 'xonsh', 'mksh', 'tcsh', 'busybox', 'bash', 'zsh', 'fish', 'nu', 'dash', 'yash', 'oksh', 'posh', 'osh', 'ysh'].join(' ');
  const result = spawnSync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', `command -v ${names} 2>/dev/null`], {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((path) => ({ name: path.split('/').pop() ?? path, path, source: `wsl:${distro}` }));
}

/**
 * Container runtimes inside a WSL distribution.
 *
 * A runtime is neither a shell nor a terminal: it is a place to run a command
 * where the distribution's own packages are not. The same bounded
 * `command -v` question decides whether it exists, so a machine without podman
 * reports nothing rather than a face that fails on every call.
 */
function scanDistroTools(distro) {
  const names = ['podman', 'docker'].join(' ');
  const result = spawnSync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', `command -v ${names} 2>/dev/null`], {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((path) => ({ name: path.split('/').pop() ?? path, path, source: `wsl:${distro}` }));
}

/**
 * One scan of this machine's shells, terminals and WSL distributions.
 * @returns a report that names where each hit was found.
 */
export function scan() {
  const windows = process.platform === 'win32';
  const shells = [];
  const terminals = [];
  const seen = new Set();

  const addShell = (name, path, source) => {
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    shells.push({ name, path, source });
  };

  if (windows) {
    for (const [name, path] of scanPath([...SHELL_NAMES_WIN, ...TERMINAL_NAMES_WIN])) {
      if (SHELL_NAMES_WIN.includes(name)) addShell(name, path, 'PATH');
      else terminals.push({ name, path, source: 'PATH' });
    }
    for (const entry of installRoots()) {
      for (const relative of entry.executables) {
        const path = join(entry.root, relative);
        if (!existsSync(path)) continue;
        const name = relative.split('\\').at(-1) ?? relative;
        if (TERMINAL_NAMES_WIN.includes(name.toLowerCase())) terminals.push({ name, path, source: entry.id });
        else addShell(name, path, entry.id);
      }
    }
  } else {
    const dirs = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
    const wanted = new Map([...SHELL_NAMES_POSIX, ...TERMINAL_NAMES_POSIX].map((name) => [name, name]));
    for (const dir of dirs) {
      for (const entry of listDir(dir)) {
        if (!wanted.has(entry)) continue;
        const path = join(dir, entry);
        if (SHELL_NAMES_POSIX.includes(entry)) addShell(entry, path, 'PATH');
        else terminals.push({ name: entry, path, source: 'PATH' });
      }
    }
  }

  const distros = windows ? scanWslDistros() : [];
  const tools = [];
  if (windows) {
    // Terminals and shells installed inside a distribution are part of this
    // machine too; they are reported with the distribution as their source,
    // never driven directly.
    for (const distro of distros) {
      for (const hit of scanDistroTerminals(distro)) {
        if (!terminals.some((known) => known.path === hit.path)) terminals.push(hit);
      }
      for (const hit of scanDistroShells(distro)) {
        if (!shells.some((known) => known.path === hit.path)) shells.push(hit);
      }
      for (const hit of scanDistroTools(distro)) {
        if (!tools.some((known) => known.path === hit.path)) tools.push(hit);
      }
    }
  }
  return { platform: process.platform, shells, terminals, distros, tools };
}
