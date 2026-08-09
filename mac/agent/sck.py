"""ScreenCaptureKit streamer: spawns the Swift helper (compiled on first use)
and yields (jpeg, w, h) frames at 10-15 fps — the milestone-3 upgrade over
the ~4 fps screencapture loop. The gateway falls back to screencapture if
swiftc or the capture permission is missing.

Helper stdout protocol: uint32 BE jpeg length, uint32 BE width, uint32 BE
height, then the JPEG bytes (see sck_streamer.swift).
"""

import asyncio
import struct
import subprocess
from pathlib import Path

_MAC_DIR = Path(__file__).resolve().parent.parent
_SOURCE = _MAC_DIR / "sck_streamer.swift"
_BINARY = _MAC_DIR / ".build" / "sck_streamer"


def _ensure_built() -> Path:
    if _BINARY.exists() and _BINARY.stat().st_mtime >= _SOURCE.stat().st_mtime:
        return _BINARY
    _BINARY.parent.mkdir(exist_ok=True)
    result = subprocess.run(
        ["swiftc", "-O", "-o", str(_BINARY), str(_SOURCE)],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"swiftc failed: {result.stderr.strip()[:400]}")
    return _BINARY


class SCKStream:
    def __init__(self, fps: int = 12, width: int = 1183, rect=None):
        self._args = ["--fps", str(fps), "--width", str(width)]
        if rect is not None:  # (x, y, w, h) in display points; phone mode crop
            self._args += ["--rect", ",".join(str(v) for v in rect)]
        self._proc = None

    async def start(self):
        binary = await asyncio.get_running_loop().run_in_executor(None, _ensure_built)
        self._proc = await asyncio.create_subprocess_exec(
            str(binary), *self._args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        # Fail fast if capture can't start (no permission, no display): the
        # helper exits immediately, before its first frame.
        try:
            header = await asyncio.wait_for(self._proc.stdout.readexactly(12), timeout=5.0)
        except (asyncio.IncompleteReadError, asyncio.TimeoutError):
            stderr = (await self._proc.stderr.read(400)).decode(errors="replace")
            await self.stop()
            raise RuntimeError(f"sck_streamer failed to start: {stderr.strip()}")
        self._first_header = header

    async def frames(self):
        header = self._first_header
        while True:
            length, w, h = struct.unpack(">III", header)
            jpeg = await self._proc.stdout.readexactly(length)
            yield jpeg, w, h
            header = await self._proc.stdout.readexactly(12)

    async def stop(self):
        if self._proc is not None and self._proc.returncode is None:
            self._proc.kill()
            await self._proc.wait()
        self._proc = None
