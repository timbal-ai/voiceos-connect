// Benchmark raw WebDriverAgent gesture latency, independent of our server.
// Run with the viewer server stopped to avoid fighting over the WDA session.
const WDA = "http://127.0.0.1:8100";

async function post(path, body) {
  const r = await fetch(WDA + path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || (j.value && j.value.error)) {
    throw new Error(`${path} -> ${r.status} ${JSON.stringify(j.value).slice(0, 160)}`);
  }
  return j;
}

(async () => {
  const s = await post("/session", { capabilities: { alwaysMatch: {}, firstMatch: [{}] } });
  const sid = s.sessionId || (s.value && s.value.sessionId);
  await post(`/session/${sid}/appium/settings`, {
    settings: { waitForIdleTimeout: 0, animationCoolOffTimeout: 0 },
  });
  const size = await (await fetch(`${WDA}/session/${sid}/window/size`)).json();
  const cx = Math.round(size.value.width / 2);
  const cy = Math.round(size.value.height * 0.12); // near top, harmless

  const time = async (label, fn) => {
    const ts = [];
    for (let i = 0; i < 6; i++) {
      const t0 = Date.now();
      await fn();
      ts.push(Date.now() - t0);
    }
    ts.sort((a, b) => a - b);
    console.log(`${label}: median ${ts[3]}ms  (${ts.join(", ")})`);
  };

  // A tap with the client-side pause.
  await time("tap w/ 25ms pause", () => post(`/session/${sid}/actions`, {
    actions: [{ type: "pointer", id: "f", parameters: { pointerType: "touch" }, actions: [
      { type: "pointerMove", duration: 0, x: cx, y: cy },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: 25 },
      { type: "pointerUp", button: 0 },
    ] }],
  }));

  // A tap with no pause at all.
  await time("tap no pause     ", () => post(`/session/${sid}/actions`, {
    actions: [{ type: "pointer", id: "f", parameters: { pointerType: "touch" }, actions: [
      { type: "pointerMove", duration: 0, x: cx, y: cy },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
    ] }],
  }));

  // Does each coordinate cost extra? If a 10-point path costs the same as a
  // 2-point one, the latency is fixed IPC overhead and patching coordinate
  // resolution in WDA would buy us nothing.
  const path = (n) => {
    const acts = [{ type: "pointerMove", duration: 0, x: cx, y: cy }, { type: "pointerDown", button: 0 }];
    for (let i = 1; i <= n; i++) {
      acts.push({ type: "pointerMove", duration: 10, x: cx, y: cy + i });
    }
    acts.push({ type: "pointerUp", button: 0 });
    return { actions: [{ type: "pointer", id: "f", parameters: { pointerType: "touch" }, actions: acts }] };
  };
  await time("swipe 2 points   ", () => post(`/session/${sid}/actions`, path(1)));
  await time("swipe 20 points  ", () => post(`/session/${sid}/actions`, path(20)));

  // Typing a whole word in one call vs the per-key cost.
  await time("keys 'hello'     ", () => post(`/session/${sid}/wda/keys`, { value: ["h","e","l","l","o"] }));
  await time("keys 'h'         ", () => post(`/session/${sid}/wda/keys`, { value: ["h"] }));

  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
