from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse, urlunparse

from capture_control_center.infrastructure.env_loader import parse_env_file


DEFAULT_WEBSOCKET_URL = 'ws://127.0.0.1:8765'
DEFAULT_WEBSOCKET_RESOLVER_URL = 'https://pastebin.com/raw/pmrhGPW5'
DEFAULT_WEBSOCKET_SECONDARY_RESOLVER_URL = (
    'https://raw.githubusercontent.com/Shivansh1980/crazy_extension/refs/heads/main/server_url.txt'
)


@dataclass(frozen=True, slots=True)
class NativeConnectionConfig:
    mode: str
    direct_url: str
    relay_url: str
    session_id: str
    resolver_url: str
    secondary_resolver_url: str

    @classmethod
    def load(cls, start_directory: Path) -> 'NativeConnectionConfig':
        values: dict[str, str] = {}
        env_path = find_upwards(start_directory, '.env')
        if env_path is not None:
            values.update(parse_env_file(env_path))
        values.update(os.environ)

        mode = (values.get('NATIVE_CONNECTION_MODE') or values.get('MODE') or 'auto').strip().lower()
        if mode not in {'auto', 'direct', 'relay'}:
            mode = 'auto'

        host = (values.get('BRIDGE_HOST') or '127.0.0.1').strip()
        if host in {'0.0.0.0', '::'}:
            host = '127.0.0.1'
        port = (values.get('BRIDGE_PORT') or '8765').strip()
        configured_direct = values.get('NATIVE_BRIDGE_URL') or values.get('WEBSOCKET_URL') or f'ws://{host}:{port}'

        return cls(
            mode=mode,
            direct_url=normalize_websocket_url(configured_direct) or DEFAULT_WEBSOCKET_URL,
            relay_url=normalize_websocket_url(values.get('RELAY_URL', '')),
            session_id=(values.get('SESSION_ID') or 'default').strip() or 'default',
            resolver_url=(values.get('WEBSOCKET_RESOLVER_URL') or DEFAULT_WEBSOCKET_RESOLVER_URL).strip(),
            secondary_resolver_url=(
                values.get('WEBSOCKET_SECONDARY_RESOLVER_URL')
                or DEFAULT_WEBSOCKET_SECONDARY_RESOLVER_URL
            ).strip(),
        )


def find_upwards(start_directory: Path, file_name: str) -> Path | None:
    current = start_directory.resolve()
    for directory in (current, *current.parents):
        candidate = directory / file_name
        if candidate.is_file():
            return candidate
    return None


def normalize_websocket_url(raw_value: str) -> str:
    candidate = (raw_value or '').strip()
    if not candidate:
        return ''
    if any(character.isspace() for character in candidate):
        return ''
    if candidate.lower().startswith('tcp://'):
        candidate = 'ws://' + candidate[len('tcp://'):]
    elif candidate.lower().startswith('http://'):
        candidate = 'ws://' + candidate[len('http://'):]
    elif candidate.lower().startswith('https://'):
        candidate = 'wss://' + candidate[len('https://'):]
    elif not candidate.lower().startswith(('ws://', 'wss://')):
        candidate = 'ws://' + candidate
    try:
        parsed = urlparse(candidate)
    except ValueError:
        return ''
    if parsed.scheme not in {'ws', 'wss'} or not parsed.netloc or not parsed.hostname:
        return ''
    return urlunparse(parsed)
