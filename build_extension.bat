@echo off
setlocal EnableExtensions

cd /d "%~dp0"

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm.cmd was not found. Install Node.js 20+ and try again.
  exit /b 1
)

where node.exe >nul 2>nul
if errorlevel 1 (
  echo node.exe was not found. Install Node.js 20+ and try again.
  exit /b 1
)

node.exe -e "const major=Number(process.versions.node.split('.')[0]); process.exit(major >= 20 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required. Detected:
  node.exe --version
  exit /b 1
)

if not exist "package.json" (
  echo package.json was not found. Run this script from the repository root.
  exit /b 1
)

if exist "package-lock.json" (
  echo Installing Node.js dependencies from package-lock.json...
  call npm.cmd ci
  if errorlevel 1 (
    echo Failed to install Node.js dependencies.
    exit /b 1
  )
)

if not exist "package-lock.json" (
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
for %%F in (manifest.json background.js offscreen.js options.js screen-share.js options.html offscreen.html screen-share.html) do (
  if not exist "dist\%%F" (
    echo Expected dist\%%F was not produced.
    exit /b 1
  )
)

echo Verified extension bundle files in dist.
exit /b 0
