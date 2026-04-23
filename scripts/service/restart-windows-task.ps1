param(
  [string]$TaskName = "CodexBridge-Weixin"
)

$ErrorActionPreference = "Stop"
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName
Write-Host "Restarted scheduled task: $TaskName"
