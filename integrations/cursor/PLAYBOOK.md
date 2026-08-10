# VoiceOS Integration Playbook

Everything learned building the "Cursor" integration (Aug 9, 2026, VoiceOS
0.1.21 developer preview). Read this to kickstart the next integration in
minutes instead of hours. `AGENTS.md` in this folder is the official contract;
this file is the tribal knowledge the docs don't tell you.

## TL;DR architecture

An integration is a folder: `voiceos.integration.json` (manifest) + `server.ts`
(standard MCP stdio server, bun). VoiceOS launches the server, offers each
tool's `description` to its agent as a routing rule, ren