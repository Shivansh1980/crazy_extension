from __future__ import annotations

import asyncio
import os
import sys
import threading
from pathlib import Path

from capture_control_center.application.controller import CaptureController
from capture_control_center.debug import debug_log
from capture_control_center.infrastructure.bridge_server import BridgeServer
from capture_control_center.infrastructure.env_loader import load_env_into_os
from capture_control_center.infrastructure.image_store import ImageStore
from capture_control_center.infrastructure.received_file_store import ReceivedFileStore
from capture_control_center.infrastructure.relay_bridge_client import (
    RelayBridgeClient,
    RelayCredentials,
)
from capture_control_center.presentation.gui import CaptureControlWindow
from capture_control_center.presentation.login_dialog import LoginDialog, LoginResult


def configure_tk_environment() -> None:
    if os.environ.get('TCL_LIBRARY') and os.environ.get('TK_LIBRARY'):
        return

    base_prefix = Path(getattr(sys, 'base_prefix', sys.prefix))
    tcl_root = base_prefix / 'tcl'
    tcl_library = tcl_root / 'tcl8.6'
    tk_library = tcl_root / 'tk8.6'

    if tcl_library.is_dir() and 'TCL_LIBRARY' not in os.environ:
        os.environ['TCL_LIBRARY'] = str(tcl_library)

    if tk_library.is_dir() and 'TK_LIBRARY' not in os.environ:
        os.environ['TK_LIBRARY'] = str(tk_library)

    debug_log(
        'python-app',
        'Configured Tcl/Tk environment.',
        {
            'base_prefix': str(base_prefix),
            'tcl_library': os.environ.get('TCL_LIBRARY'),
            'tk_library': os.environ.get('TK_LIBRARY'),
        },
    )


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _bootstrap_environment() -> dict[str, str]:
    env_path = _project_root() / '.env'
    parsed = load_env_into_os(env_path)
    debug_log(
        'python-app',
        'Loaded environment.',
        {'env_path': str(env_path), 'keys': sorted(parsed.keys())},
    )
    return dict(os.environ)


def _resolve_mode(env: dict[str, str]) -> str:
    mode = (env.get('MODE') or 'direct').strip().lower()
    if mode not in {'direct', 'relay'}:
        debug_log('python-app', 'Unknown MODE; defaulting to direct.', {'mode': mode})
        mode = 'direct'
    return mode


def _prompt_credentials(relay_url: str, default_username: str) -> LoginResult:
    configure_tk_environment()
    return LoginDialog(relay_url=relay_url, default_username=default_username).prompt()


def main() -> None:
    env = _bootstrap_environment()
    mode = _resolve_mode(env)
    debug_log('python-app', 'Starting Capture Control Center.', {'mode': mode})
    working_directory = Path.cwd()

    loop = asyncio.new_event_loop()
    server_thread = threading.Thread(target=_run_loop, args=(loop,), daemon=True)
    server_thread.start()
    debug_log('python-app', 'Async event loop thread started.')

    image_store = ImageStore(working_directory)
    received_file_store = ReceivedFileStore(working_directory)

    if mode == 'relay':
        bridge, bridge_url = _start_relay_mode(env, loop)
    else:
        bridge, bridge_url = _start_direct_mode(env, loop)

    if bridge is None:
        debug_log('python-app', 'Bridge initialisation cancelled. Shutting down.')
        loop.call_soon_threadsafe(loop.stop)
        return

    controller = CaptureController(
        bridge_server=bridge,
        image_store=image_store,
        received_file_store=received_file_store,
        loop=loop,
    )

    configure_tk_environment()
    import tkinter as tk

    root = tk.Tk()
    window = CaptureControlWindow(
        root=root,
        controller=controller,
        images_directory=image_store.images_directory,
        client_uploads_directory=received_file_store.files_directory,
        bridge_url=bridge_url,
    )

    def handle_close() -> None:
        debug_log('python-app', 'Shutdown requested from GUI.')
        controller.stop()
        loop.call_soon_threadsafe(loop.stop)
        root.destroy()

    root.protocol('WM_DELETE_WINDOW', handle_close)
    root.mainloop()


def _start_direct_mode(env: dict[str, str], loop: asyncio.AbstractEventLoop):
    host = env.get('BRIDGE_HOST', '127.0.0.1')
    try:
        port = int(env.get('BRIDGE_PORT', '8765'))
    except ValueError:
        port = 8765
    debug_log('python-app', 'Direct mode bridge.', {'host': host, 'port': port})
    bridge_server = BridgeServer(host=host, port=port)
    asyncio.run_coroutine_threadsafe(bridge_server.start(), loop).result(timeout=5)
    return bridge_server, f'ws://{host}:{port}'


def _start_relay_mode(env: dict[str, str], loop: asyncio.AbstractEventLoop):
    relay_url = env.get('RELAY_URL', '').strip()
    session_id = env.get('SESSION_ID', '').strip() or 'default'
    default_username = env.get('RELAY_USERNAME', '').strip()
    if not relay_url:
        raise SystemExit('Relay mode requires RELAY_URL in .env (e.g. wss://example.com/ws).')

    creds = _prompt_credentials(relay_url=relay_url, default_username=default_username)
    if creds.cancelled:
        return None, ''

    credentials = RelayCredentials(
        username=creds.username, password=creds.password, session_id=session_id
    )

    def provide_credentials() -> RelayCredentials:
        return credentials

    bridge = RelayBridgeClient(
        relay_url=relay_url,
        credentials_provider=provide_credentials,
    )
    asyncio.run_coroutine_threadsafe(bridge.start(), loop).result(timeout=5)
    return bridge, relay_url


def _run_loop(loop: asyncio.AbstractEventLoop) -> None:
    asyncio.set_event_loop(loop)
    debug_log('python-app', 'Async event loop entering run_forever().')
    loop.run_forever()


if __name__ == '__main__':
    main()