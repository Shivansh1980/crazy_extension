"""PageSignal Relay Server.

A single-file, hostable WebSocket relay that pairs the Capture Control GUI with
the Chrome extension (and optional native input/screen-capture client) when a
direct localhost / ngrok / pastebin tunnel is not available.

Design notes (SOLID):

* ``Config`` (frozen dataclass) — Single Responsibility for env-driven settings.
* ``AuthService`` — Single Responsibility for credential validation. Uses
  ``bcrypt`` constant-time comparison. Easy to swap for OAuth/JWT (DIP).
* ``RateLimiter`` — Single Responsibility for failed-login throttling per IP.
* ``Session`` / ``SessionRegistry`` — Single Responsibility for pairing one
  authenticated GUI with one extension and (optionally) one native client.
* ``MessageRouter`` — Forwards opaque text/binary frames between paired peers.
  Knows nothing about capture / popup / screen-share message types so adding
  new types requires no changes here (Open/Closed).
* ``ConnectionHandler`` — Orchestrates a single websocket lifecycle.
* ``RelayServer`` — Wires everything via constructor injection (DIP).

Usage:

    # 1) Generate a password hash for your operator account:
    python server.py hash-password 'my-secret'

    # 2) Put values in a ``.env`` next to ``server.py`` (or set real env vars):
    #     RELAY_USERNAME=admin
    #     RELAY_PASSWORD_HASH=<paste-the-hash>
    #     SESSION_ID=default
    #     RELAY_HOST=0.0.0.0
    #     RELAY_PORT=8765

    # 3) Run:
    python server.py

The relay never inspects business payloads. Wire protocol summary:

    Client -> Relay: must FIRST send ``client.register`` JSON.
        For role=control-gui: { sessionId, username, password, ... }
        For other roles:      { sessionId, role, capabilities, ... }
    Relay -> Client: ``server.hello`` is sent immediately on connection,
        then ``register.ack`` (or ``register.error`` + close) after register.
        Once the GUI is paired, peer ``client.register`` payloads are forwarded
        as ``peer.connected`` so the GUI can synthesize its UI events.
    All other text/binary frames are forwarded as-is.

Optional ``_target`` field on a JSON message routes to a specific role
(e.g. ``"_target":"native-input-client"``); absent or ``"any"`` => broadcast.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import signal
import sys
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable

try:
    from websockets.asyncio.server import ServerConnection, serve
    from websockets.datastructures import Headers
    from websockets.exceptions import ConnectionClosed
    from websockets.http11 import Response  # type: ignore
except ImportError as exc:  # pragma: no cover - import-time check
    raise SystemExit(
        'Missing dependency: websockets. Install with `pip install websockets`.'
    ) from exc

try:
    import bcrypt
except ImportError as exc:  # pragma: no cover - import-time check
    raise SystemExit(
        'Missing dependency: bcrypt. Install with `pip install bcrypt`.'
    ) from exc


LOGGER = logging.getLogger('relay')
WEBSOCKET_SERVER_LOGGER = logging.getLogger('relay.websocket')
WEBSOCKET_SERVER_LOGGER.addHandler(logging.NullHandler())
WEBSOCKET_SERVER_LOGGER.propagate = False
WEBSOCKET_SERVER_LOGGER.setLevel(logging.CRITICAL)


def _plain_text_response(status_code: int, reason: str, body: bytes, upgrade: bool = False) -> Response:
    headers = Headers()
    headers['content-type'] = 'text/plain; charset=utf-8'
    if upgrade:
        headers['upgrade'] = 'websocket'
    return Response(status_code, reason, headers=headers, body=body)

ROLE_CONTROL_GUI = 'control-gui'
ROLE_EXTENSION_CLIENT = 'extension-client'
ROLE_NATIVE_INPUT_CLIENT = 'native-input-client'
PEER_ROLES: tuple[str, ...] = (ROLE_EXTENSION_CLIENT, ROLE_NATIVE_INPUT_CLIENT)

# Server-controlled fields of a register payload. We strip these before
# forwarding the registration to the paired GUI so secrets never leak across.
_SECRET_REGISTER_FIELDS = {'username', 'password'}

# Hard cap on first-message size; the client.register frame must fit comfortably.
_MAX_REGISTER_BYTES = 16 * 1024

# Time the GUI waits at most for its register response before being closed by
# the server-side guard. Prevents idle half-open sockets from holding sessions.
_REGISTER_TIMEOUT_SECONDS = 15.0

# Failed-auth throttling.
_RATE_LIMIT_WINDOW_SECONDS = 15 * 60
_RATE_LIMIT_MAX_FAILURES = 5


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def _parse_env_file(env_path: Path) -> dict[str, str]:
    """Parse a minimal KEY=VALUE .env file. No external deps, no shell expansion."""
    parsed: dict[str, str] = {}
    if not env_path.is_file():
        return parsed
    for raw_line in env_path.read_text(encoding='utf-8').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            continue
        key, _, value = line.partition('=')
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            parsed[key] = value
    return parsed


def _load_env(env_path: Path) -> None:
    """Load .env values into ``os.environ`` without overriding existing variables."""
    for key, value in _parse_env_file(env_path).items():
        os.environ.setdefault(key, value)


@dataclass(frozen=True, slots=True)
class Config:
    """Server configuration loaded from environment variables."""

    host: str
    port: int
    session_id: str
    username: str
    password_hash: str
    allow_plain_ws: bool

    @staticmethod
    def from_env() -> 'Config':
        username = os.environ.get('RELAY_USERNAME', '').strip()
        password_hash = os.environ.get('RELAY_PASSWORD_HASH', '').strip()
        session_id = os.environ.get('SESSION_ID', 'default').strip() or 'default'
        host = os.environ.get('RELAY_HOST', '0.0.0.0').strip() or '0.0.0.0'
        try:
            port = int(os.environ.get('RELAY_PORT', '8765'))
        except ValueError as error:
            raise SystemExit(f'Invalid RELAY_PORT: {error}') from error
        allow_plain_ws = os.environ.get('RELAY_ALLOW_PLAIN_WS', 'true').strip().lower() in ('1', 'true', 'yes', 'on')

        missing: list[str] = []
        if not username:
            missing.append('RELAY_USERNAME')
        if not password_hash:
            missing.append('RELAY_PASSWORD_HASH')
        if missing:
            raise SystemExit(
                'Relay configuration error: missing ' + ', '.join(missing)
                + '. Generate a hash with `python live_server.py hash-password <plaintext>`'
                + ' and put RELAY_USERNAME / RELAY_PASSWORD_HASH into the environment or .env file.'
            )

        return Config(
            host=host,
            port=port,
            session_id=session_id,
            username=username,
            password_hash=password_hash,
            allow_plain_ws=allow_plain_ws,
        )


# ---------------------------------------------------------------------------
# Auth + rate limiting
# ---------------------------------------------------------------------------


class AuthService:
    """Validates GUI operator credentials. Single responsibility."""

    def __init__(self, expected_username: str, password_hash: str) -> None:
        self._expected_username = expected_username
        self._password_hash = password_hash.encode('utf-8')

    def verify(self, username: str, password: str) -> bool:
        if not username or not password:
            return False
        # ``secrets.compare_digest`` for the username (constant-time);
        # ``bcrypt.checkpw`` is itself constant-time for the password hash.
        username_ok = secrets.compare_digest(username, self._expected_username)
        try:
            password_ok = bcrypt.checkpw(password.encode('utf-8'), self._password_hash)
        except ValueError:
            password_ok = False
        return username_ok and password_ok


class RateLimiter:
    """Tracks failed authentication attempts per remote address."""

    def __init__(self, max_failures: int, window_seconds: float) -> None:
        self._max_failures = max_failures
        self._window_seconds = window_seconds
        self._buckets: dict[str, deque[float]] = defaultdict(deque)

    def is_blocked(self, key: str) -> bool:
        bucket = self._buckets.get(key)
        if not bucket:
            return False
        self._evict(bucket)
        return len(bucket) >= self._max_failures

    def record_failure(self, key: str) -> None:
        bucket = self._buckets[key]
        bucket.append(time.monotonic())
        self._evict(bucket)

    def reset(self, key: str) -> None:
        self._buckets.pop(key, None)

    def _evict(self, bucket: deque[float]) -> None:
        cutoff = time.monotonic() - self._window_seconds
        while bucket and bucket[0] < cutoff:
            bucket.popleft()


# ---------------------------------------------------------------------------
# Session model
# ---------------------------------------------------------------------------


@dataclass
class Peer:
    role: str
    websocket: ServerConnection
    registration: dict[str, Any]


@dataclass
class Session:
    session_id: str
    gui: Peer | None = None
    peers: dict[str, Peer] = field(default_factory=dict)

    def gui_paired(self) -> bool:
        return self.gui is not None


class SessionRegistry:
    """Owns ``Session`` instances keyed by session id. Concurrency-safe."""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = asyncio.Lock()

    async def get_or_create(self, session_id: str) -> Session:
        async with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                session = Session(session_id=session_id)
                self._sessions[session_id] = session
            return session

    async def attach_gui(self, session: Session, peer: Peer) -> Peer | None:
        async with self._lock:
            previous = session.gui
            session.gui = peer
            return previous

    async def attach_peer(self, session: Session, peer: Peer) -> Peer | None:
        """Attach a non-GUI peer; returns the previous peer with the same role (to be kicked)."""
        async with self._lock:
            previous = session.peers.get(peer.role)
            session.peers[peer.role] = peer
            return previous

    async def detach(self, session: Session, websocket: ServerConnection) -> Peer | None:
        async with self._lock:
            if session.gui is not None and session.gui.websocket is websocket:
                detached = session.gui
                session.gui = None
                return detached
            for role, peer in list(session.peers.items()):
                if peer.websocket is websocket:
                    del session.peers[role]
                    return peer
            return None

    async def snapshot_peers(self, session: Session) -> tuple[Peer | None, list[Peer]]:
        async with self._lock:
            return session.gui, list(session.peers.values())


# ---------------------------------------------------------------------------
# Message routing
# ---------------------------------------------------------------------------


class MessageRouter:
    """Forwards already-validated messages between paired peers.

    Knows nothing about business message types. ``_target`` field on a JSON
    message restricts the relay to a single role; otherwise GUI->peers is a
    broadcast and peer->GUI is direct. Binary frames are forwarded opaquely.
    """

    async def gui_to_peers(self, session: Session, raw: str | bytes) -> None:
        target_role = self._extract_target_role(raw)
        _, peers = await SessionRegistryAccessor.peers(session)
        for peer in peers:
            if target_role and peer.role != target_role:
                continue
            await self._safe_send(peer.websocket, raw)

    async def peer_to_gui(self, session: Session, raw: str | bytes) -> None:
        gui = session.gui
        if gui is None:
            return
        await self._safe_send(gui.websocket, raw)

    @staticmethod
    def _extract_target_role(raw: str | bytes) -> str | None:
        if isinstance(raw, (bytes, bytearray)):
            return None
        try:
            payload = json.loads(raw)
        except (TypeError, ValueError):
            return None
        if not isinstance(payload, dict):
            return None
        target = payload.get('_target')
        if not isinstance(target, str) or target.lower() in ('', 'any', 'all'):
            return None
        return target

    @staticmethod
    async def _safe_send(websocket: ServerConnection, raw: str | bytes) -> None:
        try:
            await websocket.send(raw)
        except ConnectionClosed:
            return
        except Exception as error:  # noqa: BLE001 - never tear down the relay over a bad peer
            LOGGER.warning('Failed to forward frame: %s', error)


class SessionRegistryAccessor:
    """Tiny accessor so MessageRouter does not own the asyncio.Lock semantics directly."""

    @staticmethod
    async def peers(session: Session) -> tuple[Peer | None, list[Peer]]:
        # Snapshot under no lock is fine because we tolerate transient mismatches:
        # any failed send simply drops a single frame which the application layer
        # already handles via timeout/retry.
        return session.gui, list(session.peers.values())


# ---------------------------------------------------------------------------
# Connection handler
# ---------------------------------------------------------------------------


class ConnectionHandler:
    """Orchestrates the full lifecycle of one inbound websocket."""

    def __init__(
        self,
        config: Config,
        auth: AuthService,
        rate_limiter: RateLimiter,
        registry: SessionRegistry,
        router: MessageRouter,
    ) -> None:
        self._config = config
        self._auth = auth
        self._rate_limiter = rate_limiter
        self._registry = registry
        self._router = router

    async def handle(self, websocket: ServerConnection) -> None:
        peer_address = self._peer_address(websocket)
        LOGGER.info('Inbound connection from %s', peer_address)

        await self._send_hello(websocket, gui_paired=False)

        peer: Peer | None = None
        session: Session | None = None
        try:
            register_payload = await self._await_registration(websocket)
            if register_payload is None:
                return

            role = str(register_payload.get('role') or '').strip().lower()
            session_id = str(register_payload.get('sessionId') or '').strip()

            if session_id != self._config.session_id:
                await self._send_register_error(websocket, 'Unknown sessionId.')
                return

            if role == ROLE_CONTROL_GUI:
                if self._rate_limiter.is_blocked(peer_address):
                    await self._send_register_error(websocket, 'Too many failed attempts. Try again later.')
                    return
                username = str(register_payload.get('username') or '')
                password = str(register_payload.get('password') or '')
                if not self._auth.verify(username, password):
                    self._rate_limiter.record_failure(peer_address)
                    await self._send_register_error(websocket, 'Invalid credentials.')
                    return
                self._rate_limiter.reset(peer_address)
                peer = Peer(role=ROLE_CONTROL_GUI, websocket=websocket, registration=self._sanitize_register(register_payload))
                session = await self._registry.get_or_create(session_id)
                previous = await self._registry.attach_gui(session, peer)
                if previous is not None and previous.websocket is not websocket:
                    await self._safe_close(previous.websocket, 'A newer GUI connection replaced this session.')
                await self._send(websocket, {'type': 'register.ack', 'role': ROLE_CONTROL_GUI})
                # Tell the new GUI about already-connected peers so its UI is consistent.
                _, existing_peers = await self._registry.snapshot_peers(session)
                for existing in existing_peers:
                    await self._send(
                        websocket,
                        {'type': 'peer.connected', 'role': existing.role, 'registration': existing.registration},
                    )
                # Tell each existing peer that the GUI just (re-)connected so they can
                # re-publish their current state (popup status, screen-share status,
                # buffered popup messages). Without this a freshly-paired GUI would
                # show stale/empty state until the next state-changing event.
                for existing in existing_peers:
                    await self._send(
                        existing.websocket,
                        {'type': 'gui.connected', 'sessionId': session_id, 'message': 'Control GUI paired.'},
                    )
                LOGGER.info('GUI authenticated and paired (session=%s).', session_id)
            elif role in PEER_ROLES or not role:
                # Default unknown roles to extension-client to stay forwards-compatible
                # with future client revisions.
                effective_role = role if role in PEER_ROLES else ROLE_EXTENSION_CLIENT
                peer = Peer(role=effective_role, websocket=websocket, registration=self._sanitize_register(register_payload))
                session = await self._registry.get_or_create(session_id)
                previous = await self._registry.attach_peer(session, peer)
                if previous is not None and previous.websocket is not websocket:
                    await self._safe_close(previous.websocket, 'A newer peer connection replaced this session.')
                await self._send(websocket, {'type': 'register.ack', 'role': effective_role})
                # Notify the GUI (if paired) that this peer joined.
                if session.gui is not None:
                    await self._send(
                        session.gui.websocket,
                        {'type': 'peer.connected', 'role': effective_role, 'registration': peer.registration},
                    )
                    # Tell the joining peer that a GUI is already paired so it can
                    # publish its current state immediately.
                    await self._send(
                        websocket,
                        {'type': 'gui.connected', 'sessionId': session_id, 'message': 'Control GUI is paired.'},
                    )
                LOGGER.info('Peer registered role=%s (session=%s).', effective_role, session_id)
            else:
                await self._send_register_error(websocket, f'Unsupported role: {role}.')
                return

            await self._forward_loop(websocket, session, peer)
        except ConnectionClosed:
            LOGGER.debug('Connection from %s closed.', peer_address)
        except Exception:  # noqa: BLE001
            LOGGER.exception('Unexpected error handling connection from %s.', peer_address)
        finally:
            if session is not None:
                detached = await self._registry.detach(session, websocket)
                if detached is not None:
                    if detached.role == ROLE_CONTROL_GUI:
                        # Notify peers that the GUI is gone so they can reflect it in their UIs.
                        _, peers = await self._registry.snapshot_peers(session)
                        for other in peers:
                            await self._send(
                                other.websocket,
                                {'type': 'gui.disconnected', 'message': 'Control GUI disconnected.'},
                            )
                    elif session.gui is not None:
                        await self._send(
                            session.gui.websocket,
                            {
                                'type': 'peer.disconnected',
                                'role': detached.role,
                                'message': f'{detached.role} disconnected.',
                            },
                        )

    async def _forward_loop(self, websocket: ServerConnection, session: Session, peer: Peer) -> None:
        async for message in websocket:
            try:
                if peer.role == ROLE_CONTROL_GUI:
                    await self._router.gui_to_peers(session, message)
                else:
                    await self._router.peer_to_gui(session, message)
            except Exception:  # noqa: BLE001 - never tear down on a single bad frame
                LOGGER.exception(
                    'Failed to forward frame from role=%s session=%s; continuing.',
                    peer.role,
                    session.session_id,
                )

    async def _await_registration(self, websocket: ServerConnection) -> dict[str, Any] | None:
        try:
            raw = await asyncio.wait_for(websocket.recv(), timeout=_REGISTER_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            await self._send_register_error(websocket, 'Registration timed out.')
            return None
        except ConnectionClosed:
            return None
        if isinstance(raw, (bytes, bytearray)):
            await self._send_register_error(websocket, 'First frame must be JSON client.register.')
            return None
        if len(raw) > _MAX_REGISTER_BYTES:
            await self._send_register_error(websocket, 'Register payload too large.')
            return None
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            await self._send_register_error(websocket, 'First frame must be valid JSON.')
            return None
        if not isinstance(payload, dict) or payload.get('type') != 'client.register':
            await self._send_register_error(websocket, 'First frame must be type=client.register.')
            return None
        return payload

    async def _send_hello(self, websocket: ServerConnection, gui_paired: bool) -> None:
        await self._send(
            websocket,
            {
                'type': 'server.hello',
                'mode': 'relay',
                'requiresAuth': True,
                'sessionId': self._config.session_id,
                'guiPaired': gui_paired,
            },
        )

    async def _send_register_error(self, websocket: ServerConnection, message: str) -> None:
        await self._send(websocket, {'type': 'register.error', 'message': message})
        await self._safe_close(websocket, message)

    @staticmethod
    async def _send(websocket: ServerConnection, payload: dict[str, Any]) -> None:
        try:
            await websocket.send(json.dumps(payload))
        except (ConnectionClosed, RuntimeError):
            return

    @staticmethod
    async def _safe_close(websocket: ServerConnection, reason: str) -> None:
        try:
            await websocket.close(code=4000, reason=reason[:120])
        except Exception:  # noqa: BLE001
            return

    @staticmethod
    def _peer_address(websocket: ServerConnection) -> str:
        try:
            host, port, *_ = websocket.remote_address  # type: ignore[misc]
            return f'{host}:{port}'
        except Exception:  # noqa: BLE001
            return 'unknown'

    @staticmethod
    def _sanitize_register(payload: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in payload.items() if key not in _SECRET_REGISTER_FIELDS}


# ---------------------------------------------------------------------------
# RelayServer wiring
# ---------------------------------------------------------------------------


class RelayServer:
    def __init__(self, config: Config) -> None:
        self._config = config
        self._auth = AuthService(config.username, config.password_hash)
        self._rate_limiter = RateLimiter(_RATE_LIMIT_MAX_FAILURES, _RATE_LIMIT_WINDOW_SECONDS)
        self._registry = SessionRegistry()
        self._router = MessageRouter()
        self._handler = ConnectionHandler(config, self._auth, self._rate_limiter, self._registry, self._router)
        self._stop_event: asyncio.Event | None = None

    async def serve_forever(self) -> None:
        def _process_request(connection: ServerConnection, request: Any) -> Response | None:  # type: ignore[override]
            # Provide a tiny health endpoint for hosts that probe HTTP routes.
            del connection
            try:
                path = request.path  # type: ignore[attr-defined]
            except AttributeError:
                path = '/'
            try:
                upgrade = request.headers.get('Upgrade', '')  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001 - best-effort handshake guard
                upgrade = ''
            if str(upgrade).lower() == 'websocket':
                return None
            if path in ('/healthz', '/_health', '/ping'):
                return _plain_text_response(200, 'OK', b'ok\n')
            return _plain_text_response(
                426,
                'Upgrade Required',
                b'Page Signal relay is running. Connect with a WebSocket client.\n',
                upgrade=True,
            )

        loop = asyncio.get_running_loop()
        self._stop_event = asyncio.Event()

        # Install graceful-shutdown handlers (best effort; not all platforms expose SIGTERM).
        for sig_name in ('SIGINT', 'SIGTERM'):
            sig = getattr(signal, sig_name, None)
            if sig is None:
                continue
            try:
                loop.add_signal_handler(sig, self._request_stop)
            except (NotImplementedError, RuntimeError):
                # Windows ProactorEventLoop does not implement add_signal_handler.
                # The KeyboardInterrupt path in `main()` still handles Ctrl+C there.
                pass

        async with serve(
            self._handler.handle,
            self._config.host,
            self._config.port,
            ping_interval=20,
            ping_timeout=20,
            max_size=64 * 1024 * 1024,
            process_request=_process_request,
            logger=WEBSOCKET_SERVER_LOGGER,
        ) as server:
            LOGGER.info(
                'Relay listening on %s:%s (sessionId=%s, allow_plain_ws=%s).',
                self._config.host,
                self._config.port,
                self._config.session_id,
                self._config.allow_plain_ws,
            )
            stop_task = asyncio.create_task(self._stop_event.wait())
            serve_task = asyncio.create_task(server.serve_forever())
            done, pending = await asyncio.wait(
                {stop_task, serve_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            for task in done:
                exc = task.exception()
                if exc is not None and not isinstance(exc, (asyncio.CancelledError, KeyboardInterrupt)):
                    LOGGER.exception('Relay task crashed.', exc_info=exc)
            LOGGER.info('Relay shutting down.')

    def _request_stop(self) -> None:
        if self._stop_event is not None and not self._stop_event.is_set():
            LOGGER.info('Shutdown signal received.')
            self._stop_event.set()


# ---------------------------------------------------------------------------
# CLI entry points
# ---------------------------------------------------------------------------


def _hash_password_cli(plaintext: str) -> int:
    if not plaintext:
        print('Provide a non-empty password.', file=sys.stderr)
        return 2
    digest = bcrypt.hashpw(plaintext.encode('utf-8'), bcrypt.gensalt(rounds=12))
    print(digest.decode('utf-8'))
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(argv if argv is not None else sys.argv[1:])
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s [%(name)s] %(message)s')

    if argv and argv[0] in ('hash-password', 'hash'):
        if len(argv) < 2:
            print('Usage: python live_server.py hash-password <plaintext>', file=sys.stderr)
            return 2
        return _hash_password_cli(argv[1])

    # Load .env from the live_server folder first, then fall back to the project
    # root so a single shared .env at the repo root keeps working too.
    here = Path(__file__).resolve().parent
    for candidate in (here / '.env', here.parent / '.env'):
        if candidate.is_file():
            _load_env(candidate)
            LOGGER.info('Loaded environment from %s', candidate)
            break

    try:
        config = Config.from_env()
    except SystemExit as error:
        print(str(error), file=sys.stderr)
        return 2

    server = RelayServer(config)
    try:
        asyncio.run(server.serve_forever())
    except KeyboardInterrupt:
        LOGGER.info('Relay stopped (KeyboardInterrupt).')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
