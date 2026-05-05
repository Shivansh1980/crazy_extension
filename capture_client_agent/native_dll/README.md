# PageSignal native agent — DLL build

This folder contains a third packaging of the PageSignal native client (alongside
the Python module and PyInstaller EXE that already live in
[capture_client_agent](../)). It is a **managed C# DLL** plus a small host /
injector EXE, so the agent can be **loaded into another running process** rather
than only run as a standalone program.

The C# implementation mirrors the Python client's behaviour:

| Capability | Source of truth (Python) | C# port |
|---|---|---|
| Bridge resolver chain (Pastebin → GitHub raw → local `server_url.txt` → localhost) | [client.py](../client.py) | [src/Resolver.cs](src/Resolver.cs) |
| WebSocket connect + `client.register` + dispatch loop | [client.py](../client.py) | [src/Agent.cs](src/Agent.cs) |
| Full‑screen PNG capture (`capture.request` → `capture.result.binary`) | [screen_capture.py](../screen_capture.py) | [src/ScreenCapture.cs](src/ScreenCapture.cs) |
| 10 FPS JPEG screen-share streaming (`screen-share.start` / `.stop` / `.frame.binary`) | [screen_capture.py](../screen_capture.py) | [src/ScreenCapture.cs](src/ScreenCapture.cs) |
| OS mouse + keyboard (`screen-share.input`, `screen-share.key`) | [input_dispatcher.py](../input_dispatcher.py) | [src/InputDispatcher.cs](src/InputDispatcher.cs) |
| 4‑byte big‑endian length-prefixed binary envelopes | [client.py](../client.py) | [src/WireProtocol.cs](src/WireProtocol.cs) |

> **Note** — the C# screen-share streamer sends full keyframes at 10 FPS instead
> of the Python implementation's dirty-region partial frames. The wire format is
> identical, so the bridge / GUI handle both transparently.

## Layout

```
native_dll/
├── build.bat                  Compile script (uses Framework csc.exe — no VS needed)
├── dist/                      Build output
│   ├── PageSignalAgent.dll    Managed agent (the "DLL")
│   └── PageSignalAgentHost.exe Host / injector
└── src/
    ├── Agent.cs               Public entry: Agent.Start / StartBackground / Stop
    ├── Resolver.cs            Endpoint discovery
    ├── WireProtocol.cs        Binary envelope + JSON helpers
    ├── ScreenCapture.cs       PNG/JPEG capture + streaming task
    ├── InputDispatcher.cs     SendInput-based mouse/keyboard
    ├── Logger.cs              Optional debug log (PAGESIGNAL_DEBUG=1)
    ├── Injector.cs            PageSignalAgentHost.exe entry point
    └── bootstrap.cpp          (optional) C++ CLR-bootstrap shim — see "True injection"
```

## Build

Open any cmd / PowerShell prompt and run:

```powershell
cd capture_client_agent\native_dll
.\build.bat
```

Requirements (already present on a typical Windows 10/11 dev box):

- `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` (.NET Framework 4.x)
- `System.Web.Extensions.dll` (ships with the framework — used for JSON)

No Visual Studio, no .NET SDK, no NuGet packages.

## Use cases

### 1. Run as a normal foreground agent

Drop-in replacement for the Python module / PyInstaller EXE:

```powershell
.\dist\PageSignalAgentHost.exe          # or "run"
```

Press Ctrl+C to stop. Set `$env:PAGESIGNAL_DEBUG = "1"` first to enable
diagnostic logging at `%TEMP%\PageSignalNativeAgent.log`.

### 2. Inject the agent into another process

You can target by **PID** or by **process name** (with or without `.exe`):

```powershell
# By PID
.\dist\PageSignalAgentHost.exe inject 12345

# By name — picks the most recently started match
.\dist\PageSignalAgentHost.exe inject notepad.exe
.\dist\PageSignalAgentHost.exe inject notepad

# Inject into every running instance with that name
.\dist\PageSignalAgentHost.exe inject chrome --all

# Wait up to 30s for the process to appear, then inject
.\dist\PageSignalAgentHost.exe inject MyGame.exe --wait=30

# List running processes (optionally filter by name substring)
.\dist\PageSignalAgentHost.exe list
.\dist\PageSignalAgentHost.exe list chrome
```

The optional second positional argument is the **DLL to inject** (defaults to
`PageSignalBootstrap.dll` next to the host EXE):

```powershell
.\dist\PageSignalAgentHost.exe inject notepad.exe .\dist\PageSignalBootstrap.dll
```

The injector performs the standard `OpenProcess` →
`VirtualAllocEx` → `WriteProcessMemory` → `CreateRemoteThread(LoadLibraryW)`
sequence and verifies that host/target architectures match before touching the
remote process. The third argument tells it *which* DLL to load:

- **Native target process (notepad, explorer, a game, anything)** — the target
  has no CLR, so loading `PageSignalAgent.dll` directly does nothing useful.
  Pass the **CLR-bootstrap shim** instead (see next section).
- **Managed (.NET Framework) target process** — the CLR is already up and
  `LoadLibrary` of the managed DLL will trigger `_CorDllMain`. After loading,
  start the agent by re-injecting a tiny call into
  `PageSignal.NativeAgent.Agent.StartBackground` (use any managed-injector
  technique, e.g. an extra remote thread that calls into your own initializer).

The injector requires the host EXE to run with **the same or higher privileges
than the target process** (use an elevated prompt for elevated targets) and the
**matching architecture** — the prebuilt host is x64, so it can only inject
into x64 processes. Rebuild with `/platform:x86` in `build.bat` to target 32‑bit
hosts.

### 3. True injection into arbitrary native processes

Genuine cross-process injection of a managed DLL into a *native* host needs a
small C++ shim that:

1. Boots the .NET Framework 4.x CLR via `mscoree` (`CLRCreateInstance` →
   `ICLRMetaHost::GetRuntime("v4.0.30319")` → `ICLRRuntimeHost::Start`).
2. Calls `ExecuteInDefaultAppDomain` on `PageSignal.NativeAgent.Agent.StartBackground`.

The complete source for that shim is provided as
[`src/bootstrap.cpp`](src/bootstrap.cpp). It is **not compiled by `build.bat`**
because no MSVC compiler was available on the build machine. Compile it from a
"x64 Native Tools Command Prompt for VS 2022" with:

```bat
cl /LD /EHsc /O2 src\bootstrap.cpp /Fe:dist\PageSignalBootstrap.dll mscoree.lib
```

Then inject the shim — it will pull `PageSignalAgent.dll` from the same folder:

```powershell
.\dist\PageSignalAgentHost.exe inject <PID> .\dist\PageSignalBootstrap.dll
```

## Public API (callable from any .NET host)

```csharp
using PageSignal.NativeAgent;

Agent.StartBackground();   // spawns a worker thread, returns immediately
// ... do other work ...
Agent.Stop();
```

Architecture must match the target process (compile and inject the **x64**
artifacts into x64 hosts; rebuild with `/platform:x86` in `build.bat` for 32-bit
targets).

## Limitations vs. the Python client

- Screen-share streaming sends full keyframes only (no partial dirty-region
  frames). Bandwidth is higher; protocol is unchanged.
- Multi-monitor capture grabs the primary display only (the Python client does
  the same).
- File reception is intentionally not implemented (the Chrome extension owns it,
  same as the Python agent).
