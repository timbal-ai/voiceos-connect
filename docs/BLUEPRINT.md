# VoiceOS Connect — Demo Blueprint

**Concept:** One voice, two devices. You hold the Action Button on iPhone A and
speak. A Mac runs a Claude computer-use agent that executes on macOS, and when
the task needs a phone, it opens iPhone Mirroring and operates iPhone B live.
Everything the agent does streams back to iPhone A in real time, and the agent
narrates its progress out loud in the voice you picked.

Demo-only constraints accepted: no App Store review, TestFlight/dev builds,
pre-logged-in accounts, rehearsed network.

## Hardware topology

| Device | Role | Why |
| --- | --- | --- |
| iPhone A | Voice remote + live viewer | Runs the app. Just a mic, speaker, and screen — zero iOS restrictions apply because it automates nothing locally. |
| Mac (Apple silicon) | Agent host | Runs the brain (Claude loop), the hands (input events), the eyes (screen capture), and the voice (STT/TTS). |
| iPhone B | Target phone | Same Apple ID as the Mac, locked, on the table. Controlled through the iPhone Mirroring window. |
| (Optional) prop phone | Receives the WhatsApp live | Ringer up. |

**Why two iPhones (critical):** iPhone Mirroring only works while the target
phone is locked and not in use. The remote phone is actively in use during the
demo. Same phone for both roles = constant session drops.

Requirements: macOS Sequoia+, Apple silicon; iPhone B on iOS 18+, same Apple
ID, Bluetooth + Wi-Fi on, near the Mac. **Region caveat: iPhone Mirroring has
historically been unavailable on EU-region accounts (DMA). Verify before any
demo in Spain, or use a US-region Apple ID on the demo pair.** iPhone A and
Mac on the same LAN (or the Mac's own hotspot).

## Mac host (`mac/`) — five modules

1. **Gateway** — WebSocket server (one session at a time). JSON control frames
   + binary frames (audio, JPEG). Auth = shared token QR-scanned at pairing.
2. **Voice pipeline** — Deepgram streaming STT (partials forwarded to iPhone A
   so the user sees words appear as they speak). ElevenLabs TTS, one voice ID
   per persona (picked at onboarding). Barge-in: any incoming audio chunk
   while TTS plays → kill playback, treat as interruption. Narration: after
   each meaningful agent step, one line → TTS → iPhone A.
3. **Claude agent loop** *(built — `mac/agent/`)* — screenshot → action →
   execute → repeat. `computer_20251124` tool, `claude-sonnet-5`. Downscaled
   captures, clicks scaled back to native. Quartz CGEvent input via pyautogui.
   System prompt carries app-specific hints; deterministic prompts are what
   make live demos survive.
4. **Screen streamer** — ScreenCaptureKit → JPEG at 10–15 fps, ~50–60%
   quality → binary WS frames tagged `source: mac | iphone`. In phone mode,
   crop to the iPhone Mirroring window. WebRTC/LiveKit is the upgrade path;
   don't start there.
5. **Phone mode** — a mode of module 3, not a new system. `open -a "iPhone
   Mirroring"`, find the window rect via `CGWindowListCopyWindowInfo`, crop
   every screenshot to it. Shortcuts the agent must know: **Cmd+1** home,
   **Cmd+2** app switcher, **Cmd+3** Spotlight. Open apps via Spotlight +
   typing, never icon hunting. If the window disappears (phone picked up /
   out of range), the agent says so instead of clicking into the void.

## iPhone A app (`ios/`) — deliberately dumb

All intelligence lives on the Mac; the app is a mic, a speaker, and a screen.

- **SwiftUI.** Onboarding: play 3–4 voice samples, pick one, optionally name
  it → sends `voice_id` to the Mac.
- **Session screen:** big hold-to-talk button, live transcript ribbon, live
  Mac/phone stream filling the rest. Tap stream to zoom.
- **Pairing:** scan a QR the Mac prints (`ws://<lan-ip>:<port>/<token>`).
- **Audio:** `AVAudioSession` `.playAndRecord` + `.voiceChat` mode (hardware
  echo cancellation). Capture 16 kHz mono PCM via `AVAudioEngine`, ship raw
  chunks over the WS. No on-device STT. Playback: streamed TTS PCM through
  the same engine. Releasing PTT or speaking again = barge-in signal.
- **Action Button:** App Intent `Talk to VoiceOS` with `openAppWhenRun =
  true`; user assigns it via Settings/Shortcuts. Works from the lock screen:
  press → app opens → PTT armed.
- **Live view:** decode incoming JPEG frames to a UIImage/Metal layer.
  ~12 fps is smooth enough; latency matters more than framerate.
- **Live Activity + Dynamic Island:** while a task runs, show agent status
  ("Step 3 — typing message in WhatsApp"). Keeps narrating if the phone locks.
- **Distribution:** TestFlight (paid account). No special entitlements.

## Wire protocol (WebSocket) — implemented in `mac/agent/protocol.py`

This is the contract between the iOS app and the Mac gateway. Changes must
land in `mac/agent/protocol.py`, this doc, and a heads-up to whoever owns the
other side.

Connect to `ws://<lan-ip>:8765/<token>` (from the QR the gateway prints).
First frame must be `hello`; the gateway answers `ready`.

**Text frames** are JSON: `{"type": "...", ...fields}`.

| Frame | Direction | Fields |
| --- | --- | --- |
| `hello` | A → Mac | `token`, `voice_id?`, `device` |
| `ready` | Mac → A | `server`, `screen: {w, h}` |
| `voices` | Mac → A | `items: [{id, name, preview_url}]` — sent after `ready`; `preview_url` is a plain https mp3 for the onboarding picker |
| `set_voice` | A → Mac | `voice_id` — switch narration voice after pairing |
| `audio_end` | A → Mac | none — sent on PTT release, finalizes the utterance (2 s of silence also finalizes) |
| `transcript` | Mac → A | `text`, `final: bool` |
| `say` | Mac → A | `text`, `id`, `agent?: "cloud"` — narration line; its TTS audio streams as `0x03` binary frames tagged `say_id: id` |
| `status` | Mac → A | `state: running\|idle`, `step`, `action?`, `task?`, `agent?: "cloud"` (drives Live Activity) |
| `interrupt` | A → Mac | none — barge-in / cancel current task |

**Binary frames** (both directions) share one layout:

```
byte 0        frame type: 0x01 audio (A→Mac) | 0x02 video (Mac→A) | 0x03 TTS audio (Mac→A)
bytes 1–4     uint32 big-endian JSON header length
next          UTF-8 JSON header
rest          payload
```

- `0x01` audio: header `{}`, payload 16 kHz mono s16le PCM chunks.
- `0x02` video: header `{source: "mac"|"iphone"|"cloud", w, h, seq}`, payload JPEG.
- `0x03` TTS: header `{codec: "pcm_s16le", rate: 16000, say_id, done?}`,
  payload PCM chunks streamed during synthesis; an empty-payload frame with
  `done: true` closes that `say_id`. Same 16 kHz rate as the mic path, so it
  plays through the same `AVAudioEngine`. Starting to talk (PTT) or sending
  `interrupt` cancels queued/streaming TTS server-side; the app should also
  stop playback locally the moment PTT goes down.

New commands mid-task are allowed: a final transcript arriving while a task
runs cancels it and starts the new one (barge-in semantics).

**Keepalive.** The gateway sends WebSocket protocol pings every 20 s and
closes the connection if no pong arrives within 20 s (`websockets` library
defaults). `URLSessionWebSocketTask` answers protocol pings automatically, so
nothing is required for that direction — but it does NOT ping on its own, so
the app should call `sendPing` every ~15 s and treat a failed pong as a dead
connection (tear down and reconnect).

**Reconnect / resume.** The session survives socket drops. If the connection
dies (mid-task or idle), reconnect to the same URL and send `hello` with the
same token — the gateway reattaches the new socket to the existing session:

- a running agent task keeps executing across the gap; it is never cancelled
  by a disconnect (only by `interrupt` or a new command),
- `ready` and `voices` are re-sent, then a `status` frame resyncs the current
  state (drive the Live Activity from it),
- video and TTS audio produced during the gap are dropped (stale); text
  frames (`say`, `transcript`, `status`) queue up and flush on reattach.

Also note: the first `ws://` connection to a LAN IP triggers iOS's Local
Network permission prompt — trigger and accept it during onboarding, never
on stage.

**iOS dev without a Mac gateway running the real stack:** `python
mac/gateway.py --mock` needs no API keys or macOS permissions and speaks the
full protocol with canned transcripts, scripted `say`/`status`, and a
synthetic video stream.

## Extras

- **Cloud agent** *(built — `mac/agent/browser.py`)* — any command containing
  "cloud" runs on a parallel agent driving a headless Chromium (Playwright)
  instead of the Mac: its own pair of hands, so it runs WHILE a local task
  executes. Frames stream as `source: "cloud"`; its `say`/`status` frames
  carry `agent: "cloud"`. Setup once: `playwright install chromium`.
  Per-persona voices are the remaining nicety.
- **Finale** — "build me a little game and play it": agent writes a ~60-line
  canvas game to a local HTML file, opens it, plays a round. Cut if tight.

## Demo script (~4 min)

1. Onboarding on iPhone A: pick a voice. (10 s of charm.)
2. Action Button: "Search Google for the Scaling Enterprise AI event in San
   Francisco and open the page."
3. "Now connect to my mobile." → Mirroring window opens, iPhone B wakes up on
   the Mac screen. Gasp moment — sell it with a pause.
4. "Clean up my notifications." → swipes them away one by one.
5. "Send a WhatsApp to Joshua: we just want to hug him." → his phone buzzes
   in the room. Second gasp.
6. (Optional) finale game.
7. Close: "One voice. Two devices. Nothing was faked."

Show what it does, never mention what it can't.

## Risks and rehearsal notes

- Each computer-use step is ~2–4 s. Narration + live stream turn dead air
  into theater. Never demo a task longer than ~6 steps.
- Networking: Mac hotspot or travel router, never venue Wi-Fi. USB-C tether
  iPhone A as backup.
- iPhone B prep: logged into WhatsApp/Instagram/Spotify, notifications
  seeded, DND off, stays locked, Bluetooth on, within a meter of the Mac.
- Mirroring drops if iPhone B is picked up — tape it to the table if needed.
- Determinism: pin exact spoken prompts, rehearse each 10×, pre-position
  app windows.
- Kill switch: releasing PTT + "stop" sends `interrupt`; Mac hotkey freezes
  CGEvent output instantly (milestone 1: cursor to top-left corner).
- Fallback: recorded successful run behind a long-press on iPhone A.

## Build order (weekend-sized)

1. ✅ Mac agent loop driving macOS + typed text commands — no phone yet.
2. ⬜ WS gateway + iPhone A app with PTT audio → STT on Mac → loop.
3. ⬜ Screen streaming to iPhone A.
4. ⬜ Phone mode: mirroring window detection, crop, shortcuts, hints.
5. ⬜ TTS narration + voice picker.
6. ⬜ Extras in order of appetite: Live Activity → cloud agent → finale.
