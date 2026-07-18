# C# native agent and process injector

This directory contains the managed native agent, a graphical Windows process
injector, architecture-specific injector hosts, and native CLR bootstraps.

## Portable outputs

```text
dll\dist\PageSignalInjector.exe
dll\dist\PageSignalAgent.dll
dll\dist\PageSignalAgentHost.exe
dll\dist\PageSignalAgentHost.x86.exe
dll\dist\PageSignalBootstrap.x64.dll
dll\dist\PageSignalBootstrap.x86.dll
```

Keep all six files together when copying the injector to another PC.
`PageSignalInjector.exe` is AnyCPU: it runs as x86 on 32-bit Windows and x64 on
64-bit Windows. It detects each selected process and automatically launches the
matching host with the matching bootstrap DLL.

The portable package targets Windows 10/11 x86 or x64 with .NET Framework 4.x.
ARM64-native, protected, anti-cheat, DRM, secure-desktop, and system-protected
processes are not supported.

## Graphical injector

From the repository root:

```bat
start_injector.bat
```

Or open `dll\dist\PageSignalInjector.exe` directly. The window provides:

- a searchable list of running processes;
- process name, PID, architecture, window title, session, start time, and path;
- automatic refresh every five seconds;
- x86/x64 host and bootstrap selection;
- one-click injection;
- an administrator retry when Windows denies access;
- clear errors for unsupported or exited processes.

Select a trusted process and choose **Inject PageSignal**. A successful load
starts `PageSignal.NativeAgent.Agent` inside that process; the agent then
registers with the Control Center as `native-input-client` and follows the same
reconnect plan as the standalone native client.

Run only one native implementation per session. The Python EXE, normal C# host,
and injected DLL are alternative owners of the same native role.

## Build

```bat
capture_client_agent\dll\build.bat
```

The build uses the .NET Framework compilers included with Windows for the
managed DLL, AnyCPU UI, and x64/x86 hosts. When Visual Studio C++ build tools are
available, it rebuilds both CLR bootstrap DLLs. Otherwise it validates and uses
the reviewed prebuilt bootstrap files already in `dist`.

The build finishes by running the graphical injector's non-interactive
`--self-test`, which verifies the complete architecture-specific package.

## Runtime behavior

The native agent:

1. Searches upward for `.env` and applies process-environment overrides.
2. Builds a direct/relay/auto endpoint plan.
3. Opens a bounded WebSocket handshake and registers its capabilities.
4. Handles capture, screen stream, OS input, popup, and file messages.
5. Serializes every WebSocket send through one semaphore.
6. Stops stream tasks and unbinds popup callbacks when a socket closes.
7. Repeats the endpoint plan until `Agent.Stop()` or process termination.

The public managed entry points are:

```csharp
PageSignal.NativeAgent.Agent.StartBackground();
PageSignal.NativeAgent.Agent.Start();
PageSignal.NativeAgent.Agent.Stop();
```

`StartBackgroundFromBootstrap(string)` is the signature-compatible adapter used
by `ICLRRuntimeHost.ExecuteInDefaultAppDomain`; normal callers should use the
three methods above.

## How injection starts the managed agent

The selected architecture-specific host performs a `LoadLibraryW` injection
using only the required process rights. The matching native bootstrap then:

1. starts or attaches to .NET Framework CLR v4 inside the target;
2. loads `PageSignalAgent.dll` from the portable injector directory;
3. invokes `StartBackgroundFromBootstrap` outside the loader lock;
4. returns while the managed agent reconnects in its background thread.

Loading `PageSignalAgent.dll` directly with `LoadLibraryW` is not supported;
the native bootstrap is required for arbitrary native target processes.

## CLI compatibility

The existing command line remains available for automation:

```bat
PageSignalAgentHost.exe ui
PageSignalAgentHost.exe list chrome
PageSignalAgentHost.exe inject 12345
PageSignalAgentHost.exe inject notepad.exe --wait=30
PageSignalAgentHost.exe inject chrome --all
PageSignalAgentHost.exe run
```

When no DLL path is supplied, the host chooses
`PageSignalBootstrap.x64.dll` or `PageSignalBootstrap.x86.dll` from the target
architecture. An architecture mismatch delegates to the sibling host.

## Security boundary

Injection uses `OpenProcess`, `VirtualAllocEx`, `WriteProcessMemory`, and
`CreateRemoteThread`. Antivirus products may classify an unsigned injector as
potentially unwanted software. Do not bypass endpoint protection. Sign and
allow-list reviewed artifacts through the normal organizational process, or use
the non-injection `run` mode.

Only inject software you own or are explicitly authorized to test. The tool
does not attempt to bypass protected-process, anti-cheat, DRM, or secure-desktop
controls.

## Verification

`verify.bat` compiles every managed/native artifact, runs the injector package
self-test, executes the x64 host help smoke, and validates x86 artifacts
statically. Executing the x86 injector remains opt-in because endpoint
protection may block unsigned injection tooling:

```bat
verify.bat --x86-runtime
```

Use that option only on an approved disposable test machine.

## Capture limits

The C# path uses GDI capture with layered-window support. Hardware-only or
protected content can still produce black frames. Use the Python client for
DXGI fallback. No user-mode implementation can bypass DRM, secure desktop,
display-affinity protections, or another user's protected session.
