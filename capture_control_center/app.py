from __future__ import annotations

import asyncio
import threading
import tkinter as tk
from pathlib import Path

from capture_control_center.application.controller import CaptureController
from capture_control_center.infrastructure.bridge_server import BridgeServer
from capture_control_center.infrastructure.image_store import ImageStore
from capture_control_center.presentation.gui import CaptureControlWindow


def main() -> None:
    host = '127.0.0.1'
    port = 8765
    working_directory = Path.cwd()
    loop = asyncio.new_event_loop()
    bridge_server = BridgeServer(host=host, port=port)
    image_store = ImageStore(working_directory)

    server_thread = threading.Thread(target=_run_loop, args=(loop,), daemon=True)
    server_thread.start()

    asyncio.run_coroutine_threadsafe(bridge_server.start(), loop).result(timeout=5)
    controller = CaptureController(bridge_server=bridge_server, image_store=image_store, loop=loop)

    root = tk.Tk()
    window = CaptureControlWindow(
        root=root,
        controller=controller,
        images_directory=image_store.images_directory,
        bridge_url=f'ws://{host}:{port}',
    )

    def handle_close() -> None:
        controller.stop()
        loop.call_soon_threadsafe(loop.stop)
        root.destroy()

    root.protocol('WM_DELETE_WINDOW', handle_close)
    root.mainloop()


def _run_loop(loop: asyncio.AbstractEventLoop) -> None:
    asyncio.set_event_loop(loop)
    loop.run_forever()


if __name__ == '__main__':
    main()