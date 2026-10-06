"""
Procedural surface detail for the hand, evaluated per texel (see hands_tex):
height (m), linear albedo and roughness from object-space position + normal.

Everything is placed from the skeleton (joint positions / bone frames), so the details stay on
the anatomy when the proportions change: nails on the distal phalanges, wrinkles over the
knuckles, flexion creases at the joints, the three main palm lines, extensor tendons and veins on
the back of the hand, a little weathering (dirt in creases, dirty nail edges, a few scratches)
and the ribbed knit of the sleeve cuff.
"""

from __future__ import annotations

import math

import numpy as np

import hands_geo as hg
from hands_tex import fbm, ridged, seg_dist2d, smoothstep, srgb_to_lin, vnoise

MM = 0.001


def _vec(v):
    return np.array([v.x, v.y, v.z], dtype=np.float64)


def _interp_profile(keys, s):
    xs = np.array([k[0] for k in keys])
    ys = np.array([k[1] for k in keys])
    return np.interp(s, xs, ys)


def gauss(d, sigma):
    return np.exp(-(d / sigma) ** 2)


def evaluate(P: np.ndarray, N: np.ndarray, region: np.ndarray, sk: hg.Skeleton, seed: int = 3):
    """P, N: (n, 3) object space (right hand). region: (n, 3) R = cuff, G = cuff inside.
    Returns H (n,), albedo (n, 3) linear, roughness (n,)."""
    n = P.shape[0]
    H = np.zeros(n)
    crease = np.zeros(n)        # negative where skin folds (for cavity darkening)
    dirt = np.zeros(n)          # 0..1 grime amount
    rough = np.full(n, 0.56)
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    nz = N[:, 2]
    cuff = region[:, 0] > 0.5
    cuff_in = region[:, 1] > 0.5
    skin = ~cuff

    # ------------------------------------------------------------------ classification
    segs = []  # (chain, k, A, B)   k = -1 metacarpal (palm), 0..2 bones
    for f in hg.FINGERS:
        ch = sk.chains[f]
        j0 = _vec(ch.joints[0])
        segs.append((f, -1, np.array([j0[0] * 0.55, 0.004, 0.003]), j0))
        for k in range(3):
            segs.append((f, k, _vec(ch.joints[k]), _vec(ch.joints[k + 1])))
    th = sk.chains['thumb']
    for k in range(3):
        segs.append(('thumb', k, _vec(th.joints[k]), _vec(th.joints[k + 1])))
    D = np.empty((n, len(segs)))
    for i, (_, _, A, B) in enumerate(segs):
        AB = B - A
        t = np.clip(((P - A) @ AB) / (AB @ AB), 0, 1)
        Q = A + t[:, None] * AB
        D[:, i] = np.linalg.norm(P - Q, axis=1)
    nearest = np.argmin(D, axis=1)
    seg_chain = np.array([s[0] for s in segs])[nearest]
    seg_k = np.array([s[1] for s in segs])[nearest]
    palm = skin & (seg_k < 0) | (skin & (seg_chain == 'thumb') & (seg_k == 0))

    # ------------------------------------------------------------------ base colours
    c_back = srgb_to_lin([0.690, 0.560, 0.498])
    c_palm = srgb_to_lin([0.775, 0.640, 0.575])
    c_knuckle = srgb_to_lin([0.640, 0.475, 0.430])
    c_tip = srgb_to_lin([0.760, 0.565, 0.505])
    c_nail = srgb_to_lin([0.770, 0.655, 0.615])
    c_lunula = srgb_to_lin([0.835, 0.760, 0.720])
    c_free = srgb_to_lin([0.860, 0.820, 0.730])
    c_dirt = srgb_to_lin([0.230, 0.185, 0.150])
    c_vein = srgb_to_lin([0.560, 0.540, 0.570])
    c_scab = srgb_to_lin([0.420, 0.230, 0.190])

    palmness = np.zeros(n)       # 0 dorsal .. 1 palmar
    redness = np.zeros(n)        # knuckle / tip redness
    tipness = np.zeros(n)
    nail_w = np.zeros(n)         # nail coverage 0..1
    lunula_w = np.zeros(n)
    free_w = np.zeros(n)
    vein_w = np.zeros(n)
    scab_w = np.zeros(n)

    palmness[palm] = smoothstep(0.15, -0.45, nz[palm])

    # ------------------------------------------------------------------ fingers + thumb
    for cname in hg.FINGERS + ('thumb',):
        ch = sk.chains[cname]
        sel = skin & (seg_chain == cname)
        if cname != 'thumb':
            sel &= seg_k >= 0
            prof = hg.FINGER_PROFILE
        else:
            prof = hg.THUMB_PROFILE
        idx = np.nonzero(sel)[0]
        if idx.size == 0:
            continue
        p = P[idx]
        k = seg_k[idx]
        J = [_vec(j) for j in ch.joints]
        dirs = [_vec(ch.bone_dir(i)) for i in range(3)]
        dors = [_vec(ch.dorsal[i]) for i in range(3)]
        lens = [ch.length(i) for i in range(3)]
        # per texel bone frame
        d_k = np.array(dirs)[k]
        v_k = np.array(dors)[k]
        v_k = v_k - d_k * np.sum(v_k * d_k, 1, keepdims=True)
        v_k /= np.linalg.norm(v_k, axis=1, keepdims=True)
        u_k = np.cross(d_k, v_k)
        Jk = np.array(J)[k]
        rel = p - Jk
        a = np.sum(rel * d_k, 1)
        s = k + np.clip(a / np.array(lens)[k], -0.3, 1.2)
        lx = np.sum(rel * u_k, 1)
        ly = np.sum(rel * v_k, 1)
        theta = np.arctan2(lx, ly)          # 0 = dorsal centre, +-pi = palmar centre
        cth = np.cos(theta)
        hw = _interp_profile(prof['hw'], s) * ch.scale
        q = lx / np.maximum(hw, 1e-4)

        # distance along the finger from joint j (averaged bone directions at the joint)
        def delta(j):
            if j == 0:
                dj = dirs[0]
            else:
                dj = dirs[j - 1] + dirs[j]
                dj = dj / np.linalg.norm(dj)
            return (p - J[j]) @ dj

        dorsal = smoothstep(-0.05, 0.45, cth)
        palmar = smoothstep(0.05, -0.55, cth)
        palmness[idx] = smoothstep(0.25, -0.6, cth)
        lat_fade = 1 - smoothstep(0.55, 1.0, np.abs(q))
        nz_ = vnoise(np.c_[p * 900.0] + seed)  # line breakup noise
        hh = np.zeros(idx.size)
        cr = np.zeros(idx.size)

        def wrinkle_set(dj, centers, amp, sig, curve, mask, jitter=0.25 * MM):
            out = np.zeros(idx.size)
            for ci, (c, w) in enumerate(centers):
                off = c + curve * q * q + jitter * vnoise(np.c_[p * 700.0] + 11 * ci + seed)
                depth = amp * w * (0.65 + 0.35 * vnoise(np.c_[p * 260.0] + 5 * ci))
                out -= depth * gauss(dj - off, sig)
            return out * mask

        # finger joints: 0 = MCP, 1 = PIP, 2 = DIP (thumb: 1 = MCP, 2 = IP)
        if cname == 'thumb':
            d1, d2 = delta(1), delta(2)
            # dorsal wrinkles over MCP and IP
            w = wrinkle_set(d1, [(-2.2 * MM, .6), (-0.8 * MM, 1), (0.6 * MM, 1), (2.0 * MM, .7)], 0.11 * MM, 0.22 * MM, -1.0 * MM, dorsal * lat_fade)
            w += wrinkle_set(d2, [(-2.4 * MM, .6), (-1.0 * MM, 1), (0.4 * MM, 1), (1.8 * MM, .8), (3.0 * MM, .4)], 0.12 * MM, 0.2 * MM, -0.9 * MM, dorsal * lat_fade)
            hh += w
            cr += w
            # palmar creases: IP (double), MCP (double)
            c = wrinkle_set(d2, [(-0.8 * MM, 1), (1.0 * MM, .8)], 0.32 * MM, 0.28 * MM, 0.5 * MM, palmar * lat_fade)
            c += wrinkle_set(d1, [(1.5 * MM, 1), (3.8 * MM, .7)], 0.30 * MM, 0.30 * MM, 0.8 * MM, palmar * lat_fade)
            hh += c
            cr += c
            knuck = gauss(d2, 3.5 * MM) * dorsal + gauss(d1, 4.5 * MM) * dorsal * 0.7
        else:
            d0, d1, d2 = delta(0), delta(1), delta(2)
            sc = ch.scale
            pip = [(-3.8 * MM, .45), (-2.6 * MM, .8), (-1.4 * MM, 1), (-0.3 * MM, 1), (0.8 * MM, .85), (1.9 * MM, .55), (2.9 * MM, .3)]
            dip = [(-1.9 * MM, .6), (-0.8 * MM, 1), (0.3 * MM, .9), (1.3 * MM, .5)]
            w = wrinkle_set(d1, [(c * sc, ww) for c, ww in pip], 0.13 * MM, 0.19 * MM, -1.3 * MM, dorsal * lat_fade)
            w += wrinkle_set(d2, [(c * sc, ww) for c, ww in dip], 0.09 * MM, 0.17 * MM, -0.9 * MM, dorsal * lat_fade)
            w += wrinkle_set(d0, [(4.0 * MM, .5), (6.0 * MM, .35)], 0.05 * MM, 0.3 * MM, -1.0 * MM, dorsal * lat_fade)
            hh += w
            cr += w
            # palmar flexion creases
            base_off = 20.0 * MM if cname != 'pinky' else 17.0 * MM
            c = wrinkle_set(d1, [(-0.7 * MM, 1), (1.3 * MM, .85)], 0.33 * MM, 0.27 * MM, 0.7 * MM, palmar * lat_fade)
            c += wrinkle_set(d2, [(0.3 * MM, 1), (1.6 * MM, .35)], 0.27 * MM, 0.25 * MM, 0.5 * MM, palmar * lat_fade)
            c += wrinkle_set(d0, [(base_off, 1), (base_off + 2.2 * MM, .55 if cname in ('middle', 'ring') else 0.2)], 0.30 * MM, 0.30 * MM, 1.2 * MM, palmar * lat_fade)
            hh += c
            cr += c
            # knuckle pads: slightly raised, ruddier skin over PIP / DIP
            knuck = gauss(d1 + 0.5 * MM, 4.0 * MM) * dorsal + 0.7 * gauss(d2, 3.0 * MM) * dorsal
            hh += 0.12 * MM * gauss(d1 + 0.5 * MM, 3.0 * MM) * dorsal * lat_fade
        redness[idx] = np.maximum(redness[idx], knuck * (0.55 + 0.45 * fbm(p * 300.0, 2)))

        # fingertip pad redness
        dist_tip = np.linalg.norm(p - J[3], axis=1)
        tipness[idx] = smoothstep(0.016, 0.004, dist_tip) * (0.4 + 0.6 * palmar)

        # ---------------- nail on the distal phalanx
        dd = (p - J[2]) @ dirs[2]
        L3 = lens[2]
        n0 = (0.40 if cname != 'thumb' else 0.36) * L3
        n1 = L3 - 0.9 * MM
        wn = 0.80 * _interp_profile(prof['hw'], np.clip(s, 2.0, 2.95)) * ch.scale
        # rounded rectangle SDF in (along, lateral)
        cxn = (n0 + n1) / 2
        hx = (n1 - n0) / 2
        rc = 0.55 * wn
        qx = np.abs(dd - cxn) - (hx - rc)
        qy = np.abs(lx) - (wn - rc)
        sdf = np.linalg.norm(np.c_[np.maximum(qx, 0), np.maximum(qy, 0)], axis=1) + np.minimum(np.maximum(qx, qy), 0) - rc
        top = smoothstep(0.0, 0.35, cth)
        on_tip = (k == 2) | (s > 1.9)
        inside = smoothstep(0.25 * MM, -0.35 * MM, sdf) * top * on_tip
        # plate raised, groove around (lateral folds), proximal fold ridge
        hn = 0.22 * MM * inside
        hn += 0.03 * MM * inside * (1 - (lx / np.maximum(wn, 1e-4)) ** 2)  # slight convexity
        groove = gauss(sdf - 0.25 * MM, 0.22 * MM) * top * on_tip
        hn -= 0.16 * MM * groove
        fold = gauss(dd - (n0 - 0.9 * MM), 0.6 * MM) * smoothstep(1.0, 0.6, np.abs(lx) / np.maximum(wn, 1e-4)) * top * on_tip
        hn += 0.08 * MM * fold
        # faint longitudinal ridges on the plate
        hn += 0.012 * MM * inside * np.sin(lx / (0.55 * MM) * math.pi)
        hh += hn
        cr -= 0.16 * MM * groove
        nail_w[idx] = inside
        lun = smoothstep(0.2, -0.2, ((dd - n0) / (0.26 * (n1 - n0))) ** 2 + (lx / (0.75 * wn)) ** 2 - 1)
        lunula_w[idx] = lun * inside
        free_w[idx] = smoothstep(n1 - 1.5 * MM, n1 - 0.4 * MM, dd) * inside
        # grime: under the free edge, in the nail folds, in the knuckle wrinkles
        d_edge = smoothstep(n1 - 0.6 * MM, n1 + 0.2 * MM, dd) * top * on_tip * smoothstep(1.15, 0.8, np.abs(lx) / np.maximum(wn, 1e-4))
        dirt[idx] = np.maximum(dirt[idx], 0.75 * d_edge + 0.5 * groove)

        H[idx] += hh
        crease[idx] += cr
        rough[idx] = 0.56 - 0.25 * inside + 0.06 * knuck

    # ------------------------------------------------------------------ palm
    pidx = np.nonzero(skin & (seg_k < 0) | (skin & (seg_chain == 'thumb')) | (skin & (seg_k == 0)))[0]
    px, py = x[pidx], y[pidx]
    pal = smoothstep(0.1, -0.4, nz[pidx])
    dor = smoothstep(0.15, 0.6, nz[pidx])
    hp = np.zeros(pidx.size)
    cp = np.zeros(pidx.size)
    lines = [
        # (points, depth, sigma)
        ([(0.043, 0.059), (0.032, 0.063), (0.020, 0.067), (0.008, 0.072), (-0.002, 0.077), (-0.010, 0.082), (-0.016, 0.088)], 0.42 * MM, 0.36 * MM),   # heart
        ([(-0.041, 0.061), (-0.031, 0.058), (-0.019, 0.054), (-0.006, 0.050), (0.007, 0.045), (0.018, 0.040), (0.027, 0.035)], 0.40 * MM, 0.34 * MM),  # head
        ([(-0.040, 0.062), (-0.031, 0.054), (-0.023, 0.045), (-0.017, 0.035), (-0.0125, 0.024), (-0.0095, 0.013), (-0.0085, 0.003)], 0.48 * MM, 0.38 * MM),  # life
        ([(0.003, 0.010), (0.001, 0.025), (-0.001, 0.040), (-0.002, 0.050)], 0.14 * MM, 0.28 * MM),  # fate (faint)
        ([(0.030, 0.052), (0.020, 0.056), (0.012, 0.059)], 0.12 * MM, 0.25 * MM),  # small
        ([(-0.027, 0.0005), (-0.012, 0.0022), (0.000, 0.0026), (0.012, 0.0022), (0.028, 0.0005)], 0.30 * MM, 0.30 * MM),  # wrist 1
        ([(-0.026, -0.0045), (-0.010, -0.0035), (0.008, -0.0035), (0.026, -0.0045)], 0.22 * MM, 0.30 * MM),  # wrist 2
    ]
    for li, (pts, depth, sig) in enumerate(lines):
        d, arc = seg_dist2d(px + 0.0004 * vnoise(np.c_[P[pidx] * 400.0] + li), py, pts)
        taper = smoothstep(0.0, 0.12, arc) * smoothstep(1.0, 0.85, arc) if li < 5 else smoothstep(0.0, 0.08, arc) * smoothstep(1.0, 0.92, arc)
        var = 0.7 + 0.3 * vnoise(np.c_[P[pidx] * 150.0] + 3 * li)
        g = -depth * gauss(d, sig) * taper * var * pal
        hp += g
        cp += g
    # fine palm lines (many small creases) + dorsal skin cells
    rid = ridged(P[pidx] / (1.6 * MM), 2)
    fine = -0.035 * MM * smoothstep(0.80, 0.97, rid) * pal
    hp += fine
    cp += fine * 0.5
    rid2 = ridged(P[pidx] / (1.1 * MM) + 4.2, 2)
    hp -= 0.02 * MM * smoothstep(0.82, 0.97, rid2) * dor

    # extensor tendons (back of hand), fading toward the wrist and under the knuckles
    for f in hg.FINGERS:
        j0 = sk.chains[f].joints[0]
        pts = [(j0.x * 0.28, -0.004), (j0.x * 0.62, 0.035), (j0.x * 0.92, j0.y - 0.020), (j0.x, j0.y - 0.007)]
        d, arc = seg_dist2d(px, py, pts)
        fade = smoothstep(0.0, 0.45, arc) * smoothstep(1.0, 0.88, arc)
        amp = 0.55 if f != 'pinky' else 0.35
        hp += amp * MM * gauss(d, 1.7 * MM) * fade * dor
    # veins (dorsal venous network), slightly meandering
    veins = [
        [(-0.0175, 0.066), (-0.0205, 0.052), (-0.0235, 0.036), (-0.0265, 0.018), (-0.0275, 0.002), (-0.0270, -0.010)],
        [(0.0205, 0.062), (0.0185, 0.047), (0.0150, 0.032), (0.0130, 0.016), (0.0140, 0.000), (0.0160, -0.010)],
        [(-0.0235, 0.036), (-0.0120, 0.043), (0.0010, 0.045), (0.0120, 0.042), (0.0150, 0.032)],
        [(0.0010, 0.045), (0.0010, 0.060), (-0.0010, 0.072)],
    ]
    for vi, pts in enumerate(veins):
        d, arc = seg_dist2d(px + 0.0007 * vnoise(np.c_[P[pidx] * 160.0] + 20 + vi), py, pts)
        fade = smoothstep(0.0, 0.1, arc) * smoothstep(1.0, 0.9, arc) * (0.75 if vi >= 2 else 1.0)
        g = gauss(d, 1.15 * MM) * fade * dor
        hp += 0.34 * MM * g
        vein_w[pidx] = np.maximum(vein_w[pidx], g)
    # scratches (weathered): thin scabbed lines on the back of the hand
    scr = [
        ([(-0.022, 0.040), (-0.017, 0.046), (-0.013, 0.050)], 0.2 * MM),
        ([(0.024, 0.026), (0.028, 0.034)], 0.16 * MM),
        ([(-0.006, 0.020), (0.000, 0.0225), (0.006, 0.0235)], 0.14 * MM),
    ]
    for pts, wdt in scr:
        d, arc = seg_dist2d(px, py, pts)
        g = gauss(d, wdt) * smoothstep(0.0, 0.2, arc) * smoothstep(1.0, 0.8, arc) * dor
        hp += 0.04 * MM * g
        scab_w[pidx] = np.maximum(scab_w[pidx], g * 0.8)
    H[pidx] += hp
    crease[pidx] += cp

    # ------------------------------------------------------------------ micro relief (all skin)
    sidx = np.nonzero(skin)[0]
    H[sidx] += 0.010 * MM * fbm(P[sidx] / (0.35 * MM), 2)
    rid3 = ridged(P[sidx] / (2.6 * MM) + 7.7, 2)
    H[sidx] -= 0.018 * MM * smoothstep(0.86, 0.98, rid3)

    # ------------------------------------------------------------------ skin albedo
    col = np.zeros((n, 3))
    pw = palmness[:, None]
    base = c_back * (1 - pw) + c_palm * pw
    mott = fbm(P / (9 * MM), 3)[:, None]
    mott2 = fbm(P / (2.5 * MM) + 3.3, 2)[:, None]
    base = base * (1 + 0.10 * mott + 0.04 * mott2)
    # subtle warm/cool variation
    base = base * (1 + np.array([0.03, -0.01, -0.03]) * fbm(P / (14 * MM) + 9.1, 2)[:, None])
    base = base * (1 - redness[:, None] * 0.55) + c_knuckle * redness[:, None] * 0.55
    base = base * (1 - tipness[:, None] * 0.5) + c_tip * tipness[:, None] * 0.5
    base = base * (1 - vein_w[:, None] * 0.35) + c_vein * vein_w[:, None] * 0.35
    # nails
    nw = nail_w[:, None]
    ncol = c_nail * (1 - lunula_w[:, None]) + c_lunula * lunula_w[:, None]
    ncol = ncol * (1 - free_w[:, None]) + c_free * free_w[:, None]
    ncol = ncol * (1 + 0.04 * fbm(P / (0.8 * MM), 2)[:, None])
    base = base * (1 - nw) + ncol * nw
    # cavity darkening from creases
    cav = smoothstep(0.0, -0.32 * MM, crease)[:, None]
    base = base * (1 - 0.30 * cav)
    # grime: in deep creases on the back / knuckles, plus random smudges
    smudge = smoothstep(0.35, 0.75, fbm(P / (6 * MM) + 13.0, 3)) * (1 - palmness) * 0.35
    dirt_t = np.clip(dirt + cav[:, 0] * 0.5 * (1 - palmness * 0.5) + smudge * 0.4, 0, 1)
    base = base * (1 - 0.6 * dirt_t[:, None]) + c_dirt * 0.6 * dirt_t[:, None]
    base = base * (1 - scab_w[:, None]) + c_scab * scab_w[:, None]
    # slight overall desaturation (reads under moonlight and a white flash)
    lum = (base @ np.array([0.2126, 0.7152, 0.0722]))[:, None]
    base = lum + (base - lum) * 0.86
    col[skin] = base[skin]
    rough = rough + 0.10 * dirt_t + 0.05 * cav[:, 0] - 0.04 * palmness + 0.035 * fbm(P / (1.5 * MM) + 2.0, 2)

    # ------------------------------------------------------------------ cuff (ribbed knit)
    cidx = np.nonzero(cuff)[0]
    if cidx.size:
        pc = P[cidx]
        ax_, az_, cz = 0.0335, 0.0228, 0.0012
        phi = np.arctan2((pc[:, 2] - cz) / az_, pc[:, 0] / ax_)
        NRIB = 56
        rib = 0.5 + 0.5 * np.cos(NRIB * phi)
        col_idx = (NRIB * phi / (2 * math.pi)) % 1.0
        stitch_phase = pc[:, 1] / (2.1 * MM) + 0.9 * np.abs(((NRIB * phi / (2 * math.pi) + 0.5) % 1.0) - 0.5)
        stitch = 0.5 + 0.5 * np.cos(2 * math.pi * stitch_phase)
        fuzz = fbm(pc / (0.45 * MM), 2)
        hc = 0.62 * MM * rib ** 0.7 + 0.20 * MM * stitch * rib + 0.03 * MM * fuzz
        inner = cuff_in[cidx]
        hc[inner] *= 0.3
        H[cidx] = hc
        yarn = srgb_to_lin([0.215, 0.218, 0.200])
        var = 1 + 0.10 * fbm(pc / (5 * MM), 2) + 0.05 * vnoise(np.c_[np.floor(NRIB * phi / (2 * math.pi)), np.floor(pc[:, 1] / (2.1 * MM)), np.zeros(cidx.size)] * 1.0)
        shade = 0.62 + 0.38 * rib ** 0.8 * (0.75 + 0.25 * stitch)
        # rim wear: the rolled edge is a little lighter / dustier
        wear = smoothstep(-0.013, -0.007, pc[:, 1]) * 0.25
        cc = yarn[None, :] * (shade * var)[:, None]
        cc = cc * (1 - wear[:, None]) + srgb_to_lin([0.33, 0.32, 0.29])[None, :] * wear[:, None]
        cc[inner] = srgb_to_lin([0.045, 0.045, 0.045])
        col[cidx] = cc
        rough[cidx] = 0.93 - 0.05 * rib
        _ = col_idx
    rough = np.clip(rough, 0.18, 0.98)
    return H, col, rough


def build() -> None:
    """Helper module (imported by hands.py): nothing to build on its own."""
