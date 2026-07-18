# Native clients

The native agent adds capabilities that a browser extension cannot reliably
provide: full-desktop capture, OS mouse/keyboard input, native screen
streaming, and a desktop popup fallback. All implementations use the same
WebSocket protocol and reconnect until intentionally stopped.

## Choose a client

| Client | Best use | Build |
| --- | --- | --- |
| C# host + DLL | Primary Windows runtime, smallest startup cost | `dll\build.bat` |
| Standalone Python EXE | Single-file fallback with DXGI capture support | `exe\build.bat` |
| Python module | Development inside this repository | No separate build |

Use only one native implementation for a session. The C# host/DLL, standalone
EXE, and Python module all register the same `native-input-client` role.

The launcher chooses the C# host first, then the standalone EXE, then the
Python module:

```bat
capture_client_agent\start.bat
capture_client_agent\start.bat --silent
```

The launcher supervises the selected process and restarts it three seconds
after a crash. Each client also has its own socket reconnect loop, so process
failure and network failure are recovered independently.

## Configuration

Clients search from their executable/current directory upward for `.env`.
Process environment variables override file values.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NATIVE_CONNECTION_MODE` | `MODE` or `auto` | `direct`, `relay`, or `auto` |
| `NATIVE_BRIDGE_URL` | local bridge | Explicit direct WebSocket URL |
| `BRIDGE_HOST` | `127.0.0.1` | Direct host when no URL is supplied |
| `BRIDGE_PORT` | `8765` | Direct port when no URL is supplied |
| `RELAY_URL` | empty | Relay fallback/target |
| `SESSION_ID` | `default` | Relay pairing session |
| `WEBSOCKET_RESOLVER_URL` | project resolver | Primary auto-mode resolver |
| `WEBSOCKET_SECONDARY_RESOLVER_URL` | project resolver | Secondary resolver |

Connection plans:

- `direct`: retry the configured direct bridge forever.
- `relay`: try the relay, then direct fallback attempts, then repeat.
- `auto`: try both resolvers, an upward `server_url.local.txt` or
  `server_url.txt`, direct fallback attempts, and an optional relay fallback.

Every failed endpoint waits five seconds before the next attempt. WebSocket
handshakes and messages are bounded, and popup/capture/stream sends are
serialized so concurrent tasks cannot corrupt a frame.

## Build and run

From the repository root:

```bat
setup.bat --native
start_gui.bat --with-native
```

Build one implementation directly:

```bat
capture_client_agent\dll\build.bat
capture_client_agent\exe\build.bat
```

Open the searchable x86/x64 process injector:

```bat
start_injector.bat
```

The graphical injector is an AnyCPU Windows application. Keep the complete
`capture_client_agent\dll\dist` folder together when moving it to another PC;
it contains the UI, managed agent, both hosts, and both CLR bootstraps.

Smoke-check the Python source or standalone EXE:

```bat
.venv\Scripts\python.exe -m capture_client_agent --version
capture_client_agent\exe\dist\PageSignalNativeClient.exe --version
```

## Native popup

The browser popup remains preferred while the extension is connected. The
native popup is the fallback when only a native agent is available.

- `Shift+Alt+P` toggles the native popup on Windows.
- Incoming files are stored below `client_uploads\native_popup` with safe,
  unique filenames.
- Outgoing text/files use `popup.message` and `popup-file.binary`.
- During a reconnect, the popup retains the selected content and asks the user
  to retry instead of sending through a stale socket.

## Capture behavior

The Python client uses `dxcam` first and `mss` as a fallback. It temporarily
demotes a backend that fails or returns a near-black frame. The C# client uses
GDI `BitBlt` with `CAPTUREBLT` and logs when a frame appears black.

User-mode clients cannot capture DRM-protected surfaces, the UAC secure
desktop, the lock screen, windows using `WDA_EXCLUDEFROMCAPTURE`, or another
user session without the required privileges.

## Diagnostics

Set `PAGESIGNAL_DEBUG=1` for detailed logs. The silent supervisor writes to:

```text
%TEMP%\PageSignalNativeClient.out.log
```

For DLL hosting and injection details, see [dll/README.md](dll/README.md).
