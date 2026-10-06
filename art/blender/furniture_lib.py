"""
Building blocks for MUTE's furniture set (see furniture.py for the piece list).

  * Parts:     beveled boxes, tapered/turned legs, lathe profiles, tubes, rounded "upholstered"
               boxes (low-poly + matching high-poly with wrinkles/piping/tufts/tears for baking).
  * Materials: a tiny node-graph DSL (class G) plus procedural, *aged* materials: varnished wood
               with peeling veneer, chipped paint, faded upholstery, enamel, brass, chrome...
               Every material shares one aging stack: grime in crevices (AO), worn/scuffed edges
               (bevel-normal edge mask), dust on up-facing surfaces, water tide lines, stains.
  * Pipeline:  Piece.finish() joins everything into ONE mesh with ONE material, unwraps and
               packs UVs (hidden faces get less texture space), bakes base color, roughness,
               metallic and tangent normals (hard parts from their own shaders, soft parts
               high->low), exports the GLB with glTF extras and renders review previews.

Helper module only: build() is a no-op (art/build.py calls build() on every module here).
Env knobs: FURN_Q=draft (512 px bakes, few samples) | final (default); FURN_THREADS (default 3);
FURN_PREVIEW=0 to skip preview renders.
"""

from __future__ import annotations

import math
import os
import random
import time

import bpy  # noqa: I001 (bpy must be imported before bmesh/mathutils)
import bmesh
import numpy as np
from mathutils import Euler, Matrix, Vector, noise

import common as C

QUALITY = os.environ.get('FURN_Q', 'final')
DRAFT = QUALITY == 'draft'
THREADS = int(os.environ.get('FURN_THREADS', '3'))
DO_PREVIEW = os.environ.get('FURN_PREVIEW', '1') != '0'


def build() -> None:  # helper module, nothing to export on its own
    print('furniture_lib: helper module (built through furniture.py)')


def srgb(*c):
    """sRGB 0..1 -> linear (Blender colors are linear)."""
    if len(c) == 1:
        c = c[0]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def hexc(h: str):
    h = h.lstrip('#')
    return srgb(*(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)))


# =============================================================================================
# Node DSL
# =============================================================================================

Sock = bpy.types.NodeSocket


class G:
    """Minimal shader-graph builder. Methods return output sockets; inputs take sockets or values."""

    def __init__(self, mat: bpy.types.Material, period: float | None = None):
        self.mat = mat
        self.nt = mat.node_tree
        for n in list(self.nt.nodes):
            self.nt.nodes.remove(n)
        self.out = self.nt.nodes.new('ShaderNodeOutputMaterial')
        self.bsdf = self.nt.nodes.new('ShaderNodeBsdfPrincipled')
        self.nt.links.new(self.bsdf.outputs['BSDF'], self.out.inputs['Surface'])
        self.period = period
        self._cache: dict = {}

    # -- plumbing -------------------------------------------------------------------------
    def _inp(self, n, key):
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
        raise KeyError(f'{n.bl_idname}: no input {key}')

    def _out(self, n, key):
        for s in n.outputs:
            if s.identifier == key:
                return s
        return n.outputs[key]

    def set(self, sock, v):
        if isinstance(v, Sock):
            self.nt.links.new(v, sock)
            return
        if v is None:
            return
        dv = sock.default_value
        if hasattr(dv, '__len__'):
            if isinstance(v, (int, float)):
                v = [float(v)] * len(dv)
            v = list(v)
            if len(v) < len(dv):
                v = v + [1.0] * (len(dv) - len(v))
            sock.default_value = v[:len(dv)]
        else:
            sock.default_value = float(v)

    def node(self, kind, inputs=None, **props):
        n = self.nt.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        for k, v in (inputs or {}).items():
            self.set(self._inp(n, k), v)
        return n

    # -- inputs ---------------------------------------------------------------------------
    def geo(self, key):
        n = self._cache.get('geo') or self.node('ShaderNodeNewGeometry')
        self._cache['geo'] = n
        return n.outputs[key]

    def pos(self):
        n = self._cache.get('tc') or self.node('ShaderNodeTexCoord')
        self._cache['tc'] = n
        return n.outputs['Object']

    def attr(self, name, kind='Vector'):
        key = ('attr', name)
        n = self._cache.get(key) or self.node('ShaderNodeAttribute', attribute_type='GEOMETRY', attribute_name=name)
        self._cache[key] = n
        return n.outputs[kind]

    def value(self, v):
        n = self.node('ShaderNodeValue')
        n.outputs[0].default_value = v
        return n.outputs[0]

    # -- math -----------------------------------------------------------------------------
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

    def vmax(self, a, b):
        return self.m('MAXIMUM', a, b)

    def vmin(self, a, b):
        return self.m('MINIMUM', a, b)

    def pw(self, a, b):
        return self.m('POWER', a, b)

    def v(self, op, a, b=None, scale=None):
        n = self.node('ShaderNodeVectorMath', operation=op)
        self.set(n.inputs[0], a)
        if b is not None:
            self.set(n.inputs[1], b)
        if scale is not None:
            self.set(self._inp(n, 'Scale'), scale)
        return n.outputs['Value'] if op in ('DOT_PRODUCT', 'LENGTH', 'DISTANCE') else n.outputs['Vector']

    def sep(self, vec):
        n = self.node('ShaderNodeSeparateXYZ')
        self.set(n.inputs[0], vec)
        return n.outputs['X'], n.outputs['Y'], n.outputs['Z']

    def comb(self, x, y, z):
        n = self.node('ShaderNodeCombineXYZ')
        self.set(n.inputs[0], x)
        self.set(n.inputs[1], y)
        self.set(n.inputs[2], z)
        return n.outputs[0]

    def rng(self, x, a, b, c=0.0, d=1.0, smooth=False, clamp=True):
        n = self.node('ShaderNodeMapRange', clamp=clamp,
                      interpolation_type='SMOOTHSTEP' if smooth else 'LINEAR')
        self.set(self._inp(n, 'Value'), x)
        self.set(self._inp(n, 'From Min'), a)
        self.set(self._inp(n, 'From Max'), b)
        self.set(self._inp(n, 'To Min'), c)
        self.set(self._inp(n, 'To Max'), d)
        return self._out(n, 'Result')

    def mix(self, fac, a, b, blend='MIX'):
        n = self.node('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_factor=True)
        self.set(self._inp(n, 'Factor_Float'), fac)
        self.set(self._inp(n, 'A_Color'), a)
        self.set(self._inp(n, 'B_Color'), b)
        return self._out(n, 'Result_Color')

    def mixf(self, fac, a, b):
        n = self.node('ShaderNodeMix', data_type='FLOAT', clamp_factor=True)
        self.set(self._inp(n, 'Factor_Float'), fac)
        self.set(self._inp(n, 'A_Float'), a)
        self.set(self._inp(n, 'B_Float'), b)
        return self._out(n, 'Result_Float')

    def hsv(self, col, h=0.5, s=1.0, v=1.0, fac=1.0):
        return self.node('ShaderNodeHueSaturation', {'Hue': h, 'Saturation': s, 'Value': v, 'Fac': fac, 'Color': col}).outputs[0]

    def ramp(self, fac, stops, interp='LINEAR'):
        n = self.node('ShaderNodeValToRGB')
        cr = n.color_ramp
        cr.interpolation = interp
        while len(cr.elements) > 1:
            cr.elements.remove(cr.elements[-1])
        for i, (p, c) in enumerate(stops):
            e = cr.elements[0] if i == 0 else cr.elements.new(p)
            e.position = p
            c = tuple(c) + (1.0,) * (4 - len(c))
            e.color = c
        self.set(n.inputs[0], fac)
        return n.outputs['Color']

    # -- textures (periodic in X when self.period is set, so modules tile seamlessly) ------
    def _coord(self, vec, stretch=None, offset=None):
        if vec is None:
            vec = self.pos()
        if offset is not None:
            vec = self.v('ADD', vec, offset)
        if stretch is not None:
            vec = self.v('MULTIPLY', vec, stretch)
        return vec

    def noise(self, vec=None, scale=5.0, detail=2.0, rough=0.5, dist=0.0, stretch=None, offset=None,
              periodic=True, kind='FBM', out='Fac', lac=2.0):
        use_p = self.period is not None and periodic
        vec = self._coord(vec, stretch, offset)
        n = self.node('ShaderNodeTexNoise', noise_dimensions='4D' if use_p else '3D', noise_type=kind)
        if use_p:
            # stretch is already applied to vec, so the period scales with it
            vv, w = self._periodic_scaled(vec, stretch[0] if stretch else 1.0)
            self.set(self._inp(n, 'Vector'), vv)
            self.set(self._inp(n, 'W'), w)
        else:
            self.set(self._inp(n, 'Vector'), vec)
        for k, v in (('Scale', scale), ('Detail', detail), ('Roughness', rough), ('Distortion', dist), ('Lacunarity', lac)):
            self.set(self._inp(n, k), v)
        return n.outputs[out]

    def _periodic_scaled(self, vec, sx):
        """(vector, w) for 4D noise that repeats every self.period meters along object X."""
        L = self.period * sx
        x, y, z = self.sep(vec)
        th = self.mul(x, 2 * math.pi / L)
        R = L / (2 * math.pi)
        return self.comb(self.mul(self.m('COSINE', th), R), self.mul(self.m('SINE', th), R), y), z

    def voronoi(self, vec=None, scale=5.0, feature='F1', rand=1.0, stretch=None, offset=None, out='Distance',
                periodic=True, metric='EUCLIDEAN'):
        use_p = self.period is not None and periodic
        vec = self._coord(vec, stretch, offset)
        n = self.node('ShaderNodeTexVoronoi', voronoi_dimensions='4D' if use_p else '3D', feature=feature,
                      distance=metric)
        if use_p:
            vv, w = self._periodic_scaled(vec, stretch[0] if stretch else 1.0)
            self.set(self._inp(n, 'Vector'), vv)
            self.set(self._inp(n, 'W'), w)
        else:
            self.set(self._inp(n, 'Vector'), vec)
        self.set(self._inp(n, 'Scale'), scale)
        self.set(self._inp(n, 'Randomness'), rand)
        return self._out(n, out)

    def wave(self, vec=None, scale=1.0, kind='BANDS', direction='X', dist=0.0, detail=0.0, profile='SIN', out='Fac'):
        props = dict(wave_type=kind, wave_profile=profile)
        if kind == 'BANDS':
            props['bands_direction'] = direction
        else:
            props['rings_direction'] = direction
        n = self.node('ShaderNodeTexWave', {'Vector': self._coord(vec), 'Scale': scale, 'Distortion': dist,
                                            'Detail': detail}, **props)
        return n.outputs[out]

    # -- shading helpers ------------------------------------------------------------------
    def bevel(self, radius):
        key = ('bevel', radius)
        if key not in self._cache:
            n = self.node('ShaderNodeBevel', {'Radius': radius}, samples=4)
            self._cache[key] = n.outputs['Normal']
        return self._cache[key]

    def ao(self, distance, only_local=True):
        key = ('ao', distance)
        if key not in self._cache:
            n = self.node('ShaderNodeAmbientOcclusion', {'Distance': distance}, samples=6, only_local=only_local)
            self._cache[key] = n.outputs['AO']
        return self._cache[key]

    def bump(self, height, distance=0.001, strength=1.0, normal=None):
        n = self.node('ShaderNodeBump', {'Strength': strength, 'Distance': distance, 'Height': height})
        if normal is not None:
            self.set(self._inp(n, 'Normal'), normal)
        return n.outputs['Normal']

    def finish(self, color, rough, normal=None, metal=0.0):
        self.set(self.bsdf.inputs['Base Color'], color)
        self.set(self.bsdf.inputs['Roughness'], rough)
        if normal is not None:
            self.set(self.bsdf.inputs['Normal'], normal)
        # Metallic is NOT wired into the BSDF (it would black out the diffuse-color bake); the
        # pipeline bakes it separately from this node.
        mn = self.node('ShaderNodeMath', operation='ADD', use_clamp=True)
        mn.name = '__metal__'
        self.set(mn.inputs[0], metal)
        self.set(mn.inputs[1], 0.0)
        self.bsdf.inputs['Specular IOR Level'].default_value = 0.5


def new_material(name: str):
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    return mat


# =============================================================================================
# Shared aging stack
# =============================================================================================

DUST = hexc('8a847a')
GRIME = hexc('120e0a')


# Hard-surface materials read AO / small AO / edge from a per-piece mask texture (baked once by
# Piece.finish) instead of ray-tracing them in every pass. Soft (high->low) materials stay inline.
MASK_AO, MASK_AO_SMALL, MASK_BEVEL = 0.12, 0.03, 0.006


class Masks:
    """Geometry-driven masks every material uses (cached per graph)."""

    def __init__(self, g: G, bevel_r=0.006, ao_dist=0.12, inline=False):
        self.g = g
        self.bevel_r = bevel_r
        self.ao_dist = ao_dist
        self.inline = inline
        g.mat['inline_masks'] = bool(inline)

    def _ch(self, i):
        g = self.g
        if 'maskimg' not in g._cache:
            uvn = g.node('ShaderNodeUVMap')
            n = g.node('ShaderNodeTexImage', {'Vector': uvn.outputs['UV']}, interpolation='Linear', extension='EXTEND')
            n.name = '__maskimg__'
            sp = g.node('ShaderNodeSeparateColor', {'Color': n.outputs['Color']})
            g._cache['maskimg'] = sp
        return g._cache['maskimg'].outputs[i]

    @property
    def nrm(self):
        return self.g.geo('Normal')

    def nz(self):
        return self.g.sep(self.nrm)[2]

    def up(self, lo=0.45, hi=0.92):
        return self.g.rng(self.nz(), lo, hi, smooth=True)

    def down(self):
        return self.g.rng(self.nz(), -0.4, -0.9)

    def edge(self):
        g = self.g
        if 'edge' not in g._cache:
            if self.inline:
                d = g.v('DOT_PRODUCT', g.bevel(self.bevel_r), g.geo('True Normal'))
                g._cache['edge'] = g.rng(d, 0.985, 0.80, smooth=True)
            else:
                g._cache['edge'] = self._ch(2)
        return g._cache['edge']

    def ao(self):
        return self.g.ao(self.ao_dist) if self.inline else self._ch(0)

    def ao_small(self):
        return self.g.ao(MASK_AO_SMALL) if self.inline else self._ch(1)

    def cavity(self, lo=0.45, hi=0.98):
        return self.g.rng(self.ao(), hi, lo)

    def convex(self):
        """Edge mask restricted to outside (convex) edges."""
        g = self.g
        if 'convex' not in g._cache:
            g._cache['convex'] = g.mul(self.edge(), g.rng(self.ao_small(), 0.75, 0.95))
        return g._cache['convex']

    def z(self):
        return self.g.sep(self.g.pos())[2]


def age(g: G, mk: Masks, col, rough, h, *, dust=0.6, grime=0.7, wear=0.5, wear_col=None, wear_rough=0.8,
        tide=0.0, stains=0.0, scratch=0.4, film=0.12, rings=0.0, burn=0.0, seed=0.0):
    """Common aging: grime -> edge wear -> scratches -> stains/rings -> tide line -> dust."""
    off = (seed * 13.1, seed * 7.7, seed * 3.3)
    pos = g.pos()
    # grime in crevices and corners
    if grime > 0:
        cav = g.mul(mk.cavity(), grime)
        gn = g.noise(pos, 6.0, 3, 0.6, offset=off)
        cav = g.clamp(g.mul(cav, g.rng(gn, 0.3, 0.7, 0.6, 1.3)))
        col = g.mix(cav, col, GRIME)
        rough = g.add(rough, g.mul(cav, 0.25), clamp=True)
    # convex edge wear (scuffed edges)
    if wear > 0:
        wn = g.noise(pos, 22.0, 3, 0.65, offset=off)
        wn2 = g.noise(pos, 3.0, 2, 0.5, offset=off)
        w = g.add(g.mul(mk.convex(), 1.1), g.mul(g.sub(wn, 0.5), 1.2))
        w = g.mul(g.rng(w, 0.45, 0.75, smooth=True), g.rng(wn2, 0.25, 0.65, 0.3, 1.0))
        w = g.mul(w, wear)
        if wear_col is None:
            wear_col = g.hsv(col, s=0.7, v=1.7)
        col = g.mix(w, col, wear_col)
        rough = g.mixf(w, rough, wear_rough)
        h = g.sub(h, g.mul(w, 0.25))
    # scratches: fine, randomly-oriented line networks
    if scratch > 0:
        s1 = g.voronoi(pos, 9.0, 'DISTANCE_TO_EDGE', stretch=(1.0, 14.0, 1.0), offset=off)
        s2 = g.voronoi(pos, 7.0, 'DISTANCE_TO_EDGE', stretch=(16.0, 1.0, 1.6), offset=(off[1], off[0], 2.0))
        sm = g.noise(pos, 4.0, 1, 0.5, offset=(1.7, 2.0, 0.3))
        s = g.vmax(g.rng(s1, 0.012, 0.0), g.rng(s2, 0.010, 0.0))
        s = g.mul(g.mul(s, g.rng(sm, 0.45, 0.7)), scratch)
        col = g.mix(g.mul(s, 0.45), col, g.hsv(col, s=0.6, v=1.8))
        rough = g.add(rough, g.mul(s, 0.15), clamp=True)
        h = g.sub(h, g.mul(s, 0.3))
    up = mk.up()
    # water rings left by glasses + bigger water/tea blotches (mostly on tops)
    if rings > 0:
        cell = g.voronoi(pos, 7.0, 'F1', rand=0.9, offset=(off[0], 4.0, 0))
        ring = g.mul(g.rng(cell, 0.155, 0.17, smooth=True), g.rng(cell, 0.20, 0.185, smooth=True))
        cellc = g.sep(g.voronoi(pos, 7.0, 'F1', out='Color', offset=(off[0], 4.0, 0)))[0]
        ring = g.mul(g.mul(ring, g.rng(cellc, 0.62, 0.66)), up)
        ringw = g.noise(pos, 40.0, 2, 0.5)
        ring = g.mul(g.mul(ring, g.rng(ringw, 0.3, 0.6, 0.5, 1.0)), rings)
        col = g.mix(ring, col, g.hsv(col, s=0.5, v=1.9))
        rough = g.add(rough, g.mul(ring, 0.25), clamp=True)
    if stains > 0:
        sn = g.noise(pos, 2.2, 3, 0.55, offset=(off[2], 9.0, 1.0))
        inside = g.rng(sn, 0.60, 0.64, smooth=True)
        rim = g.mul(g.rng(sn, 0.585, 0.61, smooth=True), g.rng(sn, 0.65, 0.62, smooth=True))
        col = g.mix(g.mul(inside, 0.35 * stains), col, g.hsv(col, s=0.6, v=0.65))
        col = g.mix(g.mul(rim, 0.7 * stains), col, g.hsv(col, s=0.8, v=0.45))
        rough = g.add(rough, g.mul(inside, -0.08 * stains))
    if burn > 0:
        bn = g.voronoi(pos, 3.5, 'F1', offset=(5.0, off[1], 1.0))
        bc = g.sep(g.voronoi(pos, 3.5, 'F1', out='Color', offset=(5.0, off[1], 1.0)))[1]
        b = g.mul(g.mul(g.rng(bn, 0.08, 0.03, smooth=True), g.rng(bc, 0.86, 0.88)), up)
        b = g.mul(b, burn)
        col = g.mix(b, col, hexc('1a120c'))
        h = g.sub(h, g.mul(b, 0.4))
    # flood tide line near the floor: darker swollen wood below, pale mineral line on top
    if tide > 0:
        z = mk.z()
        tz = g.add(g.mul(g.noise(pos, 3.0, 2, 0.5, stretch=(1, 1, 0.2)), 0.05), tide - 0.025)
        dz = g.sub(z, tz)
        below = g.rng(dz, 0.004, -0.02, smooth=True)
        line = g.mul(g.rng(dz, -0.006, 0.0, smooth=True), g.rng(dz, 0.006, 0.0, smooth=True))
        col = g.mix(g.mul(below, 0.55), col, g.hsv(col, s=0.55, v=0.55))
        col = g.mix(g.mul(line, 0.55), col, hexc('9b9182'))
        rough = g.add(rough, g.mul(below, 0.2), clamp=True)
    # dust: a thin film everywhere, a thick fluffy layer on up-facing surfaces
    if dust > 0:
        dn = g.noise(pos, 3.5, 3, 0.6, offset=(off[1], 2.0, 5.0))
        dfine = g.noise(pos, 60.0, 2, 0.6)
        d = g.mul(up, g.rng(dn, 0.25, 0.7, 0.35, 1.0))
        d = g.add(g.mul(d, dust), film * dust)
        d = g.mul(d, g.rng(dfine, 0.2, 0.8, 0.8, 1.1))
        d = g.clamp(d)
        col = g.mix(d, col, DUST)
        rough = g.mixf(d, rough, 0.95)
        h = g.add(h, g.mul(g.mul(up, dfine), dust * 0.1))
    return col, rough, h


def _finish(g: G, mk: Masks, col, rough, h, metal=0.0, bump_dist=0.0012):
    nrm = g.bump(h, distance=bump_dist, normal=g.bevel(mk.bevel_r))
    g.finish(col, rough, nrm, metal)


# =============================================================================================
# Materials
# =============================================================================================

def mat_wood(name, light, dark, *, finish=0.42, ring=0.006, figure=0.6, pores=0.5, dust=0.6, grime=0.7,
             wear=0.5, peel=0.0, peel_col=None, stains=0.0, rings=0.0, tide=0.0, scratch=0.4, crack=0.0,
             burn=0.0, period=None, bevel_r=0.006, raw=None, seed=0.0, tone=0.25, film=0.12, ao_dist=0.12,
             decal=None):
    """Varnished (or raw, finish~0.8) wood. Grain follows the per-part 'gc' attribute (grain = X)."""
    mat = new_material(name)
    g = G(mat, period)
    mk = Masks(g, bevel_r, ao_dist)
    gc = g.attr('gc')
    pv = g.attr('pv', 'Fac')
    # wavy growth rings: distance from the log axis (gc X) with low-frequency distortion
    d1 = g.noise(gc, 1.0, 3, 0.55, stretch=(0.35, 2.5, 2.5), periodic=False, out='Color')
    q = g.v('ADD', gc, g.v('SCALE', g.v('SUBTRACT', d1, (0.5, 0.5, 0.5)), scale=ring * 6))
    _, qy, qz = g.sep(q)
    r = g.v('LENGTH', g.comb(0.0, qy, qz))
    s = g.add(g.mul(g.m('SINE', g.mul(r, 2 * math.pi / ring)), 0.5), 0.5)
    late = g.pw(s, 3.5)
    # fine open pores, streaky along the grain
    pz = g.noise(gc, 1.0, 1, 0.5, stretch=(25.0, 900.0, 900.0), periodic=False)
    pz = g.rng(pz, 0.55, 0.75)
    # big soft figure / board-to-board tone
    fig = g.noise(gc, 1.0, 2, 0.5, stretch=(1.5, 12.0, 12.0), periodic=False)
    t = g.add(g.mul(late, 0.55 * figure), g.mul(pz, 0.35 * pores))
    t = g.add(t, g.mul(g.sub(fig, 0.5), 0.6))
    t = g.add(t, g.mul(g.sub(pv, 0.5), tone * 2))
    col = g.mix(g.clamp(t), light, dark)
    rough = g.add(finish, g.mul(pz, 0.08))
    h = g.add(g.mul(late, -0.15), g.mul(pz, -0.35 * pores))
    # varnish crazing (old finish cracking into tiny cells)
    if crack > 0:
        cr = g.voronoi(g.pos(), 70.0, 'DISTANCE_TO_EDGE', stretch=(1.0, 1.0, 1.0))
        crm = g.mul(g.rng(cr, 0.04, 0.0), g.rng(g.noise(None, 2.5, 2, 0.5), 0.45, 0.65))
        crm = g.mul(crm, crack)
        col = g.mix(g.mul(crm, 0.6), col, g.hsv(col, v=0.45))
        h = g.sub(h, g.mul(crm, 0.4))
    # peeling veneer: patches (mostly along edges) where the substrate shows through
    if peel > 0:
        pn = g.noise(None, 4.0, 4, 0.62, offset=(seed, 3.0, 1.0))
        pm = g.add(g.mul(pn, 1.0), g.mul(mk.convex(), 0.35 * peel))
        pm = g.add(pm, g.mul(mk.up(), 0.05))
        th = 0.78 - 0.18 * peel
        inner = g.rng(pm, th, th + 0.015, smooth=True)
        lip = g.mul(g.rng(pm, th - 0.03, th, smooth=True), g.rng(pm, th + 0.02, th, smooth=True))
        sub_col = peel_col or hexc('8a7254')
        sub = g.mix(g.noise(None, 40.0, 2, 0.6), sub_col, tuple(c * 0.55 for c in sub_col))
        col = g.mix(inner, col, sub)
        col = g.mix(g.mul(lip, 0.6), col, g.hsv(col, s=0.6, v=1.5))
        rough = g.mixf(inner, rough, 0.88)
        h = g.add(g.sub(h, g.mul(inner, 0.9)), g.mul(lip, 0.6))
    if decal is not None:
        col, rough, h = decal(g, col, rough, h)
    col, rough, h = age(g, mk, col, rough, h, dust=dust, grime=grime, wear=wear, wear_col=raw,
                        wear_rough=0.75, tide=tide, stains=stains, scratch=scratch, rings=rings, burn=burn,
                        seed=seed, film=film)
    _finish(g, mk, col, rough, h)
    return mat


def mat_paint(name, color, under, *, gloss=0.5, chip=0.5, layer2=None, dust=0.5, grime=0.8, tide=0.0,
              stains=0.0, scratch=0.3, rust=0.0, metal_under=0.0, period=None, bevel_r=0.006, seed=0.0,
              flake=0.5, grease=0.0, brush=0.3, film=0.12):
    """Old paint over wood/metal: chips at edges and random flakes, an older layer underneath."""
    mat = new_material(name)
    g = G(mat, period)
    mk = Masks(g, bevel_r)
    pos = g.pos()
    pv = g.attr('pv', 'Fac')
    base_n = g.noise(pos, 8.0, 3, 0.55, offset=(seed, 0, 0))
    col = g.mix(g.rng(base_n, 0.3, 0.7, 0.0, 0.25), color, tuple(c * 0.8 for c in color))
    col = g.mix(g.mul(g.sub(pv, 0.5), 0.3), col, tuple(c * 0.85 for c in color))
    # brush strokes along the part's long axis
    gc = g.attr('gc')
    br = g.noise(gc, 1.0, 2, 0.5, stretch=(4.0, 160.0, 160.0), periodic=False)
    h = g.mul(br, 0.25 * brush)
    rough = g.add(1.0 - gloss, g.mul(br, 0.05))
    # chips / flakes
    cn = g.noise(pos, 9.0, 4, 0.65, offset=(seed, 1.0, 2.0))
    cm = g.add(g.mul(mk.convex(), 0.55 * chip + 0.1), cn)
    th = 0.82 - 0.22 * chip * flake
    chip1 = g.rng(cm, th, th + 0.012)
    chip2 = g.rng(cm, th + 0.05, th + 0.06)
    lip = g.mul(g.rng(cm, th - 0.025, th), g.rng(cm, th + 0.02, th))
    if layer2 is not None:
        col = g.mix(chip1, col, layer2)
        col = g.mix(chip2, col, under)
    else:
        col = g.mix(chip1, col, under)
        chip2 = chip1
    col = g.mix(g.mul(lip, 0.5), col, g.hsv(col, v=1.25))
    rough = g.mixf(chip2, rough, 0.75)
    h = g.add(g.sub(h, g.mul(chip1, 0.6)), g.mul(lip, 0.5))
    metal = g.mul(chip2, metal_under) if metal_under else 0.0
    if rust > 0:
        rn = g.noise(pos, 14.0, 4, 0.7, offset=(2.0, seed, 0))
        halo = g.mul(g.rng(cm, th - 0.08, th), rust)
        rs = g.mul(g.add(halo, g.mul(chip2, 0.8)), g.rng(rn, 0.3, 0.6))
        # streaks running down from damage
        st = g.noise(pos, 1.0, 3, 0.6, stretch=(28.0, 28.0, 1.2), offset=(seed, 0, 0))
        st = g.mul(g.rng(st, 0.55, 0.7), rust * 0.7)
        rcol = g.mix(rn, hexc('5a2a12'), hexc('8a4a1e'))
        col = g.mix(g.clamp(rs), col, rcol)
        col = g.mix(g.mul(st, 0.45), col, rcol)
        rough = g.mixf(g.clamp(rs), rough, 0.92)
        if metal_under:
            metal = g.mul(metal, g.inv(rs))
    if grease > 0:
        gr = g.noise(pos, 5.0, 3, 0.6, offset=(seed, 5.0, 0))
        gm = g.mul(g.rng(gr, 0.5, 0.75), grease)
        col = g.mix(gm, col, hexc('5a4520'))
        rough = g.mixf(gm, rough, 0.35)
    col, rough, h = age(g, mk, col, rough, h, dust=dust, grime=grime, wear=0.0, tide=tide, stains=stains,
                        scratch=scratch, seed=seed, film=film)
    _finish(g, mk, col, rough, h, metal)
    return mat


def mat_fabric(name, base, alt=None, *, pattern='tweed', fade=0.4, stains=0.5, dust=0.45, grime=0.9,
               wear=0.5, bevel_r=0.01, seed=0.0, weave=1.0, stripe=None, sheen=0.0, ao_dist=0.15,
               foam=None, mold=0.0, rust_spots=0.0, tide=0.0):
    """Upholstery / bedding. Reads optional 'tear' attribute (1 = hole showing foam)."""
    mat = new_material(name)
    g = G(mat)
    mk = Masks(g, bevel_r, ao_dist, inline=True)
    pos = g.pos()
    alt = alt or tuple(c * 0.7 for c in base)
    off = (seed, seed * 2, 1.0)
    # yarn flecks + slubs
    fl = g.noise(pos, 140.0, 2, 0.6, offset=off)
    sl = g.noise(pos, 1.0, 2, 0.5, stretch=(30.0, 30.0, 6.0), offset=off)
    t = g.add(g.mul(g.rng(fl, 0.45, 0.7), 0.6), g.mul(g.rng(sl, 0.4, 0.75), 0.4))
    col = g.mix(t, base, alt)
    if stripe is not None:  # (color, period_m, duty, axis) ticking stripes
        scol, per, duty = stripe[:3]
        axis = stripe[3] if len(stripe) > 3 else 'X'
        x, y, z = g.sep(pos)
        coord = {'X': x, 'Y': y, 'Z': z}[axis]
        sv = g.m('FRACT', g.mul(coord, 1.0 / per))
        sm = g.mul(g.rng(sv, 0.0, 0.02), g.rng(sv, duty, duty - 0.02))
        sm2 = g.mul(g.rng(sv, duty + 0.12, duty + 0.13), g.rng(sv, duty + 0.18, duty + 0.17))
        col = g.mix(g.clamp(g.add(sm, sm2)), col, scol)
    lv = g.noise(pos, 5.0, 2, 0.5, offset=off)
    col = g.mix(g.mul(g.rng(lv, 0.3, 0.7), 0.25), col, tuple(c * 0.75 for c in base))
    # weave relief
    x, y, z = g.sep(pos)
    k = 2 * math.pi / 0.0035
    wv = g.add(g.add(g.m('SINE', g.mul(x, k)), g.m('SINE', g.mul(y, k))), g.m('SINE', g.mul(z, k)))
    h = g.add(g.mul(wv, 0.08 * weave), g.mul(fl, 0.4))
    rough = g.add(0.86, g.mul(fl, 0.08))
    # sun fade on up-facing areas + worn/threadbare convex areas
    up = mk.up(0.2, 0.9)
    fn = g.noise(pos, 1.5, 2, 0.5, offset=off)
    col = g.mix(g.mul(g.mul(up, fade), g.rng(fn, 0.2, 0.8, 0.6, 1.0)), col, g.hsv(col, s=0.45, v=1.45))
    if wear > 0:
        wn = g.noise(pos, 12.0, 3, 0.6, offset=off)
        w = g.mul(g.rng(g.add(g.mul(mk.edge(), 0.9), g.mul(wn, 0.6)), 0.55, 0.95), wear)
        col = g.mix(w, col, g.hsv(col, s=0.5, v=1.6))
        h = g.sub(h, g.mul(w, 0.2))
    if stains > 0:
        sn = g.noise(pos, 2.4, 3, 0.55, offset=(seed + 3, 1, 2))
        inside = g.rng(sn, 0.6, 0.63, smooth=True)
        rim = g.mul(g.rng(sn, 0.585, 0.605, smooth=True), g.rng(sn, 0.65, 0.625, smooth=True))
        col = g.mix(g.mul(inside, 0.45 * stains), col, g.mix(0.5, g.hsv(col, v=0.6), hexc('5a4628')))
        col = g.mix(g.mul(rim, 0.8 * stains), col, hexc('3a2a16'))
        sn2 = g.noise(pos, 6.0, 3, 0.55, offset=(seed + 7, 4, 1))
        small = g.mul(g.rng(sn2, 0.68, 0.7, smooth=True), stains)
        col = g.mix(g.mul(small, 0.6), col, hexc('2c2014'))
    if mold > 0:
        mn = g.noise(pos, 1.5, 2, 0.5, offset=(seed, 8, 8))
        sp = g.voronoi(pos, 180.0, 'F1')
        cl = g.mul(g.rng(mn, 0.55, 0.7), g.rng(sp, 0.25, 0.1))
        col = g.mix(g.mul(cl, mold), col, hexc('1c2116'))
    if rust_spots > 0:
        rp = g.voronoi(pos, 9.0, 'F1', rand=1.0, offset=(seed, 2, 0))
        rc = g.sep(g.voronoi(pos, 9.0, 'F1', out='Color', offset=(seed, 2, 0)))[0]
        rm = g.mul(g.mul(g.rng(rp, 0.12, 0.03, smooth=True), g.rng(rc, 0.7, 0.72)), rust_spots)
        col = g.mix(rm, col, hexc('6b3a18'))
    if tide > 0:
        z = mk.z()
        tz = g.add(g.mul(g.noise(pos, 3.0, 2, 0.5), 0.05), tide)
        below = g.rng(g.sub(z, tz), 0.005, -0.02, smooth=True)
        col = g.mix(g.mul(below, 0.5), col, g.hsv(col, s=0.6, v=0.5))
    # tears: foam + dark cavity, frayed light threads at the rim
    tear = g.attr('tear', 'Fac')
    foam_c = foam or hexc('b39a5e')
    fo = g.noise(pos, 90.0, 3, 0.7)
    foam_col = g.mix(g.rng(fo, 0.3, 0.75), tuple(c * 0.45 for c in foam_c), foam_c)
    inner = g.rng(tear, 0.62, 0.8)
    rimm = g.mul(g.rng(tear, 0.15, 0.4), g.rng(tear, 0.7, 0.55))
    col = g.mix(g.mul(rimm, g.rng(g.noise(pos, 300.0, 1, 0.5), 0.3, 0.7)), col, g.hsv(col, s=0.4, v=1.9))
    col = g.mix(inner, col, foam_col)
    rough = g.mixf(inner, rough, 0.97)
    h = g.add(h, g.mul(inner, g.mul(fo, 1.5)))
    col, rough, h = age(g, mk, col, rough, h, dust=dust, grime=grime, wear=0.0, scratch=0.0, seed=seed,
                        film=0.1)
    _finish(g, mk, col, rough, h, bump_dist=0.0015)
    return mat


def mat_metal(name, color, *, rough=0.45, metal=0.9, tarnish=0.5, tarnish_col=None, rust=0.0, dust=0.4,
              grime=0.9, bevel_r=0.003, seed=0.0, pitting=0.3, brushed=0.0):
    mat = new_material(name)
    g = G(mat)
    mk = Masks(g, bevel_r, 0.05)
    pos = g.pos()
    tn = g.noise(pos, 7.0, 4, 0.6, offset=(seed, 0, 0))
    tcol = tarnish_col or tuple(c * 0.35 for c in color)
    tm = g.mul(g.add(g.rng(tn, 0.3, 0.75), g.mul(mk.cavity(0.6, 1.0), 0.6)), tarnish)
    tm = g.clamp(g.sub(tm, g.mul(mk.convex(), 0.8)))  # rubbed bright on edges
    col = g.mix(tm, color, tcol)
    r = g.mixf(tm, rough, min(1.0, rough + 0.3))
    h = g.mul(tn, 0.1)
    met = g.mixf(tm, metal, metal * 0.7)
    if brushed > 0:
        b = g.noise(g.attr('gc'), 1.0, 1, 0.5, stretch=(5.0, 600.0, 600.0), periodic=False)
        h = g.add(h, g.mul(b, 0.2 * brushed))
        r = g.add(r, g.mul(b, 0.08 * brushed))
    if pitting > 0:
        pt = g.voronoi(pos, 120.0, 'F1', offset=(seed, 1, 0))
        pm = g.mul(g.rng(pt, 0.2, 0.05), g.rng(g.noise(pos, 4.0, 2, 0.5), 0.45, 0.7))
        pm = g.mul(pm, pitting)
        col = g.mix(pm, col, hexc('3a2414'))
        r = g.mixf(pm, r, 0.85)
        met = g.mixf(pm, met, 0.1)
        h = g.sub(h, g.mul(pm, 0.4))
    if rust > 0:
        rn = g.noise(pos, 6.0, 4, 0.65, offset=(seed, 3, 3))
        rm = g.mul(g.rng(g.add(rn, g.mul(mk.cavity(), 0.4)), 0.55, 0.72), rust)
        rcol = g.mix(g.noise(pos, 40.0, 2, 0.6), hexc('4a220e'), hexc('8a4a20'))
        col = g.mix(rm, col, rcol)
        r = g.mixf(rm, r, 0.92)
        met = g.mixf(rm, met, 0.05)
        h = g.add(h, g.mul(rm, g.noise(pos, 60.0, 2, 0.6)))
    col, r, h = age(g, mk, col, r, h, dust=dust, grime=grime, wear=0.0, scratch=0.2, seed=seed, film=0.08)
    _finish(g, mk, col, r, h, met, bump_dist=0.0006)
    return mat


def mat_enamel(name, color, *, chip=0.5, grime=0.8, rust=0.6, grease=0.5, dust=0.5, gloss=0.8,
               bevel_r=0.006, seed=0.0, period=None, crazing=0.3):
    """Vitreous enamel / porcelain: glossy, yellowed, chipped to black iron with rust halos."""
    mat = new_material(name)
    g = G(mat, period)
    mk = Masks(g, bevel_r, 0.1)
    pos = g.pos()
    yn = g.noise(pos, 2.0, 3, 0.5, offset=(seed, 0, 0))
    col = g.mix(g.rng(yn, 0.3, 0.8, 0.0, 0.5), color, g.mix(0.5, color, hexc('a08a55')))
    rough = g.add(1.0 - gloss, g.mul(yn, 0.08))
    h = g.mul(yn, 0.05)
    if crazing > 0:
        cr = g.voronoi(pos, 45.0, 'DISTANCE_TO_EDGE')
        crm = g.mul(g.mul(g.rng(cr, 0.03, 0.0), g.rng(g.noise(pos, 2.0, 2, 0.5), 0.45, 0.7)), crazing)
        col = g.mix(crm, col, hexc('6a5a3c'))
    cn = g.noise(pos, 11.0, 4, 0.65, offset=(seed, 2, 1))
    cm = g.add(g.mul(mk.convex(), 0.6 * chip + 0.1), g.mul(cn, 0.95))
    th = 0.86 - 0.2 * chip
    ch = g.rng(cm, th, th + 0.01)
    halo = g.mul(g.rng(cm, th - 0.06, th), g.inv(ch))
    iron = g.mix(g.noise(pos, 60.0, 2, 0.5), hexc('15120f'), hexc('2b1a10'))
    col = g.mix(ch, col, iron)
    rcol = g.mix(g.noise(pos, 30.0, 2, 0.6), hexc('5a2a10'), hexc('9a5a24'))
    col = g.mix(g.mul(halo, rust), col, rcol)
    rough = g.mixf(ch, rough, 0.8)
    rough = g.mixf(g.mul(halo, rust), rough, 0.7)
    h = g.sub(h, g.mul(ch, 0.8))
    if rust > 0:
        st = g.noise(pos, 1.0, 3, 0.6, stretch=(30.0, 30.0, 1.4), offset=(seed, 5, 0))
        st = g.mul(g.mul(g.rng(st, 0.58, 0.72), rust), g.rng(mk.nz(), 0.6, 0.2))
        col = g.mix(g.mul(st, 0.55), col, rcol)
        rough = g.mixf(st, rough, 0.6)
    if grease > 0:
        gn = g.noise(pos, 3.0, 4, 0.6, offset=(seed, 1, 9))
        gm = g.mul(g.add(g.rng(gn, 0.45, 0.75), g.mul(mk.cavity(), 0.6)), grease)
        col = g.mix(g.clamp(gm), col, hexc('4a3a1c'))
        rough = g.mixf(g.clamp(gm), rough, 0.55)
    col, rough, h = age(g, mk, col, rough, h, dust=dust, grime=grime, wear=0.0, scratch=0.25, seed=seed,
                        film=0.1)
    _finish(g, mk, col, rough, h, bump_dist=0.0008)
    return mat


def mat_laminate(name, color, specks, *, period=None, dust=0.5, grime=0.8, stains=0.5, burn=0.5,
                 chip=0.4, seed=0.0, substrate=None):
    """1950s speckled laminate countertop (periodic in X when `period` is set)."""
    mat = new_material(name)
    g = G(mat, period)
    mk = Masks(g, 0.004, 0.08)
    pos = g.pos()
    col = color
    for i, sc in enumerate(specks):
        sp = g.voronoi(pos, 70.0 + 23 * i, 'F1', rand=1.0, offset=(i * 3.1, i * 1.7, 0))
        spc = g.sep(g.voronoi(pos, 70.0 + 23 * i, 'F1', out='Color', offset=(i * 3.1, i * 1.7, 0)))[2]
        m = g.mul(g.rng(sp, 0.22, 0.12), g.rng(spc, 0.55, 0.6))
        col = g.mix(m, col, sc)
    yn = g.noise(pos, 2.0, 3, 0.5)
    col = g.mix(g.rng(yn, 0.3, 0.8, 0.0, 0.35), col, g.hsv(col, s=0.6, v=0.7))
    rough = g.add(0.3, g.mul(yn, 0.1))
    h = g.mul(yn, 0.05)
    # front-edge chips show brown particleboard
    cn = g.noise(pos, 14.0, 4, 0.65, offset=(seed, 2, 2))
    cm = g.add(g.mul(mk.convex(), 0.7 * chip), g.mul(cn, 0.9))
    ch = g.rng(cm, 0.85 - 0.15 * chip, 0.86 - 0.15 * chip)
    sub = substrate or hexc('6e5434')
    col = g.mix(ch, col, g.mix(g.noise(pos, 80.0, 2, 0.6), tuple(c * 0.5 for c in sub), sub))
    rough = g.mixf(ch, rough, 0.9)
    h = g.sub(h, g.mul(ch, 0.8))
    # knife scratches
    s1 = g.voronoi(pos, 5.0, 'DISTANCE_TO_EDGE', stretch=(1.0, 24.0, 1.0))
    s = g.mul(g.rng(s1, 0.01, 0.0), g.rng(g.noise(pos, 3.0, 1, 0.5, offset=(4, 0, 0)), 0.4, 0.65))
    col = g.mix(g.mul(s, 0.5), col, g.hsv(col, s=0.4, v=1.4))
    rough = g.add(rough, g.mul(s, 0.2), clamp=True)
    col, rough, h = age(g, mk, col, rough, h, dust=dust, grime=grime, wear=0.0, scratch=0.0, stains=stains,
                        burn=burn, seed=seed, film=0.1)
    _finish(g, mk, col, rough, h, bump_dist=0.0006)
    return mat


def mat_glass(name, tint=(0.02, 0.025, 0.02), *, dust=0.8, grime=0.6, seed=0.0):
    """Opaque 'dusty glass': near-black glossy with a grimy film, streaks and corners caked."""
    mat = new_material(name)
    g = G(mat)
    mk = Masks(g, 0.003, 0.08)
    pos = g.pos()
    fn = g.noise(pos, 3.0, 4, 0.6, offset=(seed, 0, 0))
    st = g.noise(pos, 1.0, 3, 0.6, stretch=(30.0, 30.0, 1.5), offset=(seed, 1, 0))
    film = g.clamp(g.add(g.mul(g.rng(fn, 0.3, 0.75), 0.55), g.mul(g.rng(st, 0.5, 0.7), 0.3)))
    film = g.mul(film, dust)
    col = g.mix(film, tint, hexc('4a4740'))
    rough = g.mixf(film, 0.04, 0.75)
    col = g.mix(g.mul(mk.cavity(0.5, 0.95), grime), col, hexc('2a241c'))
    h = g.mul(film, 0.1)
    g.finish(col, rough, g.bump(h, distance=0.0004), 0.0)
    return mat


def mat_plain(name, color, rough=0.8, *, dust=0.4, grime=0.8, noise_amt=0.2, seed=0.0, metal=0.0,
              wear=0.0, period=None, bevel_r=0.005, inline=False):
    """Generic matte material (felt, rubber, paper, cardboard...) with the aging stack."""
    mat = new_material(name)
    g = G(mat, period)
    mk = Masks(g, bevel_r, 0.1, inline=inline)
    pos = g.pos()
    n = g.noise(pos, 12.0, 3, 0.6, offset=(seed, 0, 0))
    col = g.mix(g.mul(g.rng(n, 0.3, 0.7), noise_amt), color, tuple(c * 0.6 for c in color))
    h = g.mul(n, 0.3)
    col, r, h = age(g, mk, col, rough, h, dust=dust, grime=grime, wear=wear, scratch=0.0, seed=seed, film=0.1)
    _finish(g, mk, col, r, h, metal)
    return mat


# =============================================================================================
# Geometry
# =============================================================================================

_DIRS = {'+x': Vector((1, 0, 0)), '-x': Vector((-1, 0, 0)), '+y': Vector((0, 1, 0)), '-y': Vector((0, -1, 0)),
         '+z': Vector((0, 0, 1)), '-z': Vector((0, 0, -1))}


def _link(name: str, bm: bmesh.types.BMesh) -> bpy.types.Object:
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _xf(loc=(0, 0, 0), rot=(0, 0, 0), pivot=None):
    m = Matrix.Translation(Vector(loc)) @ Euler([math.radians(a) for a in rot], 'XYZ').to_matrix().to_4x4()
    if pivot is not None:
        p = Vector(pivot)
        m = Matrix.Translation(p) @ m @ Matrix.Translation(-p)
    return m


class Piece:
    """Collects the parts of one furniture GLB, then bakes + exports it (finish)."""

    def __init__(self, name: str, seed: int = 1):
        C.reset()
        sc = bpy.context.scene
        sc.render.threads_mode = 'FIXED'
        sc.render.threads = THREADS
        self.name = name
        self.rng = random.Random(seed)
        self.hard: list[bpy.types.Object] = []
        self.groups: list[dict] = []  # soft/decal groups: {'low': [...], 'high': [...], 'ext': m}
        self._n = 0

    # -- attribute stamping (local part frame) ------------------------------------------------
    def _stamp(self, obj, grain='x', pv=None, offset=None):
        me = obj.data
        n = len(me.vertices)
        co = np.empty(n * 3, dtype=np.float32)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        lo, hi = co.min(0), co.max(0)
        lp = (co - lo) / np.maximum(hi - lo, 1e-6)
        perm = {'x': [0, 1, 2], 'y': [1, 0, 2], 'z': [2, 0, 1]}[grain]
        if offset is None:
            r = self.rng
            offset = (r.uniform(-50, 50), r.choice((-1, 1)) * r.uniform(0.04, 0.35), r.choice((-1, 1)) * r.uniform(0.04, 0.35))
        gc = co[:, perm]
        # tilt the log axis a little against the board so rings sweep across it (cathedral figure)
        tilt = self.rng.uniform(0.015, 0.06) * self.rng.choice((-1, 1))
        tilt2 = self.rng.uniform(-0.02, 0.02)
        gc = gc + np.stack([np.zeros(len(gc)), gc[:, 0] * tilt2, gc[:, 0] * tilt], 1)
        gc = gc + np.array(offset, dtype=np.float32)
        if pv is None:
            pv = self.rng.random()
        for nm, typ, data, key in (('gc', 'FLOAT_VECTOR', gc, 'vector'), ('lp', 'FLOAT_VECTOR', lp, 'vector')):
            a = me.attributes.get(nm) or me.attributes.new(nm, typ, 'POINT')
            a.data.foreach_set(key, data.astype(np.float32).ravel())
        a = me.attributes.get('pv') or me.attributes.new('pv', 'FLOAT', 'POINT')
        a.data.foreach_set('value', np.full(n, pv, dtype=np.float32))
        if 'tear' not in me.attributes:
            me.attributes.new('tear', 'FLOAT', 'POINT')
        return offset, pv

    def _mats(self, obj, mats, local_normals=None):
        """mats: a Material or {'default': M, '+z': M2, ...} keyed by local face direction."""
        if not isinstance(mats, dict):
            mats = {'default': mats}
        order = []
        for m in mats.values():
            if m not in order:
                order.append(m)
        for m in order:
            obj.data.materials.append(m)
        if len(order) > 1:
            dirs = [(k, _DIRS[k]) for k in mats if k in _DIRS]
            for p in obj.data.polygons:
                idx = order.index(mats['default'])
                for k, d in dirs:
                    if p.normal.dot(d) > 0.9:
                        idx = order.index(mats[k])
                p.material_index = idx

    def _place(self, obj, loc, rot, pivot=None):
        obj.data.transform(_xf(loc, rot, pivot))
        obj.data.update()

    def add(self, obj):
        self.hard.append(obj)
        return obj

    def _name(self, base):
        self._n += 1
        return f'{base}_{self._n}'

    # -- primitives -------------------------------------------------------------------------
    def box(self, size, loc=(0, 0, 0), mat=None, *, rot=(0, 0, 0), bevel=0.004, segs=1, skip=(), grain='x',
            taper=None, pivot=None, origin='center', pv=None, shear=None, name='box', hard=True, gc_offset=None):
        """Beveled box. size=(x,y,z) meters; origin 'center' or 'bottom' (loc = bottom center).
        taper=(sx, sy) scales the bottom face (legs); shear=(dx, dy) offsets the top face."""
        w, d, h = size
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            x, y, z = v.co.x * w, v.co.y * d, v.co.z * h
            if taper and v.co.z < 0:
                x *= taper[0]
                y *= taper[1]
            if shear and v.co.z > 0:
                x += shear[0]
                y += shear[1]
            if origin == 'bottom':
                z += h / 2
            v.co = Vector((x, y, z))
        if bevel > 0:
            b = min(bevel, w * 0.45, d * 0.45, h * 0.45)
            bmesh.ops.bevel(bm, geom=list(bm.edges) + list(bm.verts), offset=b, segments=segs, profile=0.5,
                            affect='EDGES', clamp_overlap=True)
        if skip:
            bm.normal_update()
            kill = [f for f in bm.faces if any(f.normal.dot(_DIRS[s]) > 0.99 for s in skip)]
            bmesh.ops.delete(bm, geom=kill, context='FACES')
        obj = _link(self._name(name), bm)
        self._stamp(obj, grain, pv, gc_offset)
        if mat is not None:
            self._mats(obj, mat)
        self._place(obj, loc, rot, pivot)
        return self.add(obj) if hard else obj

    def lathe(self, profile, loc=(0, 0, 0), mat=None, *, segs=8, rot=(0, 0, 0), cap_top=True, cap_bot=False,
              name='lathe', pv=None, hard=True, smooth_all=True, phase=0.0):
        """Surface of revolution around local Z. profile = [(radius, z), ...] bottom to top."""
        bm = bmesh.new()
        rings = []
        for r, z in profile:
            ring = []
            for i in range(segs):
                a = 2 * math.pi * (i + phase) / segs
                ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a), z)))
            rings.append(ring)
        for a, b in zip(rings, rings[1:]):
            for i in range(segs):
                j = (i + 1) % segs
                bm.faces.new((a[i], a[j], b[j], b[i]))
        if cap_top and profile[-1][0] > 1e-5:
            bm.faces.new(rings[-1])
        if cap_bot and profile[0][0] > 1e-5:
            bm.faces.new(list(reversed(rings[0])))
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
        bm.normal_update()  # winding is outward by construction (profile bottom -> top)
        obj = _link(self._name(name), bm)
        self._stamp(obj, 'z', pv)
        if mat is not None:
            self._mats(obj, mat)
        self._place(obj, loc, rot)
        return self.add(obj) if hard else obj

    def cyl(self, r, h, loc=(0, 0, 0), mat=None, *, segs=8, rot=(0, 0, 0), r2=None, caps=(True, True),
            bevel=0.0, name='cyl', pv=None, hard=True):
        """Cylinder (or cone with r2) standing on loc (local base at z=0), axis = local Z."""
        r2 = r if r2 is None else r2
        prof = [(r, 0.0)]
        if bevel > 0:
            prof = [(r - bevel, 0.0), (r, bevel), (r2, h - bevel), (r2 - bevel, h)]
        else:
            prof = [(r, 0.0), (r2, h)]
        return self.lathe(prof, loc, mat, segs=segs, rot=rot, cap_top=caps[1], cap_bot=caps[0], name=name, pv=pv,
                          hard=hard)

    def tube(self, pts, r, mat=None, *, segs=8, name='tube', pv=None, hard=True, caps=(True, True)):
        """Swept circle along a polyline (pts in world space). Rings are mitered at corners."""
        pts = [Vector(p) for p in pts]
        bm = bmesh.new()
        rings = []
        up_ref = Vector((0, 0, 1))
        for i, p in enumerate(pts):
            if i == 0:
                t = (pts[1] - pts[0]).normalized()
            elif i == len(pts) - 1:
                t = (pts[-1] - pts[-2]).normalized()
            else:
                t = ((pts[i] - pts[i - 1]).normalized() + (pts[i + 1] - pts[i]).normalized()).normalized()
            ref = up_ref if abs(t.dot(up_ref)) < 0.9 else Vector((1, 0, 0))
            u = t.cross(ref).normalized()
            v = t.cross(u).normalized()
            scale = 1.0
            if 0 < i < len(pts) - 1:
                a = (pts[i] - pts[i - 1]).normalized()
                scale = 1.0 / max(0.5, math.sqrt((1 + a.dot((pts[i + 1] - pts[i]).normalized())) / 2))
            ring = []
            for k in range(segs):
                ang = 2 * math.pi * k / segs
                off = (u * math.cos(ang) + v * math.sin(ang)) * r
                # stretch only along the miter direction
                if scale != 1.0:
                    md = (pts[i + 1] - pts[i]).normalized() - (pts[i] - pts[i - 1]).normalized()
                    if md.length > 1e-6:
                        md.normalize()
                        off = off + md * off.dot(md) * (scale - 1.0)
                ring.append(bm.verts.new(p + off))
            rings.append(ring)
            up_ref = v
        for a, b in zip(rings, rings[1:]):
            for k in range(segs):
                j = (k + 1) % segs
                bm.faces.new((a[k], a[j], b[j], b[k]))
        if caps[0]:
            bm.faces.new(list(reversed(rings[0])))
        if caps[1]:
            bm.faces.new(rings[-1])
        bm.normal_update()  # outward by construction
        obj = _link(self._name(name), bm)
        self._stamp(obj, 'x', pv)
        if mat is not None:
            self._mats(obj, mat)
        return self.add(obj) if hard else obj

    def mesh(self, verts, faces, loc=(0, 0, 0), mat=None, *, rot=(0, 0, 0), name='mesh', grain='x', pv=None,
             hard=True, bevel=0.0):
        bm = bmesh.new()
        vs = [bm.verts.new(v) for v in verts]
        for f in faces:
            bm.faces.new([vs[i] for i in f])
        bm.normal_update()
        if bevel > 0:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=1, profile=0.5, affect='EDGES',
                            clamp_overlap=True)
        obj = _link(self._name(name), bm)
        self._stamp(obj, grain, pv)
        if mat is not None:
            self._mats(obj, mat)
        self._place(obj, loc, rot)
        return self.add(obj) if hard else obj

    def prism(self, outline, depth, loc=(0, 0, 0), mat=None, *, rot=(0, 0, 0), bevel=0.003, name='prism',
              grain='x', pv=None, hard=True):
        """Extrude a 2D outline (XZ plane, CCW seen from +Y) by `depth` along Y (centered)."""
        bm = bmesh.new()
        front = [bm.verts.new((x, depth / 2, z)) for x, z in outline]
        back = [bm.verts.new((x, -depth / 2, z)) for x, z in outline]
        bm.faces.new(front)
        bm.faces.new(list(reversed(back)))
        n = len(outline)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((front[j], front[i], back[i], back[j]))
        bm.normal_update()
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        if bevel > 0:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=1, profile=0.5, affect='EDGES',
                            clamp_overlap=True)
        obj = _link(self._name(name), bm)
        self._stamp(obj, grain, pv)
        if mat is not None:
            self._mats(obj, mat)
        self._place(obj, loc, rot)
        return self.add(obj) if hard else obj

    def text(self, body, size, loc, mat, *, rot=(90, 0, 0), extrude=0.0004, align='CENTER', pv=None,
             gc_offset=None, font_bold=False):
        """Flat text mesh (for stencils/decals; meant for a decal bake group, not exported)."""
        cu = bpy.data.curves.new(self._name('txt'), 'FONT')
        cu.body = body
        cu.size = size
        cu.align_x = align
        cu.align_y = 'CENTER'
        cu.extrude = extrude
        ob = bpy.data.objects.new(cu.name, cu)
        bpy.context.scene.collection.objects.link(ob)
        deps = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(deps))
        bpy.data.objects.remove(ob)
        obj = bpy.data.objects.new(cu.name + '_m', me)
        bpy.context.scene.collection.objects.link(obj)
        self._stamp(obj, 'x', pv, gc_offset)
        obj.data.materials.append(mat)
        self._place(obj, loc, rot)
        return obj

    # -- soft (upholstered) parts -------------------------------------------------------------
    def soft(self, low, high, ext=0.025):
        """Register a low/high pair; highs are baked onto lows (selected-to-active)."""
        for grp in self.groups:
            if abs(grp['ext'] - ext) < 1e-6:
                grp['low'].append(low)
                grp['high'].append(high)
                return low
        self.groups.append({'low': [low], 'high': [high], 'ext': ext})
        return low

    def cushion(self, size, loc=(0, 0, 0), mat=None, *, rot=(0, 0, 0), radius=0.04, bulge=(0.01, 0.01, 0.02),
                sag=None, dents=(), wrinkle=0.006, piping=0.004, tufts=(), tears=(), lowres=(1, 2, 1),
                skip_bottom=False, crease=0.0, seed=0, name='cushion', pv=None, ext=0.025, flat_bottom=False,
                squash=None):
        """
        Upholstered rounded box. Returns the LOW object (the high one is registered for baking).
          sag:    (depth, sx, sy) broad dip of the top face (sx/sy as fractions of width/depth)
          dents:  [(x, y, depth, radius)] local seat dents (body impressions)
          tufts:  [(x, y)] button tufts on top (local, meters)
          tears:  [(x, y, radius)] holes in the top showing foam
          lowres: interior grid lines (x, y, z) of the low-poly
          squash: (axis_frac, amount) – lean/slump: shifts the top toward +Y by amount*h
        """
        w, d, h = size
        rr = min(radius, w / 2, d / 2, h / 2) * 0.999
        rng = random.Random(seed * 7919 + 17)
        nseed = Vector((rng.uniform(-100, 100), rng.uniform(-100, 100), rng.uniform(-100, 100)))

        def shape(p: Vector, n: Vector) -> Vector:
            u, v, s = p.x / (w / 2), p.y / (d / 2), p.z / (h / 2)
            fu, fv, fs = max(0.0, 1 - u * u), max(0.0, 1 - v * v), max(0.0, 1 - s * s)
            q = p.copy()
            q.z += bulge[2] * fu * fv * s * (0.25 if (flat_bottom and s < 0) else 1.0)
            q.x += bulge[0] * fv * fs * u
            q.y += bulge[1] * fu * fs * v
            top = (s + 1) / 2
            if sag:
                dep, sx, sy = sag
                f = math.exp(-((p.x / (w * sx)) ** 2 + (p.y / (d * sy)) ** 2))
                q.z -= dep * f * top
            for (dx, dy, dep, rad) in dents:
                f = math.exp(-(((p.x - dx) ** 2 + (p.y - dy) ** 2) / (rad * rad)))
                q.z -= dep * f * top
                # material pushed outward a little around the dent
            if squash:
                q.y += squash * (s + 1) / 2 * h
            return q

        def detail(p: Vector, q: Vector, n: Vector):
            """High-only displacement along n + tear mask."""
            disp = 0.0
            tear = 0.0
            # wrinkles: ridged noise, stronger toward edges and in dents
            u, v, s = p.x / (w / 2), p.y / (d / 2), p.z / (h / 2)
            edge_f = max(abs(u), abs(v), abs(s)) ** 2
            pp = p * 9.0 + nseed
            rn = 1.0 - abs(noise.noise(pp))
            rn2 = 1.0 - abs(noise.noise(p * 23.0 + nseed * 1.3))
            disp += wrinkle * ((rn ** 6) * (0.4 + 1.2 * edge_f) + 0.35 * rn2 ** 8 - 0.25)
            disp += wrinkle * 0.6 * noise.noise(p * 4.0 + nseed)
            for (dx, dy, dep, rad) in dents:
                rd = math.hypot(p.x - dx, p.y - dy)
                if s > 0 and rd < rad * 1.8:
                    ang = math.atan2(p.y - dy, p.x - dx)
                    rad_w = (1.0 - abs(math.sin(ang * 7 + noise.noise(p * 3.0 + nseed) * 3))) ** 8
                    disp += wrinkle * 1.5 * rad_w * math.exp(-((rd - rad * 0.9) / (rad * 0.5)) ** 2)
            # piping welt along the top/bottom perimeter (where the top panel meets the boxing)
            if piping > 0:
                hor = math.hypot(n.x, n.y)
                if hor > 0.05 and abs(n.z) > 0.05:
                    phi = math.degrees(math.atan2(abs(n.z), hor))
                    disp += piping * math.exp(-((phi - 45.0) / 7.0) ** 2)
                    disp -= piping * 0.5 * math.exp(-((phi - 33.0) / 6.0) ** 2)
                    disp -= piping * 0.5 * math.exp(-((phi - 57.0) / 6.0) ** 2)
            # crease lines on the boxing (vertical corner seams)
            if crease > 0 and abs(n.z) < 0.6:
                hx, hy = abs(n.x), abs(n.y)
                if hx > 0.05 and hy > 0.05:
                    disp -= crease * math.exp(-((math.degrees(math.atan2(hy, hx)) - 45) / 8) ** 2)
            # button tufts with pleats toward neighbours
            if s > 0.2:
                for (tx, ty) in tufts:
                    rd2 = (p.x - tx) ** 2 + (p.y - ty) ** 2
                    disp -= 0.022 * math.exp(-rd2 / (0.022 ** 2)) + 0.008 * math.exp(-rd2 / (0.06 ** 2))
            for (tx, ty, tr) in tears:
                if s > 0.3:
                    rd = math.hypot(p.x - tx, p.y - ty)
                    ragged = tr * (1.0 + 0.35 * noise.noise(Vector((math.atan2(p.y - ty, p.x - tx) * 2.0, tx * 9, 0)) + nseed)
                                   + 0.15 * noise.noise(p * 60.0))
                    if rd < ragged:
                        disp -= 0.012 + 0.006 * noise.noise(p * 50.0)
                        tear = max(tear, 1.0)
                    elif rd < ragged * 1.25:
                        f = (rd - ragged) / (ragged * 0.25)
                        disp += 0.003 * (1 - f)
                        tear = max(tear, 0.5 * (1 - f))
            return disp, tear

        def make(k_band, step, lines_xyz, high: bool):
            def axis(E, m_lines):
                half = E / 2
                band = [(-half + rr * i / k_band) for i in range(k_band + 1)]
                inner_a, inner_b = -half + rr, half - rr
                if high:
                    m = max(0, int((inner_b - inner_a) / step))
                else:
                    m = m_lines
                inner = [inner_a + (inner_b - inner_a) * (i + 1) / (m + 1) for i in range(m)]
                vals = band + inner + [-x for x in reversed(band)]
                out = []
                for x in sorted(vals):
                    if not out or abs(x - out[-1]) > 1e-5:
                        out.append(x)
                return out
            X, Y, Z = axis(w, lines_xyz[0]), axis(d, lines_xyz[1]), axis(h, lines_xyz[2])
            bm = bmesh.new()
            # build each face as a grid, weld afterwards
            def grid(us, vs, f):
                vv = [[bm.verts.new(f(a, b)) for a in us] for b in vs]
                for j in range(len(vs) - 1):
                    for i in range(len(us) - 1):
                        bm.faces.new((vv[j][i], vv[j][i + 1], vv[j + 1][i + 1], vv[j + 1][i]))
            hw, hd, hh = w / 2, d / 2, h / 2
            grid(X, Y, lambda a, b: (a, b, hh))
            if not skip_bottom:
                grid(X, Y, lambda a, b: (a, -b, -hh))
            grid(X, Z, lambda a, b: (a, -hd, b))
            grid(X, Z, lambda a, b: (-a, hd, b))
            grid(Y, Z, lambda a, b: (hw, a, b))
            grid(Y, Z, lambda a, b: (-hw, -a, b))
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
            tear_vals = []
            for vtx in bm.verts:
                p = vtx.co.copy()
                lim = Vector((hw - rr, hd - rr, hh - rr))
                qc = Vector((max(-lim.x, min(lim.x, p.x)), max(-lim.y, min(lim.y, p.y)), max(-lim.z, min(lim.z, p.z))))
                nn = p - qc
                if nn.length > 1e-9:
                    nn.normalize()
                    pr = qc + nn * rr
                else:
                    nn = Vector((0, 0, 1))
                    pr = p
                q = shape(pr, nn)
                t = 0.0
                if high:
                    disp, t = detail(pr, q, nn)
                    q = q + nn * disp
                vtx.co = q
                tear_vals.append(t)
            bm.normal_update()
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
            obj = _link(self._name(name + ('_hi' if high else '')), bm)
            return obj, tear_vals

        low, _ = make(1, 0.0, lowres, False)
        high, tv = make(6 if not DRAFT else 4, 0.014 if not DRAFT else 0.025, lowres, True)
        off, pvv = self._stamp(low, 'x', pv)
        self._stamp(high, 'x', pvv, off)
        high.data.attributes['tear'].data.foreach_set('value', np.array(tv, dtype=np.float32))
        for o in (low, high):
            if mat is not None:
                o.data.materials.append(mat)
            self._place(o, loc, rot)
            for poly in o.data.polygons:
                poly.use_smooth = True
        return self.soft(low, high, ext)

    def sheet(self, fn, nu, nv, loc=(0, 0, 0), mat=None, *, hi_mult=6, thickness=0.004, rot=(0, 0, 0),
              folds=0.01, seed=0, name='sheet', ext=0.02, uv_range=((0, 1), (0, 1))):
        """Cloth sheet from a parametric surface fn(u, v) -> Vector (u, v in 0..1); folds on the high."""
        rng = random.Random(seed)
        ns = Vector((rng.uniform(-50, 50), rng.uniform(-50, 50), rng.uniform(-50, 50)))

        def make(nu_, nv_, high):
            bm = bmesh.new()
            grid = []
            for j in range(nv_ + 1):
                row = []
                for i in range(nu_ + 1):
                    u, v = i / nu_, j / nv_
                    p = Vector(fn(u, v))
                    if high:
                        e = 1e-3
                        du = Vector(fn(min(1, u + e), v)) - Vector(fn(max(0, u - e), v))
                        dv = Vector(fn(u, min(1, v + e))) - Vector(fn(u, max(0, v - e)))
                        nrm = du.cross(dv)
                        if nrm.length > 1e-9:
                            nrm.normalize()
                            pp = p * 6.0 + ns
                            rid = 1.0 - abs(noise.noise(pp))
                            rid2 = 1.0 - abs(noise.noise(p * 15.0 + ns))
                            disp = folds * (rid ** 5 * 1.2 + 0.4 * rid2 ** 8 + 0.5 * noise.noise(p * 2.5 + ns) - 0.3)
                            p = p + nrm * disp
                    row.append(bm.verts.new(p))
                grid.append(row)
            for j in range(nv_):
                for i in range(nu_):
                    bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
            bm.normal_update()
            if thickness > 0:
                ret = bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=thickness)
            bm.normal_update()
            obj = _link(self._name(name + ('_hi' if high else '')), bm)
            return obj

        low = make(nu, nv, False)
        high = make(nu * hi_mult, nv * hi_mult, True)
        off, pvv = self._stamp(low, 'x')
        self._stamp(high, 'x', pvv, off)
        for o in (low, high):
            if mat is not None:
                o.data.materials.append(mat)
            self._place(o, loc, rot)
            for poly in o.data.polygons:
                poly.use_smooth = True
        return self.soft(low, high, ext)

    def decal_group(self, lows, decals, ext=0.004):
        """Bake `lows` from (copies of themselves + decal meshes) so stencils/labels land in the texture.
        The copies are made after UV layout (so they can sample the mask texture)."""
        for lo in lows:
            if lo in self.hard:
                self.hard.remove(lo)
        self.groups.append({'low': list(lows), 'high': list(decals), 'ext': ext, 'decal': True})

    # -- pipeline ---------------------------------------------------------------------------
    def finish(self, *, tex=1024, tileable=False, back_hidden=True, fit=None, extras=None, preview_yaw=35,
               preview_pitch=15, max_tris=2500, hard_smooth=True, weights=None, flash_yaw=None):
        name = f'furniture_{self.name}'
        size = (512 if tex >= 512 else tex) if DRAFT else tex
        samples = 6 if DRAFT else 16
        scene = bpy.context.scene

        hard = join_all(self.hard, name + '_H') if self.hard else None
        if hard is not None:
            prep_hard_normals(hard)
        lows = []
        for gi, grp in enumerate(self.groups):
            lo = join_all(grp['low'], f'{name}_S{gi}')
            if grp.get('decal'):
                prep_hard_normals(lo)
            grp['L'] = lo
            if not grp.get('decal'):
                grp['Hi'] = join_all(grp['high'], f'{name}_Hi{gi}')
            lows.append(lo)

        parts = ([hard] if hard else []) + lows
        tris = C.tri_count(parts)
        print(f'[{self.name}] low-poly: {tris} tris')

        # --- shared UV layout ------------------------------------------------------------------
        for i, o in enumerate(parts):
            a = o.data.attributes.get('grp') or o.data.attributes.new('grp', 'INT', 'FACE')
            a.data.foreach_set('value', np.full(len(o.data.polygons), i, dtype=np.int32))
        allL = join_all(parts, name + '_L')
        uv_layout(allL, size, back_hidden, weights)
        # split back into groups
        pieces = split_by_attr(allL, 'grp', len(parts))
        hard = pieces[0] if self.hard else None
        for gi, grp in enumerate(self.groups):
            grp['L'] = pieces[gi + (1 if self.hard else 0)]
            if grp.get('decal'):
                cp = grp['L'].copy()
                cp.data = grp['L'].data.copy()
                bpy.context.scene.collection.objects.link(cp)
                grp['Hi'] = join_all([cp] + grp['high'], f'{name}_Hi{gi}')

        # --- shared AO/edge mask texture for hard-surface materials --------------------------------
        mask_objs = ([hard] if hard is not None else []) + [g_['L'] for g_ in self.groups if g_.get('decal')]
        t0 = time.time()
        if mask_objs:
            bake_masks(mask_objs, size, samples)
        print(f'[{self.name}] masks baked in {time.time() - t0:.1f}s', flush=True)

        # --- bake ----------------------------------------------------------------------------
        all_mats = set()
        for o in pieces:
            for m in o.data.materials:
                all_mats.add(m)
        has_metal = any(_metal_value(m) for m in all_mats)
        keys = ['color', 'rough', 'normal'] + (['metal'] if has_metal else [])
        scene.cycles.samples = samples
        passes = ([(hard, None, 0.0)] if hard is not None else []) + [(g_['L'], g_['Hi'], g_['ext']) for g_ in self.groups]
        imgs = {}
        for key in keys:
            acc = np.zeros(size * size * 4, dtype=np.float32)
            cover = np.zeros(size * size, dtype=bool)
            for (lo_, hi_, ext_) in passes:
                # byte images for color (bake does the sRGB encode), float for normals (precision)
                tmp = bpy.data.images.new(f'{name}_{key}_tmp', size, size, alpha=True, float_buffer=key == 'normal')
                if key != 'color':
                    tmp.colorspace_settings.name = 'Non-Color'
                t0 = time.time()
                _bake_pass(key, tmp, lo_, hi_, ext_, 0, clear=True)
                t1 = time.time()
                px = np.empty(size * size * 4, dtype=np.float32)
                tmp.pixels.foreach_get(px)
                a = uv_mask(lo_, size).ravel() & ~cover
                print(f'   bake {key} {lo_.name}: {t1 - t0:.1f}s, mask {time.time() - t1:.1f}s', flush=True)
                idx = np.repeat(a, 4)
                acc[idx] = px[idx]
                cover |= a
                bpy.data.images.remove(tmp)
            acc = dilate(acc.reshape(size, size, 4), cover.reshape(size, size), max(4, size // 64)).ravel()
            acc[3::4] = 1.0
            img = bpy.data.images.new(f'{name}_{key}', size, size, alpha=False, float_buffer=key == 'normal')
            if key != 'color':
                img.colorspace_settings.name = 'Non-Color'
            img.pixels.foreach_set(acc)
            img.pack()
            imgs[key] = img
            print(f'[{self.name}] baked {key}: coverage {cover.mean() * 100:.0f}%', flush=True)

        dump = os.environ.get('FURN_DUMP')
        if dump:
            os.makedirs(dump, exist_ok=True)
            for key, img in imgs.items():
                img.filepath_raw = os.path.join(dump, f'{name}_{key}.png')
                img.file_format = 'PNG'
                img.save()

        # --- assemble final single-material mesh -------------------------------------------------
        final_mat = build_final_material(name, imgs, size)
        final = join_all(pieces, name)
        final.data.materials.clear()
        final.data.materials.append(final_mat)
        for p in final.data.polygons:
            p.material_index = 0
        for a in ('grp', 'gc', 'lp', 'pv', 'tear'):
            if a in final.data.attributes:
                final.data.attributes.remove(final.data.attributes[a])
        for grp in self.groups:
            hi = grp['Hi']
            bpy.data.objects.remove(hi)
        # leftover helper objects (text curves etc.)
        for o in list(scene.objects):
            if o is not final:
                bpy.data.objects.remove(o)
        bpy.context.view_layer.update()

        lo, hi = C._bounds([final])
        dims = hi - lo
        size3 = [round(dims.x, 3), round(dims.z, 3), round(dims.y, 3)]
        final['size'] = size3
        final['tileable'] = bool(tileable)
        if fit:
            final['fit'] = [round(v, 3) for v in fit]
        for k, v in (extras or {}).items():
            final[k] = v
        scene['size'] = size3
        scene['tileable'] = bool(tileable)
        tris = C.tri_count([final])
        print(f'[{self.name}] FINAL {tris} tris, size {size3}, center ({(lo.x + hi.x) / 2:.3f}, {(lo.y + hi.y) / 2:.3f}), '
              f'minz {lo.z:.3f}, textures {size}px, metal={has_metal}')
        if tris > max_tris:
            print(f'[{self.name}] WARNING over budget: {tris} > {max_tris}')
        C.export_glb(name, [final])
        if DO_PREVIEW:
            ps = 16 if DRAFT else 32
            C.preview(f'{name}_3q', [final], yaw_deg=preview_yaw, pitch_deg=preview_pitch, samples=ps)
            C.preview(f'{name}_flash', [final], yaw_deg=flash_yaw if flash_yaw is not None else -preview_yaw * 0.6,
                      pitch_deg=preview_pitch, mood='flash', samples=ps)
        C.report(name, [final])
        return final


# =============================================================================================
# Pipeline helpers
# =============================================================================================

def activate(obj, select=None):
    """Like common.activate, but tolerant of stale view-layer entries after object removal."""
    vl = bpy.context.view_layer
    vl.update()
    for o in vl.objects:
        if o is not None:
            o.select_set(False)
    for o in (select or [obj]):
        o.select_set(True)
    vl.objects.active = obj


def uv_mask(obj, size):
    """Boolean texel mask of the object's UV triangles (texel centers inside, slightly conservative)."""
    me = obj.data
    me.calc_loop_triangles()
    uv = np.empty(len(me.loops) * 2, dtype=np.float32)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2) * size - 0.5
    tris = np.empty(len(me.loop_triangles) * 3, dtype=np.int32)
    me.loop_triangles.foreach_get('loops', tris)
    tris = tris.reshape(-1, 3)
    mask = np.zeros((size, size), dtype=bool)
    eps = 0.6
    for t in tris:
        a, b, c = uv[t[0]], uv[t[1]], uv[t[2]]
        x0 = max(int(math.floor(min(a[0], b[0], c[0]) - 1)), 0)
        x1 = min(int(math.ceil(max(a[0], b[0], c[0]) + 1)), size - 1)
        y0 = max(int(math.floor(min(a[1], b[1], c[1]) - 1)), 0)
        y1 = min(int(math.ceil(max(a[1], b[1], c[1]) + 1)), size - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        if abs(area) < 1e-12:
            continue
        sgn = 1.0 if area > 0 else -1.0
        inside = np.ones(xs.shape, dtype=bool)
        for p, q in ((a, b), (b, c), (c, a)):
            ex, ey = q[0] - p[0], q[1] - p[1]
            ln = math.hypot(ex, ey) + 1e-12
            d = ((xs - p[0]) * ey - (ys - p[1]) * ex) * -sgn / ln  # signed distance, + inside
            inside &= d > -eps
        mask[ys[inside], xs[inside]] = True
    return mask


def dilate(px, mask, iters):
    """Grow baked islands into empty texels (mean of filled 8-neighbours), like a bake margin."""
    px = px.copy()
    mask = mask.copy()
    h, w = mask.shape
    for _ in range(iters):
        acc = np.zeros_like(px)
        cnt = np.zeros((h, w), dtype=np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                m = np.roll(np.roll(mask, dy, 0), dx, 1)
                acc += np.roll(np.roll(px * mask[..., None], dy, 0), dx, 1)
                cnt += m
        grow = (~mask) & (cnt > 0)
        if not grow.any():
            break
        px[grow] = acc[grow] / cnt[grow][:, None]
        mask = mask | grow
    # anything still empty: overall mean (keeps mips sane)
    if (~mask).any() and mask.any():
        px[~mask] = px[mask].mean(0)
    return px


def join_all(objs, name):
    objs = [o for o in objs if o is not None]
    if len(objs) == 1:
        o = objs[0]
        o.name = name
        o.data.name = name
        return o
    return C.join(objs, name)


def prep_hard_normals(obj):
    """Smooth shading + sharp edges > 50 deg + face-area weighted normals (bevels read as rounded)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2:
            try:
                ang = e.calc_face_angle()
            except ValueError:
                ang = 0
            e.smooth = ang < math.radians(50)
        else:
            e.smooth = True
    bm.to_mesh(obj.data)
    bm.free()
    mod = obj.modifiers.new('wn', 'WEIGHTED_NORMAL')
    mod.mode = 'FACE_AREA'
    mod.keep_sharp = True
    mod.weight = 50
    C.apply_modifiers(obj)


def split_by_attr(obj, attr, count):
    """Split a mesh into `count` objects by integer face attribute (keeps custom normals/UVs)."""
    out = []
    vals = np.zeros(len(obj.data.polygons), dtype=np.int32)
    obj.data.attributes[attr].data.foreach_get('value', vals)
    for i in range(count):
        cp = obj.copy()
        cp.data = obj.data.copy()
        bpy.context.scene.collection.objects.link(cp)
        bm = bmesh.new()
        bm.from_mesh(cp.data)
        bm.faces.ensure_lookup_table()
        kill = [f for f in bm.faces if vals[f.index] != i]
        bmesh.ops.delete(bm, geom=kill, context='FACES')
        bm.to_mesh(cp.data)
        bm.free()
        cp.name = f'{obj.name}_{i}'
        out.append(cp)
    bpy.data.objects.remove(obj)
    return out


def _islands(bm, uv):
    parent = list(range(len(bm.faces)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def close(a, b):
        return (a - b).length_squared < 1e-10

    for e in bm.edges:
        if len(e.link_faces) != 2:
            continue
        l1, l2 = e.link_loops[0], e.link_loops[1]
        a1, b1 = l1[uv].uv, l1.link_loop_next[uv].uv
        a2, b2 = l2[uv].uv, l2.link_loop_next[uv].uv
        if (close(a1, b2) and close(b1, a2)) or (close(a1, a2) and close(b1, b2)):
            ra, rb = find(l1.face.index), find(l2.face.index)
            if ra != rb:
                parent[ra] = rb
    groups: dict[int, list] = {}
    for f in bm.faces:
        groups.setdefault(find(f.index), []).append(f)
    return list(groups.values())


def openness(obj, reach=0.35, rays=6):
    """Per-face fraction of short rays (cone around the normal) that escape: ~0 for hidden faces."""
    from mathutils.bvhtree import BVHTree
    deps = bpy.context.evaluated_depsgraph_get()
    tree = BVHTree.FromObject(obj, deps)
    rr = random.Random(5)
    dirs = [Vector((0, 0, 1))] + [Vector((math.cos(a) * 0.6, math.sin(a) * 0.6, 0.8)).normalized()
                                  for a in [2 * math.pi * i / (rays - 1) for i in range(rays - 1)]]
    out = []
    for p in obj.data.polygons:
        n = p.normal
        ref = Vector((1, 0, 0)) if abs(n.x) < 0.9 else Vector((0, 1, 0))
        u = n.cross(ref).normalized()
        v = n.cross(u)
        esc = 0
        for d in dirs:
            w = (u * d.x + v * d.y + n * d.z).normalized()
            hit = tree.ray_cast(p.center + n * 1e-3, w, reach)
            if hit[0] is None:
                esc += 1
        out.append(esc / len(dirs))
    return out


def uv_layout(obj, size, back_hidden=True, weights=None):
    """Smart-project, then shrink islands nobody sees (bottoms, wall side, enclosed) and re-pack."""
    opn = openness(obj)
    activate(obj)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bm = bmesh.from_edit_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    uv = bm.loops.layers.uv.active
    for isl in _islands(bm, uv):
        n = Vector()
        area = 0.0
        cen = Vector((0, 0, 0))
        op = 0.0
        for f in isl:
            a = f.calc_area()
            n += f.normal * a
            area += a
            cen += f.calc_center_median() * a
            op += opn[f.index] * a
        if area <= 0:
            continue
        n.normalize()
        cen /= area
        wgt = 1.0
        if n.z < -0.6:
            wgt = 0.3 if cen.z > 0.25 else 0.15  # undersides (shelf undersides are still seen a bit)
        elif back_hidden and n.y < -0.6:
            wgt = 0.4
        elif n.z > 0.6:
            wgt = 1.15
        elif n.y > 0.6:
            wgt = 1.1
        wgt *= 0.25 + 0.75 * (op / area)
        if weights:
            wgt *= weights(n, cen, area)
        if abs(wgt - 1.0) > 1e-3:
            s = math.sqrt(wgt)
            uvs = [l[uv].uv for f in isl for l in f.loops]
            c = sum((u.copy() for u in uvs), Vector((0, 0))) / len(uvs)
            for f in isl:
                for l in f.loops:
                    l[uv].uv = c + (l[uv].uv - c) * s
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.uv.pack_islands(rotate=True, rotate_method='ANY', scale=True, margin_method='FRACTION',
                            margin=4.0 / size, shape_method='CONCAVE')
    bpy.ops.object.mode_set(mode='OBJECT')


def _metal_value(mat) -> bool:
    n = mat.node_tree.nodes.get('__metal__') if mat.node_tree else None
    if n is None:
        return False
    if n.inputs[0].is_linked:
        return True
    return n.inputs[0].default_value > 0.001


def _target(mats, img):
    for mat in mats:
        nt = mat.node_tree
        node = nt.nodes.get('__bake_target__') or nt.nodes.new('ShaderNodeTexImage')
        node.name = '__bake_target__'
        node.image = img
        for n in nt.nodes:
            n.select = False
        node.select = True
        nt.nodes.active = node


def mask_material():
    """Emission = (AO 12 cm, AO 3 cm, bevel-edge mask): baked once, sampled by hard materials."""
    mat = new_material('__mask_mat__')
    g = G(mat)
    d = g.v('DOT_PRODUCT', g.bevel(MASK_BEVEL), g.geo('True Normal'))
    edge = g.rng(d, 0.985, 0.80, smooth=True)
    col = g.comb(g.ao(MASK_AO), g.ao(MASK_AO_SMALL), edge)
    em = g.node('ShaderNodeEmission', {'Color': col, 'Strength': 1.0})
    g.nt.links.new(em.outputs[0], g.out.inputs['Surface'])
    return mat


def bake_masks(objs, size, samples):
    """Bake the shared mask texture for the given (hard-surface) objects."""
    img = bpy.data.images.new('__masks__', size, size, alpha=False)
    img.colorspace_settings.name = 'Non-Color'
    acc = np.zeros(size * size * 4, dtype=np.float32)
    cover = np.zeros(size * size, dtype=bool)
    mm = mask_material()
    sc = bpy.context.scene
    old_samples = sc.cycles.samples
    sc.cycles.samples = samples
    for o in objs:
        saved = list(o.data.materials)
        idx = np.zeros(len(o.data.polygons), dtype=np.int32)
        o.data.polygons.foreach_get('material_index', idx)
        o.data.materials.clear()
        o.data.materials.append(mm)
        o.data.polygons.foreach_set('material_index', np.zeros_like(idx))
        tmp = bpy.data.images.new('__masks_tmp__', size, size, alpha=True)
        tmp.colorspace_settings.name = 'Non-Color'
        _target([mm], tmp)
        activate(o)
        bpy.ops.object.bake(type='EMIT', margin=0, use_clear=True, target='IMAGE_TEXTURES', use_selected_to_active=False)
        px = np.empty(size * size * 4, dtype=np.float32)
        tmp.pixels.foreach_get(px)
        a = uv_mask(o, size).ravel() & ~cover
        ii = np.repeat(a, 4)
        acc[ii] = px[ii]
        cover |= a
        bpy.data.images.remove(tmp)
        o.data.materials.clear()
        for m in saved:
            o.data.materials.append(m)
        o.data.polygons.foreach_set('material_index', idx)
    sc.cycles.samples = old_samples
    acc = dilate(acc.reshape(size, size, 4), cover.reshape(size, size), 6).ravel()
    acc[3::4] = 1.0
    img.pixels.foreach_set(acc)
    img.pack()
    for m in bpy.data.materials:
        if m.node_tree:
            n = m.node_tree.nodes.get('__maskimg__')
            if n is not None:
                n.image = img
    return img


def _isolate(mats, key):
    """Unlink the BSDF inputs a pass doesn't need, so Cycles only evaluates the relevant subtree."""
    keep = {'color': 'Base Color', 'rough': 'Roughness', 'normal': 'Normal'}.get(key)
    saved = []
    for mat in mats:
        nt = mat.node_tree
        b = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if b is None:
            continue
        for sock_name in ('Base Color', 'Roughness', 'Normal'):
            sock = b.inputs[sock_name]
            if sock_name != keep and sock.is_linked:
                saved.append((nt, sock, sock.links[0].from_socket))
                nt.links.remove(sock.links[0])
    return saved


def _bake_pass(key, img, low, high, ext, margin, clear):
    mats = list(low.data.materials) + (list(high.data.materials) if high else [])
    _target(set(mats), img)
    restore = []
    isolated = _isolate(set(mats), key)
    if key == 'metal':
        for mat in set(mats):
            nt = mat.node_tree
            out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
            em = nt.nodes.new('ShaderNodeEmission')
            mn = nt.nodes.get('__metal__')
            if mn is not None:
                nt.links.new(mn.outputs[0], em.inputs['Color'])
            else:
                em.inputs['Color'].default_value = (0, 0, 0, 1)
            old = out.inputs['Surface'].links[0].from_socket if out.inputs['Surface'].is_linked else None
            nt.links.new(em.outputs[0], out.inputs['Surface'])
            restore.append((nt, out, old, em))
    sel = [high, low] if high else [low]
    activate(low, sel)
    kw = dict(margin=margin, margin_type='EXTEND', use_clear=clear, target='IMAGE_TEXTURES')
    if high:
        kw.update(use_selected_to_active=True, cage_extrusion=ext, max_ray_distance=ext * 3)
    else:
        kw.update(use_selected_to_active=False)
    t = {'color': dict(type='DIFFUSE', pass_filter={'COLOR'}), 'rough': dict(type='ROUGHNESS'),
         'normal': dict(type='NORMAL', normal_space='TANGENT'), 'metal': dict(type='EMIT')}[key]
    bpy.ops.object.bake(**t, **kw)
    for nt, out, old, em in restore:
        if old is not None:
            nt.links.new(old, out.inputs['Surface'])
        nt.nodes.remove(em)
    for nt, sock, src in isolated:
        nt.links.new(src, sock)


def build_final_material(name, imgs, size):
    """Color + packed metallicRoughness (G=rough, B=metal) + normal, all as exporter-friendly nodes."""
    w = h = size
    rough = np.empty(w * h * 4, dtype=np.float32)
    imgs['rough'].pixels.foreach_get(rough)
    mr = np.ones_like(rough)
    mr[1::4] = np.clip(rough[0::4], 0.04, 1.0)
    if 'metal' in imgs:
        met = np.empty(w * h * 4, dtype=np.float32)
        imgs['metal'].pixels.foreach_get(met)
        mr[2::4] = np.clip(met[0::4], 0.0, 1.0)
    else:
        mr[2::4] = 0.0
    mr[0::4] = 1.0
    mr_img = bpy.data.images.new(f'{name}_mr', w, h, alpha=False)
    mr_img.colorspace_settings.name = 'Non-Color'
    mr_img.pixels.foreach_set(mr)
    mr_img.pack()
    # normal map: bake as float then store as 8-bit
    nrm = np.empty(w * h * 4, dtype=np.float32)
    imgs['normal'].pixels.foreach_get(nrm)
    n_img = bpy.data.images.new(f'{name}_normal8', w, h, alpha=False)
    n_img.colorspace_settings.name = 'Non-Color'
    n_img.pixels.foreach_set(nrm)
    n_img.pack()

    mat = new_material(name)
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs['BSDF'], out.inputs['Surface'])
    tc = nt.nodes.new('ShaderNodeTexImage')
    tc.image = imgs['color']
    nt.links.new(tc.outputs['Color'], b.inputs['Base Color'])
    tm = nt.nodes.new('ShaderNodeTexImage')
    tm.image = mr_img
    sp = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(tm.outputs['Color'], sp.inputs['Color'])
    nt.links.new(sp.outputs['Green'], b.inputs['Roughness'])
    nt.links.new(sp.outputs['Blue'], b.inputs['Metallic'])
    tn = nt.nodes.new('ShaderNodeTexImage')
    tn.image = n_img
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    return mat
