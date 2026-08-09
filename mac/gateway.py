"""Milestone 2: the WebSocket gateway iPhone A connects to.

    python gateway.py          real mode: Deepgram STT -> Claude agent loop
    python gateway.py --mock   mock mode for iOS dev: canned transcripts,
                               scripted status/say frames, synthetic video —
                               no API keys or macOS permissions needed

Pairing: prints a QR of ws://<lan-ip>:<port>/<token>. The token persists in
.voiceos_token so reconnects survive gateway restarts. One session at a time;
a new connection evicts the old one.

Flow per utterance: binary audio chunks stream to Deepgram (partial
transcripts forwarded live), `audio_end` (or 2s of silence) finalizes, and
the final text becomes an agent task. While a task runs, screenshots stream
as video frames and narration goes out as `say` frames (TTS in milestone 5).
A final transcript arriving mid-task cancels the task and starts the new one
(barge-in). `interrupt` just cancels.
"""

import argparse
import asyncio
import io
import json
import secrets
import socket
import threading
import time
from pathlib import Path

import qrcode
import websockets

from agent import config, protocol

TOKEN_FILE = Path(__file__).parent / ".voiceos_token"
SILENCE_FINALIZE_S = 2.0


def get_token() -> str:
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text().strip()
    token = secrets.token_urlsafe(12)
    TOKEN_FILE.write_text(token)
    return token


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


class Session:
    def __init__(self, ws, mock: bool):
        self.ws = ws
        self.mock = mock
        self.loop = asyncio.get_running_loop()
        self.outbox: asyncio.Queue = asyncio.Queue()
        self.utterance = None
        self.last_audio_at = 0.0
        self.cancel_event = threading.Event()
        self.task_running = False
        self.step = 0
        self.seq = 0
        self.voice_id = None
        self.narrator = None  # agent.tts.Narrator, real mode with a key only
        self.say_seq = 0
        self.tts_queue: asyncio.Queue = asyncio.Queue()
        self.tts_gen = 0  # bumped on barge-in; stale queue items are skipped
        self.http = None  # httpx.AsyncClient, real mode only

    # -- thread-safe emitters (agent loop runs in a worker thread) ----------

    def emit(self, type_: str, **fields):
        self.loop.call_soon_threadsafe(
            self.outbox.put_nowait, protocol.control(type_, **fields)
        )

    def emit_video(self, jpeg: bytes, w: int, h: int, source: str = "mac"):
        self.seq += 1
        frame = protocol.encode_binary(
            protocol.BIN_VIDEO, {"source": source, "w": w, "h": h, "seq": self.seq}, jpeg
        )
        self.loop.call_soon_threadsafe(self.outbox.put_nowait, frame)

    async def sender(self):
        while True:
            await self.ws.send(await self.outbox.get())

    # -- narration + TTS -----------------------------------------------------

    def speak(self, text: str):
        """Emit a say frame and queue its TTS audio. Thread-safe."""
        self.say_seq += 1
        self.emit("say", text=text, id=self.say_seq)
        self.loop.call_soon_threadsafe(
            self.tts_queue.put_nowait, (self.tts_gen, self.say_seq, text)
        )

    def barge_in(self):
        """User started talking: drop all queued/streaming TTS."""
        self.tts_gen += 1
        while not self.tts_queue.empty():
            self.tts_queue.get_nowait()

    async def tts_worker(self):
        from agent import tts

        while True:
            gen, say_id, text = await self.tts_queue.get()
            if gen != self.tts_gen:
                continue
            header = {"codec": tts.CODEC, "rate": tts.SAMPLE_RATE, "say_id": say_id}
            try:
                if self.mock:
                    self.loop.call_soon_threadsafe(
                        self.outbox.put_nowait,
                        protocol.encode_binary(protocol.BIN_TTS, header, _mock_tone(say_id)),
                    )
                elif tts.enabled():
                    if self.narrator is None:
                        self.narrator = tts.Narrator(self.voice_id)
                    async for chunk in self.narrator.synthesize(text):
                        if gen != self.tts_gen:
                            break  # barge-in: generator finally aborts the context
                        self.loop.call_soon_threadsafe(
                            self.outbox.put_nowait,
                            protocol.encode_binary(protocol.BIN_TTS, header, chunk),
                        )
            except Exception as e:
                print(f"tts failed ({e}); say text was already sent")
            finally:
                self.loop.call_soon_threadsafe(
                    self.outbox.put_nowait,
                    protocol.encode_binary(protocol.BIN_TTS, {**header, "done": True}, b""),
                )

    # -- audio -> STT --------------------------------------------------------

    async def on_audio(self, pcm: bytes):
        self.last_audio_at = time.monotonic()
        if self.utterance is None:
            self.barge_in()  # user speaking over narration: kill playback
        if self.mock:
            if self.utterance is None:
                self.utterance = "mock"
                self.emit("transcript", text="(mock) listening...", final=False)
            return
        if self.utterance is None:
            from agent.stt import UtteranceSession

            self.utterance = UtteranceSession(
                on_partial=lambda t: self.emit("transcript", text=t, final=False),
            )
            await self.utterance.start()
        await self.utterance.feed(pcm)

    async def on_audio_end(self):
        utt, self.utterance = self.utterance, None
        if utt is None:
            return
        if self.mock:
            text = "open safari and search for anthropic"
        else:
            text = await utt.finish()
        if not text:
            self.speak("I didn't catch that.")
            return
        self.emit("transcript", text=text, final=True)
        self.start_task(text)

    async def silence_watchdog(self):
        """Finalize an utterance if the client never sends audio_end."""
        while True:
            await asyncio.sleep(0.5)
            if self.utterance is not None and time.monotonic() - self.last_audio_at > SILENCE_FINALIZE_S:
                await self.on_audio_end()

    # -- agent task ----------------------------------------------------------

    def start_task(self, text: str):
        if self.task_running:
            self.cancel_event.set()  # barge-in: newest command wins
        asyncio.create_task(self._run_task(text))

    async def _run_task(self, text: str):
        while self.task_running:  # wait for a cancelled predecessor to exit
            await asyncio.sleep(0.1)
        self.task_running = True
        self.cancel_event = threading.Event()
        self.step = 0
        self.emit("status", state="running", step=0, task=text)
        streamer = asyncio.create_task(self._stream_screens())
        try:
            if self.mock:
                result = await self._mock_task()
            else:
                from agent import loop as agent_loop

                cancel = self.cancel_event
                result = await self.loop.run_in_executor(
                    None,
                    lambda: agent_loop.run_task(
                        text,
                        on_narration=self.speak,
                        on_action=self._on_action,
                        cancel_event=cancel,
                    ),
                )
            self.speak(result)
        except Exception as e:
            from agent.loop import TaskCancelled

            if isinstance(e, TaskCancelled):
                self.speak("Okay, stopping.")
            else:
                self.speak(f"Something went wrong: {e}")
        finally:
            self.task_running = False
            streamer.cancel()
            self.emit("status", state="idle", step=self.step)

    def _on_action(self, action: dict):
        self.step += 1
        self.emit("status", state="running", step=self.step, action=action.get("action"))

    async def _stream_screens(self):
        from agent import screen

        while True:
            try:
                if self.mock:
                    jpeg, w, h = _mock_frame(self.seq)
                else:
                    jpeg, w, h = await self.loop.run_in_executor(None, screen.screenshot_jpeg)
                self.emit_video(jpeg, w, h)
            except Exception:
                pass  # no Screen Recording permission: stream nothing, task still runs
            await asyncio.sleep(config.STREAM_INTERVAL_S)

    async def _mock_task(self) -> str:
        script = [
            "Opening Safari...",
            "Typing the search into the address bar...",
            "Here are the results, opening the first one...",
        ]
        for line in script:
            if self.cancel_event.is_set():
                return "Okay, stopping."
            self.speak(line)
            self._on_action({"action": "left_click"})
            await asyncio.sleep(1.5)
        return "Done - Safari is showing the Anthropic homepage."


def _mock_tone(say_id: int) -> bytes:
    """0.35s sine beep (pitch varies per line) so iOS can test the TTS audio
    path without an ElevenLabs key. 16 kHz mono s16le, same as real TTS."""
    import array
    import math

    rate, dur, freq = 16000, 0.35, 380 + (say_id % 5) * 60
    n = int(rate * dur)
    samples = array.array("h", (
        int(8000 * math.sin(2 * math.pi * freq * i / rate) * min(1, (n - i) / 800))
        for i in range(n)
    ))
    return samples.tobytes()


def _mock_frame(seq: int):
    from PIL import Image, ImageDraw

    w, h = 640, 416
    img = Image.new("RGB", (w, h), (18, 18, 24))
    d = ImageDraw.Draw(img)
    x = (seq * 12) % w
    d.rectangle([x, h // 2 - 20, x + 60, h // 2 + 20], fill=(90, 140, 255))
    d.text((16, 16), f"voiceos-connect mock stream  #{seq}", fill=(230, 230, 230))
    d.text((16, h - 28), time.strftime("%H:%M:%S"), fill=(160, 160, 160))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=60)
    return buf.getvalue(), w, h


async def handle(ws, token: str, mock: bool, active: dict):
    if ws.request.path.strip("/") != token:
        await ws.close(4401, "bad token")
        return
    try:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
    except Exception:
        await ws.close(4400, "expected hello")
        return
    if hello.get("type") != "hello" or hello.get("token") != token:
        await ws.close(4401, "bad hello")
        return

    if active.get("ws") is not None:  # one session at a time
        await active["ws"].close(4409, "replaced by new session")
    active["ws"] = ws

    session = Session(ws, mock)
    session.voice_id = hello.get("voice_id")
    print(f"● paired: {hello.get('device', 'unknown device')}"
          f" (voice_id={session.voice_id or '-'}){' [mock]' if mock else ''}")
    from agent import screen, tts

    tasks = []
    try:
        mw, mh = (640, 416) if mock else screen.model_size()
        await ws.send(protocol.control("ready", server="voiceos-connect", screen={"w": mw, "h": mh}))

        if mock:
            voices = [{"id": f"mock-voice-{i}", "name": n, "preview_url": None}
                      for i, n in enumerate(["Nova", "Atlas", "Luna"], 1)]
        elif tts.enabled():
            import httpx

            session.http = httpx.AsyncClient()
            try:
                voices = await tts.list_voices(session.http)
            except Exception as e:
                print(f"voice list failed: {e}")
                voices = []
        else:
            voices = []
        if voices:
            await ws.send(protocol.control("voices", items=voices))

        tasks = [
            asyncio.create_task(session.sender()),
            asyncio.create_task(session.silence_watchdog()),
            asyncio.create_task(session.tts_worker()),
        ]
        async for message in ws:
            if isinstance(message, bytes):
                ftype, _, payload = protocol.decode_binary(message)
                if ftype == protocol.BIN_AUDIO:
                    await session.on_audio(payload)
            else:
                frame = json.loads(message)
                kind = frame.get("type")
                if kind == "audio_end":
                    await session.on_audio_end()
                elif kind == "interrupt":
                    session.cancel_event.set()
                    session.barge_in()
                    session.emit("status", state="idle", step=session.step)
                elif kind == "set_voice":
                    session.voice_id = frame.get("voice_id")
                    if session.narrator is not None:
                        session.narrator.set_voice(session.voice_id)
    except websockets.ConnectionClosed:
        pass
    finally:
        session.cancel_event.set()
        for t in tasks:
            t.cancel()
        if session.narrator is not None:
            await session.narrator.close()
        if session.http is not None:
            await session.http.aclose()
        if active.get("ws") is ws:
            active["ws"] = None
        print("○ session closed")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mock", action="store_true", help="no keys/permissions needed")
    args = parser.parse_args()

    token = get_token()
    url = f"ws://{lan_ip()}:{config.GATEWAY_PORT}/{token}"
    qr = qrcode.QRCode(border=1)
    qr.add_data(url)
    qr.print_ascii(invert=True)
    print(f"\nvoiceos-connect gateway{' [MOCK]' if args.mock else ''}\nscan to pair: {url}\n")

    active = {"ws": None}
    async with websockets.serve(lambda ws: handle(ws, token, args.mock, active),
                                "0.0.0.0", config.GATEWAY_PORT, max_size=8 * 1024 * 1024):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nbye")
