@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

set "SETUP_ONLY=0"
set "START_NATIVE=0"

:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="--setup-only" set "SETUP_ONLY=1"
if /I "%~1"=="--with-native" set "START_NATIVE=1"
if /I "%~1"=="--start-native" set "START_NATIVE=1"
shift
goto :parse_args
:args_done

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

%PYTHON_BOOTSTRAP% -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if errorlevel 1 (
  echo The detected Python interpreter is older than 3.11. Install Python 3.11 or newer.
  %PYTHON_BOOTSTRAP% --version
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
if not exist "%VENV_PYTHON%" (
  echo Virtual environment is corrupt: %VENV_PYTHON% does not exist. Delete .venv and re-run this script.
  exit /b 1
)

"%VENV_PYTHON%" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if errorlevel 1 (
  echo The virtual environment uses Python older than 3.11. Delete .venv and re-run this script with Python 3.11+ on PATH.
  "%VENV_PYTHON%" --version
  exit /b 1
)

for /f "tokens=1,* delims==" %%A in (.venv\pyvenv.cfg) do (
  if /I "%%A"=="home " set "PYTHON_HOME=%%B"
)
if defined PYTHON_HOME if "!PYTHON_HOME:~0,1!"==" " set "PYTHON_HOME=!PYTHON_HOME:~1!"

if defined PYTHON_HOME (
  if exist "%PYTHON_HOME%\tcl\tcl8.6" set "TCL_LIBRARY=%PYTHON_HOME%\tcl\tcl8.6"
  if exist "%PYTHON_HOME%\tcl\tk8.6" set "TK_LIBRARY=%PYTHON_HOME%\tcl\tk8.6"
)

set "REQUIREMENTS_HASH="
set "INSTALLED_REQUIREMENTS_HASH="
set "DEPENDENCIES_READY=0"
for /f "delims=" %%H in ('powershell.exe -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath 'requirements.txt').Hash"') do set "REQUIREMENTS_HASH=%%H"
if exist ".venv\.requirements.sha256" set /p "INSTALLED_REQUIREMENTS_HASH="<".venv\.requirements.sha256"

if defined REQUIREMENTS_HASH if /I "!REQUIREMENTS_HASH!"=="!INSTALLED_REQUIREMENTS_HASH!" (
  "%VENV_PYTHON%" -c "import bcrypt, mss, PIL, pyautogui, websockets" >nul 2>nul
  if not errorlevel 1 set "DEPENDENCIES_READY=1"
)

if "!DEPENDENCIES_READY!"=="0" (
  echo Installing/updating Python dependencies from requirements.txt...
  "%VENV_PYTHON%" -m pip install --disable-pip-version-check --upgrade pip setuptools wheel
  if errorlevel 1 (
    echo Failed to upgrade pip / setuptools / wheel.
    exit /b 1
  )

  "%VENV_PYTHON%" -m pip install --disable-pip-version-check -r requirements.txt
  if errorlevel 1 (
    echo Failed to install Python dependencies.
    exit /b 1
  )
  if defined REQUIREMENTS_HASH >".venv\.requirements.sha256" echo !REQUIREMENTS_HASH!
) else (
  echo Python dependencies are already up to date.
)

echo Verifying Python runtime imports...
"%VENV_PYTHON%" -c "import bcrypt, mss, PIL, pyautogui, websockets; import tkinter; tkinter.Tcl().eval('info patchlevel')" >nul 2>nul
if errorlevel 1 (
  echo Python dependencies installed, but Tkinter/Tcl or another GUI dependency failed to import.
  echo Install/repair Python 3.11+ with Tcl/Tk support, or delete .venv and re-run after fixing Python.
  "%VENV_PYTHON%" -c "import sys; print(sys.version); import tkinter; print(tkinter.__file__); tkinter.Tcl().eval('info patchlevel')"
  exit /b 1
)

if "%SETUP_ONLY%"=="1" (
  echo Python GUI environment is ready.
  exit /b 0
)

if "%START_NATIVE%"=="1" (
  REM Optional: launch a supervised native client when explicitly requested. The
  REM default GUI startup only opens the bridge and waits until a real extension,
  REM EXE, DLL host, or Python client connects and registers.
  call "%~dp0capture_client_agent\start.bat" --silent
) else (
  echo Native client auto-start disabled. The GUI will wait for an extension/native client to connect.
)

echo Starting Capture Control Center...
"%VENV_PYTHON%" -m capture_control_center.app
exit /b %errorlevel%
