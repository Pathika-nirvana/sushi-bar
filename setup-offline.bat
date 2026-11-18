@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-offline.ps1"
if errorlevel 1 (
  echo.
  echo Setup failed. Check your internet connection and retry.
  pause
  exit /b 1
)
echo.
echo Open offline.html whenever you want to play offline.
pause
