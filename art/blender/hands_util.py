"""Small Blender helpers shared by hands.py / avatar.py (render previews with explicit cameras,
mesh creation, image IO through bpy)."""

from __future__ import annotations

import math
import os

import bpy
import numpy as np
from mathutils import Vector

import common


def mesh_object(name: str, verts, faces, collection=None) -> bpy.types.Object:
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    me.update()
    ob = bpy.data.objects.new(name, me)
    (collection or bpy.context.scene.collection).objects.link(ob)
    return ob


def look_at(obj: bpy.types.Object, target: Vector, up=Vector((0, 0, 1))) -> None:
    d = (target - obj.location).normalized()
    # build a rotation whose -Z looks along d with +Y as close to `up` as possible
    z = -d
    x = up.cross(z)
    if x.length < 1e-6:
        x = Vector((1, 0, 0))
    x.normalize()
    y = z.cross(x)
    from mathutils import Matrix
    m = Matrix((x, y, z)).transposed()
    obj.rotation_euler = m.to_euler()


def render_view(path: str, target: Vector, cam_pos: Vector, up=Vector((0, 0, 1)), lens=50.0, size=640,
                samples=32, mood='studio', lights=None, ortho_scale: float | None = None,
                bg=(0.16, 0.16, 0.17), film_transparent=False) -> str:
    """Render with an explicit camera. lights: list of (kind, energy, location, size, color)."""
    scene = bpy.context.scene
    temp = []
    cam_data = bpy.data.cameras.new('__cam')
    cam_data.lens = lens
    cam_data.clip_start = 0.005
    if ortho_scale:
        cam_data.type = 'ORTHO'
        cam_data.ortho_scale = ortho_scale
    cam = bpy.data.objects.new('__cam', cam_data)
    scene.collection.objects.link(cam)
    cam.location = cam_pos
    look_at(cam, target, up)
    scene.camera = cam
    temp.append(cam)

    world = scene.world or bpy.data.worlds.new('World')
    scene.world = world
    try:
        world.use_nodes = True
    except Exception:
        pass
    bgn = next((n for n in world.node_tree.nodes if n.type == 'BACKGROUND'), None)
    if bgn:
        if mood == 'flash':
            bgn.inputs['Color'].default_value = (0, 0, 0, 1)
            bgn.inputs['Strength'].default_value = 0.0
        else:
            bgn.inputs['Color'].default_value = (*bg, 1)
            bgn.inputs['Strength'].default_value = 0.5

    if lights is None:
        dist = (cam_pos - target).length
        if mood == 'flash':
            lights = [('SPOT', 14 * dist * dist, cam_pos + Vector((0, 0, 0.04)), 0.02, (1, 0.98, 0.95)),
                      ('POINT', 0.6 * dist * dist, target + Vector((-dist, -dist, dist)) * 0.8, 0.2, (0.55, 0.65, 1.0))]
        else:
            fwd = (target - cam_pos).normalized()
            side = fwd.cross(up).normalized()
            lights = [
                ('AREA', 35 * dist * dist, target - fwd * dist + side * dist * 0.9 + up * dist * 0.9, dist, (1, 0.97, 0.93)),
                ('AREA', 10 * dist * dist, target - fwd * dist * 0.6 - side * dist * 1.1 + up * dist * 0.2, dist, (0.85, 0.9, 1.0)),
                ('AREA', 25 * dist * dist, target + fwd * dist * 1.2 + up * dist * 0.8, dist, (1, 1, 1)),
            ]
    for kind, energy, loc, sz, col in lights:
        ld = bpy.data.lights.new('__l', kind)
        ld.energy = energy
        ld.color = col
        if kind == 'AREA':
            ld.size = sz
        elif kind == 'SPOT':
            ld.spot_size = math.radians(60)
            ld.shadow_soft_size = sz
        else:
            ld.shadow_soft_size = sz
        lo = bpy.data.objects.new('__l', ld)
        lo.location = loc
        look_at(lo, target)
        scene.collection.objects.link(lo)
        temp.append(lo)

    scene.render.engine = 'CYCLES'
    scene.cycles.samples = samples
    try:
        scene.cycles.use_denoising = True
    except Exception:
        pass
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.film_transparent = film_transparent
    scene.view_settings.view_transform = 'AgX' if 'AgX' in [i.identifier for i in scene.view_settings.bl_rna.properties['view_transform'].enum_items] else 'Standard'
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for o in temp:
        data = o.data
        bpy.data.objects.remove(o)
        if isinstance(data, bpy.types.Camera):
            bpy.data.cameras.remove(data)
        elif isinstance(data, bpy.types.Light):
            bpy.data.lights.remove(data)
    print(f'[render] {path}')
    return path


def image_to_np(img: bpy.types.Image) -> np.ndarray:
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)


def np_to_image(name: str, arr: np.ndarray, non_color=False, float_buffer=False) -> bpy.types.Image:
    h, w = arr.shape[:2]
    if arr.ndim == 2:
        arr = np.repeat(arr[..., None], 3, axis=2)
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones((h, w, 1), np.float32)], axis=2)
    img = bpy.data.images.get(name)
    if img is None or tuple(img.size) != (w, h):
        img = bpy.data.images.new(name, w, h, alpha=False, float_buffer=float_buffer)
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    img.pixels.foreach_set(arr.astype(np.float32).ravel())
    img.update()
    return img


def lin_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def image_material(name: str, color: bpy.types.Image, rough: bpy.types.Image | None,
                   normal: bpy.types.Image | None, normal_strength: float = 1.0) -> bpy.types.Material:
    """Exporter-friendly Principled material from baked images."""
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    nt = mat.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = color
    t.location = (-600, 300)
    nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    if rough is not None:
        r = nt.nodes.new('ShaderNodeTexImage')
        r.image = rough
        r.location = (-600, 0)
        nt.links.new(r.outputs['Color'], b.inputs['Roughness'])
    if normal is not None:
        t2 = nt.nodes.new('ShaderNodeTexImage')
        t2.image = normal
        t2.location = (-600, -300)
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.inputs['Strength'].default_value = normal_strength
        nm.location = (-250, -300)
        nt.links.new(t2.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    return mat


def save_png(img: bpy.types.Image, path: str) -> None:
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()


def build() -> None:
    """Helper module (imported by hands.py / avatar.py): nothing to build on its own."""
