/**
 * WhatsApp, a VoiceOS integration server (standard MCP over stdio).
 *
 * Speaks the real WhatsApp Web multi-device protocol via Baileys — no browser,
 * no Meta business API. VoiceOS keeps this process alive between tool calls,
 * so one persistent WebSocket stays linked and a message ledger accumulates
 * chats as they arrive (history sync on pairing + live events).
 *
 * Linking: `link_whatsapp` returns an 8-char pairing code shown in the notch;
 * the user types it into WhatsApp on their phone (Linked Devices).
 *
 * WA_PASSIVE=1 (set by verify.ts) runs fully offline: no socket, empty ledger,
 * dry-run paths only. Never let two live sockets share ./wa-auth — WhatsApp
 * conflict-kicks the older session.
 *
 * Keep tool names in sync with voiceos.integration.json and run
 * `bun verify.ts` after every change. See AGENTS.md.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import pino from "pino";
import type { WASocket, WAMessage } from "baileys";

const PASSIVE = process.env.WA_PASSIVE === "1";

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

const header = (trailing: string): GlanceBlock => ({
  type: "header",
  title: "WhatsApp",
  appIcon: "whatsapp",
  icon: "message",
  trailing: trim(trailing, 24),
});

// Chat-bubble widget (sandboxed HTML; conversation arrives via voiceos:init).
const CHAT_WIDGET_HTML = readFileSync(new URL("./chat-widget.html", import.meta.url), "utf8");

// --- Message ledger (persists across reloads; fed by socket events) ---------
type Msg = {
  id: string;
  fromMe: boolean;
  sender: string; // jid
  senderName?: string;
  /** Group sender jid, kept so readMessages can build a valid key. */
  participant?: string;
  text: string;
  ts: number; // epoch seconds
};
type Chat = {
  jid: string;
  name?: string;
  unread: number;
  lastTs: number;
  messages: Msg[]; // oldest → newest, capped
};
type Store = {
  chats: Record<string, Chat>;
  contacts: Record<string, string>; // jid → address-book/synced name
  /** jid → self-chosen WhatsApp profile name, harvested from live messages.
   * Unsaved contacts show THIS name in the chat list, so it must be
   * searchable even when the synced contact record says something else. */
  pushNames: Record<string, string>;
};

const AUTH_DIR = new URL("./wa-auth", import.meta.url).pathname;
const STORE_FILE = new URL("./wa-store.json", import.meta.url);
const MAX_MSGS_PER_CHAT = 100;

let store: Store = { chats: {}, contacts: {}, pushNames: {} };
if (!PASSIVE) {
  try {
    store = { pushNames: {}, ...JSON.parse(await Bun.file(STORE_FILE).text()) };
  } catch {}
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (PASSIVE || saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await Bun.write(STORE_FILE, JSON.stringify(store)).catch(() => {});
  }, 1000);
}

// Saves are debounced, so a Reload could drop the last second of messages.
if (!PASSIVE) {
  const flush = () => {
    try {
      writeFileSync(STORE_FILE, JSON.stringify(store));
    } catch {}
  };
  process.on("SIGTERM", () => { flush(); process.exit(0); });
  process.on("SIGINT", () => { flush(); process.exit(0); });
}

// @lid is WhatsApp's newer privacy-preserving address — many 1:1 chats use it
// instead of a phone-number jid. Dropping them makes those contacts invisible.
const isRealChat = (jid: string) =>
  (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@g.us") || jid.endsWith("@lid")) &&
  jid !== "status@broadcast";

const numberOf = (jid: string) => (jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0] : null);

function chatFor(jid: string): Chat {
  return (store.chats[jid] ??= { jid, unread: 0, lastTs: 0, messages: [] });
}

function chatName(jid: string): string {
  const c = store.chats[jid];
  return c?.name || store.contacts[jid] || store.pushNames[jid] || jid.split("@")[0] || jid;
}

/** Human text for a WAMessage, or a placeholder for media. */
function messageText(m: WAMessage): string {
  const msg: any = m.message ?? {};
  const inner = msg.ephemeralMessage?.message ?? msg.viewOnceMessage?.message ?? msg;
  if (inner.conversation) return inner.conversation;
  if (inner.extendedTextMessage?.text) return inner.extendedTextMessage.text;
  if (inner.imageMessage) return inner.imageMessage.caption || "[photo]";
  if (inner.videoMessage) return inner.videoMessage.caption || "[video]";
  if (inner.audioMessage) return inner.audioMessage.ptt ? "[voice note]" : "[audio]";
  if (inner.stickerMessage) return "[sticker]";
  if (inner.documentMessage) return `[file: ${inner.documentMessage.fileName ?? "document"}]`;
  if (inner.locationMessage) return "[location]";
  if (inner.contactMessage) return "[contact card]";
  if (inner.reactionMessage) return `[reaction ${inner.reactionMessage.text ?? ""}]`.trim();
  if (inner.pollCreationMessage || inner.pollCreationMessageV3) return "[poll]";
  if (inner.protocolMessage || Object.keys(inner).length === 0) return "";
  return "[message]";
}

function ingestMessage(m: WAMessage, countUnread: boolean) {
  const jid = m.key.remoteJid;
  if (!jid || !isRealChat(jid)) return;
  const text = messageText(m);
  if (!text) return; // protocol noise, receipts, etc.
  const chat = chatFor(jid);
  const ts = Number(m.messageTimestamp ?? 0);
  const id = m.key.id ?? `${ts}-${Math.random()}`;
  if (chat.messages.some((x) => x.id === id)) return;
  const senderJid = m.key.fromMe ? "me" : (m.key.participant ?? jid);
  const msg: Msg = {
    id,
    fromMe: Boolean(m.key.fromMe),
    sender: senderJid,
    senderName: m.key.fromMe ? undefined : (m.pushName ?? undefined),
    ...(m.key.participant ? { participant: m.key.participant } : {}),
    text: text.slice(0, 1000),
    ts,
  };
  if (msg.senderName && senderJid !== "me") {
    store.pushNames[senderJid] = msg.senderName; // latest self-chosen name wins
    if (!store.contacts[senderJid]) store.contacts[senderJid] = msg.senderName;
  }
  chat.messages.push(msg);
  chat.messages.sort((a, b) => a.ts - b.ts);
  if (chat.messages.length > MAX_MSGS_PER_CHAT) {
    chat.messages.splice(0, chat.messages.length - MAX_MSGS_PER_CHAT);
  }
  chat.lastTs = Math.max(chat.lastTs, ts);
  if (countUnread && !m.key.fromMe) chat.unread += 1;
  scheduleSave();
}

// --- Socket manager (one persistent connection for the process) -------------
type ConnState = "offline" | "connecting" | "open" | "logged_out";
let sock: WASocket | null = null;
let connState: ConnState = "offline";
let lastError: string | undefined;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const logger = pino({ level: "silent" }); // stdout belongs to MCP — keep quiet

async function connect(): Promise<WASocket> {
  if (PASSIVE) throw new Error("WhatsApp socket disabled in passive (verify) mode.");
  if (sock && (connState === "open" || connState === "connecting")) return sock;
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
  } = await import("baileys");

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version: [number, number, number] | undefined;
  try {
    version = (await fetchLatestBaileysVersion()).version as [number, number, number];
  } catch {}

  connState = "connecting";
  lastError = undefined;
  const s = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger,
    markOnlineOnConnect: false, // keep notifications ringing on the phone
    generateHighQualityLinkPreview: false,
    syncFullHistory: true, // shallow sync misses older chats entirely
  });
  sock = s;

  s.ev.on("creds.update", saveCreds);

  s.ev.on("connection.update", (u) => {
    if (u.connection === "open") {
      connState = "open";
      reconnectAttempts = 0;
    }
    if (u.connection === "close") {
      const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
      lastError = u.lastDisconnect?.error?.message;
      sock = null;
      if (code === DisconnectReason.loggedOut) {
        connState = "logged_out";
        return; // needs a fresh link_whatsapp
      }
      // Another process took the session (e.g. VoiceOS leaked the old server
      // on Reload). Surrender instead of fighting it for the connection.
      if (code === DisconnectReason.connectionReplaced) {
        connState = "offline";
        lastError = "Session taken over by a newer WhatsApp server process.";
        return;
      }
      connState = "offline";
      // Reconnect only for sessions that completed pairing.
      if (state.creds.registered && !reconnectTimer) {
        const delay = Math.min(30_000, 2000 * 2 ** Math.min(reconnectAttempts++, 4));
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect().catch(() => {});
        }, delay);
      }
    }
  });

  s.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
    for (const c of contacts ?? []) {
      const name = (c as any).name || (c as any).notify;
      if (c.id && name) store.contacts[c.id] = name;
    }
    for (const c of chats ?? []) {
      if (!c.id || !isRealChat(c.id)) continue;
      const chat = chatFor(c.id);
      if (c.name) chat.name = c.name;
      if (typeof c.unreadCount === "number") chat.unread = Math.max(0, c.unreadCount);
      const ts = Number(c.conversationTimestamp ?? 0);
      chat.lastTs = Math.max(chat.lastTs, ts);
    }
    for (const m of messages ?? []) ingestMessage(m, false);
    scheduleSave();
  });

  s.ev.on("messages.upsert", ({ messages, type }) => {
    for (const m of messages) ingestMessage(m, type === "notify");
  });

  s.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      const name = (c as any).name || (c as any).notify;
      if (c.id && name) store.contacts[c.id] = name;
    }
    scheduleSave();
  });

  // Renames on the phone arrive as updates, not upserts.
  s.ev.on("contacts.update", (contacts) => {
    for (const c of contacts) {
      const name = (c as any).name || (c as any).notify;
      if (c.id && name) store.contacts[c.id] = name;
    }
    scheduleSave();
  });

  s.ev.on("chats.upsert", (chats) => {
    for (const c of chats) {
      if (!c.id || !isRealChat(c.id)) continue;
      if (c.name) chatFor(c.id).name = c.name;
    }
    scheduleSave();
  });

  return s;
}

const credsExist = () => existsSync(`${AUTH_DIR}/creds.json`);

// Reconnect the existing session as soon as VoiceOS boots us.
if (!PASSIVE && credsExist()) connect().catch(() => {});

/** Wait until the socket is usable (open), or throw with the last error. */
async function connectedSocket(timeoutMs = 15_000): Promise<WASocket> {
  const s = await connect();
  if (connState === "open") return s;
  const start = Date.now();
  // connect() mutates connState behind TS's back across the awaits.
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
    if ((connState as ConnState) === "open" && sock) return sock;
    if ((connState as ConnState) === "logged_out") break;
  }
  throw new Error(
    connState === "logged_out"
      ? "WhatsApp session was logged out from the phone. Say 'link WhatsApp' to pair again."
      : `WhatsApp is not connected (${connState}${lastError ? `: ${lastError}` : ""}). ` +
        "If it never connects, say 'link WhatsApp' to pair this Mac.",
  );
}

// --- Chat / contact resolution (voice-safe: ambiguity throws) ----------------
// Accent-insensitive: "Martí" must match a contact saved as "Marti".
const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s_.-]+/g, "");

type Candidate = { jid: string; name: string };

function allCandidates(): Candidate[] {
  const byJid = new Map<string, string>();
  for (const [jid, name] of Object.entries(store.contacts)) {
    if (isRealChat(jid)) byJid.set(jid, name);
  }
  for (const c of Object.values(store.chats)) {
    if (c.name) byJid.set(c.jid, c.name);
    else if (!byJid.has(c.jid)) byJid.set(c.jid, chatName(c.jid));
  }
  const out: Candidate[] = [...byJid].map(([jid, name]) => ({ jid, name }));
  // Profile names as ALTERNATE candidates: a person can match under both
  // their saved name and the name they display as (same jid = same person).
  for (const [jid, name] of Object.entries(store.pushNames)) {
    if (isRealChat(jid) && norm(byJid.get(jid) ?? "") !== norm(name)) out.push({ jid, name });
  }
  return out;
}

const uniqueJids = (cands: Candidate[]) => new Set(cands.map((c) => c.jid));

/** Digit query → candidates whose number matches, tolerating a missing
 * country code ("626 564 604" finds 34626564604@s.whatsapp.net). */
function matchByNumber(digits: string): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const jid of new Set([...Object.keys(store.chats), ...Object.keys(store.contacts)])) {
    const num = numberOf(jid);
    if (!num || seen.has(jid)) continue;
    if (num === digits || num.endsWith(digits) || digits.endsWith(num)) {
      seen.add(jid);
      out.push({ jid, name: chatName(jid) });
    }
  }
  return out;
}

const digitsOf = (ref: string) => {
  const cleaned = ref.replace(/[\s()+.-]/g, "");
  return /^\d{7,15}$/.test(cleaned) ? cleaned : null;
};

const candidateLabel = (c: Candidate) => {
  if (c.jid.endsWith("@g.us")) return `${c.name} (group)`;
  const num = numberOf(c.jid);
  return num ? `${c.name} (+${num})` : `${c.name} (WhatsApp contact)`;
};

function matchCandidates(ref: string): { exact: Candidate[]; fuzzy: Candidate[] } {
  const candidates = allCandidates();
  const needle = norm(ref);
  if (!needle) return { exact: [], fuzzy: [] };
  const exact = candidates.filter((c) => norm(c.name) === needle);
  const prefix = candidates.filter((c) => norm(c.name).startsWith(needle) && norm(c.name) !== needle);
  const substr = candidates.filter((c) => norm(c.name).includes(needle) && !norm(c.name).startsWith(needle));
  let fuzzy = [...prefix, ...substr];
  // "Martí Norberto" matching nobody as a whole should still surface all the
  // Martís: fall back to per-word matches so there's something to work with.
  if (exact.length === 0 && fuzzy.length === 0) {
    const words = ref.split(/\s+/).map(norm).filter((w) => w.length >= 3);
    if (words.length > 1) {
      const seen = new Set<string>();
      fuzzy = candidates.filter((c) => {
        const n = norm(c.name);
        if (!words.some((w) => n.includes(w)) || seen.has(c.jid)) return false;
        seen.add(c.jid);
        return true;
      });
    }
  }
  return { exact, fuzzy };
}

/** Spoken reference → jid, for READ paths. Digits pass through as a phone
 * number; names match chats+contacts (exact beats prefix beats substring;
 * ambiguity throws rather than picking someone at random). */
function resolveRecipient(ref: string): { jid: string; name: string } {
  const digits = digitsOf(ref);
  if (digits) {
    const byNum = matchByNumber(digits);
    if (byNum.length === 1) return byNum[0]!;
    if (byNum.length > 1) {
      throw new Error(
        `That number matches several chats: ${byNum.slice(0, 5).map(candidateLabel).join(", ")}. Say the full number.`,
      );
    }
    const jid = `${digits}@s.whatsapp.net`;
    return { jid, name: store.contacts[jid] || digits };
  }
  const { exact, fuzzy } = matchCandidates(ref);
  const tier = exact.length > 0 ? exact : fuzzy;
  if (uniqueJids(tier).size === 1) return tier[0]!;
  if (tier.length === 0) {
    const known = allCandidates().slice(0, 8).map((c) => c.name).join(", ");
    throw new Error(
      `No WhatsApp chat or contact matching "${ref}". ` +
        (known ? `Known: ${known}.` : "No chats synced yet — link WhatsApp and let it sync."),
    );
  }
  throw new Error(
    `"${ref}" is ambiguous: ${tier.slice(0, 5).map(candidateLabel).join(", ")}. Say the full name.`,
  );
}

/** Resolution for SENDING: a phone number or a unique EXACT name match only.
 * Names on WhatsApp are often self-chosen and unreliable, and a misdirected
 * message can't be unsent — never guess from a fuzzy match.
 *
 * Preferred form is "Name (+34612345678)" — what find_contact returns — so
 * the confirmation card shows the user exactly who will receive the message.
 * Any embedded 7-15 digit phone token wins over the name text. */
function resolveSendRecipient(ref: string): { jid: string; name: string } {
  const phoneToken = ref.match(/\+?\d[\d\s().-]{5,}\d/)?.[0];
  const digits = (phoneToken ?? ref).replace(/[^\d]/g, "");
  if (/^\d{7,15}$/.test(digits) && (phoneToken || /^[\s()+.\d-]+$/.test(ref))) {
    // Prefer an existing chat/contact whose number matches — this also
    // recovers a spoken number missing its country code.
    const byNum = matchByNumber(digits);
    if (byNum.length === 1) return byNum[0]!;
    if (byNum.length > 1) {
      throw new Error(
        `That number matches several chats: ${byNum.slice(0, 5).map(candidateLabel).join(", ")}. Use the full number with country code.`,
      );
    }
    const jid = `${digits}@s.whatsapp.net`;
    const nameText = ref.replace(phoneToken ?? "", "").replace(/[()+·]/g, "").trim();
    return { jid, name: store.contacts[jid] || nameText || digits };
  }
  const { exact, fuzzy } = matchCandidates(ref.replace(/\(group\)\s*$/i, "").trim());
  if (exact.length >= 1 && uniqueJids(exact).size === 1) return exact[0]!;
  if (exact.length > 1) {
    throw new Error(
      `${exact.length} contacts are named "${ref}": ` +
        exact.slice(0, 5).map(candidateLabel).join(", ") +
        ". Ask the user which one, then send to the phone number.",
    );
  }
  if (fuzzy.length > 0) {
    throw new Error(
      `No contact is named exactly "${ref}". Close matches: ` +
        fuzzy.slice(0, 5).map(candidateLabel).join(", ") +
        ". Confirm with the user (or call find_contact), then send using the exact name or the phone number.",
    );
  }
  throw new Error(
    `No WhatsApp contact or group matching "${ref}". Call find_contact to search, or use a phone number with country code.`,
  );
}

function timeLabel(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// --- MCP server ---------------------------------------------------------------
const server = new McpServer({ name: "notch-whatsapp", version: "1.0.0" });

// VoiceOS doesn't persist custom-tool args/results, so debugging user reports
// is guesswork without our own trace. JSON-lines, local only, gitignored.
const DEBUG_LOG = new URL("./wa-debug.log", import.meta.url).pathname;
try {
  const { size } = await import("node:fs").then((fs) => fs.statSync(DEBUG_LOG));
  if (size > 1_000_000) rmSync(DEBUG_LOG, { force: true });
} catch {}
function traced<A extends Record<string, unknown>>(
  name: string,
  handler: (args: A) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
) {
  return async (args: A) => {
    const started = Date.now();
    const entry: Record<string, unknown> = { t: new Date().toISOString(), tool: name, args };
    try {
      const result = await handler(args);
      entry.ms = Date.now() - started;
      entry.result = (result.content[0]?.text ?? "").slice(0, 400);
      return result;
    } catch (err) {
      entry.ms = Date.now() - started;
      entry.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      if (!PASSIVE) {
        const { appendFileSync } = await import("node:fs");
        try {
          appendFileSync(DEBUG_LOG, JSON.stringify(entry) + "\n");
        } catch {}
      }
    }
  };
}

// Route every tool registration through the tracer.
const registerToolRaw = server.registerTool.bind(server);
(server as any).registerTool = (name: string, def: unknown, handler: (a: any) => any) =>
  registerToolRaw(name as any, def as any, traced(name, handler) as any);

/** Last message sent through this server, so "where did my last message go"
 * has a factual answer (whatsapp_status) instead of guesswork. */
let lastSent: { to: string; number: string; body: string; ts: number } | null = null;

server.registerTool(
  "link_whatsapp",
  {
    title: "Link WhatsApp",
    description:
      "Link this Mac to the user's WhatsApp account with an 8-character pairing code (no QR scan). Use when the user asks to connect, link, set up, log in to, or re-pair WhatsApp, or when another WhatsApp tool failed because no account is linked.",
    inputSchema: {
      phone: z
        .string()
        .describe(
          "The user's own WhatsApp phone number with country code, digits only, e.g. 34612345678.",
        ),
      relink: z
        .boolean()
        .optional()
        .describe(
          "Re-pair even if already linked, wiping the current session and re-syncing history from scratch. Set when the user explicitly asks to relink, re-pair, or re-sync WhatsApp.",
        ),
      dry_run: z
        .boolean()
        .optional()
        .describe("Validate without contacting WhatsApp. Never set unless the user asks."),
    },
  },
  async ({ phone, relink, dry_run }) => {
    const digits = phone.replace(/[\s()+-]/g, "");
    if (!/^\d{8,15}$/.test(digits)) {
      throw new Error(
        `"${phone}" doesn't look like a full international number. Include the country code, digits only.`,
      );
    }

    if (dry_run) {
      return jsonResult({
        ok: true,
        dryRun: true,
        phone: digits,
        alreadyLinked: credsExist(),
        ...glanceResult([
          header("Ready"),
          { type: "keyValue", pairs: [["Phone", `+${digits}`], ["Status", "Dry run — would request pairing code"]] },
        ]),
      });
    }

    if (credsExist() && connState === "open" && !relink) {
      const me = sock?.user?.id?.split(":")[0]?.split("@")[0];
      return jsonResult({
        ok: true,
        alreadyLinked: true,
        linkedNumber: me ?? null,
        ...glanceResult([
          header("Linked"),
          { type: "keyValue", pairs: [["Status", "Already linked and connected"], ...(me ? [["Number", `+${me}`] as [string, string]] : [])] },
        ]),
      });
    }

    // Fresh pairing: any stale/logged-out session would poison the handshake.
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { sock?.end(undefined as any); } catch {}
    sock = null;
    connState = "offline";
    rmSync(AUTH_DIR, { recursive: true, force: true });
    // Fresh pairing re-syncs history from scratch; stale ledger data (old
    // unread counts, lid chats dropped by earlier versions) would linger.
    store = { chats: {}, contacts: {}, pushNames: {} };
    scheduleSave();

    const s = await connect();
    // The pairing code can only be requested once the socket has done its
    // initial handshake (signalled by the first QR event).
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WhatsApp did not answer in 20s. Check the network and retry.")), 20_000);
      s.ev.on("connection.update", (u) => {
        if (u.qr) { clearTimeout(t); resolve(); }
        if (u.connection === "close") {
          clearTimeout(t);
          reject(new Error(`Connection closed before pairing: ${u.lastDisconnect?.error?.message ?? "unknown"}`));
        }
      });
    });
    const code = await s.requestPairingCode(digits);
    const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

    return jsonResult({
      ok: true,
      pairingCode: pretty,
      phone: digits,
      instructions:
        "On the phone: WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number instead → enter the code. Linking completes in the background; ask for WhatsApp status to confirm.",
      ...glanceResult([
        header("Pairing"),
        { type: "keyValue", pairs: [["Code", pretty], ["Phone", `+${digits}`]] },
        { type: "list", rows: [
          { icon: "phone", title: "WhatsApp → Linked Devices", subtitle: "Link a Device → Link with phone number" },
          { icon: "check", title: "Enter the code above", subtitle: "Then ask: “is WhatsApp linked?”" },
        ] },
      ]),
    });
  },
);

server.registerTool(
  "whatsapp_status",
  {
    title: "WhatsApp status",
    description:
      "Check whether WhatsApp is linked and connected, which number is paired, how many chats and unreads are synced, and who the LAST SENT message went to. Use when the user asks 'is WhatsApp linked/connected/working', 'where/who did my last message go to', after pairing, or to debug why messages aren't flowing.",
    inputSchema: {},
  },
  async () => {
    const chats = Object.values(store.chats);
    const unreadChats = chats.filter((c) => c.unread > 0);
    const unreadTotal = unreadChats.reduce((n, c) => n + c.unread, 0);
    const me = sock?.user?.id?.split(":")[0]?.split("@")[0] ?? null;
    const linked = credsExist();
    const stateLabel = PASSIVE
      ? "passive (verify)"
      : connState === "open"
        ? "connected"
        : connState === "logged_out"
          ? "logged out — relink needed"
          : linked
            ? connState
            : "not linked";

    return jsonResult({
      linked,
      connection: connState,
      number: me,
      chatsSynced: chats.length,
      unreadChats: unreadChats.length,
      unreadMessages: unreadTotal,
      lastSent: lastSent
        ? { ...lastSent, time: timeLabel(lastSent.ts) }
        : "nothing sent since this server started",
      lastError: lastError ?? null,
      ...glanceResult([
        header(connState === "open" ? "Connected" : linked ? "Offline" : "Not linked"),
        { type: "keyValue", pairs: [
          ["Status", trim(stateLabel, 64)],
          ...(me ? [["Number", `+${me}`] as [string, string]] : []),
          ["Chats synced", String(chats.length)],
          ["Unread", `${unreadTotal} in ${unreadChats.length} chat${unreadChats.length === 1 ? "" : "s"}`],
          ...(lastSent
            ? [["Last sent", trim(`${lastSent.to} · ${lastSent.number} · ${timeLabel(lastSent.ts)}`, 64)] as [string, string]]
            : []),
        ] },
      ]),
    });
  },
);

server.registerTool(
  "unread_messages",
  {
    title: "Unread messages",
    description:
      "List WhatsApp chats with unread messages, including the latest message text of each. Use when the user asks 'any new WhatsApp messages', 'what did I miss', 'do I have unreads', or wants a WhatsApp inbox summary.",
    inputSchema: {},
  },
  async () => {
    const unread = Object.values(store.chats)
      .filter((c) => c.unread > 0)
      .sort((a, b) => b.lastTs - a.lastTs);

    if (unread.length === 0) {
      const linked = credsExist();
      return jsonResult({
        unreadChats: 0,
        linked,
        note: linked ? "No unread messages." : "WhatsApp is not linked yet — offer to link it.",
        ...glanceResult([
          header(linked ? "Inbox zero" : "Not linked"),
          { type: "keyValue", pairs: [["Unread", linked ? "Nothing new" : "Link WhatsApp to sync chats"]] },
        ]),
      });
    }

    const total = unread.reduce((n, c) => n + c.unread, 0);
    return jsonResult({
      unreadChats: unread.length,
      unreadMessages: total,
      chats: unread.slice(0, 10).map((c) => ({
        chat: chatName(c.jid),
        jid: c.jid,
        unread: c.unread,
        lastMessages: c.messages.slice(-Math.min(c.unread, 5)).map((m) => ({
          from: m.fromMe ? "me" : (m.senderName ?? store.contacts[m.sender] ?? chatName(c.jid)),
          text: m.text,
          time: timeLabel(m.ts),
        })),
      })),
      ...glanceResult([
        header(`${total} unread`),
        { type: "list", rows: unread.slice(0, 6).map((c) => {
          const last = c.messages[c.messages.length - 1];
          return {
            icon: c.jid.endsWith("@g.us") ? "person" : "message",
            title: trim(chatName(c.jid), 60),
            subtitle: trim(last?.text ?? "", 72),
            trailing: timeLabel(c.lastTs),
            badge: { text: String(c.unread), tone: "good" },
          };
        }) },
      ]),
    });
  },
);

server.registerTool(
  "read_chat",
  {
    title: "Read chat",
    description:
      "Read the recent messages of one WhatsApp chat (person or group) by name or phone number, marking them as read on the user's phone. Use when the user asks 'what did X say', 'read my chat with X', 'catch me up on the family group', or wants the conversation history with someone.",
    inputSchema: {
      chat: z.string().describe("Chat to read: a contact name, group name, or phone number with country code."),
      limit: z.number().optional().describe("Max messages to return (default 20)."),
    },
  },
  async ({ chat, limit }) => {
    if (Object.keys(store.chats).length === 0) {
      const linked = credsExist();
      return jsonResult({
        ok: false,
        reason: linked ? "no_chats_synced_yet" : "not_linked",
        note: linked
          ? "Chats are still syncing — try again in a minute."
          : "WhatsApp is not linked — offer to link it.",
        ...glanceResult([
          header("No chats"),
          { type: "keyValue", pairs: [["Chats", linked ? "Still syncing, try again shortly" : "Link WhatsApp first"]] },
        ]),
      });
    }
    const { jid, name } = resolveRecipient(chat);
    const record = store.chats[jid];
    if (!record || record.messages.length === 0) {
      throw new Error(`No synced messages with ${name} yet. Only messages since linking (plus a short history) are available.`);
    }
    const n = Math.max(1, Math.min(limit ?? 20, MAX_MSGS_PER_CHAT));
    const messages = record.messages.slice(-n);
    record.unread = 0; // reading it here counts as caught-up locally
    scheduleSave();

    // Best-effort: sync read state to the phone so its badge clears too.
    if (!PASSIVE && connState === "open" && sock) {
      const keys = messages
        .filter((m) => !m.fromMe)
        .map((m) => ({ remoteJid: jid, id: m.id, ...(m.participant ? { participant: m.participant } : {}) }));
      if (keys.length > 0) sock.readMessages(keys).catch(() => {});
    }

    const mapped = messages.map((m) => ({
      from: m.fromMe ? "me" : (m.senderName ?? store.contacts[m.sender] ?? name),
      fromMe: m.fromMe,
      text: m.text,
      time: timeLabel(m.ts),
      ts: m.ts,
    }));

    return jsonResult({
      chat: name,
      jid,
      isGroup: jid.endsWith("@g.us"),
      messages: mapped,
      note: "The card already shows the full conversation. Speak only a one or two sentence summary of what's new; do not read every message aloud.",
      ...glanceResult([
        {
          type: "widget",
          html: CHAT_WIDGET_HTML,
          height: Math.min(420, 70 + Math.min(mapped.length, 14) * 44),
          label: `WhatsApp chat with ${trim(name, 40)}`,
          data: {
            chat: name,
            isGroup: jid.endsWith("@g.us"),
            messages: mapped.slice(-14).map((m) => ({
              from: trim(m.from, 24),
              fromMe: m.fromMe,
              text: trim(m.text, 400),
              time: m.time,
            })),
          },
        },
      ]),
    });
  },
);

server.registerTool(
  "list_chats",
  {
    title: "List chats",
    description:
      "List the user's most recent WhatsApp chats (people and groups) with the last message of each. Use when the user asks 'what are my recent chats', 'who have I been talking to', wants to browse conversations, or when a contact search failed and you need to see what chats actually exist.",
    inputSchema: {
      limit: z.number().optional().describe("Max chats to return (default 20, max 50)."),
    },
  },
  async ({ limit }) => {
    const n = Math.max(1, Math.min(limit ?? 20, 50));
    const chats = Object.values(store.chats)
      .filter((c) => c.lastTs > 0 || c.messages.length > 0)
      .sort((a, b) => b.lastTs - a.lastTs)
      .slice(0, n);

    if (chats.length === 0) {
      const linked = credsExist();
      return jsonResult({
        count: 0,
        linked,
        note: linked ? "No chats synced yet — try again in a minute." : "WhatsApp is not linked yet — offer to link it.",
        ...glanceResult([
          header(linked ? "No chats yet" : "Not linked"),
          { type: "keyValue", pairs: [["Chats", linked ? "Still syncing" : "Link WhatsApp first"]] },
        ]),
      });
    }

    return jsonResult({
      count: chats.length,
      totalChats: Object.keys(store.chats).length,
      chats: chats.map((c) => {
        const last = c.messages[c.messages.length - 1];
        return {
          chat: chatName(c.jid),
          isGroup: c.jid.endsWith("@g.us"),
          number: numberOf(c.jid),
          unread: c.unread,
          lastMessage: last ? { from: last.fromMe ? "me" : (last.senderName ?? chatName(c.jid)), text: last.text } : null,
          time: timeLabel(c.lastTs),
        };
      }),
      ...glanceResult([
        header(`${chats.length} chats`),
        { type: "list", rows: chats.slice(0, 6).map((c) => {
          const last = c.messages[c.messages.length - 1];
          return {
            icon: c.jid.endsWith("@g.us") ? "person" : "message",
            title: trim(chatName(c.jid), 60),
            subtitle: trim(last?.text ?? "", 72),
            trailing: timeLabel(c.lastTs),
            ...(c.unread > 0 ? { badge: { text: String(c.unread), tone: "good" } } : {}),
          };
        }) },
      ]),
    });
  },
);

server.registerTool(
  "find_contact",
  {
    title: "Find contact",
    description:
      "Search the user's WhatsApp contacts and groups by (partial) name or phone number and return exact names with phone numbers. ALWAYS use this before send_message when you are not certain the recipient name is exact and unique — sending requires an exact name or phone number. Also use when the user asks 'do I have X on WhatsApp' or 'what's X's number'.",
    inputSchema: {
      query: z.string().describe("Name, partial name, or phone number to search for, e.g. 'adri' or '626564604'."),
    },
  },
  async ({ query }) => {
    const digits = digitsOf(query);
    let exact: Candidate[];
    let fuzzy: Candidate[] = [];
    if (digits) {
      exact = matchByNumber(digits);
      if (exact.length === 0) {
        // Unknown but plausibly sendable number — hand it back as-is.
        exact = [{ jid: `${digits}@s.whatsapp.net`, name: digits }];
      }
    } else {
      ({ exact, fuzzy } = matchCandidates(query));
    }
    const matches = [...exact, ...fuzzy].slice(0, 8);
    const sendAs = (c: Candidate) => {
      const num = numberOf(c.jid);
      return num ? `${c.name} (+${num})` : c.jid.endsWith("@g.us") ? `${c.name} (group)` : c.name;
    };
    const distinct = uniqueJids(matches).size;
    return jsonResult({
      query,
      count: matches.length,
      matches: matches.map((c) => ({
        name: c.name,
        isGroup: c.jid.endsWith("@g.us"),
        number: numberOf(c.jid),
        sendAs: sendAs(c),
        exactMatch: exact.includes(c),
      })),
      note:
        matches.length === 0
          ? "No matches — do NOT search again with spelling variants; ask the user for the phone number with country code."
          : distinct === 1
            ? `Single match. STOP searching and call send_message NOW with to="${sendAs(matches[0]!)}".`
            : "Multiple people match. Ask the user which one (read the names and numbers), then call send_message with that entry's sendAs value. Do not search again.",
      ...glanceResult([
        header(`${matches.length} match${matches.length === 1 ? "" : "es"}`),
        matches.length === 0
          ? { type: "keyValue", pairs: [["Contacts", trim(`Nothing matching “${query}”`, 64)]] }
          : {
              type: "list",
              rows: matches.slice(0, 6).map((c) => ({
                icon: c.jid.endsWith("@g.us") ? "person" : "phone",
                title: trim(c.name, 60),
                subtitle: c.jid.endsWith("@g.us") ? "Group" : numberOf(c.jid) ? `+${numberOf(c.jid)}` : "WhatsApp contact",
              })),
            },
      ]),
    });
  },
);

server.registerTool(
  "send_message",
  {
    title: "Send message",
    description:
      "Send a WhatsApp text message to a contact, group, or phone number. Use when the user asks to message, text, reply to, or tell someone something on WhatsApp, e.g. 'whatsapp Marc that I'm running late'. Recipient rules: a phone number always works directly. For a name, call find_contact ONCE and use the returned sendAs value as 'to'. Never call find_contact more than once per send — if it found one person, send immediately; if several, ask the user; if none, ask for the number. Sending is only complete after THIS tool returns ok — describing a draft is not sending.",
    inputSchema: {
      to: z.string().describe("Recipient in the form 'Name (+34612345678)' as returned by find_contact. Also accepted: a bare phone number with country code, an EXACT unique contact name, or an EXACT group name."),
      body: z.string().describe("The message text to send."),
      dry_run: z
        .boolean()
        .optional()
        .describe("Resolve the recipient without sending. Never set unless the user asks."),
    },
  },
  async ({ to, body, dry_run }) => {
    if (!body.trim()) throw new Error("Refusing to send an empty message.");
    const { jid, name } = resolveSendRecipient(to);
    const numberLabel = jid.endsWith("@g.us")
      ? "group"
      : numberOf(jid)
        ? `+${numberOf(jid)}`
        : "WhatsApp contact";

    if (dry_run) {
      return jsonResult({
        ok: true,
        dryRun: true,
        to: name,
        number: numberLabel,
        jid,
        body,
        ...glanceResult([
          header("Ready"),
          { type: "keyValue", pairs: [["To", trim(`${name} · ${numberLabel}`, 64)], ["Message", trim(body, 64)], ["Status", "Dry run — not sent"]] },
        ]),
      });
    }

    const s = await connectedSocket();
    // Unknown raw numbers: make sure they're actually on WhatsApp first.
    if (!store.chats[jid] && jid.endsWith("@s.whatsapp.net")) {
      const check = await s.onWhatsApp(jid).catch(() => null);
      const hit = check?.[0];
      if (hit && !hit.exists) throw new Error(`+${jid.split("@")[0]} is not on WhatsApp.`);
    }
    const sent = await s.sendMessage(jid, { text: body });

    const chat = chatFor(jid);
    const ts = Math.floor(Date.now() / 1000);
    chat.messages.push({
      id: sent?.key?.id ?? `sent-${ts}`,
      fromMe: true,
      sender: "me",
      text: body.slice(0, 1000),
      ts,
    });
    chat.lastTs = ts;
    chat.unread = 0; // replying implies the user has seen the chat
    scheduleSave();

    lastSent = { to: name, number: numberLabel, body: body.slice(0, 200), ts };

    return jsonResult({
      ok: true,
      to: name,
      number: numberLabel,
      jid,
      body,
      ...glanceResult([
        header("Sent"),
        { type: "keyValue", pairs: [["To", trim(`${name} · ${numberLabel}`, 64)], ["Message", trim(body, 64)]] },
        { type: "badges", items: [{ text: "Delivered to WhatsApp", tone: "good" }] },
      ]),
    });
  },
);

await server.connect(new StdioServerTransport());
