#!/bin/sh
# Quicker review clips: 640x360 at 15 fps (every 2nd game frame), one scene after another.
# Software rendering costs ~2-3 s per frame, so this halves a full render.
#   sh dev/anim/render-fast.sh [scene ...]     (default: the full set)
cd "$(dirname "$0")/../.." || exit 1
SCENES="${*:-walk door climb acts run tour}"
curl -s "http://localhost:${PORT:-5320}/" > /dev/null || sh dev/anim/serve.sh || exit 1
for s in $SCENES; do
  echo "== $s $(date +%H:%M:%S)"
  node dev/anim/capture.cjs "$s" --size 640x360 --every 2 --video || echo "FAILED $s"
done
echo "== done $(date +%H:%M:%S)"
