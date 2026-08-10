#!/usr/bin/env python3
"""Refreshes the manifest snapshot in VoiceOS's install record for notch-coder,
preserving the record's current configValues (which the app may have encrypted).
Run only while VoiceOS is closed."""
import json, os, shutil

CONFIG = os.path.expanduser("~/Library/Application Support/VoiceOS/config.json")
DIR = "/Users/dberges/Desktop/timbal-ai/notch-coder"

manifest = json.load(open(os.path.join(DIR, "voiceos.integration.json")))
cfg = json.load(open(CONFIG))
recs = cfg.get("installedIntegrations") or []
hit = False
for r in recs:
    if r.get("manifest", {}).get("id") == manifest["id"]:
        r["manifest"] = manifest
        # ensure new preference defaults exist without clobbering stored values
        cv = r.setdefault("configValues", {})
        cv.setdefault("SCAN_DIRS", "~/Desktop/timbal-ai,~/Projects,~/Developer")
        hit = True
        print("refreshed manifest; configValues keys:", sorted(cv.keys()))
assert hit, "record not found"
shutil.copy(CONFIG, CONFIG + ".bak-refresh")
json.dump(cfg, open(CONFIG, "w"), indent=2)
print("written")
