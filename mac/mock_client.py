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
    got = {"transcript_final": False, "say": 0, "status": 0, "video": 0}
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
                got["video"] += 1
                if got["video"] in (1, 10):
                    print(f"video frame {header} ({len(payload)} bytes)")
            else:
                frame = json.loads(message)
                print(f"<- {frame}")
                kind = frame["type"]
                if kind == "transcript" and frame.get("final"):
                    got["transcript_final"] = True
                elif kind == "say":
                    got["say"] += 1
                elif kind == "status":
                    got["status"] += 1
                    if frame.get("state") == "idle":
                        idle_seen = True

    ok = got["transcript_final"] and got["say"] >= 2 and got["video"] > 0
    print(f"\nsummary: {got}\n{'PASS' if ok else 'FAIL'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    asyncio.run(main())
