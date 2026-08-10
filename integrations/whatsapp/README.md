# WhatsApp

Read and send WhatsApp messages by voice — pairs with your phone via an
8-character code, no QR scan.

A [VoiceOS](https://www.voiceos.com) integration. Talk to VoiceOS and it can
call the tools in this folder; results show as native cards in the notch.
Under the hood it speaks the real WhatsApp Web multi-device protocol via
[Baileys](https://github.com/WhiskeySockets/Baileys) — no browser, no
business API.

> Unofficial client: using it is against WhatsApp's ToS and carries a
> (small, mostly send-pattern-driven) account-ban risk. Your call.

## Tools

- `link_whatsapp` — pair this Mac (pairing code shown in the notch)
- `whatsapp_status` — linked? connected? how many chats synced?
- `unread_messages` — inbox summary with unread badges
- `read_chat` — recent messages with a person or group
- `send_message` — send a text (confirmation card before it goes out)

Session credentials live in `wa-auth/`, the local message ledger in
`wa-store.json` — both gitignored, both stay on this Mac. Only messages
that arrive while VoiceOS is running (plus the short history WhatsApp
pushes on pairing) are available.

## Develop

```bash
bun install
bun verify.ts   # after every change; runs offline (WA_PASSIVE=1)
```

`tools/smoke.ts` opens a real (unauthenticated) socket to prove the
Baileys/Bun stack works — don't run it while a linked session is live.

Install into VoiceOS: Settings → Agent Mode → Integrations → Install from
folder. Editing with an AI agent? Point it at this folder — AGENTS.md
teaches it the whole contract.
