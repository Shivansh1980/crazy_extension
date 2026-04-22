from __future__ import annotations

import queue
import subprocess
import tkinter as tk
import tkinter.font as tkfont
from collections import deque
from concurrent.futures import Future
from pathlib import Path
from tkinter import messagebox, ttk

from capture_control_center.debug import debug_log
from PIL import Image, ImageTk

from capture_control_center.application.controller import CaptureController
from capture_control_center.domain.models import SavedCapture


class CaptureControlWindow:
    def __init__(self, root: tk.Tk, controller: CaptureController, images_directory: Path, bridge_url: str) -> None:
        self._root = root
        self._controller = controller
        self._images_directory = images_directory
        self._bridge_url = bridge_url
        self._pending_capture: Future[SavedCapture] | None = None
        self._pending_clipboard: Future[None] | None = None
        self._pending_popup: Future[dict] | None = None
        self._preview_image: ImageTk.PhotoImage | None = None
        self._last_capture_path: Path | None = None
        self._popup_message_history: deque[str] = deque(maxlen=2)
        self._popup_message_keys: deque[tuple[str, str, str]] = deque(maxlen=8)
        self._scroll_canvas: tk.Canvas | None = None
        self._scroll_content_window: int | None = None
        self._toast_frame: ttk.Frame | None = None
        self._toast_label: ttk.Label | None = None
        self._toast_hide_job: str | None = None
        self._toast_queue: deque[str] = deque()
        self._toast_visible = False

        self._root.title('Capture Control Center')
        self._root.geometry('1280x860')
        self._root.minsize(980, 720)

        self._connection_status = tk.StringVar(value=f'Listening on {bridge_url}. Waiting for extension connection...')
        self._capture_status = tk.StringVar(value='No screenshot captured yet.')
        self._clipboard_status = tk.StringVar(value='Clipboard idle.')
        self._popup_status = tk.StringVar(value='Browser popup: unknown')
        self._last_file = tk.StringVar(value='Not available')
        self._last_page = tk.StringVar(value='Not available')
        self._popup_message_one = tk.StringVar(value='No popup messages received yet.')
        self._popup_message_two = tk.StringVar(value='Waiting for the next popup message.')

        self._build_layout()
        self._poll_events()
        debug_log('python-gui', 'GUI initialized.')

    def _build_layout(self) -> None:
        style = ttk.Style(self._root)
        style.theme_use('clam')
        style.configure('Title.TLabel', font=('Segoe UI', 24, 'bold'))
        style.configure('Card.TLabelframe', padding=0)
        style.configure('Toast.TFrame', background='#102a43')
        style.configure('Toast.TLabel', background='#102a43', foreground='#f0f4f8', font=('Segoe UI', 10, 'bold'))

        root_shell = ttk.Frame(self._root)
        root_shell.pack(fill=tk.BOTH, expand=True)
        root_shell.columnconfigure(0, weight=1)
        root_shell.rowconfigure(0, weight=1)

        self._toast_frame = ttk.Frame(root_shell, style='Toast.TFrame', padding=(18, 10))
        self._toast_label = ttk.Label(self._toast_frame, style='Toast.TLabel', text='')
        self._toast_label.pack()

        self._scroll_canvas = tk.Canvas(root_shell, highlightthickness=0, borderwidth=0)
        vertical_scrollbar = ttk.Scrollbar(root_shell, orient=tk.VERTICAL, command=self._scroll_canvas.yview)
        self._scroll_canvas.configure(yscrollcommand=vertical_scrollbar.set)
        self._scroll_canvas.grid(row=0, column=0, sticky='nsew')
        vertical_scrollbar.grid(row=0, column=1, sticky='ns')

        container = ttk.Frame(self._scroll_canvas, padding=18)
        container.columnconfigure(0, weight=1)
        container.rowconfigure(3, weight=1)
        self._scroll_content_window = self._scroll_canvas.create_window((0, 0), window=container, anchor='nw')
        container.bind('<Configure>', self._update_scroll_region)
        self._scroll_canvas.bind('<Configure>', self._sync_scroll_content_width)
        self._scroll_canvas.bind_all('<MouseWheel>', self._handle_mousewheel, add='+')

        header = ttk.Frame(container)
        header.grid(row=0, column=0, sticky='ew')
        header.columnconfigure(0, weight=1)

        ttk.Label(header, text='Capture Control Center', style='Title.TLabel').grid(row=0, column=0, sticky='w')
        ttk.Label(
            header,
            text='Capture full-page screenshots, sync exact text to the browser clipboard, manage the in-page popup, and review popup-originated messages from one desktop control surface.',
            wraplength=1100,
        ).grid(row=1, column=0, sticky='w', pady=(6, 0))

        status_card = ttk.LabelFrame(container, text='Bridge status', padding=16, style='Card.TLabelframe')
        status_card.grid(row=1, column=0, sticky='ew', pady=(18, 12))
        status_card.columnconfigure(0, weight=1)
        ttk.Label(status_card, textvariable=self._connection_status, wraplength=1080).grid(row=0, column=0, sticky='w')
        ttk.Label(status_card, text=f'Images save to: {self._images_directory}', wraplength=1080).grid(row=1, column=0, sticky='w', pady=(8, 0))

        actions = ttk.Frame(container)
        actions.grid(row=2, column=0, sticky='ew', pady=(0, 12))

        self._capture_button = ttk.Button(actions, text='Capture screenshot', command=self._on_capture_clicked)
        self._capture_button.pack(side=tk.LEFT)

        self._open_folder_button = ttk.Button(actions, text='Open images folder', command=self._open_images_folder)
        self._open_folder_button.pack(side=tk.LEFT, padx=(10, 0))

        self._copy_image_button = ttk.Button(actions, text='Copy latest image', command=self._copy_latest_image)
        self._copy_image_button.pack(side=tk.LEFT, padx=(10, 0))

        self._send_clipboard_button = ttk.Button(actions, text='Send text to browser clipboard', command=self._on_send_clipboard_clicked)
        self._send_clipboard_button.pack(side=tk.LEFT, padx=(18, 0))

        self._send_popup_button = ttk.Button(actions, text='Send text to browser popup', command=self._on_send_popup_clicked)
        self._send_popup_button.pack(side=tk.LEFT, padx=(10, 0))

        content = ttk.Panedwindow(container, orient=tk.HORIZONTAL)
        content.grid(row=3, column=0, sticky='nsew')

        left_column = ttk.Frame(content)
        left_column.columnconfigure(0, weight=1)
        left_column.rowconfigure(0, weight=4, minsize=320)
        left_column.rowconfigure(1, weight=3, minsize=330)

        compose_card = ttk.LabelFrame(left_column, text='Text and popup controls', padding=16, style='Card.TLabelframe')
        compose_card.grid(row=0, column=0, sticky='nsew', padx=(0, 8))
        compose_card.columnconfigure(0, weight=1)
        compose_card.rowconfigure(3, weight=1, minsize=240)

        ttk.Label(
            compose_card,
            text='Paste any text or code below. Tabs, spacing, and line breaks are preserved exactly. Send to the browser clipboard or the in-page popup.',
            wraplength=560,
        ).grid(row=0, column=0, sticky='w')
        ttk.Label(compose_card, textvariable=self._clipboard_status, wraplength=560).grid(row=1, column=0, sticky='w', pady=(8, 4))
        ttk.Label(compose_card, textvariable=self._popup_status, wraplength=560).grid(row=2, column=0, sticky='w', pady=(0, 10))

        editor_frame = ttk.Frame(compose_card)
        editor_frame.grid(row=3, column=0, sticky='nsew')
        editor_frame.columnconfigure(0, weight=1)
        editor_frame.rowconfigure(0, weight=1)

        editor_font = tkfont.Font(family='Consolas', size=10)
        self._clipboard_input = tk.Text(
            editor_frame,
            wrap='none',
            undo=True,
            maxundo=-1,
            font=editor_font,
            padx=12,
            pady=12,
            insertwidth=2,
            relief=tk.FLAT,
            borderwidth=0,
        )
        y_scrollbar = ttk.Scrollbar(editor_frame, orient=tk.VERTICAL, command=self._clipboard_input.yview)
        x_scrollbar = ttk.Scrollbar(editor_frame, orient=tk.HORIZONTAL, command=self._clipboard_input.xview)
        self._clipboard_input.configure(yscrollcommand=y_scrollbar.set, xscrollcommand=x_scrollbar.set)
        self._clipboard_input.grid(row=0, column=0, sticky='nsew')
        y_scrollbar.grid(row=0, column=1, sticky='ns')
        x_scrollbar.grid(row=1, column=0, sticky='ew')

        self._clipboard_input.bind('<Control-Return>', self._handle_send_clipboard_shortcut)
        self._clipboard_input.bind('<Control-Shift-Return>', self._handle_send_popup_shortcut)
        self._clipboard_input.bind('<Control-a>', self._select_all_clipboard_text)
        self._clipboard_input.bind('<Tab>', self._insert_tab_character)

        messages_card = ttk.LabelFrame(left_column, text='Last two popup messages', padding=16, style='Card.TLabelframe')
        messages_card.grid(row=1, column=0, sticky='nsew', padx=(0, 8), pady=(12, 0))
        messages_card.columnconfigure(0, weight=1)
        messages_card.rowconfigure(1, weight=1, minsize=140)
        messages_card.rowconfigure(3, weight=1, minsize=140)
        ttk.Label(messages_card, text='Latest').grid(row=0, column=0, sticky='w')
        self._popup_message_box_one = self._create_message_box(messages_card)
        self._popup_message_box_one.grid(row=1, column=0, sticky='nsew', pady=(4, 8))
        ttk.Label(messages_card, text='Previous').grid(row=2, column=0, sticky='w')
        self._popup_message_box_two = self._create_message_box(messages_card)
        self._popup_message_box_two.grid(row=3, column=0, sticky='nsew', pady=(4, 0))
        self._set_readonly_text(self._popup_message_box_one, self._popup_message_one.get())
        self._set_readonly_text(self._popup_message_box_two, self._popup_message_two.get())

        right_column = ttk.Frame(content)
        right_column.columnconfigure(0, weight=1)
        right_column.rowconfigure(0, weight=1)

        preview_card = ttk.LabelFrame(right_column, text='Latest capture preview', padding=16, style='Card.TLabelframe')
        preview_card.grid(row=0, column=0, sticky='nsew', padx=(8, 0))
        preview_card.columnconfigure(0, weight=1)
        preview_card.rowconfigure(4, weight=1)
        ttk.Label(preview_card, textvariable=self._capture_status, wraplength=520).grid(row=0, column=0, sticky='w')
        ttk.Label(preview_card, textvariable=self._last_file, wraplength=520).grid(row=1, column=0, sticky='w', pady=(8, 0))
        ttk.Label(preview_card, textvariable=self._last_page, wraplength=520).grid(row=2, column=0, sticky='w', pady=(8, 0))

        preview_actions = ttk.Frame(preview_card)
        preview_actions.grid(row=3, column=0, sticky='w', pady=(12, 12))
        ttk.Button(preview_actions, text='Open images folder', command=self._open_images_folder).pack(side=tk.LEFT)
        ttk.Button(preview_actions, text='Copy latest image', command=self._copy_latest_image).pack(side=tk.LEFT, padx=(10, 0))

        preview_surface = ttk.Frame(preview_card)
        preview_surface.grid(row=4, column=0, sticky='nsew')
        preview_surface.columnconfigure(0, weight=1)
        preview_surface.rowconfigure(0, weight=1)
        self._preview_label = ttk.Label(
            preview_surface,
            text='Capture a screenshot to preview it here.',
            anchor=tk.CENTER,
            justify=tk.CENTER,
        )
        self._preview_label.grid(row=0, column=0, sticky='nsew')

        content.add(left_column, weight=3)
        content.add(right_column, weight=2)

    def _update_scroll_region(self, _event: tk.Event) -> None:
        if self._scroll_canvas is None:
            return

        self._scroll_canvas.configure(scrollregion=self._scroll_canvas.bbox('all'))

    def _sync_scroll_content_width(self, event: tk.Event) -> None:
        if self._scroll_canvas is None or self._scroll_content_window is None:
            return

        canvas_width = max(1, event.width)
        self._scroll_canvas.itemconfigure(self._scroll_content_window, width=canvas_width)

    def _handle_mousewheel(self, event: tk.Event) -> str | None:
        if self._scroll_canvas is None:
            return None

        focused_widget = self._root.winfo_containing(self._root.winfo_pointerx(), self._root.winfo_pointery())
        if focused_widget is not None:
            text_widget = focused_widget.winfo_toplevel().nametowidget(str(focused_widget))
            if isinstance(text_widget, tk.Text):
                return None

        delta = getattr(event, 'delta', 0)
        if delta == 0:
            return None

        self._scroll_canvas.yview_scroll(int(-delta / 120), 'units')
        return 'break'

    def _create_message_box(self, parent: ttk.Widget) -> tk.Text:
        widget = tk.Text(
            parent,
            height=8,
            wrap='word',
            relief=tk.FLAT,
            borderwidth=1,
            padx=10,
            pady=10,
            font=('Consolas', 10),
        )
        widget.configure(state=tk.DISABLED)
        return widget

    def _on_capture_clicked(self) -> None:
        if self._pending_capture is not None and not self._pending_capture.done():
            return

        debug_log('python-gui', 'Capture button clicked.')
        self._capture_button.state(['disabled'])
        self._capture_status.set('Capture request sent. Waiting for the extension response...')
        self._pending_capture = self._controller.request_capture()
        self._pending_capture.add_done_callback(self._on_capture_finished)

    def _on_capture_finished(self, future: Future[SavedCapture]) -> None:
        def finalize() -> None:
            self._capture_button.state(['!disabled'])
            try:
                saved_capture = future.result()
            except Exception as error:
                debug_log('python-gui', 'Capture failed in GUI callback.', str(error))
                self._capture_status.set(str(error))
                messagebox.showerror('Capture failed', str(error))
                return

            self._last_capture_path = saved_capture.file_path
            debug_log('python-gui', 'Capture finished successfully.', str(saved_capture.file_path))
            self._capture_status.set('Capture completed and saved locally.')
            self._last_file.set(f'File: {saved_capture.file_path}')
            self._last_page.set(f'Page: {saved_capture.screenshot.page_title or "Untitled"} | {saved_capture.screenshot.page_url}')
            self._render_preview(saved_capture.file_path)

        self._root.after(0, finalize)

    def _on_send_clipboard_clicked(self) -> None:
        if self._pending_clipboard is not None and not self._pending_clipboard.done():
            return

        text = self._clipboard_input.get('1.0', 'end-1c')
        debug_log('python-gui', 'Clipboard send button clicked.', {'characters': len(text)})
        self._send_clipboard_button.state(['disabled'])
        self._clipboard_status.set('Sending text to the extension clipboard...')
        self._pending_clipboard = self._controller.send_clipboard_text(text)
        self._pending_clipboard.add_done_callback(self._on_send_clipboard_finished)

    def _on_send_clipboard_finished(self, future: Future[None]) -> None:
        def finalize() -> None:
            self._send_clipboard_button.state(['!disabled'])
            try:
                future.result()
            except Exception as error:
                debug_log('python-gui', 'Clipboard send failed in GUI callback.', str(error))
                self._clipboard_status.set(str(error))
                messagebox.showerror('Clipboard send failed', str(error))
                return

            text = self._clipboard_input.get('1.0', 'end-1c')
            line_count = 0 if text == '' else text.count('\n') + 1
            self._clipboard_status.set(
                f'Clipboard updated in the browser with {len(text)} characters across {line_count} line(s).'
            )
            debug_log('python-gui', 'Clipboard send finished successfully.', {'characters': len(text), 'lines': line_count})

        self._root.after(0, finalize)

    def _on_send_popup_clicked(self) -> None:
        if self._pending_popup is not None and not self._pending_popup.done():
            return

        text = self._clipboard_input.get('1.0', 'end-1c')
        debug_log('python-gui', 'Popup send button clicked.', {'characters': len(text)})
        self._send_popup_button.state(['disabled'])
        self._popup_status.set('Sending text to the browser popup...')
        self._pending_popup = self._controller.send_popup_text(text)
        self._pending_popup.add_done_callback(self._on_send_popup_finished)

    def _on_send_popup_finished(self, future: Future[dict]) -> None:
        def finalize() -> None:
            self._send_popup_button.state(['!disabled'])
            try:
                status = future.result()
            except Exception as error:
                debug_log('python-gui', 'Popup send failed in GUI callback.', str(error))
                self._popup_status.set(str(error))
                messagebox.showerror('Popup send failed', str(error))
                return

            self._popup_status.set(self._format_popup_status(status))
            debug_log('python-gui', 'Popup send finished successfully.', status)

        self._root.after(0, finalize)

    def _handle_send_clipboard_shortcut(self, _event: tk.Event) -> str:
        self._on_send_clipboard_clicked()
        return 'break'

    def _handle_send_popup_shortcut(self, _event: tk.Event) -> str:
        self._on_send_popup_clicked()
        return 'break'

    def _select_all_clipboard_text(self, _event: tk.Event) -> str:
        self._clipboard_input.tag_add(tk.SEL, '1.0', tk.END)
        self._clipboard_input.mark_set(tk.INSERT, '1.0')
        self._clipboard_input.see(tk.INSERT)
        return 'break'

    def _insert_tab_character(self, _event: tk.Event) -> str:
        self._clipboard_input.insert(tk.INSERT, '\t')
        return 'break'

    def _format_popup_status(self, payload: dict) -> str:
        state = str(payload.get('state', 'unknown'))
        exists = bool(payload.get('exists'))
        raw_text_length = payload.get('text_length', 0)
        text_length = int(raw_text_length) if str(raw_text_length).isdigit() else raw_text_length
        action = payload.get('action')
        page_url = payload.get('page_url') or 'active page'

        if not exists:
            return 'Browser popup: not present on the active page.'

        action_suffix = f' ({action})' if action and action != 'status' else ''
        return f'Browser popup: {state}{action_suffix} on {page_url} with {text_length} characters.'

    def _record_popup_message(self, payload: dict) -> None:
        text = str(payload.get('text', '')).strip()
        if not text:
            text = '[empty message]'

        page_url = payload.get('page_url') or 'active page'
        sent_at = payload.get('sent_at') or 'unknown time'
        message_key = (sent_at, str(page_url), text)
        if message_key in self._popup_message_keys:
            return

        self._popup_message_keys.append(message_key)
        message = f'{sent_at}\n{page_url}\n\n{text}'
        self._popup_message_history.appendleft(message)
        history = list(self._popup_message_history)
        self._popup_message_one.set(history[0] if history else 'No popup messages received yet.')
        self._popup_message_two.set(history[1] if len(history) > 1 else 'Waiting for the next popup message.')
        self._set_readonly_text(self._popup_message_box_one, self._popup_message_one.get())
        self._set_readonly_text(self._popup_message_box_two, self._popup_message_two.get())
        self._show_message_toast(text)

    def _show_message_toast(self, message_text: str) -> None:
        if self._toast_frame is None or self._toast_label is None:
            return

        self._toast_queue.append(message_text)
        if self._toast_visible:
            return

        self._show_next_message_toast()

    def _show_next_message_toast(self) -> None:
        if self._toast_frame is None or self._toast_label is None:
            return

        if not self._toast_queue:
            self._toast_visible = False
            return

        message_text = self._toast_queue.popleft()

        preview = message_text.replace('\n', ' ').strip()
        if len(preview) > 90:
            preview = f'{preview[:87]}...'

        self._toast_label.configure(text=f'New message arrived: {preview}')
        self._toast_frame.place(relx=0.5, y=14, anchor='n')
        self._toast_frame.lift()
        self._toast_visible = True

        if self._toast_hide_job is not None:
            self._root.after_cancel(self._toast_hide_job)

        self._toast_hide_job = self._root.after(4000, self._hide_message_toast)

    def _hide_message_toast(self) -> None:
        self._toast_hide_job = None
        if self._toast_frame is None:
            return

        self._toast_frame.place_forget()
        self._toast_visible = False
        if self._toast_queue:
            self._show_next_message_toast()

    def _set_readonly_text(self, widget: tk.Text, text: str) -> None:
        widget.configure(state=tk.NORMAL)
        widget.delete('1.0', tk.END)
        widget.insert('1.0', text)
        widget.configure(state=tk.DISABLED)

    def _render_preview(self, image_path: Path) -> None:
        debug_log('python-gui', 'Rendering preview image.', str(image_path))
        image = Image.open(image_path)
        image.thumbnail((700, 520))
        self._preview_image = ImageTk.PhotoImage(image)
        self._preview_label.configure(image=self._preview_image, text='')

    def _copy_latest_image(self) -> None:
        if self._last_capture_path is None:
            self._capture_status.set('No captured image is available to copy yet.')
            return

        debug_log('python-gui', 'Copying latest captured image to clipboard.', str(self._last_capture_path))
        escaped_path = str(self._last_capture_path).replace("'", "''")
        command = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "Add-Type -AssemblyName System.Drawing; "
            f"$image = [System.Drawing.Image]::FromFile('{escaped_path}'); "
            "try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }"
        )

        try:
            subprocess.run(
                ['powershell.exe', '-NoProfile', '-STA', '-Command', command],
                check=True,
                capture_output=True,
                text=True,
            )
            self._capture_status.set('Latest image copied to the Windows clipboard.')
        except subprocess.CalledProcessError as error:
            debug_log('python-gui', 'Failed to copy latest image to clipboard.', error.stderr or error.stdout or str(error))
            messagebox.showerror('Copy image failed', error.stderr or error.stdout or str(error))

    def _open_images_folder(self) -> None:
        debug_log('python-gui', 'Opening images folder.', str(self._images_directory))
        self._images_directory.mkdir(parents=True, exist_ok=True)
        self._images_directory.resolve()
        import os

        os.startfile(self._images_directory)  # type: ignore[attr-defined]

    def _poll_events(self) -> None:
        while True:
            try:
                event_name, payload = self._controller.events.get_nowait()
            except queue.Empty:
                break

            if event_name == 'server_started':
                debug_log('python-gui', 'Received GUI event.', event_name)
                self._connection_status.set(f'Listening on ws://{payload["host"]}:{payload["port"]}. Waiting for extension connection...')
            elif event_name == 'client_connected':
                debug_log('python-gui', 'Received GUI event.', event_name)
                self._connection_status.set(
                    f'Extension connected: {payload["name"]} {payload["version"]} ({payload["client_id"]}).'
                )
            elif event_name == 'client_disconnected':
                debug_log('python-gui', 'Received GUI event.', event_name)
                self._connection_status.set(payload['message'])
            elif event_name == 'capture_failed':
                debug_log('python-gui', 'Received GUI event.', payload)
                self._capture_status.set(payload['message'])
            elif event_name == 'capture_saved':
                debug_log('python-gui', 'Received GUI event.', payload)
                self._capture_status.set(f'Saved {payload["file_name"]} at {payload["captured_at"]}.')
            elif event_name == 'clipboard_written':
                debug_log('python-gui', 'Received GUI event.', payload)
                self._clipboard_status.set(
                    f'Clipboard updated in the browser with {payload["character_count"]} characters across {payload["line_count"]} line(s).'
                )
            elif event_name == 'popup_status':
                debug_log('python-gui', 'Received GUI event.', payload)
                self._popup_status.set(self._format_popup_status(payload))
            elif event_name == 'popup_message':
                debug_log('python-gui', 'Received GUI event.', payload)
                self._record_popup_message(payload)

        self._root.after(200, self._poll_events)
