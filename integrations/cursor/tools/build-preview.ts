/**
 * Builds a standalone browser preview of the session widget so you can iterate
 * on the UI/UX without VoiceOS or a real agent run.
 *
 *   bun tools/build-preview.ts && open tools/preview.html
 *
 * Buttons switch between Running / Done and Dark / Light. The widget is the
 * exact session-widget.html the server ships, hosted in a sandboxed iframe that
 * speaks the real voiceos:init / resize / openUrl bridge.
 */
import { readFileSync, writeFileSync } from "node:fs";

const widget = readFileSync(new URL("../session-widget.html", import.meta.url), "utf8");

const running = {
  status: "running",
  repo: "voiceos-demo",
  runtime: "local",
  elapsed: "1m 24s",
  events: [
    { label: "thinking", kind: "thinking" },
    { label: "reading src/settings.tsx", kind: "read" },
    { label: "grepping for theme", kind: "grep" },
    { label: "editing src/settings.tsx", kind: "edit" },
    { label: "editing src/theme.ts", kind: "edit" },
    { label: "running tests", kind: "shell" },
  ],
};

const done = {
  status: "done",
  repo: "voiceos-demo",
  runtime: "local",
  model: "composer-2.5",
  events: [
    { label: "reading src/settings.tsx", kind: "read" },
    { label: "editing src/settings.tsx", kind: "edit" },
    { label: "creating src/theme.ts", kind: "write" },
    { label: "running tests", kind: "shell" },
    { label: "writing summary", kind: "assistant" },
  ],
  insertions: 128,
  deletions: 24,
  files: [
    { name: "src/settings.tsx", added: 63, removed: 12 },
    { name: "src/theme.ts", added: 51, removed: 0 },
    { name: "src/app.tsx", added: 14, removed: 12 },
  ],
  summary: "Added a dark-mode toggle to the settings page.",
  prUrl: "https://github.com/timbal-ai/voiceos-demo/pull/2",
  prNumber: 2,
};

const page = `<!doctype html>
<meta charset="utf-8" />
<title>Cursor widget preview</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; gap:20px;
         background:#0b0b0d; font:14px -apple-system,system-ui,sans-serif; color:#aaa;
         transition:background .2s; }
  body.light { background:#e9e9ee; color:#555; }
  .bar { display:flex; gap:8px; }
  button { padding:8px 14px; border-radius:9px; border:1px solid #333; background:#17181c;
           color:#ddd; font-weight:600; cursor:pointer; }
  body.light button { background:#fff; border-color:#ccc; color:#333; }
  button.on { background:#8b5cf6; border-color:#8b5cf6; color:#fff; }
  .stage { width:360px; border-radius:26px; overflow:hidden;
           background:linear-gradient(#1a1b1f,#101114);
           box-shadow:0 20px 60px rgba(0,0,0,.6); border:1px solid rgba(255,255,255,.08); }
  body.light .stage { background:#fff; box-shadow:0 20px 60px rgba(0,0,0,.15); border-color:rgba(0,0,0,.08); }
  iframe { width:100%; border:0; display:block; }
  .hint { font-size:12px; opacity:.6; }
</style>
<div class="bar">
  <button id="bRun" class="on" onclick="setState('running')">Running</button>
  <button id="bDone" onclick="setState('done')">Done</button>
  <span style="width:14px"></span>
  <button id="bDark" class="on" onclick="setTheme('dark')">Dark</button>
  <button id="bLight" onclick="setTheme('light')">Light</button>
</div>
<div class="stage"><iframe id="w" sandbox="allow-scripts"></iframe></div>
<div class="hint">Exact session-widget.html in a sandboxed iframe. openUrl clicks log to console.</div>
<script>
  var WIDGET = ${JSON.stringify(widget)};
  var DATA = { running: ${JSON.stringify(running)}, done: ${JSON.stringify(done)} };
  var state = "running", theme = "dark";
  var f = document.getElementById("w");
  function post(){
    f.contentWindow.postMessage({ type:"voiceos:init", data:DATA[state], theme:{mode:theme}, radius:26 }, "*");
  }
  function load(){ f.onload = function(){ setTimeout(post, 30); }; f.srcdoc = WIDGET; }
  window.addEventListener("message", function(e){
    var m = e.data || {};
    if (m.type === "voiceos:resize") f.style.height = m.height + "px";
    if (m.type === "voiceos:openUrl") console.log("openUrl →", m.url);
  });
  function setState(s){ state=s; document.getElementById("bRun").className = s==="running"?"on":"";
    document.getElementById("bDone").className = s==="done"?"on":""; load(); }
  function setTheme(t){ theme=t; document.body.className = t==="light"?"light":"";
    document.getElementById("bDark").className = t==="dark"?"on":"";
    document.getElementById("bLight").className = t==="light"?"on":""; load(); }
  load();
</script>`;

writeFileSync(new URL("./preview.html", import.meta.url), page);
console.log("wrote tools/preview.html — run:  open tools/preview.html");
