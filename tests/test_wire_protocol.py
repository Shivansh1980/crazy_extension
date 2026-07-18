from __future__ import annotations

import unittest

from capture_control_center.infrastructure.wire_protocol import (
    MAX_BINARY_METADATA_BYTES,
    build_binary_envelope,
    coerce_popup_status,
    parse_binary_envelope,
)
from live_server.live_server import MessageRouter


class WireProtocolTests(unittest.TestCase):
    def test_binary_envelope_round_trip(self) -> None:
        metadata = {'type': 'file-transfer.upload.binary', 'requestId': 'request-1'}
        payload = b'\x00\x01payload'
        decoded = parse_binary_envelope(build_binary_envelope(metadata, payload))
        self.assertIsNotNone(decoded)
        decoded_metadata, decoded_payload = decoded or ({}, b'')
        self.assertEqual(decoded_metadata, metadata)
        self.assertEqual(decoded_payload, payload)

    def test_malformed_envelopes_are_rejected(self) -> None:
        self.assertIsNone(parse_binary_envelope(b''))
        self.assertIsNone(parse_binary_envelope(b'\x00\x00\x00\x08{}'))
        self.assertIsNone(parse_binary_envelope(b'\x00\x00\x00\x02[]payload'))
        oversized_prefix = (MAX_BINARY_METADATA_BYTES + 1).to_bytes(4, byteorder='big')
        self.assertIsNone(parse_binary_envelope(oversized_prefix + b'{}'))

    def test_relay_routes_targeted_binary_envelopes_to_one_role(self) -> None:
        raw = build_binary_envelope(
            {'type': 'file-transfer.upload.binary', '_target': 'native-input-client'},
            b'file bytes',
        )
        self.assertEqual(MessageRouter._extract_target_role(raw), 'native-input-client')

    def test_popup_status_shape_matches_direct_and_relay_modes(self) -> None:
        result = coerce_popup_status(
            {
                'exists': True,
                'state': 'open',
                'tabId': 7,
                'pageUrl': 'https://example.test/',
                'updatedAt': 'now',
                'textLength': 12,
            },
            action='created',
        )
        self.assertEqual(result['exists'], True)
        self.assertEqual(result['page_url'], 'https://example.test/')
        self.assertEqual(result['text_length'], 12)
        self.assertEqual(result['action'], 'created')


if __name__ == '__main__':
    unittest.main()
