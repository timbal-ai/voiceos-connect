"""Streaming STT: one Deepgram websocket per PTT utterance.

Per-utterance connections cost ~300ms at speech start but avoid keep-alive
lifecycle bugs, which matter more on stage. The gateway opens an
UtteranceSession on the first audio chunk and finishes it on `audio_end`
(or silence timeout).
"""

import asyncio

from deepgram import AsyncDeepgramClient
from deepgram.core.events import EventType


class UtteranceSession:
    """Feed PCM in, get partial callbacks, call finish() for the final text."""

    def __init__(self, client: AsyncDeepgramClient, on_partial):
        self._client = client
        self._on_partial = on_partial
        self._segments: list[str] = []
        self._pending = ""
        self._done = asyncio.Event()
        self._ctx = None
        self._conn = None
        self._listener = None

    async def start(self):
        self._ctx = self._client.listen.v1.connect(
            model="nova-3",
            encoding="linear16",
            sample_rate="16000",
            channels="1",
            smart_format="true",
            interim_results="true",
            endpointing="300",
        )
        self._conn = await self._ctx.__aenter__()
        self._conn.on(EventType.MESSAGE, self._on_message)
        self._conn.on(EventType.CLOSE, lambda _: self._done.set())
        self._listener = asyncio.create_task(self._conn.start_listening())

    def _on_message(self, message):
        channel = getattr(message, "channel", None)
        if channel is None or not channel.alternatives:
            return
        text = channel.alternatives[0].transcript
        if not text:
            return
        if getattr(message, "is_final", False):
            self._segments.append(text)
            self._pending = ""
        else:
            self._pending = text
        self._on_partial(self.text)

    @property
    def text(self) -> str:
        parts = self._segments + ([self._pending] if self._pending else [])
        return " ".join(parts).strip()

    async def feed(self, chunk: bytes):
        await self._conn.send_media(chunk)

    async def finish(self) -> str:
        """Flush Deepgram and return the full utterance text."""
        try:
            await self._conn.send_finalize()
            await self._conn.send_close_stream()
            await asyncio.wait_for(self._done.wait(), timeout=3.0)
        except Exception:
            pass  # a lost close handshake shouldn't eat the transcript
        finally:
            if self._listener:
                self._listener.cancel()
            try:
                await self._ctx.__aexit__(None, None, None)
            except Exception:
                pass
        return self.text
