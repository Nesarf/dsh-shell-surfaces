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
//   * No new terminal emulator. A terminal emulator draws text for a person and
//     adds nothing to what a subprocess can do; the one surface that needs a
//     console talks to ConPTY directly.
//
// What changed once this tool became the first choice rather than a fallback:
//
//   * It registers one prompt section. A tool description only speaks after
//     the catalogue is open and the model is already weighing surfaces -- it
//     cannot stop a call from reaching for pwsh on the way past. The section
//     says where the line is drawn (this tool first, pwsh for what is really
//     PowerShell) and sits at the TOOL_BASH placement, ahead of the pwsh rule,
//     so the selection is made before the shell-specific caveats are read.
//   * It ships a client half (lib/client.js) so a call renders as
//     `<surface> · <activity>` instead of the wire tool name. The tool row is
//     drawn from the CALL, before any result exists, so that is a client
//     concern; `tool.call.toolview` is the supported seam, and nothing here
//     patches a first-party package.
//
// Discipline borrowed from this machine's other plugins: every failure is
// returned as a result the caller can act on (never a throw the harness has to
// dress up), and nothing here writes to a session log.

import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSurfaces, surfaceSpecs, lastScan, refreshScan, describeSurfaces, openPathFor } from './surfaces.js';
import { runSurface, buildArgv, prepareEnv, spawnProc, decode } from './runner.js';
import {
  sessionKey,
  getSession,
  openSession,
  dropSession,
  sendToSession,
  closeSessions,
  reapIdleSessions,
  dropOwnerSessions,
} from './sessions.js';
import {
  ESCALATION_TARGETS,
  approveEscalation,
  classifyRunnerFailure,
  escalationHintMarker,
  matchesSignature,
  sandboxDenialMarker,
  sandboxPermissionsDescription,
  validateEscalationArgs,
} from '@deepseek-ai/dsh-sandbox';

export const name = 'dsh-shell-surfaces';
export const inject = ['tools', 'systemPrompt'];

const ALL_IDS = () => Object.keys(surfaceSpecs());

/**
 * How long a session may sit unused before the pool closes it.
 *
 * Thirty minutes by default, overridable through the environment for a machine
 * that wants longer-lived shells. The number is a resource decision rather than a
 * behavioural one: a session holds a real process for as long as it lives.
 */
const SESSION_IDLE_MS =
  Number(process.env.DSH_SESSION_IDLE_MS) > 0 ? Number(process.env.DSH_SESSION_IDLE_MS) : 30 * 60 * 1000;

/**
 * How often the timer sweeps the session pool.
 *
 * The sweep before each session call is not enough on its own: a shell opened
 * once and never returned to would only be noticed the next time somebody opened
 * another session, which may never happen in that host.
 */
const SESSION_SWEEP_MS = Math.max(60_000, Math.floor(SESSION_IDLE_MS / 6));

/**
 * The surface list grouped by kind, present ones only.
 *
 * A flat row of 32 ids is a paragraph nobody reads, and the kind is what a caller
 * is actually choosing between -- a shell language, an interpreter, a window, a
 * console. Absent entries are counted rather than listed: their reason is what
 * `action="surfaces"` is for.
 * @param surfaces - the resolved table.
 * @returns one line, and how many entries were left out.
 */
function describeGroups(surfaces) {
  const groups = new Map();
  let absent = 0;
  for (const [id, spec] of Object.entries(surfaces)) {
    if (!spec.present) {
      absent += 1;
      continue;
    }
    const kind = typeof spec.kind === 'string' && spec.kind !== '' ? spec.kind : 'other';
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(id);
  }
  const parts = [...groups.entries()].map(([kind, ids]) => {
    // Ten `wsl-<shell>` faces say one thing: the distribution hosts that many
    // shells. Naming each of them makes the line longer than the choice it is
    // supposed to explain, so they are counted rather than listed; the full tree
    // is what action="surfaces" prints.
    const derived = ids.filter((id) => id.startsWith('wsl-'));
    const named = ids.filter((id) => !id.startsWith('wsl-'));
    const list = derived.length > 0 ? [...named, `wsl-<shell> (${derived.length})`] : named;
    return `${kind}(${ids.length}): ${list.join(', ')}`;
  });
  return { text: parts.join('; ') || 'none', absent };
}

export function toolDescription(surfaces) {
  const grouped = describeGroups(surfaces);
  return (
    "Run one command on one of this machine's execution surfaces, or list which ones exist. " +
    'This is the first choice for running a command, PowerShell included: pick the surface the job needs ' +
    'and run it here. The built-in `pwsh` tool covers what this one does not carry -- a persistent session -- ' +
    'not ordinary PowerShell commands, which belong on this ' +
    'tool\'s `pwsh` surface. The command crosses as a single argv element, ' +
    'so quoting, backslashes and paths survive intact; wrapping another shell inside a pwsh command line ' +
    'is exactly where they do not.\n' +
    `Surfaces on this machine -- ${grouped.text}` +
    (grouped.absent > 0
      ? `; ${grouped.absent} more are in the table but absent here (action="surfaces" says why)`
      : '') +
    '.\n' +
    'Choosing one:\n' +
    '- wsl: the job needs something only Linux has -- real grep -P, GNU sed -i, /proc, pacman, an ELF binary. ' +
    'Windows paths are visible inside as /mnt/<drive>/...\n' +
    '- nu: the pipe should carry structured values rather than text (parse JSON/CSV once, emit `to json`).\n' +
    '- msys: a POSIX toolchain has to run natively on Windows, or pacman is the package manager wanted. ' +
    'It is a different userland from git-bash; a package in one is not visible in the other.\n' +
    '- zsh / fish / brush: the task is that shell language itself. brush speaks bash but uses Windows paths ' +
    'with no translation (`/tmp/x` lands at <drive>:\\tmp\\x).\n' +
    '- tcsh / busybox: the C shell, or the BusyBox ash userland, when that language or toolset is the task ' +
    'itself. Both live in the MSYS2 userland; busybox is not bash, so bash-isms do not apply.\n' +
    '- pwsh: the task is PowerShell itself -- .NET objects, registry/CIM providers, a module only ' +
    'PowerShell has, or a pipeline of objects. It carries the same job, escalation and session machinery ' +
    'as every other surface; only a terminal-style session with a drawn prompt or a cursor is not here.\n' +
    '- wsl-<distro> / git-bash / cmd: surfaces discovered by scanning this machine (one WSL distribution ' +
    'by name, the Git for Windows userland, the Windows command interpreter). They are absent when the ' +
    'scan did not find them; action="surfaces" reports what was found and where, and `refresh: true` ' +
    're-scans after something was installed.\n' +
    '- pty: the program needs a real console -- an install prompt asking Y/N, a full-screen TUI, anything ' +
    'reading [Console]::In.ReadLine(). Answer prompts with `send`; a pipe can never do this and installing a ' +
    'terminal emulator does not either.\n' +
    'Notes: a script file passed as `script` avoids every quoting layer and is the preferred form; `cwd` ' +
    'inside wsl is a Windows path here and is translated; the MSYS-family shells run as login shells on ' +
    'purpose (without that, /tmp means different places to two neighbouring processes on this machine); ' +
    'a trailing newline in `send` becomes Enter, and a bare answer to a prompt is given one; a first wsl call ' +
    'can take 35 s on a cold instance and `wsl.exe --shutdown` clears a wedged one. A surface-level failure ' +
    '(absent, spawn error, timeout) is a reason to call action="surfaces" and retry on the right surface, ' +
    'not a reason to change tools.\n' +
    'Background: `run_in_background: true` starts the command as a job and returns its id (collect it with ' +
    'job_output, stop it with job_kill); no timeout applies. `promote_on_timeout: true` keeps a command that ' +
    'outlives its budget alive as a background job instead of killing it. The pty surface supports neither ' +
    '-- a console has no clean process to hand over.'
  );
}

/** One-line label for a job: the surface, then what is being run. */
function jobLabel(surfaceId, args) {
  const text =
    typeof args?.command === 'string' && args.command.trim() !== ''
      ? args.command
      : typeof args?.script === 'string'
        ? args.script
        : '';
  const first = String(text).split('\n')[0].trim();
  return `${surfaceId}: ${first || '(no command)'}`;
}

/**
 * Explain one finished run's confinement in the vocabulary the built-in shell
 * tools use: the mode, whether a file effect was denied, how completely the
 * backend enforces it, and whether the runner itself failed before the command
 * could run.
 */
function sandboxFactOf(result, policy) {
  if (policy === void 0) return void 0;
  if (result.confined === void 0) {
    return policy.mode === 'danger-full-access' ? { mode: policy.mode, denied: false } : void 0;
  }
  const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
  const denied = exitCode !== null && exitCode !== 0 && matchesSignature(exitCode, result.stderr, result.confined.denialSignatures);
  const failure = classifyRunnerFailure(exitCode, result.stderr, result.confined.runnerFailureRules);
  return {
    mode: policy.mode,
    denied,
    enforcement: result.confined.enforcement,
    ...(failure !== void 0 ? { runnerFailed: true } : {}),
  };
}

/** The producer hooks one live process reports through, whichever way it was started. */
function procHooks(proc) {
  const done = proc.done.then((outcome) => ({
    status: outcome.spawnError === undefined ? 'completed' : 'failed',
    detail: outcome.spawnError === undefined ? `exit code ${outcome.exitCode}` : outcome.spawnError,
  }));
  return {
    cancel: () => {
      try {
        proc.child?.kill();
      } catch {
        /* already gone */
      }
    },
    done,
  };
}

/**
 * Start one surface process as a background job. The job owns the process from
 * the first byte, so nothing is buffered and handed over twice.
 */
function startBackgroundJob(jobs, built, cwd, owner, label) {
  return jobs.start({
    kind: 'shell-surfaces',
    label,
    ...(owner !== undefined ? { owner } : {}),
    run: (job) => {
      // A surface whose command travels as data hands it over here too, so a
      // background run and a foreground run reach the shell the same way.
      const proc = spawnProc(built.argv, { env: built.env, cwd: cwd || undefined, stdin: built.stdin });
      proc.child?.stdout?.on('data', (chunk) => job.append(decode(chunk), { channel: 'stdout' }));
      proc.child?.stderr?.on('data', (chunk) => job.append(decode(chunk), { channel: 'stderr' }));
      return procHooks(proc);
    },
  });
}

/**
 * Promote an already-running process into a job. The output collected before
 * the timeout is flushed once, then the same listeners keep streaming.
 */
function promoteToJob(jobs, proc, owner, label) {
  return jobs.start({
    kind: 'shell-surfaces',
    label,
    ...(owner !== undefined ? { owner } : {}),
    run: (job) => {
      const flushed = proc.snapshot();
      if (flushed.stdout !== '') job.append(flushed.stdout, { channel: 'stdout' });
      if (flushed.stderr !== '') job.append(flushed.stderr, { channel: 'stderr' });
      proc.child?.stdout?.on('data', (chunk) => job.append(decode(chunk), { channel: 'stdout' }));
      proc.child?.stderr?.on('data', (chunk) => job.append(decode(chunk), { channel: 'stderr' }));
      return procHooks(proc);
    },
  });
}

function tool(surfaces, services) {
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
          description:
            'which surface to run on (required for action=run); action="surfaces" lists the ids this machine ' +
            'has. The set is discovered at run time, so a surface the scan found after start-up is accepted too.',
        },
        refresh: {
          type: 'boolean',
          description:
            'with action="surfaces": re-scan this machine before reporting, instead of answering from the ' +
            'start-up scan. A surface installed since the host started appears after a refresh.',
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
        run_in_background: {
          type: 'boolean',
          description:
            'start the command as a background job and return its id immediately; collect with job_output, stop ' +
            'with job_kill. No timeout applies. Not supported on the pty surface, and not with a session.',
        },
        promote_on_timeout: {
          type: 'boolean',
          description:
            'when the timeout passes, keep the command running as a background job instead of killing it. ' +
            'Not supported on the pty surface.',
        },
        description: {
          type: 'string',
          description: 'one-line label for a background job (shown in the job list); defaults to the command',
        },
        session: {
          type: 'string',
          description:
            'run inside a persistent session with this name: one long-lived shell per (agent, surface, name), ' +
            'where state -- the current directory, variables, modules -- persists across calls. Supported on ' +
            `${Object.entries(surfaces)
              .filter(([, spec]) => spec.session !== undefined)
              .map(([id]) => id)
              .join(', ') || '(none on this machine)'}. A session runs one command at a time, so the two job ` +
            'flags are refused with it. Omit for a fresh process per call.',
        },
        session_reset: {
          type: 'boolean',
          description: 'with `session`: end the existing session first and start a fresh one',
        },
        sandbox_permissions: {
          type: 'string',
          enum: [...ESCALATION_TARGETS],
          description: sandboxPermissionsDescription('command'),
        },
        justification: {
          type: 'string',
          description:
            'Required with sandbox_permissions: one sentence for the user explaining why this exact command ' +
            'needs the wider access. Use the language of the user\u2019s current request.',
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
          // A single type, deliberately. The host's validator refuses a type
          // array ("type arrays are not supported"), and a refusal here is not a
          // warning: the whole plugin fails to activate. Absence is expressed by
          // omitting the field -- `timedOut` and `spawnError` already tell the
          // reader which case they are looking at -- so the schema stays closed
          // and single-typed.
          exitCode: { type: 'integer' },
          timedOut: { type: 'boolean' },
          durationMs: { type: 'number' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
          spill: { type: 'string' },
          surfaces: { type: 'array' },
          discovered: { type: 'array' },
          argv: { type: 'array' },
          jobId: { type: 'string' },
          promoted: { type: 'boolean' },
          session: { type: 'string' },
          sandbox: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string' },
              denied: { type: 'boolean' },
              enforcement: { type: 'string' },
              runnerFailed: { type: 'boolean' },
            },
          },
        },
      },
      render: (_args, value) => {
        const parts = [String(value?.message ?? '')];
        // The sandbox vocabulary is the one every enforcing family reports, so a
        // denial reads the same here as it does on the built-in shell tools.
        if (value?.sandbox !== undefined) {
          if (value.sandbox.runnerFailed === true) {
            parts.push(
              `[sandbox: the sandbox runner itself failed under ${value.sandbox.mode} mode \u2014 the command did not ` +
                'run; this is a sandbox problem, not a command failure]',
            );
          } else if (value.sandbox.denied === true) {
            parts.push(sandboxDenialMarker(value.sandbox.mode));
            if (ESCALATION_TARGETS.length > 0) parts.push(escalationHintMarker('command'));
          }
        }
        // A note is what the surface has to say about itself rather than about the
        // command: "this is a screen transcript", "ssh refused before the command
        // ran". It used to be produced and never rendered, which made it a field
        // nobody could read (found 2026-10-24 while adding the ssh note).
        if (typeof value?.note === 'string' && value.note !== '') parts.push(value.note);
        if (typeof value?.stdout === 'string' && value.stdout.length > 0) parts.push(value.stdout);
        if (typeof value?.stderr === 'string' && value.stderr.length > 0) {
          parts.push(`--- stderr ---\n${value.stderr}`);
        }
        return [{ type: 'text', text: parts.filter(Boolean).join('\n') }];
      },
    },
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action : '';
      // A refresh is a surfaces-query idea: re-run the scan before answering, so
      // a shell installed since start-up shows up without a host restart.
      if (action === 'surfaces' && args?.refresh === true) refreshScan();
      const fresh = resolveSurfaces();

      if (action === 'surfaces') {
        const rows = Object.entries(fresh).map(([id, spec]) => ({
          id,
          kind: spec.kind,
          present: spec.present,
          exe: spec.exe,
          lookedFor: spec.present ? spec.exe : spec.absent,
          summary: spec.summary,
          // Where the row belongs in the tree: `parent` is the id it hangs
          // under, '' for a root. The client draws the same shape the text does.
          family: spec.family ?? '',
          parent: spec.parent ?? '',
          // The edges, not just the tree: a client that wants to draw a graph
          // rather than parse the text needs them here, and a row that forgets to
          // carry them would make the text and the picture disagree.
          cooperates: spec.cooperates ?? [],
        }));
        const missing = rows.filter((row) => !row.present).map((row) => row.id);
        // What the scan found, not only what the table claims: the same report a
        // person would get from walking PATH and the usual install roots.
        const report = lastScan();
        const discovered = [
          ...report.shells.map((hit) => ({ kind: 'shell', name: hit.name, path: hit.path, source: hit.source })),
          // A discovered terminal is not a dead end: `openWith` says how that
          // program can still carry a command (the shim, a pane, a headless
          // multiplexer), so "reported but not a face" comes with a next step
          // rather than a shrug.
          ...report.terminals.map((hit) => ({
            kind: 'terminal',
            name: hit.name,
            path: hit.path,
            source: hit.source,
            openWith: openPathFor(hit.name),
          })),
          ...report.distros.map((name) => ({ kind: 'wsl-distro', name, path: 'wsl.exe', source: 'wsl -l -q' })),
        ];
        return {
          ok: true,
          action: 'surfaces',
          message:
            `${rows.filter((r) => r.present).length} of ${rows.length} surfaces are on this machine` +
            (missing.length > 0 ? `; missing: ${missing.join(', ')}` : '') +
            `; the scan found ${report.shells.length} shell(s), ${report.terminals.length} terminal(s) ` +
            `and ${report.distros.length} WSL distribution(s)` +
            (args?.refresh === true ? '; the scan ran again just now' : '') +
            '\n' +
            describeSurfaces(fresh),
          surfaces: rows,
          discovered,
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
      const runInBackground = args?.run_in_background === true;
      const promoteOnTimeout = args?.promote_on_timeout === true;
      const description =
        typeof args?.description === 'string' && args.description.trim() !== '' ? args.description.trim() : '';
      const owner = exec?.agent?.id;
      const label = description !== '' ? description : jobLabel(surfaceId, args);

      // The sandbox rides each call, not the deployment: resolve the standing
      // policy for this session, honour an approved escalation for this call
      // only, then confine the exact argv the surface will spawn. A composition
      // without a policy keeps the old behaviour untouched, and
      // danger-full-access never consults the provider.
      const sandboxProvider = services.sandbox();
      const policyService = services.policy();
      const standingPolicy = policyService?.resolve(exec?.agent ? { session: exec.agent.session } : {});
      let sandboxPolicy = standingPolicy;
      if (args?.sandbox_permissions !== void 0 || args?.justification !== void 0) {
        try {
          validateEscalationArgs(args?.sandbox_permissions, args?.justification);
        } catch (error) {
          return {
            ok: false,
            action: 'run',
            surface: surfaceId,
            message: `sandbox_permissions refused: ${String(error?.message ?? error)}`,
          };
        }
        if (standingPolicy === void 0) {
          return {
            ok: false,
            action: 'run',
            surface: surfaceId,
            message: 'sandbox_permissions is not available in this composition: no sandbox policy is mounted',
          };
        }
        try {
          const approved = await approveEscalation(
            {
              requestedMode: args.sandbox_permissions,
              justification: args.justification,
              effectiveMode: standingPolicy.mode,
              subject: 'command',
            },
            {
              approver: services.approval(),
              agent: exec?.agent,
              callId: exec?.callId,
              toolName: 'shell_surfaces',
              signal: exec?.signal,
            },
          );
          sandboxPolicy = { ...standingPolicy, mode: approved };
        } catch (error) {
          return {
            ok: false,
            action: 'run',
            surface: surfaceId,
            message: `sandbox escalation refused: ${String(error?.message ?? error)}`,
          };
        }
      }
      const confine =
        sandboxProvider !== void 0 && sandboxPolicy !== void 0 && sandboxPolicy.mode !== 'danger-full-access'
          ? (argv) => sandboxProvider.confine(argv, sandboxPolicy, exec?.signal)
          : void 0;
      // What a completed run reports about its confinement: the mode and the
      // enforcement completeness. A denial is only knowable after the run.
      const sandboxFacts = sandboxPolicy !== void 0 ? { mode: sandboxPolicy.mode, denied: false } : void 0;

      // A persistent session keeps shell state across calls: one long-lived
      // process per (owner, surface, name), with a random marker telling where
      // one command's output ends. It runs one command at a time, so the job
      // flags are refused rather than silently ignored.
      if (typeof args?.session === 'string' && args.session !== '') {
        const sessionName = args.session;
        if (spec.session === undefined) {
          const supported = Object.keys(fresh).filter((id) => fresh[id].session !== undefined);
          return {
            ok: false,
            action: 'run',
            surface: surfaceId,
            session: sessionName,
            message:
              `${surfaceId} has no persistent session; sessions exist for: ` +
              (supported.join(', ') || '(none on this machine)'),
          };
        }
        if (runInBackground || promoteOnTimeout) {
          return {
            ok: false,
            action: 'run',
            surface: surfaceId,
            session: sessionName,
            message:
              'a persistent session runs one command at a time; run_in_background and promote_on_timeout need a ' +
              'fresh process, so drop the session flag for those',
          };
        }
        if (command === '') {
          return {
            ok: false,
            action: 'run',
            surface: surfaceId,
            session: sessionName,
            message: 'a session needs `command`: a script file path is not a command line',
          };
        }
        const ownerId = exec?.agent?.id ?? 'anonymous';
        // A session is a real process and nothing closes it but plugin unload, so
        // an idle sweep runs here -- the moment a caller is about to care how many
        // are open. Measured behaviour of the pool, not a guess: a shell nobody
        // returned to used to stay alive until the host restarted.
        const reaped = reapIdleSessions(SESSION_IDLE_MS);
        const key = sessionKey(ownerId, surfaceId, sessionName);
        if (args?.session_reset === true) dropSession(key);
        let session = getSession(key);
        let enforced;
        if (session === undefined || session.closed === true) {
          // Most surfaces are `exe` plus a flag list; wsl needs the distribution
          // in its command line, so a session may build its own argv instead.
          const argv =
            typeof spec.session.argvFor === 'function'
              ? spec.session.argvFor(spec)
              : [spec.exe, ...spec.session.argv];
          let spawnArgv = argv;
          if (confine !== void 0) {
            try {
              enforced = await confine(argv);
              spawnArgv = enforced.argv;
            } catch (error) {
              return {
                ok: false,
                action: 'run',
                surface: surfaceId,
                session: sessionName,
                message: `${surfaceId}: the sandbox could not confine this session -- ${String(error?.message ?? error)}`,
              };
            }
          }
          session = openSession(key, spawnArgv, prepareEnv(spec), cwd || undefined);
        }
        const outcome = await sendToSession(session, command, spec.session.marker, timeoutMs, exec?.signal);
        const facts =
          sandboxFacts !== void 0
            ? { ...sandboxFacts, ...(enforced !== void 0 ? { enforcement: enforced.enforcement } : {}) }
            : void 0;
        const head = outcome.closed
          ? `${surfaceId}: session ${sessionName} ended (exit code ${outcome.exitCode ?? 'unknown'}); the next call starts a new one`
          : outcome.timedOut
            ? `${surfaceId}: session ${sessionName} did not finish within ${timeoutMs} ms; the session stays open and the output so far is below`
            : `${surfaceId}: session ${sessionName} completed in ${outcome.durationMs ?? 0} ms`;
        // Said out loud rather than silent: a caller whose old shells were reaped
        // should know why the next call to one of them starts a fresh shell.
        const reapedNote = reaped.length > 0 ? `; closed ${reaped.length} idle session(s)` : '';
        return {
          ok: !outcome.closed,
          action: 'run',
          surface: surfaceId,
          session: sessionName,
          ...(facts !== void 0 ? { sandbox: facts } : {}),
          message: `${head}${reapedNote}`,
          timedOut: outcome.timedOut === true,
          durationMs: outcome.durationMs ?? 0,
          stdout: outcome.text,
          stderr: '',
          truncated: outcome.lossy === true,
          spill: '',
        };
      }

      // A background run is its own path, not a flag on the foreground one: the
      // job owns the process from the first byte, and the call returns the job
      // id instead of an exit status. The console is excluded on purpose -- a
      // transcript has to be read while it is live, and there is no clean
      // process to hand over.
      if (runInBackground) {
        if (surfaceId === 'pty') {
          return {
            ok: false,
            action: 'run',
            surface: surfaceId,
            message:
              'the pty surface cannot run in the background -- a console transcript is read while the program ' +
              'is alive; use a shell surface for background work',
          };
        }
        const jobs = services.jobs();
        if (jobs === void 0) {
          return {
            ok: false,
            action: 'run',
            surface: surfaceId,
            message:
              'run_in_background needs the jobs service, which this composition does not provide; run the ' +
              'command in the foreground instead',
          };
        }
        const built = buildArgv(
          surfaceId,
          spec,
          { command, script, cwd, send, ptyArgv, settleMs, timeoutMs },
          prepareEnv(spec),
        );
        // The job path confines before it starts: the provider is async and the
        // job's starter is not, so the wrap happens here and the job receives
        // the argv it should spawn.
        let spawnArgv = built.argv;
        let enforced;
        if (confine !== void 0) {
          try {
            enforced = await confine(built.argv);
            spawnArgv = enforced.argv;
          } catch (error) {
            return {
              ok: false,
              action: 'run',
              surface: surfaceId,
              message: `${surfaceId}: the sandbox could not confine this command -- ${String(error?.message ?? error)}`,
            };
          }
        }
        try {
          const jobId = startBackgroundJob(jobs, { argv: spawnArgv, env: built.env }, cwd, owner, label);
          return {
            ok: true,
            action: 'run',
            surface: surfaceId,
            jobId,
            ...(sandboxFacts !== void 0
              ? { sandbox: { ...sandboxFacts, ...(enforced !== void 0 ? { enforcement: enforced.enforcement } : {}) } }
              : {}),
            message:
              `${surfaceId}: started background job ${jobId}` +
              (description !== '' ? ` (${description})` : '') +
              ' -- read it with job_output, stop it with job_kill',
          };
        } catch (error) {
          return {
            ok: false,
            action: 'run',
            surface: surfaceId,
            message: `${surfaceId}: could not start a background job -- ${String(error?.message ?? error)}`,
          };
        }
      }

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
          promoteOnTimeout,
          confine,
          sandboxMode: sandboxPolicy?.mode,
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

      // A promoted timeout: the process is still alive. Hand it to the job
      // registry and return the job id, so the caller keeps what a kill would
      // have thrown away -- and a timeout stops being a reason to rerun the
      // whole command.
      if (result.promoted) {
        const jobs = services.jobs();
        if (jobs !== void 0) {
          const jobId = promoteToJob(jobs, result.proc, owner, label);
          const facts = sandboxFactOf(result, sandboxPolicy);
          return {
            ok: true,
            action: 'run',
            surface: surfaceId,
            jobId,
            promoted: true,
            ...(facts !== void 0 ? { sandbox: facts } : {}),
            message:
              `${surfaceId}: still running after ${timeoutMs} ms -- moved to background job ${jobId}` +
              ' (read it with job_output, stop it with job_kill); output so far follows',
            timedOut: true,
            durationMs: result.durationMs,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
            spill: result.spill,
            argv: result.argv,
          };
        }
        // No jobs service to hand it to: the original rule applies, and the
        // process must not be left running with nobody able to collect it.
        try {
          result.proc.child?.kill();
        } catch {
          /* already gone */
        }
        result.promoted = false;
        result.proc = void 0;
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
      // A surface that could not start, or that timed out without finishing, is
      // a fact about the surface rather than about the command -- and it must
      // not read as "this tool does not work". The hint names the next call this
      // plugin can answer, so the retry stays inside this plugin instead of
      // leaving for a different shell tool.
      if (result.spawnError || result.timedOut) {
        detail.push(
          'next: a surface-level failure, not a command failure -- call action="surfaces" to see what exists, ' +
            'then retry on the right surface (a different surface is not a different tool)',
        );
      }

      const facts = sandboxFactOf(result, sandboxPolicy);
      return {
        ok: !failed,
        action: 'run',
        surface: surfaceId,
        message: detail.join('\n'),
        // Omitted rather than set to null: the schema declares one type per
        // field, and the host validates the result against it before the reader
        // ever sees it. A null here would be a schema violation, not a nuance.
        ...(Number.isInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        spill: result.spill,
        argv: result.argv,
        ...(facts !== void 0 ? { sandbox: facts } : {}),
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
  // The selection rule, placed ahead of the pwsh rule. One paragraph on purpose:
  // this text is assembled into every step, so it earns its place only by
  // changing which tool a call reaches for, never by repeating the tool's own
  // description (which the model reads when it is already choosing).
  ctx.systemPrompt.section({
    name: 'tool:shell-surfaces',
    order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
    text:
      'Running commands: `shell_surfaces` is the first choice, not a fallback, and that includes PowerShell ' +
      '-- a PowerShell command belongs on its `pwsh` surface, not on a separate tool. Before writing a ' +
      'command, pick the surface the job needs -- wsl for a Linux-only tool or a real GNU/POSIX pipeline; ' +
      'msys, zsh, fish or brush when the shell language itself is the task; nu when a pipe should carry ' +
      'structured values; pwsh for PowerShell itself; pty when a program waits for input or addresses the ' +
      'cursor -- and run it there. Never wrap another shell inside a `pwsh` command line: the extra ' +
      'quoting layer is where paths get mangled. A command you are about to run through another shell ' +
      'tool belongs here instead: foreground, background, timeout promotion, escalation and sessions are ' +
      'all on this tool. The built-in persistent `pwsh` tool remains for the one shape this one does not ' +
      'carry -- a terminal session that keeps a drawn prompt, a TUI or a cursor. The sandbox is the same ' +
      'one the built-in shell tools use: a file effect denied under a confined mode is a policy answer, ' +
      'so escalate once with `sandbox_permissions` and a justification, or explain why the command ' +
      'cannot run -- never work around the fence. Given a surface-level failure -- absent, spawn error, ' +
      'timeout -- do not change tools: call action="surfaces" and retry on the right surface.',
  });
  // The jobs service is looked up per call rather than captured: a composition
  // may mount it after this row, and a background request must see the service
  // that exists when the call arrives. The same holds for the sandbox trio.
  // Persistent sessions are process resources: the plugin's disposal is the one
  // place that can guarantee every one of them is closed.
  ctx.effect(() => () => closeSessions(), 'dsh-shell-surfaces: close persistent sessions');
  // ...but disposal is not enough. The sweep before each session call only runs
  // when somebody makes a session call, so a shell opened once and never returned
  // to would survive until the host restarted. This timer is the clock nobody
  // else provides; it is unref'd so it cannot hold the process open by itself.
  ctx.effect(() => {
    const timer = setInterval(() => reapIdleSessions(SESSION_IDLE_MS), SESSION_SWEEP_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'dsh-shell-surfaces: sweep idle sessions');
  // Sessions belong to an agent, and a conversation ending is the moment an
  // agent's shells should go with it. DSH exposes `session/disposed` but no
  // `agent/disposed`, so the pair is learned the other way round: `agent/created`
  // carries `agent.session.id` (the same field prestep-audit reads), and a
  // disposed session closes the shells of every agent that named it.
  // A composition that predates the event API simply has no owner lifecycle to
  // join: the idle sweep and plugin disposal still cover it.
  if (typeof ctx.on === 'function') {
    const agentToSession = new Map();
    ctx.on('agent/created', ({ agent } = {}) => {
      const agentId = agent?.id;
      const sessionId = agent?.session?.id;
      if (typeof agentId === 'string' && typeof sessionId === 'string') agentToSession.set(agentId, sessionId);
    });
    ctx.on('session/disposed', (session) => {
      const sessionId = session?.id;
      if (typeof sessionId !== 'string') return;
      const owners = [];
      for (const [agentId, owned] of [...agentToSession]) {
        if (owned !== sessionId) continue;
        agentToSession.delete(agentId);
        owners.push(agentId);
        dropOwnerSessions(agentId);
      }
      // This is the one path in this plugin a tool call cannot exercise: no
      // argument makes a conversation go away. So it leaves a trace when asked --
      // written even when no owner matched, because the arrival itself is the
      // interesting part, and "did it ever fire?" should be answerable without a
      // debugger. Off unless DSH_SESSION_TRACE=1.
      if (process.env.DSH_SESSION_TRACE === '1') {
        try {
          const file = process.env.DSH_SESSION_TRACE_FILE ?? join(tmpdir(), 'dss-session-trace.log');
          appendFileSync(file, `${new Date().toISOString()}\tdisposed=${sessionId}\towners=${owners.join(',') || '-'}\n`);
        } catch (error) {
          ctx.logger?.warn?.(`dsh-shell-surfaces: could not write the session trace (${error?.message ?? error})`);
        }
      }
    });
    ctx.effect(() => () => agentToSession.clear(), 'dsh-shell-surfaces: forget agent sessions');
  }
  ctx.effect(() =>
    ctx.tools.register(
      tool(surfaces, {
        jobs: () => ctx.get('jobs'),
        sandbox: () => ctx.get('sandbox'),
        policy: () => ctx.get('sandboxPolicy'),
        approval: () => ctx.get('approval'),
      }),
    ),
  );
}
