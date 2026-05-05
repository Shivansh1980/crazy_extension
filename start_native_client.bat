@echo off
REM Idempotent launcher for the Page Signal native client agent.
REM
REM Order of preference (matches user request — EXE first, DLL host second,
REM Python module last):
REM   1. PageSignalNativeClient.exe (PyInstaller build under dist_native_client\)
REM   2. PageSignalAgentHost.exe run (C# host under capture_client_agent\native_dll\dist\)
REM   3. .venv\Scripts\python.exe -m capture_client_agent (last-resort dev fallback)
REM
REM If a native client process is already running, this script is a no-op and exits 0.
REM
REM Usage:
REM   start_native_client.bat            — start the best available client in a new window
REM   start_native_client.bat --silent   — start hidden (no new window, output to %TEMP%\PageSignalNativeClient.out.log)

setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

set "SILENT=0"
if /I "%~1"=="--silent" set "SILENT=1"

REM ----------------------------------------------------------------------
REM 1) Already running?  Skip.
REM ----------------------------------------------------------------------
for %%P in (PageSignalNativeClient.exe PageSignalAgentHost.exe) do (
  REM /NH = no header, /FO CSV avoids tasklist's 24-char image-name truncation.
  for /f "tokens=1 delims=," %%A in (
    'tasklist /NH /FO CSV /FI "IMAGENAME eq %%P" 2^>nul'
  ) do (
    if /I "%%~A"=="%%P" (
      echo [native-client] %%P is already running. Skipping launch.
      exit /b 0
    )
  )
)

REM Detect a Python module instance (look for "capture_client_agent" in process command lines).
for /f "skip=2 tokens=*" %%L in (
  'wmic process where "name='python.exe' or name='pythonw.exe'" get CommandLine 2^>nul'
) do (
  echo %%L | findstr /I "capture_client_agent" >nul
  if not errorlevel 1 (
    echo [native-client] capture_client_agent Python module is already running. Skipping launch.
    exit /b 0
  )
)

REM ----------------------------------------------------------------------
REM 2) Resolve preferred binary.
REM ----------------------------------------------------------------------
set "TARGET_KIND="
set "TARGET_PATH="
set "TARGET_ARGS="
set "TARGET_DIR="

if exist "dist_native_client\PageSignalNativeClient.exe" (
  set "TARGET_KIND=exe"
  set "TARGET_PATH=%CD%\dist_native_client\PageSignalNativeClient.exe"
  set "TARGET_DIR=%CD%\dist_native_client"
  set "TARGET_ARGS="
  goto :launch
)

if exist "capture_client_agent\native_dll\dist\PageSignalAgentHost.exe" (
  set "TARGET_KIND=dll-host"
  set "TARGET_PATH=%CD%\capture_client_agent\native_dll\dist\PageSignalAgentHost.exe"
  set "TARGET_DIR=%CD%\capture_client_agent\native_dll\dist"
  set "TARGET_ARGS=run"
  goto :launch
)

if exist ".venv\Scripts\python.exe" (
  set "TARGET_KIND=python-module"
  set "TARGET_PATH=%CD%\.venv\Scripts\python.exe"
  set "TARGET_DIR=%CD%"
  set "TARGET_ARGS=-m capture_client_agent"
  goto :launch
)

echo [native-client] No native client found.
echo                 Build one of:
echo                   - capture_client_agent\build.bat            (PyInstaller EXE)
echo                   - capture_client_agent\native_dll\build.bat (C# DLL host)
echo                 Or run start_gui.bat --setup-only to provision .venv.
exit /b 1

:launch
echo [native-client] Launching %TARGET_KIND%: "%TARGET_PATH%" %TARGET_ARGS%

if "%SILENT%"=="1" (
  REM Spawn detached, hidden, no new console — output redirected to a log file.
  set "LOG=%TEMP%\PageSignalNativeClient.out.log"
  start "" /B /D "%TARGET_DIR%" cmd /c ""%TARGET_PATH%" %TARGET_ARGS% >> "!LOG!" 2>&1"
) else (
  start "Page Signal Native Client" /D "%TARGET_DIR%" "%TARGET_PATH%" %TARGET_ARGS%
)

REM Wait briefly so the client gets a head start at registering with the bridge.
ping -n 2 127.0.0.1 >nul

exit /b 0
