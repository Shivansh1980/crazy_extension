from __future__ import annotations

import asyncio
import ctypes
import mimetypes
import queue
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

try:  # pragma: no cover - Tk is platform/runtime dependent
    import tkinter as tk
    from tkinter import filedialog
    from tkinter import ttk
except Exception:  # noqa: BLE001
    filedialog = None  # type: ignore[assignment]
    tk = None  # type: ignore[assignment]
    ttk = None  # type: ignore[assignment]

from capture_control_center.debug import debug_log

JsonSender = Callable[[dict[str, Any]], Awaitable[None]]
BinarySender = Callable[[dict[str, Any], bytes], Awaitable[None]]


class NativePopupService:
    """In-process desktop popup used by EXE/DLL/native-client connections.

    The browser extension keeps owning the in-page popup when connected. This
    service is only used by the native agent path and stays in the same process
    as that agent. It mirrors the browser popup protocol: popup.show,
    popup.status, popup.message, popup-file.binary, and file-transfer results.
    """

    def __init__(self) -> None:
        if tk is None or ttk is None or filedialog is None:
            raise RuntimeError('Tkinter is unavailable, so the native popup cannot be shown.')
        try:
            probe = tk.Tcl()
            probe.eval('info patchlevel')
        except Exception as error:  # noqa: BLE001
            raise RuntimeError(f'Tkinter runtime is unavailable, so the native popup cannot be shown: {error}') from error
        self._actions: queue.Queue[Callable[[], None]] = queue.Queue()
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run_ui, name='PageSignalNativePopup', daemon=True)
        self._root: Any = None
        self._window: Any = None
        self._shell: Any = None
        self._launcher: Any = None
        self._text: Any = None
        self._meta_var: Any = None
        self._file_var: Any = None
        self._status_var: Any = None
        self._opacity_var: Any = None
        self._selected_file: Path | None = None
        self._state = 'closed'
        self._normal_geometry = '360x300+80+80'
        self._hotkey_pressed = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._json_sender: JsonSender | None = None
        self._binary_sender: BinarySender | None = None
        self._lock = threading.Lock()
        self._last_text_length = 0
        self._received_dir = Path.cwd() / 'client_uploads' / 'native_popup'
        self._thread.start()
        self._ready.wait(timeout=5.0)

    def bind_bridge(
        self,
        loop: asyncio.AbstractEventLoop,
        json_sender: JsonSender,
        binary_sender: BinarySender,
    ) -> None:
        with self._lock:
            self._loop = loop
            self._json_sender = json_sender
            self._binary_sender = binary_sender

    async def show(self, text: str) -> dict[str, Any]:
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()

        def action() -> None:
            try:
                created = self._window is None
                self._ensure_window()
                if text or self._state != 'closed':
                    self._text.delete('1.0', tk.END)
                    self._text.insert('1.0', text)
                self._state = 'open'
                self._restore_window_shell()
                self._window.deiconify()
                self._window.lift()
                self._window.attributes('-topmost', True)
                self._update_meta()
                status = self._status(action='created' if created else 'updated')
                future.get_loop().call_soon_threadsafe(future.set_result, status)
                self._publish_status(status)
            except Exception as error:  # noqa: BLE001
                future.get_loop().call_soon_threadsafe(future.set_exception, error)

        self._post(action)
        return await future

    async def receive_file(self, file_name: str, file_bytes: bytes, mime_type: str) -> dict[str, Any]:
        self._received_dir.mkdir(parents=True, exist_ok=True)
        safe_name = Path(file_name or 'shared-file.bin').name or 'shared-file.bin'
        target = self._received_dir / safe_name
        if target.exists():
            stem = target.stem
            suffix = target.suffix
            stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
            target = self._received_dir / f'{stem}-{stamp}{suffix}'
        await asyncio.to_thread(target.write_bytes, file_bytes)

        def action() -> None:
            self._ensure_window()
            self._status_var.set(f'Received {target.name} ({len(file_bytes)} bytes).')
            self._file_var.set(f'Received: {target.name}')
            self._state = 'open'
            self._restore_window_shell()
            self._window.deiconify()
            self._window.lift()
            self._window.attributes('-topmost', True)
            self._publish_status(self._status(action='file-received'))

        self._post(action)
        return {
            'type': 'file-transfer.result',
            'state': 'saved',
            'ok': True,
            'fileName': target.name,
            'savedPath': str(target),
            'byteCount': len(file_bytes),
            'mimeType': mime_type or 'application/octet-stream',
            'downloadedAt': datetime.now(timezone.utc).isoformat(),
            'message': f'Native popup received {target.name}.',
        }

    def close(self) -> None:
        self._post(lambda: self._set_state('closed'))

    def _run_ui(self) -> None:
        self._root = tk.Tk()
        self._root.withdraw()
        self._root.after(50, self._drain_actions)
        self._install_hotkey_poll()
        self._ready.set()
        self._root.mainloop()

    def _post(self, action: Callable[[], None]) -> None:
        self._actions.put(action)
        if self._root is not None:
            try:
                self._root.after(0, self._drain_actions)
            except Exception:
                pass

    def _drain_actions(self) -> None:
        while True:
            try:
                action = self._actions.get_nowait()
            except queue.Empty:
                break
            try:
                action()
            except Exception as error:  # noqa: BLE001
                debug_log('client-agent', 'Native popup action failed.', {'error': str(error)})
        if self._root is not None:
            self._root.after(80, self._drain_actions)

    def _ensure_window(self) -> None:
        if self._window is not None:
            return
        window = tk.Toplevel(self._root)
        window.title('Page Signal Shared Text')
        window.geometry(self._normal_geometry)
        window.minsize(260, 220)
        window.attributes('-topmost', True)
        window.attributes('-alpha', 0.85)
        window.protocol('WM_DELETE_WINDOW', lambda: self._set_state('closed'))
        window.bind('<Alt-Shift-p>', lambda _event: self._toggle_visibility())
        window.bind('<Alt-Shift-P>', lambda _event: self._toggle_visibility())

        self._meta_var = tk.StringVar(value='0 chars - 0 lines')
        self._file_var = tk.StringVar(value='No file selected')
        self._status_var = tk.StringVar(value='Ready.')
        self._opacity_var = tk.DoubleVar(value=0.85)

        shell = ttk.Frame(window, padding=10)
        shell.pack(fill=tk.BOTH, expand=True)
        self._shell = shell
        shell.columnconfigure(0, weight=1)
        shell.rowconfigure(1, weight=1)

        launcher = ttk.Button(window, text='P', width=3, command=lambda: self._set_state('open'))
        self._launcher = launcher

        header = ttk.Frame(shell)
        header.grid(row=0, column=0, sticky='ew', pady=(0, 8))
        header.columnconfigure(0, weight=1)
        ttk.Label(header, text='Shared Text', font=('Segoe UI', 10, 'bold')).grid(row=0, column=0, sticky='w')
        ttk.Label(header, text='Native popup - topmost, draggable, resizable').grid(row=1, column=0, sticky='w')
        ttk.Button(header, text='-', width=3, command=lambda: self._set_state('minimized')).grid(row=0, column=1, rowspan=2, padx=(8, 4))
        ttk.Button(header, text='x', width=3, command=lambda: self._set_state('closed')).grid(row=0, column=2, rowspan=2)

        self._text = tk.Text(shell, wrap='none', undo=True, font=('Consolas', 10), height=8)
        self._text.grid(row=1, column=0, sticky='nsew')
        self._text.bind('<<Modified>>', self._on_text_modified)

        footer = ttk.Frame(shell)
        footer.grid(row=2, column=0, sticky='ew', pady=(8, 0))
        footer.columnconfigure(2, weight=1)
        ttk.Label(footer, textvariable=self._meta_var).grid(row=0, column=0, sticky='w')
        ttk.Label(footer, text='Opacity').grid(row=0, column=1, padx=(12, 4))
        ttk.Scale(footer, from_=0.35, to=1.0, variable=self._opacity_var, command=self._on_opacity).grid(row=0, column=2, sticky='ew')

        actions = ttk.Frame(shell)
        actions.grid(row=3, column=0, sticky='ew', pady=(8, 0))
        actions.columnconfigure(0, weight=1)
        ttk.Label(actions, textvariable=self._file_var).grid(row=0, column=0, sticky='w')
        ttk.Button(actions, text='Copy', command=self._copy_text).grid(row=0, column=1, padx=4)
        ttk.Button(actions, text='Upload', command=self._choose_file).grid(row=0, column=2, padx=4)
        ttk.Button(actions, text='Send', command=self._send_current).grid(row=0, column=3)

        ttk.Label(shell, textvariable=self._status_var).grid(row=4, column=0, sticky='ew', pady=(8, 0))

        self._window = window
        self._install_drag(header)
        self._update_meta()

    def _install_drag(self, handle: Any) -> None:
        state: dict[str, int] = {}

        def start(event: Any) -> None:
            state['x'] = event.x_root
            state['y'] = event.y_root
            geo = self._window.geometry().split('+')
            state['left'] = int(geo[1]) if len(geo) > 1 else self._window.winfo_x()
            state['top'] = int(geo[2]) if len(geo) > 2 else self._window.winfo_y()

        def move(event: Any) -> None:
            left = state.get('left', self._window.winfo_x()) + event.x_root - state.get('x', event.x_root)
            top = state.get('top', self._window.winfo_y()) + event.y_root - state.get('y', event.y_root)
            self._window.geometry(f'+{max(0, left)}+{max(0, top)}')

        handle.bind('<ButtonPress-1>', start)
        handle.bind('<B1-Motion>', move)

    def _on_text_modified(self, _event: Any) -> None:
        if self._text.edit_modified():
            self._text.edit_modified(False)
            self._update_meta()
            self._publish_status(self._status(action='status'))

    def _update_meta(self) -> None:
        value = self._text.get('1.0', 'end-1c') if self._text is not None else ''
        lines = 0 if not value else len(value.splitlines()) or 1
        self._last_text_length = len(value)
        self._meta_var.set(f'{len(value)} chars - {lines} line{"" if lines == 1 else "s"}')

    def _on_opacity(self, _value: str) -> None:
        if self._window is not None:
            self._window.attributes('-alpha', float(self._opacity_var.get()))

    def _set_state(self, state: str) -> None:
        self._ensure_window()
        self._state = state
        if state == 'closed':
            self._window.withdraw()
        elif state == 'minimized':
            if self._window.winfo_width() > 100 and self._window.winfo_height() > 100:
                self._normal_geometry = self._window.geometry()
            if self._shell is not None:
                self._shell.pack_forget()
            if self._launcher is not None:
                self._launcher.pack(fill=tk.BOTH, expand=True, padx=6, pady=6)
            self._window.geometry('64x64')
            self._window.minsize(48, 48)
            self._window.deiconify()
            self._window.lift()
            self._window.attributes('-topmost', True)
        else:
            self._restore_window_shell()
            self._window.deiconify()
            self._window.lift()
            self._window.attributes('-topmost', True)
        self._publish_status(self._status(action=state))

    def _restore_window_shell(self) -> None:
        if self._launcher is not None:
            self._launcher.pack_forget()
        if self._shell is not None:
            self._shell.pack(fill=tk.BOTH, expand=True)
        if self._window is not None:
            self._window.minsize(260, 220)
            self._window.geometry(self._normal_geometry)

    def _toggle_visibility(self) -> None:
        if self._state == 'open':
            self._set_state('minimized')
            return
        self._set_state('open')

    def _install_hotkey_poll(self) -> None:
        if sys.platform != 'win32' or self._root is None:
            return

        user32 = ctypes.windll.user32
        vk_shift = 0x10
        vk_alt = 0x12
        vk_p = 0x50

        def is_down(vk_code: int) -> bool:
            return bool(user32.GetAsyncKeyState(vk_code) & 0x8000)

        def poll() -> None:
            pressed = is_down(vk_shift) and is_down(vk_alt) and is_down(vk_p)
            if pressed and not self._hotkey_pressed:
                self._toggle_visibility()
            self._hotkey_pressed = pressed
            if self._root is not None:
                self._root.after(80, poll)

        self._root.after(120, poll)

    def _copy_text(self) -> None:
        text = self._text.get('1.0', 'end-1c')
        self._root.clipboard_clear()
        self._root.clipboard_append(text)
        self._status_var.set('Copied.')

    def _choose_file(self) -> None:
        selected = filedialog.askopenfilename(parent=self._window)
        if not selected:
            return
        self._selected_file = Path(selected)
        self._file_var.set(self._selected_file.name)

    def _send_current(self) -> None:
        text = self._text.get('1.0', 'end-1c')
        selected = self._selected_file
        if not text and selected is None:
            self._status_var.set('Nothing to send.')
            return
        if selected is not None:
            try:
                data = selected.read_bytes()
                mime_type = mimetypes.guess_type(selected.name)[0] or 'application/octet-stream'
                metadata = {
                    'type': 'popup-file.binary',
                    'uploadId': f'native-{datetime.now(timezone.utc).timestamp()}',
                    'fileName': selected.name,
                    'mimeType': mime_type,
                    'byteCount': len(data),
                    'pageUrl': 'native-popup',
                    'text': text,
                    'sentAt': datetime.now(timezone.utc).isoformat(),
                }
                self._send_binary(metadata, data)
                self._selected_file = None
                self._file_var.set('No file selected')
                self._status_var.set('Sent file and text.')
                return
            except Exception as error:  # noqa: BLE001
                self._status_var.set(f'Send failed: {error}')
                return
        self._send_json({
            'type': 'popup.message',
            'text': text,
            'pageUrl': 'native-popup',
            'sentAt': datetime.now(timezone.utc).isoformat(),
        })
        self._status_var.set('Sent text.')

    def _status(self, action: str = 'status') -> dict[str, Any]:
        return {
            'exists': self._state != 'closed',
            'state': self._state,
            'tabId': None,
            'pageUrl': 'native-popup',
            'updatedAt': datetime.now(timezone.utc).isoformat(),
            'textLength': self._last_text_length,
            'action': action,
        }

    def _publish_status(self, status: dict[str, Any]) -> None:
        self._send_json({'type': 'popup.status', 'status': status})

    def _send_json(self, payload: dict[str, Any]) -> None:
        with self._lock:
            loop = self._loop
            sender = self._json_sender
        if loop is None or sender is None:
            return
        loop.call_soon_threadsafe(lambda: asyncio.create_task(sender(payload)))

    def _send_binary(self, metadata: dict[str, Any], payload: bytes) -> None:
        with self._lock:
            loop = self._loop
            sender = self._binary_sender
        if loop is None or sender is None:
            return
        loop.call_soon_threadsafe(lambda: asyncio.create_task(sender(metadata, payload)))
