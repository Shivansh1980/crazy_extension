from __future__ import annotations

from typing import Any, Callable, Protocol, runtime_checkable

from capture_control_center.domain.models import ScreenshotResult


BridgeEventCallback = Callable[[str, dict[str, Any]], None]


class BridgeTransport(Protocol):
    """Transport contract shared by the direct server and outbound relay client."""

    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    def set_event_callback(self, callback: BridgeEventCallback) -> None: ...

    def has_native_input_client(self) -> bool: ...

    async def request_capture(self, timeout_seconds: float = 20.0) -> ScreenshotResult: ...

    async def request_clipboard_write(self, text: str, timeout_seconds: float = 15.0) -> dict[str, int]: ...

    async def request_popup_show(self, text: str, timeout_seconds: float = 15.0) -> dict[str, Any]: ...

    async def request_screen_share_start(self, timeout_seconds: float = 30.0) -> dict[str, Any]: ...

    async def request_screen_share_stop(self, timeout_seconds: float = 15.0) -> dict[str, Any]: ...

    async def request_screen_share_click(
        self, normalized_x: float, normalized_y: float, timeout_seconds: float = 10.0
    ) -> dict[str, Any]: ...

    async def request_screen_share_paste(self, text: str, timeout_seconds: float = 10.0) -> dict[str, Any]: ...

    async def request_screen_share_input(
        self,
        action: str,
        normalized_x: float,
        normalized_y: float,
        button: int = 0,
        buttons: int = 0,
        delta_x: float = 0.0,
        delta_y: float = 0.0,
        modifiers: dict[str, bool] | None = None,
        timeout_seconds: float = 5.0,
    ) -> dict[str, Any]: ...

    async def request_screen_share_key(
        self,
        action: str,
        key: str = '',
        code: str = '',
        text: str = '',
        modifiers: dict[str, bool] | None = None,
        timeout_seconds: float = 10.0,
    ) -> dict[str, Any]: ...

    async def request_file_upload(
        self,
        file_name: str,
        file_bytes: bytes,
        mime_type: str,
        timeout_seconds: float = 90.0,
    ) -> dict[str, Any]: ...


@runtime_checkable
class CredentialUpdatableBridge(Protocol):
    async def update_credentials(self, username: str, password: str, session_id: str) -> None: ...
