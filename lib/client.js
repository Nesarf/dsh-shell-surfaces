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
    function activityOf(args, listing, t) {
      if (listing) return t('list');
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
      var activity = activityOf(args, listing, t);
      var status = statusOf(block, settled, phase, t);
      var output = settled ? resultText(block) : '';
      var expandable = output !== '';
      var [expanded, setExpanded] = react.useState(false);
      var open = expanded && expandable;

      return jsx(primitives.DisclosureRow, {
        rowClassName: cls.row,
        leadingClassName: cls.leading,
        titleClassName: cls.title,
        icon: jsx(primitives.IconApiOutlineRegular, { size: 14 }),
        title: label,
        running: status.state === 'running',
        open: open,
        expandable: expandable,
        expandOnRowClick: true,
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
        children: open ? jsx('pre', { className: cls.output, children: output }) : null,
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
    return module.exports;
  },
});
