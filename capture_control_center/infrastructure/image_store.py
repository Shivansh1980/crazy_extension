from __future__ import annotations

import base64
from pathlib import Path

from capture_control_center.domain.models import SavedCapture, ScreenshotResult
from capture_control_center.infrastructure.file_names import build_unique_path, sanitize_file_name


class ImageStore:
    def __init__(self, root_directory: Path) -> None:
      self._images_directory = root_directory / 'images'
      self._images_directory.mkdir(parents=True, exist_ok=True)

    @property
    def images_directory(self) -> Path:
      return self._images_directory

    def save(self, screenshot: ScreenshotResult) -> SavedCapture:
      safe_name = sanitize_file_name(screenshot.file_name, 'capture.png')
      file_path = build_unique_path(self._images_directory, safe_name)
      image_bytes = screenshot.image_bytes
      if image_bytes is None:
          image_bytes = base64.b64decode(screenshot.base64_data.encode('utf-8'))
      file_path.write_bytes(image_bytes)
      return SavedCapture(file_path=file_path, screenshot=screenshot)
