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
      // A surfaces listing is a treemap: one vertical band per kind, its width
      // proportional to how many faces the kind holds, and one cell per face
      // inside. The band width is a `flex` value, so the browser lays it out and
      // re-lays it out on resize -- no coordinates are computed for one window
      // width and then wrong at every other.
      //
      // Below a floor the pictures stop being readable, and shrinking them further
      // is the same as not showing them: the box keeps a minimum width and this
      // container scrolls sideways instead (asked for 2026-10-25).
      //
      // The box is also the handle: `resize: both` gives the reader a grip in the
      // corner, and because the treemap is a flex child it re-lays itself out at
      // whatever size that grip lands on -- row height and column width together,
      // without this file computing either (asked for 2026-10-25).
      '.dss-tree{margin:4px 0 4px 22px;padding:8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-markdown-code-block);display:flex;flex-direction:column;gap:6px;resize:both;overflow:auto;height:380px;min-height:220px;min-width:320px;max-height:80vh}',
      '.dss-tm{display:flex;gap:4px;flex:1 1 auto;min-height:200px;min-width:760px}',
      '.dss-tm-group{display:flex;flex-direction:column;gap:3px;min-width:0;min-height:0;padding:4px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.dss-tm-group-title{flex:none;font-size:10px;letter-spacing:.04em;color:var(--dsw-alias-label-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      // A band that is a family is a place other faces live in; a band that is a
      // kind is a grouping this file made up. They should not look equally solid.
      '.dss-tm-group[data-family="yes"]{background:var(--dsw-alias-bg-layer-3)}',
      '.dss-tm-group[data-family="yes"] .dss-tm-group-title{font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dss-tm-group-body{flex:1;display:flex;flex-direction:column;gap:3px;min-height:0}',
      '.dss-tm-cell{flex:1;display:flex;align-items:center;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;font-family:var(--ds-font-family-code,ui-monospace,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}',
      '.dss-tm-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dss-tm-cell[data-found="yes"]{background:transparent;border:1px dashed var(--dsw-alias-border-l3);color:var(--dsw-alias-label-caption)}',
      '.dss-tm-group[data-found="yes"]{background:transparent;border:1px dashed var(--dsw-alias-border-l2)}',
      '.dss-tm-cell[data-selected="yes"]{background:var(--dsw-alias-label-secondary);color:var(--dsw-alias-bg-base)}',
      '.dss-tm-detail{margin-top:8px;padding:6px 8px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:3px;flex:none}',
      '.dss-tm-detail-head{font-weight:600;font-size:11px;font-family:var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-secondary)}',
      '.dss-tm-detail-line{font-size:11px;line-height:17px;color:var(--dsw-alias-label-caption)}',
      '.dss-tm-cell[data-present="no"]{opacity:.45;text-decoration:line-through}',
      '.dss-block-edges{margin-top:8px;padding-top:6px;border-top:.5px dashed var(--dsw-alias-border-l2);flex:none}',
      '.dss-block-edges-title{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}',
      '.dss-xy{width:100%;min-width:460px;height:auto;display:block;margin-top:4px}',
      '.dss-xy-node{fill:var(--dsw-alias-bg-layer-3);stroke:var(--dsw-alias-border-l2);stroke-width:1}',
      '.dss-xy-text{font-size:10px;fill:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,monospace)}',
      '.dss-xy-line{stroke:var(--dsw-alias-border-l4);stroke-width:1.2}',
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
    /**
     * The crossings as a two-column graph: a face that borrows on the left, the
     * face it borrows on the right, one curve per edge. Seven edges and eleven
     * nodes is a size where a drawing beats a list -- unlike the thirty-five-face
     * map, where a list beats a drawing.
     * @param crossings - the `a -- b: how` lines the host printed.
     */
    function renderCrossings(crossings) {
      var edges = [];
      var lefts = [];
      var rights = [];
      for (var i = 0; i < crossings.length; i += 1) {
        var match = /^(\S+) \u2014 (\S+): (.*)$/.exec(crossings[i]);
        if (match === null) continue;
        edges.push({ from: match[1], to: match[2], how: match[3] });
        if (lefts.indexOf(match[1]) === -1) lefts.push(match[1]);
        if (rights.indexOf(match[2]) === -1) rights.push(match[2]);
      }
      if (edges.length === 0) return null;
      // The order is the answer to "what does everything depend on?": a node that
      // several edges point at sits at the top, and a tie is broken by name so the
      // drawing does not move when an unrelated row changes. Scanning order would
      // put `node` first only by accident.
      var borrowed = {};
      var borrows = {};
      for (var k = 0; k < edges.length; k += 1) {
        borrowed[edges[k].to] = (borrowed[edges[k].to] ?? 0) + 1;
        borrows[edges[k].from] = (borrows[edges[k].from] ?? 0) + 1;
      }
      var byWeight = function mostUsedFirst(a, b) {
        var wa = borrowed[a] ?? 0;
        var wb = borrowed[b] ?? 0;
        if (wa !== wb) return wb - wa;
        return a < b ? -1 : a > b ? 1 : 0;
      };
      rights.sort(byWeight);
      lefts.sort(function byBorrows(a, b) {
        var wa = borrows[a] ?? 0;
        var wb = borrows[b] ?? 0;
        if (wa !== wb) return wb - wa;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      var ROW = 26;
      var NODE_H = 18;
      var WIDTH = 460;
      var NODE_W = 120;
      var height = Math.max(lefts.length, rights.length) * ROW + 12;
      var at = {};
      for (var l = 0; l < lefts.length; l += 1) at['L:' + lefts[l]] = { x: 6, y: l * ROW + 6 };
      for (var r = 0; r < rights.length; r += 1) at['R:' + rights[r]] = { x: WIDTH - NODE_W - 6, y: r * ROW + 6 };
      var shapes = [];
      for (var e = 0; e < edges.length; e += 1) {
        var a = at['L:' + edges[e].from];
        var b = at['R:' + edges[e].to];
        if (a === void 0 || b === void 0) continue;
        var x1 = a.x + NODE_W;
        var y1 = a.y + NODE_H / 2;
        var x2 = b.x;
        var y2 = b.y + NODE_H / 2;
        var mid = (x1 + x2) / 2;
        shapes.push(
          jsx('path', {
            key: 'p' + e,
            d: 'M ' + x1 + ' ' + y1 + ' C ' + mid + ' ' + y1 + ', ' + mid + ' ' + y2 + ', ' + x2 + ' ' + y2,
            fill: 'none',
            className: 'dss-xy-line',
            children: jsx('title', { key: 't', children: edges[e].how }),
          }),
        );
      }
      var labels = [];
      var columns = [
        { list: lefts, key: 'L', anchor: 'start', x: 12 },
        { list: rights, key: 'R', anchor: 'start', x: WIDTH - NODE_W + 6 },
      ];
      for (var c = 0; c < columns.length; c += 1) {
        for (var n = 0; n < columns[c].list.length; n += 1) {
          var box = at[columns[c].key + ':' + columns[c].list[n]];
          labels.push(
            jsx('rect', {
              key: columns[c].key + 'r' + n,
              x: columns[c].key === 'L' ? 6 : WIDTH - NODE_W - 6,
              y: box.y,
              width: NODE_W,
              height: NODE_H,
              rx: 4,
              className: 'dss-xy-node',
            }),
          );
          labels.push(
            jsx('text', {
              key: columns[c].key + 't' + n,
              x: box.x + 6,
              y: box.y + 13,
              className: 'dss-xy-text',
              children: columns[c].list[n],
            }),
          );
        }
      }
      return jsx('svg', {
        className: 'dss-xy',
        viewBox: '0 0 ' + WIDTH + ' ' + height,
        preserveAspectRatio: 'xMidYMin meet',
        children: [...labels, ...shapes],
      });
    }

    function renderTree(output, selected, onSelect) {
      var lines = String(output ?? '').split('\n');
      // The host hands the client one flattened string, so everything the picture
      // needs is rebuilt here: a face is a row carrying `[kind]`, the two lines
      // under it are its summary and its `when:`, and `crossings` is a section.
      var faces = [];
      var crossings = [];
      var foundItems = [];
      var inCrossings = false;
      var inFound = false;
      var pending = null;
      var lastAtDepth = {};
      var current = selected ?? '';
      var choose = typeof onSelect === 'function' ? onSelect : function noop() {};
      for (var index = 0; index < lines.length; index += 1) {
        var line = lines[index];
        if (line.trim() === '') continue;
        var text = line.trim();
        if (text.indexOf('\u00b7 crossings:') === 0) {
          inCrossings = true;
          inFound = false;
          pending = null;
          continue;
        }
        if (text.indexOf('\u00b7 found, without a face of its own:') === 0) {
          inFound = true;
          inCrossings = false;
          pending = null;
          continue;
        }
        if (inCrossings) {
          crossings.push(text.replace(/^\u00b7 /, ''));
          continue;
        }
        if (inFound) {
          foundItems.push(text.replace(/^\u00b7 /, ''));
          continue;
        }
        if (text.charAt(0) === '\u00b7') {
          var body = text.replace(/^\u00b7 /, '');
          if (pending !== null) {
            if (body.indexOf('when: ') === 0) pending.guide = body.slice(6);
            else if (pending.summary === '') pending.summary = body;
          }
          continue;
        }
        var kindMatch = /\[([a-z]+)\]/.exec(text);
        if (kindMatch === null) {
          pending = null;
          continue;
        }
        var depth = Math.floor((line.length - line.replace(/^ +/, '').length) / 4);
        var name = text.split(' [')[0];
        // ` · 42 runs` on the face line is the count the host recorded. It is a
        // weight, not decoration: the treemap sizes a cell by how often its face has
        // actually run, so the picture answers "what is this machine used for?"
        // instead of "what is installed?". Compressed with a log because a face run
        // ten thousand times and one run ten times should not differ by a thousand
        // in area -- the map has to stay readable at both ends.
        var runsMatch = / \u00b7 (\d+) runs?$/.exec(text);
        var runs = runsMatch === null ? 0 : Number(runsMatch[1]);
        pending = {
          name: name,
          kind: kindMatch[1],
          present: text.indexOf('not on this machine') === -1,
          runs: runs,
          weight: 1 + Math.log2(1 + runs),
          summary: '',
          guide: '',
          depth: depth,
          // The indentation in the text IS the parent link: the face that last sat
          // one level up is the one this row hangs under.
          parent: depth > 0 ? lastAtDepth[depth - 1] ?? '' : '',
        };
        lastAtDepth[depth] = name;
        faces.push(pending);
      }

      // A treemap, laid out by flexbox rather than by arithmetic in this file.
      // Grouping is family first: a face that owns children becomes a band of its
      // own, holding itself and its children, so the map shows the same ownership
      // the tree does. Everything else is grouped by kind, because a lone face has
      // no family to belong to and its kind is the most useful thing left to say
      // about it.
      var owns = {};
      for (var o = 0; o < faces.length; o += 1) {
        if (faces[o].parent !== '') owns[faces[o].parent] = true;
      }
      var groups = [];
      var byKey = new Map();
      for (var f = 0; f < faces.length; f += 1) {
        var face = faces[f];
        var isFamily = owns[face.name] === true;
        var key = isFamily ? 'family:' + face.name : face.parent !== '' ? 'family:' + face.parent : 'kind:' + face.kind;
        if (!byKey.has(key)) {
          var group = {
            key: key,
            title: isFamily || face.parent !== '' ? (isFamily ? face.name : face.parent) : face.kind,
            family: isFamily || face.parent !== '',
            kind: face.kind,
            items: [],
          };
          byKey.set(key, group);
          groups.push(group);
        }
        byKey.get(key).items.push(face);
      }
      // A band has an order the reader can predict: faces that exist first, then the
      // absent ones, and by name inside each half. Scan order would be the table's
      // own sequence -- informative once, noise afterwards, because a face added
      // later lands wherever it was written.
      for (var s = 0; s < groups.length; s += 1) {
        groups[s].items.sort(function byPresenceThenName(left, right) {
          if (left.present !== right.present) return left.present ? -1 : 1;
          return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
        });
        groups[s].weight = 0;
        for (var w = 0; w < groups[s].items.length; w += 1) groups[s].weight += groups[s].items[w].weight;
      }
      var cells = [];
      for (var g = 0; g < groups.length; g += 1) {
        var rows = [];
        for (var c = 0; c < groups[g].items.length; c += 1) {
          var item = groups[g].items[c];
          rows.push(
            jsx('div', {
              key: item.name,
              className: 'dss-tm-cell',
              'data-present': item.present ? 'yes' : 'no',
              'data-selected': current === item.name ? 'yes' : 'no',
              'data-runs': String(item.runs),
              style: { flex: String(item.weight) },
              // Clicking a cell is how the explanation becomes reachable: at this
              // size the map can only show names, and a hover tooltip is not a
              // thing a reader can keep open while reading a paragraph.
              onClick: (function (name) {
                return function pick() {
                  choose(current === name ? '' : name);
                };
              })(item.name),
              children: item.name,
            }),
          );
        }
        cells.push(
          jsx('div', {
            key: groups[g].key,
            className: 'dss-tm-group',
            'data-family': groups[g].family ? 'yes' : 'no',
            style: { flex: String(groups[g].weight) },
            children: [
              jsx('div', {
                key: 't',
                className: 'dss-tm-group-title',
                children: groups[g].title + ' \u00b7 ' + groups[g].items.length,
              }),
              jsx('div', { key: 'b', className: 'dss-tm-group-body', children: rows }),
            ],
          }),
        );
      }
      // Programs that exist without becoming a face. They are not among the faces
      // above because a map of faces would then be lying, and they are not dropped
      // either: "this exists and has no face" is an answer, and it is the one a
      // reader most often needs next. A dashed outline says "not a face" without
      // needing a legend.
      if (foundItems.length > 0) {
        var foundCells = [];
        for (var fi = 0; fi < foundItems.length; fi += 1) {
          foundCells.push(
            jsx('div', {
              key: 'f' + fi,
              className: 'dss-tm-cell',
              'data-found': 'yes',
              title: foundItems[fi],
              children: foundItems[fi].split(' (')[0],
            }),
          );
        }
        cells.push(
          jsx('div', {
            key: 'found',
            className: 'dss-tm-group',
            'data-family': 'no',
            'data-found': 'yes',
            style: { flex: String(foundItems.length) },
            children: [
              jsx('div', { key: 't', className: 'dss-tm-group-title', children: 'found \u00b7 ' + foundItems.length }),
              jsx('div', { key: 'b', className: 'dss-tm-group-body', children: foundCells }),
            ],
          }),
        );
      }
      var chosen = null;
      for (var q = 0; q < faces.length; q += 1) {
        if (faces[q].name === current) chosen = faces[q];
      }
      var parts = [jsx('div', { key: 'tm', className: 'dss-tm', children: cells })];
      if (chosen !== null) {
        parts.push(
          jsx('div', {
            key: 'detail',
            className: 'dss-tm-detail',
            children: [
              jsx('div', {
                key: 'h',
                className: 'dss-tm-detail-head',
                children:
                  chosen.name +
                  ' [' +
                  chosen.kind +
                  ']' +
                  (chosen.runs > 0 ? ' \u00b7 ' + chosen.runs + (chosen.runs === 1 ? ' run' : ' runs') : ''),
              }),
              jsx('div', { key: 's', className: 'dss-tm-detail-line', children: chosen.summary }),
              chosen.guide === ''
                ? null
                : jsx('div', { key: 'g', className: 'dss-tm-detail-line', children: chosen.guide }),
            ],
          }),
        );
      }
      if (crossings.length > 0) {
        parts.push(
          jsx('div', {
            key: 'edges',
            className: 'dss-block-edges',
            children: [
              jsx('div', { key: 't', className: 'dss-block-edges-title', children: 'crossings' }),
              renderCrossings(crossings),
            ],
          }),
        );
      }
      return jsx('div', { className: cls.tree, children: parts });
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
      // Which cell the reader picked. Kept here rather than inside the renderer so
      // the choice survives the re-render a streamed result causes.
      var [picked, setPicked] = react.useState('');
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
            ? renderTree(output, picked, setPicked)
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
