#!/usr/bin/env bash
# Start the full-device rig: WebDriverAgent on the phone + the viewer server.
# Requires: iPhone plugged in over USB, unlocked, Developer Mode on.
set -euo pipefail

cd "$(dirname "$0")"

DEVICE_ID="${DEVICE_ID:-$(xcrun devicectl list devices 2>/dev/null | awk '/connected/ {print $4; exit}')}"
TEAM="${DEVELOPMENT_TEAM:-LWY89QN6T6}"

if [ -z "${DEVICE_ID}" ]; then
  echo "No connected iPhone found. Plug it in and unlock it."
  exit 1
fi
echo "Using device ${DEVICE_ID}"

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "Starting WebDriverAgent on the phone…"
# WDA's test session dies if the phone locks or the cable hiccups, so supervise it.
(
  cd wda
  while true; do
    xcodebuild -project WebDriverAgent.xcodeproj \
      -scheme WebDriverAgentRunner \
      -destination "platform=iOS,id=${DEVICE_ID}" \
      -allowProvisioningUpdates DEVELOPMENT_TEAM="${TEAM}" \
      test-without-building
    echo "--- WebDriverAgent exited; restarting in 3s ---"
    sleep 3
  done
) > /tmp/wda.log 2>&1 &

echo "Waiting for WebDriverAgent to come up…"
for _ in $(seq 1 60); do
  if grep -q "ServerURLHere" /tmp/wda.log 2>/dev/null; then break; fi
  sleep 1
done

echo "Starting viewer server…"
cd server
exec node server.js
