/**
 * Phone, a VoiceOS integration server (standard MCP over stdio).
 *
 * Speak a phone task into the notch; the iPhone Mirroring window snaps to
 * top-center (the notch visually grows a live phone) and the voiceos-connect
 * computer-use agent operates it. All heavy lifting lives in ../mac (Python);
 * this server shells out to `python -m agent.phone_tool`.
 *
 * Keep tool names in sync with voiceos.integration.json and run
 * `bun verify.ts` after every change.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// --- VoiceOS glance helper ---------------------------------------------------
type GlanceBlock = Record<string, unknown> & { type: string };
function glanceResult(blocks: GlanceBlock[]) {
  if (blocks.length === 0 || blocks.length > 3) {
    throw new Error("glanceResult: pass 1-3 blocks");
  }
  return { _voiceos_glance: { blocks } };
}

const jsonResult = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload) }],
});

const trim = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

// --- Python bridge ------------------------------------------------------------
const MAC_DIR = fileURLToPath(new URL("../../mac/", import.meta.url));
const PYTHON = join(MAC_DIR, ".venv", "bin", "python3");

type PhoneRun = {
  code: number;
  narration: string[];
  steps: number;
  resultJson: Record<string, unknown> | null;
  stderr: string;
};

async function runPhoneTool(args: string[]): Promise<PhoneRun> {
  if (!existsSync(PYTHON)) {
    throw new Error(`Python venv missing at ${PYTHON} - run the mac/ quickstart first.`);
  }
  const proc = Bun.spawn([PYTHON, "-u", "-m", "agent.phone_tool", ...args], {
    cwd: MAC_DIR,
    env: process.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const narration: string[] = [];
  let steps = 0;
  let resultJson: Record<string, unknown> | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("SAY: ")) narration.push(line.slice(5).trim());
    else if (line.startsWith("STEP ")) steps += 1;
    else if (line.startsWith("RESULT_JSON:")) {
      try {
        resultJson = JSON.parse(line.slice("RESULT_JSON:".length));
      } catch {
        /* covered by code/stderr checks */
      }
    }
  }
  return { code, narration, steps, resultJson, stderr: err };
}

// --- Server -------------------------------------------------------------------
const server = new McpServer({ name: "voiceos-phone", version: "1.0.0" });

server.registerTool(
  "use_phone",
  {
    description:
      "Operate the user's iPhone through iPhone Mirroring: the phone appears live under the notch and the agent taps, swipes, and types on it. Use when the user asks to do anything on their phone or mobile - check or clean up notifications, send a WhatsApp or message, open a phone app, 'on my phone' / 'on my mobile' requests. The phone must be locked and near this Mac.",
    inputSchema: {
      task: z.string().describe("What to do on the phone. Keep the user's wording."),
      dry_run: z
        .boolean()
        .optional()
        .describe("Validate the setup without touching the phone."),
    },
  },
  async ({ task, dry_run }) => {
    if (dry_run) {
      const run = await runPhoneTool(["--dry-run", task]);
      if (run.code !== 0 || !run.resultJson) {
        throw new Error(`dry run failed: ${trim(run.stderr, 300)}`);
      }
      const checks = (run.resultJson.checks ?? {}) as Record<string, boolean>;
      const allOk = Object.values(checks).every(Boolean);
      return jsonResult({
        ...run.resultJson,
        ...glanceResult([
          { type: "header", icon: "phone", title: allOk ? "Phone setup looks good" : "Phone setup incomplete" },
          {
            type: "badges",
            items: Object.entries(checks)
              .slice(0, 3)
              .map(([k, v]) => ({ text: trim(k.replaceAll("_", " "), 20), tone: v ? "good" : "bad" })),
          },
        ]),
      });
    }

    const run = await runPhoneTool([task]);
    if (run.code !== 0 || !run.resultJson) {
      throw new Error(
        `phone task failed: ${trim(run.stderr || run.narration.at(-1) || "unknown error", 300)}`,
      );
    }
    const result = String(run.resultJson.result ?? "Done.");
    return jsonResult({
      task,
      result,
      steps: run.resultJson.steps ?? run.steps,
      narration: run.narration.slice(-6),
      ...glanceResult([
        { type: "header", icon: "phone", title: "iPhone task finished" },
        {
          type: "keyValue",
          pairs: [
            ["Task", trim(task, 60)],
            ["Steps", String(run.resultJson.steps ?? run.steps)],
            ["Outcome", trim(result, 60)],
          ],
        },
      ]),
    });
  },
);

server.registerTool(
  "phone_status",
  {
    description:
      "Check whether the iPhone Mirroring window is currently connected and visible on this Mac. Use when the user asks 'is my phone connected', 'can you see my phone', or before suggesting a phone task if unsure.",
    inputSchema: {},
  },
  async () => {
    if (!existsSync(PYTHON)) {
      throw new Error(`Python venv missing at ${PYTHON} - run the mac/ quickstart first.`);
    }
    const proc = Bun.spawn([PYTHON, "-u", "-m", "agent.phone_tool", "--status"], {
      cwd: MAC_DIR,
      env: process.env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    let window: number[] | null = null;
    try {
      window = JSON.parse(out.trim()).window;
    } catch {
      window = null;
    }
    const connected = Array.isArray(window);
    return jsonResult({
      connected,
      window,
      ...glanceResult([
        {
          type: "header",
          icon: "phone",
          title: connected ? "iPhone connected" : "iPhone not connected",
          trailing: connected ? "live" : undefined,
        },
        {
          type: "badges",
          items: [
            connected
              ? { text: "mirroring active", tone: "good" }
              : { text: "say: connect my phone", tone: "neutral" },
          ],
        },
      ]),
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
