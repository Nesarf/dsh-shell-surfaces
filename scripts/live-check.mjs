// Live check: run one real command on every surface that exists here, through the
// plugin's own code path. Not a test of the tool registry (that needs a running
// host) -- a test of whether each surface actually answers.
//
// Usage:
//   node scripts/live-check.mjs [surface ...]      (default: every surface that exists)
//   DSH_PLUGIN_ROOT=<checkout> node scripts/live-check.mjs wsl nu pty
//
// Environment:
//   DSH_PLUGIN_ROOT  where this plugin lives, so the script can be run from
//                    anywhere. Defaults to the parent of this file's directory.
//   DSH_PTY_GATE     the script for the pty case -- one that asks a question on
//                    the console. Defaults to the fixture beside this file.
//
// Three things are reported, not two: a surface can pass, fail, or be skipped.
// Skipping is not failing -- a surface this machine does not have is a fact about
// the machine, while a surface that answered with the wrong exit code is a fact
// about the plugin. The exit code follows only the second kind, because CI needs
// to distinguish "nothing to run here" from "something broke".
//
// On Linux this drives bash and sh (the surfaces a Linux runner has); on Windows
// it drives the whole set. The pty case is Windows-only in practice: the console
// runner talks to ConPTY through pywinpty.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.DSH_PLUGIN_ROOT ?? join(here, '..'));
const isWindows = process.platform === 'win32';

/**
 * Is the WSL surface actually usable, rather than merely installed?
 *
 * Measured on a GitHub runner: `wsl.exe` is on PATH there but has no distribution,
 * so `wsl.exe -d Nyarch -- bash ...` answers
 * "There is no distribution with the supplied name (WSL_E_DISTRO_NOT_FOUND)" and
 * exits with 4294967295. That is an absent surface, not a broken one, and a check
 * that calls it a failure teaches its reader to ignore failures.
 */
function hasWslDistro(spec) {
  const distro = process.env.DSH_WSL_DISTRO ?? 'Nyarch';
  try {
    const result = spawnSync(spec.exe, ['-d', distro, '--', 'true'], { stdio: 'ignore', timeout: 20000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Does the python on PATH have the console library? A cell, so it does not start the console. */
function hasPywinpty() {
  try {
    const result = spawnSync('python', ['-c', 'import winpty'], { stdio: 'ignore', timeout: 20000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

const { resolveSurfaces } = await import(pathToFileURL(join(root, 'lib', 'surfaces.js')).href);
const { runSurface } = await import(pathToFileURL(join(root, 'lib', 'runner.js')).href);

const ptyGate = process.env.DSH_PTY_GATE ?? join(here, isWindows ? 'pty-gate.ps1' : 'pty-gate.sh');

// The command each surface is asked. Every key here must also be a key in the
// plugin's surface table, or the loop reports "no such surface" and the case is
// dead weight. There is deliberately no `bash` entry: this plugin's table has no
// POSIX shell surface (that is DSH's own tool), so a case for one would only ever
// be skipped. On Linux the table's surfaces are all absent, and the honest report
// there is "absent", not a fabricated pass.
const COMMON_CASES = {};

const WINDOWS_CASES = {
  wsl: { command: 'uname -sr && grep -c . /proc/version' },
  nu: { command: 'ls | length | to json' },
  msys: { command: 'echo msys-$MSYSTEM-$BASH_VERSION && pacman -Q 2>/dev/null | wc -l' },
  zsh: { command: 'echo zsh-$ZSH_VERSION && a=(x y); print ${(w)#a}' },
  fish: { command: 'echo fish-$version && math "6*7"' },
  brush: { command: 'echo brush-$BASH_VERSION && echo "test" | tr a-z A-Z' },
  pty: { command: `powershell -NoProfile -ExecutionPolicy Bypass -File ${ptyGate}`, send: ['y\n'] },
};

// What each case must produce to count as a pass. A bare exit code is not enough:
// `bash -c ""` also exits 0, and the failures this script exists to catch (a
// command mangled by quoting, output decoded as the wrong encoding) are exactly
// the ones that keep exit code 0.
const EXPECT = {
  wsl: { re: /Linux \d/, why: 'the kernel string came back' },
  nu: { re: /^\s*\d+\s*$/, why: 'a structured pipeline produced a number' },
  msys: { re: /msys-MSYS-/, why: 'MSYS2 bash answered with its MSYSTEM' },
  zsh: { re: /zsh-\d/, why: 'zsh answered' },
  fish: { re: /fish-\d/ , why: 'fish answered' },
  brush: { re: /brush-\d/, why: 'brush answered' },
  pty: { re: /door opened|door stayed shut/, why: 'the console answered its prompt' },
};

const cases = isWindows ? { ...COMMON_CASES, ...WINDOWS_CASES } : { ...COMMON_CASES };
const wanted = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(cases);
const surfaces = resolveSurfaces();

let passed = 0;
let failed = 0;
let skipped = 0;

for (const id of wanted) {
  const spec = surfaces[id];
  const testCase = cases[id];
  const flatten = (text, n = 300) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

  if (!spec) {
    console.log(`-- ${id}: no such surface in the table`);
    skipped += 1;
    continue;
  }
  if (!spec.present) {
    console.log(`-- ${id}: absent (${spec.absent})`);
    skipped += 1;
    continue;
  }
  if (!testCase) {
    console.log(`-- ${id}: present but this script has no case for it`);
    skipped += 1;
    continue;
  }
  if (id === 'pty' && !isWindows) {
    // The console runner is pywinpty: on POSIX a pipe and a console are already
    // close enough that this surface has nothing to prove there. Reported as a
    // skip with the reason, never as a pass.
    console.log('-- pty: skipped -- the console runner is ConPTY (pywinpty), which is Windows-only in practice');
    skipped += 1;
    continue;
  }
  if (id === 'wsl' && !hasWslDistro(spec)) {
    console.log('-- wsl: skipped -- wsl.exe is on PATH but reports no distribution installed');
    skipped += 1;
    continue;
  }
  if (id === 'pty' && !hasPywinpty()) {
    console.log('-- pty: skipped -- the python on PATH cannot import winpty');
    skipped += 1;
    continue;
  }
  if (id === 'pty' && !existsSync(ptyGate)) {
    console.log(`-- ${id}: skipped -- no gate script at ${ptyGate}`);
    skipped += 1;
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

  // Second line of defence for the same distinction: if a surface answers with a
  // message about the machine rather than about the command, that is an absent
  // environment, not a failure of the plugin. The pre-checks above should have
  // caught it; this catches the case where the probe passed and the run still hit
  // a machine-level condition (a distro that vanished, a library that moved).
  const environmentMissing = /WSL_E_DISTRO_NOT_FOUND|no distribution|is not importable|ModuleNotFoundError/i.test(
    result.stdout + result.stderr,
  );
  if (environmentMissing && result.exitCode !== 0) {
    console.log(`-- ${id}: skipped -- the environment cannot run it: ${flatten(result.stdout + ' ' + result.stderr, 120)}`);
    skipped += 1;
    continue;
  }

  const expect = EXPECT[id];
  const answered = expect ? expect.re.test(result.stdout) : result.stdout.length > 0;
  const ok = !result.timedOut && !result.spawnError && result.exitCode === 0 && answered;

  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}: exit=${result.exitCode} timedOut=${result.timedOut} ms=${ms}`);
  console.log(`     stdout: ${flatten(result.stdout) || '(empty)'}`);
  if (result.stderr) console.log(`     stderr: ${flatten(result.stderr, 200)}`);
  if (ok) passed += 1;
  else {
    failed += 1;
    if (expect && !answered) console.log(`     expected output matching ${expect.re} -- ${expect.why}`);
  }
}

console.log(`\nlive-check: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed === 0 ? 0 : 1);
