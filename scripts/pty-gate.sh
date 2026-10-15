#!/bin/sh
# The Unix counterpart of pty-gate.ps1: a question asked on the console.
#
# `read` needs a console to read from, so a pipe cannot answer it -- which is the
# whole point of a pty. Kept as a file, like the other probes, because an inline
# command with a quoted prompt crosses too many layers to survive.
printf 'Proceed with the install? (Y/N) '
read answer
case "$answer" in
  y|Y) echo 'the door opened from this side' ;;
  *)   echo "the door stayed shut: $answer" ;;
esac
