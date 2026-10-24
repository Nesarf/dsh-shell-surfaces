// One real browser bundle, checked the way the module system will see it.
//
// The bundle format is the part that fails quietly: a client.js that uses a
// bare ESM import, or forgets `window.__ModuleLoader__.load`, loads nowhere and
// says nothing useful -- the page simply keeps the generic row. So this test
// runs the actual lib/client.js inside a VM behind a fake module loader, builds
// its exports with stub modules, and then reads the row the component produces
// for every call phase.
//
// What it asserts is the sentence the row is supposed to say: the surface name
// at the head, the activity beside it, the status at the end.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8');

let passed = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(detail === undefined ? label : `${label}  (${detail})`);
}
function equal(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// --- 1. the bundle registers itself --------------------------------------------

let loaded = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (entry) => {
        loaded = entry;
      },
    },
  },
};
vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' });
check('the bundle registers with the module loader', loaded !== null, 'window.__ModuleLoader__.load was never called');
if (loaded === null) {
  console.error('the bundle never registered; nothing else can be checked');
  process.exit(1);
}
equal('the bundle id is the package name', loaded.id, 'dsh-shell-surfaces');
check('the bundle carries a factory', typeof loaded.factory === 'function');

// --- 2. the factory builds cordis exports from stub modules ---------------------

const zh = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  stopped: '已停止',
  timedOut: '超时',
  preparing: '准备中',
  list: '列出可用 surface',
  script: '脚本',
  output: '输出',
  background: '后台',
  sandboxed: '受限',
  session: '会话',
};
const react = { useState: (initial) => [initial, () => {}] };
const jsx = (type, props) => ({ type, props });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'Fragment' };
const primitives = {
  DisclosureRow: 'DisclosureRow',
  IconApiOutlineRegular: 'IconApiOutlineRegular',
};

const exported = loaded.factory((specifier) => {
  if (specifier === 'react') return react;
  if (specifier === 'react/jsx-runtime') return jsxRuntime;
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error(`unexpected require("${specifier}")`);
});
check('the factory exports apply', typeof exported.apply === 'function');
check('the factory exports inject', Array.isArray(exported.inject) && exported.inject.includes('slots'));
check('the client declares its locale dependency', exported.inject.includes('locale'));

// The tree renderer is the one piece of the client that turns a host answer into
// structure, and a line it dropped would be invisible in a screenshot. It is
// exported for exactly this check.
check('the factory exports the tree renderer', typeof exported.renderTree === 'function');
if (typeof exported.renderTree === 'function') {
  const listingText = [
    'wsl [userland] available',
    '    \u00b7 a whole Linux userland',
    '    \u00b7 when: the job needs Linux',
    '    wsl-ksh [shell] available',
    '        \u00b7 ksh inside the distribution',
    '',
    '    \u00b7 crossings: faces that work together rather than live inside each other',
    '        \u00b7 wt \u2014 node: the answer comes back through dss-exec.mjs',
  ].join('\n');
  const tree = exported.renderTree(listingText);

  // The client receives one flattened string, so the block tree it builds is the
  // structure: a face block, its notes, and its children nested inside.
  const treeBlock = tree.props.children[0];
  const edgesBlock = tree.props.children[1];
  const rootBlock = treeBlock.props.children[0];
  const rootBody = rootBlock.props.children[1];
  const childBlock = rootBody.props.children[2];

  equal('a face becomes a block', rootBlock.props['data-kind'], 'userland');
  equal('the face name is its own span', rootBlock.props.children[0].props.children[0].props.children, 'wsl');
  equal('its notes and its child live in one body', rootBody.props.children.length, 3);
  equal('a note is a note, not a face', rootBody.props.children[0].props.className, 'dss-block-note');
  equal('a child face nests inside the parent block', childBlock.props['data-kind'], 'shell');
  equal('the child keeps its own notes', childBlock.props.children[1].props.children.length, 1);
  check(
    'a crossing gets its own section, apart from the tree',
    edgesBlock !== null && edgesBlock.props.children.length === 2,
  );
  check(
    'and the crossing names both ends',
    edgesBlock.props.children[1].props.children.includes('\u2014'),
  );
}

// --- 3. apply registers the keyed row and its dictionaries ----------------------

const registrations = [];
const dictionaries = [];
exported.apply({
  effect: (fn) => {
    fn();
  },
  locale: {
    register: (ns, dictionary) => {
      dictionaries.push({ ns, dictionary });
      return () => {};
    },
  },
  slots: {
    inject: (_name, fn) => {
      fn();
    },
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
});
equal('one tool row is registered', registrations.length, 1);
equal('the row is keyed by the wire tool name', registrations[0].options.key, 'shell_surfaces');
equal('the row is registered in the toolview slot', registrations[0].options.name, 'tool.call.toolview');
equal('the row carries its own translation namespace', registrations[0].options.locale, 'shell-surfaces');
check('the dictionaries are registered for that namespace', dictionaries.length === 1 && dictionaries[0].ns === 'shell-surfaces');
check('both languages are supplied', dictionaries.length === 1 && dictionaries[0].dictionary.zh !== undefined && dictionaries[0].dictionary.en !== undefined);

const Row = registrations[0].component;
const t = (key) => (zh[key] === undefined ? key : zh[key]);

// --- 4. the row says which surface ran what ------------------------------------

function childrenOf(node) {
  const kids = node && node.props ? node.props.children : undefined;
  if (kids === undefined || kids === null) return [];
  return Array.isArray(kids) ? kids : [kids];
}
function byClass(tree, className) {
  const queue = [tree];
  while (queue.length > 0) {
    const node = queue.shift();
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    if (node === null || typeof node !== 'object') continue;
    if (node.props !== undefined && node.props.className === className) return node;
    queue.push(childrenOf(node));
    if (node.props !== undefined) queue.push(node.props.collapsedContent);
  }
  return null;
}
function activityOf(tree) {
  const node = byClass(tree, 'dss-activity');
  return node === null ? '' : node.props.children;
}
function statusOf(tree) {
  const node = byClass(tree, 'dss-status');
  return node === null ? '' : node.props.children;
}
function stateOf(tree) {
  const node = byClass(tree, 'dss-status');
  return node === null ? '' : node.props['data-state'];
}

function startCall(args) {
  return Row({
    t,
    phase: 'start',
    callId: 'c1',
    toolName: 'shell_surfaces',
    block: { phase: 'start', callId: 'c1', name: 'shell_surfaces', argsRaw: JSON.stringify(args) },
  });
}
function settledCall(args, text, isError = false) {
  return Row({
    t,
    phase: 'result',
    callId: 'c1',
    toolName: 'shell_surfaces',
    block: {
      kind: 'result',
      callId: 'c1',
      call: { name: 'shell_surfaces', argsRaw: JSON.stringify(args) },
      content: [{ type: 'text', text }],
      isError,
      subCalls: [],
    },
  });
}

const wsl = startCall({ action: 'run', surface: 'wsl', command: 'grep -P "x" file.sh' });
equal('a wsl call is headed by the surface name', wsl.props.title, 'WSL');
equal('the activity is the command', activityOf(wsl), 'grep -P "x" file.sh');
equal('a dispatched call is still running', stateOf(wsl), 'running');
equal('the status says so', statusOf(wsl), '运行中');
equal('the row is not expandable before a result', wsl.props.expandable, false);

const zsh = settledCall({ action: 'run', surface: 'zsh', command: 'ls' }, 'zsh: exit code 1 in 12 ms\nboom\n');
equal('a zsh call is headed by zsh', zsh.props.title, 'zsh');
equal('a failing exit reads as one', stateOf(zsh), 'error');
equal('the failing exit code and duration are shown', statusOf(zsh), '1 · 12ms');
equal('a settled call with output is expandable', zsh.props.expandable, true);

const ok = settledCall({ action: 'run', surface: 'msys', command: 'pwd' }, 'msys: exit code 0 in 40 ms\n/tmp\n');
equal('a clean exit reads as done', stateOf(ok), 'ok');
equal('the clean status carries the duration', statusOf(ok), '完成 · 40ms');

const timedOut = settledCall({ action: 'run', surface: 'wsl', command: 'sleep 99' }, 'wsl: timed out after 120000 ms with no output (the command was stopped; a grandchild may still be running)');
equal('a timeout is not a failure of the command', stateOf(timedOut), 'warn');
equal('the timeout says what it is', statusOf(timedOut), '超时');

const background = settledCall({ action: 'run', surface: 'wsl', command: 'long-running', run_in_background: true }, 'wsl: started background job shell-surfaces-7 -- read it with job_output, stop it with job_kill');
equal('a background job shows its id, not an exit status', statusOf(background), '后台 shell-surfaces-7');
equal('a background job is not reported as done', stateOf(background), 'ok');

const denied = settledCall({ action: 'run', surface: 'wsl', command: 'touch /root/x' }, 'wsl: exit code 1 in 5 ms\n[sandbox: file access denied under read-only mode]\n');
equal('a sandbox denial names its mode', statusOf(denied), '受限 read-only');
equal('a sandbox denial is not a plain command failure', stateOf(denied), 'warn');

const sessionRow = settledCall({ action: 'run', surface: 'pwsh', command: '$x', session: 'state' }, 'pwsh: session state completed in 3 ms\n');
equal('a session call names its session', statusOf(sessionRow), '会话 state');

const listing = settledCall({ action: 'surfaces' }, '7 of 7 surfaces are on this machine\n');
equal('a listing is headed by shells, not a surface', listing.props.title, 'shells');
// The row now carries the first clause of the answer ("32 of 32 surfaces are on
// this machine") instead of the word "list": that count is the part worth reading
// at a glance, and the tree itself is one click away in the expanded output.
equal('a listing says what it found', activityOf(listing), '7 of 7 surfaces are on this machine');
// Before an answer exists there is nothing to quote, so the row falls back to
// saying what it is doing -- the summary is never invented.
equal('a listing with no answer yet says what it is doing', activityOf(startCall({ action: 'surfaces' })), '列出可用 surface');

const pty = startCall({ action: 'run', surface: 'pty', command: 'cmd /c ver' });
equal('the pty surface is named as a console', pty.props.title, 'conPTY');

const powershell = startCall({ action: 'run', surface: 'pwsh', command: 'Get-Date' });
equal('the pwsh surface is named as PowerShell', powershell.props.title, 'PowerShell');

const scripted = startCall({ action: 'run', surface: 'msys', script: 'E:\\work\\check.sh' });
equal('a script call names the script, not a directory', activityOf(scripted), '脚本 check.sh');

const unknown = startCall({ action: 'run', command: 'ls' });
equal('an unnamed surface falls back to the tool name', unknown.props.title, 'shell_surfaces');

const preparing = Row({
  t,
  phase: 'preparing',
  callId: 'c9',
  toolName: 'shell_surfaces',
  block: { phase: 'preparing', callId: 'c9', name: 'shell_surfaces' },
});
equal('a preparing call says so', preparing.props.title, '准备中');
equal('a preparing call has no activity yet', activityOf(preparing), '');
equal('a preparing call is not expandable', preparing.props.expandable, false);

// --- 5. report -----------------------------------------------------------------

if (failures.length > 0) {
  for (const failure of failures) console.error(`not passed: ${failure}`);
  console.error(`\n${passed} passed, ${failures.length} not passed`);
  process.exit(1);
}
console.log(`${passed} passed`);
