"""
Wood texture sets (numpy, periodic):
  * wood_floor: 2.0 m x 2.0 m of worn oak strip flooring. 22 rows of ~9.1 cm planks running along
    u, staggered butt joints, dusty gaps, cupped boards, scratches, face nails on 40 cm joists and
    a darker, grimier high-traffic patina.
  * wood_trim: 0.5 m x 0.5 m of chipped cream enamel (over an older green coat) on dark wood, for
    baseboards and casings. Grain and brush strokes run along u.
Helper module only: build() is a no-op (surfaces.py builds the sets).
"""

from __future__ import annotations

import math

import numpy as np

import surfaces_grime as G
from surfaces_lib import F32, Tex, hexc, lerp, sstep


def build() -> None:
    print('surfaces_wood: helper module (built through surfaces.py)')


# =============================================================================================
# Grain
# =============================================================================================

def ring_grain(xl, yl, *, pith_y, depth, tilt, spacing, wobble, late=0.25):
    """Flat-sawn growth rings on a board: distance from the (tilted) log axis, banded.
    xl, yl: meters along / across the board. Returns (rings 0..1 latewood, ring coordinate)."""
    z = depth + tilt * xl
    r = np.sqrt((yl - pith_y) ** 2 + z * z) + wobble
    f = (r / spacing) % 1.0
    lw = sstep(1 - late - 0.12, 1 - late, f) * (1 - sstep(0.97, 1.0, f))
    return lw.astype(F32), r


def plank_layout(rng, rows: int, length: float, min_piece=0.45, max_piece=1.5, stagger=0.15):
    """Per row: sorted joint positions (meters, mod length), staggered against the row below."""
    layout = []
    prev = []
    for r in range(rows):
        for _ in range(200):
            start = rng.uniform(0, length)
            joints = [start]
            pos = 0.0
            while True:
                piece = rng.uniform(min_piece, max_piece)
                if pos + piece > length - min_piece:
                    break
                pos += piece
                joints.append((start + pos) % length)
            ok = all(min(abs(j - p), length - abs(j - p)) > stagger for j in joints for p in prev)
            if r == rows - 1 and ok:  # also stagger against row 0 (wraps)
                ok = all(min(abs(j - p), length - abs(j - p)) > stagger for j in joints for p in layout[0])
            if ok:
                break
        layout.append(sorted(joints))
        prev = joints
    return layout


# =============================================================================================
# wood_floor
# =============================================================================================

def wood_floor(n: int = 1024, seed: int = 41) -> dict:
    T = Tex(n, 2.0, seed)
    rng = T.rng
    F = G.Fields(T)
    rows = 22
    pw = T.size_m / rows  # plank width (m)
    X = T.u * T.size_m
    Yr = T.v * rows
    row = np.floor(Yr).astype(np.int64) % rows
    yl = (Yr - np.floor(Yr)) * pw  # meters across the plank

    layout = plank_layout(rng, rows, T.size_m)
    xl = T.zeros()          # meters along the piece
    plen = T.zeros()        # piece length
    pid = np.zeros((n, n), np.int64)
    for r, joints in enumerate(layout):
        sel = row == r
        x = X[sel]
        js = np.asarray(joints)
        # index of the joint at or before x (cyclic)
        k = np.searchsorted(js, x, side='right') - 1
        start = js[k % len(js)]
        nxt = js[(k + 1) % len(js)]
        xl[sel] = (x - start) % T.size_m
        plen[sel] = (nxt - start) % T.size_m + (T.size_m if len(js) == 1 else 0)
        pid[sel] = r * 16 + (k % len(js))

    npieces = rows * 16
    P = {
        'tone': rng.normal(1.0, 0.09, npieces).clip(0.75, 1.25),
        'warm': rng.normal(0.0, 0.04, npieces),
        'pith': rng.uniform(-0.12, 0.2, npieces),
        'depth': rng.uniform(0.01, 0.09, npieces),
        'tilt': rng.normal(0, 0.035, npieces),
        'spacing': rng.uniform(0.0026, 0.0055, npieces),
        'cup': rng.uniform(0.0001, 0.0005, npieces),
        'lip': rng.normal(0, 0.00025, npieces),
        'gray': rng.uniform(0, 1, npieces),
    }
    g = lambda k: P[k][pid].astype(F32)

    wob = (T.fbm(3, 40, octaves=4) * 0.006 + T.fbm(12, 160, octaves=2) * 0.0012).astype(F32)
    late, rr = ring_grain(xl, yl, pith_y=g('pith'), depth=g('depth'), tilt=g('tilt'), spacing=g('spacing'),
                          wobble=wob)
    # oak pores: fine dark dashes along the grain, denser in earlywood
    # (lattice periods stay below the pixel Nyquist limit: 512 cells across 1024 px)
    pores = T.perlin(70, 420) * 0.6 + T.perlin(40, 260) * 0.4
    pores = sstep(0.3, 0.75, pores) * (1 - late * 0.6)
    fine = T.perlin(16, 200) * 0.5 + 0.5  # subtle streaky figure

    early_c = hexc('#664a33')
    late_c = hexc('#423020')
    base = lerp(T.full(early_c), T.full(late_c), late * 0.85)
    base = base * (0.9 + 0.12 * fine)[..., None]
    base = lerp(base, T.full(hexc('#3a2818')), pores * 0.55)
    tone = g('tone')[..., None]
    warm = g('warm')[..., None]
    base = base * tone * (1 + np.concatenate([warm, warm * 0.2, -warm], -1))
    # some boards have weathered grayer (sun / old water)
    gray = sstep(0.75, 1.0, g('gray'))
    l = (base[..., 0] * 0.3 + base[..., 1] * 0.6 + base[..., 2] * 0.1)[..., None]
    base = lerp(base, l * np.array([1.05, 1.0, 0.94], F32), gray * 0.35)

    L = G.Layers(T, base, rough=0.55)
    L.rough += late * 0.05 + pores * 0.1

    # --- geometry: cupping, lippage, gaps, end joints ---------------------------------------------
    across = yl / pw  # 0..1
    cup = (2 * across - 1) ** 2 * g('cup')
    edge_d = np.minimum(yl, pw - yl)  # meters to the long edges
    end_d = np.minimum(xl, plen - xl)  # meters to the butt joints
    gap_w = 0.0012 + 0.0009 * (0.5 + 0.5 * T.fbm(2, 30, octaves=2))
    side_gap = sstep(gap_w, gap_w * 0.4, edge_d)
    end_gap = sstep(0.0013, 0.0004, end_d)
    gap = np.clip(side_gap + end_gap, 0, 1)
    round_over = sstep(0.004, 0.0, np.minimum(edge_d, end_d)) * 0.00035
    L.height += cup + g('lip') - round_over - gap * 0.002

    # --- finish, patina, dust ----------------------------------------------------------------------
    traffic = sstep(-0.15, 0.55, T.fbm(2, 3, octaves=4) + 0.25 * T.fbm(8, octaves=2))
    # patina: ground-in dirt, darker + grayer, worn smooth
    L.multiply(traffic, (0.66, 0.62, 0.58), 0.6)
    L.rough = L.rough + (0.42 - L.rough) * traffic * 0.6
    # remaining amber finish crazes and dulls elsewhere
    craze_f1, craze_f2, _ = T.worley(int(T.size_m / 0.012))
    craze = sstep(0.05, 0.0, craze_f2 - craze_f1) * (1 - traffic) * 0.5
    L.paint(craze.astype(F32), hexc('#2e2116'), 0.35)
    # dust film: lighter + rougher, heavier away from traffic, settles along edges
    dust_n = sstep(-0.2, 0.7, T.fbm(6, octaves=4))
    dust = np.clip((1 - traffic) * (0.35 + 0.5 * dust_n), 0, 1)
    L.paint(dust, hexc('#8a8072'), 0.28, rough=0.85, rough_mix=0.6)
    edge_dust = sstep(0.006, 0.0, np.minimum(edge_d, end_d)) * (0.4 + 0.6 * dust_n)
    L.paint(edge_dust.astype(F32), hexc('#7a7166'), 0.35)

    # gaps: dark depth, partly packed with gray fluff
    fluff = sstep(0.1, 0.5, T.fbm(60, octaves=3)) * gap
    L.paint(gap, hexc('#140e09'), 0.92, rough=0.95)
    L.paint(fluff.astype(F32), hexc('#6d665c'), 0.7)
    L.height += fluff * 0.0012
    L.ao *= 1 - 0.7 * gap * (1 - fluff)

    # --- scratches + gouges --------------------------------------------------------------------
    sc = T.zeros()
    for _ in range(420):
        x, y = rng.random(2) * n
        ln = T.px(rng.uniform(0.03, 0.4))
        a = rng.normal(0, 0.12) if rng.random() < 0.75 else rng.uniform(0, math.pi)
        a += math.pi if rng.random() < 0.5 else 0
        pts = T.crack_path(x, y, ln, a, step=5, wiggle=0.04)
        T.stroke(sc, pts, rng.uniform(0.5, 1.2), soft=0.6, value=rng.uniform(0.25, 0.9))
    swirl = T.zeros()
    for _ in range(30):  # chair-leg arcs
        cx, cy = rng.random(2) * n
        r = T.px(rng.uniform(0.02, 0.08))
        a0 = rng.uniform(0, 6.28)
        pts = [(cx + r * math.cos(a0 + t), cy + r * math.sin(a0 + t)) for t in np.linspace(0, rng.uniform(0.6, 2.5), 20)]
        T.stroke(swirl, pts, 0.8, soft=0.6, value=0.6)
    scr = np.clip(sc + swirl, 0, 1)
    L.paint(scr, hexc('#8c7258'), 0.45, rough=0.75)
    L.height -= scr * 0.00012
    gouge = T.zeros()
    for _ in range(14):
        x, y = rng.random(2) * n
        T.blob(gouge, x, y, rng.uniform(1.5, 5), rng.uniform(1, 2.5), rot=rng.uniform(0, 3.14), soft=1.2)
    L.paint(gouge, hexc('#2a1c11'), 0.6, rough=0.85)
    L.height -= gouge * 0.0006

    # --- face nails on the joists (every 0.4 m), both edges of some boards -------------------------
    nails = T.zeros()
    rust = T.zeros()
    for r in range(rows):
        for j in range(5):
            if rng.random() < 0.45:
                continue
            x = (j * 0.4 + 0.2 + rng.normal(0, 0.004)) / T.size_m * n
            for side in (0.18, 0.82):
                if rng.random() < 0.3:
                    continue
                y = (r + side + rng.normal(0, 0.02)) / rows * n
                rad = rng.uniform(1.4, 2.0)
                T.blob(nails, x, y, rad, rad, soft=0.7)
                T.blob(rust, x, y, rad * 3, rad * 3, soft=2.0, falloff='smooth', value=rng.uniform(0.3, 0.8))
    L.paint(rust, hexc('#3a2414'), 0.5)
    L.paint(nails, hexc('#2c2a27'), 0.95, rough=0.55)
    L.metal += nails * 0.55
    L.height -= nails * 0.0002

    # --- stains: a dark spill, a pale ring where a pot stood, a few drips -------------------------
    G.water_stain(L, F, 0.70, 0.30, 0.16, stretch=(1.3, 0.9), strength=0.7, rings=2,
                  tint=(0.70, 0.64, 0.58), tide=(0.15, 0.10, 0.06), warp=0.5)
    G.water_stain(L, F, 0.22, 0.78, 0.07, strength=0.6, rings=1, tint=(0.95, 0.92, 0.86), tide=(0.24, 0.17, 0.10))
    G.fly_specks(L, 200, color=(0.08, 0.06, 0.04), size_px=(0.5, 1.4), opacity=0.6)

    return G.finish(L, normal_strength=1.3, cavity_radii=(0.004, 0.012), cavity_scale=0.0004,
                    ao_strength=0.55, color_cavity=0.15)


# =============================================================================================
# wood_trim
# =============================================================================================

def wood_trim(n: int = 1024, seed: int = 53) -> dict:
    T = Tex(n, 0.5, seed)
    rng = T.rng
    F = G.Fields(T)

    # --- wood underneath: dark stained fir, straight grain along u ---------------------------------
    wob = T.fbm(2, 12, octaves=4) * 0.004 + T.fbm(6, 60, octaves=2) * 0.0006
    yl = T.v * T.size_m
    lw, _ = ring_grain(T.u * T.size_m, yl, pith_y=-0.05, depth=0.06, tilt=0.01, spacing=0.0028, wobble=wob, late=0.3)
    wood = lerp(T.full(hexc('#4a3322')), T.full(hexc('#2a1b11')), lw)
    wood = wood * (0.9 + 0.15 * (T.perlin(20, 400) * 0.5 + 0.5))[..., None]

    # --- paint stack: old sage green coat, then cream enamel ---------------------------------------
    green = T.full(hexc('#6e745e')) * (0.95 + 0.05 * F.detail)[..., None]
    cream = T.full(hexc('#bcb196'))
    L = G.Layers(T, cream, rough=0.42)

    # brush strokes along u (ridges in the enamel) + orange peel
    brush = T.spectral(beta=1.8, fmin=6, aniso=(14.0, 1.0))
    brush_fine = T.spectral(beta=1.2, fmin=40, aniso=(10.0, 1.0))
    L.height += brush * 0.00004 + brush_fine * 0.000015
    L.multiply(np.clip(brush * 0.2 + 0.5, 0, 1), (0.96, 0.95, 0.93), 0.6)
    # grain telegraphing through the paint
    L.height += lw * 0.00002
    # yellowing + dirt (nicotine / handling), uneven
    G.fade(L, F, amount=0.0, desat=0.92, grime=(0.84, 0.79, 0.68), grime_amount=0.55)

    # --- alligator crazing in patches ---------------------------------------------------------------
    f1, f2, cid = T.worley(int(T.size_m / 0.009), jitter=0.9)
    zone = sstep(0.0, 0.45, T.fbm(4, octaves=3))
    crack_line = sstep(0.06, 0.0, f2 - f1) * zone
    curl = sstep(0.3, 0.0, f2 - f1) * zone  # cell edges lift slightly
    L.paint(crack_line.astype(F32), hexc('#3b3226'), 0.8, rough=0.8)
    L.height += curl * 0.00004 - crack_line * 0.00008

    # --- chips: top coat lost (green shows), deeper chips to bare wood ------------------------------
    chip_n = T.fbm(14, octaves=5, gain=0.58) + 0.12 * T.fbm(90, octaves=2)
    chip_zone = sstep(-0.1, 0.6, T.fbm(3, octaves=3))
    thr1 = 0.42 - 0.3 * chip_zone
    top_lost = sstep(thr1, thr1 + 0.015, chip_n)
    thr2 = thr1 + 0.07
    wood_bare = sstep(thr2, thr2 + 0.015, chip_n) * (0.4 + 0.6 * sstep(0.2, 0.5, F.warp_hi * 0.5 + 0.5))
    # small knocks along everywhere
    knocks = T.zeros()
    for _ in range(90):
        x, y = rng.random(2) * n
        r = rng.uniform(2, 9)
        T.blob(knocks, x, y, r * rng.uniform(1, 2.5), r, rot=rng.normal(0, 0.3), soft=1.0)
    knocks = knocks * sstep(-0.3, 0.3, F.detail + 0.2)
    top_lost = np.clip(top_lost + knocks, 0, 1)
    wood_bare = np.clip(wood_bare + knocks * sstep(0.2, 0.5, F.at(F.detail, 0.3, 0.6)), 0, 1) * top_lost

    L.color = L.color + (green - L.color) * top_lost[..., None]
    L.rough = L.rough + (0.6 - L.rough) * top_lost
    L.color = L.color + (wood - L.color) * wood_bare[..., None]
    L.rough = L.rough + (0.72 - L.rough) * wood_bare
    # chip edges: paint thickness steps, light rim on the cream, grime in the step
    rim = np.clip(T.blur(top_lost, 1.2) - top_lost, 0, 1) * 2.0
    L.paint(np.clip(rim, 0, 1), hexc('#d3c9ad'), 0.45)
    L.paint(np.clip(T.blur(top_lost, 2.5) - top_lost, 0, 1) * 0.8, hexc('#5d5240'), 0.35)
    L.height = L.height - top_lost * 0.00012 - wood_bare * 0.0001
    L.ao *= 1 - 0.25 * np.clip(T.blur(top_lost, 1.5) - top_lost, 0, 1)

    # --- scuffs (shoes, mop, furniture) + specks ---------------------------------------------------
    scuff = np.clip(T.spectral(beta=2.0, fmin=2, aniso=(10.0, 1.0)) * 0.5 - 0.4, 0, 1)
    L.paint(scuff.astype(F32), hexc('#3a352d'), 0.4)
    G.fly_specks(L, 160, size_px=(0.8, 2.0))
    return G.finish(L, normal_strength=1.5, cavity_radii=(0.0008, 0.003), cavity_scale=0.00008,
                    ao_strength=0.5, color_cavity=0.2)
