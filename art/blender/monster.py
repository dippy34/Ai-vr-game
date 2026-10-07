"""
MUTE monster: "the Listener" -> public/models/monster.glb (+ art/previews/monster_*.png).

Pipeline (all procedural, headless, deterministic):
  1. Sculpt (monster_anatomy + monster_sdf): the body is a signed-distance program. Skin
     envelopes per region, then bones, tendons and knobs pushed through them by a few millimeters
     (ribs with sunken intercostals, winged scapulae, vertebrae, clavicles, knobby knuckles and
     joints, nail beds, finger webbing, peeled lips over swollen gums, a ridged wet mouth,
     sealed eye sockets, skull ear-holes, sores and scars, tall membrane ears braced by
     transverse cartilage folds with a torn, scalloped trailing edge), polygonized at 2.5 mm
     with surface nets.
  2. Paint (monster_skin): per-vertex masks on the sculpt (cavity, mouth/holes, wet, dry,
     sockets, extremities, joint wrinkle rings, limb axes for directional veins and stretch
     marks, sores, scars, dried blood, ears) drive a procedural skin shader: mottling, bruising,
     necrotic extremities, veins, pores, crepe, joint wrinkles, stretch marks, cracked dry
     knees/elbows/knuckles, wet gums/lips/tear tracks, blood smeared round the mouth and nails.
  3. Game mesh (monster_mesh): density-weighted collapse decimation (face, hands, ears, joints
     keep the most), label-based UV charts cut into disks by a hidden-side cut graph and
     unwrapped with minimum stretch, texel density weighted toward the face and hands, then bake color,
     roughness and tangent-space normals (OpenGL, +Y) from the sculpt at 2048^2 (WebP).
  4. Keratin (monster_keratin): three rows of layered needle teeth per mandible and long,
     curved, cracked nails on every finger and toe, low-poly, with their own 512^2 texture set.
  5. Rig (monster_rig): the fixed 59-bone skeleton; skin weights from limb/spine-chain blending
     with bisector joint planes (narrow in the creases, wide over elbows/knees), root partitions
     at shoulders/hips, lightly smoothed, plus hand-authored jaw/ear weights; teeth
     and nails rigid to the skin they are rooted in. One skinned mesh, 2 materials.
  6. Actions: Idle, Walk (1.0 m/s), Run (3.1 m/s), Listen, Attack (one-shot), Feed, in place.

Shader masks (for the engine's skin shader), per vertex, glTF COLOR_0 (RGBA, linear, 0..1):
  R = thinness:  1 = very thin skin that light can shine through (ear membranes ~0.85-1, finger
                 and toe webbing ~0.7, lip and nostril edges ~0.6, eyelid seams, fingertips);
                 general skin ~0.08, thin-skinned areas (neck, inner arms, temples) ~0.2;
                 teeth 0.35-0.6 (translucent toward the tips), nails 0.2-0.45.
  G = wetness:   1 = wet (mouth cavity, gums, lips ~0.8, inner mouth/throat 1); eye-socket
                 seepage, nostrils, ear canals and skull pits ~0.5-0.7; open sores ~0.9;
                 armpits/groin ~0.2; teeth 0.7, nails 0.12; dry skin 0.
  B = cavity/AO: multiplicative occlusion, 1 = open skin, -> 0 deep in creases, the mouth and
                 throat, ear canals, between fingers and toes, armpits (local ambient occlusion
                 of the bind pose x fine sculpt cavity).
  A = 1 (unused).

Run: `npm run assets -- monster`. Env: MONSTER_H (voxel size, default 0.0025), MONSTER_FAST=1
(lower-res everything for quick iteration), MONSTER_NOPREVIEW=1, MONSTER_PREVIEWS=a,b (only these
previews), MONSTER_CACHE=<dir> (dev only: reuse the sculpt / bake when their sources are
unchanged), MONSTER_LOOKDEV=face,hand,... (render close-ups of the raw sculpt and stop).
"""

from __future__ import annotations

import hashlib
import math
import os
import pickle
import sys
import time

import bpy
import bmesh
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import common  # noqa: E402
import monster_anatomy as A  # noqa: E402
import monster_keratin as KER  # noqa: E402
import monster_mesh as MESH  # noqa: E402
import monster_rig as RIG  # noqa: E402
import monster_sdf as S  # noqa: E402
import monster_skin as SKIN  # noqa: E402

FAST = os.environ.get('MONSTER_FAST') == '1'
H_HIGH = float(os.environ.get('MONSTER_H', '0.004' if FAST else '0.0025'))
TEX = 1024 if FAST else 2048
LOW_TRIS = 24600      # body; teeth + nails add ~3.5k
SCALE = 1.15          # design units -> meters (hunched Idle stands ~2.1 m, upright ~2.6 m)
NAME = 'monster'
CACHE = os.environ.get('MONSTER_CACHE')


def log(msg, t0=[time.time()]):
    print(f'[monster {time.time() - t0[0]:6.1f}s] {msg}', flush=True)


def _hash(mods, extra='') -> str:
    h = hashlib.sha1(extra.encode())
    for m in mods:
        with open(m.__file__, 'rb') as f:
            h.update(f.read())
    return h.hexdigest()[:16]


# ---------------------------------------------------------------------------------------------
# mesh helpers
# ---------------------------------------------------------------------------------------------

def mesh_obj(name, V, Q) -> bpy.types.Object:
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(V))
    me.vertices.foreach_set('co', V.astype(np.float32).ravel())
    me.loops.add(Q.size)
    me.loops.foreach_set('vertex_index', Q.astype(np.int32).ravel())
    me.polygons.add(len(Q))
    me.polygons.foreach_set('loop_start', np.arange(0, Q.size, Q.shape[1], dtype=np.int32))
    me.update(calc_edges=True)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def set_color_attr(ob, name, rgba):
    at = ob.data.color_attributes.new(name, 'FLOAT_COLOR', 'POINT')
    at.data.foreach_set('color', np.clip(rgba, 0, 1).astype(np.float32).ravel())


def eval_labels(B, P) -> np.ndarray:
    out = np.zeros(len(P), np.int16)
    for s in range(0, len(P), 60000):
        _, lab = B.eval(P[s:s + 60000].astype(np.float32), want_label=True)
        out[s:s + 60000] = lab
    return out


def _labels_job(chunk):
    B, P = S._JOB
    return eval_labels(B, P[chunk[0]:chunk[1]])


def eval_labels_parallel(B, P, workers=3) -> np.ndarray:
    import multiprocessing as mp
    S._JOB = (B, P)
    n = len(P)
    cuts = np.linspace(0, n, workers * 3 + 1).astype(int)
    chunks = [(cuts[i], cuts[i + 1]) for i in range(len(cuts) - 1)]
    with mp.get_context('fork').Pool(workers) as pool:
        res = pool.map(_labels_job, chunks)
    return np.concatenate(res)


# ---------------------------------------------------------------------------------------------
# stage 1: sculpt (design units)
# ---------------------------------------------------------------------------------------------

def sculpt(J) -> dict:
    key = _hash([A, S], f'{H_HIGH}')
    path = os.path.join(CACHE, f'sculpt_{key}.pkl') if CACHE else None
    if path and os.path.exists(path):
        with open(path, 'rb') as f:
            st = pickle.load(f)
        log(f'sculpt from cache ({len(st["V"])} verts)')
        return st
    B, info = A.body(J, detail=True)
    log('sdf program ready')
    lo, hi = A.bounds(J)
    V, Q = S.polygonize(B, lo, hi, H_HIGH)
    V = S.taubin(V, Q, 1)
    log(f'sculpt polygonized: {len(V)} verts')
    labels = eval_labels_parallel(B, V)
    log('labels')
    st = {'V': V, 'Q': Q, 'labels': labels, 'info': info, 'key': key}
    if path:
        os.makedirs(CACHE, exist_ok=True)
        with open(path, 'wb') as f:
            pickle.dump(st, f, protocol=4)
    return st


def high_object(st, J, mk):
    high = mesh_obj('monster_sculpt', st['V'] * SCALE, st['Q'])
    for nm, arr in mk['attrs'].items():
        set_color_attr(high, nm, arr)
    for nm, arr in mk.get('floats', {}).items():
        at = high.data.attributes.new(nm, 'FLOAT', 'POINT')
        at.data.foreach_set('value', np.asarray(arr, np.float32))
    for nm, arr in mk.get('vectors', {}).items():
        at = high.data.attributes.new(nm, 'FLOAT_VECTOR', 'POINT')
        at.data.foreach_set('vector', np.asarray(arr, np.float32).ravel())
    high.data.polygons.foreach_set('use_smooth', np.ones(len(st['Q']), bool))
    common.assign(high, SKIN.skin_material())
    return high


# ---------------------------------------------------------------------------------------------
# stage 2: game mesh + bake (meters)
# ---------------------------------------------------------------------------------------------

def game_mesh(st, J, Jw, mk):
    key = _hash([A, S, SKIN, MESH], f'{st["key"]}|{TEX}|{LOW_TRIS}')
    path = os.path.join(CACHE, f'bake_{key}.blend') if CACHE else None
    if path and os.path.exists(path):
        bpy.ops.wm.open_mainfile(filepath=path)
        low = bpy.data.objects['monster_body']
        llab = np.array(low['llab'], np.int16)
        del low['llab']                       # cache-only data, must not reach the glTF extras
        log('game mesh + bake from cache')
        return low, llab
    high = high_object(st, J, mk)
    log('sculpt object')
    dens = MESH.density(st['V'], st['labels'], J)
    low, llab = MESH.build_low(high, st['V'], st['labels'], Jw, SCALE, LOW_TRIS, dens)
    log('decimated + uv')
    common.bake(low, 'monster_skin', size=TEX, high=high, normal=True, roughness=True,
                cage_extrusion=0.008, margin=12, samples=4 if FAST else 5)
    log('baked')
    bpy.data.objects.remove(high)
    if path:
        low['llab'] = [int(x) for x in llab]
        bpy.ops.wm.save_as_mainfile(filepath=path, compress=False)
        del low['llab']
    return low, llab


# ---------------------------------------------------------------------------------------------
# look-dev: close-ups of the raw sculpt with the procedural shader (no bake)
# ---------------------------------------------------------------------------------------------

LOOKDEV = {   # name: (center (design units), half-size, yaw, pitch, mood)
    'face': ((0, 0.33, 2.08), 0.11, 12, 0, 'flash'),
    'face3q': ((0.02, 0.30, 2.13), 0.15, 50, 10, 'flash'),
    'mouth': ((0, 0.355, 2.035), 0.055, 0, 0, 'flash'),
    'head': ((0, 0.22, 2.18), 0.26, 120, 15, 'studio'),
    'hand': (None, 0.17, 0, 0, 'flash'),
    'palm': (None, 0.17, 0, 0, 'flash'),
    'torso': ((0, 0.02, 1.55), 0.32, 25, 5, 'flash'),
    'back': ((0, -0.05, 1.55), 0.34, 160, 10, 'flash'),
    'ear': ((0.15, 0.13, 2.30), 0.20, 70, 10, 'flash'),
    'knee': ((0.12, 0.08, 0.58), 0.16, 20, 5, 'flash'),
    'foot': ((0.13, 0.05, 0.06), 0.16, 30, 25, 'flash'),
    'arm': ((0.42, 0.10, 1.40), 0.32, 20, 0, 'flash'),
}


def framed(name, center_m, half, yaw, pitch, mood, samples=24, size=420):
    proxy = bpy.data.objects.new('__frame_proxy', bpy.data.meshes.new('__frame_proxy'))
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=half * 2 / math.sqrt(3) * 1.0)
    bm.to_mesh(proxy.data)
    bm.free()
    proxy.location = center_m
    proxy.hide_render = True
    bpy.context.scene.collection.objects.link(proxy)
    bpy.context.view_layer.update()
    common.preview(name, [proxy], yaw_deg=yaw, pitch_deg=pitch, size=size, mood=mood, samples=samples)
    bpy.data.objects.remove(proxy)


def lookdev(st, J, mk, which):
    high = high_object(st, J, mk)
    KER.make(J, SCALE, st['info'])
    log('sculpt object + keratin')
    R_ = J['R']
    for nm in which:
        c, half, yaw, pitch, mood = LOOKDEV[nm]
        if nm in ('hand', 'palm'):
            c = R_['W'] + R_['ha'] * 0.17
            nrm = R_['hn'] if nm == 'palm' else -R_['hn']
            yaw = math.degrees(math.atan2(nrm[0], nrm[1]))
            pitch = math.degrees(math.asin(np.clip(nrm[2], -1, 1)))
        framed(f'_lookdev_{nm}', Vector(tuple(np.asarray(c) * SCALE)), half * SCALE, yaw, pitch, mood)
        log(f'lookdev {nm}')


# ---------------------------------------------------------------------------------------------
# previews
# ---------------------------------------------------------------------------------------------

def render_previews(mesh, arm, J, prefix='monster', samples=40, size=640, only=None):
    shots = [
        ('front', 'Idle', 0.6, 0, 6, 'studio', 1.0),
        ('3q', 'Idle', 0.6, 35, 8, 'studio', 1.0),
        ('side', 'Idle', 0.6, 90, 4, 'studio', 1.0),
        ('flash', 'Walk', 0.35, 12, 2, 'flash', 1.0),
        ('walk', 'Walk', 0.35, 60, 6, 'studio', 1.0),
        ('attack', 'Attack', 0.50, 30, 4, 'flash', 1.0),
    ]
    for tag, act, t, yaw, pitch, mood, zoom in shots:
        if only and tag not in only:
            continue
        RIG.apply_pose(arm, J, act, t)
        common.preview(f'{prefix}_{tag}', [mesh], yaw_deg=yaw, pitch_deg=pitch, size=size, mood=mood,
                       samples=samples, zoom=zoom)
    # close-ups in the flash: frame a point in a bone's rest frame
    def at_bone(bone, p_design):
        hm = arm.matrix_world @ arm.pose.bones[bone].matrix
        return hm @ (arm.data.bones[bone].matrix_local.inverted() @ (Vector(p_design) * SCALE))
    if not only or 'face' in only:
        RIG.apply_pose(arm, J, 'Listen', 0.2)
        framed(f'{prefix}_face', at_bone('head', (0, 0.29, 2.10)), 0.15 * SCALE, 18, 0, 'flash', samples, size)
    if not only or 'catch' in only:
        # what the caught player sees: the lunge peak, jaws split, from ~0.45 m
        RIG.apply_pose(arm, J, 'Attack', 0.5)
        framed(f'{prefix}_catch', at_bone('jaw', (0, 0.33, 2.03)), 0.20 * SCALE, 8, -4, 'flash', samples, size)
    if not only or 'hand' in only:
        RIG.apply_pose(arm, J, 'Attack', 0.62)
        R_ = J['R']
        framed(f'{prefix}_hand', at_bone('hand_R', tuple(np.asarray(R_['W'] + R_['ha'] * 0.16) / SCALE)),
               0.17 * SCALE, 40, 10, 'flash', samples, size)
    # stress poses for the procedural IK (crawl, reach, crouch, grip, twist)
    for tag, yaw, pitch, bone, half in RIG.STRESS_VIEWS:
        if only and 'stress' not in only and f'stress_{tag}' not in only:
            continue
        RIG.apply_stress(arm, J, tag)
        if bone:
            c = (arm.matrix_world @ arm.pose.bones[bone].matrix).translation
            framed(f'{prefix}_stress_{tag}', c, half, yaw, pitch, 'studio', samples, size)
        else:
            common.preview(f'{prefix}_stress_{tag}', [mesh], yaw_deg=yaw, pitch_deg=pitch, size=size, mood='studio',
                           samples=samples, zoom=1.25)


# ---------------------------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------------------------

def export_glb(arm) -> str:
    os.makedirs(common.MODELS_DIR, exist_ok=True)
    path = os.path.join(common.MODELS_DIR, f'{NAME}.glb')
    objs = [arm] + list(arm.children_recursive)
    common.activate(arm, objs)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
        export_texcoords=True, export_tangents=True, export_normals=True, export_materials='EXPORT',
        export_image_format='WEBP', export_animations=True, export_animation_mode='ACTIONS',
        export_skins=True, export_lights=False, export_cameras=False, export_extras=True,
        export_vertex_color='NAME', export_vertex_color_name=SKIN.COLOR_ATTR, export_all_vertex_colors=False,
        export_active_vertex_color_when_no_material=False,
    )
    print(f'[export] {path}  ({os.path.getsize(path) / 1024:.0f} KB)')
    return path


def build():
    t0 = time.time()
    common.reset()
    J = A.skeleton()
    Jw = A.scale_skeleton(J, SCALE)
    st = sculpt(J)
    mk = SKIN.masks(st['V'], st['Q'], st['labels'], J, st['info'])
    log('masks')
    look = os.environ.get('MONSTER_LOOKDEV')
    if look:
        lookdev(st, J, mk, [s for s in look.split(',') if s])
        return
    low, llab = game_mesh(st, J, Jw, mk)
    SKIN.shader_masks(low, llab, st, mk, SCALE)
    log('shader masks')
    kera, kroots = KER.make(J, SCALE, st['info'])
    arm = RIG.build_armature(Jw, NAME)
    arm['walkSpeed'] = 1.0
    arm['runSpeed'] = 3.1
    arm['height'] = round(2.28 * SCALE, 2)
    RIG.skin(low, arm, llab, Jw)
    log('skinned')
    RIG.bind_rigid(kera, kroots, low, arm)
    body = common.join([low, kera], 'monster_body')
    body.parent = arm
    mod = body.modifiers.get('Armature') or body.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    for m in list(body.modifiers):
        if m.type == 'ARMATURE' and m != mod:
            body.modifiers.remove(m)
    body['walkSpeed'] = 1.0
    body['runSpeed'] = 3.1
    RIG.make_actions(arm, Jw)
    log('actions')
    common.report(NAME, [body])
    export_glb(arm)
    log('exported')
    if CACHE:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(CACHE, 'final.blend'), compress=False)
    if os.environ.get('MONSTER_NOPREVIEW') != '1':
        only = os.environ.get('MONSTER_PREVIEWS')
        render_previews(body, arm, Jw, samples=24 if FAST else 48, only=only.split(',') if only else None)
        log('previews')
    print(f'[monster] build took {time.time() - t0:.0f}s')


if __name__ == '__main__':
    build()
