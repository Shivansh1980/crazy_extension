# PageSignalCapture

PageSignalCapture is a browser-to-desktop tool that makes a website running on your local machine viewable by other people through a temporary live connection.

It is useful when you are developing a website locally and want to share it with a client, teammate, or another device without deploying it to a hosting provider.

## How It Works

1. Start your website locally:

   ```bash
   npm run dev
   ```

2. Open the localhost website in Chrome, Edge, or Brave.
3. PageSignalCapture captures the website from the browser tab.
4. The Capture Control Center manages the live connection and browser stream.
5. In relay mode, the authenticated relay server forwards the browser stream to authorized viewers.

The website continues running on your computer. PageSignalCapture makes its browser view available remotely; it does not permanently deploy the website or upload its source code.

## Components

| Component | Purpose |
| --- | --- |
| Chrome extension | Captures and streams the localhost website |
| Capture Control Center | Manages the live-preview connection |
| Native agent | Supports desktop capture and local system control |
| Relay server | Enables authorized remote connections |

## Quick Start on Windows

### Prerequisites

- Windows 10 or 11
- Python 3.11 or newer
- Node.js 20 or newer
- Chrome, Edge, or Brave

### Setup

Run:

```bat
setup.bat --native
```

Load the extension:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the repository's `dist` directory.

Start PageSignalCapture:

```bat
start_gui.bat --with-native
```

Start your local website, for example:

```text
http://localhost:3000
```

PageSignalCapture then keeps the live preview available and automatically reconnects after temporary network, browser, or server interruptions.

## Connection Modes

- **Direct mode** — For connections within the same local network.
- **Relay mode** — For sharing the localhost website across different networks through an authenticated relay server.

## Important Note

PageSignalCapture creates a temporary live preview of a website running on localhost. It is intended for development, demos, and client reviews. It does not replace production hosting or deployment.
