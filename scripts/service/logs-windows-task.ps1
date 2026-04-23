param(
  [string]$StateDir = (Join-Path $env:USERPROFILE ".codexbridge"),
  [switch]$Follow
)

$ErrorActionPreference = "Stop"
$LogDir = Join-Path $StateDir "logs"
$StdoutLog = Join-Path $LogDir "weixin-bridge.out.log"
$StderrLog = Join-Path $LogDir "weixin-bridge.err.log"

Write-Host "== $StdoutLog =="
if (Test-Path $StdoutLog) {
  Get-Content -Path $StdoutLog -Tail 80
}

Write-Host "== $StderrLog =="
if (Test-Path $StderrLog) {
  if ($Follow) {
    Get-Content -Path $StderrLog -Tail 80 -Wait
  } else {
    Get-Content -Path $StderrLog -Tail 80
  }
}
