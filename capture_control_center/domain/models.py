from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(slots=True)
class ClientRegistration:
    client_id: str
    name: str
    version: str


@dataclass(slots=True)
class ScreenshotResult:
    request_id: str
    file_name: str
    mime_type: str
    base64_data: str
    image_bytes: bytes | None
    captured_at: str
    page_url: str
    page_title: str
    width_css_px: int
    height_css_px: int
    scale: float


@dataclass(slots=True)
class SavedCapture:
    file_path: Path
    screenshot: ScreenshotResult


@dataclass(slots=True)
class ScreenShareFrame:
    mime_type: str
    image_bytes: bytes
    captured_at: str
    width: int
    height: int
    sequence: int
