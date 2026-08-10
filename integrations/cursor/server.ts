/**
 * Cursor, a VoiceOS integration server (standard MCP over stdio).
 *
 * Speak a coding task into the notch; a Cursor agent (via @cursor/sdk) makes
 * the changes and can open a PR. Two runtimes:
 *   - local: repo is a path on this Mac, agent edits the working tree.
 *   - cloud: repo is a GitHub URL, agent runs on a Cursor-hosted VM
 *     (native autoCreatePR support).
 * Keep tool names in sync with voiceos.integration.json and run
 * `bun verify.ts` after every change. See AGENTS.md.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

// --- VoiceOS glance helper (inlined; see the VoiceOS integration SDK) -------
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

// Per-field caps: over-cap strings get the whole block dropped, so pre-trim.
const trim = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

// --- Run ledger (survives reloads; agent_status reads it) --------------------
type RunRecord = {
  id: string;
  task: string;
  repo: string;
  runtime: "local" | "cloud";
  openPr: boolean;
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  prUrl?: string;
  diff?: string;
  agentId?: string;
  runId?: string;
  activity?: string;
  events?: Array<{ label: string; kind: string }>;
  startSha?: string;
};

// LEDGER_FILE override keeps dev/test runs (e2e.ts) out of the user's real history.
const LEDGER = process.env.LEDGER_FILE
  ? new URL(`file://${process.env.LEDGER_FILE}`)
  : new URL("./agent-runs.json", import.meta.url);
const FOCUS_FILE = new URL("./focus.json", import.meta.url);

/** The repo the user is currently working on; set via focus_repo, sticky across turns. */
async function loadFocus(): Promise<string | null> {
  try {
    const { repo } = JSON.parse(await Bun.file(FOCUS_FILE).text());
    return repo && existsSync(repo) ? repo : null;
  } catch {
    return null;
  }
}
async function saveFocus(repo: string) {
  await Bun.write(FOCUS_FILE, JSON.stringify({ repo }, null, 2));
}

async function loadRuns(): Promise<RunRecord[]> {
  try {
    return JSON.parse(await Bun.file(LEDGER).text());
  } catch {
    return [];
  }
}

async function saveRun(record: RunRecord) {
  const runs = await loadRuns();
  const i = runs.findIndex((r) => r.id === record.id);
  if (i >= 0) runs[i] = record;
  else runs.push(record);
  await Bun.write(LEDGER, JSON.stringify(runs, null, 2));
}

function elapsedLabel(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Human label for what the agent is doing right now, from a stream message. */
function activityFrom(msg: any): string | null {
  if (msg?.type === "thinking") return "thinking";
  if (msg?.type === "assistant") return "writing summary";
  if (msg?.type === "tool_call" && msg.status === "running") {
    const verbs: Record<string, string> = {
      shell: "running command",
      read: "reading",
      edit: "editing",
      write: "writing",
      grep: "searching",
      glob: "scanning files",
      ls: "listing files",
      delete: "deleting",
      task: "delegating",
      webSearch: "searching the web",
      webFetch: "fetching docs",
      updateTodos: "planning",
    };
    const a = msg.args as Record<string, unknown> | undefined;
    const file = a?.path ?? a?.file_path ?? a?.filePath ?? a?.target_file ?? a?.file;
    const verb = verbs[msg.name] ?? msg.name;
    return file ? `${verb} ${basename(String(file))}` : verb;
  }
  return null;
}

function agoLabel(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

function gitShortstat(repo: string, base?: string): string {
  try {
    const proc = Bun.spawnSync(["git", "-C", repo, "diff", "--shortstat", base || "HEAD"]);
    return proc.stdout.toString().trim();
  } catch {
    return "";
  }
}

type FileChange = { name: string; added: number; removed: number };

function gitHead(repo: string): string {
  try {
    return Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
  } catch {
    return "";
  }
}

/** Per-file line stats since `base` (a commit sha): tracked changes (committed
 * or not) plus brand-new untracked files, which `git diff` never shows. Handles
 * repos with no commits yet (base empty). */
function gitNumstat(repo: string, base?: string): { files: FileChange[]; insertions: number; deletions: number } {
  const files: FileChange[] = [];
  let insertions = 0;
  let deletions = 0;
  const seen = new Set<string>();

  if (base) {
    try {
      const out = Bun.spawnSync(["git", "-C", repo, "diff", "--numstat", base]).stdout.toString().trim();
      for (const line of out ? out.split("\n") : []) {
        const [a, r, ...rest] = line.split("\t");
        const name = rest.join("\t");
        const added = a === "-" ? 0 : parseInt(a, 10) || 0;
        const removed = r === "-" ? 0 : parseInt(r, 10) || 0;
        files.push({ name, added, removed });
        seen.add(name);
        insertions += added;
        deletions += removed;
      }
    } catch {}
  }

  try {
    const others = Bun.spawnSync(["git", "-C", repo, "ls-files", "--others", "--exclude-standard"])
      .stdout.toString()
      .trim();
    for (const name of others ? others.split("\n") : []) {
      if (seen.has(name)) continue;
      let added = 0;
      try {
        const text = readFileSync(join(repo, name), "utf8");
        added = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
      } catch {}
      files.push({ name, added, removed: 0 });
      insertions += added;
    }
  } catch {}

  files.sort((a, b) => b.added + b.removed - (a.added + a.removed));
  return { files, insertions, deletions };
}

/** GitHub https URL for a local repo's origin remote, or null if not on GitHub. */
function githubRemote(repo: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "-C", repo, "remote", "get-url", "origin"]);
    const raw = proc.stdout.toString().trim();
    if (!raw) return null;
    // git@github.com:org/repo.git  ->  https://github.com/org/repo
    const ssh = raw.match(/git@github\.com:(.+?)(?:\.git)?$/);
    if (ssh) return `https://github.com/${ssh[1]}`;
    const https = raw.match(/https:\/\/github\.com\/(.+?)(?:\.git)?$/);
    if (https) return `https://github.com/${https[1]}`;
    return null;
  } catch {
    return null;
  }
}

const isUrl = (s: string) => /^https?:\/\//.test(s) || s.startsWith("git@");
const repoLabel = (repo: string) =>
  isUrl(repo) ? repo.replace(/\.git$/, "").split("/").slice(-2).join("/") : basename(repo);

// --- Repo discovery -----------------------------------------------------------
type Repo = { name: string; path: string; mtime: number };

function scanDirs(): string[] {
  const raw = process.env.SCAN_DIRS?.trim() || "~/Desktop/timbal-ai,~/Projects,~/Developer";
  return raw
    .split(",")
    .map((d) => d.trim().replace(/^~/, homedir()))
    .filter(Boolean);
}

function findRepos(): Repo[] {
  const repos: Repo[] = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    try {
      repos.push({ name: basename(path), path, mtime: statSync(path).mtimeMs });
    } catch {}
  };
  for (const root of scanDirs()) {
    if (!existsSync(root)) continue;
    if (existsSync(join(root, ".git"))) add(root);
    let children: string[] = [];
    try {
      children = readdirSync(root);
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.startsWith(".") || child === "node_modules") continue;
      const p = join(root, child);
      try {
        if (existsSync(join(p, ".git"))) add(p);
      } catch {}
    }
  }
  return repos.sort((a, b) => b.mtime - a.mtime);
}

const normName = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".venv", "venv", "target", ".turbo", "vendor", ".cache",
]);

/** Bounded search for a directory named like `ref` anywhere under the scan
 * roots (up to 4 deep) — finds nested folders like timbal/ace that the shallow
 * repo scan misses. Exact beats prefix beats substring, shallower beats deeper. */
function resolveLocalByName(ref: string): string | null {
  const needle = normName(ref);
  let frontier = scanDirs().filter(existsSync).map((d) => ({ dir: d }));
  let budget = 20000;
  // Breadth-first: shallower matches win and are reached before deep descent.
  for (let depth = 1; depth <= 4 && frontier.length && budget > 0; depth++) {
    const next: Array<{ dir: string }> = [];
    const matches: Array<{ path: string; tier: number }> = [];
    for (const { dir } of frontier) {
      if (budget <= 0) break;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (budget-- <= 0) break;
        if (e.startsWith(".") || SKIP_DIRS.has(e)) continue;
        const p = join(dir, e);
        let isDir = false;
        try {
          isDir = statSync(p).isDirectory();
        } catch {}
        if (!isDir) continue;
        const n = normName(e);
        const tier = n === needle ? 0 : n.startsWith(needle) ? 1 : n.includes(needle) ? 2 : -1;
        if (tier >= 0) matches.push({ path: p, tier });
        next.push({ dir: p });
      }
    }
    if (matches.length) {
      matches.sort((a, b) => a.tier - b.tier);
      return matches[0].path;
    }
    frontier = next;
  }
  return null;
}

/** Resolve a spoken repo reference: URL and absolute paths pass through; bare
 * names match top-level repos first (exact > prefix > substring), then any
 * nested folder by name. Ambiguity among top-level repos throws. Returns null
 * if nothing local matches (caller may then try cloud repos). */
function resolveRepoRefOrNull(ref: string): string | null {
  if (isUrl(ref) || ref.startsWith("/") || ref.startsWith("~")) {
    return ref.replace(/^~/, homedir());
  }
  const repos = findRepos();
  const needle = normName(ref);
  const exact = repos.filter((r) => normName(r.name) === needle);
  if (exact.length >= 1) return exact[0].path;
  const prefix = repos.filter((r) => normName(r.name).startsWith(needle));
  const substr = repos.filter((r) => normName(r.name).includes(needle));
  const tier = prefix.length > 0 ? prefix : substr;
  if (tier.length === 1) return tier[0].path;
  if (tier.length > 1) {
    throw new Error(
      `"${ref}" is ambiguous: ${tier.slice(0, 5).map((r) => r.name).join(", ")}. Say the full repo name.`,
    );
  }
  // No top-level repo — search nested folders (finds timbal/ace, etc.).
  return resolveLocalByName(ref);
}

function resolveRepoRef(ref: string): string {
  const local = resolveRepoRefOrNull(ref);
  if (local) return local;
  const known = findRepos().slice(0, 8).map((r) => r.name).join(", ");
  throw new Error(
    `No repo matching "${ref}". Known repos: ${known || "none found"}. Say list repos to browse.`,
  );
}

// --- Session widget (HTML lives in session-widget.html, shared with the
// browser preview harness in tools/preview so both render identically). ----
const SESSION_WIDGET_HTML = readFileSync(
  new URL("./session-widget.html", import.meta.url),
  "utf8",
);

function sessionWidgetBlock(data: Record<string, unknown>): GlanceBlock {
  const done = data.status === "done" || data.status === "failed";
  const events = Array.isArray(data.events) ? data.events.length : 0;
  const files = Array.isArray(data.files) ? data.files.length : 0;
  const height = done
    ? Math.min(420, 150 + Math.min(events, 14) * 22 + Math.min(files, 6) * 26 + (data.prUrl ? 48 : 0))
    : Math.min(360, 110 + Math.min(events, 14) * 24);
  return { type: "widget", html: SESSION_WIDGET_HTML, height, data, label: "Cursor session" };
}

// --- Live run registry (this stdio server is one long-lived process, so
// in-flight runs are reachable from a later cancel/continue tool call). --------
const liveRuns = new Map<string, { run: any; record: RunRecord }>();

/** A red "couldn't do it" card that reads as intentional, not broken. */
function errorResult(message: string) {
  return jsonResult({
    ok: false,
    error: message,
    ...glanceResult([
      { type: "header", title: "Cursor", appIcon: "cursor", icon: "x", trailing: "Failed" },
      { type: "keyValue", pairs: [["Error", trim(message, 64)]] },
      { type: "badges", items: [{ text: "Failed", tone: "bad" }] },
    ]),
  });
}

/** Stream an in-flight run into the ledger, then return the completion card.
 * Shared by run_coding_agent (fresh agent) and continue_agent (resumed). */
async function streamToCompletion(opts: {
  agent: any;
  run: any;
  record: RunRecord;
  cloud: boolean;
  model: string;
  repoName: string;
  resolvedRepo: string;
  task: string;
}) {
  const { agent, run, record, cloud, model, repoName, resolvedRepo } = opts;
  record.runId = run.id;
  liveRuns.set(record.agentId || record.id, { run, record });
  await saveRun(record);

  let result;
  try {
    let lastWrite = 0;
    for await (const msg of run.stream()) {
      const activity = activityFrom(msg);
      if (activity && activity !== record.activity) {
        record.activity = activity;
        record.events = record.events || [];
        const kind = (msg as any).type === "tool_call" ? (msg as any).name : (msg as any).type;
        record.events.push({ label: activity, kind });
        if (record.events.length > 40) record.events = record.events.slice(-40);
        const now = Date.now();
        if (now - lastWrite > 800) {
          lastWrite = now;
          await saveRun(record);
        }
      }
    }
    result = await run.wait();
  } catch (err) {
    if (record.status !== "cancelled") {
      record.status = "failed";
      record.summary = err instanceof Error ? err.message : String(err);
    }
    record.finishedAt = new Date().toISOString();
    record.activity = undefined;
    await saveRun(record);
    if (record.status === "cancelled") return errorResult("Agent cancelled.");
    return errorResult(record.summary || "The agent run failed.");
  } finally {
    liveRuns.delete(record.agentId || record.id);
    await agent?.[Symbol.asyncDispose]?.().catch(() => {});
  }

  const finalText = typeof result.result === "string" ? result.result : "";
  record.finishedAt = new Date().toISOString();
  record.activity = undefined;
  record.summary = finalText.trim();
  record.prUrl =
    result.git?.branches?.find((b: any) => b.prUrl)?.prUrl ??
    finalText.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];

  const stats = cloud ? { files: [], insertions: 0, deletions: 0 } : gitNumstat(resolvedRepo, record.startSha);
  if (!cloud)
    record.diff = `${stats.files.length} file${stats.files.length === 1 ? "" : "s"}, +${stats.insertions} -${stats.deletions}`;

  if (result.status !== "finished") {
    record.status = "failed";
    await saveRun(record);
    return errorResult(
      `Agent ended with status "${result.status}". ${result.error?.message || record.summary || ""}`.trim(),
    );
  }
  record.status = "done";
  await saveRun(record);

  const prNumber = record.prUrl ? Number(record.prUrl.match(/\/pull\/(\d+)/)?.[1]) || 0 : 0;
  const widgetData = {
    status: "done",
    repo: repoName,
    runtime: cloud ? "cloud" : "local",
    model,
    events: (record.events || []).slice(-14),
    insertions: stats.insertions,
    deletions: stats.deletions,
    files: stats.files.slice(0, 6),
    summary: trim(record.summary || "Done.", 200),
    prUrl: record.prUrl || "",
    prNumber,
  };
  return jsonResult({
    ok: true,
    task: opts.task,
    repo: resolvedRepo,
    runtime: record.runtime,
    summary: record.summary,
    diff: record.diff || null,
    filesChanged: stats.files.length,
    insertions: stats.insertions,
    deletions: stats.deletions,
    prUrl: record.prUrl || null,
    ...glanceResult([sessionWidgetBlock(widgetData)]),
  });
}

// --- MCP server ---------------------------------------------------------------
const server = new McpServer({ name: "notch-coder", version: "1.0.0" });

const PR_INSTRUCTIONS =
  "\n\nWhen you are done: create a new branch, commit your changes with a clear message, " +
  "push the branch, and open a GitHub pull request using the `gh` CLI. " +
  "Include the full PR URL in your final message.";

server.registerTool(
  "run_coding_agent",
  {
    title: "Run coding agent",
    description:
      "Start a Cursor AI coding agent that CHANGES code in a git repository (edits files, on this Mac or a Cursor cloud VM) and can open a pull request. Use only when the user wants to modify code: fix, implement, build, refactor, add, rename, delete, or 'ship it and open a PR'. Do NOT use for questions about how the code works or where something is (use ask_cursor for those), and do NOT use for general questions unrelated to the user's repositories (let VoiceOS answer those).",
    inputSchema: {
      task: z
        .string()
        .describe(
          "The coding instruction, e.g. 'Add a dark-mode toggle to the settings page'. Keep the user's own wording.",
        ),
      repo: z
        .string()
        .optional()
        .describe(
          "Which repo to work in: a repo name (e.g. 'voiceos-demo'), an absolute path, or a GitHub URL. Omit to use the currently focused repo (set via focus_repo / 'work on X').",
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Cursor model ID, e.g. composer-2.5 (fast, default), claude-opus-5, claude-sonnet-5, gpt-5.6-sol, claude-fable-5, gemini-3.1-pro. Only set when the user names a model.",
        ),
      open_pr: z
        .boolean()
        .optional()
        .describe(
          "When true the agent commits, pushes a branch, and opens a GitHub pull request when done. Default false.",
        ),
      use_cloud: z
        .boolean()
        .optional()
        .describe(
          "Run on a Cursor cloud VM against the user's GitHub repo instead of locally. Use when the user says 'in the cloud' or 'cloud agent'. Default false.",
        ),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "Validate the setup without starting an agent. Never set this unless the user explicitly asks for a dry run.",
        ),
    },
  },
  async ({ task, repo, model: modelArg, open_pr, use_cloud, dry_run }) => {
    const repoArg = repo?.trim() || "";

    // A GitHub URL always means cloud. A local path/name means local, unless the
    // user explicitly asked for cloud — then we derive the URL from its remote.
    let cloud = false;
    let resolvedRepo = ""; // local path OR github url, depending on runtime
    let localPath: string | null = null;

    if (isUrl(repoArg)) {
      cloud = true;
      resolvedRepo = repoArg;
    } else {
      // Named repo wins; otherwise fall back to the focused repo.
      localPath = repoArg ? resolveRepoRefOrNull(repoArg) : await loadFocus();

      // Not local? Try the user's cloud repos by name (e.g. 'ace').
      if (repoArg && !localPath) {
        const needle = normName(repoArg);
        const match = (await listCloudAgents()).find(
          (a) => (a.repo && normName(a.repo) === needle) || (a.rawRepo && normName(repoLabel(a.rawRepo)) === needle),
        );
        const url = cloudUrlFrom(match?.rawRepo ?? null);
        if (url) {
          cloud = true;
          resolvedRepo = url;
        } else {
          const known = findRepos().slice(0, 8).map((r) => r.name).join(", ");
          return errorResult(
            `No repo matching "${repoArg}" locally or in your cloud repos. Known local repos: ${known || "none"}.`,
          );
        }
      }

      if (!cloud) {
        if (!localPath) {
          return errorResult(
            "No repo in focus. Say 'work on <repo>' first, or name a repo (say list repos to browse).",
          );
        }
        if (!existsSync(localPath)) return errorResult(`Repository path does not exist: ${localPath}`);
        if (!dry_run) await saveFocus(localPath); // acting on a repo focuses it
        if (use_cloud) {
          const remote = githubRemote(localPath);
          if (!remote) {
            return errorResult(
              `${basename(localPath)} has no GitHub origin remote, so it can't run in the cloud. Run it locally, or push it to GitHub first.`,
            );
          }
          cloud = true;
          resolvedRepo = remote;
        } else {
          resolvedRepo = localPath;
        }
      }
    }
    const model = modelArg?.trim() || process.env.MODEL?.trim() || "composer-2.5";
    const repoName = repoLabel(resolvedRepo);

    if (dry_run) {
      return jsonResult({
        ok: true,
        dryRun: true,
        task,
        repo: resolvedRepo,
        runtime: cloud ? "cloud" : "local",
        model,
        hasApiKey: Boolean(process.env.CURSOR_API_KEY),
        ...glanceResult([
          { type: "header", title: "Cursor", appIcon: "cursor", icon: "bolt", trailing: "Ready" },
          {
            type: "keyValue",
            pairs: [
              ["Task", trim(task, 64)],
              ["Repo", trim(repoName, 64)],
              ["Runtime", cloud ? "Cursor cloud" : "This Mac"],
              ["Model", trim(model, 64)],
            ],
          },
        ]),
      });
    }

    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) {
      return errorResult("CURSOR_API_KEY is not set. Add it in Configure (cursor.com/dashboard → Integrations).");
    }

    const record: RunRecord = {
      id: `run-${Date.now().toString(36)}`,
      task,
      repo: resolvedRepo,
      runtime: cloud ? "cloud" : "local",
      openPr: Boolean(open_pr),
      status: "running",
      activity: "starting agent",
      startedAt: new Date().toISOString(),
    };
    await saveRun(record);

    // Imported lazily so `bun verify.ts` and dry runs never touch the SDK.
    const { Agent, CursorAgentError } = await import("@cursor/sdk");

    let agent;
    try {
      agent = await Agent.create({
        apiKey,
        model: { id: model },
        ...(cloud
          ? {
              cloud: {
                repos: [{ url: resolvedRepo }],
                autoCreatePR: Boolean(open_pr),
                skipReviewerRequest: true,
              },
            }
          : { local: { cwd: resolvedRepo } }),
      });
      record.agentId = agent.agentId;
      if (!cloud) record.startSha = gitHead(resolvedRepo);
      await saveRun(record);
      const run = await agent.send(cloud || !open_pr ? task : task + PR_INSTRUCTIONS);
      return await streamToCompletion({ agent, run, record, cloud, model, repoName, resolvedRepo, task });
    } catch (err) {
      record.status = "failed";
      record.finishedAt = new Date().toISOString();
      record.summary = err instanceof Error ? err.message : String(err);
      await saveRun(record);
      await agent?.[Symbol.asyncDispose]?.().catch(() => {});
      return errorResult(
        err instanceof CursorAgentError
          ? `Agent failed to start: ${err.message}. Check the API key in Configure.`
          : record.summary,
      );
    }
  },
);

server.registerTool(
  "continue_agent",
  {
    title: "Continue agent",
    description:
      "Give a follow-up instruction to the most recent Cursor coding agent, keeping full context of what it just did. Use when the user says 'also do X', 'now add Y', 'and update the tests', 'change it to Z', or otherwise refines the last coding task.",
    inputSchema: {
      task: z.string().describe("The follow-up instruction, in the user's own words."),
      open_pr: z.boolean().optional().describe("Also open a pull request when done. Default false."),
      dry_run: z.boolean().optional().describe("Validate without running. Never set unless the user asks for a dry run."),
    },
    execution: { mode: "background", estimatedDurationMs: 180000 },
  },
  async ({ task, open_pr, dry_run }) => {
    const runs = (await loadRuns()).sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    const prev = runs.find((r) => r.agentId);
    if (!prev?.agentId) {
      return errorResult("No previous agent to continue. Start one first with a coding task.");
    }
    if (dry_run) {
      return jsonResult({
        ok: true,
        dryRun: true,
        continues: prev.agentId,
        repo: prev.repo,
        ...glanceResult([
          { type: "header", title: "Cursor", appIcon: "cursor", icon: "bolt", trailing: "Ready" },
          { type: "keyValue", pairs: [["Follow-up", trim(task, 64)], ["Repo", trim(repoLabel(prev.repo), 64)]] },
        ]),
      });
    }
    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) return errorResult("CURSOR_API_KEY is not set. Add it in Configure.");

    const cloud = prev.runtime === "cloud";
    const model = process.env.MODEL?.trim() || "composer-2.5";
    const record: RunRecord = {
      id: `run-${Date.now().toString(36)}`,
      task,
      repo: prev.repo,
      runtime: prev.runtime,
      openPr: Boolean(open_pr),
      status: "running",
      activity: "resuming agent",
      agentId: prev.agentId,
      startedAt: new Date().toISOString(),
    };
    await saveRun(record);

    const { Agent, CursorAgentError } = await import("@cursor/sdk");
    let agent;
    try {
      agent = await Agent.resume(prev.agentId, {
        apiKey,
        model: { id: model },
        ...(cloud ? {} : { local: { cwd: prev.repo } }),
      });
      if (!cloud) record.startSha = gitHead(prev.repo);
      const run = await agent.send(cloud || !open_pr ? task : task + PR_INSTRUCTIONS);
      return await streamToCompletion({
        agent,
        run,
        record,
        cloud,
        model,
        repoName: repoLabel(prev.repo),
        resolvedRepo: prev.repo,
        task,
      });
    } catch (err) {
      record.status = "failed";
      record.finishedAt = new Date().toISOString();
      record.summary = err instanceof Error ? err.message : String(err);
      await saveRun(record);
      await agent?.[Symbol.asyncDispose]?.().catch(() => {});
      return errorResult(
        err instanceof CursorAgentError
          ? `Could not resume the agent: ${err.message}.`
          : record.summary,
      );
    }
  },
);

server.registerTool(
  "cancel_agent",
  {
    title: "Cancel agent",
    description:
      "Stop a Cursor coding agent that is currently running. Use when the user says 'stop', 'cancel', 'abort', 'never mind', or 'kill the agent'.",
    inputSchema: {},
  },
  async () => {
    const live = [...liveRuns.values()].filter((e) => e.record.status === "running");
    let cancelled = 0;
    for (const { run, record } of live) {
      try {
        if (!run.supports || run.supports("cancel")) {
          await run.cancel();
          record.status = "cancelled";
          record.activity = undefined;
          record.finishedAt = new Date().toISOString();
          await saveRun(record);
          cancelled++;
        }
      } catch {}
    }
    return jsonResult({
      cancelled,
      ...glanceResult([
        {
          type: "header",
          title: "Cursor",
          appIcon: "cursor",
          icon: "x",
          trailing: cancelled > 0 ? "Stopped" : "Nothing running",
        },
        {
          type: "keyValue",
          pairs: [[cancelled > 0 ? "Cancelled" : "Status", cancelled > 0 ? `${cancelled} agent${cancelled === 1 ? "" : "s"}` : "No agent was running"]],
        },
      ]),
    });
  },
);

server.registerTool(
  "focus_repo",
  {
    title: "Focus repo",
    description:
      "Set the repository the user is working on, so later commands don't need to name it. Use when the user says 'work on X', 'focus on X', 'switch to X', 'let's work in X', or otherwise picks a repo to keep using.",
    inputSchema: {
      repo: z.string().describe("The repo to focus: a repo name (e.g. 'voiceos-demo') or an absolute path."),
      dry_run: z
        .boolean()
        .optional()
        .describe("Validate resolution without changing focus. Never set unless the user asks for a dry run."),
    },
  },
  async ({ repo, dry_run }) => {
    const localPath = resolveRepoRef(repo.trim());
    if (!existsSync(localPath)) throw new Error(`Repository path does not exist: ${localPath}`);
    if (!dry_run) await saveFocus(localPath);
    const gh = githubRemote(localPath);

    return jsonResult({
      focused: localPath,
      name: basename(localPath),
      github: gh,
      ...glanceResult([
        { type: "header", title: "Cursor", appIcon: "cursor", icon: "folder", trailing: "Focused" },
        {
          type: "keyValue",
          pairs: [
            ["Working on", trim(basename(localPath), 64)],
            ["Path", trim(localPath.replace(homedir(), "~"), 64)],
            ...(gh ? ([["GitHub", trim(gh.replace("https://github.com/", ""), 64)]] as [string, string][]) : []),
          ],
        },
      ]),
    });
  },
);

server.registerTool(
  "ask_cursor",
  {
    title: "Ask about code",
    description:
      "Answer a question about the user's OWN code by having Cursor read the repository. Read-only: it never changes files and never opens a PR. Use when the user asks how their code works, where something is defined, what a repo or file does, why something behaves a certain way, or to explain or summarize part of their codebase. Do NOT use for general programming knowledge unrelated to their repos (let VoiceOS answer those), and do NOT use when the user wants to change code (use run_coding_agent).",
    inputSchema: {
      question: z
        .string()
        .describe(
          "The question about the user's code, in their own words. Do not put repo or folder names only here; also extract them into the repo argument.",
        ),
      repo: z
        .string()
        .optional()
        .describe(
          "Which repo or folder to read. ALWAYS set this when the user names any repo, folder, project, or directory (e.g. 'ace', 'the timbal repo', 'voiceos-demo'). Omit ONLY when no name is mentioned, to use the focused repo.",
        ),
      dry_run: z
        .boolean()
        .optional()
        .describe("Validate setup without reading. Never set this unless the user explicitly asks for a dry run."),
    },
  },
  async ({ question, repo, dry_run }) => {
    const repoArg = repo?.trim() || "";
    const localPath = repoArg ? resolveRepoRef(repoArg) : await loadFocus();
    if (!localPath) {
      throw new Error(
        "No repo in focus. Say 'work on <repo>' first, or name a repo (say list repos to browse).",
      );
    }
    if (!existsSync(localPath)) throw new Error(`Repository path does not exist: ${localPath}`);

    if (dry_run) {
      return jsonResult({
        ok: true,
        dryRun: true,
        repo: localPath,
        question,
        ...glanceResult([
          { type: "header", title: "Cursor", appIcon: "cursor", icon: "note", trailing: "Ready" },
          { type: "keyValue", pairs: [["Repo", trim(basename(localPath), 64)], ["Asked", trim(question, 64)]] },
        ]),
      });
    }

    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) {
      throw new Error("CURSOR_API_KEY is not set. Add it in Configure.");
    }
    const model = process.env.MODEL?.trim() || "composer-2.5";

    const { Agent, CursorAgentError } = await import("@cursor/sdk");
    let result;
    try {
      result = await Agent.prompt(question, {
        apiKey,
        model: { id: model },
        local: { cwd: localPath },
        // Read-only toolset: the agent physically cannot edit or run commands.
        tools: ["read", "grep", "glob", "ls", "semSearch"],
      });
    } catch (err) {
      if (err instanceof CursorAgentError) {
        throw new Error(`Cursor could not read the repo: ${err.message}. Check the API key in Configure.`);
      }
      throw err;
    }
    const answer = (typeof result.result === "string" ? result.result : "").trim();
    if (result.status !== "finished" || !answer) {
      throw new Error(`Cursor could not answer (status "${result.status}"). ${result.error?.message ?? ""}`.trim());
    }

    return jsonResult({
      answer,
      repo: localPath,
      question,
      ...glanceResult([
        { type: "header", title: "Cursor", appIcon: "cursor", icon: "note", trailing: "Answer" },
        {
          type: "keyValue",
          pairs: [
            ["Repo", trim(basename(localPath), 64)],
            ["Asked", trim(question, 64)],
          ],
        },
      ]),
    });
  },
);

server.registerTool(
  "list_repos",
  {
    title: "List repos",
    description:
      "List the git repositories on this Mac that the coding agent can work on. Use when the user asks what repos, projects, or codebases they have, wants to browse or pick a repository, or asks 'which repo'.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Optional name filter, e.g. 'timbal'. Omit to list the most recently touched repos."),
    },
  },
  async ({ query }) => {
    let repos = findRepos();
    if (query?.trim()) {
      const needle = query.trim().toLowerCase();
      repos = repos.filter((r) => r.name.toLowerCase().includes(needle));
    }
    const focused = await loadFocus();
    const withRemote = repos.slice(0, 20).map((r) => ({
      name: r.name,
      path: r.path,
      github: githubRemote(r.path),
      focused: r.path === focused,
    }));

    return jsonResult({
      note: "The card already lists the repos. Speak only one short sentence; do not enumerate them aloud.",
      count: repos.length,
      scanned: scanDirs(),
      focused: focused ? basename(focused) : null,
      repos: withRemote,
      ...glanceResult([
        {
          type: "header",
          title: "Cursor",
          appIcon: "cursor",
          icon: "folder",
          trailing: focused ? trim(basename(focused), 40) : `${repos.length} repos`,
        },
        repos.length === 0
          ? { type: "keyValue", pairs: [["Repos", "None found in scan folders"]] }
          : {
              type: "list",
              rows: withRemote.slice(0, 6).map((r) => ({
                icon: "folder",
                title: trim(r.name, 60),
                subtitle: trim(r.path.replace(homedir(), "~"), 72),
                badge: r.focused
                  ? { text: "Focused", tone: "good" }
                  : r.github
                    ? { text: "GitHub", tone: "neutral" }
                    : undefined,
              })),
            },
      ]),
    });
  },
);

type CloudAgentEntry = {
  agentId: string;
  name: string;
  status: "running" | "finished" | "error" | "unknown";
  repo: string | null;
  rawRepo: string | null;
  lastModified: number;
};

/** A cloud repo reference to an https GitHub URL, or null if not resolvable. */
function cloudUrlFrom(raw: string | null): string | null {
  if (!raw) return null;
  if (isUrl(raw)) return raw.replace(/\.git$/, "");
  if (/^[^/\s]+\/[^/\s]+$/.test(raw)) return `https://github.com/${raw}`;
  return null;
}

/** All cloud agents on the account (IDE, web, or SDK started), best-effort.
 * Cached for 60s: status is asked often and a fresh API round-trip per
 * question is the single biggest source of perceived lag. */
let cloudAgentsCache: { at: number; items: CloudAgentEntry[] } | null = null;

async function listCloudAgents(): Promise<CloudAgentEntry[]> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) return [];
  if (cloudAgentsCache && Date.now() - cloudAgentsCache.at < 60_000) return cloudAgentsCache.items;
  try {
    const { Agent } = await import("@cursor/sdk");
    const listed = (await Promise.race([
      Agent.list({ runtime: "cloud", limit: 15, apiKey }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3500)),
    ])) as { items: any[] };
    const items: CloudAgentEntry[] = listed.items.map((a) => ({
      agentId: a.agentId,
      name: a.name || a.summary || a.agentId,
      status: a.status ?? "unknown",
      repo: Array.isArray(a.repos) && a.repos[0] ? repoLabel(String(a.repos[0])) : null,
      rawRepo: Array.isArray(a.repos) && a.repos[0] ? String(a.repos[0]) : null,
      lastModified: a.lastModified ?? 0,
    }));
    cloudAgentsCache = { at: Date.now(), items };
    return items;
  } catch {
    return [];
  }
}

/** SDK-started local agents in known repos (IDE chat sessions are not visible).
 * Cached for 60s alongside the cloud list. */
let localAgentsCache: { at: number; items: CloudAgentEntry[] } | null = null;

async function listLocalAgents(): Promise<CloudAgentEntry[]> {
  if (localAgentsCache && Date.now() - localAgentsCache.at < 60_000) return localAgentsCache.items;
  try {
    const { Agent } = await import("@cursor/sdk");
    const cwds = new Set<string>(
      [process.env.DEFAULT_REPO?.trim(), ...findRepos().slice(0, 5).map((r) => r.path)].filter(
        (p): p is string => Boolean(p),
      ),
    );
    const all: CloudAgentEntry[] = [];
    await Promise.all(
      [...cwds].map(async (cwd) => {
        try {
          const listed = (await Promise.race([
            Agent.list({ runtime: "local", cwd, limit: 10 }),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
          ])) as { items: any[] };
          for (const a of listed.items) {
            all.push({
              agentId: a.agentId,
              name: a.name || a.summary || a.agentId,
              status: a.status ?? "unknown",
              repo: basename(cwd),
              lastModified: a.lastModified ?? 0,
            });
          }
        } catch {}
      }),
    );
    localAgentsCache = { at: Date.now(), items: all };
    return all;
  } catch {
    return [];
  }
}

server.registerTool(
  "agent_status",
  {
    title: "Agent status",
    description:
      "Check the progress and results of Cursor coding agents: ones started here by voice and cloud agents from the user's Cursor account (IDE or web). Use when the user asks 'is it done', 'how's the agent doing', 'what's Cursor working on', 'what agents are running', or wants a status update on coding tasks.",
    inputSchema: {},
  },
  async () => {
    const [ledger, cloudAgents, localAgents] = await Promise.all([
      loadRuns(),
      listCloudAgents(),
      listLocalAgents(),
    ]);
    const runs = ledger.sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    // Agents we started ourselves are already in the ledger; skip dupes.
    const ours = new Set(runs.map((r) => r.agentId).filter(Boolean));
    const external = [...cloudAgents, ...localAgents.map((a) => ({ ...a, repo: `${a.repo} (local)` }))]
      .filter((a) => !ours.has(a.agentId));
    const active = runs.filter((r) => r.status === "running");
    const running = active.length + external.filter((a) => a.status === "running").length;
    const done = runs.filter((r) => r.status === "done").length;

    type Row = { title: string; subtitle: string; badge: { text: string; tone: string }; when: number };
    const rows: Row[] = [
      ...runs.map((r) => ({
        title: trim(r.task, 60),
        subtitle: trim(
          r.status === "running" && r.activity
            ? `${repoLabel(r.repo)} · ${r.activity}`
            : `${repoLabel(r.repo)} · ${r.runtime} · ${agoLabel(r.startedAt)}`,
          72,
        ),
        badge:
          r.status === "running"
            ? { text: "Running", tone: "neutral" }
            : r.status === "done"
              ? { text: r.prUrl ? "PR opened" : "Done", tone: "good" }
              : { text: "Failed", tone: "bad" },
        when: new Date(r.startedAt).getTime(),
      })),
      ...external.map((a) => ({
        title: trim(a.name, 60),
        subtitle: trim(
          `${a.repo ?? "cloud"} · cloud · ${agoLabel(new Date(a.lastModified).toISOString())}`,
          72,
        ),
        badge:
          a.status === "running"
            ? { text: "Running", tone: "neutral" }
            : a.status === "finished"
              ? { text: "Done", tone: "good" }
              : a.status === "error"
                ? { text: "Failed", tone: "bad" }
                : { text: "Cloud", tone: "neutral" },
        when: a.lastModified,
      })),
    ].sort((a, b) => b.when - a.when);

    const listBlock: GlanceBlock = {
      type: "list",
      rows: rows.slice(0, active.length > 0 ? 4 : 6).map(({ when: _when, ...row }) => row),
    };

    let blocks: GlanceBlock[];
    if (rows.length === 0) {
      blocks = [
        { type: "header", title: "Cursor", appIcon: "cursor", icon: "bolt", trailing: "Idle" },
        { type: "keyValue", pairs: [["Agents", "None started yet"]] },
      ];
    } else if (active.length > 0) {
      // Live view: replay the running agent's tool-calls as a terminal.
      const current = active[0];
      const liveWidget = sessionWidgetBlock({
        status: "running",
        repo: repoLabel(current.repo),
        runtime: current.runtime,
        elapsed: elapsedLabel(current.startedAt),
        events: (current.events || []).slice(-14),
      });
      // Widget + a list of the other runs (2 blocks; widget carries its own header).
      blocks = active.length + runs.length > 1 ? [liveWidget, listBlock] : [liveWidget];
    } else {
      blocks = [
        {
          type: "header",
          title: "Cursor",
          appIcon: "cursor",
          icon: "bolt",
          trailing: running > 0 ? `${running} running` : "All done",
        },
        listBlock,
      ];
    }

    return jsonResult({
      note: "The card already shows the agents. Speak only one short sentence (e.g. how many are running and the most notable one); do not enumerate every agent aloud.",
      totalRuns: runs.length,
      running,
      done,
      failed: runs.filter((r) => r.status === "failed").length,
      cloudAgents: external.map((a) => ({
        name: a.name,
        status: a.status,
        repo: a.repo,
        agentId: a.agentId,
      })),
      recent: runs.slice(0, 6).map((r) => ({
        task: r.task,
        repo: r.repo,
        runtime: r.runtime,
        status: r.status,
        activity: r.activity || null,
        elapsed: r.status === "running" ? elapsedLabel(r.startedAt) : null,
        startedAt: r.startedAt,
        prUrl: r.prUrl || null,
        summary: r.summary ? r.summary.slice(0, 400) : null,
      })),
      ...glanceResult(blocks),
    });
  },
);

await server.connect(new StdioServerTransport());
