# Demo rehearsal runbook

Determinism is the whole game: pin the exact prompts, rehearse each 10×,
pre-position everything. Show what it does, never mention what it can't.

## The five pinned prompts (speak these exactly)

1. *(Onboarding on iPhone A — pick a voice, 10 s of charm.)*
2. **"Search Google for the Scaling Enterprise AI event in San Francisco and
   open the page."** — desktop task, ~5 steps.
3. **"Now connect to my mobile."** — deterministic phone-mode trigger
   (regex: connect/switch/go + phone/mobile/iphone). Pause. Sell the gasp.
4. **"Clean up my notifications."** — swipes them away one by one.
5. **"Send a WhatsApp to Joshua: we just want to hug him."** — his phone
   buzzes in the room. Second gasp.
6. *(Optional finale)* **"Build me a tiny game and play it."** — agent writes
   a canvas game in TextEdit, saves, opens in Safari, plays a round. Cut if
   timing is tight.

Close: **"One voice. Two devices. Nothing was faked."**

## Kill switches (rehearse using them)

| Switch | Effect |
| --- | --- |
| **Ctrl+Opt+Cmd+Space** on the Mac | Freezes ALL synthetic input instantly; cancels the task; agent says "Emergency stop". Press again to unfreeze. |
| Slam cursor into **top-left corner** | pyautogui failsafe aborts the current action. |
| Release PTT + say **"stop"** | Sends interrupt; cancels the task. |
| Speak any new command mid-task | Barge-in: old task cancels, new one starts. |

## Mac prep (once)

- System Settings → Privacy & Security → **Screen Recording** AND
  **Accessibility** for the terminal running the gateway. Restart it after.
- `mac/.env`: `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`.
- `python integration_test.py` must print PASS (live STT/TTS round trip).
- Run one desktop task via `python main.py "..."` and watch click accuracy.
- Pre-position app windows; close everything not in the demo.
- Do Not Disturb ON on the Mac (no notification popups over the demo).

## iPhone B prep (the target phone)

- Same Apple ID as the Mac, iOS 18+, Bluetooth + Wi-Fi on, within a meter.
- Logged into WhatsApp / Instagram / Spotify. Notifications seeded (ask 2-3
  people to text it the night before). DND **off**.
- **Locked, face up, and nobody touches it** — mirroring drops if it's
  picked up. Tape it to the table if you must.
- Verify iPhone Mirroring pairing the night before AND the morning of.
- EU caveat: mirroring has historically been unavailable on EU-region Apple
  IDs. Verified launch on our IDs; pairing verdict pending (Isaac). Plan B:
  WDA over USB (`ios-app/` rig).

## Networking

- Mac's own hotspot or a travel router. **Never venue Wi-Fi.**
- iPhone A: USB-C tether to the Mac as backup path.
- Pair (QR scan) BEFORE going on stage; trigger the iOS Local Network
  permission prompt during setup, never live.

## Day-of run order (T-30 min)

1. Mac on hotspot; phone A and Mac on the same network.
2. `cd mac && source .venv/bin/activate && python gateway.py` — check
   "panic hotkey armed" prints.
3. Scan QR with iPhone A; accept Local Network prompt; pick the voice.
4. iPhone B: lock it, place it, verify mirroring connects once, close the
   mirroring window again (the agent reopens it on cue).
5. One full dry run of prompts 2-5. Then reset: close Safari tabs, re-seed
   a notification, delete the WhatsApp test message.
6. Projector mirrors the Mac; iPhone A in the presenter's hand.

## Rules of thumb

- Each computer-use step is 2-4 s; narration covers the gaps. Never demo a
  task longer than ~6 steps.
- If a task goes sideways: panic chord, laugh, re-speak the pinned prompt.
  The audience forgives a retry; it never forgives dead silence.
- If mirroring drops mid-demo the agent says so — acknowledge, relock the
  phone, say "connect to my mobile" again.
