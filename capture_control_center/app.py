from __future__ import annotations

import asyncio
import os
import sys
import threading
from pathlib import Path

from capture_control_center.application.controller import CaptureController
from capture_control_center.debug import debug_log
from capture_control_center.infrastructure.bridge_server import BridgeServer
from capture_control_center.infrastructure.image_store import ImageStore
from capture_control_center.presentation.gui import CaptureControlWindow


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


def main() -> None:
    host = '127.0.0.1'
    port = 8765
    debug_log('python-app', 'Starting Capture Control Center.', {'host': host, 'port': port})
    working_directory = Path.cwd()
    loop = asyncio.new_event_loop()
    bridge_server = BridgeServer(host=host, port=port)
    image_store = ImageStore(working_directory)

    server_thread = threading.Thread(target=_run_loop, args=(loop,), daemon=True)
    server_thread.start()
    debug_log('python-app', 'Async event loop thread started.')

    asyncio.run_coroutine_threadsafe(bridge_server.start(), loop).result(timeout=5)
    debug_log('python-app', 'running...')
    controller = CaptureController(bridge_server=bridge_server, image_store=image_store, loop=loop)

    configure_tk_environment()
    import tkinter as tk

    root = tk.Tk()
    window = CaptureControlWindow(
        root=root,
        controller=controller,
        images_directory=image_store.images_directory,
        bridge_url=f'ws://{host}:{port}',
    )

    def handle_close() -> None:
        debug_log('python-app', 'Shutdown requested from GUI.')
        controller.stop()
        loop.call_soon_threadsafe(loop.stop)
        root.destroy()

    root.protocol('WM_DELETE_WINDOW', handle_close)
    root.mainloop()


def _run_loop(loop: asyncio.AbstractEventLoop) -> None:
    asyncio.set_event_loop(loop)
    debug_log('python-app', 'Async event loop entering run_forever().')
    loop.run_forever()


if __name__ == '__main__':
    main()