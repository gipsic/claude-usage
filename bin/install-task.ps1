<#
.SYNOPSIS
  Install claude-usage as a per-user scheduled task: starts at logon, restarts if
  it dies, and keeps tracking in the background whether or not a browser is open.
  The Windows counterpart of bin/install-daemon.sh (launchd) and
  bin/install-systemd.sh (systemd --user).

.NOTES
  Three Task Scheduler defaults would quietly stop the tracker on a laptop:
  DisallowStartIfOnBatteries, StopIfGoingOnBatteries and StartWhenAvailable.
  They are set here and then READ BACK - a task that silently kept the defaults
  looks installed and simply never runs on battery.
#>
[CmdletBinding()]
param(
  [int]$Port = 4778,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$TaskName = 'claude-usage'
$Root     = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Data     = if ($env:CLAUDE_USAGE_HOME) { $env:CLAUDE_USAGE_HOME } else { Join-Path $HOME '.claude-usage' }
$Vbs      = Join-Path $Root 'bin\run-hidden.vbs'
$Main     = Join-Path $Root 'src\main.mjs'

function Fail($msg) { Write-Host "install-task: $msg" -ForegroundColor Red; exit 1 }

# --- refuse the two installs that cannot work -------------------------------
# An MSIX-packaged app writes into a virtualised copy of AppData: the task would
# be registered against a path that does not exist outside the package sandbox.
if ($Root -like '*\AppData\Local\Packages\*') {
  Fail @"
claude-usage is inside an MSIX-virtualised path:

  $Root

A scheduled task cannot run from there - the path only exists inside the app
container. Install it somewhere real first, for example:

  npm install -g @gipsic/claude-usage      (with Node from nodejs.org)
"@
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail 'node was not found on PATH. Install Node.js 22+ from https://nodejs.org and re-run.' }

# Claude Desktop ships its own Node. It is not on PATH by design, and pinning a
# task to it would break the moment the app updates itself.
if ($node -match '\\AnthropicClaude\\' -or $node -match '\\Claude\\app-[\d.]+\\') {
  Fail "the node found on PATH is the one bundled inside Claude Desktop ($node). Install Node.js 22+ from https://nodejs.org."
}

# `node --version`, not `node -p '...'`: PowerShell rewrites the quoting of
# arguments to native commands, and the inner quotes of a JS expression do not
# survive the trip.
$ver = (& $node --version) -replace '^v', ''
$major = [int]($ver.Split('.')[0])
if ($major -lt 22) { Fail "node $ver is too old; claude-usage needs 22 or newer." }

if (-not (Test-Path $Main)) { Fail "src\main.mjs not found under $Root" }
New-Item -ItemType Directory -Force -Path (Join-Path $Data 'logs') | Out-Null

# --- the task ----------------------------------------------------------------
# wscript runs the VBS with no console window; a bare node action would flash one
# at every logon.
$argument = '"{0}" "{1}" "{2}" serve --port {3}' -f $Vbs, $node, $Main, $Port
$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//nologo $argument" -WorkingDirectory $Root
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

if ($DryRun) {
  Write-Host ''
  Write-Host "  Would register $TaskName"
  Write-Host "    node        $node"
  Write-Host "    action      wscript.exe //nologo $argument"
  Write-Host "    at logon    $env:USERNAME"
  Write-Host "    data        $Data"
  Write-Host ''
  exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'claude-usage - Claude Code usage and limit tracker (https://github.com/gipsic/claude-usage)' | Out-Null

# Register-ScheduledTask has been known to normalise the battery flags back to
# their defaults, so set them again and then check what the scheduler actually
# stored. Reading it back is the only honest confirmation.
Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null
$stored = (Get-ScheduledTask -TaskName $TaskName).Settings
$battery = @()
if ($stored.DisallowStartIfOnBatteries) { $battery += 'DisallowStartIfOnBatteries is still ON' }
if ($stored.StopIfGoingOnBatteries)     { $battery += 'StopIfGoingOnBatteries is still ON' }
if (-not $stored.StartWhenAvailable)    { $battery += 'StartWhenAvailable is still OFF' }

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
try {
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:$Port/api/health" | Out-Null
  $state = 'running'
} catch {
  $state = "not responding yet - check $Data\logs\ and: Get-ScheduledTaskInfo -TaskName $TaskName"
}

Write-Host ''
Write-Host "  Installed scheduled task $TaskName"
Write-Host ''
Write-Host "    dashboard   http://127.0.0.1:$Port"
Write-Host "    status      $state"
Write-Host "    node        $node"
Write-Host "    data        $Data"
if ($battery.Count) {
  Write-Host ''
  Write-Host '    On battery, Windows kept its own defaults:' -ForegroundColor Yellow
  foreach ($b in $battery) { Write-Host "      $b" -ForegroundColor Yellow }
  Write-Host '      Fix it in Task Scheduler -> claude-usage -> Conditions.' -ForegroundColor Yellow
} else {
  Write-Host "    on battery  starts and keeps running"
}
Write-Host ''
Write-Host '  It starts automatically at logon and restarts if it exits.'
Write-Host '  Stop it with:  claude-usage uninstall-daemon'
Write-Host ''
