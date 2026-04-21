@echo off
setlocal EnableExtensions

cd /d "%~dp0"

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm.cmd was not found. Install Node.js 20+ and try again.
  exit /b 1
)

if not exist "node_modules" (
  echo Installing Node.js dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo Failed to install Node.js dependencies.
    exit /b 1
  )
)

echo Building extension bundle...
call npm.cmd run build
if errorlevel 1 (
  echo Extension build failed.
  exit /b 1
)

echo Extension bundle is ready in the dist folder.
exit /b 0