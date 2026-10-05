# MUTE: game design

> A co-op VR horror game. The monster is blind, but it hears **everything**, including your real voice.
> You *can* talk. You just probably shouldn't. Your hands do the talking.

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
- Sign to a teammate ("it's there", "3 fuses left", "run", "stop", "come here"), then flash so
  they can see it. The afterimage hangs in the air for ~2 seconds.
- Caught players become spectators. The monster ignores them.

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
| Move | Left stick (smooth) | WASD |
| Turn | Right stick (snap 30°) or real body | Mouse (click to lock pointer) |
| Sneak (quiet) | Crouch in real life | Hold C (crouch) or Ctrl |
| Sprint (loud) | Click left stick | Shift |
| Grab / drop | Grip near item | E |
| Flash | Trigger while holding camera | Left click while holding camera |
| Hand signs | Your actual hands / fingers | Keys 1–6 |
| Talk | Just talk (mic is always on) | Just talk |

## Look and sound

- **Visual:** low-poly, near-black, blue-gray moonlight, exponential fog. The flash is blinding
  white, and afterimages are pale ghostly copies that fade. The monster is very tall and thin, with
  long arms and no eyes. You see it only in flashes, which is the point.
- **Audio:** all procedural WebAudio for now (no asset files). Spatialized HRTF voices and monster
  sounds, a low drone, house creaks, a heartbeat. Sound is half of horror, so it gets real effort.

## Why it can sell

- The core twist (**talk with your hands, read signs by camera flash**) only works in VR. We found
  no other game built around it.
- Monster-hears-your-mic games are proven streamer bait, and silent signing makes for funny,
  panicky clips.
- Small, dark scope: one house, a few rooms, darkness hides simple art.

## Roadmap after this prototype

1. Playtest the core: is signing in flashes fun? Tune `src/config.ts`.
2. More houses/levels, item randomization, a smarter monster (learns hiding spots).
3. Proper sound design pass, possibly recorded assets.
4. Ship: Meta Horizon Store (PWA wrapper or native port), then Steam. See `docs/PORTING.md`.
