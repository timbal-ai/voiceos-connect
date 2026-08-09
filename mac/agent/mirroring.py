"""iPhone Mirroring window driver (phone mode).

The phone is never automated directly: its screen is a macOS window, so
phone use reduces to computer use on a Viewport cropped to that window.
Requires: macOS Sequoia+, Apple silicon, iPhone on iOS 18+ with the same
Apple ID, locked, in Bluetooth range. The session drops if the phone is
picked up — find_window() returning None is how we detect that.
"""

import subprocess
import time

import Quartz

APP_NAME = "iPhone Mirroring"

# The mirroring window is a tall portrait rectangle; filter out menus,
# tooltips and other small panels the app also owns.
_MIN_W, _MIN_H = 100, 300


def find_window():
    """Rect (x, y, w, h) of the mirroring window in display points, or None."""
    infos = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly
        | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID,
    ) or []
    for info in infos:
        if info.get("kCGWindowOwnerName") != APP_NAME:
            continue
        if info.get("kCGWindowLayer", 0) != 0:  # normal window layer only
            continue
        b = info.get("kCGWindowBounds") or {}
        if b.get("Width", 0) >= _MIN_W and b.get("Height", 0) >= _MIN_H:
            return (b["X"], b["Y"], b["Width"], b["Height"])
    return None


def is_alive() -> bool:
    return find_window() is not None


def connect(timeout: float = 20.0):
    """Launch/focus iPhone Mirroring and return the window rect.

    Raises RuntimeError if the window never appears (phone unlocked, out of
    range, or mirroring unavailable on this account/region).
    """
    subprocess.run(["open", "-a", APP_NAME], check=True, capture_output=True)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        rect = find_window()
        if rect is not None:
            time.sleep(1.0)  # let the connection banner settle
            return find_window() or rect
        time.sleep(0.5)
    raise RuntimeError(
        f"{APP_NAME} window did not appear within {timeout:.0f}s - is the "
        "iPhone locked, nearby, and paired with this Mac?"
    )
