#!/usr/bin/env bash
# Try MJPEG configurations and report delivered framerate for each.
# Keep the phone on a fixed screen while this runs so results are comparable.
cd "$(dirname "$0")"

run() {
  local q=$1 s=$2
  lsof -ti :8080 | xargs kill 2>/dev/null
  sleep 1
  MJPEG_FPS=60 MJPEG_QUALITY=$q MJPEG_SCALE=$s node server.js > /tmp/tune-server.log 2>&1 &
  for _ in $(seq 1 30); do
    grep -q "session ready" /tmp/tune-server.log && break
    sleep 0.5
  done
  sleep 1
  # Wake the screen, otherwise a blank display gives fake (tiny) frames.
  node -e 'const W=require("ws");const w=new W("ws://localhost:8080/?role=viewer");w.on("open",()=>{w.send(JSON.stringify({type:"button",name:"home"}));setTimeout(()=>process.exit(0),1200);});' 2>/dev/null
  sleep 1
  printf "quality=%-3s scale=%-4s -> %s\n" "$q" "$s" "$(node fps.js 4)"
}

run 40 50
run 30 50
run 25 40
run 20 35
run 30 100

lsof -ti :8080 | xargs kill 2>/dev/null
echo "done"
