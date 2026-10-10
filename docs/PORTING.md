# Taking MUTE from the web to an app

MUTE runs in the browser today (WebXR, so it plays on a Quest straight from a link). The code is
split so the move to a store app is a wrapper or a port, not a rewrite.

## How the code is layered

| Layer | Folder | Knows about | Porting cost |
|---|---|---|---|
| **Game rules** | `src/core/` | Nothing. Plain TypeScript and plain JSON data | Reuse as-is (web wrapper) or translate 1:1 to C#/GDScript |
| **Tunables** | `src/config.ts` | Nothing | Copy the numbers |
| **Session / game loop** | `src/game/` | `core`, `net`, the platform **interfaces** | Small. Mostly the same logic in the new engine's update loop |
| **Network protocol** | `src/net/protocol.ts`, `transport.ts` | JSON messages | Keep the same messages over any transport |
| **Transports** | `src/net/*` | PeerJS (WebRTC), BroadcastChannel | Swap for the engine's networking (e.g. Photon, Normcore, Godot WebRTC/ENet) |
| **Platform** | `src/platform/` | three.js, WebXR, WebAudio | Re-implement `IGameRenderer`, `IInputManager`, `IAudioManager` (see `src/platform/types.ts`) |
| **Menus** | `src/ui/` | DOM | Rebuild with the engine's UI, same callbacks |

The rules (monster AI, hearing, items, win/lose) never touch rendering, input or audio, so they
can be unit tested (`npm test`) and moved anywhere.

## Route 1 (fastest): package the web build as a Quest app (PWA)

Meta's Horizon Store accepts Progressive Web Apps. The game already ships as one: there's a
`manifest.webmanifest`, icons and an offline service worker in `public/`.

1. Deploy the web build to HTTPS (GitHub Pages workflow in `.github/workflows/pages.yml`).
2. Use Meta's PWA packaging tool (`ovr-platform-util create-pwa`, see Meta's "Progressive Web
   Apps" developer docs) to wrap the hosted URL + manifest into an APK.
3. Upload the APK to the Meta developer dashboard.

**Pros:** zero code changes, and updates ship by redeploying the website. **Cons:** browser
performance limits, and the store presence feels slightly less "native".

## The Unity port (decided October 2026)

The owner chose **Unity** over Godot and Unreal for the store version:
- **Unity:** Meta builds its Quest tools for it first (hand tracking, frame-rate features, store
  achievements and purchases), drop-in co-op voice that reports mic loudness (Photon Voice or
  Normcore), the Asset Store for better textures, and it runs on the owner's MacBook.
- **Godot** (the runner-up): free forever and the most AI-friendly (scenes are plain text), but
  we'd build voice chat ourselves and its Quest graphics tuning is less mature.
- **Unreal:** its high-end rendering doesn't run on standalone Quest, Mac-to-Quest development is
  poorly supported, and it's the hardest for an AI assistant to work in.

**Setup** (the owner, on the Mac): Unity Hub → the newest **Unity 6 LTS** with *Android Build
Support* (OpenJDK, Android SDK and NDK); Quest in developer mode; Meta Quest Developer Hub for
installing builds. Claude Code runs **locally on the Mac** inside the Unity project, so it can edit
scripts and (with a Unity MCP bridge) read the console and drive the editor. Note: Quest Link
(play-in-editor through the headset) is Windows only, so on the Mac you test in the editor with
keyboard/mouse or a simulator, and build to the headset over USB.

**Where it lives:** a `unity/` folder in this repo next to the web game, with Unity's standard
`.gitignore` (Library/, Temp/, Obj/, Build/, Logs/, UserSettings/). Big textures may need Git LFS.

**Order:**
1. **First slice:** the Hale House, solo: Crank Light, one fuse, the monster hearing your mic.
   Check it holds frame rate on a Quest.
2. **Port `src/core/` to plain C#** (`unity/Assets/MUTE/Core/`, no UnityEngine in it, same rule as
   today) with the vitest suites translated to NUnit (Unity Test Framework) as the spec.
3. **Co-op and voice** (same JSON messages as `src/net/protocol.ts`, host-authoritative).
4. **Art upgrade:** high-res PBR textures, baked lighting plus the Crank Light as the one realtime
   shadowed light, fog, post-processing. Models still come from `art/blender/`.
5. **The monster's procedural animation** (`src/platform/render/monster/`) ported to C#.
6. **Sound:** the procedural sounds (`src/platform/audio/`, the new `monsterVoice.ts`) rendered
   to WAV variations with the offline renderers in `dev/` and played through Meta's spatial audio.
7. **Store prep.**

## Route 2: a native port (Godot 4 or Unity)

When the game needs more performance, better audio, or store features (achievements, IAP):

1. **Port `src/core/` first.** It's ~pure functions over plain data. Keep the same type names
   (`WorldState`, `SimEvent`, `NoiseEvent`, ...) and the existing unit tests as a spec.
2. **Keep `src/net/protocol.ts` as the wire format** so web and native builds could even play
   together during a transition.
3. **Implement the three platform interfaces** with engine features: XR hand tracking →
   `FingerCurls` (5 numbers per hand), spatial audio for voices and the monster, the flash
   afterimage effect. The web look lives in three's shader chunks (`src/platform/render/fx/`:
   AgX tone curve + look, height fog with flash in-scatter, grain/dither/vignette, room AO
   field, monster skin): engines do these as post-processing / material graphs, so port the
   numbers in `RENDER`, not the patching.
4. Copy `src/config.ts` numbers so the game feels the same.

### Multiplayer in a native engine

There is no game server today: one player's game is the host (it runs `src/core`'s GameSim) and
the others connect to it peer to peer over WebRTC, introduced by the free PeerJS signaling
service. The **design** carries over to any engine unchanged; the **transport code** (PeerJS)
is web-only and gets swapped for the engine's networking:

| Engine | Suggested stack | Notes |
|---|---|---|
| Unity | Netcode for GameObjects + Unity Relay/Lobby, or Photon Fusion / Normcore | Normcore and Photon include VR-friendly voice; Relay solves strict-NAT players (what the web build needs a TURN server for) |
| Unreal | Built-in replication + Epic Online Services (lobbies, P2P relay, voice; free) | Heavier for standalone Quest; budget performance early |
| Godot 4 | High-level multiplayer over ENet or WebRTC | Closest to the current code |
| Any (Quest store) | Meta Platform SDK rooms/invites/voice | Also gives store-native friend invites |

Keep the host-authoritative model and the messages in `src/net/protocol.ts` (they map to
RPCs/replicated state). The monster still hears each player's **local** mic level, sent to the
host like today, whatever voice service carries the actual audio.

## Route 3: PC VR / Steam

Either the native port above (Godot/Unity export to SteamVR/OpenXR), or wrap the web build in a
desktop shell such as Electron. Verify WebXR + OpenXR support in that shell before committing to it.

## Things to replace before a real launch

- **Signaling/TURN:** PeerJS's free public signaling server and Google STUN are fine for testing.
  For launch, run your own PeerJS server (or another signaling service) plus a TURN server so
  players behind strict NATs can connect. Configure them with `VITE_PEER_*` / `VITE_ICE_SERVERS`
  env vars (see `src/net/`).
- **Audio:** procedural sounds are placeholders. A sound design pass (recorded or licensed assets)
  will help the horror a lot.
- **Moderation/safety:** open voice chat with strangers needs reporting/muting tools and age
  ratings before a store release.
