# MUTE development trailer

The cut follows the owner's latest notes in `docs/HANDOFF.md` section 8: a close chase opens
the trailer, followed by real gameplay and the catch. Halcyon Acoustics is marked as in
development; future locations say "Soon to come" with a smaller "Concept preview" label.
Place names have no chapter or location numbers. Captions use short, plain wording.
The end card has no campaign, demo, website or PC/browser claims. The gameplay is captured
from the game renderer with scripted camera, monster and teammate movement. The soundtrack
uses the game's procedural effects plus the offline score in `audio.ts`.

## Rebuild on Windows or macOS/Linux

Requirements: the project dependencies (`npm ci`), FFmpeg/FFprobe on PATH, and Playwright
with Chromium. The scripts resolve a local Playwright package first and then a global one.

Start the capture server in one terminal:

```sh
npx vite --config dev/anim/vite.capture.config.ts
```

This server disables file watching. Restart it after editing game source or `audio.ts`.

In another terminal:

```sh
node dev/trailer/fonts.mjs
node dev/trailer/cards.cjs
node dev/trailer/shots.cjs --size 1920x1080
node dev/trailer/trailer.cjs
```

On a desktop with hardware graphics, set `CAPTURE_GPU=1` to use the GPU instead of
SwiftShader. In PowerShell: `$env:CAPTURE_GPU='1'`. Leave it unset for software rendering.
To use an existing Chromium installation, set `CHROME_PATH` to its executable.
`NODE_PATH` can point to a runtime's bundled Node packages if Playwright is provided there.

`shots.cjs hall --test` captures three sample frames; named shots can be captured individually
(`hall`, `door`, `climb`, `hands`, `wind`, `rush`). `trailer.cjs --preview 2` makes a short rough cut.

The outputs are `out/mute_trailer.mp4` (1080p30 master) and `out/mute_trailer_web.mp4`
(smaller sharing copy). `out/` and downloaded `fonts/` are ignored by Git. The approved exports
are saved in [`docs/trailer/`](../../docs/trailer/):

- [`mute_trailer.mp4`](../../docs/trailer/mute_trailer.mp4): 48-second 1080p30 master.
- [`mute_trailer_web.mp4`](../../docs/trailer/mute_trailer_web.mp4): smaller sharing copy.

After an approved revision, copy the two exports there to publish them with the source changes.

The current chapter images are 960x540 previews. Full-HD renders in `docs/concept/raw/`
are used automatically when available; see `art/concept/README.md`.

Gameplay was recaptured after fixing arm roll flips, wrist snaps, and the transition off
the table, and tucking the elbows for narrow doorways. The body regression tests replay
the exact `door`, `climb`, `wind`, and `rush` paths, including frame-to-frame joint motion
and doorway elbow clearance. `shots.cjs` exports `SHOTS` without starting a capture.
