"""
tile_floor texture set (numpy, periodic): 1.0 m x 1.0 m of grimy black-and-white checkered
ceramic tile (8 x 8 tiles of 12.5 cm, ~3 mm dark grout). Yellowed, crazed white glaze, worn black
tiles, uneven lippage (each tile tilts a little, so the flash glints differently per tile), cracked
and chipped tiles, a broken one with a missing shard, grime collected along the grout.
Helper module only: build() is a no-op (surfaces.py builds the sets).
"""

from __future__ import annotations

import math

import numpy as np

import surfaces_grime as G
from surfaces_lib import F32, Tex, hexc, lerp, sstep, standardize


def build() -> None:
    print('surfaces_tile: helper module (built through surfaces.py)')


def tile_floor(n: int = 1024, seed: int = 61) -> dict:
    T = Tex(n, 1.0, seed)
    rng = T.rng
    F = G.Fields(T)
    k = 8
    size = T.size_m / k
    gx = T.u * k
    gy = T.v * k
    ix = np.floor(gx).astype(np.int64) % k
    iy = np.floor(gy).astype(np.int64) % k
    tid = iy * k + ix
    lx = (gx - np.floor(gx)) * size  # meters inside the tile
    ly = (gy - np.floor(gy)) * size
    white = ((ix + iy) % 2 == 0)

    # hand-set tiles: grout width wanders a little
    grout_half = 0.0015 + 0.0005 * T.fbm(6, octaves=2)
    ex = np.minimum(lx, size - lx)
    ey = np.minimum(ly, size - ly)
    edge = np.minimum(ex, ey)  # meters to the nearest tile edge
    grout = sstep(grout_half + 0.0004, grout_half - 0.0002, edge)

    nt = k * k
    P = {
        'val': rng.normal(1.0, 0.035, nt),
        'hue': rng.normal(0.0, 0.015, nt),
        'tx': rng.normal(0, 0.0035, nt),  # tilt (rad)
        'ty': rng.normal(0, 0.0035, nt),
        'lift': rng.normal(0, 0.0003, nt),
        'craze': rng.uniform(0, 1, nt),
        'wear': rng.uniform(0, 1, nt),
    }
    g = lambda key: P[key][tid].astype(F32)

    white_c = hexc('#aca796')
    black_c = hexc('#1f1e1c')
    base = np.where(white[..., None], T.full(white_c), T.full(black_c))
    hv = g('hue')[..., None]
    base = base * g('val')[..., None] * (1 + np.concatenate([hv, hv * 0.3, -hv], -1))
    # glaze: subtle cloudiness in the white, slight speckle in the black
    cloud = T.fbm(16, octaves=4)
    base = np.where(white[..., None], base * (0.96 + 0.06 * cloud)[..., None],
                    base * (1.0 + 0.25 * np.clip(T.spectral(beta=0.8, fmin=100), -1, 2) * 0.15)[..., None])
    L = G.Layers(T, base.astype(F32), rough=0.22)

    # --- geometry: cushion edges, tilt + lippage, grout recess -----------------------------------------
    cushion = sstep(0.004, 0.0, edge) ** 1.5 * 0.0006
    tilt = g('tx') * (lx - size / 2) + g('ty') * (ly - size / 2)
    L.height += tilt + g('lift') - cushion
    grout_n = T.spectral(beta=0.9, fmin=120)
    L.height = L.height * (1 - grout) + grout * (-0.0018 + grout_n * 0.00006)

    # --- crazing on the white glaze (stained craze lines), strength per tile -----------------------
    f1, f2, _ = T.worley(int(1.0 / 0.009), jitter=0.95)
    f1b, f2b, _ = T.worley(int(1.0 / 0.022), jitter=0.95)
    craze = np.maximum(sstep(0.05, 0.0, f2 - f1) * 0.7, sstep(0.035, 0.0, f2b - f1b))
    cz = (white & (g('craze') > 0.35)) * sstep(0.35, 0.9, g('craze'))
    craze = craze * cz * np.clip(0.6 + 0.6 * F.detail, 0, 1)
    L.paint(craze.astype(F32), hexc('#5a4f3e'), 0.55)

    # --- wear: black tiles scuffed gray and matte, whites dulled in traffic ----------------------------
    traffic = sstep(-0.2, 0.6, T.fbm(2, octaves=4) + 0.2 * F.warp_lo)
    scuff = sstep(0.0, 1.5, T.spectral(beta=1.6, fmin=8)) * traffic
    blk = (~white).astype(F32)
    L.paint(scuff * blk, hexc('#3e3b36'), 0.65, rough=0.55)
    L.rough = L.rough + (0.5 - L.rough) * traffic * 0.6
    swirl = T.zeros()
    for _ in range(160):
        x, y = rng.random(2) * n
        a = rng.uniform(0, math.pi)
        pts = T.crack_path(x, y, T.px(rng.uniform(0.01, 0.07)), a, step=3, wiggle=0.1)
        T.stroke(swirl, pts, rng.uniform(0.5, 1.0), soft=0.6, value=rng.uniform(0.3, 0.8))
    L.paint(swirl * blk, hexc('#55514a'), 0.5, rough=0.6)
    L.paint(swirl * (1 - blk), hexc('#8f8a7c'), 0.3, rough=0.4)

    # --- grime: dark film collected along the grout + general dirt ----------------------------------
    near = sstep(0.009, 0.0015, edge) * (0.55 + 0.45 * sstep(-0.3, 0.6, F.detail + F.warp_hi * 0.5))
    L.paint(near.astype(F32), hexc('#4a4234'), 0.5, rough=0.55, rough_mix=0.5)
    dirt = sstep(-0.1, 0.8, T.fbm(5, octaves=4)) * 0.6 + traffic * 0.3
    L.multiply(dirt.astype(F32), (0.74, 0.70, 0.62), 0.8)
    L.rough = L.rough + (0.6 - L.rough) * dirt * 0.4
    # smeared dried mop water / footprints of grime
    smear = np.clip(standardize(T.fbm(10, 4, octaves=4)) * 0.6 - 0.2, 0, 1) * sstep(-0.2, 0.4, F.warp_lo)
    L.paint(smear.astype(F32), hexc('#5b5243'), 0.35, rough=0.65, rough_mix=0.6)
    corner = sstep(0.018, 0.004, np.sqrt(ex * ex + ey * ey)) * 0.8
    L.paint(corner.astype(F32), hexc('#3b342a'), 0.45)

    # --- cracks across some tiles + chipped corners ------------------------------------------------
    cracks = T.zeros()
    cracked_tiles = rng.choice(nt, 6, replace=False)
    for t in cracked_tiles:
        ty, tx = divmod(int(t), k)
        x0 = (tx + rng.uniform(0.0, 0.2)) / k * n
        y0 = (ty + rng.uniform(0.2, 0.8)) / k * n
        a = rng.uniform(-0.6, 0.6)
        pts = T.crack_path(x0, y0, T.px(size * rng.uniform(0.6, 1.1)), a, step=2.5, wiggle=0.35)
        T.stroke(cracks, pts, np.linspace(1.4, 0.7, len(pts)), soft=0.6)
    chips = T.zeros()
    for _ in range(10):
        tx, ty = rng.integers(0, k, 2)
        cx = (tx + rng.choice([0.0, 1.0])) / k * n + rng.normal(0, 1)
        cy = (ty + rng.choice([0.0, 1.0])) / k * n + rng.normal(0, 1)
        r = rng.uniform(3, 9)
        T.blob(chips, cx, cy, r * rng.uniform(0.8, 1.5), r, rot=rng.uniform(0, 3.14), soft=0.8)
    chips = chips * (1 - grout)
    chips = np.clip(chips * sstep(-0.4, 0.2, F.at(F.warp_hi, 0.2, 0.7) + 0.3), 0, 1)

    # one broken tile: radial cracks from an impact + a missing shard showing the mortar bed
    bt = int(rng.integers(nt))
    bty, btx = divmod(bt, k)
    cxp = (btx + 0.55) / k * n
    cyp = (bty + 0.45) / k * n
    for i in range(7):
        a = i / 7 * 2 * math.pi + rng.normal(0, 0.25)
        pts = T.crack_path(cxp, cyp, T.px(size * rng.uniform(0.35, 0.7)), a, step=2.5, wiggle=0.25)
        T.stroke(cracks, pts, np.linspace(1.6, 0.8, len(pts)), soft=0.6)
    du, dv = T.tdelta(cxp / n + 0.012, cyp / n - 0.01)
    ang = np.arctan2(dv, du)
    jag = 0.18 * np.abs(np.sin(ang * 2.5 + 0.7)) + 0.12 * np.abs(np.sin(ang * 6.0 + 2.0)) + 0.06 * np.sin(ang * 13.0)
    shard = sstep(1.0, 0.96, np.sqrt((du / 0.03) ** 2 + (dv / 0.022) ** 2) * (1 + jag))
    shard = shard * (tid == bt)

    crack_w = cracks * (1 - grout)
    L.paint(crack_w, hexc('#1b1712'), 0.85, rough=0.9)
    L.paint(np.clip(T.blur(crack_w, 1.5) - crack_w, 0, 1), hexc('#4b4234'), 0.4)
    L.height -= crack_w * 0.0006
    # chips show the pale ceramic body
    L.paint(chips, hexc('#8d8678'), 0.95, rough=0.9)
    L.height -= chips * 0.0012
    mortar = T.full(hexc('#4e4a42')) * (0.85 + 0.2 * standardize(T.fbm(60, octaves=3))[..., None] * 0.3)
    L.color = L.color + (mortar - L.color) * shard[..., None]
    L.rough = L.rough + (0.95 - L.rough) * shard
    L.height = L.height * (1 - shard) + shard * (-0.006 + T.fbm(40, octaves=2) * 0.0003)
    L.ao *= 1 - 0.5 * np.clip(T.blur(shard, 2.0) * (1 - shard) * 2, 0, 1)

    # grout color: dark gray-brown, gritty, dirtier in places
    gr_c = T.full(hexc('#383229')) * (0.8 + 0.25 * np.clip(grout_n * 0.3 + 0.5, 0, 1))[..., None]
    gr_c = gr_c * (0.85 + 0.15 * F.detail)[..., None]
    L.color = L.color + (gr_c - L.color) * grout[..., None]
    L.rough = L.rough + (0.95 - L.rough) * grout
    L.ao *= 1 - 0.45 * grout

    # --- stains: rust ring from a can, a dark spill, grime specks ------------------------------------
    G.water_stain(L, F, 0.38, 0.66, 0.05, stretch=(1.0, 1.0), strength=0.8, rings=1,
                  tint=(0.84, 0.70, 0.55), tide=(0.36, 0.20, 0.10), warp=0.1)
    G.water_stain(L, F, 0.75, 0.22, 0.14, stretch=(1.2, 0.8), strength=0.6, rings=2,
                  tint=(0.75, 0.70, 0.62), tide=(0.20, 0.16, 0.11), warp=0.6, rough_delta=0.15)
    G.fly_specks(L, 240, color=(0.10, 0.08, 0.06), size_px=(0.6, 1.6), opacity=0.7)
    return G.finish(L, normal_strength=1.0, cavity_radii=(0.002, 0.006), cavity_scale=0.0004,
                    ao_strength=0.5, color_cavity=0.15, rough_range=(0.12, 1.0))
