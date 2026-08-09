"""ElevenLabs TTS over the multi-context websocket, 16 kHz mono s16le PCM out.

Ported from timbal's production `ElevenLabsStreamTTS` (timbal/python/timbal/
voice/elevenlabs.py). The lessons inherited from there:

- ONE persistent connection per gateway session; per-request HTTP pays a
  ~0.5-1s TCP+TLS+WS handshake per narration line, which is dead air on stage.
- Each say line is an independent *context*; `close_context` must be sent
  right after `flush` or `is_final` never arrives and the reader deadlocks.
- A space ping every 55s resets stream-input's inactivity timeout.
- Aborting a context (barge-in) = unroute its queue first, then close_context,
  so in-flight audio for it is dropped.

pcm_16000 matches the mic path, so iPhone A plays narration through the same
AVAudioEngine it records with. eleven_flash_v2_5 is the ~75ms-latency model.
"""

import asyncio
import base64
import contextlib
import json
import os
from urllib.parse import quote, urlencode

import httpx
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

_HOST = "api.elevenlabs.io"
MODEL_ID = os.getenv("VOICEOS_TTS_MODEL", "eleven_flash_v2_5")

# "Rachel", an ElevenLabs default voice — used when the app never picked one.
DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"

SAMPLE_RATE = 16000
CODEC = "pcm_s16le"

_KEEPALIVE_INTERVAL = 55.0
_INACTIVITY_TIMEOUT = 180


def enabled() -> bool:
    return bool(os.environ.get("ELEVENLABS_API_KEY"))


async def list_voices(client: httpx.AsyncClient, limit: int = 6) -> list:
    """Curated voice list for the onboarding picker. preview_url is a plain
    https mp3 the iOS app can play directly."""
    response = await client.get(
        f"https://{_HOST}/v1/voices",
        headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]},
        timeout=15.0,
    )
    response.raise_for_status()
    return [
        {"id": v["voice_id"], "name": v["name"], "preview_url": v.get("preview_url")}
        for v in response.json()["voices"][:limit]
    ]


class Narrator:
    """Persistent multi-context TTS connection for one gateway session."""

    def __init__(self, voice_id: str = None):
        self._voice_id = voice_id or DEFAULT_VOICE
        self._ws = None
        self._ws_voice = None  # voice the open socket was dialed with
        self._queues: dict[str, asyncio.Queue] = {}
        self._ctx_counter = 0
        self._tasks: list[asyncio.Task] = []
        self._lock = asyncio.Lock()

    def set_voice(self, voice_id: str):
        # voice_id lives in the connection URL; the next synthesize reconnects.
        self._voice_id = voice_id or DEFAULT_VOICE

    async def _ensure_ws(self):
        async with self._lock:
            if self._ws is not None and self._ws_voice == self._voice_id:
                return
            await self._teardown()
            params = {
                "model_id": MODEL_ID,
                "output_format": "pcm_16000",
                "auto_mode": "true",
                "inactivity_timeout": _INACTIVITY_TIMEOUT,
            }
            uri = (f"wss://{_HOST}/v1/text-to-speech/"
                   f"{quote(self._voice_id, safe='')}/multi-stream-input?{urlencode(params)}")
            self._ws = await ws_connect(
                uri, additional_headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]}
            )
            self._ws_voice = self._voice_id
            self._tasks = [
                asyncio.create_task(self._read_loop()),
                asyncio.create_task(self._keepalive_loop()),
            ]

    async def _read_loop(self):
        try:
            async for raw in self._ws:
                msg = json.loads(raw)
                ctx = msg.get("contextId")
                if ctx and ctx in self._queues:
                    await self._queues[ctx].put(msg)
        except (ConnectionClosed, Exception):
            pass
        finally:
            for q in list(self._queues.values()):
                q.put_nowait(None)
            self._ws = None

    async def _keepalive_loop(self):
        while True:
            await asyncio.sleep(_KEEPALIVE_INTERVAL)
            if self._ws is None:
                return
            with contextlib.suppress(Exception):
                await self._ws.send(json.dumps({"context_id": "_ka", "text": ""}))

    async def synthesize(self, text: str):
        """Yield PCM chunks for one narration line. Breaking out of the
        iteration (barge-in) aborts the context server-side."""
        text = text.strip()
        if not text:
            return
        await self._ensure_ws()

        self._ctx_counter += 1
        ctx = f"ctx_{self._ctx_counter}"
        queue: asyncio.Queue = asyncio.Queue()
        self._queues[ctx] = queue
        finished = False
        try:
            await self._ws.send(json.dumps({"text": text + " ", "context_id": ctx, "flush": True}))
            await self._ws.send(json.dumps({"context_id": ctx, "close_context": True}))
            while True:
                msg = await queue.get()
                if msg is None:
                    return
                if msg.get("error"):
                    raise RuntimeError(f"ElevenLabs TTS error: {msg['error']}")
                if msg.get("audio"):
                    yield base64.b64decode(msg["audio"])
                if msg.get("is_final") or msg.get("isFinal"):
                    finished = True
                    return
        finally:
            self._queues.pop(ctx, None)
            if not finished and self._ws is not None:
                # consumer bailed early (barge-in): drop the context
                with contextlib.suppress(Exception):
                    await self._ws.send(json.dumps({"context_id": ctx, "close_context": True}))

    async def _teardown(self):
        for t in self._tasks:
            t.cancel()
        self._tasks = []
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
            self._ws = None
        for q in list(self._queues.values()):
            q.put_nowait(None)
        self._queues.clear()

    async def close(self):
        async with self._lock:
            await self._teardown()
