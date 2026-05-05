from __future__ import annotations

import asyncio
from pathlib import Path

from capture_client_agent.client import BackgroundCaptureClient
from capture_client_agent.dpi_awareness import ensure_per_monitor_v2
from capture_control_center.debug import debug_log


def main() -> None:
    # Mark this process as PerMonitorV2 DPI aware *before* importing/using any
    # screen-capture or input library, so coordinates and pixels match what the
    # user actually sees on HiDPI / scaled displays.
    ensure_per_monitor_v2()

    project_directory = Path.cwd()
    debug_log(
        'client-agent',
        'Starting native client agent.',
        {'project_directory': str(project_directory)},
    )
    client = BackgroundCaptureClient(project_directory=project_directory)
    try:
        asyncio.run(client.run_forever())
    except KeyboardInterrupt:
        debug_log('client-agent', 'Native client agent interrupted by user.')


if __name__ == '__main__':
    main()
