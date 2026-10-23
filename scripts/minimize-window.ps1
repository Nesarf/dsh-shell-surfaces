param(
  # Exactly one target: a PID when this tool spawned the process itself, or a
  # command-line substring when it spawned a launcher that handed the work to an
  # instance which was already running (Tabby).
  [int]$ProcessId = 0,
  [string]$Match = '',
  [int]$TimeoutSeconds = 25
)

# Minimise the window a surface opened, and only that one.
#
# Why this exists: none of these programs has a "start minimised" flag, and
# `cmd /c start /min` is not a substitute -- `start` swallows the quoted program
# path as its window TITLE and then tries to launch the next word as a file
# (measured 2026-10-24: it produced a "Windows cannot find 'profile'" dialog and
# hung the caller). ShowWindow is the direct answer.

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class DssMinimize {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
'@ -ErrorAction SilentlyContinue

if ($ProcessId -le 0 -and [string]::IsNullOrWhiteSpace($Match)) { return }

function Try-Minimise([System.Diagnostics.Process]$process) {
  if ($null -eq $process) { return $false }
  if ($process.MainWindowHandle -eq 0) { return $false }
  if ([DssMinimize]::IsIconic($process.MainWindowHandle)) { return $true }
  [DssMinimize]::ShowWindow($process.MainWindowHandle, 6) | Out-Null   # 6 = SW_MINIMIZE
  return $true
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  if ($ProcessId -gt 0) {
    $direct = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (Try-Minimise $direct) { return }
  }
  if (-not [string]::IsNullOrWhiteSpace($Match)) {
    $candidates = Get-CimInstance Win32_Process -Filter "Name = 'Tabby.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $null -ne $_.CommandLine -and $_.CommandLine.Contains($Match) }
    foreach ($candidate in $candidates) {
      $process = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
      if (Try-Minimise $process) { return }
    }
  }
  Start-Sleep -Milliseconds 300
}
