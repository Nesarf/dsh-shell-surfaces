#!/bin/sh
# A probe for the WSL userland, written as a file on purpose: an inline command
# crosses four quoting layers here (pwsh -> Start-Job -> wsl.exe -> bash) and a
# `$(...)` inside it gets expanded by the wrong layer. A file has no quoting.
printf 'bash %s | %s\n' "$BASH_VERSION" "$(uname -sr)"
zsh --version 2>/dev/null || printf 'zsh: no --version\n'
printf 'sh %s\n' "$(uname -o)"
printf 'coreutils %s\n' "$(ls --version 2>/dev/null | head -1)"
printf 'grep -P %s\n' "$(grep -c . /proc/version >/dev/null 2>&1 && echo works || echo missing)"
printf 'packages %s\n' "$(pacman -Q 2>/dev/null | wc -l)"
