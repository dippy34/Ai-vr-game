#!/bin/sh
# encode.sh <framesDir> <out.mp4>
set -e
ffmpeg -loglevel error -y -framerate 30 -i "$1/f_%05d.jpg" -c:v libx264 -preset slow -crf 18 -tune film \
  -pix_fmt yuv420p -movflags +faststart "$2"
ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$2"
