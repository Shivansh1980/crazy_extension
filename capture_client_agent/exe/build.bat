@echo off
REM ===========================================================================
REM capture_client_agent\exe\build.bat
REM ---------------------------------------------------------------------------
REM Bundles the capture_client_agent Python package into a single shareable
REM Windows executable using PyInstaller. The resulting exe is fully self
REM contained: it does not need Python, a virtualenv, or any wheels installed
REM on the target machine. Just copy the produced exe to any Windows box and
REM double-click it (or hand it to capture_client_agent\start.bat).
REM
REM Output: capture_client_agent\exe\dist\PageSignalNativeClient.exe
REM ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion

REM --- Resolve repo root ----------------------------------------------------
cd /d "%~dp0\..\.."
if errorlevel 1 (
  echo Failed to switch to the repository root.
  exit /b 1
)

if not exist "capture_client_agent\__main__.py" (
  echo Could not find capture_client_agent\__main__.py. Run this script from a clean checkout of the repository.
  exit /b 1
)
if not exist "requirements.txt" (
  echo requirements.txt is missing at the repository root.
  exit /b 1
)

REM --- Locate a Python interpreter to bootstrap the venv -------------------
set "PYTHON_BOOTSTRAP="
where py >nul 2>nul
if not errorlevel 1 set "PYTHON_BOOTSTRAP=py -3"

if not defined PYTHON_BOOTSTRAP (
  where python >nul 2>nul
  if not errorlevel 1 set "PYTHON_BOOTSTRAP=python"
)

if not defined PYTHON_BOOTSTRAP (
  echo Python was not found on PATH. Install Python 3.11+ from https://www.python.org/downloads/ and re-run this script.
  exit /b 1
)

REM --- Verify the interpreter is actually >= 3.11 --------------------------
%PYTHON_BOOTSTRAP% -c "import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)" >nul 2>nul
if errorlevel 1 (
  echo The detected Python interpreter is older than 3.11. Install Python 3.11 or newer.
  %PYTHON_BOOTSTRAP% --version
  exit /b 1
)

REM --- Create / reuse the virtual environment ------------------------------
if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment in .venv ...
  %PYTHON_BOOTSTRAP% -m venv .venv
  if errorlevel 1 (
    echo Failed to create the virtual environment.
    exit /b 1
  )
)

set "VENV_PYTHON=.venv\Scripts\python.exe"
if not exist "%VENV_PYTHON%" (
  echo Virtual environment is corrupt: %VENV_PYTHON% does not exist. Delete the .venv folder and re-run this script.
  exit /b 1
)

REM --- Install / upgrade build dependencies --------------------------------
echo Ensuring Python dependencies are installed...
"%VENV_PYTHON%" -m pip install --upgrade pip setuptools wheel
if errorlevel 1 (
  echo Failed to upgrade pip / setuptools / wheel.
  exit /b 1
)

"%VENV_PYTHON%" -m pip install -r requirements.txt
if errorlevel 1 (
  echo Failed to install runtime dependencies from requirements.txt.
  exit /b 1
)

"%VENV_PYTHON%" -m pip install "pyinstaller>=6.6,<7"
if errorlevel 1 (
  echo Failed to install PyInstaller.
  exit /b 1
)

REM --- Sanity-check that critical imports actually load --------------------
echo Verifying critical imports...
"%VENV_PYTHON%" -c "import websockets, PIL, mss, pyautogui, struct, asyncio, json" 2>nul
if errorlevel 1 (
  echo One or more required modules failed to import in the venv. Re-run after deleting the .venv folder.
  exit /b 1
)

REM --- Compile-check the package before invoking PyInstaller ---------------
echo Byte-compiling capture_client_agent ...
"%VENV_PYTHON%" -m compileall -q capture_client_agent
if errorlevel 1 (
  echo Source compilation failed. Fix the syntax errors above before retrying.
  exit /b 1
)

REM --- Clean previous artifacts --------------------------------------------
echo Cleaning previous native client build artifacts...
if exist "capture_client_agent\exe\build" rmdir /s /q "capture_client_agent\exe\build"
if exist "capture_client_agent\exe\dist"  rmdir /s /q "capture_client_agent\exe\dist"
if exist "capture_client_agent\exe\PageSignalNativeClient.spec" del /q "capture_client_agent\exe\PageSignalNativeClient.spec"

REM --- Build the single-file executable ------------------------------------
echo Building PageSignalNativeClient.exe (single-file, sharable)...
REM --collect-submodules pulls everything PyAutoGUI / mss / Pillow lazy-import.
REM --onefile produces a single sharable .exe. The PyInstaller bootloader still
REM extracts to a temp dir at runtime, but the artifact you ship is one file.
"%VENV_PYTHON%" -m PyInstaller ^
  --noconfirm ^
  --clean ^
  --onefile ^
  --name PageSignalNativeClient ^
  --distpath capture_client_agent\exe\dist ^
  --workpath capture_client_agent\exe\build ^
  --specpath capture_client_agent\exe ^
  --collect-submodules pyautogui ^
  --collect-submodules mss ^
  --collect-submodules PIL ^
  --collect-submodules websockets ^
  --hidden-import pymsgbox ^
  --hidden-import mouseinfo ^
  --hidden-import pyscreeze ^
  --hidden-import pytweening ^
  capture_client_agent\__main__.py
if errorlevel 1 (
  echo PyInstaller build failed. Inspect the log above; common fixes: delete .venv and re-run, or upgrade Python.
  exit /b 1
)

if not exist "capture_client_agent\exe\dist\PageSignalNativeClient.exe" (
  echo Expected output capture_client_agent\exe\dist\PageSignalNativeClient.exe was not produced.
  exit /b 1
)

REM --- Sanity check: confirm the produced file is a non-trivial PE binary --
for %%I in ("capture_client_agent\exe\dist\PageSignalNativeClient.exe") do set "EXE_SIZE=%%~zI"
if not defined EXE_SIZE (
  echo Unable to read the size of the produced executable.
  exit /b 1
)
if %EXE_SIZE% LSS 1000000 (
  echo Produced executable is suspiciously small ^(%EXE_SIZE% bytes^). Build likely failed.
  exit /b 1
)

echo.
echo ===========================================================================
echo Native client built successfully:
echo   %CD%\capture_client_agent\exe\dist\PageSignalNativeClient.exe
echo Share this single exe; users can double-click it or use capture_client_agent\start.bat.
echo ===========================================================================
exit /b 0

