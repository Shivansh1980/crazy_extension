from __future__ import annotations

import queue
import tkinter as tk
from concurrent.futures import Future
from pathlib import Path
from tkinter import messagebox, ttk

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
        self._preview_image: ImageTk.PhotoImage | None = None

        self._root.title('Capture Control Center')
        self._root.geometry('980x760')
        self._root.minsize(860, 640)

        self._connection_status = tk.StringVar(value=f'Listening on {bridge_url}. Waiting for extension connection...')
        self._capture_status = tk.StringVar(value='No screenshot captured yet.')
        self._last_file = tk.StringVar(value='Not available')
        self._last_page = tk.StringVar(value='Not available')

        self._build_layout()
        self._poll_events()

    def _build_layout(self) -> None:
        style = ttk.Style(self._root)
        style.theme_use('clam')

        container = ttk.Frame(self._root, padding=18)
        container.pack(fill=tk.BOTH, expand=True)

        header = ttk.Frame(container)
        header.pack(fill=tk.X)

        ttk.Label(header, text='Capture Control Center', font=('Segoe UI', 22, 'bold')).pack(anchor=tk.W)
        ttk.Label(
            header,
            text='Drive Chrome screenshot capture from Python and keep the image locally for inspection or downstream analysis.',
            wraplength=820,
        ).pack(anchor=tk.W, pady=(6, 0))

        status_card = ttk.LabelFrame(container, text='Bridge status', padding=16)
        status_card.pack(fill=tk.X, pady=(18, 12))
        ttk.Label(status_card, textvariable=self._connection_status, wraplength=860).pack(anchor=tk.W)
        ttk.Label(status_card, text=f'Images save to: {self._images_directory}', wraplength=860).pack(anchor=tk.W, pady=(8, 0))

        actions = ttk.Frame(container)
        actions.pack(fill=tk.X, pady=(0, 12))

        self._capture_button = ttk.Button(actions, text='Capture screenshot', command=self._on_capture_clicked)
        self._capture_button.pack(side=tk.LEFT)

        ttk.Button(actions, text='Open images folder', command=self._open_images_folder).pack(side=tk.LEFT, padx=(10, 0))

        info_card = ttk.LabelFrame(container, text='Latest result', padding=16)
        info_card.pack(fill=tk.X, pady=(0, 12))
        ttk.Label(info_card, textvariable=self._capture_status, wraplength=860).pack(anchor=tk.W)
        ttk.Label(info_card, textvariable=self._last_file, wraplength=860).pack(anchor=tk.W, pady=(8, 0))
        ttk.Label(info_card, textvariable=self._last_page, wraplength=860).pack(anchor=tk.W, pady=(8, 0))

        preview_card = ttk.LabelFrame(container, text='Preview', padding=16)
        preview_card.pack(fill=tk.BOTH, expand=True)
        self._preview_label = ttk.Label(preview_card, text='Capture a screenshot to preview it here.', anchor=tk.CENTER)
        self._preview_label.pack(fill=tk.BOTH, expand=True)

    def _on_capture_clicked(self) -> None:
        if self._pending_capture is not None and not self._pending_capture.done():
            return

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
                self._capture_status.set(str(error))
                messagebox.showerror('Capture failed', str(error))
                return

            self._capture_status.set('Capture completed and saved locally.')
            self._last_file.set(f'File: {saved_capture.file_path}')
            self._last_page.set(f'Page: {saved_capture.screenshot.page_title or "Untitled"} | {saved_capture.screenshot.page_url}')
            self._render_preview(saved_capture.file_path)

        self._root.after(0, finalize)

    def _render_preview(self, image_path: Path) -> None:
        image = Image.open(image_path)
        image.thumbnail((840, 480))
        self._preview_image = ImageTk.PhotoImage(image)
        self._preview_label.configure(image=self._preview_image, text='')

    def _open_images_folder(self) -> None:
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
                self._connection_status.set(f'Listening on ws://{payload["host"]}:{payload["port"]}. Waiting for extension connection...')
            elif event_name == 'client_connected':
                self._connection_status.set(
                    f'Extension connected: {payload["name"]} {payload["version"]} ({payload["client_id"]}).'
                )
            elif event_name == 'client_disconnected':
                self._connection_status.set(payload['message'])
            elif event_name == 'capture_failed':
                self._capture_status.set(payload['message'])
            elif event_name == 'capture_saved':
                self._capture_status.set(f'Saved {payload["file_name"]} at {payload["captured_at"]}.')

        self._root.after(200, self._poll_events)
