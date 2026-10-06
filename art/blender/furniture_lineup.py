"""
Review renders built from the EXPORTED GLBs (so they show exactly what the game loads):
  render():  art/previews/furniture_lineup.png, every furniture_*.glb side by side.
  closeup(): art/previews/furniture_<name>_close.png, a near view like a player walking up in VR.
Helper module: build() is a no-op (run through furniture.py: FURNITURE=lineup).
"""

from __future__ import annotations

import glob
import math
import os
import sys

import bpy
from mathutils import Vector

import common as C

ORDER = ['couch', 'armchair', 'bench', 'bed', 'piano', 'shelf_module', 'shelf_module_b', 'cabinet_tall',
         'cabinet_narrow', 'cabinet_low', 'nightstand', 'table_dining', 'desk', 'table_small', 'table_coffee',
         'counter_module', 'counter_sink', 'counter_stove', 'crate', 'crate_small']


def build() -> None:
    print('furniture_lineup: run through furniture.py (FURNITURE=lineup)')


def _import(name):
    path = os.path.join(C.MODELS_DIR, f'furniture_{name}.glb')
    if not os.path.exists(path):
        return None
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.context.scene.objects if o not in before]
    return [o for o in new if o.type == 'MESH']


def _floor(size=40.0):
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, 0))
    fl = bpy.context.active_object
    fl.data.materials.append(C.material('floor', (0.09, 0.08, 0.07), 0.8))
    return fl


def render(samples: int = 32) -> str:
    C.reset()
    sc = bpy.context.scene
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = int(os.environ.get('FURN_THREADS', '3'))
    # two rows: big pieces in back, small in front
    rows = [ORDER[:10], ORDER[10:]]
    placed = []
    y = 0.0
    for r, names in enumerate(rows):
        x = 0.0
        depth = 0.0
        row = []
        for n in names:
            objs = _import(n)
            if not objs:
                continue
            lo, hi = C._bounds(objs)
            w = hi.x - lo.x
            for o in objs:
                o.location.x += x - lo.x
                o.location.y += y
            x += w + 0.25
            depth = max(depth, hi.y - lo.y)
            row.append(objs)
        # center the row
        for objs in row:
            for o in objs:
                o.location.x -= (x - 0.25) / 2
        placed += [o for objs in row for o in objs]
        y += depth + 0.6
    _floor()
    bpy.context.view_layer.update()
    lo, hi = C._bounds(placed)
    center = (lo + hi) / 2
    cam_d = bpy.data.cameras.new('cam')
    cam_d.lens = 40
    cam = bpy.data.objects.new('cam', cam_d)
    sc.collection.objects.link(cam)
    span = max(hi.x - lo.x, (hi.y - lo.y) * 1.6)
    cam.location = center + Vector((0, -span * 0.95 - 1.0, span * 0.42))
    # front faces +Y: look from +Y side
    cam.location = center + Vector((0, span * 0.95 + 1.0, span * 0.42))
    cam.rotation_euler = (center + Vector((0, 0, -0.3)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    world = bpy.data.worlds.new('w')
    sc.world = world
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (0.16, 0.16, 0.17, 1)
    bg.inputs['Strength'].default_value = 0.5
    for loc, e, s in (((center.x + 6, center.y + 8, 9), 3500, 8), ((center.x - 8, center.y + 4, 5), 900, 8),
                      ((center.x, center.y - 6, 6), 1200, 8)):
        ld = bpy.data.lights.new('l', 'AREA')
        ld.energy = e
        ld.size = s
        lo_ = bpy.data.objects.new('l', ld)
        lo_.location = loc
        lo_.rotation_euler = (center - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        sc.collection.objects.link(lo_)
    sc.cycles.samples = samples
    sc.render.resolution_x = 1280
    sc.render.resolution_y = 640
    path = os.path.join(C.PREVIEW_DIR, 'furniture_lineup.png')
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f'[lineup] {path}')
    return path


def closeup(name: str, eye, target, mood='flash', samples=24, size=640, lens=30, suffix='close') -> str:
    """Render the exported GLB from a player-like viewpoint (eye/target in Blender meters, model space)."""
    C.reset()
    sc = bpy.context.scene
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = int(os.environ.get('FURN_THREADS', '3'))
    objs = _import(name)
    _floor(8)
    cam_d = bpy.data.cameras.new('cam')
    cam_d.lens = lens
    cam = bpy.data.objects.new('cam', cam_d)
    sc.collection.objects.link(cam)
    cam.location = Vector(eye)
    cam.rotation_euler = (Vector(target) - Vector(eye)).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    world = bpy.data.worlds.new('w')
    sc.world = world
    bg = world.node_tree.nodes.get('Background')
    if mood == 'flash':
        bg.inputs['Strength'].default_value = 0.0
        ld = bpy.data.lights.new('flash', 'SPOT')
        ld.energy = 60
        ld.spot_size = math.radians(80)
        ld.shadow_soft_size = 0.02
        lo_ = bpy.data.objects.new('flash', ld)
        lo_.location = Vector(eye) + Vector((0.05, 0, 0.06))
        lo_.rotation_euler = cam.rotation_euler
        sc.collection.objects.link(lo_)
        md = bpy.data.lights.new('moon', 'SUN')
        md.energy = 0.08
        md.color = (0.55, 0.65, 1.0)
        mo = bpy.data.objects.new('moon', md)
        mo.rotation_euler = (math.radians(50), 0, math.radians(40))
        sc.collection.objects.link(mo)
    else:
        bg.inputs['Color'].default_value = (0.18, 0.18, 0.19, 1)
        bg.inputs['Strength'].default_value = 0.8
        ld = bpy.data.lights.new('key', 'AREA')
        ld.energy = 150
        ld.size = 2
        lo_ = bpy.data.objects.new('key', ld)
        lo_.location = Vector(eye) + Vector((1.0, 0.5, 1.5))
        lo_.rotation_euler = (Vector(target) - lo_.location).to_track_quat('-Z', 'Y').to_euler()
        sc.collection.objects.link(lo_)
    sc.cycles.samples = samples
    sc.render.resolution_x = size
    sc.render.resolution_y = size
    path = os.path.join(C.PREVIEW_DIR, f'furniture_{name}_{suffix}.png')
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f'[closeup] {path}')
    return path


def tiletest(names, eye, target, mood='studio', samples=24, out='furniture_tiling') -> str:
    """Repeat tileable modules side by side along X (names = sequence) to check the seams."""
    C.reset()
    sc = bpy.context.scene
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = int(os.environ.get('FURN_THREADS', '3'))
    x = 0.0
    placed = []
    for n in names:
        objs = _import(n)
        lo, hi = C._bounds(objs)
        for o in objs:
            o.location.x += x - lo.x
        x += hi.x - lo.x
        placed += objs
    for o in placed:
        o.location.x -= x / 2
    _floor(12)
    cam_d = bpy.data.cameras.new('cam')
    cam_d.lens = 30
    cam = bpy.data.objects.new('cam', cam_d)
    sc.collection.objects.link(cam)
    cam.location = Vector(eye)
    cam.rotation_euler = (Vector(target) - Vector(eye)).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    world = bpy.data.worlds.new('w')
    sc.world = world
    bg = world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (0.18, 0.18, 0.19, 1)
    bg.inputs['Strength'].default_value = 0.8
    ld = bpy.data.lights.new('key', 'AREA')
    ld.energy = 400
    ld.size = 3
    lo_ = bpy.data.objects.new('key', ld)
    lo_.location = Vector(eye) + Vector((1.5, 0.5, 2.0))
    lo_.rotation_euler = (Vector(target) - lo_.location).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(lo_)
    sc.cycles.samples = samples
    sc.render.resolution_x = 960
    sc.render.resolution_y = 540
    path = os.path.join(C.PREVIEW_DIR, f'{out}.png')
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f'[tiletest] {path}')
    return path


if __name__ == '__main__':
    # .blender-venv/bin/python art/blender/furniture_lineup.py couch ex ey ez tx ty tz [mood]
    a = sys.argv[1:]
    if not a:
        render()
    else:
        closeup(a[0], [float(v) for v in a[1:4]], [float(v) for v in a[4:7]], a[7] if len(a) > 7 else 'flash',
                suffix=a[8] if len(a) > 8 else 'close')
