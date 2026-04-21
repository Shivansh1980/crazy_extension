from __future__ import annotations

import asyncio
import queue
from concurrent.futures import Future
from typing import Any

from capture_control_center.debug import debug_log
from capture_control_center.domain.models import SavedCapture
from capture_control_center.infrastructure.bridge_server import BridgeServer
from capture_control_center.infrastructure.image_store import ImageStore


class CaptureController:
    def __init__(self, bridge_server: BridgeServer, image_store: ImageStore, loop: asyncio.AbstractEventLoop) -> None:
        self._bridge_server = bridge_server
        self._image_store = image_store
        self._loop = loop
        self._events: queue.Queue[tuple[str, dict]] = queue.Queue()
        self._bridge_server.set_event_callback(self._enqueue_event)

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

    def stop(self) -> None:
        debug_log('python-controller', 'Stopping bridge server.')
        stop_future = asyncio.run_coroutine_threadsafe(self._bridge_server.stop(), self._loop)
        stop_future.result(timeout=5)

    def _enqueue_event(self, event_name: str, payload: dict[str, Any]) -> None:
        self._events.put_nowait((event_name, payload))

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
