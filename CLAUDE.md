# MUTE: notes for contributors and AI assistants

Co-op WebXR horror game (TypeScript + Vite + three.js). Read `docs/DESIGN.md` first.

## Commands
- `npm run dev`: desktop testing at http://localhost:5173 (`?net=local` = multi-tab multiplayer)
- `npm run dev:https`: LAN HTTPS so a Quest headset can open it
- `npm test`: vitest unit tests (core rules, input math, audio math, local transport)
- `npm run build`: typecheck + production build

## Architecture rules (they keep the web → native-app port cheap, see docs/PORTING.md)
- `src/core/` is pure TypeScript over plain JSON data: **no three.js, DOM, WebAudio or network
  imports.** All game rules live here and run only on the host.
- Shared types live in `src/core/types.ts`. Shared tunables live in `src/config.ts`. Tune the game
  there, not with magic numbers in modules.
- Platform code (three.js / WebXR / WebAudio) lives in `src/platform/` behind the interfaces in
  `src/platform/types.ts`. The game loop (`src/game/`) only talks to those interfaces.
- Network messages are defined in `src/net/protocol.ts` (plain JSON, star topology through the
  host; voice is a peer-to-peer mesh).
- Hand poses use the canonical hand frame documented on `HandPose` in `src/core/types.ts`.
