from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from capture_control_center.domain.models import ScreenshotResult
from capture_control_center.infrastructure.file_names import sanitize_file_name
from capture_control_center.infrastructure.image_store import ImageStore
from capture_control_center.infrastructure.received_file_store import ReceivedFileStore


class FileStorageTests(unittest.TestCase):
    def test_sanitizer_bounds_names_and_avoids_windows_devices(self) -> None:
        sanitized = sanitize_file_name('../CON.' + ('x' * 400) + '.png', 'capture.png')
        self.assertLessEqual(len(sanitized), 180)
        self.assertNotIn('/', sanitized)
        self.assertNotIn('\\', sanitized)
        self.assertFalse(Path(sanitized).stem.upper() == 'CON')

    def test_image_store_does_not_overwrite_duplicate_capture_names(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = ImageStore(Path(temporary_directory))
            screenshot = ScreenshotResult(
                request_id='request-1',
                file_name='capture.png',
                mime_type='image/png',
                base64_data='',
                image_bytes=b'first',
                captured_at='now',
                page_url='',
                page_title='',
                width_css_px=1,
                height_css_px=1,
                scale=1,
            )
            first = store.save(screenshot)
            screenshot.image_bytes = b'second'
            second = store.save(screenshot)

            self.assertNotEqual(first.file_path, second.file_path)
            self.assertEqual(first.file_path.read_bytes(), b'first')
            self.assertEqual(second.file_path.read_bytes(), b'second')

    def test_received_file_index_rejects_paths_outside_store(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            store = ReceivedFileStore(root)
            outside = root / 'outside.txt'
            outside.write_text('outside', encoding='utf-8')
            (store.files_directory / 'index.json').write_text(
                '[{"file_name":"outside.txt","file_path":"' + str(outside).replace('\\', '\\\\') + '"}]',
                encoding='utf-8',
            )
            reloaded = ReceivedFileStore(root)
            self.assertEqual(reloaded.list_files(), [])


if __name__ == '__main__':
    unittest.main()
