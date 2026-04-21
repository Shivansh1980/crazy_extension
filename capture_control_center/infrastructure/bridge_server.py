from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any, Callable

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from capture_control_center.domain.models import ClientRegistration, ScreenshotResult


class BridgeServer:
    def __init__(self, host: str, port: int) -> None:
        self._host = host
        self._port = port
        self._active_connection: ServerConnection | None = None
        self._active_registration: ClientRegistration | None = None
        self._pending_requests: dict[str, asyncio.Future[ScreenshotResult]] = {}
        self._server = None
        self._lock = asyncio.Lock()
        self._event_callback: Callable[[str, dict[str, Any]], None] | None = None

    async def start(self) -> None:
        self._server = await serve(
            self._handle_connection,
            self._host,
            self._port,
            ping_interval=15,
            ping_timeout=15,
            max_size=64 * 1024 * 1024,
        )
        self._emit('server_started', {'host': self._host, 'port': self._port})

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        await self._clear_active_client('Server stopped.')
        self._emit('server_stopped', {})

    def set_event_callback(self, callback: Callable[[str, dict[str, Any]], None]) -> None:
        self._event_callback = callback

    async def request_capture(self, timeout_seconds: float = 20.0) -> ScreenshotResult:
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

        self._emit('capture_requested', {'request_id': request_id})

        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            self._pending_requests.pop(request_id, None)
            raise RuntimeError(f'No capture response arrived within {timeout_seconds:.0f} seconds.') from error

    async def _handle_connection(self, websocket: ServerConnection) -> None:
        try:
            async for raw_message in websocket:
                payload = json.loads(raw_message)
                message_type = payload.get('type')

                if message_type == 'client.register':
                    await self._register_client(websocket, payload)
                    continue

                if message_type == 'capture.result':
                    self._resolve_pending_request(payload)
                    continue

                if message_type == 'capture.error':
                    self._reject_pending_request(payload)
                    continue
        except ConnectionClosed:
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

        self._emit(
            'client_connected',
            {
                'client_id': registration.client_id,
                'name': registration.name,
                'version': registration.version,
            },
        )

    async def _handle_disconnect(self, websocket: ServerConnection) -> None:
        async with self._lock:
            if websocket is not self._active_connection:
                return

            disconnect_reason = 'The Chrome extension bridge disconnected.'
            self._active_connection = None
            self._active_registration = None
            pending = list(self._pending_requests.values())
            self._pending_requests.clear()

        for future in pending:
            if not future.done():
                future.set_exception(RuntimeError(disconnect_reason))

        self._emit('client_disconnected', {'message': disconnect_reason})

    async def _clear_active_client(self, message: str) -> None:
        async with self._lock:
            pending = list(self._pending_requests.values())
            self._pending_requests.clear()
            self._active_connection = None
            self._active_registration = None

        for future in pending:
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
            captured_at=str(captured_page.get('capturedAt', '')),
            page_url=str(captured_page.get('tab', {}).get('url', '')),
            page_title=str(captured_page.get('tab', {}).get('title', '')),
            width_css_px=int(captured_page.get('widthCssPx', 0)),
            height_css_px=int(captured_page.get('heightCssPx', 0)),
            scale=float(captured_page.get('scale', 1)),
        )
        future.set_result(result)
        self._emit('capture_received', {'request_id': request_id, 'file_name': result.file_name})

    def _reject_pending_request(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        future = self._pending_requests.pop(request_id, None)
        if future is None or future.done():
            return

        message = str(payload.get('message', 'The extension reported an unknown error.'))
        future.set_exception(RuntimeError(message))
        self._emit('capture_failed', {'request_id': request_id, 'message': message})

    def _emit(self, event_name: str, payload: dict[str, Any]) -> None:
        if self._event_callback is not None:
            self._event_callback(event_name, payload)
