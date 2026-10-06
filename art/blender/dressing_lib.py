"""
Building blocks for MUTE's set dressing (see dressing.py for the piece list).

  * G        a small shader-graph DSL (methods return sockets).
  * age()    the shared aging stack: grime in crevices, scuffed convex edges, scratches, stains,
             floor dirt, faded color and dust on up-facing surfaces. Geometry masks (AO, small AO,
             bevel edges) are baked ONCE per piece into a mask image that every material samples.
  * mat_*    procedural aged materials (wood, paint, metal, cloth, fur, paper, glass, wax...).
  * geometry bmesh helpers: beveled boxes, lathes, tubes along paths, swept profiles, grids.
  * Piece    collects parts, unwraps (per-part density weights), joins, bakes color / roughness /
             metal / normal (+ alpha for glass) into one atlas per material group, exports the GLB
             with root extras {size, placement} and renders the review previews.

Helper module only: build() is a no-op (art/build.py calls build() on every module).
Env: DRESS_Q=draft (256 px bakes, few samples) | final (default); DRESS_PREVIEW=0 skips renders;
DRESS_THREADS (default 2).
"""

from __future__ import annotations

import math
import os
import random
import subprocess
import time

import bpy  # noqa: I001
import bmesh
import numpy as np
from mathutils import Matrix, Vector

import common as C

DRAFT = os.environ.get('DRESS_Q', 'final') == 'draft'
DO_PREVIEW = os.environ.get('DRESS_PREVIEW', '1') != '0'
THREADS = int(os.environ.get('DRESS_THREADS', '2'))
HERE = os.path.dirname(os.path.abspath(__file__))


def build() -> None:
    print('dressing_lib: helper module (built through dressing.py)')


# =============================================================================================
# Colors
# =============================================================================================

def srgb(*c):
    if len(c) == 1:
        c = c[0]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def hexc(h: str):
    h = h.lstrip('#')
    return srgb(*(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)))


DUST = hexc('8c877d')
GRIME = hexc('15110d')

# =============================================================================================
# Node DSL
# =============================================================================================

Sock = bpy.types.NodeSocket


def new_material(name):
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    return mat


class G:
    def __init__(self, mat):
        self.mat = mat
        self.nt = mat.node_tree
        for n in list(self.nt.nodes):
            self.nt.nodes.remove(n)
        self.out = self.nt.nodes.new('ShaderNodeOutputMaterial')
        self.bsdf = self.nt.nodes.new('ShaderNodeBsdfPrincipled')
        self.nt.links.new(self.bsdf.outputs['BSDF'], self.out.inputs['Surface'])
        self.c = {}
        mat['metal'] = 0
        mat['glass'] = 0

    # plumbing
    def _in(self, n, key):
        if isinstance(key, int):
            return n.inputs[key]
        for s in n.inputs:
            if s.identifier == key:
                return s
        for s in n.inputs:
            if s.name == key and s.enabled:
                return s
        for s in n.inputs:
            if s.name == key:
                return s
        raise KeyError(f'{n.bl_idname} has no input {key}')

    def set(self, sock, v):
        if v is None:
            return
        if isinstance(v, Sock):
            self.nt.links.new(v, sock)
            return
        dv = sock.default_value
        if hasattr(dv, '__len__'):
            if isinstance(v, (int, float)):
                v = [float(v)] * len(dv)
            v = list(v) + [1.0] * (len(dv) - len(v))
            sock.default_value = v[:len(dv)]
        else:
            sock.default_value = float(v)

    def node(self, kind, ins=None, **props):
        n = self.nt.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        for k, v in (ins or {}).items():
            self.set(self._in(n, k), v)
        return n

    def out_(self, n, key):
        for s in n.outputs:
            if s.identifier == key or s.name == key:
                if s.enabled:
                    return s
        for s in n.outputs:
            if s.identifier == key or s.name == key:
                return s
        return n.outputs[key]

    # inputs
    def geo(self, key):
        if 'geo' not in self.c:
            self.c['geo'] = self.node('ShaderNodeNewGeometry')
        return self.c['geo'].outputs[key]

    def pos(self):
        if 'tc' not in self.c:
            self.c['tc'] = self.node('ShaderNodeTexCoord')
        return self.c['tc'].outputs['Object']

    def attr(self, name, kind='Vector'):
        k = ('attr', name)
        if k not in self.c:
            self.c[k] = self.node('ShaderNodeAttribute', attribute_type='GEOMETRY', attribute_name=name)
        return self.c[k].outputs[kind]

    def gc(self):
        """Per-part local coordinates (grain along X), stored by Part placement."""
        return self.attr('gc')

    def uv(self, name='src'):
        k = ('uv', name)
        if k not in self.c:
            self.c[k] = self.node('ShaderNodeUVMap', uv_map=name)
        return self.c[k].outputs['UV']

    def nz(self):
        return self.sep(self.geo('Normal'))[2]

    # math
    def m(self, op, a, b=None, c=None, clamp=False):
        n = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.set(n.inputs[0], a)
        if b is not None:
            self.set(n.inputs[1], b)
        if c is not None:
            self.set(n.inputs[2], c)
        return n.outputs[0]

    def add(self, a, b, clamp=False):
        return self.m('ADD', a, b, clamp=clamp)

    def sub(self, a, b, clamp=False):
        return self.m('SUBTRACT', a, b, clamp=clamp)

    def mul(self, a, b, clamp=False):
        return self.m('MULTIPLY', a, b, clamp=clamp)

    def madd(self, a, b, c, clamp=False):
        return self.m('MULTIPLY_ADD', a, b, c, clamp=clamp)

    def clamp(self, a):
        return self.m('ADD', a, 0.0, clamp=True)

    def inv(self, a):
        return self.m('SUBTRACT', 1.0, a, clamp=True)

    def mx(self, a, b):
        return self.m('MAXIMUM', a, b)

    def mn(self, a, b):
        return self.m('MINIMUM', a, b)

    def pw(self, a, b):
        return self.m('POWER', a, b)

    def absf(self, a):
        return self.m('ABSOLUTE', a)

    def sin(self, a):
        return self.m('SINE', a)

    def fract(self, a):
        return self.m('FRACT', a)

    def rng(self, x, a, b, c=0.0, d=1.0, smooth=True, clamp=True):
        n = self.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP' if smooth else 'LINEAR', clamp=clamp)
        self.set(n.inputs['From Min'], a)
        self.set(n.inputs['From Max'], b)
        self.set(n.inputs['To Min'], c)
        self.set(n.inputs['To Max'], d)
        self.set(n.inputs['Value'], x)
        return n.outputs['Result']

    def v(self, op, a, b=None, scale=None):
        n = self.node('ShaderNodeVectorMath', operation=op)
        self.set(n.inputs[0], a)
        if b is not None:
            self.set(n.inputs[1], b)
        if scale is not None:
            self.set(self._in(n, 'Scale'), scale)
        return n.outputs['Value'] if op in ('DOT_PRODUCT', 'LENGTH', 'DISTANCE') else n.outputs['Vector']

    def vmul(self, a, s):
        return self.v('MULTIPLY', a, s)

    def vadd(self, a, b):
        return self.v('ADD', a, b)

    def sep(self, vec):
        n = self.node('ShaderNodeSeparateXYZ')
        self.set(n.inputs[0], vec)
        return n.outputs['X'], n.outputs['Y'], n.outputs['Z']

    def comb(self, x, y, z):
        n = self.node('ShaderNodeCombineXYZ')
        for i, val in enumerate((x, y, z)):
            self.set(n.inputs[i], val)
        return n.outputs[0]

    def mix(self, fac, a, b, blend='MIX'):
        n = self.node('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_factor=True)
        self.set(n.inputs[0], fac)
        self.set(n.inputs[6], a)
        self.set(n.inputs[7], b)
        return n.outputs[2]

    def mixf(self, fac, a, b):
        n = self.node('ShaderNodeMix', data_type='FLOAT', clamp_factor=True)
        self.set(n.inputs[0], fac)
        self.set(n.inputs[2], a)
        self.set(n.inputs[3], b)
        return n.outputs[0]

    def hsv(self, col, h=0.5, s=1.0, v=1.0):
        return self.node('ShaderNodeHueSaturation', {'Hue': h, 'Saturation': s, 'Value': v, 'Fac': 1.0,
                                                     'Color': col}).outputs[0]

    def ramp(self, fac, stops):
        n = self.node('ShaderNodeValToRGB')
        cr = n.color_ramp
        while len(cr.elements) > 1:
            cr.elements.remove(cr.elements[-1])
        for i, (p, col) in enumerate(stops):
            e = cr.elements[0] if i == 0 else cr.elements.new(p)
            e.position = p
            e.color = (*col, 1.0) if len(col) == 3 else col
        self.set(n.inputs[0], fac)
        return n.outputs[0]

    # textures
    def _co(self, vec, stretch=None, offset=None):
        vec = self.pos() if vec is None else vec
        if stretch is not None:
            vec = self.vmul(vec, stretch)
        if offset is not None:
            vec = self.vadd(vec, offset)
        return vec

    def noise(self, vec=None, scale=5.0, detail=2.0, rough=0.5, dist=0.0, stretch=None, offset=None, out='Fac'):
        n = self.node('ShaderNodeTexNoise', {'Vector': self._co(vec, stretch, offset), 'Scale': scale,
                                             'Detail': detail, 'Roughness': rough, 'Distortion': dist})
        return self.out_(n, out)

    def vor(self, vec=None, scale=5.0, feature='F1', out='Distance', rand=1.0, stretch=None, offset=None,
            metric='EUCLIDEAN'):
        n = self.node('ShaderNodeTexVoronoi', {'Vector': self._co(vec, stretch, offset), 'Scale': scale,
                                               'Randomness': rand}, feature=feature, distance=metric)
        return self.out_(n, out)

    def wave(self, vec=None, scale=1.0, kind='BANDS', direction='X', dist=0.0, detail=0.0, profile='SIN',
             stretch=None, offset=None, rings_dir='SPHERICAL'):
        props = dict(wave_type=kind, wave_profile=profile)
        if kind == 'BANDS':
            props['bands_direction'] = direction
        else:
            props['rings_direction'] = rings_dir
        n = self.node('ShaderNodeTexWave', {'Vector': self._co(vec, stretch, offset), 'Scale': scale,
                                            'Distortion': dist, 'Detail': detail}, **props)
        return n.outputs['Fac']

    def img(self, image, vec=None, interp='Linear', ext='EXTEND'):
        n = self.node('ShaderNodeTexImage', interpolation=interp, extension=ext)
        n.image = image
        self.set(n.inputs['Vector'], vec if vec is not None else self.uv('src'))
        return n.outputs['Color'], n.outputs['Alpha']

    def bump(self, h, dist=0.001, strength=1.0, normal=None):
        n = self.node('ShaderNodeBump', {'Strength': strength, 'Distance': dist, 'Height': h})
        if normal is not None:
            self.set(self._in(n, 'Normal'), normal)
        return n.outputs['Normal']

    # baked geometry masks (R = AO large, G = edge, B = AO small), sampled with the atlas UV
    def mask(self, ch):
        if 'mask' not in self.c:
            t = self.node('ShaderNodeTexImage', interpolation='Linear', extension='EXTEND')
            t.name = '__mask__'
            self.set(t.inputs['Vector'], self.uv('atlas'))
            self.c['mask'] = self.node('ShaderNodeSeparateColor', {'Color': t.outputs['Color']})
        return self.c['mask'].outputs[ch]

    def ao(self):
        return self.mask(0)

    def ao_s(self):
        return self.mask(2)

    def edge(self):
        return self.mask(1)

    def convex(self):
        if 'convex' not in self.c:
            self.c['convex'] = self.mul(self.edge(), self.rng(self.ao_s(), 0.72, 0.95))
        return self.c['convex']

    def cavity(self, lo=0.4, hi=0.97):
        return self.rng(self.ao(), hi, lo)

    def up(self, lo=0.35, hi=0.9):
        return self.rng(self.nz(), lo, hi)

    def finish(self, col, rough, h=None, metal=0.0, alpha=None, bump_dist=0.0008, normal=None, soft=None):
        """Wire the graph. Metal/alpha go to named nodes (baked via emission), not the BSDF.
        soft = radius: rounds hard edges in the baked normal map (Bevel shader node)."""
        self.set(self.bsdf.inputs['Base Color'], col)
        self.set(self.bsdf.inputs['Roughness'], rough)
        nrm = normal
        if soft:
            nrm = self.node('ShaderNodeBevel', {'Radius': soft}, samples=8).outputs['Normal']
        if h is not None:
            nrm = self.bump(h, bump_dist, 1.0, normal)
        if nrm is not None:
            self.set(self.bsdf.inputs['Normal'], nrm)
        for key, val in (('__metal__', metal), ('__alpha__', 1.0 if alpha is None else alpha)):
            n = self.node('ShaderNodeMath', operation='ADD', use_clamp=True)
            n.name = key
            self.set(n.inputs[0], val)
            self.set(n.inputs[1], 0.0)
        if not (isinstance(metal, (int, float)) and metal == 0):
            self.mat['metal'] = 1
        self.c['color'] = col
        return self.mat


# =============================================================================================
# Aging stack
# =============================================================================================

def age(g: G, col, rough, h, *, dust=0.6, grime=0.7, wear=0.5, wear_col=None, wear_rough=None,
        scratch=0.3, stains=0.0, stain_col=None, floor=0.0, floor_h=0.15, fade=0.0, film=0.15, seed=0.0,
        dust_scale=1.0, vec=None, up_lo=0.35):
    """Grime -> edge wear -> scratches -> stains -> floor dirt -> fade -> dust. Returns col, rough, h."""
    p = g.pos() if vec is None else vec
    off = (seed * 13.7, seed * 5.3, seed * 9.1)
    if fade > 0:
        # sun/age fading: desaturate + lift toward a warm gray, blotchy
        fn = g.noise(p, 1.8, 2, 0.5, offset=off)
        f = g.mul(g.rng(fn, 0.3, 0.7, 0.6, 1.0), fade)
        col = g.mix(f, col, g.mix(0.5, g.hsv(col, s=0.35, v=1.15), hexc('8a8172')))
    if grime > 0:
        cav = g.cavity()
        gn = g.noise(p, 9.0, 3, 0.6, offset=off)
        cav = g.clamp(g.mul(g.mul(cav, grime), g.rng(gn, 0.3, 0.7, 0.55, 1.35)))
        col = g.mix(cav, col, GRIME)
        rough = g.add(rough, g.mul(cav, 0.2), clamp=True)
    if wear > 0:
        wn = g.noise(p, 26.0, 3, 0.65, offset=off)
        wn2 = g.noise(p, 3.5, 2, 0.5, offset=off)
        w = g.add(g.mul(g.convex(), 1.15), g.mul(g.sub(wn, 0.5), 1.3))
        w = g.mul(g.rng(w, 0.45, 0.8), g.rng(wn2, 0.25, 0.65, 0.35, 1.0))
        w = g.mul(w, wear)
        col = g.mix(w, col, wear_col if wear_col is not None else g.hsv(col, s=0.75, v=1.6))
        if wear_rough is not None:
            rough = g.mixf(w, rough, wear_rough)
        h = g.sub(h, g.mul(w, 0.2))
    if scratch > 0:
        s1 = g.vor(p, 11.0, 'DISTANCE_TO_EDGE', stretch=(1.0, 13.0, 1.0), offset=off)
        s2 = g.vor(p, 8.0, 'DISTANCE_TO_EDGE', stretch=(15.0, 1.0, 1.5), offset=(off[1], off[0], 2.0))
        sm = g.noise(p, 4.0, 1, 0.5, offset=(1.7, 2.0 + seed, 0.3))
        s = g.mx(g.rng(s1, 0.014, 0.0), g.rng(s2, 0.011, 0.0))
        s = g.mul(g.mul(s, g.rng(sm, 0.42, 0.7)), scratch)
        col = g.mix(g.mul(s, 0.5), col, g.hsv(col, s=0.6, v=1.9))
        rough = g.add(rough, g.mul(s, 0.12), clamp=True)
        h = g.sub(h, g.mul(s, 0.25))
    if stains > 0:
        sn = g.noise(p, 2.6, 3, 0.55, offset=(off[2], 9.0, 1.0))
        inside = g.rng(sn, 0.6, 0.64)
        rim = g.mul(g.rng(sn, 0.585, 0.61), g.rng(sn, 0.655, 0.625))
        sc = stain_col if stain_col is not None else g.hsv(col, s=0.7, v=0.55)
        col = g.mix(g.mul(inside, 0.45 * stains), col, sc)
        col = g.mix(g.mul(rim, 0.8 * stains), col, g.hsv(sc, s=1.1, v=0.6))
    if floor > 0:
        z = g.sep(g.pos())[2]
        fz = g.rng(z, floor_h, 0.0)
        fnz = g.noise(p, 6.0, 3, 0.6, offset=(off[0], 1.0, 7.0))
        fm = g.mul(g.mul(fz, g.rng(fnz, 0.25, 0.75, 0.35, 1.0)), floor)
        col = g.mix(fm, col, g.mix(0.5, g.hsv(col, s=0.5, v=0.45), hexc('2b251d')))
        rough = g.add(rough, g.mul(fm, 0.12), clamp=True)
    if dust > 0:
        up = g.up(up_lo, 0.92)
        dn = g.noise(p, 3.2 * dust_scale, 3, 0.6, offset=(off[1], 2.0, 5.0))
        dfine = g.noise(p, 70.0 * dust_scale, 2, 0.6)
        d = g.mul(up, g.rng(dn, 0.25, 0.75, 0.2, 0.9))
        # dust gathers along inner corners of top faces too (AO between 0.5..0.9 on up faces)
        d = g.add(g.mul(d, dust), film * dust)
        d = g.mul(d, g.rng(dfine, 0.2, 0.8, 0.75, 1.12))
        d = g.clamp(d)
        col = g.mix(d, col, DUST)
        rough = g.mixf(d, rough, 0.95)
        h = g.add(h, g.mul(g.mul(up, dfine), dust * 0.08))
    return col, rough, h


# =============================================================================================
# Materials
# =============================================================================================

def wood_pattern(g: G, light, dark, *, ring=0.007, figure=0.6, pores=0.4, vec=None, seed=0.0):
    """Grain along gc X. Returns (col, height)."""
    v = g.gc() if vec is None else vec
    off = (seed * 3.1, seed * 1.7, seed * 2.3)
    v = g.vadd(v, off)
    x, y, z = g.sep(v)
    warp = g.noise(v, 2.5, 3, 0.55, stretch=(0.15, 1.0, 1.0))
    d = g.add(g.m('SQRT', g.add(g.mul(y, y), g.mul(g.add(z, 0.13), g.add(z, 0.13)))), g.mul(warp, 0.03))
    rings = g.fract(g.m('DIVIDE', d, ring))
    late = g.rng(rings, 0.55, 0.9)
    fig = g.noise(v, 6.0, 4, 0.6, stretch=(0.08, 1.0, 1.0))
    streak = g.noise(v, 40.0, 2, 0.5, stretch=(0.04, 1.0, 1.0))
    t = g.clamp(g.add(g.mul(late, 0.55), g.mul(g.sub(fig, 0.5), figure)))
    t = g.clamp(g.add(t, g.mul(g.sub(streak, 0.5), 0.5)))
    col = g.mix(t, light, dark)
    pore = g.noise(v, 260.0, 1, 0.5, stretch=(0.06, 1.0, 1.0))
    pm = g.mul(g.rng(pore, 0.62, 0.75), pores)
    col = g.mix(g.mul(pm, 0.5), col, g.hsv(dark, v=0.6))
    h = g.add(g.mul(late, 0.25), g.mul(pm, -0.4))
    return col, h


def mat_wood(name, light, dark, *, gloss=0.38, ring=0.007, figure=0.6, dust=0.6, grime=0.7, wear=0.6,
             scratch=0.4, stains=0.0, floor=0.0, fade=0.15, seed=0.0, raw=False, peel=0.0, peel_col=None,
             bump=0.0008, film=0.15, soft=0.0025, cracks=0.0):
    mat = new_material(name)
    g = G(mat)
    col, h = wood_pattern(g, light, dark, ring=ring, figure=figure, seed=seed)
    rough = g.add(gloss, g.mul(g.noise(None, 8.0, 2, 0.5, offset=(seed, 0, 0)), 0.18))
    if cracks > 0:
        # weather checks: dark splits running along the grain
        ck = g.vor(g.vmul(g.gc(), (1.5, 40.0, 40.0)), 3.0, 'DISTANCE_TO_EDGE', offset=(seed, 0, 0))
        cm = g.mul(g.rng(ck, 0.04, 0.0), g.rng(g.noise(g.gc(), 2.0, 2, 0.5, stretch=(0.5, 3.0, 3.0)), 0.45, 0.6))
        cm = g.mul(cm, cracks)
        col = g.mix(cm, col, hexc('120c08'))
        h = g.sub(h, g.mul(cm, 1.2))
    if peel > 0:
        # flaking varnish/paint: lighter raw wood exposed in blotches near edges
        pn = g.noise(None, 7.0, 4, 0.65, offset=(seed * 2.0, 3.0, 1.0))
        pm = g.rng(g.add(pn, g.mul(g.convex(), 0.25)), 0.66 - peel * 0.2, 0.69 - peel * 0.2, smooth=False)
        rawc = peel_col if peel_col is not None else g.hsv(light, s=0.5, v=1.25)
        col = g.mix(pm, col, rawc)
        rough = g.mixf(pm, rough, 0.85)
        h = g.sub(h, g.mul(pm, 0.4))
    wear_col = g.hsv(light, s=0.6, v=1.35) if not raw else g.hsv(light, s=0.5, v=1.5)
    col, rough, h = age(g, col, rough, h, dust=dust, grime=grime, wear=wear, wear_col=wear_col, wear_rough=0.75,
                        scratch=scratch, stains=stains, floor=floor, fade=fade, seed=seed, film=film)
    return g.finish(col, rough, h, bump_dist=bump, soft=soft)


def mat_paint(name, color, under, *, gloss=0.55, chip=0.5, dust=0.5, grime=0.8, wear=0.5, seed=0.0,
              stains=0.0, fade=0.3, floor=0.0, scratch=0.25, base_is_wood=True):
    mat = new_material(name)
    g = G(mat)
    p = g.pos()
    pn = g.noise(p, 16.0, 5, 0.7, offset=(seed, 1.0, 2.0))
    big = g.noise(p, 3.0, 2, 0.5, offset=(seed, 4.0, 0.0))
    chipm = g.rng(g.add(g.add(pn, g.mul(g.convex(), 0.45)), g.mul(g.sub(big, 0.5), 0.3)),
                  0.74 - chip * 0.18, 0.755 - chip * 0.18, smooth=False)
    if base_is_wood:
        ucol, uh = wood_pattern(g, under, g.hsv(under, v=0.6), seed=seed)
    else:
        ucol, uh = under, 0.0
    col = g.mix(g.mul(g.noise(p, 3.0, 3, 0.5), 0.25), color, g.hsv(color, s=0.8, v=0.85))
    col = g.mix(chipm, col, ucol)
    rough = g.mixf(chipm, gloss, 0.8)
    h = g.mul(g.inv(chipm), 0.6)
    col, rough, h = age(g, col, rough, h, dust=dust, grime=grime, wear=wear, scratch=scratch, stains=stains,
                        fade=fade, seed=seed, floor=floor)
    return g.finish(col, rough, h, soft=0.002)


def mat_metal(name, color, *, rough=0.38, tarnish=0.5, tarnish_col=None, rust=0.0, dust=0.4, grime=0.8,
              wear=0.5, seed=0.0, pit=0.3, scratch=0.3):
    mat = new_material(name)
    g = G(mat)
    p = g.pos()
    tn = g.noise(p, 5.0, 4, 0.6, offset=(seed, 2.0, 0.0))
    tm = g.mul(g.rng(g.add(tn, g.mul(g.cavity(), 0.4)), 0.35, 0.75), tarnish)
    tcol = tarnish_col if tarnish_col is not None else g.hsv(color, s=0.6, v=0.35)
    col = g.mix(tm, color, tcol)
    r = g.mixf(tm, rough, 0.7)
    metal = g.sub(1.0, g.mul(tm, 0.55))
    h = g.mul(g.noise(p, 90.0, 2, 0.5), pit * 0.3)
    if rust > 0:
        rn = g.noise(p, 9.0, 4, 0.7, offset=(seed, 5.0, 1.0))
        rm = g.mul(g.rng(g.add(rn, g.mul(g.cavity(), 0.35)), 0.55, 0.7), rust)
        rcol = g.mix(g.noise(p, 30.0, 2, 0.5), hexc('5a2e17'), hexc('8a4a22'))
        col = g.mix(rm, col, rcol)
        r = g.mixf(rm, r, 0.9)
        metal = g.mixf(rm, metal, 0.0)
        h = g.add(h, g.mul(rm, g.noise(p, 60.0, 3, 0.6)))
    # worn bright high points
    col, r, h = age(g, col, r, h, dust=dust, grime=grime, wear=wear, wear_col=g.hsv(color, s=0.9, v=1.35),
                    wear_rough=0.25, scratch=scratch, seed=seed, film=0.1)
    return g.finish(col, r, h, metal=metal, soft=0.0015)


def mat_fabric(name, base, alt=None, *, weave=420.0, fade=0.4, stains=0.4, dust=0.5, grime=0.9, seed=0.0,
               pattern=None, holes=0.0, rough=0.9, vec=None, floor=0.0):
    """Woven cloth (wool/cotton). pattern(g, vec) -> (col) optional overlay."""
    mat = new_material(name)
    g = G(mat)
    p = g.pos() if vec is None else vec
    w1 = g.wave(p, weave, 'BANDS', 'X', profile='SIN')
    w2 = g.wave(p, weave, 'BANDS', 'Z', profile='SIN')
    w3 = g.wave(p, weave, 'BANDS', 'Y', profile='SIN')
    wv = g.mul(g.add(g.add(w1, w2), w3), 0.333)
    fuzz = g.noise(p, 150.0, 3, 0.7, offset=(seed, 0, 0))
    col = base
    if alt is not None:
        col = g.mix(g.rng(g.noise(p, 25.0, 2, 0.5), 0.4, 0.6), base, alt)
    if pattern is not None:
        col = pattern(g, p, col)
    col = g.mix(g.mul(g.sub(fuzz, 0.3), 0.35), col, g.hsv(col, v=0.75))
    h = g.add(g.mul(wv, 0.5), g.mul(fuzz, 0.5))
    rgh = g.add(rough, 0.0)
    if holes > 0:
        hv = g.vor(p, 18.0, 'F1', offset=(seed, 1.0, 0))
        hc = g.sep(g.vor(p, 18.0, 'F1', out='Color', offset=(seed, 1.0, 0)))[0]
        hm = g.mul(g.rng(hv, 0.12, 0.07), g.rng(hc, 1.0 - holes * 0.15, 1.0 - holes * 0.15 + 0.01))
        col = g.mix(hm, col, hexc('0d0b09'))
        h = g.sub(h, g.mul(hm, 2.0))
    col, rgh, h = age(g, col, rgh, h, dust=dust, grime=grime, wear=0.25, wear_col=g.hsv(col, s=0.6, v=1.25),
                      scratch=0.0, stains=stains, fade=fade, seed=seed, floor=floor)
    return g.finish(col, rgh, h, bump_dist=0.0006)


def mat_glass(name, tint=(0.05, 0.06, 0.05), *, alpha=0.18, dust=0.8, grime=0.6, seed=0.0, rough=0.06,
              cracks=None):
    """Alpha glass (baked as RGBA). cracks: optional (image) whose R marks crack lines in 'src' UV."""
    mat = new_material(name)
    g = G(mat)
    mat['glass'] = 1
    p = g.pos()
    up = g.up(0.2, 0.85)
    dn = g.noise(p, 4.0, 3, 0.6, offset=(seed, 3.0, 0))
    smear = g.noise(p, 1.5, 4, 0.7, stretch=(1.0, 1.0, 3.0), offset=(0, seed, 0))
    d = g.clamp(g.add(g.mul(g.mul(up, g.rng(dn, 0.25, 0.7, 0.3, 1.0)), dust), g.mul(g.rng(smear, 0.45, 0.7), dust * 0.25)))
    cav = g.mul(g.cavity(0.5, 0.98), grime)
    col = g.mix(d, tint, DUST)
    col = g.mix(cav, col, GRIME)
    a = g.clamp(g.add(g.add(alpha, g.mul(d, 0.65)), g.mul(cav, 0.5)))
    r = g.mixf(d, rough, 0.85)
    if cracks is not None:
        cc, _ = g.img(cracks)
        cr = g.sep(cc)[0]
        col = g.mix(cr, col, hexc('c9cbc6'))
        a = g.clamp(g.add(a, g.mul(cr, 0.75)))
        r = g.mixf(cr, r, 0.5)
    return g.finish(col, r, None, alpha=a)


def mat_plain(name, color, rough=0.7, *, dust=0.4, grime=0.8, noise_amt=0.15, seed=0.0, wear=0.3, scratch=0.15,
              stains=0.0, fade=0.1, metal=0.0, floor=0.0):
    mat = new_material(name)
    g = G(mat)
    p = g.pos()
    col = g.mix(g.mul(g.noise(p, 6.0, 3, 0.5, offset=(seed, 0, 0)), noise_amt), color, g.hsv(color, v=0.7))
    h = g.mul(g.noise(p, 50.0, 2, 0.5), 0.3)
    col, r, h = age(g, col, rough, h, dust=dust, grime=grime, wear=wear, scratch=scratch, stains=stains,
                    fade=fade, seed=seed, floor=floor)
    return g.finish(col, r, h, metal=metal, soft=0.0015)


def mat_image(name, image, *, rough=0.6, dust=0.35, grime=0.6, wear=0.0, fade=0.0, seed=0.0, scratch=0.0,
              bump_img=0.0, stains=0.0, vec=None, interp='Linear'):
    """A printed/painted image (src UV) with the aging stack on top."""
    mat = new_material(name)
    g = G(mat)
    c, _ = g.img(image, vec, interp=interp)
    h = g.mul(g.sep(c)[1], bump_img) if bump_img else g.mul(g.noise(None, 80.0, 2, 0.5), 0.1)
    col, r, h = age(g, c, rough, h, dust=dust, grime=grime, wear=wear, fade=fade, seed=seed, scratch=scratch,
                    stains=stains)
    return g.finish(col, r, h)


# =============================================================================================
# Geometry
# =============================================================================================

def _link(bm, name):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def xf(loc=(0, 0, 0), rot=(0, 0, 0), scale=None, order='XYZ'):
    from mathutils import Euler
    M = Matrix.Translation(Vector(loc)) @ Euler([math.radians(a) for a in rot], order).to_matrix().to_4x4()
    if scale is not None:
        s = scale if hasattr(scale, '__len__') else (scale,) * 3
        M = M @ Matrix.Diagonal((*s, 1.0))
    return M


def place(obj, M=None, grain='auto', gc_off=None):
    """Store the part's local coords as 'gc' (grain along X), then move it to M (world)."""
    me = obj.data
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(n, 3)
    if grain == 'auto':
        ext = co.max(0) - co.min(0) if n else np.ones(3)
        a = int(np.argmax(ext))
    else:
        a = 'xyz'.index(grain)
    order = [a] + [i for i in range(3) if i != a]
    gc = co[:, order].copy()
    off = np.array(gc_off if gc_off is not None else [random.uniform(-5, 5) for _ in range(3)], dtype=np.float32)
    gc += off
    at = me.attributes.get('gc') or me.attributes.new('gc', 'FLOAT_VECTOR', 'POINT')
    at.data.foreach_set('vector', gc.ravel())
    if M is not None:
        me.transform(M)
    me.update()
    return obj


def bm_box(sx, sy, sz, bevel=0.003, segs=1, center=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * sx + center[0], v.co.y * sy + center[1], v.co.z * sz + center[2]))
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=segs, affect='EDGES', profile=0.5,
                        clamp_overlap=True)
    return bm


def box(name, size, M=None, bevel=0.003, segs=1, grain='auto', center=(0, 0, 0)):
    obj = _link(bm_box(*size, bevel=bevel, segs=segs, center=center), name)
    return place(obj, M, grain)


def lathe(name, profile, segs=16, M=None, cap_top=True, cap_bot=True, grain='z', start=0.0, arc=360.0,
          jitter=0.0, seed=1):
    """profile: [(r, z)] bottom->top. Revolve around Z."""
    rnd = random.Random(seed)
    bm = bmesh.new()
    rings = []
    full = abs(arc - 360.0) < 1e-6
    nseg = segs if full else segs + 1
    for (r, z) in profile:
        ring = []
        for i in range(nseg):
            a = math.radians(start + arc * i / segs)
            rr = r * (1.0 + (rnd.uniform(-jitter, jitter) if jitter else 0.0))
            if r < 1e-6:
                ring.append(None)
                continue
            ring.append(bm.verts.new((rr * math.cos(a), rr * math.sin(a), z)))
        rings.append(ring)
    centers = {}
    for k in range(len(profile) - 1):
        a_, b_ = rings[k], rings[k + 1]
        for i in range(segs):
            j = (i + 1) % nseg if full else i + 1
            if a_[i] is None and b_[i] is None:
                continue
            if a_[i] is None:
                c = centers.get(k) or bm.verts.new((0, 0, profile[k][1]))
                centers[k] = c
                bm.faces.new((c, b_[j], b_[i]))
            elif b_[i] is None:
                c = centers.get(k + 1) or bm.verts.new((0, 0, profile[k + 1][1]))
                centers[k + 1] = c
                bm.faces.new((a_[i], a_[j], c))
            else:
                bm.faces.new((a_[i], a_[j], b_[j], b_[i]))
    if full:
        if cap_bot and rings[0][0] is not None:
            f = bm.faces.new(list(reversed(rings[0])))
        if cap_top and rings[-1][0] is not None:
            bm.faces.new(rings[-1])
    bm.normal_update()
    obj = _link(bm, name)
    return place(obj, M, grain)


def frames_along(pts, up_hint=(0, 0, 1)):
    """Parallel-transport frames along a polyline: returns [(p, t, n, b)]."""
    P = [Vector(p) for p in pts]
    T = []
    for i in range(len(P)):
        a = P[max(i - 1, 0)]
        b = P[min(i + 1, len(P) - 1)]
        T.append((b - a).normalized())
    up = Vector(up_hint)
    if abs(T[0].dot(up)) > 0.95:
        up = Vector((1, 0, 0))
    N = [(up - T[0] * up.dot(T[0])).normalized()]
    for i in range(1, len(P)):
        n = N[-1] - T[i] * N[-1].dot(T[i])
        N.append(n.normalized() if n.length > 1e-6 else N[-1])
    return [(P[i], T[i], N[i], T[i].cross(N[i])) for i in range(len(P))]


def tube(name, pts, radius, segs=8, M=None, caps=True, profile=None, closed=False, twist=0.0, grain='path',
         up_hint=(0, 0, 1), scale_xy=(1.0, 1.0)):
    """Sweep a circle (or a 2D profile [(x, y)]) along pts. radius: float or per-point list."""
    fr = frames_along(pts, up_hint)
    if not hasattr(radius, '__len__'):
        radius = [radius] * len(pts)
    if profile is None:
        profile = [(math.cos(2 * math.pi * i / segs) * scale_xy[0], math.sin(2 * math.pi * i / segs) * scale_xy[1])
                   for i in range(segs)]
    area = sum(profile[i][0] * profile[(i + 1) % len(profile)][1] - profile[(i + 1) % len(profile)][0] * profile[i][1]
               for i in range(len(profile)))
    if area < 0:  # keep outward normals whatever the profile winding
        profile = list(reversed(profile))
    bm = bmesh.new()
    rings = []
    L = 0.0
    gcs = []
    for k, (p, t, n, b) in enumerate(fr):
        if k:
            L += (p - fr[k - 1][0]).length
        ang = twist * k / max(1, len(fr) - 1)
        ca, sa = math.cos(ang), math.sin(ang)
        ring = []
        for (x, y) in profile:
            xx, yy = x * ca - y * sa, x * sa + y * ca
            v = bm.verts.new(p + (n * xx + b * yy) * radius[k])
            ring.append(v)
            gcs.append((L, xx * radius[k], yy * radius[k]))
        rings.append(ring)
    m = len(profile)
    nr = len(rings)
    for k in range(nr - 1 + (1 if closed else 0)):
        a_, b_ = rings[k], rings[(k + 1) % nr]
        for i in range(m):
            j = (i + 1) % m
            bm.faces.new((a_[i], a_[j], b_[j], b_[i]))
    if caps and not closed:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    bm.normal_update()
    obj = _link(bm, name)
    if grain == 'path':
        at = obj.data.attributes.new('gc', 'FLOAT_VECTOR', 'POINT')
        off = np.array([random.uniform(-5, 5) for _ in range(3)], dtype=np.float32)
        at.data.foreach_set('vector', (np.array(gcs, dtype=np.float32) + off).ravel())
        if M is not None:
            obj.data.transform(M)
        return obj
    return place(obj, M, grain)


def grid(name, nu, nv, fn, M=None, grain='x', thickness=0.0, src_uv=True, two_sided_uv=False):
    """Parametric sheet: fn(u, v) -> (x, y, z), u, v in [0, 1]. Writes a 'src' UV = (u, v)."""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('src')
    V = [[bm.verts.new(fn(i / nu, j / nv)) for i in range(nu + 1)] for j in range(nv + 1)]
    for j in range(nv):
        for i in range(nu):
            f = bm.faces.new((V[j][i], V[j][i + 1], V[j + 1][i + 1], V[j + 1][i]))
            for lp, (a, b) in zip(f.loops, ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))):
                lp[uvl].uv = (a / nu, b / nv)
    if thickness > 0:
        bm.normal_update()
        res = bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=thickness)
        del res
    bm.normal_update()
    obj = _link(bm, name)
    return place(obj, M, grain)


def mesh(name, verts, faces, M=None, grain='auto', uvs=None):
    bm = bmesh.new()
    vv = [bm.verts.new(v) for v in verts]
    uvl = bm.loops.layers.uv.new('src') if uvs is not None else None
    for fi, f in enumerate(faces):
        face = bm.faces.new([vv[i] for i in f])
        if uvl is not None:
            for lp, i in zip(face.loops, f):
                lp[uvl].uv = uvs[i]
    bm.normal_update()
    obj = _link(bm, name)
    return place(obj, M, grain)


def prism(name, outline, depth, M=None, bevel=0.0, segs=1, grain='auto', src_uv=None):
    """Extrude a 2D outline [(x, y)] (CCW) along Z from 0 to depth."""
    bm = bmesh.new()
    bot = [bm.verts.new((x, y, 0.0)) for x, y in outline]
    top = [bm.verts.new((x, y, depth)) for x, y in outline]
    bm.faces.new(list(reversed(bot)))
    ft = bm.faces.new(top)
    n = len(outline)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((bot[i], bot[j], top[j], top[i]))
    if src_uv is not None:
        uvl = bm.loops.layers.uv.new('src')
        (x0, y0), (x1, y1) = src_uv
        for f in bm.faces:
            for lp in f.loops:
                lp[uvl].uv = ((lp.vert.co.x - x0) / (x1 - x0), (lp.vert.co.y - y0) / (y1 - y0))
    bm.normal_update()
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=segs, affect='EDGES', clamp_overlap=True)
    obj = _link(bm, name)
    return place(obj, M, grain)


def displace(obj, fn):
    """Move every vertex: fn(Vector) -> Vector (new position)."""
    for v in obj.data.vertices:
        v.co = fn(v.co.copy())
    obj.data.update()


def bevel_obj(obj, width, segs=1, angle=40.0):
    """Bevel sharp edges (above `angle`) of an existing mesh."""
    mod = obj.modifiers.new('bev', 'BEVEL')
    mod.width = width
    mod.segments = segs
    mod.limit_method = 'ANGLE'
    mod.angle_limit = math.radians(angle)
    mod.harden_normals = False
    mod.use_clamp_overlap = True
    C.apply_modifiers(obj)


def subdiv(obj, levels=1):
    mod = obj.modifiers.new('sub', 'SUBSURF')
    mod.levels = levels
    mod.render_levels = levels
    C.apply_modifiers(obj)


def ellipse_pts(rx, ry, n, z=0.0):
    return [(rx * math.cos(2 * math.pi * i / n), ry * math.sin(2 * math.pi * i / n)) for i in range(n)]


def sweep(name, profile, path, closed=True, M=None, grain='path'):
    """Sweep a 2D profile [(d, h)] around a closed planar path [(x, y)] in the XY plane.
    d = inward offset (toward the path's inside), h = height (Blender -Y... see callers): the profile
    point maps to path point + inward_normal * d + Z * h. Gives frames/moldings."""
    n = len(path)
    P = [Vector((x, y, 0)) for x, y in path]
    bm = bmesh.new()
    rings = []
    gcs = []
    L = 0.0
    for i in range(n):
        a = P[(i - 1) % n]
        b = P[(i + 1) % n]
        t = (b - a).normalized()
        inward = Vector((-t.y, t.x, 0))  # CCW path -> left normal points inside
        # miter: scale offset by 1/cos(half angle) at corners
        t0 = (P[i] - a).normalized()
        t1 = (b - P[i]).normalized()
        n0 = Vector((-t0.y, t0.x, 0))
        n1 = Vector((-t1.y, t1.x, 0))
        nm = (n0 + n1).normalized()
        k = 1.0 / max(0.3, nm.dot(n0))
        if i:
            L += (P[i] - P[i - 1]).length
        ring = []
        for (d, h) in profile:
            ring.append(bm.verts.new(P[i] + nm * d * k + Vector((0, 0, h))))
            gcs.append((L, d, h))
        rings.append(ring)
    m = len(profile)
    for i in range(n if closed else n - 1):
        r0, r1 = rings[i], rings[(i + 1) % n]
        for j in range(m - 1):
            bm.faces.new((r0[j], r1[j], r1[j + 1], r0[j + 1]))
    bm.normal_update()
    obj = _link(bm, name)
    at = obj.data.attributes.new('gc', 'FLOAT_VECTOR', 'POINT')
    gca = np.array(gcs, dtype=np.float32)
    gca[:, 0] += np.float32(random.uniform(0, 3))  # offset along the path only: (d, h) stay exact
    at.data.foreach_set('vector', gca.ravel())
    if M is not None:
        obj.data.transform(M)
    return obj


def recalc_normals(obj, inside=False):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if inside:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bm.to_mesh(obj.data)
    bm.free()


def bounds(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for v in o.data.vertices:
            p = o.matrix_world @ v.co
            lo = Vector((min(lo.x, p.x), min(lo.y, p.y), min(lo.z, p.z)))
            hi = Vector((max(hi.x, p.x), max(hi.y, p.y), max(hi.z, p.z)))
    return lo, hi


def np_image(name, arr, non_color=False, alpha=False):
    """numpy HxWx3/4 float (top row first, sRGB-encoded if color) -> packed Blender image."""
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=alpha)
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    a = np.ones((h, w, 4), dtype=np.float32)
    a[..., :arr.shape[2] if arr.ndim == 3 else 1] = arr if arr.ndim == 3 else arr[..., None]
    if arr.ndim == 2:
        a[..., 1] = arr
        a[..., 2] = arr
    a = a[::-1]  # Blender rows are bottom-up
    img.pixels.foreach_set(np.clip(a, 0, 1).ravel())
    img.pack()
    return img


# =============================================================================================
# Pipeline
# =============================================================================================

def _activate(obj, sel=None):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in (sel or [obj]):
        o.select_set(True)
    bpy.context.view_layer.objects.active = obj


def _ensure_uv(obj):
    me = obj.data
    names = [u.name for u in me.uv_layers]
    if 'src' not in names:
        if names:
            me.uv_layers[0].name = 'src'
        else:
            me.uv_layers.new(name='src')
    if 'atlas' not in [u.name for u in me.uv_layers]:
        me.uv_layers.new(name='atlas')
    # order: atlas first (index 0 = TEXCOORD_0 in glTF)
    atl = me.uv_layers['atlas']
    me.uv_layers.active = atl
    atl.active_render = True


def _uv_area(obj, layer):
    me = obj.data
    uv = me.uv_layers[layer].data
    a3 = 0.0
    a2 = 0.0
    for p in me.polygons:
        a3 += p.area
        idx = list(p.loop_indices)
        pts = [uv[i].uv for i in idx]
        s = 0.0
        for k in range(len(pts)):
            x0, y0 = pts[k]
            x1, y1 = pts[(k + 1) % len(pts)]
            s += x0 * y1 - x1 * y0
        a2 += abs(s) / 2
    return a3, a2


def _unwrap_part(obj, method, weight, angle):
    _ensure_uv(obj)
    me = obj.data
    if method == 'src':
        src = me.uv_layers['src'].data
        atl = me.uv_layers['atlas'].data
        for i in range(len(atl)):
            atl[i].uv = src[i].uv
    else:
        _activate(obj)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=0.02, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode='OBJECT')
    a3, a2 = _uv_area(obj, 'atlas')
    if a2 > 1e-9:
        s = math.sqrt(a3 / a2) * weight
        atl = me.uv_layers['atlas'].data
        for d in atl:
            d.uv = (d.uv[0] * s, d.uv[1] * s)


def _use_atlas(obj):
    me = obj.data
    atl = me.uv_layers['atlas']
    me.uv_layers.active = atl
    atl.active_render = True


def _pack(obj, size):
    _use_atlas(obj)
    _activate(obj)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    margin = 3.0 / size
    try:
        t0 = time.time()
        bpy.ops.uv.pack_islands(udim_source='CLOSEST_UDIM', rotate=True, rotate_method='CARDINAL', scale=True,
                                merge_overlap=False, margin_method='FRACTION', margin=margin,
                                shape_method=os.environ.get('DRESS_PACK', 'CONVEX'))
        print(f'   pack {time.time() - t0:.1f}s', flush=True)
    except Exception as e:  # pragma: no cover
        print('pack_islands fallback:', e)
        bpy.ops.uv.pack_islands(rotate=True, margin=margin)
    bpy.ops.object.mode_set(mode='OBJECT')


def _join(objs, name):
    objs = [o for o in objs if o is not None]
    if len(objs) > 1:
        with bpy.context.temp_override(active_object=objs[0], selected_editable_objects=objs, selected_objects=objs):
            bpy.ops.object.join()
    o = objs[0]
    o.name = name
    o.data.name = name
    return o


def _triangulate(obj):
    mod = obj.modifiers.new('tri', 'TRIANGULATE')
    mod.min_vertices = 4
    mod.keep_custom_normals = True
    mod.quad_method = 'BEAUTY'
    C.apply_modifiers(obj)


def mask_material(ao_dist, bevel_r, ao_small):
    mat = new_material('__mask__')
    g = G(mat)
    d = g.v('DOT_PRODUCT', g.node('ShaderNodeBevel', {'Radius': bevel_r}, samples=8).outputs['Normal'],
            g.geo('Normal'))
    edge = g.rng(d, 0.99, 0.82)
    ao1 = g.node('ShaderNodeAmbientOcclusion', {'Distance': ao_dist}, samples=12, only_local=True).outputs['AO']
    ao2 = g.node('ShaderNodeAmbientOcclusion', {'Distance': ao_small}, samples=8, only_local=True).outputs['AO']
    col = g.comb(ao1, edge, ao2)
    em = g.node('ShaderNodeEmission', {'Color': col, 'Strength': 1.0})
    g.nt.links.new(em.outputs[0], g.out.inputs['Surface'])
    return mat


def _target(mats, img):
    for mat in mats:
        nt = mat.node_tree
        node = nt.nodes.get('__bake__') or nt.nodes.new('ShaderNodeTexImage')
        node.name = '__bake__'
        node.image = img
        for n in nt.nodes:
            n.select = False
        node.select = True
        nt.nodes.active = node


def _new_img(name, size, non_color):
    img = bpy.data.images.new(name, size, size, alpha=True)
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    return img


def _bake(obj, kind, img, margin):
    _activate(obj)
    kw = dict(margin=margin, margin_type='EXTEND', use_clear=True, target='IMAGE_TEXTURES',
              use_selected_to_active=False)
    if kind == 'normal':
        bpy.ops.object.bake(type='NORMAL', normal_space='TANGENT', **kw)
    elif kind == 'rough':
        bpy.ops.object.bake(type='ROUGHNESS', **kw)
    else:
        bpy.ops.object.bake(type='EMIT', **kw)


def _emit_rewire(mats, key):
    """Route a socket to an Emission shader for EMIT baking. Returns restore info."""
    saved = []
    for mat in mats:
        nt = mat.node_tree
        out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
        bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Strength'].default_value = 1.0
        if key == 'color':
            s = bsdf.inputs['Base Color']
            if s.is_linked:
                nt.links.new(s.links[0].from_socket, em.inputs['Color'])
            else:
                em.inputs['Color'].default_value = s.default_value
        else:
            src = nt.nodes.get('__metal__' if key == 'metal' else '__alpha__')
            if src is not None:
                nt.links.new(src.outputs[0], em.inputs['Color'])
            else:
                v = 0.0 if key == 'metal' else 1.0
                em.inputs['Color'].default_value = (v, v, v, 1)
        old = out.inputs['Surface'].links[0].from_socket
        nt.links.new(em.outputs[0], out.inputs['Surface'])
        saved.append((nt, out, old, em))
    return saved


def _emit_restore(saved):
    for nt, out, old, em in saved:
        nt.links.new(old, out.inputs['Surface'])
        nt.nodes.remove(em)


def _isolate(mats, keep):
    """Unlink BSDF inputs that a pass doesn't need (Cycles then skips those subtrees)."""
    saved = []
    for mat in mats:
        nt = mat.node_tree
        b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        for sn in ('Base Color', 'Roughness', 'Normal'):
            s = b.inputs[sn]
            if sn != keep and s.is_linked:
                saved.append((nt, s, s.links[0].from_socket))
                nt.links.remove(s.links[0])
    return saved


def _restore(saved):
    for nt, s, src in saved:
        nt.links.new(src, s)


def _px(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a


def bake_group(obj, name, size, *, ao_dist, bevel_r, ao_small, samples, mode='opaque', margin=None,
               double_sided=False):
    """Mask bake, then color/rough/normal(/metal/alpha) bakes; returns the final export material."""
    margin = margin if margin is not None else max(2, size // 64)
    _use_atlas(obj)
    sc = bpy.context.scene
    sc.cycles.samples = samples
    mats = [m for m in obj.data.materials]
    # 1) masks
    t0 = time.time()
    mm = mask_material(ao_dist, bevel_r, ao_small)
    saved = [s.material for s in obj.material_slots]
    for s in obj.material_slots:
        s.material = mm
    mimg = _new_img(f'{name}_mask', size, True)
    _target([mm], mimg)
    sc.cycles.samples = max(samples, 8)
    _bake(obj, 'emit', mimg, margin)
    sc.cycles.samples = samples
    mimg.pack()
    for s, m in zip(obj.material_slots, saved):
        s.material = m
    for m in mats:
        n = m.node_tree.nodes.get('__mask__')
        if n is not None:
            n.image = mimg
    print(f'   [{name}] masks {time.time() - t0:.1f}s', flush=True)
    has_metal = any(m.get('metal') for m in mats)
    keys = ['color', 'rough', 'normal'] + (['metal'] if has_metal else []) + (['alpha'] if mode != 'opaque' else [])
    imgs = {}
    for key in keys:
        t0 = time.time()
        img = _new_img(f'{name}_{key}', size, key != 'color')
        _target(mats, img)
        if key in ('color', 'metal', 'alpha'):
            iso = _isolate(mats, 'Base Color' if key == 'color' else None)
            sv = _emit_rewire(mats, key)
            _bake(obj, 'emit', img, margin)
            _emit_restore(sv)
            _restore(iso)
        elif key == 'rough':
            iso = _isolate(mats, 'Roughness')
            _bake(obj, 'rough', img, margin)
            _restore(iso)
        else:
            iso = _isolate(mats, 'Normal')
            _bake(obj, 'normal', img, margin)
            _restore(iso)
        img.pack()
        imgs[key] = img
        print(f'   [{name}] {key} {time.time() - t0:.1f}s', flush=True)
    dump = os.environ.get('DRESS_DUMP')
    if dump:
        os.makedirs(dump, exist_ok=True)
        for k, img in list(imgs.items()) + [('mask', mimg)]:
            img.filepath_raw = os.path.join(dump, f'{name}_{k}.png')
            img.file_format = 'PNG'
            img.save()
    return final_material(name, imgs, size, mode=mode, double_sided=double_sided)


def final_material(name, imgs, size, mode='opaque', double_sided=False):
    glass = mode != 'opaque'
    rough = _px(imgs['rough'])
    mr = np.ones_like(rough)
    mr[1::4] = np.clip(rough[0::4], 0.04, 1.0)
    mr[2::4] = np.clip(_px(imgs['metal'])[0::4], 0, 1) if 'metal' in imgs else 0.0
    mr_img = bpy.data.images.new(f'{name}_mr', size, size, alpha=False)
    mr_img.colorspace_settings.name = 'Non-Color'
    mr_img.pixels.foreach_set(mr)
    mr_img.pack()
    col_img = imgs['color']
    if glass:
        c = _px(imgs['color'])
        c[3::4] = np.clip(_px(imgs['alpha'])[0::4], 0, 1)
        col_img = bpy.data.images.new(f'{name}_rgba', size, size, alpha=True)
        col_img.pixels.foreach_set(c)
        col_img.alpha_mode = 'STRAIGHT'
        col_img.pack()
    else:
        c = _px(col_img)
        c[3::4] = 1.0
        col_img.pixels.foreach_set(c)
        col_img.pack()
    mat = new_material(name)
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs['BSDF'], out.inputs['Surface'])
    tc = nt.nodes.new('ShaderNodeTexImage')
    tc.image = col_img
    nt.links.new(tc.outputs['Color'], b.inputs['Base Color'])
    tm = nt.nodes.new('ShaderNodeTexImage')
    tm.image = mr_img
    sp = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(tm.outputs['Color'], sp.inputs['Color'])
    nt.links.new(sp.outputs['Green'], b.inputs['Roughness'])
    nt.links.new(sp.outputs['Blue'], b.inputs['Metallic'])
    tn = nt.nodes.new('ShaderNodeTexImage')
    tn.image = imgs['normal']
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    if mode == 'glass':
        nt.links.new(tc.outputs['Alpha'], b.inputs['Alpha'])
        b.inputs['IOR'].default_value = 1.5
        for attr, value in (('surface_render_method', 'BLENDED'), ('blend_method', 'BLEND')):
            try:
                setattr(mat, attr, value)
            except Exception:
                pass
    elif mode == 'cutout':
        rd = nt.nodes.new('ShaderNodeMath')
        rd.operation = 'ROUND'
        nt.links.new(tc.outputs['Alpha'], rd.inputs[0])
        nt.links.new(rd.outputs[0], b.inputs['Alpha'])
        try:
            mat.surface_render_method = 'DITHERED'
        except Exception:
            pass
    mat.use_backface_culling = not (double_sided or mode == 'glass')
    return mat


class Piece:
    """Collect parts, then finish(): unwrap, join, bake, export, preview."""

    def __init__(self, name, placement='floor', *, tex=512, glass_tex=256, max_tris=1500, ao=0.08, bevel=0.004,
                 ao_small=0.015, seed=1, double_sided=False, cutout_tex=None):
        C.reset()
        self.double_sided = double_sided
        self.cutout_tex = cutout_tex
        self.name = name
        self.placement = placement
        self.tex = tex
        self.glass_tex = glass_tex
        self.max_tris = max_tris
        self.ao = ao
        self.bevel = bevel
        self.ao_small = ao_small
        self.parts = []
        random.seed(seed)
        np.random.seed(seed)

    def add(self, obj, mat, *, weight=1.0, group='opaque', uv='smart', smooth=35.0, angle=66.0, flat=False):
        """group: 'opaque' | 'glass' (alpha blend) | 'cutout' (alpha mask, double sided)."""
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        for p in obj.data.polygons:
            p.use_smooth = not flat
        if not flat and smooth is not None:
            C.smooth(obj, smooth)
        if mat.get('glass') and group == 'opaque':
            group = 'glass'
        self.parts.append(dict(obj=obj, group=group, weight=weight, uv=uv, angle=angle))
        return obj

    def transform_all(self, M):
        for p in self.parts:
            p['obj'].data.transform(M)
            p['obj'].data.update()

    def _origin(self, objs, origin):
        lo, hi = bounds(objs)
        if origin is not None:
            pivot = Vector(origin)
        elif self.placement in ('floor', 'surface'):
            pivot = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
        elif self.placement == 'wall':
            pivot = Vector(((lo.x + hi.x) / 2, lo.y, (lo.z + hi.z) / 2))
        else:  # ceiling: top center
            pivot = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, hi.z))
        for o in objs:
            o.data.transform(Matrix.Translation(-pivot))
            o.data.update()

    def finish(self, *, origin=None, extras=None, previews=None, max_tris=None):
        name = f'dressing_{self.name}'
        size = min(self.tex, 256) if DRAFT else self.tex
        gsize = min(self.glass_tex, 128) if DRAFT else self.glass_tex
        samples = 4 if DRAFT else 8
        scene = bpy.context.scene
        try:
            scene.render.threads_mode = 'FIXED'
            scene.render.threads = THREADS
        except Exception:
            pass
        t0 = time.time()
        objs = [p['obj'] for p in self.parts]
        self._origin(objs, origin)
        for p in self.parts:
            t1 = time.time()
            _unwrap_part(p['obj'], p['uv'], p['weight'], p['angle'])
            if time.time() - t1 > 2:
                print(f'   unwrap {p["obj"].name}: {time.time() - t1:.1f}s', flush=True)
        groups = []
        for grp in ('opaque', 'cutout', 'glass'):
            pp = [p for p in self.parts if p['group'] == grp]
            ps = [p['obj'] for p in pp]
            if not ps:
                continue
            o = _join(ps, name if grp == 'opaque' else f'{name}_{grp}')
            _triangulate(o)
            gs = size if grp != 'glass' else gsize
            if grp == 'cutout' and self.cutout_tex:
                gs = min(self.cutout_tex, 256) if DRAFT else self.cutout_tex
            if all(p['uv'] == 'src' for p in pp):
                # already laid out in 0..1 by the builder (e.g. a glass pane): keep it
                src = o.data.uv_layers['src'].data
                atl = o.data.uv_layers['atlas'].data
                for i in range(len(atl)):
                    atl[i].uv = src[i].uv
                _use_atlas(o)
            else:
                _pack(o, gs)
            groups.append((o, grp, gs))
        tris = C.tri_count([g_[0] for g_ in groups])
        print(f'[{self.name}] {tris} tris, unwrap {time.time() - t0:.1f}s', flush=True)
        finals = []
        for o, grp, gs in groups:
            t1 = time.time()
            mat = bake_group(o, o.name, gs, ao_dist=self.ao, bevel_r=self.bevel,
                             ao_small=self.ao_small, samples=samples, mode=grp,
                             double_sided=self.double_sided or grp == 'cutout')
            o.data.materials.clear()
            o.data.materials.append(mat)
            for poly in o.data.polygons:
                poly.material_index = 0
            if 'src' in o.data.uv_layers:
                o.data.uv_layers.remove(o.data.uv_layers['src'])
            for a in ('gc',):
                if a in o.data.attributes:
                    o.data.attributes.remove(o.data.attributes[a])
            finals.append(o)
            print(f'[{self.name}] baked {o.name} in {time.time() - t1:.1f}s', flush=True)
        root = finals[0]
        for o in finals[1:]:
            o.parent = root
        for ob in list(scene.objects):
            if ob not in finals:
                bpy.data.objects.remove(ob)
        lo, hi = bounds(finals)
        d = hi - lo
        size3 = [round(d.x, 3), round(d.z, 3), round(d.y, 3)]
        root['size'] = size3
        root['placement'] = self.placement
        scene['size'] = size3
        scene['placement'] = self.placement
        for k, v in (extras or {}).items():
            root[k] = v
            scene[k] = v
        tris = C.tri_count(finals)
        mt = max_tris or self.max_tris
        print(f'[{self.name}] FINAL {tris} tris (budget {mt}), size {size3}, placement {self.placement}, '
              f'bounds lo {tuple(round(x, 3) for x in lo)} hi {tuple(round(x, 3) for x in hi)}, tex {size}', flush=True)
        if tris > mt:
            print(f'[{self.name}] WARNING over budget: {tris} > {mt}')
        C.export_glb(name, [root])
        if DO_PREVIEW:
            render_previews(name, finals, previews or {}, self.placement)
        return root


def render_previews(name, objs, opts, placement):
    ps = 16 if DRAFT else 32
    yaw = opts.get('yaw', 35)
    pitch = opts.get('pitch', 18 if placement in ('floor', 'surface') else 8)
    zoom = opts.get('zoom', 1.0)
    C.preview(f'{name}_3q', objs, yaw_deg=yaw, pitch_deg=pitch, samples=ps, zoom=zoom)
    C.preview(f'{name}_flash', objs, yaw_deg=opts.get('flash_yaw', -yaw * 0.5), pitch_deg=opts.get('flash_pitch', pitch),
              mood='flash', samples=ps, zoom=zoom)
    for extra in opts.get('extra', []):
        C.preview(f'{name}_{extra["tag"]}', objs, yaw_deg=extra.get('yaw', yaw), pitch_deg=extra.get('pitch', pitch),
                  mood=extra.get('mood', 'studio'), samples=ps, zoom=extra.get('zoom', 1.0))
