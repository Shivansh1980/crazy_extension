# Page Signal Capture

Page Signal Capture is a browser-to-desktop capture and control system. It has
four cooperating runtimes:

| Runtime | Purpose |
| --- | --- |
| Chrome extension | Full-page browser capture, browser clipboard writes, page popup, and browser-tab streaming |
| Capture Control Center | Tk desktop UI, direct WebSocket server or outbound relay client, image/file storage, and remote controls |
| Native agent | Desktop capture, OS mouse/keyboard input, native popup, and native screen streaming |
| Relay server | Optional authenticated pairing when the GUI and clients cannot use the same localhost connection |

Every long-lived client reconnects until it is intentionally stopped. Network
connections can still be interrupted by sleep, Wi-Fi changes, process restarts,
or server outages; the reliability guarantee is automatic detection and
recovery, not an impossible claim that a physical connection never drops.

## Quick start on Windows

Prerequisites:

- Windows 10 or 11
- Python 3.11 or newer
- Node.js 20 or newer
- Chrome, Edge, or Brave

Run the one-time setup from the repository root:

```bat
setup.bat --native
```

This creates the Python virtual environment, installs version-bounded runtime
dependencies, builds the extension, and rebuilds the C# DLL, graphical process
injector, x64/x86 hosts, and x64/x86 CLR bootstrap DLLs. Use `setup.bat --all`
when you also want the standalone PyInstaller EXE.

Load the extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select the `dist` directory.

Start the complete local stack:

```bat
start_gui.bat --with-native
```

The GUI starts in direct mode on `ws://127.0.0.1:8765`. The extension and
native client reconnect automatically when they start before the GUI or when
the GUI is restarted.

## Daily commands

| Action | Command |
| --- | --- |
| Start only the control center | `start_gui.bat` |
| Start control center plus supervised native agent | `start_gui.bat --with-native` |
| Start the supervised native agent | `capture_client_agent\start.bat` |
| Start the native agent hidden | `capture_client_agent\start.bat --silent` |
| Open graphical process injector | `start_injector.bat` |
| Build the extension | `build_extension.bat` |
| Build C# DLL and both hosts | `capture_client_agent\dll\build.bat` |
| Build standalone Python EXE | `capture_client_agent\exe\build.bat` |
| Run all normal verification | `verify.bat` |
| Verify and rebuild the standalone EXE | `verify.bat --all` |

`start_gui.bat` fingerprints `requirements.txt`, so normal launches no longer
run package installation when the environment is already current.

## Configuration

Copy `.env.example` to `.env` only when the defaults need to change. `.env` is
ignored by Git.

Important settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MODE` | `direct` | Control Center transport: `direct` or `relay` |
| `BRIDGE_HOST` | `127.0.0.1` | Direct-mode listen host |
| `BRIDGE_PORT` | `8765` | Direct-mode listen port |
| `SESSION_ID` | `default` | Pairing key shared by relay clients |
| `RELAY_URL` | empty | Relay WebSocket URL |
| `RELAY_USERNAME` | empty | Prefilled relay login name; password is requested in the UI |
| `WEBSOCKET_RESOLVER_URL` | project default | Primary optional endpoint resolver |
| `WEBSOCKET_SECONDARY_RESOLVER_URL` | project default | Secondary optional endpoint resolver |
| `NATIVE_CONNECTION_MODE` | follows `MODE`/auto | Native agent override: `direct`, `relay`, or `auto` |
| `NATIVE_BRIDGE_URL` | local bridge | Native direct endpoint override |

The extension Options page stores its own direct URL, resolver URL, connection
mode, relay URL, and session ID. Applying settings performs a clean reconnect.
Resolver responses may be a plain URL or JSON containing `websocketUrl`,
`webSocketUrl`, `bridgeUrl`, `url`, or `targetUrl`.

## Reliability model

The connection lifecycle follows these rules:

1. A socket must register before any business or binary frame is accepted.
2. Main extension, native agent, and browser screen stream use distinct roles.
   A stream reconnect cannot replace the main extension connection.
3. Browser handshakes are bounded to 12 seconds. Failed extension reconnects
   back off from 5 to 30 seconds and retry immediately when the browser returns
   online.
4. Direct and relay servers use WebSocket ping/pong health checks and a 64 MiB
   frame limit. Malformed frames are isolated to the sending peer.
5. The browser screen stream reconnects independently while tab capture stays
   active. The GUI shows the interruption without closing the viewer.
6. The Python and C# native clients serialize concurrent popup, capture, and
   streaming sends over their shared socket.
7. Extension responses are queued while its direct socket is disconnected, so
   an in-flight direct request can complete after reconnect. Relay transport
   loss fails already-sent requests promptly because side effects cannot be
   replayed safely and the relay does not persist responses without a GUI.
8. Relay authentication failures intentionally pause reconnect attempts to
   avoid account lockout. The running GUI prompts for corrected credentials and
   resumes the same reconnect loop after submission.
9. Intentional actions such as disabling the extension bridge, closing the GUI,
   stopping screen share, or stopping the native supervisor do not reconnect.
10. The Control Center derives available workflows from each registered client's
    capability list. Controls disappear on disconnect and return after a capable
    client registers again; hidden actions are also blocked at their shortcut
    handlers.

See [docs/RELIABILITY.md](docs/RELIABILITY.md) for protocol ownership and
failure-recovery details.

## Architecture

```text
src/
  domain/                 Extension models and ports
  application/            Capture and bridge orchestration
  infrastructure/         Chrome and storage adapters
  background/             Manifest V3 service worker
  offscreen/              Persistent main WebSocket client
  screen-share/           Independent tab-frame stream client
  options/                Extension settings and status UI

capture_control_center/
  domain/                 Models and transport protocols
  application/            UI-facing controller
  infrastructure/         Direct bridge, relay client, wire protocol, stores
  presentation/           Capability-driven Tk UI and relay login dialog

capture_client_agent/
  connection_config.py    Shared Python native configuration
  client.py               Reconnecting Python/PyInstaller agent
  dll/src/                Reconnecting C# agent, popup, capture, input, host

live_server/
  live_server.py          Authenticated role-based relay

tests/                    Unit and localhost reconnect integration tests
```

`BridgeTransport` is the Control Center boundary. Direct and relay transports
implement the same request/event contract, while shared wire helpers keep popup,
file, capture, and screen status shapes identical.

## Feature flows

Full-page browser capture:

1. The GUI sends `capture.request`.
2. The extension service worker uses Chrome DevTools Protocol
   `Page.captureScreenshot` with `captureBeyondViewport`.
3. The offscreen client returns a binary envelope.
4. The GUI saves the image under `images` and updates its preview.

Desktop capture and control:

1. The native client registers `screen-capture` and `os-input` capabilities.
2. The GUI prefers native desktop capture when available and uses the extension
   as the browser-only fallback.
3. Native capture tries DXGI (`dxcam`) and then GDI (`mss`) on Windows.

Clipboard and popup:

1. GUI clipboard text is written by the extension offscreen document.
2. The extension does not intercept page `paste`, `copy`, `cut`, or keyboard
   events. Normal Ctrl+V behavior, including ChatGPT image paste, remains owned
   by the page.
3. Popup and file commands prefer the browser popup, then use the native popup
   when the extension is unavailable.

Screen streaming:

1. Native streaming uses the main native connection.
2. Browser tab streaming uses a separate `screen-share-stream` connection.
3. Relay routing recognizes that role and forwards its frames without changing
   extension presence in the GUI.

Dynamic Control Center UI:

1. Extension and native registrations include explicit capabilities.
2. Browser clipboard controls appear only with `clipboard.write`.
3. Capture, popup, file, screen-share, and remote-control actions appear when at
   least one connected provider advertises the required capability.
4. Native-only Ctrl+V control types clipboard text through OS input; browser
   paste continues to use the extension's page-aware paste path.
5. Disconnect events recompute the complete UI in one pass, including action
   rows, status rows, text tools, popup history, and live-view controls.

## Verification

Run:

```bat
verify.bat
```

It performs:

- strict TypeScript type checking;
- Python unit and localhost reconnect integration tests;
- Python byte compilation;
- extension production build;
- C# DLL, AnyCPU injector UI, x64/x86 host, and x64/x86 bootstrap builds;
- injector package self-test, x64 host startup smoke, and x86 artifact validation.

`verify.bat --all` additionally rebuilds the standalone
`PageSignalNativeClient.exe`. Browser permission prompts, real desktop pixels,
and OS input injection remain manual end-to-end checks because they require an
interactive desktop.

`verify.bat --x86-runtime` explicitly executes the x86 injector help smoke.
Unsigned injection tooling can trigger endpoint protection, so that check is
opt-in and should only run on an approved test machine.

## Build outputs

- Extension: `dist`
- Managed DLL: `capture_client_agent\dll\dist\PageSignalAgent.dll`
- x64 host: `capture_client_agent\dll\dist\PageSignalAgentHost.exe`
- x86 host: `capture_client_agent\dll\dist\PageSignalAgentHost.x86.exe`
- Graphical injector: `capture_client_agent\dll\dist\PageSignalInjector.exe`
- x64 bootstrap: `capture_client_agent\dll\dist\PageSignalBootstrap.x64.dll`
- x86 bootstrap: `capture_client_agent\dll\dist\PageSignalBootstrap.x86.dll`
- Standalone native EXE: `capture_client_agent\exe\dist\PageSignalNativeClient.exe`

Keep every file in `capture_client_agent\dll\dist` together when moving the
injector to another Windows PC. `PageSignalInjector.exe` is AnyCPU and selects
the matching host/bootstrap automatically for x86 or x64 targets.

## Troubleshooting

- Extension remains disconnected: open its Options page and inspect the target
  and last message. Verify the session ID and click **Reconnect bridge**.
- GUI is waiting: start the extension or native agent; the GUI intentionally
  does not invent a connected client before registration.
- Relay login failed: enter corrected credentials in the dialog shown by the
  running GUI. Reconnect resumes without restarting the application.
- Native client repeatedly restarts: inspect
  `%TEMP%\PageSignalNativeClient.out.log`.
- Injector cannot open a process: accept its administrator retry only when the
  target is trusted and injection is approved. Protected processes, anti-cheat,
  secure desktop, and ARM64-native targets are intentionally unsupported.
- EXE and DLL both running: stop one. They are alternative implementations of
  the single `native-input-client` role and should not compete in one session.
- x86 host was blocked by antivirus: do not bypass the alert. Use normal host
  `run` mode or sign and allow-list reviewed injector artifacts through your
  security process.
- Video/game capture is black: install `dxcam`; DRM, secure desktop, lock screen,
  and `WDA_EXCLUDEFROMCAPTURE` windows cannot be captured by user-mode tools.
- Ctrl+V still behaves like an older build: reload the unpacked extension and
  refresh already-open tabs once. Old anonymous listeners disappear only when
  those page contexts are reloaded.

## Security notes

- Keep direct mode bound to `127.0.0.1` unless LAN exposure is intentional.
- Use `wss://` for remote relay access and terminate TLS at the deployment edge.
- Relay GUI credentials are authenticated with bcrypt; peer registration uses
  the configured session ID.
- `chrome.debugger` may display Chrome's debugging indicator during full-page
  capture. That permission enables single-pass, high-fidelity screenshots.

Relay deployment details are in [live_server/README.md](live_server/README.md).
