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

import { appendFileSync, existsSync } from 'node:fs';
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
  dash: { command: 'echo dash-$((6*7))' },
  // tcsh's $version already begins with its own name ("tcsh 6.24.16 ..."), so a
  // "tcsh-$version" line came back as "tcsh-tcsh 6.24.16" and the first version
  // of this expectation rejected it (measured). Ask for a plain word instead.
  tcsh: { command: 'echo tcsh-ok' },
  busybox: { command: 'echo busybox-$((6*7))' },
  // PowerShell is a surface here, so "fall back to PowerShell" no longer means
  // leaving this plugin. The case checks both halves: the shell identifies
  // itself (major version) and arithmetic runs, so a profile or argument-order
  // regression cannot pass as a healthy shell.
  pwsh: { command: '$PSVersionTable.PSVersion.Major.ToString() + ":" + (6*7)' },
  // The other PowerShell, on purpose: a machine holding both must be able to ask
  // 5.1 a question, and the answer has to be 5 and not 7.
  powershell: { command: '$PSVersionTable.PSVersion.Major.ToString() + ":" + (6*7)' },
  python: { command: 'print(6*7)' },
  node: { command: 'console.log(6*7)' },
  perl: { command: 'print 6*7, "\\n"' },
  // The one surface whose input is a file: the command is a VBScript body, and
  // the inline-file mechanism writes it out before cscript ever runs.
  cscript: { command: 'WScript.Echo 6*7' },
  pty: { command: `powershell -NoProfile -ExecutionPolicy Bypass -File ${ptyGate}`, send: ['y\n'] },
};

// A terminal face opens a real window, so a routine run does not ask three of
// them: opt in with DSH_LIVE_TERMINALS=1 (or name one on the command line).
const WINDOW_CASES = {
  wt: { command: 'echo wt-ok' },
  mintty: { command: 'echo mintty-ok' },
  wezterm: { command: 'echo wezterm-ok' },
  // Tabby needs the one-time profile install (`node scripts/tabby-setup.mjs`);
  // without it this case waits out its budget and fails, which is the honest
  // report -- the profile is a configuration a person has to accept once.
  tabby: { command: 'echo tabby-ok' },
};

// Shells living inside a distribution. They are keyed by the derived surface id,
// so they only run when the scan found that shell.
const DISTRO_SHELL_CASES = {
  'wsl-osh': { command: 'echo osh-$((6*7))' },
  'wsl-ysh': { command: 'echo ysh-ok' },
  'wsl-dash': { command: 'echo dash-$((6*7))' },
  'wsl-elvish': { command: 'echo elvish-ok' },
  'wsl-ksh': { command: 'echo ksh-ok' },
  'wsl-xonsh': { command: 'print("xonsh-ok")' },
  'wsl-mksh': { command: 'echo mksh-ok' },
  'wsl-tcsh': { command: 'echo tcsh-ok' },
  'wsl-busybox': { command: 'echo busybox-ok' },
  'wsl-nu': { command: '6 * 7' },
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
  dash: { re: /dash-42/, why: 'dash answered with arithmetic' },
  tcsh: { re: /tcsh-ok/, why: 'tcsh answered' },
  busybox: { re: /busybox-42/, why: 'BusyBox sh answered with arithmetic' },
  pwsh: { re: /^\s*\d+:42\s*$/m, why: 'PowerShell answered with its major version and arithmetic' },
  powershell: { re: /^\s*5:42\s*$/m, why: 'Windows PowerShell 5.1 answered as 5, not 7' },
  python: { re: /^\s*42\s*$/m, why: 'Python answered' },
  node: { re: /^\s*42\s*$/m, why: 'Node answered' },
  perl: { re: /^\s*42\s*$/m, why: 'Perl answered' },
  cscript: { re: /^\s*42\s*$/m, why: 'Windows Script Host answered from a temporary .vbs' },
  wt: { re: /wt-ok/, why: 'the shim carried a command into a Windows Terminal tab' },
  mintty: { re: /mintty-ok/, why: 'the shim carried a command into a mintty window' },
  wezterm: { re: /wezterm-ok/, why: 'a wezterm pane answered and was read back' },
  tabby: { re: /tabby-ok/, why: 'the dss profile ran the agent and the job file came back' },
  pty: { re: /door opened|door stayed shut/, why: 'the console answered its prompt' },
};

for (const [id, why] of [
  ['wsl-osh', 'osh answered with arithmetic'],
  ['wsl-ysh', 'ysh answered'],
  ['wsl-dash', 'dash inside a distribution answered'],
  ['wsl-elvish', 'elvish answered'],
  ['wsl-ksh', 'ksh answered'],
  ['wsl-xonsh', 'xonsh answered'],
  ['wsl-mksh', 'mksh answered'],
  ['wsl-tcsh', 'tcsh answered'],
  ['wsl-busybox', 'BusyBox inside a distribution answered'],
  ['wsl-nu', 'nushell inside a distribution answered'],
]) {
  EXPECT[id] = { re: /-ok|-42|^\s*42\s*$/m, why };
}

// Naming a window face on the command line is also opting in. README promises
// it, and a run that names `wt` and then silently skips it is the kind of small
// lie that makes a check untrustworthy.
const named = process.argv.slice(2);
const wantsWindows = process.env.DSH_LIVE_TERMINALS === '1' || named.some((id) => id in WINDOW_CASES);
const windowCases = wantsWindows ? WINDOW_CASES : {};
const cases = isWindows
  ? { ...COMMON_CASES, ...WINDOWS_CASES, ...windowCases, ...DISTRO_SHELL_CASES }
  : { ...COMMON_CASES };
const wanted = named.length > 0 ? named : Object.keys(cases);

// JSON mode: the human-readable lines go to stderr so stdout stays one JSON
// document that probe-table.mjs can eat. The two readers want the same run --
// "is it alive" and "what did it answer" are the same fact seen twice.
const jsonMode = process.env.LIVE_CHECK_JSON === '1';
const note = jsonMode ? (...args) => console.error(...args) : (...args) => console.log(...args);
const surfaces = resolveSurfaces();

if (wanted.length === 0) {
  // Reached on a platform this plugin's table has no surface for (a Linux runner:
  // every entry in the table is a Windows-side surface). Printed as its own
  // sentence, because "0 passed, 0 failed, 0 skipped" is technically true and
  // tells the reader nothing about why nothing ran.
  console.log('-- nothing to run here: this table has no surface for this platform');
  console.log(`   the table: ${Object.keys(surfaces).join(', ')}`);
  console.log('   (the POSIX shell on this machine is DSH\'s own tool, not this plugin)');
  console.log('\nlive-check: nothing applicable on this platform');
  process.exit(0);
}

const flatten = (text, n = 300) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const rows = [];
const tally = { pass: 0, fail: 0, absent: 0, skip: 0 };

for (const id of wanted) {
  const spec = surfaces[id];
  const testCase = cases[id];

  if (!spec) {
    rows.push({ id, state: 'skip', detail: 'no such surface in the table', ms: '' });
    tally.skip += 1;
    continue;
  }
  if (!spec.present) {
    rows.push({ id, state: 'absent', detail: spec.absent, ms: '' });
    tally.absent += 1;
    continue;
  }

  // Reasons a surface is present but cannot be exercised here. Each one is about
  // the machine, and each is printed with its reason rather than counted as a
  // failure -- a check that calls an absent environment "broken" teaches its
  // reader to ignore failures.
  const skipReason =
    !testCase
      ? 'present, but this script has no case for it'
      : id === 'pty' && !isWindows
        ? 'the console runner is ConPTY (pywinpty), Windows-only in practice'
        : id === 'wsl' && !hasWslDistro(spec)
          ? 'wsl.exe is on PATH but reports no distribution installed'
          : id === 'pty' && !hasPywinpty()
            ? 'the python on PATH cannot import winpty'
            : id === 'pty' && !existsSync(ptyGate)
              ? `no gate script at ${ptyGate}`
              : '';
  if (skipReason) {
    rows.push({ id, state: 'skip', detail: skipReason, ms: '' });
    tally.skip += 1;
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
  // environment, not a plugin failure. The pre-checks above should have caught
  // it; this catches the run that still hit a machine-level condition.
  if (
    result.exitCode !== 0 &&
    /WSL_E_DISTRO_NOT_FOUND|no distribution|is not importable|ModuleNotFoundError/i.test(result.stdout + result.stderr)
  ) {
    rows.push({ id, state: 'skip', detail: flatten(`${result.stdout} ${result.stderr}`, 120), ms: String(ms) });
    tally.skip += 1;
    continue;
  }

  const expect = EXPECT[id];
  const answered = expect ? expect.re.test(result.stdout) : result.stdout.length > 0;
  const ok = !result.timedOut && !result.spawnError && result.exitCode === 0 && answered;
  const shown = flatten(result.stdout) || '(empty)';

  note(`${ok ? 'ok  ' : 'FAIL'} ${id}: exit=${result.exitCode} timedOut=${result.timedOut} ms=${ms}`);
  note(`     stdout: ${shown}`);
  if (result.stderr) note(`     stderr: ${flatten(result.stderr, 200)}`);
  if (ok) {
    rows.push({ id, state: 'pass', detail: shown, ms: String(ms) });
    tally.pass += 1;
  } else {
    const why = result.timedOut
      ? 'timed out'
      : result.spawnError
        ? `could not start: ${result.spawnError}`
        : expect && !answered
          ? `output did not match ${expect.re} -- ${expect.why}`
          : `exit code ${result.exitCode}`;
    rows.push({ id, state: 'fail', detail: why, ms: String(ms) });
    tally.fail += 1;
    note(`     ${why}`);
  }
}

// One run, two readers: the live check already asks each surface one real
// command, and its answer IS the version census probe-faces.mjs used to ask for
// separately. `LIVE_CHECK_JSON=1` hands that to probe-table.mjs (which the CI
// step feeds straight in), while the human-readable lines go to stderr so the
// JSON on stdout stays parseable.
if (jsonMode) {
  const shells = rows.map((row) => ({
    shell: row.id,
    ms: row.ms,
    answer: row.state === 'pass' ? row.detail : `${row.state}: ${row.detail}`,
  }));
  process.stdout.write(JSON.stringify({ shells }));
  process.exit(tally.fail > 0 ? 1 : 0);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  // The console output is the record; this is the table a reader skims. It says
  // the same thing in one place, and it is why "the runner is missing half the
  // surfaces" is answerable without opening the log.
  const lines = [
    '',
    '### Live check: one real command per surface',
    '',
    `- platform: ${process.platform}`,
    `- ${tally.pass} passed, ${tally.fail} failed, ${tally.absent} absent, ${tally.skip} skipped`,
    '',
    '| surface | result | detail | ms |',
    '| --- | --- | --- | ---: |',
  ];
  for (const row of rows) {
    lines.push(`| ${row.id} | ${row.state} | ${row.detail.replace(/\|/g, '\\|').slice(0, 160)} | ${row.ms} |`);
  }
  const table = `${lines.join('\n')}\n`;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  // Also to the log, and not only to the summary. A writer that leaves no trace
  // in the log is indistinguishable from one that failed -- I could not tell from
  // the API whether the summary was empty because nothing was written or because
  // I was reading the wrong field, and that ambiguity cost a round trip. Printing
  // it settles that question in the same place the rest of the evidence lives.
  console.log(table);
}

console.log(`\nlive-check: ${tally.pass} passed, ${tally.fail} failed, ${tally.absent} absent, ${tally.skip} skipped`);
process.exit(tally.fail === 0 ? 0 : 1);
