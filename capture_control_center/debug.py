from __future__ import annotations

from datetime import datetime
from typing import Any


DEBUG_LOGGING_ENABLED = True


def debug_log(scope: str, message: str, details: Any | None = None) -> None:
    if not DEBUG_LOGGING_ENABLED:
        return

    timestamp = datetime.now().strftime('%H:%M:%S')
    prefix = f'[{timestamp}] [{scope}]'

    if details is None:
        print(f'{prefix} {message}', flush=True)
        return

    print(f'{prefix} {message} | {details}', flush=True)