"""
Procedural material recipes for the gameplay props (baked into atlases by props_lib.bake_atlas).

All colors are LINEAR (Blender's working space). Scales are in meters (object space, props keep
identity transforms): noise scale 1000 means ~1 mm features. `s` scales a recipe's detail size
for bigger/smaller objects. Every recipe takes `marks` (decals / masks layered on top, see
props_lib.pbr) and returns a material.
"""

from __future__ import annotations

from typing import Callable, Sequence

import props_lib as L
from props_lib import Kit

Mask = Callable[[Kit], object] | None


def build() -> None:
    """art/build.py imports every module here and calls build(); this one is only a helper."""


def engraved(mask: Callable, color=(0.015, 0.014, 0.013), rough=0.55, depth=-1.5, metal=0.0) -> dict:
    """Engraved/stamped mark filled with paint (or grime)."""
    return dict(mask=mask, color=color, rough=rough, metal=metal, height=depth)


def printed(mask: Callable, color, rough=0.45, metal=0.0, height=0.15) -> dict:
    return dict(mask=mask, color=color, rough=rough, metal=metal, height=height)


# ---------------------------------------------------------------------------------------------
# Metals
# ---------------------------------------------------------------------------------------------

def brass(name: str, s: float = 1.0, tarnish: float = 0.55, stamp: Mask = None, grime: float = 1.0,
          polish_edges: float = 0.8, warm: float = 1.0, marks: Sequence[dict] = ()) -> 'bpy.types.Material':
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
        return dict(color=col, rough=rough, metal=metal, height=h, bump=0.6, bump_dist=0.00025 * s)

    return L.pbr(name, fn, marks=marks)


def aluminum(name: str, s: float = 1.0, brush_axis: str = 'X', tone: float = 1.0, grime: float = 1.0,
             marks: Sequence[dict] = ()) -> 'bpy.types.Material':
    """Brushed satin aluminum/chromed brass trim: brushing streaks, rubbed edges, grime in seams,
    dull oxidation spots, scratches."""
    stretch = {'X': (1, 70, 70), 'Y': (70, 1, 70), 'Z': (70, 70, 1)}[brush_axis]

    def fn(k: Kit):
        brushed = k.noise(scale=420 / s, detail=3, rough=0.6, vec=k.mapping(scale=stretch))
        brushed2 = k.noise(scale=2600 / s, detail=1, rough=0.5, vec=k.mapping(scale=stretch))
        big = k.noise(scale=30 / s, detail=5, rough=0.6)
        cav = k.cavity(dist=0.004 * s, lo=0.45, hi=0.98)
        edge = k.edges(dist=0.0010 * s, lo=0.5, hi=0.93)
        base = (0.56 * tone, 0.56 * tone, 0.54 * tone)
        col = k.mix(k.add(k.mul(brushed, 0.6), k.mul(brushed2, 0.4)), (0.44 * tone, 0.44 * tone, 0.43 * tone), base)
        col = k.mix(k.mul(k.ramp_f(big, 0.4, 0.7), 0.35), col, (0.40, 0.39, 0.36))
        col = k.mix(k.mul(edge, 0.7), col, (0.78, 0.78, 0.76))
        ox = k.mul(k.ramp_f(k.noise(scale=180 / s, detail=4, rough=0.7), 0.64, 0.74), 0.7)
        col = k.mix(ox, col, (0.46, 0.46, 0.43))
        scr = k.maxf(k.scratches(scale=40 / s, density=0.6, width=0.010, angle=12, seed=11),
                     k.scratches(scale=65 / s, density=0.5, width=0.007, angle=-48, seed=12))
        col = k.mix(k.mul(scr, 0.7), col, (0.80, 0.80, 0.78))
        g = k.mul(k.mul(cav, k.ramp_f(big, 0.2, 0.6)), grime)
        col = k.mix(g, col, (0.035, 0.032, 0.028))
        rough = k.add(0.30, k.mul(brushed, 0.12))
        rough = k.add(rough, k.mul(ox, 0.25))
        rough = k.sub(rough, k.mul(edge, 0.08))
        rough = k.add(rough, k.mul(g, 0.45))
        metal = k.sub(1.0, k.add(k.mul(g, 0.9), k.mul(ox, 0.3)), clamp=True)
        h = k.add(k.mul(brushed2, 0.15), k.mul(scr, -0.5))
        return dict(color=col, rough=rough, metal=metal, height=h, bump=0.5, bump_dist=0.0002 * s)

    return L.pbr(name, fn, marks=marks)


def chrome(name: str, s: float = 1.0, marks: Sequence[dict] = ()) -> 'bpy.types.Material':
    """Old chrome plate: bright, a little pitted, grime in crevices, rubbed edges."""

    def fn(k: Kit):
        big = k.noise(scale=40 / s, detail=5)
        pits = k.ramp_f(k.noise(scale=1500 / s, detail=2), 0.66, 0.74)
        cav = k.cavity(dist=0.003 * s, lo=0.45, hi=0.98)
        col = k.mix(k.ramp_f(big, 0.3, 0.7), (0.70, 0.70, 0.70), (0.58, 0.58, 0.57))
        col = k.mix(k.mul(pits, 0.8), col, (0.20, 0.17, 0.13))
        g = k.mul(cav, 0.9)
        col = k.mix(g, col, (0.03, 0.028, 0.025))
        scr = k.scratches(scale=60 / s, density=0.5, width=0.008, angle=30, seed=21)
        rough = k.add(k.add(0.14, k.mul(big, 0.08)), k.mul(k.maxf(pits, g), 0.5))
        rough = k.add(rough, k.mul(scr, 0.1))
        metal = k.sub(1.0, k.mul(k.maxf(pits, g), 0.8), clamp=True)
        h = k.add(k.mul(pits, -0.5), k.mul(scr, -0.3))
        return dict(color=col, rough=rough, metal=metal, height=h, bump=0.5, bump_dist=0.00015 * s)

    return L.pbr(name, fn, marks=marks)


def black_enamel(name: str, s: float = 1.0, under=(0.62, 0.45, 0.20), under_metal: float = 1.0, wear: float = 1.0,
                 gloss: float = 0.38, marks: Sequence[dict] = (), height_fn: Callable | None = None
                 ) -> 'bpy.types.Material':
    """Black enamel over metal (brass by default): edges worn through ('brassing'), chips,
    rub marks, dust in crevices. height_fn(k) adds a relief (e.g. knurling)."""

    def fn(k: Kit):
        n1 = k.noise(scale=90 / s, detail=6, rough=0.6)
        n2 = k.noise(scale=900 / s, detail=3)
        edge = k.edges(dist=0.0013 * s, lo=0.45, hi=0.92)
        cav = k.cavity(dist=0.004 * s, lo=0.45, hi=0.98)
        relief = height_fn(k) if height_fn else None
        wearm = k.ramp_f(k.sub(k.add(k.mul(edge, 0.9 * wear), k.mul(n1, 0.45)), 0.0), 0.72, 0.82)
        if relief is not None:
            # knurl peaks get rubbed through too
            wearm = k.maxf(wearm, k.mul(k.ramp_f(relief, 0.8, 0.98), k.ramp_f(n1, 0.35, 0.6)))
        chips = k.mul(k.ramp_f(k.noise(scale=260 / s, detail=4, rough=0.7), 0.68, 0.72), k.ramp_f(edge, 0.2, 0.5))
        bare = k.maxf(wearm, chips)
        paint = k.mix(k.mul(n2, 0.5), (0.016, 0.015, 0.014), (0.03, 0.028, 0.026))
        col = k.mix(bare, paint, under)
        dust = k.mul(cav, 0.75)
        col = k.mix(dust, col, (0.09, 0.08, 0.065))
        scr = k.scratches(scale=50 / s, density=0.55, width=0.009, angle=25, seed=31)
        col = k.mix(k.mul(scr, 0.35), col, (0.12, 0.11, 0.10))
        rough = k.add(gloss, k.mul(n2, 0.1))
        rough = k.mixf(bare, rough, 0.30)
        rough = k.add(rough, k.mul(dust, 0.35))
        rough = k.add(rough, k.mul(scr, 0.15))
        metal = k.mul(k.mul(bare, under_metal), k.inv(dust))
        h = k.add(k.mul(n2, 0.08), k.mul(chips, -0.7))
        h = k.add(h, k.mul(scr, -0.4))
        if relief is not None:
            h = k.add(h, k.mul(relief, 3.0))
        return dict(color=col, rough=rough, metal=metal, height=h, bump=0.7, bump_dist=0.0002 * s)

    return L.pbr(name, fn, marks=marks)


def leatherette(name: str, s: float = 1.0, color=(0.0125, 0.0115, 0.0105), marks: Sequence[dict] = ()
                ) -> 'bpy.types.Material':
    """Pebbled vinyl leatherette: fine grain with a soft sheen, edges rubbed grey and glossy,
    handling scuffs, a little dust in seams."""

    def fn(k: Kit):
        cells = k.voronoi(scale=1250 / s, feature='DISTANCE_TO_EDGE', rand=0.85)
        f1 = k.voronoi(scale=1250 / s, feature='F1', rand=0.85)
        n = k.noise(scale=220 / s, detail=5, rough=0.6)
        big = k.noise(scale=25 / s, detail=4)
        edge = k.edges(dist=0.0016 * s, lo=0.5, hi=0.92)
        cav = k.cavity(dist=0.004 * s, lo=0.40, hi=0.97)
        grain = k.ramp_f(cells, 0.0, 0.16)
        scuff = k.mul(k.ramp_f(k.add(k.mul(edge, 0.8), k.mul(n, 0.45)), 0.62, 0.85), 0.9)
        patches = k.mul(k.ramp_f(k.noise(scale=60 / s, detail=5, rough=0.65), 0.62, 0.72), 0.5)
        col = k.mix(k.mul(big, 0.5), color, (color[0] * 1.35, color[1] * 1.3, color[2] * 1.25))
        col = k.mix(k.mul(k.inv(grain), 0.35), col, (color[0] * 0.55, color[1] * 0.55, color[2] * 0.55))
        col = k.mix(k.maxf(scuff, patches), col, (0.050, 0.046, 0.041))
        dust = k.mul(cav, 0.55)
        col = k.mix(dust, col, (0.060, 0.054, 0.046))
        rough = k.add(0.62, k.mul(k.inv(grain), 0.14))
        rough = k.sub(rough, k.mul(k.maxf(scuff, patches), 0.22))
        rough = k.add(rough, k.mul(dust, 0.2))
        h = k.add(k.mul(grain, 0.55), k.mul(k.ramp_f(f1, 0.55, 0.0), 0.2))
        h = k.sub(h, k.mul(scuff, 0.35))
        return dict(color=col, rough=rough, metal=0.0, height=h, bump=0.35, bump_dist=0.0002 * s)

    return L.pbr(name, fn, marks=marks)


def plastic(name: str, color, s: float = 1.0, rough: float = 0.4, wear_color=None, marks: Sequence[dict] = ()
            ) -> 'bpy.types.Material':
    """Old molded plastic: faded on top, rubbed glossy on edges, dirt in crevices."""
    wear_color = wear_color or tuple(min(1.0, c * 1.8 + 0.02) for c in color)

    def fn(k: Kit):
        n = k.noise(scale=600 / s, detail=3)
        big = k.noise(scale=60 / s, detail=4)
        edge = k.edges(dist=0.0008 * s)
        cav = k.cavity(dist=0.002 * s, lo=0.45, hi=0.98)
        col = k.mix(k.mul(big, 0.5), color, tuple(c * 0.7 for c in color))
        col = k.mix(k.mul(edge, 0.6), col, wear_color)
        col = k.mix(k.mul(cav, 0.8), col, (0.03, 0.025, 0.02))
        r = k.add(rough, k.mul(n, 0.1))
        r = k.add(r, k.mul(cav, 0.3))
        return dict(color=col, rough=r, metal=0.0, height=k.mul(n, 0.2), bump=0.3, bump_dist=0.0001 * s)

    return L.pbr(name, fn, marks=marks)


def rubber(name: str, s: float = 1.0, marks: Sequence[dict] = ()) -> 'bpy.types.Material':
    def fn(k: Kit):
        n = k.noise(scale=1200 / s, detail=3)
        cav = k.cavity(dist=0.002 * s, lo=0.45, hi=0.98)
        edge = k.edges(dist=0.0008 * s)
        col = k.mix(k.mul(edge, 0.5), (0.014, 0.013, 0.013), (0.05, 0.048, 0.046))
        col = k.mix(k.mul(cav, 0.8), col, (0.07, 0.065, 0.055))
        return dict(color=col, rough=k.add(0.82, k.mul(n, 0.1)), metal=0.0, height=k.mul(n, 0.3), bump=0.3,
                    bump_dist=0.0001 * s)

    return L.pbr(name, fn, marks=marks)


def dark_glass(name: str, tint=(0.010, 0.012, 0.016), s: float = 1.0, marks: Sequence[dict] = ()
               ) -> 'bpy.types.Material':
    """Opaque-looking dark glass (viewfinder / eyepiece / meter windows), smudges and dust."""

    def fn(k: Kit):
        smudge = k.ramp_f(k.noise(scale=150 / s, detail=5, rough=0.65), 0.5, 0.75)
        dust = k.ramp_f(k.noise(scale=2500 / s, detail=1), 0.7, 0.78)
        col = k.mix(k.mul(dust, 0.6), tint, (0.10, 0.10, 0.09))
        r = k.add(k.add(0.04, k.mul(smudge, 0.25)), k.mul(dust, 0.4))
        return dict(color=col, rough=r, metal=0.0, height=k.mul(dust, 0.2), bump=0.2, bump_dist=0.0001)

    return L.pbr(name, fn, marks=marks)


def lens_glass(name: str, center, radius: float = 0.012) -> 'bpy.types.Material':
    """Coated front element (optical axis = +Y): near-black with a purple/amber coating sheen
    toward the rim (baked as color), faint cleaning swirls and dust specks."""

    def fn(k: Kit):
        p = k.vmath('SUBTRACT', k.coord(), tuple(center))
        px, _, pz = k.xyz(p)
        r = k.math('DIVIDE', k.math('SQRT', k.add(k.mul(px, px), k.mul(pz, pz))), radius)
        ring = k.ramp(r, [(0.0, (0.004, 0.005, 0.010)), (0.55, (0.012, 0.006, 0.024)), (0.85, (0.032, 0.013, 0.010)),
                          (1.0, (0.016, 0.020, 0.010))])
        swirl = k.ramp_f(k.wave(scale=55, kind='RINGS', direction='SPHERICAL', distortion=3.0, detail=2), 0.45, 0.55)
        dust = k.ramp_f(k.noise(scale=3000, detail=1), 0.72, 0.78)
        col = k.mix(k.mul(dust, 0.7), ring, (0.12, 0.12, 0.11))
        rough = k.add(k.add(0.03, k.mul(swirl, 0.08)), k.mul(dust, 0.5))
        return dict(color=col, rough=rough, metal=0.0, height=k.mul(dust, 0.3), bump=0.2, bump_dist=0.00008)

    return L.pbr(name, fn)


def reflector(name: str, s: float = 1.0, bright: float = 1.0) -> 'bpy.types.Material':
    """Pebbled (orange-peel) bright flash reflector."""

    def fn(k: Kit):
        pebble = k.voronoi(scale=1500 / s, feature='F1', rand=1.0)
        n = k.noise(scale=80 / s, detail=4)
        cav = k.cavity(dist=0.002 * s, lo=0.5, hi=0.98)
        col = k.mix(k.mul(n, 0.4), (0.80 * bright, 0.80 * bright, 0.78 * bright), (0.66, 0.66, 0.64))
        col = k.mix(k.mul(cav, 0.4), col, (0.20, 0.19, 0.17))
        return dict(color=col, rough=k.add(0.12, k.mul(n, 0.06)), metal=1.0,
                    height=k.ramp_f(pebble, 0.0, 0.5), bump=0.25, bump_dist=0.0001)

    return L.pbr(name, fn)


def frosted(name: str, color=(0.75, 0.76, 0.74), rough: float = 0.25, marks: Sequence[dict] = ()):
    def fn(k: Kit):
        n = k.noise(scale=2500, detail=2)
        return dict(color=color, rough=k.add(rough, k.mul(n, 0.1)), metal=0.0, height=k.mul(n, 0.2), bump=0.2,
                    bump_dist=0.0001)

    return L.pbr(name, fn, marks=marks)


def tin(name: str, s: float = 1.0, rust: float = 0.25, marks: Sequence[dict] = ()) -> 'bpy.types.Material':
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
        h = k.add(k.mul(fine, 0.3), k.mul(scr, -0.5))
        return dict(color=col, rough=rough, metal=metal, height=h, bump=0.5, bump_dist=0.0002 * s)

    return L.pbr(name, fn, marks=marks)


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
        return dict(color=col, rough=0.95, metal=0.0, height=n, bump=0.6, bump_dist=0.0002)

    return L.pbr(name, fn)


# ---------------------------------------------------------------------------------------------
# Fuse box / door recipes
# ---------------------------------------------------------------------------------------------

def painted_steel(name: str, paint=(0.115, 0.150, 0.120), s: float = 1.0, chips: float = 1.0, rust: float = 1.0,
                  dust: float = 1.0, primer=(0.20, 0.055, 0.03), edge_dist: float = 0.0009,
                  marks: Sequence[dict] = ()) -> 'bpy.types.Material':
    """Old enamel on sheet steel: hammer-tone texture, chipped edges down to red-oxide primer and
    bare/rusty steel, rust blooming in seams with streaks running down, dust settled on every
    upward-facing surface."""

    def fn(k: Kit):
        n1 = k.noise(scale=9 / s, detail=6, rough=0.62)
        n2 = k.noise(scale=70 / s, detail=6, rough=0.62)
        n3 = k.noise(scale=700 / s, detail=3)
        hammer = k.voronoi(scale=260 / s, feature='F1', rand=1.0)
        edge = k.edges(dist=edge_dist, lo=0.5, hi=0.9)
        cav = k.cavity(dist=0.012 * s, lo=0.5, hi=0.97)
        x, y, z = k.xyz(k.coord())
        nz = k.xyz(k.geo('Normal'))[2]
        # chips: along edges (noisy) + a few random spots; red-oxide primer ring around bare steel
        spot_n = k.noise(scale=38 / s, detail=6, rough=0.7)
        spots = k.ramp_f(spot_n, 0.700, 0.715)
        chipf = k.add(k.mul(edge, 0.9), k.mul(n2, 0.45))
        chip_primer = k.mul(k.maxf(k.ramp_f(chipf, 0.80, 0.83), spots), chips)
        chip_bare = k.mul(k.maxf(k.ramp_f(chipf, 0.88, 0.91), k.ramp_f(spot_n, 0.725, 0.74)), chips)
        rustm = k.mul(k.ramp_f(k.add(k.mul(cav, 0.6), k.mul(n1, 0.45)), 0.66, 0.82), rust)
        rustm = k.maxf(rustm, k.mul(chip_bare, k.ramp_f(n2, 0.4, 0.6)))
        streak_n = k.noise(scale=22 / s, detail=5, vec=k.mapping(scale=(30, 30, 1.2)))
        streak = k.mul(k.mul(k.ramp_f(streak_n, 0.60, 0.74), k.ramp_f(n1, 0.45, 0.7)), 0.6 * rust)
        dustm = k.mul(k.mul(k.ramp_f(nz, 0.45, 0.9), k.add(0.45, k.mul(n2, 0.6))), dust)
        dustm = k.minf(k.add(dustm, k.mul(cav, 0.15 * dust)), 1.0)
        # paint color: slight variation + hammer-tone cells
        pc = k.mix(k.ramp_f(n1, 0.3, 0.7), tuple(c * 0.82 for c in paint), tuple(c * 1.15 for c in paint))
        pc = k.mix(k.mul(k.ramp_f(hammer, 0.1, 0.6), 0.25), pc, tuple(c * 0.75 for c in paint))
        pc = k.mix(k.mul(n3, 0.15), pc, tuple(c * 1.25 for c in paint))
        steel = k.mix(k.ramp_f(n3, 0.3, 0.7), (0.06, 0.055, 0.05), (0.13, 0.12, 0.11))
        rustc = k.mix(k.ramp_f(n2, 0.3, 0.7), (0.13, 0.045, 0.018), (0.26, 0.10, 0.035))
        col = k.mix(chip_primer, pc, primer)
        col = k.mix(chip_bare, col, k.mix(k.ramp_f(n1, 0.45, 0.6), steel, rustc))
        col = k.mix(rustm, col, rustc)
        col = k.mix(streak, col, (0.12, 0.05, 0.022))
        col = k.mix(k.mul(dustm, 0.85), col, (0.24, 0.225, 0.20))
        rough = k.add(0.52, k.mul(n2, 0.12))
        rough = k.mixf(chip_primer, rough, 0.75)
        rough = k.mixf(chip_bare, rough, 0.5)
        rough = k.mixf(k.maxf(rustm, streak), rough, 0.85)
        rough = k.mixf(dustm, rough, 0.92)
        metal = k.mul(k.mul(chip_bare, k.inv(rustm)), k.inv(dustm))
        h = k.mul(k.ramp_f(hammer, 0.0, 0.5), 0.25)
        h = k.add(h, k.mul(chip_primer, -0.8))
        h = k.add(h, k.mul(chip_bare, -0.6))
        h = k.add(h, k.mul(k.mul(rustm, n3), 0.9))
        return dict(color=col, rough=rough, metal=metal, height=h, bump=0.6, bump_dist=0.0006 * s)

    return L.pbr(name, fn, marks=marks)


def porcelain(name: str, color=(0.56, 0.52, 0.42), s: float = 1.0, marks: Sequence[dict] = ()):
    """Glazed electrical porcelain: crazed glaze, grime in the craze lines and crevices, chipped
    corners showing rough white bisque."""

    def fn(k: Kit):
        craze = k.voronoi(scale=90 / s, feature='DISTANCE_TO_EDGE', rand=1.0)
        lines = k.ramp_f(craze, 0.012, 0.0)
        n = k.noise(scale=40 / s, detail=5)
        edge = k.edges(dist=0.003 * s, lo=0.5, hi=0.92)
        cav = k.cavity(dist=0.008 * s, lo=0.45, hi=0.97)
        chip = k.ramp_f(k.add(k.mul(edge, 0.9), k.mul(k.noise(scale=150 / s, detail=5), 0.45)), 0.86, 0.88)
        col = k.mix(k.mul(n, 0.4), color, tuple(c * 0.85 for c in color))
        col = k.mix(k.mul(lines, 0.6), col, (0.20, 0.17, 0.12))
        col = k.mix(k.mul(cav, 0.85), col, (0.10, 0.085, 0.06))
        col = k.mix(chip, col, (0.66, 0.64, 0.58))
        rough = k.add(0.16, k.mul(n, 0.08))
        rough = k.mixf(k.mul(cav, 0.8), rough, 0.7)
        rough = k.mixf(chip, rough, 0.85)
        h = k.add(k.mul(chip, -1.2), k.mul(lines, -0.15))
        return dict(color=col, rough=rough, metal=0.0, height=h, bump=0.6, bump_dist=0.0003 * s)

    return L.pbr(name, fn, marks=marks)


def galvanized(name: str, s: float = 1.0, marks: Sequence[dict] = ()):
    """Galvanized conduit: zinc spangle, white rust, a few rust freckles, dust on top."""

    def fn(k: Kit):
        sp = k.voronoi(scale=40 / s, feature='F1', out='Color', rand=1.0)
        spv = k.xyz(sp)[0]
        n = k.noise(scale=30 / s, detail=5)
        n2 = k.noise(scale=300 / s, detail=4)
        cav = k.cavity(dist=0.02 * s, lo=0.45, hi=0.97)
        nz = k.xyz(k.geo('Normal'))[2]
        white = k.ramp_f(k.add(k.mul(n, 0.7), k.mul(n2, 0.4)), 0.68, 0.78)
        freck = k.ramp_f(k.noise(scale=120 / s, detail=4), 0.72, 0.76)
        col = k.mix(spv, (0.34, 0.34, 0.33), (0.48, 0.48, 0.47))
        col = k.mix(white, col, (0.52, 0.52, 0.49))
        col = k.mix(freck, col, (0.18, 0.07, 0.03))
        g = k.minf(k.add(k.mul(cav, 0.8), k.mul(k.ramp_f(nz, 0.3, 0.9), 0.6)), 1.0)
        col = k.mix(k.mul(g, 0.8), col, (0.16, 0.15, 0.13))
        rough = k.add(0.42, k.mul(spv, 0.12))
        rough = k.mixf(k.maxf(white, freck), rough, 0.85)
        rough = k.mixf(g, rough, 0.9)
        metal = k.mul(k.inv(k.maxf(white, freck)), k.inv(g))
        return dict(color=col, rough=rough, metal=metal, height=k.add(k.mul(n2, 0.3), k.mul(freck, 0.5)),
                    bump=0.4, bump_dist=0.0003 * s)

    return L.pbr(name, fn, marks=marks)


def bakelite(name: str, color=(0.055, 0.018, 0.010), s: float = 1.0, marks: Sequence[dict] = ()):
    """Glossy brown-black bakelite: swirled, worn matte where held, grime in crevices."""

    def fn(k: Kit):
        swirl = k.noise(scale=60 / s, detail=6, distortion=2.5)
        cav = k.cavity(dist=0.004 * s, lo=0.45, hi=0.97)
        edge = k.edges(dist=0.002 * s)
        col = k.mix(swirl, color, (color[0] * 1.8, color[1] * 1.6, color[2] * 1.4))
        col = k.mix(k.mul(cav, 0.8), col, (0.02, 0.015, 0.01))
        rough = k.add(0.22, k.mul(edge, 0.25))
        rough = k.add(rough, k.mul(cav, 0.4))
        return dict(color=col, rough=rough, metal=0.0, height=k.mul(swirl, 0.1), bump=0.2, bump_dist=0.0002)

    return L.pbr(name, fn, marks=marks)


def paper(name: str, ink_mask: Callable, s: float = 1.0, color=(0.52, 0.44, 0.28), marks: Sequence[dict] = ()):
    """Old yellowed paper/card: foxing spots, water stains, darker edges, ink from a decal mask."""

    def fn(k: Kit):
        n1 = k.noise(scale=25 / s, detail=6, rough=0.6)
        n2 = k.noise(scale=400 / s, detail=4)
        fox = k.ramp_f(k.noise(scale=80 / s, detail=4), 0.68, 0.74)
        stain = k.mul(k.ramp_f(k.wave(scale=14 / s, kind='RINGS', direction='SPHERICAL', distortion=6.0, detail=3),
                               0.55, 0.62), k.ramp_f(n1, 0.45, 0.6))
        edge = k.edges(dist=0.004 * s, lo=0.55, hi=0.92)
        col = k.mix(k.ramp_f(n1, 0.3, 0.7), color, tuple(c * 0.8 for c in color))
        col = k.mix(k.mul(fox, 0.7), col, (0.22, 0.13, 0.05))
        col = k.mix(k.mul(stain, 0.6), col, (0.25, 0.17, 0.08))
        col = k.mix(k.mul(edge, 0.7), col, (0.16, 0.11, 0.06))
        ink = ink_mask(k)
        col = k.mix(k.mul(ink, 0.85), col, (0.035, 0.03, 0.04))
        return dict(color=col, rough=k.add(0.82, k.mul(n2, 0.1)), metal=0.0, height=k.add(k.mul(n2, 0.4), k.mul(n1, 0.3)),
                    bump=0.4, bump_dist=0.0004 * s)

    return L.pbr(name, fn, marks=marks)


def _grain(k: Kit, axis: str, s: float, rot: float = 0.0, scale: float = 1.0):
    """Wood grain value (0..1): long streaks along `axis` (object space), optional rotation about Y."""
    stretch = {'Z': (1.0, 1.0, 0.035), 'X': (0.035, 1.0, 1.0)}[axis]
    v = k.mapping(rot=(0, rot, 0), scale=stretch)
    d = 'Y' if axis == 'Z' else 'Y'
    rings = k.wave(scale=38 * scale / s, vec=v, kind='BANDS', direction='X' if axis == 'Z' else 'Z', distortion=7.0,
                   detail=4, detail_scale=1.5)
    fine = k.noise(scale=900 / s, detail=3, vec=v)
    _ = d
    return k.add(k.mul(rings, 0.75), k.mul(fine, 0.25))


def painted_wood(name: str, paint=(0.040, 0.055, 0.045), under=(0.40, 0.37, 0.28), wood=(0.17, 0.11, 0.06),
                 grain: str = 'Z', s: float = 1.0, peel: float = 1.0, grime: float = 1.0, crack: float = 1.0,
                 rot: float = 0.0, marks: Sequence[dict] = ()) -> 'bpy.types.Material':
    """Old paint on wood: two coats (top + cream undercoat) peeling in flakes with lifted edges,
    alligator cracking, bare grey wood where both coats are gone, grime low down and in
    crevices, exterior faces (normal -Y) sun-bleached and more weathered."""

    def fn(k: Kit):
        x, y, z = k.xyz(k.coord())
        ny = k.xyz(k.geo('Normal'))[1]
        ext = k.ramp_f(ny, -0.3, -0.8)        # exterior side of the wall
        g = _grain(k, grain, s, rot)
        n1 = k.noise(scale=4.5 / s, detail=8, rough=0.62)
        n2 = k.noise(scale=22 / s, detail=6, rough=0.6)
        n3 = k.noise(scale=300 / s, detail=3)
        edge = k.edges(dist=0.004 * s, lo=0.5, hi=0.9)
        cav = k.cavity(dist=0.02 * s, lo=0.5, hi=0.97)
        low = k.ramp_f(z, 0.45, 0.05)          # kick zone near the floor
        # paint loss
        pv = k.add(k.add(k.mul(n1, 0.62), k.mul(n2, 0.30)), k.mul(edge, 0.30))
        pv = k.add(pv, k.mul(low, 0.10))
        pv = k.add(pv, k.mul(ext, 0.10))
        pv = k.add(pv, k.mul(g, 0.06))         # flakes follow the grain a little
        th = 0.74 - 0.10 * peel
        top_gone = k.ramp_f(pv, th, th + 0.008)
        lifted = k.sub(k.ramp_f(pv, th - 0.018, th - 0.004), top_gone, clamp=True)   # rim of the flake
        under_gone = k.mul(top_gone, k.ramp_f(k.add(k.mul(n2, 0.7), k.mul(n3, 0.3)), 0.56, 0.58))
        # alligator cracks in the remaining top coat
        cells = k.voronoi(scale=55 / s, feature='DISTANCE_TO_EDGE', rand=1.0)
        cr = k.mul(k.mul(k.ramp_f(cells, 0.035, 0.0), k.ramp_f(n2, 0.45, 0.6)), crack)
        cr = k.mul(cr, k.inv(top_gone))
        # colors
        woodc = k.mix(k.ramp_f(g, 0.3, 0.7), tuple(c * 0.75 for c in wood), wood)
        woodc = k.mix(k.mul(ext, 0.7), woodc, (0.20, 0.18, 0.15))           # silvered outside
        topc = k.mix(k.ramp_f(n2, 0.3, 0.7), tuple(c * 0.85 for c in paint), tuple(c * 1.12 for c in paint))
        topc = k.mix(k.mul(ext, 0.55), topc, tuple(min(1.0, c * 1.6 + 0.03) for c in paint))   # sun faded
        underc = k.mix(k.ramp_f(n3, 0.3, 0.7), under, tuple(c * 0.85 for c in under))
        col = k.mix(top_gone, topc, underc)
        col = k.mix(under_gone, col, woodc)
        col = k.mix(k.mul(lifted, 0.6), col, tuple(min(1.0, c * 1.5 + 0.02) for c in paint))
        col = k.mix(k.mul(cr, 0.8), col, (0.012, 0.010, 0.008))
        dirt = k.minf(k.add(k.mul(cav, 0.7), k.mul(k.mul(low, k.ramp_f(n2, 0.3, 0.7)), 0.55)), 1.0)
        dirt = k.mul(dirt, grime)
        col = k.mix(dirt, col, (0.035, 0.028, 0.020))
        rough = k.add(0.55, k.mul(n3, 0.1))
        rough = k.mixf(top_gone, rough, 0.75)
        rough = k.mixf(under_gone, rough, 0.88)
        rough = k.mixf(dirt, rough, 0.85)
        rough = k.add(rough, k.mul(ext, 0.12))
        h = k.mul(k.inv(top_gone), 0.6)
        h = k.add(h, k.mul(lifted, 0.5))
        h = k.add(h, k.mul(k.inv(under_gone), 0.3))
        h = k.add(h, k.mul(k.mul(under_gone, g), 0.4))
        h = k.sub(h, k.mul(cr, 0.4))
        return dict(color=col, rough=rough, metal=0.0, height=h, bump=0.7, bump_dist=0.0008 * s)

    return L.pbr(name, fn, marks=marks)


def raw_wood(name: str, wood=(0.16, 0.12, 0.08), grain: str = 'X', rot: float = 0.0, s: float = 1.0, wear_z=None,
             marks: Sequence[dict] = ()) -> 'bpy.types.Material':
    """Weathered bare wood (boards, threshold): silvered, open grain, splits, dirt."""

    def fn(k: Kit):
        g = _grain(k, grain, s, rot, scale=1.3)
        n1 = k.noise(scale=12 / s, detail=6)
        n2 = k.noise(scale=200 / s, detail=4)
        cav = k.cavity(dist=0.015 * s, lo=0.5, hi=0.97)
        edge = k.edges(dist=0.003 * s)
        split = k.mul(k.ramp_f(g, 0.86, 0.9), k.ramp_f(n1, 0.55, 0.65))
        col = k.mix(k.ramp_f(g, 0.25, 0.75), tuple(c * 0.6 for c in wood), wood)
        col = k.mix(k.mul(k.ramp_f(n1, 0.3, 0.7), 0.6), col, (0.19, 0.17, 0.14))
        col = k.mix(k.mul(edge, 0.5), col, tuple(min(1.0, c * 1.4) for c in wood))
        col = k.mix(split, col, (0.02, 0.015, 0.01))
        col = k.mix(k.mul(cav, 0.8), col, (0.03, 0.025, 0.018))
        rough = k.add(0.72, k.mul(n2, 0.12))
        if wear_z is not None:
            x, y, z = k.xyz(k.coord())
            worn = k.mul(k.ramp_f(k.math('ABSOLUTE', x), 0.35, 0.05), k.ramp_f(n1, 0.2, 0.6))
            col = k.mix(k.mul(worn, 0.5), col, tuple(min(1.0, c * 1.6) for c in wood))
            rough = k.sub(rough, k.mul(worn, 0.25))
        h = k.add(k.mul(g, 0.6), k.mul(split, -1.2))
        h = k.add(h, k.mul(n2, 0.2))
        return dict(color=col, rough=rough, metal=0.0, height=h, bump=0.6, bump_dist=0.0008 * s)

    return L.pbr(name, fn, marks=marks)


def iron(name: str, s: float = 1.0, marks: Sequence[dict] = ()):
    """Rusty iron (nail heads, hinge pins)."""

    def fn(k: Kit):
        n = k.noise(scale=500 / s, detail=5)
        col = k.mix(n, (0.05, 0.035, 0.025), (0.20, 0.08, 0.03))
        return dict(color=col, rough=k.add(0.7, k.mul(n, 0.2)), metal=k.mul(k.inv(n), 0.5), height=n, bump=0.5,
                    bump_dist=0.0002 * s)

    return L.pbr(name, fn, marks=marks)
