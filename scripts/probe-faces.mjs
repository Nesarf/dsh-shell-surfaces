// Probe every surface in the TABLE, once, and report what each one answers.
//
// This is the inventory counterpart to probe-all-shells.ps1. That script reads
// versions of the terminals and the long-standing shells from a hand-written
// list; this one reads the surface table, so a face added to the plugin shows up
// here without anybody remembering to add it in a second place. Measured
// 2026-10-24: the hand-written list reported 12 shells while the table held 32
// faces, and that gap is exactly what this script removes.
//
// Output shape matches probe-table.mjs:
//   { shells: [{ shell, ms, answer }] }
//
// Window faces are skipped unless PROBE_TERMINALS=1: they open a real window, and
// a version census should not do that on someone's screen.

import { resolveSurfaces } from '../lib/surfaces.js';
import { runSurface } from '../lib/runner.js';

/** What to ask each surface so its answer identifies it. Keyed by surface id. */
const VERSION_COMMANDS = {
  wsl: 'uname -sr',
  nu: 'version | get version',
  msys: 'echo $BASH_VERSION',
  zsh: 'echo $ZSH_VERSION',
  fish: 'echo $version',
  brush: 'echo $BASH_VERSION',
  tcsh: 'echo $version',
  // `busybox` is not on this surface's PATH (its shell is `sh -c`, and the
  // external lookup failed: measured "busybox: not found"), so the answer is a
  // computation instead of a lookup.
  busybox: 'echo busybox-$((6*7))',
  dash: 'dpkg --version 2>/dev/null || echo dash',
  pwsh: '$PSVersionTable.PSVersion.ToString()',
  powershell: '$PSVersionTable.PSVersion.ToString()',
  python: 'import sys; print(sys.version.split()[0])',
  perl: 'print $^V',
  // `node -e` only prints what the program prints: `process.version` on its own
  // evaluates and discards (measured: empty answer).
  node: 'console.log(process.version)',
  cscript: 'WScript.Echo WScript.Version',
  // `ver` answers in the console code page, which arrives as mojibake through a
  // pipe (measured on this machine for both cmd and pty). A plain word avoids
  // measuring the encoding instead of the surface.
  cmd: 'echo cmd-ok',
  'git-bash': 'echo $BASH_VERSION',
  // The pty surface hands its command to a console, which requires a real
  // program name: `echo` alone answers "The command was not found or was not
  // executable". It has to be routed through cmd.
  pty: 'cmd /c echo pty-ok',
  // A derived face reports its own program: the id is wsl-<program>.
  'wsl-elvish': 'elvish -version',
  'wsl-ksh': 'echo $KSH_VERSION',
  'wsl-xonsh': 'echo $XONSH_VERSION',
  'wsl-mksh': 'echo $KSH_VERSION',
  'wsl-tcsh': 'echo $version',
  'wsl-busybox': 'busybox | head -1',
  'wsl-zsh': 'echo $ZSH_VERSION',
  'wsl-dash': 'echo dash',
  'wsl-osh': 'osh --version | head -1',
  'wsl-ysh': 'ysh --version | head -1',
  'wsl-nu': 'version | get version',
  // Window faces: cmd syntax, answered through the shim.
  wt: 'ver',
  mintty: 'ver',
  tabby: 'ver',
  wezterm: 'ver',
};

const probeWindows = process.env.PROBE_TERMINALS === '1';
const surfaces = resolveSurfaces();
const rows = [];

for (const [id, spec] of Object.entries(surfaces)) {
  if (!spec.present) continue;
  if (spec.kind === 'terminal' && !probeWindows) continue;
  const command = VERSION_COMMANDS[id] ?? 'echo ok';
  const started = Date.now();
  let answer = '';
  try {
    const result = await runSurface(id, spec, {
      command,
      script: '',
      cwd: '',
      send: [],
      timeoutMs: 30000,
      maxOutputChars: 4000,
    });
    const text = (result.stdout ?? '').trim() || (result.stderr ?? '').trim();
    answer = text.split('\n')[0] ?? '';
    if (result.timedOut) answer = answer === '' ? 'TIMEOUT' : `${answer} (timed out)`;
    if (answer === '' && result.spawnError !== '') answer = `ERR ${result.spawnError}`;
  } catch (error) {
    answer = `ERR ${String(error?.message ?? error)}`;
  }
  rows.push({ shell: id, ms: Date.now() - started, answer });
}

process.stdout.write(JSON.stringify({ shells: rows }));
