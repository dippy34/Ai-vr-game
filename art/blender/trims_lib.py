"""
Shared helpers for MUTE's architectural trim models (trims_*.py): boards with bevelled edges and
real-scale UVs onto the tileable wood_trim texture set, a generated glass atlas, materials that
export cleanly to glTF, export with root extras, and review renders.

Painted wood uses the SAME tileable wood_trim set as the baseboards (public/textures/wood_trim_*),
mapped at real scale (UV = meters / 0.5 m tile, grain along each board's length, a random offset
per board), so casings, sills and baseboards match exactly and stay sharp at arm's length.
Helper module only: build() is a no-op.
"""

from __future__ import annotations

import math
import os

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector

import common as C

TEX_DIR = os.path.join(C.REPO, 'public', 'textures')
TRIM_TILE = 0.5
rng = np.random.default_rng(5)


def build() -> None:
    print('trims_lib: helper module (built through trims.py)')


# =============================================================================================
# Materials
# =============================================================================================

def ensure_surface(name: str) -> None:
    if not os.path.exists(os.path.join(TEX_DIR, f'{name}_color.webp')):
        import surfaces
        surfaces.build_set(name)


def _gltf_output_group() -> bpy.types.NodeTree:
    """The custom node group the glTF exporter reads extra outputs (Occlusion) from."""
    g = bpy.data.node_groups.get('glTF Material Output')
    if g:
        return g
    g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
    try:
        g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    except Exception:
        g.inputs.new('NodeSocketFloat', 'Occlusion')
    return g


def load_image(path: str, non_color: bool) -> bpy.types.Image:
    im = bpy.data.images.load(path, check_existing=True)
    if non_color:
        im.colorspace_settings.name = 'Non-Color'
    return im


def textured_material(name: str, color: bpy.types.Image, orm: bpy.types.Image | None,
                      normal: bpy.types.Image | None, *, alpha: bool = False, occlusion: bool = True,
                      normal_strength: float = 1.0, rough_const: float | None = None) -> bpy.types.Material:
    """Principled material wired the way the glTF exporter maps it 1:1:
    color -> baseColorTexture, orm.G/B -> metallicRoughnessTexture, orm.R -> occlusionTexture,
    normal -> normalTexture."""
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    nt = mat.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tc = nt.nodes.new('ShaderNodeTexImage')
    tc.image = color
    tc.location = (-700, 300)
    nt.links.new(tc.outputs['Color'], b.inputs['Base Color'])
    if alpha:
        nt.links.new(tc.outputs['Alpha'], b.inputs['Alpha'])
        for attr, value in (('surface_render_method', 'BLENDED'), ('blend_method', 'BLEND')):
            try:
                setattr(mat, attr, value)
            except Exception:
                pass
        try:
            mat.use_backface_culling = False
        except Exception:
            pass
    if orm is not None:
        to = nt.nodes.new('ShaderNodeTexImage')
        to.image = orm
        to.location = (-700, 0)
        sp = nt.nodes.new('ShaderNodeSeparateColor')
        sp.location = (-400, 0)
        nt.links.new(to.outputs['Color'], sp.inputs['Color'])
        nt.links.new(sp.outputs['Green'], b.inputs['Roughness'])
        nt.links.new(sp.outputs['Blue'], b.inputs['Metallic'])
        if occlusion:
            go = nt.nodes.new('ShaderNodeGroup')
            go.node_tree = _gltf_output_group()
            go.location = (0, -300)
            nt.links.new(sp.outputs['Red'], go.inputs['Occlusion'])
    elif rough_const is not None:
        b.inputs['Roughness'].default_value = rough_const
    if normal is not None:
        tn = nt.nodes.new('ShaderNodeTexImage')
        tn.image = normal
        tn.location = (-700, -300)
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.location = (-400, -300)
        nm.inputs['Strength'].default_value = normal_strength
        nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    return mat


def wood_trim_material() -> bpy.types.Material:
    mat = bpy.data.materials.get('painted_wood')
    if mat:
        return mat
    ensure_surface('wood_trim')
    p = lambda k: os.path.join(TEX_DIR, f'wood_trim_{k}.webp')
    mat = textured_material('painted_wood', load_image(p('color'), False), load_image(p('orm'), True),
                            load_image(p('normal'), True))
    mat.use_backface_culling = True
    return mat


# =============================================================================================
# Geometry
# =============================================================================================

AXES = {'x': 0, 'y': 1, 'z': 2}


def board(name: str, lo, hi, *, bevel: float = 0.003, drop=(), long_axis: str | None = None,
          segments: int = 1, uv_offset=None) -> bpy.types.Object:
    """Axis-aligned board from corner lo to hi (meters) with chamfered edges.
    drop: faces to delete, e.g. ('-y',) for a back face lying on the wall.
    UVs: real scale onto the wood_trim tile, u along the board's long axis (grain)."""
    lo = Vector(lo)
    hi = Vector(hi)
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    size = hi - lo
    center = (hi + lo) / 2
    for v in bm.verts:
        v.co = Vector((v.co.x * size.x, v.co.y * size.y, v.co.z * size.z)) + center
    # drop hidden faces first (their edges then stay sharp: nothing to see there)
    kill = []
    for f in bm.faces:
        n = f.normal
        for d in drop:
            ax = AXES[d[1]]
            sgn = -1 if d[0] == '-' else 1
            if n[ax] * sgn > 0.9:
                kill.append(f)
    if kill:
        bmesh.ops.delete(bm, geom=kill, context='FACES')
    if bevel > 0:
        edges = [e for e in bm.edges if len(e.link_faces) == 2]
        bmesh.ops.bevel(bm, geom=edges, offset=min(bevel, min(size) * 0.45), segments=segments,
                        profile=0.5, affect='EDGES', clamp_overlap=True)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    la = long_axis or 'xyz'[int(np.argmax([size.x, size.y, size.z]))]
    real_uv(ob, la, uv_offset)
    return ob


def real_uv(ob: bpy.types.Object, long_axis: str, offset=None, tile: float = TRIM_TILE) -> None:
    """Planar UVs per face at real scale: u along `long_axis` (when it lies in the face), else
    along the face's longer in-plane axis; v along the remaining axis."""
    me = ob.data
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    uv = me.uv_layers.active.data
    off = offset if offset is not None else rng.random(2) * 4
    la = AXES[long_axis]
    mw = ob.matrix_world
    for poly in me.polygons:
        n = poly.normal
        normal_ax = int(np.argmax([abs(n.x), abs(n.y), abs(n.z)]))
        in_plane = [a for a in range(3) if a != normal_ax]
        if la in in_plane:
            ua = la
            va = in_plane[0] if in_plane[1] == la else in_plane[1]
        else:
            ua, va = in_plane
        for li in poly.loop_indices:
            p = mw @ me.vertices[me.loops[li].vertex_index].co
            uv[li].uv = (p[ua] / tile + off[0], p[va] / tile + off[1])


def quad(name: str, corners, uvs) -> bpy.types.Object:
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
    return ob


def finish_objects(objs, mat, name: str, smooth_deg: float = 35.0) -> bpy.types.Object:
    for o in objs:
        o.data.materials.clear()
        o.data.materials.append(mat)
    ob = C.join(objs, name)
    C.smooth(ob, smooth_deg)
    return ob


def save_rgba(path: str, arr: np.ndarray, quality: int = 92) -> str:
    from surfaces_lib import save_image
    return save_image(path, arr, quality=quality)


# =============================================================================================
# Export + review
# =============================================================================================

def export(name: str, root: bpy.types.Object, extras: dict) -> str:
    scene = bpy.context.scene
    for k, v in extras.items():
        root[k] = v
        scene[k] = v
    return C.export_glb(name, [root])


def bounds(objs):
    return C._bounds(objs)
