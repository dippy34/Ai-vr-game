"""
Shared "grime language" for MUTE's tileable surfaces (numpy, periodic): water stains with tide
lines, drip streaks, mildew blooms, fly specks, scuffs, torn/lifting paper, fading.

Every function draws into full-tile arrays of a surfaces_lib.Tex and stays periodic (toroidal
offsets / wrapped windows). Sizes are in METERS unless named *_px.
Helper module only: build() is a no-op.
"""

from __future__ import annotations

import math

import numpy as np

from surfaces_lib import F32, Tex, sstep


def build() -> None:
    print('surfaces_grime: helper module (built through surfaces.py)')


class Layers:
    """Accumulates the PBR channels of one texture while grime is layered on."""

    def __init__(self, T: Tex, color: np.ndarray, rough: float | np.ndarray = 0.8):
        self.T = T
        self.color = color.astype(F32)
        self.rough = (np.full((T.n, T.n), rough, F32) if np.isscalar(rough) else rough.astype(F32))
        self.metal = np.zeros((T.n, T.n), F32)
        self.height = np.zeros((T.n, T.n), F32)  # meters
        self.ao = np.ones((T.n, T.n), F32)

    def paint(self, mask: np.ndarray, color, opacity: float = 1.0, rough: float | None = None,
              rough_mix: float = 1.0) -> None:
        m = np.clip(mask * opacity, 0, 1).astype(F32)
        c = np.asarray(color, F32)
        self.color = self.color + (c - self.color) * m[..., None]
        if rough is not None:
            self.rough = self.rough + (rough - self.rough) * (m * rough_mix)

    def multiply(self, mask: np.ndarray, tint, opacity: float = 1.0) -> None:
        m = np.clip(mask * opacity, 0, 1)[..., None]
        t = np.asarray(tint, F32)
        self.color = self.color * (1 + (t - 1) * m)


# =============================================================================================
# Shared noise fields (generated once per texture, sampled at offsets for each feature)
# =============================================================================================

class Fields:
    def __init__(self, T: Tex):
        self.T = T
        self.warp_lo = T.fbm(6, octaves=4)          # stain outlines
        self.warp_hi = T.fbm(24, octaves=3)         # ragged edges
        self.detail = T.fbm(64, octaves=3)          # fine breakup

    def at(self, field: np.ndarray, ou: float, ov: float) -> np.ndarray:
        """`field` shifted by (ou, ov) tile units (still periodic)."""
        n = self.T.n
        return np.roll(np.roll(field, int(ov * n), 0), int(ou * n), 1)


# =============================================================================================
# Water stains
# =============================================================================================

def water_stain(L: Layers, F: Fields, cu: float, cv: float, radius: float, *, stretch=(1.0, 1.0),
                tint=(0.86, 0.79, 0.64), tide=(0.34, 0.25, 0.14), strength: float = 1.0,
                rings: int = 2, buckle: float = 0.0, rough_delta: float = 0.0, warp: float = 0.35):
    """Irregular dried water stain: mottled tinted interior, crisp dark tide line at the edge, faint
    inner rings where it dried in stages. Returns the interior mask (for mildew / flakes)."""
    T = L.T
    rng = T.rng
    du, dv = T.tdelta(cu, cv)
    dx = du * T.size_m / (radius * stretch[0])
    dy = dv * T.size_m / (radius * stretch[1])
    r = np.sqrt(dx * dx + dy * dy)
    ou, ov = rng.random(2)
    r = r * (1 + warp * F.at(F.warp_lo, ou, ov) + 0.09 * F.at(F.warp_hi, ov, ou) + 0.025 * F.at(F.detail, ou, ov))
    inside = sstep(1.01, 0.96, r)
    # interior: mottled, stronger toward the rim (pigment migrates outward while drying)
    mott = np.clip(0.55 + 0.6 * F.at(F.warp_hi, ou + 0.3, ov) + 0.3 * F.at(F.detail, ov, ou + 0.2), 0, 1)
    body = inside * (0.25 + 0.75 * sstep(0.3, 0.98, r)) * mott
    L.multiply(body, tint, 0.8 * strength)
    # tide line: sharp outside, soft inside
    edge = np.where(r > 1.0, np.exp(-((r - 1.0) / 0.008) ** 2), np.exp(-((r - 1.0) / 0.035) ** 2))
    edge *= 0.65 + 0.35 * F.at(F.detail, ou, ov + 0.5)
    L.paint(edge.astype(F32), tide, 0.6 * strength)
    for k in range(rings):
        rr = rng.uniform(0.4, 0.88)
        jit = 1 + 0.06 * F.at(F.warp_hi, ou + 0.1 * k, ov + 0.2)
        rk = r * jit
        ring = np.where(rk > rr, np.exp(-((rk - rr) / 0.007) ** 2), np.exp(-((rk - rr) / 0.03) ** 2))
        L.paint((ring * inside).astype(F32), tide, rng.uniform(0.18, 0.35) * strength)
    if buckle:
        b = F.at(F.detail, ov, ou)
        L.height += (inside * (0.6 + 0.4 * F.at(F.warp_lo, ov, ou)) * buckle
                     + inside * b * buckle * 0.25).astype(F32)
    if rough_delta:
        L.rough += inside * rough_delta
    return inside.astype(F32)


def drip(L: Layers, cu: float, cv: float, length: float, width: float, *, color=(0.40, 0.31, 0.19),
         strength: float = 0.5, bead: bool = True):
    """Vertical run-down streak (dirty water) starting at (cu, cv) going DOWN (-v)."""
    T = L.T
    rng = T.rng
    m = T.zeros()
    x = cu * T.n
    y = cv * T.n
    pts, ws = [], []
    steps = max(4, int(T.px(length) / 6))
    w = T.px(width)
    for i in range(steps + 1):
        t = i / steps
        pts.append((x, y))
        ws.append(w * (0.6 + 0.6 * math.sin(math.pi * min(t * 1.4, 1.0))) * (1 - 0.5 * t))
        x += rng.normal(0, 0.6)
        y -= T.px(length) / steps
    T.stroke(m, pts, ws, soft=2.0)
    fade = T.zeros()
    # fade along the streak: strong at the top, thin and faint at the end
    for i in range(len(pts) - 1):
        t = i / (len(pts) - 1)
        T.stroke(fade, pts[i:i + 2], [ws[i] + 4, ws[i + 1] + 4], soft=2.0, value=1.0 - 0.75 * t)
    soft = T.blur(m * fade, 1.5)
    L.multiply(soft, (0.86, 0.80, 0.70), strength)
    rim = np.clip(T.blur(m, 0.8) - T.blur(m, 3.0), 0, 1) * 2.0 * fade
    L.paint(rim, color, strength * 0.9)
    if bead:
        bx, by = pts[-1]
        bm = T.zeros()
        T.blob(bm, bx, by, ws[-1] * 0.7 + 1.5, ws[-1] * 0.9 + 2, soft=1.5)
        L.paint(bm, color, strength * 0.9)


# =============================================================================================
# Biology + dirt
# =============================================================================================

def mildew(L: Layers, F: Fields, cu: float, cv: float, radius: float, *, density: float = 1.0,
           color=(0.17, 0.18, 0.13), halo=(0.80, 0.80, 0.62), rough: float = 0.92):
    """Mildew bloom: a fractal cluster of tiny dark specks with a yellow-green halo."""
    T = L.T
    rng = T.rng
    du, dv = T.tdelta(cu, cv)
    r = np.sqrt((du * T.size_m) ** 2 + (dv * T.size_m) ** 2) / radius
    ou, ov = rng.random(2)
    r = r * (1 + 0.5 * F.at(F.warp_lo, ou, ov) + 0.25 * F.at(F.warp_hi, ou, ov))
    cluster = np.clip(1 - r, 0, 1) ** 1.3 * density
    L.multiply(sstep(0.0, 0.6, cluster), halo, 0.6)
    specks = T.zeros()
    for cells, thr in ((int(T.size_m / 0.004), 0.45), (int(T.size_m / 0.0016), 0.5), (int(T.size_m / 0.009), 0.35)):
        f1, _, cid = T.worley(cells, seed=int(rng.integers(1 << 30)))
        rnd = ((cid * 2654435761) % 1000) / 1000.0
        on = (rnd < cluster * 1.2).astype(F32)
        size = (0.18 + 0.35 * rnd) * np.clip(cluster * 1.5, 0, 1)
        specks = np.maximum(specks, on * sstep(size, size * 0.55, f1))
    specks = np.clip(specks, 0, 1)
    L.paint(specks, color, 0.85, rough=rough)
    L.paint(T.blur(specks, 2.5), color, 0.35)
    L.height += specks * 0.00006
    return cluster


def fly_specks(L: Layers, count: int, *, color=(0.12, 0.10, 0.07), size_px=(0.6, 1.6), opacity=0.8):
    T = L.T
    rng = T.rng
    m = T.zeros()
    # clustered: specks gather in a few areas
    centers = rng.random((max(1, count // 40), 2)) * T.n
    for i in range(count):
        if rng.random() < 0.7:
            c = centers[rng.integers(len(centers))]
            x, y = c + rng.normal(0, T.n * 0.08, 2)
        else:
            x, y = rng.random(2) * T.n
        s = rng.uniform(*size_px)
        T.blob(m, x, y, s, s * rng.uniform(0.7, 1.3), rot=rng.uniform(0, 3.14), soft=0.6,
               value=rng.uniform(0.4, 1.0))
    L.paint(m, color, opacity)


def scuff_band(L: Layers, F: Fields, v0: float, v1: float, *, dark=(0.25, 0.23, 0.20),
               light=(0.75, 0.71, 0.62), strength: float = 1.0, scratches: int = 30):
    """Horizontal rub marks and scratches between v0..v1 (furniture, shoulders, hands)."""
    T = L.T
    rng = T.rng
    band = sstep(v0, v0 + 0.05, T.v) * sstep(v1, v1 - 0.05, T.v)
    streak = T.spectral(beta=2.2, fmin=2, aniso=(12.0, 1.0))  # long horizontal smears
    blot = T.fbm(12, 3, octaves=3)
    rub = np.clip(streak * 0.45 + 0.5 * blot - 0.2, 0, 1) * band
    L.paint(rub, dark, 0.5 * strength, rough=0.6, rough_mix=0.5)
    sc = T.zeros()
    for _ in range(scratches):
        y = rng.uniform(v0 + 0.02, v1 - 0.02) * T.n
        x = rng.uniform(0, T.n)
        ln = T.px(rng.uniform(0.03, 0.22))
        a = rng.normal(0, 0.08) + (math.pi if rng.random() < 0.5 else 0)
        pts = T.crack_path(x, y, ln, a, step=4, wiggle=0.05)
        T.stroke(sc, pts, rng.uniform(0.7, 1.6), soft=0.6, value=rng.uniform(0.4, 1.0))
    L.paint(sc, light, 0.3 * strength, rough=0.85)
    L.height -= sc * 0.00008
    return band


def tear(L: Layers, F: Fields, cu: float, cv: float, w: float, h: float, under: np.ndarray, *,
         under_rough=0.88, rim=(0.80, 0.77, 0.68), depth: float = 0.0003, under_height=None):
    """Torn-away patch of the top layer, revealing `under` (full-tile color array)."""
    T = L.T
    rng = T.rng
    du, dv = T.tdelta(cu, cv)
    ou, ov = rng.random(2)
    d = np.sqrt((du * T.size_m / w) ** 2 + (dv * T.size_m / h) ** 2)
    # ragged outline at scales relative to the tear's own size
    base_p = max(2, int(round(T.size_m / max(w, h) * 1.3)))
    jag = T.fbm(base_p, octaves=5, gain=0.6)
    d = d * (1 + 0.55 * jag) + 0.04 * F.at(F.detail, ou, ov)
    hole = sstep(1.0, 0.97, d).astype(F32)
    fib = np.clip(T.spectral(beta=1.0, fmin=150) * 0.5 + 0.7, 0, 1)
    rim_m = (sstep(1.09, 1.0, d) - hole).clip(0, 1) * fib
    L.color = L.color + (under - L.color) * hole[..., None]
    L.rough = L.rough + (under_rough - L.rough) * hole
    L.paint(rim_m.astype(F32), rim, 0.85, rough=0.9)
    L.height = L.height - hole * depth + rim_m * depth * 0.4
    if under_height is not None:
        L.height = L.height + hole * under_height
    L.ao *= 1 - 0.35 * np.clip(sstep(0.97, 1.0, d) * sstep(1.04, 1.0, d), 0, 1)
    return hole


def paper_seam(L: Layers, F: Fields, u_seam: float, *, lifts=(), gap_color=(0.16, 0.14, 0.11),
               back=(0.76, 0.73, 0.64), wall=(0.42, 0.40, 0.36)):
    """Vertical butt seam between two wallpaper strips at u_seam. `lifts` = [(v0, v1, side, amount_m)]:
    sections where one strip's edge has come unstuck and curls off the wall."""
    T = L.T
    du, _ = T.tdelta(u_seam, 0.0)
    xm = du * T.size_m  # meters from the seam (signed)
    ax = np.abs(xm)
    gap = sstep(0.0009, 0.0002, ax)
    L.paint(gap, gap_color, 0.75, rough=0.95)
    L.ao *= 1 - 0.4 * gap
    # paste ridge (slightly raised edges either side)
    L.height += np.exp(-((ax - 0.0012) / 0.0008) ** 2) * 0.00008
    for (v0, v1, side, amount) in lifts:
        env = sstep(v0, v0 + 0.06, T.v) * sstep(v1, v1 - 0.06, T.v)
        env = env * (0.8 + 0.2 * F.detail)
        on_side = (np.sign(xm) == side).astype(F32)
        w = 0.010 + 0.006 * F.at(F.warp_hi, v0, 0.3)
        prof = np.clip(1 - ax / w, 0, 1) ** 2 * on_side * env
        L.height += prof * amount
        # the curled edge shows the paper's paler back and a dark gap behind it
        curl = sstep(0.0035, 0.0012, ax) * on_side * env
        L.paint(curl, back, 0.7)
        shadow = sstep(0.006, 0.0015, ax) * (1 - on_side) * env
        L.paint(shadow, wall, 0.5)
        L.paint(sstep(0.0018, 0.0006, ax) * env, gap_color, 0.9, rough=0.95)
        L.ao *= 1 - 0.5 * (shadow + sstep(0.0018, 0.0006, ax) * env).clip(0, 1)


def fade(L: Layers, F: Fields, *, amount: float = 0.12, desat: float = 0.85, grime=(0.85, 0.82, 0.76),
         grime_amount: float = 0.35):
    """Uneven sun fading (lighter, less saturated) and soft overall grime (darker), periodic."""
    T = L.T
    lo = T.fbm(3, octaves=4)
    mid = T.fbm(10, octaves=3)
    fadem = sstep(-0.3, 0.6, lo)
    c = L.color
    l = c[..., 0] * 0.2126 + c[..., 1] * 0.7152 + c[..., 2] * 0.0722
    s = desat + (1 - desat) * (1 - fadem)
    c = l[..., None] + (c - l[..., None]) * s[..., None]
    c = c + (1 - c) * (fadem * amount)[..., None]
    g = sstep(-0.2, 0.7, mid * 0.6 + lo * 0.4) * grime_amount
    c = c * (1 + (np.asarray(grime, F32) - 1) * g[..., None])
    L.color = c.astype(F32)


# =============================================================================================
# Final maps
# =============================================================================================

def finish(L: Layers, *, normal_strength: float = 1.0, cavity_radii=(0.002, 0.008, 0.03),
           cavity_scale: float = 0.0005, ao_strength: float = 0.6, color_cavity: float = 0.25,
           rough_range=(0.04, 1.0), roll=(0.0, 0.0)) -> dict:
    """Layers -> {'color': sRGB, 'normal': encoded OpenGL tangent normal, 'orm': AO/rough/metal}.
    roll=(du, dv) shifts the finished tile (periodic, so still seamless) so that no strong pattern
    edge (paper seam, plank gap, grout line) sits exactly on the wrap edge."""
    T = L.T
    cav = T.cavity(L.height, cavity_radii, cavity_scale)
    ao = np.clip(L.ao * (1 - ao_strength * cav), 0, 1)
    color = np.clip(L.color * (1 - color_cavity * cav)[..., None], 0, 1)
    normal = T.normal_from_height(L.height, normal_strength)
    orm = np.stack([ao, np.clip(L.rough, *rough_range), np.clip(L.metal, 0, 0.8)], axis=-1)
    out = {'color': color.astype(F32), 'normal': normal, 'orm': orm.astype(F32), 'height': L.height}
    ru, rv = int(round(roll[0] * T.n)), int(round(roll[1] * T.n))
    if ru or rv:
        out = {k: np.roll(np.roll(a, rv, axis=0), ru, axis=1) for k, a in out.items()}
    return out
