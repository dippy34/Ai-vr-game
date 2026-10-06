"""
Player hands: hand_right.glb + hand_left.glb (true mirror pair).

Pipeline (all code, no GUI):
  1. hands_geo.build_hand(): parametric right hand, explicit quad topology with edge loops at every
     joint, skin weights, UV seams.
  2. Low-poly object + armature (bones wrist, thumb_1..3, index_1..3, middle_1..3, ring_1..3,
     pinky_1..3). Every bone's local +Z points toward the palm (the direction it bends), so a curl
     is a positive rotation about the bone's local X axis.
  3. High-poly = low-poly subdivided + procedural sculpt detail (nails, knuckle wrinkles, palm
     creases, tendons, veins, knit cuff) -> baked to color / roughness / normal (1024, WebP).
  4. Mirror to the left hand, export both, render posed previews.

Canonical frame (three.js): origin = wrist, fingers -Z, back of hand +Y, thumb -X (right) / +X
(left). Blender: fingers +Y, back +Z, right thumb -X.

Curl convention (stored in the armature node's glTF extras and on every bone):
  bone.quaternion = restQuaternion * axisAngle(curlAxis, curlSign * curl * angle)
"""

from __future__ import annotations

import math
import os
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
import hands_detail  # noqa: E402
import hands_geo as hg  # noqa: E402
import hands_tex as ht  # noqa: E402
import hands_util as hu  # noqa: E402
import numpy as np  # noqa: E402

STAGE = os.environ.get('HANDS_STAGE', 'full')  # 'shape' = quick geometry review renders only
SCRATCH = os.environ.get('HANDS_SCRATCH', os.path.join(common.REPO, 'art', 'previews'))

BONES = ['wrist'] + [f'{f}_{i}' for f in ('thumb', 'index', 'middle', 'ring', 'pinky') for i in (1, 2, 3)]
FINGER_ORDER = ('thumb', 'index', 'middle', 'ring', 'pinky')

# Full-curl angles (radians) per finger and joint [proximal, middle, distal].
CURL_ANGLES = {
    'index': [1.50, 1.78, 1.20],
    'middle': [1.55, 1.80, 1.22],
    'ring': [1.60, 1.80, 1.20],
    'pinky': [1.66, 1.76, 1.15],
    'thumb': [None, 0.80, 1.05],  # thumb_1 uses its own oblique axis (see thumb_curl)
}


def skin_preview_material() -> bpy.types.Material:
    return common.material('skin_preview', color=(0.55, 0.42, 0.36), roughness=0.55)


def make_mesh(hm: hg.HandMesh, name: str) -> bpy.types.Object:
    ob = hu.mesh_object(name, hm.verts, hm.faces)
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


def shape_review(ob: bpy.types.Object, tag: str) -> None:
    common.assign(ob, skin_preview_material())
    c = Vector((0.0, 0.07, 0.0))
    out = SCRATCH
    views = {
        'back': (c + Vector((0.0, -0.05, 0.38)), Vector((0, 1, 0))),
        'palm': (c + Vector((0.0, -0.05, -0.38)), Vector((0, 1, 0))),
        'side': (c + Vector((-0.38, 0.0, 0.05)), Vector((0, 0, 1))),
        'tips': (c + Vector((-0.10, 0.36, 0.14)), Vector((0, 0, 1))),
        'vr': (c + Vector((0.10, -0.30, 0.24)), Vector((0, 0, 1))),
        'thumbside': (c + Vector((-0.30, 0.10, -0.18)), Vector((0, 0, 1))),
    }
    for k, (pos, up) in views.items():
        hu.render_view(os.path.join(out, f'{tag}_{k}.png'), c, pos, up=up, lens=60, size=420, samples=12)


def wire_overlay(ob: bpy.types.Object) -> bpy.types.Object:
    w = ob.copy()
    w.data = ob.data.copy()
    bpy.context.scene.collection.objects.link(w)
    m = w.modifiers.new('wire', 'WIREFRAME')
    m.thickness = 0.00035
    m.use_relative_offset = False
    m.offset = 1.0
    common.assign(w, common.material('wire', color=(0.05, 0.05, 0.06), roughness=0.9))
    return w


# ---------------------------------------------------------------------------------------------
# Rig
# ---------------------------------------------------------------------------------------------

MIRROR = Matrix.Scale(-1, 3, Vector((1, 0, 0)))


def thumb_curl_rotation(sk: hg.Skeleton) -> Quaternion:
    """Full-curl rotation of thumb_1 (hand space): swing the metacarpal palmward + across the palm
    and pronate it so the pad faces the fingers (opposition)."""
    th = sk.chains['thumb']
    d1 = th.bone_dir(0)
    target = Vector((-0.10, 0.80, -0.59)).normalized()
    swing = d1.rotation_difference(target)
    twist = Quaternion(target, math.radians(32))
    return twist @ swing


def make_armature(sk: hg.Skeleton, name: str, mirror: bool) -> bpy.types.Object:
    S = MIRROR if mirror else Matrix.Identity(3)
    data = bpy.data.armatures.new(f'{name}_rig')
    arm = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(arm)
    common.activate(arm)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = data.edit_bones.new('wrist')
    eb.head = (0, 0, 0)
    eb.tail = (0, 0.045, 0)
    eb.align_roll(Vector((0, 0, -1)))
    for fname in FINGER_ORDER:
        ch = sk.chains[fname]
        parent = eb
        for k in range(3):
            b = data.edit_bones.new(f'{fname}_{k + 1}')
            b.head = S @ ch.joints[k]
            b.tail = S @ ch.joints[k + 1]
            b.parent = parent
            b.use_connect = k > 0
            b.align_roll(S @ ch.flex[k])
            parent = b
    bpy.ops.object.mode_set(mode='OBJECT')

    # curl data -> glTF extras (armature node + every bone)
    q = thumb_curl_rotation(sk)
    M = q.to_matrix()
    if mirror:
        M = S @ M @ S
    qa = M.to_quaternion()
    axis, angle = qa.axis, qa.angle
    if angle > math.pi:
        axis, angle = -axis, 2 * math.pi - angle
    rest1 = data.bones['thumb_1'].matrix_local.to_3x3()
    thumb_axis_local = (rest1.transposed() @ axis).normalized()
    angles = {f: list(CURL_ANGLES[f]) for f in FINGER_ORDER}
    angles['thumb'][0] = round(angle, 4)
    for fi, fname in enumerate(FINGER_ORDER):
        for k in range(3):
            bone = data.bones[f'{fname}_{k + 1}']
            ax = thumb_axis_local if (fname == 'thumb' and k == 0) else Vector((1, 0, 0))
            bone['curlAxis'] = [round(x, 5) for x in ax]
            bone['curlAngle'] = round(angles[fname][k], 4)
            bone['finger'] = fi
    arm['handedness'] = 'left' if mirror else 'right'
    arm['curlAxis'] = [1.0, 0.0, 0.0]
    arm['curlSign'] = 1.0
    arm['curlAngles'] = [round(x, 4) for x in CURL_ANGLES['middle']]
    arm['fingerCurlAngles'] = {f: [round(x, 4) for x in angles[f]] for f in FINGER_ORDER}
    arm['thumbAxis'] = [round(x, 5) for x in thumb_axis_local]
    arm['curlOrder'] = list(FINGER_ORDER)
    arm['curlFormula'] = ('bone.quaternion = rest * axisAngle(bone.extras.curlAxis, curlSign * '
                          'curls[bone.extras.finger] * bone.extras.curlAngle)')
    return arm


def skin(ob: bpy.types.Object, arm: bpy.types.Object, weights: list[dict[str, float]]) -> None:
    groups = {b: ob.vertex_groups.new(name=b) for b in BONES}
    for vi, w in enumerate(weights):
        for bname, x in w.items():
            groups[bname].add([vi], x, 'REPLACE')
    ob.parent = arm
    mod = ob.modifiers.new('rig', 'ARMATURE')
    mod.object = arm


def apply_curls(arm: bpy.types.Object, curls) -> None:
    """Pose the rig exactly like the renderer: rest * axisAngle(curlAxis, curl * curlAngle)."""
    for fi, fname in enumerate(FINGER_ORDER):
        for k in range(3):
            pb = arm.pose.bones[f'{fname}_{k + 1}']
            bone = arm.data.bones[pb.name]
            pb.rotation_mode = 'QUATERNION'
            pb.rotation_quaternion = Quaternion(Vector(bone['curlAxis']), curls[fi] * bone['curlAngle'])
    bpy.context.view_layer.update()


SIGNS = {
    'open': [0.05, 0, 0, 0, 0],
    'fist': [0.8, 1, 1, 1, 1],
    'point': [0.75, 0, 1, 1, 1],
    'thumbsup': [0, 1, 1, 1, 1],
    'three': [0.9, 0, 0, 0, 1],
    'comehere': [0.3, 0.6, 0.6, 0.6, 0.6],
}


def pose_review(arm, ob, tag):
    common.assign(ob, skin_preview_material())
    c = Vector((0.0, 0.07, 0.0))
    for name in ('fist', 'point', 'thumbsup', 'three'):
        apply_curls(arm, SIGNS[name])
        for k, (pos, up) in {
            'side': (c + Vector((-0.30, 0.02, 0.10)), Vector((0, 0, 1))),
            'front': (c + Vector((0.12, 0.30, 0.16)), Vector((0, 0, 1))),
            'palm': (c + Vector((0.05, 0.06, -0.33)), Vector((0, 1, 0))),
        }.items():
            hu.render_view(os.path.join(SCRATCH, f'{tag}_{name}_{k}.png'), c, pos, up=up, lens=60, size=360, samples=10)
    apply_curls(arm, [0] * 5)


# ---------------------------------------------------------------------------------------------
# UVs + textures
# ---------------------------------------------------------------------------------------------

TEX = int(os.environ.get('HANDS_TEX', '1024'))


def unwrap(ob: bpy.types.Object, hm: hg.HandMesh) -> None:
    import bmesh
    me = ob.data
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    bm = bmesh.new()
    bm.from_mesh(me)
    for e in bm.edges:
        a, b = e.verts[0].index, e.verts[1].index
        e.seam = (min(a, b), max(a, b)) in hm.seams
    bm.to_mesh(me)
    bm.free()
    common.activate(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.unwrap(method='ANGLE_BASED', margin=0.003)
    bpy.ops.uv.pack_islands(rotate=True, margin=0.003)
    bpy.ops.object.mode_set(mode='OBJECT')


def region_attribute(ob: bpy.types.Object, hm: hg.HandMesh) -> None:
    ca = ob.data.color_attributes.new('region', 'FLOAT_COLOR', 'POINT')
    for i, d in enumerate(ca.data):
        cuff = hm.region[i] == 'cuff'
        inner = cuff and hm.station[i][1] >= 8
        d.color = (1.0 if cuff else 0.0, 1.0 if inner else 0.0, 0.0, 1.0)


def make_textures(ob: bpy.types.Object, hm: hg.HandMesh, sk: hg.Skeleton, size: int) -> bpy.types.Material:
    region_attribute(ob, hm)
    td = ht.texel_data(ob, size, region_attr='region')
    m = td['mask']
    print(f'[hands] texel coverage {m.mean() * 100:.1f}%')
    H, C, R = hands_detail.evaluate(td['P'][m].astype(np.float64), td['N'][m].astype(np.float64),
                                    td['region'][m], sk, life_line=hm.meta.get('life_line'))
    Hf = np.zeros(m.shape)
    Hf[m] = H
    Cf = np.zeros(m.shape + (3,))
    Cf[m] = C
    Rf = np.zeros(m.shape)
    Rf[m] = R
    objn = ht.height_to_object_normal(Hf, td['P'].astype(np.float64), td['N'].astype(np.float64), m,
                                      max_step=0.0025 * 1024 / size)
    if os.environ.get('HANDS_DEBUG_TEX'):
        dots = np.sum(objn * td['N'], -1)
        bad = m & (dots < 0.75)
        print(f'[hands] steep normal texels: {bad.sum()}')
        if bad.any():
            Pb = td['P'][bad]
            Hb = Hf[bad]
            for i in np.linspace(0, len(Pb) - 1, min(30, len(Pb))).astype(int):
                print('[hands]   ', np.round(Pb[i], 4), round(float(Hb[i]) * 1000, 3), 'mm', round(float(dots[bad][i]), 2))
    objn = ht.dilate(objn, m, 16)
    objn /= np.maximum(np.linalg.norm(objn, axis=-1, keepdims=True), 1e-6)
    Cf = ht.dilate(Cf, m, 16)
    Rf = ht.dilate(Rf, m, 16)
    color = hu.np_to_image('hand_color', hu.lin_to_srgb(Cf))
    rough = hu.np_to_image('hand_roughness', Rf, non_color=True)
    normal = ht.bake_tangent_normal(ob, objn, size, 'hand')
    for img in (color, rough, normal):
        img.pack()
    if os.environ.get('HANDS_DEBUG_TEX'):
        for img in (color, rough, normal):
            hu.save_png(img.copy(), os.path.join(SCRATCH, f'tex_{img.name}.png'))
    for nm in ('cover', 'region'):
        if nm in ob.data.color_attributes:
            ob.data.color_attributes.remove(ob.data.color_attributes[nm])
    mat = hu.image_material('hand_skin', color, rough, normal)
    mat.use_backface_culling = True
    common.assign(ob, mat)
    return mat


def mirror_object(src: bpy.types.Object, name: str) -> bpy.types.Object:
    import bmesh
    ob = src.copy()
    ob.data = src.data.copy()
    ob.name = name
    ob.data.name = name
    ob.modifiers.clear()
    ob.parent = None
    bpy.context.scene.collection.objects.link(ob)
    ob.data.transform(Matrix.Scale(-1, 4, Vector((1, 0, 0))))
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    return ob


def tex_review(ob, arm):
    c = Vector((0.0, 0.075, 0.0))
    for k, (pos, up) in {
        'back': (c + Vector((0.0, -0.06, 0.30)), Vector((0, 1, 0))),
        'palm': (c + Vector((0.0, -0.06, -0.30)), Vector((0, 1, 0))),
        'vr': (c + Vector((0.12, -0.24, 0.20)), Vector((0, 0, 1))),
        'tipcu': (Vector((-0.010, 0.15, 0.006)) + Vector((0.05, 0.10, 0.10)), Vector((0, 0, 1))),
        'thenar': (Vector((-0.014, 0.014, -0.016)) + Vector((0.01, -0.035, -0.085)), Vector((0, 1, 0))),
    }.items():
        tgt = {'tipcu': Vector((-0.010, 0.15, 0.006)), 'thenar': Vector((-0.014, 0.014, -0.016))}.get(k, c)
        hu.render_view(os.path.join(SCRATCH, f'tex_{k}.png'), tgt, pos, up=up, lens=60, size=480, samples=16)
    if os.environ.get('HANDS_WIRE'):
        w = wire_overlay(ob)
        w.modifiers.remove(w.modifiers['rig']) if 'rig' in w.modifiers else None
        tgt = Vector((-0.014, 0.014, -0.016))
        hu.render_view(os.path.join(SCRATCH, 'tex_thenar_wire.png'), tgt, tgt + Vector((0.01, -0.035, -0.085)),
                       up=Vector((0, 1, 0)), lens=60, size=480, samples=8)


def orient(arm: bpy.types.Object, fingers, back, location=(0, 0, 0)) -> None:
    """Place the rig so the fingers point along `fingers` and the back of the hand faces `back`
    (Blender world). Canonical: local +Y = fingers, +Z = back."""
    y = Vector(fingers).normalized()
    z = Vector(back)
    z = (z - y * z.dot(y)).normalized()
    x = y.cross(z)
    m = Matrix((x, y, z)).transposed().to_4x4()
    m.translation = Vector(location)
    arm.matrix_world = m
    bpy.context.view_layer.update()


def eval_points(objs) -> list[Vector]:
    deps = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in objs:
        ev = o.evaluated_get(deps)
        me = ev.to_mesh()
        mw = ev.matrix_world
        pts.extend(mw @ v.co for v in me.vertices)
        ev.to_mesh_clear()
    return pts


def framed_render(path, objs, cam_dir, up=Vector((0, 0, 1)), lens=55, size=640, samples=48, fill=1.0, mood='studio'):
    pts = eval_points(objs)
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    c = (lo + hi) / 2
    r = max((p - c).length for p in pts)
    fov = 2 * math.atan(18 / lens)
    dist = r / math.sin(fov / 2) * 0.92 / fill
    d = Vector(cam_dir).normalized()
    hu.render_view(path, c, c + d * dist, up=up, lens=lens, size=size, samples=samples, mood=mood)


PREVIEW_SHOTS = {
    # name: (sign, fingers, back, camera direction)   Blender world, camera looks at the hand
    'hand_open': ('open', (0.0, 0.08, 1.0), (0.12, 1.0, 0.0), (0.42, -1.0, 0.12)),
    'hand_fist': ('fist', (0.0, 0.10, 1.0), (0.0, 1.0, 0.0), (0.75, -1.0, 0.30)),
    'hand_point': ('point', (-1.0, -0.25, 0.08), (0.0, 0.25, 1.0), (-0.15, -1.0, 0.55)),
    'hand_thumbsup': ('thumbsup', (0.35, -1.0, 0.0), (-1.0, -0.35, 0.0), (0.55, -1.0, 0.18)),
}


def renders(arm, ob, arm_l, ob_l):
    """Final previews (Blender, posed like the signs, seen by a teammate) -> art/previews/hand_*.png"""
    for o in (arm_l, ob_l):
        o.hide_render = True
    samples = int(os.environ.get('HANDS_SAMPLES', '48'))
    for name, (sign, fingers, back, cam) in PREVIEW_SHOTS.items():
        orient(arm, fingers, back)
        apply_curls(arm, SIGNS[sign])
        framed_render(os.path.join(common.PREVIEW_DIR, f'{name}.png'), [ob], cam, samples=samples)
    apply_curls(arm, [0] * 5)
    arm.matrix_world = Matrix.Identity(4)
    for o in (arm_l, ob_l):
        o.hide_render = False


def build() -> None:
    common.reset()
    hm, sk = hg.build_hand()
    ob = make_mesh(hm, 'hand_right_mesh')
    print(f'[hands] low-poly: {len(hm.verts)} verts, {common.tri_count([ob])} tris')
    if STAGE == 'shape':
        if os.environ.get('HANDS_WIRE'):
            wire_overlay(ob)
        shape_review(ob, 'shape')
        return
    arm = make_armature(sk, 'hand_right', mirror=False)
    skin(ob, arm, hm.weights)
    if STAGE == 'pose':
        pose_review(arm, ob, 'pose')
        return
    unwrap(ob, hm)
    mat = make_textures(ob, hm, sk, TEX)
    if STAGE == 'tex':
        tex_review(ob, arm)
        return

    # left hand = true mirror
    ob_l = mirror_object(ob, 'hand_left_mesh')
    arm_l = make_armature(sk, 'hand_left', mirror=True)
    groups = {g.name for g in ob_l.vertex_groups}
    assert set(BONES) <= groups
    ob_l.parent = arm_l
    ob_l.modifiers.new('rig', 'ARMATURE').object = arm_l
    ob.name = ob.data.name = 'hand_right_mesh'
    common.assign(ob_l, mat)
    print(f'[hands] right {common.tri_count([ob])} tris, left {common.tri_count([ob_l])} tris')

    for o in (arm, arm_l):
        apply_curls(o, [0] * 5)
    common.export_glb('hand_right', [arm])
    common.export_glb('hand_left', [arm_l])
    if STAGE != 'export':
        renders(arm, ob, arm_l, ob_l)
