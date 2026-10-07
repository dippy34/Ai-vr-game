# MUTE: game design

> A co-op VR horror game. The monster is blind, but it hears **everything**, including your real voice.
> You *can* talk. You just probably shouldn't. Your hands do the talking.

> **Direction update (Oct 2026):** this doc describes the game as it plays today (one house). The
> agreed future, a chapter-based story game with big maps and chases, the **Crank Light**
> replacing the camera flash (and no more afterimages), the **Echo** gadget and near-impossible
> difficulty, is in [`STORY.md`](STORY.md). The build plan is in [`HANDOFF.md`](HANDOFF.md).

## Pitch

1–4 players wake up in a dark, abandoned house. Something tall and eyeless lives here. It can't see
you, but it hears your footsteps, the click of your camera and **your real microphone**. Whisper and
it might not notice. Talk normally and it comes to check. Scream and it charges.

The house is almost pitch black. The only real light is **an old camera with a flash** that the team
passes around. Every flash lights up the room for a split second and leaves **frozen afterimages**
of everyone's hands in the air. That's how you read each other's hand signs in the dark. But every
flash makes a *click*, and film is limited.

**Goal:** find the fuses, put them in the fuse box to power the exit door, and get out. Opening the
door makes a huge noise, so the last sprint is always a chase.

## The three rules of MUTE

1. **Talking is allowed, and it's dangerous.** Voice is on all the time and spatialized, so nearby
   players hear you from where you stand. The monster hears whatever your mic picks up, scaled by
   distance and walls (see `HEARING` in `src/config.ts`).
2. **It's dark.** You can barely see silhouettes up close. You can't read a hand sign unless it's lit.
3. **Light costs noise.** Each flash is a click the monster can hear, and film runs out.

## Moment-to-moment

- Explore by touch and sound. Faint moonlight through windows, a dim glint on items up close.
- The monster is invisible in the dark. You *hear* it: breathing, heavy steps, the floor creaking.
  Your heartbeat speeds up as it gets near.
- Hold still and quiet, and it walks right past you (unless it bumps into you).
- It remembers where it heard things. Keep making noise in one room and it starts patrolling there
  (the memory fades after a minute or two).
- Sign to a teammate ("it's there", "3 fuses left", "run", "stop", "come here"), then flash so
  they can see it. The afterimage hangs in the air for ~2 seconds.
- Caught players become spectators. The monster ignores them.

## How the monster thinks

It is **blind**. It only knows what it hears (`HEARING`: loudness x range vs distance, each wall
in between counts extra), what it touches (bumping into you, its searching hands, its sweep)
and what it remembers. Everything runs on the host (`src/core/monster.ts`), seeded, so every
client sees the same monster. Tunables: `MONSTER` and `NAV` in `src/config.ts`.

- **Moving.** A fine nav grid (0.2 m, `src/core/navgrid.ts`, built once per level) knows where
  its 2.6 m body fits: upright, **ducking** under 2.4 m door lintels (slower), **crawling** on
  all fours through tight gaps, or **climbing** over low furniture (beds, tables, couches,
  crates: `position.y` follows the top). A* picks the fastest route for its current pace, so it
  clambers over a bed while searching but runs around it in a chase. Hiding behind furniture
  is not safe, and no standable spot is out of its reach (a test checks every one).
- **Patrol (wander).** It roams briskly from room to room and prowls inside them, stopping
  now and then to listen or sniff. It heads for rooms it has not *listened to* lately (the
  hallway "covers" the rooms around it), rooms where it heard things (noise memory, fades over
  a couple of minutes) and the fuse-box room. When it freezes to listen it hears better.
- **A faint sound** makes it freeze and turn its head, then **stalk**: it walks closer, then
  creeps (near-silent steps), stopping to listen. Hear that sound again and it **lunges**.
  A normal sound gets a short freeze and a walk over. A loud or close one gets a **charge**.
- **Chasing** it runs at the last thing it heard; if you keep making noise while running it
  aims ahead of you (cutting through doorways). Arriving where it heard you a moment ago, it
  swipes. Silence for a few seconds and it loses you.
- **Searching.** Arriving and finding nothing, it listens, then checks 2-3 likely hiding spots
  nearby (corners, behind furniture, beside the door), feeling around (its hands find you
  within ~1 m), sniffing, or **sweeping**: a long-armed swipe with a 0.5 s wind-up (a hiss you
  can hear) that catches anyone within 1.6 m in front of it, never through a wall. After a
  search, and more often after losing a chase, it may **lurk**: wait motionless beside a
  doorway or in a corner for 6-12 s, ready to lunge at small sounds.
- **Escalation.** Every fuse makes it faster and keener, and so does a long round. When the
  exit opens it goes into a **frenzy**: faster, hears more, charges at less, guards the exit.
- **Body language.** Every tick the sim publishes what its body is doing (`gait`, `posture`,
  `act`, `actStart`, `focus` on `MonsterState`) and keeps it truthful (it ducks only under a
  lintel, crawls only where it must, "run" only at speed). The animation and its sounds
  (`src/platform/audio/monster.ts`) follow those, so players can *read* it in the dark: creeping
  steps, held breath while it listens, scrapes on all fours, the hiss before a sweep.

## Hand signs

There's no fixed sign vocabulary. Players invent their own, which is half the fun (and great clips).
Tech-wise, we network 5 finger curls per hand plus the wrist pose, which is enough for pointing,
fists, open palm "stop", thumbs up/down, counting 1–5, "come here" waves and slashes.

- **Hand tracking (Quest):** real finger curls from joint data.
- **Controllers:** trigger = index curl, grip = middle/ring/pinky curl, thumb resting on a
  button/stick = thumb curled, lifted = thumbs up.
- **Desktop:** number keys play preset signs on the right hand (1 point, 2 stop, 3 thumbs up,
  4 fist, 5 count-three, 6 come-here wave).

## Items and objective

| Thing | What it does |
|---|---|
| **Camera** | One per round. Grab it, trigger to flash. Shows its film count on its back. Starts with 6 shots. |
| **Film roll** | Touch/grab to load +3 film into the camera (whoever holds it). |
| **Fuse** | Carry it to the fuse box. It inserts automatically when held close. |
| **Fuse box** | Next to the exit. One light per fuse. All lit = the exit door unlocks *loudly*. |
| **Exit door** | Walk through once it's open to escape. Round is won if anyone escapes. |

## Controls

| Action | VR | Desktop |
|---|---|---|
| Move | Left stick (smooth). Hand tracking: hold a left pinch + point | WASD |
| Turn | Right stick (snap 30°) or real body | Mouse (click to lock pointer) |
| Sneak (quiet) | Crouch in real life | Hold C (crouch) or Ctrl |
| Sprint (loud) | Click left stick | Shift |
| Grab / drop | Grip near item | E |
| Read a note | Lean in close | Aim at it, E (leans in; E again or move to stand up) |
| Flash | Trigger while holding camera | Left click while holding camera |
| Hand signs | Your actual hands / fingers | Keys 1–6 |
| Talk | Just talk (mic is always on) | Just talk |

## Look and sound

- **Visual:** near-black, filmic (AgX) tone curve, cold moonlight pooling through the windows with
  dusty shafts, height fog that swallows far rooms. The flash is blinding white with real shadows
  (inverse-square falloff: whatever is close burns out, the far end of the room stays murky) and
  lights up the haze and dust in the air; afterimages are pale ghostly copies that fade. The monster
  is very tall and thin, with long arms and no eyes, wet, pale skin that glows red where it's thin.
  You see it only in flashes, which is the point. Desktop and Quest share one look; the Quest tier
  only lowers shadow resolution, grain and vignette (`RENDER.quality`).
- **Audio:** all procedural WebAudio for now (no asset files). Spatialized HRTF voices and monster
  sounds, a low drone, house creaks, a heartbeat. Sound is half of horror, so it gets real effort.

## Why it can sell

- The core twist (**talk with your hands, read signs by camera flash**) only works in VR. We found
  no other game built around it.
- Monster-hears-your-mic games are proven streamer bait, and silent signing makes for funny,
  panicky clips.
- Small, dark scope: one house, a few rooms, darkness hides simple art.

## Roadmap after this prototype

> Superseded by [`STORY.md`](STORY.md) and [`HANDOFF.md`](HANDOFF.md) §6. Kept for reference.

1. Playtest the core: is signing in flashes fun? Tune `src/config.ts`.
2. **A map board, not a linear campaign.** Pick which house to enter; escaping unlocks bigger ones
   (farmhouse, motel, school, hospital) with more fuses and new trouble. Every round reshuffles
   fuses and the monster, so no house is ever "done". Difficulty = how well it hears (Nightmare:
   it hears whispers). The notes tie the houses into one family story.
3. **A darkroom hub** between rounds: the photos you flashed get developed and hang on a line
   (shareable moments).
4. **Second chance** (rules + tests written, shelved in commit `99e544d`; revert its revert to
   resume): the first time it reaches you each round it grabs you instead, and you get ~1.6 s to
   get out. Pry its jaws apart (VR: grab both glowing spots and pull; desktop: the two keys
   shown, a wrong key fumbles), or Last Flash point-blank (costs film), or a teammate makes a big
   noise and it drops you for them. Loud Mode (lobby option, off by default) lets a real scream
   count. Screaming must never be the only way out: players in apartments.
5. **The Nest** (story finale, later): a secret cellar where you finally fight it with sound, flash
   and hand-signed timing. Rule until then: you can hurt it, but you can't kill it.
6. Proper sound design pass, possibly recorded assets.
7. Ship: Meta Horizon Store (PWA wrapper or native port), then Steam. See `docs/PORTING.md`.
