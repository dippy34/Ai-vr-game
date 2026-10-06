"""
Player head geometry (avatar_head.glb): a survivor in a knit beanie with a bandana pulled over the
nose and mouth. Only the eyes and the strip of face around them show.

Blender space, meters: origin = midpoint between the eyeball centres, face toward +Y, +Z up,
the avatar's right on +X.

Every layer is ray-cast onto one smooth signed-distance "head" (cranium, face mass, jaw, neck,
nose, brow ridges, cheekbones, eye sockets) at its own offset, so the beanie, bandana and skin can
never intersect each other. The visible face is triangulated with a constrained Delaunay
triangulation around concentric loops that follow the almond-shaped eye openings; the innermost
loop (the lid margin) sits on the eyeball.
"""

from __future__ import annotations

import math

import numpy as np
from mathutils import Vector
from mathutils.geometry import delaunay_2d_cdt

EYE_X = 0.0315          # half interpupillary distance
EYE_R = 0.0120          # eyeball radius
AXIS_Y = -0.070         # vertical axis for cylindrical layers (behind the eyes)


# ---------------------------------------------------------------------------------------------
# SDF
# ---------------------------------------------------------------------------------------------

def sd_ellipsoid(p, c, r):
    q = (p - np.asarray(c)) / np.asarray(r)
    k0 = np.linalg.norm(q, axis=-1)
    k1 = np.linalg.norm(q / np.asarray(r), axis=-1)
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def sd_capsule(p, a, b, ra, rb):
    a = np.asarray(a)
    b = np.asarray(b)
    ba = b - a
    t = np.clip(((p - a) @ ba) / (ba @ ba), 0, 1)
    q = a + t[..., None] * ba
    return np.linalg.norm(p - q, axis=-1) - (ra + (rb - ra) * t)


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b * (1 - h) + a * h - k * h * (1 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def head_sdf(p: np.ndarray, sockets: bool = True) -> np.ndarray:
    d = sd_ellipsoid(p, (0, -0.078, 0.028), (0.0745, 0.0985, 0.091))           # cranium
    d = smin(d, sd_ellipsoid(p, (0, -0.036, -0.030), (0.0625, 0.066, 0.072)), 0.018)   # face mass
    d = smin(d, sd_ellipsoid(p, (0, -0.030, -0.078), (0.052, 0.056, 0.034)), 0.020)    # jaw / chin
    d = smin(d, sd_capsule(p, (0, -0.068, -0.07), (0, -0.060, -0.26), 0.054, 0.058), 0.025)  # neck
    for sx in (-1, 1):
        d = smin(d, sd_ellipsoid(p, (sx * 0.029, 0.0045, 0.0145), (0.024, 0.012, 0.0085)), 0.010)  # brow
        d = smin(d, sd_ellipsoid(p, (sx * 0.046, -0.004, -0.021), (0.022, 0.019, 0.015)), 0.012)   # cheekbone
        d = smin(d, sd_ellipsoid(p, (sx * 0.0135, 0.0235, -0.0355), (0.0095, 0.0085, 0.0075)), 0.004)  # ala
    d = smin(d, sd_capsule(p, (0, 0.0165, 0.004), (0, 0.0385, -0.033), 0.0050, 0.0105), 0.010)  # nose
    if sockets:
        for sx in (-1, 1):
            d = smax(d, -sd_ellipsoid(p, (sx * EYE_X, 0.0330, -0.0005), (0.0215, 0.0185, 0.0130)), 0.008)
    return d


def raycast(origins: np.ndarray, dirs: np.ndarray, offset, rmax: float = 0.25, steps: int = 160,
            sdf=head_sdf) -> np.ndarray:
    """Outermost distance along each ray where sdf == offset (marching inward from rmax)."""
    n = origins.shape[0]
    offset = np.broadcast_to(np.asarray(offset, dtype=np.float64), (n,))
    rs = np.linspace(rmax, 0.0, steps)
    prev = np.full(n, rmax)
    hit = np.full(n, np.nan)
    f_prev = sdf(origins + dirs * rmax) - offset
    for r in rs[1:]:
        f = sdf(origins + dirs * r) - offset
        new = np.isnan(hit) & (f <= 0) & (f_prev > 0)
        if new.any():
            lo = np.full(n, r)
            hi = prev.copy()
            for _ in range(30):
                mid = (lo + hi) / 2
                fm = sdf(origins + dirs * mid[:, None]) - offset
                inside = fm <= 0
                lo = np.where(inside, mid, lo)
                hi = np.where(inside, hi, mid)
            hit = np.where(new, (lo + hi) / 2, hit)
        f_prev = f
        prev = np.full(n, r)
        if not np.isnan(hit).any():
            break
    return np.nan_to_num(hit, nan=0.0)


def cyl_points(theta: np.ndarray, z: np.ndarray, offset, sdf=head_sdf) -> np.ndarray:
    o = np.stack([np.zeros_like(theta), np.full_like(theta, AXIS_Y), z], axis=-1)
    d = np.stack([np.sin(theta), np.cos(theta), np.zeros_like(theta)], axis=-1)
    r = raycast(o, d, offset, sdf=sdf)
    return o + d * r[:, None]


# ---------------------------------------------------------------------------------------------
# Layer boundaries (as functions of the azimuth, radians, 0 = front)
# ---------------------------------------------------------------------------------------------

def _keyed(a, keys):
    a = np.degrees(np.abs(np.asarray(a, dtype=np.float64)))
    xs, ys = zip(*keys)
    # smooth (cubic-ish) interpolation through keys
    return np.interp(a, xs, ys)


def beanie_edge_z(a):
    """Lower edge of the beanie's folded cuff: across the forehead, down over the ears, to the nape."""
    return _keyed(a, [(0, 0.0315), (20, 0.0290), (40, 0.0200), (60, 0.0040), (80, -0.0180), (98, -0.0330),
                      (125, -0.0420), (180, -0.0480)])


def bandana_top_z(a):
    """Upper edge of the bandana: over the nose bridge, under the cheekbones, around the back."""
    return _keyed(a, [(0, -0.0150), (12, -0.0175), (28, -0.0235), (50, -0.0275), (75, -0.0295), (110, -0.0315),
                      (180, -0.0340)])


def bandana_bottom_z(a):
    a = np.abs(np.asarray(a, dtype=np.float64))
    t = np.clip(a / math.pi, 0, 1)
    return -0.184 + 0.012 * t ** 0.8


# ---------------------------------------------------------------------------------------------
# Eyes
# ---------------------------------------------------------------------------------------------

def almond(n: int, w: float = 0.0290, hu: float = 0.0057, hl: float = 0.0043, tilt: float = 0.035):
    """Eye opening outline in local (u lateral, v up) meters, CCW starting at the medial corner."""
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        u = -math.cos(t) * w / 2               # medial (-) -> lateral (+)
        s = math.sin(t)
        x = (2 * u / w)
        if s >= 0:   # upper lid, peak slightly medial
            v = hu * (1 - x * x) ** 0.85 * (1 - 0.12 * x) * s / max(abs(s), 1e-9)
        else:
            v = -hl * (1 - x * x) ** 1.1 * (1 + 0.15 * x)
        v += tilt * u
        pts.append((u, v))
    return pts


def eye_angles(n: int):
    """Lid-margin outline as angles on the eyeball (deg): h lateral +, v up. Starts medial."""
    out = []
    for i in range(n):
        t = 2 * math.pi * i / n
        x = -math.cos(t)                       # -1 medial .. +1 lateral
        h = 6.0 + 55.0 * x
        if math.sin(t) >= 0:   # relaxed upper lid: covers the top of the iris
            v = 22.5 * (1 - x * x) ** 0.7 * (1 - 0.10 * x)
        else:
            v = -18.0 * (1 - x * x) ** 1.0 * (1 + 0.12 * x)
        v += 2.5 * x + 0.5
        out.append((h, v))
    return out


def build_face(spacing=0.0062):
    """Visible face strip + eye loops. Returns verts (n,3), tris, per-vertex tag, eye-ring info."""
    R0 = 0.085   # radius used to flatten azimuth into meters for the 2D triangulation
    NE = 22
    pts2: list[tuple[float, float]] = []
    tag: list[str] = []
    ring_ids: list[list[list[int]]] = []
    edges = []
    eye_info = []
    eye3d: dict[int, np.ndarray] = {}
    for sx in (-1, 1):
        e = np.array([sx * EYE_X, 0.0, 0.0])
        rings = []
        # lid margin (k=0), lid rim (k=1) and lid fold (k=2) are angular loops on the eyeball
        # (degrees: h lateral +, v up); k=3,4 grow outward in the face domain
        ang = eye_angles(NE)
        grow = [(0.0, 0.0, 0.00035), (3.0, 4.0, 0.0016), (9.0, 15.0, 0.0028)]
        prev2d = None
        for k in range(5):
            ids = []
            ring2d = []
            for i, (h, v) in enumerate(ang):
                if k < 3:
                    gl, gu, lift = grow[k]
                    hc, vc = 6.0, 2.0
                    dh, dv = h - hc, v - vc
                    ln = math.hypot(dh, dv) or 1.0
                    g = gu if v > vc else gl
                    hh = h + dh / ln * g * 0.6
                    vv = v + dv / ln * g
                    hr, vr = math.radians(hh), math.radians(vv)
                    d = np.array([sx * math.sin(hr) * math.cos(vr), math.cos(hr) * math.cos(vr), math.sin(vr)])
                    p3 = e + d * (EYE_R + lift)
                    th = math.atan2(p3[0], p3[1] - AXIS_Y)
                    q = (th * R0, p3[2])
                    eye3d[len(pts2)] = p3
                else:
                    # offset ring 2 outward in 2D
                    c2 = np.mean(np.array(prev2d), axis=0)
                    pv = np.array(prev2d[i])
                    dd = pv - c2
                    dd /= np.linalg.norm(dd)
                    off = (0.0042 if pv[1] < c2[1] else 0.0050) if k == 3 else (0.0088 if pv[1] < c2[1] else 0.0100)
                    base_ = np.array(ring2d_k2[i])
                    q = tuple(base_ + dd * off)
                ids.append(len(pts2))
                pts2.append(q)
                ring2d.append(q)
                tag.append(f'eye{k}')
            if k == 2:
                ring2d_k2 = ring2d
            prev2d = ring2d if k < 3 else prev2d
            for i in range(NE):
                edges.append((ids[i], ids[(i + 1) % NE]))
            rings.append(ids)
        ring_ids.append(rings)
        eye_info.append(sx)
    # grid points outside the eye rings, inside the visible strip (+ tuck-under margins)
    th_max = math.radians(102)
    us = np.arange(-th_max * R0, th_max * R0 + 1e-9, spacing)
    zs = np.arange(-0.050, 0.050 + 1e-9, spacing * 0.92)
    outer = [np.array([pts2[i] for i in rings[-1]]) for rings in ring_ids]
    for j, z in enumerate(zs):
        for u in us:
            uj = u + (spacing * 0.5 if j % 2 else 0.0)
            th = uj / R0
            if abs(th) > th_max:
                continue
            ztop = float(beanie_edge_z(th)) + 0.013
            zbot = float(bandana_top_z(th)) - 0.012
            if z > ztop + spacing or z < zbot - spacing:
                continue
            # sparser where it's hidden
            hidden = z > ztop - 0.004 or z < zbot + 0.004 or abs(th) > math.radians(75)
            if hidden and (j % 2 == 1 or int(round(u / spacing)) % 2 == 1):
                continue
            pnt = np.array([uj, z])
            ok = True
            for o in outer:
                c = o.mean(axis=0)
                # inside (scaled) outer eye ring?
                rel = (o - c)
                d = pnt - c
                ang = math.atan2(d[1], d[0])
                angs = np.arctan2(rel[:, 1], rel[:, 0])
                k = int(np.argmin(np.abs(np.angle(np.exp(1j * (angs - ang))))))
                if np.linalg.norm(d) < np.linalg.norm(rel[k]) + spacing * 0.55:
                    ok = False
                    break
            if ok:
                pts2.append((uj, z))
                tag.append('face')
    vin = [Vector((p[0], p[1])) for p in pts2]
    out = delaunay_2d_cdt(vin, edges, [], 0, 1e-7, True)
    vco, _, faces, orig_v = out[0], out[1], out[2], out[3]
    # map output verts -> input index (for tags)
    vtag = []
    for ov in orig_v:
        vtag.append(tag[ov[0]] if ov else 'face')
    # drop triangles inside the lid margin (eye openings) and outside the strip
    margin_polys = [np.array([pts2[i] for i in rings[0]]) for rings in ring_ids]

    def inside_poly(pt, poly):
        x, y = pt
        c = False
        n = len(poly)
        for i in range(n):
            x0, y0 = poly[i]
            x1, y1 = poly[(i + 1) % n]
            if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
                c = not c
        return c

    keep = []
    for f in faces:
        cx = sum(vco[i].x for i in f) / 3
        cy = sum(vco[i].y for i in f) / 3
        th = cx / R0
        if any(inside_poly((cx, cy), poly) for poly in margin_polys):
            continue
        ztop = float(beanie_edge_z(th)) + 0.013
        zbot = float(bandana_top_z(th)) - 0.012
        if cy > ztop + 0.002 or cy < zbot - 0.002:
            continue
        # avoid slivers on the hull
        a = vco[f[0]]
        b = vco[f[1]]
        c2 = vco[f[2]]
        area = abs((b - a).x * (c2 - a).y - (b - a).y * (c2 - a).x) / 2
        if area < 1e-9:
            continue
        keep.append(tuple(f))
    used = sorted({i for f in keep for i in f})
    remap = {old: new for new, old in enumerate(used)}
    uv2 = np.array([[vco[i].x, vco[i].y] for i in used])
    tags = [vtag[i] for i in used]
    tris = [tuple(remap[i] for i in f) for f in keep]

    # ---- lift to 3D
    theta = uv2[:, 0] / R0
    z = uv2[:, 1]
    P = cyl_points(theta, z, 0.0)
    # eye rings 0..2 sit exactly on the eyeball (+ lid thickness); 3 blends into the socket
    for new, old in enumerate(used):
        ov = orig_v[old][0] if orig_v[old] else None
        if ov is not None and ov in eye3d:
            P[new] = eye3d[ov]
    for i, tg in enumerate(tags):
        if tg == 'eye3':
            sx = 1 if P[i, 0] > 0 else -1
            e = np.array([sx * EYE_X, 0.0, 0.0])
            d = P[i] - e
            dn = d / np.linalg.norm(d)
            on = e + dn * (EYE_R + 0.0034)
            P[i] = P[i] * 0.55 + on * 0.45
    return P, tris, tags, uv2


def eyeball(sx: int, segs: int = 12, rings: int = 6, max_deg: float = 112.0):
    """Front part of an eyeball (pole = cornea), slight corneal bulge."""
    e = np.array([sx * EYE_X, 0.0, 0.0])
    verts = [e + np.array([0, EYE_R + 0.0007, 0])]
    faces = []
    for k in range(1, rings + 1):
        a = math.radians(max_deg) * (k / rings) ** 1.15
        rr = EYE_R + 0.0007 * max(0.0, 1 - a / math.radians(32)) ** 2
        for j in range(segs):
            b = 2 * math.pi * j / segs
            dvec = np.array([math.sin(a) * math.cos(b), math.cos(a), math.sin(a) * math.sin(b)])
            verts.append(e + dvec * rr)
    for j in range(segs):
        faces.append((0, 1 + j, 1 + (j + 1) % segs))
    for k in range(1, rings):
        o0 = 1 + (k - 1) * segs
        o1 = 1 + k * segs
        for j in range(segs):
            j1 = (j + 1) % segs
            faces.append((o0 + j, o1 + j, o1 + j1, o0 + j1))
    return np.array(verts), faces


def grid_layer(cols: int, rows_fn, point_fn, closed=True):
    """Generic (azimuth x row) quad grid. rows_fn(a) -> list of row params, point_fn(a, rows) -> (rows,3)."""
    verts = []
    cols_pts = []
    for ci in range(cols):
        a = 2 * math.pi * ci / cols
        a = (a + math.pi) % (2 * math.pi) - math.pi
        pts = point_fn(a, rows_fn(a))
        cols_pts.append(pts)
    nr = len(cols_pts[0])
    for pts in cols_pts:
        verts.extend(pts)
    faces = []
    for ci in range(cols if closed else cols - 1):
        cj = (ci + 1) % cols
        for r in range(nr - 1):
            faces.append((ci * nr + r, cj * nr + r, cj * nr + r + 1, ci * nr + r + 1))
    return np.array(verts), faces, nr


BEANIE_C = np.array([0.0, -0.078, 0.030])
BEANIE_CUFF_V = 0.745   # row parameter where the folded cuff starts


def beanie_psi_edge(a):
    zb = beanie_edge_z(a)
    return np.arccos(np.clip((zb - BEANIE_C[2]) / 0.098, -1, 1)) + 0.03


def beanie_coords(P: np.ndarray):
    """(azimuth, v) of points on the beanie: v = 0 top .. 1 cuff bottom."""
    d = P - BEANIE_C
    a = np.arctan2(d[:, 0], d[:, 1])
    psi = np.arccos(np.clip(d[:, 2] / np.linalg.norm(d, axis=1), -1, 1))
    return a, psi / beanie_psi_edge(a), psi


def build_beanie(cols: int = 28):
    """Slouchy knit beanie: crown + a folded cuff (thicker, rolled lower edge)."""
    C = BEANIE_C
    # row parameter v: 0 = top .. 1 = cuff bottom; offsets (m) from the head surface
    vrow = [0.05, 0.14, 0.24, 0.34, 0.45, 0.56, 0.665, 0.735, 0.75, 0.80, 0.88, 0.95, 1.0, 1.0]
    off = [0.0068, 0.0068, 0.0066, 0.0063, 0.0060, 0.0056, 0.0053, 0.0053, 0.0090, 0.0097, 0.0099, 0.0095, 0.0075, 0.0035]

    def point_fn(a, _):
        # polar angle of the cuff bottom for this azimuth, from the target z
        zb = float(beanie_edge_z(a))
        # slouch: more volume at the top / back
        pts = []
        dir_b = None
        for v, o in zip(vrow, off):
            # interpolate the direction between the top pole and the cuff-bottom direction
            psi_edge = beanie_psi_edge(a)
            psi = v * psi_edge
            d = np.array([math.sin(psi) * math.sin(a), math.sin(psi) * math.cos(a), math.cos(psi)])
            slouch = 0.0045 * (1 - v) ** 1.5 * (0.6 + 0.4 * -math.cos(a))
            r = raycast(C[None], d[None], np.array([o + slouch]))[0]
            p = C + d * r
            pts.append(p)
        # last row tucks under (inner edge of the fold)
        pts[-1] = pts[-1] + np.array([0, 0, 0.004])
        return np.array(pts)

    verts, faces, nr = grid_layer(cols, lambda a: None, point_fn)
    # cap the top with a fan
    top = len(verts)
    cap = C + np.array([0, -0.004, 1.0]) * raycast(C[None], np.array([[0, -0.04, 1.0]]) / np.linalg.norm([0, -0.04, 1.0]), np.array([0.0095]))[0]
    verts = np.vstack([verts, cap[None]])
    for ci in range(cols):
        cj = (ci + 1) % cols
        faces.append((top, cj * nr, ci * nr))
    return verts, faces, nr, vrow


def build_bandana(cols: int = 30, rows: int = 11):
    """Bandana over nose + mouth, wrapped around the head, hanging in a point over the throat."""
    def point_fn(a, _):
        zt = float(bandana_top_z(a))
        zb = float(bandana_bottom_z(a))
        zs = np.array([zt + 0.0018] + list(np.linspace(zt, zb, rows - 1)))
        th = np.full(rows, a)
        # under-surface: head + offset, with the cloth tenting from the nose tip to the chin and
        # hanging free in front of the throat
        base = cyl_points(th, zs, 0.0042)
        r = np.linalg.norm(base[:, :2] - np.array([0, AXIS_Y]), axis=1)
        front = math.cos(a)
        if front > 0:
            # tent line: straight from nose tip (z -0.036, y +0.047) to the chin and down
            y_t = np.interp(zs, [-0.19, -0.16, -0.13, -0.10, -0.060, -0.036, -0.02], [0.014, 0.020, 0.026, 0.030, 0.040, 0.046, 0.034])
            r_t = (y_t - AXIS_Y) * (front ** 0.55) * (1 - 0.10 * (1 - front))
            r = np.maximum(r, r_t)
        # drape folds in the hanging part (below the chin), strongest at the bottom
        hang = np.clip((-0.095 - zs) / 0.07, 0, 1) ** 1.2 * max(front, 0.0) ** 0.6
        r = r + 0.0028 * hang * np.sin(9.0 * a + 0.7 + 2.0 * hang)
        dirs = np.stack([np.sin(th), np.cos(th), np.zeros_like(th)], axis=-1)
        pts = np.stack([np.zeros_like(th), np.full_like(th, AXIS_Y), zs], axis=-1) + dirs * r[:, None]
        # first row: rolled hem lip (tucked inward)
        pts[0] = pts[0] - dirs[0] * 0.0020
        return pts

    verts, faces, nr = grid_layer(cols, lambda a: None, point_fn)
    return verts, faces, nr


def build() -> None:
    """Helper module (imported by avatar.py): nothing to build on its own."""
