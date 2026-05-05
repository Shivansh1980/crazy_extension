@echo off
REM =====================================================================
REM Build the PageSignal native agent in BOTH bitnesses.
REM
REM Outputs (in dist\):
REM   PageSignalAgent.dll          managed agent (AnyCPU - works either way)
REM   PageSignalAgentHost.exe      x64 host / injector (primary on 64-bit Windows)
REM   PageSignalAgentHost.x86.exe  x86 host / injector (used to reach 32-bit targets)
REM
REM Requires only the in-box .NET Framework 4.x compilers (no Visual Studio):
REM   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe   (x64)
REM   C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe     (x86)
REM =====================================================================
setlocal enableextensions
set CSC64=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set CSC32=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe

if not exist "%CSC64%" (
    echo [build] csc.exe ^(x64^) not found at %CSC64%
    exit /b 1
)
set NO_X86=
if not exist "%CSC32%" (
    echo [build] csc.exe ^(x86^) not found at %CSC32%
    echo [build] x86 host will not be built; injection into 32-bit targets will be unavailable.
    set NO_X86=1
)

set HERE=%~dp0
set OUT=%HERE%dist
set SRC=%HERE%src
if not exist "%OUT%" mkdir "%OUT%"

set AGENT_SRCS="%SRC%\Agent.cs" "%SRC%\InputDispatcher.cs" "%SRC%\Logger.cs" "%SRC%\Resolver.cs" "%SRC%\ScreenCapture.cs" "%SRC%\WireProtocol.cs"

echo [build] compiling PageSignalAgent.dll (AnyCPU) ...
"%CSC64%" /nologo /target:library /platform:anycpu ^
    /out:"%OUT%\PageSignalAgent.dll" ^
    /reference:"System.dll" ^
    /reference:"System.Core.dll" ^
    /reference:"System.Drawing.dll" ^
    /reference:"System.Web.Extensions.dll" ^
    %AGENT_SRCS%
if errorlevel 1 (echo [build] DLL compile failed & exit /b 1)

echo [build] compiling PageSignalAgentHost.exe (x64) ...
"%CSC64%" /nologo /target:exe /platform:x64 ^
    /out:"%OUT%\PageSignalAgentHost.exe" ^
    /win32manifest:"%SRC%\app.manifest" ^
    /reference:"System.dll" ^
    /reference:"%OUT%\PageSignalAgent.dll" ^
    "%SRC%\Injector.cs"
if errorlevel 1 (echo [build] x64 host compile failed & exit /b 1)

if defined NO_X86 goto :done

echo [build] compiling PageSignalAgentHost.x86.exe (x86) ...
"%CSC32%" /nologo /target:exe /platform:x86 ^
    /out:"%OUT%\PageSignalAgentHost.x86.exe" ^
    /win32manifest:"%SRC%\app.manifest" ^
    /reference:"System.dll" ^
    /reference:"%OUT%\PageSignalAgent.dll" ^
    "%SRC%\Injector.cs"
if errorlevel 1 (echo [build] x86 host compile failed & exit /b 1)

:done
echo [build] done. Artifacts in %OUT%
exit /b 0
