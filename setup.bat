@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "BUILD_NATIVE=0"
set "BUILD_ALL=0"

:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="--native" set "BUILD_NATIVE=1"
if /I "%~1"=="--all" (
  set "BUILD_NATIVE=1"
  set "BUILD_ALL=1"
)
shift
goto :parse_args
:args_done

echo [setup] Preparing the Python control center...
call "%~dp0start_gui.bat" --setup-only
if errorlevel 1 exit /b 1

echo [setup] Building the browser extension...
call "%~dp0build_extension.bat"
if errorlevel 1 exit /b 1

if "%BUILD_NATIVE%"=="1" (
  echo [setup] Building the C# native DLL and hosts...
  call "%~dp0capture_client_agent\dll\build.bat"
  if errorlevel 1 exit /b 1
)

if "%BUILD_ALL%"=="1" (
  echo [setup] Building the standalone native EXE...
  call "%~dp0capture_client_agent\exe\build.bat"
  if errorlevel 1 exit /b 1
)

echo.
echo [setup] Page Signal Capture is ready.
echo [setup] Start the GUI with: start_gui.bat
echo [setup] Start GUI + native client with: start_gui.bat --with-native
if "%BUILD_NATIVE%"=="1" echo [setup] Open the graphical DLL injector with: start_injector.bat
exit /b 0
