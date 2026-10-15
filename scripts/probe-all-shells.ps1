# Every shell / userland this machine has, plus every terminal it can draw in.
#
# Part one asks each execution surface one question -- what are you? -- in its own
# job with a timeout, because two of these are known to be slow or brittle here:
# a cold WSL instance takes 35-60 s, and an MSYS shell started without -l
# disagrees with its neighbours about /tmp. A timeout is reported as a timeout,
# never as a failure of the shell.
#
# Part two lists the terminals. A terminal emulator is not an execution surface --
# it draws text for a person and gives a subprocess nothing -- but "every shell
# and terminal on this machine" includes them, and the file version is a cheaper
# and more honest answer than a GUI program's --version flag (Tabby takes 9 s to
# answer that one, and it briefly starts an Electron app to do it).
#
# Four mistakes this script already made, kept as comments so it does not make
# them again:
#   * `@args` is NOT a safe splat name -- `$args` is automatic, so `@args`
#     silently expanded to nothing and every shell was asked an empty question;
#   * `Test-Path wsl.exe` answers false for a command on PATH that is a reparse
#     point (measured); bare command names go through Get-Command;
#   * nushell refuses to run when stdin is not a TTY unless it is told to read a
#     script, so it needs --no-config-file and a -c;
#   * the terminal block was first written AFTER the JSON that referenced it, so
#     it serialised an empty array. Order is part of correctness.

$ErrorActionPreference = 'Continue'

$cases = @(
  @{ n = 'cmd.exe';        exe = 'C:\Windows\System32\cmd.exe';                    a = @('/c', 'ver') }
  @{ n = 'powershell 5.1'; exe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'; a = @('-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()') }
  @{ n = 'pwsh 7';         exe = 'C:\Program Files\PowerShell\7\pwsh.exe';         a = @('-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()') }
  @{ n = 'git-bash';       exe = 'C:\Program Files\Git\bin\bash.exe';              a = @('-lc', 'echo $BASH_VERSION $(uname -o)') }
  @{ n = 'git-bash sh';    exe = 'C:\Program Files\Git\usr\bin\sh.exe';            a = @('-lc', 'echo sh-ok $(uname -o)') }
  @{ n = 'git-bash dash';  exe = 'C:\Program Files\Git\usr\bin\dash.exe';          a = @('-c', 'echo dash-ok') }
  @{ n = 'MSYS2 bash';     exe = 'D:\msys64\usr\bin\bash.exe';                     a = @('-lc', 'echo $BASH_VERSION $MSYSTEM') }
  @{ n = 'MSYS2 zsh';      exe = 'D:\msys64\usr\bin\zsh.exe';                      a = @('-lc', 'echo $ZSH_VERSION') }
  @{ n = 'MSYS2 fish';     exe = 'D:\msys64\usr\bin\fish.exe';                     a = @('-l', '-c', 'echo $version') }
  @{ n = 'brush';          exe = 'D:\msys64\ucrt64\bin\brush.exe';                 a = @('-c', 'echo $BASH_VERSION') }
  @{ n = 'nushell';        exe = "$env:LOCALAPPDATA\Programs\nu\bin\nu.exe";       a = @('--no-config-file', '-c', 'version | get version') }
  @{ n = 'WSL probe (file)'; exe = 'wsl.exe';                                      a = @('-d', 'Nyarch', '--', 'bash', '/mnt/e/dsh-home/plugins/dsh-shell-surfaces/scripts/probe-wsl.sh') }
)

$results = foreach ($case in $cases) {
  $job = Start-Job -ScriptBlock {
    param($exe, $argv, $name)
    $isBare = $exe -notmatch '[\\/]'
    if ($isBare -and -not (Get-Command $exe -ErrorAction SilentlyContinue)) {
      return [pscustomobject]@{ ms = 0; out = "not on PATH: $exe" }
    }
    if (-not $isBare -and -not (Test-Path $exe)) {
      return [pscustomobject]@{ ms = 0; out = "not found: $exe" }
    }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
      $out = & $exe @argv 2>&1 | Out-String
      [pscustomobject]@{ ms = $sw.ElapsedMilliseconds; out = ($out -replace '\s+', ' ').Trim() }
    } catch {
      [pscustomobject]@{ ms = $sw.ElapsedMilliseconds; out = "ERROR: $($_.Exception.Message)" }
    }
  } -ArgumentList $case.exe, $case.a, $case.n

  $done = Wait-Job $job -Timeout 90
  if ($done) {
    $r = Receive-Job $job
    [pscustomobject]@{ shell = $case.n; ms = $r.ms; answer = if ($r.out) { $r.out } else { '(empty output)' } }
  } else {
    Stop-Job $job
    [pscustomobject]@{ shell = $case.n; ms = 90000; answer = 'TIMED OUT after 90 s' }
  }
  Remove-Job $job -Force
}

$terminals = @(
  @{ n = 'Windows Terminal'; p = "$env:LOCALAPPDATA\Microsoft\WindowsApps\wt.exe" }
  @{ n = 'WezTerm';          p = 'D:\DaShaoHuo\apps\WezTerm\wezterm.exe' }
  @{ n = 'wezterm-gui';      p = 'D:\DaShaoHuo\apps\WezTerm\wezterm-gui.exe' }
  @{ n = 'Tabby';            p = 'C:\Program Files\Tabby\Tabby.exe' }
  @{ n = 'mintty';           p = 'C:\Program Files\Git\usr\bin\mintty.exe' }
  @{ n = 'conhost';          p = 'C:\Windows\System32\conhost.exe' }
)

$terminalResults = foreach ($t in $terminals) {
  $item = Get-Item -LiteralPath $t.p -Force -ErrorAction SilentlyContinue
  if ($item -and $item.VersionInfo.FileVersion) {
    [pscustomobject]@{ terminal = $t.n; version = $item.VersionInfo.FileVersion; path = $item.FullName }
    continue
  }
  # Two shapes a file version does not cover. Windows Terminal's entry point is an
  # Appx execution alias, so the package carries the version. WezTerm's launcher
  # carries none, while its gui twin does -- so the honest label is "from the gui".
  $appx = Get-AppxPackage -Name 'Microsoft.WindowsTerminal' -ErrorAction SilentlyContinue
  if ($t.n -eq 'Windows Terminal' -and $appx) {
    [pscustomobject]@{ terminal = $t.n; version = $appx.Version; path = 'Appx package (wt.exe is an execution alias)' }
    continue
  }
  if ($t.n -eq 'WezTerm') {
    $gui = Get-Item -LiteralPath 'D:\DaShaoHuo\apps\WezTerm\wezterm-gui.exe' -Force -ErrorAction SilentlyContinue
    if ($gui -and $gui.VersionInfo.FileVersion) {
      [pscustomobject]@{ terminal = $t.n; version = "$($gui.VersionInfo.FileVersion) (from wezterm-gui.exe)"; path = $item.FullName }
      continue
    }
  }
  [pscustomobject]@{ terminal = $t.n; version = if ($item) { 'no file version' } else { 'not installed' }; path = $t.p }
}

@{
  shells = @($results)
  terminals = @($terminalResults)
} | ConvertTo-Json -Depth 4 -Compress
