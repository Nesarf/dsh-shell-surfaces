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
import { join } from 'node:path';
import { resolveSurfaces, surfaceSpecs } from '../lib/surfaces.js';
import { buildArgv, toWslPath } from '../lib/runner.js';
import { apply, inject, name as pluginName } from '../lib/index.js';

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
for (const required of ['wsl', 'nu', 'msys', 'zsh', 'fish', 'brush', 'pty']) {
  check(`table has the ${required} surface`, required in specs);
}
check('every surface carries a summary and a guide', ids.every((id) => specs[id].summary && specs[id].guide));
check(
  'every surface says where to look when it is absent',
  ids.every((id) => typeof specs[id].absent === 'string' && specs[id].absent.length > 0),
);

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

// --- resolution -----------------------------------------------------------------

const surfaces = resolveSurfaces();
check('resolution keeps every id', Object.keys(surfaces).length === ids.length);
check(
  'resolution reports presence as a boolean and a reason when absent',
  Object.values(surfaces).every((s) => typeof s.present === 'boolean' && s.absent),
);

// A bare command name has to be resolved against PATH, not assumed present. CI
// caught this: a Linux runner used to report wsl as available because `wsl.exe`
// was taken as given, and a surface that claims to be available on a machine
// that cannot run it is worse than one that says nothing.
function onPath(name) {
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = process.platform === 'win32' ? ['.EXE', '.CMD', '.BAT', ''] : [''];
  return dirs.some((dir) => exts.some((ext) => existsSync(join(dir, name + ext))));
}
equal('wsl.exe presence follows PATH, not an assumption', surfaces.wsl.present, onPath('wsl.exe'));
equal('python presence follows PATH', surfaces.pty.present, onPath('python'));

// --- the tool contract ----------------------------------------------------------

equal('plugin name', pluginName, 'dsh-shell-surfaces');
check('plugin injects the tools service', Array.isArray(inject) && inject.includes('tools'));

const registered = [];
const ctx = {
  effect: (fn) => fn(),
  tools: { register: (t) => registered.push(t) },
  logger: { warn: () => {} },
};
apply(ctx, {});
equal('exactly one tool is registered', registered.length, 1);
const tool = registered[0];
equal('tool name', tool.name, 'shell_surfaces');
check('the tool declares no field-level required (the host refuses those)', !('required' in tool.parameters));
check('the output schema is closed', tool.output.schema.additionalProperties === false);
check('the output schema declares no required either', !('required' in tool.output.schema));
check('actions are run and surfaces', JSON.stringify(tool.parameters.properties.action.enum) === JSON.stringify(['run', 'surfaces']));
equal(
  'the surface enum matches the table',
  JSON.stringify(tool.parameters.properties.surface.enum),
  JSON.stringify(ids),
);
check('the description names every surface', ids.every((id) => tool.description.includes(id)));
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
const listing = await tool.execute({ action: 'surfaces' });
check('the surfaces action returns rows', listing.ok === true && Array.isArray(listing.surfaces) && listing.surfaces.length === ids.length);

// --- no judgement glyphs in the shipped files -----------------------------------

const glyphs = /[\u2713\u2714\u2717\u2718\u2705\u274c\u274e\u2611\u2612\u00d7\u2715\u2716\u221a\u221b]/;
for (const file of ['../lib/index.js', '../lib/runner.js', '../lib/surfaces.js', '../cordis.patch.yml', '../package.json']) {
  const text = readFileSync(join(import.meta.dirname, file), 'utf8');
  check(`${file} carries no judgement glyphs`, !glyphs.test(text));
}

// --- report ---------------------------------------------------------------------

console.log(`surfaces-test: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
