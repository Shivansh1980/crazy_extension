# Page Signal Capture

Page Signal Capture now consists of two cooperating applications:

- A Manifest V3 Chrome extension that maintains a resilient local WebSocket client in an offscreen document and captures full-page screenshots on demand.
- A Python desktop control center that exposes the WebSocket server, lets the user trigger captures from a GUI, previews the latest image, saves each screenshot into an `images` folder under the current working directory, can push raw text or code into the browser clipboard, and can show the same text inside a draggable in-page popup.

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
2. The extension offscreen document connects to `ws://127.0.0.1:8765` by default and keeps retrying every 5 seconds if the server is unavailable.
	If a resolver URL is configured, it fetches the latest tunnel endpoint once and keeps retrying that cached target.
	After 10 consecutive connection failures, it fetches the resolver again to detect a rotated ngrok URL and then continues with the updated target if it changed.
3. The user clicks **Capture screenshot** in the Python GUI.
4. The Python server sends a WebSocket request to the extension.
5. The extension captures the active page with `chrome.debugger` and `Page.captureScreenshot` using `captureBeyondViewport`.
6. The Python app receives the image, saves it to `images/`, and renders a preview in the GUI.

Clipboard flow:

1. Paste any text or code into the advanced clipboard editor in the Python GUI.
2. Click **Send text to browser clipboard** or press `Ctrl+Enter`.
3. The Python server sends the exact raw string to the extension over the existing WebSocket bridge.
4. The offscreen extension document writes the content into the browser clipboard without trimming or reformatting it.

Popup flow:

1. Use the same advanced editor in the Python GUI and click **Send text to browser popup**.
2. The extension injects or updates a floating popup on the active page.
3. The popup stays above the page, can be dragged, resized, minimized into a compact icon, restored, copied from, or closed completely.
4. Sending again updates the existing popup text instead of creating duplicates.
5. The Python GUI shows the current popup state reported by the extension: open, minimized, or not present.

## Why this capture strategy

The extension still uses the Chrome DevTools Protocol through `chrome.debugger` and `Page.captureScreenshot`. That remains the fastest high-fidelity path for full-page screenshots because it avoids scroll-and-stitch artifacts and preserves device-aware detail that downstream AI analysis needs.

To avoid oversized screenshots that can fail on extremely long pages, the capture gateway computes an optimal scale using both a maximum dimension cap and a maximum pixel-area cap.

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
- The extension caches the last resolved ngrok target, retries it every 5 seconds, and refreshes the resolver only after 10 consecutive failures or when settings change.
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