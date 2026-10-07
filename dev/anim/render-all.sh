#!/bin/sh
# Render the review clips (854x480, every frame) one after another: dev/anim/out/<scene>.mp4.
#   sh dev/anim/render-all.sh [scene ...]     (default: the full set)
cd "$(dirname "$0")/../.." || exit 1
SCENES="${*:-walk door climb acts run tour}"
sh dev/anim/serve.sh || exit 1
for s in $SCENES; do
  echo "== $s $(date +%H:%M:%S)"
  node dev/anim/capture.cjs "$s" --size 854x480 || echo "FAILED $s"
done
echo "== done $(date +%H:%M:%S)"
