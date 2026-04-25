from __future__ import annotations

import asyncio
import json
import struct
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse
from urllib.request import urlopen

from websockets.asyncio.client import connect

from capture_client_agent.input_dispatcher import OsInputDispatcher
from capture_client_agent.screen_capture import (
    ScreenCaptureService,
    screen_capture_available,
    screen_capture_unavailable_reason,
)
from capture_control_center.debug import debug_log


DEFAULT_WEBSOCKET_URL = 'ws://127.0.0.1:8765'
DEFAULT_WEBSOCKET_SECONDARY_RESOLVER_URL = (
    'https://raw.githubusercontent.com/Shivansh1980/crazy_extension/refs/heads/main/server_url.txt'
)
RECONNECT_INTERVAL_SECONDS = 5
LOCALHOST_ATTEMPT_THRESHOLD = 10
CLIENT_NAME = 'page-signal-native-client'
CLIENT_VERSION = '2.0.0'
LOCAL_RESOLVER_FILE_NAME = 'server_url.txt'


@dataclass
class ResolvedEndpoint:
    url: str
    source: str


class BackgroundCaptureClient:
    """Connects to the capture bridge and provides screen capture + OS input.

    File reception is intentionally NOT implemented here: the Chrome extension already
    receives popup-uploaded files reliably through its own websocket connection, so the
    native agent only contributes capabilities the browser cannot provide on its own
    (full-desktop screen capture via mss, and synthesized OS-level input via pyautogui).
    """

    def __init__(self, project_directory: Path) -> None:
        self._project_directory = project_directory
        self._client_id = str(uuid.uuid4())
        self._localhost_failure_count = 0
        try:
            self._input_dispatcher: OsInputDispatcher | None = OsInputDispatcher()
            self._input_capable = True
            debug_log('client-agent', 'OS-level input dispatcher ready (pyautogui detected).')
        except RuntimeError as error:
            self._input_dispatcher = None
            self._input_capable = False
            debug_log('client-agent', 'OS-level input disabled.', {'error': str(error)})

        if screen_capture_available():
            try:
                self._screen_capture_service: ScreenCaptureService | None = ScreenCaptureService()
                self._screen_capture_capable = True
                debug_log('client-agent', 'Screen capture service ready (mss + Pillow detected).')
            except RuntimeError as error:
                self._screen_capture_service = None
                self._screen_capture_capable = False
                debug_log('client-agent', 'Screen capture disabled.', {'error': str(error)})
        else:
            self._screen_capture_service = None
            self._screen_capture_capable = False
            debug_log('client-agent', 'Screen capture disabled.', {'error': screen_capture_unavailable_reason()})

    async def run_forever(self) -> None:
        debug_log(
            'client-agent',
            'Starting native capture client.',
            {'client_id': self._client_id},
        )
        while True:
            for endpoint in self._connection_plan():
                try:
                    await self._connect(endpoint)
                except Exception as error:  # noqa: BLE001 - reconnect on any failure
                    debug_log(
                        'client-agent',
                        'Connection attempt failed.',
                        {'endpoint': endpoint.url, 'source': endpoint.source, 'error': str(error)},
                    )
                    continue
            debug_log(
                'client-agent',
                'All endpoints exhausted; sleeping before retry.',
                {'seconds': RECONNECT_INTERVAL_SECONDS},
            )
            await asyncio.sleep(RECONNECT_INTERVAL_SECONDS)

    def _connection_plan(self) -> list[ResolvedEndpoint]:
        plan: list[ResolvedEndpoint] = []
        local_endpoint = self._resolve_local_endpoint()
        if (
            local_endpoint is not None
            and self._localhost_failure_count < LOCALHOST_ATTEMPT_THRESHOLD
        ):
            plan.append(local_endpoint)

        remote_endpoint = self._resolve_remote_endpoint(DEFAULT_WEBSOCKET_SECONDARY_RESOLVER_URL)
        if remote_endpoint is not None:
            plan.append(remote_endpoint)

        if not plan:
            plan.append(ResolvedEndpoint(url=DEFAULT_WEBSOCKET_URL, source='default-fallback'))
        return plan

    def _resolve_local_endpoint(self) -> ResolvedEndpoint | None:
        resolver_path = self._project_directory / LOCAL_RESOLVER_FILE_NAME
        if not resolver_path.is_file():
            return ResolvedEndpoint(url=DEFAULT_WEBSOCKET_URL, source='default-local')
        try:
            raw_value = resolver_path.read_text(encoding='utf-8').strip()
        except OSError as error:
            debug_log('client-agent', 'Failed to read local resolver file.', {'error': str(error)})
            return ResolvedEndpoint(url=DEFAULT_WEBSOCKET_URL, source='default-local')
        normalized = self._normalize_target_url(raw_value)
        if normalized is None:
            return ResolvedEndpoint(url=DEFAULT_WEBSOCKET_URL, source='default-local')
        return ResolvedEndpoint(url=normalized, source='local-file')

    def _resolve_remote_endpoint(self, resolver_url: str) -> ResolvedEndpoint | None:
        try:
            with urlopen(resolver_url, timeout=5) as response:
                raw_value = response.read().decode('utf-8').strip()
        except Exception as error:  # noqa: BLE001 - resolver is best effort
            debug_log('client-agent', 'Remote resolver fetch failed.', {'error': str(error)})
            return None
        normalized = self._normalize_target_url(raw_value)
        if normalized is None:
            return None
        return ResolvedEndpoint(url=normalized, source='remote-resolver')

    def _normalize_target_url(self, raw_value: str) -> str | None:
        if not raw_value:
            return None
        candidate = raw_value.strip()
        if candidate.startswith('tcp://'):
            candidate = 'ws://' + candidate[len('tcp://'):]
        if candidate.startswith('http://'):
            candidate = 'ws://' + candidate[len('http://'):]
        elif candidate.startswith('https://'):
            candidate = 'wss://' + candidate[len('https://'):]
        if not candidate.startswith(('ws://', 'wss://')):
            candidate = 'ws://' + candidate
        try:
            parsed = urlparse(candidate)
        except ValueError:
            return None
        if not parsed.netloc:
            return None
        return urlunparse(parsed)

    async def _connect(self, endpoint: ResolvedEndpoint) -> None:
        debug_log(
            'client-agent',
            'Opening websocket connection.',
            {'endpoint': endpoint.url, 'source': endpoint.source},
        )
        try:
            async with connect(endpoint.url, max_size=None, ping_interval=20, ping_timeout=20) as websocket:
                if endpoint.source in ('local-file', 'default-local'):
                    self._localhost_failure_count = 0
                capabilities: list[str] = []
                if self._input_capable:
                    capabilities.append('os-input')
                if self._screen_capture_capable:
                    capabilities.append('screen-capture')
                await websocket.send(
                    json.dumps(
                        {
                            'type': 'client.register',
                            'clientId': self._client_id,
                            'name': CLIENT_NAME,
                            'version': CLIENT_VERSION,
                            'role': 'native-input-client' if self._input_capable else 'native-file-client',
                            'capabilities': capabilities,
                        }
                    )
                )
                debug_log(
                    'client-agent',
                    'Registered with bridge.',
                    {'endpoint': endpoint.url, 'capabilities': capabilities},
                )
                async for raw_message in websocket:
                    await self._handle_message(websocket, raw_message)
        except Exception:
            if self._screen_capture_service is not None and self._screen_capture_service.active:
                try:
                    await self._screen_capture_service.stop()
                except Exception:  # noqa: BLE001 - best effort cleanup
                    pass
            if endpoint.source in ('local-file', 'default-local'):
                self._localhost_failure_count += 1
            raise

    async def _handle_message(self, websocket: Any, raw_message: Any) -> None:
        if isinstance(raw_message, bytes):
            metadata, _payload_bytes = self._decode_binary_envelope(raw_message)
            message_type = metadata.get('type')
            # File-receive is now handled exclusively by the Chrome extension. Any binary
            # frames the bridge still routes our way (e.g. legacy file-transfer envelopes)
            # are dropped silently.
            debug_log('client-agent', 'Ignoring binary payload (handled by extension).', {'type': message_type})
            return

        try:
            payload = json.loads(raw_message)
        except (TypeError, ValueError):
            debug_log('client-agent', 'Received non-JSON text payload; ignoring.')
            return

        message_type = payload.get('type')
        if message_type == 'screen-share.input':
            await self._handle_screen_share_input(websocket, payload)
            return
        if message_type == 'screen-share.key':
            await self._handle_screen_share_key(websocket, payload)
            return
        if message_type == 'screen-share.start':
            await self._handle_screen_share_start(websocket, payload)
            return
        if message_type == 'screen-share.stop':
            await self._handle_screen_share_stop(websocket, payload)
            return
        debug_log('client-agent', 'Received text payload.', {'type': message_type})

    async def _handle_screen_share_input(self, websocket: Any, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        if self._input_dispatcher is None:
            await websocket.send(
                json.dumps(
                    {
                        'type': 'screen-share.input-error',
                        'requestId': request_id,
                        'message': 'Native input is unavailable on this agent (pyautogui not installed).',
                    }
                )
            )
            return
        try:
            result = await asyncio.to_thread(self._input_dispatcher.dispatch_input, payload)
        except Exception as error:  # noqa: BLE001 - report any dispatch failure
            debug_log('client-agent', 'OS input dispatch failed.', {'error': str(error)})
            await websocket.send(
                json.dumps(
                    {
                        'type': 'screen-share.input-error',
                        'requestId': request_id,
                        'message': str(error) or 'OS input dispatch failed.',
                    }
                )
            )
            return
        await websocket.send(
            json.dumps(
                {
                    'type': 'screen-share.input-result',
                    'requestId': request_id,
                    'message': result.message,
                    'targetDescription': result.target_description,
                    'viewportWidth': result.viewport_width,
                    'viewportHeight': result.viewport_height,
                }
            )
        )

    async def _handle_screen_share_key(self, websocket: Any, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        if self._input_dispatcher is None:
            await websocket.send(
                json.dumps(
                    {
                        'type': 'screen-share.key-error',
                        'requestId': request_id,
                        'message': 'Native key input is unavailable on this agent (pyautogui not installed).',
                    }
                )
            )
            return
        try:
            result = await asyncio.to_thread(self._input_dispatcher.dispatch_key, payload)
        except Exception as error:  # noqa: BLE001 - report any dispatch failure
            debug_log('client-agent', 'OS key dispatch failed.', {'error': str(error)})
            await websocket.send(
                json.dumps(
                    {
                        'type': 'screen-share.key-error',
                        'requestId': request_id,
                        'message': str(error) or 'OS key dispatch failed.',
                    }
                )
            )
            return
        await websocket.send(
            json.dumps(
                {
                    'type': 'screen-share.key-result',
                    'requestId': request_id,
                    'message': result.message,
                    'targetDescription': result.target_description,
                }
            )
        )

    async def _handle_screen_share_start(self, websocket: Any, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        if self._screen_capture_service is None:
            await websocket.send(
                json.dumps(
                    {
                        'type': 'screen-share.error',
                        'requestId': request_id,
                        'message': 'Native screen capture is unavailable on this agent. Install mss/Pillow.',
                    }
                )
            )
            return
        try:
            summary = await self._screen_capture_service.start(websocket)
        except Exception as error:  # noqa: BLE001 - surface to bridge
            debug_log('client-agent', 'Screen capture start failed.', {'error': str(error)})
            await websocket.send(
                json.dumps(
                    {
                        'type': 'screen-share.error',
                        'requestId': request_id,
                        'message': str(error) or 'Failed to start native screen capture.',
                    }
                )
            )
            return
        await websocket.send(
            json.dumps(
                {
                    'type': 'screen-share.result',
                    'requestId': request_id,
                    'status': {
                        'state': 'streaming',
                        'active': True,
                        'viewerWindowId': None,
                        'sourceLabel': summary.source_label,
                        'updatedAt': self._utcnow_iso(),
                        'message': f'Native client streaming desktop ({summary.width}x{summary.height}).',
                    },
                }
            )
        )

    async def _handle_screen_share_stop(self, websocket: Any, payload: dict[str, Any]) -> None:
        request_id = str(payload.get('requestId', ''))
        if self._screen_capture_service is not None:
            try:
                await self._screen_capture_service.stop()
            except Exception as error:  # noqa: BLE001 - report but never crash
                debug_log('client-agent', 'Screen capture stop failed.', {'error': str(error)})
        await websocket.send(
            json.dumps(
                {
                    'type': 'screen-share.stop-result',
                    'requestId': request_id,
                    'status': {
                        'state': 'idle',
                        'active': False,
                        'viewerWindowId': None,
                        'sourceLabel': None,
                        'updatedAt': self._utcnow_iso(),
                        'message': 'Native screen share stopped.',
                    },
                }
            )
        )

    @staticmethod
    def _utcnow_iso() -> str:
        from datetime import datetime, timezone

        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _decode_binary_envelope(raw_message: bytes) -> tuple[dict[str, Any], bytes]:
        if len(raw_message) < 4:
            raise ValueError('Binary envelope is shorter than the metadata length prefix.')
        (metadata_length,) = struct.unpack('>I', raw_message[:4])
        if metadata_length < 0 or 4 + metadata_length > len(raw_message):
            raise ValueError('Binary envelope metadata length is invalid.')
        metadata_bytes = raw_message[4:4 + metadata_length]
        payload_bytes = raw_message[4 + metadata_length:]
        metadata = json.loads(metadata_bytes.decode('utf-8'))
        if not isinstance(metadata, dict):
            raise ValueError('Binary envelope metadata is not a JSON object.')
        return metadata, payload_bytes
