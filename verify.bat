@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "BUILD_EXE=0"
set "RUN_X86_HOST=0"
:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="--all" set "BUILD_EXE=1"
if /I "%~1"=="--x86-runtime" set "RUN_X86_HOST=1"
shift
goto :parse_args
:args_done

if not exist ".venv\Scripts\python.exe" (
  echo [verify] Python environment is missing; running setup first.
  call "%~dp0start_gui.bat" --setup-only
  if errorlevel 1 exit /b 1
)

echo [verify] Type-checking extension...
call "%~dp0run_npm.bat" run typecheck
if errorlevel 1 exit /b 1

echo [verify] Running Python unit and reconnect integration tests...
".venv\Scripts\python.exe" -m unittest discover -s tests -v
if errorlevel 1 exit /b 1

echo [verify] Byte-compiling Python clients...
".venv\Scripts\python.exe" -m compileall -q capture_control_center capture_client_agent live_server tests
if errorlevel 1 exit /b 1

echo [verify] Building extension bundle...
call "%~dp0run_npm.bat" run build
if errorlevel 1 exit /b 1

echo [verify] Building and smoke-checking C# DLL/hosts...
call "%~dp0capture_client_agent\dll\build.bat"
if errorlevel 1 exit /b 1
"capture_client_agent\dll\dist\PageSignalAgentHost.exe" --help >nul
if errorlevel 1 exit /b 1
"capture_client_agent\dll\dist\PageSignalInjector.exe" --self-test
if errorlevel 1 exit /b 1
for %%I in (
  "capture_client_agent\dll\dist\PageSignalBootstrap.x64.dll"
  "capture_client_agent\dll\dist\PageSignalBootstrap.x86.dll"
) do if %%~zI LSS 10000 (
  echo [verify] %%~nxI is missing or suspiciously small.
  exit /b 1
)
if exist "capture_client_agent\dll\dist\PageSignalAgentHost.x86.exe" (
  for %%I in ("capture_client_agent\dll\dist\PageSignalAgentHost.x86.exe") do if %%~zI LSS 10000 (
    echo [verify] x86 host is suspiciously small.
    exit /b 1
  )
  if "%RUN_X86_HOST%"=="1" (
    "capture_client_agent\dll\dist\PageSignalAgentHost.x86.exe" --help >nul
    if errorlevel 1 exit /b 1
  ) else (
    echo [verify] x86 host compiled; runtime smoke skipped unless --x86-runtime is requested.
  )
) else (
  echo [verify] x86 compiler unavailable; x86 host was not produced.
)

if "%BUILD_EXE%"=="1" (
  echo [verify] Building standalone native EXE...
  call "%~dp0capture_client_agent\exe\build.bat"
  if errorlevel 1 exit /b 1
  "capture_client_agent\exe\dist\PageSignalNativeClient.exe" --version >nul
  if errorlevel 1 exit /b 1
)

echo [verify] All checks passed.
exit /b 0
