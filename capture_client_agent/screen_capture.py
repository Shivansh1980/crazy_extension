"""Native OS screen capture service for the client agent.

Uses :mod:`mss` for fast cross-platform screen grabbing and :mod:`PIL` for diff/encode. Streams
JPEG-encoded frames over the supplied websocket using the existing binary-envelope protocol the
Python bridge already understands (``type='screen-share.frame.binary'``).

Bandwidth optimization: each frame is compared against the previous one and only the bounding box
of the changed pixels is encoded and sent. A full keyframe is forced periodically (every
``KEYFRAME_INTERVAL_SECONDS``) and whenever the dirty-region covers more than 60% of the canvas.
"""

from __future__ import annotations

import asyncio
import io
import json
import struct
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

try:  # pragma: no cover - optional dependency
    import mss
except Exception as import_error:  # noqa: BLE001
    mss = None  # type: ignore[assignment]
    _MSS_IMPORT_ERROR: Exception | None = import_error
else:
    _MSS_IMPORT_ERROR = None

try:  # pragma: no cover - PIL is provided by Pillow which is already required
    from PIL import Image, ImageChops
except Exception as import_error:  # noqa: BLE001
    Image = None  # type: ignore[assignment]
    ImageChops = None  # type: ignore[assignment]
    _PIL_IMPORT_ERROR: Exception | None = import_error
else:
    _PIL_IMPORT_ERROR = None


CAPTURE_INTERVAL_SECONDS = 1.0 / 15  # 15 FPS target
KEYFRAME_INTERVAL_SECONDS = 2.0
HEARTBEAT_INTERVAL_SECONDS = 5.0
MAX_FRAME_WIDTH_PX = 1600
JPEG_QUALITY_KEYFRAME = 80
JPEG_QUALITY_PARTIAL = 72
FULL_FRAME_AREA_RATIO_TRIGGER = 0.6


def screen_capture_available() -> bool:
    return _MSS_IMPORT_ERROR is None and _PIL_IMPORT_ERROR is None


def screen_capture_unavailable_reason() -> str:
    if _MSS_IMPORT_ERROR is not None:
        return f'mss is not installed: {_MSS_IMPORT_ERROR}. Install with "pip install mss".'
    if _PIL_IMPORT_ERROR is not None:
        return f'Pillow is not installed: {_PIL_IMPORT_ERROR}. Install with "pip install Pillow".'
    return 'screen capture is unavailable for an unknown reason.'


@dataclass(slots=True)
class CaptureSummary:
    width: int
    height: int
    monitor_index: int
    source_label: str


class ScreenCaptureService:
    """Owns a running capture+stream loop. ``start`` / ``stop`` are idempotent and concurrency-safe."""

    def __init__(self) -> None:
        if not screen_capture_available():
            raise RuntimeError(screen_capture_unavailable_reason())
        self._task: asyncio.Task[None] | None = None
        self._websocket: Any | None = None
        self._sequence: int = 0
        self._previous_frame = None  # type: ignore[assignment]
        self._canvas_size: tuple[int, int] = (0, 0)
        self._last_keyframe_at: float = 0.0
        self._last_send_at: float = 0.0
        self._summary: CaptureSummary | None = None
        self._stop_event = asyncio.Event()

    @property
    def active(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def summary(self) -> CaptureSummary | None:
        return self._summary

    async def start(self, websocket: Any) -> CaptureSummary:
        if self.active:
            assert self._summary is not None
            return self._summary

        # Probe display geometry on a worker thread so import + grab happen off the event loop.
        summary = await asyncio.to_thread(self._probe_primary_monitor)
        self._websocket = websocket
        self._sequence = 0
        self._previous_frame = None
        self._canvas_size = (summary.width, summary.height)
        self._last_keyframe_at = 0.0
        self._last_send_at = 0.0
        self._summary = summary
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._run_loop())
        return summary

    async def stop(self) -> None:
        if not self.active:
            return
        assert self._task is not None
        self._stop_event.set()
        try:
            await asyncio.wait_for(self._task, timeout=2.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            self._task.cancel()
        finally:
            self._task = None
            self._websocket = None
            self._previous_frame = None
            self._summary = None

    # -------------------------------------------------------------------- internals

    @staticmethod
    def _probe_primary_monitor() -> CaptureSummary:
        with mss.mss() as sct:  # type: ignore[union-attr]
            # mss.monitors[0] is the union of all displays; index 1 is the primary monitor.
            monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            width = int(monitor.get('width') or 0)
            height = int(monitor.get('height') or 0)
            return CaptureSummary(
                width=width,
                height=height,
                monitor_index=1 if len(sct.monitors) > 1 else 0,
                source_label=f'Primary display ({width}x{height})',
            )

    async def _run_loop(self) -> None:
        try:
            while not self._stop_event.is_set():
                started_at = time.monotonic()
                try:
                    await self._capture_and_send_once()
                except Exception as error:  # noqa: BLE001 - never tear down the agent
                    # Log and continue: a single bad frame must not stop the stream.
                    from capture_control_center.debug import debug_log

                    debug_log('client-agent', 'Screen capture frame failed.', {'error': str(error)})
                elapsed = time.monotonic() - started_at
                sleep_for = max(0.0, CAPTURE_INTERVAL_SECONDS - elapsed)
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=sleep_for)
                    break  # stop_event set during sleep
                except asyncio.TimeoutError:
                    continue
        finally:
            self._previous_frame = None

    async def _capture_and_send_once(self) -> None:
        websocket = self._websocket
        if websocket is None:
            return

        prepared = await asyncio.to_thread(self._capture_and_encode)
        if prepared is None:
            return

        envelope, sent_keyframe = prepared
        try:
            await websocket.send(envelope)
        except Exception:
            # Surface so the outer loop can decide; reset previous frame so the next attempt is a keyframe.
            self._previous_frame = None
            raise

        now = time.monotonic()
        self._last_send_at = now
        if sent_keyframe:
            self._last_keyframe_at = now

    def _capture_and_encode(self) -> tuple[bytes, bool] | None:
        with mss.mss() as sct:  # type: ignore[union-attr]
            monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            shot = sct.grab(monitor)
            current = Image.frombytes('RGB', shot.size, shot.bgra, 'raw', 'BGRX')  # type: ignore[union-attr]

        original_size = current.size
        if current.width > MAX_FRAME_WIDTH_PX:
            new_width = MAX_FRAME_WIDTH_PX
            new_height = int(round(current.height * (MAX_FRAME_WIDTH_PX / current.width)))
            current = current.resize((new_width, new_height), Image.LANCZOS)  # type: ignore[union-attr]

        canvas_width, canvas_height = current.size
        canvas_changed = (canvas_width, canvas_height) != self._canvas_size
        if canvas_changed:
            self._canvas_size = (canvas_width, canvas_height)
            self._previous_frame = None  # force keyframe when canvas resized

        now = time.monotonic()
        force_keyframe = (
            self._previous_frame is None
            or canvas_changed
            or (now - self._last_keyframe_at) >= KEYFRAME_INTERVAL_SECONDS
        )

        partial_bbox: tuple[int, int, int, int] | None = None
        if not force_keyframe and self._previous_frame is not None:
            diff = ImageChops.difference(self._previous_frame, current)  # type: ignore[union-attr]
            bbox = diff.getbbox()
            if bbox is None:
                # Nothing changed. Honor heartbeat to keep the viewer alive.
                if (now - self._last_send_at) < HEARTBEAT_INTERVAL_SECONDS:
                    return None
                # Send a tiny 1x1 partial as heartbeat so receivers update last-seen timestamps.
                bbox = (0, 0, 1, 1)
            partial_bbox = bbox
            area_ratio = self._area_ratio(bbox, canvas_width, canvas_height)
            if area_ratio >= FULL_FRAME_AREA_RATIO_TRIGGER:
                force_keyframe = True
                partial_bbox = None

        self._previous_frame = current

        self._sequence += 1
        captured_at = datetime.now(timezone.utc).isoformat()

        if force_keyframe:
            payload_bytes = self._encode_image(current, JPEG_QUALITY_KEYFRAME)
            metadata = {
                'type': 'screen-share.frame.binary',
                'sequence': self._sequence,
                'capturedAt': captured_at,
                'mimeType': 'image/jpeg',
                'width': canvas_width,
                'height': canvas_height,
                'frameWidth': canvas_width,
                'frameHeight': canvas_height,
                'offsetX': 0,
                'offsetY': 0,
                'partial': False,
                'sourceWidth': original_size[0],
                'sourceHeight': original_size[1],
                'sourceLabel': self._summary.source_label if self._summary else 'desktop',
            }
            return self._build_binary_envelope(metadata, payload_bytes), True

        assert partial_bbox is not None
        left, top, right, bottom = partial_bbox
        partial_image = current.crop(partial_bbox)
        payload_bytes = self._encode_image(partial_image, JPEG_QUALITY_PARTIAL)
        metadata = {
            'type': 'screen-share.frame.binary',
            'sequence': self._sequence,
            'capturedAt': captured_at,
            'mimeType': 'image/jpeg',
            'width': right - left,
            'height': bottom - top,
            'frameWidth': canvas_width,
            'frameHeight': canvas_height,
            'offsetX': left,
            'offsetY': top,
            'partial': True,
            'sourceWidth': original_size[0],
            'sourceHeight': original_size[1],
            'sourceLabel': self._summary.source_label if self._summary else 'desktop',
        }
        return self._build_binary_envelope(metadata, payload_bytes), False

    @staticmethod
    def _encode_image(image: Any, quality: int) -> bytes:
        buffer = io.BytesIO()
        image.save(buffer, format='JPEG', quality=quality, optimize=False)
        return buffer.getvalue()

    @staticmethod
    def _area_ratio(bbox: tuple[int, int, int, int], width: int, height: int) -> float:
        if width <= 0 or height <= 0:
            return 1.0
        left, top, right, bottom = bbox
        bbox_area = max(0, right - left) * max(0, bottom - top)
        return bbox_area / float(width * height)

    @staticmethod
    def _build_binary_envelope(metadata: dict[str, Any], payload_bytes: bytes) -> bytes:
        metadata_bytes = json.dumps(metadata).encode('utf-8')
        prefix = struct.pack('>I', len(metadata_bytes))
        return prefix + metadata_bytes + payload_bytes
