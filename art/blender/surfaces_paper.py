"""
Wallpaper texture sets (numpy, periodic): wallpaper_a (faded olive/sepia damask) and wallpaper_b
(dusty blue-gray regency stripe with small diamonds). Both are 1.0 m x 1.0 m tiles made of two
0.5 m paper strips (seams at u = 0 and u = 0.5) and share the grime language in surfaces_grime.

v = 0 is the bottom of the tile (the renderer maps v = height / 1.0 m, so v = 0.85..1.0 is hip
height on the first repetition).
Helper module only: build() is a no-op (surfaces.py builds the sets).
"""

from __future__ import annotations

import math

import numpy as np

import surfaces_grime as G
from surfaces_lib import F32, Tex, hexc, lerp, sstep


def build() -> None:
    print('surfaces_paper: helper module (built through surfaces.py)')


# =============================================================================================
# Ornament drawing on a local (non-tiling) cell canvas
# =============================================================================================

class Cell:
    """A square drawing canvas in meters with (0, 0) at its center (y up)."""

    def __init__(self, size_m: float, texel: float, seed: int = 1):
        self.n = int(round(size_m / texel))
        self.size = size_m
        self.T = Tex(self.n, size_m, seed)
        self.texel = texel
        h = size_m / 2
        self.X = (self.T.u * size_m - h).astype(F32)
        self.Y = (self.T.v * size_m - h).astype(F32)
        self.h = h

    def p(self, x, y):
        return ((x + self.h) / self.texel, (y + self.h) / self.texel)

    def mask(self):
        return np.zeros((self.n, self.n), F32)

    def stroke(self, m, pts_m, widths_m, mirror=True, soft=0.9):
        pts = [self.p(x, y) for x, y in pts_m]
        w = np.asarray(widths_m, dtype=np.float64) / self.texel
        self.T.stroke(m, pts, w, soft=soft)
        if mirror:
            pts = [self.p(-x, y) for x, y in pts_m]
            self.T.stroke(m, pts, w, soft=soft)

    def dot(self, m, x, y, r, mirror=True, ry=None, rot=0.0):
        ry = r if ry is None else ry
        for sx in ((1, -1) if mirror and abs(x) > 1e-6 else (1,)):
            px, py = self.p(sx * x, y)
            self.T.blob(m, px, py, r / self.texel, ry / self.texel, rot=sx * rot, soft=0.9)

    def profile(self, m, y0, y1, wfun, x0=0.0):
        """Fill a vertically symmetric shape: |x - x0| < wfun(t), t = (y - y0)/(y1 - y0) in 0..1."""
        t = (self.Y - y0) / (y1 - y0)
        inside = (t >= 0) & (t <= 1)
        w = np.where(inside, wfun(np.clip(t, 0, 1)), -1.0)
        cov = np.clip((w - np.abs(self.X - x0)) / (self.texel * 0.9) + 0.5, 0, 1)
        np.maximum(m, cov.astype(F32), out=m)

    def ring(self, m, cx, cy, rx, ry, w):
        d = np.sqrt(((self.X - cx) / rx) ** 2 + ((self.Y - cy) / ry) ** 2)
        cov = np.clip((w / 2 - np.abs(d - 1) * min(rx, ry)) / (self.texel * 0.9) + 0.5, 0, 1)
        np.maximum(m, cov.astype(F32), out=m)

    def poly(self, m, pts_m, mirror=True):
        """Even-odd polygon fill (meters), antialiased by distance to the outline."""
        for sx in ((1, -1) if mirror else (1,)):
            P = np.asarray(pts_m, dtype=np.float64) * np.array([sx, 1.0])
            x0, y0 = P.min(0) - 0.004
            x1, y1 = P.max(0) + 0.004
            c0 = max(int((x0 + self.h) / self.texel), 0)
            c1 = min(int((x1 + self.h) / self.texel) + 1, self.n)
            r0 = max(int((y0 + self.h) / self.texel), 0)
            r1 = min(int((y1 + self.h) / self.texel) + 1, self.n)
            X = self.X[r0:r1, c0:c1].astype(np.float64)
            Y = self.Y[r0:r1, c0:c1].astype(np.float64)
            inside = np.zeros(X.shape, bool)
            dmin = np.full(X.shape, 1e9)
            for i in range(len(P)):
                ax, ay = P[i]
                bx, by = P[(i + 1) % len(P)]
                cond = (ay > Y) != (by > Y)
                with np.errstate(divide='ignore', invalid='ignore'):
                    xi = (bx - ax) * (Y - ay) / (by - ay + 1e-15) + ax
                inside ^= cond & (X < xi)
                ex, ey = bx - ax, by - ay
                t = np.clip(((X - ax) * ex + (Y - ay) * ey) / (ex * ex + ey * ey + 1e-15), 0, 1)
                dmin = np.minimum(dmin, np.hypot(X - ax - t * ex, Y - ay - t * ey))
            sd = np.where(inside, -dmin, dmin)
            cov = np.clip(0.5 - sd / (self.texel * 0.9), 0, 1).astype(F32)
            sub = m[r0:r1, c0:c1]
            np.maximum(sub, cov, out=sub)

    def ellipse(self, m, cx, cy, rx, ry):
        d = np.sqrt(((self.X - cx) / rx) ** 2 + ((self.Y - cy) / ry) ** 2)
        cov = np.clip((1 - d) * min(rx, ry) / (self.texel * 0.9) + 0.5, 0, 1)
        np.maximum(m, cov.astype(F32), out=m)


def bezier(p0, p1, p2, p3, n=28):
    t = np.linspace(0, 1, n)[:, None]
    p0, p1, p2, p3 = (np.asarray(p, float) for p in (p0, p1, p2, p3))
    pts = ((1 - t) ** 3) * p0 + 3 * ((1 - t) ** 2) * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3
    return [tuple(p) for p in pts], t[:, 0]


def spiral(cx, cy, r0, r1, a0, turns, n=40, cw=True):
    pts = []
    for i in range(n):
        t = i / (n - 1)
        a = a0 + (-1 if cw else 1) * turns * 2 * math.pi * t
        r = r0 + (r1 - r0) * t
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def damask_motif(texel: float):
    """Main damask medallion (0.5 m cell): a pomegranate/ogee body full of seeds, framed by big
    scalloped acanthus leaves, a palmette crown and lower scrolls. Returns (fill, veins) masks:
    fill = printed motif, veins = fine lines inside it (left in ground color)."""
    C = Cell(0.5, texel, seed=7)
    fill = C.mask()
    veins = C.mask()
    cut = C.mask()

    # --- pomegranate body (ogee outline band + seeds inside) -------------------------------------
    body_out = lambda t: 0.003 + 0.072 * np.clip(np.sin(np.pi * t ** 0.85), 0, 1) ** 0.9 * (1 - 0.25 * t)
    C.profile(fill, -0.115, 0.10, body_out)
    C.profile(cut, -0.10, 0.083, lambda t: body_out((t * 0.183 + 0.015) / 0.215) - 0.011)
    # seeds: staggered dots inside the body
    seeds = C.mask()
    for row in range(9):
        y = -0.085 + row * 0.019
        off = 0.0 if row % 2 == 0 else 0.0095
        for k in range(6):
            x = off + k * 0.019
            if x <= 0.07:
                C.dot(seeds, x, y, 0.0052, mirror=x > 0.001)
    seeds *= cut
    fill = fill * (1 - cut) + seeds
    C.ring(fill, 0.0, -0.005, 0.022, 0.03, 0.006)
    C.ellipse(fill, 0.0, -0.005, 0.011, 0.016)
    C.ellipse(veins, 0.0, -0.005, 0.0035, 0.007)

    # --- big side leaves: filled between two curves, scalloped outer edge -------------------------
    outer, t = bezier((0.03, -0.115), (0.19, -0.13), (0.245, 0.06), (0.135, 0.175), n=64)
    inner, _ = bezier((0.03, -0.115), (0.12, -0.085), (0.155, 0.04), (0.135, 0.175), n=64)
    outer = np.asarray(outer)
    # scallops: push the outer edge out in lobes along its length
    d = np.gradient(outer, axis=0)
    nrm = np.stack([d[:, 1], -d[:, 0]], 1)
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-9
    lobes = 0.011 * np.abs(np.sin(t * np.pi * 5.0)) ** 0.6 * np.sin(np.pi * t)
    outer = outer + nrm * lobes[:, None]
    leaf = np.vstack([outer, np.asarray(inner)[::-1]])
    C.poly(fill, leaf)
    # midrib + side veins
    mid = (np.asarray(outer) * 0.45 + np.asarray(inner) * 0.55)
    C.stroke(veins, [tuple(p) for p in mid[4:-6]], np.linspace(0.0035, 0.001, len(mid[4:-6])))
    for k in range(1, 5):
        i = int(k * 12.8)
        a = mid[i]
        b = np.asarray(outer[i + 5])
        C.stroke(veins, [tuple(a), tuple(a * 0.35 + b * 0.65)], [0.0022, 0.0008])
    # inner curl at the leaf tip
    C.stroke(fill, spiral(0.112, 0.152, 0.026, 0.007, math.radians(10), 0.85, cw=False), np.linspace(0.011, 0.005, 40))
    C.dot(fill, 0.112 + 0.007 * math.cos(math.radians(10) + 0.85 * 2 * math.pi),
          0.152 + 0.007 * math.sin(math.radians(10) + 0.85 * 2 * math.pi), 0.006)

    # --- palmette crown: fan of petals ------------------------------------------------------------
    for ang, ln, wd in ((90, 0.125, 0.034), (62, 0.10, 0.026), (36, 0.08, 0.020)):
        a = math.radians(ang)
        pts = []
        ws = []
        for i in range(24):
            tt = i / 23
            r = 0.012 + ln * tt
            bend = 0.0 if ang == 90 else 0.12 * tt * tt
            pts.append((r * math.cos(a - bend), 0.095 + r * math.sin(a - bend)))
            ws.append(0.003 + wd * np.clip(math.sin(math.pi * tt ** 0.7), 0, 1) ** 1.1)
        C.stroke(fill, pts, ws)
        C.stroke(veins, pts[3:-3], 0.0015)
    C.ellipse(fill, 0.0, 0.098, 0.028, 0.013)

    # --- lower scroll leaves -----------------------------------------------------------------
    outer2, t2 = bezier((0.012, -0.13), (0.07, -0.25), (0.20, -0.235), (0.205, -0.165), n=40)
    inner2, _ = bezier((0.012, -0.13), (0.06, -0.20), (0.15, -0.205), (0.205, -0.165), n=40)
    C.poly(fill, np.vstack([np.asarray(outer2), np.asarray(inner2)[::-1]]))
    C.stroke(fill, spiral(0.183, -0.152, 0.024, 0.006, math.radians(-30), 0.9, cw=False), np.linspace(0.010, 0.004, 40))
    mid2 = np.asarray(outer2) * 0.5 + np.asarray(inner2) * 0.5
    C.stroke(veins, [tuple(p) for p in mid2[3:-4]], 0.0016)
    # stem + foot
    C.profile(fill, -0.245, -0.11, lambda t: 0.006 + 0.024 * (1 - t) ** 4)
    # small pendant drops / pearls
    for (x, y, r) in ((0.215, 0.105, 0.007), (0.225, 0.07, 0.005), (0.085, 0.215, 0.006), (0.105, 0.232, 0.0045),
                      (0.225, -0.10, 0.0055)):
        C.dot(fill, x, y, r)
    fill = np.clip(fill, 0, 1)
    veins = np.clip(veins, 0, 1) * fill
    return fill.astype(F32), veins.astype(F32)


def filler_motif(texel: float):
    """Small four-petal rosette with dots, placed between the medallions."""
    C = Cell(0.25, texel, seed=9)
    k = 1.45  # scale
    fill = C.mask()
    veins = C.mask()
    for a in (0, 90, 180, 270):
        ar = math.radians(a)
        ln = 1.25 if a in (90, 270) else 1.0
        cx, cy = 0.032 * k * ln * math.cos(ar), 0.032 * k * ln * math.sin(ar)
        C.dot(fill, cx, cy, 0.012 * k, ry=0.026 * k * ln, rot=ar + math.pi / 2, mirror=False)
        C.dot(veins, cx, cy, 0.0018, ry=0.018 * k * ln, rot=ar + math.pi / 2, mirror=False)
    for a in (45, 135, 225, 315):
        ar = math.radians(a)
        C.dot(fill, 0.052 * k * math.cos(ar), 0.052 * k * math.sin(ar), 0.006 * k, mirror=False)
        pts, t = bezier((0.016 * k * math.cos(ar), 0.016 * k * math.sin(ar)),
                        (0.06 * k * math.cos(ar + 0.4), 0.06 * k * math.sin(ar + 0.4)),
                        (0.085 * k * math.cos(ar), 0.085 * k * math.sin(ar)),
                        (0.072 * k * math.cos(ar - 0.4), 0.072 * k * math.sin(ar - 0.4)), n=20)
        C.stroke(fill, pts, 0.0018 + 0.006 * np.sin(np.pi * t), mirror=False)
    C.ring(fill, 0, 0, 0.016 * k, 0.016 * k, 0.005)
    C.ellipse(fill, 0, 0, 0.007 * k, 0.007 * k)
    veins *= fill
    return fill, veins


def paste(T: Tex, dst: np.ndarray, src: np.ndarray, cu: float, cv: float, mode='max') -> None:
    """Paste a square cell raster centered at tile coords (cu, cv) (wraps)."""
    k = src.shape[0]
    c0 = int(round(cu * T.n - k / 2))
    r0 = int(round(cv * T.n - k / 2))
    idx = np.ix_(np.arange(r0, r0 + k) % T.n, np.arange(c0, c0 + k) % T.n)
    if mode == 'max':
        dst[idx] = np.maximum(dst[idx], src)
    else:
        dst[idx] = dst[idx] + src


# =============================================================================================
# Shared paper base
# =============================================================================================

def paper_fibers(T: Tex) -> np.ndarray:
    """Paper surface: fine fibrous grain + soft cockling, height in meters."""
    fib = T.spectral(beta=1.2, fmin=60, fmax=420)
    streak = T.spectral(beta=1.6, fmin=30, aniso=(1.0, 3.0))  # fibers slightly vertical
    cockle = T.fbm(5, octaves=3)
    return (fib * 0.000012 + streak * 0.000010 + cockle * 0.00012).astype(F32)


def strip_shift(T: Tex, a: np.ndarray, dv_m: float) -> np.ndarray:
    """Shift the right-hand strip (u in 0.5..1) vertically by dv_m: hung slightly out of match."""
    out = a.copy()
    half = T.n // 2
    k = int(round(dv_m / T.texel))
    out[:, half:] = np.roll(a[:, half:], k, axis=0)
    return out


# =============================================================================================
# wallpaper_a: olive / sepia damask
# =============================================================================================

def wallpaper_a(n: int = 1024, seed: int = 11) -> dict:
    T = Tex(n, 1.0, seed)
    rng = T.rng
    F = G.Fields(T)

    main, mveins = damask_motif(T.texel)
    fil, fveins = filler_motif(T.texel)
    motif = T.zeros()
    veins = T.zeros()
    for cu, cv in ((0.25, 0.25), (0.75, 0.75), (0.25, 0.75), (0.75, 0.25)):
        is_main = (cu, cv) in ((0.25, 0.25), (0.75, 0.75))
        paste(T, motif, main if is_main else fil, cu, cv)
        paste(T, veins, mveins if is_main else fveins, cu, cv)
    motif = strip_shift(T, motif, 0.004)
    veins = strip_shift(T, veins, 0.004)

    # print: slightly misregistered dark keyline under the motif layer, patchy ink
    key = np.clip(T.blur(motif, 1.6) * 1.6 - 0.25, 0, 1) - motif * 0.85
    key = np.clip(key, 0, 1)
    ink = np.clip(0.82 + 0.18 * F.detail + 0.1 * T.fbm(40, octaves=2), 0, 1)
    m = motif * ink * (1 - 0.8 * veins)

    ground = hexc('#6b6546')
    ground2 = hexc('#5e583b')
    motif_c = hexc('#8c8160')
    key_c = hexc('#4a4530')
    # mottled ground (hand-printed look): two tones through mid noise
    gmix = sstep(-0.4, 0.6, T.fbm(14, octaves=3))
    base = lerp(T.full(ground), T.full(ground2), gmix * 0.6)
    # faint vertical satin stripes in the ground
    # silk-moire ground: fine vertical ribs, gently warped
    wv = T.fbm(4, 2, octaves=3) * 0.004
    satin = 0.5 + 0.5 * np.sin((T.u + wv) * 2 * math.pi * 180)
    moire = 0.5 + 0.5 * np.sin((T.u * 3 + T.fbm(3, 6, octaves=2) * 0.6) * 2 * math.pi)
    base = base * (1 - (0.03 * satin + 0.04 * moire))[..., None]
    L = G.Layers(T, base, rough=0.82)
    L.paint(key, key_c, 0.55)
    L.paint(m, motif_c, 1.0, rough=0.58)
    # flocked / embossed motif
    L.height += T.blur(motif, 1.2) * 0.00009 - T.blur(veins, 0.8) * 0.00004
    L.height += paper_fibers(T)
    # fiber color noise
    L.multiply(np.clip(T.spectral(beta=1.0, fmin=80) * 0.5 + 0.5, 0, 1), (0.93, 0.93, 0.9), 0.5)

    # --- aging -------------------------------------------------------------------------------
    G.fade(L, F, amount=0.10, desat=0.78, grime=(0.80, 0.76, 0.68), grime_amount=0.4)

    # water stains (two medium, one small) + drips
    st1 = G.water_stain(L, F, 0.62, 0.62, 0.17, stretch=(0.8, 1.25), strength=0.9, rings=3, buckle=0.0007)
    st2 = G.water_stain(L, F, 0.12, 0.30, 0.11, stretch=(1.0, 1.4), strength=0.7, rings=2, buckle=0.0004)
    G.water_stain(L, F, 0.88, 0.12, 0.05, strength=0.55, rings=1, buckle=0.0002)
    G.drip(L, 0.60, 0.46, 0.26, 0.010, strength=0.55)
    G.drip(L, 0.66, 0.47, 0.17, 0.006, strength=0.45)
    G.drip(L, 0.10, 0.18, 0.12, 0.007, strength=0.4)
    # mildew around the larger stain and in a corner of the second
    G.mildew(L, F, 0.70, 0.52, 0.09, density=0.75)
    G.mildew(L, F, 0.05, 0.22, 0.07, density=0.8)
    G.mildew(L, F, 0.40, 0.95, 0.05, density=0.5)
    # hip-height rubs (v 0.80..0.98)
    G.scuff_band(L, F, 0.80, 0.98, strength=0.8, scratches=26)
    G.fly_specks(L, 260)
    # seams: one tight, one lifting in two places
    G.paper_seam(L, F, 0.0, lifts=[(0.55, 0.92, 1, 0.0022), (0.05, 0.22, -1, 0.0012)])
    G.paper_seam(L, F, 0.5, lifts=[(0.30, 0.48, 1, 0.0016)])
    # small tear near the lifting seam showing bare plaster
    plaster = T.full(hexc('#776a52')) * (0.85 + 0.15 * F.detail + 0.1 * F.warp_hi)[..., None]
    G.tear(L, F, 0.03, 0.80, 0.03, 0.045, plaster, depth=0.0003)

    return G.finish(L, normal_strength=1.6, cavity_radii=(0.0015, 0.006), cavity_scale=0.0002,
                    ao_strength=0.5, color_cavity=0.18, roll=(0.125, 0.0))


# =============================================================================================
# wallpaper_b: dusty blue-gray regency stripe with small diamonds
# =============================================================================================

def wallpaper_b(n: int = 1024, seed: int = 23) -> dict:
    T = Tex(n, 1.0, seed)
    rng = T.rng
    F = G.Fields(T)

    period = 1.0 / 8  # 12.5 cm stripe repeat, 4 per strip
    wob = T.fbm(2, 12, octaves=3) * 0.0012  # hand-printed stripes wander a little
    x = ((T.u + wob) % period) / period  # 0..1 inside one repeat
    wide = sstep(0.015, 0.03, x) * sstep(0.505, 0.49, x)
    pin1 = np.exp(-((x - 0.53) / 0.008) ** 2)
    pin2 = np.exp(-((x - 0.97) / 0.008) ** 2)
    hair = np.exp(-((x - 0.75) / 0.004) ** 2)

    band_c = hexc('#5b6468')
    light_c = hexc('#7f837c')
    pin_c = hexc('#9c9b8a')
    diamond_c = hexc('#545c60')

    base = lerp(T.full(light_c), T.full(band_c), wide)
    L = G.Layers(T, base, rough=0.8)
    L.paint(pin1 + pin2, pin_c, 0.8, rough=0.6)
    L.paint(hair, band_c, 0.6)
    # small diamonds in the light band, on a 1/30 m vertical pitch, alternating offset
    dx = (x - 0.75) * period
    pitch = 1.0 / 32
    vy = (T.v % pitch) / pitch - 0.5
    dmd = np.clip(1 - (np.abs(dx) / 0.0055 + np.abs(vy * pitch) / 0.0085), 0, 1)
    dmd = sstep(0.0, 0.18, dmd)
    dot = np.clip(1 - np.sqrt((dx / 0.0016) ** 2 + (((T.v + pitch / 2) % pitch / pitch - 0.5) * pitch / 0.0016) ** 2), 0, 1)
    L.paint(dmd, diamond_c, 0.85, rough=0.62)
    L.paint(sstep(0, 0.3, dot), pin_c, 0.7)
    # wide band: fine moire "silk" texture
    silk = T.spectral(beta=1.4, fmin=40, aniso=(1.0, 8.0))
    L.multiply(np.clip(silk * 0.3 + 0.5, 0, 1) * wide, (0.88, 0.9, 0.92), 0.6)
    L.height += (pin1 + pin2) * 0.00003 + dmd * 0.00004 + paper_fibers(T)
    L.multiply(np.clip(T.spectral(beta=1.0, fmin=80) * 0.5 + 0.5, 0, 1), (0.93, 0.93, 0.93), 0.5)
    L.color = strip_shift(T, L.color, 0.0)

    G.fade(L, F, amount=0.10, desat=0.72, grime=(0.80, 0.76, 0.68), grime_amount=0.5)
    G.water_stain(L, F, 0.30, 0.70, 0.14, stretch=(0.85, 1.3), strength=0.85, rings=3, buckle=0.0006,
                  tint=(0.84, 0.76, 0.60), warp=0.6)
    G.water_stain(L, F, 0.85, 0.35, 0.08, stretch=(1.0, 1.2), strength=0.6, rings=2, buckle=0.0003)
    G.drip(L, 0.28, 0.54, 0.30, 0.009, strength=0.55)
    G.drip(L, 0.35, 0.56, 0.20, 0.006, strength=0.4)
    G.drip(L, 0.83, 0.27, 0.10, 0.005, strength=0.35)
    G.mildew(L, F, 0.22, 0.60, 0.09, density=0.9)
    G.mildew(L, F, 0.92, 0.42, 0.05, density=0.6)
    G.scuff_band(L, F, 0.80, 0.98, strength=0.9, scratches=30)
    G.fly_specks(L, 220)
    G.paper_seam(L, F, 0.0, lifts=[(0.20, 0.45, -1, 0.0018)])
    G.paper_seam(L, F, 0.5, lifts=[(0.62, 0.98, 1, 0.0025), (0.02, 0.12, -1, 0.0010)])

    # a torn patch revealing the OLDER damask paper underneath (and a bit of plaster)
    # (kept small and quiet: anything distinctive repeats every meter along a wall)
    old = wallpaper_a_color_only(T) * T.full((0.62, 0.62, 0.60))
    G.tear(L, F, 0.515, 0.86, 0.018, 0.028, old, depth=0.0002, rim=(0.70, 0.70, 0.66))

    return G.finish(L, normal_strength=1.6, cavity_radii=(0.0015, 0.006), cavity_scale=0.0002,
                    ao_strength=0.5, color_cavity=0.18, roll=(0.125, 0.0))


def wallpaper_a_color_only(T: Tex) -> np.ndarray:
    """Cheap version of the damask (no grime) to show under torn top paper."""
    main, _ = damask_motif(T.texel)
    m = T.zeros()
    paste(T, m, main, 0.53, 0.8)
    base = T.full(hexc('#6f6a4a'))
    c = lerp(base, T.full(hexc('#8e845e')), m)
    return (c * 0.92).astype(F32)
