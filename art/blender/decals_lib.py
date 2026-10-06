"""
Blender side of MUTE's story decals and notes: numpy images -> packed Blender images, decal quads
and bent paper sheets, glTF-friendly materials, export with extras, review renders.

Conventions (Decals.ts relies on them):
  wall / door decal: a quad in Blender XZ, front faces +Y (three.js -Z), origin = quad center
                     (on the wall plane). Texture top = up.
  floor decal:       a quad in Blender XY facing +Z, origin = center. Texture top = Blender +Y
                     (three.js -Z, the model's forward).
  note surface/floor: a bent sheet lying on XY, origin = bottom center (lowest point at z = 0); the
                     reader stands at the model's front (Blender +Y = three.js -Z), the text's top
                     edge points away from them.
  note wall:         a sheet in XZ facing +Y, back on y = 0, origin = center of the back.
glTF extras on the root node (and scene): placement, size [w, h, d] (three.js axes), kind
('decal' | 'note'), and for notes the message `text`.

Helper module only: build() is a no-op.
"""

from __future__ import annotations

import math
import os

import bpy
import numpy as np
from mathutils import Vector

import common as C

DRAFT = os.environ.get('DECAL_Q') == 'draft'
DO_PREVIEW = os.environ.get('DECAL_PREVIEW', '1') != '0'


def build() -> None:
    print('decals_lib: helper module (built through decals.py)')


# ---------------------------------------------------------------------------------------------
# Images + materials
# ---------------------------------------------------------------------------------------------

def image(name, arr, non_color=False):
    """numpy HxWx3/4 (top row first; sRGB-encoded unless non_color) -> packed Blender image."""
    h, w = arr.shape[:2]
    c = arr.shape[2] if arr.ndim == 3 else 1
    img = bpy.data.images.new(name, w, h, alpha=(c == 4))
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    a = np.ones((h, w, 4), np.float32)
    if c == 1:
        a[..., :3] = arr.reshape(h, w, 1)
    else:
        a[..., :c] = arr
    img.pixels.foreach_set(np.ascontiguousarray(np.clip(a[::-1], 0, 1)).ravel())
    if c == 4:
        img.alpha_mode = 'STRAIGHT'
    img.pack()
    return img


def material(name, color_img, normal_img=None, *, rough=0.8, mode='blend', double_sided=False, normal_strength=1.0):
    """Image material. mode: 'blend' (alpha blended decal) | 'clip' (alpha mask, e.g. torn paper)."""
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    nt = mat.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = color_img
    tex.interpolation = 'Linear'
    nt.links.new(tex.outputs['Color'], b.inputs['Base Color'])
    if mode == 'blend':
        nt.links.new(tex.outputs['Alpha'], b.inputs['Alpha'])
        mat.surface_render_method = 'BLENDED'
    elif mode == 'clip':
        rd = nt.nodes.new('ShaderNodeMath')
        rd.operation = 'ROUND'
        nt.links.new(tex.outputs['Alpha'], rd.inputs[0])
        nt.links.new(rd.outputs[0], b.inputs['Alpha'])
        mat.surface_render_method = 'DITHERED'
    if normal_img is not None:
        tn = nt.nodes.new('ShaderNodeTexImage')
        tn.image = normal_img
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.inputs['Strength'].default_value = normal_strength
        nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = 0.0
    mat.use_backface_culling = not double_sided
    return mat


# ---------------------------------------------------------------------------------------------
# Meshes
# ---------------------------------------------------------------------------------------------

def _mesh(name, verts, faces, uvs):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    uv = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li, vi in zip(poly.loop_indices, poly.vertices):
            uv.data[li].uv = uvs[vi]
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def grid_sheet(name, w, h, us, vs, placement, z_of=None, reader_front=False, rot90=False):
    """
    A w x h sheet sampled at page coords us x vs (0..1 lists; v = 0 is the TOP edge). z_of(u, v) =
    displacement off the surface (m). Floor sheets: texture top toward +Y (the model's forward), or
    with reader_front the reader stands at the model's front (+Y, three.js -Z) and the top points away.
    """
    verts, uvs = [], []
    for v in vs:
        for u in us:
            z = z_of(u, v) if z_of else 0.0
            if placement in ('wall', 'door'):
                # front (+Y) seen from +Y: viewer's right is -X, so u runs toward -X
                verts.append(((0.5 - u) * w, z, (0.5 - v) * h))
            elif reader_front:
                verts.append(((0.5 - u) * w, (v - 0.5) * h, z))
            else:
                verts.append(((u - 0.5) * w, (0.5 - v) * h, z))
            # rot90: the image is stored rotated 90 deg CCW (decals_img.standard)
            uvs.append((v, u) if rot90 else (u, 1.0 - v))
    nu = len(us)
    faces = []
    for j in range(len(vs) - 1):
        for i in range(nu - 1):
            a = j * nu + i
            faces.append((a, a + nu, a + nu + 1, a + 1) if placement in ('wall', 'door') else (a, a + 1, a + nu + 1, a + nu))
    ob = _mesh(name, verts, faces, uvs)
    # make sure the front faces the right way (+Y for wall pieces, +Z for floor pieces)
    me = ob.data
    want = Vector((0, 1, 0)) if placement in ('wall', 'door') else Vector((0, 0, 1))
    avg = sum((p.normal for p in me.polygons), Vector())
    if avg.dot(want) < 0:
        for p in me.polygons:
            p.flip()
        me.update()
    for p in me.polygons:
        p.use_smooth = True
    return ob


def quad(name, w, h, placement, rot90=False):
    return grid_sheet(name, w, h, [0.0, 1.0], [0.0, 1.0], placement, rot90=rot90)


def lines_with(n, extra=(), eps=0.012):
    """0..1 sample positions: n even steps plus each extra position (+-eps) for sharp creases."""
    pts = set(round(k / n, 5) for k in range(n + 1))
    for e in extra:
        for d in (-eps, 0.0, eps):
            if 0 < e + d < 1:
                pts.add(round(e + d, 5))
    return sorted(pts)


# ---------------------------------------------------------------------------------------------
# Export + previews
# ---------------------------------------------------------------------------------------------

def finish(name, ob, extras, quality=90):
    """Tag extras, export public/models/<name>.glb (WebP images)."""
    for k, v in extras.items():
        ob[k] = v
        bpy.context.scene[k] = v
    os.makedirs(C.MODELS_DIR, exist_ok=True)
    path = os.path.join(C.MODELS_DIR, f'{name}.glb')
    C.activate(ob)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_materials='EXPORT',
        export_image_format='WEBP', export_image_quality=quality, export_animations=False, export_skins=False,
        export_lights=False, export_cameras=False, export_extras=True,
    )
    print(f'[export] {path}  ({os.path.getsize(path) / 1024:.0f} KB), {C.tri_count([ob])} tris')
    return path


def _backdrop(placement, ob):
    """A temporary wall / floor / tabletop behind the piece for review renders."""
    lo, hi = C._bounds([ob])
    size = max((hi - lo).length * 3.0, 1.0)
    col = {'wall': (0.12, 0.14, 0.17), 'door': (0.13, 0.08, 0.05), 'floor': (0.09, 0.06, 0.04),
           'surface': (0.16, 0.1, 0.06)}[placement]
    mat = C.material('__backdrop', col, roughness=0.75)
    if placement in ('wall', 'door'):
        verts = [(-size, -0.002, -size), (size, -0.002, -size), (size, -0.002, size), (-size, -0.002, size)]
    else:
        verts = [(-size, -size, -0.0015), (size, -size, -0.0015), (size, size, -0.0015), (-size, size, -0.0015)]
    me = bpy.data.meshes.new('__backdrop')
    me.from_pydata(verts, [], [(0, 1, 2, 3)])
    bd = bpy.data.objects.new('__backdrop', me)
    bpy.context.scene.collection.objects.link(bd)
    bd.data.materials.append(mat)
    for p in me.polygons:
        if (placement in ('wall', 'door') and p.normal.y < 0) or (placement not in ('wall', 'door') and p.normal.z < 0):
            p.flip()
    return bd


def previews(name, ob, placement, *, yaw=0.0, pitch=None, zoom=1.0, flash_yaw=None):
    if not DO_PREVIEW:
        return
    pitch = pitch if pitch is not None else (6.0 if placement in ('wall', 'door') else 62.0)
    bd = _backdrop(placement, ob)
    size = 384 if DRAFT else 640
    samples = 8 if DRAFT else 20
    try:
        C.preview(f'{name}_3q', [ob], yaw_deg=yaw, pitch_deg=pitch, size=size, mood='studio', samples=samples, zoom=zoom)
        C.preview(f'{name}_flash', [ob], yaw_deg=flash_yaw if flash_yaw is not None else yaw + 18, pitch_deg=pitch,
                  size=size, mood='flash', samples=samples, zoom=zoom)
    finally:
        bpy.data.objects.remove(bd)


def gltf_extras_size(placement, w, h, depth=0.0):
    """[w, h, d] in three.js axes."""
    if placement in ('wall', 'door'):
        return [round(w, 4), round(h, 4), round(depth, 4)]
    return [round(w, 4), round(depth, 4), round(h, 4)]


def mesh_depth(ob, axis):
    zs = [v.co[axis] for v in ob.data.vertices]
    return max(zs) - min(zs)


def drop_to(ob, axis, value=0.0):
    """Shift vertices so their minimum along axis = value."""
    lo = min(v.co[axis] for v in ob.data.vertices)
    for v in ob.data.vertices:
        v.co[axis] += value - lo
    ob.data.update()


def angle(deg):
    return math.radians(deg)
