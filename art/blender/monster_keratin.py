"""
Teeth and nails of the Listener (helper for monster.py; build() is a no-op).

Low-poly keratin geometry grown from the sculpt's feature slots (monster_anatomy reports them in
info['teeth'] / info['nails']):
  * teeth: three rows of needle teeth per mandible half, rooted in the swollen gum lumps: long
    outer needles reaching across the slit, a middle row, and short inner hooks that point down
    the throat; curved, uneven, some snapped off.
  * nails: long, thick, curved, ridged and cracked claws on every finger and toe, lying on the
    flattened nail beds and curling past the tips toward the palm / floor.
They share one small material (512^2 color / OpenGL normal / roughness), generated in numpy.
"""

from __future__ import annotations

import math

import bpy
import bmesh
import numpy as np

import common
import monster_anatomy as A
import monster_sdf as S

TEX = 512
TOOTH_U = (0.0, 0.5)          # atlas columns: teeth on the left half, nails on the right
NAIL_U = (0.5, 1.0)
VARIANTS = 6                  # texture variants (columns) per half


def build() -> None:
    print('[monster_keratin] helper module, nothing to build')


# ---------------------------------------------------------------------------------------------
# texture (numpy)
# ---------------------------------------------------------------------------------------------

def _noise2(u, v, fu, fv, seed):
    p = np.stack([u * fu, v * fv, np.full_like(u, seed)], -1).reshape(-1, 3)
    return S.perlin(p).reshape(u.shape)


def keratin_images(size=TEX):
    """(color RGB linear, normal RGB, roughness) arrays of shape (size, size, 3) / (size, size).
    Row 0 = v 0 (Blender image pixel order)."""
    v, u = np.meshgrid((np.arange(size) + 0.5) / size, (np.arange(size) + 0.5) / size, indexing='ij')
    col = np.zeros((size, size, 3))
    hgt = np.zeros((size, size))
    rough = np.zeros((size, size))
    vw = 1.0 / (2 * VARIANTS)
    var = np.floor((u % 0.5) / vw).astype(int)                # variant column within the half
    lu = ((u % 0.5) - var * vw) / vw                           # 0..1 across the column (around)
    teeth = u < 0.5
    rs = np.random.RandomState(9)
    # ---- teeth: blood at the gum line, stained dentin, yellowed enamel, translucent tips
    t = v
    base = np.stack([0.44 + 0.20 * t, 0.37 + 0.21 * t, 0.24 + 0.24 * t], -1)
    stain = np.clip(_noise2(u, v, 40, 6, 1.0) * 1.6 + 0.2 - t * 0.9, 0, 1)
    base = base * (1 - 0.55 * stain[..., None]) + np.array([0.30, 0.20, 0.09]) * 0.55 * stain[..., None]
    blood = np.clip(1 - t / 0.16, 0, 1) ** 1.5
    base = base * (1 - blood[..., None]) + np.array([0.22, 0.03, 0.03]) * blood[..., None]
    cracks_t = np.zeros_like(t)
    for k in range(VARIANTS):
        for _ in range(2):
            cu = rs.uniform(0.15, 0.85)
            v0, v1 = rs.uniform(0.15, 0.5), rs.uniform(0.6, 1.0)
            wob = 0.03 * np.sin(v * rs.uniform(20, 40) + rs.uniform(0, 6))
            d = np.abs(lu - cu - wob)
            m = (var == k) & (v > v0) & (v < v1)
            cracks_t = np.maximum(cracks_t, m * np.clip(1 - d / 0.035, 0, 1))
    base = base * (1 - 0.7 * cracks_t[..., None]) + np.array([0.12, 0.08, 0.05]) * 0.7 * cracks_t[..., None]
    striae = 0.5 + 0.5 * np.sin(lu * math.pi * 10 + _noise2(u, v, 30, 4, 2.0) * 3)
    th = 0.25 * striae - 0.9 * cracks_t + 0.15 * _noise2(u, v, 90, 30, 3.0)
    tr = 0.16 + 0.10 * stain + 0.25 * cracks_t - 0.05 * blood
    # ---- nails: dark horn, longitudinal ridges, splits from the tip, chipped edges, grime
    nb_ = np.stack([0.15 + 0.22 * t ** 1.3, 0.125 + 0.19 * t ** 1.3, 0.095 + 0.13 * t ** 1.3], -1)
    grime = np.clip(_noise2(u, v, 25, 10, 4.0) * 1.5 + 0.1, 0, 1) * (0.3 + 0.7 * t)
    nb_ = nb_ * (1 - 0.5 * grime[..., None]) + np.array([0.06, 0.045, 0.03]) * 0.5 * grime[..., None]
    ridges = 0.5 + 0.5 * np.sin(lu * math.pi * 14 + _noise2(u, v, 20, 3, 5.0) * 2.5)
    splits = np.zeros_like(t)
    for k in range(VARIANTS):
        for _ in range(3):
            cu = rs.uniform(0.2, 0.8)
            v0 = rs.uniform(0.45, 0.85)
            wob = 0.02 * np.sin(v * rs.uniform(25, 45) + rs.uniform(0, 6))
            d = np.abs(lu - cu - wob - (v - v0) * rs.uniform(-0.15, 0.15))
            m = (var == k) & (v > v0)
            splits = np.maximum(splits, m * np.clip(1 - d / 0.03, 0, 1) * np.clip((v - v0) * 8, 0, 1))
    chips = np.clip(_noise2(u, v, 60, 60, 6.0) * 3 - 1.6, 0, 1) * (v > 0.55)
    bands = np.clip(np.sin(v * 70 + _noise2(u, v, 8, 8, 7.0) * 4) * 2 - 1.4, 0, 1) * 0.5        # growth bands
    nb_ = nb_ * (1 - 0.8 * splits[..., None]) + np.array([0.02, 0.015, 0.012]) * 0.8 * splits[..., None]
    nb_ = nb_ * (1 + 0.6 * chips[..., None])
    nh = 0.45 * ridges - 1.0 * splits - 0.5 * chips - 0.3 * bands + 0.1 * _noise2(u, v, 120, 40, 8.0)
    nr = 0.34 + 0.12 * grime + 0.35 * splits + 0.2 * chips - 0.08 * (1 - t)
    col = np.where(teeth[..., None], base, nb_)
    hgt = np.where(teeth, th, nh)
    rough = np.where(teeth, tr, nr)
    # tangent-space normal (OpenGL: +Y = +v) from the height field (wraps across each column)
    gu = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) * 0.5
    gv = (np.roll(hgt, -1, 0) - np.roll(hgt, 1, 0)) * 0.5
    k = 1.6
    nrm = np.stack([-gu * k, -gv * k, np.ones_like(gu)], -1)
    nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
    return np.clip(col, 0, 1), nrm * 0.5 + 0.5, np.clip(rough, 0.05, 0.95)


def _image(name, rgb, non_color):
    size = rgb.shape[0]
    img = bpy.data.images.new(name, size, size, alpha=False)
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    px = np.ones((size, size, 4), np.float32)
    if rgb.ndim == 2:
        px[..., :3] = rgb[..., None]
    else:
        px[..., :3] = rgb
    if not non_color:   # pixels of an sRGB image are stored display-encoded
        px[..., :3] = np.where(px[..., :3] <= 0.0031308, px[..., :3] * 12.92,
                               1.055 * np.power(np.clip(px[..., :3], 0, 1), 1 / 2.4) - 0.055)
    img.pixels.foreach_set(px.ravel())
    img.pack()
    return img


def keratin_material() -> bpy.types.Material:
    col, nrm, rough = keratin_images()
    mat = bpy.data.materials.new('monster_keratin')
    try:
        mat.use_nodes = True
    except Exception:
        pass
    nt = mat.node_tree
    b = common._bsdf(mat)

    def tex(img, y):
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = img
        n.location = (-600, y)
        n.interpolation = 'Linear'
        return n
    nt.links.new(tex(_image('monster_keratin_color', col, False), 300).outputs['Color'], b.inputs['Base Color'])
    nt.links.new(tex(_image('monster_keratin_rough', rough, True), 0).outputs['Color'], b.inputs['Roughness'])
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tex(_image('monster_keratin_normal', nrm, True), -300).outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    b.inputs['Metallic'].default_value = 0.0
    return mat


# ---------------------------------------------------------------------------------------------
# geometry
# ---------------------------------------------------------------------------------------------

def _loft(bm, uv, rings, tip, u0, u1, close_base=False):
    """Faces between consecutive rings (lists of (co, v) with v along the piece) and a fan to
    the tip. UV: u around the ring across [u0, u1], v as given."""
    vs = [[bm.verts.new(tuple(c)) for c, _ in r] for r in rings]
    tv = bm.verts.new(tuple(tip[0]))
    n = len(rings[0])
    faces = []
    for k in range(len(rings) - 1):
        for i in range(n):
            j = (i + 1) % n
            f = bm.faces.new((vs[k][i], vs[k][j], vs[k + 1][j], vs[k + 1][i]))
            uvs = [(i, rings[k][0][1]), (i + 1, rings[k][0][1]), (i + 1, rings[k + 1][0][1]), (i, rings[k + 1][0][1])]
            faces.append((f, uvs))
    for i in range(n):
        j = (i + 1) % n
        f = bm.faces.new((vs[-1][i], vs[-1][j], tv))
        faces.append((f, [(i, rings[-1][0][1]), (i + 1, rings[-1][0][1]), (i + 0.5, tip[1])]))
    for f, uvs in faces:
        for loop, (iu, vv) in zip(f.loops, uvs):
            loop[uv].uv = (u0 + (u1 - u0) * (iu / n), min(max(vv, 0.01), 0.99))
    return [v for r in vs for v in r] + [tv]


def _frame(d, up):
    d = S.normalize(d)
    up = S.normalize(up - d * np.dot(up, d))
    return d, up, np.cross(d, up)


def _teeth(bm, uv, info, scale, rng, out):
    for tt in info['teeth']:
        row, n_ = tt['row'], S.normalize(tt['n'])
        lo, hi = A.TOOTH_ROWS[row][3]
        L = (lo + (hi - lo) * rng.rand()) * (0.45 + 0.55 * tt['taper'])
        jit = S.v3(0, 0, (rng.rand() - 0.5) * 0.45)
        if row == 0:
            d = S.normalize(n_ * 1.0 + S.v3(0, 0.55 + 0.25 * rng.rand(), 0) + jit)
            hook = S.v3(0, -0.20, 0)
        elif row == 1:
            d = S.normalize(n_ * 1.0 + S.v3(0, 0.12, 0) + jit)
            hook = S.v3(0, -0.35, 0)
        else:
            d = S.normalize(n_ * 0.8 + S.v3(0, -0.70, 0) + jit)
            hook = S.v3(0, -0.6, -0.1)
        broken = rng.rand() < (0.14 if row == 0 else 0.08)
        if broken:
            L *= 0.42 + 0.15 * rng.rand()
        r0 = (0.0019, 0.0016, 0.0014)[row] * (0.8 + 0.4 * rng.rand())
        sides = 5 if row == 0 else 4
        nring = 3 if row == 0 else 2
        base = tt['root'] - d * 0.0015
        ax, up, side = _frame(d, S.v3(0, 0, 1))
        var = int(rng.randint(VARIANTS))
        u0 = TOOTH_U[0] + (TOOTH_U[1] - TOOTH_U[0]) * var / VARIANTS
        u1 = u0 + (TOOTH_U[1] - TOOTH_U[0]) / VARIANTS
        rings = []
        for k in range(nring + 1):
            f = k / (nring + 1)
            c = base + d * L * f + hook * L * f * f
            r = r0 * (1 - f) ** 0.75
            ring = []
            for i in range(sides):
                a = 2 * math.pi * i / sides
                ring.append((c + (up * math.cos(a) * 1.15 + side * math.sin(a) * 0.80) * r, f * (0.75 if broken else 1.0)))
            rings.append(ring)
        tip = base + d * L + hook * L
        if broken:          # snapped: a jagged stump instead of a point
            tip = tip - d * r0 * 0.3 + up * r0 * 0.4
        verts = _loft(bm, uv, rings, (tip, 0.78 if broken else 1.0), u0, u1)
        out.append({'verts': verts, 'root': tt['root'] * scale, 'kind': 'tooth', 'len': L})


def _nails(bm, uv, info, scale, rng, out):
    for nl in info['nails']:
        toe = nl['toe']
        up = S.normalize(nl['up'])
        root, end = np.asarray(nl['root'], float), np.asarray(nl['end'], float)
        d0 = S.normalize(end - root)
        w = nl['w'] * (1.12 if not toe else 1.05)
        thumb = nl['finger'] == 'thumb'
        ext = (0.016 + 0.010 * rng.rand()) if toe else ((0.036 if thumb else 0.046) * (0.9 + 0.2 * rng.rand()))
        chipped = rng.rand() < 0.22
        if chipped:
            ext *= 0.55 + 0.2 * rng.rand()
        curl = (0.75 if not toe else 0.9) * (0.85 + 0.3 * rng.rand())
        # centerline: along the bed, then past the tip, curving toward the palm / floor
        ts = [0.0, 0.3, 0.62, 0.78, 0.9, 1.0] if not toe else [0.0, 0.35, 0.7, 1.0]
        bed = np.linalg.norm(end - root)
        total = bed + ext
        var = int(rng.randint(VARIANTS))
        u0 = NAIL_U[0] + (NAIL_U[1] - NAIL_U[0]) * var / VARIANTS
        u1 = u0 + (NAIL_U[1] - NAIL_U[0]) / VARIANTS
        rings = []
        pos = root + up * 0.0004
        dirc = d0
        prev_s = 0.0
        for t in ts:
            s_ = t * total
            step = s_ - prev_s
            if s_ > bed:
                ang = curl * (s_ - bed) / max(ext, 1e-6)
                dirc = S.normalize(d0 * math.cos(ang) - up * math.sin(ang))
            pos = pos + dirc * step
            prev_s = s_
            beyond = max(0.0, (s_ - bed) / max(ext, 1e-6))
            half = w * 0.5 * (1.0 - 0.85 * beyond ** 1.3) * (0.85 + 0.15 * min(1, t * 4))
            thick = (0.0025 if not toe else 0.0027) * (1 - 0.50 * beyond)
            ax, upc, sidec = _frame(dirc, up)
            ring = []
            for a in np.linspace(-1, 1, 5):                       # convex top arc
                ring.append((pos + sidec * a * half + upc * (thick * 0.5 + 0.35 * half * (1 - a * a)), t))
            for a in (0.6, 0.0, -0.6):                            # flatter underside
                ring.append((pos + sidec * a * half * 0.92 + upc * (-thick * 0.5 + 0.12 * half * (1 - a * a)), t))
            rings.append(ring)
        tip = pos + dirc * (w * 0.25)
        if chipped:
            tip = tip - dirc * w * 0.15 + (sidec * (w * 0.25))
        verts = _loft(bm, uv, rings, (tip, 1.0), u0, u1)
        out.append({'verts': verts, 'root': root * scale, 'kind': 'nail', 'len': total})


def make(J, SCALE, info):
    """Build the keratin object (meters). Returns (object, roots) where roots is a list of
    (vertex indices, root point) used to bind each piece rigidly to the skin it grows from."""
    import monster_skin as SKIN
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    rng = np.random.RandomState(5)
    pieces: list = []
    _teeth(bm, uv, info, SCALE, rng, pieces)
    _nails(bm, uv, info, SCALE, rng, pieces)
    for v in bm.verts:
        v.co = v.co * SCALE
    bm.verts.index_update()
    roots = [([v.index for v in p['verts']], p['root']) for p in pieces]
    # per-vertex engine masks: teeth translucent + wet, nails a little translucent at the tips
    nv = len(bm.verts)
    rgba = np.zeros((nv, 4))
    for p in pieces:
        for v in p['verts']:
            t = np.clip(np.linalg.norm(np.array(v.co[:]) - p['root']) / max(p['len'] * SCALE, 1e-6), 0, 1)
            if p['kind'] == 'tooth':
                rgba[v.index] = (0.35 + 0.25 * t, 0.70, 0.55 + 0.45 * t, 1.0)
            else:
                rgba[v.index] = (0.22 + 0.25 * t, 0.12, 0.85 + 0.15 * t, 1.0)
    me = bpy.data.meshes.new('monster_keratin')
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('monster_keratin', me)
    bpy.context.scene.collection.objects.link(ob)
    common.assign(ob, keratin_material())
    at = me.color_attributes.new(SKIN.COLOR_ATTR, 'FLOAT_COLOR', 'POINT')
    at.data.foreach_set('color', rgba.astype(np.float32).ravel())
    common.smooth(ob, 50)
    print(f'[monster_keratin] {sum(1 for p in pieces if p["kind"] == "tooth")} teeth, '
          f'{sum(1 for p in pieces if p["kind"] == "nail")} nails, {sum(len(p.vertices) - 2 for p in me.polygons)} tris')
    return ob, roots
