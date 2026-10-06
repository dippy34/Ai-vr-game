"""
2D image synthesis for MUTE's story decals (numpy only): bloody handprints, claw gouges, a dried
drag trail, black mold, wall scrawls ("IT HEARS YOU", "SHHH" + tally marks, "DON'T TALK") and a
child's crayon drawing taped to the wall.

Every decal function returns (rgba, normal_or_None): float32 HxWx4 straight alpha (sRGB color),
top row first (row 0 = the decal's TOP: wall decals = up, floor decals = model forward).

Helper module only: build() is a no-op. `save_png` writes debug images without Blender.
"""

from __future__ import annotations

import math
import struct
import zlib

import numpy as np

import decals_hand as H
from dressing_img import blur, hexa, lerp, smooth, vnoise


def build() -> None:
    print('decals_img: helper module (built through decals.py)')


# =============================================================================================
# Basics
# =============================================================================================

def save_png(path, a):
    """Debug PNG writer (no PIL in the Blender venv). a: HxW, HxWx3 or HxWx4 floats 0..1."""
    a = np.nan_to_num(np.clip(a, 0, 1))
    if a.ndim == 2:
        a = np.stack([a] * 3, -1)
    h, w, c = a.shape
    raw = (a * 255 + 0.5).astype(np.uint8)
    rows = b''.join(b'\x00' + raw[y].tobytes() for y in range(h))
    ct = {3: 2, 4: 6}[c]

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, ct, 0, 0, 0)) +
                chunk(b'IDAT', zlib.compress(rows, 6)) + chunk(b'IEND', b''))


def over(rgb, alpha, src_rgb, src_a):
    """Composite straight-alpha src over (rgb, alpha) in place-free form; returns (rgb, alpha)."""
    sa = np.clip(src_a, 0, 1)[..., None]
    da = np.clip(alpha, 0, 1)[..., None]
    out_a = sa + da * (1 - sa)
    src = np.broadcast_to(np.asarray(src_rgb, np.float32), rgb.shape)
    out = (src * sa + rgb * da * (1 - sa)) / np.maximum(out_a, 1e-5)
    return out, out_a[..., 0]


def resize(a, w, h):
    """Bilinear resize (box-prefiltered when shrinking) of an HxW[xC] float image."""
    sh, sw = a.shape[:2]
    if (sh, sw) == (h, w):
        return a
    if h < sh:
        a = blur(a, 0.45 * sh / h) if a.ndim == 2 else np.stack([blur(a[..., c], 0.45 * sh / h) for c in range(a.shape[2])], -1)
    if w < sw:
        a = blur(a, 0.45 * sw / w) if a.ndim == 2 else np.stack([blur(a[..., c], 0.45 * sw / w) for c in range(a.shape[2])], -1)
    ys = np.clip((np.arange(h) + 0.5) * sh / h - 0.5, 0, sh - 1)
    xs = np.clip((np.arange(w) + 0.5) * sw / w - 0.5, 0, sw - 1)
    y0 = np.floor(ys).astype(int)
    x0 = np.floor(xs).astype(int)
    y1 = np.minimum(y0 + 1, sh - 1)
    x1 = np.minimum(x0 + 1, sw - 1)
    ty = (ys - y0)[:, None]
    tx = (xs - x0)[None, :]
    if a.ndim == 3:
        ty, tx = ty[..., None], tx[..., None]
    top = a[y0][:, x0] * (1 - tx) + a[y0][:, x1] * tx
    bot = a[y1][:, x0] * (1 - tx) + a[y1][:, x1] * tx
    return (top * (1 - ty) + bot * ty).astype(np.float32)


def standard(img, tex=(512, 1024)):
    """
    Every decal ships the same texture size (so the renderer's batcher can stack them all into one
    texture array = one draw call). Portrait decals are resized to tex; landscape ones are resized
    to (tex[1] x tex[0]) and stored rotated 90 deg CCW (decals_lib.quad(rot90=True) maps it back).
    Returns (image, rotated).
    """
    h, w = img.shape[:2]
    if w > h:
        r = resize(img, tex[1], tex[0])
        return np.ascontiguousarray(np.rot90(r, 1)), True
    return resize(img, tex[0], tex[1]), False


def rgba(rgb, a):
    return np.concatenate([np.clip(rgb, 0, 1), np.clip(a, 0, 1)[..., None]], -1).astype(np.float32)


def grid(w, h):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    return xx + 0.5, yy + 0.5


def normal_from_height(hgt, strength=1.0):
    """Tangent-space normal map (OpenGL, +Y = image up) from a height map (top row first)."""
    gx = np.zeros_like(hgt)
    gy = np.zeros_like(hgt)
    gx[:, 1:-1] = (hgt[:, 2:] - hgt[:, :-2]) * 0.5
    gy[1:-1, :] = (hgt[2:, :] - hgt[:-2, :]) * 0.5  # + = height grows DOWN the image
    nx = -gx * strength
    ny = gy * strength  # image up = -row, so d/d(up) = -gy and n.y = -d/d(up)
    nz = np.ones_like(hgt)
    L = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / L * 0.5 + 0.5, ny / L * 0.5 + 0.5, nz / L * 0.5 + 0.5], -1).astype(np.float32)


def capsule(xx, yy, ax, ay, bx, by, ra, rb):
    """Signed distance (px) to a tapered capsule a->b (radii ra at a, rb at b)."""
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy + 1e-9
    t = np.clip(((xx - ax) * dx + (yy - ay) * dy) / L2, 0, 1)
    px = ax + t * dx - xx
    py = ay + t * dy - yy
    return np.sqrt(px * px + py * py) - (ra + (rb - ra) * t)


def feather_edges(a, w, h, margin=0.04, seed=0):
    """Fade alpha to 0 at the image border so no decal ever shows a hard quad edge."""
    xx, yy = grid(w, h)
    U, V = xx / w, yy / h
    d = np.minimum(np.minimum(U, 1 - U), np.minimum(V, 1 - V))
    n = vnoise(w, h, 40, seed, 3)
    return a * smooth(d + (n - 0.5) * margin * 0.8, 0.0, margin)


# =============================================================================================
# Dried blood
# =============================================================================================

BLOOD_THICK = hexa('1e0504')
BLOOD_MID = hexa('420b07')
BLOOD_THIN = hexa('5e1c11')


def blood_rgba(T, seed, w, h, alpha_max=0.96):
    """Thickness map -> dried-blood color + alpha (thin = translucent brown, thick = near black)."""
    a = smooth(T, 0.02, 0.32)
    col = lerp(BLOOD_THIN, BLOOD_MID, smooth(T, 0.08, 0.45))
    col = lerp(col, BLOOD_THICK, smooth(T, 0.45, 1.1))
    # Coffee-ring: pigment migrates to the edge of a drying smear.
    edge = smooth(T, 0.05, 0.14) * (1 - smooth(T, 0.16, 0.42))
    col = lerp(col, BLOOD_THICK, edge * 0.45)
    grain = vnoise(w, h, 2.5, seed, 2)
    flake = smooth(vnoise(w, h, 6, seed + 1, 3), 0.7, 0.78) * smooth(T, 0.4, 0.9)
    col = col * (0.88 + 0.22 * grain)[..., None]
    col = lerp(col, BLOOD_THIN * 1.1, flake * 0.35)  # cracked flakes catch the light
    alpha = np.clip(a * (0.85 + 0.2 * grain), 0, 1) * alpha_max
    return col, alpha


def smear(T, dx, dy, steps, decay=1.5, streak=None):
    """Drag thickness T along (dx, dy) px per step, fading; `streak` (HxW) modulates the trail."""
    out = T.copy()
    h, w = T.shape
    for k in range(1, steps + 1):
        sx, sy = int(round(dx * k)), int(round(dy * k))
        sh = np.zeros_like(T)
        ys0, ys1 = max(0, sy), min(h, h + sy)
        xs0, xs1 = max(0, sx), min(w, w + sx)
        sh[ys0:ys1, xs0:xs1] = T[ys0 - sy:ys1 - sy, xs0 - sx:xs1 - sx]
        f = (1 - k / (steps + 1)) ** decay
        if streak is not None:
            f = f * streak
        out = np.maximum(out, sh * f)
    return out


def drip(T, x, y, length, width, rng, w, h):
    """A run of blood down from (x, y): wavering, thinning line with a small bead at the end."""
    n = max(4, int(length / 6))
    pts = []
    xs = x
    for k in range(n + 1):
        t = k / n
        xs += rng.normal(0, 0.35)
        pts.append((xs, y + length * t))
    pts = np.asarray(pts, np.float32)
    t = np.linspace(0, 1, n + 1, dtype=np.float32)
    widths = width * (1.0 - 0.55 * t) * (0.85 + 0.3 * rng.random(n + 1).astype(np.float32))
    dens = (0.55 + 0.35 * t).astype(np.float32)
    H.stroke_cov(T, pts, widths, dens, soft=0.8)
    bx, by = float(pts[-1][0]), float(pts[-1][1]) + width * 0.2
    r = width * rng.uniform(0.55, 0.8)
    H.stroke_cov(T, np.array([(bx, by), (bx, by + r * 0.6)], np.float32), np.array([r * 2, r * 1.6], np.float32),
                 np.array([0.95, 0.95], np.float32), soft=0.8)
    return T


# =============================================================================================
# Handprints
# =============================================================================================

FINGERS = (  # (base x, base y, length, radius, splay deg) in mm, palm center origin, fingers up (-y)
    (-29, -42, 64, 9.0, -9),
    (-9, -47, 74, 9.5, -2),
    (11, -45, 69, 9.0, 4),
    (30, -38, 52, 7.8, 12),
)


def hand_print(w, h, cx, cy, mm, angle, right=True, seed=0, pressure=1.0, fingers_only=False):
    """Thickness map of one bloody handprint (palm on the wall, seen from the front)."""
    rng = np.random.default_rng(seed)
    xx, yy = grid(w, h)
    c, s = math.cos(angle), math.sin(angle)
    # to hand space (mm)
    lx = ((xx - cx) * c + (yy - cy) * s) / mm
    ly = (-(xx - cx) * s + (yy - cy) * c) / mm
    if not right:
        lx = -lx
    m = np.zeros((h, w), np.float32)
    pad = np.zeros((h, w), np.float32)
    for (bx, by, L, r, sp) in FINGERS:
        a = math.radians(sp)
        tx, ty = bx + math.sin(a) * L, by - math.cos(a) * L
        d = capsule(lx, ly, bx, by, tx, ty, r, r * 0.88)
        f = smooth(-d, -1.2, 1.5)
        # joint creases: no contact across the finger at two knuckles
        t = np.clip(((lx - bx) * (tx - bx) + (ly - by) * (ty - by)) / (L * L), 0, 1)
        crease = 1 - 0.85 * (np.exp(-((t - 0.38) / 0.035) ** 2) + np.exp(-((t - 0.68) / 0.03) ** 2))
        m = np.maximum(m, f * crease)
        pad = np.maximum(pad, f * smooth(t, 0.7, 0.95))
    # thumb (on the -x side for a right hand seen from the front)
    d = capsule(lx, ly, -36, 12, -66, -28, 12.0, 10.0)
    m = np.maximum(m, smooth(-d, -1.2, 1.5) * (0.0 if fingers_only else 1.0))
    if not fingers_only:
        # palm: a rounded square, heel heavier, hollow in the middle barely touches
        pd = (np.abs(lx / 44) ** 3.2 + np.abs((ly - 5) / 50) ** 3.2) ** (1 / 3.2) - 1
        palm = smooth(-pd * 40, -1.2, 1.5)
        hollow = np.exp(-((lx + 2) / 22) ** 2 - ((ly + 2) / 20) ** 2)
        heel = smooth(ly, 10, 45)
        palm = palm * (1 - 0.75 * hollow) * (0.7 + 0.5 * heel)
        # palm lines (creases) leave gaps
        for (x0, y0, x1, y1) in ((-44, -12, 30, -26), (-44, 2, 14, -6), (-10, 40, -18, -18)):
            dd = capsule(lx, ly, x0, y0, x1, y1, 1.5, 1.5)
            palm *= 1 - 0.7 * smooth(-dd, -1.0, 1.0)
        m = np.maximum(m, palm)
    contact = vnoise(w, h, max(3.0, 9 * mm), seed, 4)
    contact = smooth(contact, 0.22, 0.6) * 0.75 + 0.25
    T = m * contact * pressure + pad * 0.3 * pressure
    return np.clip(T, 0, 1.4)


def _finger_streaks(w, h, seed, mm, cx, angle, contrast=0.85):
    """Across-the-drag modulation (constant along the drag): finger lines + palm streaks."""
    rng = np.random.default_rng(seed)
    xx, _ = grid(w, h)
    lx = (xx - cx) / mm
    m = 0.25 + 0.2 * vnoise(w, 1, 2.5, seed, 3)[0][None, :].repeat(h, 0)
    for (bx, _, _, r, sp) in FINGERS:
        fx = bx + math.sin(math.radians(sp)) * 40 + rng.normal(0, 2)
        m = np.maximum(m, np.exp(-((lx - fx * math.cos(angle)) / (r * 0.75)) ** 2))
    fine = vnoise(w, 1, 1.5, seed + 1, 2)[0][None, :].repeat(h, 0)
    return np.clip(m * (1 - contrast * 0.5 + contrast * 0.5 * fine), 0, 1)


def decal_handprints(w=512, h=1024, seed=101):
    """Bloody hands on a wall: one dragged a long way down (someone sliding down it), one pressed
    flat and twisted, and a last fingers-only grab low down."""
    rng = np.random.default_rng(seed)
    mm = w / 600.0  # 0.6 m wide
    xx, yy = grid(w, h)
    # A: left hand high, dragged down: the print smears into finger streaks below it
    ax, ay = w * 0.34, h * 0.16
    a = hand_print(w, h, ax, ay, mm, math.radians(-12), right=False, seed=seed, pressure=1.15)
    a_sm = smear(a * 0.8, 0.18, 4.0, 70, 1.9, _finger_streaks(w, h, seed + 3, mm, ax, -0.2))
    T = np.maximum(a, a_sm * 0.75)
    # B: right hand, pressed flat, slight twist smudge
    bx, by = w * 0.69, h * 0.43
    b = hand_print(w, h, bx, by, mm, math.radians(9), right=True, seed=seed + 7, pressure=1.0)
    b = np.maximum(b, smear(b * 0.5, 1.2, 1.6, 7, 2.0) * 0.7)
    T = np.maximum(T, b)
    # C: fingers only, low: a last grab, dragged a little
    cx_, cy_ = w * 0.42, h * 0.77
    c = hand_print(w, h, cx_, cy_, mm, math.radians(-4), right=True, seed=seed + 11, pressure=0.9, fingers_only=True)
    c = np.maximum(c, smear(c * 0.8, 0.1, 3.5, 30, 2.2, _finger_streaks(w, h, seed + 12, mm, cx_, 0.0)) * 0.7)
    T = np.maximum(T, c)
    # runs from the thickest spots
    for k in range(7):
        x = w * rng.uniform(0.22, 0.8)
        y = h * rng.uniform(0.14, 0.6)
        if T[int(min(h - 1, y)), int(min(w - 1, x))] < 0.45:
            continue
        T = drip(T, x, y, h * rng.uniform(0.03, 0.16), rng.uniform(2.5, 4.0) * mm * 1.3, rng, w, h)
    # spatter
    for k in range(18):
        r = rng.uniform(0.7, 2.6) * mm * 1.4
        x0, y0 = w * rng.uniform(0.1, 0.9), h * rng.uniform(0.05, 0.9)
        T = np.maximum(T, smooth(-(np.sqrt((xx - x0) ** 2 + (yy - y0) ** 2) - r), -0.8, 0.8) * rng.uniform(0.3, 0.9))
    T = blur(T, 0.5)
    col, alpha = blood_rgba(T, seed, w, h)
    alpha = feather_edges(alpha, w, h, 0.03, seed)
    return rgba(col, alpha), None


# =============================================================================================
# Claw gouges
# =============================================================================================

def decal_scratches(w=512, h=1024, seed=202):
    """Deep claw gouges: sets of four parallel grooves, torn edges, exposed pale material."""
    rng = np.random.default_rng(seed)
    mm = w / 550.0
    xx, yy = grid(w, h)
    hgt = np.zeros((h, w), np.float32)
    torn = np.zeros((h, w), np.float32)
    groove = np.zeros((h, w), np.float32)
    grime = np.zeros((h, w), np.float32)
    # (start x, start y, end x, end y, bow) in 0..1, four claws per set
    sets = [
        (0.30, 0.05, 0.62, 0.62, 0.05, 1.0),
        (0.20, 0.42, 0.42, 0.97, -0.04, 0.8),
        (0.66, 0.30, 0.80, 0.70, 0.03, 0.55),
    ]
    for si, (x0, y0, x1, y1, bow, depth) in enumerate(sets):
        ax, ay, bx, by = x0 * w, y0 * h, x1 * w, y1 * h
        L = math.hypot(bx - ax, by - ay)
        nx, ny = -(by - ay) / L, (bx - ax) / L  # perpendicular
        spacing = rng.uniform(36, 44) * mm
        for k in range(4):
            off = (k - 1.5) * spacing * (1 + rng.normal(0, 0.06))
            # each claw starts and ends a little differently
            s0 = rng.uniform(0.0, 0.12)
            s1 = rng.uniform(0.82, 1.0) * (0.85 if k in (0, 3) else 1.0)
            pts = []
            n = 40
            for i in range(n):
                t = s0 + (s1 - s0) * i / (n - 1)
                b = math.sin(t * math.pi) * bow * L
                px = ax + (bx - ax) * t + nx * (off * (1 - 0.25 * t) + b) + rng.normal(0, 0.6)
                py = ay + (by - ay) * t + ny * (off * (1 - 0.25 * t) + b) + rng.normal(0, 0.6)
                pts.append((px, py, t))
            # distance + param along the claw path, within its bbox
            pa = np.array([(p[0], p[1]) for p in pts], np.float32)
            pad = 30 * mm
            ix0, ix1 = int(max(0, pa[:, 0].min() - pad)), int(min(w, pa[:, 0].max() + pad))
            iy0, iy1 = int(max(0, pa[:, 1].min() - pad)), int(min(h, pa[:, 1].max() + pad))
            sx, sy = xx[iy0:iy1, ix0:ix1], yy[iy0:iy1, ix0:ix1]
            dist = np.full(sx.shape, 1e9, np.float32)
            tpar = np.zeros(sx.shape, np.float32)
            for i in range(n - 1):
                qx0, qy0 = pa[i]
                qx1, qy1 = pa[i + 1]
                dx, dy = qx1 - qx0, qy1 - qy0
                l2 = dx * dx + dy * dy + 1e-9
                tt = np.clip(((sx - qx0) * dx + (sy - qy0) * dy) / l2, 0, 1)
                d = np.hypot(qx0 + tt * dx - sx, qy0 + tt * dy - sy)
                closer = d < dist
                dist = np.where(closer, d, dist)
                tpar = np.where(closer, (i + tt) / (n - 1), tpar)
            # depth profile: bites in fast, digs deep, lifts out slowly
            prof = smooth(tpar, 0.0, 0.12) * (1 - smooth(tpar, 0.55, 1.0) * 0.85) * depth
            width = (2.6 + 3.4 * prof) * mm * (1 + 0.2 * (k in (1, 2)))
            edge_noise = vnoise(ix1 - ix0, iy1 - iy0, 3, seed + si * 10 + k, 3)
            r = dist / np.maximum(width, 0.5)
            core = smooth(1.0 - r, 0.0, 0.35) * prof
            groove[iy0:iy1, ix0:ix1] = np.maximum(groove[iy0:iy1, ix0:ix1], core)
            hgt[iy0:iy1, ix0:ix1] -= core * (1.0 - r * r * 0.5) * 6.0
            # burr: torn surface layer curling up on both sides, ragged
            rag = (r - 1.0) / (0.5 + 2.2 * edge_noise ** 2)
            burr = smooth(rag, -0.1, 0.12) * (1 - smooth(rag, 0.2, 0.7)) * prof
            hgt[iy0:iy1, ix0:ix1] += burr * 1.2
            chips = (1 - smooth(rag, 0.0, 0.8)) * smooth(edge_noise, 0.5, 0.68) * prof
            torn[iy0:iy1, ix0:ix1] = np.maximum(torn[iy0:iy1, ix0:ix1], np.maximum(chips, burr * 0.6))
            # dirt rubbed along the path
            gr = np.exp(-(dist / (width * 2.5)) ** 2) * prof * 0.45
            grime[iy0:iy1, ix0:ix1] = np.maximum(grime[iy0:iy1, ix0:ix1], gr)
    hgt = blur(hgt, 0.7)
    groove = blur(groove, 0.5)
    exposed = lerp(hexa('9c8f78'), hexa('c4b89e'), vnoise(w, h, 2, seed + 50, 2))
    col = lerp(exposed, hexa('4a3e32'), smooth(groove, 0.05, 0.45))
    col = lerp(col, hexa('16110d'), smooth(groove, 0.45, 1.0) * 0.75)
    col = lerp(col, hexa('2e261e'), grime * (1 - smooth(torn, 0.1, 0.5)) * 0.6)
    alpha = np.clip(np.maximum.reduce([smooth(groove, 0.02, 0.2), smooth(torn, 0.05, 0.3) * 0.9, grime * 0.4]), 0, 1)
    alpha = feather_edges(alpha, w, h, 0.03, seed)
    # relief baked into the color (light from the upper left): the decal ships no normal map, so it
    # merges with the other decals into one draw call
    nrm = normal_from_height(hgt, 1.6) * 2 - 1
    lit = np.clip(nrm[..., 0] * -0.45 + nrm[..., 1] * 0.55 + nrm[..., 2] * 0.7, 0, 1.4)
    col = col * (0.55 + 0.6 * lit)[..., None]
    return rgba(np.clip(col, 0, 1), alpha), None


# =============================================================================================
# Drag trail (floor)
# =============================================================================================

def decal_drag(w=512, h=1024, seed=303):
    """
    A long dried blood drag trail, 0.6 x 2.4 m. Row 0 = the model's forward end (where the body was
    dragged TO): heavier at the start (bottom), streaky, pooled where it rested, clawing finger
    marks at the sides, both ends broken up so copies chain into one long trail.
    """
    rng = np.random.default_rng(seed)
    xx, yy = grid(w, h)
    U, V = xx / w, yy / h
    pxm = w / 600.0  # px per mm across
    # wavering center + width along the trail
    v1 = np.linspace(0, 1, h, dtype=np.float32)
    wav = vnoise(1, h, 220, seed, 3)[:, 0]
    center = 0.5 + 0.07 * (wav - 0.5) * 2 + 0.03 * np.sin(v1 * 3.0 + 1.3)
    widn = vnoise(1, h, 120, seed + 1, 3)[:, 0]
    half = (0.17 + 0.1 * widn) * (0.75 + 0.35 * v1)  # wider near the start (bottom)
    du = (U - center[:, None]) / half[:, None]
    band = 1 - smooth(np.abs(du), 0.55, 1.05 + 0.2 * vnoise(w, h, 18, seed + 2, 3))
    # streaks: constant along the drag (sampled across the band, in band coordinates)
    across = np.clip((du + 1.2) / 2.4, 0, 1)
    sn = vnoise(256, 1, 3, seed + 3, 4)[0]
    streak = np.interp(across, np.linspace(0, 1, 256), sn)
    streak = smooth(streak, 0.25, 0.75)
    along = vnoise(w, h, 60, seed + 4, 3)
    T = band * (0.25 + 0.75 * streak) * (0.35 + 0.8 * smooth(along, 0.25, 0.7))
    T *= 0.45 + 0.55 * smooth(V, 0.0, 0.9)  # thinning toward the far end
    # pools where it rested
    for (pv, pr) in ((0.82, 0.13), (0.38, 0.08)):
        pc = np.interp(pv, v1, center)
        d = np.sqrt(((U - pc) / (pr * 1.15)) ** 2 + ((V - pv) / (pr * 0.55)) ** 2)
        d += (vnoise(w, h, 30, seed + int(pv * 100), 3) - 0.5) * 0.6
        T = np.maximum(T, smooth(-d, -1.0, -0.65) * 1.05)
    # clawing fingers at the sides (dragged hands): 4 thin parallel streaks, angled back
    for (cv_, side) in ((0.6, -1), (0.22, 1)):
        base_u = np.interp(cv_, v1, center) + side * np.interp(cv_, v1, half) * 0.85
        ang = math.radians(rng.uniform(6, 16)) * side
        for k in range(4):
            if rng.random() < 0.2:
                continue
            ox = base_u * w + (k - 1.5) * 18 * pxm * side + rng.normal(0, 3)
            oy = cv_ * h + rng.normal(0, 8)
            L = rng.uniform(0.04, 0.1) * h
            a2 = ang + rng.normal(0, 0.08)
            pts = np.array([(ox + math.sin(a2) * L * t + 4 * math.sin(t * 3 + k), oy + math.cos(a2) * L * t)
                            for t in np.linspace(0, 1, 12)], np.float32)
            wd = (np.linspace(8.5, 2.5, 12) * pxm * rng.uniform(0.8, 1.1)).astype(np.float32)
            H.stroke_cov(T, pts, wd, np.linspace(0.85, 0.35, 12).astype(np.float32), soft=0.9)
    # drops off the edges
    for k in range(60):
        r = rng.uniform(1.5, 6.0) * pxm
        uc = np.interp(rng.random(), v1, center)
        x0 = (uc + rng.normal(0, 0.3)) * w
        y0 = rng.random() * h
        T = np.maximum(T, smooth(-(np.sqrt((xx - x0) ** 2 + ((yy - y0) * 2.3) ** 2) - r), -0.8, 0.8) * rng.uniform(0.3, 0.8))
    # break up both ends so chained copies blend into one trail
    ends = smooth(V, 0.0, 0.1) * (1 - smooth(V, 0.93, 1.0))
    ends = np.clip(ends + (vnoise(w, h, 25, seed + 9, 3) - 0.5) * 0.5 * (1 - ends), 0, 1)
    T = blur(T * ends, 0.6)
    col, alpha = blood_rgba(T, seed, w, h, 0.95)
    col = col * 0.8
    alpha = feather_edges(alpha, w, h, 0.04, seed)
    return rgba(col, alpha), None


# =============================================================================================
# Black mold + water damage
# =============================================================================================

def decal_mold(w=600, h=1000, seed=404):
    """Water leak from the top-left corner: tide-lined stain running down + black mold colonies."""
    rng = np.random.default_rng(seed)
    xx, yy = grid(w, h)
    U, V = xx / w, yy / h
    # stain field: strongest at the top-left source, stretched downward by gravity
    n1 = vnoise(w, h, 140, seed, 4)
    n2 = vnoise(w, h // 3 + 1, 40, seed + 1, 3)
    n2 = np.repeat(n2, 3, 0)[:h]
    src = np.exp(-((U - 0.08) / 0.55) ** 2 - ((V - 0.0) / 0.95) ** 2)
    runs = smooth(n2, 0.45, 0.8) * smooth(U, 0.0, 0.05) * (1 - smooth(U, 0.5, 0.95)) * (1 - smooth(V, 0.4, 1.0))
    field = src * (0.65 + 0.5 * n1) + runs * 0.35
    stain = smooth(field, 0.32, 0.5)
    # tide lines: thin dark rings on iso-levels of the field
    tide = np.zeros((h, w), np.float32)
    for lv in (0.34, 0.42, 0.52, 0.63):
        q = np.abs(field - lv)
        tide = np.maximum(tide, np.exp(-(q / 0.008) ** 2) * (0.5 + 0.5 * vnoise(w, h, 20, seed + int(lv * 100), 2)))
    rgb = lerp(hexa('6e5432'), hexa('3a2a16'), smooth(field, 0.45, 0.8))
    alpha = stain * (0.34 + 0.2 * vnoise(w, h, 30, seed + 5, 3)) + tide * 0.5
    rgb = lerp(rgb, hexa('3e2c18'), np.clip(tide, 0, 1))
    # black mold: colonies of tiny dots, denser + darker toward the source
    dens = np.zeros((h, w), np.float32)
    for k in range(170):
        cu = abs(rng.normal(0.0, 0.4))
        cv = abs(rng.normal(0.0, 0.48))
        if field[int(min(h - 1, cv * h)), int(min(w - 1, cu * w))] < 0.38:
            continue
        r = rng.uniform(0.02, 0.09) * w
        cx, cy = cu * w, cv * h
        nd = int(rng.integers(30, 160))
        pts = rng.normal(0, r * 0.45, (nd, 2))
        x0, x1 = int(max(0, cx - r * 2)), int(min(w, cx + r * 2))
        y0, y1 = int(max(0, cy - r * 2)), int(min(h, cy + r * 2))
        if x1 <= x0 or y1 <= y0:
            continue
        sx, sy = xx[y0:y1, x0:x1], yy[y0:y1, x0:x1]
        sub = dens[y0:y1, x0:x1]
        sub += np.exp(-(((sx - cx) ** 2 + (sy - cy) ** 2) / (r * r * 0.5))) * 0.12  # fuzzy halo
        for (px, py) in pts:
            rr = rng.uniform(0.8, 3.4)
            sub += smooth(-(np.sqrt((sx - cx - px) ** 2 + (sy - cy - py) ** 2) - rr), -0.8, 0.8) * rng.uniform(0.4, 1.0)
    dens = np.clip(dens, 0, 1.5)
    speck = smooth(vnoise(w, h, 1.6, seed + 7, 2), 0.55, 0.75) * smooth(field, 0.4, 0.7)
    dens = np.maximum(dens, speck * 0.8)
    mold = smooth(dens, 0.08, 0.9)
    mold_col = lerp(hexa('3c4232'), hexa('0c0e0a'), smooth(dens, 0.3, 1.0))
    rgb = lerp(rgb, mold_col, mold)
    alpha = np.maximum(alpha, mold * 0.94)
    alpha = feather_edges(alpha, w, h, 0.05, seed)
    return rgba(rgb, alpha), None


# =============================================================================================
# Wall writing
# =============================================================================================

def _grit(w, h, seed, scale=1.6):
    return vnoise(w, h, scale, seed, 2)


def writing_charcoal(w, h, text, size, seed, x=None, y=None, slope=0.0, color='16120f'):
    """Charcoal scrawl: gritty broken strokes, smudged, a dusting fallen below the letters."""
    cov = np.zeros((h, w), np.float32)
    hand = H.Hand(slant=0.12, messy=0.85, size_jitter=0.07, rot_jitter=3.5, baseline=0.18, spacing=1.13,
                  line_slope=slope, caps=True, seed=seed)
    pen = H.Pen('charcoal', width=size * 0.2)
    H.write(cov, text, x if x is not None else w * 0.05, y if y is not None else h * 0.72, size, hand, pen,
            max_width=w * 0.92, line_h=size * 2.2, wobble=0.05)
    grit = _grit(w, h, seed + 1)
    cov_g = cov * smooth(grit, 0.04, 0.42)
    smudge = blur(cov, size * 0.12) * 0.45
    dust = blur(cov, 2) * smooth(vnoise(w, h, 1.2, seed + 2, 1), 0.7, 0.85)
    dust = np.roll(dust, int(size * 0.25), 0) * 0.5
    a = np.clip(np.maximum.reduce([cov_g * 1.3, smudge, dust]), 0, 1)
    rgb = np.broadcast_to(hexa(color), (h, w, 3)).copy()
    rgb = lerp(rgb, hexa('2a2622'), smooth(1 - cov, 0.3, 0.9))
    a = feather_edges(a, w, h, 0.02, seed)
    return rgba(rgb, a), None


def decal_writing_hears(w=1024, h=384, seed=505):
    return writing_charcoal(w, h, 'IT *HEARS* YOU', 70, seed, x=w * 0.035, y=h * 0.58, slope=0.035)


def decal_writing_dont(w=1024, h=560, seed=606):
    """'DON'T / TALK' gouged + scrawled in chalky white (scratched through to the plaster)."""
    cov = np.zeros((h, w), np.float32)
    hand = H.Hand(slant=0.06, messy=0.7, size_jitter=0.08, rot_jitter=4.0, baseline=0.12, spacing=1.08, caps=True,
                  seed=seed)
    pen = H.Pen('chalk', width=15)
    H.write(cov, "DON'T", w * 0.12, h * 0.40, 112, hand, pen, max_width=w * 0.9)
    H.write(cov, 'TALK', w * 0.26, h * 0.86, 112, hand, pen, max_width=w * 0.9)
    grit = _grit(w, h, seed + 1, 1.4)
    a = cov * smooth(grit, 0.15, 0.55) * 0.92
    a = np.maximum(a, blur(cov, 6) * 0.14)
    rgb = lerp(hexa('cfc8b4'), hexa('ece6d6'), smooth(cov, 0.6, 1.0))
    rgb = lerp(rgb, hexa('9a9282'), smooth(1 - cov, 0.4, 1.0))
    a = feather_edges(a, w, h, 0.02, seed)
    return rgba(rgb, a), None


def decal_writing_shh(w=1024, h=768, seed=707):
    """'SHHH' finger-painted in blood (it ran), and a wall of tally marks in charcoal below."""
    rng = np.random.default_rng(seed)
    T = np.zeros((h, w), np.float32)
    hand = H.Hand(slant=0.1, messy=0.6, size_jitter=0.08, rot_jitter=3.0, baseline=0.1, spacing=1.3, caps=True,
                  seed=seed)
    H.write(T, 'SHHH', w * 0.08, h * 0.47, 150, hand, H.Pen('finger', width=24, density=1.0), max_width=w)
    # runs: blood ran down from the heaviest strokes
    xx, yy = grid(w, h)
    cols = np.where(T.max(0) > 0.6)[0]
    for k in range(8):
        if not len(cols):
            break
        x = float(rng.choice(cols))
        ys = np.where(T[:, int(x)] > 0.6)[0]
        if not len(ys):
            continue
        y = float(ys.max())
        T = drip(T, x, y - 4, rng.uniform(0.03, 0.2) * h, rng.uniform(3.0, 5.0), rng, w, h)
    T = np.clip(T * 1.1, 0, 1.3)
    col, alpha = blood_rgba(blur(T, 0.6), seed, w, h)
    # tally marks: days (charcoal), in rows
    cov = np.zeros((h, w), np.float32)
    pen = H.Pen('charcoal', width=12)
    H.tally(cov, w * 0.07, h * 0.80, 100, 23, pen, rng, spacing=25, group_gap=46, wobble=1.8)
    H.tally(cov, w * 0.09, h * 0.955, 86, 14, pen, rng, spacing=24, group_gap=42, wobble=1.8)
    cov = cov * smooth(_grit(w, h, seed + 3), 0.05, 0.45)
    col, alpha = over(col, alpha, hexa('14100d'), cov * 0.97)
    alpha = feather_edges(alpha, w, h, 0.02, seed)
    return rgba(col, alpha), None


# =============================================================================================
# Child's crayon drawing, taped to the wall
# =============================================================================================

def decal_drawing(w=768, h=1024, seed=808):
    """
    Crayon on cheap drawing paper: a tall black figure with no eyes and HUGE ears, long arms to the
    floor; a small girl with her finger on her lips, sound arcs between them; "IT CAN HEER YOU".
    Taped at the top corners, a torn bottom corner, a fold crease.
    """
    rng = np.random.default_rng(seed)
    xx, yy = grid(w, h)
    U, V = xx / w, yy / h
    paper = lerp(hexa('e2d9c2'), hexa('cfc2a2'), vnoise(w, h, 90, seed, 3))
    rgb = paper.copy()
    tooth = vnoise(w, h, 1.4, seed + 1, 1)

    def crayon(pts, width, col, alpha=0.9, passes=3):
        cov = np.zeros((h, w), np.float32)
        for k in range(passes):
            off = rng.normal(0, width * 0.22, 2)
            q = [(x + off[0], y + off[1]) for x, y in pts]
            H.draw_stroke(cov, q, H.Pen('crayon', width=width * rng.uniform(0.7, 0.95)), rng, wobble=width * 0.25,
                          size=60)
        cov = cov * smooth(tooth, 0.2, 0.6)  # wax skips on the paper grain
        nonlocal rgb
        rgb = lerp(rgb, hexa(col), np.clip(cov * alpha, 0, 1))

    def scribble(x0, y0, x1, y1, col, n=24, width=9, alpha=0.85):
        pts = [(x0 + (x1 - x0) * rng.random(), y0 + (y1 - y0) * (k / (n - 1))) for k in range(n)]
        crayon(pts, width, col, alpha, passes=2)

    def ring(cx, cy, rx, ry, col, width=7, a0=0, a1=360, alpha=0.9):
        crayon([(cx + rx * math.cos(math.radians(a)), cy + ry * math.sin(math.radians(a)))
                for a in np.linspace(a0, a1, 24)], width, col, alpha)

    black, red, yellow, brown, blue, green = '15120f', 'a8321f', 'd9ae2c', '6e4426', '33508c', '4d7234'
    # floor line + a bed (brown) on the left
    crayon([(w * 0.03, h * 0.86), (w * 0.5, h * 0.87), (w * 0.97, h * 0.855)], 8, brown, 0.8)
    crayon([(w * 0.06, h * 0.86), (w * 0.06, h * 0.72), (w * 0.38, h * 0.72), (w * 0.38, h * 0.86)], 8, brown)
    crayon([(w * 0.06, h * 0.68), (w * 0.06, h * 0.86)], 9, brown)
    scribble(w * 0.08, h * 0.725, w * 0.36, h * 0.765, blue, 16, 8, 0.6)
    # the girl, half behind the bed, finger on her lips
    gx, gy = w * 0.25, h * 0.58
    ring(gx, gy, 30, 32, black, 6)
    for sgn in (-1, 1):
        crayon([(gx + sgn * 11, gy - 6), (gx + sgn * 10, gy - 3)], 6, black)
    crayon([(gx - 8, gy + 14), (gx + 8, gy + 14)], 5, red)
    crayon([(gx + 2, gy + 4), (gx + 3, gy + 26)], 6, black)  # the finger on her lips
    crayon([(gx - 30, gy - 10), (gx - 44, gy + 30)], 7, yellow)  # pigtails
    crayon([(gx + 30, gy - 10), (gx + 44, gy + 30)], 7, yellow)
    crayon([(gx, gy + 32), (gx - 40, gy + 110), (gx + 40, gy + 110), (gx, gy + 32)], 7, yellow)
    scribble(gx - 26, gy + 50, gx + 26, gy + 105, yellow, 14, 8, 0.7)
    # the tall one: right side, head near the top, no eyes, HUGE ears, arms to the floor
    tx, top = w * 0.68, h * 0.13
    ring(tx, top + 52, 46, 54, black, 9)
    for k in range(4):
        scribble(tx - 34, top + 12, tx + 34, top + 92, black, 10, 8, 0.75)
    for sgn in (-1, 1):  # ears: big ragged ovals, red inside
        ex = tx + sgn * 92
        ring(ex, top + 50, 44, 74, black, 9)
        ring(ex, top + 52, 24, 46, red, 7, alpha=0.85)
    crayon([(tx - 26, top + 84), (tx - 6, top + 96), (tx + 8, top + 86), (tx + 24, top + 97)], 6, red)  # mouth
    body = [(tx - 28, top + 106), (tx + 28, top + 106)]
    for k in range(5):
        scribble(tx - 36 + k * 3, top + 108, tx + 36 - k * 3, h * 0.62, black, 34, 12, 0.85)
    del body
    crayon([(tx - 18, h * 0.62), (tx - 30, h * 0.855)], 10, black)
    crayon([(tx + 18, h * 0.62), (tx + 26, h * 0.855)], 10, black)
    for sgn in (-1, 1):
        crayon([(tx + sgn * 30, top + 120), (tx + sgn * 92, top + 300), (tx + sgn * 104, h * 0.83)], 9, black)
        for k in range(4):
            crayon([(tx + sgn * 104, h * 0.83), (tx + sgn * (98 + k * 6), h * 0.86 + 6)], 5, black)
    # sound arcs: from the girl to the ear
    for k in range(3):
        r = 40 + k * 26
        crayon([(gx + 60 + r * 0.5 * math.cos(math.radians(a)), gy - 10 + r * math.sin(math.radians(a)))
                for a in np.linspace(-50, 50, 10)], 6, blue, 0.8)
    # child's capitals (backwards N), signed
    cov = np.zeros((h, w), np.float32)
    hand = H.Hand(slant=-0.05, messy=1.0, size_jitter=0.15, rot_jitter=7.0, baseline=0.3, spacing=1.15, caps=True,
                  seed=seed + 3)
    H.write(cov, 'IT CAN HEER YOU', w * 0.06, h * 0.075, 26, hand, H.Pen('crayon', width=8), max_width=w * 0.9)
    H.write(cov, 'ELLIE', w * 0.66, h * 0.955, 18, hand, H.Pen('crayon', width=6), max_width=w * 0.3)
    cov = cov * smooth(tooth, 0.2, 0.6)
    rgb = lerp(rgb, hexa(red), np.clip(cov * 0.9, 0, 1))
    # paper aging, crease, dirty fingerprints
    rgb = lerp(rgb, hexa('a8905e'), smooth(vnoise(w, h, 70, seed + 5, 3), 0.55, 0.85) * 0.3)
    crease = np.exp(-((V - 0.47 - 0.01 * np.sin(U * 6)) / 0.0035) ** 2)
    rgb = lerp(rgb, hexa('8c7a58'), crease * 0.5)
    for k in range(3):
        fx, fy = w * rng.uniform(0.1, 0.9), h * rng.uniform(0.6, 0.95)
        ridges = 0.5 + 0.5 * np.sin(np.hypot(xx - fx, (yy - fy) * 0.8) * 1.6)
        rgb = lerp(rgb, hexa('7a6448'), smooth(-(np.hypot((xx - fx) / 1.0, (yy - fy) / 1.3) - 16), -6, 6)
                   * ridges * 0.22)
    # outline: slightly irregular edges, a torn-off bottom-right corner
    edge = vnoise(w, h, 12, seed + 6, 3)
    m = 0.018
    inside = smooth(np.minimum(np.minimum(U, 1 - U), np.minimum(V, 1 - V)) + (edge - 0.5) * 0.008, m * 0.5, m * 0.5 + 0.004)
    tear = (U - 0.78) + (V - 0.84) + (vnoise(w, h, 10, seed + 7, 4) - 0.5) * 0.06
    inside *= 1 - smooth(tear, 0.27, 0.275)
    rgb = lerp(rgb, hexa('9a8462'), smooth(np.minimum(np.minimum(U, 1 - U), np.minimum(V, 1 - V)), 0.05, m) * 0.5)
    alpha = inside
    # yellowed tape over the top corners (half on the paper, half on the wall)
    for (tcx, ang) in ((0.06, -0.6), (0.94, 0.55)):
        cx, cy = tcx * w, 0.03 * h
        c, s = math.cos(ang), math.sin(ang)
        lx = (xx - cx) * c + (yy - cy) * s
        ly = -(xx - cx) * s + (yy - cy) * c
        tape = smooth(-(np.abs(lx) - 70), -1.5, 1.5) * smooth(-(np.abs(ly) - 22), -1.5, 1.5)
        tape *= 0.75 + 0.25 * vnoise(w, h, 4, seed + 8, 2)
        rgb, alpha = over(rgb, alpha, hexa('c8b072'), tape * 0.55)
        alpha = np.maximum(alpha, tape * 0.6)
    return rgba(rgb, alpha), None


DECALS = {
    'handprints': decal_handprints,
    'scratches': decal_scratches,
    'drag': decal_drag,
    'mold': decal_mold,
    'writing_hears': decal_writing_hears,
    'writing_shh': decal_writing_shh,
    'writing_dont': decal_writing_dont,
    'drawing': decal_drawing,
}
