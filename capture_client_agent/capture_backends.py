"""Robust screen-capture backend chain.

Most "my screenshot is black" failures on Windows fall into a small set of
buckets. This module picks the best available capture method per call, with
graceful fallbacks, so the agent keeps producing usable frames even when one
method is defeated:

| Backend                                | Catches                                         |
|----------------------------------------|-------------------------------------------------|
| ``dxcam`` (DXGI Desktop Duplication)   | HW-accelerated video, GPU-rasterized Chrome,    |
|                                        | DirectX windowed games, layered windows.        |
| ``mss`` (GDI BitBlt)                   | Universal fallback. Works on any Windows.       |

Selection heuristic:
1. Try ``dxcam`` first if installed; instantiated lazily and reused.
2. If a frame fails or comes back **mostly black** (>= ``BLACK_FRAME_RATIO``
   near-black pixels), the backend is demoted for ``DEMOTION_SECONDS`` and the
   next backend in the chain is used instead.
3. Periodically re-promote (so a transient device-lost in DXGI \u2014 e.g. RDP
   resize, GPU driver reset \u2014 doesn't permanently disable the fast path).

What this module **cannot** capture (Windows-level protections \u2014 no user-mode
method works, only a kernel driver helps):
- ``SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`` windows (Win 10 2004+)
- DRM-protected video surfaces (Widevine / PlayReady)
- The UAC secure desktop / lock screen (only LOCAL_SYSTEM can see those)
- Other-session windows when running as the wrong user

Callers should treat a black frame as "the user has something protected on
screen; show a placeholder" rather than as an agent bug.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Optional, Tuple

try:  # pragma: no cover - optional fast path
    import dxcam  # type: ignore
except Exception:  # noqa: BLE001
    dxcam = None  # type: ignore[assignment]

try:  # pragma: no cover - PIL is required by the rest of the agent
    from PIL import Image
except Exception:  # noqa: BLE001 - surfaced by screen_capture.py
    Image = None  # type: ignore[assignment]

try:  # pragma: no cover - mss is required as the universal fallback
    import mss  # type: ignore
except Exception:  # noqa: BLE001 - surfaced by screen_capture.py
    mss = None  # type: ignore[assignment]


# A frame is "black" if 99% of its pixels are within this threshold of pure
# black. Pure-black frames are the classic "GDI tried to capture HW-accelerated
# content" symptom; when we see one we demote the backend that produced it.
BLACK_FRAME_THRESHOLD = 8           # 0..255 per channel
BLACK_FRAME_RATIO = 0.99            # fraction of pixels that must be near-black
DEMOTION_SECONDS = 30.0             # how long to skip a backend after it fails


@dataclass
class CapturedFrame:
    """One captured frame, normalized to a PIL RGB Image and a backend label."""

    image: object  # PIL.Image.Image
    backend: str
    width: int
    height: int


class _DxcamBackend:
    """Thin wrapper around ``dxcam`` that creates the camera lazily and
    survives device-lost / monitor-disconnect events by recycling the camera.
    """

    name = 'dxgi-dd'

    def __init__(self) -> None:
        self._camera = None  # type: ignore[assignment]
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        return dxcam is not None and Image is not None

    def grab(self) -> Optional[Any]:
        if not self.available:
            return None
        with self._lock:
            if self._camera is None:
                try:
                    # output_color='RGB' so we can drop straight into PIL.
                    self._camera = dxcam.create(output_color='RGB')  # type: ignore[union-attr]
                except Exception:
                    return None
                if self._camera is None:
                    return None
            try:
                frame = self._camera.grab()
            except Exception:
                # device lost / monitor change \u2014 force a fresh camera next time.
                self._dispose_locked()
                return None
            if frame is None:
                # dxcam returns None when the screen hasn't changed since the
                # last grab. Force a fresh frame by re-grabbing once.
                try:
                    frame = self._camera.grab()
                except Exception:
                    self._dispose_locked()
                    return None
            if frame is None:
                return None
            try:
                # frame is an HxWx3 numpy array of uint8.
                return Image.fromarray(frame, 'RGB')  # type: ignore[union-attr]
            except Exception:
                return None

    def reset(self) -> None:
        with self._lock:
            self._dispose_locked()

    def _dispose_locked(self) -> None:
        cam = self._camera
        self._camera = None
        if cam is not None:
            try:
                cam.release()
            except Exception:
                pass


class _MssBackend:
    """Universal GDI fallback. Always available when ``mss`` is installed."""

    name = 'gdi-mss'

    @property
    def available(self) -> bool:
        return mss is not None and Image is not None

    def grab(self) -> Optional[Any]:
        if not self.available:
            return None
        try:
            with mss.mss() as sct:  # type: ignore[union-attr]
                monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
                shot = sct.grab(monitor)
                return Image.frombytes('RGB', shot.size, shot.bgra, 'raw', 'BGRX')  # type: ignore[union-attr]
        except Exception:
            return None


class CaptureBackendChain:
    """Chooses the best available backend per call and demotes failing ones.

    Thread-safe; intended to be a single long-lived instance per process.
    """

    def __init__(self) -> None:
        self._backends = [_DxcamBackend(), _MssBackend()]
        self._demoted_until: dict[str, float] = {}
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        return any(b.available for b in self._backends)

    @property
    def available_backends(self) -> list[str]:
        return [b.name for b in self._backends if b.available]

    def grab(self) -> Optional[CapturedFrame]:
        """Capture one frame. Returns ``None`` only if every backend failed."""

        now = time.monotonic()
        for backend in self._backends:
            if not backend.available:
                continue
            with self._lock:
                demote_until = self._demoted_until.get(backend.name, 0.0)
            if now < demote_until:
                continue

            image = backend.grab()
            if image is None:
                self._demote(backend, reason='returned None')
                continue
            if _is_mostly_black(image):
                # The capture succeeded but the result is unusable. Try the
                # next backend in the chain on the same frame.
                self._demote(backend, reason='mostly-black frame')
                continue
            return CapturedFrame(
                image=image,
                backend=backend.name,
                width=image.width,
                height=image.height,
            )
        return None

    def _demote(self, backend, reason: str) -> None:
        # Reset internal state so the next promotion starts clean.
        try:
            backend.reset()  # type: ignore[attr-defined]
        except AttributeError:
            pass
        with self._lock:
            self._demoted_until[backend.name] = time.monotonic() + DEMOTION_SECONDS
        try:  # pragma: no cover - best-effort logging
            from capture_control_center.debug import debug_log

            debug_log(
                'client-agent',
                'Capture backend demoted.',
                {'backend': backend.name, 'reason': reason, 'cooldown_seconds': DEMOTION_SECONDS},
            )
        except Exception:
            pass


def _is_mostly_black(image) -> bool:
    """Return True if the image is essentially a pure-black frame.

    Hardware-accelerated content (videos, games, GPU-rasterized Chrome) shows
    up as a near-pure-black rectangle when grabbed via plain GDI BitBlt. We use
    a coarse downsample so this is cheap (\u224810 us per frame).
    """

    if image is None or Image is None:  # type: ignore[truthy-bool]
        return False
    try:
        # Downsample to <= 64 pixels on the long side; statistic is stable.
        thumb = image.copy()
        thumb.thumbnail((64, 64), Image.NEAREST)  # type: ignore[union-attr]
        pixels = thumb.tobytes()
    except Exception:
        return False
    if not pixels:
        return False
    near_black = 0
    for value in pixels:
        if value <= BLACK_FRAME_THRESHOLD:
            near_black += 1
    ratio = near_black / float(len(pixels))
    return ratio >= BLACK_FRAME_RATIO


# Module-level singleton so callers don't recreate the dxcam camera per frame.
_chain: Optional[CaptureBackendChain] = None
_chain_lock = threading.Lock()


def get_backend_chain() -> CaptureBackendChain:
    global _chain
    with _chain_lock:
        if _chain is None:
            _chain = CaptureBackendChain()
        return _chain


def grab_one(max_width: int = 0) -> Optional[Tuple[Any, str, Tuple[int, int]]]:
    """Convenience helper: grab one frame, optionally downscaled.

    Returns ``(PIL.Image, backend_name, (original_w, original_h))`` or ``None``.
    """

    chain = get_backend_chain()
    captured = chain.grab()
    if captured is None:
        return None
    image = captured.image
    original = (image.width, image.height)
    if max_width > 0 and image.width > max_width:
        new_h = int(round(image.height * (max_width / image.width)))
        image = image.resize((max_width, new_h), Image.LANCZOS)  # type: ignore[union-attr]
    return image, captured.backend, original
