// Live check: run one real command on every surface, through the plugin's own
// code path. Not a test of the tool registry (that needs a running host) -- a
// test of whether each surface actually answers.
//
// Usage:
//   node scripts/live-check.mjs [surface ...]      (default: every surface)
//   DSH_PLUGIN_ROOT=<checkout> node scripts/live-check.mjs wsl nu pty
//
// Environment:
//   DSH_PLUGIN_ROOT  where this plugin lives, so the script can be run from
//                    anywhere. Defaults to the parent of this file's directory.
//   DSH_PTY_GATE     the script for the pty case -- one that asks a question on
//                    the console. Defaults to scripts/pty-gate.ps1 beside this file.
//
// The pty case is skipped when no gate script exists rather than reported as a
// failure: a missing fixture is not a broken surface.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.DSH_PLUGIN_ROOT ?? join(here, '..'));

const { resolveSurfaces } = await import(pathToFileURL(join(root, 'lib', 'surfaces.js')).href);
const { runSurface } = await import(pathToFileURL(join(root, 'lib', 'runner.js')).href);

const gate = process.env.DSH_PTY_GATE ?? join(here, 'pty-gate.ps1');

const CASES = {
  wsl: { command: 'uname -sr && grep -c . /proc/version' },
  nu: { command: 'ls | length | to json' },
  msys: { command: 'echo msys-$MSYSTEM-$BASH_VERSION && pacman -Q 2>/dev/null | wc -l' },
  zsh: { command: 'echo zsh-$ZSH_VERSION && a=(x y); print ${(w)#a}' },
  fish: { command: 'echo fish-$version && math "6*7"' },
  brush: { command: 'echo brush-$BASH_VERSION && echo "test" | tr a-z A-Z' },
  pty: { command: `powershell -NoProfile -ExecutionPolicy Bypass -File ${gate}`, send: ['y\n'] },
};

const wanted = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(CASES);
const surfaces = resolveSurfaces();

for (const id of wanted) {
  const spec = surfaces[id];
  const testCase = CASES[id];
  if (!spec) {
    console.log(`== ${id}: no such surface`);
    continue;
  }
  if (!spec.present) {
    console.log(`== ${id}: absent (${spec.absent})`);
    continue;
  }
  if (id === 'pty' && !existsSync(gate)) {
    console.log(`== ${id}: skipped -- no gate script at ${gate}`);
    continue;
  }
  const started = Date.now();
  const result = await runSurface(id, spec, {
    command: testCase.command,
    script: '',
    cwd: '',
    send: testCase.send ?? [],
    settleMs: 5000,
    timeoutMs: 60000,
    maxOutputChars: 4000,
  });
  const ms = Date.now() - started;
  const flatten = (text, n = 300) => text.replace(/\s+/g, ' ').trim().slice(0, n);
  console.log(`== ${id}: exit=${result.exitCode} timedOut=${result.timedOut} ms=${ms} spawnError=${result.spawnError || '-'}`);
  console.log(`   stdout: ${flatten(result.stdout) || '(empty)'}`);
  if (result.stderr) console.log(`   stderr: ${flatten(result.stderr, 200)}`);
  if (result.note) console.log(`   note: ${result.note}`);
}
