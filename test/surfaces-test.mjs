// Checks the parts of this plugin that can be checked without a session: the
// table, the argv shape, and the output contract the host validates against.
//
// The three argv assertions are the ones that matter, because each encodes a
// measured fact rather than a preference:
//   * the WSL command crosses as a single argument after `--`, so no shell on
//     this side re-parses it (the trap was `/mnt/e/x.sh` becoming
//     `C:/Program Files/Git/mnt/e/x.sh`);
//   * every MSYS-family shell gets a login flag, because /tmp otherwise means
//     different places to two neighbouring processes on this machine;
//   * brush gets none, because it has no mount table to log into.
//
// Run: node test/surfaces-test.mjs

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { resolveSurfaces, surfaceSpecs, lastScan, describeSurfaces, openPathFor, scanSshHosts } from '../lib/surfaces.js';
import { scan } from '../lib/discover.js';
import { buildArgv, toWslPath } from '../lib/runner.js';
import { apply, inject, name as pluginName } from '../lib/index.js';
import { closeSessions } from '../lib/sessions.js';

let passed = 0;
const failures = [];

// A cold WSL instance outlasts the scan's probe budget, and a scan that gives up
// on a distribution silently drops every `wsl-<shell>` face. That made this
// suite report 154 or 160 depending on whether anybody had touched WSL recently
// (measured 2026-10-24), which reads as flakiness rather than as the machine
// fact it is. Waking the instance first costs a few seconds and makes the total
// reproducible; the assertions about a distribution's shells still skip when the
// machine genuinely has none.
if (process.platform === 'win32') {
  spawnSync('wsl.exe', ['--', 'true'], { timeout: 90000, windowsHide: true });
}

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail ? ` -- ${detail}` : ''}`);
}

function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- the table -----------------------------------------------------------------

const specs = surfaceSpecs();
const ids = Object.keys(specs);
for (const required of ['wsl', 'nu', 'msys', 'zsh', 'fish', 'brush', 'tcsh', 'busybox', 'pwsh', 'pty']) {
  check(`table has the ${required} surface`, required in specs);
}
check('every surface carries a summary and a guide', ids.every((id) => specs[id].summary && specs[id].guide));
check(
  'every surface says where to look when it is absent',
  ids.every((id) => typeof specs[id].absent === 'string' && specs[id].absent.length > 0),
);

// --- the scan --------------------------------------------------------------------

// Found, not assumed: the table's paths are defaults, and a machine that moved
// its installs is discovered rather than edited.
const report = scan();
check('the scan names its platform', typeof report.platform === 'string');
check(
  'every discovered shell carries the path and the source it came from',
  report.shells.length > 0 &&
    report.shells.every(
      (hit) => typeof hit.path === 'string' && hit.path.length > 0 && typeof hit.source === 'string' && hit.source.length > 0,
    ),
);
check(
  'every discovered terminal carries the same two facts',
  report.terminals.every(
    (hit) => typeof hit.path === 'string' && hit.path.length > 0 && typeof hit.source === 'string',
  ),
);
check('the scan reports the WSL listing as an array', Array.isArray(report.distros));
if (process.platform === 'win32') {
  check('a Windows scan finds a PowerShell of some kind', report.shells.some((hit) => /^(pwsh|powershell)\.exe$/i.test(hit.name)));
  check('a Windows scan finds a bash of some kind', report.shells.some((hit) => /^bash\.exe$/i.test(hit.name)));
}
check('the process keeps one scan, not one per question', lastScan() === lastScan());
check(
  'the wsl surface carries the distro it will actually run',
  typeof specs.wsl.distro === 'string' && specs.wsl.distro.length > 0,
);
if (process.platform === 'win32') {
  check(
    'a scanned userland or interpreter becomes a surface of its own',
    specs['git-bash'] !== void 0 || specs.cmd !== void 0,
  );
}

// --- wsl ------------------------------------------------------------------------

equal('wsl path: drive letter', toWslPath('E:\\DaShaoHuo\\x.sh'), '/mnt/e/DaShaoHuo/x.sh');
equal('wsl path: forward slashes', toWslPath('D:/msys64/usr/bin/bash.exe'), '/mnt/d/msys64/usr/bin/bash.exe');
equal('wsl path: posix path is left alone', toWslPath('/usr/bin/env'), '/usr/bin/env');

const wslInline = buildArgv('wsl', specs.wsl, { command: 'uname -sr', script: '', cwd: '', send: [] });
// Measured 2026-10-20: wsl.exe recomposes its arguments into one command line
// and that line is parsed again inside the distribution, so a `$VAR` in an
// argument was expanded by a shell that had never run the loop defining it
// (`for n in alpha beta; do echo "n=[$n]"; done` printed n=[] twice, and even a
// single-quoted literal lost its value). stdin is the one channel it does not
// rewrite, so the command is not an argument at all any more.
check('wsl command travels on stdin, not as an argument', wslInline.stdin === 'uname -sr\n' && !wslInline.argv.includes('uname -sr'));
check('wsl asks bash to read its script from stdin', wslInline.argv.at(-2) === '-l' && wslInline.argv.at(-1) === '-s');
check('wsl argv carries no quoting and no dollar sign at all', !wslInline.argv.some((a) => /["'$]/.test(a)));

const wslScript = buildArgv('wsl', specs.wsl, {
  command: '',
  script: 'E:\\DaShaoHuo\\cache\\tmp\\probe.sh',
  cwd: '',
  send: [],
});
equal('wsl script becomes a file path', wslScript.argv.at(-1), '/mnt/e/DaShaoHuo/cache/tmp/probe.sh');

const wslCwd = buildArgv('wsl', specs.wsl, { command: 'pwd', script: '', cwd: 'E:\\DaShaoHuo', send: [] });
check('wsl cwd stays a Windows path for wsl.exe to translate', wslCwd.argv.includes('E:\\DaShaoHuo'));

// A wsl session keeps one login bash alive inside the distribution: the argv has
// to carry the distribution, so it cannot be `exe` + a flag list (measured
// 2026-10-24: `cd /tmp` then `echo "$DSS_PROBE:$(pwd)"` answered 41:/tmp).
check(
  'a wsl session puts the distribution on the command line',
  (() => {
    const argv = specs.wsl.session.argvFor(specs.wsl);
    return argv[0] === 'wsl.exe' && argv.includes('-d') && argv.includes('--') && argv.at(-1) === '-s';
  })(),
);
check('and asks bash for a stdin script rather than a command argument', specs.wsl.session.argvFor(specs.wsl).includes('-s'));
if (specs.fish !== void 0) {
  // fish refuses `-s` and treats a piped stdin as a script file, so its session
  // keeps stdin away from the parser and reads it with fish's own `read`. A plain
  // `-l` argv measured as silence in a live session (2026-10-24).
  check(
    'fish reads its session through its own line reader',
    (specs.fish.session?.argv ?? []).join(' ').includes('while read'),
  );
}
if (specs['wsl-elvish'] !== void 0) {
  check(
    'a derived wsl face does not inherit the bash session',
    specs['wsl-elvish'].session === void 0,
    'a session there would quietly run bash while the row claims elvish',
  );
}
if (specs.podman !== void 0) {
  // A container runtime is a place to run a command, so it is a face -- throwaway
  // by design, because a face is one command rather than a session.
  equal('podman is a container surface', specs.podman.kind, 'container');
  check('and it runs a throwaway container', (specs.podman.wslExec?.argv ?? []).includes('--rm'));
  check(
    'with sh -c carrying the command, handed over the same way a derived shell is',
    (specs.podman.wslExec?.argv ?? []).slice(-2).join(' ') === 'sh -c',
  );
}

// A shell that lives inside a distribution gets its own face, and its command is
// handed to that shell rather than to bash: `exec <program> -c '<command>'` is
// written to the same stdin script, single-quoted so the outer bash passes it
// through untouched.
const elvishSpec = specs['wsl-elvish'];
if (elvishSpec !== void 0) {
  const built = buildArgv('wsl-elvish', elvishSpec, { command: 'echo hi', script: '', cwd: '', send: [] });
  check('a distribution shell is exec-ed with -c', built.stdin.startsWith('exec elvish -c '));
  check('its command is quoted so the outer bash leaves it alone', built.stdin.includes("'echo hi'"));
  check('and it keeps the same stdin hand-off as wsl', built.argv.at(-1) === '-s');
}
const busyboxWsl = specs['wsl-busybox'];
if (busyboxWsl !== void 0) {
  const built = buildArgv('wsl-busybox', busyboxWsl, { command: 'echo ok', script: '', cwd: '', send: [] });
  check('busybox inside a distribution is asked for its sh', built.stdin.startsWith('exec busybox sh -c '));
}
// `sh` is bash's alias on this distribution, so it is the same duplicate as
// `bash` -- two names for the face that already exists. Measured 2026-10-24, when
// merging the scans briefly produced `wsl-sh`.
check(
  'a distribution shell never duplicates the bash that wsl already is',
  specs['wsl-bash'] === void 0 && specs['wsl-sh'] === void 0,
);

// --- dash and the two PowerShells -----------------------------------------------

const dashArgv = buildArgv('dash', specs.dash, { command: 'echo ok', script: '', cwd: '', send: [] });
check('dash gets a plain -c', dashArgv.argv.includes('-c'));
check('dash gets the MSYS PATH prefix so its coreutils resolve', dashArgv.env.PATH_PREFIX !== void 0);

const ps51 = buildArgv('powershell', specs.powershell, { command: 'echo hi', script: '', cwd: '', send: [] });
equal(
  'PowerShell 5.1 gets the same -Command shape as pwsh',
  ps51.argv.slice(1).join(' '),
  '-NoProfile -NonInteractive -Command echo hi',
);
const ps51File = buildArgv('powershell', specs.powershell, { command: '', script: 'C:\\x.ps1', cwd: '', send: [] });
check('PowerShell 5.1 wants -File for a script', ps51File.argv.includes('-File') && !ps51File.argv.includes('-Command'));
check(
  'PowerShell 5.1 and 7 are two surfaces, not one variable',
  specs.powershell !== void 0 && specs.pwsh !== void 0 && specs.powershell.exe !== specs.pwsh.exe,
);

// --- interpreters ---------------------------------------------------------------

// An interpreter is a face the same way a shell is: it takes a command and
// answers with stdout. What makes it a separate kind is that the flag differs
// (`-c` for Python, `-e` for Node) and there is no pipeline to quote around.
for (const [id, flag] of [['python', '-c'], ['node', '-e'], ['perl', '-e']]) {
  const spec = specs[id];
  if (spec === void 0) continue;
  const built = buildArgv(id, spec, { command: 'print(1)', script: '', cwd: '', send: [] });
  check(`${id} is an interpreter run with ${flag}`, built.argv.includes(flag) && spec.kind === 'interpreter');
}
check('perl is asked not to warn about a locale it cannot honour', specs.perl.env?.PERL_BADLANG === '0');

// --- cscript: the one surface whose input is a file -----------------------------

// `cscript //nologo` takes a .vbs path and has no `-c`, so the command has to
// land in a file first. What matters is that the code never reaches argv and the
// file is reported back for removal (measured 2026-10-24: the run answered
// "cscript-face-ok" and the spill directory did not grow).
const cscriptBuilt = buildArgv('cscript', specs.cscript, { command: 'WScript.Echo "x"', script: '', cwd: '', send: [] });
check('cscript is handed a file, not the code', cscriptBuilt.argv.at(-1).endsWith('.vbs'));
check('the code itself never appears in argv', !cscriptBuilt.argv.includes('WScript.Echo "x"'));
check(
  'the inline file is listed so the caller can remove it',
  (cscriptBuilt.cleanup ?? []).length === 1 && cscriptBuilt.cleanup[0].endsWith('.vbs'),
);
for (const file of cscriptBuilt.cleanup ?? []) {
  try {
    unlinkSync(file);
  } catch {
    /* the assertion above already covered the path */
  }
}

// --- ssh destinations -----------------------------------------------------------

// A `User git` host and a wildcard are not destinations a command can be sent
// to, so neither becomes a surface. Measured on this machine: its only entry is
// github.com with User git, which is why the ssh family is empty here.
equal(
  'a git-only host and a wildcard are dropped',
  scanSshHosts('Host github.com\n  User git\nHost *.internal\n  User ops\nHost box\n  User ada\n').join(','),
  'box',
);
equal('an empty config yields no destinations', scanSshHosts('').join(','), '');

// `accept-new` is the behaviour that fits both ends: a host seen for the first
// time is recorded, while a host whose key CHANGED is still refused. Measured
// 2026-10-24: without it the first call to any new host died with "Host key
// verification failed", which reads as a broken destination rather than an
// unrecorded one.
const sshDestination = Object.entries(resolveSurfaces()).find(([id, spec]) => id.startsWith('ssh-') && Array.isArray(spec.argv));
if (sshDestination !== void 0) {
  check(
    'an ssh destination records a new host key and still refuses a changed one',
    sshDestination[1].argv.includes('StrictHostKeyChecking=accept-new'),
  );
}

// --- the terminal program -------------------------------------------------------

// WezTerm is the one terminal program with a face, and it is not a shell: it is
// driven through `wezterm cli spawn` / `get-text` rather than given a `-c`, so a
// shell argv would be wrong for it. The face exists because its mux server can
// answer both questions a window normally cannot (measured 2026-10-24).
equal('wezterm is a terminal surface, not a shell', specs.wezterm.kind, 'terminal');
check('a terminal surface carries no shell argv', specs.wezterm.argv === void 0);
check('and its guide names the two calls that make it usable', /spawn/.test(specs.wezterm.guide) && /get-text|pane text/.test(specs.wezterm.guide));

// A window that can only START a process gets the shim instead: the host runs
// `node scripts/dss-exec.mjs`, the shim writes a structured result, and this side
// polls for the file (measured 2026-10-24: wt and mintty both answered in under
// 60 ms with the right exit code).
for (const id of ['wt', 'mintty']) {
  const spec = specs[id];
  if (spec === void 0) continue;
  equal(`${id} is a shim-backed terminal surface`, spec.shim, true);
  check(`${id} launches a program rather than taking a -c`, spec.launch !== void 0 && spec.argv === void 0);
}
check('the shim script exists', existsSync(join(import.meta.dirname, '..', 'scripts', 'dss-exec.mjs')));

// "Reported but not a face" comes with a next step, not a shrug.
check(
  'every discovered terminal comes back with a next step',
  /shim|face|channel|session host|no cli|not a launcher/.test(openPathFor('tabby.exe')),
);
// Tabby has no `-e` and no `new-tab -- <program>`, but it does have
// `tabby profile <name>` and a local profile carrying command+args -- so the
// opening is a profile that runs a fixed agent plus a per-call job file
// (measured 2026-10-24: the agent answered 45 ms after launch).
check('Tabby is named as a face now that the profile path exists', /face: `tabby`/.test(openPathFor('tabby.exe')));
equal('tabby is a terminal surface driven by a profile', specs.tabby.tabbyProfile, 'dss');
check(
  'tabby carries a job file and the agent that reads it',
  typeof specs.tabby.jobFile === 'string' &&
    specs.tabby.jobFile.endsWith('.json') &&
    existsSync(join(import.meta.dirname, '..', 'scripts', 'dss-tabby-agent.mjs')) &&
    existsSync(join(import.meta.dirname, '..', 'scripts', 'tabby-setup.mjs')),
);
check('git-shell gets a channel, not a shim', /channel/.test(openPathFor('git-shell')));
check('a multiplexer is named as a session host', /session host/.test(openPathFor('tmux')));

// --- the family tree ------------------------------------------------------------

const resolvedTree = resolveSurfaces();
equal('msys owns the shells installed beside it', resolvedTree.zsh.parent, 'msys');
equal('msys is the root of its own family', resolvedTree.msys.parent, '');
equal('the msys family is named', resolvedTree.zsh.family, 'msys2');
if (resolvedTree['wsl-elvish'] !== void 0) {
  equal('a shell inside a distribution hangs under wsl', resolvedTree['wsl-elvish'].parent, 'wsl');
  equal('and belongs to the wsl family', resolvedTree['wsl-elvish'].family, 'wsl');
}
equal('a standalone shell has no family', resolvedTree.pwsh.family, '');

const treeText = describeSurfaces(resolvedTree);
check('the tree draws a userland child under its parent', /├─ zsh \[/.test(treeText) || /└─ zsh \[/.test(treeText));
check('a child row carries one connector, not two dashes', !/├─ - /.test(treeText) && !/└─ - /.test(treeText));
check('a root row still reads as a list item', /^- wsl \[/.test(treeText) || /^- msys \[/.test(treeText));

// --- the MSYS family ------------------------------------------------------------

for (const id of ['msys', 'zsh', 'fish']) {
  const built = buildArgv(id, specs[id], { command: 'echo ok', script: '', cwd: '', send: [] });
  check(`${id} runs as a login shell`, built.argv.some((a) => a === '-l' || a === '-lc'));
  check(`${id} gets MSYSTEM pinned`, built.env.MSYSTEM === 'MSYS');
}
const brushArgv = buildArgv('brush', specs.brush, { command: 'echo ok', script: '', cwd: '', send: [] });
check('brush is not given a login flag', !brushArgv.argv.includes('-l') && !brushArgv.argv.includes('-lc'));
check('brush does not claim MSYS', brushArgv.env.MSYSTEM === 'UCRT64');
// The UTF-8 request is added at resolution time, so this one reads a resolved entry.
const resolvedBrush = resolveSurfaces().brush;
check('the MSYS family is asked for UTF-8', resolvedBrush.env.LANG === 'C.UTF-8' && resolvedBrush.env.LC_ALL === 'C.UTF-8');

// --- nu and pty -----------------------------------------------------------------

const nuArgv = buildArgv('nu', specs.nu, { command: 'ls | length', script: '', cwd: '', send: [] });
check('nu gets a command flag', nuArgv.argv.includes('-c'));
check('nu command is one element', nuArgv.argv.at(-1) === 'ls | length');

const ptyArgv = buildArgv('pty', specs.pty, {
  command: 'cmd /c ver',
  script: '',
  cwd: '',
  send: ['y\n'],
  ptyArgv: ['cmd', '/c', 'ver'],
  timeoutMs: 60000,
  settleMs: 3000,
});
check('pty calls the python runner', ptyArgv.argv[1].endsWith('pty_runner.py'));
check('pty passes the send text through', ptyArgv.argv.includes('y\n'));
check('pty separates flags from the command with --', ptyArgv.argv.includes('--'));
const ptyJson = ptyArgv.argv[ptyArgv.argv.indexOf('--argv-json') + 1];
const ptyDecoded = JSON.parse(Buffer.from(ptyJson, 'base64').toString('utf8'));
check('pty carries an argv array, not a command line', JSON.stringify(ptyDecoded) === JSON.stringify(['cmd', '/c', 'ver']));
const ptyTokenized = buildArgv('pty', specs.pty, {
  command: 'cmd /c "echo hello world"',
  script: '',
  cwd: '',
  send: [],
  timeoutMs: 60000,
  settleMs: 3000,
});
const tokenized = JSON.parse(Buffer.from(ptyTokenized.argv[ptyTokenized.argv.indexOf('--argv-json') + 1], 'base64').toString('utf8'));
check('a quoted command keeps its quoted argument whole', JSON.stringify(tokenized) === JSON.stringify(['cmd', '/c', 'echo hello world']));;

// --- pwsh -----------------------------------------------------------------------

// PowerShell is a surface here so that "fall back to PowerShell" stays inside
// this plugin instead of becoming "use the other tool". The facts that shape
// its argv: a command line needs -Command, a script file needs -File (otherwise
// the path is parsed as a command), and both must be non-interactive so a
// profile cannot write to the pipe this runner is reading.
const pwshArgv = buildArgv('pwsh', specs.pwsh, { command: 'Get-Date', script: '', cwd: '', send: [] });
check('pwsh gets a command flag', pwshArgv.argv.includes('-Command'));
check('pwsh runs non-interactive', pwshArgv.argv.includes('-NoProfile') && pwshArgv.argv.includes('-NonInteractive'));
check('pwsh command is one element', pwshArgv.argv.at(-1) === 'Get-Date');
check('pwsh puts its flags before the command', pwshArgv.argv.indexOf('-Command') === pwshArgv.argv.length - 2);
const pwshScript = buildArgv('pwsh', specs.pwsh, {
  command: '',
  script: 'E:\\DaShaoHuo\\cache\\tmp\\check.ps1',
  cwd: '',
  send: [],
});
check('a pwsh script is handed over as a file, not a command line', pwshScript.argv.includes('-File') && !pwshScript.argv.includes('-Command'));
equal('the script path is the final element', pwshScript.argv.at(-1), 'E:\\DaShaoHuo\\cache\\tmp\\check.ps1');
equal('the script flag is the one declared for files', pwshScript.argv.at(-2), '-File');

// --- resolution -----------------------------------------------------------------

const surfaces = resolveSurfaces();
check('resolution keeps every id', Object.keys(surfaces).length === ids.length);
check(
  'resolution reports presence as a boolean and a reason when absent',
  Object.values(surfaces).every((s) => typeof s.present === 'boolean' && s.absent),
);

// A bare command name has to be resolved against the shell's own lookup, not
// assumed and not guessed from a directory walk. CI caught the difference: a
// Linux runner used to report wsl as available because `wsl.exe` was taken as
// given, and on Windows the walk through PATH missed it while `where.exe` found
// it in the same breath -- the file is a reparse point.
function resolvable(name) {
  const probe =
    process.platform === 'win32'
      ? { command: 'where.exe', args: [name] }
      : { command: 'sh', args: ['-c', `command -v ${JSON.stringify(name)} >/dev/null 2>&1`] };
  try {
    return spawnSync(probe.command, probe.args, { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}
check('a name that resolves nowhere is refused, so presence is not assumed', resolvable('this-command-does-not-exist-xyz') === false);
if (surfaces.pty.present) {
  check(
    'a surface reported present is actually resolvable',
    resolvable('python') || resolvable('python3'),
    'python is on PATH but neither name resolves',
  );
}
check(
  'a path-shaped surface follows the filesystem, a bare one follows the shell lookup',
  Object.values(surfaces).every((spec) =>
    /[\\/]/.test(spec.exe) ? spec.present === existsSync(spec.exe) : spec.present === resolvable(spec.exe),
  ),
);

// --- the tool contract ----------------------------------------------------------

equal('plugin name', pluginName, 'dsh-shell-surfaces');
check('plugin injects the tools service', Array.isArray(inject) && inject.includes('tools'));
check('plugin injects the prompt service (it registers the selection rule)', inject.includes('systemPrompt'));

const registered = [];
const sections = [];
// A stand-in for ctx.jobs: it records the spec, runs the producer the way the
// real registry does (the starter owns the process), and exposes the appended
// output so a test can read what the job would have streamed.
const jobsService = {
  started: [],
  start(spec) {
    const id = `shell-surfaces-${this.started.length + 1}`;
    const record = { id, spec, appended: [] };
    this.started.push(record);
    record.hooks = spec.run({
      id,
      append: (text, options) => record.appended.push({ text, channel: options?.channel }),
      updateProgress: () => {},
    });
    return id;
  },
};
const listeners = [];
const ctx = {
  effect: (fn) => fn(),
  on: (name, handler) => {
    listeners.push({ name, handler });
    return () => {};
  },
  tools: { register: (t) => registered.push(t) },
  systemPrompt: {
    section: (section) => sections.push(section),
    // The real allocation the pwsh rule uses is 1010; a rule placed at
    // TOOL_BASH (1000) is read first, which is the whole point.
    getSectionOrder: (name) => (name === 'TOOL_BASH' ? 1000 : 9999),
  },
  get: (name) => (name === 'jobs' ? jobsService : void 0),
  logger: { warn: () => {} },
};
apply(ctx, {});
equal('exactly one tool is registered', registered.length, 1);
// The pair that makes owner cleanup possible: DSH has no `agent/disposed`, so an
// agent's session is learned at creation and acted on when the session is
// disposed (the same direction prestep-audit reads `agent.session.id`).
check(
  'an agent creation is watched so its session can be recognised later',
  listeners.some((entry) => entry.name === 'agent/created'),
);
check(
  'a disposed session closes the shells of the agents that named it',
  listeners.some((entry) => entry.name === 'session/disposed'),
);
equal('exactly one prompt section is registered', sections.length, 1);
equal('the section is named for this tool', sections[0].name, 'tool:shell-surfaces');
equal('the section is placed at the shell-rule position, ahead of pwsh', sections[0].order, 1000);
check(
  'the section says which tool is the first choice',
  typeof sections[0].text === 'string' && sections[0].text.includes('first choice') && sections[0].text.includes('shell_surfaces'),
);
check(
  'the section keeps pwsh work on this tool, not on a separate tool',
  typeof sections[0].text === 'string' && /pwsh` surface/.test(sections[0].text) && !/genuinely PowerShell/.test(sections[0].text),
);
check(
  'the section narrows the built-in pwsh tool to the terminal-session shape',
  typeof sections[0].text === 'string' &&
    /a terminal session/.test(sections[0].text) &&
    /a drawn prompt/.test(sections[0].text) &&
    !/a persistent session/.test(sections[0].text),
);
check(
  'the section tells a command aimed at another shell tool to come here',
  /belongs here instead/.test(sections[0].text) &&
    /foreground, background, timeout promotion/.test(sections[0].text) &&
    /sessions are all on this tool/.test(sections[0].text),
);
check(
  'the section teaches the sandbox escalation instead of a workaround',
  /sandbox_permissions/.test(sections[0].text) && /never work around the fence/.test(sections[0].text),
);
check(
  'the section keeps a surface failure inside this tool',
  typeof sections[0].text === 'string' && /do not change tools/.test(sections[0].text) && /action="surfaces"/.test(sections[0].text),
);
const tool = registered[0];
equal('tool name', tool.name, 'shell_surfaces');
check('the tool declares no field-level required (the host refuses those)', !('required' in tool.parameters));
check('the output schema is closed', tool.output.schema.additionalProperties === false);
check('the output schema declares no required either', !('required' in tool.output.schema));

// The host's validator refuses a "type" that is an array of types, and a refusal
// there is not a warning: the plugin does not activate at all. That is what
// happened in the field (2026-10-15, `exitCode: ['integer','null']`), and the
// self-test passed anyway because it never looked at the schemas' type fields.
// Nothing in any schema may be a join of types.
function jointTypes(node, path = '$') {
  if (node === null || typeof node !== 'object') return [];
  const found = [];
  if (Array.isArray(node.type)) found.push(`${path}.type`);
  if (node.type !== undefined && typeof node.type !== 'string') found.push(`${path}.type`);
  for (const [key, value] of Object.entries(node)) {
    found.push(...jointTypes(value, `${path}.${key}`));
  }
  return found;
}
equal('no schema joins types with an array', JSON.stringify([
  ...jointTypes(tool.parameters, 'parameters'),
  ...jointTypes(tool.output.schema, 'output.schema'),
]), '[]');
check(
  'every declared field type is a single type string',
  Object.values(tool.output.schema.properties).every((p) => typeof p.type === 'string'),
);
check('actions are run and surfaces', JSON.stringify(tool.parameters.properties.action.enum) === JSON.stringify(['run', 'surfaces']));
check(
  'the surface argument stays an open string, because the scan decides the ids',
  tool.parameters.properties.surface.type === 'string' && tool.parameters.properties.surface.enum === void 0,
);
check('a refresh flag is advertised for the surfaces query', tool.parameters.properties.refresh?.type === 'boolean');
// The description names what this machine can actually run: a surface whose
// executable is missing here is counted rather than listed (its reason is what
// action="surfaces" is for), and the ten `wsl-<shell>` faces are summarised as
// one count because they say one thing. Measured 2026-10-24: listing all 32 ids
// cost 3559 characters and read as a wall; grouped, it is 3457 and has the shape
// of the choice.
check(
  'the description names every surface it can run here',
  Object.entries(resolveSurfaces())
    .filter(([, spec]) => spec.present)
    .every(([id]) => (id.startsWith('wsl-') ? tool.description.includes('wsl-<shell>') : tool.description.includes(id))),
);
check('and says how many are absent rather than listing them', /absent here/.test(tool.description) || Object.values(resolveSurfaces()).every((spec) => spec.present));
check(
  'the description carries the console rule rather than only the names',
  tool.description.includes('ConPTY') || tool.description.includes('real console'),
);
check('the render function produces text', tool.output.render({}, { ok: true, message: 'm' })[0].type === 'text');

// --- a run result keeps its shape -----------------------------------------------

const badSurface = await tool.execute({ action: 'run', surface: 'nope', command: 'echo hi' });
check('an unknown surface is refused as a result, not a throw', badSurface.ok === false && /known surfaces/.test(badSurface.message));
const noCommand = await tool.execute({ action: 'run', surface: 'nu' });
check('a missing command is refused', noCommand.ok === false && /command/.test(noCommand.message));
const badAction = await tool.execute({ action: 'nonsense' });
check('an unknown action is refused', badAction.ok === false && /action must be/.test(badAction.message));
const listing = await tool.execute({ action: 'surfaces' });
check('the surfaces action returns rows', listing.ok === true && Array.isArray(listing.surfaces) && listing.surfaces.length === ids.length);
check(
  'the surfaces action reports what the scan found, with paths and sources',
  Array.isArray(listing.discovered) &&
    listing.discovered.some((hit) => hit.kind === 'shell') &&
    listing.discovered.every((hit) => typeof hit.path === 'string' && typeof hit.source === 'string'),
);
const rescanned = await tool.execute({ action: 'surfaces', refresh: true });
check(
  'a refresh re-scans and says so, and still reports both halves',
  rescanned.ok === true &&
    Array.isArray(rescanned.discovered) &&
    /the scan ran again just now/.test(rescanned.message),
);

// A surface-level failure must name the next call this plugin can answer.
// Otherwise "the surface did not start" reads as "the tool is broken", which is
// exactly the reading that sends a session back to another shell tool.
if (surfaces.pwsh.present) {
  const timedOut = await tool.execute({ action: 'run', surface: 'pwsh', command: 'Start-Sleep -Seconds 5', timeout_ms: 1000 });
  check(
    'a timeout comes with the next call to make inside this tool',
    timedOut.timedOut === true && /action="surfaces"/.test(timedOut.message),
  );
}

// --- background work, on this same tool ----------------------------------------

// "Use the built-in shell tool for a job" used to be the only way to get one.
// This is that capability here: the call returns a registry id, the spec carries
// this plugin's kind, and the process streams into the job ring from its first
// byte.
if (surfaces.pwsh.present) {
  const background = await tool.execute({
    action: 'run',
    surface: 'pwsh',
    command: 'Write-Output done',
    run_in_background: true,
    description: 'background probe',
  });
  check(
    'a background run returns a job id instead of an exit status',
    background.ok === true && typeof background.jobId === 'string' && /background job/.test(background.message),
  );
  if (background.ok === true) {
    check(
      'the job is registered under this plugin kind',
      jobsService.started.length === 1 && jobsService.started[0].spec.kind === 'shell-surfaces',
    );
    check('the description becomes the job label', jobsService.started[0].spec.label === 'background probe');
    await jobsService.started[0].hooks.done;
    check(
      'the job streamed the command output into the ring',
      jobsService.started[0].appended.some((chunk) => String(chunk.text).includes('done')),
    );
  }
}

if (surfaces.pty.present) {
  const ptyBackground = await tool.execute({ action: 'run', surface: 'pty', command: 'cmd /c ver', run_in_background: true });
  check(
    'the console refuses background work with a sentence',
    ptyBackground.ok === false && /cannot run in the background/.test(ptyBackground.message),
  );
}

// --- a promoted timeout ----------------------------------------------------------

if (surfaces.pwsh.present) {
  const startedBefore = jobsService.started.length;
  const promoted = await tool.execute({
    action: 'run',
    surface: 'pwsh',
    command: 'Start-Sleep -Seconds 5; Write-Output late',
    timeout_ms: 1000,
    promote_on_timeout: true,
  });
  check(
    'a promoted timeout returns a job id instead of losing the process',
    promoted.ok === true && promoted.promoted === true && typeof promoted.jobId === 'string',
  );
  check('the promoted process is registered as a job', jobsService.started.length === startedBefore + 1);
  // Leave nothing running: cancelling is what a caller would do, and it also
  // proves the hooks reach the live process.
  const record = jobsService.started.at(-1);
  record.hooks.cancel('test cleanup');
  await record.hooks.done;
}

// --- the sandbox seam -----------------------------------------------------------

// A confined run wraps the exact argv the surface would spawn and reports the
// mode in the vocabulary the built-in shell tools use. The provider here wraps
// nothing (a real runner would not exist on this machine), but every call it
// receives is recorded, which is the contract that matters.
const confinedCalls = [];
const approvalRequests = [];
const registeredSandbox = [];
let approvalOutcome = 'allowed-once';
const ctxSandbox = {
  effect: (fn) => fn(),
  tools: { register: (t) => registeredSandbox.push(t) },
  systemPrompt: { section: () => {}, getSectionOrder: () => 1000 },
  get: (name) =>
    ({
      jobs: jobsService,
      sandbox: {
        confine: (argv, policy) => {
          confinedCalls.push({ argv, policy });
          return Promise.resolve({ argv, enforcement: 'full', denialSignatures: ['EPERM'], runnerFailureRules: [] });
        },
      },
      sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: 'E:\\work' }) },
      approval: {
        request: (request) => {
          approvalRequests.push(request);
          return Promise.resolve(approvalOutcome);
        },
      },
    })[name],
  logger: { warn: () => {} },
};
apply(ctxSandbox, {});
const sandboxTool = registeredSandbox[0];
const execStub = { agent: { id: 's1', session: { id: 's1' } }, callId: 'c1', signal: new AbortController().signal };

if (surfaces.pwsh.present) {
  const confinedRun = await sandboxTool.execute({ action: 'run', surface: 'pwsh', command: 'Get-Date' }, execStub);
  check(
    'a confined run reports its mode and enforcement',
    confinedRun.sandbox?.mode === 'read-only' && confinedRun.sandbox.enforcement === 'full' && confinedRun.sandbox.denied === false,
  );
  check(
    'the provider wrapped the exact argv, not a command line',
    Array.isArray(confinedCalls.at(-1)?.argv) && confinedCalls.at(-1).argv.includes('-Command'),
  );

  const escalated = await sandboxTool.execute(
    {
      action: 'run',
      surface: 'pwsh',
      command: 'Get-Date',
      sandbox_permissions: 'workspace-write',
      justification: 'need to write the report',
    },
    execStub,
  );
  check('an approved escalation confines this call under the wider mode', escalated.sandbox?.mode === 'workspace-write');
  check(
    'the approval carries the justification',
    approvalRequests.length === 1 && /need to write the report/.test(approvalRequests[0].reason),
  );
  check('the escalated call is the one that ran wider', confinedCalls.at(-1).policy.mode === 'workspace-write');

  approvalOutcome = 'rejected';
  const rejected = await sandboxTool.execute(
    {
      action: 'run',
      surface: 'pwsh',
      command: 'Get-Date',
      sandbox_permissions: 'danger-full-access',
      justification: 'needs full access',
    },
    execStub,
  );
  approvalOutcome = 'allowed-once';
  check(
    'a rejected escalation stops before the command runs',
    rejected.ok === false && /rejected/.test(rejected.message) && !('stdout' in rejected),
  );
}

if (surfaces.pwsh.present) {
  const noSandboxEscalation = await tool.execute({
    action: 'run',
    surface: 'pwsh',
    command: 'Get-Date',
    sandbox_permissions: 'workspace-write',
    justification: 'whatever',
  });
  check(
    'an escalation without a mounted policy is refused as a result',
    noSandboxEscalation.ok === false && /not available/.test(noSandboxEscalation.message),
  );
}

// --- a persistent session -------------------------------------------------------

if (surfaces.pwsh.present) {
  const sessionExec = { agent: { id: 'session-owner', session: { id: 'session-owner' } }, callId: 'c1' };
  const first = await tool.execute({ action: 'run', surface: 'pwsh', command: '$dss = 41', session: 'state' }, sessionExec);
  check('a session call reports its name', first.ok === true && first.session === 'state');
  const second = await tool.execute({ action: 'run', surface: 'pwsh', command: '$dss + 1', session: 'state' }, sessionExec);
  check('the next call sees the previous command state', /42/.test(String(second.stdout)));

  const mixed = await tool.execute(
    { action: 'run', surface: 'pwsh', command: '$dss', session: 'state', run_in_background: true },
    sessionExec,
  );
  check(
    'a session refuses the job flags with a sentence',
    mixed.ok === false && /one command at a time/.test(mixed.message),
  );

  const reset = await tool.execute(
    { action: 'run', surface: 'pwsh', command: '$dss', session: 'state', session_reset: true },
    sessionExec,
  );
  check('a reset starts a fresh session', reset.ok === true && !/42/.test(String(reset.stdout)));
  closeSessions();
}

// Any present shell that does NOT declare a session. wsl used to be the example
// here, and it stopped being one when a session was added to it (measured
// 2026-10-24); the case now asks the table for such a surface instead of naming
// one, so adding a session somewhere never silently turns this into a passing
// test of the wrong thing.
const noSessionSurface = Object.entries(surfaces).find(
  ([, spec]) => spec.present && spec.session === void 0 && spec.kind === 'shell',
);
if (noSessionSurface !== void 0) {
  const noSession = await tool.execute({ action: 'run', surface: noSessionSurface[0], command: 'echo x', session: 'x' });
  check(
    'a surface without sessions refuses one and names the surfaces that have them',
    noSession.ok === false && /no persistent session/.test(noSession.message) && /pwsh/.test(noSession.message),
  );
}

// Every result the tool can produce is validated by the host against this schema
// before a reader sees it, so a field the schema does not declare is a failed
// tool call rather than a harmless extra. Declared names only, on every path.
const allowedNames = new Set(Object.keys(tool.output.schema.properties));
for (const [label, result] of [
  ['run/unknown-surface', badSurface],
  ['run/no-command', noCommand],
  ['unknown-action', badAction],
  ['surfaces', listing],
]) {
  const strays = Object.keys(result).filter((key) => !allowedNames.has(key));
  equal(`the ${label} result declares only declared fields`, JSON.stringify(strays), '[]');
}

// --- no judgement glyphs in the shipped files -----------------------------------

const glyphs = /[\u2713\u2714\u2717\u2718\u2705\u274c\u274e\u2611\u2612\u00d7\u2715\u2716\u221a\u221b]/;
for (const file of ['../lib/index.js', '../lib/runner.js', '../lib/surfaces.js', '../cordis.patch.yml', '../package.json']) {
  const text = readFileSync(join(import.meta.dirname, file), 'utf8');
  check(`${file} carries no judgement glyphs`, !glyphs.test(text));
}

let hostSaid = 'the host validator was not exercised';
try {
  const { assertSupportedJsonSchema } = await import(process.env.DSH_TOOLS_MODULE ?? 'file:///E:/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
  for (const [label, schema] of [['parameters', tool.parameters], ['output.schema', tool.output.schema]]) {
    try {
      assertSupportedJsonSchema(schema);
      hostSaid = `the host validator accepted both schemas (${label} checked)`;
    } catch (error) {
      check(`the host validator accepts the ${label}`, false, error.message);
    }
  }
} catch {
  /* no host checkout next to this one: the shape checks above still stand */
}
check('the result names stay inside the schema', Object.keys(listing).every((key) => key in tool.output.schema.properties));

// --- report ---------------------------------------------------------------------

console.log(`surfaces-test: ${passed} passed, ${failures.length} failed`);
console.log(`  ${hostSaid}`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
