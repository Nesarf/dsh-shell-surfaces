# dsh-shell-surfaces

<img src="assets/dessa-sophia.jpg" alt="Dessa Sophia" width="320">

[![test](https://github.com/Nesarf/dsh-shell-surfaces/actions/workflows/test.yml/badge.svg)](https://github.com/Nesarf/dsh-shell-surfaces/actions/workflows/test.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

`https://github.com/Nesarf/dsh-shell-surfaces` -- a DSH plugin, installed with
`dsh plugin --profile <profile> add github:Nesarf/dsh-shell-surfaces`.

The badge is the whole test workflow: the pure self-test, and a live check that
runs one real command on every surface the runner has -- on Windows and on Linux --
then feeds those answers into the same table a person reads. A green badge means
"the table and the argv shape still hold, and both platforms still answered", not
just "the linter passed".

One DSH tool for the execution surfaces this machine has -- thirty-two faces at
the last measurement: a WSL Linux userland and the ten shells inside it, the MSYS2
userland's six, four interpreters, both PowerShells, four window hosts, a real
console, and nushell.

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
output ends, which is the only signal every supported shell prints without a
prompt.

Ten surfaces carry a session, in three shapes:

* `pwsh`, `msys`, `git-bash`, `zsh` and `tcsh` keep `exe` + a flag list
  (`-Command -` / `-l -s` / `-s`), which is the default shape.
* `dash`, `brush` and `busybox` have no login flag to give (dash is the strict
  POSIX sh by design, brush has no mount table, and BusyBox is ash), so their
  session is `-s` under the PATH the table sets -- `busybox sh -s` for the last.
* `wsl` needs the **distribution on its command line** (`wsl.exe -d Nyarch --
  bash -l -s`), so its entry builds the argv itself through `argvFor`. Measured
  2026-10-24: `cd /tmp && export DSS_PROBE=41` then `echo "$DSS_PROBE:$(pwd)"`
  answered `41:/tmp` -- the directory and the variable both survived.

`fish` needed a different shape rather than a refusal. It treats a piped stdin as
a script **file** and waits for EOF before running any of it -- measured
2026-10-24, with `-l` and with `-l -i` alike, a session that writes one command at
a time got silence. The opening is to keep stdin away from the script parser: the
session argv runs fish's own line reader, `while read -l dss_line; eval
$dss_line; end`, so each line is evaluated on its own. Measured: `cd /tmp` and
`set -x DSS_X 41` survived into the next call as `X=41;P=/tmp`.

A session is a real process, and three things close one: the sweep before each
session call (`reapIdleSessions`, thirty minutes of idle by default,
`DSH_SESSION_IDLE_MS` to change it), a timer that sweeps the same budget on its
own clock so a shell nobody returns to is still noticed, and the disposal of the
conversation that owned it -- `session/disposed` closes the shells of every agent
that named that session. Plugin unload closes whatever is left. A call that closed
something says so in its message, because the next call to that shell starting
fresh is otherwise a surprise.

A derived `wsl-<shell>` face deliberately has **no** session: the session's argv
is `bash -l -s`, so a session there would quietly run bash while the row claims
elvish or ysh. A session runs one command at a time, so the job flags are refused
with it, and `pty` has no session at all: a console transcript is read while the
program is alive.

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
| a terminal program that can be driven (`wt`, `mintty`, `wezterm`, `tabby`) | a face of its own -- through the `dss-exec` shim for the first two, its own pane API for WezTerm, a private profile for Tabby (see "Opening a path instead of refusing it") |
| a terminal program with no such entry (`alacritty`, `conhost`, kitty without a GUI session) | reported in `discovered` with an `openWith` line saying how it could be reached, if at all |
| a terminal installed inside a distribution (`kitty`, `tmux`, `screen`) | reported with `wsl:<distro>` as its source; the Windows PATH cannot see it |
| `tcsh` or BusyBox in the MSYS2 userland | surfaces of their own: `tcsh` (`-c`) and `busybox` (`sh -c`) |
| `dash` in the MSYS2 userland | a `dash` surface: the strict POSIX sh, where a bash-ism fails instead of being forgiven |
| a shell installed inside a distribution (`elvish`, `ksh`, `xonsh`, `mksh`, `tcsh`, BusyBox) | its own `wsl-<shell>` surface, which runs *that* shell rather than bash |
| `oils-for-unix` in a distribution | two faces, `wsl-osh` and `wsl-ysh`: the bash-compatible half and the strict half that rejects what bash forgives |

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

`python`, `node` and `perl` are surfaces of their own rather than something to
spell out inside a `pwsh` call. They pass the same test every shell here passes:
they take a command and answer with stdout and an exit code. Their `kind` is
`interpreter`, and the guide says what makes them different -- the code travels
after `-c` (Python), `-e` (Node), or `-e` (Perl), and a pipeline belongs inside
the code rather than around it.

Perl gets one environment entry of its own: `PERL_BADLANG=0`. Measured on this
machine, a Perl run under the UTF-8 request warns about a locale it cannot honour
before printing anything, and that warning arrives on stderr on every single call.
The variable silences exactly that warning and changes nothing else.

`cscript` is the one interpreter whose input is a **file**: `cscript //nologo`
takes a `.vbs` path and has no `-c`. That is what `inlineFile` exists for -- the
command is written to a temporary `.vbs` in the spill directory, cscript runs it,
and the file is removed the moment the run settles. Measured: the code never
appears in argv, and the spill directory does not grow across calls.

## An ssh destination is a surface

The host list comes from the user's own `~/.ssh/config`, and `ssh <host>
<command>` is already the "flags then command" argv shape every shell surface
uses, so an ssh destination needs no new machinery: each host becomes an
`ssh-<host>` face whose flags end with the host and whose command is the last
argument.

Two kinds of entry are dropped on purpose, because a face that fails on every
call is worse than no face:

* a host with `User git` -- that speaks the git protocol, not a shell, and the far
  side refuses anything else. This machine's config carries `github.com` with
  `User git`, and it is dropped for exactly that reason.
* a wildcard (`Host *.internal`) -- that is a pattern for matching, not a
  destination that can be dialled.

`BatchMode=yes` is not a preference. Without it a host that wants a password sits
at a prompt nobody can type into, and the call reads as hung; with it, that host
fails at once and says so.

`StrictHostKeyChecking=accept-new` is the other half of that argument. A host seen
for the first time is recorded; a host whose key has **changed** is still refused.
Without it the first call to any new destination dies with "Host key verification
failed", which reads as a broken face rather than as an unrecorded host -- measured
2026-10-24 by clearing the entry from `known_hosts` and calling the surface.

When ssh cannot get as far as the command it answers 255, and the result carries a
note saying so: an unreachable host, a refused key or a changed host key is a
surface-level problem, not a failed command. Measured 2026-10-24 by stopping the
daemon and calling the surface (`exit=255`, `Connection refused`, note present);
with the daemon up the same call answers and the note is absent.

### Standing up a loopback destination, so the face can be tested at all

This machine's ssh family was empty -- its only config entry is git-only -- and a
face nobody can call is a claim, not a capability. Nothing here needs a second
machine. Measured on this one (2026-10-24) with the distribution's own openssh
10.3p1:

```
# inside the distribution, as root
ssh-keygen -A                         # this image had no host keys at all
mkdir -p /run/sshd
/usr/sbin/sshd -p 2222 -o ListenAddress=127.0.0.1 \
               -o PubkeyAuthentication=yes -o PasswordAuthentication=no
```

then one dedicated keypair on the Windows side, its public half in the
distribution user's `~/.ssh/authorized_keys` (700 / 600), and this in
`~/.ssh/config`:

```
Host dss-loopback
  HostName 127.0.0.1
  Port 2222
  User nyarch
  IdentityFile ~/.ssh/id_ed25519_loopback
  IdentitiesOnly yes
```

`action="surfaces"` then reports `ssh-dss-loopback [remote]`, and a command
through it answers in 367 ms. The daemon binds loopback only and accepts keys only.

It can outlive a distribution restart, which is worth doing: a face that disappears
on reboot fails the first time anyone needs it. The image runs systemd
(`/etc/wsl.conf` sets `systemd=true`) and `sshd_config` already includes
`/etc/ssh/sshd_config.d/`, so `systemctl enable --now sshd` is enough -- the
drop-in above supplies the port and the key-only policy. Measured 2026-10-24 by
`wsl --shutdown` and waking the distribution again: 15 s cold start, then
`ssh-after-restart` with `up 0 minute`, `active`, `enabled`.

A trap worth writing down: generating that key with `-N '""'` in PowerShell makes
the two quote characters the passphrase. The symptom is not "wrong passphrase" --
the server says `Server accepts key` and then the client never sends the signature
(`we did not send a packet`), because BatchMode cannot ask. `ssh-keygen -y -P ''`
is the check: it prints the public key when there is none.

`rbash` is scanned and reported but given no face: a restricted shell refuses the
first `cd`, `PATH` assignment or redirection, so a surface that looks like bash
and then declines to do bash things would mislead. Shells that are merely not
installed -- `yash`, `posh`, `oksh` -- are already in the candidate table;
install one and the next scan reports it, and promoting it to a face is a
two-line change.

## A container is a face too

Every container runtime the scan finds inside a distribution gets one:
`<runtime> run --rm <image> sh -c '<command>'`, handed over on stdin the same way a
derived shell's command is. It is deliberately throwaway -- a face is one command,
not a session -- so nothing persists between calls; when state matters, `wsl` is
the surface to use. A machine with neither runtime reports neither face.

Both runtimes are present on this machine (2026-10-24) and they are not
interchangeable: `podman` is rootless, `docker` is not. `DSH_PODMAN_IMAGE` and
`DSH_DOCKER_IMAGE` (or one `DSH_CONTAINER_IMAGE`) pick the image, default
`docker.io/library/alpine:latest`, pulled on the first call.

Getting them to run took four unrelated fixes, none of them the runtimes' fault:

* `libphonenumber` pinned an older protobuf than podman wanted. Upgrading the two
  together resolved it -- the repository's current `libphonenumber` already
  depends on the new protobuf.
* the pacman keyring was a 32-byte empty `pubring.kbx`, and every install failed
  with `keyring is not writable`. `pacman-key --init` plus `--populate archlinux`
  rebuilt it with 180 keys. Note that `pkill -f gpg-agent` is the wrong way to
  quiet the agent: the pattern matches the shell running it, which kills the
  command itself. The keyring went bad **again** after `wsl --shutdown`, so the
  rebuild is a thing to expect rather than a one-off.
* rootless podman needs `libsubid.so.6`, which the installed `shadow` (4.18.0) did
  not provide; that package was upgraded for it. With subuid/subgid already in
  place the container ran first try: `container-face-ok` and `ID=alpine` in 2.6 s.
* docker could not pull: `dockerd` uses the distribution's own network stack and
  the registry resolved to an IPv6 address that does not answer here
  (`dial tcp [2a03:2880:...]:443: i/o timeout`). The image came over from podman
  instead -- `podman save docker.io/library/alpine:latest | docker load` -- and
  `docker run --rm alpine:latest` then answered `docker-ok`. Adding the daemon to
  the `docker` group is what lets the surface reach the socket at all.

### A container that is already running is a face of its own

`<runtime> exec <name> sh -c '<command>'`, derived from `docker ps` / `podman ps` in
the same scan, so the face exists exactly while its container does. It needs a shell
inside the image -- a scratch image has none, and the call says so rather than
pretending.

The difference is measured, not asserted (2026-10-24, writing a file through both
doors and reading it on the next call):

| face | write | read on the next call |
| --- | --- | --- |
| `docker-dss-docker` -- `exec` into a running container | `kept` | `kept` |
| `docker` -- one-shot `run --rm` | `kept` | `marker-gone` |

Getting the container list cost one lesson: the scan script goes on **stdin**, not
as an argument. With it as an argument the list came back empty while `docker ps`
answered fine by hand -- `wsl.exe` recomposes what it is handed and parses it again
inside the distribution, which is the same trap the `wsl` surface's own commands hit.

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

The client does exactly that: opening a listing renders **one element per line**,
with the box-drawing characters kept in the text (they survive a copy, and a reader
of the raw output still sees the hierarchy) and each line marked as a root, a
child, or a `when:` note. The styling is what makes a child read as someone's
child rather than as a sibling that happens to be indented. Every other call still
opens as captured output -- a hierarchy and a log want different shapes.

## Why one tool and not seven

Every registered tool spends part of the context on its description. Thirty-two
tools would say the same thing thirty-two times. The selection rules -- which surface for a
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
shells · 32 of 32 surfaces are on this machine       完成
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
| a window that keeps its output (Windows Terminal, mintty) | the **shim**: the window runs `node scripts/dss-exec.mjs`, the shim runs the command and writes `{exitCode, stdout, stderr}` to a file, and this tool polls that file | `wt` answered `wt-ok` in 53 ms and carried `cmd /c exit 5` back as exit 5; `mintty` answered in 39 ms; both are faces now |
| a program with its own control channel (WezTerm) | the **pane**: `wezterm cli spawn` gives a pane a command, `get-text` reads the screen back | `wezterm-ok` in 225 ms, `ver` in 227 ms |
| a program that refuses everything else on purpose (`git-shell`) | the **channel**: it accepts only git transport, so a `pre-receive` hook in a bare repository runs on push and its output rides back on the push report | `git-shell -c 'echo x'` answers `fatal: unrecognized command` -- the refusal is the design, so the opening is another protocol, not a wrapper |
| a multiplexer (`tmux`, `zellij`, `abduco`) | the **session host**: driven headless (`new-session -d` + `capture-pane`) rather than as a window | `capture-pane` returned `tmux-ok` and `rc=0` from a detached session |

Two more openings, both measured 2026-10-24:

* `rbash` refuses `cd`, `PATH` changes and redirection (`rbash -c 'cd /tmp'` answers
  `cd: restricted`), and a plain `bash -c` from a non-restricted shell restores all
  three -- the opening is a second shell, not a flag.
* `mshta` starts the shim like any other launcher: an HTA page whose
  `WScript.Shell.Run(..., 0, True)` runs `dss-exec.mjs` with the child window hidden.
  Measured: the report came back with `mshta-ok` in 316 ms and mshta itself exited in
  1.3 s -- it does not hang the caller the way `wt --help` did. (`node` still has to
  be on PATH; an HTA has no shell to inherit one from.)

**Tabby needed a different opening.** It takes Electron switches only -- no `-e`,
no `new-tab -- <program>` -- but it does have `tabby profile <name>`, and a local
profile carries `options.command` + `options.args`. Those are static, so the
profile names a fixed agent (`scripts/dss-tabby-agent.mjs`) once and every call
only rewrites the job file that agent reads. `scripts/tabby-setup.mjs` writes that
profile **into a private instance's own config** (`--user-data-dir`), never into
the user's: `handleOpenProfile` calls `bringToFront()` on every open, so driving
someone's Tabby would yank their window forward on every call.

Two measured traps shaped it:

* a bare `command: node` does not work -- Tabby starts the profile and the agent
  never runs, so the profile names the interpreter by absolute path;
* `cmd /c start /min` is not a way to keep the window out of the way: `start`
  takes the quoted program path as its window TITLE and then tries to launch the
  next word as a file, which produced a "Windows cannot find 'profile'" dialog and
  hung the caller. The window is minimised after the fact instead, and **after the
  answer arrives**, because `bringToFront()` un-minimises it while the profile
  opens.

`Tabby.exe profile dss` itself never returns (it blocks for the application's
lifetime), so the launch is detached and the result file is the only thing waited
on. Measured: the agent answers in about 45 ms, and the whole call -- including
minimising the window -- finishes in about 4 s once the instance is warm.

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
* **No window launcher that cannot answer.** Windows Terminal and mintty are
  driven through the `dss-exec` shim, WezTerm through its own pane API, and Tabby
  through a private profile; each returns a structured result rather than a
  window's contents. A terminal program with no such entry stays a scan report,
  and the report says which entry it would need: `wt --help` measured as a window
  that never exits, and kitty needs a GUI session this machine cannot give it.
  `git-shell` was refused for its own reason: it rejects every command that is not
  a git upload/download (`fatal: unrecognized command`). A face that cannot answer
  is worse than a report that says so.

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
| `scripts/probe-faces.mjs` | reads the surface TABLE and asks every present face what it is; a face added to the table is covered without being added here too |
| `scripts/probe-all-shells.ps1` | a version census for the terminals and the long-standing shells, from a hand-written list; platform-shaped, one JSON object out |
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
DSH_LIVE_TERMINALS=1 node scripts/live-check.mjs wt mintty wezterm tabby   # the window faces, which open windows
node scripts/probe-faces.mjs | node scripts/probe-table.mjs   # every surface in the table
pwsh -File scripts/probe-all-shells.ps1 | node scripts/probe-table.mjs   # terminals + the long-standing shells
```

**`live-check.mjs` is the probe now.** With `LIVE_CHECK_JSON=1` it writes the JSON
`probe-table.mjs` eats to stdout and its human-readable lines to stderr, so one run
answers both "is this surface alive" and "what version is it". CI uses that form;
the plain form is what a person runs.

`probe-faces.mjs` came first and does the census without asserting anything: it
reads the table and asks every present face what it is. It stays for a quick "what
is on this machine right now" that cannot fail a build.

`probe-all-shells.ps1` stays for what the table cannot answer: the **terminal
programs without a face** (alacritty, conhost, kitty here) still have no entry, and
a version census is where their presence is recorded.

The live check covers the interpreters and the shells inside a distribution as
well, and it opts **out** of the window faces by default: a routine run should
not put four windows on someone's screen, so `wt`, `mintty`, `wezterm` and `tabby`
are exercised only when `DSH_LIVE_TERMINALS=1` or when named on the command line.
Measured on this machine: the default set is twenty-six surfaces (twenty-five
answering, one skipped because its nushell cannot run on that distribution's
glibc), and the four window faces answer `wt-ok` / `mintty-ok` / `wezterm-ok` /
`tabby-ok` in 0.34 to 1.05 s once their instance is warm (tabby's first call pays
for a cold start).

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


The first full pass (2026-10-15) ran every surface the table had then: wsl returned
the kernel and a `/proc` count, nu returned a number through a structured pipeline,
msys returned its bash version and a package count, zsh its parameter-expansion
result, fish its arithmetic result, brush an uppercased string, and pty answered a
`Read-Host` prompt with `y` and printed the branch it took. That list has since
grown to thirty-two faces -- which is exactly why the live check reads the table
instead of keeping a list of its own.

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
* The `pwsh` surface can run in the foreground, as a background job
  (`run_in_background`), or promoted past its timeout (`promote_on_timeout`), and
  it carries escalation approval and a persistent session as well. The built-in
  `pwsh` tool keeps exactly one shape this one does not: a terminal session that
  keeps a drawn prompt or a cursor.
* Background work and promotion need the `jobs` service. A composition without
  it gets a refusal sentence instead of a job nobody can read, and the `pty`
  surface has no background mode at all: a console transcript has to be read
  while the program is alive.
* The sandbox seam is optional: without `ctx.sandbox` and `ctx.sandboxPolicy`
  nothing is confined, exactly as before. When it is mounted, confinement covers
  every surface, including `wsl` and `msys`; a surface the runner cannot launch
  under confinement reports the sandbox problem rather than running unconfined.
* Sessions exist for ten surfaces -- the shells that can read commands from stdin,
  which is every shell here except `pty` and the four window hosts. A derived
  `wsl-<shell>` face has none on purpose (a session there would run bash while the
  row claims elvish), and a surface without one says so and names the ones that
  have it. A session is process-local: it does not survive a harness restart.
* The scan runs once per process; `refresh: true` on a surfaces query re-runs it,
  so a shell installed later appears without a restart.
* Of the terminal programs this machine has, four are faces (`wt`, `mintty`,
  `wezterm`, `tabby`) and the rest stay reports. `pty` remains the one real
  console, and the one shape no window face carries.
