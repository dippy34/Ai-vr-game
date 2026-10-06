"""
Texel-space texture authoring for skinned characters (used by hands.py / avatar.py).

Instead of sculpting a multi-million-poly high-res mesh, every texel of the low-poly's UV layout is
baked to its 3D position + smooth normal (Cycles POSITION / NORMAL bakes). Analytic "sculpt"
functions (numpy) then give a height, albedo and roughness per texel; the height gradient is
turned into an object-space normal, which Cycles converts into a MikkTSpace tangent-space normal
map (exactly what glTF / three.js expect).
"""

from __future__ import annotations

import bpy
import numpy as np

import common
import hands_util as hu


# ---------------------------------------------------------------------------------------------
# Baking helpers
# ---------------------------------------------------------------------------------------------

def _bake_material(name: str):
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    return mat


def _set_target(mat, img):
    nt = mat.node_tree
    node = nt.nodes.get('__bake_target__') or nt.nodes.new('ShaderNodeTexImage')
    node.name = '__bake_target__'
    node.image = img
    for n in nt.nodes:
        n.select = False
    node.select = True
    nt.nodes.active = node


def bake_to_array(ob, size: int, bake_type: str, mat, margin: int = 0, **kw) -> np.ndarray:
    img = bpy.data.images.new(f'__bake_{bake_type}', size, size, alpha=True, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    img.generated_color = (0, 0, 0, 0)
    old = list(ob.data.materials)
    common.assign(ob, mat)
    _set_target(mat, img)
    common.activate(ob)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = kw.pop('samples', 1)
    bpy.ops.object.bake(type=bake_type, margin=margin, use_clear=True, **kw)
    arr = hu.image_to_np(img).copy()
    bpy.data.images.remove(img)
    ob.data.materials.clear()
    for m in old:
        ob.data.materials.append(m)
    return arr


def emission_attr_material(attr: str):
    mat = _bake_material(f'__emit_{attr}')
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    at = nt.nodes.new('ShaderNodeAttribute')
    at.attribute_name = attr
    nt.links.new(at.outputs['Color'], em.inputs['Color'])
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return mat


def texel_data(ob, size: int, region_attr: str | None = None) -> dict[str, np.ndarray]:
    """Per-texel object-space position, smooth normal, coverage mask (+ a baked color attribute)."""
    plain = common.material('__plain')
    pos = bake_to_array(ob, size, 'POSITION', plain, margin=0)
    nrm = bake_to_array(ob, size, 'NORMAL', plain, margin=0, normal_space='OBJECT')
    # coverage: emit white with no margin
    if 'cover' not in ob.data.color_attributes:
        ca = ob.data.color_attributes.new('cover', 'FLOAT_COLOR', 'POINT')
        for d in ca.data:
            d.color = (1, 1, 1, 1)
    cov = bake_to_array(ob, size, 'EMIT', emission_attr_material('cover'), margin=0)
    out = {
        'P': pos[..., :3],
        'N': nrm[..., :3] * 2 - 1,
        'mask': cov[..., 0] > 0.5,
    }
    if region_attr:
        out['region'] = bake_to_array(ob, size, 'EMIT', emission_attr_material(region_attr), margin=0)[..., :3]
    n = out['N']
    ln = np.linalg.norm(n, axis=-1, keepdims=True)
    out['N'] = n / np.maximum(ln, 1e-6)
    return out


def dilate(arr: np.ndarray, mask: np.ndarray, iters: int = 12) -> np.ndarray:
    """Grow valid texels into the empty margin (repeated 4-neighbour averaging)."""
    a = arr.copy()
    m = mask.copy()
    for _ in range(iters):
        acc = np.zeros_like(a)
        cnt = np.zeros(m.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            sm = np.roll(np.roll(m, dy, 0), dx, 1)
            sa = np.roll(np.roll(a, dy, 0), dx, 1)
            acc += sa * sm[..., None] if a.ndim == 3 else sa * sm
            cnt += sm
        grow = (~m) & (cnt > 0)
        if a.ndim == 3:
            a[grow] = acc[grow] / cnt[grow][:, None]
        else:
            a[grow] = acc[grow] / cnt[grow]
        m = m | grow
    return a


def height_to_object_normal(H: np.ndarray, P: np.ndarray, N: np.ndarray, mask: np.ndarray,
                            max_step: float) -> np.ndarray:
    """Perturb the smooth normals by the surface gradient of the height field (meters)."""
    def diff(A, axis):
        fwd = np.roll(A, -1, axis)
        bwd = np.roll(A, 1, axis)
        mf = np.roll(mask, -1, axis)
        mb = np.roll(mask, 1, axis)
        return fwd, bwd, mf, mb

    grads = []
    for axis in (1, 0):  # u (x / columns), v (y / rows)
        Pf, Pb, mf, mb = diff(P, axis)
        Hf, Hb, _, _ = diff(H, axis)
        # same island test: neighbours further than max_step in 3D are across a seam
        okf = mf & (np.linalg.norm(Pf - P, axis=-1) < max_step)
        okb = mb & (np.linalg.norm(Pb - P, axis=-1) < max_step)
        both = okf & okb
        dP = np.zeros_like(P)
        dH = np.zeros_like(H)
        dP[both] = (Pf[both] - Pb[both]) * 0.5
        dH[both] = (Hf[both] - Hb[both]) * 0.5
        of = okf & ~okb
        dP[of] = Pf[of] - P[of]
        dH[of] = Hf[of] - H[of]
        ob = okb & ~okf
        dP[ob] = P[ob] - Pb[ob]
        dH[ob] = H[ob] - Hb[ob]
        grads.append((dP, dH))
    (Pu, Hu), (Pv, Hv) = grads
    a = np.sum(Pu * Pu, -1)
    b = np.sum(Pu * Pv, -1)
    c = np.sum(Pv * Pv, -1)
    det = a * c - b * b
    ok = det > 1e-16
    inv = np.where(ok, 1.0 / np.where(ok, det, 1), 0)
    alpha = (c * Hu - b * Hv) * inv
    beta = (-b * Hu + a * Hv) * inv
    g = alpha[..., None] * Pu + beta[..., None] * Pv
    g -= N * np.sum(g * N, -1, keepdims=True)
    n2 = N - g
    n2 /= np.maximum(np.linalg.norm(n2, axis=-1, keepdims=True), 1e-8)
    n2[~mask] = N[~mask]
    return n2


def bake_tangent_normal(ob, obj_normal: np.ndarray, size: int, name: str, margin: int = 8) -> bpy.types.Image:
    """Object-space normal image -> MikkTSpace tangent-space normal map (Cycles does the basis)."""
    src = hu.np_to_image(f'{name}_objn', obj_normal * 0.5 + 0.5, non_color=True, float_buffer=True)
    mat = _bake_material(f'__objn_{name}')
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = src
    tex.interpolation = 'Closest'
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nm.space = 'OBJECT'
    nt.links.new(tex.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    out = bake_to_array(ob, size, 'NORMAL', mat, margin=margin, normal_space='TANGENT')
    img = hu.np_to_image(f'{name}_normal', out[..., :3], non_color=True)
    bpy.data.images.remove(src)
    return img


# ---------------------------------------------------------------------------------------------
# Noise (vectorised value noise / fbm)
# ---------------------------------------------------------------------------------------------

_rs = np.random.RandomState(1234)
_PERM = np.concatenate([_rs.permutation(256)] * 2).astype(np.int64)
_VALS = _rs.uniform(-1, 1, 256)


def vnoise(p: np.ndarray) -> np.ndarray:
    """3D value noise in [-1, 1], smooth (quintic), p: (..., 3)."""
    pi = np.floor(p).astype(np.int64)
    f = p - pi
    w = f * f * f * (f * (f * 6 - 15) + 10)
    x0, y0, z0 = pi[..., 0] & 255, pi[..., 1] & 255, pi[..., 2] & 255
    x1, y1, z1 = (x0 + 1) & 255, (y0 + 1) & 255, (z0 + 1) & 255

    def h(x, y, z):
        return _VALS[_PERM[_PERM[_PERM[x] + y] + z] & 255]

    wx, wy, wz = w[..., 0], w[..., 1], w[..., 2]
    c00 = h(x0, y0, z0) * (1 - wx) + h(x1, y0, z0) * wx
    c10 = h(x0, y1, z0) * (1 - wx) + h(x1, y1, z0) * wx
    c01 = h(x0, y0, z1) * (1 - wx) + h(x1, y0, z1) * wx
    c11 = h(x0, y1, z1) * (1 - wx) + h(x1, y1, z1) * wx
    c0 = c00 * (1 - wy) + c10 * wy
    c1 = c01 * (1 - wy) + c11 * wy
    return c0 * (1 - wz) + c1 * wz


def fbm(p: np.ndarray, octaves: int = 4, lac: float = 2.03, gain: float = 0.5) -> np.ndarray:
    tot = np.zeros(p.shape[:-1])
    amp = 1.0
    norm = 0.0
    q = p
    for i in range(octaves):
        tot += amp * vnoise(q + i * 17.31)
        norm += amp
        amp *= gain
        q = q * lac
    return tot / norm


def ridged(p: np.ndarray, octaves: int = 3) -> np.ndarray:
    """0..1, sharp creases where the noise crosses zero (cell-like skin lines)."""
    tot = np.zeros(p.shape[:-1])
    amp = 1.0
    norm = 0.0
    q = p
    for i in range(octaves):
        tot += amp * (1 - np.abs(vnoise(q + i * 9.7)))
        norm += amp
        amp *= 0.5
        q = q * 2.1
    return tot / norm


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def srgb_to_lin(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def seg_dist2d(px, py, pts) -> tuple[np.ndarray, np.ndarray]:
    """Distance from points to a 2D polyline + normalised arc position (0..1) of the closest point."""
    pts = np.asarray(pts, dtype=np.float64)
    best = np.full(px.shape, 1e9)
    arc = np.zeros(px.shape)
    seglen = np.linalg.norm(pts[1:] - pts[:-1], axis=1)
    cum = np.concatenate([[0], np.cumsum(seglen)])
    total = cum[-1]
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = np.clip(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1)
        qx, qy = ax + t * dx, ay + t * dy
        d = np.hypot(px - qx, py - qy)
        better = d < best
        best = np.where(better, d, best)
        arc = np.where(better, (cum[i] + t * seglen[i]) / total, arc)
    return best, arc


def build() -> None:
    """Helper module (imported by hands.py / avatar.py): nothing to build on its own."""
