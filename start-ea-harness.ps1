param(
  [int]$Port = 3000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSCommandPath
Set-Location -LiteralPath $root

function Fail([string]$Message) {
  Write-Host ""
  Write-Host $Message -ForegroundColor Red
  Write-Host ""
  Read-Host "Press Enter to close"
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js was not found. Install Node.js 20+ and run start-ea-harness.bat again."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail "npm was not found. Reinstall Node.js and run start-ea-harness.bat again."
}

if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules"))) {
  Write-Host "Running first-time setup. Please wait..." -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) {
    Fail "Setup failed. Please check the error shown in this window."
  }
}

$command = "Set-Location -LiteralPath '$root'; npm start"
Start-Process powershell -WorkingDirectory $root -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  $command
) | Out-Null

$url = "http://127.0.0.1:$Port"
$deadline = (Get-Date).AddSeconds(30)
$isReady = $false

while ((Get-Date) -lt $deadline) {
  try {
    if (Test-NetConnection -ComputerName "127.0.0.1" -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue) {
      $isReady = $true
      break
    }
  } catch {
  }

  Start-Sleep -Seconds 1
}

if ($isReady) {
  Start-Process $url | Out-Null
  Write-Host "Browser opened: $url" -ForegroundColor Green
} else {
  Write-Host "Server is still starting. Open this URL in a few seconds: $url" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Check Setup Wizard at the bottom of the page"
Write-Host "2. Click Test MT5"
Write-Host "3. Click Test Codex"
Write-Host "4. Click Save Settings"
Write-Host ""
