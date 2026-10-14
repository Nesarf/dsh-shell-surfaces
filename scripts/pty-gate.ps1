# A fixture for the pty case in live-check.mjs: a question asked on the console.
# Read-Host needs a real console, so a pipe cannot answer it -- which is exactly
# what the pty surface exists to provide.
# ASCII only on purpose: a .ps1 read by Windows PowerShell is decoded with the
# code page, and a non-ASCII comment is enough to break the file.
# Callers pass -ExecutionPolicy Bypass: a local .ps1 is otherwise refused by the
# default policy ("not digitally signed"), which looks like a broken pty surface.
$answer = Read-Host 'Proceed with the install? (Y/N)'
if ($answer -eq 'y') { Write-Output 'the door opened from this side' }
else { Write-Output "the door stayed shut: $answer" }
