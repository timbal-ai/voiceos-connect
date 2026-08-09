"""Wire protocol codec. This mirrors docs/BLUEPRINT.md exactly — if you
change anything here, update the doc and tell the iOS folks.

Text WS messages are JSON control frames: {"type": "hello" | "ready" |
"transcript" | "say" | "status" | "interrupt" | "audio_end", ...}.

Binary WS messages (both directions) share one layout:

    byte 0        frame type
    bytes 1-4     uint32 big-endian JSON header length
    then          UTF-8 JSON header
    then          payload bytes
"""

import json
import struct

BIN_AUDIO = 0x01  # A -> Mac: 16 kHz mono s16le PCM. header: {} 
BIN_VIDEO = 0x02  # Mac -> A: JPEG. header: {source: "mac"|"iphone", w, h, seq}
BIN_TTS = 0x03    # Mac -> A: TTS audio (milestone 5). header: {codec, rate}


def encode_binary(ftype: int, header: dict, payload: bytes) -> bytes:
    h = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return bytes([ftype]) + struct.pack(">I", len(h)) + h + payload


def decode_binary(data: bytes):
    """-> (ftype, header dict, payload bytes)"""
    ftype = data[0]
    (hlen,) = struct.unpack(">I", data[1:5])
    header = json.loads(data[5 : 5 + hlen]) if hlen else {}
    return ftype, header, data[5 + hlen :]


def control(type_: str, **fields) -> str:
    return json.dumps({"type": type_, **fields}, separators=(",", ":"))
