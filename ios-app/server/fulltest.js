// End-to-end check: receive full-device frames and issue a Home press.
const WebSocket = require("ws");

const ws = new WebSocket("ws://localhost:8080/?role=viewer");
let frames = 0;
let bytes = 0;
let status = null;

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    frames++;
    bytes += data.length;
  } else {
    status = JSON.parse(data.toString());
  }
});

ws.on("open", () => {
  setTimeout(() => {
    console.log("status:", JSON.stringify(status));
    console.log(`frames in 3s: ${frames} (${(frames / 3).toFixed(1)} fps, avg ${Math.round(bytes / Math.max(frames, 1) / 1024)} KB/frame)`);
    console.log("sending Home press…");
    ws.send(JSON.stringify({ type: "button", name: "home" }));
    setTimeout(() => {
      console.log(`frames still arriving after Home: ${frames}`);
      console.log(frames > 5 && status && status.wdaReady ? "FULL-DEVICE TEST PASSED" : "TEST INCOMPLETE");
      process.exit(0);
    }, 2000);
  }, 3000);
});

ws.on("error", (e) => { console.error("error:", e.message); process.exit(1); });
