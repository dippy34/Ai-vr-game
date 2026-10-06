"""
Procedural material recipes for the gameplay props (baked into atlases by props_lib.bake_atlas).

All colors are LINEAR (Blender's working space). Scales are in meters (object space, props keep
identity transforms): noise scale 1000 means ~1 mm features. `s` scales a recipe's detail size
for bigger/smaller objects. Each recipe returns a material built with props_lib.pbr.
"""

from __future__ import annotations

from typing import Callable

import props_lib as L
from props_lib import Kit

Mask = Callable[[Kit], object] | None


def build() -> None:
    """art/build.py imports every module here and calls build(); this one is only a helper."""


# ---------------------------------------------------------------------------------------------
# Metals
# ---------------------------------------------------------------------------------------------

def brass(name: str, s: float = 1.0, tarnish: float = 0.55, stamp: Mask = None, grime: float = 1.0,
          polish_edges: float = 0.8, warm: float = 1.0) -> 'bpy.types.Material':
    """Old brass: tarnish blotches, dark grime + a hint of verdigris in crevices, rubbed bright on
    edges, fine scratches. `stamp(k)` -> 0..1 mask of stamped/engraved marks (sunk + dark)."""

    def fn(k: Kit):
        big = k.noise(scale=38 / s, detail=6, rough=0.62)
        mid = k.noise(scale=160 / s, detail=4, rough=0.55)
        fine = k.noise(scale=1400 / s, detail=2, rough=0.5)
        cav = k.cavity(dist=0.005 * s, lo=0.45, hi=0.98)
        edge = k.edges(dist=0.0012 * s, lo=0.5, hi=0.93)
        tar = k.ramp_f(k.add(k.mul(big, 0.9), k.mul(mid, 0.25)), 0.48 - tarnish * 0.25, 0.70 - tarnish * 0.2)
        tar = k.minf(k.add(k.mul(tar, tarnish + 0.25), k.mul(cav, 0.5)), 1.0)
        polish = k.mul(k.mul(edge, k.inv(cav)), polish_edges)
        bright = (0.78 * warm, 0.56 * warm, 0.24 * warm)
        col = k.mix(tar, bright, (0.30, 0.20, 0.075))
        col = k.mix(k.mul(k.ramp_f(mid, 0.3, 0.75), 0.25), col, (0.42, 0.24, 0.06))  # coppery mottling
        col = k.mix(polish, col, (0.90, 0.72, 0.38))
        scr = k.maxf(k.scratches(scale=55 / s, density=0.55, width=0.010, angle=20, seed=1),
                     k.scratches(scale=80 / s, density=0.45, width=0.008, angle=-35, seed=2))
        col = k.mix(k.mul(scr, 0.6), col, (0.88, 0.70, 0.36))
        g = k.mul(k.mul(cav, k.ramp_f(mid, 0.25, 0.7)), grime)
        verd = k.mul(k.mul(cav, k.ramp_f(big, 0.55, 0.75)), 0.55 * grime)
        col = k.mix(verd, col, (0.10, 0.20, 0.13))
        col = k.mix(g, col, (0.035, 0.026, 0.016))
        rough = k.add(0.26, k.mul(tar, 0.22))
        rough = k.add(rough, k.mul(fine, 0.08))
        rough = k.sub(rough, k.mul(polish, 0.12))
        rough = k.add(rough, k.mul(k.maxf(g, verd), 0.45))
        metal = k.sub(1.0, k.mul(k.maxf(g, verd), 0.9), clamp=True)
        h = k.add(k.mul(fine, 0.12), k.mul(scr, -0.6))
        if stamp is not None:
            st = stamp(k)
            col = k.mix(k.mul(st, 0.85), col, (0.07, 0.045, 0.02))
            rough = k.add(rough, k.mul(st, 0.25))
            h = k.add(h, k.mul(st, -2.0))
        nrm = k.bump(h, strength=0.6, distance=0.00025 * s)
        return dict(color=col, rough=rough, metal=metal, normal=nrm)

    return L.pbr(name, fn)


def tin(name: str, s: float = 1.0, rust: float = 0.25) -> 'bpy.types.Material':
    """Dull tin-plated steel (film canister caps): satin, dents, spotty rust in seams."""

    def fn(k: Kit):
        big = k.noise(scale=60 / s, detail=5, rough=0.6)
        fine = k.noise(scale=1800 / s, detail=2)
        cav = k.cavity(dist=0.003 * s, lo=0.4, hi=0.97)
        edge = k.edges(dist=0.0008 * s)
        spots = k.ramp_f(k.noise(scale=420 / s, detail=3, rough=0.7), 0.62, 0.72)
        r = k.minf(k.add(k.mul(spots, rust * 2), k.mul(cav, rust * 2)), 1.0)
        col = k.mix(k.ramp_f(big, 0.3, 0.7), (0.62, 0.62, 0.60), (0.45, 0.45, 0.43))
        col = k.mix(k.mul(edge, 0.6), col, (0.80, 0.80, 0.78))
        scr = k.scratches(scale=90 / s, density=0.5, width=0.01, angle=10, seed=4)
        col = k.mix(k.mul(scr, 0.5), col, (0.85, 0.85, 0.83))
        col = k.mix(r, col, (0.16, 0.07, 0.03))
        g = k.mul(cav, 0.7)
        col = k.mix(g, col, (0.05, 0.045, 0.04))
        rough = k.add(k.add(0.38, k.mul(big, 0.12)), k.mul(k.maxf(r, g), 0.45))
        rough = k.sub(rough, k.mul(edge, 0.1))
        metal = k.sub(1.0, k.maxf(r, k.mul(g, 0.8)), clamp=True)
        nrm = k.bump(k.add(k.mul(fine, 0.3), k.mul(scr, -0.5)), strength=0.5, distance=0.0002 * s)
        return dict(color=col, rough=rough, metal=metal, normal=nrm)

    return L.pbr(name, fn)


def copper_wire(name: str) -> 'bpy.types.Material':
    def fn(k: Kit):
        n = k.noise(scale=3000, detail=2)
        col = k.mix(n, (0.55, 0.25, 0.12), (0.30, 0.12, 0.05))
        return dict(color=col, rough=k.add(0.3, k.mul(n, 0.2)), metal=1.0)

    return L.pbr(name, fn)


# ---------------------------------------------------------------------------------------------
# Non-metals
# ---------------------------------------------------------------------------------------------

def felt(name: str, color=(0.012, 0.010, 0.010)) -> 'bpy.types.Material':
    def fn(k: Kit):
        n = k.noise(scale=4000, detail=3, rough=0.7)
        lint = k.ramp_f(k.noise(scale=700, detail=2), 0.6, 0.75)
        col = k.mix(k.mul(lint, 0.6), color, (0.08, 0.075, 0.07))
        return dict(color=col, rough=0.95, metal=0.0, normal=k.bump(n, strength=0.6, distance=0.0002))

    return L.pbr(name, fn)


def film_leader(name: str) -> 'bpy.types.Material':
    """Exposed film leader: dark, glossy emulsion with printed sprocket holes (mask in UV-free
    object space is too fiddly, so the holes are a plane-mapped decal given at build time)."""

    def fn(k: Kit):
        n = k.noise(scale=500, detail=3)
        col = k.mix(n, (0.025, 0.016, 0.010), (0.045, 0.026, 0.014))
        scr = k.scratches(scale=70, density=0.6, width=0.012, angle=5, seed=7)
        col = k.mix(k.mul(scr, 0.5), col, (0.15, 0.12, 0.10))
        return dict(color=col, rough=k.add(0.18, k.mul(scr, 0.3)), metal=0.0,
                    normal=k.bump(k.mul(scr, -1.0), strength=0.4, distance=0.0001))

    return L.pbr(name, fn)
