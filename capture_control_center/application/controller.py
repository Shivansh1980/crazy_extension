from __future__ import annotations

import asyncio
import mimetypes
import queue
from concurrent.futures import Future
from pathlib import Path
from typing import Any

from capture_control_center.debug import debug_log
from capture_control_center.domain.models import ReceivedClientFile, SavedCapture
from capture_control_center.infrastructure.bridge_server import BridgeServer
from capture_control_center.infrastructure.image_store import ImageStore
from capture_control_center.infrastructure.received_file_store import ReceivedFileStore


class CaptureController:
    def __init__(
        self,
        bridge_server: BridgeServer,
        image_store: ImageStore,
        received_file_store: ReceivedFileStore,
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        self._bridge_server = bridge_server
        self._image_store = image_store
        self._received_file_store = received_file_store
        self._loop = loop
        self._events: queue.Queue[tuple[str, dict]] = queue.Queue()
        self._bridge_server.set_event_callback(self._handle_bridge_event)

    @property
    def events(self) -> queue.Queue[tuple[str, dict]]:
        return self._events

    def request_capture(self) -> Future[SavedCapture]:
        debug_log('python-controller', 'Capture requested from GUI.')
        return asyncio.run_coroutine_threadsafe(self._capture_and_store(), self._loop)

    def send_clipboard_text(self, text: str) -> Future[None]:
        debug_log('python-controller', 'Clipboard write requested from GUI.', {'characters': len(text)})
        return asyncio.run_coroutine_threadsafe(self._send_clipboard_text(text), self._loop)

    def send_popup_text(self, text: str) -> Future[dict[str, Any]]:
        debug_log('python-controller', 'Popup write requested from GUI.', {'characters': len(text)})
        return asyncio.run_coroutine_threadsafe(self._send_popup_text(text), self._loop)

    def request_screen_share(self) -> Future[dict[str, Any]]:
        debug_log('python-controller', 'Screen share requested from GUI.')
        return asyncio.run_coroutine_threadsafe(self._request_screen_share(), self._loop)

    def stop_screen_share(self) -> Future[dict[str, Any]]:
        debug_log('python-controller', 'Screen share stop requested from GUI.')
        return asyncio.run_coroutine_threadsafe(self._stop_screen_share(), self._loop)

    def send_screen_share_click(self, normalized_x: float, normalized_y: float) -> Future[dict[str, Any]]:
        debug_log(
            'python-controller',
            'Screen share click requested from GUI.',
            {'normalized_x': normalized_x, 'normalized_y': normalized_y},
        )
        return asyncio.run_coroutine_threadsafe(
            self._send_screen_share_click(normalized_x, normalized_y),
            self._loop,
        )

    def send_screen_share_paste(self, text: str) -> Future[dict[str, Any]]:
        debug_log('python-controller', 'Screen share paste requested from GUI.', {'characters': len(text)})
        return asyncio.run_coroutine_threadsafe(self._send_screen_share_paste(text), self._loop)

    def send_screen_share_input(
        self,
        action: str,
        normalized_x: float,
        normalized_y: float,
        button: int = 0,
        buttons: int = 0,
        delta_x: float = 0.0,
        delta_y: float = 0.0,
        modifiers: dict[str, bool] | None = None,
    ) -> Future[dict[str, Any]]:
        return asyncio.run_coroutine_threadsafe(
            self._bridge_server.request_screen_share_input(
                action=action,
                normalized_x=normalized_x,
                normalized_y=normalized_y,
                button=button,
                buttons=buttons,
                delta_x=delta_x,
                delta_y=delta_y,
                modifiers=modifiers,
            ),
            self._loop,
        )

    def send_screen_share_key(
        self,
        action: str,
        key: str = '',
        code: str = '',
        text: str = '',
        modifiers: dict[str, bool] | None = None,
    ) -> Future[dict[str, Any]]:
        return asyncio.run_coroutine_threadsafe(
            self._bridge_server.request_screen_share_key(
                action=action,
                key=key,
                code=code,
                text=text,
                modifiers=modifiers,
            ),
            self._loop,
        )

    def send_file_to_browser(self, file_path: Path) -> Future[dict[str, Any]]:
        debug_log('python-controller', 'Browser download requested from GUI.', {'file_path': str(file_path)})
        return asyncio.run_coroutine_threadsafe(self._send_file_to_browser(file_path), self._loop)

    def stop(self) -> None:
        debug_log('python-controller', 'Stopping bridge server.')
        stop_future = asyncio.run_coroutine_threadsafe(self._bridge_server.stop(), self._loop)
        stop_future.result(timeout=5)

    def list_received_client_files(self) -> list[dict[str, Any]]:
        records = self._received_file_store.list_files()
        return [self._serialize_received_file(record) for record in records]

    def _enqueue_event(self, event_name: str, payload: dict[str, Any]) -> None:
        self._events.put_nowait((event_name, payload))

    def _handle_bridge_event(self, event_name: str, payload: dict[str, Any]) -> None:
        if event_name == 'popup_file_received':
            debug_log(
                'python-controller',
                'Scheduling popup file save.',
                {'file_name': payload.get('file_name'), 'byte_count': payload.get('byte_count')},
            )
            # If the popup carried an accompanying text message alongside the file, surface
            # it through the regular popup_message channel BEFORE saving the file so the
            # GUI's "Latest popup message" updates first and the file appears second.
            accompanying_text = payload.get('text')
            if isinstance(accompanying_text, str) and accompanying_text:
                self._enqueue_event(
                    'popup_message',
                    {
                        'text': accompanying_text,
                        'page_url': payload.get('page_url'),
                        'tab_id': payload.get('tab_id'),
                        'sent_at': payload.get('sent_at', ''),
                    },
                )
            # run_coroutine_threadsafe is safe whether _handle_bridge_event runs on the loop
            # thread (the typical case) or some other thread. Using it instead of
            # call_soon_threadsafe + create_task gives us a Future we can await on if needed
            # and avoids a subtle race where the lambda captured an already-completed payload.
            asyncio.run_coroutine_threadsafe(self._store_popup_file(payload), self._loop)
            return

        self._enqueue_event(event_name, payload)

    async def _capture_and_store(self) -> SavedCapture:
        debug_log('python-controller', 'Waiting for screenshot from extension.')
        screenshot = await self._bridge_server.request_capture()
        saved_capture = self._image_store.save(screenshot)
        debug_log('python-controller', 'Screenshot saved locally.', str(saved_capture.file_path))
        self._events.put_nowait(
            (
                'capture_saved',
                {
                    'file_path': str(saved_capture.file_path),
                    'file_name': saved_capture.screenshot.file_name,
                    'page_title': saved_capture.screenshot.page_title,
                    'page_url': saved_capture.screenshot.page_url,
                    'captured_at': saved_capture.screenshot.captured_at,
                },
            )
        )
        return saved_capture

    async def _send_clipboard_text(self, text: str) -> None:
        debug_log('python-controller', 'Sending clipboard text through the bridge.', {'characters': len(text)})
        result = await self._bridge_server.request_clipboard_write(text)
        self._events.put_nowait(
            (
                'clipboard_written',
                {
                    'character_count': result['character_count'],
                    'line_count': result['line_count'],
                },
            )
        )

    async def _send_popup_text(self, text: str) -> dict[str, Any]:
        debug_log('python-controller', 'Sending popup text through the bridge.', {'characters': len(text)})
        result = await self._bridge_server.request_popup_show(text)
        self._events.put_nowait(('popup_status', result))
        return result

    async def _request_screen_share(self) -> dict[str, Any]:
        debug_log('python-controller', 'Sending screen share request through the bridge.')
        result = await self._bridge_server.request_screen_share_start()
        self._events.put_nowait(('screen_share_status', result))
        return result

    async def _stop_screen_share(self) -> dict[str, Any]:
        debug_log('python-controller', 'Sending screen share stop request through the bridge.')
        result = await self._bridge_server.request_screen_share_stop()
        self._events.put_nowait(('screen_share_status', result))
        return result

    async def _send_screen_share_click(self, normalized_x: float, normalized_y: float) -> dict[str, Any]:
        debug_log(
            'python-controller',
            'Sending screen share click through the bridge.',
            {'normalized_x': normalized_x, 'normalized_y': normalized_y},
        )
        return await self._bridge_server.request_screen_share_click(normalized_x, normalized_y)

    async def _send_screen_share_paste(self, text: str) -> dict[str, Any]:
        debug_log('python-controller', 'Sending screen share paste through the bridge.', {'characters': len(text)})
        return await self._bridge_server.request_screen_share_paste(text)

    async def _send_file_to_browser(self, file_path: Path) -> dict[str, Any]:
        debug_log('python-controller', 'Sending file to browser through the bridge.', {'file_path': str(file_path)})
        file_bytes = await asyncio.to_thread(file_path.read_bytes)
        mime_type, _ = mimetypes.guess_type(file_path.name)
        return await self._bridge_server.request_file_upload(
            file_name=file_path.name,
            file_bytes=file_bytes,
            mime_type=mime_type or 'application/octet-stream',
        )

    async def _store_popup_file(self, payload: dict[str, Any]) -> None:
        debug_log(
            'python-controller',
            'Storing popup-uploaded file.',
            {
                'file_name': payload.get('file_name'),
                'mime_type': payload.get('mime_type'),
                'byte_count': payload.get('byte_count'),
                'tab_id': payload.get('tab_id'),
            },
        )
        try:
            file_bytes = payload.get('file_bytes')
            if not isinstance(file_bytes, (bytes, bytearray)):
                raise RuntimeError('The popup file payload did not contain valid file bytes.')

            saved_file = await asyncio.to_thread(
                self._received_file_store.save,
                file_name=str(payload.get('file_name', 'client-upload.bin')),
                file_bytes=bytes(file_bytes),
                mime_type=str(payload.get('mime_type', 'application/octet-stream')),
                page_url=payload.get('page_url') if isinstance(payload.get('page_url'), str) and payload.get('page_url') else None,
                tab_id=int(payload['tab_id']) if isinstance(payload.get('tab_id'), int) else None,
                received_at=str(payload.get('sent_at', '')),
            )
        except Exception as error:
            debug_log('python-controller', 'Saving popup-uploaded file failed.', str(error))
            self._enqueue_event('popup_file_failed', {'message': str(error)})
            return

        debug_log(
            'python-controller',
            'Popup-uploaded file saved locally; enqueuing popup_file_saved.',
            {'file_path': str(saved_file.file_path), 'byte_count': saved_file.byte_count},
        )
        self._enqueue_event('popup_file_saved', self._serialize_received_file(saved_file))

    def _serialize_received_file(self, record: ReceivedClientFile) -> dict[str, Any]:
        return {
            'file_name': record.file_name,
            'file_path': str(record.file_path),
            'mime_type': record.mime_type,
            'byte_count': record.byte_count,
            'page_url': record.page_url,
            'tab_id': record.tab_id,
            'received_at': record.received_at,
        }
