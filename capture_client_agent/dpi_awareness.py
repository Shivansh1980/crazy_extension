"""Per-monitor v2 DPI awareness bootstrap.

Marks the current process as PerMonitorV2 DPI-aware so that:

* Win32 metrics returned by ``GetSystemMetrics`` and ``mss.grab`` reflect the
  *physical* pixels on every monitor (not the 100%-scaled virtual size).
* ``pyautogui.moveTo`` / ``pyautogui.click`` land on the correct on-screen
  pixel even on HiDPI / mixed-DPI displays.

Has no effect on non-Windows platforms or when DPI awareness has already been
locked in by the process host (we silently fall through).
"""

from __future__ import annotations

import sys

_initialized = False


def ensure_per_monitor_v2() -> None:
    """Best-effort: escalate to PerMonitorV2; degrade gracefully on older Windows.

    Tries, in order:
      1. ``SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)``  (Win10 1703+)
      2. ``SetProcessDpiAwarenessContext(PER_MONITOR_AWARE)``     (Win10 1607+)
      3. ``SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE)``(Win 8.1+)
      4. ``SetProcessDPIAware()``                                 (Vista+)

    Each call may fail with ``E_ACCESSDENIED`` if the process has already
    initialized DPI awareness; that's fine — we move to the next tier.
    """

    global _initialized
    if _initialized:
        return
    _initialized = True

    if not sys.platform.startswith('win'):
        return

    try:
        import ctypes
        from ctypes import wintypes  # noqa: F401  (ensures wintypes is loaded)
    except Exception:
        return

    # Tier 1 + 2: SetProcessDpiAwarenessContext (Win10 1607 / 1703+).
    try:
        user32 = ctypes.windll.user32
        SetCtx = getattr(user32, 'SetProcessDpiAwarenessContext', None)
        if SetCtx is not None:
            SetCtx.restype = ctypes.c_bool
            SetCtx.argtypes = [ctypes.c_void_p]
            # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
            if SetCtx(ctypes.c_void_p(-4)):
                return
            # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE    = -3
            if SetCtx(ctypes.c_void_p(-3)):
                return
    except Exception:
        pass

    # Tier 3: SetProcessDpiAwareness (Win 8.1+).
    try:
        shcore = ctypes.windll.shcore
        # PROCESS_PER_MONITOR_DPI_AWARE = 2
        if shcore.SetProcessDpiAwareness(2) == 0:
            return
    except Exception:
        pass

    # Tier 4: SetProcessDPIAware (Vista+ — system-wide DPI only, but better than nothing).
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass
