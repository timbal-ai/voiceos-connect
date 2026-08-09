# voiceos-connect

One voice, two devices. iPhone A is the voice remote and live viewer, a Mac is
the agent host (brain, hands, eyes, voice), and iPhone B gets driven through
iPhone Mirroring. **Read [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) first** — it
has the full architecture, the WebSocket wire protocol, the iPhone A app spec,
and the demo script.

## Layout

- `mac/` — Python agent host. Milestone 1 is done: a Claude computer-use loop
  that drives the real macOS desktop from typed text commands.
- `ios/` — (upcoming) SwiftUI app for iPhone A: PTT mic, live transcript,
  streamed screen view. TestFlight distribution.

## Milestone status (weekend build order)

1. ✅ Mac agent loop driving macOS, hardcoded/typed text commands — no phone.
2. ✅ WS gateway (`mac/gateway.py`): pairing QR, Deepgram STT, agent wiring,
   `--mock` mode for iOS dev. iPhone A app itself lives in `ios/` (WIP).
3. 🟡 Screen streaming to iPhone A — placeholder ships with the gateway
   (screencapture at ~4 fps during tasks); ScreenCaptureKit helper for
   10–15 fps still to do.
4. ⬜ Phone mode: iPhone Mirroring window detection, crop, Cmd+1/2/3, hints.
5. ✅ ElevenLabs TTS narration (streamed 16 kHz PCM behind each `say` frame,
   `eleven_flash_v2_5`) + voice list for the onboarding picker. Mock mode
   sends beep tones so the iOS audio path is testable without a key.
6. ⬜ Extras: Live Activity → cloud agent → finale game.

## Mac agent quickstart

```bash
cd mac
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in ANTHROPIC_API_KEY + DEEPGRAM_API_KEY
python main.py                        # REPL
python main.py "open Safari and search for anthropic"   # one-shot
python gateway.py                     # WS gateway for iPhone A (prints pairing QR)
python gateway.py --mock              # protocol mock: no keys/permissions needed
```

### macOS permissions (grant once, to your terminal app / IDE)

System Settings → Privacy & Security:

- **Screen Recording** — for `screencapture` (the agent's eyes). Without it,
  captures silently show only the wallpaper.
- **Accessibility** — for synthetic mouse/keyboard events (the agent's hands).

Restart the terminal after granting.

### Kill switches

- Slam the cursor into the **top-left corner** — pyautogui failsafe aborts the
  current action instantly.
- `Ctrl+C` in the terminal cancels the current task, keeps the REPL alive.

## Demo risk log (do not lose these)

- **EU-region Apple IDs can't use iPhone Mirroring (DMA).** Our IDs are
  EU/Spain — verify on the actual demo hardware ASAP, or set up a US-region
  Apple ID on the Mac + iPhone B pair. This blocks milestone 4.
- iPhone Mirroring needs: macOS Sequoia+, Apple silicon, iPhone B on iOS 18+,
  same Apple ID, Bluetooth + Wi-Fi on, phone locked and untouched.
- Never demo on venue Wi-Fi: Mac hotspot or travel router. USB-C tether
  iPhone A as backup.
- Each computer-use step is ~2–4 s; never demo a task longer than ~6 steps.
