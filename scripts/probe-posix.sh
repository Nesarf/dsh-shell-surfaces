#!/bin/sh
# The POSIX probe, as a file.
#
# Same lesson as probe-wsl.sh: an inline command crossing PowerShell's own
# parsing, a job's process boundary and then bash arrives with its $() already
# expanded -- measured here as "/bin/bash: -c: line 1: syntax error near
# unexpected token `('" when git-bash was asked `echo $BASH_VERSION $(uname -o)`
# from a pwsh probe. A file has no quoting layers at all.
printf '%s\n' "bash ${BASH_VERSION:-none}"
printf '%s\n' "sh $(uname -o 2>/dev/null || echo unknown)"
printf '%s\n' "uname $(uname -sr 2>/dev/null || echo unknown)"
if command -v ls >/dev/null 2>&1; then printf '%s\n' "coreutils $(ls --version 2>/dev/null | head -1)"; fi
if printf 'x\n' | grep -P 'x' >/dev/null 2>&1; then printf '%s\n' 'grep -P works'; else printf '%s\n' 'grep -P missing'; fi
