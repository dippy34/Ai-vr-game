#!/bin/sh
# (Re)start the no-HMR capture server on :5320 (or $PORT) from this worktree, in the background.
cd "$(dirname "$0")/../.." || exit 1
PORT="${PORT:-5320}"
pkill -f "vite --config dev/anim/vite.capture.config.ts" 2>/dev/null
sleep 0.5
mkdir -p dev/anim/out
PORT="$PORT" nohup npx vite --config dev/anim/vite.capture.config.ts > dev/anim/out/vite.log 2>&1 &
for i in $(seq 1 40); do
  if curl -s "http://localhost:$PORT/" > /dev/null; then echo "serving on :$PORT"; exit 0; fi
  sleep 0.25
done
echo "server did not start"; cat dev/anim/out/vite.log; exit 1
