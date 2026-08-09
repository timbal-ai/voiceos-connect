"""Milestone 2: the WebSocket gateway iPhone A connects to.

    python gateway.py          real mode: Deepgram STT -> Claude agent loop
    python gateway.py --mock   mock mode for iOS dev: canned transcripts,
                               scripted status/say frames, synthetic video —
                               no API keys or macOS permissions needed

Pairing: prints a QR of ws://<lan-ip>:<port>/<token>. The token persists in
.voiceos_token so reconnects survive gateway restarts. One session at a time;
a new connection evicts the old one's socket but REATTACHES to the running
session — a socket drop mid-task never kills the task. While detached, video
and TTS audio are dropped (stale on arrival anyway); text frames queue up and
flush on reattach, and the gateway re-sends ready/voices/status to resync.

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
import re
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

# Mock transcripts cycle so a barge-in shows a visibly different command,
# and the cycle walks through the phone-mode flow (portrait iphone frames).
MOCK_TRANSCRIPTS = [
    "open safari and search for anthropic",
    "now connect to my mobile",
    "send a message to joshua saying we just want to hug him",
    "disconnect from my phone",
]

# Phone mode entry/exit is routed deterministically from the transcript, not
# by the model — deterministic routing is what survives a live demo.
PHONE_CONNECT_RE = re.compile(
    r"\b(connect|switch|go)\b.{0,24}\b(phone|mobile|iphone)\b", re.IGNORECASE)
PHONE_DISCONNECT_RE = re.compile(
    r"\b(disconnect|exit|leave|back)\b.{0,24}\b(phone|mobile|iphone|mac)\b", re.IGNORECASE)

MOCK_PHONE_SIZE = (330, 650)  # portrait, roughly the mirroring window aspect


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
    """Lives independently of any one WebSocket connection (Isaac's reconnect
    ask): the session is created on first pairing and survives socket drops;
    handle() attaches/detaches connections to it."""

    def __init__(self, mock: bool, mock_fps: float = 5.0, mock_size=(640, 416)):
        self.ws = None
        self.attached = False
        self.sender_task = None
        self.workers: list = []
        self.voices = None  # cached after first fetch, re-sent on reattach
        self.mock = mock
        self.mock_interval = 1.0 / mock_fps
        self.mock_w, self.mock_h = mock_size
        self.mock_cmd_i = 0
        self.viewport = None  # (x, y, w, h) of the mirroring window in phone mode
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

    # -- connection lifecycle ------------------------------------------------

    def attach(self, ws):
        self.ws = ws
        self.attached = True

    def detach(self):
        self.attached = False
        self.ws = None
        if self.sender_task is not None:
            self.sender_task.cancel()
            self.sender_task = None

    def start_workers(self):
        self.workers = [
            asyncio.create_task(self.silence_watchdog()),
            asyncio.create_task(self.tts_worker()),
        ]

    # -- thread-safe emitters (agent loop runs in a worker thread) ----------

    def emit(self, type_: str, **fields):
        self.loop.call_soon_threadsafe(
            self.outbox.put_nowait, protocol.control(type_, **fields)
        )

    def emit_video(self, jpeg: bytes, w: int, h: int, source: str = "mac"):
        if not self.attached:
            return  # stale pixels are worthless after a reconnect
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
                if not self.attached:
                    pass  # nobody listening: skip synthesis, still send done marker
                elif self.mock:
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
            text = MOCK_TRANSCRIPTS[self.mock_cmd_i % len(MOCK_TRANSCRIPTS)]
            self.mock_cmd_i += 1
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
            if PHONE_CONNECT_RE.search(text) and self.viewport is None:
                result = await self._connect_phone()
            elif PHONE_DISCONNECT_RE.search(text) and self.viewport is not None:
                self.viewport = None
                result = "Back on the Mac."
            elif self.mock:
                result = await self._mock_task()
            else:
                result = await self._run_agent(text)
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

    async def _run_agent(self, text: str) -> str:
        from agent import loop as agent_loop

        if self.viewport is not None:
            # phone mode: re-locate the window (it may have moved) and detect
            # a dropped mirroring session before clicking into the void
            from agent import mirroring

            rect = await self.loop.run_in_executor(None, mirroring.find_window)
            if rect is None:
                self.viewport = None
                return ("The phone connection dropped - the mirroring window is "
                        "gone. Say 'connect to my phone' to retry.")
            self.viewport = tuple(rect)

        cancel = self.cancel_event
        region = self.viewport
        return await self.loop.run_in_executor(
            None,
            lambda: agent_loop.run_task(
                text,
                on_narration=self.speak,
                on_action=self._on_action,
                cancel_event=cancel,
                region=region,
                phone=region is not None,
            ),
        )

    async def _connect_phone(self) -> str:
        self.speak("Connecting to your iPhone...")
        if self.mock:
            await asyncio.sleep(1.5)
            self.viewport = (0, 0, *MOCK_PHONE_SIZE)
        else:
            from agent import mirroring

            rect = await self.loop.run_in_executor(None, mirroring.connect)
            self.viewport = tuple(rect)
        await asyncio.sleep(2.0)  # let the stream show the phone waking up
        return "Connected. I can see your phone - what should I do on it?"

    def _on_action(self, action: dict):
        self.step += 1
        self.emit("status", state="running", step=self.step, action=action.get("action"))

    async def _stream_screens(self):
        """Streams the display (or the mirroring window in phone mode) while a
        task runs. Restarts the capture whenever the viewport changes so the
        phone fills iPhone A's screen the moment phone mode engages."""
        from agent import screen

        while True:
            rect = self.viewport
            source = "iphone" if rect is not None else "mac"

            if self.mock:
                w, h = MOCK_PHONE_SIZE if rect is not None else (self.mock_w, self.mock_h)
                while self.viewport == rect:
                    jpeg, mw, mh = _mock_frame(self.seq, w, h)
                    self.emit_video(jpeg, mw, mh, source=source)
                    await asyncio.sleep(self.mock_interval)
                continue

            # Preferred path: ScreenCaptureKit helper at 10-15 fps.
            try:
                from agent.sck import SCKStream

                stream = SCKStream(fps=config.STREAM_FPS, rect=rect)
                await stream.start()
                try:
                    async for jpeg, w, h in stream.frames():
                        self.emit_video(jpeg, w, h, source=source)
                        if self.viewport != rect:
                            break  # viewport changed: restart with the new crop
                finally:
                    await stream.stop()
                if self.viewport == rect:
                    return  # helper died for another reason; don't spin
                continue
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"SCK streamer unavailable ({e}); falling back to screencapture")

            while self.viewport == rect:
                try:
                    jpeg, w, h = await self.loop.run_in_executor(
                        None, screen.screenshot_jpeg, None, rect)
                    self.emit_video(jpeg, w, h, source=source)
                except Exception:
                    pass  # no Screen Recording permission: stream nothing
                await asyncio.sleep(config.STREAM_INTERVAL_S)

    async def _mock_task(self) -> str:
        # (narration line, pause seconds). The 4s line is Isaac's barge-in
        # window: speak over it (or send interrupt) to test cancel end to end.
        script = [
            ("Opening Safari...", 1.5),
            ("Typing the search into the address bar...", 1.5),
            ("Scanning the results...", 1.5),
            ("This next step takes a moment - a good window to interrupt me...", 4.0),
            ("Opening the first result...", 1.5),
            ("Checking the page loaded properly...", 1.5),
        ]
        for line, pause in script:
            self.speak(line)
            self._on_action({"action": "left_click"})
            deadline = time.monotonic() + pause
            while time.monotonic() < deadline:
                if self.cancel_event.is_set():
                    return "Okay, stopping."
                await asyncio.sleep(0.25)
        return "Done - Safari is showing the Anthropic homepage."


def _tone(freq: float, dur: float, rate: int = 16000) -> bytes:
    """Sine PCM (16 kHz mono s16le) with a fade-out to avoid clicks."""
    import array
    import math

    n = int(rate * dur)
    samples = array.array("h", (
        int(8000 * math.sin(2 * math.pi * freq * i / rate) * min(1, (n - i) / 800))
        for i in range(n)
    ))
    return samples.tobytes()


def _mock_tone(say_id: int) -> bytes:
    """0.35s beep (pitch varies per line) so iOS can test the TTS audio path
    without an ElevenLabs key. Same format as real TTS."""
    return _tone(380 + (say_id % 5) * 60, 0.35)


def start_preview_server(port: int) -> list:
    """Mock voice previews Isaac can actually play: generates a distinct
    two-note WAV per voice and serves them over plain HTTP (AVPlayer handles
    WAV URLs the same as mp3). Returns the voices list for the `voices` frame."""
    import functools
    import http.server
    import tempfile
    import threading
    import wave

    directory = tempfile.mkdtemp(prefix="voiceos_previews_")
    host = lan_ip()
    voices = []
    for i, (name, freq) in enumerate([("Nova", 392), ("Atlas", 262), ("Luna", 523)], 1):
        filename = f"{name.lower()}.wav"
        with wave.open(f"{directory}/{filename}", "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(_tone(freq, 0.5) + _tone(freq * 1.25, 0.5))
        voices.append({
            "id": f"mock-voice-{i}",
            "name": name,
            "preview_url": f"http://{host}:{port}/{filename}",
        })

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return voices


def _mock_frame(seq: int, w: int = 640, h: int = 416):
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (w, h), (18, 18, 24))
    d = ImageDraw.Draw(img)
    x = (seq * 12) % w
    d.rectangle([x, h // 2 - 20, x + 60, h // 2 + 20], fill=(90, 140, 255))
    d.text((16, 16), f"voiceos-connect mock stream  #{seq}  {w}x{h}", fill=(230, 230, 230))
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

    if active.get("ws") is not None:  # one connection at a time
        await active["ws"].close(4409, "replaced by new connection")
    active["ws"] = ws

    session = active.get("session")
    resumed = session is not None
    if session is None:
        session = Session(mock, mock_fps=active["mock_fps"], mock_size=active["mock_size"])
        session.start_workers()
        active["session"] = session
    else:
        session.detach()  # drop the dead connection's sender before reattaching
    if hello.get("voice_id"):
        session.voice_id = hello["voice_id"]
        if session.narrator is not None:
            session.narrator.set_voice(session.voice_id)
    session.attach(ws)
    print(f"● {'resumed' if resumed else 'paired'}: {hello.get('device', 'unknown device')}"
          f" (voice_id={session.voice_id or '-'}){' [mock]' if mock else ''}")
    from agent import screen, tts

    try:
        mw, mh = (session.mock_w, session.mock_h) if mock else screen.model_size()
        await ws.send(protocol.control("ready", server="voiceos-connect", screen={"w": mw, "h": mh}))

        if session.voices is None:
            if mock:
                session.voices = active["mock_voices"]
            elif tts.enabled():
                import httpx

                session.http = httpx.AsyncClient()
                try:
                    session.voices = await tts.list_voices(session.http)
                except Exception as e:
                    print(f"voice list failed: {e}")
                    session.voices = []
            else:
                session.voices = []
        if session.voices:
            await ws.send(protocol.control("voices", items=session.voices))

        if resumed:  # resync Live Activity state after the gap
            session.emit("status",
                         state="running" if session.task_running else "idle",
                         step=session.step)

        session.sender_task = asyncio.create_task(session.sender())
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
        # Only the connection dies; the session (and any running task) stays
        # alive so the app can reconnect with the same token and resume.
        if session.ws is ws:
            session.detach()
        if active.get("ws") is ws:
            active["ws"] = None
        print("○ connection closed (session kept for resume)")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mock", action="store_true", help="no keys/permissions needed")
    parser.add_argument("--mock-fps", type=float, default=5.0,
                        help="synthetic video frame rate (decoder stress-testing)")
    parser.add_argument("--mock-size", default="640x416",
                        help="synthetic video frame size, e.g. 1183x768")
    args = parser.parse_args()
    mock_w, mock_h = (int(v) for v in args.mock_size.lower().split("x"))

    token = get_token()
    url = f"ws://{lan_ip()}:{config.GATEWAY_PORT}/{token}"
    qr = qrcode.QRCode(border=1)
    qr.add_data(url)
    qr.print_ascii(invert=True)
    print(f"\nvoiceos-connect gateway{' [MOCK]' if args.mock else ''}\nscan to pair: {url}\n")

    active = {
        "ws": None,
        "session": None,
        "mock_fps": args.mock_fps,
        "mock_size": (mock_w, mock_h),
        "mock_voices": start_preview_server(config.GATEWAY_PORT + 1) if args.mock else None,
    }
    async with websockets.serve(lambda ws: handle(ws, token, args.mock, active),
                                "0.0.0.0", config.GATEWAY_PORT, max_size=8 * 1024 * 1024):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nbye")
