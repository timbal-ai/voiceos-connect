"""Streaming STT: Deepgram Nova-3 over a raw websocket, one per PTT utterance.

Ported from timbal's production `DeepgramNovaSTT` (timbal/python/timbal/voice/
deepgram.py) — same wire recipe, minus the parts a PTT flow doesn't need:

- mic PCM buffered to ~80ms frames before sending (Deepgram's recommended
  cadence; tiny frames hurt latency, timer-only flushing feels commit-gated)
- KeepAlive every 5s: Nova drops the socket with NET-0001 after ~10s without
  audio, which a silent PTT hold would otherwise trigger
- `is_final` segments buffered; joined into the utterance on finish()
- finish() = flush + Finalize (Deepgram force-commits and answers with a
  `from_finalize` result) + CloseStream
"""

import asyncio
import contextlib
import json
import os
from urllib.parse import urlencode

from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

_HOST = "api.deepgram.com"
MODEL = os.getenv("VOICEOS_STT_MODEL", "nova-3")

_FLUSH_INTERVAL = 0.08
_FLUSH_BYTES = int(16_000 * _FLUSH_INTERVAL * 2)  # 80ms of 16 kHz s16le mono
_KEEPALIVE_INTERVAL = 5.0


class UtteranceSession:
    """Feed PCM in, get partial callbacks, call finish() for the final text."""

    def __init__(self, on_partial):
        self._on_partial = on_partial
        self._segments: list[str] = []
        self._pending = ""
        self._buf = bytearray()
        # One lock covers buffer mutation and ws.send so audio frames can't
        # interleave out of order (same rationale as the timbal original).
        self._wire_lock = asyncio.Lock()
        self._closed = asyncio.Event()
        self._ws = None
        self._tasks: list[asyncio.Task] = []

    async def start(self):
        params = {
            "model": MODEL,
            "encoding": "linear16",
            "sample_rate": "16000",
            "channels": "1",
            "interim_results": "true",
            "smart_format": "true",
            "punctuate": "true",
            "endpointing": "300",
        }
        self._ws = await ws_connect(
            f"wss://{_HOST}/v1/listen?{urlencode(params)}",
            additional_headers={"Authorization": f"Token {os.environ['DEEPGRAM_API_KEY']}"},
        )
        self._tasks = [
            asyncio.create_task(self._receive_loop()),
            asyncio.create_task(self._keepalive_loop()),
        ]

    @property
    def text(self) -> str:
        parts = self._segments + ([self._pending] if self._pending else [])
        return " ".join(parts).strip()

    async def feed(self, chunk: bytes):
        if not chunk:
            return
        async with self._wire_lock:
            self._buf.extend(chunk)
            if len(self._buf) < _FLUSH_BYTES or self._ws is None:
                return
            raw = bytes(self._buf)
            self._buf.clear()
            with contextlib.suppress(ConnectionClosed):
                await self._ws.send(raw)

    async def _flush_audio(self):
        async with self._wire_lock:
            raw = bytes(self._buf)
            self._buf.clear()
            if raw and self._ws is not None:
                with contextlib.suppress(ConnectionClosed):
                    await self._ws.send(raw)

    async def _send_json(self, payload: dict):
        async with self._wire_lock:
            if self._ws is not None:
                with contextlib.suppress(Exception):
                    await self._ws.send(json.dumps(payload))

    async def _keepalive_loop(self):
        while True:
            await asyncio.sleep(_KEEPALIVE_INTERVAL)
            await self._send_json({"type": "KeepAlive"})

    async def _receive_loop(self):
        try:
            async for raw in self._ws:
                if isinstance(raw, bytes):
                    continue
                msg = json.loads(raw)
                if msg.get("type") != "Results":
                    continue
                alternatives = (msg.get("channel") or {}).get("alternatives") or [{}]
                text = (alternatives[0].get("transcript") or "").strip()
                if not msg.get("is_final"):
                    if text:
                        self._pending = text
                        self._on_partial(self.text)
                    continue
                self._pending = ""
                if text:
                    self._segments.append(text)
                    self._on_partial(self.text)
        except ConnectionClosed:
            pass
        finally:
            self._closed.set()

    async def finish(self) -> str:
        """Force-commit whatever Deepgram is holding and return the utterance.

        Finalize + CloseStream, then wait for Deepgram to close the socket:
        it keeps sending final Results while draining, and tearing down on
        the first from_finalize loses the tail of the utterance.
        """
        try:
            await self._flush_audio()
            await self._send_json({"type": "Finalize"})
            await self._send_json({"type": "CloseStream"})
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._closed.wait(), timeout=3.0)
        finally:
            for t in self._tasks:
                t.cancel()
            if self._ws is not None:
                with contextlib.suppress(Exception):
                    await self._ws.close()
                self._ws = None
        return self.text
