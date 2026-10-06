"""
Lineup render of every set-dressing GLB in one Blender scene: art/previews/dressing_lineup.png.
Wall pieces hang on a back wall, the bulb hangs from the top, floor pieces stand on the floor and
surface pieces sit on a low crate. Imports the exported GLBs, so it shows exactly what ships.

    DRESSING=lineup npm run assets -- dressing
Helper module: build() is a no-op.
"""

from __future__ import annotations

import math
import os

import bpy
from mathutils import Vector

import common as C
import dressing_lib as L
from dressing_lib import hexc

# name -> (x, y, z, yaw_deg) in Blender coords; wall pieces: (x, wall_y, z_center)
WALL_Y = -0.75
LAYOUT = {
    'frame_portrait': (-1.75, WALL_Y, 1.55, 0),
    'frame_landscape': (-0.75, WALL_Y, 1.6, 0),
    'clock': (0.35, WALL_Y, 1.5, 0),
    'boards': (1.45, WALL_Y, 1.25, 0),
    'bulb': (-0.2, -0.15, 2.45, 0),
    'coat_rack': (2.45, -0.35, 0.0, -20),
    'chair': (-1.25, -0.2, 0.0, 25),
    'chair_fallen': (1.35, 0.15, 0.0, -10),
    'rug': (0.05, 0.25, 0.0, 0),
    'toys': (-0.05, 0.35, 0.0, 15),
    'papers': (0.55, 0.85, 0.0, 0),
    'plate_broken': (-0.75, 0.95, 0.0, 30),
    'books_pile': (-2.15, 0.35, 0.55, 15),
    'bottles': (-2.4, 0.15, 0.55, 0),
    'candles': (-1.95, 0.05, 0.55, 0),
}


def build() -> None:
    print('dressing_lineup: helper module (DRESSING=lineup npm run assets -- dressing)')


def _import(name):
    path = os.path.join(C.MODELS_DIR, f'dressing_{name}.glb')
    if not os.path.exists(path):
        print(f'[lineup] missing {path}')
        return None
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    roots = [o for o in new if o.parent is None]
    return roots[0] if roots else None


def render():
    C.reset()
    scene = bpy.context.scene
    for name, (x, y, z, yaw) in LAYOUT.items():
        root = _import(name)
        if root is None:
            continue
        root.location = (-x, y, z)
        root.rotation_mode = 'XYZ'
        print(f'[lineup] {name}: imported rotation {tuple(round(a, 3) for a in root.rotation_euler)}')
        root.rotation_euler = (0, 0, math.radians(yaw))
    # room: floor, back wall, crate for the surface pieces
    floor = L.box('floor', (7.0, 3.2, 0.02), L.xf((0.2, 0.2, -0.01)), bevel=0.0)
    wall = L.box('wall', (7.0, 0.02, 3.2), L.xf((0.2, WALL_Y - 0.01, 1.6)), bevel=0.0)
    crate = L.box('crate', (0.75, 0.55, 0.55), L.xf((2.15, 0.2, 0.275)), bevel=0.01)
    C.assign(floor, C.material('lineup_floor', hexc('2a2420'), 0.8))
    C.assign(wall, C.material('lineup_wall', hexc('3a3c36'), 0.9))
    C.assign(crate, C.material('lineup_crate', hexc('3a2e24'), 0.8))
    cam_data = bpy.data.cameras.new('lineup_cam')
    cam_data.lens = 26
    cam = bpy.data.objects.new('lineup_cam', cam_data)
    scene.collection.objects.link(cam)
    cam.location = (-0.1, 4.9, 1.7)
    cam.rotation_euler = (Vector((-0.1, 0.0, 1.0)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam

    def light(kind, energy, loc, size=1.0, color=(1, 1, 1), target=(0, 0, 1)):
        d = bpy.data.lights.new(f'l_{len(scene.objects)}', kind)
        d.energy = energy
        d.color = color
        if kind == 'AREA':
            d.size = size
        o = bpy.data.objects.new(d.name, d)
        o.location = loc
        o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        scene.collection.objects.link(o)
    light('AREA', 420, (-2.5, 3.5, 3.5), 3.0, (1.0, 0.96, 0.9))
    light('AREA', 140, (3.5, 3.0, 2.0), 3.0, (0.75, 0.82, 1.0))
    light('AREA', 90, (0.0, 1.5, 3.2), 2.0, (1.0, 0.95, 0.9), target=(0, 0, 0))
    world = bpy.data.worlds.new('lineup_world')
    scene.world = world
    bg = next((n for n in world.node_tree.nodes if n.type == 'BACKGROUND'), None)
    if bg:
        bg.inputs['Color'].default_value = (0.05, 0.05, 0.055, 1)
        bg.inputs['Strength'].default_value = 1.0
    scene.cycles.samples = 16 if L.DRAFT else 40
    try:
        scene.cycles.use_denoising = True
    except Exception:
        pass
    scene.render.resolution_x = 640
    scene.render.resolution_y = 400
    try:
        scene.render.threads_mode = 'FIXED'
        scene.render.threads = L.THREADS
    except Exception:
        pass
    path = os.path.join(C.PREVIEW_DIR, 'dressing_lineup.png')
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f'[lineup] {path}')
