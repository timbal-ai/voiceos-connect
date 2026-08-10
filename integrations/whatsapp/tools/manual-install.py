#!/usr/bin/env python3
"""Registers the notch-whatsapp integration in VoiceOS's config store — the exact
record IntegrationManager.install() writes (decoded from app main.js v0.1.21).
Workaround for 0.1.21 shipping without the "Install from folder" button wired.
Run only while VoiceOS is closed."""
import json, hashlib, base64, re, os, shutil
from datetime import datetime, timezone

CONFIG = os.path.expanduser("~/Library/Application Support/VoiceOS/config.json")
DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

manifest = json.load(open(os.path.join(DIR, "voiceos.integration.json")))

# deriveServerId: sha256(id) -> base64url -> lowercase -> strip non [a-z0-9_] -> 13 chars
digest = hashlib.sha256(manifest["id"].encode()).digest()
b64 = base64.urlsafe_b64encode(digest).decode().rstrip("=").lower()
server_id = "int_" + re.sub(r"[^a-z0-9_]", "", b64)[:13]

cfg = json.load(open(CONFIG))
owner = (cfg.get("userProfile") or {}).get("id")
assert owner, "no signed-in user profile in config"

record = {
    "manifest": manifest,
    "dirPath": DIR,
    "ownerUserId": owner,
    "enabled": True,
    "installedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "source": "local-folder",
    "serverId": server_id,
    # no auth fields or preferences in this manifest
    "configValues": {},
}

# The record alone isn't enough: install() ALSO materializes a server entry
# into the customMcpServers store, which is what McpClientManager boots from.
# Without this second write the agent never sees the tools ("not supported").
server_entry = {
    "id": server_id,
    "name": manifest["name"],
    "enabled": True,
    "integrationId": manifest["id"],
    "confirmTools": [t["name"] for t in manifest["tools"] if "confirmation" in t],
    "transport": "stdio",
    "command": manifest["runtime"]["command"],
    "args": manifest["runtime"]["args"],
    "cwd": DIR,
}

shutil.copy(CONFIG, CONFIG + ".bak-notchwhatsapp")
existing = [r for r in cfg.get("installedIntegrations") or [] if r.get("manifest", {}).get("id") != manifest["id"]]
cfg["installedIntegrations"] = existing + [record]
servers = [s for s in cfg.get("customMcpServers") or [] if s.get("integrationId") != manifest["id"]]
cfg["customMcpServers"] = servers + [server_entry]
json.dump(cfg, open(CONFIG, "w"), indent=2)
print("installed:", manifest["id"], "serverId:", server_id, "owner:", owner[:8] + "…")
print("records now:", len(cfg["installedIntegrations"]), "| mcp servers:", len(cfg["customMcpServers"]))
