"""
MUTE key gameplay props: camera.glb, fuse.glb, film.glb, fusebox.glb, door.glb.

    npm run assets -- props                 # all five
    PROPS=camera,fuse npm run assets -- props   # just some (comma list)
    PROPS_FAST=1 ...                        # half-res bakes + fewer samples while iterating

Pipeline per asset (see props_lib.py): build a high-detail version with procedural materials
(wear, grime, chipping, decals rendered from text) and a game-res version, smart-UV the game
mesh, bake color / ORM (roughness+metallic) / normal from high to low, split it into the named
nodes the game needs, export, render previews (studio + flash). Builders live in
props_small.py (fuse, film), props_camera.py, props_fusebox.py and props_door.py.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import props_camera  # noqa: E402
import props_door  # noqa: E402
import props_fusebox  # noqa: E402
import props_small  # noqa: E402

BUILDERS = {
    'fuse': props_small.build_fuse,
    'film': props_small.build_film,
    'camera': props_camera.build_camera,
    'fusebox': props_fusebox.build_fusebox,
    'door': props_door.build_door,
}


def build() -> None:
    wanted = [w.strip() for w in os.environ.get('PROPS', '').split(',') if w.strip()] or list(BUILDERS)
    for name in wanted:
        print(f'--- props: {name} ---', flush=True)
        BUILDERS[name]()
