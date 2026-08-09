"""The eyes: main-display capture, model-resolution downscale, coordinate
mapping between model space and macOS logical (points) space, and zoom.

Uses /usr/sbin/screencapture (needs Screen Recording permission). Captures are
in physical pixels (2x on retina); mouse events are in points, so there are
two coordinate spaces to convert between:

  model space  --(scale up)-->  points (clicks)  --(x retina factor)-->  pixels (crops)
"""

import base64
import io
import subprocess
import tempfile
from functools import lru_cache

import pyautogui
from PIL import Image

from . import config


@lru_cache(maxsize=1)
def geometry():
    """(logical_w, logical_h, model_w, model_h) for the main display."""
    logical_w, logical_h = pyautogui.size()
    scale = min(config.MODEL_MAX_W / logical_w, config.MODEL_MAX_H / logical_h, 1.0)
    return logical_w, logical_h, round(logical_w * scale), round(logical_h * scale)


def model_size():
    _, _, mw, mh = geometry()
    return mw, mh


def to_points(x, y):
    """Model-space coordinate -> logical screen points."""
    lw, lh, mw, mh = geometry()
    return round(x * lw / mw), round(y * lh / mh)


def capture_raw() -> Image.Image:
    with tempfile.NamedTemporaryFile(suffix=".png") as f:
        subprocess.run(
            ["/usr/sbin/screencapture", "-x", "-m", f.name],
            check=True,
            capture_output=True,
        )
        img = Image.open(f.name)
        img.load()
    return img


def _encode(img: Image.Image) -> dict:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=config.JPEG_QUALITY)
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": base64.standard_b64encode(buf.getvalue()).decode(),
        },
    }


def screenshot_block() -> dict:
    """Full screen, downscaled to model resolution, as an API image block."""
    img = capture_raw()
    _, _, mw, mh = geometry()
    return _encode(img.resize((mw, mh), Image.LANCZOS))


def screenshot_jpeg(quality: int = None) -> tuple:
    """Full screen as raw JPEG bytes for the live stream. -> (bytes, w, h)"""
    img = capture_raw()
    _, _, mw, mh = geometry()
    buf = io.BytesIO()
    img.resize((mw, mh), Image.LANCZOS).convert("RGB").save(
        buf, format="JPEG", quality=quality or config.STREAM_JPEG_QUALITY
    )
    return buf.getvalue(), mw, mh


def zoom_block(region) -> dict:
    """Crop of the native-resolution capture for a model-space region."""
    x1, y1, x2, y2 = region
    img = capture_raw()
    _, _, mw, mh = geometry()
    px = img.width / mw
    py = img.height / mh
    crop = img.crop((
        max(0, round(x1 * px)),
        max(0, round(y1 * py)),
        min(img.width, round(x2 * px)),
        min(img.height, round(y2 * py)),
    ))
    # Keep the zoom payload reasonable; native retina crops can be huge.
    if crop.width > 1568:
        crop = crop.resize((1568, round(crop.height * 1568 / crop.width)), Image.LANCZOS)
    return _encode(crop)
