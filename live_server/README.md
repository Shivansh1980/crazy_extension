# PageSignal Live Relay (`live_server.py`)

A single-file, hostable WebSocket relay that pairs the **Capture Control GUI** (Python Tk) with the **Chrome extension** (and optional native input/screen-capture client) when a direct localhost / ngrok / Pastebin tunnel is unavailable.

It is the "live" path of the system. The "direct" path (GUI listens locally on `127.0.0.1:8765`) keeps working unchanged.

## Quick start (Docker)

```sh
cp .env.example .env
# Generate a bcrypt hash and paste it into .env as RELAY_PASSWORD_HASH:
docker run --rm -v "$PWD:/work" -w /work python:3.13-slim sh -c \
  "pip install -q bcrypt && python live_server.py hash-password 'mypassword'"
docker compose up -d
docker compose logs -f relay
```

The relay listens on `:8765` (override via `RELAY_HOST_PORT`).

## Quick start (bare metal)

```sh
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python live_server.py hash-password 'mypassword'   # copy into .env
.venv/bin/python live_server.py
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `RELAY_HOST` | `0.0.0.0` | Bind address |
| `RELAY_PORT` | `8765` | TCP port |
| `RELAY_USERNAME` | *(required)* | Operator username |
| `RELAY_PASSWORD_HASH` | *(required)* | bcrypt hash of the password |
| `SESSION_ID` | `default` | Logical session bucket (must match GUI + extension) |
| `RELAY_ALLOW_PLAIN_WS` | `1` | Allow plaintext `ws://`. Set to `0` in production behind TLS. |

## Endpoints

| Path | Purpose |
| --- | --- |
| `/` (any path, WS upgrade) | WebSocket relay |
| `/healthz`, `/_health`, `/ping` | HTTP `200 OK` for load-balancer probes |

## Wire protocol

1. Server sends `server.hello` immediately on connect.
2. Client must respond with `client.register` JSON within 15 s. The first frame must be ≤ 16 KiB.
   - GUI: `{type, role:'control-gui', sessionId, username, password, ...}`
   - Peer: `{type, role:'extension-client'|'native-input-client', sessionId, capabilities, ...}`
3. Server replies with `register.ack` (or `register.error` + close).
4. The GUI receives one `peer.connected` per already-connected peer. Joining peers receive `gui.connected` if a GUI is already paired (and vice-versa) so they can re-publish their state.
5. All other frames (text + binary) are forwarded opaquely. JSON frames may carry an optional `_target` field (`extension-client`, `native-input-client`, or absent for broadcast).

## Production hardening

- Run behind Caddy / Nginx with TLS (`wss://`). Set `RELAY_ALLOW_PLAIN_WS=0`.
- Mount the container with a read-only filesystem and `--cap-drop=ALL` (compose can be extended).
- Rotate the password by re-generating the hash and restarting.
- Failed-auth IPs are throttled (5 failures / 15 min).
- Each frame is bounded to 64 MiB (websockets `max_size`).

## Testing locally with the GUI and extension

1. Start the relay (steps above). Note the printed listen address.
2. In the workspace `.env` (the one read by `capture_control_center/app.py`):
   ```
   MODE=relay
   RELAY_URL=ws://127.0.0.1:8765
   RELAY_USERNAME=<same as relay>
   SESSION_ID=default
   ```
3. Launch the GUI: `python -m capture_control_center.app` and authenticate in the modal dialog.
4. In the Chrome extension's Options page, set Connection mode = **Relay**, Relay URL = `ws://127.0.0.1:8765`, Session id = `default`, then click **Apply & reconnect**.
