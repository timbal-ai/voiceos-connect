/**
 * Smoke-test this integration: `bun verify.ts`.
 * Speaks real MCP over stdio to server.ts the way VoiceOS does. It rereads
 * voiceos.integration.json every run, checks tool parity, invokes safe preview
 * fixtures, and validates creator-owned glance cards. Exits non-zero on any
 * failure — run it after every change (AI agents: this is your feedback loop).
 *
 * The server is spawned with WA_PASSIVE=1: no WhatsApp socket, empty ledger.
 * A second live socket would conflict-kick the real session VoiceOS holds.
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const GLANCE_RESULT_KEY = "_voiceos_glance";
const manifest = JSON.parse(readFileSync(new URL("./voiceos.integration.json", import.meta.url), "utf8"));
const preview = JSON.parse(readFileSync(new URL("./voiceos.integration.preview.json", import.meta.url), "utf8"));
const expectedTools = (manifest.tools as Array<{ name: string; description?: string }>).map((t) => t.name).sort();

const child = spawn("bun", ["server.ts"], {
  cwd: import.meta.dir,
  env: { ...process.env, WA_PASSIVE: "1" },
});
let buffer = "";
let stderr = "";
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
    } catch {
      console.error("[verify] non-JSON on stdout:", line.slice(0, 120));
    }
  }
});
child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

function request(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  const promise = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${method}\n${stderr}`)),
      10_000,
    );
    pending.set(id, (msg) => {
      clearTimeout(timer);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return promise;
}

const checks: Array<{ name: string; ok: boolean; note?: string }> = [];
function check(name: string, ok: boolean, note?: string) {
  checks.push({ name, ok, ...(note ? { note } : {}) });
  console.error(`${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
}

function extractTextContent(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("\n");
}

function extractGlance(result: any): { blocks?: unknown[] } | null {
  const text = extractTextContent(result);
  if (!text.includes(GLANCE_RESULT_KEY)) return null;
  try {
    const parsed = JSON.parse(text);
    const glance = parsed?.[GLANCE_RESULT_KEY];
    return glance && Array.isArray(glance.blocks) ? glance : null;
  } catch {
    return null;
  }
}

try {
  check("manifest schema version is v1", manifest.schemaVersion === 1);
  check("preview fixture schema version is v1", preview.schemaVersion === 1);

  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "voiceos-verify", version: "1.0.0" },
  });
  check("initialize handshake", !!init.serverInfo?.name);
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );

  const listed = await request("tools/list");
  const names = (listed.tools as Array<{ name: string }>).map((t) => t.name).sort();
  check(
    "tools match voiceos.integration.json",
    JSON.stringify(names) === JSON.stringify(expectedTools),
    names.join(", ") || "none",
  );

  for (const tool of listed.tools as Array<{ name: string; description?: string }>) {
    check(
      `${tool.name} has a model-facing description`,
      (tool.description?.trim().length ?? 0) >= 20,
    );
  }

  for (const toolName of expectedTools) {
    const fixture = preview.tools?.[toolName];
    if (!fixture) {
      check(`${toolName} has a preview fixture`, false);
      continue;
    }
    const result = await request("tools/call", {
      name: toolName,
      arguments: fixture.args ?? {},
    });
    check(`${toolName} preview call returns text`, extractTextContent(result).trim().length > 0);
    const glance = extractGlance(result);
    check(
      `${toolName} preview call returns 1-3 glance blocks`,
      !!glance && Array.isArray(glance.blocks) && glance.blocks.length >= 1 && glance.blocks.length <= 3,
    );
  }
} catch (err) {
  check("verify run", false, err instanceof Error ? err.message : String(err));
} finally {
  child.kill();
}

const failed = checks.filter((c) => !c.ok);
const verdict = JSON.stringify({ ok: failed.length === 0, checks });
console.log(verdict);
if (process.env.VERIFY_OUT) await Bun.write(process.env.VERIFY_OUT, verdict);
process.exit(failed.length === 0 ? 0 : 1);
