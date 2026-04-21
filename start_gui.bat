@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "SETUP_ONLY=0"
if /I "%~1"=="--setup-only" set "SETUP_ONLY=1"

set "PYTHON_BOOTSTRAP="
where py >nul 2>nul
if not errorlevel 1 set "PYTHON_BOOTSTRAP=py -3"

if not defined PYTHON_BOOTSTRAP (
  where python >nul 2>nul
  if not errorlevel 1 set "PYTHON_BOOTSTRAP=python"
)

if not defined PYTHON_BOOTSTRAP (
  echo Python was not found. Install Python 3.11+ and try again.
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
for /f "tokens=1,* delims==" %%A in (.venv\pyvenv.cfg) do (
  if /I "%%A"=="home " set "PYTHON_HOME=%%B"
)

if defined PYTHON_HOME (
  if exist "%PYTHON_HOME%\tcl\tcl8.6" set "TCL_LIBRARY=%PYTHON_HOME%\tcl\tcl8.6"
  if exist "%PYTHON_HOME%\tcl\tk8.6" set "TK_LIBRARY=%PYTHON_HOME%\tcl\tk8.6"
)

echo Checking Python dependencies...
%VENV_PYTHON% -c "import PIL, websockets" >nul 2>nul
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

if "%SETUP_ONLY%"=="1" (
  echo Python GUI environment is ready.
  exit /b 0
)

echo Starting Capture Control Center...
%VENV_PYTHON% -m capture_control_center.app
exit /b %errorlevel%
