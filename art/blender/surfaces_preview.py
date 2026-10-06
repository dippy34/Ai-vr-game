"""
Cycles review renders for the tileable surface sets (used by surfaces.py):
  * art/previews/surface_<name>_tiled.png: a 3 x 3 tiled patch under a grazing key light, to check
    for seams and for how the normal map reads.
  * art/previews/surface_room_flash.png (+ _b): a room corner (wall + baseboard + floor + ceiling)
    lit by dim blue moonlight and a harsh camera flash from the viewer, like in game.
Helper module only: build() is a no-op.
"""

from __future__ import annotations

import math
import os

import bpy
import bmesh
from mathutils import Vector

import common as C

TEX_DIR = os.path.join(C.REPO, 'public', 'textures')


def build() -> None:
    print('surfaces_preview: helper module (built through surfaces.py)')


# =============================================================================================
# Materials from the exported texture files (exactly what the game loads)
# =============================================================================================

def surface_material(name: str, ao_mix: float = 0.0, normal_strength: float = 1.0) -> bpy.types.Material:
    mat = bpy.data.materials.get(f'surf_{name}')
    if mat:
        return mat
    mat = bpy.data.materials.new(f'surf_{name}')
    try:
        mat.use_nodes = True
    except Exception:
        pass
    nt = mat.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')

    def img(kind: str, non_color: bool) -> bpy.types.Node:
        path = os.path.join(TEX_DIR, f'{name}_{kind}.webp')
        im = bpy.data.images.load(path, check_existing=True)
        if non_color:
            im.colorspace_settings.name = 'Non-Color'
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = im
        n.interpolation = 'Cubic'
        return n

    col = img('color', False)
    orm = img('orm', True)
    nrm = img('normal', True)
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(orm.outputs['Color'], sep.inputs['Color'])
    if ao_mix > 0:
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = ao_mix
        nt.links.new(col.outputs['Color'], mix.inputs['A'])
        nt.links.new(sep.outputs['Red'], mix.inputs['B'])
        nt.links.new(mix.outputs['Result'], b.inputs['Base Color'])
    else:
        nt.links.new(col.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(sep.outputs['Green'], b.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], b.inputs['Metallic'])
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nm.inputs['Strength'].default_value = normal_strength
    nt.links.new(nrm.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    return mat


def quad(name: str, corners, uvs, mat) -> bpy.types.Object:
    """One quad with explicit UVs (corners counter-clockwise seen from the front)."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    vs = [bm.verts.new(c) for c in corners]
    f = bm.faces.new(vs)
    uv = bm.loops.layers.uv.new('UVMap')
    for loop, t in zip(f.loops, uvs):
        loop[uv].uv = t
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    return ob


def box_world_uv(name: str, lo, hi, tile_u: float, tile_v: float, mat, along: str = 'x') -> bpy.types.Object:
    """Axis-aligned box with world-space planar UVs (like the game's LevelView.worldUv)."""
    bpy.ops.mesh.primitive_cube_add(size=1)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = [hi[i] - lo[i] for i in range(3)]
    ob.location = [(hi[i] + lo[i]) / 2 for i in range(3)]
    C.apply_transform(ob, location=True)
    me = ob.data
    uv = me.uv_layers.active.data
    for poly in me.polygons:
        nx, ny, nz = (abs(c) for c in poly.normal)
        for li in poly.loop_indices:
            p = me.vertices[me.loops[li].vertex_index].co
            if nz >= nx and nz >= ny:
                uv[li].uv = (p.x / tile_u, p.y / tile_v)
            elif nx >= ny:
                uv[li].uv = (p.y / tile_u, p.z / tile_v)
            else:
                uv[li].uv = (p.x / tile_u, p.z / tile_v)
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    return ob


def _render(path: str, w: int, h: int, samples: int) -> None:
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.max_bounces = 4
    try:
        scene.cycles.use_denoising = True
        scene.cycles.denoiser = 'OPENIMAGEDENOISE'
    except Exception:
        scene.cycles.use_denoising = False
    scene.render.resolution_x = w
    scene.render.resolution_y = h
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f'[preview] {path}')


def _world(color=(0, 0, 0), strength=0.0):
    scene = bpy.context.scene
    world = scene.world or bpy.data.worlds.new('World')
    scene.world = world
    try:
        world.use_nodes = True
    except Exception:
        pass
    bg = next((n for n in world.node_tree.nodes if n.type == 'BACKGROUND'), None)
    if bg:
        bg.inputs['Color'].default_value = (*color, 1)
        bg.inputs['Strength'].default_value = strength


def _light(kind, energy, loc, target, color=(1, 1, 1), size=0.1, spot=None, angle=None):
    data = bpy.data.lights.new(f'L_{kind}', kind)
    data.energy = energy
    data.color = color
    if kind in ('POINT', 'SPOT'):
        data.shadow_soft_size = size
    if kind == 'SPOT' and spot:
        data.spot_size = math.radians(spot)
        data.spot_blend = 0.6
    if kind == 'SUN' and angle is not None:
        data.angle = math.radians(angle)
    ob = bpy.data.objects.new(data.name, data)
    ob.location = loc
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.collection.objects.link(ob)
    return ob


def _camera(loc, target, lens=28.0, ortho=None):
    cd = bpy.data.cameras.new('cam')
    cd.lens = lens
    if ortho:
        cd.type = 'ORTHO'
        cd.ortho_scale = ortho
    cam = bpy.data.objects.new('cam', cd)
    cam.location = loc
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return cam


# =============================================================================================
# Previews
# =============================================================================================

def tiled_preview(name: str, tile, samples: int = 24, size: int = 900) -> str:
    """3 x 3 tiles seen straight on, grazing key light from the upper left + soft fill."""
    C.reset()
    tw, th = tile
    mat = surface_material(name)
    W, H = 3 * tw, 3 * th
    quad('patch', [(0, 0, 0), (W, 0, 0), (W, H, 0), (0, H, 0)], [(0, 0), (3, 0), (3, 3), (0, 3)], mat)
    _camera((W / 2, H / 2, 10), (W / 2, H / 2, 0), ortho=max(W, H))
    _world((0.5, 0.5, 0.52), 0.6)
    _light('SUN', 5.5, (-1, H + 1, 1.2), (W / 2, H / 2, 0), color=(1.0, 0.97, 0.92), angle=2)
    path = os.path.join(C.PREVIEW_DIR, f'surface_{name}_tiled.png')
    _render(path, size, size, samples)
    return path


def room_corner(path: str, wall: str, floor: str, ceiling: str = 'plaster_ceiling', trim: str = 'wood_trim',
                tiles: dict | None = None, samples: int = 48, extras=None) -> str:
    """Corner of a 3.2 x 3.2 m room, 2.8 m ceiling: two papered walls, baseboards, floor, ceiling.
    Moonlight (cold, dim) from a window behind the camera + a camera flash at the viewer's eye."""
    C.reset()
    tiles = tiles or {}
    tw = tiles[wall]
    tf = tiles[floor]
    tc = tiles[ceiling]
    tt = tiles[trim]
    R = 3.2
    Hh = 2.8
    m_wall = surface_material(wall)
    m_floor = surface_material(floor)
    m_ceil = surface_material(ceiling)
    m_trim = surface_material(trim)
    # room spans x in [0, R], y in [0, R]; the corner is at (R, R); walls on x = R and y = R
    quad('floor', [(0, 0, 0), (R, 0, 0), (R, R, 0), (0, R, 0)],
         [(0, 0), (R / tf[0], 0), (R / tf[0], R / tf[1]), (0, R / tf[1])], m_floor)
    quad('ceiling', [(0, 0, Hh), (0, R, Hh), (R, R, Hh), (R, 0, Hh)],
         [(0, 0), (0, R / tc[1]), (R / tc[0], R / tc[1]), (R / tc[0], 0)], m_ceil)
    quad('wall_n', [(0, R, 0), (R, R, 0), (R, R, Hh), (0, R, Hh)],
         [(0, 0), (R / tw[0], 0), (R / tw[0], Hh / tw[1]), (0, Hh / tw[1])], m_wall)
    quad('wall_e', [(R, R, 0), (R, 0, 0), (R, 0, Hh), (R, R, Hh)],
         [(0, 0), (R / tw[0], 0), (R / tw[0], Hh / tw[1]), (0, Hh / tw[1])], m_wall)
    # baseboards (15 cm, 2 cm proud) with a 1 cm top bead
    for nm, lo, hi in (('base_n', (0, R - 0.02, 0), (R, R, 0.15)), ('base_e', (R - 0.02, 0, 0), (R, R, 0.15)),
                       ('bead_n', (0, R - 0.028, 0.15), (R, R, 0.165)), ('bead_e', (R - 0.028, 0, 0.15), (R, R, 0.165))):
        box_world_uv(nm, lo, hi, tt[0], tt[1], m_trim)
    for ob in extras or []:
        ob()
    eye = Vector((0.75, 0.6, 1.6))
    look = Vector((R - 0.2, R - 0.25, 1.05))
    _camera(eye, look, lens=17)
    _world((0.02, 0.025, 0.04), 0.4)
    # moonlight through a window behind/left of the camera: cold, dim, hard-ish
    _light('SPOT', 140, (-0.6, 1.6, 2.2), (R, R - 0.6, 0.6), color=(0.55, 0.65, 1.0), size=0.25, spot=40)
    # camera flash: just right of / below the eye, very bright, tiny source
    _light('SPOT', 260, eye + Vector((0.12, 0.0, -0.08)), look, color=(1.0, 0.98, 0.95), size=0.02, spot=95)
    _render(path, 960, 720, samples)
    return path
