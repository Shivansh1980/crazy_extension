from __future__ import annotations

import queue
import tkinter as tk
import unittest
from pathlib import Path

from capture_control_center.presentation.gui import CaptureControlWindow


class _ControllerStub:
    def __init__(self) -> None:
        self.events: queue.Queue[tuple[str, dict]] = queue.Queue()


class GuiCapabilityVisibilityTests(unittest.TestCase):
    def setUp(self) -> None:
        try:
            self.root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(f'Tk display is unavailable: {error}')
        self.root.withdraw()
        self.window = CaptureControlWindow(
            self.root,
            _ControllerStub(),  # type: ignore[arg-type]
            Path.cwd() / 'images',
            Path.cwd() / 'client_uploads',
            'ws://127.0.0.1:8765',
        )
        self.root.update_idletasks()

    def tearDown(self) -> None:
        if hasattr(self, 'root'):
            self.root.destroy()

    def test_remote_actions_start_hidden(self) -> None:
        self.assertEqual(self.window._action_buttons['clipboard'].winfo_manager(), '')
        self.assertEqual(self.window._action_buttons['popup'].winfo_manager(), '')
        self.assertEqual(self.window._action_buttons['screen_share'].winfo_manager(), '')
        self.assertEqual(self.window._action_buttons['open_folder'].winfo_manager(), 'grid')
        self.assertEqual(self.window._text_panel_card.winfo_manager(), '')

    def test_extension_and_native_connections_recompute_visible_actions(self) -> None:
        self.window._extension_connection_details = {
            'capabilities': ['clipboard.write', 'popup.browser', 'file-transfer.browser']
        }
        self.window._update_capabilities()
        self.root.update_idletasks()

        self.assertEqual(self.window._action_buttons['clipboard'].winfo_manager(), 'grid')
        self.assertEqual(self.window._action_buttons['popup'].winfo_manager(), 'grid')
        self.assertEqual(self.window._action_buttons['screen_share'].winfo_manager(), '')
        self.assertEqual(self.window._text_panel_card.winfo_manager(), 'grid')

        self.window._extension_connection_details = None
        self.window._native_connection_details = {
            'capabilities': ['screen-capture', 'os-input', 'native-popup', 'file-transfer.native']
        }
        self.window._update_capabilities()
        self.root.update_idletasks()

        self.assertEqual(self.window._action_buttons['clipboard'].winfo_manager(), '')
        self.assertEqual(self.window._action_buttons['popup'].winfo_manager(), 'grid')
        self.assertEqual(self.window._action_buttons['screen_share'].winfo_manager(), 'grid')
        self.assertTrue(self.window._ui_capabilities.remote_input)


if __name__ == '__main__':
    unittest.main()
