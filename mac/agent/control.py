"""The hands: synthetic mouse/keyboard via pyautogui (Quartz CGEvent under the
hood). Needs Accessibility permission.

Claude sends xdotool-style key names ("Return", "super+space"); pyautogui
wants its own names ("enter", ["command", "space"]) — normalize_key bridges.
"""

import subprocess
import time

import pyautogui

from . import panic

# Kill switches: slamming the cursor into the top-left corner raises
# FailSafeException; the panic hotkey (ctrl+opt+cmd+space) freezes everything.
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.05

_KEY_MAP = {
    "return": "enter",
    "kp_enter": "enter",
    "super": "command",
    "super_l": "command",
    "super_r": "command",
    "cmd": "command",
    "meta": "command",
    "win": "command",
    "alt": "option",
    "alt_l": "option",
    "alt_r": "option",
    "control": "ctrl",
    "ctrl_l": "ctrl",
    "ctrl_r": "ctrl",
    "shift_l": "shift",
    "shift_r": "shift",
    "back_space": "backspace",
    "escape": "esc",
    "page_down": "pagedown",
    "page_up": "pageup",
    "prior": "pageup",
    "next": "pagedown",
    "caps_lock": "capslock",
    "minus": "-",
    "equal": "=",
    "plus": "+",
    "grave": "`",
    "asciitilde": "~",
    "comma": ",",
    "period": ".",
    "slash": "/",
    "backslash": "\\",
    "semicolon": ";",
    "apostrophe": "'",
    "quotedbl": '"',
    "bracketleft": "[",
    "bracketright": "]",
    "underscore": "_",
}


def normalize_key(key: str) -> str:
    k = key.strip()
    return _KEY_MAP.get(k.lower(), k.lower() if len(k) > 1 else k)


def press_combo(combo: str):
    panic.check()
    keys = [normalize_key(k) for k in combo.split("+")]
    if len(keys) == 1:
        pyautogui.press(keys[0])
    else:
        pyautogui.hotkey(*keys)


def hold_key(combo: str, duration: float):
    panic.check()
    keys = [normalize_key(k) for k in combo.split("+")]
    for k in keys:
        pyautogui.keyDown(k)
    time.sleep(duration)
    for k in reversed(keys):
        pyautogui.keyUp(k)


def type_text(text: str):
    panic.check()
    # Paste instead of per-char typing: handles accents/emoji and is instant,
    # which matters when every agent step is already 2-4s.
    subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=True)
    pyautogui.hotkey("command", "v")
    time.sleep(0.2)


def move(x, y):
    panic.check()
    pyautogui.moveTo(x, y)


def click(x, y, button="left", clicks=1, modifier=None):
    panic.check()
    pyautogui.moveTo(x, y)
    mod = normalize_key(modifier) if modifier else None
    if mod:
        pyautogui.keyDown(mod)
    try:
        pyautogui.click(x, y, clicks=clicks, interval=0.1, button=button)
    finally:
        if mod:
            pyautogui.keyUp(mod)


def mouse_down(x, y):
    panic.check()
    pyautogui.moveTo(x, y)
    pyautogui.mouseDown()


def mouse_up(x, y):
    panic.check()
    pyautogui.mouseUp(x, y)


def drag(x1, y1, x2, y2):
    panic.check()
    pyautogui.moveTo(x1, y1)
    pyautogui.dragTo(x2, y2, duration=0.5, button="left")


def scroll(x, y, direction: str, amount: int, modifier=None):
    panic.check()
    pyautogui.moveTo(x, y)
    mod = normalize_key(modifier) if modifier else None
    if mod:
        pyautogui.keyDown(mod)
    try:
        # macOS scroll units are tiny; multiply the model's "clicks" up.
        ticks = amount * 5
        if direction == "up":
            pyautogui.scroll(ticks)
        elif direction == "down":
            pyautogui.scroll(-ticks)
        elif direction == "left":
            pyautogui.hscroll(ticks)
        elif direction == "right":
            pyautogui.hscroll(-ticks)
    finally:
        if mod:
            pyautogui.keyUp(mod)


def cursor_position():
    p = pyautogui.position()
    return p.x, p.y
