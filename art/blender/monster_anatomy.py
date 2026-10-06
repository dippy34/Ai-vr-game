"""
Anatomy of "the Listener" (MUTE's monster): skeleton joints + the signed-distance sculpt.

Everything is in Blender coordinates, meters, bind pose: Z up, the creature faces +Y, its right
side is +X (bones *_R), left is -X (*_L). Origin between the feet on the floor.

The bind pose is a hunched A-pose (arms ~45 degrees down) so skin weights separate cleanly; the
animations bring the arms down so they hang past the knees.

Helper module (not an asset): build() is a no-op.
"""

from __future__ import annotations

import math

import numpy as np

import monster_sdf as S
from monster_sdf import Ellipsoid, Group, RoundCone, Sphere, Func, frame_from, normalize, rot, v3, smoothstep

F = np.float32


def build() -> None:
    print('[monster_anatomy] helper module, nothing to build')


MIRROR = np.diag([-1.0, 1.0, 1.0])

# body-part labels (used for skin-weight cleanup and texture masks)
LABEL_NAMES = ['torso', 'pelvis', 'neck', 'head', 'jaw_L', 'jaw_R', 'ear_L', 'ear_R']
for _suf in ('_L', '_R'):
    LABEL_NAMES += [n + _suf for n in ('clav', 'upper_arm', 'forearm', 'hand', 'thumb', 'index', 'middle',
                                       'ring', 'pinky', 'thigh', 'shin', 'foot')]
LAB = {n: i for i, n in enumerate(LABEL_NAMES)}

FINGERS = ('thumb', 'index', 'middle', 'ring', 'pinky')


def bend(d, toward, ang):
    d = normalize(d)
    t = np.asarray(toward, float)
    t = t - d * np.dot(t, d)
    if np.linalg.norm(t) < 1e-9:
        return d
    t = normalize(t)
    return normalize(d * math.cos(ang) + t * math.sin(ang))


def toward(a, b, ang):
    """Rotate unit vector a toward b by `ang` radians (in their common plane)."""
    return bend(a, b, ang)


# ---------------------------------------------------------------------------------------------
# skeleton
# ---------------------------------------------------------------------------------------------

def _right_side() -> dict:
    R = {}
    S_ = v3(0.200, 0.035, 1.765)                       # shoulder (gleno-humeral) joint
    R['clav_in'] = v3(0.028, 0.06, 1.795)               # shoulder bone head (near the neck)
    R['S'] = S_
    d_up = normalize(v3(0.69, 0.14, -0.71))
    E = S_ + 0.50 * d_up
    d_fo = normalize(d_up + v3(0.0, 0.24, 0.05))
    W = E + 0.46 * d_fo
    R['E'], R['W'] = E, W
    R['d_up'], R['d_fo'] = d_up, d_fo
    a = d_fo
    n0 = v3(-0.72, 0.0, -0.69)
    n = normalize(n0 - a * np.dot(n0, a))               # palm normal (out of the palm)
    b = normalize(np.cross(a, n))                       # toward the thumb (forward)
    R['ha'], R['hn'], R['hb'] = a, n, b
    # elbow "back" (olecranon side): perpendicular to arm, away from the bend direction
    bend_dir = normalize(d_fo - d_up * np.dot(d_fo, d_up))
    R['elbow_back'] = -bend_dir

    # fingers: (b offset, spread deg (toward thumb +), lengths, radii at joints, curl deg per joint)
    fingers = {
        'index': (0.029, 9.0, (0.088, 0.064, 0.050), (0.0092, 0.0084, 0.0072, 0.0050), (6, 10, 9)),
        'middle': (0.0095, 2.0, (0.098, 0.070, 0.054), (0.0096, 0.0086, 0.0074, 0.0052), (7, 11, 9)),
        'ring': (-0.0095, -6.0, (0.091, 0.066, 0.050), (0.0090, 0.0081, 0.0070, 0.0049), (8, 12, 10)),
        'pinky': (-0.028, -14.0, (0.073, 0.052, 0.042), (0.0080, 0.0072, 0.0062, 0.0045), (10, 13, 11)),
    }
    for f, (off, spread, lens, rads, curls) in fingers.items():
        k = W + a * 0.122 + b * off - n * 0.003
        d = toward(a, b, math.radians(spread)) if spread >= 0 else toward(a, -b, math.radians(-spread))
        pts = [k]
        dirs = []
        for i, L in enumerate(lens):
            d = bend(d, n, math.radians(curls[i]))
            dirs.append(d)
            pts.append(pts[-1] + d * L)
        R[f'{f}_pts'] = pts
        R[f'{f}_rad'] = rads
        R[f'{f}_dirs'] = dirs
    # thumb
    k = W + a * 0.030 + b * 0.026 + n * 0.010
    d = normalize(a * 0.62 + b * 0.66 + n * 0.42)
    pts = [k]
    dirs = []
    for L, c in zip((0.054, 0.044, 0.036), (0, 10, 12)):
        d = bend(d, n - b * 0.3, math.radians(c))
        dirs.append(d)
        pts.append(pts[-1] + d * L)
    R['thumb_pts'] = pts
    R['thumb_rad'] = (0.0115, 0.0095, 0.0080, 0.0056)
    R['thumb_dirs'] = dirs

    # leg
    H = v3(0.098, -0.012, 1.085)
    K = v3(0.116, 0.072, 0.585)
    A = v3(0.124, -0.036, 0.108)
    R['H'], R['K'], R['A'] = H, K, A
    toe_out = rot((0, 0, 1), math.radians(-8.0))         # rotate foot vectors outward (+X)
    R['foot_fwd'] = toe_out @ v3(0, 1, 0)
    R['heel'] = A + toe_out @ v3(0, -0.048, -0.075)
    R['ball'] = A + toe_out @ v3(0.004, 0.170, -0.080)
    R['toe_tip'] = A + toe_out @ v3(0.008, 0.270, -0.096)
    toes = {}
    for i, (off, L, r, spread) in enumerate(((0.030, 0.080, 0.0105, 7), (0.010, 0.088, 0.0098, 2),
                                             (-0.010, 0.078, 0.0092, -3), (-0.028, 0.064, 0.0085, -9))):
        base = A + toe_out @ v3(off, 0.165, -0.078)
        d = toe_out @ normalize(v3(math.sin(math.radians(spread)), 1.0, -0.12))
        p1 = base + d * L * 0.55
        d2 = normalize(d + v3(0, 0, -0.35))
        p2 = p1 + d2 * L * 0.45
        toes[i] = (base, p1, p2, r, d2)
    R['toes'] = toes
    return R


def _mirror(obj):
    if isinstance(obj, np.ndarray) and obj.shape == (3,):
        return MIRROR @ obj
    if isinstance(obj, (list, tuple)):
        out = [_mirror(o) for o in obj]
        return type(obj)(out) if isinstance(obj, tuple) else out
    if isinstance(obj, dict):
        return {k: _mirror(v) for k, v in obj.items()}
    return obj


def skeleton() -> dict:
    J = {
        'pelvis': v3(0, -0.02, 1.10),
        'L5': v3(0, -0.045, 1.235),
        'T12': v3(0, -0.068, 1.445),
        'T6': v3(0, -0.058, 1.655),
        'C7': v3(0, 0.010, 1.845),
        'C3': v3(0, 0.118, 1.975),
        'atlas': v3(0, 0.205, 2.058),
        'head_tip': v3(0, 0.225, 2.275),
        'jaw_hinge': v3(0, 0.285, 2.085),
        'jaw_tip': v3(0, 0.352, 2.010),
    }
    Rt = _right_side()
    J['R'] = Rt
    J['L'] = _mirror(Rt)
    # ears: base, direction (along ear), normal (concave side), length, half-width
    for side, s in (('R', 1.0), ('L', -1.0)):
        base = v3(0.060 * s, 0.226, 2.170)
        u = normalize(v3(0.70 * s, -0.44, 0.58))
        nrm = v3(0.40 * s, 0.90, 0.06)
        nrm = normalize(nrm - u * np.dot(nrm, u))
        J[side]['ear'] = (base, u, nrm)
    return J


def spine_curve(J, n=64):
    """Catmull-Rom through the spine joints, pelvis -> atlas. Returns points (n,3)."""
    ctrl = [J['pelvis'] + v3(0, 0.01, -0.12), J['pelvis'], J['L5'], J['T12'], J['T6'], J['C7'], J['C3'], J['atlas'],
            J['atlas'] + v3(0, 0.08, 0.06)]
    pts = []
    for i in range(1, len(ctrl) - 2):
        p0, p1, p2, p3 = ctrl[i - 1], ctrl[i], ctrl[i + 1], ctrl[i + 2]
        for t in np.linspace(0, 1, n // (len(ctrl) - 3), endpoint=False):
            t2, t3 = t * t, t * t * t
            pts.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    pts.append(ctrl[-2])
    return np.array(pts)


# ---------------------------------------------------------------------------------------------
# sculpt
# ---------------------------------------------------------------------------------------------

def _ear_prim(base, u, nrm, side_s, L=0.205, Wmax=0.080, seed=0.0, notches=(), holes=()):
    """Big ragged bat-like ear membrane (cupped, thick cartilage rim, bites and tears).
    Returns (Func prim, axes, ridge point lists)."""
    e_u = normalize(u)
    e_w = normalize(nrm)
    e_v = normalize(np.cross(e_w, e_u))
    M = np.stack([e_u, e_v, e_w], 1).astype(F)
    base = np.asarray(base, float)
    base32 = base.astype(F)

    def prof(t):
        t = np.clip(t, 0, 1)
        return (0.5 + 0.5 * smoothstep(0.0, 0.32, t)) * np.power(1 - t, 0.8) / 0.75

    def vc(t):
        return -0.018 * np.clip(t, 0, 1) ** 2 + 0.008 * np.sin(np.pi * np.clip(t, 0, 1))

    def w0(t, rel):
        return 0.022 * rel * rel * np.clip(t * 3, 0, 1) * (1 - 0.45 * t) - 0.008 * t * t

    TH = 0.0042

    def fn(p):
        q = (p - base32) @ M
        qu, qv, qw = q[:, 0], q[:, 1], q[:, 2]
        t = qu / L
        W = Wmax * prof(t)
        c = vc(t)
        d_edge = (np.abs(qv - c) - W) * 0.8
        d_edge = np.maximum(d_edge, -qu)
        ragged = smoothstep(0.12, 0.4, t)
        nz = S.fbm(np.stack([qu * 22, qv * 22, np.full_like(qu, seed)], 1), 2, seed=seed)
        nz2 = S.perlin(np.stack([qu * 70, qv * 70, np.full_like(qu, seed + 5)], 1))
        d_edge = d_edge + (0.0030 * nz + 0.0012 * nz2) * ragged
        for (nt, nside, ra, rb) in notches:   # bites / tears out of the rim (ellipses, rb deep)
            cu = nt * L
            cv = float(vc(np.array([nt]))[0]) + nside * Wmax * float(prof(np.array([nt]))[0])
            dn = np.sqrt(((qu - cu) / ra) ** 2 + ((qv - cv) / rb) ** 2) - 1.0
            d_edge = np.maximum(d_edge, -dn * min(ra, rb))
        rel = np.clip((qv - c) / np.maximum(W, 1e-3), -1.3, 1.3)
        th = TH + 0.0040 * smoothstep(-0.008, 0.0, d_edge) + 0.016 * np.power(np.clip(1 - t * 3.2, 0, 1), 2)
        d_w = (np.abs(qw - w0(t, rel)) - th * 0.5) * 0.8
        d = smax(d_edge, d_w, 0.0015)
        for (ht, hv, hr) in holes:
            cu = ht * L
            cv = float(vc(np.array([ht]))[0]) + hv * Wmax * float(prof(np.array([ht]))[0])
            dh = np.sqrt((qu - cu) ** 2 + (qv - cv) ** 2) - hr
            d = smax(d, -dh, 0.001)
        return d

    ext = np.array([L + 0.02, Wmax + 0.03, 0.05])
    corners = np.array([[a, b, c] for a in (-0.02, ext[0]) for b in (-ext[1], ext[1]) for c in (-ext[2], ext[2])])
    w = corners @ M.T.astype(np.float64) + base
    # cartilage folds lying on the inner (+w) surface
    ridges = []
    for (rv0, rv1, t0, t1) in ((0.10, 0.35, 0.10, 0.72), (-0.30, -0.45, 0.12, 0.55), (0.55, 0.62, 0.15, 0.45)):
        ts = np.linspace(t0, t1, 6)
        rel = np.linspace(rv0, rv1, 6)
        W = Wmax * prof(ts)
        qv = vc(ts) + rel * W
        qw = w0(ts, rel) + (TH + 0.016 * np.power(np.clip(1 - ts * 3.2, 0, 1), 2)) * 0.5 - 0.0005
        pts = [base + e_u * (tt * L) + e_v * vv + e_w * ww for tt, vv, ww in zip(ts, qv, qw)]
        ridges.append(pts)
    return Func(fn, w.min(0), w.max(0)), (e_u, e_v, e_w), ridges


def smax(a, b, k):
    return S.smax(a, b, k)


def body(J, detail: bool = True) -> tuple[Group, dict]:
    """The whole creature as an SDF group. Returns (group, info) where info holds feature
    positions used later for texture masks (ear holes, mouth, etc.).

    Principle: build a continuous skin ENVELOPE per region first, then push bones / tendons /
    knobs through it by a controlled few millimeters (features are projected onto the actual
    envelope surface), so it reads as skin stretched over bone, not an X-ray skeleton."""
    info: dict = {}
    sp = spine_curve(J, 96)
    info['spine'] = sp
    B = Group(LAB['torso'])

    def on(grp, pts, r, prot):
        """Centers for features of radius r that stick out `prot` above grp's surface."""
        P, N = S.project(grp, pts)
        return [P[i] - N[i] * (r - prot) for i in range(len(P))], N

    # ======================= ENVELOPES =======================================================
    core = Group(LAB['torso'])
    rc_c = v3(0, 0.022, 1.578)
    rc_up = normalize(v3(0, 0.12, 0.40))
    fwd = normalize(v3(0, 1, 0) - rc_up * np.dot(v3(0, 1, 0), rc_up))
    Rrc = np.stack([np.cross(fwd, rc_up), fwd, rc_up], 1)
    rc_r = v3(0.146, 0.106, 0.212)
    core.union(Ellipsoid(rc_c, rc_r, Rrc))
    core.union(Ellipsoid(v3(0, 0.002, 1.752), v3(0.160, 0.078, 0.066)), k=0.04)            # shoulder girdle
    core.union(Ellipsoid(v3(0, -0.024, 1.338), v3(0.098, 0.064, 0.125)), k=0.05)            # sunken abdomen
    core.union(Ellipsoid(v3(0, -0.030, 1.138), v3(0.120, 0.080, 0.086)), k=0.05, label=LAB['pelvis'])
    for s_ in (1, -1):
        core.union(Ellipsoid(v3(0.058 * s_, -0.080, 1.050), v3(0.056, 0.042, 0.066)), k=0.035, label=LAB['pelvis'])
        # erector columns (wasted) along the lower back
        pts = [sp[i] + v3(0.026 * s_, -0.030, 0) for i in range(8, 50, 6)]
        core.union(S.tube(pts, [0.017] * len(pts), k=0.01), k=0.03)
    # neck
    n0, n1 = v3(0, 0.030, 1.795), J['atlas'] + v3(0, 0.012, -0.004)
    core.union(RoundCone(n0, n1, 0.050, 0.039), k=0.045, label=LAB['neck'])
    # shoulder caps (deltoids, wasted)
    for side in ('R', 'L'):
        Rs = J[side]
        core.union(Ellipsoid(Rs['S'] + Rs['d_up'] * 0.035 + v3(0, 0, 0.010), v3(0.040, 0.046, 0.046),
                             frame_from(Rs['d_up'], v3(0, 0, 1))), k=0.03, label=LAB['clav_' + side])
    B.union(core)

    # ======================= TORSO FEATURES ==================================================
    feat = Group(LAB['torso'])
    # ribs: loops on the ribcage ellipsoid, projected onto the real envelope
    nrib = 11
    for i in range(nrib):
        f = i / (nrib - 1)
        z0 = 0.170 - f * 0.300
        drop = 0.050 + 0.045 * math.sin(f * math.pi * 0.8)
        if i <= 6:
            th_end = math.pi - 0.15
        elif i <= 9:
            th_end = 2.45 - (i - 7) * 0.25
        else:
            th_end = 1.60
        th0 = 0.55
        raw, rads, prots = [], [], []
        nseg = 12
        for j in range(nseg + 1):
            th = th0 + (th_end - th0) * j / nseg
            s_ = min(th / 2.25, 1.0)
            z = z0 - drop * math.sin(s_ * math.pi * 0.5) ** 1.4
            if th > 2.25 and i <= 6:
                z += (th - 2.25) / (th_end - 2.25 + 1e-6) * (0.020 + 0.035 * f)
            if 7 <= i <= 9 and th > 1.7:
                z += (th - 1.7) * 0.06
            zz = np.clip(z / rc_r[2], -0.97, 0.97)
            ring = math.sqrt(1 - zz * zz)
            loc = v3(rc_r[0] * ring * math.sin(th), -rc_r[1] * ring * math.cos(th), z)
            raw.append(rc_c + Rrc @ loc)
            r = 0.0068 if th < 2.25 else 0.0050
            vis = smoothstep(0.6, 1.2, th) * (0.55 + 0.45 * smoothstep(0, 3, i))   # covered near spine / top
            prots.append(0.0012 + 0.0040 * vis)
            rads.append(r)
        for s_ in (1, -1):
            P0 = [MIRROR @ p if s_ < 0 else p for p in raw]
            Pp, N = S.project(core, P0)
            C = [Pp[k] - N[k] * (rads[k] - prots[k]) for k in range(len(Pp))]
            feat.union(S.tube(C, rads, k=0.003), k=0.002)
    # sternum + xiphoid
    st = [rc_c + Rrc @ v3(0, 0.09, z) for z in np.linspace(0.17, -0.03, 6)]
    C, _ = on(core, st, 0.012, 0.003)
    feat.union(S.tube(C, [0.013, 0.012, 0.012, 0.011, 0.010, 0.008]), k=0.004)
    info['sternum'] = (C[0], C[-1])
    # costal margin (inverted V under the chest)
    for s_ in (1, -1):
        cm = [rc_c + Rrc @ v3(0.012 * s_, 0.098, -0.04), rc_c + Rrc @ v3(0.05 * s_, 0.092, -0.085),
              rc_c + Rrc @ v3(0.095 * s_, 0.070, -0.125), rc_c + Rrc @ v3(0.128 * s_, 0.030, -0.14)]
        C, _ = on(core, cm, 0.008, 0.005)
        feat.union(S.tube(C, [0.007, 0.008, 0.008, 0.007]), k=0.003)
    # spine knobs (spinous processes), placed on the actual back surface
    nk = 26
    for i in range(nk):
        t = 0.05 + 0.86 * i / (nk - 1)
        idx = int(t * (len(sp) - 1))
        p = sp[idx]
        tan = normalize(sp[min(idx + 1, len(sp) - 1)] - sp[max(idx - 1, 0)])
        back = normalize(np.cross(tan, v3(1, 0, 0)))
        if back[1] > 0:
            back = -back
        hump = math.exp(-((t - 0.70) / 0.12) ** 2)
        r = 0.0085 + 0.0050 * hump
        surf, nrm = S.raycast(core, p, back, 0.2)
        c = surf - back * r * (0.45 - 0.2 * hump)
        feat.union(Ellipsoid(c, v3(r * 1.25, r * 0.95, r * 1.35), frame_from(tan, back)), k=0.005)
    # scapulae (winged), clavicles
    for side, s_ in (('R', 1), ('L', -1)):
        Rs = J[side]
        surf, nrm = S.raycast(core, v3(0.092 * s_, 0.0, 1.690), v3(0.25 * s_, -1, 0.05), 0.25)
        up = normalize(v3(-0.22 * s_, 0.12, 1.0))
        Rsc = frame_from(nrm, up)
        feat.union(Ellipsoid(surf + nrm * 0.001, v3(0.050, 0.0065, 0.070), Rsc), k=0.022)
        tang = normalize(np.cross(nrm, up)) * s_   # points medial->lateral?
        lat = normalize(Rsc[:, 0]) * (1 if np.dot(Rsc[:, 0], v3(s_, 0, 0)) > 0 else -1)
        med_top = surf - lat * 0.042 + Rsc[:, 2] * 0.058
        med_bot = surf - lat * 0.030 + Rsc[:, 2] * -0.066
        C, _ = on(core, [med_top, (med_top + med_bot) / 2, med_bot], 0.0075, 0.0085)
        feat.union(S.tube(C, [0.0070, 0.0078, 0.0068]), k=0.008)         # winged medial border
        acr = Rs['S'] + v3(-0.012 * s_, -0.030, 0.034)
        spn = [surf - lat * 0.036 + Rsc[:, 2] * 0.030, surf + lat * 0.01 + Rsc[:, 2] * 0.040, acr]
        C, _ = on(core, spn, 0.0068, 0.0050)
        feat.union(S.tube(C, [0.0060, 0.0072, 0.0095]), k=0.006)
        C, _ = on(core, [surf - lat * 0.020 + Rsc[:, 2] * -0.072], 0.008, 0.006)
        feat.union(Sphere(C[0], 0.008), k=0.01)                             # inferior angle
        cl = [v3(0.020 * s_, 0.112, 1.756), v3(0.080 * s_, 0.112, 1.782), v3(0.140 * s_, 0.080, 1.796),
              Rs['S'] + v3(-0.020 * s_, 0.010, 0.036)]
        C, _ = on(core, cl, 0.0085, 0.0080)
        feat.union(S.tube(C, [0.0090, 0.0078, 0.0078, 0.0100]), k=0.004)
        info['clav_' + side] = C
        # iliac crest + ASIS
        cr = [v3(0.050 * s_, -0.096, 1.200), v3(0.110 * s_, -0.072, 1.195), v3(0.132 * s_, -0.020, 1.178),
              v3(0.118 * s_, 0.040, 1.150), v3(0.094 * s_, 0.070, 1.122)]
        C, _ = on(core, cr, 0.010, 0.0065)
        feat.union(S.tube(C, [0.009, 0.010, 0.011, 0.011, 0.011]), k=0.004)
        C, _ = on(core, [v3(0.094 * s_, 0.078, 1.115)], 0.014, 0.008)
        feat.union(Sphere(C[0], 0.014), k=0.008)
        # trochanter
        C, _ = on(core, [Rs['H'] + v3(0.055 * s_, -0.008, -0.045)], 0.022, 0.010)
        feat.union(Sphere(C[0], 0.022), k=0.02, label=LAB['thigh_' + side])
        # abdominal sinew
        ab = [v3(0.022 * s_, 0.06, 1.42), v3(0.020 * s_, 0.05, 1.33), v3(0.016 * s_, 0.05, 1.24)]
        C, _ = on(core, ab, 0.007, 0.0025)
        feat.union(S.tube(C, [0.006, 0.007, 0.006]), k=0.006)
    # neck: tendons + throat
    for s_ in (1, -1):
        scm = [v3(0.050 * s_, 0.205, 2.098) * (1 - t) + v3(0.017 * s_, 0.113, 1.757) * t for t in np.linspace(0, 1, 6)]
        C, _ = on(core, scm, 0.0095, 0.0065)
        feat.union(S.tube(C, [0.0105, 0.0105, 0.0100, 0.0095, 0.0090, 0.0085]), k=0.006, label=LAB['neck'])
    tr = [v3(0, 0.118, 1.770) * (1 - t) + v3(0, 0.250, 1.995) * t for t in np.linspace(0, 1, 7)]
    C, _ = on(core, tr, 0.0095, 0.0045)
    feat.union(S.tube(C, [0.0095] * 7), k=0.006, label=LAB['neck'])
    C, _ = on(core, [v3(0, 0.200, 1.915)], 0.013, 0.008)
    feat.union(Sphere(C[0], 0.013), k=0.008, label=LAB['neck'])        # larynx
    B.union(feat, k=0.0)
    # hollows (after features)
    for s_ in (1, -1):
        B.sub(Ellipsoid(v3(0.072 * s_, 0.092, 1.818), v3(0.030, 0.016, 0.014)), k=0.016)  # supraclavicular
        B.sub(Ellipsoid(v3(0.040 * s_, 0.130, 1.80), v3(0.012, 0.012, 0.03)), k=0.012)     # beside the throat

    # ======================= HEAD ============================================================
    hd = Group(LAB['head'])
    Rhead = rot((1, 0, 0), math.radians(-16))
    hd.union(Ellipsoid(v3(0, 0.232, 2.178), v3(0.069, 0.112, 0.097), Rhead))
    hd.union(Ellipsoid(v3(0, 0.166, 2.205), v3(0.060, 0.072, 0.072), Rhead), k=0.03)    # stretched occiput
    hd.union(Ellipsoid(v3(0, 0.310, 2.118), v3(0.054, 0.052, 0.062)), k=0.03)          # midface
    hd.union(Ellipsoid(v3(0, 0.320, 2.045), v3(0.035, 0.041, 0.058), rot((1, 0, 0), math.radians(-8))), k=0.028)
    hd.union(Sphere(v3(0, 0.328, 1.994), 0.017), k=0.022)                              # chin
    for s_ in (1, -1):
        hd.union(Ellipsoid(v3(0.040 * s_, 0.268, 2.060), v3(0.016, 0.052, 0.028),
                           rot((1, 0, 0), math.radians(35))), k=0.03)                   # jaw sides
    hfeat = Group(LAB['head'])
    for s_ in (1, -1):
        br = [v3(0.0, 0.40, 2.166), v3(0.028 * s_, 0.40, 2.172), v3(0.052 * s_, 0.38, 2.178)]
        C, _ = on(hd, br, 0.0095, 0.0055)
        hfeat.union(S.tube(C, [0.0085, 0.0095, 0.0085]), k=0.006)                      # brow ridge
        C, _ = on(hd, [v3(0.052 * s_, 0.36, 2.113)], 0.014, 0.0055)
        hfeat.union(Ellipsoid(C[0], v3(0.014, 0.022, 0.010)), k=0.012)                 # cheekbone
        za = [v3(0.058 * s_, 0.33, 2.115), v3(0.067 * s_, 0.29, 2.122), v3(0.069 * s_, 0.255, 2.128)]
        C, _ = on(hd, za, 0.0065, 0.004)
        hfeat.union(S.tube(C, [0.0065, 0.006, 0.0055]), k=0.006)                      # zygomatic arch
        jl = [v3(0.050 * s_, 0.24, 2.075), v3(0.044 * s_, 0.28, 2.035), v3(0.030 * s_, 0.315, 2.0), v3(0.012 * s_, 0.33, 1.988)]
        C, _ = on(hd, jl, 0.008, 0.0035)
        hfeat.union(S.tube(C, [0.008, 0.0085, 0.008, 0.007]), k=0.008)               # jaw edge
        C, _ = on(hd, [v3(0.050 * s_, 0.205, 2.105)], 0.012, 0.006)
        hfeat.union(Sphere(C[0], 0.012), k=0.01)                                      # mastoid
        gr = [v3(0.0098 * s_, 0.40, z) for z in np.linspace(1.998, 2.092, 5)]
        P = []
        for g_ in gr:
            sp_, n_ = S.raycast(hd, g_ * v3(1, 0, 1) + v3(0, 0.30, 0), v3(0, 1, 0), 0.12)
            P.append(sp_ - n_ * (0.0048 - 0.003))
        hfeat.union(S.tube(P, [0.0042, 0.0050, 0.0052, 0.0050, 0.0042]), k=0.005)    # gum ridges
    hd.union(hfeat, k=0.0)
    for s_ in (1, -1):
        hd.sub(Ellipsoid(v3(0.030 * s_, 0.364, 2.140), v3(0.024, 0.020, 0.019)), k=0.013)   # sockets
        hd.sub(Ellipsoid(v3(0.049 * s_, 0.330, 2.072), v3(0.017, 0.030, 0.022)), k=0.016)   # hollow cheeks
        hd.sub(Ellipsoid(v3(0.072 * s_, 0.292, 2.172), v3(0.011, 0.032, 0.030)), k=0.018)   # temples
        hd.sub(RoundCone(v3(0.0055 * s_, 0.366, 2.098), v3(0.0085 * s_, 0.360, 2.116), 0.0030, 0.0026), k=0.002)  # nostril slits
    hd.sub(Ellipsoid(v3(0, 0.366, 2.045), v3(0.0042, 0.024, 0.050)), k=0.0015)     # mouth slit
    hd.sub(Ellipsoid(v3(0, 0.336, 2.045), v3(0.0140, 0.024, 0.044)), k=0.005)      # mouth cavity
    info['mouth'] = (v3(0, 0.36, 2.045), 0.050)
    # skull ear-holes: craters projected onto the real skull surface
    rng = np.random.RandomState(11)
    cand = []
    cc = v3(0, 0.215, 2.19)
    tries = 0
    while len(cand) < 34 and tries < 6000:
        tries += 1
        d = normalize(rng.normal(size=3))
        if d[2] < 0.0 or d[1] > 0.62:
            continue
        p = cc + d * 0.12
        pp, nn = S.project(hd, [p])
        pp = pp[0]
        if pp[2] < 2.13 or pp[1] > 0.31:
            continue
        if any(np.linalg.norm(pp - J[s2]['ear'][0]) < 0.045 for s2 in ('L', 'R')):
            continue
        if any(np.linalg.norm(pp - q) < 0.020 for q, _, _ in cand):
            continue
        r = 0.0030 + 0.0028 * rng.rand()
        cand.append((pp, nn[0], r))
    for p, nrm, r in cand:
        hd.union(Sphere(p - nrm * r * 0.6, r * 1.75), k=0.005)
    for p, nrm, r in cand:
        hd.sub(Sphere(p + nrm * r * 0.25, r), k=0.0012)
    info['holes'] = cand
    B.union(hd, k=0.022)

    # ======================= EARS ============================================================
    ear_info = {}
    for side, s_, seed, notches, eholes in (
        ('R', 1.0, 0.0, ((0.50, 1.0, 0.014, 0.016), (0.74, -1.0, 0.005, 0.022), (0.30, -1.0, 0.009, 0.009),
                          (0.88, 1.0, 0.006, 0.007)), ((0.58, 0.15, 0.0060),)),
        ('L', -1.0, 3.7, ((0.40, -1.0, 0.016, 0.018), (0.62, 1.0, 0.005, 0.026), (0.83, -1.0, 0.008, 0.008)),
         ((0.36, -0.30, 0.0045), (0.70, 0.25, 0.004))),
    ):
        base, u, nrm = J[side]['ear']
        prim, axes, ridges = _ear_prim(base, u, nrm, s_, seed=seed, notches=notches, holes=eholes)
        eg = Group(LAB['ear_' + side])
        eg.union(prim)
        for rp in ridges:
            eg.union(S.tube(rp, list(np.linspace(0.0032, 0.0016, len(rp)))), k=0.003)
        B.union(eg, k=0.014)
        ear_info[side] = (base, axes)
        B.sub(Sphere(base + v3(0.008 * s_, 0.010, -0.010), 0.0085), k=0.004)   # ear canal
    info['ears'] = ear_info

    # ======================= ARMS + HANDS ====================================================
    for side, s_ in (('R', 1), ('L', -1)):
        R_ = J[side]
        Sx, E, W = R_['S'], R_['E'], R_['W']
        a, n, b = R_['ha'], R_['hn'], R_['hb']
        eb = R_['elbow_back']
        ua = Group(LAB['upper_arm_' + side])
        ua.union(RoundCone(Sx, E, 0.036, 0.027))
        ua.union(Ellipsoid(Sx + R_['d_up'] * 0.25 + eb * 0.012, v3(0.025, 0.14, 0.024), frame_from(R_['d_up'], eb)), k=0.02)
        ua.union(Ellipsoid(Sx + R_['d_up'] * 0.30 - eb * 0.010, v3(0.022, 0.11, 0.020), frame_from(R_['d_up'], -eb)), k=0.02)
        B.union(ua, k=0.03)
        fa = Group(LAB['forearm_' + side])
        fa.union(RoundCone(E, W, 0.025, 0.0155))
        fa.union(Ellipsoid(E + R_['d_fo'] * 0.10 + b * 0.010 - n * 0.004, v3(0.024, 0.11, 0.019),
                           frame_from(R_['d_fo'], -n)), k=0.02)   # brachioradialis
        fa.union(Ellipsoid(E + R_['d_fo'] * 0.24, v3(0.022, 0.20, 0.0135), frame_from(R_['d_fo'], -n)), k=0.02)  # flatten
        ffeat = Group(LAB['forearm_' + side])
        lat = normalize(np.cross(R_['d_up'], eb))
        C, _ = on(fa, [E + eb * 0.02], 0.022, 0.012)
        ffeat.union(Sphere(C[0], 0.022))                             # olecranon
        C, _ = on(fa, [E + lat * 0.03, E - lat * 0.03], 0.014, 0.007)
        ffeat.union(Sphere(C[0], 0.014), k=0.006)
        ffeat.union(Sphere(C[1], 0.015), k=0.006)
        ul = [E + eb * 0.02 + (W - E) * t for t in np.linspace(0.1, 0.95, 5)]
        C, _ = on(fa, ul, 0.006, 0.0025)
        ffeat.union(S.tube(C, [0.006] * 5), k=0.006)                 # ulna ridge
        C, _ = on(fa, [W + b * 0.02, W - b * 0.02 - n * 0.003], 0.010, 0.0055)
        ffeat.union(Sphere(C[0], 0.010), k=0.005)                    # styloids
        ffeat.union(Sphere(C[1], 0.010), k=0.005)
        for off in (-0.006, 0.006):                                  # wrist tendons (palm side)
            tn = [E + (W - E) * t + b * off + n * 0.01 for t in np.linspace(0.6, 1.0, 4)]
            C, _ = on(fa, tn, 0.003, 0.0018)
            ffeat.union(S.tube(C, [0.0028] * 4), k=0.003)
        fa.union(ffeat, k=0.0)
        B.union(fa, k=0.016)
        hand = Group(LAB['hand_' + side])
        hand.union(Ellipsoid(W + a * 0.064 - n * 0.001, v3(0.034, 0.066, 0.0118), np.stack([b, a, -n], 1)))
        hand.union(Ellipsoid(W + a * 0.035 - b * 0.022 + n * 0.004, v3(0.014, 0.03, 0.010), np.stack([b, a, -n], 1)), k=0.01)
        hfe = Group(LAB['hand_' + side])
        for f in ('index', 'middle', 'ring', 'pinky'):
            k0 = R_[f + '_pts'][0]
            mc = [W + a * 0.02 + (k0 - W - a * 0.122) * 0.3 - n * 0.006, (W + k0) / 2 - n * 0.008, k0 - n * 0.006]
            C, _ = on(hand, mc, 0.0045, 0.0030)
            hfe.union(S.tube(C, [0.0040, 0.0048, 0.0058]), k=0.004)  # metacarpal tendons
            hfe.union(Sphere(k0 - n * 0.0035, 0.0112), k=0.004)        # knuckle
        hand.union(hfe, k=0.0)
        B.union(hand, k=0.013)
        for f in FINGERS:
            pts = R_[f + '_pts']
            rads = R_[f + '_rad']
            fg = Group(LAB[f + '_' + side])
            for i in range(3):
                fg.union(RoundCone(pts[i], pts[i + 1], rads[i] * 0.93, rads[i + 1] * 1.0), k=0.003)
                if i > 0:
                    fg.union(Sphere(pts[i] - n * 0.0016, rads[i] * 1.22), k=0.004)
            fg.union(Sphere(pts[3] - R_[f + '_dirs'][2] * 0.002, rads[3] * 1.08), k=0.003)
            B.union(fg, k=0.008 if f != 'thumb' else 0.014)

    # ======================= LEGS + FEET =====================================================
    for side, s_ in (('R', 1), ('L', -1)):
        R_ = J[side]
        H, K, A = R_['H'], R_['K'], R_['A']
        leg_d = normalize(K - H)
        lf = normalize(v3(0, 1, 0) - leg_d * np.dot(v3(0, 1, 0), leg_d))
        th = Group(LAB['thigh_' + side])
        th.union(RoundCone(H + v3(0.006 * s_, 0, 0.03), K + v3(0, 0, 0.045), 0.064, 0.040))
        th.union(Ellipsoid((H + K) / 2 + lf * 0.016 + v3(0.010 * s_, 0, 0.03), v3(0.042, 0.19, 0.038), frame_from(leg_d, lf)), k=0.035)
        th.union(Ellipsoid((H + K) / 2 - lf * 0.022 + v3(-0.004 * s_, 0, 0.05), v3(0.040, 0.17, 0.034), frame_from(leg_d, lf)), k=0.035)
        B.union(th, k=0.035)
        sh = Group(LAB['shin_' + side])
        shin_d = normalize(A - K)
        sf = normalize(v3(0, 1, 0) - shin_d * np.dot(v3(0, 1, 0), shin_d))
        sh.union(RoundCone(K - shin_d * 0.04, A - shin_d * 0.02, 0.030, 0.019))
        sh.union(Ellipsoid(K - shin_d * 0.15 - sf * 0.024, v3(0.034, 0.11, 0.030), frame_from(shin_d, sf)), k=0.03)  # calf
        sh.union(RoundCone(K - shin_d * 0.25 - sf * 0.026, R_['heel'] + v3(0, 0.004, 0.030), 0.012, 0.0085), k=0.014)  # achilles
        kn = Group(LAB['shin_' + side])
        kn.union(Ellipsoid(K + lf * 0.036, v3(0.025, 0.016, 0.031), frame_from(lf, v3(0, 0, 1))))   # patella
        kn.union(Sphere(K + v3(0.030 * s_, 0.0, 0.022), 0.031), k=0.01)
        kn.union(Sphere(K + v3(-0.030 * s_, -0.004, 0.022), 0.032), k=0.01)
        kn.union(Sphere(K + v3(0.027 * s_, 0.006, -0.034), 0.026), k=0.012)
        kn.union(Sphere(K + v3(-0.027 * s_, 0.004, -0.034), 0.026), k=0.012)
        kn.union(Sphere(K + sf * 0.026 - shin_d * 0.075, 0.011), k=0.012)    # tibial tuberosity
        sh.union(kn, k=0.012)
        tc = [K - shin_d * t + sf * 0.03 for t in np.linspace(0.09, 0.42, 6)]
        C, _ = on(sh, tc, 0.0075, 0.0035)
        sh.union(S.tube(C, [0.0075, 0.0075, 0.007, 0.0065, 0.006, 0.0055]), k=0.006)   # tibial crest
        B.union(sh, k=0.025)
        ft = Group(LAB['foot_' + side])
        ffwd = R_['foot_fwd']
        mid = (R_['heel'] + R_['ball']) * 0.5 + v3(0, 0, 0.012)
        ft.union(Ellipsoid(mid, v3(0.036, 0.108, 0.025), frame_from(ffwd, v3(0, 0, 1))))
        ft.union(Sphere(R_['heel'] + v3(0, 0, 0.004), 0.033), k=0.012)
        ft.union(Sphere(A, 0.023), k=0.014)
        ffe = Group(LAB['foot_' + side])
        C, _ = on(ft, [A + v3(0.026 * s_, -0.008, -0.008), A + v3(-0.026 * s_, 0.004, 0.004)], 0.016, 0.009)
        ffe.union(Sphere(C[0], 0.016))
        ffe.union(Sphere(C[1], 0.016), k=0.004)                        # malleoli
        for i, (base, p1, p2, r, d2) in R_['toes'].items():
            mt = [A + (base - A) * t + v3(0, 0, 0.012 * (1 - t)) for t in (0.35, 0.65, 0.95)]
            C, _ = on(ft, mt, 0.005, 0.003)
            ffe.union(S.tube(C, [0.0045, 0.005, 0.006]), k=0.004)       # metatarsal tendons
        ft.union(ffe, k=0.0)
        for i, (base, p1, p2, r, d2) in R_['toes'].items():
            ft.union(Sphere(base + v3(0, 0, 0.003), r * 1.15), k=0.008)
            ft.union(RoundCone(base, p1, r, r * 0.88), k=0.003)
            ft.union(Sphere(p1 + v3(0, 0, 0.002), r * 1.04), k=0.003)
            ft.union(RoundCone(p1, p2, r * 0.85, r * 0.62), k=0.003)
        ft.inter(Func(lambda p: (0.0 - p[:, 2]).astype(F), v3(-2, -2, -1), v3(2, 2, 3)), k=0.004)   # flat sole
        B.union(ft, k=0.018)

    # ======================= SKIN ============================================================
    if detail:
        def skin(p):
            return (0.0010 * S.perlin(p * 24.0) + 0.0004 * S.perlin(p * 67.0 + 3.1)).astype(F)
        B.displace(skin, v3(-2, -2, -0.1), v3(2, 2, 3), band=0.004)
    B.inter(Func(lambda p: (-0.0005 - p[:, 2]).astype(F), v3(-2, -2, -1), v3(2, 2, 3)), k=0.0)
    return B, info


def bounds(J):
    return v3(-1.25, -0.40, -0.01), v3(1.25, 0.55, 2.36)
