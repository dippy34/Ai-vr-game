# Concept-art renders (Blender, Cycles)

Scenes that show what the future chapter maps could look like, built from code with the **real
monster model** (`public/models/monster.glb`). Output goes to `docs/concept/raw/` (PNG); the
committed, compressed copies live in `docs/concept/`.

| Script | Shots |
|---|---|
| `ch2_echo_halls.py` | `A` wide view of the Echo Halls (pit, catwalks, hanging speakers); `B` catwalk chase |
| `ch3_nest.py` | `A` flooded tunnel with the monster swimming under the surface; `B` the nest / keycard heist |
| `ch4_quiet_room.py` | `A` the Quiet Room vault door seen from the control room; `B` the Feedback boss fight |
| `mlib.py` | Shared kit: materials (concrete, rust, fabric, fog, glass), primitives, lights, camera, monster import + posing |

```bash
python3.11 -m venv .blender-venv && .blender-venv/bin/pip install bpy==5.0.1   # once
.blender-venv/bin/python art/concept/ch2_echo_halls.py -- preview    # fast 960x540 preview, both shots
.blender-venv/bin/python art/concept/ch3_nest.py -- A                # full 1920x1080, shot A only
```

Notes: a full render is about 5–15 min per shot on 4 CPU cores. The monster is posed by sampling
one of its glTF clips (Attack, Feed, Idle, Listen, Run, Walk) at a frame and baking it, plus
optional per-bone tweaks (`pose={'jaw': (38, 0, 0)}`). It faces +Y at rotation 0. The skin shader
ignores the glTF vertex colours (they're masks, see `docs/HANDOFF.md`).
