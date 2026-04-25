"""Shared wire-protocol helpers used by BridgeServer (direct mode) and
RelayBridgeClient (relay mode).

Keeping these as free functions / static helpers means both transports speak
the EXACT same protocol with zero duplication of envelope/coercion logic.
"""

from __future__ import annotations

import json
import struct
from typing import Any


def coerce_popup_status(status: dict[str, Any], action: str = 'updated') -> dict[str, Any]:
    return {
        'state': str(status.get('state', 'unknown')),
        'tab_id': int(status['tabId']) if isinstance(status.get('tabId'), int) else None,
        'tab_title': status.get('tabTitle') if isinstance(status.get('tabTitle'), str) and status.get('tabTitle') else None,
        'tab_url': status.get('tabUrl') if isinstance(status.get('tabUrl'), str) and status.get('tabUrl') else None,
        'updated_at': str(status.get('updatedAt', '')),
        'action': action,
        'message': str(status.get('message', '')),
    }


def coerce_popup_message(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        'text': str(payload.get('text', '')),
        'page_url': payload.get('pageUrl') if isinstance(payload.get('pageUrl'), str) and payload.get('pageUrl') else None,
        'tab_id': int(payload['tabId']) if isinstance(payload.get('tabId'), int) else None,
        'sent_at': str(payload.get('sentAt', '')),
    }


def coerce_screen_share_status(status: dict[str, Any]) -> dict[str, Any]:
    return {
        'state': str(status.get('state', 'idle')),
        'active': bool(status.get('active')),
        'viewer_window_id': int(status['viewerWindowId']) if isinstance(status.get('viewerWindowId'), int) else None,
        'source_label': status.get('sourceLabel') if isinstance(status.get('sourceLabel'), str) and status.get('sourceLabel') else None,
        'updated_at': str(status.get('updatedAt', '')),
        'message': str(status.get('message', 'Screen share is idle.')),
    }


def coerce_file_transfer_status(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        'file_name': str(payload.get('fileName', 'unknown')),
        'saved_path': str(payload.get('savedPath', '')),
        'byte_count': int(payload.get('byteCount', 0)),
        'downloaded_at': str(payload.get('downloadedAt', '')),
        'message': str(payload.get('message', 'File saved on the client.')),
    }


def build_binary_envelope(metadata: dict[str, Any], payload_bytes: bytes) -> bytes:
    metadata_bytes = json.dumps(metadata).encode('utf-8')
    envelope = bytearray(4 + len(metadata_bytes) + len(payload_bytes))
    envelope[0:4] = len(metadata_bytes).to_bytes(4, byteorder='big', signed=False)
    envelope[4 : 4 + len(metadata_bytes)] = metadata_bytes
    envelope[4 + len(metadata_bytes) :] = payload_bytes
    return bytes(envelope)


def parse_binary_envelope(raw_message: bytes) -> tuple[dict[str, Any], bytes] | None:
    """Decode an inbound binary envelope; return (metadata, payload) or None on malformed input."""
    if len(raw_message) < 5:
        return None
    metadata_length = int.from_bytes(raw_message[:4], byteorder='big', signed=False)
    if metadata_length <= 0 or len(raw_message) < 4 + metadata_length:
        return None
    try:
        metadata = json.loads(raw_message[4 : 4 + metadata_length].decode('utf-8'))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(metadata, dict):
        return None
    payload_bytes = raw_message[4 + metadata_length :]
    return metadata, payload_bytes
