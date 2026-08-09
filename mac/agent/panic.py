"""Panic kill switch: Ctrl+Option+Cmd+Space freezes ALL synthetic input
instantly, from anywhere (global Quartz event tap). Press again to unfreeze.

This is the blueprint's stage safety requirement: the cursor-corner failsafe
needs the presenter to win a mouse race against the agent; a keyboard chord
doesn't. control.py refuses to emit any event while FROZEN is set, and the
gateway watches the flag to cancel the running task and say so out loud.

Listen-only tap: we observe the chord, never swallow or modify events.
Requires Accessibility permission (which the agent's hands need anyway).
"""

import threading

import Quartz

FROZEN = threading.Event()

_SPACE_KEYCODE = 49
_CHORD = (
    Quartz.kCGEventFlagMaskControl
    | Quartz.kCGEventFlagMaskAlternate
    | Quartz.kCGEventFlagMaskCommand
)


def check():
    """Raise if input is frozen. Called before every synthetic event."""
    if FROZEN.is_set():
        raise RuntimeError("input frozen by panic hotkey (ctrl+opt+cmd+space)")


def _callback(proxy, type_, event, refcon):
    if type_ == Quartz.kCGEventKeyDown:
        keycode = Quartz.CGEventGetIntegerValueField(
            event, Quartz.kCGKeyboardEventKeycode)
        flags = Quartz.CGEventGetFlags(event)
        if keycode == _SPACE_KEYCODE and (flags & _CHORD) == _CHORD:
            if FROZEN.is_set():
                FROZEN.clear()
                print("\n▶ panic hotkey: input unfrozen")
            else:
                FROZEN.set()
                print("\n⛔ PANIC: synthetic input frozen (press again to resume)")
    return event


def install() -> bool:
    """Start the global listener thread. Returns False if the event tap
    could not be created (missing Accessibility permission)."""
    ok = threading.Event()

    def run():
        tap = Quartz.CGEventTapCreate(
            Quartz.kCGSessionEventTap,
            Quartz.kCGHeadInsertEventTap,
            Quartz.kCGEventTapOptionListenOnly,
            Quartz.CGEventMaskBit(Quartz.kCGEventKeyDown),
            _callback,
            None,
        )
        if tap is None:
            return
        source = Quartz.CFMachPortCreateRunLoopSource(None, tap, 0)
        Quartz.CFRunLoopAddSource(
            Quartz.CFRunLoopGetCurrent(), source, Quartz.kCFRunLoopCommonModes)
        Quartz.CGEventTapEnable(tap, True)
        ok.set()
        Quartz.CFRunLoopRun()

    threading.Thread(target=run, daemon=True, name="panic-hotkey").start()
    return ok.wait(timeout=2.0)
