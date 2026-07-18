from __future__ import annotations

from pathlib import Path


_WINDOWS_RESERVED_NAMES = {
    'CON',
    'PRN',
    'AUX',
    'NUL',
    *(f'COM{index}' for index in range(1, 10)),
    *(f'LPT{index}' for index in range(1, 10)),
}


def sanitize_file_name(value: str, fallback: str, max_length: int = 180) -> str:
    """Return a portable leaf filename with bounded length and no reserved device name."""
    leaf = (value or '').replace('\\', '/').rsplit('/', 1)[-1]
    cleaned = ''.join(
        character if character.isalnum() or character in {'-', '_', '.', ' '} else '-'
        for character in leaf
    ).strip(' .')
    cleaned = cleaned.lstrip('.') or fallback

    stem = Path(cleaned).stem
    suffix = Path(cleaned).suffix
    if stem.upper() in _WINDOWS_RESERVED_NAMES:
        stem = f'_{stem}'

    suffix = suffix[:20]
    available_stem_length = max(1, max_length - len(suffix))
    stem = stem[:available_stem_length].rstrip(' .') or Path(fallback).stem or 'file'
    return f'{stem}{suffix}'


def build_unique_path(directory: Path, file_name: str) -> Path:
    candidate = directory / file_name
    if not candidate.exists():
        return candidate

    stem = candidate.stem or 'file'
    suffix = candidate.suffix
    counter = 2
    while True:
        counter_suffix = f'-{counter}'
        bounded_stem = stem[: max(1, 180 - len(suffix) - len(counter_suffix))]
        next_candidate = directory / f'{bounded_stem}{counter_suffix}{suffix}'
        if not next_candidate.exists():
            return next_candidate
        counter += 1
