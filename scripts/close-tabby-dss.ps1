# close-tabby-dss.ps1 -- close the Tabby instance dss opened, and only that one.
#
# The tab a dss call runs in belongs to the private instance
# (`--user-data-dir=...\tabby-dss`), and Tabby keeps a tab whose process has exited:
# the agent finishes, writes its result, and the window stays open. Closing it by hand
# on every call was the alternative, reported 2026-11-01.
#
# Two rules this file follows:
#   * matched by `user-data-dir`, never by image name -- a Tabby the person opened
#     themselves is a different instance and must not be touched;
#   * delayed, because the caller is still reading the result file when the agent
#     exits. Two seconds is enough and short enough not to feel like a stray window.

Start-Sleep -Seconds 2

$private = Get-CimInstance Win32_Process -Filter "Name = 'Tabby.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $null -ne $_.CommandLine -and $_.CommandLine.Contains('tabby-dss') }

foreach ($proc in $private) {
    try {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    } catch {
        # A process that is already gone is the outcome wanted here.
    }
}
