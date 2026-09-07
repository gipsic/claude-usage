<#
.SYNOPSIS
  Remove the claude-usage scheduled task. Collected data in ~/.claude-usage is
  left alone.
#>
$ErrorActionPreference = 'Stop'
$TaskName = 'claude-usage'
$Data = if ($env:CLAUDE_USAGE_HOME) { $env:CLAUDE_USAGE_HOME } else { Join-Path $HOME '.claude-usage' }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "  Removed scheduled task $TaskName (data in $Data kept)."
} else {
  Write-Host "  No scheduled task named $TaskName."
}
