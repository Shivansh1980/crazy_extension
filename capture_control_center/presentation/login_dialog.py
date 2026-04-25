"""Modal login dialog used in relay mode.

Blocks until the user submits valid-looking credentials, or cancels (in
which case the application exits). Prefills the username from .env when
available so the operator only has to type the password.
"""

from __future__ import annotations

import tkinter as tk
from dataclasses import dataclass
from tkinter import ttk
from typing import Callable


@dataclass(frozen=True, slots=True)
class LoginResult:
    username: str
    password: str
    cancelled: bool = False


class LoginDialog:
    """A blocking modal Tk dialog that returns ``(username, password)``."""

    def __init__(
        self,
        title: str = 'Capture Control Center — Sign in',
        relay_url: str = '',
        default_username: str = '',
        error_message: str = '',
    ) -> None:
        self._title = title
        self._relay_url = relay_url
        self._default_username = default_username
        self._error_message = error_message
        self._result: LoginResult | None = None

    def prompt(self) -> LoginResult:
        root = tk.Tk()
        root.title(self._title)
        root.resizable(False, False)
        root.protocol('WM_DELETE_WINDOW', lambda: self._on_cancel(root))

        container = ttk.Frame(root, padding=16)
        container.grid(row=0, column=0, sticky='nsew')

        ttk.Label(
            container,
            text='Sign in to the capture relay.',
            font=('Segoe UI', 11, 'bold'),
        ).grid(row=0, column=0, columnspan=2, sticky='w')

        if self._relay_url:
            ttk.Label(container, text=f'Relay: {self._relay_url}', foreground='#555555').grid(
                row=1, column=0, columnspan=2, sticky='w', pady=(2, 12)
            )

        ttk.Label(container, text='Username').grid(row=2, column=0, sticky='w', pady=(0, 4))
        username_var = tk.StringVar(value=self._default_username)
        username_entry = ttk.Entry(container, textvariable=username_var, width=32)
        username_entry.grid(row=2, column=1, sticky='ew', pady=(0, 4))

        ttk.Label(container, text='Password').grid(row=3, column=0, sticky='w')
        password_var = tk.StringVar()
        password_entry = ttk.Entry(container, textvariable=password_var, show='*', width=32)
        password_entry.grid(row=3, column=1, sticky='ew')

        error_var = tk.StringVar(value=self._error_message)
        error_label = ttk.Label(container, textvariable=error_var, foreground='#b00020', wraplength=320)
        error_label.grid(row=4, column=0, columnspan=2, sticky='w', pady=(8, 0))

        button_row = ttk.Frame(container)
        button_row.grid(row=5, column=0, columnspan=2, sticky='e', pady=(16, 0))
        ttk.Button(button_row, text='Cancel', command=lambda: self._on_cancel(root)).grid(row=0, column=0, padx=(0, 8))
        ttk.Button(
            button_row,
            text='Sign in',
            command=lambda: self._on_submit(root, username_var.get(), password_var.get(), error_var),
        ).grid(row=0, column=1)

        container.columnconfigure(1, weight=1)

        # Keyboard ergonomics: Enter submits, Esc cancels.
        root.bind('<Return>', lambda _event: self._on_submit(root, username_var.get(), password_var.get(), error_var))
        root.bind('<Escape>', lambda _event: self._on_cancel(root))

        if self._default_username:
            password_entry.focus_set()
        else:
            username_entry.focus_set()

        # Center on the screen.
        root.update_idletasks()
        width = root.winfo_reqwidth()
        height = root.winfo_reqheight()
        x = (root.winfo_screenwidth() - width) // 2
        y = (root.winfo_screenheight() - height) // 2
        root.geometry(f'+{x}+{y}')

        root.mainloop()

        return self._result or LoginResult(username='', password='', cancelled=True)

    def _on_submit(
        self,
        root: tk.Tk,
        username: str,
        password: str,
        error_var: tk.StringVar,
    ) -> None:
        username = username.strip()
        if not username or not password:
            error_var.set('Please enter both username and password.')
            return
        self._result = LoginResult(username=username, password=password, cancelled=False)
        root.destroy()

    def _on_cancel(self, root: tk.Tk) -> None:
        self._result = LoginResult(username='', password='', cancelled=True)
        root.destroy()


def prompt_with_retry(
    relay_url: str,
    default_username: str,
    verifier: Callable[[str, str], str | None],
) -> LoginResult:
    """Show the dialog, run ``verifier``; on a non-empty error message re-prompt.

    ``verifier`` returns ``None`` on success or an error string to display.
    """
    error_message = ''
    while True:
        dialog = LoginDialog(
            relay_url=relay_url,
            default_username=default_username,
            error_message=error_message,
        )
        result = dialog.prompt()
        if result.cancelled:
            return result
        verification_error = verifier(result.username, result.password)
        if verification_error is None:
            return result
        error_message = verification_error
