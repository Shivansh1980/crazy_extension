@echo off
REM Build PageSignalAgent.dll (managed) and PageSignalAgentHost.exe (host/injector).
REM Uses .NET Framework 4.x csc.exe — no Visual Studio required.
setlocal enableextensions
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" (
    echo [build] csc.exe not found at %CSC%
    exit /b 1
)

set HERE=%~dp0
set OUT=%HERE%dist
set SRC=%HERE%src
if not exist "%OUT%" mkdir "%OUT%"

echo [build] compiling PageSignalAgent.dll ...
"%CSC%" /nologo /target:library /platform:x64 ^
    /out:"%OUT%\PageSignalAgent.dll" ^
    /reference:"System.dll" ^
    /reference:"System.Core.dll" ^
    /reference:"System.Drawing.dll" ^
    /reference:"System.Web.Extensions.dll" ^
    "%SRC%\Agent.cs" "%SRC%\InputDispatcher.cs" "%SRC%\Logger.cs" ^
    "%SRC%\Resolver.cs" "%SRC%\ScreenCapture.cs" "%SRC%\WireProtocol.cs"
if errorlevel 1 (echo [build] DLL compile failed & exit /b 1)

echo [build] compiling PageSignalAgentHost.exe ...
"%CSC%" /nologo /target:exe /platform:x64 ^
    /out:"%OUT%\PageSignalAgentHost.exe" ^
    /reference:"System.dll" ^
    /reference:"%OUT%\PageSignalAgent.dll" ^
    "%SRC%\Injector.cs"
if errorlevel 1 (echo [build] EXE compile failed & exit /b 1)

echo [build] done. Artifacts in %OUT%
exit /b 0
