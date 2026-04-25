from __future__ import annotations

import asyncio
import json
import traceback
import uuid
from typing import Any, Callable

from capture_control_center.debug import debug_log
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from capture_control_center.domain.models import ClientRegistration, ScreenshotResult, ScreenShareFrame


class BridgeServer:
    def __init__(self, host: str, port: int) -> None:
        self._host = host
        self._port = port
        self._extension_connection: ServerConnection | None = None
        self._extension_registration: ClientRegistration | None = None
        self._native_input_connection: ServerConnection | None = None
        self._native_input_registration: ClientRegistration | None = None
        self._screen_share_provider: ServerConnection | None = None
        self._screen_share_provider_kind: str = 'none'  # 'native' | 'extension' | 'none'
        self._pending_requests: dict[str, asyncio.Future[ScreenshotResult]] = {}
        self._pending_clipboard_requests: dict[str, asyncio.Future[dict[str, int]]] = {}
        self._pending_popup_requests: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_screen_share_requests: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_screen_share_stop_requests: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_screen_share_click_requests: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_screen_share_paste_requests: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_screen_share_input_requests: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_screen_share_key_requests: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_file_upload_requests: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._server = None
        self._lock = asyncio.Lock()
        self._event_callback: Callable[[str, dict[str, Any]], None] | None = None
        self._stream_connections: set[ServerConnection] = set()

    async def start(self) -> None:
        debug_log('python-bridge', 'Starting websocket bridge server.', {'host': self._host, 'port': self._port})
        self._server = await serve(
            self._handle_connection,
            self._host,
            self._port,
            ping_interval=15,
            ping_timeout=15,
            max_size=None,
        )
        debug_log('python-bridge', 'running...')
        self._emit('server_started', {'host': self._host, 'port': self._port})

    async def stop(self) -> None:
        debug_log('python-bridge', 'Stopping websocket bridge server.')
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        await self._clear_active_clients('Server stopped.')
        self._emit('server_stopped', {})

    def set_event_callback(self, callback: Callable[[str, dict[str, Any]], None]) -> None:
        self._event_callback = callback

    def _select_input_connection_locked(self) -> tuple[ServerConnection | None, str]:
        """Pick the websocket that should receive screen-share input/key events.

        Prefers the native input client (capability ``os-input``) when connected; otherwise falls
        back to the Chrome extension. Caller MUST hold ``self._lock``.
        """
        if self._native_input_connection is not None and self._native_input_registration is not None:
            return self._native_input_connection, 'native-input-client'
        if self._extension_connection is not None and self._extension_registration is not None:
            return self._extension_connection, 'extension-client'
        return None, 'none'

    def has_native_input_client(self) -> bool:
        return self._native_input_connection is not None and self._native_input_registration is not None

    def _select_screen_share_provider_locked(self) -> tuple[ServerConnection | None, str]:
        """Pick the websocket that should provide screen-share frames. Caller MUST hold ``self._lock``.

        Prefers a native client that advertises the ``screen-capture`` capability so the user does
        not need to re-share through the browser picker. Falls back to the Chrome extension when no
        native provider is available.
        """
        if (
            self._native_input_connection is not None
            and self._native_input_registration is not None
            and 'screen-capture' in self._native_input_registration.capabilities
        ):
            return self._native_input_connection, 'native'
        if self._extension_connection is not None and self._extension_registration is not None:
            return self._extension_connection, 'extension'
        return None, 'none'

    async def request_capture(self, timeout_seconds: float = 20.0) -> ScreenshotResult:
        debug_log('python-bridge', 'Preparing capture request.', {'timeout_seconds': timeout_seconds})
        request_id = str(uuid.uuid4())
        future: asyncio.Future[ScreenshotResult] = asyncio.get_running_loop().create_future()

        async with self._lock:
            connection = self._extension_connection
            if connection is None or self._extension_registration is None:
                raise RuntimeError('The Chrome extension is not connected. Open the extension options and reconnect the bridge.')

            self._pending_requests[request_id] = future
            try:
                await connection.send(json.dumps({'type': 'capture.request', 'requestId': request_id}))
            except Exception:
                self._pending_requests.pop(request_id, None)
                raise

        debug_log('python-bridge', 'Capture request sent to extension.', request_id)
        self._emit('capture_requested', {'request_id': request_id})

        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            self._pending_requests.pop(request_id, None)
            raise RuntimeError(f'No capture response arrived within {timeout_seconds:.0f} seconds.') from error

    async def request_clipboard_write(self, text: str, timeout_seconds: float = 15.0) -> dict[str, int]:
        debug_log('python-bridge', 'Preparing clipboard write request.', {'timeout_seconds': timeout_seconds, 'characters': len(text)})
        request_id = str(uuid.uuid4())
        future: asyncio.Future[dict[str, int]] = asyncio.get_running_loop().create_future()

        async with self._lock:
            connection = self._extension_connection
            if connection is None or self._extension_registration is None:
                raise RuntimeError('The Chrome extension is not connected. Open the extension options and reconnect the bridge.')

            self._pending_clipboard_requests[request_id] = future
            try:
                await connection.send(json.dumps({'type': 'clipboard.write', 'requestId': request_id, 'text': text}))
            except Exception:
                self._pending_clipboard_requests.pop(request_id, None)
                raise

        debug_log('python-bridge', 'Clipboard write request sent to extension.', {'request_id': request_id, 'characters': len(text)})

        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            self._pending_clipboard_requests.pop(request_id, None)
            raise RuntimeError(f'No clipboard response arrived within {timeout_seconds:.0f} seconds.') from error

    async def request_popup_show(self, text: str, timeout_seconds: float = 15.0) -> dict[str, Any]:
        debug_log('python-bridge', 'Preparing popup show request.', {'timeout_seconds': timeout_seconds, 'characters': len(text)})
        request_id = str(uuid.uuid4())
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()

        async with self._lock:
            connection = self._extension_connection
            if connection is None or self._extension_registration is None:
                raise RuntimeError('The Chrome extension is not connected. Open the extension options and reconnect the bridge.')

            self._pending_popup_requests[request_id] = future
            try:
                await connection.send(json.dumps({'type': 'popup.show', 'requestId': request_id, 'text': text}))
            except Exception:
                self._pending_popup_requests.pop(request_id, None)
                raise

        debug_log('python-bridge', 'Popup show request sent to extension.', {'request_id': request_id, 'characters': len(text)})

        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            self._pending_popup_requests.pop(request_id, None)
            raise RuntimeError(f'No popup response arrived within {timeout_seconds:.0f} seconds.') from error

    async def request_screen_share_start(self, timeout_seconds: float = 30.0) -> dict[str, Any]:
        debug_log('python-bridge', 'Preparing screen share start request.', {'timeout_seconds': timeout_seconds})
        request_id = str(uuid.uuid4())
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()

        async with self._lock:
            connection, provider_kind = self._select_screen_share_provider_locked()
            if connection is None:
                raise RuntimeError('No screen share provider is connected. Start the native client agent or connect the Chrome extension.')

            self._pending_screen_share_requests[request_id] = future
            self._screen_share_provider = connection
            self._screen_share_provider_kind = provider_kind
            try:
                await connection.send(json.dumps({'type': 'screen-share.start', 'requestId': request_id}))
            except Exception:
                self._pending_screen_share_requests.pop(request_id, None)
                self._screen_share_provider = None
                self._screen_share_provider_kind = 'none'
                raise

        debug_log('python-bridge', 'Screen share request sent.', {'request_id': request_id, 'provider': provider_kind})

        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            self._pending_screen_share_requests.pop(request_id, None)
            raise RuntimeError(f'No screen share response arrived within {timeout_seconds:.0f} seconds.') from error

    async def request_screen_share_stop(self, timeout_seconds: float = 15.0) -> dict[str, Any]:
        debug_log('python-bridge', 'Preparing screen share stop request.', {'timeout_seconds': timeout_seconds})
        request_id = str(uuid.uuid4())
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()

        async with self._lock:
            connection = self._screen_share_provider
            if connection is None:
                # No active provider — fall back to the same selection logic so the GUI can stop a stale browser session too.
                connection, _ = self._select_screen_share_provider_locked()
            if connection is None:
                raise RuntimeError('No screen share provider is connected.')

            self._pending_screen_share_stop_requests[request_id] = future
            try:
                await connection.send(json.dumps({'type': 'screen-share.stop', 'requestId': request_id}))
            except Exception:
                self._pending_screen_share_stop_requests.pop(request_id, None)
                raise

        debug_log('python-bridge', 'Screen share stop request sent.', {'request_id': request_id})

        try:
            response = await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            self._pending_screen_share_stop_requests.pop(request_id, None)
            raise RuntimeError(f'No screen share stop response arrived within {timeout_seconds:.0f} seconds.') from error

        async with self._lock:
            self._screen_share_provider = None
            self._screen_share_provider_kind = 'none'
        return response

    async def request_screen_share_click(
        self,
        normalized_x: float,
        normalized_y: float,
        timeout_seconds: float = 10.0,
    ) -> dict[str, Any]:
        debug_log(
            'python-bridge',
            'Preparing screen share click request.',
            {'timeout_seconds': timeout_seconds, 'normalized_x': normalized_x, 'normalized_y': normalized_y},
        )
        request_id = str(uuid.uuid4())
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()

        async with self._lock:
            connection = self._extension_connection
            if connection is None or self._extension_registration is None:
                raise RuntimeError('The Chrome extension is not connected. Open the extension options and reconnect the bridge.')

            self._pending_screen_share_click_requests[request_id] = future
            try:
                await connection.send(
                    json.dumps(
                        {
                            'type': 'screen-share.click',
                            'requestId': request_id,
                            'normalizedX': normalized_x,
                            'normalizedY': normalized_y,
                        }
                    )
                )
            except Exception:
                self._pending_screen_share_click_requests.pop(request_id, None)
                raise

        debug_log('python-bridge', 'Screen share click request sent to extension.', {'request_id': request_id, 'normalized_x': normalized_x, 'normalized_y': normalized_y})

        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            self._pending_screen_share_click_requests.pop(request_id, None)
            raise RuntimeError(f'No screen share click response arrived within {timeout_seconds:.0f} seconds.') from error

    async def request_screen_share_paste(self, text: str, timeout_seconds: float = 10.0) -> dict[str, Any]:
        debug_log('python-bridge', 'Preparing screen share paste request.', {'timeout_seconds': timeout_seconds, 'characters': len(text)})
        request_id = str(uuid.uuid4())
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()

        async with self._lock:
            connection = self._extension_connection
            if connection is None or self._extension_registration is None:
                raise RuntimeError('The Chrome extension is not connected. Open the extension options and reconnect the bridge.')

            self._pending_screen_share_paste_requests[request_id] = future
            try:
                await connection.send(json.dumps({'type': 'screen-share.paste', 'requestId': request_id, 'text': text}))
            except Exception:
                self._pending_screen_share_paste_requests.pop(request_id, None)
                raise

        debug_log('python-bridge', 'Screen share paste request sent to extension.', {'request_id': request_id, 'characters': len(text)})

        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            self._pending_screen_share_paste_requests.pop(request_id, None)
            raise RuntimeError(f'No screen share paste response arrived within {timeout_seconds:.0f} seconds.') from error

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
        request_id = str(uuid.uuid4())
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        message_payload = {
            'type': 'screen-share.input',
            'requestId': request_id,
            'action': action,
            'normalizedX': normalized_x,
            'normalizedY': normalized_y,
            'button': button,
            'buttons': buttons,
            'deltaX': delta_x,
            'deltaY': delta_y,
            'modifiers': modifiers or {},
        }

        async with self._lock:
            connection, source = self._select_input_connection_locked()
            if connection is None:
                raise RuntimeError('No remote input client is connected. Start the native client agent or connect the Chrome extension.')

            self._pending_screen_share_input_requests[request_id] = future
            try:
                await connection.send(json.dumps(message_payload))
            except Exception:
                self._pending_screen_share_input_requests.pop(request_id, None)
                raise

        debug_log('python-bridge', 'Screen share input dispatched.', {'source': source, 'action': action})

        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            self._pending_screen_share_input_requests.pop(request_id, None)
            raise RuntimeError(f'No screen share input response arrived within {timeout_seconds:.1f} seconds.') from error

    async def request_screen_share_key(
        self,
        action: str,
        key: str = '',
        code: str = '',
        text: str = '',
        modifiers: dict[str, bool] | None = None,
        timeout_seconds: float = 10.0,
    ) -> dict[str, Any]:
        request_id = str(uuid.uuid4())
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        message_payload = {
            'type': 'screen-share.key',
            'requestId': request_id,
            'action': action,
            'key': key,
            'code': code,
            'text': text,
            'modifiers': modifiers or {},
        }

        async with self._lock:
            connection, _selected_source = self._select_input_connection_locked()
            if connection is None:
                raise RuntimeError('No remote input client is connected. Start the native client agent or connect the Chrome extension.')

                self._pending_screen_share_key_requests[request_id] = future
                try:
                    await connection.send(json.dumps(message_payload))
                except Exception:
                    self._pending_screen_share_key_requests.pop(request_id, None)
                    raise

        debug_log('python-bridge', 'Screen share key dispatched.', {'source': _selected_source, 'action': action, 'characters': len(text)})

        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            self._pending_screen_share_key_requests.pop(request_id, None)
            raise RuntimeError(f'No screen share key response arrived within {timeout_seconds:.1f} seconds.') from error

    async def request_file_upload(
        self,
        file_name: str,
        file_bytes: bytes,
        mime_type: str,
        timeout_seconds: float = 90.0,
    ) -> dict[str, Any]:
        debug_log('python-bridge', 'Preparing file upload request.', {'timeout_seconds': timeout_seconds, 'file_name': file_name, 'bytes': len(file_bytes), 'mime_type': mime_type})
        request_id = str(uuid.uuid4())
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        metadata = {
            'type': 'file-transfer.upload.binary',
            'requestId': request_id,
            'fileName': file_name,
            'mimeType': mime_type,
            'byteCount': len(file_bytes),
            'uploadedAt': asyncio.get_running_loop().time(),
        }

        async with self._lock:
            connection = self._extension_connection
            if connection is None or self._extension_registration is None:
                raise RuntimeError('The Chrome extension is not connected. Open the extension options and reconnect the bridge.')

            self._pending_file_upload_requests[request_id] = future
            try:
                await connection.send(self._build_binary_envelope(metadata, file_bytes))
            except Exception:
                self._pending_file_upload_requests.pop(request_id, None)
                raise

        debug_log('python-bridge', 'File upload request sent to extension.', {'request_id': request_id, 'file_name': file_name, 'bytes': len(file_bytes)})

        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            self._pending_file_upload_requests.pop(request_id, None)
            raise RuntimeError(f'No file upload response arrived within {timeout_seconds:.0f} seconds.') from error

    async def _handle_connection(self, websocket: ServerConnection) -> None:
        debug_log('python-bridge', 'Incoming websocket connection received.')
        try:
            async for raw_message in websocket:
                debug_log('python-bridge', 'Received websocket payload.', raw_message if isinstance(raw_message, str) else f'<binary:{len(raw_message)} bytes>')
                if isinstance(raw_message, bytes):
                    self._handle_binary_payload(raw_message)
                    continue

                payload = json.loads(raw_message)
                message_type = payload.get('type')

                if message_type == 'client.register':
                    await self._register_client(websocket, payload)
                    continue

                if message_type == 'screen-share.stream-register':
                    await self._register_stream_connection(websocket, payload)
                    continue

                if message_type == 'capture.result':
                    self._resolve_pending_request(payload)
                    continue

                if message_type == 'capture.error':
                    self._reject_pending_request(payload)
                    continue

                if message_type == 'clipboard.result':
                    self._resolve_pending_clipboard_request(payload)
                    continue

                if message_type == 'clipboard.error':
                    self._reject_pending_clipboard_request(payload)
                    continue

                if message_type == 'popup.result':
                    self._resolve_pending_popup_request(payload)
                    continue

                if message_type == 'popup.error':
                    self._reject_pending_popup_request(payload)
                    continue

                if message_type == 'popup.status':
                    self._emit('popup_status', self._coerce_popup_status(payload.get('status', {}), action='status'))
                    continue

                if message_type == 'popup.message':
                    self._emit('popup_message', self._coerce_popup_message(payload))
                    continue

                if message_type == 'screen-share.result':
                    self._resolve_pending_screen_share_request(payload)
                    continue

                if message_type == 'screen-share.error':
                    self._reject_pending_screen_share_request(payload)
                    continue

                if message_type == 'screen-share.stop-result':
                    self._resolve_pending_screen_share_stop_request(payload)
                    continue

                if message_type == 'screen-share.stop-error':
                    self._reject_pending_screen_share_stop_request(payload)
                    continue

                if message_type == 'screen-share.click-result':
                    self._resolve_pending_screen_share_click_request(payload)
                    continue

                if message_type == 'screen-share.click-error':
                    self._reject_pending_screen_share_click_request(payload)
                    continue

                if message_type == 'screen-share.paste-result':
                    self._resolve_pending_screen_share_paste_request(payload)
                    continue

                if message_type == 'screen-share.paste-error':
                    self._reject_pending_screen_share_paste_request(payload)
                    continue

                if message_type == 'screen-share.input-result':
                    self._resolve_pending_screen_share_input_request(payload)
                    continue

                if message_type == 'screen-share.input-error':
                    self._reject_pending_screen_share_input_request(payload)
                    continue

                if message_type == 'screen-share.key-result':
                    self._resolve_pending_screen_share_key_request(payload)
                    continue

                if message_type == 'screen-share.key-error':
                    self._reject_pending_screen_share_key_request(payload)
                    continue

                if message_type == 'screen-share.status':
                    self._emit('screen_share_status', self._coerce_screen_share_status(payload.get('status', {})))
                    continue

                if message_type == 'file-transfer.result':
                    self._resolve_pending_file_upload_request(payload)
                    continue

                if message_type == 'file-transfer.error':
                    self._reject_pending_file_upload_request(payload)
                    continue
        except ConnectionClosed:
            debug_log('python-bridge', 'Websocket connection closed by peer.')
        finally:
            await self._handle_disconnect(websocket)

    async def _register_client(self, websocket: ServerConnection, payload: dict[str, Any]) -> None:
        capabilities = tuple(item for item in payload.get('capabilities', []) if isinstance(item, str))
        registration = ClientRegistration(
            client_id=str(payload.get('clientId', 'unknown')),
            name=str(payload.get('name', 'unknown')),
            version=str(payload.get('version', 'unknown')),
            capabilities=capabilities,
            role=str(payload.get('role', 'extension-client')),
        )

        is_native_input_client = (
            'os-input' in capabilities
            or registration.role in ('native-input-client', 'native-client', 'desktop-agent')
        )

        replaced_connection = None
        async with self._lock:
            if is_native_input_client:
                if (
                    self._native_input_connection is not None
                    and self._native_input_connection is not websocket
                ):
                    replaced_connection = self._native_input_connection
                self._native_input_connection = websocket
                self._native_input_registration = registration
            else:
                if (
                    self._extension_connection is not None
                    and self._extension_connection is not websocket
                ):
                    replaced_connection = self._extension_connection
                self._extension_connection = websocket
                self._extension_registration = registration

        if replaced_connection is not None:
            await replaced_connection.close(code=1012, reason='A newer bridge connection replaced this session.')

        debug_log(
            'python-bridge',
            'Native-input client registered.' if is_native_input_client else 'Extension client registered.',
            payload,
        )
        if is_native_input_client:
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
            self._emit(
                'client_connected',
                {
                    'client_id': registration.client_id,
                    'name': registration.name,
                    'version': registration.version,
                },
            )

    async def _register_stream_connection(self, websocket: ServerConnection, payload: dict[str, Any]) -> None:
        async with self._lock:
            self._stream_connections.add(websocket)
        debug_log('python-bridge', 'Screen share stream client registered.', payload)

    async def _handle_disconnect(self, websocket: ServerConnection) -> None:
        removed_stream_connection = False
        extension_disconnected = False
        native_input_disconnected = False

        async with self._lock:
            if websocket in self._stream_connections:
                self._stream_connections.remove(websocket)
                removed_stream_connection = True

            if websocket is self._extension_connection:
                self._extension_connection = None
                self._extension_registration = None
                extension_disconnected = True

            if websocket is self._native_input_connection:
                self._native_input_connection = None
                self._native_input_registration = None
                native_input_disconnected = True

            if websocket is self._screen_share_provider:
                self._screen_share_provider = None
                self._screen_share_provider_kind = 'none'

        if extension_disconnected:
            disconnect_reason = 'The Chrome extension bridge disconnected.'
            debug_log('python-bridge', 'Active extension disconnected.', disconnect_reason)
            debug_log(
                'python-bridge',
                'Keeping in-flight extension requests pending while waiting for bridge reconnection.',
                {
                    'capture_requests': len(self._pending_requests),
                    'clipboard_requests': len(self._pending_clipboard_requests),
                    'popup_requests': len(self._pending_popup_requests),
                    'screen_share_requests': len(self._pending_screen_share_requests),
                    'screen_share_stop_requests': len(self._pending_screen_share_stop_requests),
                    'screen_share_click_requests': len(self._pending_screen_share_click_requests),
                    'screen_share_paste_requests': len(self._pending_screen_share_paste_requests),
                },
            )
            self._emit('client_disconnected', {'message': disconnect_reason})

        if native_input_disconnected:
            disconnect_reason = 'The native input client disconnected.'
            debug_log('python-bridge', 'Native input client disconnected.', disconnect_reason)
            self._emit('native_input_disconnected', {'message': disconnect_reason})

        if removed_stream_connection:
            self._emit('screen_share_stream_ended', {'message': 'Screen share stream disconnected.'})

    async def _clear_active_clients(self, message: str) -> None:
        async with self._lock:
            pending = list(self._pending_requests.values())
            pending_clipboard = list(self._pending_clipboard_requests.values())
            pending_popup = list(self._pending_popup_requests.values())
            pending_screen_share = list(self._pending_screen_share_requests.values())
            pending_screen_share_stop = list(self._pending_screen_share_stop_requests.values())
            pending_screen_share_click = list(self._pending_screen_share_click_requests.values())
            pending_screen_share_paste = list(self._pending_screen_share_paste_requests.values())
            pending_screen_share_input = list(self._pending_screen_share_input_requests.values())
            pending_screen_share_key = list(self._pending_screen_share_key_requests.values())
            pending_file_upload = list(self._pending_file_upload_requests.values())
            self._pending_requests.clear()
            self._pending_clipboard_requests.clear()
            self._pending_popup_requests.clear()
            self._pending_screen_share_requests.clear()
            self._pending_screen_share_stop_requests.clear()
            self._pending_screen_share_click_requests.clear()
            self._pending_screen_share_paste_requests.clear()
            self._pending_screen_share_input_requests.clear()
            self._pending_screen_share_key_requests.clear()
            self._pending_file_upload_requests.clear()
            self._extension_connection = None
            self._extension_registration = None
            self._native_input_connection = None
            self._native_input_registration = None
        for future in pending:
            if not future.done():
                future.set_exception(RuntimeError(message))

        for future in pending_clipboard:
            if not future.done():
                future.set_exception(RuntimeError(message))

        for future in pending_popup:
            if not future.done():
                future.set_exception(RuntimeError(message))

        for future in pending_screen_share:
            if not future.done():
                future.set_exception(RuntimeError(message))

        for future in pending_screen_share_stop:
            if not future.done():
                future.set_exception(RuntimeError(message))

        for future in pending_screen_share_click:
            if not future.done():
                future.set_exception(RuntimeError(message))

        for future in pending_screen_share_paste:
            if not future.done():
                future.set_exception(RuntimeError(message))

        for future in pending_screen_share_input:
            if not future.done():
                future.set_exception(RuntimeError(message))

        for future in pending_screen_share_key:
            if not future.done():
                future.set_exception(RuntimeError(message))

        for future in pending_file_upload:
            if not future.done():
                future.set_exception(RuntimeError(message))

    def _handle_binary_payload(self, raw_message: bytes) -> None:
        if len(raw_message) < 5:
            debug_log('python-bridge', 'Ignoring malformed binary payload.', {'length': len(raw_message)})
            return

        metadata_length = int.from_bytes(raw_message[:4], byteorder='big', signed=False)
        if metadata_length <= 0 or len(raw_message) < 4 + metadata_length:
            debug_log('python-bridge', 'Ignoring binary payload with invalid metadata length.', {'length': len(raw_message), 'metadata_length': metadata_length})
            return

        try:
            metadata = json.loads(raw_message[4 : 4 + metadata_length].decode('utf-8'))
        except Exception as error:
            debug_log('python-bridge', 'Ignoring binary payload with invalid JSON metadata.', str(error))
            return

        payload_type = metadata.get('type')
        payload_bytes = raw_message[4 + metadata_length :]

        if payload_type == 'capture.result.binary':
            self._resolve_pending_binary_capture(metadata, payload_bytes)
            return

        if payload_type == 'screen-share.frame.binary':
            self._emit_screen_share_frame(metadata, payload_bytes)
            return

        if payload_type == 'popup-file.binary':
            debug_log(
                'python-bridge',
                'Received popup-file.binary envelope.',
                {
                    'file_name': metadata.get('fileName'),
                    'mime_type': metadata.get('mimeType'),
                    'byte_count': metadata.get('byteCount'),
                    'payload_bytes': len(payload_bytes),
                    'tab_id': metadata.get('tabId'),
                },
            )
            self._emit_popup_file(metadata, payload_bytes)
            return

        debug_log('python-bridge', 'Ignoring unknown binary websocket payload type.', payload_type)

    def _resolve_pending_request(self, payload: dict[str, Any]) -> None:
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
        debug_log('python-bridge', 'Capture response resolved successfully.', {'request_id': request_id, 'file_name': result.file_name})
        self._emit('capture_received', {'request_id': request_id, 'file_name': result.file_name})

    def _reject_pending_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_requests.pop(request_id, None)
        if future is None or future.done():
            return

        message = str(payload.get('message', 'The extension reported an unknown error.'))
        future.set_exception(RuntimeError(message))
        debug_log('python-bridge', 'Capture response returned an error.', {'request_id': request_id, 'message': message})
        self._emit('capture_failed', {'request_id': request_id, 'message': message})

    def _resolve_pending_binary_capture(self, metadata: dict[str, Any], image_bytes: bytes) -> None:
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
            image_bytes=image_bytes,
            captured_at=str(captured_page.get('capturedAt', '')),
            page_url=str(captured_page.get('tab', {}).get('url', '')),
            page_title=str(captured_page.get('tab', {}).get('title', '')),
            width_css_px=int(captured_page.get('widthCssPx', 0)),
            height_css_px=int(captured_page.get('heightCssPx', 0)),
            scale=float(captured_page.get('scale', 1)),
        )
        future.set_result(result)
        debug_log('python-bridge', 'Binary capture response resolved successfully.', {'request_id': request_id, 'file_name': result.file_name, 'bytes': len(image_bytes)})
        self._emit('capture_received', {'request_id': request_id, 'file_name': result.file_name})

    def _emit_screen_share_frame(self, metadata: dict[str, Any], image_bytes: bytes) -> None:
        frame = ScreenShareFrame(
            mime_type=str(metadata.get('mimeType', 'image/jpeg')),
            image_bytes=image_bytes,
            captured_at=str(metadata.get('capturedAt', '')),
            width=int(metadata.get('width', 0)),
            height=int(metadata.get('height', 0)),
            sequence=int(metadata.get('sequence', 0)),
        )
        # Optional partial-frame fields. Defaults preserve backward compatibility with the
        # extension-driven full-frame stream.
        partial = bool(metadata.get('partial', False))
        offset_x = int(metadata.get('offsetX', 0)) if isinstance(metadata.get('offsetX'), (int, float)) else 0
        offset_y = int(metadata.get('offsetY', 0)) if isinstance(metadata.get('offsetY'), (int, float)) else 0
        frame_width = int(metadata.get('frameWidth', frame.width)) if isinstance(metadata.get('frameWidth'), (int, float)) else frame.width
        frame_height = int(metadata.get('frameHeight', frame.height)) if isinstance(metadata.get('frameHeight'), (int, float)) else frame.height
        source_label = metadata.get('sourceLabel') if isinstance(metadata.get('sourceLabel'), str) else None
        self._emit(
            'screen_share_frame',
            {
                'mime_type': frame.mime_type,
                'image_bytes': frame.image_bytes,
                'captured_at': frame.captured_at,
                'width': frame.width,
                'height': frame.height,
                'sequence': frame.sequence,
                'partial': partial,
                'offset_x': offset_x,
                'offset_y': offset_y,
                'frame_width': frame_width,
                'frame_height': frame_height,
                'source_label': source_label,
            },
        )

    def _emit_popup_file(self, metadata: dict[str, Any], file_bytes: bytes) -> None:
        debug_log(
            'python-bridge',
            'Emitting popup_file_received event to controller.',
            {
                'file_name': metadata.get('fileName'),
                'byte_count': metadata.get('byteCount'),
                'actual_bytes': len(file_bytes),
            },
        )
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

    def _resolve_pending_clipboard_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_clipboard_requests.pop(request_id, None)
        if future is None or future.done():
            return

        result = {'character_count': int(payload.get('characterCount', 0)), 'line_count': int(payload.get('lineCount', 0))}
        future.set_result(result)
        debug_log('python-bridge', 'Clipboard response resolved successfully.', {'request_id': request_id, **result})

    def _reject_pending_clipboard_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_clipboard_requests.pop(request_id, None)
        if future is None or future.done():
            return

        message = str(payload.get('message', 'The extension reported an unknown clipboard error.'))
        future.set_exception(RuntimeError(message))
        debug_log('python-bridge', 'Clipboard response returned an error.', {'request_id': request_id, 'message': message})

    def _resolve_pending_popup_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_popup_requests.pop(request_id, None)
        if future is None or future.done():
            return

        result = self._coerce_popup_status(payload.get('status', {}), action=str(payload.get('action', 'updated')))
        future.set_result(result)
        debug_log('python-bridge', 'Popup response resolved successfully.', {'request_id': request_id, **result})

    def _reject_pending_popup_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_popup_requests.pop(request_id, None)
        if future is None or future.done():
            return

        message = str(payload.get('message', 'The extension reported an unknown popup error.'))
        future.set_exception(RuntimeError(message))
        debug_log('python-bridge', 'Popup response returned an error.', {'request_id': request_id, 'message': message})

    def _resolve_pending_screen_share_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_screen_share_requests.pop(request_id, None)
        if future is None or future.done():
            return

        result = self._coerce_screen_share_status(payload.get('status', {}))
        future.set_result(result)
        debug_log('python-bridge', 'Screen share response resolved successfully.', {'request_id': request_id, **result})
        self._emit('screen_share_status', result)

    def _reject_pending_screen_share_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_screen_share_requests.pop(request_id, None)
        if future is None or future.done():
            return

        message = str(payload.get('message', 'The extension reported an unknown screen share error.'))
        future.set_exception(RuntimeError(message))
        debug_log('python-bridge', 'Screen share response returned an error.', {'request_id': request_id, 'message': message})

    def _resolve_pending_screen_share_stop_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_screen_share_stop_requests.pop(request_id, None)
        if future is None or future.done():
            return

        result = self._coerce_screen_share_status(payload.get('status', {}))
        future.set_result(result)
        debug_log('python-bridge', 'Screen share stop response resolved successfully.', {'request_id': request_id, **result})
        self._emit('screen_share_status', result)

    def _reject_pending_screen_share_stop_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_screen_share_stop_requests.pop(request_id, None)
        if future is None or future.done():
            return

        message = str(payload.get('message', 'The extension reported an unknown screen share stop error.'))
        future.set_exception(RuntimeError(message))
        debug_log('python-bridge', 'Screen share stop response returned an error.', {'request_id': request_id, 'message': message})

    def _resolve_pending_screen_share_click_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_screen_share_click_requests.pop(request_id, None)
        if future is None or future.done():
            return

        result = {
            'message': str(payload.get('message', 'Remote click delivered to the shared page.')),
            'target_description': str(payload.get('targetDescription', 'page element')),
            'viewport_width': int(payload.get('viewportWidth', 0)),
            'viewport_height': int(payload.get('viewportHeight', 0)),
        }
        future.set_result(result)
        debug_log('python-bridge', 'Screen share click response resolved successfully.', {'request_id': request_id, **result})

    def _reject_pending_screen_share_click_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_screen_share_click_requests.pop(request_id, None)
        if future is None or future.done():
            return

        message = str(payload.get('message', 'The extension reported an unknown screen share click error.'))
        future.set_exception(RuntimeError(message))
        debug_log('python-bridge', 'Screen share click response returned an error.', {'request_id': request_id, 'message': message})

    def _resolve_pending_screen_share_paste_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_screen_share_paste_requests.pop(request_id, None)
        if future is None or future.done():
            return

        result = {
            'message': str(payload.get('message', 'Clipboard text inserted into the shared page.')),
            'target_description': str(payload.get('targetDescription', 'focused element')),
            'character_count': int(payload.get('characterCount', 0)),
        }
        future.set_result(result)
        debug_log('python-bridge', 'Screen share paste response resolved successfully.', {'request_id': request_id, **result})

    def _reject_pending_screen_share_paste_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_screen_share_paste_requests.pop(request_id, None)
        if future is None or future.done():
            return

        message = str(payload.get('message', 'The extension reported an unknown screen share paste error.'))
        future.set_exception(RuntimeError(message))
        debug_log('python-bridge', 'Screen share paste response returned an error.', {'request_id': request_id, 'message': message})

    def _resolve_pending_screen_share_input_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_screen_share_input_requests.pop(request_id, None)
        if future is None or future.done():
            return

        result = {
            'message': str(payload.get('message', 'Remote input delivered.')),
            'target_description': str(payload.get('targetDescription', 'page element')),
            'viewport_width': int(payload.get('viewportWidth', 0)),
            'viewport_height': int(payload.get('viewportHeight', 0)),
        }
        future.set_result(result)

    def _reject_pending_screen_share_input_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_screen_share_input_requests.pop(request_id, None)
        if future is None or future.done():
            return
        message = str(payload.get('message', 'The extension reported an unknown screen share input error.'))
        future.set_exception(RuntimeError(message))

    def _resolve_pending_screen_share_key_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_screen_share_key_requests.pop(request_id, None)
        if future is None or future.done():
            return

        result = {
            'message': str(payload.get('message', 'Remote key event delivered.')),
            'target_description': str(payload.get('targetDescription', 'focused element')),
        }
        future.set_result(result)

    def _reject_pending_screen_share_key_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_screen_share_key_requests.pop(request_id, None)
        if future is None or future.done():
            return
        message = str(payload.get('message', 'The extension reported an unknown screen share key error.'))
        future.set_exception(RuntimeError(message))

    def _resolve_pending_file_upload_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_file_upload_requests.pop(request_id, None)
        if future is None or future.done():
            return

        result = self._coerce_file_transfer_status(payload)
        future.set_result(result)
        debug_log('python-bridge', 'File upload response resolved successfully.', {'request_id': request_id, **result})
        self._emit('file_transfer_status', result)

    def _reject_pending_file_upload_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_file_upload_requests.pop(request_id, None)
        if future is None or future.done():
            return

        message = str(payload.get('message', 'The native client reported an unknown file transfer error.'))
        future.set_exception(RuntimeError(message))
        debug_log('python-bridge', 'File upload response returned an error.', {'request_id': request_id, 'message': message})

    def _coerce_popup_status(self, status: dict[str, Any], action: str) -> dict[str, Any]:
        return {
            'exists': bool(status.get('exists')),
            'state': str(status.get('state', 'unknown')),
            'tab_id': int(status['tabId']) if isinstance(status.get('tabId'), int) else None,
            'page_url': status.get('pageUrl') if isinstance(status.get('pageUrl'), str) and status.get('pageUrl') else None,
            'updated_at': str(status.get('updatedAt', '')),
            'text_length': int(status.get('textLength', 0)),
            'action': action,
        }

    def _coerce_popup_message(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            'text': str(payload.get('text', '')),
            'page_url': payload.get('pageUrl') if isinstance(payload.get('pageUrl'), str) and payload.get('pageUrl') else None,
            'tab_id': int(payload['tabId']) if isinstance(payload.get('tabId'), int) else None,
            'sent_at': str(payload.get('sentAt', '')),
        }

    def _coerce_screen_share_status(self, status: dict[str, Any]) -> dict[str, Any]:
        return {
            'state': str(status.get('state', 'idle')),
            'active': bool(status.get('active')),
            'viewer_window_id': int(status['viewerWindowId']) if isinstance(status.get('viewerWindowId'), int) else None,
            'source_label': status.get('sourceLabel') if isinstance(status.get('sourceLabel'), str) and status.get('sourceLabel') else None,
            'updated_at': str(status.get('updatedAt', '')),
            'message': str(status.get('message', 'Screen share is idle.')),
        }

    def _coerce_file_transfer_status(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            'file_name': str(payload.get('fileName', 'unknown')),
            'saved_path': str(payload.get('savedPath', '')),
            'byte_count': int(payload.get('byteCount', 0)),
            'downloaded_at': str(payload.get('downloadedAt', '')),
            'message': str(payload.get('message', 'File saved on the client.')),
        }

    def _build_binary_envelope(self, metadata: dict[str, Any], payload_bytes: bytes) -> bytes:
        metadata_bytes = json.dumps(metadata).encode('utf-8')
        envelope = bytearray(4 + len(metadata_bytes) + len(payload_bytes))
        envelope[0:4] = len(metadata_bytes).to_bytes(4, byteorder='big', signed=False)
        envelope[4 : 4 + len(metadata_bytes)] = metadata_bytes
        envelope[4 + len(metadata_bytes) :] = payload_bytes
        return bytes(envelope)

    def _emit(self, event_name: str, payload: dict[str, Any]) -> None:
        if self._event_callback is not None:
            try:
                self._event_callback(event_name, payload)
            except Exception as error:
                debug_log(
                    'python-bridge',
                    'Event callback failed; continuing without interrupting the bridge.',
                    {
                        'event_name': event_name,
                        'payload': payload,
                        'error': str(error),
                        'traceback': traceback.format_exc(),
                    },
                )