from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


LEGACY_EXTENSION_CAPABILITIES = frozenset(
    {
        'capture.full-page',
        'clipboard.write',
        'popup.browser',
        'file-transfer.browser',
        'screen-share.preview',
        'screen-share.input',
        'screen-share.paste',
    }
)


def _capability_set(details: dict[str, Any] | None, legacy: Iterable[str] = ()) -> frozenset[str]:
    if details is None:
        return frozenset()
    if 'capabilities' not in details:
        return frozenset(legacy)
    values = details.get('capabilities')
    if not isinstance(values, (list, tuple, set, frozenset)):
        return frozenset()
    return frozenset(value for value in values if isinstance(value, str))


@dataclass(frozen=True)
class UiCapabilities:
    extension_connected: bool
    native_connected: bool
    capture: bool
    clipboard: bool
    popup: bool
    file_transfer: bool
    screen_share: bool
    remote_input: bool
    remote_paste: bool
    browser_paste: bool
    native_screen_capture: bool

    @property
    def text_tools(self) -> bool:
        return self.clipboard or self.popup

    @classmethod
    def from_connections(
        cls,
        extension: dict[str, Any] | None,
        native: dict[str, Any] | None,
    ) -> UiCapabilities:
        extension_capabilities = _capability_set(extension, LEGACY_EXTENSION_CAPABILITIES)
        native_capabilities = _capability_set(native)

        extension_capture = 'capture.full-page' in extension_capabilities
        native_capture = 'screen-capture' in native_capabilities
        extension_popup = 'popup.browser' in extension_capabilities
        native_popup = 'native-popup' in native_capabilities
        extension_input = 'screen-share.input' in extension_capabilities
        native_input = 'os-input' in native_capabilities
        browser_paste = 'screen-share.paste' in extension_capabilities

        return cls(
            extension_connected=extension is not None,
            native_connected=native is not None,
            capture=extension_capture or native_capture,
            clipboard='clipboard.write' in extension_capabilities,
            popup=extension_popup or native_popup,
            file_transfer=(
                'file-transfer.browser' in extension_capabilities
                or 'file-transfer.native' in native_capabilities
                or native_popup
            ),
            screen_share='screen-share.preview' in extension_capabilities or native_capture,
            remote_input=extension_input or native_input,
            remote_paste=browser_paste or native_input,
            browser_paste=browser_paste,
            native_screen_capture=native_capture,
        )
