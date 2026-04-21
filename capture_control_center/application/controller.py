from __future__ import annotations

import asyncio
import queue
from concurrent.futures import Future

from capture_control_center.domain.models import SavedCapture
from capture_control_center.infrastructure.bridge_server import BridgeServer
from capture_control_center.infrastructure.image_store import ImageStore


class CaptureController:
    def __init__(self, bridge_server: BridgeServer, image_store: ImageStore, loop: asyncio.AbstractEventLoop) -> None:
        self._bridge_server = bridge_server
        self._image_store = image_store
        self._loop = loop
        self._events: queue.Queue[tuple[str, dict]] = queue.Queue()
        self._bridge_server.set_event_callback(self._events.put_nowait)

    @property
    def events(self) -> queue.Queue[tuple[str, dict]]:
        return self._events

    def request_capture(self) -> Future[SavedCapture]:
        return asyncio.run_coroutine_threadsafe(self._capture_and_store(), self._loop)

    def stop(self) -> None:
        stop_future = asyncio.run_coroutine_threadsafe(self._bridge_server.stop(), self._loop)
        stop_future.result(timeout=5)

    async def _capture_and_store(self) -> SavedCapture:
        screenshot = await self._bridge_server.request_capture()
        saved_capture = self._image_store.save(screenshot)
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
