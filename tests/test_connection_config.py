from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from capture_client_agent.connection_config import NativeConnectionConfig, normalize_websocket_url


_CONFIG_KEYS = {
    'NATIVE_CONNECTION_MODE',
    'MODE',
    'NATIVE_BRIDGE_URL',
    'WEBSOCKET_URL',
    'BRIDGE_HOST',
    'BRIDGE_PORT',
    'RELAY_URL',
    'SESSION_ID',
    'WEBSOCKET_RESOLVER_URL',
    'WEBSOCKET_SECONDARY_RESOLVER_URL',
}


class NativeConnectionConfigTests(unittest.TestCase):
    def test_loads_parent_env_and_normalizes_urls(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            nested = root / 'capture_client_agent' / 'dll' / 'dist'
            nested.mkdir(parents=True)
            (root / '.env').write_text(
                '\n'.join(
                    (
                        'MODE=relay',
                        'RELAY_URL=https://relay.example.test/ws',
                        'SESSION_ID=team-one',
                        'BRIDGE_HOST=0.0.0.0',
                        'BRIDGE_PORT=9876',
                    )
                ),
                encoding='utf-8',
            )
            clean_environment = {key: value for key, value in os.environ.items() if key not in _CONFIG_KEYS}
            with patch.dict(os.environ, clean_environment, clear=True):
                config = NativeConnectionConfig.load(nested)

        self.assertEqual(config.mode, 'relay')
        self.assertEqual(config.relay_url, 'wss://relay.example.test/ws')
        self.assertEqual(config.session_id, 'team-one')
        self.assertEqual(config.direct_url, 'ws://127.0.0.1:9876')

    def test_process_environment_overrides_env_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / '.env').write_text('MODE=direct\nSESSION_ID=file-value\n', encoding='utf-8')
            clean_environment = {key: value for key, value in os.environ.items() if key not in _CONFIG_KEYS}
            clean_environment.update({'MODE': 'relay', 'SESSION_ID': 'process-value', 'RELAY_URL': 'relay.test:443'})
            with patch.dict(os.environ, clean_environment, clear=True):
                config = NativeConnectionConfig.load(root)

        self.assertEqual(config.mode, 'relay')
        self.assertEqual(config.session_id, 'process-value')
        self.assertEqual(config.relay_url, 'ws://relay.test:443')

    def test_url_normalization_rejects_invalid_targets(self) -> None:
        self.assertEqual(normalize_websocket_url('https://example.test/path'), 'wss://example.test/path')
        self.assertEqual(normalize_websocket_url('tcp://127.0.0.1:9000'), 'ws://127.0.0.1:9000')
        self.assertEqual(normalize_websocket_url('not a url'), '')


if __name__ == '__main__':
    unittest.main()
