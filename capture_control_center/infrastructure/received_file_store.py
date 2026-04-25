from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from capture_control_center.domain.models import ReceivedClientFile


class ReceivedFileStore:
    def __init__(self, root_directory: Path) -> None:
        self._files_directory = root_directory / 'client_uploads'
        self._files_directory.mkdir(parents=True, exist_ok=True)
        self._index_path = self._files_directory / 'index.json'
        self._lock = threading.Lock()
        self._records = self._load_index()

    @property
    def files_directory(self) -> Path:
        return self._files_directory

    def save(
        self,
        *,
        file_name: str,
        file_bytes: bytes,
        mime_type: str,
        page_url: str | None,
        tab_id: int | None,
        received_at: str,
    ) -> ReceivedClientFile:
        safe_name = self._sanitize_file_name(file_name)

        with self._lock:
            file_path = self._build_unique_path(safe_name)
            file_path.write_bytes(file_bytes)
            record = ReceivedClientFile(
                file_name=file_name,
                file_path=file_path,
                mime_type=mime_type or 'application/octet-stream',
                byte_count=len(file_bytes),
                page_url=page_url,
                tab_id=tab_id,
                received_at=received_at,
            )
            self._records.insert(0, self._serialize_record(record))
            self._persist_index()
            return record

    def list_files(self) -> list[ReceivedClientFile]:
        with self._lock:
            records: list[ReceivedClientFile] = []
            dirty = False
            for item in self._records:
                record = self._deserialize_record(item)
                if record is None or not record.file_path.exists():
                    dirty = True
                    continue
                records.append(record)

            if dirty:
                self._records = [self._serialize_record(record) for record in records]
                self._persist_index()

            # Always present newest first regardless of stored order.
            records.sort(key=lambda r: r.received_at or '', reverse=True)
            return records

    def _load_index(self) -> list[dict[str, Any]]:
        if not self._index_path.is_file():
            return []

        try:
            payload = json.loads(self._index_path.read_text(encoding='utf-8'))
        except Exception:
            return []

        if not isinstance(payload, list):
            return []

        return [item for item in payload if isinstance(item, dict)]

    def _persist_index(self) -> None:
        temp_path = self._index_path.with_suffix('.tmp')
        temp_path.write_text(json.dumps(self._records, indent=2), encoding='utf-8')
        temp_path.replace(self._index_path)

    def _build_unique_path(self, safe_name: str) -> Path:
        candidate = self._files_directory / safe_name
        if not candidate.exists():
            return candidate

        stem = candidate.stem or 'client-file'
        suffix = candidate.suffix
        counter = 2
        while True:
            next_candidate = self._files_directory / f'{stem}-{counter}{suffix}'
            if not next_candidate.exists():
                return next_candidate
            counter += 1

    def _sanitize_file_name(self, file_name: str) -> str:
        cleaned = ''.join(character if character.isalnum() or character in {'-', '_', '.', ' '} else '-' for character in file_name).strip()
        cleaned = cleaned.lstrip('.')
        return cleaned or 'client-upload.bin'

    def _serialize_record(self, record: ReceivedClientFile) -> dict[str, Any]:
        return {
            'file_name': record.file_name,
            'file_path': str(record.file_path),
            'mime_type': record.mime_type,
            'byte_count': record.byte_count,
            'page_url': record.page_url,
            'tab_id': record.tab_id,
            'received_at': record.received_at,
        }

    def _deserialize_record(self, payload: dict[str, Any]) -> ReceivedClientFile | None:
        file_path = payload.get('file_path')
        if not isinstance(file_path, str) or not file_path:
            return None

        return ReceivedClientFile(
            file_name=str(payload.get('file_name', Path(file_path).name)),
            file_path=Path(file_path),
            mime_type=str(payload.get('mime_type', 'application/octet-stream')),
            byte_count=int(payload.get('byte_count', 0)),
            page_url=payload.get('page_url') if isinstance(payload.get('page_url'), str) and payload.get('page_url') else None,
            tab_id=int(payload['tab_id']) if isinstance(payload.get('tab_id'), int) else None,
            received_at=str(payload.get('received_at', '')),
        )