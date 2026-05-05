# Page Signal Capture

Page Signal Capture now consists of two cooperating applications:

- A Manifest V3 Chrome extension that maintains a resilient local WebSocket client in an offscreen document and captures full-page screenshots on demand.
- A Python desktop control center that exposes the WebSocket server, lets the user trigger captures from a GUI, previews the latest image, saves each screenshot into an `images` folder under the current working directory, can push raw text or code into the browser clipboard, and can show the same text inside a draggable in-page popup.

## Setup — first time on a fresh Windows machine

Pick the path that matches who you are. **Do these once**, then use the
day-to-day commands at the end.

### Path A — End user (no source code, just want it running)

Prereqs:

- Windows 10 / 11.
- Python 3.11+ on `PATH` (Microsoft Store install is fine — confirm with
  `python --version`).
- Google Chrome (or Edge / Brave).

Steps:

1. Clone or download this repo and open a PowerShell prompt in its root folder.
2. **Start the control center** — first run sets up the venv and installs every
   dependency automatically:
   ```powershell
   .\start_gui.bat
   ```
   This creates `.venv\`, runs `pip install -r requirements.txt` (which now
   includes the optional `dxcam` package on Windows for HW-accelerated screen
   capture — see [Robust desktop screen capture](#robust-desktop-screen-capture)),
   and launches the Tkinter GUI. Leave the window open; it is the WebSocket
   server.
3. **Build the Chrome extension** (only needed once unless `src/` changes):
   ```powershell
   .\build_extension.bat
   ```
   This requires Node.js 20+. It produces a `dist\` folder.
4. **Load the extension** in Chrome:
   - Go to `chrome://extensions`, enable **Developer mode** (top right).
   - Click **Load unpacked** and select the `dist\` folder produced in step 3.
   - The extension icon should appear and connect to the GUI within ~5 seconds.
5. **Start the native client** (needed for screen-share / OS input — *not*
   for browser screenshots, which the extension handles itself):
   ```powershell
   .\capture_client_agent\start.bat
   ```
   It runs supervised: if it ever crashes it auto-restarts after 3 s. For a
   detached, hidden, always-on launcher use:
   ```powershell
   .\capture_client_agent\start.bat --silent
   ```
   Logs land in `%TEMP%\PageSignalNativeClient.out.log`.

That's everything. Click **Capture screenshot** in the GUI to verify the
browser <-> server <-> agent loop.

### Path B — Developer (working on the source)

Same prereqs as Path A, plus:

- Node.js 20+.
- (Optional) Visual Studio Code or any editor.
- (Optional) The .NET Framework 4.x C# compiler — preinstalled on
  Win 10/11; only needed if you rebuild the C# DLL/host.

Steps:

```powershell
# 1. JS / extension deps + first build
npm.cmd install
npm.cmd run build              # or: .\build_extension.bat

# 2. Python deps + GUI (creates .venv automatically)
.\start_gui.bat

# 3. (optional) one-shot venv setup without launching the GUI
.\start_gui.bat --setup-only

# 4. (optional) rebuild the C# native agent (DLL + x64 + x86 hosts)
cd capture_client_agent\dll
.\build.bat
cd ..\..

# 5. (optional) rebuild the single-file PyInstaller exe of the native client
cd capture_client_agent\exe
.\build.bat
cd ..\..
```

Then load `dist\` in `chrome://extensions` (Developer mode → Load unpacked).

### Day-to-day commands

| You want to... | Command |
|---|---|
| Start the GUI + WebSocket server | `.\start_gui.bat` |
| Start the native client (visible, supervised) | `.\capture_client_agent\start.bat` |
| Start the native client (silent, detached, always-on) | `.\capture_client_agent\start.bat --silent` |
| Rebuild the Chrome extension after editing `src/` | `.\build_extension.bat` |
| Rebuild the C# agent after editing `dll\src\` | `.\capture_client_agent\dll\build.bat` |
| Rebuild the single-file native-client EXE | `.\capture_client_agent\exe\build.bat` |
| Verify the screen-capture chain (which backends are live) | `python -c "from capture_client_agent.capture_backends import get_backend_chain; print(get_backend_chain().available_backends)"` |

### Common first-run problems

- **GUI says "no client connected"**: the extension's offscreen document still
  needs to find a bridge endpoint. Either let the resolver chain run (it tries
  Pastebin → GitHub raw → `ws://127.0.0.1:8765` automatically with 5 s
  backoff) or open the extension Options page and set the URL manually.
- **Screenshots arrive but screen-share frames are black**: the foreground
  app is hardware-accelerated. Make sure `dxcam` installed cleanly
  (`pip show dxcam`); see
  [Robust desktop screen capture](#robust-desktop-screen-capture) for the
  full story and the deliberate Windows protections that no user-mode
  capture method can bypass.
- **`PageSignalAgentHost.exe` triggers SmartScreen**: expected for unsigned
  builds. See [capture_client_agent/dll/README.md](capture_client_agent/dll/README.md)
  for the self-signing PowerShell script.
- **`start.bat` keeps respawning the agent in a loop**: that's the supervisor
  doing its job (3 s restart on any exit). Check
  `%TEMP%\PageSignalNativeClient.out.log` for the actual error.

## Architecture

- `src/domain`: extension models and ports.
- `src/application`: extension orchestration services.
- `src/infrastructure`: Chrome adapters for capture, storage, and the offscreen bridge runtime.
- `src/offscreen`: persistent WebSocket client that reconnects automatically and forwards capture requests.
- `src/background`: service worker composition root that handles on-demand capture.
- `src/options`: extension configuration UI.
- `capture_control_center/domain`: Python-side data models.
- `capture_control_center/infrastructure`: Python WebSocket server and image persistence.
- `capture_control_center/application`: Python orchestration layer.
- `capture_control_center/presentation`: Tkinter GUI.

The browser APIs and GUI concerns stay behind focused abstractions so capture quality, bridge reliability, and desktop workflows can evolve independently.

## Capture flow

1. Start the Python GUI server.
2. The extension offscreen document checks the configured Pastebin resolver first and tries the latest resolved tunnel endpoint before anything else.
	If that resolver lookup or tunnel connection fails, it tries the GitHub raw fallback at `https://raw.githubusercontent.com/Shivansh1980/crazy_extension/refs/heads/main/server_url.txt`.
	If that also fails, it falls back to `ws://127.0.0.1:8765` and retries localhost every 5 seconds for up to 10 attempts.
	After those 10 localhost failures, it repeats the same cycle: Pastebin, then GitHub raw, then localhost.
3. The user clicks **Capture screenshot** in the Python GUI.
4. The Python server sends a WebSocket request to the extension.
5. The extension captures the active page with `chrome.debugger` and `Page.captureScreenshot` using `captureBeyondViewport`.
6. The Python app receives the image, saves it to `images/`, and renders a preview in the GUI.

Clipboard flow:

1. Paste any text or code into the advanced clipboard editor in the Python GUI.
2. Click **Send text to browser clipboard** or press `Ctrl+Enter`.
3. The Python server sends the exact raw string to the extension over the existing WebSocket bridge.
4. The offscreen extension document writes the content into the browser clipboard without trimming or reformatting it.
5. When the extension starts or when the active tab finishes loading, it also tries several fallback techniques to re-enable blocked page copy and paste behavior without stopping the rest of the extension if any technique fails.

Popup flow:

1. Use the same advanced editor in the Python GUI and click **Send text to browser popup**.
2. The extension injects or updates a floating popup on the active page.
3. The popup stays above the page, can be dragged, resized, minimized into a compact icon, restored, copied from, or closed completely.
4. Sending again updates the existing popup text instead of creating duplicates.
5. The Python GUI shows the current popup state reported by the extension: open, minimized, or not present.
6. You can also press `Alt+P` in Chrome to toggle the popup on the active tab: if it is missing it opens, and if it is already present it closes.

File transfer flow:

1. Click **Send File to Browser** in the Python GUI and choose any file.
2. The Python bridge sends the selected file to the extension over the existing WebSocket bridge.
3. The extension first tries the browser downloads API and falls back to a tab-triggered save flow when the browser does not expose that API.
4. If the browser supports managed downloads, its normal uniquify behavior is used instead of overwriting an older file.

## Why this capture strategy

The extension still uses the Chrome DevTools Protocol through `chrome.debugger` and `Page.captureScreenshot`. That remains the fastest high-fidelity path for full-page screenshots because it avoids scroll-and-stitch artifacts and preserves device-aware detail that downstream AI analysis needs.

To avoid oversized screenshots that can fail on extremely long pages, the capture gateway computes an optimal scale using both a maximum dimension cap and a maximum pixel-area cap.

## Robust desktop screen capture

The native client agent (used for the screen-share feature, not browser-page
capture) goes through a fallback chain so hardware-accelerated content
(videos, games, GPU-rasterized Chrome) is captured instead of returning black
frames:

1. **DXGI Desktop Duplication** (via the optional `dxcam` package) — catches
   HW-accel content and layered windows.
2. **GDI BitBlt** (`mss`) — universal fallback for everything else.

The chain auto-demotes a backend that returns black frames or fails, then
re-promotes after a short cooldown so transient GPU/RDP events don't
permanently disable the fast path. Full documentation lives in
[capture_client_agent/README.md](capture_client_agent/README.md#robust-screen-capture-no-more-black-frames-on-videos--games)
and the C# DLL equivalent in
[capture_client_agent/dll/README.md](capture_client_agent/dll/README.md#robust-screen-capture).

What **cannot** be captured by any user-mode method (deliberate Windows
protections — list these up-front to clients):
`WDA_EXCLUDEFROMCAPTURE` windows, DRM video (Widevine/PlayReady), the UAC
secure desktop, and other-session windows.

## Local development

```bash
npm.cmd install
npm.cmd run build
npm.cmd run gui
```

You can also launch the Python GUI directly with:

```bash
.venv\Scripts\python.exe -m capture_control_center.app
```

Load the generated `dist` folder through `chrome://extensions` with Developer Mode enabled.

## Deployment on another Windows machine

Python GUI:

1. Install Python 3.11+ and make sure the `py` launcher or `python` command is available.
2. Run `start_gui.bat` from the project root.
3. On the first run it creates `.venv`, installs `requirements.txt`, and then starts the GUI.

Extension:

1. Install Node.js 20+.
2. Run `build_extension.bat` from the project root.
3. Load the generated `dist` folder through `chrome://extensions`.

Validation-only setup:

```bat
start_gui.bat --setup-only
build_extension.bat
```

## Runtime behavior

- The extension keeps a persistent offscreen WebSocket client and retries every 5 seconds if the Python server restarts or the tunnel changes.
- The extension uses a resolver-first reconnect strategy: it checks Pastebin first, then the GitHub raw fallback, then localhost for up to 10 attempts, and repeats that cycle until a bridge endpoint comes back.
- Browser support is capability-based: Chrome, Edge, and Brave share the same Chromium path when the required APIs exist, and unsupported features degrade independently instead of taking down the whole extension.
- Full-page screenshot capture remains debugger-based; if a browser does not expose the required debugger APIs, popup, clipboard, and bridge features continue to work while capture reports that it is unavailable.
- The Python server uses WebSocket heartbeats and request timeouts so failures surface cleanly instead of hanging forever.
- Restricted browser pages such as `chrome://` are skipped.
- Captures are saved into an `images` directory under the directory where the Python GUI process is started.

## Resolver payload format

The resolver URL can return either plain text or JSON.

Plain text examples:

```text
wss://example.ngrok-free.app
tcp://0.tcp.in.ngrok.io:18207
https://example.ngrok-free.app
```

JSON example:

```json
{
	"websocketUrl": "wss://example.ngrok-free.app"
}
```

Normal Pastebin page URLs are accepted in the options UI and are normalized to the raw Pastebin URL automatically.
Resolver values are converted as follows: `https -> wss`, `http -> ws`, `tcp -> ws`, and `ws/wss` are used directly.

## Important permission note

Using `chrome.debugger` can show Chrome's debugging indicator while screenshots are being captured. That tradeoff is what enables single-pass, full-page, high-fidelity capture.