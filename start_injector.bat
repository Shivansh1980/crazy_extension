@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "INJECTOR=%~dp0capture_client_agent\dll\dist\PageSignalInjector.exe"

if not exist "%INJECTOR%" (
  echo PageSignalInjector.exe is missing. Run setup.bat --native first.
  exit /b 1
)

start "PageSignal Process Injector" "%INJECTOR%"
exit /b 0
