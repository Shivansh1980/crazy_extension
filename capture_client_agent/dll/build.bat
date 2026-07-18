@echo off
REM =====================================================================
REM Build the PageSignal native agent in BOTH bitnesses.
REM
REM Outputs (in dist\):
REM   PageSignalAgent.dll          managed agent (AnyCPU - works either way)
REM   PageSignalAgentHost.exe      x64 host / injector (primary on 64-bit Windows)
REM   PageSignalAgentHost.x86.exe  x86 host / injector (used to reach 32-bit targets)
REM   PageSignalInjector.exe       AnyCPU graphical process browser / injector
REM   PageSignalBootstrap.x64.dll  x64 CLR bootstrap loaded into target processes
REM   PageSignalBootstrap.x86.dll  x86 CLR bootstrap loaded into target processes
REM
REM Managed artifacts require only an in-box .NET Framework 4.x compiler:
REM   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe   (x64)
REM   C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe     (x86)
REM The script uses either compiler to produce all managed target architectures.
REM If MSVC is installed, both native bootstraps are rebuilt; otherwise the
REM reviewed prebuilt bootstrap DLLs in dist\ are validated and retained.
REM =====================================================================
setlocal EnableExtensions EnableDelayedExpansion
set CSC64=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set CSC32=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe
set CSC=

if exist "%CSC64%" set "CSC=%CSC64%"
if not defined CSC if exist "%CSC32%" set "CSC=%CSC32%"
if not defined CSC (
    echo [build] .NET Framework 4.x csc.exe was not found.
    exit /b 1
)

set HERE=%~dp0
set OUT=%HERE%dist
set SRC=%HERE%src
if not exist "%OUT%" mkdir "%OUT%"
if not exist "%HERE%build" mkdir "%HERE%build"

set AGENT_SRCS="%SRC%\Agent.cs" "%SRC%\InputDispatcher.cs" "%SRC%\Logger.cs" "%SRC%\NativePopup.cs" "%SRC%\Resolver.cs" "%SRC%\ScreenCapture.cs" "%SRC%\WireProtocol.cs"

echo [build] compiling PageSignalAgent.dll (AnyCPU) ...
"%CSC%" /nologo /target:library /platform:anycpu /unsafe ^
    /out:"%OUT%\PageSignalAgent.dll" ^
    /reference:"System.dll" ^
    /reference:"System.Core.dll" ^
    /reference:"System.Drawing.dll" ^
    /reference:"System.Windows.Forms.dll" ^
    /reference:"System.Web.Extensions.dll" ^
    %AGENT_SRCS%
if errorlevel 1 (echo [build] DLL compile failed & exit /b 1)

echo [build] compiling PageSignalAgentHost.exe (x64) ...
"%CSC%" /nologo /target:exe /platform:x64 ^
    /out:"%OUT%\PageSignalAgentHost.exe" ^
    /win32manifest:"%SRC%\app.manifest" ^
    /reference:"System.dll" ^
    /reference:"%OUT%\PageSignalAgent.dll" ^
    "%SRC%\Injector.cs"
if errorlevel 1 (echo [build] x64 host compile failed & exit /b 1)

echo [build] compiling PageSignalInjector.exe (AnyCPU WinForms) ...
"%CSC%" /nologo /target:winexe /platform:anycpu ^
    /out:"%OUT%\PageSignalInjector.exe" ^
    /win32manifest:"%SRC%\app.manifest" ^
    /reference:"System.dll" ^
    /reference:"System.Core.dll" ^
    /reference:"System.Drawing.dll" ^
    /reference:"System.Windows.Forms.dll" ^
    "%SRC%\InjectorUi.cs"
if errorlevel 1 (echo [build] injector UI compile failed & exit /b 1)

echo [build] compiling PageSignalAgentHost.x86.exe (x86) ...
"%CSC%" /nologo /target:exe /platform:x86 ^
    /out:"%OUT%\PageSignalAgentHost.x86.exe" ^
    /win32manifest:"%SRC%\app.manifest" ^
    /reference:"System.dll" ^
    /reference:"%OUT%\PageSignalAgent.dll" ^
    "%SRC%\Injector.cs"
if errorlevel 1 (echo [build] x86 host compile failed & exit /b 1)

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VSROOT="
if exist "!VSWHERE!" (
    for /f "usebackq delims=" %%I in (`"!VSWHERE!" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do if not defined VSROOT set "VSROOT=%%I"
)

if not defined VSROOT goto :use_prebuilt_bootstraps
set "VCVARS=!VSROOT!\VC\Auxiliary\Build\vcvarsall.bat"
if not exist "!VCVARS!" goto :use_prebuilt_bootstraps

echo [build] compiling PageSignalBootstrap.x64.dll ...
if not exist "%HERE%build\bootstrap-x64" mkdir "%HERE%build\bootstrap-x64"
call "!VCVARS!" x64 >nul
if errorlevel 1 (echo [build] failed to initialize the x64 MSVC environment & exit /b 1)
cl.exe /nologo /LD /EHsc /O2 /std:c++14 ^
    /Fo"%HERE%build\bootstrap-x64\bootstrap.obj" ^
    /Fd"%HERE%build\bootstrap-x64\bootstrap.pdb" ^
    /Fe:"%OUT%\PageSignalBootstrap.x64.dll" ^
    "%SRC%\bootstrap.cpp" ^
    /link /NOLOGO /IMPLIB:"%HERE%build\bootstrap-x64\PageSignalBootstrap.lib" /PDB:"%HERE%build\bootstrap-x64\PageSignalBootstrap-link.pdb" mscoree.lib
if errorlevel 1 (echo [build] x64 bootstrap compile failed & exit /b 1)

echo [build] compiling PageSignalBootstrap.x86.dll ...
if not exist "%HERE%build\bootstrap-x86" mkdir "%HERE%build\bootstrap-x86"
call "!VCVARS!" x86 >nul
if errorlevel 1 (echo [build] failed to initialize the x86 MSVC environment & exit /b 1)
cl.exe /nologo /LD /EHsc /O2 /std:c++14 ^
    /Fo"%HERE%build\bootstrap-x86\bootstrap.obj" ^
    /Fd"%HERE%build\bootstrap-x86\bootstrap.pdb" ^
    /Fe:"%OUT%\PageSignalBootstrap.x86.dll" ^
    "%SRC%\bootstrap.cpp" ^
    /link /NOLOGO /IMPLIB:"%HERE%build\bootstrap-x86\PageSignalBootstrap.lib" /PDB:"%HERE%build\bootstrap-x86\PageSignalBootstrap-link.pdb" mscoree.lib
if errorlevel 1 (echo [build] x86 bootstrap compile failed & exit /b 1)

:use_prebuilt_bootstraps
echo [build] validating portable bootstrap DLLs...
if not exist "%OUT%\PageSignalBootstrap.x64.dll" (
    echo [build] PageSignalBootstrap.x64.dll is missing. Install Visual Studio C++ build tools or restore the prebuilt artifact.
    exit /b 1
)
if not exist "%OUT%\PageSignalBootstrap.x86.dll" (
    echo [build] PageSignalBootstrap.x86.dll is missing. Install Visual Studio C++ build tools or restore the prebuilt artifact.
    exit /b 1
)

:verify_outputs
"%OUT%\PageSignalInjector.exe" --self-test
if errorlevel 1 (echo [build] injector UI self-test failed & exit /b 1)
echo [build] done. Artifacts in %OUT%
exit /b 0
