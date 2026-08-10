# Cursor for VoiceOS

A [VoiceOS](https://www.voiceos.com) integration. Speak a coding task into the
notch, like *"add a dark-mode toggle to the settings page and open a PR"*, and a
[Cursor](https://cursor.com) agent makes the changes in your repo, pushes a
branch, and opens the pull request. The notch tracks it in the background and
shows the outcome card when it ships.

## Tools

- **`run_coding_agent`**: starts a Cursor agent on a repo (confirmation card
  with model picker, local or cloud runtime, background execution, optional PR).
- **`list_repos`**: read-only browse of git repos found on this Mac.
- **`agent_status`**: read-only glance at running and finished agents.

## Setup

Needs a Cursor API key (cursor.com/dashboard, Integrations). VoiceOS asks for
it on first use, plus a default repo path.

## Develop

```bash
bun add @modelcontextprotocol/sdk zod @cursor/sdk
bun verify.ts
```

Install into VoiceOS: Settings, Agent Mode, Integrations, Install from folder.
After edits, hit Reload.
