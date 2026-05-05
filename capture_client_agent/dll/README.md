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
dll/
├── build.bat                       Compile script (uses Framework csc.exe — no VS needed)
├── dist/                           Build output (both bitnesses)
│   ├── PageSignalAgent.dll         Managed agent (AnyCPU — same DLL works in x64/x86 hosts)
│   ├── PageSignalAgentHost.exe     x64 host / injector (primary on 64-bit Windows)
│   └── PageSignalAgentHost.x86.exe x86 host / injector (used to reach 32-bit targets)
└── src/
    ├── Agent.cs                    Public entry: Agent.Start / StartBackground / Stop
    ├── Resolver.cs                 Endpoint discovery
    ├── WireProtocol.cs             Binary envelope + JSON helpers
    ├── ScreenCapture.cs            PNG/JPEG capture + streaming task
    ├── InputDispatcher.cs          SendInput-based mouse/keyboard
    ├── Logger.cs                   Optional debug log (PAGESIGNAL_DEBUG=1)
    ├── Injector.cs                 PageSignalAgentHost.exe entry point + injector
    └── bootstrap.cpp               (optional) C++ CLR-bootstrap shim — see “True injection”
```

## Architecture support — x86 and x64

The build produces **both** bitnesses out of the box:

| Artifact | Bitness | Used for |
|---|---|---|
| `PageSignalAgentHost.exe`      | x64 (Amd64) | Running the agent + injecting into x64 targets |
| `PageSignalAgentHost.x86.exe`  | x86         | Injecting into 32-bit targets (legacy apps, games, some browsers' helpers) |
| `PageSignalAgent.dll`          | AnyCPU (MSIL) | Same managed DLL is loaded by either bitness |

Windows requires the injecting process to **match the bitness of the target**
(`CreateRemoteThread` cannot cross the WoW64 boundary). The host handles this
for you:

- The injector inspects the target with `IsWow64Process`.
- On a mismatch it **automatically re-launches the sibling host** (`x86` ↔ `x64`)
  next to it and forwards `inject <pid> <dll>`. The child's exit code is returned
  verbatim.
- If the sibling EXE isn't present, you get exit code `12` and a hint to copy /
  rebuild the missing variant.

Keep both EXEs side-by-side in `dist\`; that's all that's needed for transparent
dual-arch operation.

## Robustness notes

- **PerMonitorV2 DPI awareness**: both host EXEs ship with an embedded
  [`app.manifest`](src/app.manifest) declaring `PerMonitorV2,PerMonitor`, and
  `Agent.StartBackground` additionally calls `SetProcessDpiAwarenessContext`
  as a belt-and-braces fallback (matters when the managed DLL is **injected**
  into a third-party EXE whose own manifest takes precedence). Result:
  screen-capture pixel dimensions and pointer coordinates match the user's
  *physical* display on HiDPI / scaled monitors instead of getting silently
  virtualised by the system DPI scaler.
- **`SeDebugPrivilege`** is enabled at host startup (best-effort). When you run
  the host from an **elevated** prompt this lets the injector reach elevated and
  cross-session targets that would otherwise refuse `OpenProcess`.
- **Distinct exit codes** on failure: `4` DLL not found, `5` `OpenProcess`,
  `6` `LoadLibraryW` resolve, `7` `VirtualAllocEx`, `8` `WriteProcessMemory`,
  `9` `CreateRemoteThread`, `10` remote `LoadLibraryW` returned NULL,
  `11` one or more PIDs failed during `--all`, `12` arch mismatch with no
  sibling host available.
- **Resource hygiene**: every Win32 handle and remote allocation is released in
  a `try/finally`, including when the remote thread call fails.
- **`--wait[=seconds]`** polls until the named process appears (default 60s),
  useful for hooking apps right after launch.
- **`--all`** loops over every running match and reports a non-zero exit if any
  individual injection failed.

## Robust screen capture

The C# `BitBlt` path (in [src/ScreenCapture.cs](src/ScreenCapture.cs)) is now
invoked with the `SRCCOPY | CAPTUREBLT` flag combination so **layered /
transparent windows** (notification toasts, tooltips, some IME popups) are
included in the capture instead of being silently dropped by GDI+.

A cheap pixel-grid sample (`LooksAllBlack`) checks every captured frame; when
GDI is defeated by hardware-accelerated content (videos, games,
GPU-rasterized Chrome) it logs a clear warning so operators know to switch to
the Python agent (which has the DXGI Desktop Duplication fallback via
`dxcam` — see [../README.md](../README.md#robust-screen-capture-no-more-black-frames-on-videos--games)).

Things the C# host **cannot** capture in any user-mode code path — these are
deliberate Windows protections, not bugs:
`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` windows, DRM-protected
video (Widevine/PlayReady), the UAC secure desktop, and other-session
windows. Only a kernel driver bypasses these.

## Build

Open any cmd / PowerShell prompt and run:

```powershell
cd capture_client_agent\dll
.\build.bat
```

Requirements (already present on a typical Windows 10/11 dev box):

- `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` (.NET Framework 4.x, x64)
- `C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe`   (.NET Framework 4.x, x86)
- `System.Web.Extensions.dll` (ships with the framework — used for JSON)

Both `csc.exe` variants ship in-box on Windows; the build script will warn and
skip the x86 host if Framework (32-bit) isn't present, but you'll lose the
ability to inject into 32-bit processes.

No Visual Studio, no .NET SDK, no NuGet packages.

## Code signing (optional, free, self-signed)

Fresh installs may trigger SmartScreen / AV "unknown publisher" warnings the
first time `PageSignalAgentHost.exe` runs. Eliminate them on managed machines
with a **self-signed code-signing cert** — no Windows SDK, no `signtool`, no
paid certificate authority required:

```powershell
powershell -ExecutionPolicy Bypass -File capture_client_agent\sign.ps1
```

What the script does (idempotent — safe to re-run):

1. Creates (or reuses) a SHA-256 RSA-2048 cert `CN=PageSignal Self-Signed` in
   `Cert:\CurrentUser\My`, valid 5 years.
2. Signs every built artifact in `dll/dist/` and `exe/dist/` with
   `Set-AuthenticodeSignature -HashAlgorithm SHA256 -IncludeChain All` plus a
   public RFC-3161 timestamp from DigiCert (so signatures stay valid after the
   cert expires).
3. Enrols the cert into `CurrentUser\TrustedPublisher` and `CurrentUser\Root`
   so Windows trusts the chain. The Root install pops a one-time Windows
   security dialog — click **Yes** to make `Get-AuthenticodeSignature` report
   `Status = Valid`. If you click No the binaries are still signed and
   timestamped (`Status = UnknownError`); re-run and accept later to fix.

Deploy the same cert to other machines without re-running the script:

```powershell
Export-Certificate -Cert (Get-Item Cert:\CurrentUser\My\<thumbprint>) -FilePath PageSignal-SelfSigned.cer
# then on each target machine:
Import-Certificate -FilePath PageSignal-SelfSigned.cer -CertStoreLocation Cert:\CurrentUser\TrustedPublisher
Import-Certificate -FilePath PageSignal-SelfSigned.cer -CertStoreLocation Cert:\CurrentUser\Root
```

> Self-signed certs work **only on machines that trust them**. They are perfect
> for internal / kiosk / dev fleets but do **not** replace an EV / OV cert for
> anonymous public distribution.

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
sequence, enables `SeDebugPrivilege` on startup, and verifies that host/target
architectures match before touching the remote process. On a mismatch it tries
to re-launch its sibling-bitness host (`PageSignalAgentHost.exe` ↔
`PageSignalAgentHost.x86.exe`) automatically; you only need to keep both files
in the same folder. The third positional argument tells it *which* DLL to load:

- **Native target process (notepad, explorer, a game, anything)** — the target
  has no CLR, so loading `PageSignalAgent.dll` directly does nothing useful.
  Pass the **CLR-bootstrap shim** instead (see next section).
- **Managed (.NET Framework) target process** — the CLR is already up and
  `LoadLibrary` of the managed DLL will trigger `_CorDllMain`. After loading,
  start the agent by re-injecting a tiny call into
  `PageSignal.NativeAgent.Agent.StartBackground` (use any managed-injector
  technique, e.g. an extra remote thread that calls into your own initializer).

The host requires the **same or higher privileges than the target process**
(use an elevated prompt for elevated/service targets). Architecture matching is
handled automatically as long as both `PageSignalAgentHost.exe` (x64) and
`PageSignalAgentHost.x86.exe` (x86) live in the same folder — which is what
`build.bat` produces by default.

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

Architecture must match the target process. With both prebuilt hosts present in
`dist\`, the injector relays automatically. If you embed the agent in a
third-party EXE, build it for the bitness that matches the host you intend to
run in (`/platform:x64`, `/platform:x86`, or leave the default `anycpu` for
libraries that are loaded into either).

## Limitations vs. the Python client

- Screen-share streaming sends full keyframes only (no partial dirty-region
  frames). Bandwidth is higher; protocol is unchanged.
- Multi-monitor capture grabs the primary display only (the Python client does
  the same).
- File reception is intentionally not implemented (the Chrome extension owns it,
  same as the Python agent).
