@echo off
REM ===========================================================================
REM capture_client_agent\build.bat
REM ---------------------------------------------------------------------------
REM Bundles the capture_client_agent Python package into a single shareable
REM Windows executable using PyInstaller. The resulting exe is fully self
REM contained: it does not need Python, a virtualenv, or any wheels installed
REM on the target machine. Just copy the produced exe to any Windows box and
REM double-click it (or hand it to start.bat).
REM
REM Output: capture_client_agent\dist\PageSignalNativeClient.exe
REM ===========================================================================
setlocal EnableExtensions

REM Switch to the repository root (one level up from this script's folder).
cd /d "%~dp0\.."

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

echo Ensuring Python dependencies are installed...
%VENV_PYTHON% -m pip install --upgrade pip
if errorlevel 1 (
  echo Failed to upgrade pip.
  exit /b 1
)

%VENV_PYTHON% -m pip install -r requirements.txt
if errorlevel 1 (
  echo Failed to install runtime dependencies.
  exit /b 1
)

%VENV_PYTHON% -m pip install "pyinstaller>=6.6,<7"
if errorlevel 1 (
  echo Failed to install PyInstaller.
  exit /b 1
)

echo Cleaning previous native client build artifacts...
if exist "capture_client_agent\build" rmdir /s /q "capture_client_agent\build"
if exist "capture_client_agent\dist" rmdir /s /q "capture_client_agent\dist"
if exist "capture_client_agent\PageSignalNativeClient.spec" del /q "capture_client_agent\PageSignalNativeClient.spec"

echo Building PageSignalNativeClient.exe (single-file, sharable)...
REM --collect-submodules pulls everything PyAutoGUI / mss / Pillow lazy-import.
REM --onefile produces a single sharable .exe. The PyInstaller bootloader still
REM extracts to a temp dir at runtime, but the artifact you ship is one file.
%VENV_PYTHON% -m PyInstaller ^
  --noconfirm ^
  --clean ^
  --onefile ^
  --name PageSignalNativeClient ^
  --distpath capture_client_agent\dist ^
  --workpath capture_client_agent\build ^
  --specpath capture_client_agent ^
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
  echo PyInstaller build failed.
  exit /b 1
)

if not exist "capture_client_agent\dist\PageSignalNativeClient.exe" (
  echo Expected output capture_client_agent\dist\PageSignalNativeClient.exe was not produced.
  exit /b 1
)

echo.
echo ===========================================================================
echo Native client built successfully:
echo   %CD%\capture_client_agent\dist\PageSignalNativeClient.exe
echo Share this single exe; users can double-click it or use start.bat.
echo ===========================================================================
exit /b 0
