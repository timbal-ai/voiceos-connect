# Building this VoiceOS integration (guide for AI coding agents)

You are editing **Notch Coder**, a VoiceOS integration: a folder that
teaches the VoiceOS voice agent new tools, with native UI in the Mac notch.
This file is the whole contract — no VoiceOS internals needed.

## What a user experiences

The user talks to VoiceOS. The agent picks one of the tools declared here,
VoiceOS runs this folder's MCP server (`server.ts`), and the result appears
two ways: the model narrates the data, and the notch shows the tool's
**glance card** (blocks the tool attached via `glanceResult`). Tools that act
on the user's behalf first show a **confirmation card** declared in the
manifest, which the user can edit and approve.

## Files

- `voiceos.integration.json` — identity, runtime, permissions, tools
  (name/description/inputSchema/confirmation). Every manifest tool must be
  registered in server.ts with the same name, and vice versa.
- `server.ts` — standard MCP stdio server. Implement your logic in the tool
  handlers (marked TODO).
- `verify.ts` — run `bun verify.ts` after every change; all checks must ✓.

## Rules that make integrations feel native

1. **Tool descriptions are routing rules for the model**: what it does + when
   to use it ("Use when the user asks …").
2. **Results carry data AND a glance card**: JSON the model reasons about,
   plus `glanceResult([...])` for the user. Never put information only in
   the card.
3. **Glance cards are a 2-second read** — max 3 blocks. Vocabulary:
   `header` {icon?, appIcon?, title, trailing?}, `list` {header?, rows:
   [{icon?, title, subtitle?, trailing?, badge?: {text, tone?}}]} (≤6 rows),
   `stats` {items: [{label, value, delta?, tone?}]} (≤3), `keyValue`
   {pairs: [[label, value]]} (≤5), `bars` {labels, values, unit?} /
   `line` {points, tone?, baseline?} / `splitBar` {segments} (max ONE
   chart), `progress` {value, max?, label?, style?: "bar"|"ring"},
   `badges` {items} (≤3), `clock` {tz}, `countdown` {until|seconds},
   `divider`, `row` {children} (2-3 side by side). tone is
   "neutral"|"good"|"bad". Titles ≤60 chars; pre-trim strings. Icons:
   calendar clock timer bed car mail message music sun moon cloud rain star
   folder file globe pin phone person heart bolt check x mic note list
   battery chart dollar home wifi coffee plane sparkle.
   Off-schema blocks are silently dropped — verify catches shape mistakes.
4. **Anything that acts needs a manifest `confirmation` card.** Inputs bind
   to args with `{{argName}}`; edited values are what execute. Interactive
   vocabulary: card, stack, text, markdown, keyValue, metadata, list/listItem,
   image, badge, divider, progress, textField, passwordField, select, toggle,
   chips (inputs take `bind`), actions (roles confirm/cancel/copy/openUrl).
   Read-only tools must NOT declare one.
5. **Be honest**: throw on failure; never fabricate data or claim success.
6. **Least privilege**: list only domains you call in permissions.
7. **Long work (>20s) declares** `"execution": {"mode": "background"}` +
   the `background` permission — VoiceOS tracks it in the side panel and
   shows your glance card on completion.
8. **Secrets come from the user**: declare `preferences` /
   `auth:{"kind":"apiKey"}` fields; VoiceOS injects them as env vars named
   after each field (`process.env.MY_FIELD`). Never hardcode keys.

## Dev loop

```bash
bun add @modelcontextprotocol/sdk zod   # once
bun verify.ts                            # after every change
```

Then in VoiceOS: Settings → Agent Mode → Integrations → **Install from
folder** → pick this folder. After edits, hit the integration's **Reload**.
Tools appear to the agent on the next turn — just talk to it.

## Definition of done

- `bun verify.ts` exits 0, every check ✓.
- Each tool description says when the model should call it.
- Acting tools have confirmation cards; read tools don't.
- Glance cards read in 2 seconds.
