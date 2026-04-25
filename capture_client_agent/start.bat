@echo off
REM ===========================================================================
REM capture_client_agent\start.bat
REM ---------------------------------------------------------------------------
REM Launches the Page Signal native client (screen capture + OS input + popup
REM file delivery). Prefers the standalone PyInstaller exe at
REM capture_client_agent\dist\PageSignalNativeClient.exe so end users do not
REM need Python installed; falls back to the Python module from the repo
REM virtualenv for developer iteration.
REM ===========================================================================
setlocal EnableExtensions

REM Switch to the repository root (one level up from this script's folder).
cd /d "%~dp0\.."

set "NATIVE_EXE=capture_client_agent\dist\PageSignalNativeClient.exe"

if exist "%NATIVE_EXE%" (
  echo Starting Page Signal native client (standalone exe)...
  "%NATIVE_EXE%" %*
  exit /b %errorlevel%
)

echo Standalone exe not found at %NATIVE_EXE%.
echo Falling back to the Python module. Run capture_client_agent\build.bat to produce the exe.
echo.

set "PYTHON_BOOTSTRAP="
where py >nul 2>nul
if not errorlevel 1 set "PYTHON_BOOTSTRAP=py -3"

if not defined PYTHON_BOOTSTRAP (
  where python >nul 2>nul
  if not errorlevel 1 set "PYTHON_BOOTSTRAP=python"
)

if not defined PYTHON_BOOTSTRAP (
  echo Python was not found. Either build the standalone exe with capture_client_agent\build.bat
  echo on a machine that has Python, or install Python 3.11+ here.
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment...
  %PYTHON_BOOTSTRAP% -m venv .venv
  if errorlevel 1 (
    echo Failed to create the virtual environment.
    exit /b 1
  )
)

set "VENV_PYTHON=.venv\Scripts\python.exe"

echo Checking Python dependencies...
%VENV_PYTHON% -c "import PIL, websockets, pyautogui, mss" >nul 2>nul
if errorlevel 1 (
  echo Installing Python dependencies from requirements.txt...
  %VENV_PYTHON% -m pip install --upgrade pip
  if errorlevel 1 (
    echo Failed to upgrade pip.
    exit /b 1
  )

  %VENV_PYTHON% -m pip install -r requirements.txt
  if errorlevel 1 (
    echo Failed to install Python dependencies.
    exit /b 1
  )
)

echo Starting Page Signal native client (Python fallback)...
%VENV_PYTHON% -m capture_client_agent %*
exit /b %errorlevel%
