/**
 * Dev-only end-to-end test: spawns server.ts over real MCP stdio (like
 * VoiceOS does) and runs ONE real Cursor agent against a scratch repo.
 *
 *   CURSOR_API_KEY=key_… bun e2e.ts                       # local runtime
 *   CURSOR_API_KEY=key_… GITHUB_REPO=https://github.com/you/repo bun e2e.ts cloud
 *
 * Local mode needs no GitHub anything — it edits /tmp/notch-coder-e2e.
 */
import { spawn, spawnSync } from "node:child_process";

const cloud = process.argv[2] === "cloud";
if (!process.env.CURSOR_API_KEY) {
  console.error("Set CURSOR_API_KEY first (cursor.com/dashboard → Integrations).");
  process.exit(1);
}
if (cloud && !process.env.GITHUB_REPO) {
  console.error("Cloud mode: set GITHUB_REPO to a GitHub URL you can push to.");
  process.exit(1);
}

// Scratch repo for the local run.
const SCRATCH = "/tmp/notch-coder-e2e";
if (!cloud) {
  spawnSync("rm", ["-rf", SCRATCH]);
  spawnSync("mkdir", ["-p", SCRATCH]);
  spawnSync("git", ["-C", SCRATCH, "init", "-q"]);
  await Bun.write(`${SCRATCH}/README.md`, "# Notch Coder E2E scratch repo\n");
  spawnSync("git", ["-C", SCRATCH, "add", "-A"]);
  spawnSync("git", ["-C", SCRATCH, "commit", "-qm", "init"]);
}

const child = spawn("bun", ["server.ts"], {
  cwd: import.meta.dir,
  env: { ...process.env, DEFAULT_REPO: SCRATCH, LEDGER_FILE: "/tmp/notch-coder-e2e-ledger.json" },
});
let buffer = "";
const pending = new Map<number, (msg: any) => void>();
let nextId = 1;
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (typeof msg.id === "number") pending.get(msg.id)?.(msg);
    } catch {}
  }
});
child.stderr.on("data", (c) => process.stderr.write(c));

function request(method: string, params?: unknown, timeoutMs = 600_000): Promise<any> {
  const id = nextId++;
  const promise = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return promise;
}

try {
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1.0.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const args = cloud
    ? {
        task: "Append the line 'Hello from Notch Coder (cloud)' to README.md",
        repo: process.env.GITHUB_REPO,
        use_cloud: true,
        open_pr: true,
      }
    : {
        task: "Append the line 'Hello from Notch Coder' to the end of README.md",
        repo: SCRATCH,
      };

  console.error(`\n→ starting ${cloud ? "CLOUD" : "LOCAL"} agent run (takes a minute or two)…\n`);
  const result = await request("tools/call", { name: "run_coding_agent", arguments: args });
  const payload = JSON.parse(result.content[0].text);
  console.error("\n=== RESULT ===");
  console.error("summary:", (payload.summary || "").slice(0, 500));
  console.error("diff:   ", payload.diff);
  console.error("prUrl:  ", payload.prUrl);
  console.error("glance blocks:", payload._voiceos_glance?.blocks?.length);

  if (!cloud) {
    console.error("\n=== SCRATCH REPO PROOF ===");
    console.error(spawnSync("cat", [`${SCRATCH}/README.md`]).stdout.toString());
    console.error(spawnSync("git", ["-C", SCRATCH, "diff", "--stat", "HEAD"]).stdout.toString());
  }
  console.error(payload.ok ? "\nE2E PASSED" : "\nE2E FAILED");
  process.exit(payload.ok ? 0 : 1);
} catch (err) {
  console.error("\nE2E FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  child.kill();
}
