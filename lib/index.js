// dsh-shell-surfaces -- the machine's other execution surfaces, as one tool.
//
// The problem this solves is not a missing fact, it is a missing handle. The
// selection rules for this machine's shells and consoles have been written down
// for a while (which surface for a structured pipe, which for a Linux-only tool,
// which for a program that waits for input), but a session could only act on
// them by composing a command string for pwsh and hoping the quoting survived.
// Here they become callable.
//
// What it is NOT:
//
//   * No message hooks and no prompt section. The rules live in the tool
//     description, which only costs context when the tool is in the catalog and
//     which the model reads exactly when it is choosing a surface.
//   * No new terminal emulator. A terminal emulator draws text for a person and
//     adds nothing to what a subprocess can do; the one surface that needs a
//     console talks to ConPTY directly.
//
// Discipline borrowed from this machine's other plugins: every failure is
// returned as a result the caller can act on (never a throw the harness has to
// dress up), and nothing here writes to a session log.

import { resolveSurfaces, surfaceSpecs } from './surfaces.js';
import { runSurface } from './runner.js';

export const name = 'dsh-shell-surfaces';
export const inject = ['tools'];

const ALL_IDS = () => Object.keys(surfaceSpecs());

function describeSurfaces(surfaces) {
  const lines = [];
  for (const [id, spec] of Object.entries(surfaces)) {
    const state = spec.present ? 'available' : `not on this machine (${spec.absent})`;
    lines.push(`- ${id} [${spec.kind}] ${state}`);
    lines.push(`    ${spec.summary}`);
    lines.push(`    when: ${spec.guide}`);
  }
  return lines.join('\n');
}

function toolDescription(surfaces) {
  const available = Object.entries(surfaces)
    .filter(([, spec]) => spec.present)
    .map(([id]) => id);
  return (
    "Run one command on one of this machine's non-PowerShell execution surfaces, or list which ones exist. " +
    'Use it instead of composing a pwsh command line that calls another shell: the command is passed as a ' +
    'single argv element, so quoting, backslashes and paths survive intact.\n' +
    `Surfaces: ${ALL_IDS().join(', ')} (present now: ${available.join(', ') || 'none'}).\n` +
    'Choosing one:\n' +
    '- wsl: the job needs something only Linux has -- real grep -P, GNU sed -i, /proc, pacman, an ELF binary. ' +
    'Windows paths are visible inside as /mnt/<drive>/...\n' +
    '- nu: the pipe should carry structured values rather than text (parse JSON/CSV once, emit `to json`).\n' +
    '- msys: a POSIX toolchain has to run natively on Windows, or pacman is the package manager wanted. ' +
    'It is a different userland from git-bash; a package in one is not visible in the other.\n' +
    '- zsh / fish / brush: the task is that shell language itself. brush speaks bash but uses Windows paths ' +
    'with no translation (`/tmp/x` lands at <drive>:\\tmp\\x).\n' +
    '- pty: the program needs a real console -- an install prompt asking Y/N, a full-screen TUI, anything ' +
    'reading [Console]::In.ReadLine(). Answer prompts with `send`; a pipe can never do this and installing a ' +
    'terminal emulator does not either.\n' +
    'Notes: a script file passed as `script` avoids every quoting layer and is the preferred form; `cwd` ' +
    'inside wsl is a Windows path here and is translated; the MSYS-family shells run as login shells on ' +
    'purpose (without that, /tmp means different places to two neighbouring processes on this machine); ' +
    'a trailing newline in `send` becomes Enter, and a bare answer to a prompt is given one; a first wsl call ' +
    'can take 35 s on a cold instance and `wsl.exe --shutdown` clears a wedged one.'
  );
}

function tool(surfaces) {
  return {
    name: 'shell_surfaces',
    description: toolDescription(surfaces),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'surfaces'],
          description:
            'run = execute one command on one surface; surfaces = report which surfaces exist on this machine, ' +
            'with the path each was looked for',
        },
        surface: {
          type: 'string',
          enum: ALL_IDS(),
          description: 'which surface to run on (required for action=run)',
        },
        command: {
          type: 'string',
          description:
            'the command line, passed to that surface as one argument (required for action=run unless script is given)',
        },
        script: {
          type: 'string',
          description:
            'absolute path of a script file to run instead of an inline command; preferred whenever quoting is involved',
        },
        cwd: {
          type: 'string',
          description: 'working directory for the command; for wsl a Windows path (translated to /mnt/<drive>/...)',
        },
        timeout_ms: {
          type: 'number',
          description: 'budget for the command, default 120000; a timeout is reported as a timeout, not as a failure',
        },
        max_output_chars: {
          type: 'number',
          description:
            'cap on returned stdout characters, default 20000; the full text is spilled to a file when it overflows',
        },
        send: {
          type: 'array',
          items: { type: 'string' },
          description:
            'pty only: text typed into the console once the program has settled, each entry in order; a trailing \\n means Enter. May repeat.',
        },
        pty_argv: {
          type: 'array',
          items: { type: 'string' },
          description:
            'pty only: the command split into an argv array, when a program name or an argument contains a space; ' +
            'otherwise `command` is split on whitespace and quotes',
        },
        settle_ms: {
          type: 'number',
          description: 'pty only: how long to let the program start before the first send, default 4000',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          surface: { type: 'string' },
          message: { type: 'string' },
          exitCode: { type: ['integer', 'null'] },
          timedOut: { type: 'boolean' },
          durationMs: { type: 'number' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
          spill: { type: 'string' },
          surfaces: { type: 'array' },
          argv: { type: 'array' },
        },
      },
      render: (_args, value) => {
        const parts = [String(value?.message ?? '')];
        if (typeof value?.stdout === 'string' && value.stdout.length > 0) parts.push(value.stdout);
        if (typeof value?.stderr === 'string' && value.stderr.length > 0) {
          parts.push(`--- stderr ---\n${value.stderr}`);
        }
        return [{ type: 'text', text: parts.filter(Boolean).join('\n') }];
      },
    },
    async execute(args) {
      const fresh = resolveSurfaces();
      const action = typeof args?.action === 'string' ? args.action : '';

      if (action === 'surfaces') {
        const rows = Object.entries(fresh).map(([id, spec]) => ({
          id,
          kind: spec.kind,
          present: spec.present,
          exe: spec.exe,
          lookedFor: spec.present ? spec.exe : spec.absent,
          summary: spec.summary,
        }));
        const missing = rows.filter((row) => !row.present).map((row) => row.id);
        return {
          ok: true,
          action: 'surfaces',
          message:
            `${rows.filter((r) => r.present).length} of ${rows.length} surfaces are on this machine` +
            (missing.length > 0 ? `; missing: ${missing.join(', ')}` : '') +
            '\n' +
            describeSurfaces(fresh),
          surfaces: rows,
        };
      }

      if (action !== 'run') {
        return {
          ok: false,
          action: action || '(none)',
          message: 'action must be "run" or "surfaces"',
        };
      }

      const surfaceId = typeof args?.surface === 'string' ? args.surface : '';
      if (!(surfaceId in fresh)) {
        return {
          ok: false,
          action: 'run',
          surface: surfaceId,
          message: `unknown surface "${surfaceId}"; known surfaces: ${ALL_IDS().join(', ')}. Call action="surfaces" to see which exist here.`,
        };
      }
      const command = typeof args?.command === 'string' ? args.command : '';
      const script = typeof args?.script === 'string' ? args.script : '';
      if (!command && !script) {
        return {
          ok: false,
          action: 'run',
          surface: surfaceId,
          message: 'give either `command` or `script`',
        };
      }
      const spec = fresh[surfaceId];
      if (!spec.present) {
        return {
          ok: false,
          action: 'run',
          surface: surfaceId,
          message: `${surfaceId} is not on this machine: ${spec.absent}. Call action="surfaces" for the full list.`,
        };
      }

      const timeoutMs = clampNumber(args?.timeout_ms, 120000, 1000, 3600000);
      const maxOutputChars = clampNumber(args?.max_output_chars, 20000, 500, 400000);
      const send = Array.isArray(args?.send) ? args.send.filter((s) => typeof s === 'string') : [];
      const ptyArgv = Array.isArray(args?.pty_argv) ? args.pty_argv.filter((s) => typeof s === 'string') : [];
      const settleMs = clampNumber(args?.settle_ms, 4000, 0, 600000);
      const cwd = typeof args?.cwd === 'string' ? args.cwd : '';

      let result;
      try {
        result = await runSurface(surfaceId, spec, {
          command,
          script,
          cwd,
          send,
          ptyArgv,
          settleMs,
          timeoutMs,
          maxOutputChars,
        });
      } catch (error) {
        // A malformed request (an empty command after splitting, a path that is
        // not a file) is reported as a result too: the caller needs the sentence,
        // not a stack trace dressed up as a harness failure.
        return {
          ok: false,
          action: 'run',
          surface: surfaceId,
          message: `${surfaceId}: ${String(error?.message ?? error)}`,
        };
      }

      const failed = Boolean(result.spawnError) || (result.exitCode !== 0 && !result.timedOut);
      const head = result.timedOut
        ? result.stdout
          // Measured on this machine: wsl.exe sometimes prints the result and
          // then declines to exit. Reporting only "timed out" would throw away
          // output that is in fact complete, so the two cases read differently.
          ? `${surfaceId}: the command produced output but the process had not exited when the ${timeoutMs} ms budget expired -- the output above is likely complete`
          : `${surfaceId}: timed out after ${timeoutMs} ms with no output (the command was stopped; a grandchild may still be running)`
        : result.spawnError
          ? `${surfaceId}: could not start -- ${result.spawnError}`
          : `${surfaceId}: exit code ${result.exitCode} in ${result.durationMs} ms`;
      const detail = [
        head,
        result.truncated ? `output was capped at ${maxOutputChars} characters; full text at ${result.spill}` : '',
        result.note,
      ].filter(Boolean);

      return {
        ok: !failed,
        action: 'run',
        surface: surfaceId,
        message: detail.join('\n'),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        spill: result.spill,
        argv: result.argv,
      };
    },
  };
}

function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function apply(ctx, config) {
  const row = config && typeof config === 'object' ? config : {};
  const surfaces = resolveSurfaces();
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[dsh-shell-surfaces] ${message}`);
    } catch {
      /* a logger that refuses is not a reason to fail the load */
    }
  };
  const missing = Object.entries(surfaces)
    .filter(([, spec]) => !spec.present)
    .map(([id]) => id);
  if (missing.length > 0) {
    warn(
      `these surfaces are not on this machine and will report themselves absent: ${missing.join(', ')} ` +
        `(config keys seen: ${Object.keys(row).join(', ') || 'none'})`,
    );
  }
  ctx.effect(() => ctx.tools.register(tool(surfaces)));
}
