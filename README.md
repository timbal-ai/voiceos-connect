# voiceos-connect

One voice, two devices. iPhone A is the voice remote and live viewer, a Mac is
the agent host (brain, hands, eyes, voice), and iPhone B gets driven through
iPhone Mirroring. **Read [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) first** — it
has the full architecture, the WebSocket wire protocol, the iPhone A app spec,
and the demo script.

## Layout

- `mac/` — Python agent host: computer-use loop, WS gateway, STT/TTS,
  phone mode, cloud agent.
- `integrations/` — **VoiceOS notch integrations** (install each in VoiceOS:
  Settings → Agent Mode → Integrations → Install from folder → pick the
  specific subfolder; `bun verify.ts` inside it must pass):
  - `integrations/phone/` — speak a phone task into the notch, the iPhone
    Mirroring window snaps to top-center under the notch (the "notch grows a
    live phone" effect) and the agent operates it. Needs the `mac/` venv.
  - `integrations/cursor/` — voice-driven Cursor coding agent (repos, PRs,
    run status).
  - `integrations/whatsapp/` — WhatsApp from the notch: link via QR, read
    chats and unreads, find contacts, send messages. Session material
    (`wa-auth/`, `wa-store.json`) stays local and gitignored.
- `ios-app/` — iPhone app + WDA full-device rig (Isaac).

## Milestone status (weekend build order)

1. ✅ Mac agent loop driving macOS, hardcoded/typed text commands — no phone.
2. ✅ WS gateway (`mac/gateway.py`): pairing QR, Deepgram STT, agent wiring,
   `--mock` mode for iOS dev. iPhone A app itself lives in `ios/` (WIP).
3. ✅ Screen streaming to iPhone A — ScreenCaptureKit Swift helper
   (`sck_streamer.swift`, compiled on first use) at 12 fps, verified at
   13.4 fps real capture. Falls back to ~4 fps screencapture if swiftc or
   the permission is missing. `--rect` crop support ready for phone mode.
4. 🟡 Phone mode: built, untested on real hardware (gated on the EU
   mirroring pairing verdict). "Connect to my phone" is routed
   deterministically from the transcript; the agent viewport crops to the
   mirroring window; the stream switches to `source: iphone`; dropped
   windows are detected before each task. Mock walks the whole flow.
5. ✅ ElevenLabs TTS narration (streamed 16 kHz PCM behind each `say` frame,
   `eleven_flash_v2_5`) + voice list for the onboarding picker. Mock mode
   sends beep tones so the iOS audio path is testable without a key.
6. 🟡 Extras: cloud agent ✅ (parallel headless-browser agent, "…in the
   cloud" routes to it; needs `playwright install chromium` once), panic
   kill switch ✅ (Ctrl+Opt+Cmd+Space), finale prompt hints ✅, rehearsal
   runbook ✅ (`docs/REHEARSAL.md`). Live Activity is iOS-side.

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
python integration_test.py            # real-API STT/TTS round trip (needs keys)
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
