# VoiceOS Connect

View and control your iPhone from your computer's browser.

The repo contains two separate things, because iOS makes them mutually exclusive:

| | `wda` + `server` (full-device rig) | `ios/` (VoiceOS Connect app) |
|---|---|---|
| Sees | The **whole phone**, every app | Only its own screen |
| Controls | The **whole phone** | Only its in-app browser |
| Connection | USB cable | USB or Wi-Fi |
| Distributable | No — developer setup only | Yes — TestFlight / App Store |

Apple forbids apps from injecting touches into other apps or capturing other apps' screens, which is why the shippable app can only control itself. Full-device control is possible only through **WebDriverAgent**, the XCUITest automation engine (the same one Appium uses), which must be developer-signed and driven over USB.

---

## Full-device rig — view & control the entire phone

### Requirements

- Xcode, plus `brew install libimobiledevice` (provides `iproxy`)
- iPhone connected by USB, **unlocked**, with **Developer Mode** enabled
  (*Settings → Privacy & Security → Developer Mode*)

### Run

First time only — fetch WebDriverAgent and apply our bundle-ID patch (it is a
third-party dependency, so it is not committed here):

```bash
./setup-wda.sh
```

Then, every time:

```bash
./start.sh
```

Then open **http://localhost:8080**.

`start.sh` launches WebDriverAgent on the phone (restarting it automatically if the device locks) and then the viewer server. To run the pieces by hand:

```bash
# 1. WebDriverAgent on the phone (keep running)
cd wda
xcodebuild -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner \
  -destination 'platform=iOS,id=<UDID>' -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<TEAM_ID> test-without-building

# 2. Viewer server
cd server && npm install && npm start
```

Find your UDID with `xcrun devicectl list devices`.

### Using it

| Input | Action on the phone |
|---|---|
| Click | Tap |
| Click & drag | Swipe |
| Scroll wheel | Scroll |
| Typing | Text input (focus a field on the phone first) |
| <kbd>Enter</kbd> / <kbd>Backspace</kbd> | Return / delete |
| **Home** button | Go to home screen |
| **Apps** button | App switcher |

Verify the whole chain any time with `node server/fulltest.js`.

### How it works

```
iPhone (USB)                              Computer
┌────────────────────────┐               ┌─────────────────────────┐
│ WebDriverAgent runner  │  MJPEG :9100  │ iproxy tunnels both     │
│  • full-screen video   ├──────────────▶│ ports over USB          │
│  • XCUITest automation │◀──────────────┤ Node server             │
└────────────────────────┘  HTTP  :8100  │  → browser viewer       │
                            commands     └─────────────────────────┘
```

Video comes from WebDriverAgent's built-in MJPEG server; the Node server splits the stream into JPEG frames and pushes them to the browser over a WebSocket. Clicks and keystrokes travel back as JSON and become XCUITest gestures. Stream quality is tuned in `server.js` via `mjpegServerFramerate`, `mjpegServerScreenshotQuality`, and `mjpegScalingFactor`.

### Latency: what's tuned and what's a hard limit

Measured on an iPhone 17 Pro over USB (`node wda-bench.js`, run with the server stopped):

| Gesture | Latency |
|---|---|
| Tap | ~600 ms |
| Swipe (2 points) | ~920 ms |
| Swipe (20 points) | ~1210 ms |
| Typing — any length, one call | ~315 ms |

Two findings shaped the design:

- **Typing cost is per call, not per character.** `"hello"` costs the same as `"h"`, so the viewer batches keystrokes (70 ms window) and sends them as one string. Typing a word went from ~1575 ms to ~315 ms.
- **Gesture cost is a fixed overhead, not per coordinate.** Adding 18 extra points to a path costs only ~16 ms each, so the ~600 ms is XCTest's `synthesizeEvent` IPC to `testmanagerd` — not something WDA settings or a source patch can fix. The two waits that *are* configurable (`waitForIdleTimeout`, `animationCoolOffTimeout`) are already zeroed in `server.js`.

Because gestures are slow and wheel events are fast, scrolls are **coalesced**: the viewer batches wheel deltas over 90 ms, and the server merges any scrolls that queue up behind an in-flight gesture into one larger flick. A 12-event burst drains in ~800 ms instead of ~4.8 s.

Real-time (<100 ms) input is not reachable through WebDriverAgent. The only viable route would be **Bluetooth HID** — iOS natively supports BT mice (via AssistiveTouch) and keyboards at ~10–20 ms — which needs a microcontroller acting as the HID peripheral, since macOS doesn't expose that role.

### Gotchas

- The phone must stay **unlocked**; WebDriverAgent stops if the device locks or is unplugged. Re-run `./start.sh` to recover.
- Signed with a **personal team**, the runner expires after 7 days — rebuild to renew.
- Typing goes to whatever field has focus **on the phone**; tap the field first.

---

## VoiceOS Connect app (`ios/`) — the shippable one

A SwiftUI app that streams its own screen to the same viewer and lets you drive its built-in browser from the PC. This is the version that can go to TestFlight.

```bash
cd ios
xcodegen generate      # brew install xcodegen
open VoiceOSConnect.xcodeproj
```

Set your team under *Signing & Capabilities*, then Run. Bundle ID is `com.voiceos.connect`.

### Ship to TestFlight

1. Join the [Apple Developer Program](https://developer.apple.com/programs/enroll/) ($99/yr).
2. Create the app in [App Store Connect](https://appstoreconnect.apple.com) — name **VoiceOS Connect**, bundle ID `com.voiceos.connect`.
3. Xcode → destination **Any iOS Device (arm64)** → *Product → Archive* → *Distribute App → TestFlight & App Store*.
4. In TestFlight, answer the export-compliance question (standard encryption → exempt) and add yourself as an **internal tester** (no review needed).

## Ideas next

- H.264/WebRTC instead of MJPEG for lower bandwidth and higher fps
- Launch a specific app by bundle ID from the viewer
- Clipboard sync and file transfer
- Multi-viewer auth
