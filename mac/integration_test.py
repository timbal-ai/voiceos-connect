"""Real-API smoke test for the STT/TTS providers (no mic or speakers needed).

    DEEPGRAM_API_KEY=... ELEVENLABS_API_KEY=... python integration_test.py

Round trip: ElevenLabs synthesizes a sentence to 16 kHz PCM, then Deepgram
transcribes that PCM back. Exercises the voice list, two narration lines over
one multi-context connection, and a full PTT-style utterance session.
"""

import asyncio
import sys

import httpx

from agent import stt, tts

SENTENCE = "Open Safari and search for Anthropic."


async def main():
    async with httpx.AsyncClient() as client:
        voices = await tts.list_voices(client)
    print(f"voices: {[v['name'] for v in voices]}")
    assert voices, "no voices returned"

    narrator = tts.Narrator()
    pcm = bytearray()
    async for chunk in narrator.synthesize(SENTENCE):
        pcm.extend(chunk)
    print(f"tts line 1: {len(pcm)} PCM bytes (~{len(pcm) / 32000:.1f}s)")
    assert len(pcm) > 16000, "suspiciously little audio"

    # second line reuses the same connection (multi-context)
    pcm2 = bytearray()
    async for chunk in narrator.synthesize("Done. The page is open."):
        pcm2.extend(chunk)
    await narrator.close()
    print(f"tts line 2: {len(pcm2)} PCM bytes")
    assert len(pcm2) > 8000, "second context produced no audio"

    partials = []
    utterance = stt.UtteranceSession(on_partial=partials.append)
    await utterance.start()
    for i in range(0, len(pcm), 2560):
        await utterance.feed(bytes(pcm[i : i + 2560]))
        await asyncio.sleep(0.02)
    text = await utterance.finish()
    print(f"stt: {len(partials)} partials, final: {text!r}")
    lowered = text.lower()
    assert "safari" in lowered and "anthropic" in lowered, f"incomplete transcript: {text!r}"

    print("PASS")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except AssertionError as e:
        print(f"FAIL: {e}")
        sys.exit(1)
