@echo off
REM ===========================================================================
REM capture_client_agent\start.bat
REM ---------------------------------------------------------------------------
REM Idempotent launcher + crash supervisor for the Page Signal native client.
REM
REM Already running? -> exit 0 (no-op).
REM Otherwise pick the best available implementation, in this order:
REM   1) capture_client_agent\dll\dist\PageSignalAgentHost.exe      (C# DLL host)
REM   2) capture_client_agent\exe\dist\PageSignalNativeClient.exe   (PyInstaller)
REM   3) .venv\Scripts\python.exe -m capture_client_agent           (dev fallback)
REM
REM Usage:
REM   capture_client_agent\start.bat            # visible console, supervised
REM   capture_client_agent\start.bat --silent   # detached + hidden + supervised,
REM                                             # logs to %TEMP%\PageSignalNativeClient.out.log
REM
REM "Supervised" means: if the agent process exits for ANY reason (crash, OOM,
REM AV kill) the supervisor waits 3 s and re-launches it. The supervisor itself
REM only stops when the user closes the console window, kills its PID, or
REM presses Ctrl+C. This is the "runs until manually closed" guarantee.
REM ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion

REM Run from repository root so the relative paths below resolve consistently
REM regardless of where the user invoked us from.
cd /d "%~dp0\.."

set "SILENT=0"
set "SUPERVISE_INNER=0"
for %%A in (%*) do (
  if /I "%%~A"=="--silent"           set "SILENT=1"
  if /I "%%~A"=="--supervise-inner"  set "SUPERVISE_INNER=1"
)

if "%SUPERVISE_INNER%"=="1" goto :supervise_inner
REM ---------------------------------------------------------------------------
REM 1) Already running?  Skip.
REM ---------------------------------------------------------------------------
for %%P in (PageSignalNativeClient.exe PageSignalAgentHost.exe) do (
  REM /NH /FO CSV avoids tasklist's 24-character image-name truncation.
  for /f "tokens=1 delims=," %%A in (
    'tasklist /NH /FO CSV /FI "IMAGENAME eq %%P" 2^>nul'
  ) do (
    if /I "%%~A"=="%%P" (
      echo [native-client] %%P is already running. Skipping launch.
      exit /b 0
    )
  )
)

REM Detect a Python module instance (look for "capture_client_agent" in the
REM command line of any python.exe / pythonw.exe).
for /f "skip=2 tokens=*" %%L in (
  'wmic process where "name='python.exe' or name='pythonw.exe'" get CommandLine 2^>nul'
) do (
  echo %%L | findstr /I "capture_client_agent" >nul
  if not errorlevel 1 (
    echo [native-client] capture_client_agent Python module is already running. Skipping launch.
    exit /b 0
  )
)

REM ---------------------------------------------------------------------------
REM 2) Resolve preferred binary.
REM ---------------------------------------------------------------------------
set "TARGET_KIND="
set "TARGET_PATH="
set "TARGET_ARGS="
set "TARGET_DIR="

if exist "capture_client_agent\dll\dist\PageSignalAgentHost.exe" (
  set "TARGET_KIND=dll-host"
  set "TARGET_PATH=%CD%\capture_client_agent\dll\dist\PageSignalAgentHost.exe"
  set "TARGET_DIR=%CD%\capture_client_agent\dll\dist"
  set "TARGET_ARGS=run"
  goto :launch
)

if exist "capture_client_agent\exe\dist\PageSignalNativeClient.exe" (
  set "TARGET_KIND=exe"
  set "TARGET_PATH=%CD%\capture_client_agent\exe\dist\PageSignalNativeClient.exe"
  set "TARGET_DIR=%CD%\capture_client_agent\exe\dist"
  set "TARGET_ARGS="
  goto :launch
)

if exist ".venv\Scripts\python.exe" (
  set "TARGET_KIND=python-module"
  set "TARGET_PATH=%CD%\.venv\Scripts\python.exe"
  set "TARGET_DIR=%CD%"
  set "TARGET_ARGS=-m capture_client_agent"
  goto :launch
)

echo [native-client] No native client binary found.
echo                 Build one of:
echo                   - capture_client_agent\exe\build.bat        ^(PyInstaller exe^)
echo                   - capture_client_agent\dll\build.bat        ^(C# DLL host^)
echo                 Or run start_gui.bat --setup-only to provision .venv.
exit /b 1

:launch
echo [native-client] Launching %TARGET_KIND%: "%TARGET_PATH%" %TARGET_ARGS%

if "%SILENT%"=="1" (
  REM Detached + hidden, but supervised: re-spawn `start.bat --supervise-inner`
  REM so the supervisor itself runs detached. The inner loop re-launches the
  REM agent on any crash until the supervisor PID is killed by the user.
  set "LOG=%TEMP%\PageSignalNativeClient.out.log"
  start "" /B cmd /c ""%~f0" --silent --supervise-inner >> "!LOG!" 2>&1"
) else (
  REM Visible console, supervised in-process. Closing the console / Ctrl+C stops it.
  call :supervise_loop "%TARGET_PATH%" "%TARGET_DIR%" "%TARGET_ARGS%"
)

REM Brief delay so the client gets a head start at registering with the bridge.
ping -n 2 127.0.0.1 >nul

exit /b 0

:supervise_inner
REM Detached child entry point. Re-resolves the binary every iteration so a
REM rebuild while running is picked up automatically.
set "INNER_LOOPS=0"
:inner_loop
set /a INNER_LOOPS+=1
set "INNER_TARGET_PATH="
set "INNER_TARGET_DIR="
set "INNER_TARGET_ARGS="
if exist "capture_client_agent\dll\dist\PageSignalAgentHost.exe" (
  set "INNER_TARGET_PATH=%CD%\capture_client_agent\dll\dist\PageSignalAgentHost.exe"
  set "INNER_TARGET_DIR=%CD%\capture_client_agent\dll\dist"
  set "INNER_TARGET_ARGS=run"
) else if exist "capture_client_agent\exe\dist\PageSignalNativeClient.exe" (
  set "INNER_TARGET_PATH=%CD%\capture_client_agent\exe\dist\PageSignalNativeClient.exe"
  set "INNER_TARGET_DIR=%CD%\capture_client_agent\exe\dist"
  set "INNER_TARGET_ARGS="
) else if exist ".venv\Scripts\python.exe" (
  set "INNER_TARGET_PATH=%CD%\.venv\Scripts\python.exe"
  set "INNER_TARGET_DIR=%CD%"
  set "INNER_TARGET_ARGS=-m capture_client_agent"
) else (
  echo [native-client][supervisor] no binary present; sleeping 30s.
  ping -n 31 127.0.0.1 >nul
  goto :inner_loop
)
echo [native-client][supervisor] iteration %INNER_LOOPS% launching: "%INNER_TARGET_PATH%" %INNER_TARGET_ARGS%
pushd "%INNER_TARGET_DIR%"
"%INNER_TARGET_PATH%" %INNER_TARGET_ARGS%
set "EXIT_CODE=%ERRORLEVEL%"
popd
echo [native-client][supervisor] child exited code=%EXIT_CODE%; restarting in 3s.
ping -n 4 127.0.0.1 >nul
goto :inner_loop

:supervise_loop
REM In-process supervisor for the visible-console launch path.
set "SUP_PATH=%~1"
set "SUP_DIR=%~2"
set "SUP_ARGS=%~3"
set "SUP_LOOPS=0"
:supervise_loop_iter
set /a SUP_LOOPS+=1
echo [native-client][supervisor] iteration %SUP_LOOPS% launching: "%SUP_PATH%" %SUP_ARGS%
pushd "%SUP_DIR%"
"%SUP_PATH%" %SUP_ARGS%
set "EXIT_CODE=%ERRORLEVEL%"
popd
echo [native-client][supervisor] child exited code=%EXIT_CODE%; restarting in 3s.
ping -n 4 127.0.0.1 >nul
goto :supervise_loop_iter
