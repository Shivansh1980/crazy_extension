"""Tiny zero-dependency .env loader (KEY=VALUE per line, # comments).

We avoid `python-dotenv` so the GUI keeps a small dependency footprint.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Mapping


def parse_env_file(env_path: Path) -> dict[str, str]:
    parsed: dict[str, str] = {}
    if not env_path.is_file():
        return parsed
    for raw_line in env_path.read_text(encoding='utf-8').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            continue
        key, _, value = line.partition('=')
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            parsed[key] = value
    return parsed


def load_env_into_os(env_path: Path, *, override: bool = False) -> Mapping[str, str]:
    """Load .env values into ``os.environ``. Returns the parsed mapping."""
    parsed = parse_env_file(env_path)
    for key, value in parsed.items():
        if override or key not in os.environ:
            os.environ[key] = value
    return parsed
