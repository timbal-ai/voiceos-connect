/**
 * Fire any tool at the real MCP server from the terminal — no voice needed.
 *
 *   bun tools/try.ts list_repos
 *   bun tools/try.ts focus_repo repo=voiceos-demo
 *   bun tools/try.ts ask_cursor question="what does this repo do"
 *   bun tools/try.ts run_coding_agent task="add a comment to the readme"
 *
 * key=value pairs become tool args (true/false/numbers are coerced). The API
 * key is read from .env automatically. Prints the model-facing JSON plus a
 * summary of the glance card so you can see both halves of the result.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const [tool, ...pairs] = process.argv.slice(2);
if (!tool) {
  console.error("usage: bun tools/try.ts <tool> [key=value ...]");
  console.error("tools: list_repos, focus_repo, ask_cursor, run_coding_agent, agent_status");
  process.exit(1);
}

const args: Record<string, unknown> = {};
for (const p of pairs) {
  const i = p.indexOf("=");
  const k = p.slice(0, i);
  let v: unknown = p.slice(i + 1);
  if (v === "true") v = true;
  else if (v === "false") v = false;
  else if (typeof v === "string" && v !== "" && !isNaN(Number(v))) v = Number(v);
  args[k] = v;
}

// Load .env so real runs have the key.
const env: Record<string, string> = { ...process.env } as Record<string, string>;
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} catch {}

const dir = new URL("..", import.meta.url).pathname;
const child = spawn("bun", ["server.ts"], { cwd: dir, env });
let buf = "";
const pending = new Map<number, (m: any) => void>();
let nextId = 1;
child.stdout.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (typeof m.id === "number") pending.get(m.id)?.(m);
    } catch {}
  }
});
child.stderr.on("data", (c) => process.stderr.write(c));

function req(method: string, params?: unknown, timeoutMs = 600_000): Promise<any> {
  const id = nextId++;
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout on ${method}`)), timeoutMs);
    pending.set(id, (m) => {
      clearTimeout(t);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const GLYPH: Record<string, string> = { good: "🟢", bad: "🔴", neutral: "⚪" };

function summarizeGlance(blocks: any[]) {
  console.log("\n\x1b[2m── card ──────────────────────────\x1b[0m");
  for (const b of blocks) {
    if (b.type === "header") console.log(`\x1b[1m${b.title}\x1b[0m  ${b.trailing ?? ""}`);
    else if (b.type === "keyValue")
      for (const [k, v] of b.pairs) console.log(`  ${k}: \x1b[36m${v}\x1b[0m`);
    else if (b.type === "list")
      for (const r of b.rows)
        console.log(`  • ${r.title}${r.badge ? `  [${GLYPH[r.badge.tone] ?? ""}${r.badge.text}]` : ""}${r.subtitle ? `\n      \x1b[2m${r.subtitle}\x1b[0m` : ""}`);
    else if (b.type === "widget")
      console.log(`  \x1b[35m[widget]\x1b[0m ${b.label} — status=${b.data?.status} events=${b.data?.events?.length ?? 0} +${b.data?.insertions ?? 0}/-${b.data?.deletions ?? 0}${b.data?.prUrl ? ` PR=${b.data.prUrl}` : ""}`);
    else console.log(`  [${b.type}]`);
  }
  console.log("\x1b[2m──────────────────────────────────\x1b[0m");
}

try {
  await req("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "try", version: "1.0.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  console.log(`\x1b[1m→ ${tool}\x1b[0m ${JSON.stringify(args)}`);
  const r = await req("tools/call", { name: tool, arguments: args });
  const payload = JSON.parse(r.content[0].text);
  const glance = payload._voiceos_glance;
  delete payload._voiceos_glance;

  console.log("\n\x1b[2m── data the model narrates ──────\x1b[0m");
  console.log(JSON.stringify(payload, null, 2));
  if (glance?.blocks) summarizeGlance(glance.blocks);
  process.exit(0);
} catch (e) {
  console.error("\n\x1b[31m✗\x1b[0m", e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  child.kill();
}
