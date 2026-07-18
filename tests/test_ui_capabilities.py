from __future__ import annotations

import unittest

from capture_control_center.presentation.capabilities import UiCapabilities


class UiCapabilitiesTests(unittest.TestCase):
    def test_no_clients_exposes_only_local_ui(self) -> None:
        capabilities = UiCapabilities.from_connections(None, None)

        self.assertFalse(capabilities.capture)
        self.assertFalse(capabilities.clipboard)
        self.assertFalse(capabilities.popup)
        self.assertFalse(capabilities.screen_share)
        self.assertFalse(capabilities.remote_input)
        self.assertFalse(capabilities.text_tools)

    def test_extension_features_follow_advertised_capabilities(self) -> None:
        extension = {
            'capabilities': [
                'capture.full-page',
                'clipboard.write',
                'popup.browser',
                'file-transfer.browser',
                'screen-share.preview',
                'screen-share.input',
                'screen-share.paste',
            ]
        }
        capabilities = UiCapabilities.from_connections(extension, None)

        self.assertTrue(capabilities.capture)
        self.assertTrue(capabilities.clipboard)
        self.assertTrue(capabilities.popup)
        self.assertTrue(capabilities.file_transfer)
        self.assertTrue(capabilities.screen_share)
        self.assertTrue(capabilities.remote_input)
        self.assertTrue(capabilities.remote_paste)
        self.assertTrue(capabilities.browser_paste)
        self.assertFalse(capabilities.native_screen_capture)

    def test_native_client_never_exposes_browser_clipboard(self) -> None:
        native = {
            'capabilities': ['os-input', 'screen-capture', 'native-popup', 'file-transfer.native']
        }
        capabilities = UiCapabilities.from_connections(None, native)

        self.assertTrue(capabilities.capture)
        self.assertFalse(capabilities.clipboard)
        self.assertTrue(capabilities.popup)
        self.assertTrue(capabilities.file_transfer)
        self.assertTrue(capabilities.screen_share)
        self.assertTrue(capabilities.remote_input)
        self.assertTrue(capabilities.remote_paste)
        self.assertFalse(capabilities.browser_paste)
        self.assertTrue(capabilities.native_screen_capture)

    def test_missing_native_input_capability_hides_remote_control(self) -> None:
        native = {'capabilities': ['screen-capture', 'native-popup']}
        capabilities = UiCapabilities.from_connections(None, native)

        self.assertTrue(capabilities.screen_share)
        self.assertFalse(capabilities.remote_input)
        self.assertFalse(capabilities.remote_paste)

    def test_legacy_extension_registration_keeps_compatible_features(self) -> None:
        capabilities = UiCapabilities.from_connections({'name': 'legacy-extension'}, None)

        self.assertTrue(capabilities.capture)
        self.assertTrue(capabilities.clipboard)
        self.assertTrue(capabilities.popup)
        self.assertTrue(capabilities.remote_input)


if __name__ == '__main__':
    unittest.main()
