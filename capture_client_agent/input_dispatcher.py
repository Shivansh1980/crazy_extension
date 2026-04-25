"""OS-level mouse/keyboard dispatcher for the native client agent.

Uses :mod:`pyautogui` for cross-platform input (Windows / macOS / Linux). All public methods are
synchronous and safe to call from a worker thread; the network layer schedules them off the asyncio
loop so heavy keyboard/mouse work cannot stall the websocket reader.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

try:  # pragma: no cover - import guarded for graceful failure
    import pyautogui
except Exception as import_error:  # noqa: BLE001 - fail soft, surface at runtime
    pyautogui = None  # type: ignore[assignment]
    _IMPORT_ERROR: Exception | None = import_error
else:
    _IMPORT_ERROR = None
    # Disable the failsafe corner so the agent doesn't abort when the GUI sends a fast move
    # toward a screen edge. Users can still terminate via Ctrl+C in the agent terminal.
    pyautogui.FAILSAFE = False
    pyautogui.PAUSE = 0


_BUTTON_MAP = {
    0: 'left',
    1: 'middle',
    2: 'right',
}


@dataclass(slots=True)
class InputDispatchResult:
    message: str
    target_description: str
    viewport_width: int
    viewport_height: int


@dataclass(slots=True)
class KeyDispatchResult:
    message: str
    target_description: str


class OsInputDispatcher:
    """Synchronous wrapper around pyautogui for OS-level mouse and keyboard input."""

    def __init__(self) -> None:
        if _IMPORT_ERROR is not None:
            raise RuntimeError(
                'pyautogui is not installed. Install it via "pip install pyautogui" to enable OS-level remote input.'
            ) from _IMPORT_ERROR

    # --- Mouse ----------------------------------------------------------------------------

    def dispatch_input(self, payload: dict[str, Any]) -> InputDispatchResult:
        action = str(payload.get('action', ''))
        normalized_x = self._coerce_float(payload.get('normalizedX'), 0.0)
        normalized_y = self._coerce_float(payload.get('normalizedY'), 0.0)
        button_index = int(payload.get('button', 0) or 0)
        delta_x = self._coerce_float(payload.get('deltaX'), 0.0)
        delta_y = self._coerce_float(payload.get('deltaY'), 0.0)
        modifiers = self._coerce_modifiers(payload.get('modifiers'))

        screen_width, screen_height = pyautogui.size()  # type: ignore[union-attr]
        target_x = self._clamp(int(round(normalized_x * screen_width)), 0, max(0, screen_width - 1))
        target_y = self._clamp(int(round(normalized_y * screen_height)), 0, max(0, screen_height - 1))
        button_name = _BUTTON_MAP.get(button_index, 'left')

        if action == 'pointer-move':
            pyautogui.moveTo(target_x, target_y, duration=0)  # type: ignore[union-attr]
            message = f'Moved cursor to {target_x}, {target_y}.'
        elif action == 'pointer-down':
            pyautogui.moveTo(target_x, target_y, duration=0)  # type: ignore[union-attr]
            with self._modifier_context(modifiers):
                pyautogui.mouseDown(x=target_x, y=target_y, button=button_name)  # type: ignore[union-attr]
            message = f'Pressed {button_name} mouse button at {target_x}, {target_y}.'
        elif action == 'pointer-up':
            pyautogui.moveTo(target_x, target_y, duration=0)  # type: ignore[union-attr]
            with self._modifier_context(modifiers):
                pyautogui.mouseUp(x=target_x, y=target_y, button=button_name)  # type: ignore[union-attr]
            message = f'Released {button_name} mouse button at {target_x}, {target_y}.'
        elif action == 'click':
            with self._modifier_context(modifiers):
                pyautogui.click(x=target_x, y=target_y, button=button_name)  # type: ignore[union-attr]
            message = f'Clicked {button_name} at {target_x}, {target_y}.'
        elif action == 'double-click':
            with self._modifier_context(modifiers):
                pyautogui.doubleClick(x=target_x, y=target_y, button=button_name)  # type: ignore[union-attr]
            message = f'Double-clicked {button_name} at {target_x}, {target_y}.'
        elif action == 'wheel':
            pyautogui.moveTo(target_x, target_y, duration=0)  # type: ignore[union-attr]
            # Browser wheel deltas are pixels; pyautogui.scroll is in "clicks" (~120 pixels per click on Windows).
            scroll_clicks = int(round(-delta_y / 100.0)) if delta_y else 0
            horizontal_clicks = int(round(delta_x / 100.0)) if delta_x else 0
            if scroll_clicks:
                pyautogui.scroll(scroll_clicks, x=target_x, y=target_y)  # type: ignore[union-attr]
            if horizontal_clicks and hasattr(pyautogui, 'hscroll'):
                try:
                    pyautogui.hscroll(horizontal_clicks, x=target_x, y=target_y)  # type: ignore[union-attr]
                except Exception:  # noqa: BLE001 - hscroll unsupported on some platforms
                    pass
            message = f'Scrolled at {target_x}, {target_y}.'
        else:
            raise ValueError(f'Unsupported screen-share input action: {action!r}')

        return InputDispatchResult(
            message=message,
            target_description=f'desktop:{target_x},{target_y}',
            viewport_width=int(screen_width),
            viewport_height=int(screen_height),
        )

    # --- Keyboard -------------------------------------------------------------------------

    def dispatch_key(self, payload: dict[str, Any]) -> KeyDispatchResult:
        action = str(payload.get('action', ''))
        key = str(payload.get('key', '') or '')
        text = str(payload.get('text', '') or '')
        modifiers = self._coerce_modifiers(payload.get('modifiers'))

        if action == 'type' and text:
            pyautogui.typewrite(text, interval=0)  # type: ignore[union-attr]
            return KeyDispatchResult(
                message=f'Typed {len(text)} character(s).',
                target_description='desktop:typewrite',
            )

        mapped_key = self._map_key(key)
        if not mapped_key:
            # Treat as a character key — typewrite handles letters/digits/symbols.
            if key and len(key) == 1 and action in ('down', 'type'):
                with self._modifier_context(modifiers):
                    pyautogui.typewrite(key, interval=0)  # type: ignore[union-attr]
                return KeyDispatchResult(
                    message=f'Typed key {key!r}.',
                    target_description='desktop:typewrite',
                )
            return KeyDispatchResult(
                message=f'Ignored unmappable key {key!r}.',
                target_description='desktop:noop',
            )

        if action == 'down':
            with self._modifier_context(modifiers, hold=False):
                pyautogui.keyDown(mapped_key)  # type: ignore[union-attr]
            return KeyDispatchResult(
                message=f'keyDown {mapped_key!r}.',
                target_description='desktop:key',
            )
        if action == 'up':
            with self._modifier_context(modifiers, hold=False):
                pyautogui.keyUp(mapped_key)  # type: ignore[union-attr]
            return KeyDispatchResult(
                message=f'keyUp {mapped_key!r}.',
                target_description='desktop:key',
            )
        # 'type' for a non-character special key -> press
        with self._modifier_context(modifiers):
            pyautogui.press(mapped_key)  # type: ignore[union-attr]
        return KeyDispatchResult(
            message=f'press {mapped_key!r}.',
            target_description='desktop:key',
        )

    # --- Helpers --------------------------------------------------------------------------

    @staticmethod
    def _coerce_float(value: Any, default: float) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _coerce_modifiers(value: Any) -> dict[str, bool]:
        if not isinstance(value, dict):
            return {}
        return {
            'ctrl': bool(value.get('ctrl')),
            'shift': bool(value.get('shift')),
            'alt': bool(value.get('alt')),
            'meta': bool(value.get('meta')),
        }

    @staticmethod
    def _clamp(value: int, lower: int, upper: int) -> int:
        if value < lower:
            return lower
        if value > upper:
            return upper
        return value

    @staticmethod
    def _map_key(key: str) -> str:
        mapping = {
            'Enter': 'enter',
            'Return': 'enter',
            'Tab': 'tab',
            'Backspace': 'backspace',
            'Delete': 'delete',
            'Escape': 'esc',
            'Esc': 'esc',
            'ArrowUp': 'up',
            'ArrowDown': 'down',
            'ArrowLeft': 'left',
            'ArrowRight': 'right',
            'Home': 'home',
            'End': 'end',
            'PageUp': 'pageup',
            'PageDown': 'pagedown',
            'Insert': 'insert',
            ' ': 'space',
            'Space': 'space',
            'Spacebar': 'space',
            'CapsLock': 'capslock',
        }
        if key in mapping:
            return mapping[key]
        if len(key) == 1:
            return key
        if key.startswith('F') and key[1:].isdigit():
            return key.lower()
        return ''

    class _ModifierContext:
        def __init__(self, modifiers: dict[str, bool], hold: bool) -> None:
            self._modifiers = modifiers
            self._hold = hold
            self._active: list[str] = []

        def __enter__(self) -> 'OsInputDispatcher._ModifierContext':
            if not self._hold:
                return self
            for flag, key_name in (
                ('ctrl', 'ctrl'),
                ('shift', 'shift'),
                ('alt', 'alt'),
                ('meta', 'win'),
            ):
                if self._modifiers.get(flag):
                    pyautogui.keyDown(key_name)  # type: ignore[union-attr]
                    self._active.append(key_name)
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            for key_name in reversed(self._active):
                try:
                    pyautogui.keyUp(key_name)  # type: ignore[union-attr]
                except Exception:  # noqa: BLE001 - best effort cleanup
                    pass
            self._active.clear()

    def _modifier_context(self, modifiers: dict[str, bool], hold: bool = True) -> 'OsInputDispatcher._ModifierContext':
        return self._ModifierContext(modifiers, hold)
