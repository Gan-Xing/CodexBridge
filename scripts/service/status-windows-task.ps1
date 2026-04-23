param(
  [string]$TaskName = "CodexBridge-Weixin"
)

$ErrorActionPreference = "Stop"
$Task = Get-ScheduledTask -TaskName $TaskName
$Info = Get-ScheduledTaskInfo -TaskName $TaskName

$Task | Select-Object TaskName, State
$Info | Select-Object LastRunTime, LastTaskResult, NextRunTime, NumberOfMissedRuns
