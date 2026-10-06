"""
plaster_ceiling texture set (numpy, periodic): 2.0 m x 2.0 m of aged, hand-troweled plaster with
yellowed paint, hairline crack networks, brown water-stain rings and flaking paint.
Helper module only: build() is a no-op (surfaces.py builds the sets).
"""

from __future__ import annotations

import math

import numpy as np

import surfaces_grime as G
from surfaces_lib import F32, Tex, hexc, lerp, sstep


def build() -> None:
    print('surfaces_plaster: helper module (built through surfaces.py)')


def trowel_marks(T: Tex, count: int) -> np.ndarray:
    """Overlapping shallow trowel arcs: ridged height (meters)."""
    rng = T.rng
    ridge = T.zeros()
    for _ in range(count):
        cx, cy = rng.random(2) * T.n
        r = T.px(rng.uniform(0.08, 0.35))
        a0 = rng.uniform(0, 2 * math.pi)
        span = rng.uniform(0.5, 1.4)
        k = 24
        pts = [(cx + r * math.cos(a0 + span * i / k), cy + r * math.sin(a0 + span * i / k)) for i in range(k + 1)]
        w = np.sin(np.linspace(0, math.pi, k + 1)) * rng.uniform(1.0, 2.6) + 0.3
        T.stroke(ridge, pts, w, soft=1.5, mode='max', value=rng.uniform(0.4, 1.0))
    return T.blur(ridge, 1.0) * 0.00012


def plaster_ceiling(n: int = 1024, seed: int = 31) -> dict:
    T = Tex(n, 2.0, seed)
    rng = T.rng
    F = G.Fields(T)

    paint = hexc('#aaa493')
    L = G.Layers(T, T.full(paint), rough=0.86)
    # --- surface relief: undulation, trowel arcs, sand grain ---------------------------------------
    L.height += T.fbm(4, octaves=4) * 0.0012
    L.height += trowel_marks(T, 140)
    grain = T.spectral(beta=1.1, fmin=120)
    L.height += grain * 0.000025
    L.height += T.fbm(30, octaves=3) * 0.00008
    stip = T.spectral(beta=0.6, fmin=200)
    L.height += np.clip(stip, 0, None) * 0.00003  # sand-float stipple
    # color: patchy yellowing + dust, slight value noise from the grain
    yell = sstep(-0.3, 0.7, T.fbm(3, octaves=4))
    L.multiply(yell, (0.93, 0.89, 0.80), 0.7)
    L.multiply(np.clip(grain * 0.25 + 0.5, 0, 1), (0.95, 0.95, 0.94), 0.6)
    G.fade(L, F, amount=0.05, desat=0.9, grime=(0.86, 0.84, 0.80), grime_amount=0.45)

    # --- joist ghosting: faint soot lines where the cold joists sit above (every 0.4 m) -----------
    ju = (T.u * 5.0) % 1.0
    ghost = np.exp(-((ju - 0.5) / 0.05) ** 2) * np.clip(0.5 + 0.8 * T.fbm(2, 6, octaves=3), 0, 1)
    L.multiply(ghost.astype(F32), (0.9, 0.89, 0.87), 0.45)

    # --- water stains (big ring stain + a smaller one + a faint one) --------------------------------
    st1 = G.water_stain(L, F, 0.30, 0.62, 0.30, stretch=(1.1, 0.9), strength=0.72, rings=6, buckle=0.0012,
                        tint=(0.93, 0.86, 0.72), tide=(0.42, 0.30, 0.17), warp=0.6)
    st2 = G.water_stain(L, F, 0.78, 0.22, 0.17, stretch=(0.9, 1.15), strength=0.6, rings=4, buckle=0.0008,
                        tint=(0.93, 0.87, 0.74), tide=(0.44, 0.33, 0.19), warp=0.6)
    G.water_stain(L, F, 0.80, 0.80, 0.07, strength=0.5, rings=1, tint=(0.94, 0.9, 0.8))

    # --- flaking paint: clusters near the stain centers, a few strays ---------------------------------
    du, dv = T.tdelta(0.27, 0.60)
    core1 = np.clip(1 - np.sqrt((du * 2) ** 2 + (dv * 2) ** 2) / 0.30, 0, 1) ** 0.7
    du, dv = T.tdelta(0.79, 0.23)
    core2 = np.clip(1 - np.sqrt((du * 2) ** 2 + (dv * 2) ** 2) / 0.16, 0, 1) ** 0.7
    flake_zone = np.clip(core1 * st1 * 1.3 + core2 * st2 * 1.1 + sstep(0.45, 0.7, T.fbm(5, octaves=3)) * 0.25, 0, 1)
    fl_noise = T.fbm(16, octaves=5, gain=0.55) + 0.15 * T.fbm(120, octaves=2)
    thr = 0.5 - 0.56 * flake_zone
    flake = (sstep(thr, thr + 0.02, fl_noise) * (flake_zone > 0.03)).astype(F32)
    gran = T.spectral(beta=0.9, fmin=100)
    under = T.full(hexc('#a39d8f')) * (0.88 + 0.08 * F.detail + 0.05 * gran)[..., None]
    # water carried tannins into the bare plaster: brown blotches inside the flakes
    under = lerp(under, under * np.array([0.82, 0.72, 0.56], F32), sstep(0.0, 0.6, F.at(F.warp_hi, 0.4, 0.1)) * 0.6)
    # residue islands of paint left inside the bare patches
    resid = sstep(0.55, 0.6, T.fbm(90, octaves=2) * 0.5 + 0.5)
    # an older, more yellow paint layer shows around the bigger flakes
    old_layer = sstep(thr - 0.04, thr - 0.02, fl_noise) * (1 - flake) * (flake_zone > 0.03)
    L.paint(old_layer.astype(F32), hexc('#a39673'), 0.8)
    flake = (flake * (1 - resid)).astype(F32)
    L.color = L.color + (under - L.color) * flake[..., None]
    L.rough = L.rough + (0.95 - L.rough) * flake
    edge = np.clip(T.blur(flake, 1.0) - flake, 0, 1) * 2.5
    L.paint(np.clip(edge, 0, 1), hexc('#c9c4b5'), 0.6)  # curled paint edges catch light
    L.height = L.height - flake * 0.0003 - old_layer * 0.0001 + np.clip(edge, 0, 1) * 0.0002
    L.ao *= 1 - 0.3 * np.clip(T.blur(flake, 1.5) - flake, 0, 1)

    # --- cracks (darkness varies along their length) -------------------------------------------------
    hair = T.zeros()
    T.crack_network(hair, 26, length_px=(60, 260), width=(0.7, 1.3), branch=0.7, wiggle=0.55, depth=2)
    big = T.zeros()
    T.crack_network(big, 3, length_px=(350, 600), width=(1.6, 2.2), branch=1.0, wiggle=0.35, depth=2)
    vary = np.clip(0.55 + 0.6 * T.fbm(20, octaves=3), 0.15, 1)
    cracks = np.clip(hair * 0.8 * vary + big * np.clip(vary + 0.3, 0, 1), 0, 1)
    L.paint(cracks, hexc('#3d3427'), 0.75, rough=0.95)
    L.paint(np.clip(T.blur(big, 2.0) * 1.5 - big, 0, 1), hexc('#7d7564'), 0.35)  # dirt halo
    L.height -= cracks * 0.0003
    L.ao *= 1 - 0.55 * cracks

    # --- mold specks + soot near the stains ---------------------------------------------------------
    G.mildew(L, F, 0.20, 0.56, 0.12, density=0.8, color=(0.20, 0.19, 0.14))
    G.mildew(L, F, 0.86, 0.16, 0.06, density=0.6, color=(0.20, 0.19, 0.14))
    G.fly_specks(L, 380, size_px=(0.5, 1.2), opacity=0.7)

    return G.finish(L, normal_strength=1.4, cavity_radii=(0.003, 0.012), cavity_scale=0.0003,
                    ao_strength=0.6, color_cavity=0.2)
