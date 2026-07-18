@echo off
setlocal EnableExtensions

set "NODE_EXE="
for /f "delims=" %%I in ('where.exe node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE (
  echo node.exe was not found. Install Node.js 20+ and try again.
  exit /b 1
)

for %%I in ("%NODE_EXE%") do set "NODE_HOME=%%~dpI"
set "NPM_CLI=%NODE_HOME%node_modules\npm\bin\npm-cli.js"

if not exist "%NPM_CLI%" goto :fallback

"%NODE_EXE%" "%NPM_CLI%" %*
exit /b %errorlevel%

:fallback
set "NPM_CMD="
for /f "delims=" %%I in ('where.exe npm.cmd 2^>nul') do if not defined NPM_CMD set "NPM_CMD=%%I"
if not defined NPM_CMD (
  echo npm.cmd was not found beside Node.js or on PATH. Reinstall Node.js 20+ and try again.
  exit /b 1
)

call "%NPM_CMD%" %*
exit /b %errorlevel%
