// Measure delivered framerate and frame size over a few seconds.
const WebSocket = require("ws");

const SECONDS = Number(process.argv[2] || 4);
const ws = new WebSocket("ws://localhost:8080/?role=viewer");
let frames = 0;
let bytes = 0;

ws.on("open", () => {
  setTimeout(() => {
    frames = 0; bytes = 0; // discard warm-up
    setTimeout(() => {
      console.log(`${(frames / SECONDS).toFixed(1)} fps, ${Math.round(bytes / Math.max(frames, 1) / 1024)} KB/frame, ${(bytes / SECONDS / 1024 / 1024).toFixed(1)} MB/s`);
      process.exit(0);
    }, SECONDS * 1000);
  }, 1000);
});

ws.on("message", (data, isBinary) => {
  if (isBinary) { frames++; bytes += data.length; }
});
ws.on("error", (e) => { console.error(e.message); process.exit(1); });
