# Page Signal live relay

`live_server.py` pairs one authenticated Control Center with extension, native,
and browser-stream peers when localhost connectivity is not available.

## Quick start with Docker

```sh
cp .env.example .env
docker run --rm -v "$PWD:/work" -w /work python:3.13-slim sh -c \
  "pip install -q bcrypt && python live_server.py hash-password 'change-me'"
docker compose up -d
docker compose logs -f relay
```

Place the generated hash in `.env` as `RELAY_PASSWORD_HASH` before starting
the container.

## Bare-metal start

```sh
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python live_server.py hash-password 'change-me'
.venv/bin/python live_server.py
```

On Windows, use `.venv\Scripts\python.exe` instead.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `RELAY_HOST` | `0.0.0.0` | Listen address |
| `RELAY_PORT` | `8765` | Listen port |
| `RELAY_USERNAME` | required | Control Center login name |
| `RELAY_PASSWORD_HASH` | required | bcrypt password hash |
| `SESSION_ID` | `default` | Session shared by all peers |
| `RELAY_ALLOW_PLAIN_WS` | `true` | Permit plaintext WebSockets |

Use TLS termination and `wss://` for remote deployments. Set
`RELAY_ALLOW_PLAIN_WS=0` when plaintext transport must be rejected.

Health probes are available at `/healthz`, `/_health`, and `/ping`.

## Roles

| Role | Authentication | Purpose |
| --- | --- | --- |
| `control-gui` | username, password, session ID | Control Center transport |
| `extension-client` | session ID | Main extension connection |
| `native-input-client` | session ID | Python/C# native agent |
| `screen-share-stream` | session ID | Independent browser frame stream |

Only one peer per role is active in a session. A newer connection replaces the
older connection of the same role. The stream role is distinct, so reconnecting
browser frames never changes extension presence in the GUI. Legacy native role
names are normalized to `native-input-client` for compatibility.

## Protocol

1. The relay sends `server.hello`.
2. The client sends `client.register` within 15 seconds and 16 KiB.
3. The relay replies with `register.ack` or `register.error` and closes.
4. The GUI receives `peer.connected` snapshots; peers receive `gui.connected`
   so they can republish current popup/screen state.
5. Business text and binary frames are routed without modification.

GUI messages may include `_target` in JSON or binary-envelope metadata. The
relay applies the same role filter to both forms, preventing a targeted file
upload from being broadcast to every peer.

## Reliability and security

- WebSocket messages are capped at 64 MiB.
- Registration and authentication have finite timeouts.
- Failed GUI logins are limited per source host, not ephemeral source port.
- Five failures within 15 minutes pause further attempts for that host.
- Passwords are checked with bcrypt and removed from forwarded registration
  snapshots.
- A malformed business frame is isolated to that forwarding attempt.
- Peer responses are not persisted while the GUI is disconnected. The GUI
  fails in-flight work promptly and reconnects; side-effecting commands are not
  replayed automatically.

## Local integration test

Configure the workspace `.env`:

```env
MODE=relay
RELAY_URL=ws://127.0.0.1:8765
RELAY_USERNAME=operator
SESSION_ID=default
```

Set the extension Options page to the same relay URL and session ID. Start the
relay, launch `start_gui.bat`, enter the password, and then load/start the
extension or native agent.

The automated relay authentication, role, routing, credential-correction, and
transport-loss flows run as part of `verify.bat`.
