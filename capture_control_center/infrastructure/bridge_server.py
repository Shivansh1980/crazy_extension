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
        self._active_connection: ServerConnection | None = None
        self._active_registration: ClientRegistration | None = None
        self._pending_requests: dict[str, asyncio.Future[ScreenshotResult]] = {}
        self._pending_clipboard_requests: dict[str, asyncio.Future[dict[str, int]]] = {}
        self._pending_popup_requests: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_screen_share_requests: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_screen_share_stop_requests: dict[str, asyncio.Future[dict[str, Any]]] = {}
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
            max_size=64 * 1024 * 1024,
        )
        debug_log('python-bridge', 'running...')
        self._emit('server_started', {'host': self._host, 'port': self._port})

    async def stop(self) -> None:
        debug_log('python-bridge', 'Stopping websocket bridge server.')
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        await self._clear_active_client('Server stopped.')
        self._emit('server_stopped', {})

    def set_event_callback(self, callback: Callable[[str, dict[str, Any]], None]) -> None:
        self._event_callback = callback

    async def request_capture(self, timeout_seconds: float = 20.0) -> ScreenshotResult:
        debug_log('python-bridge', 'Preparing capture request.', {'timeout_seconds': timeout_seconds})
        async with self._lock:
            if self._active_connection is None or self._active_registration is None:
                raise RuntimeError('The Chrome extension is not connected. Open the extension options and reconnect the bridge.')

            request_id = str(uuid.uuid4())
            future: asyncio.Future[ScreenshotResult] = asyncio.get_running_loop().create_future()
            self._pending_requests[request_id] = future

            try:
                await self._active_connection.send(json.dumps({'type': 'capture.request', 'requestId': request_id}))
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
        async with self._lock:
            if self._active_connection is None or self._active_registration is None:
                raise RuntimeError('The Chrome extension is not connected. Open the extension options and reconnect the bridge.')

            request_id = str(uuid.uuid4())
            future: asyncio.Future[dict[str, int]] = asyncio.get_running_loop().create_future()
            self._pending_clipboard_requests[request_id] = future

            try:
                await self._active_connection.send(json.dumps({'type': 'clipboard.write', 'requestId': request_id, 'text': text}))
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
        async with self._lock:
            if self._active_connection is None or self._active_registration is None:
                raise RuntimeError('The Chrome extension is not connected. Open the extension options and reconnect the bridge.')

            request_id = str(uuid.uuid4())
            future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
            self._pending_popup_requests[request_id] = future

            try:
                await self._active_connection.send(json.dumps({'type': 'popup.show', 'requestId': request_id, 'text': text}))
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
        async with self._lock:
            if self._active_connection is None or self._active_registration is None:
                raise RuntimeError('The Chrome extension is not connected. Open the extension options and reconnect the bridge.')

            request_id = str(uuid.uuid4())
            future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
            self._pending_screen_share_requests[request_id] = future

            try:
                await self._active_connection.send(json.dumps({'type': 'screen-share.start', 'requestId': request_id}))
            except Exception:
                self._pending_screen_share_requests.pop(request_id, None)
                raise

            debug_log('python-bridge', 'Screen share request sent to extension.', {'request_id': request_id})

        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            self._pending_screen_share_requests.pop(request_id, None)
            raise RuntimeError(f'No screen share response arrived within {timeout_seconds:.0f} seconds.') from error

    async def request_screen_share_stop(self, timeout_seconds: float = 15.0) -> dict[str, Any]:
        debug_log('python-bridge', 'Preparing screen share stop request.', {'timeout_seconds': timeout_seconds})
        async with self._lock:
            if self._active_connection is None or self._active_registration is None:
                raise RuntimeError('The Chrome extension is not connected. Open the extension options and reconnect the bridge.')

            request_id = str(uuid.uuid4())
            future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
            self._pending_screen_share_stop_requests[request_id] = future

            try:
                await self._active_connection.send(json.dumps({'type': 'screen-share.stop', 'requestId': request_id}))
            except Exception:
                self._pending_screen_share_stop_requests.pop(request_id, None)
                raise

            debug_log('python-bridge', 'Screen share stop request sent to extension.', {'request_id': request_id})

        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            self._pending_screen_share_stop_requests.pop(request_id, None)
            raise RuntimeError(f'No screen share stop response arrived within {timeout_seconds:.0f} seconds.') from error

    async def _handle_connection(self, websocket: ServerConnection) -> None:
        debug_log('python-bridge', 'Incoming websocket connection received.')
        try:
            async for raw_message in websocket:
                debug_log('python-bridge', 'Received websocket payload.', raw_message)
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

                if message_type == 'screen-share.status':
                    self._emit('screen_share_status', self._coerce_screen_share_status(payload.get('status', {})))
                    continue
        except ConnectionClosed:
            debug_log('python-bridge', 'Websocket connection closed by peer.')
            pass
        finally:
            await self._handle_disconnect(websocket)

    async def _register_client(self, websocket: ServerConnection, payload: dict[str, Any]) -> None:
        registration = ClientRegistration(
            client_id=str(payload.get('clientId', 'unknown')),
            name=str(payload.get('name', 'unknown')),
            version=str(payload.get('version', 'unknown')),
        )

        async with self._lock:
            if self._active_connection is not None and self._active_connection is not websocket:
                await self._active_connection.close(code=1012, reason='A newer bridge connection replaced this session.')
            self._active_connection = websocket
            self._active_registration = registration

        debug_log('python-bridge', 'Extension client registered.', payload)

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
        async with self._lock:
            if websocket in self._stream_connections:
                self._stream_connections.remove(websocket)
                removed_stream_connection = True

            if websocket is not self._active_connection:
                if removed_stream_connection:
                    self._emit('screen_share_stream_ended', {'message': 'Screen share stream disconnected.'})
                return

            disconnect_reason = 'The Chrome extension bridge disconnected.'
            self._active_connection = None
            self._active_registration = None

        debug_log('python-bridge', 'Active extension disconnected.', disconnect_reason)
        debug_log(
            'python-bridge',
            'Keeping in-flight requests pending while waiting for bridge reconnection.',
            {
                'capture_requests': len(self._pending_requests),
                'clipboard_requests': len(self._pending_clipboard_requests),
                'popup_requests': len(self._pending_popup_requests),
                'screen_share_requests': len(self._pending_screen_share_requests),
                'screen_share_stop_requests': len(self._pending_screen_share_stop_requests),
            },
        )

        self._emit('client_disconnected', {'message': disconnect_reason})
        if removed_stream_connection:
            self._emit('screen_share_stream_ended', {'message': 'Screen share stream disconnected.'})

    async def _clear_active_client(self, message: str) -> None:
        async with self._lock:
            pending = list(self._pending_requests.values())
            pending_clipboard = list(self._pending_clipboard_requests.values())
            pending_popup = list(self._pending_popup_requests.values())
            pending_screen_share = list(self._pending_screen_share_requests.values())
            pending_screen_share_stop = list(self._pending_screen_share_stop_requests.values())
            self._pending_requests.clear()
            self._pending_clipboard_requests.clear()
            self._pending_popup_requests.clear()
            self._pending_screen_share_requests.clear()
            self._pending_screen_share_stop_requests.clear()
            self._active_connection = None
            self._active_registration = None

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

    def _handle_binary_payload(self, raw_message: bytes) -> None:
        if len(raw_message) < 5:
            debug_log('python-bridge', 'Ignoring malformed binary capture payload.', {'length': len(raw_message)})
            return

        metadata_length = int.from_bytes(raw_message[:4], byteorder='big', signed=False)
        if metadata_length <= 0 or len(raw_message) < 4 + metadata_length:
            debug_log(
                'python-bridge',
                'Ignoring binary capture payload with invalid metadata length.',
                {'length': len(raw_message), 'metadata_length': metadata_length},
            )
            return

        try:
            metadata = json.loads(raw_message[4 : 4 + metadata_length].decode('utf-8'))
        except Exception as error:
            debug_log('python-bridge', 'Ignoring binary capture payload with invalid JSON metadata.', str(error))
            return

        payload_type = metadata.get('type')
        if payload_type == 'capture.result.binary':
            self._resolve_pending_binary_capture(metadata, raw_message[4 + metadata_length :])
            return

        if payload_type == 'screen-share.frame.binary':
            self._emit_screen_share_frame(metadata, raw_message[4 + metadata_length :])
            return

        if payload_type != 'capture.result.binary':
            debug_log('python-bridge', 'Ignoring unknown binary websocket payload type.', metadata.get('type'))
            return

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
        debug_log(
            'python-bridge',
            'Binary capture response resolved successfully.',
            {'request_id': request_id, 'file_name': result.file_name, 'bytes': len(image_bytes)},
        )
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
        self._emit(
            'screen_share_frame',
            {
                'mime_type': frame.mime_type,
                'image_bytes': frame.image_bytes,
                'captured_at': frame.captured_at,
                'width': frame.width,
                'height': frame.height,
                'sequence': frame.sequence,
            },
        )

    def _resolve_pending_clipboard_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_clipboard_requests.pop(request_id, None)
        if future is None or future.done():
            return

        result = {
            'character_count': int(payload.get('characterCount', 0)),
            'line_count': int(payload.get('lineCount', 0)),
        }
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
