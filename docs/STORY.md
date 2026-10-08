# MUTE: story, progression, tools and difficulty

This is the agreed direction for the full game, worked out with the owner in October 2026. It
replaces the "one house, map board" roadmap in `DESIGN.md`. The core rules (a blind monster that
hears everything, including your real mic, and players who talk with their hands) do not change.

**Style target:** Poppy Playtime-like. Big explorable maps, a signature gadget that gets upgrades,
puzzles, scripted chase scenes and a climax at the end of each chapter. Co-op 1–4 or solo.

**Difficulty target:** *near impossible.* The prologue is gentle, then every chapter gets harder
(see [Difficulty](#difficulty)).

---

## The story (final version, v3)

**Setting:** Hollow Creek, a small town in 1996, during a storm. Above it on the hill sits
**Halcyon Acoustics**, a sound-research company.

**The monster ("the Listener")** used to be **Dr. Martin Hale**, a Halcyon scientist and the
father of Ellie and Tom. Project CLARITY put an implant in his head that made him hear
*everything*. It burned away the man. There is **no humanity left**: he is a brutal, uncaring
killer. Sound physically hurts him, and killing makes it stop. **He killed his own kids** and
didn't hesitate. They were just the first prey.

Rules the owner set (don't break these):
- The father is the monster. ✅
- **The kids are dead** before the players arrive. It's implied and found through traces (notes,
  drag marks, empty rooms), **never shown**. ✅
- **Nobody gets rescued**, ever. ✅
- **No sympathetic monster.** He isn't looking for his kids, "he's still Dad inside" doesn't
  apply, and there's no sad redemption ending. ✅

What the monster does:
- **Voice-stealing as bait:** he records the kids' last screams and sobs (and later yours) and
  plays them back through recorders and speakers to lure people in. He knows you'll come running.
  He enjoys it.
- **"It keeps coming back to the kitchen. We were loud there."** (an in-game note) isn't nostalgia.
  He returns to places where prey made noise: **hunting grounds**.

**Dad's tapes** (hidden collectibles) show his descent:
- Early: *"The kids are so loud."*
- Later: *"I made Tom quiet. It helped."*
- Last: *"Ellie's hiding. I can hear her breathing."*

**The players** are Ellie's friends from her **hand-sign club** (that's why they sign). They come
over for club night and find the house dark and silent. They're too late.

**Why they go to Halcyon:** the storm wrecks the only bridge out of town. The only way out is
Halcyon's service tunnel under the hill. Inside, they learn they can trap or kill him.

### In-game notes that already exist (keep the story consistent with them)
Text lives in `art/blender/decals_notes.py`:
- tutorial: "If you can read this, don't say a word. It can't see you. It HEARS you. Three fuses.
  Box by the front door. Winding is LOUD. Talk with your hands." 
- tom: "It found Tom when he screamed."
- whisper: "Whisper. Always whisper. Even the floor creaks."
- light (`note_light`, OCT 30): "The light doesn't bother it. It's blind. But it hears you wind it." 
- dad: "Dad hid the fuses so we couldnt leave. Im sorry. - Ellie" (read it as sinister: he trapped
  them in with him)
- kitchen: "It keeps coming back to the kitchen. We were loud there."

Decals: a drag trail to the bathroom, "IT HEARS YOU", "SHH", a child's drawing.

---

## The tools

### Problem with the old camera flash (owner feedback)
1. **Players couldn't figure out how to use it.** It lies somewhere in the house; you have to find
   it, pick it up (E) and *then* left-click. Nothing tells you this.
2. **It's useless:** the lighting upgrade made the moonlight too bright (`exposure 1.5`,
   `ambientIntensity 0.08` and the moonlight in `src/platform/render/fx/moonlight.ts`), so you can
   see the monster without it.
3. **It's confusing:** the flash leaves a frozen afterimage of the monster
   (`afterimageDuration: 2.2` in `src/config.ts`) while the real one keeps walking. Two monsters on
   screen, one fake. **Cut the afterimage.**

### Tool 1: the Crank Light (replaces the camera) ✅ built (see `docs/HANDOFF.md` §6 step 1)
- A wind-up flashlight. **Every player starts holding it.** No hunting for it.
- **F** toggles it (VR: a controller button). It gives a steady beam, like any flashlight.
- The battery lasts about a minute and **flickers when low**.
- **Hold R to crank it** (VR: shake it or wind it). Cranking makes a loud *whirrr*, and **the
  monster hears it.** The light itself is safe because he's blind. **Charging is the risk.**
- Use the beam to light a friend's hands so you can read their signs.
- At the same time, **make the world truly dark again**: drop the moonlight and ambient way down so
  without the light you really can't see.

### Tool 2: the Echo (the signature gadget, like Poppy's GrabPack)
Halcyon's prototype sound gun. It **records a sound and fires it somewhere else.** Grab a ringing
phone's sound, shoot it down a hallway, and he runs *there*. He tricks you with stolen voices; you
trick him back. It gets an upgrade each chapter:

| Chapter | Upgrade | What it does |
|---|---|---|
| 1 | **Record / Throw** | Capture a sound, fire it as a decoy. Opens sound-locked doors (play the right tone). |
| 2 | **Hush** | Fire a bubble of silence. Noise inside doesn't carry, so **players can talk out loud inside it**: the only safe place to speak. |
| 3 | **Feedback** | A blast that **stuns him for ~3 seconds**. Very few charges. This is the **"second chance"**: if he grabs you, you can blast free once. |
| 4 | All three combined | Used in the final fight. |

(The shelved "second chance" sim rules in commit `99e544d` (grab, pry, scream, rescue) are an
earlier take on this. Rework them around Feedback; see `docs/HANDOFF.md`.)

---

## How the game progresses

Every chapter runs the same loop:
**explore a big new area → get an Echo upgrade → solve puzzles with it → survive a chase → chapter
climax → auto-save.**

### 🏠 Prologue: The Hale House (~15 min, free)
*This is the house that exists in the game today.*
- Arrive for sign club. The front door locks behind you. Dark, silent, the kids are gone.
- Learn to whisper, sign and use the Crank Light.
- Find 3 fuses. The power comes on and the garage opens.
- **First chase:** he smashes through the kitchen, and you slide under the closing garage door.
- In Dad's car: his Halcyon badge. The bridge is out, so the only way out is Halcyon's tunnel.

### 🏢 Chapter 1: Halcyon Acoustics (~45 min, free)
- A huge lobby, offices and soundproof (anechoic) test labs. **You get the Echo.**
- Puzzles: sound-locked doors (record the right tone and play it back), and luring him off a
  doorway with a fake noise.
- **Chase:** up the elevator shaft. The doors close on his hand.

### 🌀 Chapter 2: The Echo Halls (~1 hr)
- Giant chambers where every sound echoes *louder*. A whisper becomes a shout (mic and footstep
  loudness multiplied here).
- **New enemies, the Hums:** failed test subjects that hum constantly. When the humming stops,
  they heard you.
- **Upgrade: Hush.**
- **Set piece:** he takes over the PA and plays Ellie's voice from every speaker. You shut them off
  one by one.
- **Chase:** a collapsing catwalk over the big echo pit.

### 🕳️ Chapter 3: The Nest (~1 hr)
- Flooded basements. Splashing is loud; deep water muffles you.
- **His nest is a larder:** the kids' backpacks and toys, the recorders he uses for bait, torn
  Halcyon uniforms from staff who tried to contain him. Show what's left, never the act.
- **The heist:** he's asleep in the nest, and you steal the **override key** from right beside him.
  Breathe too loud and he wakes up.
- **Upgrade: Feedback.**
- **Chase:** he swims after you through the flooded tunnel.

### 🔒 Chapter 4: The Quiet Room (~45 min)
You pick the ending. Neither one has mercy:
- **"Sealed":** lure him into the Quiet Room (an anechoic vault) and lock it. He's alive in there
  forever, scratching at the door. As you leave, the intercom plays Ellie's voice: *"Let me out."*
  It's him.
- **"Feedback":** the boss fight. Overload his implant with every speaker in the Echo Halls and kill
  him. He goes out *screaming*, in all the stolen voices at once.

### Across the whole game
- **Checkpoints:** a death never costs an hour, but they get sparse later (see below).
- **Dad's tapes:** hidden collectibles.
- **Players:** solo, or co-op with up to 4.
- **Money (Poppy Playtime model):** the Prologue and Chapter 1 are free on the web; Chapters 2–4
  are paid.

---

## Difficulty

The owner wants it **near impossible**: the beginning can be easier, but it has to get brutal.

- **One touch = dead.** No health bar. (Feedback in Ch3+ is the only way out of a grab, once.)
- **It ramps every chapter:**
  - **Prologue:** forgiving. He's slower, only reacts to loud noise, and checkpoints are frequent.
  - **Ch1:** normal hearing; he starts **remembering** where he heard things.
  - **Ch2:** everything is louder (echo multiplier). The Hums add a second threat.
  - **Ch3:** he **learns**: the same decoy trick doesn't work twice in the same spot, and he
    ambushes routes you used before.
  - **Ch4:** he hears whispers; checkpoints only at section starts.
- **He adapts:** use the same hiding spot or route repeatedly and he starts checking it first
  (build on the memory and escalation in `src/core/monster.ts`).
- **Scarcity:** a short Crank Light battery and very few Feedback charges.
- **Co-op is not easier:** more players means more noise.
- **Optional "Nightmare" mode:** one life for a whole chapter.

---

## Chapter pictures

Six Blender renders of Chapters 2–4 (made with the real monster model) are in `docs/concept/`.
In anything public (the trailer, the Kickstarter page) they're shown as the chapters themselves,
labelled "Chapter 2 · The Echo Halls" and so on, **never as "concept art"** (the owner's call). The scripts that make them are in `art/concept/` (see its README).

Four AI concept images for the Prologue and Chapter 1 were made in the owner's Canva account (the
Canva credits ran out after these four):
- Prologue, kitchen: https://www.canva.com/M/MAHXVWTps9s
- Prologue, upstairs hallway: https://www.canva.com/M/MAHXVb7NaLg
- Chapter 1, Halcyon lobby: https://www.canva.com/M/MAHXVVcH7AU
- Chapter 1, the Echo lab: https://www.canva.com/M/MAHXVQ5WZpY

## Rejected story versions (so nobody re-proposes them)
- **v1:** the players rescue Ellie and Tom. ❌ The owner wants the kids killed.
- **v2:** the kids are dead, but you escort survivors / rescue someone. ❌ "You don't rescue anybody."
- **v2.5:** the monster is a sad father looking for his kids, with a "rest in peace" ending.
  ❌ "He's a brutal killer, he doesn't care about the kids."
