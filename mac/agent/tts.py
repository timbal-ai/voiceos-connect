"""ElevenLabs streaming TTS -> 16 kHz mono s16le PCM chunks.

pcm_16000 matches the mic capture rate, so iPhone A plays narration through
the same AVAudioEngine it records with (hardware echo cancellation intact).
eleven_flash_v2_5 is the ~75ms-latency model; narration must not add dead air.
"""

import os

import httpx

BASE = "https://api.elevenlabs.io/v1"
MODEL_ID = os.getenv("VOICEOS_TTS_MODEL", "eleven_flash_v2_5")

# "Rachel", an ElevenLabs default voice — used when hello/set_voice never
# provided a voice_id.
DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"

SAMPLE_RATE = 16000
CODEC = "pcm_s16le"


def _headers() -> dict:
    return {"xi-api-key": os.environ["ELEVENLABS_API_KEY"]}


def enabled() -> bool:
    return bool(os.environ.get("ELEVENLABS_API_KEY"))


async def stream_pcm(client: httpx.AsyncClient, text: str, voice_id: str):
    """Yield PCM chunks for `text` as they are generated."""
    async with client.stream(
        "POST",
        f"{BASE}/text-to-speech/{voice_id or DEFAULT_VOICE}/stream",
        params={"output_format": "pcm_16000"},
        headers=_headers(),
        json={"text": text, "model_id": MODEL_ID},
        timeout=30.0,
    ) as response:
        response.raise_for_status()
        async for chunk in response.aiter_bytes(chunk_size=4096):
            if chunk:
                yield chunk


async def list_voices(client: httpx.AsyncClient, limit: int = 6) -> list:
    """Curated voice list for the onboarding picker. preview_url is a plain
    https mp3 the iOS app can play directly."""
    response = await client.get(f"{BASE}/voices", headers=_headers(), timeout=15.0)
    response.raise_for_status()
    return [
        {"id": v["voice_id"], "name": v["name"], "preview_url": v.get("preview_url")}
        for v in response.json()["voices"][:limit]
    ]
