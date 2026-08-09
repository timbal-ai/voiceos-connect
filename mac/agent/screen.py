"""The eyes: main-display capture, model-resolution downscale, coordinate
mapping between model space and macOS logical (points) space, and zoom.

A Viewport optionally crops everything to a region of the display in points —
phone mode uses this to show Claude only the iPhone Mirroring window, which
makes clicks dramatically more accurate.

Uses /usr/sbin/screencapture (needs Screen Recording permission). Captures are
in physical pixels (2x on retina); mouse events are in points, so there are
two coordinate spaces to convert between:

  model space  --(scale up)-->  points (clicks)  --(x retina factor)-->  pixels (crops)
"""

import base64
import io
import subprocess
import tempfile

import pyautogui
from PIL import Image

from . import config


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


class Viewport:
    """Maps between model space and screen points for a display region.

    region: (x, y, w, h) in display points, or None for the full display.
    """

    def __init__(self, region=None):
        logical_w, logical_h = pyautogui.size()
        self.logical = (logical_w, logical_h)
        self.ox, self.oy = 0.0, 0.0
        w, h = float(logical_w), float(logical_h)
        if region is not None:
            self.ox, self.oy, w, h = (float(v) for v in region)
        scale = min(config.MODEL_MAX_W / w, config.MODEL_MAX_H / h, 1.0)
        self.w, self.h = w, h
        self.model_w, self.model_h = round(w * scale), round(h * scale)

    @property
    def is_full_screen(self) -> bool:
        return (self.ox, self.oy) == (0.0, 0.0) and (self.w, self.h) == (
            float(self.logical[0]), float(self.logical[1]))

    def to_points(self, x, y):
        """Model-space coordinate -> absolute logical screen points."""
        return (
            round(self.ox + x * self.w / self.model_w),
            round(self.oy + y * self.h / self.model_h),
        )

    def _crop_native(self, img: Image.Image) -> Image.Image:
        if self.is_full_screen:
            return img
        px = img.width / self.logical[0]
        py = img.height / self.logical[1]
        return img.crop((
            max(0, round(self.ox * px)),
            max(0, round(self.oy * py)),
            min(img.width, round((self.ox + self.w) * px)),
            min(img.height, round((self.oy + self.h) * py)),
        ))

    def screenshot_block(self) -> dict:
        """Viewport contents at model resolution, as an API image block."""
        img = self._crop_native(capture_raw())
        return _encode(img.resize((self.model_w, self.model_h), Image.LANCZOS))

    def screenshot_jpeg(self, quality: int = None) -> tuple:
        """Viewport contents as raw JPEG bytes for the live stream. -> (bytes, w, h)"""
        img = self._crop_native(capture_raw())
        buf = io.BytesIO()
        img.resize((self.model_w, self.model_h), Image.LANCZOS).convert("RGB").save(
            buf, format="JPEG", quality=quality or config.STREAM_JPEG_QUALITY
        )
        return buf.getvalue(), self.model_w, self.model_h

    def zoom_block(self, region) -> dict:
        """Native-resolution crop for a model-space region within the viewport."""
        x1, y1, x2, y2 = region
        img = self._crop_native(capture_raw())
        px = img.width / self.model_w
        py = img.height / self.model_h
        crop = img.crop((
            max(0, round(x1 * px)),
            max(0, round(y1 * py)),
            min(img.width, round(x2 * px)),
            min(img.height, round(y2 * py)),
        ))
        if crop.width > 1568:
            crop = crop.resize((1568, round(crop.height * 1568 / crop.width)), Image.LANCZOS)
        return _encode(crop)


_default_viewport = None


def default_viewport() -> Viewport:
    global _default_viewport
    if _default_viewport is None:
        _default_viewport = Viewport()
    return _default_viewport


# -- module-level conveniences (full-screen viewport) ------------------------

def model_size():
    vp = default_viewport()
    return vp.model_w, vp.model_h


def screenshot_jpeg(quality: int = None, region=None) -> tuple:
    vp = Viewport(region) if region is not None else default_viewport()
    return vp.screenshot_jpeg(quality)
