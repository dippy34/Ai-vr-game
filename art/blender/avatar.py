"""
Remote player avatar: avatar_head.glb (origin = eye centre, faces +Y) and avatar_body.glb
(origin = neck base, faces +Y). Static meshes (no skinning): the renderer drives the head from the
HMD pose and hangs the body under it. Each file has a mesh node named `tint` (beanie / jacket
trim) with a light-neutral material for the per-player colour.

Geometry: avatar_head.py / avatar_body.py. Surface detail: avatar_detail.py, evaluated per texel
like the hands (hands_tex).
"""

from __future__ import annotations

import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
import avatar_body as ab  # noqa: E402
import avatar_detail as ad  # noqa: E402
import avatar_head as ah  # noqa: E402
import hands_tex as ht  # noqa: E402
import hands_util as hu  # noqa: E402

STAGE = os.environ.get('AVATAR_STAGE', 'full')   # shape | bodyshape | headtex | export | full
SCRATCH = os.environ.get('AVATAR_SCRATCH', os.path.join(common.REPO, 'art', 'previews'))


def make_obj(name, verts, faces, smooth=True):
    ob = hu.mesh_object(name, [tuple(v) for v in verts], faces)
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    for p in ob.data.polygons:
        p.use_smooth = smooth
    return ob


def head_objects():
    P, tris, tags, uv2 = ah.build_face()
    face = make_obj('face', P, tris)
    eyes = []
    for sx in (-1, 1):
        v, f = ah.eyeball(sx)
        eyes.append(make_obj(f'eye_{sx}', v, f))
    bv, bf = ah.build_bandana()[:2]
    band = make_obj('bandana', bv, bf)
    nv, nf = ah.build_beanie()[:2]
    beanie = make_obj('tint', nv, nf)
    return face, eyes, band, beanie


def shape_review_head(objs, tag):
    cols = {'face': (0.62, 0.48, 0.42), 'eye': (0.85, 0.85, 0.83), 'bandana': (0.25, 0.24, 0.22), 'tint': (0.75, 0.74, 0.70)}
    for o in objs:
        key = 'eye' if o.name.startswith('eye') else o.name
        common.assign(o, common.material(f'pv_{key}', color=cols.get(key, (0.5, 0.5, 0.5)), roughness=0.6))
    c = Vector((0, -0.04, -0.03))
    views = {
        'front': (c + Vector((0, 0.55, 0.03)), Vector((0, 0, 1))),
        'q3': (c + Vector((0.36, 0.40, 0.08)), Vector((0, 0, 1))),
        'side': (c + Vector((0.55, 0.0, 0.03)), Vector((0, 0, 1))),
        'back': (c + Vector((-0.30, -0.45, 0.12)), Vector((0, 0, 1))),
        'eyes': (Vector((0, 0.01, 0)) + Vector((0.05, 0.22, 0.02)), Vector((0, 0, 1))),
    }
    for k, (pos, up) in views.items():
        tgt = Vector((0, 0.01, 0)) if k == 'eyes' else c
        hu.render_view(os.path.join(SCRATCH, f'{tag}_{k}.png'), tgt, pos, up=up, lens=60, size=420, samples=12)


TEX = int(os.environ.get('AVATAR_TEX', '1024'))


def unwrap_static(ob, boost: dict[int, float] | None = None, angle=66.0, margin=0.003):
    """Smart-project, equalise texel density, then enlarge islands of some material slots
    (e.g. the eyes) before packing."""
    common.activate(ob)
    if not ob.data.uv_layers:
        ob.data.uv_layers.new(name='UVMap')
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin)
    bpy.ops.uv.average_islands_scale()
    bpy.ops.object.mode_set(mode='OBJECT')
    if boost:
        me = ob.data
        uv = me.uv_layers.active.data
        for mi, f in boost.items():
            polys = [p for p in me.polygons if p.material_index == mi]
            # scale each connected UV island of these faces about its own centre
            loops = [li for p in polys for li in p.loop_indices]
            if not loops:
                continue
            groups = island_groups(me, polys)
            for g in groups:
                pts = np.array([uv[li].uv for li in g])
                c = pts.mean(axis=0)
                for li in g:
                    q = (np.array(uv[li].uv) - c) * f + c
                    uv[li].uv = (float(q[0]), float(q[1]))
    common.activate(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=True, margin=margin)
    bpy.ops.object.mode_set(mode='OBJECT')


def island_groups(me, polys):
    """Group the loops of `polys` into UV islands (shared UV coordinates at shared vertices)."""
    uv = me.uv_layers.active.data
    parent = {}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    key_of = {}
    for p in polys:
        for li in p.loop_indices:
            parent[li] = li
    for p in polys:
        lis = list(p.loop_indices)
        for li in lis[1:]:
            parent[find(li)] = find(lis[0])
        for li in lis:
            k = (me.loops[li].vertex_index, round(uv[li].uv[0], 5), round(uv[li].uv[1], 5))
            if k in key_of:
                parent[find(li)] = find(key_of[k])
            else:
                key_of[k] = li
    groups = {}
    for li in parent:
        groups.setdefault(find(li), []).append(li)
    return list(groups.values())


def bake_textures(ob, size, name, evaluate, region_attr=None, normal_strength=1.0):
    td = ht.texel_data(ob, size, region_attr=region_attr)
    m = td['mask']
    reg = td['region'][m] if region_attr else np.zeros((int(m.sum()), 3))
    H, C, R = evaluate(td['P'][m].astype(np.float64), td['N'][m].astype(np.float64), reg)
    Hf = np.zeros(m.shape)
    Hf[m] = H
    Cf = np.zeros(m.shape + (3,))
    Cf[m] = C
    Rf = np.zeros(m.shape)
    Rf[m] = R
    objn = ht.height_to_object_normal(Hf, td['P'].astype(np.float64), td['N'].astype(np.float64), m,
                                      max_step=0.004 * 1024 / size)
    objn = ht.dilate(objn, m, 16)
    objn /= np.maximum(np.linalg.norm(objn, axis=-1, keepdims=True), 1e-6)
    color = hu.np_to_image(f'{name}_color', hu.lin_to_srgb(ht.dilate(Cf, m, 16)))
    rough = hu.np_to_image(f'{name}_roughness', ht.dilate(Rf, m, 16), non_color=True)
    normal = ht.bake_tangent_normal(ob, objn, size, name)
    for img in (color, rough, normal):
        img.pack()
    if os.environ.get('AVATAR_DEBUG_TEX'):
        for img in (color, normal):
            hu.save_png(img.copy(), os.path.join(SCRATCH, f'tex_{img.name}.png'))
    mat = hu.image_material(name, color, rough, normal, normal_strength=normal_strength)
    mat.use_backface_culling = True
    print(f'[avatar] {name}: texel coverage {m.mean() * 100:.1f}%')
    return mat


def build_head():
    face, eyes, band, beanie = head_objects()
    # one mesh (face + eyes + bandana) with a region attribute for the detail functions
    parts = [(face, 0), (eyes[0], 1), (eyes[1], 1), (band, 2)]
    for o, mi in parts:
        o.data.materials.clear()
        for k in range(3):
            o.data.materials.append(bpy.data.materials.get(f'__slot{k}') or bpy.data.materials.new(f'__slot{k}'))
        for p in o.data.polygons:
            p.material_index = mi
        ca = o.data.color_attributes.new('region', 'FLOAT_COLOR', 'POINT')
        col = {0: (0, 0, 1, 1), 1: (1, 0, 0, 1), 2: (0, 1, 0, 1)}[mi]
        for d in ca.data:
            d.color = col
    head = common.join([o for o, _ in parts], name='head')
    unwrap_static(head, boost={1: 2.6})
    mat = bake_textures(head, TEX, 'avatar_head', ad.evaluate_head, region_attr='region')
    for nm in ('region', 'cover'):
        if nm in head.data.color_attributes:
            head.data.color_attributes.remove(head.data.color_attributes[nm])
    common.assign(head, mat)
    unwrap_static(beanie)
    bmat = bake_textures(beanie, TEX, 'avatar_tint', lambda P, N, r: ad.evaluate_beanie(P, N))
    if 'cover' in beanie.data.color_attributes:
        beanie.data.color_attributes.remove(beanie.data.color_attributes['cover'])
    common.assign(beanie, bmat)
    root = bpy.data.objects.new('avatar_head', None)
    bpy.context.scene.collection.objects.link(root)
    for o in (head, beanie):
        o.parent = root
    return root, head, beanie


def head_tex_review(head, beanie):
    c = Vector((0, -0.03, -0.02))
    for k, (pos, up, tgt) in {
        'front': (Vector((0.0, 0.50, 0.02)), Vector((0, 0, 1)), c),
        'q3': (Vector((0.30, 0.38, 0.06)), Vector((0, 0, 1)), c),
        'back': (Vector((-0.30, -0.45, 0.10)), Vector((0, 0, 1)), c),
        'eyes': (Vector((0.04, 0.20, 0.015)), Vector((0, 0, 1)), Vector((0, 0.012, 0.0))),
    }.items():
        hu.render_view(os.path.join(SCRATCH, f'htex_{k}.png'), tgt, tgt + pos, up=up, lens=60, size=480, samples=16)


# eye centre relative to the neck base (Blender, m): head origin = neck base + HEAD_OFFSET
HEAD_OFFSET = Vector((0.0, 0.063, 0.215))


def body_objects():
    v, f, part = ab.build_body()
    body = make_obj('body', v, f)
    tv, tf, _ = ab.tint_bands()
    tint = make_obj('tint', tv, tf)
    return body, part, tint


def shape_review_body(objs, tag):
    c = Vector((0, 0, -0.12))
    views = {
        'front': (c + Vector((0, 1.5, 0.15)), Vector((0, 0, 1))),
        'q3': (c + Vector((1.0, 1.1, 0.30)), Vector((0, 0, 1))),
        'side': (c + Vector((1.5, 0.0, 0.10)), Vector((0, 0, 1))),
        'back': (c + Vector((-0.8, -1.25, 0.30)), Vector((0, 0, 1))),
    }
    for k, (pos, up) in views.items():
        hu.render_view(os.path.join(SCRATCH, f'{tag}_{k}.png'), c, pos, up=up, lens=60, size=420, samples=12)


def avatar_renders(head_parts, body_parts):
    root, head, beanie = head_parts
    broot = body_parts[0]
    root.location = HEAD_OFFSET
    bpy.context.view_layer.update()
    objs = [head, beanie, body_parts[1], body_parts[2]]
    samples = int(os.environ.get('AVATAR_SAMPLES', '48'))
    c = Vector((0, 0.0, -0.10))
    hu.render_view(os.path.join(common.PREVIEW_DIR, 'avatar_3q.png'), c, c + Vector((0.95, 1.30, 0.32)),
                   lens=50, size=640, samples=samples)
    c2 = Vector((0, 0.02, 0.05))
    hu.render_view(os.path.join(common.PREVIEW_DIR, 'avatar_flash.png'), c2, c2 + Vector((0.25, 1.05, 0.06)),
                   lens=50, size=640, samples=samples, mood='flash')
    root.location = (0, 0, 0)


def build() -> None:
    common.reset()
    face, eyes, band, beanie = head_objects()
    objs = [face, *eyes, band, beanie]
    print(f'[avatar] head tris: face {common.tri_count([face])}, eyes {common.tri_count(eyes)}, '
          f'bandana {common.tri_count([band])}, beanie {common.tri_count([beanie])}, total {common.tri_count(objs)}')
    if STAGE == 'shape':
        shape_review_head(objs, 'head')
        return
    if STAGE == 'bodyshape':
        for o in objs:
            o.location = HEAD_OFFSET
        body, part, tint = body_objects()
        ca = body.data.color_attributes.new('part', 'FLOAT_COLOR', 'POINT')
        palette = {0: (0.30, 0.30, 0.24), 1: (0.42, 0.42, 0.42), 2: (0.06, 0.06, 0.06), 3: (0.20, 0.22, 0.26),
                   4: (0.04, 0.04, 0.04), 5: (0.1, 0.1, 0.1), 6: (0.33, 0.32, 0.26)}
        for i, d in enumerate(ca.data):
            d.color = (*palette[int(part[i])], 1)
        m = common.material('pv_body', color=(1, 1, 1), roughness=0.8)
        attr = m.node_tree.nodes.new('ShaderNodeAttribute')
        attr.attribute_name = 'part'
        bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        m.node_tree.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
        common.assign(body, m)
        common.assign(tint, common.material('pv_tint', color=(0.8, 0.3, 0.2), roughness=0.4))
        cols = {'face': (0.62, 0.48, 0.42), 'eye': (0.85, 0.85, 0.83), 'bandana': (0.25, 0.24, 0.22), 'tint': (0.75, 0.74, 0.70)}
        for o in objs:
            key = 'eye' if o.name.startswith('eye') else o.name
            common.assign(o, common.material(f'pv_{key}', color=cols.get(key, (0.5, 0.5, 0.5)), roughness=0.6))
        print(f'[avatar] body tris {common.tri_count([body])}, tint {common.tri_count([tint])}')
        shape_review_body([body, tint], 'body')
        return
    common.reset()
    root, head, beanie = build_head()
    print(f'[avatar] head: {common.tri_count([head, beanie])} tris (tint {common.tri_count([beanie])})')
    if STAGE == 'headtex':
        head_tex_review(head, beanie)
        return
    common.export_glb('avatar_head', [root])
    head_parts = (root, head, beanie)
    beanie.name = beanie.data.name = 'head_tint'   # free the name: the body needs its own `tint` node

    # ------------------------------------------------------------------ body
    body, part, tint = body_objects()
    tint.name = tint.data.name = 'tint'
    ca = body.data.color_attributes.new('region', 'FLOAT_COLOR', 'POINT')
    for i, d in enumerate(ca.data):
        d.color = (part[i] / 10.0, 0, 0, 1)
    unwrap_static(body, angle=60.0)
    mat = bake_textures(body, TEX, 'avatar_body', ad.evaluate_body, region_attr='region')
    for nm in ('region', 'cover'):
        if nm in body.data.color_attributes:
            body.data.color_attributes.remove(body.data.color_attributes[nm])
    common.assign(body, mat)
    unwrap_static(tint)
    tmat = bake_textures(tint, 512, 'avatar_body_tint', lambda P, N, r: ad.evaluate_tint_tape(P, N))
    if 'cover' in tint.data.color_attributes:
        tint.data.color_attributes.remove(tint.data.color_attributes['cover'])
    common.assign(tint, tmat)
    broot = bpy.data.objects.new('avatar_body', None)
    bpy.context.scene.collection.objects.link(broot)
    for o in (body, tint):
        o.parent = broot
    print(f'[avatar] body: {common.tri_count([body, tint])} tris (tint {common.tri_count([tint])})')
    common.export_glb('avatar_body', [broot])
    if STAGE != 'export':
        avatar_renders(head_parts, (broot, body, tint))
