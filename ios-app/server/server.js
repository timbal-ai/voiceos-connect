const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const WDA_PORT = 8100;  // WebDriverAgent control API on the phone, tunneled via iproxy
const MJPEG_PORT = 9100; // WebDriverAgent's built-in full-device MJPEG video stream

// Video tuning (WDA caps framerate at 60). Default 30fps — 60 over USB/iproxy
// flaps the MJPEG socket. activeFps can climb toward TARGET when the link is calm.
const MJPEG_FPS_TARGET = Number(process.env.MJPEG_FPS || 30);
const MJPEG_QUALITY = Number(process.env.MJPEG_QUALITY || 25);
const MJPEG_SCALE = Number(process.env.MJPEG_SCALE || 40);
let activeFps = MJPEG_FPS_TARGET;

// ---------- HTTP server (serves the viewer page) ----------
const server = http.createServer((req, res) => {
  if (req.url === "/debug/foreground") {
    withSession((sid) => wdaFetch("GET", `/session/${sid}/wda/activeAppInfo`))
      .then((r) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r.value || {})); })
      .catch((e) => { res.writeHead(500); res.end(String(e.message)); });
    return;
  }

  const pathname = new URL(req.url, "http://localhost").pathname;
  const url = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(__dirname, "public", path.normalize(url).replace(/^(\.\.[\/\\])+/, ""));
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
});

// ---------- WebSocket relay ----------
// The Mac capture helper connects with ?role=phone and sends binary JPEG frames.
// Browser viewers connect with ?role=viewer, receive frames, and send control JSON.
const wss = new WebSocketServer({ server });

const viewers = new Set();
let lastFrame = null;
let frameCount = 0;
let videoConnected = false;

function relayFrame(jpeg) {
  lastFrame = jpeg;
  frameCount++;
  // Drop frames when a viewer is backed up — prefer realtime over backlog.
  for (const v of viewers) {
    if (v.readyState === v.OPEN && v.bufferedAmount < 256_000) {
      v.send(jpeg, { binary: true });
    }
  }
}

function broadcastStatus() {
  const msg = JSON.stringify({
    type: "status",
    phoneConnected: videoConnected,
    wdaReady: wda.ready,
    viewers: viewers.size,
  });
  for (const v of viewers) {
    if (v.readyState === v.OPEN) v.send(msg);
  }
}

wss.on("connection", (ws) => {
  viewers.add(ws);
  console.log(`[viewer] connected (${viewers.size} total)`);
  if (lastFrame) ws.send(lastFrame, { binary: true });
  broadcastStatus();

  ws.on("message", (data, isBinary) => {
    if (!isBinary) handleControl(data.toString()).catch((e) => console.error("control error:", e.message));
  });

  ws.on("close", () => {
    viewers.delete(ws);
    console.log(`[viewer] disconnected (${viewers.size} total)`);
    broadcastStatus();
  });

  ws.on("error", (err) => console.error("ws error:", err.message));
});

// ---------- WebDriverAgent client (full-device control) ----------
const wda = {
  base: `http://127.0.0.1:${WDA_PORT}`,
  sessionId: null,
  size: null, // { width, height } in device points
  ready: false,
};

async function wdaFetch(method, endpoint, body) {
  const res = await fetch(wda.base + endpoint, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`WDA ${endpoint} -> ${res.status} ${text.slice(0, 200)}`);
  return json;
}

async function createSession() {
  // Empty capabilities → attach to whatever is on screen. shouldWaitForQuiescence:false
  // stops WDA from blocking on app "idle"/animation settling after each gesture, which
  // is the main source of tap/swipe latency.
  const res = await wdaFetch("POST", "/session", {
    capabilities: { alwaysMatch: { "appium:shouldWaitForQuiescence": false }, firstMatch: [{}] },
    // Legacy format too — raw WDA reads shouldWaitForQuiescence from here.
    desiredCapabilities: { shouldWaitForQuiescence: false },
  });
  wda.sessionId = res.sessionId || (res.value && res.value.sessionId);
  const sz = await wdaFetch("GET", `/session/${wda.sessionId}/window/size`);
  wda.size = sz.value;
  // Tune the MJPEG stream, and turn off the post-action idle waits for snappy control.
  await applyMjpegSettings(wda.sessionId);
  wda.ready = true;
  console.log(
    `[wda] session ready ${wda.sessionId.slice(0, 8)}, screen ${wda.size.width}x${wda.size.height} pt` +
      ` (mjpeg ${activeFps}fps q=${MJPEG_QUALITY} scale=${MJPEG_SCALE})`
  );
  broadcastStatus();
}

async function applyMjpegSettings(sid = wda.sessionId) {
  if (!sid) return;
  await wdaFetch("POST", `/session/${sid}/appium/settings`, {
    settings: {
      mjpegServerFramerate: activeFps,
      mjpegServerScreenshotQuality: MJPEG_QUALITY,
      mjpegScalingFactor: MJPEG_SCALE,
      waitForIdleTimeout: 0,
      animationCoolOffTimeout: 0,
      shouldUseCompactResponses: true,
    },
  }).catch(() => {});
}

// Hot path: use the cached session without a validation round-trip. Staleness is
// caught by withSession's retry and by the background probe, so taps stay snappy.
async function ensureSession() {
  if (!wda.sessionId) await createSession();
}

// Background health check: validate the session off the hot path so a stale one
// (after a WDA restart from lock/unplug) is refreshed before the next gesture.
async function probeWda() {
  try {
    if (!wda.sessionId) { await createSession(); return; }
    const r = await fetch(`${wda.base}/session/${wda.sessionId}/window/size`);
    if (!r.ok) { wda.sessionId = null; await createSession(); }
  } catch {
    if (wda.ready) { wda.ready = false; wda.sessionId = null; broadcastStatus(); }
  }
}

function isSessionError(err) {
  const m = String(err && err.message);
  return m.includes("invalid session id") || m.includes("Session does not exist") || m.includes("-> 404");
}

// Run a WDA action, recreating the session once if it went stale mid-flight.
async function withSession(fn) {
  await ensureSession();
  try {
    return await fn(wda.sessionId);
  } catch (err) {
    if (!isSessionError(err)) throw err;
    wda.sessionId = null;
    await createSession();
    return await fn(wda.sessionId);
  }
}

// Map normalized (0..1) viewer coords to device points.
function toPoint(nx, ny) {
  return { x: Math.round(nx * wda.size.width), y: Math.round(ny * wda.size.height) };
}

// W3C touch gesture: a sequence of pointer actions for one finger.
function touch(sid, actions) {
  return wdaFetch("POST", `/session/${sid}/actions`, {
    actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions }],
  });
}

function tapActions(x, y) {
  return [
    { type: "pointerMove", duration: 0, x, y },
    { type: "pointerDown", button: 0 },
    { type: "pause", duration: 25 },
    { type: "pointerUp", button: 0 },
  ];
}

function swipeActions(fromX, fromY, toX, toY, durationMs) {
  return [
    { type: "pointerMove", duration: 0, x: fromX, y: fromY },
    { type: "pointerDown", button: 0 },
    { type: "pointerMove", duration: durationMs, x: toX, y: toY },
    { type: "pointerUp", button: 0 },
  ];
}

// Gestures run one at a time (WDA serializes anyway). Scrolls that pile up while
// one is in flight get merged into a single larger swipe instead of queueing,
// which is what made fast wheel scrolling feel so laggy.
const gestureQueue = [];
let pendingScroll = null;
let draining = false;

function handleControl(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return Promise.resolve(); }

  if (msg.type === "scroll") {
    if (pendingScroll) {
      pendingScroll.dx += msg.dx || 0;
      pendingScroll.dy += msg.dy || 0;
    } else {
      pendingScroll = { type: "scroll", dx: msg.dx || 0, dy: msg.dy || 0 };
      gestureQueue.push(pendingScroll);
    }
  } else {
    pendingScroll = null;
    gestureQueue.push(msg);
  }
  return drainGestures();
}

async function drainGestures() {
  if (draining) return;
  draining = true;
  try {
    while (gestureQueue.length) {
      const msg = gestureQueue.shift();
      if (msg === pendingScroll) pendingScroll = null; // now executing; stop merging into it
      try {
        await runGesture(msg);
      } catch (e) {
        console.error("control error:", e.message);
      }
    }
  } finally {
    draining = false;
  }
}

async function runGesture(msg) {
  await withSession(async (sid) => {
    switch (msg.type) {
      case "tap": {
        const p = toPoint(msg.x, msg.y);
        await touch(sid, tapActions(p.x, p.y));
        break;
      }
      case "scroll": {
        // A merged wheel delta becomes one flick from screen center. A short
        // duration over a long distance triggers iOS inertia, so a single
        // gesture covers much more content than a slow drag would.
        const cx = wda.size.width / 2;
        const cy = wda.size.height / 2;
        const limit = Math.min(wda.size.height * 0.35, 300);
        const dy = Math.max(-limit, Math.min(limit, -(msg.dy || 0)));
        const dx = Math.max(-limit, Math.min(limit, -(msg.dx || 0)));
        await touch(sid, swipeActions(cx, cy, cx + dx, cy + dy, 60));
        break;
      }
      case "swipe": {
        const from = toPoint(msg.fromX, msg.fromY);
        const to = toPoint(msg.toX, msg.toY);
        const dur = Math.round((msg.duration || 0.2) * 1000);
        await touch(sid, swipeActions(from.x, from.y, to.x, to.y, dur));
        break;
      }
      case "text": {
        await wdaFetch("POST", `/session/${sid}/wda/keys`, { value: Array.from(msg.text) });
        break;
      }
      case "key": {
        if (msg.key === "backspace") {
          await wdaFetch("POST", `/session/${sid}/wda/keys`, { value: ["\u0008"] });
        } else if (msg.key === "enter") {
          await wdaFetch("POST", `/session/${sid}/wda/keys`, { value: ["\n"] });
        }
        break;
      }
      case "button": {
        // name: "home" | "volumeUp" | "volumeDown"
        await wdaFetch("POST", `/session/${sid}/wda/pressButton`, { name: msg.name });
        break;
      }
      case "appswitcher": {
        await wdaFetch("POST", `/session/${sid}/wda/pressButton`, { name: "home" });
        await wdaFetch("POST", `/session/${sid}/wda/pressButton`, { name: "home" });
        break;
      }
      default:
        break;
    }
  });
}

// ---------- Full-device video: WDA's MJPEG stream ----------
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

let videoReq = null;
let videoRes = null;
let videoRetryTimer = null;
let videoBackoffMs = 250;
let videoStableSince = 0;
const videoDrops = []; // timestamps of recent drops, for adaptive FPS

function scheduleVideoReconnect(reason) {
  if (videoRetryTimer) return;
  const delay = videoBackoffMs;
  videoBackoffMs = Math.min(videoBackoffMs * 2, 4000);
  videoRetryTimer = setTimeout(() => {
    videoRetryTimer = null;
    connectVideo();
  }, delay);
  if (reason) console.log(`[video] reconnect in ${delay}ms (${reason})`);
}

function destroyVideo(reason, fromReq = null, fromRes = null) {
  // Ignore late events from a connection we've already replaced.
  if (fromReq && videoReq && fromReq !== videoReq) return;
  if (fromRes && videoRes && fromRes !== videoRes) return;
  if (!videoReq && !videoRes && !videoConnected) {
    scheduleVideoReconnect(reason || "drop");
    return;
  }

  const wasConnected = videoConnected;
  const req = videoReq;
  const res = videoRes;
  videoReq = null;
  videoRes = null;
  if (req) req.destroy();
  if (res) res.destroy();

  videoConnected = false;
  if (wasConnected) {
    console.log("[video] MJPEG stream lost");
    broadcastStatus();
    const now = Date.now();
    videoDrops.push(now);
    while (videoDrops.length && now - videoDrops[0] > 30_000) videoDrops.shift();
    // Flapping → back off framerate so USB/iproxy can breathe.
    if (videoDrops.length >= 3 && activeFps > 15) {
      const next = Math.max(15, Math.round(activeFps * 0.7));
      if (next < activeFps) {
        activeFps = next;
        console.log(`[video] flapping — lowering mjpeg to ${activeFps}fps`);
        applyMjpegSettings().catch(() => {});
      }
    }
  }
  scheduleVideoReconnect(reason || "drop");
}

// The stream is multipart JPEG; we scan for SOI/EOI markers and emit whole frames.
function connectVideo() {
  if (videoReq || videoRes) return;

  const req = http.get(
    { host: "127.0.0.1", port: MJPEG_PORT, path: "/", timeout: 5000 },
    (res) => {
      if (videoReq !== req) { res.destroy(); return; }
      videoRes = res;
      videoConnected = true;
      videoBackoffMs = 250;
      videoStableSince = Date.now();
      console.log(`[video] MJPEG stream connected (${activeFps}fps)`);
      broadcastStatus();

      let buffer = Buffer.alloc(0);
      res.on("data", (chunk) => {
        if (buffer.length === 0) buffer = chunk;
        else buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 4_000_000) buffer = Buffer.alloc(0);

        while (true) {
          const start = buffer.indexOf(JPEG_SOI);
          if (start === -1) { buffer = Buffer.alloc(0); break; }
          if (start > 0) buffer = buffer.subarray(start);
          const end = buffer.indexOf(JPEG_EOI, 2);
          if (end === -1) break;
          const frame = buffer.subarray(0, end + 2);
          buffer = buffer.subarray(end + 2);
          relayFrame(frame);
        }
      });

      res.on("end", () => destroyVideo("end", req, res));
      res.on("error", () => destroyVideo("res-error", req, res));
      res.on("close", () => destroyVideo("close", req, res));
    }
  );

  videoReq = req;
  req.on("error", () => destroyVideo("req-error", req, null));
  req.on("timeout", () => destroyVideo("timeout", req, null));
}

// Climb back toward the target FPS after the link has been quiet.
setInterval(() => {
  if (!videoConnected || !videoStableSince) return;
  if (Date.now() - videoStableSince < 20_000) return;
  if (videoDrops.length > 0) return;
  if (activeFps >= MJPEG_FPS_TARGET) return;
  activeFps = Math.min(MJPEG_FPS_TARGET, activeFps + 5);
  videoStableSince = Date.now();
  console.log(`[video] stable — raising mjpeg to ${activeFps}fps`);
  applyMjpegSettings().catch(() => {});
}, 10_000);

// ---------- iproxy: tunnel the phone's WDA ports to localhost ----------
function startTunnel(port) {
  const proc = spawn("iproxy", [String(port), String(port)], { stdio: "ignore" });
  proc.on("error", (err) => {
    if (err.code === "ENOENT") console.log("[wda] iproxy not found (brew install libimobiledevice)");
  });
  proc.on("exit", () => setTimeout(() => startTunnel(port), 3000));
}
startTunnel(WDA_PORT);
startTunnel(MJPEG_PORT);

setInterval(probeWda, 3000);
connectVideo();

// ---------- throughput log ----------
setInterval(() => {
  if (frameCount > 0) {
    console.log(`~${(frameCount / 10).toFixed(1)} fps, ${viewers.size} viewer(s), wda=${wda.ready}`);
    frameCount = 0;
  }
}, 10_000);

server.listen(PORT, () => {
  console.log(`VoiceOS Connect (full-device) server running on port ${PORT}`);
  console.log(`  Viewer: http://localhost:${PORT}`);
});
