"""Relay-mode bridge client.

Mirrors the public surface of ``BridgeServer`` (LSP) but instead of accepting
inbound websocket connections, opens a single OUTBOUND websocket to the
configured relay (``server.py``) and authenticates as the control GUI.

Protocol (matches ``server.py``):

* On connect the relay sends ``server.hello``.
* The client sends ``client.register`` with role=control-gui plus username,
  password, and sessionId.
* On success the relay sends ``register.ack``; otherwise ``register.error``
  followed by close. Re-auth happens automatically on reconnect using the
  credentials supplied by the constructor's credentials provider.
* The relay forwards peer ``client.register`` payloads as ``peer.connected``
  envelopes; this client synthesises ``client_connected`` /
  ``native_input_connected`` events from them.
* Outbound control commands are tagged with ``_target`` so the relay can
  route to the correct peer (extension vs native-input-client).

This file deliberately re-implements the dispatch tables of
``BridgeServer`` instead of refactoring the latter, so direct mode stays
untouched (less risk).
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from websockets.asyncio.client import ClientConnection, connect

from capture_control_center.debug import debug_log
from capture_control_center.domain.models import ClientRegistration, ScreenshotResult
from capture_control_center.infrastructure.wire_protocol import (
    build_binary_envelope,
    coerce_file_transfer_status,
    coerce_popup_message,
    coerce_popup_status,
    coerce_screen_share_status,
    parse_binary_envelope,
)


# Roles understood by ``server.py``.
ROLE_CONTROL_GUI = 'control-gui'
ROLE_EXTENSION_CLIENT = 'extension-client'
ROLE_NATIVE_INPUT_CLIENT = 'native-input-client'

# Reconnect backoff bounds (seconds).
_RECONNECT_INITIAL_BACKOFF = 2.0
_RECONNECT_MAX_BACKOFF = 30.0


def normalize_websocket_url(value: str) -> str:
    candidate = (value or '').strip()
    if not candidate:
        return ''
    lowered = candidate.lower()
    if lowered.startswith('tcp://'):
        return 'ws://' + candidate[len('tcp://'):]
    if lowered.startswith('http://'):
        return 'ws://' + candidate[len('http://'):]
    if lowered.startswith('https://'):
        return 'wss://' + candidate[len('https://'):]
    if lowered.startswith(('ws://', 'wss://')):
        return candidate
    return 'ws://' + candidate


@dataclass(frozen=True, slots=True)
class RelayCredentials:
    """Operator credentials supplied by the login dialog."""

    username: str
    password: str
    session_id: str


CredentialsProvider = Callable[[], RelayCredentials]
AuthFailureCallback = Callable[[str], None]


class RelayAuthError(RuntimeError):
    """Raised when the relay rejects the credentials. Callers should re-prompt."""


class RelayBridgeClient:
    """Outbound relay client exposing the same surface as :class:`BridgeServer`."""

    def __init__(
        self,
        relay_url: str,
        credentials_provider: CredentialsProvider,
        client_name: str = 'page-signal-control-gui',
        client_version: str = '2.0.0',
        on_auth_failure: AuthFailureCallback | None = None,
    ) -> None:
        self._relay_url = normalize_websocket_url(relay_url)
        self._credentials_provider = credentials_provider
        self._client_name = client_name
        self._client_version = client_version
        self._on_auth_failure = on_auth_failure

        self._client_id = str(uuid.uuid4())
        self._socket: ClientConnection | None = None
        self._authenticated = False
        self._stopping = False
        self._connect_task: asyncio.Task[None] | None = None

        self._extension_registration: ClientRegistration | None = None
        self._native_input_registration: ClientRegistration | None = None

        # Pending request maps — mirror BridgeServer.
        self._pending_requests: dict[str, asyncio.Future[ScreenshotResult]] = {}
        self._pending_clipboard: dict[str, asyncio.Future[dict[str, int]]] = {}
        self._pending_popup: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_screen_share: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_screen_share_stop: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_screen_share_click: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_screen_share_paste: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_screen_share_input: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_screen_share_key: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_file_upload: dict[str, asyncio.Future[dict[str, Any]]] = {}

        self._event_callback: Callable[[str, dict[str, Any]], None] | None = None

    # ------------------------------------------------------------------ public API

    async def start(self) -> None:
        debug_log('python-relay', 'Starting relay client.', {'relay_url': self._relay_url})
        self._stopping = False
        self._connect_task = asyncio.create_task(self._connect_loop(), name='relay-connect-loop')
        # Emit a "server_started" event mimicking BridgeServer so the GUI can show a status.
        self._emit('server_started', {'host': self._relay_url, 'port': 0, 'mode': 'relay'})

    async def stop(self) -> None:
        debug_log('python-relay', 'Stopping relay client.')
        self._stopping = True
        if self._connect_task is not None:
            self._connect_task.cancel()
            try:
                await self._connect_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._connect_task = None
        await self._close_socket('Relay client stopping.')
        await self._fail_all_pending('Relay client stopped.')
        self._emit('server_stopped', {})

    def set_event_callback(self, callback: Callable[[str, dict[str, Any]], None]) -> None:
        self._event_callback = callback

    def has_native_input_client(self) -> bool:
        return self._native_input_registration is not None

    # ------------------------------------------------------------ request methods

    async def request_capture(self, timeout_seconds: float = 20.0) -> ScreenshotResult:
        request_id = self._new_request_id()
        future = self._loop_future()
        self._pending_requests[request_id] = future
        # Prefer the native client (full desktop capture). The extension is the fallback.
        target = self._select_screen_share_target()
        try:
            await self._send_to_role(
                target,
                {'type': 'capture.request', 'requestId': request_id},
            )
        except Exception:
            self._pending_requests.pop(request_id, None)
            raise
        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            self._pending_requests.pop(request_id, None)
            raise RuntimeError(f'No capture response arrived within {timeout_seconds:.0f} seconds.') from error

    async def request_clipboard_write(self, text: str, timeout_seconds: float = 15.0) -> dict[str, int]:
        return await self._simple_request(
            self._pending_clipboard,
            ROLE_EXTENSION_CLIENT,
            {'type': 'clipboard.write', 'text': text},
            timeout_seconds,
            'clipboard',
        )

    async def request_popup_show(self, text: str, timeout_seconds: float = 15.0) -> dict[str, Any]:
        target = self._select_popup_target()
        return await self._simple_request(
            self._pending_popup,
            target,
            {'type': 'popup.show', 'text': text},
            timeout_seconds,
            'popup',
        )

    async def request_screen_share_start(self, timeout_seconds: float = 30.0) -> dict[str, Any]:
        target = self._select_screen_share_target()
        return await self._simple_request(
            self._pending_screen_share,
            target,
            {'type': 'screen-share.start'},
            timeout_seconds,
            'screen-share start',
        )

    async def request_screen_share_stop(self, timeout_seconds: float = 15.0) -> dict[str, Any]:
        target = self._select_screen_share_target()
        return await self._simple_request(
            self._pending_screen_share_stop,
            target,
            {'type': 'screen-share.stop'},
            timeout_seconds,
            'screen-share stop',
        )

    async def request_screen_share_click(
        self, normalized_x: float, normalized_y: float, timeout_seconds: float = 10.0
    ) -> dict[str, Any]:
        return await self._simple_request(
            self._pending_screen_share_click,
            ROLE_EXTENSION_CLIENT,
            {'type': 'screen-share.click', 'normalizedX': normalized_x, 'normalizedY': normalized_y},
            timeout_seconds,
            'screen-share click',
        )

    async def request_screen_share_paste(self, text: str, timeout_seconds: float = 10.0) -> dict[str, Any]:
        return await self._simple_request(
            self._pending_screen_share_paste,
            ROLE_EXTENSION_CLIENT,
            {'type': 'screen-share.paste', 'text': text},
            timeout_seconds,
            'screen-share paste',
        )

    async def request_screen_share_input(
        self,
        action: str,
        normalized_x: float,
        normalized_y: float,
        button: int = 0,
        buttons: int = 0,
        delta_x: float = 0.0,
        delta_y: float = 0.0,
        modifiers: dict[str, bool] | None = None,
        timeout_seconds: float = 5.0,
    ) -> dict[str, Any]:
        target = self._select_input_target()
        return await self._simple_request(
            self._pending_screen_share_input,
            target,
            {
                'type': 'screen-share.input',
                'action': action,
                'normalizedX': normalized_x,
                'normalizedY': normalized_y,
                'button': button,
                'buttons': buttons,
                'deltaX': delta_x,
                'deltaY': delta_y,
                'modifiers': modifiers or {},
            },
            timeout_seconds,
            'screen-share input',
        )

    async def request_screen_share_key(
        self,
        action: str,
        key: str = '',
        code: str = '',
        text: str = '',
        modifiers: dict[str, bool] | None = None,
        timeout_seconds: float = 10.0,
    ) -> dict[str, Any]:
        target = self._select_input_target()
        return await self._simple_request(
            self._pending_screen_share_key,
            target,
            {
                'type': 'screen-share.key',
                'action': action,
                'key': key,
                'code': code,
                'text': text,
                'modifiers': modifiers or {},
            },
            timeout_seconds,
            'screen-share key',
        )

    async def request_file_upload(
        self,
        file_name: str,
        file_bytes: bytes,
        mime_type: str,
        timeout_seconds: float = 90.0,
    ) -> dict[str, Any]:
        request_id = self._new_request_id()
        future = self._loop_future()
        self._pending_file_upload[request_id] = future
        target = self._select_popup_target()
        metadata = {
            'type': 'file-transfer.upload.binary',
            'requestId': request_id,
            'fileName': file_name,
            'mimeType': mime_type,
            'byteCount': len(file_bytes),
            'uploadedAt': time.time(),
            '_target': target,
        }
        envelope = build_binary_envelope(metadata, file_bytes)
        try:
            self._ensure_role_connected(target)
            await self._send_binary(envelope)
        except Exception:
            self._pending_file_upload.pop(request_id, None)
            raise
        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            self._pending_file_upload.pop(request_id, None)
            raise RuntimeError(f'No file upload response arrived within {timeout_seconds:.0f} seconds.') from error

    # --------------------------------------------------------------- internal helpers

    async def _simple_request(
        self,
        pending: dict[str, asyncio.Future[Any]],
        target_role: str,
        payload: dict[str, Any],
        timeout_seconds: float,
        label: str,
    ) -> Any:
        request_id = self._new_request_id()
        future = self._loop_future()
        pending[request_id] = future
        try:
            await self._send_to_role(target_role, {**payload, 'requestId': request_id})
        except Exception:
            pending.pop(request_id, None)
            raise
        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            pending.pop(request_id, None)
            raise RuntimeError(f'No {label} response arrived within {timeout_seconds:.0f} seconds.') from error

    @staticmethod
    def _new_request_id() -> str:
        return str(uuid.uuid4())

    @staticmethod
    def _loop_future() -> asyncio.Future[Any]:
        return asyncio.get_running_loop().create_future()

    def _select_input_target(self) -> str:
        if self._native_input_registration is not None:
            return ROLE_NATIVE_INPUT_CLIENT
        return ROLE_EXTENSION_CLIENT

    def _select_screen_share_target(self) -> str:
        if (
            self._native_input_registration is not None
            and 'screen-capture' in self._native_input_registration.capabilities
        ):
            return ROLE_NATIVE_INPUT_CLIENT
        return ROLE_EXTENSION_CLIENT

    def _select_popup_target(self) -> str:
        if self._extension_registration is not None:
            return ROLE_EXTENSION_CLIENT
        if (
            self._native_input_registration is not None
            and 'native-popup' in self._native_input_registration.capabilities
        ):
            return ROLE_NATIVE_INPUT_CLIENT
        raise RuntimeError('No popup provider is connected. Connect the Chrome extension or start the native client agent.')

    def _ensure_role_connected(self, target_role: str) -> None:
        if target_role == ROLE_EXTENSION_CLIENT and self._extension_registration is None:
            raise RuntimeError('The Chrome extension is not connected to the relay yet.')
        if target_role == ROLE_NATIVE_INPUT_CLIENT and self._native_input_registration is None:
            raise RuntimeError('The native input client is not connected to the relay yet.')

    async def _send_to_role(self, target_role: str, payload: dict[str, Any]) -> None:
        if not self._authenticated:
            raise RuntimeError(
                'Relay is not connected/authenticated yet. Verify the relay server is reachable and '
                'your credentials are correct.'
            )
        self._ensure_role_connected(target_role)
        framed = {**payload, '_target': target_role}
        await self._send_text(framed)

    async def _send_text(self, payload: dict[str, Any]) -> None:
        socket = self._socket
        if socket is None:
            raise RuntimeError('Relay socket is not open.')
        await socket.send(json.dumps(payload))

    async def _send_binary(self, envelope: bytes) -> None:
        if not self._authenticated:
            raise RuntimeError('Relay is not connected/authenticated yet.')
        socket = self._socket
        if socket is None:
            raise RuntimeError('Relay socket is not open.')
        await socket.send(envelope)

    # ----------------------------------------------------------- connect loop

    async def _connect_loop(self) -> None:
        backoff = _RECONNECT_INITIAL_BACKOFF
        while not self._stopping:
            try:
                await self._connect_once()
                backoff = _RECONNECT_INITIAL_BACKOFF  # reset on a clean session
            except RelayAuthError as error:
                debug_log('python-relay', 'Authentication failed; halting reconnect.', str(error))
                if self._on_auth_failure is not None:
                    try:
                        self._on_auth_failure(str(error))
                    except Exception:  # noqa: BLE001
                        pass
                # Stop trying — credentials are wrong; the GUI must re-prompt.
                self._emit('client_disconnected', {'message': f'Relay authentication failed: {error}'})
                return
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001
                debug_log('python-relay', 'Relay connection failed.', str(error))
                self._emit(
                    'client_disconnected',
                    {'message': f'Relay disconnected: {error}. Retrying in {backoff:.0f}s.'},
                )
            await self._reset_session_state()
            if self._stopping:
                return
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                raise
            backoff = min(backoff * 1.6, _RECONNECT_MAX_BACKOFF)

    async def _connect_once(self) -> None:
        debug_log('python-relay', 'Opening relay socket.', self._relay_url)
        async with connect(self._relay_url, max_size=64 * 1024 * 1024, ping_interval=20, ping_timeout=20) as socket:
            self._socket = socket
            try:
                await self._handshake(socket)
                self._authenticated = True
                self._emit(
                    'client_connected',
                    {
                        'client_id': self._client_id,
                        'name': self._client_name,
                        'version': self._client_version,
                        'message': f'Authenticated to relay at {self._relay_url}.',
                    },
                )
                async for raw in socket:
                    if isinstance(raw, (bytes, bytearray)):
                        self._handle_binary_payload(bytes(raw))
                    else:
                        self._handle_text_payload(str(raw))
            finally:
                self._socket = None
                self._authenticated = False

    async def _handshake(self, socket: ClientConnection) -> None:
        # Wait for server.hello (any other first frame is treated as protocol error).
        hello_raw = await asyncio.wait_for(socket.recv(), timeout=10.0)
        if isinstance(hello_raw, (bytes, bytearray)):
            raise RuntimeError('Relay sent binary as first frame; expected server.hello JSON.')
        try:
            hello = json.loads(hello_raw)
        except json.JSONDecodeError as error:
            raise RuntimeError(f'Relay sent invalid JSON for server.hello: {error}') from error
        if not isinstance(hello, dict) or hello.get('type') != 'server.hello':
            raise RuntimeError('First frame from relay was not server.hello.')

        creds = self._credentials_provider()
        register = {
            'type': 'client.register',
            'role': ROLE_CONTROL_GUI,
            'clientId': self._client_id,
            'name': self._client_name,
            'version': self._client_version,
            'sessionId': creds.session_id,
            'username': creds.username,
            'password': creds.password,
            'capabilities': ['control-gui'],
        }
        await socket.send(json.dumps(register))

        ack_raw = await asyncio.wait_for(socket.recv(), timeout=10.0)
        if isinstance(ack_raw, (bytes, bytearray)):
            raise RuntimeError('Relay sent binary instead of register.ack.')
        try:
            ack = json.loads(ack_raw)
        except json.JSONDecodeError as error:
            raise RuntimeError(f'Relay sent invalid JSON for register response: {error}') from error
        if ack.get('type') == 'register.error':
            raise RelayAuthError(str(ack.get('message', 'Relay rejected the credentials.')))
        if ack.get('type') != 'register.ack':
            raise RuntimeError(f'Unexpected first response from relay: {ack}')
        debug_log('python-relay', 'Relay register.ack received.', ack)

    async def _close_socket(self, reason: str) -> None:
        socket = self._socket
        if socket is None:
            return
        try:
            await socket.close(code=1000, reason=reason[:120])
        except Exception:  # noqa: BLE001
            pass
        self._socket = None

    async def _reset_session_state(self) -> None:
        self._authenticated = False
        if self._extension_registration is not None:
            self._extension_registration = None
            self._emit('client_disconnected', {'message': 'Extension peer disconnected from relay.'})
        if self._native_input_registration is not None:
            self._native_input_registration = None
            self._emit('native_input_disconnected', {'message': 'Native client disconnected from relay.'})

    async def _fail_all_pending(self, message: str) -> None:
        for bucket in (
            self._pending_requests,
            self._pending_clipboard,
            self._pending_popup,
            self._pending_screen_share,
            self._pending_screen_share_stop,
            self._pending_screen_share_click,
            self._pending_screen_share_paste,
            self._pending_screen_share_input,
            self._pending_screen_share_key,
            self._pending_file_upload,
        ):
            for future in list(bucket.values()):
                if not future.done():
                    future.set_exception(RuntimeError(message))
            bucket.clear()

    # ------------------------------------------------------------ inbound dispatch

    def _emit(self, event_name: str, payload: dict[str, Any]) -> None:
        if self._event_callback is not None:
            try:
                self._event_callback(event_name, payload)
            except Exception as error:  # noqa: BLE001
                debug_log('python-relay', 'Event callback failed.', {'event_name': event_name, 'error': str(error)})

    def _handle_text_payload(self, raw: str) -> None:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            debug_log('python-relay', 'Ignoring non-JSON text frame from relay.')
            return
        if not isinstance(payload, dict):
            return
        message_type = payload.get('type')

        # Relay-specific control envelopes.
        if message_type == 'peer.connected':
            self._on_peer_connected(payload)
            return
        if message_type == 'peer.disconnected':
            self._on_peer_disconnected(payload)
            return
        if message_type in ('server.hello', 'register.ack', 'register.error'):
            return  # already handled in _handshake
        if message_type == 'gui.disconnected':
            return  # we are the GUI, ignore self-disconnect notifications
        if message_type == 'gui.connected':
            return  # informational; the relay sends this to peers, not to us

        # Forwarded peer responses: same dispatch table as BridgeServer (subset).
        if message_type == 'capture.result':
            self._resolve_capture(payload)
            return
        if message_type == 'capture.error':
            self._reject_capture(payload)
            return
        if message_type == 'clipboard.result':
            self._resolve_simple(self._pending_clipboard, payload, _coerce_clipboard_result)
            return
        if message_type == 'clipboard.error':
            self._reject_simple(self._pending_clipboard, payload, 'clipboard')
            return
        if message_type == 'popup.result':
            self._resolve_simple(
                self._pending_popup,
                payload,
                lambda p: coerce_popup_status(p.get('status', {}), action=str(p.get('action', 'updated'))),
            )
            return
        if message_type == 'popup.error':
            self._reject_simple(self._pending_popup, payload, 'popup')
            return
        if message_type == 'popup.status':
            self._emit('popup_status', coerce_popup_status(payload.get('status', {}), action='status'))
            return
        if message_type == 'popup.message':
            self._emit('popup_message', coerce_popup_message(payload))
            return
        if message_type == 'screen-share.result':
            self._resolve_simple(
                self._pending_screen_share, payload, lambda p: coerce_screen_share_status(p.get('status', {}))
            )
            self._emit('screen_share_status', coerce_screen_share_status(payload.get('status', {})))
            return
        if message_type == 'screen-share.error':
            self._reject_simple(self._pending_screen_share, payload, 'screen-share start')
            return
        if message_type == 'screen-share.stop-result':
            self._resolve_simple(
                self._pending_screen_share_stop,
                payload,
                lambda p: coerce_screen_share_status(p.get('status', {})),
            )
            self._emit('screen_share_status', coerce_screen_share_status(payload.get('status', {})))
            return
        if message_type == 'screen-share.stop-error':
            self._reject_simple(self._pending_screen_share_stop, payload, 'screen-share stop')
            return
        if message_type == 'screen-share.click-result':
            self._resolve_simple(
                self._pending_screen_share_click,
                payload,
                lambda p: {
                    'message': str(p.get('message', 'Remote click delivered to the shared page.')),
                    'target_description': str(p.get('targetDescription', 'page element')),
                    'viewport_width': int(p.get('viewportWidth', 0)),
                    'viewport_height': int(p.get('viewportHeight', 0)),
                },
            )
            return
        if message_type == 'screen-share.click-error':
            self._reject_simple(self._pending_screen_share_click, payload, 'screen-share click')
            return
        if message_type == 'screen-share.paste-result':
            self._resolve_simple(
                self._pending_screen_share_paste,
                payload,
                lambda p: {
                    'message': str(p.get('message', 'Remote paste delivered.')),
                    'target_description': str(p.get('targetDescription', 'page element')),
                    'character_count': int(p.get('characterCount', 0)),
                },
            )
            return
        if message_type == 'screen-share.paste-error':
            self._reject_simple(self._pending_screen_share_paste, payload, 'screen-share paste')
            return
        if message_type == 'screen-share.input-result':
            self._resolve_simple(
                self._pending_screen_share_input,
                payload,
                lambda p: {
                    'message': str(p.get('message', 'Remote input delivered.')),
                    'target_description': str(p.get('targetDescription', 'page element')),
                    'viewport_width': int(p.get('viewportWidth', 0)),
                    'viewport_height': int(p.get('viewportHeight', 0)),
                },
            )
            return
        if message_type == 'screen-share.input-error':
            self._reject_simple(self._pending_screen_share_input, payload, 'screen-share input')
            return
        if message_type == 'screen-share.key-result':
            self._resolve_simple(
                self._pending_screen_share_key,
                payload,
                lambda p: {
                    'message': str(p.get('message', 'Remote key delivered.')),
                    'target_description': str(p.get('targetDescription', 'page element')),
                },
            )
            return
        if message_type == 'screen-share.key-error':
            self._reject_simple(self._pending_screen_share_key, payload, 'screen-share key')
            return
        if message_type == 'screen-share.status':
            self._emit('screen_share_status', coerce_screen_share_status(payload.get('status', {})))
            return
        if message_type == 'file-transfer.result':
            self._resolve_simple(self._pending_file_upload, payload, coerce_file_transfer_status)
            return
        if message_type == 'file-transfer.error':
            self._reject_simple(self._pending_file_upload, payload, 'file upload')
            return

        debug_log('python-relay', 'Ignoring unknown text payload from relay.', {'type': message_type})

    def _handle_binary_payload(self, raw: bytes) -> None:
        decoded = parse_binary_envelope(raw)
        if decoded is None:
            debug_log('python-relay', 'Malformed binary frame from relay.', {'length': len(raw)})
            return
        metadata, payload_bytes = decoded
        payload_type = metadata.get('type')

        if payload_type == 'capture.result.binary':
            request_id = str(metadata.get('requestId', ''))
            future = self._pending_requests.pop(request_id, None)
            if future is None or future.done():
                return
            captured_page = metadata.get('capturedPage', {})
            result = ScreenshotResult(
                request_id=request_id,
                file_name=str(captured_page.get('fileName', 'capture.png')),
                mime_type=str(captured_page.get('mimeType', 'image/png')),
                base64_data='',
                image_bytes=payload_bytes,
                captured_at=str(captured_page.get('capturedAt', '')),
                page_url=str(captured_page.get('tab', {}).get('url', '')),
                page_title=str(captured_page.get('tab', {}).get('title', '')),
                width_css_px=int(captured_page.get('widthCssPx', 0)),
                height_css_px=int(captured_page.get('heightCssPx', 0)),
                scale=float(captured_page.get('scale', 1)),
            )
            future.set_result(result)
            self._emit('capture_received', {'request_id': request_id, 'file_name': result.file_name})
            return

        if payload_type == 'screen-share.frame.binary':
            self._emit_screen_share_frame(metadata, payload_bytes)
            return

        if payload_type == 'popup-file.binary':
            self._emit_popup_file(metadata, payload_bytes)
            return

        debug_log('python-relay', 'Ignoring unknown binary payload type.', payload_type)

    def _emit_screen_share_frame(self, metadata: dict[str, Any], image_bytes: bytes) -> None:
        partial = bool(metadata.get('partial', False))
        offset_x = int(metadata.get('offsetX', 0)) if isinstance(metadata.get('offsetX'), (int, float)) else 0
        offset_y = int(metadata.get('offsetY', 0)) if isinstance(metadata.get('offsetY'), (int, float)) else 0
        width = int(metadata.get('width', 0))
        height = int(metadata.get('height', 0))
        frame_width = (
            int(metadata.get('frameWidth', width)) if isinstance(metadata.get('frameWidth'), (int, float)) else width
        )
        frame_height = (
            int(metadata.get('frameHeight', height))
            if isinstance(metadata.get('frameHeight'), (int, float))
            else height
        )
        source_label = metadata.get('sourceLabel') if isinstance(metadata.get('sourceLabel'), str) else None
        self._emit(
            'screen_share_frame',
            {
                'mime_type': str(metadata.get('mimeType', 'image/jpeg')),
                'image_bytes': image_bytes,
                'captured_at': str(metadata.get('capturedAt', '')),
                'width': width,
                'height': height,
                'sequence': int(metadata.get('sequence', 0)),
                'partial': partial,
                'offset_x': offset_x,
                'offset_y': offset_y,
                'frame_width': frame_width,
                'frame_height': frame_height,
                'source_label': source_label,
            },
        )

    def _emit_popup_file(self, metadata: dict[str, Any], file_bytes: bytes) -> None:
        self._emit(
            'popup_file_received',
            {
                'file_name': str(metadata.get('fileName', 'client-upload.bin')),
                'mime_type': str(metadata.get('mimeType', 'application/octet-stream')),
                'byte_count': int(metadata.get('byteCount', len(file_bytes))),
                'page_url': metadata.get('pageUrl') if isinstance(metadata.get('pageUrl'), str) and metadata.get('pageUrl') else None,
                'tab_id': int(metadata['tabId']) if isinstance(metadata.get('tabId'), int) else None,
                'sent_at': str(metadata.get('sentAt', '')),
                'file_bytes': bytes(file_bytes),
                'text': str(metadata.get('text', '')) if isinstance(metadata.get('text'), str) else '',
            },
        )

    # --------------------------------------------------------- pending resolvers

    def _resolve_capture(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_requests.pop(request_id, None)
        if future is None or future.done():
            return
        captured_page = payload.get('capturedPage', {})
        result = ScreenshotResult(
            request_id=request_id,
            file_name=str(captured_page.get('fileName', 'capture.png')),
            mime_type=str(captured_page.get('mimeType', 'image/png')),
            base64_data=str(captured_page.get('base64Data', '')),
            image_bytes=None,
            captured_at=str(captured_page.get('capturedAt', '')),
            page_url=str(captured_page.get('tab', {}).get('url', '')),
            page_title=str(captured_page.get('tab', {}).get('title', '')),
            width_css_px=int(captured_page.get('widthCssPx', 0)),
            height_css_px=int(captured_page.get('heightCssPx', 0)),
            scale=float(captured_page.get('scale', 1)),
        )
        future.set_result(result)
        self._emit('capture_received', {'request_id': request_id, 'file_name': result.file_name})

    def _reject_capture(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_requests.pop(request_id, None)
        if future is None or future.done():
            return
        message = str(payload.get('message', 'Capture failed.'))
        future.set_exception(RuntimeError(message))
        self._emit('capture_failed', {'request_id': request_id, 'message': message})

    @staticmethod
    def _resolve_simple(
        pending: dict[str, asyncio.Future[Any]],
        payload: dict[str, Any],
        coerce: Callable[[dict[str, Any]], Any],
    ) -> None:
        request_id = str(payload.get('requestId', ''))
        future = pending.pop(request_id, None)
        if future is None or future.done():
            return
        try:
            result = coerce(payload)
        except Exception as error:  # noqa: BLE001
            future.set_exception(RuntimeError(f'Failed to parse response: {error}'))
            return
        future.set_result(result)

    @staticmethod
    def _reject_simple(
        pending: dict[str, asyncio.Future[Any]],
        payload: dict[str, Any],
        label: str,
    ) -> None:
        request_id = str(payload.get('requestId', ''))
        future = pending.pop(request_id, None)
        if future is None or future.done():
            return
        message = str(payload.get('message', f'{label} failed.'))
        future.set_exception(RuntimeError(message))

    # ----------------------------------------------------------- peer events

    def _on_peer_connected(self, payload: dict[str, Any]) -> None:
        registration_payload = payload.get('registration') or {}
        if not isinstance(registration_payload, dict):
            return
        peer_role = str(payload.get('role', '')).strip().lower()
        capabilities = tuple(c for c in registration_payload.get('capabilities', []) if isinstance(c, str))
        registration = ClientRegistration(
            client_id=str(registration_payload.get('clientId', 'unknown')),
            name=str(registration_payload.get('name', 'unknown')),
            version=str(registration_payload.get('version', 'unknown')),
            capabilities=capabilities,
            role=peer_role or ROLE_EXTENSION_CLIENT,
        )
        is_native_input = peer_role == ROLE_NATIVE_INPUT_CLIENT or 'os-input' in capabilities

        if is_native_input:
            self._native_input_registration = registration
            self._emit(
                'native_input_connected',
                {
                    'client_id': registration.client_id,
                    'name': registration.name,
                    'version': registration.version,
                    'capabilities': list(capabilities),
                },
            )
        else:
            self._extension_registration = registration
            self._emit(
                'client_connected',
                {
                    'client_id': registration.client_id,
                    'name': registration.name,
                    'version': registration.version,
                },
            )

    def _on_peer_disconnected(self, payload: dict[str, Any]) -> None:
        peer_role = str(payload.get('role', '')).strip().lower()
        message = str(payload.get('message', 'Peer disconnected.'))
        if peer_role == ROLE_NATIVE_INPUT_CLIENT:
            if self._native_input_registration is not None:
                self._native_input_registration = None
                self._emit('native_input_disconnected', {'message': message})
        else:
            if self._extension_registration is not None:
                self._extension_registration = None
                self._emit('client_disconnected', {'message': message})


def _coerce_clipboard_result(payload: dict[str, Any]) -> dict[str, int]:
    return {
        'character_count': int(payload.get('characterCount', 0)),
        'line_count': int(payload.get('lineCount', 0)),
    }
