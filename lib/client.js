// dsh-shell-surfaces -- client half: one row per `shell_surfaces` call.
//
// The host half registers the tool; this half decides how its call renders.
//
// The stock tool row is built from the wire tool name, and that name is
// `shell_surfaces` for every call. A reader therefore sees "工具调用 ·
// shell_surfaces · wsl" -- the catalogue name, not which machine surface ran
// the command, and not what the command does. The useful sentence is the one
// this row carries: `WSL · grep -P ...`, `nushell · 解析 JSON`, `zsh · ...`,
// or the console name for the PTY surface.
//
// The row is a client concern, not a host result concern: the pending state
// must already name the surface before any output exists, so a title computed
// from the settled result would arrive too late. `tool.call.toolview` is the
// supported seam for exactly this (keyed by the wire tool name, replacing the
// generic row for this tool only), so nothing here patches a first-party
// package.
//
// This file is the built browser bundle, in the module system's own format:
// `window.__ModuleLoader__.load` registers a lazy CJS factory, and the module
// body runs when the plugin is first materialized. That is why the CSS is
// injected inside the factory and not at this file's top level.

window.__ModuleLoader__.load({
  id: 'dsh-shell-surfaces',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    var jsxRuntime = require('react/jsx-runtime');
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    var jsx = jsxRuntime.jsx;
    var jsxs = jsxRuntime.jsxs;
    var Fragment = jsxRuntime.Fragment;

    var NS = 'shell-surfaces';

    var zh = {
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
    var en = {
      running: 'running',
      done: 'done',
      failed: 'failed',
      stopped: 'stopped',
      timedOut: 'timed out',
      preparing: 'preparing',
      list: 'list surfaces',
      script: 'script',
      output: 'output',
      background: 'background',
      sandboxed: 'sandboxed',
      session: 'session',
    };

    // The surface names a person would say out loud. `pty` is not a shell and
    // not a userland: it is a console, so it says so.
    var SURFACE_LABELS = {
      wsl: 'WSL',
      nu: 'nushell',
      msys: 'MSYS2 bash',
      zsh: 'zsh',
      fish: 'fish',
      brush: 'brush',
      dash: 'dash',
      tcsh: 'tcsh',
      busybox: 'BusyBox sh',
      perl: 'Perl',
      cscript: 'cscript',
      pwsh: 'PowerShell',
      powershell: 'PowerShell 5.1',
      wezterm: 'WezTerm',
      wt: 'Windows Terminal',
      mintty: 'mintty',
      tabby: 'Tabby',
      pty: 'conPTY',
      cmd: 'cmd',
      'git-bash': 'Git bash',
    };

    var cls = {
      row: 'dss-row',
      leading: 'dss-leading',
      title: 'dss-title',
      summary: 'dss-summary',
      separator: 'dss-separator',
      activity: 'dss-activity',
      status: 'dss-status',
      output: 'dss-output',
      tree: 'dss-tree',
    };

    var css = [
      '.dss-title{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-weight:500}',
      '.dss-summary{display:flex;align-items:center;min-width:0;flex:auto;overflow:hidden}',
      '.dss-separator{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}',
      '.dss-activity{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-secondary)}',
      '.dss-status{white-space:nowrap;flex:none;margin-left:8px;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);color:var(--dsw-alias-label-caption)}',
      '.dss-status[data-state="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.dss-status[data-state="warn"]{color:var(--dsw-alias-state-warn-label)}',
      '.dss-output{margin:4px 0 4px 22px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow-y:auto}',
      // A surfaces listing is a block tree: each face is a block, and its children
      // sit inside the parent's edge. The nesting is the layout, so a narrow window
      // wraps the words instead of breaking the shape -- which is what a character
      // drawing cannot promise.
      '.dss-tree{margin:4px 0 4px 22px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-markdown-code-block);font-size:12px;line-height:18px;max-height:520px;overflow-y:auto}',
      '.dss-block-tree{display:flex;flex-direction:column;gap:3px}',
      '.dss-block[data-depth="0"]{margin-top:7px}',
      '.dss-block[data-depth="0"]:first-child{margin-top:0}',
      '.dss-block-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dss-block-name{font-family:var(--ds-font-family-code,ui-monospace,monospace)}',
      '.dss-block-kind{font-size:10px;line-height:15px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-caption);font-weight:400}',
      '.dss-block-state{font-weight:400;font-size:11px;color:var(--dsw-alias-label-caption)}',
      '.dss-block-body{margin-left:6px;padding-left:12px;border-left:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:2px}',
      '.dss-block-note{font-size:11px;line-height:17px;color:var(--dsw-alias-label-caption);white-space:pre-wrap;word-break:break-word}',
      '.dss-block-edges{margin-top:8px;padding-top:6px;border-top:.5px dashed var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:2px}',
      '.dss-block-edges-title{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}',
      '.dss-block-edge{font-size:11px;color:var(--dsw-alias-label-caption);font-family:var(--ds-font-family-code,ui-monospace,monospace);word-break:break-word}',
    ].join('');

    var plugin = '@deepseek-ai/dsh-client-ui-tool';
    var cssTagId = 'dsh-shell-surfaces/ShellSurfaceRow.module.css';
    if (typeof document !== 'undefined') {
      var existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(cssTagId) + ']');
      if (existing === null) {
        var tag = document.createElement('style');
        tag.dataset.plugin = plugin;
        tag.dataset.pluginCss = cssTagId;
        tag.textContent = css;
        document.head.appendChild(tag);
      }
    }

    function firstLine(text) {
      var newline = text.indexOf('\n');
      return newline === -1 ? text : text.slice(0, newline);
    }

    /**
     * A surfaces listing as a tree, one element per line.
     *
     * The host already draws the shape with box-drawing characters, and those
     * stay in the text -- they survive a copy, and someone reading the raw output
     * still sees the hierarchy. What this adds is per-line identity and real
     * indentation: the face at the top of a family is bold, its shells sit under
     * it at their own depth, and the `when:` notes recede.
     * @param output - the settled result text, whose lines are the host's tree.
     */
    function renderTree(output) {
      var lines = String(output ?? '').split('\n');
      // The host hands the client one flattened string, so the structure is
      // rebuilt here: a face is a row carrying `[kind]`, a note starts with the
      // middle dot, and depth is the leading whitespace (four spaces per level).
      var root = { children: [], notes: [], text: '', depth: -1, kind: '' };
      var stack = [root];
      var crossings = [];
      var inCrossings = false;
      for (var index = 0; index < lines.length; index += 1) {
        var line = lines[index];
        if (line.trim() === '') continue;
        var spaces = line.length - line.replace(/^ +/, '').length;
        var depth = Math.floor(spaces / 4);
        var text = line.trim();
        if (text.indexOf('\u00b7 crossings:') === 0) {
          inCrossings = true;
          continue;
        }
        if (inCrossings) {
          crossings.push(text.replace(/^\u00b7 /, ''));
          continue;
        }
        while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
        var parent = stack[stack.length - 1];
        if (text.charAt(0) === '\u00b7') {
          parent.notes.push(text.replace(/^\u00b7 /, ''));
          continue;
        }
        var kindMatch = /\[([a-z]+)\]/.exec(text);
        var node = {
          children: [],
          notes: [],
          depth: depth,
          text: text,
          kind: kindMatch === null ? '' : kindMatch[1],
        };
        parent.children.push(node);
        stack.push(node);
      }
      // A block per face, nested inside its parent's edge: the tree is the layout,
      // not a character drawing, so a narrow window wraps the words instead of
      // breaking the shape. Notes stay inside the block they explain.
      var renderNode = (node) => {
        if (node.kind === '') return null;
        var rows = [];
        for (var n = 0; n < node.notes.length; n += 1) {
          rows.push(jsx('div', { key: 'n' + n, className: 'dss-block-note', children: node.notes[n] }));
        }
        for (var c = 0; c < node.children.length; c += 1) {
          var child = renderNode(node.children[c]);
          if (child !== null) rows.push(child);
        }
        var head = node.text.replace(/\s*\[[a-z]+\]\s*/, ' ');
        return jsx('div', {
          key: node.text,
          className: 'dss-block',
          'data-kind': node.kind,
          'data-depth': String(node.depth),
          children: [
            jsx('div', {
              key: 'h',
              className: 'dss-block-head',
              children: [
                jsx('span', { key: 'n', className: 'dss-block-name', children: node.text.split(' [')[0] }),
                jsx('span', { key: 'k', className: 'dss-block-kind', children: node.kind }),
                jsx('span', { key: 's', className: 'dss-block-state', children: head.replace(/^\S+\s+\S+\s+/, '') }),
              ],
            }),
            jsx('div', { key: 'b', className: 'dss-block-body', children: rows }),
          ],
        });
      };
      var blocks = [];
      for (var r = 0; r < root.children.length; r += 1) {
        var rendered = renderNode(root.children[r]);
        if (rendered !== null) blocks.push(rendered);
      }
      var edgeRows = [];
      for (var e = 0; e < crossings.length; e += 1) {
        edgeRows.push(jsx('div', { key: 'e' + e, className: 'dss-block-edge', children: crossings[e] }));
      }
      return jsx('div', {
        className: cls.tree,
        children: [
          jsx('div', { key: 'tree', className: 'dss-block-tree', children: blocks }),
          edgeRows.length === 0
            ? null
            : jsx('div', {
                key: 'edges',
                className: 'dss-block-edges',
                children: [
                  jsx('div', { key: 't', className: 'dss-block-edges-title', children: 'crossings' }),
                  ...edgeRows,
                ],
              }),
        ],
      });
    }

    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    function parseArgs(raw) {
      if (typeof raw !== 'string' || raw === '') return null;
      try {
        var value = JSON.parse(raw);
        return isRecord(value) ? value : null;
      } catch {
        return null;
      }
    }

    /** What the result text says about how the run ended. */
    function resultText(block) {
      var parts = [];
      for (var i = 0; i < block.content.length; i += 1) {
        var item = block.content[i];
        parts.push(item.type === 'text' ? item.text : JSON.stringify(item, null, 2));
      }
      var text = parts.join('\n');
      if (text !== '') return text;
      return block.error === undefined ? '' : block.error.name + ': ' + block.error.code;
    }

    /**
     * The row's state and its short status sentence. The exit status is read
     * from the tool's own one-line head ("wsl: exit code 1 in 120 ms"), because
     * the tool reports a failed command as a normal result rather than as an
     * error: the exit code is the fact, and a reader should not have to expand
     * the row to learn it.
     */
    function statusOf(block, settled, phase, t) {
      if (phase === 'preparing') return { state: 'running', text: t('preparing') };
      if (!settled) return { state: 'running', text: t('running') };
      if (block.error !== undefined && block.error.code === 'interrupted') return { state: 'stopped', text: t('stopped') };
      if (block.isError) return { state: 'error', text: t('failed') };
      var text = resultText(block);
      var timedOut = /timed out after \d+ ms/i.test(text);
      if (timedOut) return { state: 'warn', text: t('timedOut') };
      // A background run settles with a job id, not an exit code: the command is
      // still out there by design, so "完成" would be a lie about what happened.
      var job = /(?:started background job|moved to background job) (\S+)/.exec(text);
      if (job !== null) return { state: 'ok', text: t('background') + ' ' + job[1] };
      // A session call is one command inside a long-lived shell: the row names
      // the session, because "完成" would hide which one it belongs to.
      var sessionDone = /session (\S+) completed/.exec(text);
      if (sessionDone !== null) return { state: 'ok', text: t('session') + ' ' + sessionDone[1] };
      var sessionEnded = /session (\S+) ended/.exec(text);
      if (sessionEnded !== null) return { state: 'error', text: t('session') + ' ' + sessionEnded[1] };
      // A file-effect denial is a policy outcome, not a command failure: the
      // row says which mode refused it, so the reader sees the reason before
      // the exit code.
      var sandbox = /\[sandbox: file access denied under (\S+) mode\]/.exec(text);
      if (sandbox !== null) return { state: 'warn', text: t('sandboxed') + ' ' + sandbox[1] };
      var exit = /exit code (\d+) in (\d+) ms/.exec(text);
      if (exit !== null) {
        var code = Number(exit[1]);
        var ms = Number(exit[2]);
        if (code !== 0) return { state: 'error', text: exit[1] + ' · ' + ms + 'ms' };
        return { state: 'ok', text: t('done') + ' · ' + ms + 'ms' };
      }
      if (/could not start/i.test(text)) return { state: 'error', text: t('failed') };
      return { state: 'ok', text: t('done') };
    }

    /** The activity: the command (or script) that is running. */
    function activityOf(args, listing, t, output) {
      if (listing) {
        // The row says what the listing found rather than the word "list": the
        // first clause of the answer is the count ("32 of 32 surfaces are on
        // this machine"), and that is the part worth reading at a glance. The
        // tree itself is one click away, in the expanded output.
        if (typeof output === 'string' && output !== '') {
          var head = firstLine(output).trim();
          var cut = head.indexOf(';');
          var summary = cut === -1 ? head : head.slice(0, cut);
          if (summary !== '') return summary.length > 96 ? summary.slice(0, 93) + '...' : summary;
        }
        return t('list');
      }
      if (args === null) return '';
      if (typeof args.command === 'string' && args.command.trim() !== '') return firstLine(args.command).trim();
      if (typeof args.script === 'string' && args.script.trim() !== '') {
        var path = args.script.replace(/[\\/]+$/, '');
        var cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
        return t('script') + ' ' + (cut === -1 ? path : path.slice(cut + 1));
      }
      return '';
    }

    /** The surface name shown at the head of the row. */
    function labelOf(phase, listing, surfaceId, t) {
      if (phase === 'preparing') return t('preparing');
      if (listing) return 'shells';
      if (SURFACE_LABELS[surfaceId] !== undefined) return SURFACE_LABELS[surfaceId];
      // A shell that lives inside a distribution carries its distribution in the
      // id (`wsl-elvish`), and the row should say both: the shell is what the
      // command was written for, the distribution is where it ran.
      if (surfaceId.startsWith('wsl-') && surfaceId.length > 4) {
        return surfaceId.slice(4) + ' (WSL)';
      }
      if (surfaceId.startsWith('ssh-') && surfaceId.length > 4) {
        return 'ssh ' + surfaceId.slice(4);
      }
      if (surfaceId !== '') return surfaceId;
      return 'shell_surfaces';
    }

    /**
     * One `shell_surfaces` call as a single row: the surface on the left, the
     * activity beside it, the status at the end, and the captured output one
     * click away.
     */
    function ShellSurfaceRow(props) {
      var phase = props.phase;
      var block = props.block;
      var t = props.t;
      var settled = 'kind' in block;
      var argsRaw = settled ? (block.call && block.call.argsRaw) || '' : phase === 'start' ? block.argsRaw || '' : '';
      var args = parseArgs(argsRaw);
      var listing = args !== null && args.action === 'surfaces';
      var surfaceId = args !== null && typeof args.surface === 'string' ? args.surface : '';
      var label = labelOf(phase, listing, surfaceId, t);
      var activity = activityOf(args, listing, t, settled ? resultText(block) : '');
      var status = statusOf(block, settled, phase, t);
      var output = settled ? resultText(block) : '';
      // A listing is always open. It is a map of the machine rather than a log to
      // peek at, and folding it means the one call whose whole value is the
      // overview starts closed -- so the tree shows without a click (asked for
      // 2026-10-24). Every other call keeps the click, because its output can be
      // a screenful nobody wants by default.
      var expandable = output !== '' && !listing;
      var [expanded, setExpanded] = react.useState(false);
      var open = listing ? output !== '' : expanded && expandable;

      return jsx(primitives.DisclosureRow, {
        rowClassName: cls.row,
        leadingClassName: cls.leading,
        titleClassName: cls.title,
        icon: jsx(primitives.IconApiOutlineRegular, { size: 14 }),
        title: label,
        running: status.state === 'running',
        open: open,
        expandable: expandable,
        expandOnRowClick: expandable,
        keepContentWhenOpen: true,
        onToggle: function toggle() {
          setExpanded(function flip(value) {
            return !value;
          });
        },
        collapsedContent: jsxs(Fragment, {
          children: [
            activity === '' ? null : jsx('span', { className: cls.separator, 'aria-hidden': true }),
            activity === '' ? null : jsx('span', { className: cls.activity, children: activity }),
            jsx('span', {
              className: cls.status,
              'data-state': status.state,
              children: status.text,
            }),
          ],
        }),
        // A listing is the tree, always: it is what the call was for. Every other
        // call opens as its captured output when clicked.
        children: listing
          ? output !== ''
            ? renderTree(output)
            : null
          : open
            ? jsx('pre', { className: cls.output, children: output })
            : null,
      });
    }

    /** Required services: the UI slot registry and its translation dictionaries. */
    var inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(function dictionaries() {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, 'dsh-shell-surfaces: dictionaries');
      ctx.slots.inject('tool.call.toolview', function registerRow() {
        return ctx.slots.register(
          {
            name: 'tool.call.toolview',
            key: 'shell_surfaces',
            locale: NS,
          },
          ShellSurfaceRow,
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    // Exported for the self-test: this is a pure function from the listing text to
    // elements, and "the tree dropped a line" is exactly the failure worth
    // guarding -- a styled tree that silently loses a row is worse than a plain one.
    exports.renderTree = renderTree;
    return module.exports;
  },
});
