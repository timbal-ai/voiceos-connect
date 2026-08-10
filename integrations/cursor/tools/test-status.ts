/** Calls agent_status over real MCP with the key present, prints merged view. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const DIR = "/Users/dberges/Desktop/timbal-ai/notch-coder";
const key = readFileSync(`${DIR}/.env`, "utf8").match(/CURSOR_API_KEY=(.+)/)?.[1]?.trim();
const child = spawn("bun", ["server.ts"], { cwd: DIR, env: { ...process.env, CURSOR_API_KEY: key } });
let buffer = "";
const pending = new Map<number, (m: any) => void>();
let nextId = 1;
child.stdout.on("data", (c) => {
  buffer += c.toString();
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (typeof m.id === "number") pending.get(m.id)?.(m);
    } catch {}
  }
});
function req(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  const p = new Promise<any>((res, rej) => {
    setTimeout(() => rej(new Error("timeout")), 20000);
    pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
}
await req("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const r = await req("tools/call", { name: "agent_status", arguments: {} });
const payload = JSON.parse(r.content[0].text);
console.log("running:", payload.running, "| ledger runs:", payload.totalRuns);
console.log("cloud agents:", JSON.stringify(payload.cloudAgents, null, 1).slice(0, 800));
console.log("glance rows:", payload._voiceos_glance.blocks.at(-1).rows?.map((r: any) => r.title + " [" + (r.badge?.text ?? r.trailing ?? "") + "]"));
child.kill();
process.exit(0);
