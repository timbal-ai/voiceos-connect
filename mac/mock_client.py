"""Protocol exerciser: pretends to be iPhone A. Useful as a reference for the
iOS implementation and as a smoke test for the gateway.

    python gateway.py --mock     (in another terminal)
    python mock_client.py

Pairs, streams fake PTT audio, sends audio_end, prints every frame received
until the task finishes.
"""

import asyncio
import json
import sys
from pathlib import Path

import websockets

from agent import config, protocol

async def main():
    token = (Path(__file__).parent / ".voiceos_token").read_text().strip()
    url = f"ws://127.0.0.1:{config.GATEWAY_PORT}/{token}"
    got = {"transcript_final": False, "say": 0, "status": 0, "video": 0,
           "voices": 0, "tts_bytes": 0, "tts_done": 0}
    async with websockets.connect(url, max_size=8 * 1024 * 1024) as ws:
        await ws.send(protocol.control(
            "hello", token=token, voice_id="test-voice", device="mock-client"
        ))
        ready = json.loads(await ws.recv())
        assert ready["type"] == "ready", ready
        print(f"paired: {ready}")

        # 1s of fake PTT audio in 50ms chunks (16 kHz mono s16le)
        chunk = b"\x00\x00" * 800
        for _ in range(20):
            await ws.send(protocol.encode_binary(protocol.BIN_AUDIO, {}, chunk))
            await asyncio.sleep(0.05)
        await ws.send(protocol.control("audio_end"))

        idle_seen = False
        while not idle_seen:
            message = await asyncio.wait_for(ws.recv(), timeout=15)
            if isinstance(message, bytes):
                ftype, header, payload = protocol.decode_binary(message)
                if ftype == protocol.BIN_VIDEO:
                    got["video"] += 1
                    if got["video"] in (1, 10):
                        print(f"video frame {header} ({len(payload)} bytes)")
                elif ftype == protocol.BIN_TTS:
                    if header.get("done"):
                        got["tts_done"] += 1
                        print(f"tts done for say_id={header['say_id']}")
                    else:
                        got["tts_bytes"] += len(payload)
            else:
                frame = json.loads(message)
                print(f"<- {frame}")
                kind = frame["type"]
                if kind == "transcript" and frame.get("final"):
                    got["transcript_final"] = True
                elif kind == "voices":
                    got["voices"] = len(frame["items"])
                elif kind == "say":
                    got["say"] += 1
                elif kind == "status":
                    got["status"] += 1
                    if frame.get("state") == "idle":
                        idle_seen = True

        # small grace period: TTS done markers can trail the idle status
        try:
            while got["tts_done"] < got["say"]:
                message = await asyncio.wait_for(ws.recv(), timeout=3)
                if isinstance(message, bytes):
                    ftype, header, payload = protocol.decode_binary(message)
                    if ftype == protocol.BIN_TTS and header.get("done"):
                        got["tts_done"] += 1
                    elif ftype == protocol.BIN_TTS:
                        got["tts_bytes"] += len(payload)
        except asyncio.TimeoutError:
            pass

    ok = (got["transcript_final"] and got["say"] >= 2 and got["video"] > 0
          and got["voices"] > 0 and got["tts_bytes"] > 0 and got["tts_done"] >= got["say"])
    print(f"\nsummary: {got}\n{'PASS' if ok else 'FAIL'}")
    sys.exit(0 if ok else 1)


async def main_reconnect():
    """Drop the socket mid-task, reconnect with the same token, and require
    the task to survive the gap (Isaac's resume semantics)."""
    token = (Path(__file__).parent / ".voiceos_token").read_text().strip()
    url = f"ws://127.0.0.1:{config.GATEWAY_PORT}/{token}"

    async with websockets.connect(url, max_size=8 * 1024 * 1024) as ws:
        await ws.send(protocol.control("hello", token=token, device="mock-client"))
        assert json.loads(await ws.recv())["type"] == "ready"
        chunk = b"\x00\x00" * 800
        for _ in range(10):
            await ws.send(protocol.encode_binary(protocol.BIN_AUDIO, {}, chunk))
            await asyncio.sleep(0.05)
        await ws.send(protocol.control("audio_end"))
        # wait until the task is actually running, then yank the socket
        while True:
            message = await asyncio.wait_for(ws.recv(), timeout=10)
            if isinstance(message, str):
                frame = json.loads(message)
                if frame["type"] == "status" and frame.get("state") == "running":
                    break
        print("task running -> dropping connection")

    await asyncio.sleep(1.0)  # gap while the task keeps going

    got = {"resync_status": False, "say": 0, "idle": False}
    async with websockets.connect(url, max_size=8 * 1024 * 1024) as ws:
        await ws.send(protocol.control("hello", token=token, device="mock-client"))
        assert json.loads(await ws.recv())["type"] == "ready"
        print("reconnected")
        while not got["idle"]:
            message = await asyncio.wait_for(ws.recv(), timeout=15)
            if isinstance(message, bytes):
                continue
            frame = json.loads(message)
            print(f"<- {frame}")
            if frame["type"] == "voices":
                continue
            if frame["type"] == "status":
                if frame.get("state") == "running":
                    got["resync_status"] = True
                elif frame.get("state") == "idle":
                    got["idle"] = True
            elif frame["type"] == "say":
                got["say"] += 1

    ok = got["resync_status"] and got["say"] >= 1 and got["idle"]
    print(f"\nsummary: {got}\n{'PASS' if ok else 'FAIL'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    asyncio.run(main_reconnect() if "--reconnect" in sys.argv else main())
