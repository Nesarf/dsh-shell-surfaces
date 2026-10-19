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

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { resolveSurfaces, surfaceSpecs, lastScan } from '../lib/surfaces.js';
import { scan } from '../lib/discover.js';
import { buildArgv, toWslPath } from '../lib/runner.js';
import { apply, inject, name as pluginName } from '../lib/index.js';
import { closeSessions } from '../lib/sessions.js';

let passed = 0;
const failures = [];

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
for (const required of ['wsl', 'nu', 'msys', 'zsh', 'fish', 'brush', 'pwsh', 'pty']) {
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
check('wsl command is one argv element after --', wslInline.argv.includes('--') && wslInline.argv.at(-1) === 'uname -sr');
check('wsl asks bash to take a command line', wslInline.argv.at(-2) === '-lc');
check('wsl command is not pre-quoted', !wslInline.argv.some((a) => /["']/.test(a)));

const wslScript = buildArgv('wsl', specs.wsl, {
  command: '',
  script: 'E:\\DaShaoHuo\\cache\\tmp\\probe.sh',
  cwd: '',
  send: [],
});
equal('wsl script becomes a file path', wslScript.argv.at(-1), '/mnt/e/DaShaoHuo/cache/tmp/probe.sh');

const wslCwd = buildArgv('wsl', specs.wsl, { command: 'pwd', script: '', cwd: 'E:\\DaShaoHuo', send: [] });
check('wsl cwd stays a Windows path for wsl.exe to translate', wslCwd.argv.includes('E:\\DaShaoHuo'));

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
const ctx = {
  effect: (fn) => fn(),
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
equal(
  'the surface enum matches the table',
  JSON.stringify(tool.parameters.properties.surface.enum),
  JSON.stringify(ids),
);
check('the description names every surface', ids.every((id) => tool.description.includes(id) || id.startsWith('wsl-')));
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

if (surfaces.wsl.present) {
  const noSession = await tool.execute({ action: 'run', surface: 'wsl', command: 'ls', session: 'x' });
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
