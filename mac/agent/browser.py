"""The cloud agent's computer: a headless Chromium driven through Playwright.

Same computer-use action vocabulary as DesktopComputer, executed against a
browser page instead of the Mac - which is what lets a cloud task run IN
PARALLEL with a local one (the Mac only has one pair of hands; the browser
has its own). The viewport equals the model resolution, so no coordinate
scaling at all.

Playwright's sync API is thread-bound: construct and use a BrowserComputer
inside one worker thread (the gateway runs the whole cloud run_task in a
single executor thread).

Setup once: pip install playwright && playwright install chromium
"""

import base64
import io
import time

W, H = 1280, 800
SETTLE_S = 0.4

_KEY_MAP = {
    "return": "Enter",
    "kp_enter": "Enter",
    "enter": "Enter",
    "tab": "Tab",
    "space": "Space",
    "backspace": "Backspace",
    "back_space": "Backspace",
    "delete": "Delete",
    "escape": "Escape",
    "esc": "Escape",
    "up": "ArrowUp",
    "down": "ArrowDown",
    "left": "ArrowLeft",
    "right": "ArrowRight",
    "page_down": "PageDown",
    "page_up": "PageUp",
    "home": "Home",
    "end": "End",
    "ctrl": "Control",
    "control": "Control",
    "alt": "Alt",
    "option": "Alt",
    "shift": "Shift",
    "super": "Meta",
    "cmd": "Meta",
    "meta": "Meta",
}


def _key(name: str) -> str:
    k = name.strip()
    return _KEY_MAP.get(k.lower(), k.upper() if len(k) == 1 and k.isalpha() else k)


def _combo(combo: str) -> str:
    return "+".join(_key(p) for p in combo.split("+"))


class BrowserComputer:
    def __init__(self, start_url: str = "https://www.google.com"):
        from playwright.sync_api import sync_playwright

        self._pl = sync_playwright().start()
        self._browser = self._pl.chromium.launch(headless=True)
        self._page = self._browser.new_page(viewport={"width": W, "height": H})
        self._page.goto(start_url, wait_until="domcontentloaded")
        self.last_jpeg = None  # gateway streamer polls this cross-thread

    @property
    def model_size(self):
        return W, H

    def _jpeg(self, quality: int = 70) -> bytes:
        jpeg = self._page.screenshot(type="jpeg", quality=quality)
        self.last_jpeg = jpeg
        return jpeg

    def _screenshot_block(self) -> dict:
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": base64.standard_b64encode(self._jpeg()).decode(),
            },
        }

    def execute(self, action: dict) -> list:
        kind = action["action"]
        page = self._page
        mouse = page.mouse

        if kind == "screenshot":
            return [self._screenshot_block()]
        if kind == "zoom":
            from PIL import Image

            x1, y1, x2, y2 = action["region"]
            img = Image.open(io.BytesIO(self._jpeg(quality=90)))
            crop = img.crop((max(0, x1), max(0, y1), min(img.width, x2), min(img.height, y2)))
            buf = io.BytesIO()
            crop.save(buf, format="JPEG", quality=85)
            return [{
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": base64.standard_b64encode(buf.getvalue()).decode(),
                },
            }]
        if kind == "cursor_position":
            return [{"type": "text", "text": "Cursor position is not tracked in the browser."}]
        if kind == "wait":
            time.sleep(min(float(action.get("duration", 1)), 5.0))
        elif kind == "key":
            page.keyboard.press(_combo(action["text"]))
        elif kind == "hold_key":
            page.keyboard.down(_key(action["text"]))
            time.sleep(float(action.get("duration", 1)))
            page.keyboard.up(_key(action["text"]))
        elif kind == "type":
            page.keyboard.insert_text(action["text"])
        elif kind == "mouse_move":
            mouse.move(*action["coordinate"])
        elif kind in ("left_click", "right_click", "middle_click", "double_click", "triple_click"):
            x, y = action["coordinate"]
            button = {"right_click": "right", "middle_click": "middle"}.get(kind, "left")
            clicks = {"double_click": 2, "triple_click": 3}.get(kind, 1)
            modifier = action.get("text")
            if modifier:
                page.keyboard.down(_key(modifier))
            try:
                mouse.click(x, y, button=button, click_count=clicks)
            finally:
                if modifier:
                    page.keyboard.up(_key(modifier))
        elif kind == "left_mouse_down":
            mouse.move(*action["coordinate"])
            mouse.down()
        elif kind == "left_mouse_up":
            mouse.move(*action["coordinate"])
            mouse.up()
        elif kind == "left_click_drag":
            x1, y1 = action["start_coordinate"]
            x2, y2 = action["coordinate"]
            mouse.move(x1, y1)
            mouse.down()
            mouse.move(x2, y2, steps=12)
            mouse.up()
        elif kind == "scroll":
            x, y = action["coordinate"]
            amount = int(action.get("scroll_amount", 3)) * 120
            direction = action["scroll_direction"]
            mouse.move(x, y)
            dx, dy = {
                "down": (0, amount), "up": (0, -amount),
                "right": (amount, 0), "left": (-amount, 0),
            }[direction]
            mouse.wheel(dx, dy)
        else:
            return [{"type": "text", "text": f"Unsupported action: {kind}"}]

        time.sleep(SETTLE_S)
        return [self._screenshot_block()]

    def close(self):
        for closer in (self._browser.close, self._pl.stop):
            try:
                closer()
            except Exception:
                pass


CLOUD_SYSTEM = """You are the cloud agent of VoiceOS, operating a headless \
web browser for a live user while a separate local agent works on their Mac. \
You see the page through screenshots and act with mouse and keyboard.

Operating rules:
- ALWAYS take a screenshot first to see the current page.
- Navigate by clicking links and using page search boxes. There is no \
address bar in your screenshots; to go to a URL, you must use links or a \
search engine.
- After typing into a field, verify it landed before pressing Enter.
- If small text is unreadable, use the zoom action on that region.
- Keep going until done or genuinely impossible; never fabricate results.

Narration (spoken aloud): before each meaningful step, ONE short \
present-tense line ("Searching for flights...", "Opening the results..."). \
No markdown, no jargon. End with a one-line summary of what you found.
"""
