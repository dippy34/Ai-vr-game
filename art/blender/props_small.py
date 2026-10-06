"""
Small pickups: fuse.glb (glass cartridge fuse) and film.glb (35 mm film canister).
Built by props.py; see art/README.md for budgets and node names.
"""

from __future__ import annotations

import math

import bpy

import common
import props_lib as L
import props_mats as M


def build() -> None:
    """art/build.py imports every module here and calls build(); props.py drives this one."""


# =============================================================================================
# Fuse: ~11 cm renewable cartridge fuse, brass ferrules, glass tube, wire + solder bead.
# Long axis = Blender Z (three.js Y), origin = center.
# =============================================================================================

FUSE_R_GLASS = 0.0084
FUSE_R_CAP = 0.0105


def _fuse_cap_profile(hi: bool):
    """(r, z) for the +Z ferrule, from the glass junction out and up to the axis."""
    R = FUSE_R_CAP
    if not hi:
        return [(0.0087, 0.0357), (0.0101, 0.0360), (R, 0.0369), (R, 0.0526), (0.0099, 0.0547),
                (0.0062, 0.0553), (0.0, 0.0555)]
    p = [(0.0087, 0.0357), (0.0097, 0.03575), (0.01025, 0.0361), (R + 0.0001, 0.0367), (R + 0.0001, 0.0372),
         (R, 0.0376)]
    # two rolled/stamped grooves
    for zc in (0.0388, 0.0512):
        p += [(R, zc - 0.0007), (R - 0.00035, zc - 0.0003), (R - 0.00035, zc + 0.0003), (R, zc + 0.0007)]
    p += [(R, 0.0524), (0.01035, 0.0538), (0.0099, 0.0547), (0.0092, 0.0551), (0.0062, 0.0554),
          (0.0024, 0.0556), (0.0018, 0.0554), (0.0, 0.0553)]
    return p


def _fuse_parts(hi: bool, mats: dict | None):
    segs = 48 if hi else 14
    parts = []
    for sign, nm in ((1, 'cap_top'), (-1, 'cap_bot')):
        prof = [(r, z * sign) for r, z in _fuse_cap_profile(hi)]
        if sign < 0:
            prof = list(reversed(prof))
        cap = L.lathe(nm, prof, segs, smooth_deg=40 if hi else 50)
        parts.append(cap)
    # Fuse wire: diagonal from cap to cap with a slight sag, solder bead in the middle.
    pts = []
    n = 12 if hi else 7
    for i in range(n + 1):
        t = i / n
        z = -0.0365 + 0.073 * t
        x = -0.0045 + 0.009 * t
        y = 0.0012 * math.sin(math.pi * t)
        pts.append((x, y, z))
    wire = L.sweep('wire', pts, 0.00038, sides=6 if hi else 4, caps=False)
    bead = L.lathe('bead', [(0, -0.0013), (0.0009, -0.0009), (0.00125, 0.0), (0.0009, 0.0009), (0, 0.0013)],
                   12 if hi else 6, loc=(0.0, 0.0012, 0.0), rot=(0, 30, 0), smooth_deg=80)
    parts += [wire, bead]
    if mats:
        for o in parts[:2]:
            L.assign(o, mats['brass'])
        L.assign(wire, mats['wire'])
        L.assign(bead, mats['solder'])
    return parts


def build_fuse(final: bool = True) -> None:
    common.reset()
    stamp_a = L.Decal('fuse_a', 1024, 64)
    stamp_a.text(512, 32, '30 AMP  •  250 V  •  RENEWABLE', 50, (1, 1, 1), kind='sans_bold', spacing=1.15)
    img_a = stamp_a.render()
    stamp_b = L.Decal('fuse_b', 1024, 64)
    stamp_b.text(512, 32, 'NORA ELECTRIC  •  No. 4  •  U.S.A.', 50, (1, 1, 1), kind='sans_bold', spacing=1.15)
    img_b = stamp_b.render()

    def stamp(k: L.Kit):
        a = k.decal(img_a, k.cyl_uv(-80, 160, 0.0425, 0.0477))
        b = k.decal(img_b, k.cyl_uv(100, 160, -0.0477, -0.0425))
        return k.ramp_f(k.maxf(a, b), 0.2, 0.8)

    mats = dict(
        brass=M.brass('fuse_brass_src', s=0.35, tarnish=0.8, stamp=stamp, warm=1.0, grime=1.3),
        wire=M.copper_wire('fuse_wire_src'),
        solder=M.tin('fuse_solder_src', s=0.2, rust=0.0),
    )
    highs = _fuse_parts(True, mats)
    lows = _fuse_parts(False, None)
    low = L.join(lows, 'fuse_body')
    L.triangulate(low)
    glass = L.lathe('glass', [(FUSE_R_GLASS, -0.0372), (FUSE_R_GLASS, 0.0372)], 16, smooth_deg=60)
    L.uv_unwrap(low, margin=0.006)
    size = L.tex_size(512)
    L.bake_atlas(low, 'fuse', size, highs, samples_=L.samples(24), extrusion=0.0008, max_ray=0.0025)
    for o in highs:
        L.delete(o)
    # Old glass: faint green-gray, clear, glossy.
    L.assign(glass, L.flat_material('fuse_glass', color=(0.36, 0.44, 0.40), rough=0.04, alpha=0.2,
                                    culling=False))
    common.report('fuse', [low, glass])
    common.export_glb('fuse', [low, glass])
    L.previews('fuse', [low, glass], [('3q', dict(yaw=35, pitch=15, mood='studio')),
                                      ('flash', dict(yaw=20, pitch=10, mood='flash'))], final=final)


# =============================================================================================
# Film: 35 mm canister (VESPER COLOR 400, 36 exp.) with the leader sticking out.
# Upright (Blender Z), origin = bottom center.
# =============================================================================================

FILM_R = 0.0126       # body (label) radius
FILM_RC = 0.0131      # cap radius
LIP_ANGLE = -30.0     # degrees, where the felt light-trap lip / leader is


def _label_decals():
    """Color label + bare-metal mask, wrapped 360 degrees around the body (u from the lip)."""
    W, H = 1024, 552
    mm = W / (2 * math.pi * FILM_R * 1000)  # px per mm around the body
    ox = (0.155, 0.012, 0.010, 1)
    cream = (0.74, 0.66, 0.45, 1)
    black = (0.018, 0.016, 0.015, 1)
    mustard = (0.56, 0.33, 0.045, 1)
    silver = (0.55, 0.55, 0.53, 1)
    white = (1, 1, 1, 1)
    out = []
    for kind in ('color', 'metal'):
        bg = (0, 0, 0, 1) if kind == 'metal' else cream
        d = L.Decal(f'film_{kind}', W, H, bg=bg)

        def c(col):
            if kind == 'color':
                return col
            return white if col is silver else (0, 0, 0, 1)

        def r(x0, y0, x1, y1, col):
            d.rect(x0 * mm, y0 * mm, x1 * mm, y1 * mm, c(col))

        def t(x, y, body, size, col, **kw):
            d.text(x * mm, y * mm, body, size * mm / 0.72, c(col), **kw)

        r(0, 0, 80, 6.5, ox)
        r(0, 36.3, 80, 43, ox)
        r(0, 6.5, 80, 7.2, black)
        r(0, 35.6, 80, 36.3, black)
        t(25, 21.5, 'VESPER', 8.6, ox, kind='serif_bold', spacing=1.02)
        t(25, 12.5, 'COLOR 400', 4.0, black, kind='sans_bold', spacing=1.2)
        t(25, 30.5, 'FOR COLOR PRINTS', 2.0, black, kind='sans_bold', spacing=1.3)
        t(27, 39.6, 'VESPER FILM CO.  •  ROCHESTER', 2.0, cream, kind='sans_bold', spacing=1.2)
        t(27, 3.2, 'ISO 400/27°   135-36', 2.2, cream, kind='sans_bold', spacing=1.2)
        # "36" panel
        r(50, 10, 64, 33, mustard)
        r(50, 10, 64, 10.6, black)
        r(50, 32.4, 64, 33, black)
        t(57, 22.5, '36', 11.0, black, kind='sans_bold', spacing=0.95)
        t(57, 13.8, 'EXP.', 2.8, black, kind='sans_bold', spacing=1.2)
        # DX code: 2 x 12 checker of bare metal / black.
        import random
        rnd = random.Random(400)
        r(67.5, 7.2, 76.5, 35.6, black)
        for row in range(12):
            for col in range(2):
                if (row + col) % 2 == 0 or rnd.random() < 0.3:
                    y0 = 8.0 + row * 2.25
                    x0 = 68.3 + col * 4.0
                    r(x0, y0, x0 + 3.4, y0 + 1.8, silver)
        t(72, 3.2, 'DX', 2.4, cream, kind='sans_bold')
        # Barcode across the bottom band.
        x = 40.0
        while x < 48.5:
            w = rnd.choice((0.25, 0.25, 0.4, 0.6))
            r(x, 0.8, x + w, 5.5, black)
            x += w + rnd.choice((0.25, 0.35, 0.5))
        out.append(d.render())
    return out


def _film_parts(hi: bool, mats: dict | None, img_color=None, img_metal=None):
    segs = 56 if hi else 20
    R, RC = FILM_R, FILM_RC
    parts = {}
    if hi:
        bot = [(0, 0.0005), (0.0045, 0.0005), (0.005, 0.0), (0.0118, 0.0), (0.0125, 0.0001), (0.01295, 0.0005),
               (RC, 0.0011), (RC, 0.0026), (0.01295, 0.0031), (R + 0.0001, 0.0034), (R, 0.0037)]
        body = [(R, 0.0037), (R, 0.0463)]
        top = [(R, 0.0463), (R + 0.0001, 0.0466), (0.01295, 0.0469), (RC, 0.0474), (RC, 0.0489), (0.01295, 0.0495),
               (0.0125, 0.0499), (0.0118, 0.0500), (0.0108, 0.0500), (0.0104, 0.0497), (0.0100, 0.0500),
               (0.0058, 0.0500), (0.0054, 0.0503)]
        nub = [(0.0050, 0.0503), (0.0048, 0.0506), (0.0048, 0.0556), (0.0045, 0.0561), (0.0, 0.0562)]
    else:
        bot = [(0, 0.0), (0.0122, 0.0), (RC, 0.0009), (RC, 0.0028), (R, 0.0036)]
        body = [(R, 0.0036), (R, 0.0464)]
        top = [(R, 0.0464), (RC, 0.0472), (RC, 0.0491), (0.0122, 0.0500), (0.0052, 0.0500)]
        nub = [(0.0052, 0.0500), (0.0048, 0.0505), (0.0048, 0.0557), (0.0, 0.0562)]
    parts['bot'] = L.lathe('can_bot', bot, segs, smooth_deg=40)
    parts['body'] = L.lathe('can_body', body, segs, smooth_deg=40)
    parts['top'] = L.lathe('can_top', top, segs, smooth_deg=40)
    parts['nub'] = L.lathe('can_nub', nub, segs // 2 if not hi else segs, smooth_deg=40)
    # Felt light-trap lip along the body.
    a = math.radians(LIP_ANGLE)
    lip = L.box('lip', (0.0042, 0.0026, 0.0418), loc=(0, 0, 0.025))
    if hi:
        L.bevel(lip, 0.0008, 3, harden=False)
    else:
        L.bevel(lip, 0.0006, 1)
    L.xform(lip, (math.cos(a) * (R + 0.0006), math.sin(a) * (R + 0.0006), 0), (0, 0, LIP_ANGLE + 90))
    parts['lip'] = lip
    # Film leader: a thin grid strip (u along the film, v across, w = thickness), full width at
    # the lip, then the classic half-width tongue with a rounded end. Curled out of the lip.
    leader = _leader_strip()
    me = leader.data
    # Map: x -> along tangent with curl, y -> height, z -> thickness (normal)
    tang = (-math.sin(a), math.cos(a))
    nrm = (math.cos(a), math.sin(a))
    base = (math.cos(a) * (R + 0.0011), math.sin(a) * (R + 0.0011))
    for v in me.vertices:
        u, vv, w = v.co
        u = u - 0.0015
        bend = 0.0 if u < 0 else 9.0 * u * u
        x = base[0] + tang[0] * u + nrm[0] * (bend + w)
        y = base[1] + tang[1] * u + nrm[1] * (bend + w)
        v.co = (x, y, 0.025 + vv)
    me.update()
    L.smooth_by_angle(leader, 30)
    parts['leader'] = leader
    if mats:
        L.assign(parts['bot'], mats['tin'])
        L.assign(parts['top'], mats['tin'])
        L.assign(parts['nub'], mats['plastic'])
        L.assign(parts['body'], mats['label'])
        L.assign(parts['lip'], mats['felt'])
        L.assign(parts['leader'], mats['leader'])
    return list(parts.values())


def _leader_strip():
    import bmesh
    t = 0.00016
    vc, hh = -0.01015, 0.00735          # tongue center / half height
    u0, a = 0.0262, 0.0074              # start of the rounded tongue end, its length
    cols = [0.0, 0.0045, 0.0075, 0.012, 0.017, 0.022, u0, 0.0298, 0.0322, 0.0334]

    def lo_hi(u):
        lo, hi = -0.0175, 0.0175
        if u > 0.0075:
            k = min(1.0, (u - 0.0075) / (0.0255 - 0.0075))
            hi = 0.0175 + (-0.0028 - 0.0175) * k
        if u > u0:
            dv = hh * math.sqrt(max(0.0, 1 - ((u - u0) / a) ** 2))
            lo, hi = vc - dv, min(hi, vc + dv)
        return lo, hi

    bm = bmesh.new()
    rows = []
    for u in cols:
        lo, hi = lo_hi(u)
        rows.append([bm.verts.new((u, lo, -t / 2)), bm.verts.new((u, hi, -t / 2)),
                     bm.verts.new((u, lo, t / 2)), bm.verts.new((u, hi, t / 2))])
    for i in range(len(rows) - 1):
        a_, b_ = rows[i], rows[i + 1]
        bm.faces.new((a_[2], b_[2], b_[3], a_[3]))   # top (+w)
        bm.faces.new((a_[1], b_[1], b_[0], a_[0]))   # bottom
        bm.faces.new((a_[0], b_[0], b_[2], a_[2]))   # lo edge
        bm.faces.new((a_[3], b_[3], b_[1], a_[1]))   # hi edge
    for r, flip in ((rows[0], False), (rows[-1], True)):
        f = (r[0], r[2], r[3], r[1])
        bm.faces.new(tuple(reversed(f)) if flip else f)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = L.from_bmesh('leader', bm)
    me = o.data
    uvl = me.uv_layers.new(name='flat')
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            uvl.data[li].uv = (co.x, co.y)
    return o


def _label_material(img_color, img_metal):
    def fn(k: L.Kit):
        uv = k.cyl_uv(LIP_ANGLE + 4.0, 360.0, 0.0036, 0.0464)
        col = k.decal(img_color, uv, out='Color')
        bare = k.decal(img_metal, uv, out='Color')
        x, y, z = k.xyz(k.coord())
        # Wear: rubbed off near the cap rims, scuffs, fine scratches through the print.
        rim = k.maxf(k.ramp_f(z, 0.0062, 0.0040), k.ramp_f(z, 0.0438, 0.0460))
        n1 = k.noise(scale=260, detail=6, rough=0.65)
        n2 = k.noise(scale=1200, detail=3)
        rub = k.ramp_f(k.add(k.mul(rim, 0.55), k.mul(n1, 0.7)), 0.62, 0.78)
        scr = k.maxf(k.scratches(scale=40, density=0.7, width=0.010, angle=75, seed=3),
                     k.scratches(scale=55, density=0.5, width=0.008, angle=-10, seed=5))
        worn = k.maxf(k.maxf(rub, scr), k.ramp_f(bare, 0.3, 0.7))
        # Faded print (sun + age), slight yellowing.
        faded = k.mix(0.10, col, (0.55, 0.48, 0.33))
        faded = k.mix(k.mul(k.ramp_f(n1, 0.35, 0.65), 0.22), faded, (0.30, 0.24, 0.15))
        metal_col = k.mix(n2, (0.60, 0.60, 0.58), (0.45, 0.45, 0.43))
        out = k.mix(worn, faded, metal_col)
        dirt = k.mul(k.ramp_f(k.noise(scale=90, detail=4), 0.5, 0.8), 0.45)
        out = k.mix(dirt, out, (0.10, 0.085, 0.06))
        rough = k.add(k.mixf(worn, 0.42, 0.30), k.mul(dirt, 0.3))
        metal = k.mul(worn, k.sub(1.0, dirt))
        h = k.add(k.mul(worn, -0.3), k.mul(n2, 0.1))
        return dict(color=out, rough=rough, metal=metal, normal=k.bump(h, strength=0.5, distance=0.0001))

    return L.pbr('film_label_src', fn)


def _leader_material():
    def fn(k: L.Kit):
        uvn = k.node('ShaderNodeUVMap', uv_map='flat')
        u, v, _ = k.xyz(uvn.outputs[0])
        pitch = 0.00475
        fu = k.math('FLOORED_MODULO', k.add(u, 0.0006), pitch)
        hu = k.mul(k.ramp_f(fu, 0.0, 0.0002), k.ramp_f(fu, 0.00198, 0.00178))
        av = k.math('ABSOLUTE', v)
        hv = k.mul(k.ramp_f(av, 0.0137, 0.0140), k.ramp_f(av, 0.0166, 0.0163))
        hole = k.mul(hu, hv)
        n = k.noise(scale=500, detail=3)
        col = k.mix(n, (0.030, 0.018, 0.010), (0.055, 0.030, 0.015))
        # emulsion edge print (frame numbers / brand along the edge) as faint bars
        edge = k.mul(k.ramp_f(av, 0.0168, 0.0170), k.ramp_f(k.math('FLOORED_MODULO', u, 0.0038), 0.0, 0.0001))
        col = k.mix(k.mul(edge, 0.4), col, (0.20, 0.10, 0.04))
        scr = k.scratches(scale=70, density=0.6, width=0.012, angle=5, seed=7)
        col = k.mix(k.mul(scr, 0.5), col, (0.16, 0.12, 0.09))
        col = k.mix(hole, col, (0.004, 0.003, 0.003))
        rough = k.add(k.add(0.16, k.mul(scr, 0.3)), k.mul(hole, 0.7))
        h = k.add(k.mul(scr, -0.6), k.mul(hole, -1.0))
        return dict(color=col, rough=rough, metal=0.0, normal=k.bump(h, strength=0.8, distance=0.00012))

    return L.pbr('film_leader_src', fn, culling=False)


def build_film(final: bool = True) -> None:
    common.reset()
    img_color, img_metal = _label_decals()
    mats = dict(
        tin=M.tin('film_tin_src', s=0.4, rust=0.18),
        plastic=_black_plastic('film_spool_src'),
        label=_label_material(img_color, img_metal),
        felt=M.felt('film_felt_src'),
        leader=_leader_material(),
    )
    highs = _film_parts(True, mats)
    lows = _film_parts(False, None)
    low = L.join(lows, 'film')
    L.triangulate(low)
    L.uv_unwrap(low, margin=0.006)
    size = L.tex_size(512)
    L.bake_atlas(low, 'film', size, highs, samples_=L.samples(24), extrusion=0.0006, max_ray=0.002)
    for o in highs:
        L.delete(o)
    common.report('film', [low])
    common.export_glb('film', [low])
    L.previews('film', [low], [('3q', dict(yaw=35, pitch=20, mood='studio')),
                               ('flash', dict(yaw=10, pitch=12, mood='flash'))], final=final)


def _black_plastic(name: str):
    def fn(k: L.Kit):
        n = k.noise(scale=900, detail=3)
        edge = k.edges(dist=0.0006)
        cav = k.cavity(dist=0.002)
        col = k.mix(k.mul(edge, 0.5), (0.018, 0.017, 0.016), (0.07, 0.068, 0.065))
        col = k.mix(k.mul(cav, 0.5), col, (0.04, 0.035, 0.03))
        return dict(color=col, rough=k.add(0.45, k.mul(n, 0.15)), metal=0.0,
                    normal=k.bump(n, strength=0.2, distance=0.0001))

    return L.pbr(name, fn)
