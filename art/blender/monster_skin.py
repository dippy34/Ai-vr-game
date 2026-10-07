"""
Skin of the Listener (helper for monster.py; build() is a no-op).

  * masks(): per-vertex masks on the high-res sculpt (design units), computed in numpy from the
    body-part labels and the feature positions the sculpt reports (mouth, gums, lips, sores,
    scars, eyelid seams, webbing, ear struts...). They become color attributes on the sculpt.
  * skin_material(): the procedural skin shader that reads them (Cycles; baked down to the game
    textures): mottling, bruises, necrotic extremities, directional veins and capillaries,
    pores, crepe, joint wrinkle rings, stretch marks, cracked dry knees/elbows/knuckles, scars,
    weeping sores, wet gums and mouth, oily vs dry roughness.
  * shader_masks(): the per-vertex masks the engine's skin shader reads (glTF COLOR_0):
    R thinness, G wetness, B cavity/AO, A = 1 (see monster.py).

Joint wrinkles, stretch marks and veins need a direction on the surface: every vertex gets the
arclength coordinate `wcrd` along its limb chain (shoulder -> elbow -> wrist -> palm, finger
roots -> tips, hip -> knee -> ankle -> toes, pelvis -> spine -> neck; radial distance on the
ears), the chain's tangent `wax`, and the wrinkle spacing `wlam`; rings around a limb are lines
of constant `wcrd`.
"""

from __future__ import annotations

import math

import bpy
import numpy as np

import monster_anatomy as A
import monster_sdf as S


def build() -> None:
    print('[monster_skin] helper module, nothing to build')


def vertex_normals(V, Q) -> np.ndarray:
    a, b, c, d = V[Q[:, 0]], V[Q[:, 1]], V[Q[:, 2]], V[Q[:, 3]]
    fn = np.cross(c - a, d - b)
    N = np.zeros_like(V)
    for k in range(4):
        for ax in range(3):
            N[:, ax] += np.bincount(Q[:, k], weights=fn[:, ax], minlength=len(V))
    return N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)


def graph_smooth_scalar(E, nv, x, iters):
    deg = np.bincount(E.ravel(), minlength=nv).astype(np.float64)
    for _ in range(iters):
        s = np.bincount(E[:, 0], weights=x[E[:, 1]], minlength=nv) + np.bincount(E[:, 1], weights=x[E[:, 0]], minlength=nv)
        x = 0.5 * x + 0.5 * s / np.maximum(deg, 1)
    return x


def graph_smooth_pos(E, nv, V, iters):
    out = V.copy()
    for ax in range(3):
        out[:, ax] = graph_smooth_scalar(E, nv, V[:, ax], iters)
    return out


def ss(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def dist_polyline(P, pts) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Distance from each point to a polyline; also arclength and unit tangent at the closest point."""
    pts = np.asarray(pts, float)
    seg = pts[1:] - pts[:-1]
    L = np.linalg.norm(seg, axis=1)
    cum = np.concatenate([[0], np.cumsum(L)])
    best = np.full(len(P), 1e9)
    arc = np.zeros(len(P))
    tan = np.zeros((len(P), 3))
    for i in range(len(seg)):
        t = np.clip(((P - pts[i]) @ seg[i]) / max(L[i] ** 2, 1e-12), 0, 1)
        d = np.linalg.norm(P - (pts[i] + t[:, None] * seg[i]), axis=1)
        m = d < best
        best[m] = d[m]
        arc[m] = cum[i] + t[m] * L[i]
        tan[m] = seg[i] / max(L[i], 1e-12)
    return best, arc, tan


# ---------------------------------------------------------------------------------------------
# masks (per sculpt vertex, design units)
# ---------------------------------------------------------------------------------------------

def masks(V, Q, labels, J, info) -> dict:
    nv = len(V)
    E = np.concatenate([Q[:, [0, 1]], Q[:, [1, 2]], Q[:, [2, 3]], Q[:, [3, 0]]])
    E = np.unique(np.sort(E, 1), axis=0)
    N = vertex_normals(V, Q)
    Vs = graph_smooth_pos(E, nv, V, 5)
    cav_s = ((Vs - V) * N).sum(1) / 0.0012          # + concave / - convex (fine)
    Vl = graph_smooth_pos(E, nv, V, 28)
    cav_l = ((Vl - V) * N).sum(1) / 0.005           # (broad)
    lab = np.array(A.LABEL_NAMES)[labels]
    x, y, z = V[:, 0], V[:, 1], V[:, 2]
    V32 = V.astype(np.float32)
    head = np.isin(labels, [A.LAB['head'], A.LAB['jaw_L'], A.LAB['jaw_R']]).astype(float)
    ear = np.isin(labels, [A.LAB['ear_L'], A.LAB['ear_R']]).astype(float)
    rng = np.random.RandomState(3)

    # ---- mouth: slit + cavity + throat (dark), gums, lips --------------------------------
    slit = S.Ellipsoid(*A.MOUTH_SLIT).eval(V32)
    cav = S.Ellipsoid(*A.MOUTH_CAV).eval(V32)
    throat = S.Ellipsoid(S.v3(0, 0.292, 2.012), S.v3(0.0105, 0.016, 0.024)).eval(V32)
    dm = np.minimum(np.minimum(slit, cav), throat)
    inner = (1 - ss(0.0005, 0.0050, dm)) * head                      # inside the mouth
    deep = (1 - ss(-0.002, 0.003, np.minimum(cav, throat) + 0.004 * ss(0.30, 0.34, y))) * head
    gum = np.zeros(nv)
    for c, r in info['gums']:
        d = np.linalg.norm(V - c, axis=1) - r
        gum = np.maximum(gum, 1 - ss(0.0, 0.0030, d))
    gum *= head
    lip = np.zeros(nv)
    for side, pts in info['lips'].items():
        d, _, _ = dist_polyline(V, pts)
        lip = np.maximum(lip, 1 - ss(0.0025, 0.0060, d))
    lip *= head
    dark = np.maximum(deep * 0.95, 0.0)
    for p, nrm, r in info['holes']:                                     # skull ear-pits
        d = np.linalg.norm(V - (p + nrm * r * 0.25), axis=1) - r
        dark = np.maximum(dark, 1 - ss(0.0, 0.0022, d))
    for side, s_ in (('L', -1), ('R', 1)):                              # ear canals
        base = J[side]['ear'][0]
        d = np.linalg.norm(V - (base + S.v3(0.010 * s_, 0.012, -0.012)), axis=1) - 0.0085
        dark = np.maximum(dark, 1 - ss(0.0, 0.004, d))
    nost = np.zeros(nv)
    for (na, nb_) in A.NOSTRILS:
        rc = S.RoundCone(na, nb_, 0.0030, 0.0026).eval(V32)
        dark = np.maximum(dark, 1 - ss(0.0, 0.002, rc))
        nost = np.maximum(nost, 1 - ss(0.0, 0.0045, rc))

    # ---- sockets, sealed eyelid seams, seepage ------------------------------------------
    sock = np.zeros(nv)
    for (sc_, sr_) in A.SOCKETS:
        d = S.Ellipsoid(sc_, sr_).eval(V32)
        sock = np.maximum(sock, (1 - ss(-0.004, 0.012, d)) * head)
    seam = np.zeros(nv)
    seep = np.zeros(nv)
    for side, pts in info['eyeseam'].items():
        d, _, _ = dist_polyline(V, pts)
        seam = np.maximum(seam, 1 - ss(0.0005, 0.0016, d))
        lo = pts[len(pts) // 2]
        for k_, (dx, ln) in enumerate(((-0.006, 0.040), (0.004, 0.058), (0.011, 0.028))):   # tear tracks
            sx = lo[0] + dx * (1 if lo[0] > 0 else -1)
            wob = 0.0022 * np.sin((lo[2] - z) * 140 + k_ * 2.1) + 0.0012 * np.sin((lo[2] - z) * 390 + k_)
            across = np.abs(x - sx - wob)
            down = lo[2] - z
            wid = 0.0016 + 0.0016 * ss(0.0, ln, down)
            tr = (1 - ss(wid * 0.5, wid * 1.6, across)) * ss(-0.004, 0.006, down) * (1 - ss(ln * 0.5, ln, down))
            seep = np.maximum(seep, tr * (y > 0.30) * head)
    seam *= head

    # ---- ears: membrane (thin), struts, root ---------------------------------------------
    strut = np.zeros(nv)
    for side, sts in info['struts'].items():
        for pts in sts:
            d, _, _ = dist_polyline(V, pts)
            strut = np.maximum(strut, 1 - ss(0.0030, 0.0065, d))
    root = np.zeros(nv)
    for side in ('L', 'R'):
        base, u, nrm = J[side]['ear']
        along = (V - base) @ S.normalize(u)
        root = np.maximum(root, (lab == f'ear_{side}') * (1 - ss(0.02, 0.06, along)))
    membrane = graph_smooth_scalar(E, nv, ear, 3) * (1 - 0.45 * strut) * (1 - 0.7 * root)

    # ---- hands/feet: extremities, webbing, nail beds, pads -----------------------------
    ext = np.zeros(nv)
    nailb = np.zeros(nv)
    for side in ('L', 'R'):
        R_ = J[side]
        for f in A.FINGERS:
            pts = R_[f + '_pts']
            k0, tip = pts[0], pts[3]
            ax = tip - k0
            t = np.clip(((V - k0) @ ax) / np.dot(ax, ax), 0, 1)
            sel = (lab == f'{f}_{side}') | (lab == f'hand_{side}')
            ext = np.maximum(ext, sel * (0.30 + 0.65 * ss(0.0, 0.85, t)))
        ext = np.maximum(ext, (lab == f'hand_{side}') * 0.35)
        for (base, p1, p2, r, d2) in R_['toes'].values():
            t = np.clip(((V - base) @ (p2 - base)) / np.dot(p2 - base, p2 - base), 0, 1)
            dd = np.linalg.norm(V - (base + np.outer(t, p2 - base)), axis=1)
            ext = np.maximum(ext, (lab == f'foot_{side}') * (dd < r * 2.2) * ss(-0.2, 1.0, t))
        ext = np.maximum(ext, (lab == f'foot_{side}') * (0.35 + 0.4 * ss(0.06, 0.0, z)))
    for nl in info['nails']:
        d, _, _ = dist_polyline(V, [nl['root'], nl['end']])
        nailb = np.maximum(nailb, 1 - ss(nl['w'] * 0.45, nl['w'] * 0.75, d))
    web = np.zeros(nv)
    for c, r in info['web']:
        web = np.maximum(web, 1 - ss(r * 0.55, r * 1.05, np.linalg.norm(V - c, axis=1)))
    tips = np.zeros(nv)
    for side in ('L', 'R'):
        for f in A.FINGERS:
            tips = np.maximum(tips, 1 - ss(0.004, 0.012, np.linalg.norm(V - J[side][f + '_pts'][3], axis=1)))

    # ---- dry, cracked skin: knees, elbows, knuckles, heels, soles -------------------------
    dry = np.zeros(nv)
    for side in ('L', 'R'):
        R_ = J[side]
        for jnt, rad, val in ((R_['K'] + S.v3(0, 0.035, 0.005), 0.045, 1.0), (R_['E'] + R_['elbow_back'] * 0.02, 0.036, 1.0),
                              (R_['heel'], 0.040, 0.9), (R_['A'] + S.v3(0, 0.02, 0.0), 0.030, 0.5)):
            dry = np.maximum(dry, val * (1 - ss(rad * 0.4, rad, np.linalg.norm(V - jnt, axis=1))))
        dorsal = ss(0.0, 0.5, -(N @ R_['hn']))
        for f in ('index', 'middle', 'ring', 'pinky'):
            for i in (0, 1, 2):
                dry = np.maximum(dry, 0.85 * dorsal * (1 - ss(0.006, 0.016, np.linalg.norm(V - R_[f + '_pts'][i], axis=1))))
        dry = np.maximum(dry, (lab == f'foot_{side}') * ss(0.012, 0.0, z) * 0.9)
    dry *= 0.75 + 0.25 * S.fbm(V * 30.0, 2, seed=1.7) + 0.25
    dry = np.clip(dry, 0, 1)

    # ---- sores, scars ---------------------------------------------------------------------
    sore = np.zeros(nv)
    sore_rim = np.zeros(nv)
    for p, nn, r in info['sores']:
        d = np.linalg.norm(V - p, axis=1)
        sore = np.maximum(sore, 1 - ss(r * 0.55, r * 0.95, d))
        sore_rim = np.maximum(sore_rim, (1 - ss(r * 0.9, r * 2.6, d)) * ss(r * 0.4, r * 0.9, d))
    for p, nrm, r in info['holes']:
        d = np.linalg.norm(V - p, axis=1)
        sore_rim = np.maximum(sore_rim, 0.7 * (1 - ss(r * 1.0, r * 2.4, d)))
    scar = np.zeros(nv)
    for pts in info['scars']:
        d, _, _ = dist_polyline(V, pts)
        scar = np.maximum(scar, 1 - ss(0.0015, 0.0045, d))

    # ---- veins: density where the skin is thinnest ---------------------------------------
    vein = 0.18 + 0.0 * x
    vein += 0.5 * np.isin(labels, [A.LAB['neck']]) + 0.35 * ear
    vein += 0.45 * head * ss(2.12, 2.20, z) * (1 - ss(0.30, 0.34, y))     # temples / skull
    for side in ('L', 'R'):
        vein += 0.50 * np.isin(lab, [f'forearm_{side}', f'hand_{side}']) + 0.30 * (lab == f'upper_arm_{side}')
        vein += 0.25 * np.isin(lab, [f'thigh_{side}', f'shin_{side}', f'foot_{side}'])
    vein += 0.35 * (lab == 'torso') * ss(1.45, 1.75, z) * ss(-0.02, 0.06, y)   # upper chest
    vein = np.clip(vein, 0, 1)

    # ---- limb chains: arclength coordinate, axis, wrinkle spacing --------------------------
    wc = np.zeros(nv)
    wax = np.tile([0.0, 0.0, 1.0], (nv, 1))
    wlam = np.full(nv, 0.006)
    aniso = np.zeros(nv)
    sp = info['spine']
    spine_pts = np.concatenate([sp, [J['atlas'] + S.v3(0, 0.03, 0.10)]])
    sel = np.isin(lab, ['torso', 'pelvis', 'neck'])
    _, c_, t_ = dist_polyline(V[sel], spine_pts)
    wc[sel], wax[sel], wlam[sel] = c_, t_, 0.0055
    aniso[np.isin(lab, ['neck'])] = 0.7
    selh = head > 0
    wc[selh], wax[selh], wlam[selh] = z[selh], [0, 0, 1], 0.0035
    for side in ('L', 'R'):
        R_ = J[side]
        arm = [R_['clav_in'], R_['S'], R_['E'], R_['W'], R_['W'] + R_['ha'] * A.PALM]
        sel = np.isin(lab, [f'clav_{side}', f'upper_arm_{side}', f'forearm_{side}', f'hand_{side}'])
        _, c_, t_ = dist_polyline(V[sel], arm)
        wc[sel], wax[sel], wlam[sel], aniso[sel] = c_, t_, 0.0042, 1.0
        arm_len = sum(np.linalg.norm(np.asarray(arm[i + 1]) - arm[i]) for i in range(len(arm) - 1))
        for f in A.FINGERS:
            sel = lab == f'{f}_{side}'
            pts = R_[f + '_pts']
            _, c_, t_ = dist_polyline(V[sel], pts)
            wc[sel], wax[sel], wlam[sel], aniso[sel] = c_ + arm_len, t_, 0.0026, 1.0
        leg = [R_['H'], R_['K'], R_['A'], R_['ball'], R_['toe_tip']]
        sel = np.isin(lab, [f'thigh_{side}', f'shin_{side}', f'foot_{side}'])
        _, c_, t_ = dist_polyline(V[sel], leg)
        wc[sel], wax[sel], wlam[sel], aniso[sel] = c_, t_, 0.0048, 1.0
        base, u, nrm = J[side]['ear']
        sel = lab == f'ear_{side}'
        rel = V[sel] - base
        rel = rel - np.outer(rel @ nrm, nrm)
        rho = np.linalg.norm(rel, axis=1)
        wc[sel], wax[sel], wlam[sel], aniso[sel] = rho, rel / np.maximum(rho, 1e-6)[:, None], 0.004, 0.85
    for ax in range(3):
        wax[:, ax] = graph_smooth_scalar(E, nv, wax[:, ax], 4)
    wax /= np.maximum(np.linalg.norm(wax, axis=1, keepdims=True), 1e-9)

    # ---- joint wrinkles + stretch marks + bruising -------------------------------------
    wr = np.zeros(nv)
    st = np.zeros(nv)
    bru = np.zeros(nv)

    def near(p, r0, r1):
        return 1 - ss(r0, r1, np.linalg.norm(V - p, axis=1))
    for side, s_ in (('L', -1), ('R', 1)):
        R_ = J[side]
        dorsal = ss(-0.2, 0.5, -(N @ R_['hn']))
        wr = np.maximum(wr, 0.9 * near(R_['E'], 0.025, 0.065))
        wr = np.maximum(wr, 0.8 * near(R_['W'], 0.015, 0.040))
        wr = np.maximum(wr, 0.85 * near(R_['K'] + S.v3(0, 0.02, 0.02), 0.03, 0.075))
        wr = np.maximum(wr, 0.6 * near(R_['A'] + S.v3(0, 0.025, 0.01), 0.015, 0.040))
        wr = np.maximum(wr, 0.6 * near(R_['S'] + R_['d_up'] * 0.05, 0.03, 0.07) * ss(0.0, 0.4, -(N[:, 2])))   # armpit
        wr = np.maximum(wr, 0.6 * near(R_['H'] + S.v3(0.0, 0.07, -0.02), 0.025, 0.06))                       # hip crease
        for f in A.FINGERS:
            for i in (0, 1, 2):
                wr = np.maximum(wr, (0.55 + 0.45 * dorsal) * near(R_[f + '_pts'][i], 0.006, 0.016))
        for (base, p1, p2, r, d2) in R_['toes'].values():
            wr = np.maximum(wr, 0.8 * near(p1, 0.004, 0.012))
            wr = np.maximum(wr, 0.7 * near(base, 0.006, 0.016))
        st = np.maximum(st, near(R_['S'] + R_['d_up'] * 0.06, 0.03, 0.10))                              # shoulders/armpits
        st = np.maximum(st, 0.8 * near(R_['H'] + S.v3(0.03 * s_, -0.03, 0.02), 0.04, 0.11))             # hips
        st = np.maximum(st, 0.7 * near(R_['K'] - S.v3(0, 0.03, 0), 0.02, 0.06))                         # back of the knees
        bru = np.maximum(bru, near(R_['E'], 0.02, 0.07))
        bru = np.maximum(bru, near(R_['K'], 0.03, 0.08))
        bru = np.maximum(bru, 0.8 * near((R_['K'] + R_['A']) / 2 + S.v3(0, 0.025, 0), 0.03, 0.10))   # shins
        bru = np.maximum(bru, 0.7 * near(R_['W'] + R_['ha'] * 0.06, 0.02, 0.06))
        for f in A.FINGERS:
            for i in (0, 1, 2):
                bru = np.maximum(bru, 0.65 * near(R_[f + '_pts'][i], 0.004, 0.012))
    neck = np.isin(labels, [A.LAB['neck']]).astype(float)
    wr = np.maximum(wr, 0.85 * neck * ss(-0.02, 0.06, y - 0.05))
    wr = np.maximum(wr, 0.7 * head * ss(0.32, 0.36, y) * ss(2.150, 2.175, z) * (1 - ss(2.205, 2.235, z)))   # brow furrows
    wr = np.maximum(wr, 0.6 * (lab == 'torso') * ss(0.02, 0.06, y) * ss(1.24, 1.30, z) * (1 - ss(1.40, 1.46, z)))  # belly folds
    st = np.maximum(st, 0.9 * np.isin(lab, ['torso', 'pelvis']) * ss(0.07, 0.11, np.abs(x)) * ss(1.15, 1.25, z) * (1 - ss(1.40, 1.52, z)))   # flanks
    bru = np.maximum(bru, 0.6 * (lab == 'torso') * ss(0.08, 0.14, np.abs(x)))                         # ribs
    bru = np.maximum(bru, 0.6 * sock)
    bru = np.clip(bru, 0, 1)

    # ---- inflamed rims -----------------------------------------------------------------
    infl = np.maximum(sore_rim, (1 - ss(0.002, 0.012, dm)) * head * 0.9)
    infl = np.maximum(infl, nost * 0.6)

    # ---- dried blood: smeared around the lips, dripping off the chin, under the nails ----
    blood = np.zeros(nv)
    for side, pts in info['lips'].items():
        d, _, _ = dist_polyline(V, pts)
        blood = np.maximum(blood, (1 - ss(0.002, 0.024, d)) * head)
    zb = A.MOUTH_SLIT[0][2] - A.MOUTH_SLIT[1][2] * 0.9                 # bottom of the slit
    for dx, ln in ((-0.012, 0.075), (0.003, 0.11), (0.016, 0.05)):
        across = np.abs(x - dx - 0.0025 * np.sin((zb - z) * 110 + dx * 300))
        down = zb + 0.008 - z
        wid = 0.0022 + 0.0025 * ss(0.0, ln, down)
        blood = np.maximum(blood, (1 - ss(wid * 0.6, wid * 1.5, across)) * ss(-0.004, 0.010, down)
                           * (1 - ss(ln * 0.45, ln, down)) * (y > 0.20))
    blood = np.maximum(blood, tips * 0.75)

    # ---- wet / thin / cavity for the engine (COLOR_0) ------------------------------------
    wet = np.maximum.reduce([inner * 0.95, deep, gum, lip * 0.8, seep * 0.75, seam * 0.6, nost * 0.6,
                             sore * 0.9, sore_rim * 0.35, dark * 0.6])
    for side in ('L', 'R'):                                               # sweaty creases
        R_ = J[side]
        wet = np.maximum(wet, 0.22 * near(R_['S'] + R_['d_up'] * 0.05 - S.v3(0, 0, 0.02), 0.02, 0.06))
        wet = np.maximum(wet, 0.18 * near(R_['H'] + S.v3(-0.04 * (1 if side == 'R' else -1), 0.06, -0.05), 0.02, 0.06))
    thin_skin = 0.08 + 0.12 * np.maximum.reduce([np.isin(labels, [A.LAB['neck']]) * 1.0,
                                                 head * ss(2.14, 2.20, z) * (1 - ss(0.30, 0.34, y))])
    for side in ('L', 'R'):
        thin_skin = np.maximum(thin_skin, 0.20 * np.isin(lab, [f'forearm_{side}']) * ss(0.0, 0.6, N @ J[side]['hn']))
    thin = np.maximum.reduce([thin_skin, membrane * 0.97, web * 0.72, lip * 0.62, nost * 0.55, seam * 0.4,
                              tips * 0.30, root * 0.35 * ear])
    cavity = np.clip(1 - np.maximum(cav_s, 0) * 0.30 - np.maximum(cav_l, 0) * 0.25 - dark * 0.75 - deep * 0.3, 0, 1)

    clamp = lambda a: np.clip(a, 0, 1)
    attrs = {
        'mA': np.stack([clamp(cav_s * 0.5 + 0.5), clamp(cav_l * 0.5 + 0.5), clamp(dark), clamp(ext)], 1),
        'mB': np.stack([clamp(membrane), clamp(sock), vein, clamp(infl)], 1),
        'mC': np.stack([clamp(wet), clamp(thin), dry, clamp(wr)], 1),
        'mD': np.stack([clamp(np.maximum(sore, 0)), clamp(scar), clamp(np.maximum(seam * 0.8, seep * 0.32)), clamp(st)], 1),
        'mE': np.stack([clamp(np.maximum(gum, inner * 0.6)), clamp(lip), bru, clamp(nailb)], 1),
        'mF': np.stack([clamp(blood), clamp(ear), np.zeros(nv), np.zeros(nv)], 1),
    }
    floats = {'wcrd': wc, 'wlam': wlam, 'aniso': aniso}
    vectors = {'wax': wax}
    return {'attrs': attrs, 'floats': floats, 'vectors': vectors, 'thin': thin, 'wet': wet, 'cav': cavity}


# ---------------------------------------------------------------------------------------------
# procedural skin shader (lives on the sculpt; baked down to images)
# ---------------------------------------------------------------------------------------------

class NB:
    def __init__(self, mat):
        self.nt = mat.node_tree
        self.nt.nodes.clear()
        self.y = 0

    def n(self, kind, **kw):
        node = self.nt.nodes.new(kind)
        node.location = (0, -self.y * 30)
        self.y += 1
        for k, v in kw.items():
            if k.startswith('in_'):
                self.set(node.inputs[k[3:].replace('_', ' ')], v)
            else:
                setattr(node, k, v)
        return node

    def set(self, sock, v):
        if isinstance(v, bpy.types.NodeSocket):
            self.nt.links.new(v, sock)
        elif isinstance(v, (tuple, list)):
            if len(v) == 3 and sock.type == 'RGBA':
                v = (*v, 1.0)
            sock.default_value = v
        else:
            sock.default_value = v

    def math(self, op, a, b=0.0, clamp=False):
        m = self.n('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.set(m.inputs[0], a)
        self.set(m.inputs[1], b)
        return m.outputs[0]

    def mul(self, a, b, clamp=False):
        return self.math('MULTIPLY', a, b, clamp)

    def add(self, a, b, clamp=False):
        return self.math('ADD', a, b, clamp)

    def sub(self, a, b, clamp=False):
        return self.math('SUBTRACT', a, b, clamp)

    def inv(self, a):
        return self.math('SUBTRACT', 1.0, a, True)

    def mix(self, fac, a, b, blend='MIX', clamp=True):
        m = self.n('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_result=clamp)
        self.set(m.inputs['Factor'], fac)
        self.set(m.inputs[6], a)
        self.set(m.inputs[7], b)
        return m.outputs[2]

    def mixf(self, fac, a, b):
        m = self.n('ShaderNodeMix', data_type='FLOAT')
        self.set(m.inputs['Factor'], fac)
        self.set(m.inputs[2], a)
        self.set(m.inputs[3], b)
        return m.outputs[0]

    def ramp(self, fac, a, b):
        """Smoothstep remap of fac from [a, b] to [0, 1]."""
        m = self.n('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP')
        self.set(m.inputs['Value'], fac)
        m.inputs['From Min'].default_value = a
        m.inputs['From Max'].default_value = b
        return m.outputs[0]

    def noise(self, vec, scale, detail=3.0, rough=0.55, distortion=0.0):
        m = self.n('ShaderNodeTexNoise', noise_dimensions='3D')
        self.set(m.inputs['Vector'], vec)
        m.inputs['Scale'].default_value = scale
        m.inputs['Detail'].default_value = detail
        m.inputs['Roughness'].default_value = rough
        m.inputs['Distortion'].default_value = distortion
        return m.outputs['Fac']

    def noise_vec(self, vec, scale, detail=2.0):
        m = self.n('ShaderNodeTexNoise', noise_dimensions='3D')
        self.set(m.inputs['Vector'], vec)
        m.inputs['Scale'].default_value = scale
        m.inputs['Detail'].default_value = detail
        return m.outputs['Color']

    def voronoi(self, vec, scale, feature='F1', rand=1.0):
        m = self.n('ShaderNodeTexVoronoi', voronoi_dimensions='3D', feature=feature)
        self.set(m.inputs['Vector'], vec)
        m.inputs['Scale'].default_value = scale
        m.inputs['Randomness'].default_value = rand
        return m.outputs['Distance']

    def vadd(self, a, b):
        m = self.n('ShaderNodeVectorMath', operation='ADD')
        self.set(m.inputs[0], a)
        self.set(m.inputs[1], b)
        return m.outputs[0]

    def vscale(self, a, s):
        m = self.n('ShaderNodeVectorMath', operation='SCALE')
        self.set(m.inputs[0], a)
        self.set(m.inputs['Scale'], s)
        return m.outputs[0]

    def attr(self, name, out='Color'):
        return self.n('ShaderNodeAttribute', attribute_name=name, attribute_type='GEOMETRY').outputs[out]

    def split(self, name):
        a = self.n('ShaderNodeAttribute', attribute_name=name, attribute_type='GEOMETRY')
        s = self.n('ShaderNodeSeparateColor')
        self.set(s.inputs[0], a.outputs['Color'])
        return s.outputs[0], s.outputs[1], s.outputs[2], a.outputs['Alpha']


def skin_material() -> bpy.types.Material:
    mat = bpy.data.materials.new('monster_sculpt')
    try:
        mat.use_nodes = True
    except Exception:
        pass
    nb = NB(mat)
    out = nb.n('ShaderNodeOutputMaterial')
    bsdf = nb.n('ShaderNodeBsdfPrincipled')
    nb.nt.links.new(bsdf.outputs[0], out.inputs['Surface'])
    P = nb.n('ShaderNodeTexCoord').outputs['Object']        # meters
    cs, cl, dark, ext = nb.split('mA')
    ear, sock, vein_d, infl = nb.split('mB')
    wet, thin, dry0, wrink = nb.split('mC')
    sore, scar, seam, stretch = nb.split('mD')
    gum, lip, bruise, nailb = nb.split('mE')
    blood, _, _, _ = nb.split('mF')
    wcrd = nb.attr('wcrd', 'Fac')
    wlam = nb.attr('wlam', 'Fac')
    aniso = nb.attr('aniso', 'Fac')
    wax = nb.attr('wax', 'Vector')
    dry = nb.mul(dry0, nb.ramp(nb.noise(P, 16.0, 3, 0.6), 0.30, 0.58))   # ragged edges
    cav_s = nb.sub(cs, 0.5)                                  # + concave / - convex
    cav_l = nb.sub(cl, 0.5)

    # warped coordinates for organic patterns, and limb-stretched ones for directional veins
    Pw = nb.vadd(P, nb.vscale(nb.noise_vec(P, 7.0, 2.0), 0.035))
    Pa = nb.vadd(Pw, nb.vscale(wax, nb.mul(nb.mul(wcrd, aniso), -0.72)))   # squash along the limb axis

    def isoline(vec, scale, width, detail=2.0):
        nz = nb.noise(vec, scale, detail, 0.5)
        return nb.inv(nb.ramp(nb.math('ABSOLUTE', nb.sub(nz, 0.5)), 0.0, width))

    # ---- base color -------------------------------------------------------------------
    col = nb.mix(nb.ramp(nb.noise(P, 1.4, 2, 0.5), 0.3, 0.7), (0.47, 0.45, 0.40), (0.31, 0.295, 0.28))
    mott = nb.ramp(nb.noise(P, 5.5, 6, 0.62), 0.42, 0.58)
    col = nb.mix(nb.mul(mott, 0.85), col, (0.185, 0.170, 0.190))                          # mottling
    fine = nb.ramp(nb.noise(P, 38.0, 3, 0.6), 0.35, 0.65)
    col = nb.mix(nb.mul(fine, 0.18), col, (0.24, 0.20, 0.20))                              # blotchy grain
    blot = nb.ramp(nb.noise(Pw, 2.3, 4, 0.55, 0.4), 0.50, 0.61)
    col = nb.mix(nb.mul(blot, 0.80), col, (0.11, 0.09, 0.10))                              # necrotic blotches
    rim = nb.mul(nb.ramp(nb.noise(Pw, 2.3, 4, 0.55, 0.4), 0.44, 0.51), nb.inv(blot))
    col = nb.mix(nb.mul(rim, 0.45), col, (0.25, 0.13, 0.18))                               # bruised purple edges
    sick = nb.ramp(nb.noise(Pw, 3.1, 3, 0.5), 0.54, 0.67)
    col = nb.mix(nb.mul(sick, 0.45), col, (0.44, 0.38, 0.17))                              # yellowed patches
    # bruises near joints / ribs: dark purple core, yellow-green halo
    bn = nb.noise(Pw, 4.2, 4, 0.55, 0.3)
    bcore = nb.mul(nb.ramp(bn, 0.53, 0.64), bruise)
    bhalo = nb.mul(nb.mul(nb.ramp(bn, 0.47, 0.53), nb.inv(nb.ramp(bn, 0.55, 0.60))), bruise)
    col = nb.mix(nb.mul(bhalo, 0.5), col, (0.40, 0.38, 0.19))
    col = nb.mix(nb.mul(bcore, 0.75), col, (0.20, 0.09, 0.16))
    # thin skin glows warmer (blood under it)
    col = nb.mix(nb.mul(thin, 0.35), col, (0.44, 0.30, 0.28))
    # veins: long sinuous trunks running along the limbs + finer branches, under the skin
    v1 = isoline(Pa, 4.2, 0.022)
    v2 = nb.mul(isoline(nb.vadd(Pa, (3.7, 1.3, 5.1)), 10.5, 0.017), 0.75)
    v3_ = nb.mul(isoline(nb.vadd(Pw, (1.1, 7.3, 2.9)), 23.0, 0.018), 0.25)
    brk = nb.ramp(nb.noise(P, 3.0, 2), 0.47, 0.64)
    vmask = nb.mul(nb.add(vein_d, 0.18), brk)
    veins = nb.mul(nb.math('MAXIMUM', nb.math('MAXIMUM', v1, v2), v3_), vmask, clamp=True)
    col = nb.mix(nb.mul(veins, 0.95), col, (0.040, 0.048, 0.100))
    cap = nb.mul(isoline(Pw, 34.0, 0.022), 0.30)
    col = nb.mix(nb.mul(cap, nb.add(vein_d, thin)), col, (0.24, 0.07, 0.11))              # capillaries
    # stretched skin over bone (convex) lighter; crevices darker + redder
    convex = nb.ramp(nb.mul(cav_s, -1.0), 0.03, 0.35)
    col = nb.mix(nb.mul(nb.mul(convex, 0.50), nb.inv(ear)), col, (0.58, 0.56, 0.50))
    crev = nb.ramp(nb.add(cav_s, nb.mul(cav_l, 1.2)), 0.02, 0.38)
    col = nb.mix(crev, col, nb.mix(0.85, col, (0.14, 0.075, 0.065), 'MULTIPLY'), 'MIX')
    # joint wrinkles (rings of constant wcrd), shared by color and height
    phase = nb.math('DIVIDE', nb.add(wcrd, nb.add(nb.mul(nb.sub(nb.noise(P, 60.0, 2), 0.5), 0.0060),
                                                 nb.mul(nb.sub(nb.noise(P, 12.0, 2), 0.5), 0.018))), wlam)
    ring = nb.math('ABSOLUTE', nb.math('SINE', nb.mul(phase, math.pi)))
    crease = nb.math('POWER', nb.inv(ring), 7.0)
    wbrk = nb.ramp(nb.noise(P, 26.0, 2), 0.40, 0.63)
    folds = nb.mul(nb.mul(crease, wrink), wbrk)
    col = nb.mix(nb.mul(folds, 0.55), col, (0.17, 0.11, 0.12))
    # stretch marks: broken bands around the limb / torso, pale lilac, shiny
    sband = nb.ramp(nb.noise(nb.vadd(nb.vscale(P, 7.0), nb.vscale(wax, nb.mul(wcrd, 95.0))), 1.0, 2, 0.5), 0.58, 0.66)
    smask = nb.mul(nb.mul(sband, stretch), nb.ramp(nb.noise(Pw, 9.0, 2), 0.40, 0.62))
    col = nb.mix(nb.mul(smask, 0.60), col, (0.52, 0.42, 0.47))
    # dry cracked skin: lighter flakes, dark crack network
    Pc = nb.vadd(P, nb.vscale(nb.noise_vec(P, 90.0, 2.0), 0.0035))
    cracks = nb.mul(nb.inv(nb.ramp(nb.voronoi(Pc, 430.0, 'DISTANCE_TO_EDGE', 0.9), 0.0, 0.045)),
                    nb.ramp(nb.noise(P, 60.0, 2), 0.38, 0.55))
    flakes = nb.ramp(nb.noise(P, 520.0, 2), 0.52, 0.70)
    col = nb.mix(nb.mul(dry, 0.35), col, (0.53, 0.51, 0.48))
    col = nb.mix(nb.mul(nb.mul(flakes, dry), 0.35), col, (0.64, 0.62, 0.58))
    col = nb.mix(nb.mul(nb.mul(cracks, dry), 0.75), col, (0.09, 0.07, 0.065))
    # scars: pale, waxy, dark edged
    col = nb.mix(nb.mul(scar, 0.75), col, (0.56, 0.47, 0.46))
    col = nb.mix(nb.mul(nb.mul(scar, nb.inv(scar)), 1.6), col, (0.20, 0.10, 0.11))
    # sockets: bruised; sealed eyelid seams and tear tracks: raw red
    col = nb.mix(nb.mul(sock, 0.65), col, (0.17, 0.11, 0.15))
    col = nb.mix(nb.mul(seam, 0.60), col, (0.21, 0.07, 0.07))
    # inflamed rims, weeping sores (pus ring, raw crater)
    col = nb.mix(nb.mul(infl, 0.70), col, (0.33, 0.09, 0.09))
    pus = nb.mul(sore, nb.inv(nb.ramp(sore, 0.55, 0.95)))
    col = nb.mix(nb.mul(pus, 1.2), col, (0.44, 0.37, 0.14))
    col = nb.mix(nb.ramp(sore, 0.55, 0.95), col, (0.10, 0.015, 0.018))
    # extremities: necrotic grey-purple toward the finger/toe tips, darker nail beds
    col = nb.mix(nb.mul(ext, 0.85), col, nb.mix(0.5, (0.15, 0.12, 0.13), (0.10, 0.07, 0.08)))
    col = nb.mix(nb.mul(nailb, 0.8), col, (0.10, 0.05, 0.06))
    # mouth: raw lips, swollen gums, the deep wet red-black throat
    col = nb.mix(nb.mul(lip, 0.80), col, (0.38, 0.13, 0.13))
    col = nb.mix(nb.mul(gum, 0.92), col, nb.mix(nb.ramp(nb.noise(P, 90.0, 2), 0.3, 0.7), (0.30, 0.04, 0.06), (0.18, 0.02, 0.05)))
    bl = nb.mul(blood, nb.ramp(nb.noise(Pw, 14.0, 3, 0.6), 0.34, 0.62))
    col = nb.mix(nb.mul(bl, 0.85), col, nb.mix(nb.ramp(nb.noise(P, 70.0, 2), 0.3, 0.7), (0.17, 0.030, 0.028), (0.075, 0.012, 0.012)))
    col = nb.mix(dark, col, (0.032, 0.006, 0.008))
    ao = nb.n('ShaderNodeAmbientOcclusion', only_local=True, samples=8)
    ao.inputs['Distance'].default_value = 0.06
    col = nb.mix(nb.mixf(ao.outputs['AO'], 0.30, 1.0), (0, 0, 0), col, 'MIX')
    nb.set(bsdf.inputs['Base Color'], col)

    # ---- roughness: oily skin, wet mouth/gums/seepage/sores, dry cracked knees/elbows -------
    rough = nb.mixf(nb.noise(P, 9.0, 3), 0.38, 0.54)
    rough = nb.add(rough, nb.mul(nb.sub(nb.noise(P, 180.0, 2), 0.5), 0.10))
    rough = nb.mixf(nb.mul(blot, 0.6), rough, 0.52)
    rough = nb.mixf(nb.mul(ext, 0.5), rough, 0.50)
    rough = nb.mixf(dry, rough, nb.mixf(cracks, 0.64, 0.82))
    rough = nb.mixf(nb.mul(scar, 0.8), rough, 0.22)
    rough = nb.mixf(nb.mul(smask, 0.6), rough, 0.24)
    rough = nb.mixf(nb.mul(crev, 0.5), rough, 0.31)
    rough = nb.mixf(nb.mul(ear, 0.4), rough, 0.30)
    rough = nb.mixf(nb.mul(sock, 0.6), rough, 0.18)
    rough = nb.mixf(nb.mul(bl, 0.7), rough, 0.30)
    rough = nb.mixf(wet, rough, 0.09)
    rough = nb.mixf(dark, rough, 0.07)
    nb.set(bsdf.inputs['Roughness'], nb.math('MAXIMUM', nb.math('MINIMUM', rough, 0.9), 0.05))

    # ---- height: pores, crepe, raised veins, joint creases, stretch marks, cracks ----------
    hgt = nb.mul(veins, 0.60)
    hgt = nb.sub(hgt, nb.mul(nb.mul(isoline(Pw, 55.0, 0.05, 3.0), nb.inv(nb.mul(ear, 0.85))), 0.20))   # crepey skin
    pore = nb.inv(nb.ramp(nb.voronoi(P, 520.0, 'F1'), 0.0, 0.32))
    hgt = nb.sub(hgt, nb.mul(nb.mul(pore, nb.inv(wet)), 0.22))                            # pores
    hgt = nb.add(hgt, nb.mul(nb.noise(P, 160.0, 2), 0.14))                                # micro bumps
    hgt = nb.add(hgt, nb.mul(nb.noise(P, 22.0, 3), 0.24))                                 # lumps
    hgt = nb.sub(hgt, nb.mul(folds, 1.45))                                                # joint creases
    hgt = nb.add(hgt, nb.mul(nb.mul(nb.mul(ring, wrink), wbrk), 0.25))                    # the folds between
    hgt = nb.sub(hgt, nb.mul(smask, 0.40))                                                # stretch marks
    hgt = nb.sub(hgt, nb.mul(nb.mul(cracks, dry), 0.85))                                  # cracks
    hgt = nb.add(hgt, nb.mul(nb.mul(flakes, dry), 0.25))                                  # flakes
    hgt = nb.add(hgt, nb.mul(nb.mul(nb.noise(P, 260.0, 2), scar), 0.30))                  # scar tissue
    hgt = nb.sub(hgt, nb.mul(seam, 0.6))                                                  # eyelid seams
    bump = nb.n('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 1.0
    bump.inputs['Distance'].default_value = 0.0009
    nb.set(bump.inputs['Height'], hgt)
    nb.set(bsdf.inputs['Normal'], bump.outputs['Normal'])
    return mat


# ---------------------------------------------------------------------------------------------
# shader masks for the engine (glTF COLOR_0): R thinness, G wetness, B cavity/AO, A = 1
# ---------------------------------------------------------------------------------------------

COLOR_ATTR = 'shader_mask'


def _fib_hemisphere(n):
    """n cosine-weighted directions on the +Z hemisphere (deterministic Fibonacci spiral)."""
    i = np.arange(n) + 0.5
    r = np.sqrt(i / n)
    phi = i * math.pi * (3 - math.sqrt(5))
    return np.stack([r * np.cos(phi), r * np.sin(phi), np.sqrt(1 - r * r)], 1)


def vertex_ao(objs, target, dist=0.07, nrays=40) -> np.ndarray:
    """Local ambient occlusion per vertex of `target` against all `objs` (bind pose)."""
    from mathutils.bvhtree import BVHTree
    deps = bpy.context.evaluated_depsgraph_get()
    verts, polys = [], []
    for o in objs:
        me = o.evaluated_get(deps).to_mesh()
        off = len(verts)
        verts.extend([o.matrix_world @ v.co for v in me.vertices])
        polys.extend([[off + i for i in p.vertices] for p in me.polygons])
        o.evaluated_get(deps).to_mesh_clear()
    bvh = BVHTree.FromPolygons(verts, polys, all_triangles=False, epsilon=0.0)
    me = target.data
    D = _fib_hemisphere(nrays)
    out = np.zeros(len(me.vertices))
    for v in me.vertices:
        n = v.normal
        p = target.matrix_world @ v.co
        t1 = n.orthogonal().normalized()
        t2 = n.cross(t1)
        occ = 0.0
        for dx, dy, dz in D:
            d = t1 * dx + t2 * dy + n * dz
            hit = bvh.ray_cast(p + n * 0.0015, d, dist)
            if hit[0] is not None:
                occ += 1.0 - 0.5 * (hit[3] / dist)
        out[v.index] = 1.0 - occ / nrays
    return out


def shader_masks(low, llab, st, mk, scale, occluders=()) -> None:
    """Average the sculpt's thin/wet/cavity masks around each game-mesh vertex, multiply the
    cavity by local AO, and store them as the COLOR_0 attribute."""
    from mathutils import kdtree
    Vh = st['V'] * scale
    t = kdtree.KDTree(len(Vh))
    for i, p in enumerate(Vh):
        t.insert(p, i)
    t.balance()
    me = low.data
    nv = len(me.vertices)
    thin, wet, cav = mk['thin'], mk['wet'], mk['cav']
    out = np.zeros((nv, 4))
    for v in me.vertices:
        p = low.matrix_world @ v.co
        hits = t.find_range(p, 0.0045) or [t.find(p)]
        idx = [h[1] for h in hits]
        out[v.index, 0] = thin[idx].mean()
        out[v.index, 1] = wet[idx].max() * 0.6 + wet[idx].mean() * 0.4
        out[v.index, 2] = cav[idx].mean()
    ao = vertex_ao([low] + list(occluders), low)
    out[:, 2] = np.clip(out[:, 2] * (0.15 + 0.85 * ao), 0, 1)
    out[:, 3] = 1.0
    at = me.color_attributes.new(COLOR_ATTR, 'FLOAT_COLOR', 'POINT')
    at.data.foreach_set('color', np.clip(out, 0, 1).astype(np.float32).ravel())
    print(f'[monster_skin] shader masks: thin {out[:, 0].mean():.2f}, wet {out[:, 1].mean():.2f}, '
          f'cavity {out[:, 2].mean():.2f}')
