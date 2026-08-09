#!/usr/bin/env bash
# Fetch WebDriverAgent and apply the one local change we need: a unique bundle
# identifier, so the runner can be signed with your own team instead of
# Facebook's (which is already registered to someone else).
#
# WDA is a third-party dependency with its own git history, so it is not
# vendored into this repo. Run this once after cloning.
set -euo pipefail

cd "$(dirname "$0")"

if [ -d wda ]; then
  echo "wda/ already exists — nothing to do."
  exit 0
fi

echo "Cloning appium/WebDriverAgent…"
git clone --depth 1 https://github.com/appium/WebDriverAgent.git wda

echo "Applying unique bundle identifier…"
sed -i '' 's/com\.facebook\.WebDriverAgentRunner/com.voiceos.wda.runner/g' \
  wda/WebDriverAgent.xcodeproj/project.pbxproj

echo "Done. Now run ./start.sh (see README for signing setup)."
