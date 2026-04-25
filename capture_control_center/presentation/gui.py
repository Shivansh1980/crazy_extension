from __future__ import annotations

import queue
import subprocess
import time
import tkinter as tk
import tkinter.font as tkfont
from collections import deque
from concurrent.futures import Future
from io import BytesIO
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import Callable

from capture_control_center.debug import debug_log
from PIL import Image, ImageTk

from capture_control_center.application.controller import CaptureController
from capture_control_center.domain.models import SavedCapture

try:
    _LANCZOS = Image.Resampling.LANCZOS
except AttributeError:  # pragma: no cover - Pillow < 9 compatibility
    _LANCZOS = Image.LANCZOS


class Palette:
    BG = '#0f1b31'
    BG_DEEP = '#0b1426'
    CARD = '#17294a'
    CARD_ALT = '#1a2f55'
    SURFACE = '#101b31'
    SURFACE_ALT = '#0f172a'
    INPUT = '#101827'
    BORDER = '#28446f'
    BORDER_SOFT = '#23385f'
    BORDER_DASH = '#52688f'
    TEXT = '#f8fafc'
    TEXT_SOFT = '#d7e3f4'
    MUTED = '#aabbd4'
    MUTED_DARK = '#7f94b3'
    PRIMARY = '#2f6eea'
    PRIMARY_HOVER = '#3d7cff'
    PRIMARY_PRESSED = '#255cc8'
    BUTTON = '#273955'
    BUTTON_HOVER = '#33476a'
    BUTTON_PRESSED = '#203049'
    DANGER = '#ff6b6b'
    DANGER_BG = '#2c2034'
    DANGER_HOVER = '#3a263d'
    SUCCESS = '#34d399'
    SUCCESS_BG = '#123b35'
    INFO = '#60a5fa'
    INFO_BG = '#102d4f'
    WARNING = '#f59e0b'
    WARNING_BG = '#3c2d12'
    DISABLED_BG = '#1b2940'
    DISABLED_FG = '#6f819d'
    TOAST_BG = '#12233f'


class CaptureControlWindow:
    def __init__(
        self,
        root: tk.Tk,
        controller: CaptureController,
        images_directory: Path,
        client_uploads_directory: Path,
        bridge_url: str,
    ) -> None:
        self._root = root
        self._controller = controller
        self._images_directory = images_directory
        self._client_uploads_directory = client_uploads_directory
        self._bridge_url = bridge_url
        self._pending_capture: Future[SavedCapture] | None = None
        self._pending_clipboard: Future[None] | None = None
        self._pending_popup: Future[dict] | None = None
        self._pending_screen_share: Future[dict] | None = None
        self._pending_screen_share_stop: Future[dict] | None = None
        self._pending_screen_share_paste: Future[dict] | None = None
        self._pending_file_upload: Future[dict] | None = None
        self._preview_image: ImageTk.PhotoImage | None = None
        self._preview_source_image: Image.Image | None = None
        self._last_capture_path: Path | None = None
        self._popup_message_history: deque[str] = deque(maxlen=2)
        self._popup_message_keys: deque[tuple[str, str, str]] = deque(maxlen=8)
        self._toast_frame: tk.Frame | None = None
        self._toast_label: tk.Label | None = None
        self._toast_hide_job: str | None = None
        self._toast_queue: deque[str] = deque()
        self._toast_visible = False
        self._last_screen_share_sequence = -1
        self._screen_share_window: tk.Toplevel | None = None
        self._screen_share_window_label: tk.Label | None = None
        self._screen_share_window_image: ImageTk.PhotoImage | None = None
        self._screen_share_window_image_bounds: tuple[int, int, int, int] | None = None
        self._screen_share_window_status = tk.StringVar(value='Waiting for screen sharing to start...')
        self._latest_screen_share_frame: Image.Image | None = None
        self._screen_share_active = False
        self._remote_control_enabled = False
        self._remote_pointer_pressed = False
        self._remote_pointer_drag_started = False
        self._last_remote_motion_send_ms = 0.0
        self._last_remote_drag_send_ms = 0.0
        self._upload_file_button: ttk.Button | None = None
        self._client_uploads_button: ttk.Button | None = None
        self._stop_screen_share_button: ttk.Button | None = None
        self._viewer_stop_button: ttk.Button | None = None
        self._viewer_take_control_button: ttk.Button | None = None
        self._client_uploads_window: tk.Toplevel | None = None
        self._client_uploads_container: tk.Frame | None = None
        self._preview_canvas: tk.Canvas | None = None
        self._preview_placeholder_frame: tk.Frame | None = None
        self._preview_meta_frame: tk.Frame | None = None
        self._popup_message_box_one: tk.Text | None = None
        self._popup_message_box_two: tk.Text | None = None
        self._event_poll_interval_ms = 80
        self._scroll_canvas: tk.Canvas | None = None
        self._scroll_content_window: int | None = None
        self._scroll_container: tk.Frame | None = None

        self._root.title('Capture Control Center')
        self._root.geometry('1440x860')
        self._root.minsize(1120, 740)
        self._root.configure(bg=Palette.BG)

        self._connection_status = tk.StringVar(value=f'Listening on {bridge_url}. Waiting for extension connection...')
        self._capture_status = tk.StringVar(value='No screenshot captured yet.')
        self._clipboard_status = tk.StringVar(value='Clipboard idle.')
        self._popup_status = tk.StringVar(value='Browser popup: unknown')
        self._screen_share_status = tk.StringVar(value='Screen share: idle.')
        self._file_transfer_status = tk.StringVar(value='No browser file has been sent yet.')
        self._client_uploads_status = tk.StringVar(value='No popup uploads received yet.')
        self._last_file = tk.StringVar(value='Not available')
        self._last_page = tk.StringVar(value='Not available')
        self._popup_message_one = tk.StringVar(value='No popup messages received yet.')
        self._popup_message_two = tk.StringVar(value='Waiting for the next popup message.')

        self._build_layout()
        self._poll_events()
        debug_log('python-gui', 'GUI initialized.')

    def _build_layout(self) -> None:
        self._style_ttk()

        root_shell = tk.Frame(self._root, bg=Palette.BG)
        root_shell.pack(fill=tk.BOTH, expand=True)
        root_shell.grid_columnconfigure(0, weight=1)
        root_shell.grid_rowconfigure(0, weight=1)

        self._toast_frame = tk.Frame(
            root_shell,
            bg=Palette.TOAST_BG,
            highlightbackground=Palette.BORDER,
            highlightthickness=1,
            padx=18,
            pady=10,
        )
        self._toast_label = tk.Label(
            self._toast_frame,
            text='',
            bg=Palette.TOAST_BG,
            fg=Palette.TEXT,
            font=('Segoe UI', 10, 'bold'),
        )
        self._toast_label.pack()

        self._scroll_canvas = tk.Canvas(
            root_shell,
            bg=Palette.BG,
            highlightthickness=0,
            bd=0,
            relief=tk.FLAT,
        )
        vertical_scrollbar = ttk.Scrollbar(root_shell, orient=tk.VERTICAL, command=self._scroll_canvas.yview)
        self._scroll_canvas.configure(yscrollcommand=vertical_scrollbar.set)
        self._scroll_canvas.grid(row=0, column=0, sticky='nsew')
        vertical_scrollbar.grid(row=0, column=1, sticky='ns')

        container = tk.Frame(self._scroll_canvas, bg=Palette.BG, padx=20, pady=18)
        self._scroll_container = container
        self._scroll_content_window = self._scroll_canvas.create_window((0, 0), window=container, anchor='nw')
        container.grid_columnconfigure(0, weight=1)
        container.grid_rowconfigure(3, weight=1, minsize=340)

        container.bind('<Configure>', self._update_scroll_region)
        self._scroll_canvas.bind('<Configure>', self._sync_scroll_content_width)
        self._root.bind_all('<MouseWheel>', self._handle_mousewheel, add='+')

        self._build_header(container)
        self._build_bridge_status(container)
        self._build_action_bar(container)
        self._build_main_content(container)
        self._build_messages_panel(container)

        self._root.after(100, self._redraw_preview_canvas)

    def _update_scroll_region(self, _event: tk.Event) -> None:
        if self._scroll_canvas is None:
            return

        self._scroll_canvas.configure(scrollregion=self._scroll_canvas.bbox('all'))

    def _sync_scroll_content_width(self, event: tk.Event) -> None:
        if self._scroll_canvas is None or self._scroll_content_window is None:
            return

        self._scroll_canvas.itemconfigure(self._scroll_content_window, width=max(1, event.width))

    def _handle_mousewheel(self, event: tk.Event) -> str | None:
        if self._scroll_canvas is None:
            return None

        focused_widget = self._root.winfo_containing(self._root.winfo_pointerx(), self._root.winfo_pointery())
        if focused_widget is not None:
            widget_path = str(focused_widget)
            try:
                actual_widget = focused_widget.winfo_toplevel().nametowidget(widget_path)
            except KeyError:
                actual_widget = focused_widget

            if isinstance(actual_widget, tk.Text):
                return None

        delta = getattr(event, 'delta', 0)
        if delta == 0:
            return None

        self._scroll_canvas.yview_scroll(int(-delta / 120), 'units')
        return 'break'

    def _style_ttk(self) -> None:
        style = ttk.Style(self._root)
        try:
            style.theme_use('clam')
        except tk.TclError:
            pass

        self._root.option_add('*Font', '{Segoe UI} 10')
        self._root.option_add('*TCombobox*Listbox.background', Palette.SURFACE)
        self._root.option_add('*TCombobox*Listbox.foreground', Palette.TEXT)

        style.configure('.', font=('Segoe UI', 10), background=Palette.BG, foreground=Palette.TEXT)
        style.configure('TFrame', background=Palette.BG)
        style.configure('TLabel', background=Palette.BG, foreground=Palette.TEXT)
        style.configure(
            'Action.TButton',
            font=('Segoe UI', 10, 'bold'),
            foreground=Palette.TEXT,
            background=Palette.BUTTON,
            bordercolor=Palette.BORDER,
            lightcolor=Palette.BUTTON,
            darkcolor=Palette.BUTTON,
            focusthickness=0,
            focuscolor=Palette.BUTTON,
            padding=(14, 12),
            relief=tk.FLAT,
        )
        style.map(
            'Action.TButton',
            background=[
                ('disabled', Palette.DISABLED_BG),
                ('pressed', Palette.BUTTON_PRESSED),
                ('active', Palette.BUTTON_HOVER),
            ],
            foreground=[('disabled', Palette.DISABLED_FG)],
            bordercolor=[('active', Palette.BORDER_DASH)],
        )
        style.configure(
            'Primary.Action.TButton',
            font=('Segoe UI', 10, 'bold'),
            foreground=Palette.TEXT,
            background=Palette.PRIMARY,
            bordercolor=Palette.PRIMARY,
            lightcolor=Palette.PRIMARY,
            darkcolor=Palette.PRIMARY,
            focusthickness=0,
            focuscolor=Palette.PRIMARY,
            padding=(14, 12),
            relief=tk.FLAT,
        )
        style.map(
            'Primary.Action.TButton',
            background=[
                ('disabled', Palette.DISABLED_BG),
                ('pressed', Palette.PRIMARY_PRESSED),
                ('active', Palette.PRIMARY_HOVER),
            ],
            foreground=[('disabled', Palette.DISABLED_FG)],
        )
        style.configure(
            'Danger.Action.TButton',
            font=('Segoe UI', 10, 'bold'),
            foreground=Palette.DANGER,
            background=Palette.DANGER_BG,
            bordercolor=Palette.DANGER,
            lightcolor=Palette.DANGER_BG,
            darkcolor=Palette.DANGER_BG,
            focusthickness=0,
            focuscolor=Palette.DANGER_BG,
            padding=(14, 12),
            relief=tk.FLAT,
        )
        style.map(
            'Danger.Action.TButton',
            background=[
                ('disabled', Palette.DISABLED_BG),
                ('pressed', Palette.DANGER_BG),
                ('active', Palette.DANGER_HOVER),
            ],
            foreground=[('disabled', Palette.DISABLED_FG)],
        )
        style.configure(
            'Vertical.TScrollbar',
            background=Palette.BUTTON,
            troughcolor=Palette.SURFACE,
            bordercolor=Palette.SURFACE,
            arrowcolor=Palette.MUTED,
            lightcolor=Palette.BUTTON,
            darkcolor=Palette.BUTTON,
        )
        style.configure(
            'Horizontal.TScrollbar',
            background=Palette.BUTTON,
            troughcolor=Palette.SURFACE,
            bordercolor=Palette.SURFACE,
            arrowcolor=Palette.MUTED,
            lightcolor=Palette.BUTTON,
            darkcolor=Palette.BUTTON,
        )

    def _build_header(self, parent: tk.Frame) -> None:
        header = tk.Frame(parent, bg=Palette.BG)
        header.grid(row=0, column=0, sticky='ew', pady=(0, 18))
        header.grid_columnconfigure(1, weight=1)

        logo = tk.Canvas(header, width=72, height=72, bg=Palette.BG, highlightthickness=0, bd=0)
        logo.grid(row=0, column=0, sticky='nw', rowspan=2, padx=(0, 18))
        self._draw_header_icon(logo)

        title = tk.Label(
            header,
            text='Capture Control Center',
            bg=Palette.BG,
            fg=Palette.TEXT,
            font=('Segoe UI', 22, 'bold'),
            anchor='w',
        )
        title.grid(row=0, column=1, sticky='w')

        subtitle = tk.Label(
            header,
            text=(
                'Capture full-page screenshots, sync exact text to the browser clipboard, manage the in-page popup, '
                'send local files into the active browser, and review popup-originated messages from one desktop control surface.'
            ),
            bg=Palette.BG,
            fg=Palette.TEXT_SOFT,
            font=('Segoe UI', 10),
            justify=tk.LEFT,
            anchor='w',
            wraplength=760,
        )
        subtitle.grid(row=1, column=1, sticky='w', pady=(6, 0))
        header.bind('<Configure>', lambda event: subtitle.configure(wraplength=max(420, min(880, event.width - 120))))

    def _draw_header_icon(self, canvas: tk.Canvas) -> None:
        canvas.create_rectangle(6, 6, 66, 66, outline='#8378ff', width=4)
        canvas.create_rectangle(24, 27, 49, 45, outline=Palette.TEXT, width=2)
        canvas.create_rectangle(29, 22, 44, 28, outline=Palette.TEXT, width=2)
        canvas.create_oval(32, 31, 42, 41, outline=Palette.TEXT, width=2)
        canvas.create_line(28, 48, 46, 48, fill='#8378ff', width=3)

    def _build_bridge_status(self, parent: tk.Frame) -> None:
        card, body = self._create_card(parent, title='Bridge Status', icon='\u25cf', padding=(16, 14))
        card.grid(row=1, column=0, sticky='ew', pady=(0, 14))
        body.grid_columnconfigure(1, weight=1)

        self._add_status_detail_line(
            body,
            row=0,
            icon='\u223f',
            icon_color=Palette.INFO,
            variable=self._connection_status,
        )

        path_frame = tk.Frame(body, bg=Palette.CARD)
        path_frame.grid(row=1, column=0, columnspan=2, sticky='ew', pady=(10, 0))
        path_frame.grid_columnconfigure(2, weight=1)

        tk.Label(
            path_frame,
            text='\U0001f4c1',
            bg=Palette.CARD,
            fg=Palette.INFO,
            font=('Segoe UI Symbol', 12),
            width=3,
            anchor='w',
        ).grid(row=0, column=0, sticky='w')
        tk.Label(
            path_frame,
            text='Images save to:',
            bg=Palette.CARD,
            fg=Palette.TEXT,
            font=('Segoe UI', 10, 'bold'),
        ).grid(row=0, column=1, sticky='w', padx=(0, 6))
        path_label = tk.Label(
            path_frame,
            text=str(self._images_directory),
            bg=Palette.CARD,
            fg=Palette.SUCCESS,
            font=('Segoe UI', 10),
            anchor='w',
            justify=tk.LEFT,
            wraplength=1000,
        )
        path_label.grid(row=0, column=2, sticky='ew')
        path_frame.bind('<Configure>', lambda event: path_label.configure(wraplength=max(260, event.width - 170)))

    def _add_status_detail_line(
        self,
        parent: tk.Frame,
        row: int,
        icon: str,
        icon_color: str,
        variable: tk.StringVar,
    ) -> None:
        tk.Label(
            parent,
            text=icon,
            bg=Palette.CARD,
            fg=icon_color,
            font=('Segoe UI Symbol', 12),
            width=3,
            anchor='w',
        ).grid(row=row, column=0, sticky='nw')
        label = tk.Label(
            parent,
            textvariable=variable,
            bg=Palette.CARD,
            fg=Palette.TEXT,
            font=('Segoe UI', 10),
            anchor='w',
            justify=tk.LEFT,
            wraplength=1080,
        )
        label.grid(row=row, column=1, sticky='ew')
        parent.bind('<Configure>', lambda event: label.configure(wraplength=max(260, event.width - 70)), add='+')

    def _build_action_bar(self, parent: tk.Frame) -> None:
        actions = tk.Frame(parent, bg=Palette.BG)
        actions.grid(row=2, column=0, sticky='ew', pady=(0, 12))
        actions.grid_columnconfigure(0, weight=1)

        top_row = tk.Frame(actions, bg=Palette.BG)
        top_row.grid(row=0, column=0)
        bottom_row = tk.Frame(actions, bg=Palette.BG)
        bottom_row.grid(row=1, column=0, pady=(8, 0))

        top_row_columns = 6
        bottom_row_columns = 3
        for column in range(top_row_columns):
            top_row.grid_columnconfigure(column, weight=1, uniform='actions-top')
        for column in range(bottom_row_columns):
            bottom_row.grid_columnconfigure(column, weight=1, uniform='actions-bottom')

        self._capture_button = self._create_action_button(
            top_row,
            0,
            '\U0001f4f7  Capture Screenshot',
            self._on_capture_clicked,
            'Primary.Action.TButton',
            top_row_columns,
        )
        self._open_folder_button = self._create_action_button(
            top_row,
            1,
            '\U0001f4c2  Open Images Folder',
            self._open_images_folder,
            'Action.TButton',
            top_row_columns,
        )
        self._copy_image_button = self._create_action_button(
            top_row,
            2,
            '\U0001f4cb  Copy Latest Image',
            self._copy_latest_image,
            'Action.TButton',
            top_row_columns,
        )
        self._send_clipboard_button = self._create_action_button(
            top_row,
            3,
            '\U0001f4dd  Send Text to Clipboard',
            self._on_send_clipboard_clicked,
            'Action.TButton',
            top_row_columns,
        )
        self._send_popup_button = self._create_action_button(
            top_row,
            4,
            '\u2708  Send Text to Popup',
            self._on_send_popup_clicked,
            'Action.TButton',
            top_row_columns,
        )
        self._upload_file_button = self._create_action_button(
            top_row,
            5,
            '\U0001f4e4  Send File to Browser',
            self._on_upload_file_clicked,
            'Action.TButton',
            top_row_columns,
        )
        self._client_uploads_button = self._create_action_button(
            bottom_row,
            0,
            '\U0001f4e5  Client Uploads',
            self._on_open_client_uploads_clicked,
            'Action.TButton',
            bottom_row_columns,
        )
        self._screen_share_button = self._create_action_button(
            bottom_row,
            1,
            '\U0001f5a5  Get Screen',
            self._on_screen_share_clicked,
            'Action.TButton',
            bottom_row_columns,
        )
        self._stop_screen_share_button = self._create_action_button(
            bottom_row,
            2,
            '\u25a0  Stop Sharing',
            self._on_stop_screen_share_clicked,
            'Danger.Action.TButton',
            bottom_row_columns,
        )
        self._stop_screen_share_button.state(['disabled'])

    def _create_action_button(
        self,
        parent: tk.Frame,
        index: int,
        text: str,
        command: Callable[[], None],
        style: str,
        total_columns: int,
    ) -> ttk.Button:
        row = 0
        column = index
        left_pad = 0 if column == 0 else 6
        right_pad = 0 if column == total_columns - 1 else 6
        button = ttk.Button(parent, text=text, command=command, style=style)
        button.grid(
            row=row,
            column=column,
            sticky='ew',
            padx=(left_pad, right_pad),
            ipady=4,
        )
        return button

    def _build_main_content(self, parent: tk.Frame) -> None:
        content = tk.Frame(parent, bg=Palette.BG)
        content.grid(row=3, column=0, sticky='nsew')
        content.grid_columnconfigure(0, weight=7, uniform='main')
        content.grid_columnconfigure(1, weight=5, uniform='main')
        content.grid_rowconfigure(0, weight=1)

        self._build_text_panel(content)
        self._build_preview_panel(content)

    def _build_text_panel(self, parent: tk.Frame) -> None:
        card, body = self._create_card(parent, title='Text and Popup Controls', icon='\U0001f5ce')
        card.grid(row=0, column=0, sticky='nsew', padx=(0, 6))
        body.grid_columnconfigure(0, weight=1)
        body.grid_rowconfigure(4, weight=1)

        info_box = tk.Frame(
            body,
            bg=Palette.SURFACE,
            highlightbackground=Palette.BORDER_SOFT,
            highlightthickness=1,
            padx=14,
            pady=12,
        )
        info_box.grid(row=0, column=0, sticky='ew', pady=(0, 12))
        info_box.grid_columnconfigure(1, weight=1)

        tk.Label(
            info_box,
            text='\u24d8',
            bg=Palette.SURFACE,
            fg=Palette.INFO,
            font=('Segoe UI Symbol', 14, 'bold'),
            width=3,
        ).grid(row=0, column=0, sticky='nw', padx=(0, 8))
        info_label = tk.Label(
            info_box,
            text=(
                'Paste any text or code below. Tabs, spacing, and line breaks are preserved exactly. '
                'Send it to the browser clipboard or the in-page popup.'
            ),
            bg=Palette.SURFACE,
            fg=Palette.TEXT_SOFT,
            justify=tk.LEFT,
            anchor='w',
            wraplength=680,
        )
        info_label.grid(row=0, column=1, sticky='ew')
        info_box.bind('<Configure>', lambda event: info_label.configure(wraplength=max(320, event.width - 90)))

        status_area = tk.Frame(body, bg=Palette.CARD)
        status_area.grid(row=1, column=0, sticky='ew', pady=(0, 8))
        status_area.grid_columnconfigure(0, weight=1)

        self._create_status_row(status_area, 0, 'Clipboard:', self._clipboard_status, 'clipboard')
        self._create_status_row(status_area, 1, 'Browser Popup:', self._popup_status, 'popup')

        separator = tk.Frame(body, height=1, bg=Palette.BORDER_SOFT)
        separator.grid(row=2, column=0, sticky='ew', pady=(4, 12))

        share_status = tk.Frame(body, bg=Palette.CARD)
        share_status.grid(row=3, column=0, sticky='ew', pady=(0, 12))
        share_status.grid_columnconfigure(0, weight=1)
        self._create_status_row(share_status, 0, 'Screen Share:', self._screen_share_status, 'screen_share')
        self._create_status_row(share_status, 1, 'Download:', self._file_transfer_status, 'file_transfer')
        self._create_status_row(share_status, 2, 'Client Uploads:', self._client_uploads_status, 'client_uploads')

        editor_frame = tk.Frame(
            body,
            bg=Palette.INPUT,
            highlightbackground=Palette.BORDER_SOFT,
            highlightcolor=Palette.PRIMARY,
            highlightthickness=1,
        )
        editor_frame.grid(row=4, column=0, sticky='nsew')
        editor_frame.columnconfigure(0, weight=1)
        editor_frame.rowconfigure(0, weight=1)

        editor_font = tkfont.Font(family='Consolas', size=10)
        self._clipboard_input = tk.Text(
            editor_frame,
            wrap='none',
            undo=True,
            maxundo=-1,
            font=editor_font,
            padx=14,
            pady=12,
            insertwidth=2,
            relief=tk.FLAT,
            borderwidth=0,
            bg=Palette.INPUT,
            fg=Palette.TEXT,
            insertbackground=Palette.TEXT,
            selectbackground=Palette.PRIMARY,
            selectforeground=Palette.TEXT,
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

    def _create_status_row(
        self,
        parent: tk.Frame,
        row: int,
        label_text: str,
        variable: tk.StringVar,
        kind: str,
    ) -> None:
        line = tk.Frame(parent, bg=Palette.CARD)
        line.grid(row=row, column=0, sticky='ew', pady=(0, 8))
        line.grid_columnconfigure(2, weight=1)

        tk.Label(
            line,
            text=label_text,
            bg=Palette.CARD,
            fg=Palette.TEXT_SOFT,
            font=('Segoe UI', 10),
            anchor='w',
            width=14,
        ).grid(row=0, column=0, sticky='w')

        badge = tk.Label(
            line,
            text='Idle',
            bg=Palette.SUCCESS_BG,
            fg=Palette.SUCCESS,
            font=('Segoe UI', 9, 'bold'),
            padx=10,
            pady=3,
        )
        badge.grid(row=0, column=1, sticky='w', padx=(0, 10))

        detail = tk.Label(
            line,
            textvariable=variable,
            bg=Palette.CARD,
            fg=Palette.MUTED,
            font=('Segoe UI', 9),
            justify=tk.LEFT,
            anchor='w',
            wraplength=460,
        )
        detail.grid(row=0, column=2, sticky='ew')

        line.bind('<Configure>', lambda event: detail.configure(wraplength=max(220, event.width - 240)))
        variable.trace_add('write', lambda *_args, b=badge, v=variable, k=kind: self._update_status_badge(v, b, k))
        self._update_status_badge(variable, badge, kind)

    def _update_status_badge(self, variable: tk.StringVar, badge: tk.Label, kind: str) -> None:
        text, bg, fg = self._badge_style_for_status(variable.get(), kind)
        badge.configure(text=text, bg=bg, fg=fg)

    def _badge_style_for_status(self, value: str, kind: str) -> tuple[str, str, str]:
        lower = value.lower()

        if any(token in lower for token in ('failed', 'error', 'not connected')):
            return 'Error', Palette.DANGER_BG, Palette.DANGER

        if kind == 'clipboard':
            if 'sending' in lower:
                return 'Sending', Palette.WARNING_BG, Palette.WARNING
            if 'updated' in lower or 'copied' in lower:
                return 'Updated', Palette.SUCCESS_BG, Palette.SUCCESS
            return 'Idle', Palette.SUCCESS_BG, Palette.SUCCESS

        if kind == 'popup':
            if 'sending' in lower:
                return 'Sending', Palette.WARNING_BG, Palette.WARNING
            if 'not present' in lower:
                return 'Missing', Palette.DANGER_BG, Palette.DANGER
            if 'unknown' in lower:
                return 'Unknown', Palette.WARNING_BG, Palette.WARNING
            return 'Ready', Palette.SUCCESS_BG, Palette.SUCCESS

        if kind == 'file_transfer':
            if 'uploading' in lower or 'sending' in lower or 'preparing' in lower:
                return 'Sending', Palette.WARNING_BG, Palette.WARNING
            if ('download' in lower or 'save was triggered' in lower or 'sent to the browser' in lower) and ('started' in lower or 'ready' in lower or 'created' in lower or 'triggered' in lower):
                return 'Ready', Palette.SUCCESS_BG, Palette.SUCCESS
            if 'no browser file' in lower or 'waiting' in lower:
                return 'Idle', Palette.INFO_BG, Palette.INFO
            return 'Idle', Palette.SUCCESS_BG, Palette.SUCCESS

        if kind == 'client_uploads':
            if 'saving' in lower or 'receiving' in lower:
                return 'Saving', Palette.WARNING_BG, Palette.WARNING
            if 'failed' in lower or 'error' in lower:
                return 'Error', Palette.DANGER_BG, Palette.DANGER
            if 'no popup uploads' in lower or 'waiting' in lower:
                return 'Idle', Palette.INFO_BG, Palette.INFO
            return 'Ready', Palette.SUCCESS_BG, Palette.SUCCESS

        if 'requesting' in lower or 'waiting' in lower:
            return 'Pending', Palette.INFO_BG, Palette.INFO
        if 'stopping' in lower:
            return 'Stopping', Palette.WARNING_BG, Palette.WARNING
        if 'ended' in lower or 'stopped' in lower or 'disconnected' in lower:
            return 'Ended', Palette.WARNING_BG, Palette.WARNING
        if 'active' in lower or 'streaming' in lower or 'sharing' in lower:
            return 'Live', Palette.SUCCESS_BG, Palette.SUCCESS
        return 'Idle', Palette.SUCCESS_BG, Palette.SUCCESS

    def _build_preview_panel(self, parent: tk.Frame) -> None:
        card, body = self._create_card(parent, title='Preview', icon='\u25c9')
        card.grid(row=0, column=1, sticky='nsew', padx=(6, 0))
        body.grid_columnconfigure(0, weight=1)
        body.grid_rowconfigure(0, weight=1)

        self._preview_canvas = tk.Canvas(
            body,
            bg=Palette.CARD,
            highlightthickness=0,
            bd=0,
            relief=tk.FLAT,
        )
        self._preview_canvas.grid(row=0, column=0, sticky='nsew')
        self._preview_canvas.bind('<Configure>', lambda _event: self._redraw_preview_canvas())

        self._preview_placeholder_frame = tk.Frame(self._preview_canvas, bg=Palette.CARD)
        icon = tk.Label(
            self._preview_placeholder_frame,
            text='\U0001f5a5',
            bg=Palette.CARD,
            fg='#8d87ff',
            font=('Segoe UI Symbol', 42),
        )
        icon.pack(pady=(0, 12))
        title = tk.Label(
            self._preview_placeholder_frame,
            textvariable=self._capture_status,
            bg=Palette.CARD,
            fg=Palette.TEXT,
            font=('Segoe UI', 12, 'bold'),
            justify=tk.CENTER,
            wraplength=420,
        )
        title.pack()
        tk.Label(
            self._preview_placeholder_frame,
            text='Capture a screenshot to preview it here.',
            bg=Palette.CARD,
            fg=Palette.MUTED,
            font=('Segoe UI', 10),
            justify=tk.CENTER,
            wraplength=420,
        ).pack(pady=(6, 18))

        preview_buttons = tk.Frame(self._preview_placeholder_frame, bg=Palette.CARD)
        preview_buttons.pack()
        ttk.Button(
            preview_buttons,
            text='\U0001f4c2  Open Images Folder',
            command=self._open_images_folder,
            style='Action.TButton',
        ).pack(side=tk.LEFT, padx=(0, 8))
        ttk.Button(
            preview_buttons,
            text='\U0001f4cb  Copy Latest Image',
            command=self._copy_latest_image,
            style='Action.TButton',
        ).pack(side=tk.LEFT, padx=(8, 0))

        self._preview_meta_frame = tk.Frame(body, bg=Palette.CARD)
        self._preview_meta_frame.grid(row=1, column=0, sticky='ew', pady=(12, 0))
        self._preview_meta_frame.grid_columnconfigure(0, weight=1)

        tk.Label(
            self._preview_meta_frame,
            textvariable=self._capture_status,
            bg=Palette.CARD,
            fg=Palette.TEXT_SOFT,
            font=('Segoe UI', 10, 'bold'),
            anchor='w',
            justify=tk.LEFT,
        ).grid(row=0, column=0, sticky='ew')
        file_label = tk.Label(
            self._preview_meta_frame,
            textvariable=self._last_file,
            bg=Palette.CARD,
            fg=Palette.MUTED,
            font=('Segoe UI', 9),
            anchor='w',
            justify=tk.LEFT,
            wraplength=520,
        )
        file_label.grid(row=1, column=0, sticky='ew', pady=(4, 0))
        page_label = tk.Label(
            self._preview_meta_frame,
            textvariable=self._last_page,
            bg=Palette.CARD,
            fg=Palette.MUTED_DARK,
            font=('Segoe UI', 9),
            anchor='w',
            justify=tk.LEFT,
            wraplength=520,
        )
        page_label.grid(row=2, column=0, sticky='ew', pady=(4, 0))
        self._preview_meta_frame.bind(
            '<Configure>',
            lambda event: (
                file_label.configure(wraplength=max(260, event.width - 20)),
                page_label.configure(wraplength=max(260, event.width - 20)),
            ),
        )
        self._preview_meta_frame.grid_remove()

    def _build_messages_panel(self, parent: tk.Frame) -> None:
        card, body = self._create_card(parent, title='Last Two Popup Messages', icon='\u25cc', padding=(16, 14))
        card.grid(row=4, column=0, sticky='ew', pady=(10, 0))
        body.grid_columnconfigure(0, weight=1, uniform='messages')
        body.grid_columnconfigure(1, weight=1, uniform='messages')
        body.grid_rowconfigure(0, weight=1)

        latest_panel, self._popup_message_box_one = self._create_message_panel(body, 'Latest', Palette.SUCCESS)
        latest_panel.grid(row=0, column=0, sticky='nsew', padx=(0, 6))

        previous_panel, self._popup_message_box_two = self._create_message_panel(body, 'Previous', Palette.PRIMARY)
        previous_panel.grid(row=0, column=1, sticky='nsew', padx=(6, 0))

        self._set_readonly_text(self._popup_message_box_one, self._popup_message_one.get())
        self._set_readonly_text(self._popup_message_box_two, self._popup_message_two.get())

    def _create_message_panel(self, parent: tk.Frame, title: str, dot_color: str) -> tuple[tk.Frame, tk.Text]:
        panel = tk.Frame(
            parent,
            bg=Palette.SURFACE_ALT,
            highlightbackground=Palette.BORDER_SOFT,
            highlightthickness=1,
            padx=12,
            pady=10,
        )
        panel.grid_columnconfigure(0, weight=1)
        panel.grid_rowconfigure(1, weight=1)

        header = tk.Frame(panel, bg=Palette.SURFACE_ALT)
        header.grid(row=0, column=0, sticky='ew', pady=(0, 8))

        tk.Label(
            header,
            text='\u25cf',
            bg=Palette.SURFACE_ALT,
            fg=dot_color,
            font=('Segoe UI', 10),
        ).pack(side=tk.LEFT, padx=(0, 8))
        tk.Label(
            header,
            text=title,
            bg=Palette.SURFACE_ALT,
            fg=Palette.TEXT,
            font=('Segoe UI', 10, 'bold'),
        ).pack(side=tk.LEFT)

        message_box = self._create_message_box(panel)
        message_box.grid(row=1, column=0, sticky='nsew')
        return panel, message_box

    def _create_card(
        self,
        parent: tk.Misc,
        title: str,
        icon: str = '',
        padding: tuple[int, int] = (16, 16),
    ) -> tuple[tk.Frame, tk.Frame]:
        outer = tk.Frame(
            parent,
            bg=Palette.CARD,
            highlightbackground=Palette.BORDER,
            highlightcolor=Palette.BORDER,
            highlightthickness=1,
            bd=0,
        )
        inner = tk.Frame(outer, bg=Palette.CARD)
        inner.pack(fill=tk.BOTH, expand=True, padx=padding[0], pady=padding[1])

        header = tk.Frame(inner, bg=Palette.CARD)
        header.pack(fill=tk.X, pady=(0, 14))

        if icon:
            icon_color = Palette.SUCCESS if title == 'Bridge Status' else Palette.TEXT_SOFT
            tk.Label(
                header,
                text=icon,
                bg=Palette.CARD,
                fg=icon_color,
                font=('Segoe UI Symbol', 12, 'bold'),
            ).pack(side=tk.LEFT, padx=(0, 10))

        tk.Label(
            header,
            text=title,
            bg=Palette.CARD,
            fg=Palette.TEXT,
            font=('Segoe UI', 11, 'bold'),
            anchor='w',
        ).pack(side=tk.LEFT)

        body = tk.Frame(inner, bg=Palette.CARD)
        body.pack(fill=tk.BOTH, expand=True)
        return outer, body

    def _redraw_preview_canvas(self) -> None:
        if self._preview_canvas is None:
            return

        width = max(1, self._preview_canvas.winfo_width())
        height = max(1, self._preview_canvas.winfo_height())
        if width <= 2 or height <= 2:
            return

        self._preview_canvas.delete('all')
        if self._preview_source_image is None:
            self._draw_preview_placeholder(width, height)
            return

        available_width = max(1, width - 36)
        available_height = max(1, height - 36)
        image = self._preview_source_image.copy()
        image.thumbnail((available_width, available_height), _LANCZOS)
        self._preview_image = ImageTk.PhotoImage(image)
        self._preview_canvas.create_image(width // 2, height // 2, image=self._preview_image, anchor=tk.CENTER)

    def _draw_preview_placeholder(self, width: int, height: int) -> None:
        if self._preview_canvas is None or self._preview_placeholder_frame is None:
            return

        margin = 18
        right = max(margin + 1, width - margin)
        bottom = max(margin + 1, height - margin)
        self._preview_canvas.create_rectangle(
            margin,
            margin,
            right,
            bottom,
            outline=Palette.BORDER_DASH,
            dash=(7, 7),
            width=2,
        )
        self._preview_canvas.create_window(
            width // 2,
            height // 2,
            window=self._preview_placeholder_frame,
            anchor=tk.CENTER,
        )

    def _create_message_box(self, parent: tk.Misc) -> tk.Text:
        widget = tk.Text(
            parent,
            height=4,
            wrap='word',
            relief=tk.FLAT,
            borderwidth=0,
            padx=2,
            pady=0,
            font=('Consolas', 10),
            bg=Palette.SURFACE_ALT,
            fg=Palette.TEXT_SOFT,
            insertbackground=Palette.TEXT,
            selectbackground=Palette.PRIMARY,
            selectforeground=Palette.TEXT,
            highlightthickness=0,
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

    def _on_upload_file_clicked(self) -> None:
        if self._pending_file_upload is not None and not self._pending_file_upload.done():
            return

        selected_path = filedialog.askopenfilename(parent=self._root, title='Select a file to send to the browser')
        if not selected_path:
            return

        file_path = Path(selected_path)
        if not file_path.is_file():
            self._file_transfer_status.set('The selected path is not a file. Choose a valid file and try again.')
            return

        debug_log('python-gui', 'File upload button clicked.', {'file_path': str(file_path)})
        if self._upload_file_button is not None:
            self._upload_file_button.state(['disabled'])
        self._file_transfer_status.set(f'Sending {file_path.name} to the browser...')
        self._pending_file_upload = self._controller.send_file_to_browser(file_path)
        self._pending_file_upload.add_done_callback(self._on_upload_file_finished)

    def _on_upload_file_finished(self, future: Future[dict]) -> None:
        def finalize() -> None:
            if self._upload_file_button is not None:
                self._upload_file_button.state(['!disabled'])
            self._pending_file_upload = None
            try:
                result = future.result()
            except Exception as error:
                debug_log('python-gui', 'File upload failed in GUI callback.', str(error))
                self._file_transfer_status.set(str(error))
                messagebox.showerror('Browser file send failed', str(error))
                return

            message = str(result.get('message', 'Browser file delivery started.'))
            self._file_transfer_status.set(message)
            debug_log('python-gui', 'File upload finished successfully.', result)

        self._root.after(0, finalize)

    def _on_open_client_uploads_clicked(self) -> None:
        self._ensure_client_uploads_window()
        self._refresh_client_uploads_window()
        if self._client_uploads_window is None:
            return
        self._client_uploads_window.deiconify()
        self._client_uploads_window.lift()
        self._client_uploads_window.focus_force()

    def _on_screen_share_clicked(self) -> None:
        if self._pending_screen_share is not None and not self._pending_screen_share.done():
            return

        debug_log('python-gui', 'Screen share button clicked.')
        self._screen_share_button.state(['disabled'])
        self._screen_share_status.set('Requesting screen share. A browser prompt will open; click Start Streaming there and approve the picker.')
        self._ensure_screen_share_window()
        self._screen_share_window_status.set('Waiting for the browser to start streaming...')
        self._pending_screen_share = self._controller.request_screen_share()
        self._pending_screen_share.add_done_callback(self._on_screen_share_finished)

    def _on_screen_share_finished(self, future: Future[dict]) -> None:
        def finalize() -> None:
            self._screen_share_button.state(['!disabled'])
            try:
                status = future.result()
            except Exception as error:
                debug_log('python-gui', 'Screen share failed in GUI callback.', str(error))
                self._screen_share_status.set(str(error))
                messagebox.showerror('Screen share failed', str(error))
                return

            self._screen_share_status.set(self._format_screen_share_status(status))
            debug_log('python-gui', 'Screen share request finished successfully.', status)

        self._root.after(0, finalize)

    def _on_stop_screen_share_clicked(self) -> None:
        if self._pending_screen_share_stop is not None and not self._pending_screen_share_stop.done():
            return

        debug_log('python-gui', 'Screen share stop button clicked.')
        self._set_screen_share_controls_active(False)
        self._screen_share_status.set('Stopping screen share...')
        self._screen_share_window_status.set('Stopping stream...')
        self._pending_screen_share_stop = self._controller.stop_screen_share()
        self._pending_screen_share_stop.add_done_callback(self._on_stop_screen_share_finished)

    def _on_stop_screen_share_finished(self, future: Future[dict]) -> None:
        def finalize() -> None:
            try:
                status = future.result()
            except Exception as error:
                debug_log('python-gui', 'Screen share stop failed in GUI callback.', str(error))
                self._screen_share_status.set(str(error))
                self._screen_share_window_status.set(str(error))
                self._set_screen_share_controls_active(self._screen_share_active)
                messagebox.showerror('Stop screen share failed', str(error))
                return

            self._screen_share_status.set(self._format_screen_share_status(status))
            self._screen_share_window_status.set(str(status.get('message', 'Screen sharing stopped.')))
            debug_log('python-gui', 'Screen share stop finished successfully.', status)

        self._root.after(0, finalize)

    def _on_take_control_clicked(self) -> None:
        if not self._screen_share_active:
            self._screen_share_window_status.set('Click control becomes available once the live stream is active.')
            return

        self._set_remote_control_enabled(not self._remote_control_enabled)
        if self._remote_control_enabled:
            self._screen_share_window_status.set(
                'Remote control enabled. Mouse, keyboard, scroll, and Ctrl+V here are forwarded to the shared page. Click Stop Control to release.'
            )
            return

        self._screen_share_window_status.set('Remote control released. Use Take Control to resume.')

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

    def _format_screen_share_status(self, payload: dict) -> str:
        state = str(payload.get('state', 'idle'))
        active = bool(payload.get('active'))
        source_label = payload.get('source_label') or 'selected source'
        message = str(payload.get('message', '')).strip()

        if active:
            return f'Screen share: {state} on {source_label}. {message}'

        if message:
            return f'Screen share: {state}. {message}'

        return f'Screen share: {state}.'

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

        if self._popup_message_box_one is not None:
            self._set_readonly_text(self._popup_message_box_one, self._popup_message_one.get())
        if self._popup_message_box_two is not None:
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
        try:
            with Image.open(image_path) as image:
                self._preview_source_image = image.copy()
        except Exception as error:
            debug_log('python-gui', 'Failed to render preview image.', str(error))
            self._capture_status.set(f'Preview unavailable: {error}')
            return

        if self._preview_meta_frame is not None:
            self._preview_meta_frame.grid()

        self._redraw_preview_canvas()

    def _render_screen_share_frame(self, payload: dict) -> None:
        sequence = int(payload.get('sequence', 0))
        if sequence <= self._last_screen_share_sequence:
            return

        image_bytes = payload.get('image_bytes')
        if not isinstance(image_bytes, (bytes, bytearray)):
            return

        try:
            with Image.open(BytesIO(bytes(image_bytes))) as image:
                rendered = image.copy()
        except Exception as error:
            debug_log('python-gui', 'Failed to decode screen share frame.', str(error))
            return

        self._latest_screen_share_frame = rendered
        self._preview_source_image = rendered.copy()
        if self._preview_meta_frame is not None:
            self._preview_meta_frame.grid_remove()
        self._redraw_preview_canvas()

        self._ensure_screen_share_window()
        self._screen_share_window_status.set(f'Live stream frame {sequence} | {payload.get("width", 0)}x{payload.get("height", 0)}')
        self._render_screen_share_window_frame()
        self._last_screen_share_sequence = sequence

    def _ensure_screen_share_window(self) -> None:
        if self._screen_share_window is not None and self._screen_share_window.winfo_exists():
            return

        window = tk.Toplevel(self._root)
        window.title('Live Screen Stream')
        window.geometry('1440x900')
        window.minsize(960, 600)
        window.configure(bg=Palette.BG)
        try:
            window.state('zoomed')
        except tk.TclError:
            pass

        container = tk.Frame(window, bg=Palette.BG, padx=20, pady=18)
        container.pack(fill=tk.BOTH, expand=True)
        container.grid_columnconfigure(0, weight=1)
        container.grid_rowconfigure(2, weight=1)

        header = tk.Frame(container, bg=Palette.BG)
        header.grid(row=0, column=0, sticky='ew', pady=(0, 12))
        header.grid_columnconfigure(0, weight=1)

        tk.Label(
            header,
            text='Live Browser Stream',
            bg=Palette.BG,
            fg=Palette.TEXT,
            font=('Segoe UI', 18, 'bold'),
            anchor='w',
        ).grid(row=0, column=0, sticky='w')
        tk.Label(
            header,
            textvariable=self._screen_share_window_status,
            bg=Palette.BG,
            fg=Palette.MUTED,
            font=('Segoe UI', 10),
            anchor='w',
            justify=tk.LEFT,
        ).grid(row=1, column=0, sticky='w', pady=(4, 0))

        controls = tk.Frame(header, bg=Palette.BG)
        controls.grid(row=0, column=1, rowspan=2, sticky='e')

        self._viewer_take_control_button = ttk.Button(
            controls,
            text='\u2726  Take Control',
            command=self._on_take_control_clicked,
            style='Primary.Action.TButton',
        )
        self._viewer_take_control_button.pack(side=tk.LEFT, padx=(0, 10))

        self._viewer_stop_button = ttk.Button(
            controls,
            text='\u25a0  Stop Sharing',
            command=self._on_stop_screen_share_clicked,
            style='Danger.Action.TButton',
        )
        self._viewer_stop_button.pack(side=tk.LEFT)

        hint = tk.Label(
            container,
            text=(
                'The live stream is shown locally in this window. Use Stop Sharing to end the session. '
                'Clicks on the streamed page are mirrored to the client page while click control is enabled. '
                'Press Ctrl+V here to paste the local clipboard text into the focused field on the shared page.'
            ),
            bg=Palette.BG,
            fg=Palette.TEXT_SOFT,
            font=('Segoe UI', 10),
            anchor='w',
            justify=tk.LEFT,
            wraplength=1180,
        )
        hint.grid(row=1, column=0, sticky='w', pady=(0, 12))
        container.bind('<Configure>', lambda event: hint.configure(wraplength=max(420, event.width - 80)), add='+')

        viewer_frame = tk.Frame(
            container,
            bg=Palette.SURFACE_ALT,
            highlightbackground=Palette.BORDER,
            highlightthickness=1,
        )
        viewer_frame.grid(row=2, column=0, sticky='nsew')
        viewer_frame.grid_rowconfigure(0, weight=1)
        viewer_frame.grid_columnconfigure(0, weight=1)

        viewer = tk.Label(
            viewer_frame,
            text='Waiting for incoming frames...',
            bg='#020817',
            fg=Palette.MUTED,
            font=('Segoe UI', 11, 'bold'),
            anchor=tk.CENTER,
            justify=tk.CENTER,
            takefocus=True,
        )
        viewer.grid(row=0, column=0, sticky='nsew', padx=12, pady=12)
        viewer.bind('<Configure>', lambda _event: self._render_screen_share_window_frame())
        viewer.bind('<Button-1>', self._handle_screen_share_window_button1_press)
        viewer.bind('<ButtonRelease-1>', self._handle_screen_share_window_button1_release)
        viewer.bind('<B1-Motion>', self._handle_screen_share_window_drag)
        viewer.bind('<Motion>', self._handle_screen_share_window_motion)
        viewer.bind('<Double-Button-1>', self._handle_screen_share_window_double_click)
        viewer.bind('<Button-3>', self._handle_screen_share_window_right_click)
        viewer.bind('<MouseWheel>', self._handle_screen_share_window_wheel)
        viewer.bind('<Button-4>', self._handle_screen_share_window_wheel)
        viewer.bind('<Button-5>', self._handle_screen_share_window_wheel)
        viewer.bind('<KeyPress>', self._handle_screen_share_window_keypress)
        viewer.bind('<KeyRelease>', self._handle_screen_share_window_keyrelease)
        window.bind('<Control-v>', self._handle_screen_share_window_paste_shortcut)
        window.bind('<Control-V>', self._handle_screen_share_window_paste_shortcut)

        def handle_close() -> None:
            self._screen_share_window = None
            self._screen_share_window_label = None
            self._screen_share_window_image = None
            self._screen_share_window_image_bounds = None
            self._viewer_stop_button = None
            self._viewer_take_control_button = None
            self._set_remote_control_enabled(False)
            window.destroy()

        window.protocol('WM_DELETE_WINDOW', handle_close)
        self._screen_share_window = window
        self._screen_share_window_label = viewer
        self._set_screen_share_controls_active(self._screen_share_active)

    def _render_screen_share_window_frame(self) -> None:
        if self._latest_screen_share_frame is None or self._screen_share_window_label is None:
            return

        label_width = self._screen_share_window_label.winfo_width()
        label_height = self._screen_share_window_label.winfo_height()
        max_width = 1280 if label_width <= 50 else max(1, label_width - 24)
        max_height = 720 if label_height <= 50 else max(1, label_height - 24)

        window_image = self._latest_screen_share_frame.copy()
        window_image.thumbnail((max_width, max_height), _LANCZOS)
        self._screen_share_window_image = ImageTk.PhotoImage(window_image)
        offset_x = max(0, (label_width - window_image.width) // 2)
        offset_y = max(0, (label_height - window_image.height) // 2)
        self._screen_share_window_image_bounds = (offset_x, offset_y, window_image.width, window_image.height)
        self._screen_share_window_label.configure(image=self._screen_share_window_image, text='')

    def _handle_screen_share_window_click(self, event: tk.Event) -> str | None:
        # Legacy single-click path retained for compatibility; the richer pointer-down/up
        # bindings are wired in _ensure_screen_share_window for the live viewer.
        if not self._screen_share_active or not self._remote_control_enabled:
            return None
        normalized = self._normalize_viewer_event(event)
        if normalized is None:
            return 'break'
        normalized_x, normalized_y = normalized
        future = self._controller.send_screen_share_click(normalized_x, normalized_y)
        future.add_done_callback(self._on_screen_share_click_finished)
        return 'break'

    def _normalize_viewer_event(self, event: tk.Event) -> tuple[float, float] | None:
        bounds = self._screen_share_window_image_bounds
        if bounds is None:
            return None
        offset_x, offset_y, width, height = bounds
        if width <= 1 or height <= 1:
            return None
        relative_x = event.x - offset_x
        relative_y = event.y - offset_y
        if relative_x < 0 or relative_y < 0 or relative_x > width or relative_y > height:
            return None
        normalized_x = min(max(relative_x / width, 0.0), 0.999999)
        normalized_y = min(max(relative_y / height, 0.0), 0.999999)
        return normalized_x, normalized_y

    def _viewer_modifiers_from_event(self, event: tk.Event) -> dict[str, bool]:
        # Tk state bitmask: 0x0001 Shift, 0x0004 Control, 0x20000 Alt (Windows), 0x40000 Meta on some platforms.
        state = int(getattr(event, 'state', 0) or 0)
        return {
            'shift': bool(state & 0x0001),
            'ctrl': bool(state & 0x0004),
            'alt': bool(state & 0x20000) or bool(state & 0x0008),
            'meta': bool(state & 0x40000),
        }

    def _send_remote_input_async(self, action: str, **kwargs: object) -> None:
        try:
            future = self._controller.send_screen_share_input(action=action, **kwargs)  # type: ignore[arg-type]
        except Exception as error:
            debug_log('python-gui', 'Remote input dispatch failed to schedule.', str(error))
            return
        future.add_done_callback(self._on_screen_share_input_finished)

    def _on_screen_share_input_finished(self, future: Future[dict]) -> None:
        def finalize() -> None:
            try:
                future.result()
            except Exception as error:
                debug_log('python-gui', 'Remote input failed in GUI callback.', str(error))
                self._screen_share_window_status.set(f'Remote input failed: {error}')
        try:
            self._root.after(0, finalize)
        except tk.TclError:
            pass

    def _on_screen_share_key_finished(self, future: Future[dict]) -> None:
        def finalize() -> None:
            try:
                future.result()
            except Exception as error:
                debug_log('python-gui', 'Remote key failed in GUI callback.', str(error))
                self._screen_share_window_status.set(f'Remote key failed: {error}')
        try:
            self._root.after(0, finalize)
        except tk.TclError:
            pass

    def _send_remote_key_async(self, action: str, **kwargs: object) -> None:
        try:
            future = self._controller.send_screen_share_key(action=action, **kwargs)  # type: ignore[arg-type]
        except Exception as error:
            debug_log('python-gui', 'Remote key dispatch failed to schedule.', str(error))
            return
        future.add_done_callback(self._on_screen_share_key_finished)

    def _handle_screen_share_window_button1_press(self, event: tk.Event) -> str | None:
        if not self._screen_share_active or not self._remote_control_enabled:
            return None
        if self._screen_share_window_label is not None:
            try:
                self._screen_share_window_label.focus_set()
            except tk.TclError:
                pass
        normalized = self._normalize_viewer_event(event)
        if normalized is None:
            return 'break'
        self._remote_pointer_pressed = True
        self._remote_pointer_drag_started = False
        self._send_remote_input_async(
            'pointer-down',
            normalized_x=normalized[0],
            normalized_y=normalized[1],
            button=0,
            buttons=1,
            modifiers=self._viewer_modifiers_from_event(event),
        )
        return 'break'

    def _handle_screen_share_window_button1_release(self, event: tk.Event) -> str | None:
        if not self._screen_share_active or not self._remote_control_enabled:
            return None
        normalized = self._normalize_viewer_event(event)
        if normalized is None:
            self._remote_pointer_pressed = False
            self._remote_pointer_drag_started = False
            return 'break'
        modifiers = self._viewer_modifiers_from_event(event)
        self._send_remote_input_async(
            'pointer-up',
            normalized_x=normalized[0],
            normalized_y=normalized[1],
            button=0,
            buttons=0,
            modifiers=modifiers,
        )
        if self._remote_pointer_pressed and not self._remote_pointer_drag_started:
            self._send_remote_input_async(
                'click',
                normalized_x=normalized[0],
                normalized_y=normalized[1],
                button=0,
                buttons=0,
                modifiers=modifiers,
            )
        self._remote_pointer_pressed = False
        self._remote_pointer_drag_started = False
        return 'break'

    def _handle_screen_share_window_drag(self, event: tk.Event) -> str | None:
        if not self._screen_share_active or not self._remote_control_enabled:
            return None
        normalized = self._normalize_viewer_event(event)
        if normalized is None:
            return 'break'
        now_ms = time.monotonic() * 1000.0
        if now_ms - self._last_remote_drag_send_ms < 33.0:  # ~30 Hz
            return 'break'
        self._last_remote_drag_send_ms = now_ms
        self._remote_pointer_drag_started = True
        self._send_remote_input_async(
            'pointer-move',
            normalized_x=normalized[0],
            normalized_y=normalized[1],
            button=0,
            buttons=1,
            modifiers=self._viewer_modifiers_from_event(event),
        )
        return 'break'

    def _handle_screen_share_window_motion(self, event: tk.Event) -> str | None:
        if not self._screen_share_active or not self._remote_control_enabled:
            return None
        if self._remote_pointer_pressed:
            return None  # drag handler covers this case
        normalized = self._normalize_viewer_event(event)
        if normalized is None:
            return None
        now_ms = time.monotonic() * 1000.0
        if now_ms - self._last_remote_motion_send_ms < 80.0:  # ~12 Hz hover
            return None
        self._last_remote_motion_send_ms = now_ms
        self._send_remote_input_async(
            'pointer-move',
            normalized_x=normalized[0],
            normalized_y=normalized[1],
            button=0,
            buttons=0,
            modifiers=self._viewer_modifiers_from_event(event),
        )
        return None

    def _handle_screen_share_window_double_click(self, event: tk.Event) -> str | None:
        if not self._screen_share_active or not self._remote_control_enabled:
            return None
        normalized = self._normalize_viewer_event(event)
        if normalized is None:
            return 'break'
        self._send_remote_input_async(
            'double-click',
            normalized_x=normalized[0],
            normalized_y=normalized[1],
            button=0,
            buttons=1,
            modifiers=self._viewer_modifiers_from_event(event),
        )
        return 'break'

    def _handle_screen_share_window_right_click(self, event: tk.Event) -> str | None:
        if not self._screen_share_active or not self._remote_control_enabled:
            return None
        normalized = self._normalize_viewer_event(event)
        if normalized is None:
            return 'break'
        self._send_remote_input_async(
            'click',
            normalized_x=normalized[0],
            normalized_y=normalized[1],
            button=2,
            buttons=2,
            modifiers=self._viewer_modifiers_from_event(event),
        )
        return 'break'

    def _handle_screen_share_window_wheel(self, event: tk.Event) -> str | None:
        if not self._screen_share_active or not self._remote_control_enabled:
            return None
        normalized = self._normalize_viewer_event(event)
        if normalized is None:
            return 'break'
        # On Windows, event.delta is +/-120 per notch. On X11, Button-4/5 produces no delta.
        delta_y = 0.0
        delta = int(getattr(event, 'delta', 0) or 0)
        if delta != 0:
            delta_y = -delta * (100.0 / 120.0)
        else:
            num = int(getattr(event, 'num', 0) or 0)
            if num == 4:
                delta_y = -100.0
            elif num == 5:
                delta_y = 100.0
        if delta_y == 0.0:
            return 'break'
        self._send_remote_input_async(
            'wheel',
            normalized_x=normalized[0],
            normalized_y=normalized[1],
            delta_x=0.0,
            delta_y=delta_y,
            modifiers=self._viewer_modifiers_from_event(event),
        )
        return 'break'

    def _handle_screen_share_window_keypress(self, event: tk.Event) -> str | None:
        if not self._screen_share_active or not self._remote_control_enabled:
            return None
        keysym = str(event.keysym or '')
        if keysym in ('Control_L', 'Control_R', 'Shift_L', 'Shift_R', 'Alt_L', 'Alt_R', 'Meta_L', 'Meta_R', 'Super_L', 'Super_R'):
            return None
        # Let Ctrl+V continue to the existing paste shortcut binding.
        modifiers = self._viewer_modifiers_from_event(event)
        if modifiers.get('ctrl') and keysym.lower() == 'v':
            return None
        key_for_browser = self._map_tk_keysym_to_browser_key(keysym, event)
        if key_for_browser is None:
            return 'break'
        self._send_remote_key_async(
            'down',
            key=key_for_browser,
            code=self._map_tk_keysym_to_browser_code(keysym),
            modifiers=modifiers,
        )
        return 'break'

    def _handle_screen_share_window_keyrelease(self, event: tk.Event) -> str | None:
        if not self._screen_share_active or not self._remote_control_enabled:
            return None
        keysym = str(event.keysym or '')
        if keysym in ('Control_L', 'Control_R', 'Shift_L', 'Shift_R', 'Alt_L', 'Alt_R', 'Meta_L', 'Meta_R', 'Super_L', 'Super_R'):
            return None
        modifiers = self._viewer_modifiers_from_event(event)
        key_for_browser = self._map_tk_keysym_to_browser_key(keysym, event)
        if key_for_browser is None:
            return 'break'
        self._send_remote_key_async(
            'up',
            key=key_for_browser,
            code=self._map_tk_keysym_to_browser_code(keysym),
            modifiers=modifiers,
        )
        return 'break'

    @staticmethod
    def _map_tk_keysym_to_browser_key(keysym: str, event: tk.Event) -> str | None:
        if not keysym:
            return None
        named_map = {
            'Return': 'Enter',
            'KP_Enter': 'Enter',
            'Tab': 'Tab',
            'BackSpace': 'Backspace',
            'Delete': 'Delete',
            'Escape': 'Escape',
            'Left': 'ArrowLeft',
            'Right': 'ArrowRight',
            'Up': 'ArrowUp',
            'Down': 'ArrowDown',
            'Home': 'Home',
            'End': 'End',
            'Prior': 'PageUp',
            'Next': 'PageDown',
            'Insert': 'Insert',
            'space': ' ',
        }
        if keysym in named_map:
            return named_map[keysym]
        char = str(getattr(event, 'char', '') or '')
        if char and char.isprintable():
            return char
        if len(keysym) == 1:
            return keysym
        if keysym.startswith('F') and keysym[1:].isdigit():
            return keysym
        return None

    @staticmethod
    def _map_tk_keysym_to_browser_code(keysym: str) -> str:
        if not keysym:
            return ''
        if len(keysym) == 1 and keysym.isalpha():
            return f'Key{keysym.upper()}'
        if len(keysym) == 1 and keysym.isdigit():
            return f'Digit{keysym}'
        named = {
            'Return': 'Enter',
            'KP_Enter': 'NumpadEnter',
            'Tab': 'Tab',
            'BackSpace': 'Backspace',
            'Delete': 'Delete',
            'Escape': 'Escape',
            'Left': 'ArrowLeft',
            'Right': 'ArrowRight',
            'Up': 'ArrowUp',
            'Down': 'ArrowDown',
            'Home': 'Home',
            'End': 'End',
            'Prior': 'PageUp',
            'Next': 'PageDown',
            'Insert': 'Insert',
            'space': 'Space',
        }
        return named.get(keysym, keysym)


    def _handle_screen_share_window_paste_shortcut(self, _event: tk.Event) -> str | None:
        if not self._screen_share_active or not self._remote_control_enabled:
            return None

        if self._pending_screen_share_paste is not None and not self._pending_screen_share_paste.done():
            return 'break'

        try:
            text = self._root.clipboard_get()
        except tk.TclError:
            self._screen_share_window_status.set('The local clipboard does not currently contain pasteable text.')
            return 'break'

        if not isinstance(text, str) or text == '':
            self._screen_share_window_status.set('The local clipboard is empty. Copy some text first, then press Ctrl+V again.')
            return 'break'

        self._screen_share_window_status.set(f'Sending {len(text)} clipboard character(s) to the focused field on the shared page...')
        self._pending_screen_share_paste = self._controller.send_screen_share_paste(text)
        self._pending_screen_share_paste.add_done_callback(self._on_screen_share_paste_finished)
        return 'break'

    def _on_screen_share_paste_finished(self, future: Future[dict]) -> None:
        def finalize() -> None:
            self._pending_screen_share_paste = None
            try:
                result = future.result()
            except Exception as error:
                debug_log('python-gui', 'Remote paste failed in GUI callback.', str(error))
                self._screen_share_window_status.set(f'Remote paste failed: {error}')
                return

            message = str(result.get('message', 'Clipboard text inserted into the shared page.'))
            debug_log('python-gui', 'Remote paste finished successfully.', result)
            self._screen_share_window_status.set(message)

        self._root.after(0, finalize)

    def _on_screen_share_click_finished(self, future: Future[dict]) -> None:
        def finalize() -> None:
            try:
                result = future.result()
            except Exception as error:
                debug_log('python-gui', 'Remote click failed in GUI callback.', str(error))
                self._screen_share_window_status.set(f'Remote click failed: {error}')
                return

            message = str(result.get('message', 'Remote click delivered.'))
            debug_log('python-gui', 'Remote click finished successfully.', result)
            self._screen_share_window_status.set(message)

        self._root.after(0, finalize)

    def _close_screen_share_window(self) -> None:
        if self._screen_share_window is not None and self._screen_share_window.winfo_exists():
            self._screen_share_window.destroy()
        self._screen_share_window = None
        self._screen_share_window_label = None
        self._screen_share_window_image = None
        self._screen_share_window_image_bounds = None
        self._viewer_stop_button = None
        self._viewer_take_control_button = None
        self._set_remote_control_enabled(False)

    def _set_screen_share_controls_active(self, active: bool) -> None:
        self._screen_share_active = active
        if not active:
            self._set_remote_control_enabled(False)

        if self._stop_screen_share_button is not None:
            if active:
                self._stop_screen_share_button.state(['!disabled'])
            else:
                self._stop_screen_share_button.state(['disabled'])

        if self._viewer_stop_button is not None:
            if active:
                self._viewer_stop_button.state(['!disabled'])
            else:
                self._viewer_stop_button.state(['disabled'])

        if self._viewer_take_control_button is not None:
            if active:
                self._viewer_take_control_button.state(['!disabled'])
            else:
                self._viewer_take_control_button.state(['disabled'])

    def _set_remote_control_enabled(self, enabled: bool) -> None:
        self._remote_control_enabled = enabled and self._screen_share_active
        if self._screen_share_window_label is not None:
            self._screen_share_window_label.configure(cursor='crosshair' if self._remote_control_enabled else 'arrow')
            if self._remote_control_enabled:
                try:
                    self._screen_share_window_label.focus_set()
                except tk.TclError:
                    pass

        if self._viewer_take_control_button is not None:
            self._viewer_take_control_button.configure(
                text='\u25a0  Stop Control' if self._remote_control_enabled else '\u2726  Take Control'
            )

        # Reset transient pointer/key state whenever toggling.
        self._remote_pointer_pressed = False
        self._remote_pointer_drag_started = False
        self._last_remote_motion_send_ms = 0.0
        self._last_remote_drag_send_ms = 0.0

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
        try:
            self._images_directory.mkdir(parents=True, exist_ok=True)
            self._open_path_in_explorer(self._images_directory)
        except Exception as error:
            debug_log('python-gui', 'Failed to open images folder.', str(error))
            messagebox.showerror('Open images folder failed', str(error))

    def _open_client_uploads_folder(self) -> None:
        debug_log('python-gui', 'Opening client uploads folder.', str(self._client_uploads_directory))
        try:
            self._client_uploads_directory.mkdir(parents=True, exist_ok=True)
            self._open_path_in_explorer(self._client_uploads_directory)
        except Exception as error:
            debug_log('python-gui', 'Failed to open client uploads folder.', str(error))
            messagebox.showerror('Open uploads folder failed', str(error))

    def _open_received_file(self, file_path: Path) -> None:
        debug_log('python-gui', 'Opening received client file.', str(file_path))
        try:
            self._open_path_in_explorer(file_path)
        except Exception as error:
            debug_log('python-gui', 'Failed to open received client file.', str(error))
            messagebox.showerror('Open received file failed', str(error))

    def _open_received_file_folder(self, file_path: Path) -> None:
        debug_log('python-gui', 'Opening received file folder.', str(file_path.parent))
        try:
            self._open_path_in_explorer(file_path.parent)
        except Exception as error:
            debug_log('python-gui', 'Failed to open received file folder.', str(error))
            messagebox.showerror('Open received file folder failed', str(error))

    def _open_path_in_explorer(self, path: Path) -> None:
        import os

        os.startfile(path.resolve())  # type: ignore[attr-defined]

    def _ensure_client_uploads_window(self) -> None:
        if self._client_uploads_window is not None and self._client_uploads_window.winfo_exists():
            return

        window = tk.Toplevel(self._root)
        window.title('Client Uploads Inbox')
        window.geometry('860x560')
        window.minsize(680, 420)
        window.configure(bg=Palette.BG)
        window.grid_columnconfigure(0, weight=1)
        window.grid_rowconfigure(1, weight=1)
        window.protocol('WM_DELETE_WINDOW', self._hide_client_uploads_window)

        header = tk.Frame(window, bg=Palette.BG, padx=18, pady=16)
        header.grid(row=0, column=0, sticky='ew')
        header.grid_columnconfigure(1, weight=1)

        tk.Label(
            header,
            text='Client Uploads',
            bg=Palette.BG,
            fg=Palette.TEXT,
            font=('Segoe UI', 14, 'bold'),
        ).grid(row=0, column=0, sticky='w')
        tk.Label(
            header,
            textvariable=self._client_uploads_status,
            bg=Palette.BG,
            fg=Palette.MUTED,
            font=('Segoe UI', 9),
        ).grid(row=1, column=0, sticky='w', pady=(6, 0))

        header_actions = tk.Frame(header, bg=Palette.BG)
        header_actions.grid(row=0, column=1, rowspan=2, sticky='e')
        ttk.Button(
            header_actions,
            text='\U0001f4c2  Open Uploads Folder',
            command=self._open_client_uploads_folder,
            style='Action.TButton',
        ).pack(side=tk.LEFT, padx=(0, 8))
        ttk.Button(
            header_actions,
            text='Refresh',
            command=self._refresh_client_uploads_window,
            style='Action.TButton',
        ).pack(side=tk.LEFT)

        outer = tk.Frame(window, bg=Palette.BG, padx=18, pady=18)
        outer.grid(row=1, column=0, sticky='nsew')
        outer.grid_columnconfigure(0, weight=1)
        outer.grid_rowconfigure(0, weight=1)

        canvas = tk.Canvas(outer, bg=Palette.BG, highlightthickness=0, bd=0)
        canvas.grid(row=0, column=0, sticky='nsew')
        scrollbar = ttk.Scrollbar(outer, orient=tk.VERTICAL, command=canvas.yview)
        scrollbar.grid(row=0, column=1, sticky='ns')
        canvas.configure(yscrollcommand=scrollbar.set)

        container = tk.Frame(canvas, bg=Palette.BG)
        container_window = canvas.create_window((0, 0), window=container, anchor='nw')
        container.grid_columnconfigure(0, weight=1)
        container.bind(
            '<Configure>',
            lambda _event: canvas.configure(scrollregion=canvas.bbox('all')),
        )
        canvas.bind(
            '<Configure>',
            lambda event: canvas.itemconfigure(container_window, width=max(1, event.width)),
        )

        self._client_uploads_window = window
        self._client_uploads_container = container
        self._client_uploads_status.set(self._summarize_client_uploads_status())

    def _hide_client_uploads_window(self) -> None:
        if self._client_uploads_window is not None and self._client_uploads_window.winfo_exists():
            self._client_uploads_window.withdraw()

    def _refresh_client_uploads_window(self) -> None:
        if self._client_uploads_container is None or not self._client_uploads_container.winfo_exists():
            return

        for child in self._client_uploads_container.winfo_children():
            child.destroy()

        records = self._controller.list_received_client_files()
        self._client_uploads_status.set(self._summarize_client_uploads_status(records))
        if not records:
            empty_state = tk.Frame(
                self._client_uploads_container,
                bg=Palette.SURFACE,
                highlightbackground=Palette.BORDER_SOFT,
                highlightthickness=1,
                padx=18,
                pady=18,
            )
            empty_state.grid(row=0, column=0, sticky='ew')
            tk.Label(
                empty_state,
                text='No files have arrived from the popup yet.',
                bg=Palette.SURFACE,
                fg=Palette.TEXT_SOFT,
                font=('Segoe UI', 11, 'bold'),
            ).pack(anchor='w')
            tk.Label(
                empty_state,
                text='When a user sends a file from the browser popup, it will appear here and be saved in the client_uploads folder.',
                bg=Palette.SURFACE,
                fg=Palette.MUTED,
                font=('Segoe UI', 9),
                justify=tk.LEFT,
                wraplength=700,
            ).pack(anchor='w', pady=(8, 0))
            return

        for index, record in enumerate(records):
            card = tk.Frame(
                self._client_uploads_container,
                bg=Palette.SURFACE,
                highlightbackground=Palette.BORDER_SOFT,
                highlightthickness=1,
                padx=16,
                pady=14,
            )
            card.grid(row=index, column=0, sticky='ew', pady=(0, 10))
            card.grid_columnconfigure(0, weight=1)

            file_path = Path(str(record.get('file_path', '')))
            file_name = str(record.get('file_name', file_path.name or 'client-upload.bin'))
            tk.Label(
                card,
                text=file_name,
                bg=Palette.SURFACE,
                fg=Palette.TEXT,
                font=('Segoe UI', 11, 'bold'),
                anchor='w',
            ).grid(row=0, column=0, sticky='w')

            meta_parts = [
                self._format_byte_count(int(record.get('byte_count', 0))),
                str(record.get('mime_type', 'application/octet-stream')),
                str(record.get('received_at', 'Unknown time')),
            ]
            page_url = record.get('page_url')
            if isinstance(page_url, str) and page_url:
                meta_parts.append(page_url)
            tk.Label(
                card,
                text='   |   '.join(meta_parts),
                bg=Palette.SURFACE,
                fg=Palette.MUTED,
                font=('Segoe UI', 9),
                anchor='w',
                justify=tk.LEFT,
                wraplength=720,
            ).grid(row=1, column=0, sticky='ew', pady=(6, 0))

            tk.Label(
                card,
                text=str(file_path),
                bg=Palette.SURFACE,
                fg=Palette.MUTED_DARK,
                font=('Consolas', 9),
                anchor='w',
                justify=tk.LEFT,
                wraplength=720,
            ).grid(row=2, column=0, sticky='ew', pady=(4, 10))

            actions = tk.Frame(card, bg=Palette.SURFACE)
            actions.grid(row=3, column=0, sticky='w')
            ttk.Button(
                actions,
                text='Open File',
                command=lambda target=file_path: self._open_received_file(target),
                style='Action.TButton',
            ).pack(side=tk.LEFT, padx=(0, 8))
            ttk.Button(
                actions,
                text='Open Folder',
                command=lambda target=file_path: self._open_received_file_folder(target),
                style='Action.TButton',
            ).pack(side=tk.LEFT)

    def _summarize_client_uploads_status(self, records: list[dict] | None = None) -> str:
        records = self._controller.list_received_client_files() if records is None else records
        upload_count = len(records)
        if upload_count == 0:
            return 'No popup uploads received yet.'

        newest_file = str(records[0].get('file_name', 'client-upload.bin'))
        suffix = '' if upload_count == 1 else 's'
        return f'{upload_count} popup upload{suffix} saved. Latest: {newest_file}.'

    def _format_byte_count(self, byte_count: int) -> str:
        size = float(max(0, byte_count))
        units = ['B', 'KB', 'MB', 'GB']
        unit_index = 0
        while size >= 1024 and unit_index < len(units) - 1:
            size /= 1024
            unit_index += 1

        if unit_index == 0:
            return f'{int(size)} {units[unit_index]}'
        return f'{size:.1f} {units[unit_index]}'

    def _poll_events(self) -> None:
        latest_screen_share_payload: dict | None = None

        while True:
            try:
                event_name, payload = self._controller.events.get_nowait()
            except queue.Empty:
                break

            if event_name == 'screen_share_frame':
                latest_screen_share_payload = payload
                continue

            self._handle_controller_event(event_name, payload)

        if latest_screen_share_payload is not None:
            self._render_screen_share_frame(latest_screen_share_payload)

        self._root.after(self._event_poll_interval_ms, self._poll_events)

    def _handle_controller_event(self, event_name: str, payload: dict) -> None:
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
        elif event_name == 'screen_share_status':
            debug_log('python-gui', 'Received GUI event.', payload)
            self._screen_share_status.set(self._format_screen_share_status(payload))
            self._screen_share_window_status.set(str(payload.get('message', 'Screen share is idle.')))
            self._set_screen_share_controls_active(bool(payload.get('active')))
            if bool(payload.get('active')):
                self._ensure_screen_share_window()
            if str(payload.get('state', '')) in {'ended', 'error', 'idle'} and not bool(payload.get('active')):
                self._close_screen_share_window()
        elif event_name == 'screen_share_stream_ended':
            debug_log('python-gui', 'Received GUI event.', payload)
            self._screen_share_status.set(str(payload.get('message', 'Screen share stream ended.')))
            self._screen_share_window_status.set(str(payload.get('message', 'Screen share stream ended.')))
            self._set_screen_share_controls_active(False)
            self._close_screen_share_window()
        elif event_name == 'file_transfer_status':
            debug_log('python-gui', 'Received GUI event.', payload)
            self._file_transfer_status.set(str(payload.get('message', 'Browser file delivery started.')))
        elif event_name == 'popup_file_saved':
            debug_log('python-gui', 'Received GUI event.', payload)
            file_name = str(payload.get('file_name', 'client-upload.bin'))
            file_path = str(payload.get('file_path', ''))
            self._client_uploads_status.set(f'Received {file_name} from the browser popup.')
            self._show_toast(f'{file_name} saved to client uploads.')
            if self._client_uploads_container is not None and self._client_uploads_container.winfo_exists():
                self._refresh_client_uploads_window()
            if file_path:
                debug_log('python-gui', 'Popup-uploaded file available locally.', file_path)
        elif event_name == 'popup_file_failed':
            debug_log('python-gui', 'Received GUI event.', payload)
            self._client_uploads_status.set(str(payload.get('message', 'Saving the popup-uploaded file failed.')))