# dsh-shell-surfaces

<img src="assets/dessa-sophia.jpg" alt="Dessa Sophia" width="320">

[![test](https://github.com/Nesarf/dsh-shell-surfaces/actions/workflows/test.yml/badge.svg)](https://github.com/Nesarf/dsh-shell-surfaces/actions/workflows/test.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

`https://github.com/Nesarf/dsh-shell-surfaces` -- a DSH plugin, installed with
`dsh plugin --profile <profile> add github:Nesarf/dsh-shell-surfaces`.

The badge is the whole test workflow: the pure self-test, and the two-runner
probe that asks every shell on Windows and on Linux what it is. A green badge
therefore means "the table and the argv shape still hold, and both platforms
still answered", not just "the linter passed".

One DSH tool for the execution surfaces this machine has: a WSL Linux userland,
nushell's structured pipelines, the MSYS2 userland (bash / zsh / fish / brush),
PowerShell itself, and a real console for interactive programs.

It exists because a rule that is only written down is not a capability. The
selection rules for these surfaces have been recorded for a while, but a session
could only act on them by composing a command string for pwsh and hoping the
quoting survived the trip. Here they are callable.

```
shell_surfaces(action="surfaces")                    what exists here, and where each was looked for
shell_surfaces(action="run", surface="wsl",  command="grep -P '(?<=Linux )[0-9.]+' /proc/version")
shell_surfaces(action="run", surface="nu",   command="open data.json | where n > 3 | to json")
shell_surfaces(action="run", surface="msys", command="pacman -Q | wc -l")
shell_surfaces(action="run", surface="pwsh", command="Get-CimInstance Win32_OperatingSystem | Select-Object Caption")
shell_surfaces(action="run", surface="pty",  command="powershell -File install.ps1", send=["y\n"])
```

## PowerShell is a surface here

"Fall back to pwsh" used to mean "leave this tool and use the other one". The
`pwsh` surface closes that gap: a PowerShell command is an ordinary call here,
the same shape as every other surface, so a session that hits an awkward surface
does not have to change its tool to get a PowerShell job done. Background jobs,
timeout promotion, escalation approval and persistent sessions work on it as
well -- they are surface features here, not privileges of one tool.

Both PowerShells are addressable, and that took two entries rather than one. `pwsh`
is PowerShell 7 and is the better default; `powershell` is the 5.1 that ships
with Windows. Keeping them behind a single `DSH_PWSH` variable meant a machine
holding both could reach only one of them, while "does this script still work on
5.1" is a question two surfaces answer and one variable cannot.

The one shape this tool does not carry is a terminal session that keeps a drawn
prompt or a cursor. That is where the built-in `pwsh` tool still earns its place;
"the command is PowerShell" is not a reason to go there.

A surface-level failure is also not a reason to change tools. When a surface is
absent, cannot spawn, or times out, the tool says so and names the next call
(`action="surfaces"`) that stays inside this plugin; the failure is about the
surface, not about the tool.

## Background work stays here too

`run_in_background: true` starts the command as a job and returns its id: the
output ring streams it, `job_output` reads it, `job_kill` stops it. No timeout
applies. `promote_on_timeout: true` turns a timeout into that same job instead of
killing the process -- the output collected before the budget expired is handed
over exactly once, and the rest keeps streaming.

That is why the built-in `pwsh` tool now covers only approval/sandbox escalation
and the persistent session: the job machinery no longer sends a session back to
it. A composition without the `jobs` service gets a refusal sentence for a
background request rather than a job nobody can collect, and the `pty` surface
has no background mode at all, because a console transcript is read while the
program is alive.

## The same sandbox as the built-in shell tools

A confined deployment confines this tool too. Each call resolves the session's
policy through `ctx.sandboxPolicy`, wraps the exact argv it is about to spawn
through `ctx.sandbox.confine`, and reports the mode, enforcement and denial facts
in the same vocabulary the built-in shell tools use. `danger-full-access` never
consults the provider, and a composition without the sandbox services runs
exactly as before.

A file effect the mode denies is a policy answer, not a command failure.
`sandbox_permissions` plus `justification` asks `ctx.approval` for exactly one
wider call -- the grant is consumed by that call and never persisted -- and an
escalation that is refused, cancelled or has no approval channel stops before
anything runs. The same-turn denial hint rides the tool result, so the sanctioned
retry does not depend on recalling the description.

## Persistent sessions

Pass `session: <name>` to run a command inside one long-lived shell per (agent,
surface, name): the current directory, variables and modules persist across
calls, and `session_reset: true` starts a fresh one. The session is a process
with a pipe, not a terminal -- a random nonce line marks where one command's
output ends, which is the only signal every supported shell (`pwsh`, `msys`)
prints without a prompt. A session runs one command at a time, so the job flags
are refused with it, and `pty` has no session at all: a console transcript is
read while the program is alive.

## Finding this machine's shells

The table is a set of defaults, and the scan is what makes them true on a
machine that moved its installs. The model is borrowed from
mega-index-map's `library_detect`: a built-in candidate table (shell names, the
usual install roots, the WSL launcher) resolved against PATH and this machine's
own locations, with every hit carrying where it was found. A scan costs one
PATH listing per directory, a few `stat` calls, one `wsl -l -q`, and one
`command -v` inside each distribution -- it is not a walk of the drive.

What the scan adds to the table:

| Found | Becomes |
|---|---|
| a WSL distribution other than the default | its own `wsl-<distro>` surface |
| a Git-for-Windows or Cygwin bash | a `git-bash` surface (the MSYS2 one keeps `msys`) |
| `cmd.exe` | a `cmd` surface (`cmd /c`) |
| a terminal program (`wt`, `mintty`, `wezterm`, ...) | reported in `action="surfaces"` under `discovered`, not a surface: a terminal draws text, it does not interpret commands |
| a terminal installed inside a distribution (`kitty`, `tmux`, `screen`) | reported with `wsl:<distro>` as its source; the Windows PATH cannot see it |
| `tcsh` or BusyBox in the MSYS2 userland | surfaces of their own: `tcsh` (`-c`) and `busybox` (`sh -c`) |
| `dash` in the MSYS2 userland | a `dash` surface: the strict POSIX sh, where a bash-ism fails instead of being forgiven |
| a shell installed inside a distribution (`elvish`, `ksh`, `xonsh`, `mksh`, `tcsh`, BusyBox) | its own `wsl-<shell>` surface, which runs *that* shell rather than bash |

A shell that lives inside a distribution used to be reachable only by writing
`bash -lc 'elvish -c ...'` by hand -- a wrapper the caller had to quote correctly
every time, for a shell the scan had already found. `wsl-elvish` (and its
siblings) run the shell itself: the command is written to the distribution's
stdin as `exec elvish -c '<command>'`, so the outer bash gets one word it passes
through untouched. `wsl-bash` does not exist on purpose -- `wsl` already is bash.

### The command travels on stdin, not as an argument

`wsl.exe` recomposes the words it was handed into one command line and hands that
line to the distribution, where it is parsed once more. A `$VAR` in an argument
was therefore expanded by a shell that had never run the loop defining it.
Measured 2026-10-20, through this surface:

```
for n in alpha beta; do echo "n=[$n]"; done   ->  n=[] and n=[]   (wanted alpha, beta)
echo 'single=[$HOME]'                         ->  single=[/home/...]  (single quotes lost too)
```

while the same commands on the `msys` surface answered correctly. Base64 behind
`eval` did not help -- that wrapper was re-parsed the same way. The one channel
`wsl.exe` does not rewrite is stdin, so the command now goes there and bash reads
it with `-l -s`. Scripts are unaffected: a file path was always safe.

The distribution probe is bounded: a cold instance that outlasts the budget
reports nothing for that distribution instead of blocking the scan.

`action="surfaces"` answers with both halves: the surfaces this tool can run
now, and the `discovered` report (kind, name, path, source) the scan produced.
A discovered path also replaces a guessed default, so a machine whose
PowerShell lives outside `Program Files` still answers.

`refresh: true` re-runs the scan on a surfaces query, so a shell installed since
start-up appears without a restart. The `surface` argument is an open string for
the same reason: the scan decides the ids, and the executor validates one against
the scan it is holding rather than against a list fixed at registration.

## Interpreters are faces too

`python` and `node` are surfaces of their own rather than something to spell out
inside a `pwsh` call. They pass the same test every shell here passes: they take a
command and answer with stdout and an exit code. Their `kind` is `interpreter`,
and the guide says what makes them different -- the code travels after `-c`
(Python) or `-e` (Node), and a pipeline belongs inside the code rather than
around it.

`rbash` is scanned and reported but given no face: a restricted shell refuses the
first `cd`, `PATH` assignment or redirection, so a surface that looks like bash
and then declines to do bash things would mislead. Shells that are merely not
installed -- `yash`, `posh`, `oksh` -- are already in the candidate table;
install one and the next scan reports it, and promoting it to a face is a
two-line change.

## The list is a tree

`action="surfaces"` draws the table as a tree, because a userland that hosts
several shells is one place with children:

```
- wsl [userland] available
├─ wsl-elvish [shell] available
├─ wsl-ksh [shell] available
└─ wsl-busybox [shell] available
- msys [userland] available
├─ zsh [shell] available
├─ fish [shell] available
└─ dash [shell] available
```

The relation is derived (`family` / `parent` on every row) rather than written
into each entry, so a row added later cannot forget who it hangs under. The same
two fields travel in the structured `surfaces` array, so a client can draw the
same shape instead of parsing the text.

## Why one tool and not seven

Every registered tool spends part of the context on its description. Seven tools
would say the same thing seven times. The selection rules -- which surface for a
structured pipe, which for a Linux-only tool, which for a program that waits for
input -- live in this one description, and a session reads them exactly when it
is choosing.

This tool is the **first choice** for running a command, not a fallback for
"exceptional" cases: a job that needs a Linux tool, a POSIX pipeline, another
shell language, a structured pipe, a real console -- or PowerShell itself --
belongs on its surface. One prompt section says that, placed ahead of the pwsh
rule, because a tool description only speaks once the catalogue is already open.
Wrapping another shell inside a `pwsh` command line stays the thing to avoid: the
extra quoting layer is where paths get mangled.

## The row a call renders as

A `shell_surfaces` call used to render as the wire tool name --
"工具调用 · shell_surfaces · wsl" -- which names the catalogue entry rather than
the machine surface or the command. The plugin now ships a client half
(`lib/client.js`) that registers a `tool.call.toolview` row for this tool, so a
call reads as the sentence it is:

```
WSL · grep -P '(?<=Linux )[0-9.]+' /proc/version      完成 · 120ms
zsh · ls                                            1 · 12ms
conPTY · cmd /c ver                                  运行中
shells · 列出可用 surface                             完成
```

The surface name is at the head, the activity beside it, the exit status at the
end, and the captured output one click away. That is a client concern rather
than a host result: the pending row must already name its surface before any
output exists. Nothing patches a first-party package -- `tool.call.toolview` is
the supported keyed seam, and the stock row remains the fallback for every other
tool.

## Opening a path instead of refusing it

A host that cannot answer is a problem with four shapes, and three of them have a
physical fix -- a piece that runs beside the host rather than an argument that
hopes the host cooperates.

| Shape | Opening | Measured |
| --- | --- | --- |
| a window that keeps its output (Windows Terminal, mintty, Tabby) | the **shim**: the window runs `node scripts/dss-exec.mjs`, the shim runs the command and writes `{exitCode, stdout, stderr}` to a file, and this tool polls that file | `wt` answered `wt-ok` in 53 ms and carried `cmd /c exit 5` back as exit 5; `mintty` answered in 39 ms; both are faces now |
| a program with its own control channel (WezTerm) | the **pane**: `wezterm cli spawn` gives a pane a command, `get-text` reads the screen back | `wezterm-ok` in 225 ms, `ver` in 227 ms |
| a program that refuses everything else on purpose (`git-shell`) | the **channel**: it accepts only git transport, so a `pre-receive` hook in a bare repository runs on push and its output rides back on the push report | `git-shell -c 'echo x'` answers `fatal: unrecognized command` -- the refusal is the design, so the opening is another protocol, not a wrapper |
| a multiplexer (`tmux`, `zellij`, `abduco`) | the **session host**: driven headless (`new-session -d` + `capture-pane`) rather than as a window | `capture-pane` returned `tmux-ok` and `rc=0` from a detached session |

`rbash` and `mshta` are the remaining pair: rbash refuses `cd`, `PATH` changes and
redirection (a plain `bash -c` from a non-restricted shell restores them), and an
HTA host can start the shim like any other launcher.

`action="surfaces"` carries this per program: every discovered terminal comes
back with an `openWith` line, so "reported but not a face" is a next step rather
than a shrug.

## What it is not

* **No message hooks.** It registers a tool, a prompt section and a client row;
  the message stream is not touched, so it cannot be the plugin that writes a
  malformed message.
* **No terminal emulator.** A terminal emulator draws text for a person and adds
  nothing a subprocess can use. The one surface that needs a console talks to
  ConPTY directly.
* **No window launcher.** Windows Terminal, Tabby, mintty, kitty, WezTerm and
  gnome-terminal stay in the scan report and were deliberately given no face.
  Measured 2026-10-24: `wt --help` opens a window and never exits, so the call sat
  here until its 120 s budget expired, and a command launched inside a window
  writes into that window instead of back to the caller. `git-shell` was refused
  for its own reason: it rejects every command that is not a git
  upload/download (`fatal: unrecognized command`). A face that cannot answer is
  worse than a report that says it is not one.

## The facts behind the argument lists

Each of these was measured on this machine, and each shapes the argv:

| Fact | Consequence |
| --- | --- |
| A command handed through a shell can be re-parsed twice | The command travels as **one argv element**; a script **file** is preferred over an inline string |
| `wsl.exe` recomposes its arguments into one command line, which is parsed again inside the distribution | the command travels on **stdin** (`bash -l -s`); as an argument it lost `$VAR` values to a shell that had not defined them, and even single-quoted literals lost their value |
| MSYS2's `/tmp` follows `TMPDIR`, which this machine passes down as a Windows path | msys / zsh / fish run as **login** shells, which normalises the environment |
| brush has no Cygwin runtime beside it, so `/tmp` is `<drive>:\tmp` | brush gets **no** login flag and no POSIX-path assumptions; its PATH needs `usr\bin` as well as `ucrt64\bin`, or every external command fails while the shell reports a healthy version |
| `PtyProcess.read` blocks | Reading happens on its own thread; a read loop that also decides when to stop can block the very check that would stop it |
| A console wants Enter, which is a carriage return | `send` normalises a trailing newline (real, escaped, or literal) to CR, and a bare answer gets one added |
| `wsl.exe` sometimes prints the result and then declines to exit | A timeout **with** output is reported differently from a timeout **without** it; `wsl.exe --shutdown` is the reset (measured: a cold instance answered in 58 s, the same call after a reset in 8 s, and warm in 0.13 s) |
| PowerShell parses what follows `-Command` as a command line, so a script path handed that way is a command, not a file | a script gets `-File`, a command line gets `-Command`; both always run `-NoProfile -NonInteractive` |
| pwsh 7 and Windows PowerShell 5.1 both answer UTF-8 through a pipe (measured 2026-10-15) | the runner's single UTF-8 decode needs no per-surface exception |
| The job registry accepts each chunk through `job.append`, not through a `read` source | the producer pushes bytes as they arrive, and a promoted process flushes what it already produced exactly once |
| `SandboxProvider.confine` wraps argv, not a command line | the surface's exact argv (program, flags, command) is what gets wrapped, so nothing re-parses it |
| An approval grants one call, not a session | a wider mode is consumed by the call that asked; the next call starts from the standing policy |
| A shell reading a pipe prints no prompt | a random nonce line ends each session command's output; the command's own text can never be mistaken for the marker |
| A scan that walks the drive is the thing it must never become | the candidate table is the whole search space: PATH, the usual install roots, and one `wsl -l -q` |

## Layout

| Path | What it is |
| --- | --- |
| `lib/index.js` | the tool: one `shell_surfaces` (run, surfaces, background, promote, sandbox escalation, sessions) and the selection-rule prompt section |
| `lib/sessions.js` | the persistent session pool: one marker-delimited command at a time, per (owner, surface, name) |
| `lib/client.js` | the client half: the `tool.call.toolview` row that renders as `<surface> · <activity>`, in the module system's own bundle format |
| `lib/surfaces.js` | the table: paths, arguments, environments, and the absent-reason for each surface |
| `lib/discover.js` | the scan: shell names, install roots and the WSL listing, each hit with its source |
| `lib/runner.js` | argv construction, bounded output with spill, timeout classification |
| `scripts/pty_runner.py` | the console: pywinpty, a reader thread, ANSI stripping, one JSON report |
| `scripts/live-check.mjs` | runs one real command per surface through the plugin's own code path |
| `scripts/probe-all-shells.ps1` | asks every shell **and** terminal this machine has what it is; platform-shaped, one JSON object out |
| `scripts/probe-posix.sh`, `scripts/probe-wsl.sh` | the POSIX and WSL probes, as files, because an inline command crosses quoting layers and a `$()` gets expanded by the wrong one |
| `scripts/probe-table.mjs` | the probe's JSON as a markdown table, also written to `$GITHUB_STEP_SUMMARY` |
| `scripts/pty-gate.ps1` | the interactive fixture: a `Read-Host` prompt for the pty case |
| `test/surfaces-test.mjs` | the table, the argv shape, the tool contract, the prompt section |
| `test/client-bundle-test.mjs` | the bundle format, the keyed row registration, and the sentence the row says in every call phase |

## Verification

```
node test/surfaces-test.mjs          # no host needed; the host validator is asked too when reachable
node test/client-bundle-test.mjs     # the real client bundle behind a fake module loader
node scripts/live-check.mjs          # one real command per surface on this machine
node scripts/live-check.mjs wsl nu   # or only some of them
pwsh -File scripts/probe-all-shells.ps1 | node scripts/probe-table.mjs   # every shell and terminal
```

CI runs the self-test, and runs the probe on both a Windows and a Linux runner
(the tables land in the run summary, so "which surfaces exist" is a record with
history rather than something a person measured once). Each runner also runs this
live check against every surface it actually has.

That last step reports four outcomes, not two: **pass**, **fail**, **absent** and
**skipped**. A surface a machine does not have is a fact about the machine
(`absent`, with the path that was looked for); a surface that exists but cannot be
exercised here -- a WSL launcher with no distribution, a python without pywinpty --
is also a fact about the machine (`skipped`, with the reason). A surface that ran
and answered wrongly is a fact about the plugin, and only that fails the job,
because a runner with nothing to run is not a broken build.

A pass also needs the expected *output*, not just exit code 0: `bash -c ""` exits
0, and the failures this check exists to catch (a command mangled by quoting,
output decoded as the wrong encoding) are exactly the ones that keep exit code 0.

Its table goes into the run summary beside the probe's, so "this runner is missing
half the surfaces, and here is why" is answerable without opening the log.


Every surface was also run for real (2026-10-15): wsl returned the kernel and a
`/proc` count, nu returned a number through a structured pipeline, msys returned
its bash version and a package count, zsh its parameter-expansion result, fish
its arithmetic result, brush an uppercased string, and pty answered a
`Read-Host` prompt with `y` and printed the branch it took.

## Honest boundaries

* **Windows-first.** The surfaces it knows about are this class of machine's: a
  WSL distro, MSYS2, nushell, and ConPTY. On POSIX the platform already ships a
  single shell, so most of this is unnecessary there.
* No isolation of its own: a command runs with the harness process's rights.
  The file sandbox and approval policy still apply to the process tree.
* MSYS-family output is assumed UTF-8 (`LANG=C.UTF-8` is set). A Windows program
  reached through a surface may still answer in the OEM code page.
* The MSYS2 surfaces need `DSH_MSYS_ROOT` if MSYS2 is not at `D:\msys64`;
  nushell needs `DSH_NU` if `nu.exe` is not in `%LOCALAPPDATA%\Programs\nu\bin`;
  the pty surface needs `python` on PATH with `pywinpty` installed.
* The `pwsh` surface is PowerShell 7 (`pwsh.exe`) by default; a machine with
  only Windows PowerShell sets `DSH_PWSH=powershell.exe`.
* The `pwsh` surface can run in the foreground or as a background job
  (`run_in_background`), and can keep a timeout alive (`promote_on_timeout`).
  Approval/sandbox escalation and the persistent session stay with the built-in
  `pwsh` tool -- that tool is the right one when the machinery is the task.
* Background work and promotion need the `jobs` service. A composition without
  it gets a refusal sentence instead of a job nobody can read, and the `pty`
  surface has no background mode at all: a console transcript has to be read
  while the program is alive.
* The sandbox seam is optional: without `ctx.sandbox` and `ctx.sandboxPolicy`
  nothing is confined, exactly as before. When it is mounted, confinement covers
  every surface, including `wsl` and `msys`; a surface the runner cannot launch
  under confinement reports the sandbox problem rather than running unconfined.
* Sessions exist for the surfaces that can read commands from stdin (`pwsh`,
  `msys`). A surface without one says so and names the surfaces that have it.
  A session is process-local: it does not survive a harness restart, and plugin
  disposal ends every one of them.
* The scan runs once per process; `refresh: true` on a surfaces query re-runs it,
  so a shell installed later appears without a restart.
* Terminal programs are reported, never run: `pty` is the one console this tool
  drives, and `discovered` only says the others exist.
