# MUTE

**A co-op VR horror game. The monster is blind, but it hears everything, including your real voice.**

You *can* talk. It's just a really bad idea. It's pitch dark, so you talk with your **hands** and
flash an old camera so your friends can read your hand signs, frozen in the air for a moment.
Every flash clicks. Film runs out. Find the fuses, open the front door, get out.

- 1–4 players, online (WebRTC) or solo
- Meta Quest browser (controllers **and** hand tracking), or desktop keyboard + mouse
- Runs straight from a web link, no install. Installable as a PWA.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full design and
[`docs/PORTING.md`](docs/PORTING.md) for the path from web to a store app.

**Picking the project up?** Read [`docs/HANDOFF.md`](docs/HANDOFF.md) first: project state, the code
map, known traps and the next steps. The future story, chapters, tools and difficulty are in
[`docs/STORY.md`](docs/STORY.md), and the concept art is in [`docs/concept/`](docs/concept/).

## Play it

| | VR (Quest) | Desktop |
|---|---|---|
| Move / turn | Left stick / right stick (snap) | WASD / mouse |
| Sneak (quiet) | Crouch for real | Hold C |
| Run (loud) | Click left stick | Shift |
| Grab / drop | Grip near the thing | E |
| Read a note | Lean in close | Look at it, E (E again to stand up) |
| Flash the camera | Trigger while holding it | Left click while holding it |
| Hand signs | Your real hands | Keys 1–6 |
| Talk | Just talk (it hears you) | Just talk |

The host starts a round with the trigger (VR) or a click (desktop).

**Hand tracking (no controllers):** pinch your left thumb and index finger and *hold* to walk where
your left hand points. Make a fist near something to grab it, and pinch to flash the camera.

## Run it locally

```bash
npm install
npm run dev          # http://localhost:5173 (desktop testing)
npm run dev:https    # https://<your-pc-ip>:5173 on your Wi-Fi, so a Quest can open it (WebXR needs HTTPS)
npm test             # game-rule unit tests
npm run build        # typecheck + production build into dist/
```

On the Quest, open the `dev:https` address in the Quest browser, accept the self-signed
certificate warning, then press **Enter VR**.

**Test multiplayer on one computer:** open `http://localhost:5173/?net=local` in two tabs. Host in
one tab and join with the code in the other (no internet needed, no voice).

## Put it online (GitHub Pages)

1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions** (not "Deploy from a
   branch": that publishes the raw source files, which can't run).
2. Push to the default branch. `.github/workflows/pages.yml` builds and deploys automatically.
3. Open `https://<user>.github.io/<repo>/` in the Quest browser and share it with friends.

## Project layout

```
src/
  config.ts          every gameplay "feel" number in one place
  core/              game rules: level, physics, monster AI + hearing, sim (pure TS, unit tested)
  game/              session (solo / host / client) + the frame loop
  net/               protocol + transports (PeerJS WebRTC with voice, BroadcastChannel for tests)
  platform/          three.js renderer, WebXR/desktop input, WebAudio (behind interfaces)
  ui/                DOM menus + desktop HUD
public/              PWA manifest, service worker, icons
docs/                design + porting docs
```
