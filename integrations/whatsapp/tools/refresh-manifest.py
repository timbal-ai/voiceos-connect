#!/usr/bin/env python3
"""Refreshes the manifest snapshot in VoiceOS's install record for notch-whatsapp,
preserving the record's current configValues (which the app may have encrypted).
Run after editing voiceos.integration.json, only while VoiceOS is closed."""
import json, os, shutil

CONFIG = os.path.expanduser("~/Library/Application Support/VoiceOS/config.json")
DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

manifest = json.load(open(os.path.join(DIR, "voiceos.integration.json")))
cfg = json.load(open(CONFIG))
recs = cfg.get("installedIntegrations") or []
hit = False
for r in recs:
    if r.get("manifest", {}).get("id") == manifest["id"]:
        r["manifest"] = manifest
        r.setdefault("configValues", {})
        hit = True
        print("refreshed manifest for", manifest["id"])
assert hit, "record not found — run manual-install.py first"
shutil.copy(CONFIG, CONFIG + ".bak-refresh")
json.dump(cfg, open(CONFIG, "w"), indent=2)
print("written")
