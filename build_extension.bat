@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

if not exist "%~dp0run_npm.bat" (
  echo run_npm.bat was not found. Restore the repository setup files and try again.
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

set "DEPENDENCY_MANIFEST=package.json"
set "INSTALL_COMMAND=install"
if exist "package-lock.json" (
  set "DEPENDENCY_MANIFEST=package-lock.json"
  set "INSTALL_COMMAND=ci"
)

set "DEPENDENCY_HASH="
set "INSTALLED_DEPENDENCY_HASH="
set "DEPENDENCIES_READY=0"
for /f "delims=" %%H in ('powershell.exe -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath '!DEPENDENCY_MANIFEST!').Hash"') do set "DEPENDENCY_HASH=%%H"
if exist "node_modules\.page-signal-package.sha256" set /p "INSTALLED_DEPENDENCY_HASH="<"node_modules\.page-signal-package.sha256"
if defined DEPENDENCY_HASH if /I "!DEPENDENCY_HASH!"=="!INSTALLED_DEPENDENCY_HASH!" (
  node.exe -e "require('esbuild'); require('typescript')" >nul 2>nul
  if not errorlevel 1 set "DEPENDENCIES_READY=1"
)

if "!DEPENDENCIES_READY!"=="0" (
  echo Installing Node.js dependencies from !DEPENDENCY_MANIFEST!...
  call "%~dp0run_npm.bat" !INSTALL_COMMAND!
  if errorlevel 1 (
    echo Failed to install Node.js dependencies.
    exit /b 1
  )
  if defined DEPENDENCY_HASH >"node_modules\.page-signal-package.sha256" echo !DEPENDENCY_HASH!
) else (
  echo Node.js dependencies are already up to date.
)

echo Building extension bundle...
call "%~dp0run_npm.bat" run build
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
