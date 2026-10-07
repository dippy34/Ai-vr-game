"""
Rig + animations for the Listener (helper for monster.py; build() is a no-op).

Armature built from monster_anatomy.skeleton(); skin weights are analytic (skin_weights): chain
blending across bisector joint planes with per-joint, per-side blend widths, smooth root
partitions at the shoulders and hips, finger-affinity knuckle splits, then hand-authored weights
for the split jaw and the ears; teeth and nails copy the skin they are rooted in (bind_rigid).
Stress poses (crawl, deep crouch, reach, grip with twisted wrists) render as previews so the
deformation the procedural IK will cause can be checked.

Animations are authored procedurally with a tiny FK/IK poser:
  * legs: foot-roll gait planner (planted feet slide back at exactly the locomotion speed, so the
    in-place cycles match 1.0 m/s and 3.1 m/s) + analytic two-bone IK that keeps knee hinges.
  * arms: two-bone IK to wrist targets with an elbow pole, hands/fingers by local curls.
  * spine/neck/head: layered periodic motion + sharp "twitch" events (still periodic).
Loops are sampled on [0, N] with periodic functions, so the first key == the last key.
"""

from __future__ import annotations

import math

import bpy
import numpy as np
from mathutils import Euler, Matrix, Quaternion, Vector

import monster_anatomy as A

FPS = 30


def build() -> None:
    print('[monster_rig] helper module, nothing to build')


# ---------------------------------------------------------------------------------------------
# armature
# ---------------------------------------------------------------------------------------------

def bone_specs(J) -> list[tuple]:
    """(name, head, tail, parent, z_hint, connect)"""
    V = lambda a: Vector(tuple(float(x) for x in a))
    B = []
    B.append(('root', V((0, 0, 0)), V((0, 0, 0.2)), None, V((0, 1, 0)), False))
    B.append(('hips', V(J['pelvis']), V(J['L5']), 'root', V((0, 1, 0)), False))
    B.append(('spine_1', V(J['L5']), V(J['T12']), 'hips', V((0, 1, 0)), True))
    B.append(('spine_2', V(J['T12']), V(J['T6']), 'spine_1', V((0, 1, 0)), True))
    B.append(('spine_3', V(J['T6']), V(J['C7']), 'spine_2', V((0, 1, 0)), True))
    B.append(('neck', V(J['C7']), V(J['C3']), 'spine_3', V((0, 1, 0)), True))
    B.append(('neck_2', V(J['C3']), V(J['atlas']), 'neck', V((0, 1, 0)), True))
    B.append(('head', V(J['atlas']), V(J['head_tip']), 'neck_2', V((0, 1, 0)), True))
    B.append(('jaw', V(J['jaw_hinge']), V(J['jaw_tip']), 'head', V((0, 0, 1)), False))
    for side, s in (('L', -1), ('R', 1)):
        k = J['scale']
        B.append((f'jaw_{side}', V((0.016 * s * k, 0.294 * k, 2.052 * k)), V((0.009 * s * k, 0.358 * k, 2.036 * k)), 'jaw', V((0, 0, 1)), False))
    for side in ('L', 'R'):
        base, u, nrm = J[side]['ear']
        B.append((f'ear_{side}', V(base), V(base + u * 0.13 * J['scale']), 'head', V(nrm), False))
    for side in ('L', 'R'):
        R = J[side]
        sf = f'_{side}'
        B.append(('shoulder' + sf, V(R['clav_in']), V(R['S']), 'spine_3', V((0, 0, 1)), False))
        B.append(('upper_arm' + sf, V(R['S']), V(R['E']), 'shoulder' + sf, V((0, 1, 0)), True))
        B.append(('forearm' + sf, V(R['E']), V(R['W']), 'upper_arm' + sf, V((0, 1, 0)), True))
        hand_tip = R['W'] + R['ha'] * A.PALM
        B.append(('hand' + sf, V(R['W']), V(hand_tip), 'forearm' + sf, V(R['hn']), True))
        for f in A.FINGERS:
            pts = R[f + '_pts']
            for i in range(3):
                parent = 'hand' + sf if i == 0 else f'{f}_{i}{sf}'
                B.append((f'{f}_{i + 1}{sf}', V(pts[i]), V(pts[i + 1]), parent, V(R['hn']), i > 0))
        B.append(('thigh' + sf, V(R['H']), V(R['K']), 'hips', V((0, 1, 0)), False))
        B.append(('shin' + sf, V(R['K']), V(R['A']), 'thigh' + sf, V((0, 1, 0)), True))
        B.append(('foot' + sf, V(R['A']), V(R['ball']), 'shin' + sf, V((0, 0, 1)), True))
        B.append(('toe' + sf, V(R['ball']), V(R['toe_tip']), 'foot' + sf, V((0, 0, 1)), True))
    return B


def build_armature(J, name='monster') -> bpy.types.Object:
    data = bpy.data.armatures.new(name + '_rig')
    arm = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    for o in bpy.context.view_layer.objects:
        o.select_set(o == arm)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = data.edit_bones
    for (n, h, t, parent, zh, connect) in bone_specs(J):
        b = eb.new(n)
        b.head, b.tail = h, t
        y = (t - h).normalized()
        z = zh - y * zh.dot(y)
        if z.length < 1e-6:
            z = Vector((0, 0, 1)) - y * y.z
        b.align_roll(z.normalized())
        if parent:
            b.parent = eb[parent]
            b.use_connect = bool(connect) and (eb[parent].tail - h).length < 1e-5
        b.use_deform = n != 'root'
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    return arm


# ---------------------------------------------------------------------------------------------
# skinning
# ---------------------------------------------------------------------------------------------

def _smooth01(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def _nrm(v):
    v = np.asarray(v, float)
    return v / max(np.linalg.norm(v), 1e-12)


def _plane_t(P, c, n, h):
    """0 before / 1 past the joint plane through c (normal n), blended over +-h (h may vary)."""
    return _smooth01(-1.0, 1.0, ((P - np.asarray(c, float)) @ _nrm(n)) / np.maximum(h, 1e-6))


def _chain(P, bones, joints, normals, hs) -> dict:
    """Partition of unity along a bone chain: bone i owns what lies past joint i-1 and before
    joint i (product form, so it always sums to 1)."""
    out, acc = {}, np.ones(len(P))
    for i, b in enumerate(bones):
        if i < len(joints):
            t = _plane_t(P, joints[i], normals[i], hs[i])
            out[b] = acc * (1 - t)
            acc = acc * t
        else:
            out[b] = acc
    return out


def _seg_dist(P, a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    ab = b - a
    t = np.clip(((P - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)


def _radial(P, c, axis):
    """Unit direction from the axis line through c to each point (perpendicular to axis)."""
    q = P - np.asarray(c, float)
    ax = _nrm(axis)
    q = q - np.outer(q @ ax, ax)
    return q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-9)


def skin_weights(co: np.ndarray, labels: np.ndarray, J) -> dict:
    """Analytic skin weights (meters, bind pose): chain blending across bisector joint planes,
    blend widths set per joint and per side (narrow on the inside of a bend, wide over the
    olecranon / kneecap), smooth root partitions at the shoulders (spine / shoulder blade / arm)
    and hips, knuckle splits by finger affinity. Returns {bone: weights}."""
    k = J['scale']
    nv = len(co)
    lab = np.array(A.LABEL_NAMES)[labels]
    Wd: dict = {}

    def add(name, w):
        Wd[name] = Wd.get(name, 0) + w

    # ---- spine chain (hips .. head) ------------------------------------------------------
    sj = [J['pelvis'], J['L5'], J['T12'], J['T6'], J['C7'], J['C3'], J['atlas'], J['head_tip']]
    sb = ['hips', 'spine_1', 'spine_2', 'spine_3', 'neck', 'neck_2', 'head']
    sd = [_nrm(sj[i + 1] - sj[i]) for i in range(len(sj) - 1)]
    spine = _chain(co, sb, sj[1:7], [_nrm(sd[i] + sd[i + 1]) for i in range(6)],
                   [0.055 * k, 0.065 * k, 0.065 * k, 0.045 * k, 0.034 * k, 0.030 * k])

    group = np.full(nv, 'body', dtype=object)
    for side in ('L', 'R'):
        arm_l = [f'clav_{side}', f'upper_arm_{side}', f'forearm_{side}', f'hand_{side}'] + [f'{f}_{side}' for f in A.FINGERS]
        group[np.isin(lab, arm_l)] = 'arm_' + side
        group[np.isin(lab, [f'thigh_{side}', f'shin_{side}', f'foot_{side}'])] = 'leg_' + side
    group[np.isin(lab, ['head', 'jaw_L', 'jaw_R', 'ear_L', 'ear_R'])] = 'head'

    body = {b: w.copy() for b, w in spine.items()}          # what the torso does, per vertex
    total_root = np.zeros(nv)
    limb_parts = []
    for side, s_ in (('L', -1), ('R', 1)):
        R = J[side]
        S0, E, Wr = R['S'], R['E'], R['W']
        du, df, ha = R['d_up'], R['d_fo'], R['ha']
        eb = R['elbow_back']
        # -- arm chain: upper arm | forearm | hand (+ fingers)
        c_out = _radial(co, E, du + df) @ eb
        h_el = 0.032 * k * (1 + 0.55 * c_out)
        arm = _chain(co, [f'upper_arm_{side}', f'forearm_{side}', f'hand_{side}'], [E, Wr],
                     [_nrm(du + df), _nrm(df + ha)], [h_el, 0.028 * k])
        hand_share = arm.pop(f'hand_{side}')
        fing: dict = {f'hand_{side}': np.zeros(nv)}
        is_f = {f: lab == f'{f}_{side}' for f in A.FINGERS}
        is_hand = lab == f'hand_{side}'
        aff = {}
        for f in A.FINGERS:
            pts, rads, dirs = R[f + '_pts'], R[f + '_rad'], R[f + '_dirs']
            bones = [f'hand_{side}', f'{f}_1_{side}', f'{f}_2_{side}', f'{f}_3_{side}']
            d_in = ha if f != 'thumb' else _nrm(pts[0] - (Wr + ha * 0.01))
            nrms = [_nrm(d_in + dirs[0]), _nrm(dirs[0] + dirs[1]), _nrm(dirs[1] + dirs[2])]
            hs = [rads[0] * (0.95 if f != 'thumb' else 1.4), rads[1] * 0.80, rads[2] * 0.75]
            ch = _chain(co, bones, pts[:3], nrms, hs)
            lat = _seg_dist(co, pts[0] - dirs[0] * 0.02 * k, pts[1])
            aff[f] = np.exp(-(lat / ((0.016 if f != 'thumb' else 0.020) * k)) ** 2)
            for b, w in ch.items():
                fing[b] = fing.get(b, 0) + w * is_f[f] * hand_share
            aff[f + '_ch'] = ch
        tot_aff = sum(aff[f] for f in A.FINGERS)
        for f in A.FINGERS:   # palm / webbing: the hand, blending into the finger roots
            a_f = aff[f] / np.maximum(tot_aff, 1e-6) * np.clip(tot_aff * 4, 0, 1)
            ch = aff[f + '_ch']
            for b, w in ch.items():
                if b == f'hand_{side}':
                    continue
                fing[b] = fing.get(b, 0) + w * a_f * is_hand * hand_share
        fsum = sum(w for b, w in fing.items() if b != f'hand_{side}')
        fing[f'hand_{side}'] = hand_share - fsum
        armw = dict(arm)
        for b, w in fing.items():
            armw[b] = armw.get(b, 0) + w
        # -- root partition at the shoulder: torso | shoulder blade + collarbone | arm
        lateral = np.array([s_, 0.0, 0.0])
        t_arm = _plane_t(co, S0, lateral + du, 0.032 * k)
        prox = 1 - _smooth01(0.065 * k, 0.135 * k, np.linalg.norm(co - S0, axis=1))
        scap = np.array([0.094 * s_, -0.07, 1.685]) * k
        t_sh = np.maximum(1 - _smooth01(0.045 * k, 0.10 * k, _seg_dist(co, R['clav_in'], S0)),
                          0.75 * (1 - _smooth01(0.040 * k, 0.095 * k, np.linalg.norm(co - scap, axis=1))))
        t_sh *= _smooth01(J['T6'][2] - 0.02 * k, J['T6'][2] + 0.07 * k, co[:, 2])
        t_sh *= _smooth01(0.010 * k, 0.040 * k, co[:, 0] * s_)          # not across the midline
        in_arm = group == 'arm_' + side
        ta = np.where(in_arm, t_arm, t_arm * prox * (group == 'body'))
        # body share near this shoulder belongs partly to the shoulder bone
        for b in list(body.keys()):
            body[b] = body[b] * (1 - t_sh * (group != 'head'))
        body[f'shoulder_{side}'] = body.get(f'shoulder_{side}', 0) + t_sh * (group != 'head')
        limb_parts.append((ta, armw))
        total_root += ta
        # -- leg chain: thigh | shin | foot | toe
        H, K, Ak = R['H'], R['K'], R['A']
        ld, sdn = _nrm(K - H), _nrm(Ak - K)
        fd, td = _nrm(R['ball'] - Ak), _nrm(R['toe_tip'] - R['ball'])
        kfwd = _nrm(_nrm(np.array([0, 1.0, 0]) - ld * ld[1]) + _nrm(np.array([0, 1.0, 0]) - sdn * sdn[1]))
        c_front = _radial(co, K, ld + sdn) @ kfwd
        h_kn = 0.034 * k * (1 + 0.45 * c_front)
        leg = _chain(co, [f'thigh_{side}', f'shin_{side}', f'foot_{side}', f'toe_{side}'], [K, Ak, R['ball']],
                     [_nrm(ld + sdn), _nrm(sdn + fd), _nrm(fd + td)], [h_kn, 0.030 * k, 0.016 * k])
        hip_n = _nrm(ld + np.array([0, 0, -1.0]))
        c_back = _radial(co, H, hip_n) @ np.array([0, -1.0, 0])
        t_leg = _plane_t(co, H + np.array([0, 0, 0.012 * k]), hip_n, 0.050 * k * (1 + 0.30 * c_back))
        side_ok = _smooth01(-0.012 * k, 0.012 * k, co[:, 0] * s_)          # crotch: own side only
        proxl = 1 - _smooth01(0.10 * k, 0.17 * k, np.linalg.norm(co - H, axis=1))
        in_leg = group == 'leg_' + side
        tl = np.where(in_leg, t_leg, t_leg * proxl * side_ok * (group == 'body'))
        limb_parts.append((tl, leg))
        total_root += tl
    total_root = np.clip(total_root, 0, 1)
    scale_body = 1 - total_root
    for b, w in body.items():
        add(b, w * scale_body)
    for t, part in limb_parts:
        for b, w in part.items():
            add(b, w * t)
    return Wd


def skin(mesh: bpy.types.Object, arm: bpy.types.Object, labels: np.ndarray, J, extra_fix=None) -> None:
    """Analytic chain weights (skin_weights) + hand-authored jaw/ear weights, smoothed a little,
    pruned to 4 influences."""
    with bpy.context.temp_override(active_object=arm, selected_objects=[mesh, arm], selected_editable_objects=[mesh, arm]):
        bpy.ops.object.parent_set(type='ARMATURE_NAME')
    me = mesh.data
    nv = len(me.vertices)
    names = [b.name for b in arm.data.bones if b.use_deform]
    col = {n: i for i, n in enumerate(names)}
    co = np.array([v.co[:] for v in me.vertices])
    E = np.array([e.vertices[:] for e in me.edges])

    def smooth_w(W, iters, mask=None):
        deg = np.bincount(E.ravel(), minlength=nv).astype(float)
        for _ in range(iters):
            acc = np.zeros_like(W)
            np.add.at(acc, E[:, 0], W[E[:, 1]])
            np.add.at(acc, E[:, 1], W[E[:, 0]])
            avg = acc / np.maximum(deg, 1)[:, None]
            W = np.where(mask[:, None], 0.5 * W + 0.5 * avg, W) if mask is not None else 0.5 * W + 0.5 * avg
        return W

    W = np.zeros((nv, len(names)))
    for b, w in skin_weights(co, labels, J).items():
        W[:, col[b]] += np.clip(w, 0, None)
    W = W / np.maximum(W.sum(1, keepdims=True), 1e-9)

    # --- hand-authored: split jaw -----------------------------------------------------------
    x, y, z = (co / J['scale']).T     # jaw region is defined in design units
    head_lab = np.isin(labels, [A.LAB['head'], A.LAB['jaw_L'], A.LAB['jaw_R'], A.LAB['neck']])
    f_jaw = _smooth01(0.288, 0.318, y) * _smooth01(2.104, 2.082, z) * _smooth01(1.940, 1.962, z) * (np.abs(x) < 0.05) * head_lab
    f_jaw *= _smooth01(0.050, 0.032, np.abs(x))
    side_L = _smooth01(-0.0005, -0.0045, x)
    side_R = _smooth01(0.0005, 0.0045, x)
    wj = np.zeros((nv, len(names)))
    wj[:, col['jaw_L']] = f_jaw * side_L
    wj[:, col['jaw_R']] = f_jaw * side_R
    wj[:, col['jaw']] = f_jaw * (1 - side_L - side_R)
    W = W * (1 - f_jaw)[:, None] + wj
    # --- ears ---------------------------------------------------------------------------------
    for side in ('L', 'R'):
        base, u, nrm = J[side]['ear']
        along = (co - base) @ u
        f = _smooth01(-0.004, 0.030, along) * (labels == A.LAB['ear_' + side])
        W = W * (1 - f)[:, None]
        W[:, col['ear_' + side]] += f
    # final cleanup: smooth a little (not across the mouth slit), prune to 4 influences, normalize
    W = smooth_w(W, 2, mask=f_jaw < 0.02)
    idx = np.argsort(-W, axis=1)[:, :4]
    W4 = np.zeros_like(W)
    rows = np.arange(nv)[:, None]
    W4[rows, idx] = W[rows, idx]
    W4[W4 < 0.01] = 0
    dead = W4.sum(1) < 1e-6
    if dead.any():   # never leave a vertex unweighted (the exporter would bind it to a neutral bone)
        for vi in np.nonzero(dead)[0]:
            j = int(np.argmax(W[vi])) if W[vi].max() > 0 else col['head' if co[vi, 2] > 1.95 * J['scale'] else 'spine_2']
            W4[vi, j] = 1.0
        print(f'[rig] fixed {int(dead.sum())} unweighted vertices')
    W4 = W4 / np.maximum(W4.sum(1, keepdims=True), 1e-9)
    if extra_fix:
        W4 = extra_fix(W4, col, co, labels)
    for g in list(mesh.vertex_groups):
        mesh.vertex_groups.remove(g)
    for n in names:
        g = mesh.vertex_groups.new(name=n)
        c = W4[:, col[n]]
        for vi in np.nonzero(c > 0)[0]:
            g.add([int(vi)], float(c[vi]), 'REPLACE')
    if not any(m.type == 'ARMATURE' for m in mesh.modifiers):
        mod = mesh.modifiers.new('Armature', 'ARMATURE')
        mod.object = arm


# ---------------------------------------------------------------------------------------------
# poser: FK + IK in armature space
# ---------------------------------------------------------------------------------------------

def q_euler(rx=0.0, ry=0.0, rz=0.0) -> Quaternion:
    return Euler((math.radians(rx), math.radians(ry), math.radians(rz)), 'XYZ').to_quaternion()


def two_bone(root: Vector, target: Vector, l1: float, l2: float, pole: Vector) -> tuple[Vector, Vector]:
    d = target - root
    L = d.length
    L = min(max(L, abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4)
    dn = d.normalized()
    target = root + dn * L
    cos_a = (l1 * l1 + L * L - l2 * l2) / (2 * l1 * L)
    sin_a = math.sqrt(max(0.0, 1 - cos_a * cos_a))
    pp = pole - dn * pole.dot(dn)
    if pp.length < 1e-6:
        pp = Vector((0, 1, 0)) - dn * dn.y
    pp.normalize()
    mid = root + dn * (l1 * cos_a) + pp * (l1 * sin_a)
    return mid, target


def frame_rot(y_from: Vector, h_from: Vector, y_to: Vector, h_to: Vector) -> Matrix:
    """Rotation mapping (y_from, h_from) onto (y_to, h_to) (h orthogonalized against y)."""
    def basis(y, h):
        y = y.normalized()
        h = (h - y * h.dot(y)).normalized()
        return Matrix((y, h, y.cross(h))).transposed()
    return basis(y_to, h_to) @ basis(y_from, h_from).transposed()


class Poser:
    def __init__(self, arm: bpy.types.Object):
        self.arm = arm
        bones = arm.data.bones
        self.rest = {b.name: b.matrix_local.copy() for b in bones}
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in bones}
        self.length = {b.name: b.length for b in bones}
        order, seen = [], set()

        def visit(n):
            if n in seen:
                return
            p = self.parent[n]
            if p:
                visit(p)
            seen.add(n)
            order.append(n)
        for b in bones:
            visit(b.name)
        self.order = order
        self.offs = {}
        for n in order:
            p = self.parent[n]
            self.offs[n] = (self.rest[p].inverted() @ self.rest[n]) if p else self.rest[n].copy()
        self.reset()

    def reset(self):
        self.basis = {n: Matrix.Identity(4) for n in self.order}
        self.M = {}
        self.fk()

    def fk(self, start: str | None = None):
        for n in self.order:
            p = self.parent[n]
            self.M[n] = (self.M[p] @ self.offs[n] if p else self.offs[n]) @ self.basis[n]

    def unposed(self, n) -> Matrix:
        p = self.parent[n]
        return self.M[p] @ self.offs[n] if p else self.offs[n]

    def set_local(self, n, q: Quaternion = None, loc: Vector | None = None, scale=None):
        m = (q or Quaternion()).to_matrix().to_4x4()
        if scale is not None:
            m = m @ Matrix.Diagonal((*scale, 1.0))
        if loc is not None:
            m = Matrix.Translation(loc) @ m
        self.basis[n] = m

    def set_armature(self, n, M_target: Matrix):
        """Pose bone n so its armature-space matrix equals M_target (needs parents posed+fk)."""
        M0 = self.unposed(n)
        self.basis[n] = M0.inverted() @ M_target

    def rot_armature(self, n, R: Matrix, pivot: Vector | None = None, pre_fk=True):
        """Rotate bone n in armature space (about its head) on top of its current basis."""
        if pre_fk:
            self.fk()
        M = self.M[n]
        piv = M.translation.copy() if pivot is None else pivot
        Mt = Matrix.Translation(piv) @ R.to_4x4() @ Matrix.Translation(-piv) @ M
        self.set_armature(n, Mt)

    def head(self, n) -> Vector:
        return self.M[n].translation.copy()

    def tail(self, n) -> Vector:
        return (self.M[n] @ Vector((0, self.length[n], 0, 1))).to_3d()

    # ---- limbs ------------------------------------------------------------------------------
    def limb_ik(self, upper, lower, target: Vector, pole: Vector):
        self.fk()
        rs_u, rs_l = self.rest[upper], self.rest[lower]
        root = self.unposed(upper).translation.copy()
        l1, l2 = self.length[upper], self.length[lower]
        mid, tgt = two_bone(root, target, l1, l2, pole)
        y_ru = rs_u.col[1].to_3d()
        y_rl = rs_l.col[1].to_3d()
        h_r = y_ru.cross(y_rl)
        y_nu = (mid - root).normalized()
        y_nl = (tgt - mid).normalized()
        h_n = y_nu.cross(y_nl)
        if h_n.length < 1e-5:
            h_n = h_r.copy()
        Ru = frame_rot(y_ru, h_r, y_nu, h_n)
        Rl = frame_rot(y_rl, h_r, y_nl, h_n)
        Mu = Matrix.Translation(root) @ (Ru @ rs_u.to_3x3()).to_4x4()
        self.set_armature(upper, Mu)
        self.fk()
        Ml = Matrix.Translation(mid) @ (Rl @ rs_l.to_3x3()).to_4x4()
        self.set_armature(lower, Ml)
        self.fk()
        return mid, tgt

    def orient(self, n, R: Matrix, at: Vector | None = None):
        """Give bone n the armature-space orientation R @ rest (keeps its FK head position)."""
        self.fk()
        pos = self.unposed(n).translation.copy() if at is None else at
        M = Matrix.Translation(pos) @ (R @ self.rest[n].to_3x3()).to_4x4()
        self.set_armature(n, M)
        self.fk()

    # ---- keying -----------------------------------------------------------------------------
    def key(self, frame: int, prev: dict):
        for n in self.order:
            if n == 'root':
                continue
            pb = self.arm.pose.bones[n]
            loc, q, sc = self.basis[n].decompose()
            if n in prev and prev[n].dot(q) < 0:
                q = -q
            prev[n] = q
            pb.rotation_quaternion = q
            pb.keyframe_insert('rotation_quaternion', frame=frame, group=n)
            if n == 'hips':
                pb.location = loc
                pb.keyframe_insert('location', frame=frame, group=n)
            if n in ('spine_2', 'spine_3', 'neck'):
                pb.scale = sc
                pb.keyframe_insert('scale', frame=frame, group=n)


# ---------------------------------------------------------------------------------------------
# animation authoring
# ---------------------------------------------------------------------------------------------

def smoothstep(a, b, x):
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def wrap(x):
    return x - math.floor(x)


def pulse(phase, at, rise=0.03, hold=0.05, fall=0.12):
    """Periodic sharp twitch: 0..1..0 starting at `at` (phase units)."""
    d = wrap(phase - at)
    if d < rise:
        return smoothstep(0, rise, d)
    if d < rise + hold:
        return 1.0
    if d < rise + hold + fall:
        return 1.0 - smoothstep(rise + hold, rise + hold + fall, d)
    return 0.0


class Gait:
    """Planted-foot gait in the armature frame (creature faces +Y; ground slides toward -Y)."""

    def __init__(self, J, speed, period, duty, lift, stride_offset=0.0, toe_drop=-35.0, stutter=0.0, width=0.0):
        self.v, self.T, self.duty, self.lift = speed, period, duty, lift
        self.width = width
        self.travel = speed * period * duty
        self.offset = stride_offset
        self.toe_drop = toe_drop
        self.stutter = stutter
        self.J = J

    def foot(self, side, phase):
        """Returns (ankle position, foot pitch deg (+ = toes up), toe pitch relative deg)."""
        R = self.J[side]
        wx = Vector((self.width * (1 if side == 'R' else -1), 0, 0))
        A0 = Vector(R['A']) + wx
        ball0 = Vector(R['ball']) + wx
        heel0 = Vector(R['heel']) + wx + Vector((0, 0, -R['heel'][2] + 0.0))
        p = wrap(phase)
        half = self.travel / 2
        if p < self.duty:
            s = p / self.duty
            dy = self.offset + half - self.travel * s
            lift = 0.0
            if s < 0.12:
                pitch = 12.0 * (1 - smoothstep(0.0, 0.12, s))
                pivot = 'heel'
            elif s > 0.62:
                pitch = -28.0 * smoothstep(0.62, 1.0, s)
                pivot = 'ball'
            else:
                pitch, pivot = 0.0, 'ball'
            toe_rel = -pitch if pivot == 'ball' else 0.0
        else:
            u = (p - self.duty) / (1 - self.duty)
            if self.stutter > 0:   # hesitate mid-swing, then snap forward
                g = u + self.stutter * math.sin(2 * math.pi * u) / (2 * math.pi) * -1.0
                g = 0.5 - 0.5 * math.cos(math.pi * min(max(g, 0), 1))
            else:
                g = 0.5 - 0.5 * math.cos(math.pi * u)
            dy = self.offset - half + self.travel * g
            lift = self.lift * math.sin(math.pi * u) ** 0.9
            pitch = -28.0 + (self.toe_drop + 28.0) * smoothstep(0.0, 0.35, u)
            pitch = pitch + (12.0 - self.toe_drop) * smoothstep(0.55, 1.0, u)
            pivot = 'ball'
            toe_rel = -12.0 * math.sin(math.pi * u)
        Rx = Matrix.Rotation(math.radians(pitch), 3, 'X')
        if pivot == 'heel':
            hp = Vector((heel0.x, heel0.y + dy, 0.0 + lift))
            ankle = hp + Rx @ (A0 - Vector((heel0.x, heel0.y, 0.0)))
        else:
            bp = Vector((ball0.x, ball0.y + dy, ball0.z + lift))
            ankle = bp + Rx @ (A0 - ball0)
        # floor guard: the ball and the (curled) toe tips never go below the floor
        tip0 = Vector(R['toe_tip']) + wx
        Rt = Matrix.Rotation(math.radians(pitch + toe_rel), 3, 'X')
        ball = ankle + Rx @ (ball0 - A0)
        tip = ball + Rt @ (tip0 - ball0)
        low = min(ball.z - ball0.z, tip.z - 0.006)
        if low < 0:
            ankle = ankle + Vector((0, 0, -low))
        return ankle, pitch, toe_rel


def _arm_hang(P: Poser, side, s, swing=0.0, out=0.0, fwd=0.0, drop=0.0, elbow=0.0, pole_back=1.0):
    """Arms hanging past the knees: wrist target relative to the shoulder."""
    P.fk()
    S0 = P.unposed('upper_arm_' + side).translation
    L = P.length['upper_arm_' + side] + P.length['forearm_' + side]
    reach = L * (0.985 - 0.10 * elbow)
    d = Vector((s * (0.13 + out), 0.10 + fwd + swing, -1.0 - drop)).normalized()
    tgt = S0 + d * reach
    pole = Vector((s * 0.35, -1.0 * pole_back, -0.1))
    P.limb_ik('upper_arm_' + side, 'forearm_' + side, tgt, pole)


def _fingers(P: Poser, side, curl=0.0, spread=0.0, twitch=None):
    for i, f in enumerate(A.FINGERS):
        c = curl + (twitch[i] if twitch else 0.0)
        base = 1.0 if f != 'thumb' else 0.5
        sp = spread * (-1.5 + i * 0.75) if f != 'thumb' else spread
        P.set_local(f'{f}_1_{side}', q_euler(c * base * 0.8, 0, sp))
        P.set_local(f'{f}_2_{side}', q_euler(c * base * 1.0))
        P.set_local(f'{f}_3_{side}', q_euler(c * base * 0.8))


def _legs(P: Poser, gait: Gait, phase_L, phase_R, knee_out=0.15):
    for side, s, ph in (('L', -1, phase_L), ('R', 1, phase_R)):
        ankle, pitch, toe_rel = gait.foot(side, ph)
        P.limb_ik('thigh_' + side, 'shin_' + side, ankle, Vector((s * knee_out, 1.0, 0.0)))
        Rf = Matrix.Rotation(math.radians(pitch), 3, 'X')
        P.orient('foot_' + side, Rf)
        Rt = Matrix.Rotation(math.radians(pitch + toe_rel), 3, 'X')
        P.orient('toe_' + side, Rt)


def _plant(P: Poser, J, side, s, dy=0.0, dx=0.0, pitch=0.0, knee_out=0.15):
    R = J[side]
    dx = dx * J.get('scale', 1.0)
    ankle = Vector(R['A']) + Vector((dx * s, dy, 0))
    if pitch:
        ball0 = Vector(R['ball'])
        bp = ball0 + Vector((dx * s, dy, 0))
        ankle = bp + Matrix.Rotation(math.radians(pitch), 3, 'X') @ (Vector(R['A']) - ball0)
    P.limb_ik('thigh_' + side, 'shin_' + side, ankle, Vector((s * knee_out, 1.0, 0.0)))
    P.orient('foot_' + side, Matrix.Rotation(math.radians(pitch), 3, 'X'))
    P.orient('toe_' + side, Matrix.Identity(3))


def _hips(P: Poser, dpos=(0, 0, 0), pitch=0.0, yaw=0.0, roll=0.0):
    rest = P.rest['hips']
    R = (Matrix.Rotation(math.radians(yaw), 3, 'Z') @ Matrix.Rotation(math.radians(roll), 3, 'Y')
         @ Matrix.Rotation(math.radians(-pitch), 3, 'X'))     # +pitch = lean forward
    M = Matrix.Translation(rest.translation + Vector(dpos)) @ (R @ rest.to_3x3()).to_4x4()
    P.set_armature('hips', M)
    P.fk()


def _spine(P: Poser, pitch=(0, 0, 0), yaw=(0, 0, 0), roll=(0, 0, 0), breathe=0.0):
    for i, n in enumerate(('spine_1', 'spine_2', 'spine_3')):
        sc = None
        if n == 'spine_2':
            sc = (1 + 0.035 * breathe, 1.0, 1 + 0.045 * breathe)
        elif n == 'spine_3':
            sc = (1 + 0.02 * breathe, 1.0, 1 + 0.03 * breathe)
        P.set_local(n, q_euler(pitch[i], yaw[i], roll[i]), scale=sc)
    P.fk()


def _neck_head(P: Poser, neck=(0, 0, 0), neck2=(0, 0, 0), head=(0, 0, 0)):
    P.set_local('neck', q_euler(*neck))
    P.set_local('neck_2', q_euler(*neck2))
    P.set_local('head', q_euler(*head))
    P.fk()


def _jaw(P: Poser, open_=0.0, drop=0.0):
    P.set_local('jaw', q_euler(drop, 0, 0))
    P.fk()
    for side, s in (('L', -1), ('R', 1)):
        # swing each half outward about the world-up axis through its hinge
        P.rot_armature('jaw_' + side, Matrix.Rotation(math.radians(-s * open_), 3, 'Z') @
                       Matrix.Rotation(math.radians(open_ * 0.25), 3, Vector((0, 1, 0))) if False else
                       Matrix.Rotation(math.radians(-s * open_), 3, 'Z'))


def _ears(P: Poser, L=(0, 0, 0), R=(0, 0, 0)):
    P.set_local('ear_L', q_euler(*L))
    P.set_local('ear_R', q_euler(*R))
    P.fk()


def _shoulders(P: Poser, L=(0, 0, 0), R=(0, 0, 0)):
    P.set_local('shoulder_L', q_euler(*L))
    P.set_local('shoulder_R', q_euler(*R))
    P.fk()


def _hand_world(P: Poser, J, side, fwd: Vector, palm: Vector):
    """Orient the hand in armature space: fingers along `fwd`, palm facing `palm`."""
    R = J[side]
    Rm = frame_rot(Vector(R['ha']), Vector(R['hn']), fwd.normalized(), palm.normalized())
    P.orient('hand_' + side, Rm)


def _lowest_finger(P: Poser, side) -> float:
    P.fk()
    return min(P.tail(f'{f}_{i}_{side}').z for f in A.FINGERS for i in (1, 2, 3))


def _arm_floor(P: Poser, J, side, tgt: Vector, pole: Vector, hand_fn, clearance=0.03):
    """Arm IK to `tgt`, then hand/fingers via hand_fn(); lift the wrist if any finger (claws
    included via `clearance`) would go through the floor."""
    for _ in range(3):
        P.limb_ik('upper_arm_' + side, 'forearm_' + side, tgt, pole)
        hand_fn()
        low = _lowest_finger(P, side) - clearance * J['scale']
        if low >= 0:
            break
        tgt = tgt + Vector((0, 0, -low + 0.002))


def _hand(P: Poser, side, rx=0.0, ry=0.0, rz=0.0):
    P.set_local('hand_' + side, q_euler(rx, ry, rz))
    P.fk()


# ---- individual actions ----------------------------------------------------------------------

def pose_idle(P: Poser, J, t, T=4.0):
    """Hunched, predatory stance: weight on the right leg, head jutting forward and cocked,
    arms dangling in front of the knees, fingers slowly curling; 3 slow breaths per loop."""
    ph = t / T
    w = 2 * math.pi * ph
    P.reset()
    breathe = 0.5 + 0.5 * math.sin(w * 3)
    sway = math.sin(w)
    _hips(P, (0.02 + 0.010 * sway, -0.03, -0.05 + 0.006 * math.sin(w * 2)), pitch=4, roll=-3 + 1.2 * sway,
          yaw=-4 + 2 * math.sin(w + 1))
    _spine(P, pitch=(2, 9 + 1.5 * breathe, 25), yaw=(1, 2 - 1.5 * sway, 3 - 2 * sway), roll=(2, 2 - sway, 2 - sway),
           breathe=breathe)
    tw = pulse(ph, 0.37, 0.012, 0.06, 0.10) - 0.7 * pulse(ph, 0.71, 0.01, 0.03, 0.12)
    _neck_head(P, neck=(16, 4 * math.sin(w + 0.5), -2), neck2=(4, 3, 0),
               head=(-52 + 3 * math.sin(w * 2), 10 * math.sin(w + 0.8) + 4, 3 + 8 * tw + 3 * math.sin(w)))
    _jaw(P, open_=2.5 + 2.5 * math.sin(w * 3 + 1.2))
    et = pulse(ph, 0.52, 0.01, 0.02, 0.06)
    _ears(P, L=(-6 * et, 0, 0), R=(-3 * pulse(ph, 0.22, 0.01, 0.02, 0.06), 0, 0))
    _shoulders(P, L=(8, 0, 6 + 1.5 * breathe), R=(10, 0, -4 - 1.5 * breathe))
    for side, s in (('L', -1), ('R', 1)):
        _arm_hang(P, side, s, swing=0.02 * math.sin(w + (0 if s > 0 else 2)), out=0.02 if s > 0 else 0.05,
                  fwd=0.14 if s > 0 else 0.20, elbow=0.9 if s > 0 else 0.6)
        _hand(P, side, rx=10, ry=s * -14)
        ft = [14 * pulse(ph + i * 0.07 + (0.3 if s > 0 else 0), 0.6, 0.02, 0.05, 0.2) for i in range(5)]
        _fingers(P, side, curl=18 + 8 * math.sin(w * 2 + s), spread=4, twitch=ft)
    _plant(P, J, 'L', -1, dy=0.08, dx=0.03, knee_out=0.25)
    _plant(P, J, 'R', 1, dy=-0.04, dx=0.0, knee_out=0.15)


def pose_walk(P: Poser, J, t, T=1.4):
    """Slow stalking walk at 1.0 m/s: hunched, wide-footed, lurching onto the left leg (a slight
    limp), swing foot hesitating mid-air, arms dangling low and swinging late."""
    ph = t / T
    w = 2 * math.pi * ph
    k = J['scale']
    g = Gait(J, 1.0, T, 0.62, 0.15 * k, stride_offset=0.02 * k, toe_drop=-40, stutter=0.55, width=0.045 * k)
    P.reset()
    # phase 0 = left heel strike, 0.5 = right heel strike; the left strike lands heavier
    strikeL = pulse(ph, 0.0, 0.04, 0.03, 0.18)
    strikeR = pulse(ph, 0.5, 0.04, 0.03, 0.18)
    lurch = strikeL * 1.0 + strikeR * 0.55
    bob = math.cos(w * 2)
    _hips(P, (0.026 * math.sin(w), 0.0, -0.075 - 0.016 * bob - 0.02 * strikeL), pitch=8 + 2 * lurch,
          yaw=4 * math.sin(w), roll=-3 * math.sin(w) - 2.5 * strikeL)
    _spine(P, pitch=(2, 9 + 3 * lurch, 25 + 4 * lurch), yaw=(-2 * math.sin(w), -3 * math.sin(w), -4 * math.sin(w)),
           roll=(2 * math.sin(w), 1.5 * math.sin(w), 0), breathe=0.5 + 0.5 * math.sin(w * 2))
    tw = pulse(ph, 0.30, 0.010, 0.07, 0.10) - pulse(ph, 0.80, 0.010, 0.04, 0.14)
    _neck_head(P, neck=(15 - 6 * lurch, 3 * math.sin(w), 0), neck2=(4, 0, 0),
               head=(-46 + 2.5 * bob + 4 * lurch, -4 * math.sin(w) + 10 * tw, 12 * tw - 6))
    _jaw(P, open_=3.0)
    _ears(P, L=(-5 * pulse(ph, 0.1, 0.01, 0.02, 0.05), 0, 0), R=(-5 * pulse(ph, 0.62, 0.01, 0.02, 0.05), 0, 0))
    _shoulders(P, L=(6, 0, 2 * math.sin(w)), R=(6, 0, 2 * math.sin(w)))
    for side, s in (('L', -1), ('R', 1)):
        sw = math.sin(w + (math.pi if side == 'L' else 0) - 0.8)   # late, loose pendulum
        _arm_hang(P, side, s, swing=0.20 * sw, fwd=0.16, out=0.03, elbow=0.35 + 0.25 * max(0, sw))
        _hand(P, side, rx=6 + 12 * max(0, -sw), ry=s * -10)
        _fingers(P, side, curl=18 + 10 * sw, spread=4)
    _legs(P, g, ph, ph + 0.5, knee_out=0.30)


def pose_run(P: Poser, J, t, T=22 / 30):
    """Four-limbed loping chase at 3.1 m/s: body thrown forward and low, head up and thrust out,
    long bounding strides; the arms swing low in alternation, knuckles and claws brushing just
    above the floor, elbows splayed like a spider's."""
    ph = t / T
    w = 2 * math.pi * ph
    k = J['scale']
    g = Gait(J, 3.1, T, 0.36, 0.20 * k, stride_offset=0.06 * k, toe_drop=-45, width=0.05 * k)
    P.reset()
    bob = math.cos(w * 2)
    _hips(P, (0.015 * math.sin(w), 0.03 * k, -0.20 * k + 0.03 * bob), pitch=34, yaw=6 * math.sin(w), roll=-4 * math.sin(w))
    _spine(P, pitch=(10, 14, 14 + 4 * bob), yaw=(-4 * math.sin(w), -5 * math.sin(w), -6 * math.sin(w)),
           roll=(2 * math.sin(w), 0, 0), breathe=0.5 + 0.5 * bob)
    _neck_head(P, neck=(-10 - 3 * bob, 0, 0), neck2=(-8, 0, 0), head=(-34 + 4 * bob, 3 * math.sin(w), 0))
    _jaw(P, open_=9 + 6 * bob)
    _ears(P, L=(20, 0, 0), R=(20, 0, 0))
    _shoulders(P, L=(8, 0, 0), R=(8, 0, 0))
    for side, s in (('L', -1), ('R', 1)):
        pa = 2 * math.pi * (ph + (0.5 if side == 'L' else 0.0) + 0.08)
        front = 0.5 + 0.5 * math.cos(pa)                       # 1 = hand fully forward (lowest)
        tgt = Vector((s * 0.30 * k, (0.12 + 0.62 * front) * k, (0.40 - 0.24 * front + 0.05 * max(0.0, math.sin(pa))) * k))
        c = 30 + 22 * front

        def hand_fn(side=side, s=s, front=front, c=c):
            _hand_world(P, J, side, Vector((s * 0.15, 0.55 + 0.35 * front, -1.0)), Vector((0, -1.0, 0.25)))
            for i, f in enumerate(A.FINGERS):                   # claws curled under, knuckles leading
                P.set_local(f'{f}_1_{side}', q_euler(c * 0.6, 0, (i - 2) * 3 * s))
                P.set_local(f'{f}_2_{side}', q_euler(c))
                P.set_local(f'{f}_3_{side}', q_euler(c * 0.7))
        _arm_floor(P, J, side, tgt, Vector((s * 0.9, -0.3, 0.6)), hand_fn, clearance=0.012)
    _legs(P, g, ph, ph + 0.5, knee_out=0.30)


def pose_listen(P: Poser, J, t, T=4.0):
    """Frozen, half-reared up, head cocked and turning slowly side to side, ears twitching,
    the split jaw slightly parted, a faint tremor."""
    ph = t / T
    w = 2 * math.pi * ph
    P.reset()
    tremor = 0.3 * math.sin(w * 23) + 0.2 * math.sin(w * 37)
    _hips(P, (0.0, -0.02, -0.06), pitch=2)
    _spine(P, pitch=(0, 4, 14), yaw=(0, 0, 5 * math.sin(w)), breathe=0.2 + 0.1 * math.sin(w * 2))
    turn = math.sin(w)
    cock = 22 * math.sin(w + 0.35)
    _neck_head(P, neck=(12, 10 * turn, 0), neck2=(2, 8 * turn, 0),
               head=(-30 + tremor, 18 * turn, cock + tremor))
    _jaw(P, open_=7 + 1.5 * math.sin(w * 5))
    eL = 10 * pulse(ph, 0.15, 0.01, 0.02, 0.05) + 8 * pulse(ph, 0.55, 0.01, 0.03, 0.06) + 6 * pulse(ph, 0.83, 0.01, 0.02, 0.04)
    eR = 9 * pulse(ph, 0.32, 0.01, 0.02, 0.05) + 10 * pulse(ph, 0.66, 0.01, 0.03, 0.06) + 6 * pulse(ph, 0.95, 0.01, 0.02, 0.04)
    _ears(P, L=(-12 - eL, 0, 4 * turn), R=(-12 - eR, 0, 4 * turn))
    _shoulders(P, L=(4, 0, -3), R=(4, 0, 3))
    for side, s in (('L', -1), ('R', 1)):
        _arm_hang(P, side, s, out=0.08, fwd=0.14, elbow=0.9)
        _hand(P, side, rx=-8, ry=s * -15)
        _fingers(P, side, curl=6 + tremor, spread=12)
    _plant(P, J, 'L', -1, dy=0.05 * J['scale'], dx=0.03, knee_out=0.25)
    _plant(P, J, 'R', 1, dy=-0.04 * J['scale'], dx=0.03, knee_out=0.25)


def pose_attack(P: Poser, J, t, T=1.2):
    """One-shot: rear up and spread the arms (0-0.3 s), lunge at head height with the jaws split
    wide (0.3-0.55 s), claws clamp and pull the prey in (0.55-0.8 s), settle back to Idle."""
    P.reset()
    k = J['scale']
    a = smoothstep(0.0, 0.30, t) * (1 - smoothstep(0.30, 0.46, t))     # rear up / wind-up
    l = smoothstep(0.28, 0.50, t) * (1 - smoothstep(0.85, 1.2, t))     # lunge
    gch = smoothstep(0.48, 0.60, t) * (1 - smoothstep(0.95, 1.2, t))   # claws closed
    rec = smoothstep(0.85, 1.2, t)
    idle = 1 - max(a, l)
    _hips(P, (0.0, (-0.05 * a + 0.34 * l) * k, (-0.05 + 0.02 * a - 0.10 * l) * k), pitch=4 * idle - 8 * a + 16 * l)
    _spine(P, pitch=(2 * idle + 2 * l, 9 * idle + 2 * a + 7 * l, 25 * idle + 6 * a + 12 * l), breathe=0.5 + 0.5 * a)
    _neck_head(P, neck=(16 * idle + 4 * a + 10 * l, 0, 0), neck2=(4 * idle, 0, 0),
               head=(-50 * idle - 26 * a - 34 * l, 0, 7 * idle))
    _jaw(P, open_=3 + 14 * a + 26 * l - 14 * gch * (1 - rec), drop=5 * l)
    _ears(P, L=(-22 * a + 14 * l, 0, 0), R=(-22 * a + 14 * l, 0, 0))
    _shoulders(P, L=(0, 0, -10 * a), R=(0, 0, 10 * a))
    for side, s in (('L', -1), ('R', 1)):
        P.fk()
        S0 = P.unposed('upper_arm_' + side).translation
        reach = P.length['upper_arm_' + side] + P.length['forearm_' + side]
        d_hang = Vector((s * 0.13, 0.25, -1.0)).normalized()
        d_wide = Vector((s * 0.80, 0.10, 0.65)).normalized()
        d_grab = Vector((s * 0.30, 1.0, 0.05)).normalized()
        d_pull = Vector((s * 0.12, 1.0, -0.12)).normalized()
        d = d_hang.lerp(d_wide, a)
        d = d.lerp(d_grab, l * (1 - gch * 0.7))
        d = d.lerp(d_pull, gch * (1 - rec))
        d = d.lerp(d_hang, rec * 0.7)
        r = reach * (0.97 - 0.18 * a - 0.30 * gch * (1 - rec))
        pole = Vector((s * 0.6, -0.9, -0.3)).lerp(Vector((s * 1.0, -0.5, 0.4)), l).lerp(Vector((s * 0.35, -1.0, -0.1)), idle)
        P.limb_ik('upper_arm_' + side, 'forearm_' + side, S0 + d.normalized() * r, pole)
        _hand(P, side, rx=-20 * l + 25 * gch, ry=s * -15)
        _fingers(P, side, curl=12 - 14 * (a + l) * (1 - gch) + 60 * gch * (1 - rec * 0.7), spread=16 * max(a, l) * (1 - gch))
    _plant(P, J, 'L', -1, dy=(0.12 * l - 0.03 * a) * k, dx=0.03)
    _plant(P, J, 'R', 1, dy=(-0.14 * l - 0.03 * a) * k, dx=0.03, pitch=-20 * l)


def pose_feed(P: Poser, J, t, T=2.4):
    """Crouched low over the floor on splayed knees, hands pinning the prey, head jerking and
    tearing at irregular beats."""
    ph = t / T
    w = 2 * math.pi * ph
    k = J['scale']
    P.reset()
    tear = pulse(ph, 0.10, 0.03, 0.04, 0.10) + pulse(ph, 0.42, 0.02, 0.03, 0.12) + 0.8 * pulse(ph, 0.70, 0.02, 0.06, 0.09)
    chew = math.sin(w * 6)
    _hips(P, (0.0, 0.05 * k, -0.43 * k), pitch=38 + 3 * tear)
    _spine(P, pitch=(14, 16, 18 - 6 * tear), yaw=(0, 3 * math.sin(w), 6 * tear), breathe=0.5 + 0.5 * math.sin(w * 2))
    _neck_head(P, neck=(30 - 18 * tear, 6 * tear, 0), neck2=(18 - 12 * tear, 0, 0),
               head=(-10 - 20 * tear, 16 * tear - 4 * math.sin(w), 12 * tear))
    _jaw(P, open_=6 + 10 * max(0, chew) + 12 * tear)
    _ears(P, L=(8, 0, 0), R=(8, 0, 0))
    for side, s in (('L', -1), ('R', 1)):
        P.fk()
        tgt = Vector((s * 0.26, 0.50 + 0.03 * s, 0.050 + 0.012 * max(0, math.sin(w * 2 + s)))) * k
        c = 10 * tear * (1 if s > 0 else 0.5)

        def hand_fn(side=side, s=s, c=c):
            _hand_world(P, J, side, Vector((s * 0.35, 1.0, 0.10)), Vector((0, 0.1, -1)))
            for i, f in enumerate(A.FINGERS):     # spider-arched fingers: knuckles up, claw tips down
                P.set_local(f'{f}_1_{side}', q_euler(-18 + c * 0.3, 0, (i - 2) * 4 * s))
                P.set_local(f'{f}_2_{side}', q_euler(30 + c))
                P.set_local(f'{f}_3_{side}', q_euler(26 + c))
        _arm_floor(P, J, side, tgt, Vector((s * 1.0, -0.2, 0.8)), hand_fn, clearance=0.006)
    _plant(P, J, 'L', -1, dy=0.02 * k, dx=0.06, knee_out=0.5)
    _plant(P, J, 'R', 1, dy=-0.06 * k, dx=0.06, knee_out=0.5, pitch=-10)


ACTIONS = [
    ('Idle', pose_idle, 4.0, True),
    ('Walk', pose_walk, 1.4, True),
    ('Run', pose_run, 22 / 30, True),
    ('Listen', pose_listen, 4.0, True),
    ('Attack', pose_attack, 1.2, False),
    ('Feed', pose_feed, 2.4, True),
]


def make_actions(arm: bpy.types.Object, J, step: int = 1) -> dict:
    scene = bpy.context.scene
    scene.render.fps = FPS
    P = Poser(arm)
    if arm.animation_data is None:
        arm.animation_data_create()
    made = {}
    for name, fn, T, loop in ACTIONS:
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        arm.animation_data.action = act
        n = int(round(T * FPS))
        prev: dict = {}
        frames = list(range(0, n + 1, step))
        if frames[-1] != n:
            frames.append(n)
        for f in frames:
            tt = f / FPS
            if loop and f == n:
                tt = 0.0                      # exact seamless loop: last key == first key
            fn(P, J, tt, T) if name != 'Attack' else fn(P, J, tt, T)
            P.key(f, prev)
        act.use_frame_range = True
        act.frame_start, act.frame_end = 0, n
        try:
            act.use_cyclic = loop
        except Exception:
            pass
        track = arm.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 0, act)
        track.mute = True
        made[name] = act
        arm.animation_data.action = None
    return made


def bind_rigid(kera: bpy.types.Object, roots, skin_mesh: bpy.types.Object, arm: bpy.types.Object) -> None:
    """Teeth and nails: every piece copies (rigidly) the weights of the skin vertex nearest to
    its root, so it moves exactly with the gum / fingertip it grows from."""
    from mathutils import kdtree
    me = skin_mesh.data
    t = kdtree.KDTree(len(me.vertices))
    for v in me.vertices:
        t.insert(skin_mesh.matrix_world @ v.co, v.index)
    t.balance()
    gname = {g.index: g.name for g in skin_mesh.vertex_groups}
    for b in arm.data.bones:
        if b.use_deform and b.name not in kera.vertex_groups:
            kera.vertex_groups.new(name=b.name)
    for verts, root in roots:
        # average a few nearest skin vertices (smoother than a single one)
        acc: dict = {}
        near = t.find_n(Vector(tuple(root)), 4)
        for co, idx, d in near:
            for g in me.vertices[idx].groups:
                acc[gname[g.group]] = acc.get(gname[g.group], 0.0) + g.weight / len(near)
        top = sorted(acc.items(), key=lambda kv: -kv[1])[:4]
        tot = sum(w for _, w in top) or 1.0
        for name, w in top:
            kera.vertex_groups[name].add(list(verts), w / tot, 'REPLACE')


# ---- stress poses (previews only): what the procedural IK will do to the mesh ----------------

def _stress_crawl(P: Poser, J):
    """On all fours under a low gap: torso level, palms planted ahead, knees deep, head up."""
    k = J['scale']
    P.reset()
    _hips(P, (0.0, 0.10 * k, -0.52 * k), pitch=62)
    _spine(P, pitch=(10, 10, 4))
    _neck_head(P, neck=(-28, 0, 0), neck2=(-18, 0, 0), head=(-22, 0, 0))
    _jaw(P, open_=6)
    _shoulders(P, L=(14, 0, 0), R=(14, 0, 0))
    for side, s in (('L', -1), ('R', 1)):
        tgt = Vector((s * 0.30, 0.95, 0.06)) * k

        def hand_fn(side=side, s=s):
            _hand_world(P, J, side, Vector((s * 0.25, 1.0, -0.05)), Vector((0, 0, -1)))
            _fingers(P, side, curl=14, spread=8)
        _arm_floor(P, J, side, tgt, Vector((s * 1.0, -0.4, 0.3)), hand_fn, clearance=0.004)
    _plant(P, J, 'L', -1, dy=-0.12 * k, dx=0.06, knee_out=0.35, pitch=-25)
    _plant(P, J, 'R', 1, dy=-0.12 * k, dx=0.06, knee_out=0.35, pitch=-25)


def _stress_crouch(P: Poser, J):
    """Deepest crouch: pelvis near the heels, knees splayed, torso folded over the thighs."""
    k = J['scale']
    P.reset()
    _hips(P, (0.0, -0.10 * k, -0.78 * k), pitch=28)
    _spine(P, pitch=(18, 16, 12))
    _neck_head(P, neck=(-6, 0, 0), neck2=(-6, 0, 0), head=(-30, 0, 0))
    for side, s in (('L', -1), ('R', 1)):
        tgt = Vector((s * 0.16, 0.42, 0.05)) * k

        def hand_fn(side=side, s=s):
            _hand_world(P, J, side, Vector((s * 0.1, 1.0, -0.4)), Vector((0, 0.2, -1)))
            _fingers(P, side, curl=25, spread=6)
        _arm_floor(P, J, side, tgt, Vector((s * 1.0, 0.0, 0.2)), hand_fn, clearance=0.004)
    _plant(P, J, 'L', -1, dy=0.0, dx=0.10, knee_out=0.7, pitch=-12)
    _plant(P, J, 'R', 1, dy=0.0, dx=0.10, knee_out=0.7, pitch=-12)


def _stress_reach(P: Poser, J):
    """Left arm straight up over the head, right arm straight forward at shoulder height."""
    k = J['scale']
    P.reset()
    _hips(P, (0, 0, -0.02 * k), pitch=-2)
    _spine(P, pitch=(-2, -4, -6))
    _neck_head(P, neck=(6, 0, 0), neck2=(2, 0, 0), head=(-40, 0, 0))
    _shoulders(P, L=(-6, 0, -18), R=(-4, 0, 6))
    P.fk()
    for side, s, d, pole in (('L', -1, Vector((-0.10, 0.12, 1.0)), Vector((-0.6, -0.6, 0.0))),
                             ('R', 1, Vector((0.08, 1.0, 0.06)), Vector((0.5, 0.0, -1.0)))):
        S0 = P.unposed('upper_arm_' + side).translation
        reach = P.length['upper_arm_' + side] + P.length['forearm_' + side]
        P.limb_ik('upper_arm_' + side, 'forearm_' + side, S0 + d.normalized() * reach * 0.985, pole)
        _hand(P, side, rx=-10)
        _fingers(P, side, curl=-6, spread=18)
    _plant(P, J, 'L', -1, dy=0.04 * k, dx=0.03)
    _plant(P, J, 'R', 1, dy=-0.04 * k, dx=0.03)


def _stress_grip(P: Poser, J):
    """Gripping a door frame: right arm up and out at head height, fist closed and the wrist
    twisted 75 degrees; left elbow folded shut (hand at the shoulder), wrist twisted the other way."""
    k = J['scale']
    P.reset()
    _hips(P, (0.0, 0.0, -0.10 * k), pitch=10, yaw=-8)
    _spine(P, pitch=(4, 8, 14), yaw=(-4, -6, -8))
    _neck_head(P, neck=(10, -10, 0), neck2=(4, -6, 0), head=(-44, 0, 6))
    _shoulders(P, L=(4, 0, 4), R=(-8, 0, -14))
    P.fk()
    S0 = P.unposed('upper_arm_R').translation
    reach = P.length['upper_arm_R'] + P.length['forearm_R']
    P.limb_ik('upper_arm_R', 'forearm_R', S0 + Vector((0.70, 0.45, 0.55)).normalized() * reach * 0.88,
              Vector((0.3, -0.6, -1.0)))
    _hand(P, 'R', rx=-20, ry=75)
    _fingers(P, 'R', curl=78, spread=0)
    S1 = P.unposed('upper_arm_L').translation
    P.limb_ik('upper_arm_L', 'forearm_L', S1 + Vector((0.10, 0.30, -0.08)) * k, Vector((-0.4, 0.2, -1.0)))
    _hand(P, 'L', rx=30, ry=70)
    _fingers(P, 'L', curl=40, spread=10)
    _plant(P, J, 'L', -1, dy=0.10 * k, dx=0.06, knee_out=0.3)
    _plant(P, J, 'R', 1, dy=-0.10 * k, dx=0.04, knee_out=0.3, pitch=-15)


STRESS = {'crawl': _stress_crawl, 'crouch': _stress_crouch, 'reach': _stress_reach, 'grip': _stress_grip}
# (tag, yaw, pitch, focus bone or None for the whole body, half-size of the close-up in m)
STRESS_VIEWS = [('crawl', 55, 12, None, 0), ('crawl_back', 160, 35, 'spine_3', 0.42),
                ('crouch', 35, 8, None, 0), ('crouch_knee', 75, 5, 'shin_R', 0.24),
                ('reach', 40, 4, None, 0), ('reach_armpit', -55, 5, 'upper_arm_L', 0.30),
                ('grip', -30, 6, None, 0), ('grip_hand', 55, 10, 'hand_R', 0.17), ('grip_elbow', -60, 0, 'forearm_L', 0.22)]


def apply_stress(arm: bpy.types.Object, J, tag: str):
    P = Poser(arm)
    STRESS[tag.split('_')[0]](P, J)
    _apply(arm, P)
    return P


def _apply(arm, P):
    for n in P.order:
        if n == 'root':
            continue
        pb = arm.pose.bones[n]
        loc, q, sc = P.basis[n].decompose()
        pb.rotation_quaternion = q
        pb.location = loc if n == 'hips' else Vector((0, 0, 0))
        pb.scale = sc
    bpy.context.view_layer.update()


def apply_pose(arm: bpy.types.Object, J, name: str, t: float):
    """Pose the armature directly (for previews) without actions."""
    P = Poser(arm)
    for nm, fn, T, loop in ACTIONS:
        if nm == name:
            fn(P, J, t, T)
            break
    for n in P.order:
        if n == 'root':
            continue
        pb = arm.pose.bones[n]
        loc, q, sc = P.basis[n].decompose()
        pb.rotation_quaternion = q
        if n == 'hips':
            pb.location = loc
        pb.scale = sc
    bpy.context.view_layer.update()
    return P
