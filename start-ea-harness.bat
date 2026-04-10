@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-ea-harness.ps1"
endlocal
