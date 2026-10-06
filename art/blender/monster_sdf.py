"""
Tiny signed-distance-field "sculpting" kit used by monster.py (pure numpy, no Blender needed).

The monster's high-res body is described as a program of SDF primitives (tapered capsules,
ellipsoids, spheres, custom membranes) combined with smooth unions / smooth subtractions, then
polygonized with naive Surface Nets on a sparse, tiled grid (only tiles near the surface are
evaluated), which gives a clean closed quad mesh with ~2-3 mm detail.

This is a helper module, not an asset: build() is a no-op so `npm run assets` can skip it.
"""

from __future__ import annotations

import math
import time

import numpy as np

F = np.float32


def build() -> None:  # helper module (art/build.py calls build() on every module)
    print('[monster_sdf] helper module, nothing to build')


# ---------------------------------------------------------------------------------------------
# small vector helpers
# ---------------------------------------------------------------------------------------------

def v3(x, y=None, z=None) -> np.ndarray:
    if y is None:
        return np.asarray(x, dtype=np.float64).reshape(3)
    return np.array([x, y, z], dtype=np.float64)


def normalize(v) -> np.ndarray:
    v = np.asarray(v, dtype=np.float64)
    return v / max(np.linalg.norm(v), 1e-12)


def frame_from(y_axis, z_hint) -> np.ndarray:
    """3x3 rotation whose columns are (x, y, z) with y along y_axis and z as close to z_hint."""
    y = normalize(y_axis)
    z = np.asarray(z_hint, dtype=np.float64)
    z = normalize(z - y * np.dot(z, y))
    x = np.cross(y, z)
    return np.stack([x, y, z], axis=1)


def rot(axis, angle) -> np.ndarray:
    a = normalize(axis)
    c, s = math.cos(angle), math.sin(angle)
    x, y, z = a
    return np.array([
        [c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
        [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
        [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)],
    ])


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------------------------------------
# noise (vectorized Perlin)
# ---------------------------------------------------------------------------------------------

_rs = np.random.RandomState(1337)
_PERM = _rs.permutation(256).astype(np.int64)
_PERM = np.concatenate([_PERM, _PERM])
_GRAD = np.array([[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1],
                  [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]], dtype=F)


def perlin(p: np.ndarray) -> np.ndarray:
    """Classic 3D gradient noise, roughly in [-1, 1]. p: (N, 3)."""
    p = np.asarray(p, dtype=np.float64)
    pi = np.floor(p)
    f = (p - pi).astype(F)
    pi = pi.astype(np.int64) & 255
    u = f * f * f * (f * (f * 6 - 15) + 10)
    X, Y, Z = pi[:, 0], pi[:, 1], pi[:, 2]
    P = _PERM
    A = P[X] + Y
    AA = P[A] + Z
    AB = P[A + 1] + Z
    B = P[X + 1] + Y
    BA = P[B] + Z
    BB = P[B + 1] + Z
    x, y, z = f[:, 0], f[:, 1], f[:, 2]

    def g(h, gx, gy, gz):
        gr = _GRAD[P[h] % 12]
        return gr[:, 0] * gx + gr[:, 1] * gy + gr[:, 2] * gz

    n000 = g(AA, x, y, z)
    n100 = g(BA, x - 1, y, z)
    n010 = g(AB, x, y - 1, z)
    n110 = g(BB, x - 1, y - 1, z)
    n001 = g(AA + 1, x, y, z - 1)
    n101 = g(BA + 1, x - 1, y, z - 1)
    n011 = g(AB + 1, x, y - 1, z - 1)
    n111 = g(BB + 1, x - 1, y - 1, z - 1)
    ux, uy, uz = u[:, 0], u[:, 1], u[:, 2]
    nx00 = n000 + ux * (n100 - n000)
    nx10 = n010 + ux * (n110 - n010)
    nx01 = n001 + ux * (n101 - n001)
    nx11 = n011 + ux * (n111 - n011)
    nxy0 = nx00 + uy * (nx10 - nx00)
    nxy1 = nx01 + uy * (nx11 - nx01)
    return nxy0 + uz * (nxy1 - nxy0)


def fbm(p: np.ndarray, octaves: int = 3, lac: float = 2.03, gain: float = 0.5, seed: float = 0.0) -> np.ndarray:
    p = np.asarray(p, dtype=np.float64) + seed * 17.13
    out = np.zeros(len(p), dtype=F)
    amp, tot = 1.0, 0.0
    for i in range(octaves):
        out += amp * perlin(p + i * 31.7)
        tot += amp
        p = p * lac
        amp *= gain
    return out / tot


# ---------------------------------------------------------------------------------------------
# primitives: each has .bbox (lo, hi) and .eval(p) -> distance
# ---------------------------------------------------------------------------------------------

class Prim:
    lo: np.ndarray
    hi: np.ndarray

    def eval(self, p: np.ndarray) -> np.ndarray:
        raise NotImplementedError


class Sphere(Prim):
    def __init__(self, c, r):
        self.c = v3(c).astype(F)
        self.r = float(r)
        self.lo = self.c - self.r
        self.hi = self.c + self.r

    def eval(self, p):
        return np.sqrt(((p - self.c) ** 2).sum(1)) - self.r


class RoundCone(Prim):
    """Tapered capsule from a (radius ra) to b (radius rb) - iq's exact sdRoundCone."""

    def __init__(self, a, b, ra, rb=None):
        rb = ra if rb is None else rb
        self.a = v3(a).astype(F)
        self.b = v3(b).astype(F)
        self.ra, self.rb = float(ra), float(rb)
        self.lo = np.minimum(self.a - self.ra, self.b - self.rb)
        self.hi = np.maximum(self.a + self.ra, self.b + self.rb)
        ba = (self.b - self.a).astype(np.float64)
        self.ba = ba.astype(F)
        self.l2 = float(np.dot(ba, ba))
        self.rr = self.ra - self.rb
        self.a2 = self.l2 - self.rr * self.rr
        self.il2 = 1.0 / max(self.l2, 1e-12)

    def eval(self, p):
        pa = p - self.a
        y = pa @ self.ba
        z = y - self.l2
        x = pa * self.l2 - y[:, None] * self.ba
        x2 = (x * x).sum(1)
        y2 = y * y * self.l2
        z2 = z * z * self.l2
        k = math.copysign(1.0, self.rr) * self.rr * self.rr * x2
        if self.a2 <= 0:  # one sphere contains the other
            return np.minimum(np.sqrt(((p - self.a) ** 2).sum(1)) - self.ra,
                              np.sqrt(((p - self.b) ** 2).sum(1)) - self.rb)
        d_mid = (np.sqrt(x2 * self.a2 * self.il2) + y * self.rr) * self.il2 - self.ra
        d_b = np.sqrt(x2 + z2) * self.il2 - self.rb
        d_a = np.sqrt(x2 + y2) * self.il2 - self.ra
        return np.where(np.sign(z) * self.a2 * z2 > k, d_b, np.where(np.sign(y) * self.a2 * y2 < k, d_a, d_mid))


class Ellipsoid(Prim):
    """Ellipsoid with semi-axes r along the columns of R (approximate distance, iq's bound)."""

    def __init__(self, c, r, R=None):
        self.c = v3(c).astype(F)
        self.r = v3(r).astype(F)
        self.R = (np.eye(3) if R is None else np.asarray(R, dtype=np.float64)).astype(F)
        ext = np.sqrt(((self.R * self.r[None, :]) ** 2).sum(1))
        self.lo = self.c - ext
        self.hi = self.c + ext

    def eval(self, p):
        q = (p - self.c) @ self.R
        k0 = np.sqrt(((q / self.r) ** 2).sum(1))
        k1 = np.sqrt(((q / (self.r * self.r)) ** 2).sum(1))
        return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


class Torus(Prim):
    def __init__(self, c, axis, R, r):
        self.c = v3(c).astype(F)
        self.M = frame_from(axis, np.cross(axis, [0.3, 0.5, 0.8]) + 1e-3).astype(F)  # y = axis
        self.R, self.r = float(R), float(r)
        e = self.R + self.r
        self.lo, self.hi = self.c - e, self.c + e

    def eval(self, p):
        q = (p - self.c) @ self.M
        rad = np.sqrt(q[:, 0] ** 2 + q[:, 2] ** 2) - self.R
        return np.sqrt(rad * rad + q[:, 1] ** 2) - self.r


class Func(Prim):
    """Arbitrary distance function with an explicit bounding box."""

    def __init__(self, fn, lo, hi):
        self.fn = fn
        self.lo, self.hi = v3(lo).astype(F), v3(hi).astype(F)

    def eval(self, p):
        return self.fn(p).astype(F)


def tube(points, radii, k=0.004):
    """Smooth chain of round cones through `points` with per-point radii."""
    g = Group()
    for i in range(len(points) - 1):
        g.union(RoundCone(points[i], points[i + 1], radii[i], radii[i + 1]), k=k)
    return g


# ---------------------------------------------------------------------------------------------
# SDF program
# ---------------------------------------------------------------------------------------------

def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1 - h) + a * h - k * h * (1 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


class Group(Prim):
    """A sub-program (its own unions/subtractions) usable as a single primitive."""

    FAR = 1.0

    def __init__(self, label: int = -1):
        self.ops: list = []
        self.label = label
        self.lo = np.full(3, 1e9)
        self.hi = np.full(3, -1e9)
        self.post = None  # optional fn(p, d) -> d applied after all ops (e.g. noise)
        self.post_margin = 0.0

    def _grow(self, prim, k):
        m = k + 0.002
        self.lo = np.minimum(self.lo, prim.lo - m)
        self.hi = np.maximum(self.hi, prim.hi + m)

    def union(self, prim, k=0.0, label=None):
        lab = label if label is not None else getattr(prim, 'label', -1)
        self.ops.append(('u', prim, float(k), lab))
        self._grow(prim, k)
        return prim

    def sub(self, prim, k=0.0):
        self.ops.append(('s', prim, float(k), -1))
        return prim

    def inter(self, prim, k=0.0):
        self.ops.append(('i', prim, float(k), -1))
        return prim

    def displace(self, fn, lo, hi, band=0.01):
        """d += fn(p) for points inside [lo, hi] that are within `band` of the surface."""
        f = Func(fn, lo, hi)
        f.band = band
        self.ops.append(('d', f, 0.0, -1))

    def eval(self, p, want_label=False, exact=False):
        n = len(p)
        d = np.full(n, self.FAR, dtype=F)
        lab = np.full(n, self.label, dtype=np.int16) if want_label else None
        plo = p.min(0) if n else np.zeros(3)
        phi = p.max(0) if n else np.zeros(3)
        for kind, prim, k, plab in self.ops:
            if not exact and kind != 'd':
                if (prim.hi + k + 0.003 < plo).any() or (prim.lo - k - 0.003 > phi).any():
                    continue
            if kind == 'd':
                lo = prim.lo
                hi = prim.hi
                m = np.all((p >= lo) & (p <= hi), axis=1) & (np.abs(d) < prim.band)
            elif exact:
                m = np.ones(n, bool)
            else:
                lo = prim.lo - k - 0.003
                hi = prim.hi + k + 0.003
                m = np.all((p >= lo) & (p <= hi), axis=1)
            if not m.any():
                continue
            idx = None if m.all() else np.nonzero(m)[0]
            pp = p if idx is None else p[idx]
            dd = d if idx is None else d[idx]
            if kind == 'd':
                res = dd + prim.eval(pp)
            else:
                if isinstance(prim, Group):
                    if want_label:
                        dp, lp = prim.eval(pp, True, exact)
                    else:
                        dp = prim.eval(pp, False, exact)
                else:
                    dp = prim.eval(pp).astype(F)
                if kind == 'u':
                    res = smin(dd, dp, k)
                    if want_label:
                        win = dp < dd
                        if isinstance(prim, Group) and prim.label < 0:
                            newlab = lp
                        else:
                            newlab = np.full(len(pp), plab if plab >= 0 else self.label, dtype=np.int16)
                        if idx is None:
                            lab = np.where(win, newlab, lab)
                        else:
                            lab[idx] = np.where(win, newlab, lab[idx])
                elif kind == 's':
                    res = smax(dd, -dp, k)
                else:
                    res = smax(dd, dp, k)
            if idx is None:
                d = res.astype(F)
            else:
                d[idx] = res
        if self.post is not None:
            d = self.post(p, d).astype(F)
        if want_label:
            return d, lab
        return d


# ---------------------------------------------------------------------------------------------
# Surface nets on a sparse tiled grid
# ---------------------------------------------------------------------------------------------

_CORNERS = np.array([[x, y, z] for x in (0, 1) for y in (0, 1) for z in (0, 1)], dtype=np.int64)
_EDGES = []
for _i in range(8):
    for _j in range(_i + 1, 8):
        if np.abs(_CORNERS[_i] - _CORNERS[_j]).sum() == 1:
            _EDGES.append((_i, _j))
_EDGES = np.array(_EDGES)


def polygonize(sdf: Group, lo, hi, h: float, tile: int = 32, verbose: bool = True):
    """
    Surface-nets mesh of {sdf < 0} inside [lo, hi] at voxel size h.
    Returns (verts (V,3) float64, quads (Q,4) int64) with outward-facing winding.
    """
    t0 = time.time()
    lo = np.asarray(lo, dtype=np.float64) - 2 * h
    hi = np.asarray(hi, dtype=np.float64) + 2 * h
    ncell = np.ceil((hi - lo) / h).astype(np.int64)
    ntile = np.ceil(ncell / tile).astype(np.int64)
    ncell = ntile * tile
    NCY, NCZ = int(ncell[1]), int(ncell[2])

    # cull tiles with the distance at their centers
    ti = np.stack(np.meshgrid(np.arange(ntile[0]), np.arange(ntile[1]), np.arange(ntile[2]), indexing='ij'), -1).reshape(-1, 3)
    centers = lo + (ti + 0.5) * tile * h
    dc = np.empty(len(centers), dtype=F)
    for s in range(0, len(centers), 200000):
        dc[s:s + 200000] = sdf.eval(centers[s:s + 200000].astype(F), exact=True)
    radius = math.sqrt(3) * tile * h / 2
    keep = np.abs(dc) < radius * 1.35 + 0.012
    tiles = ti[keep]
    if verbose:
        print(f'[sdf] grid {ncell.tolist()} cells, {len(tiles)}/{len(ti)} tiles near surface')

    global _JOB
    _JOB = (sdf, lo, h, tile, NCY, NCZ)
    workers = int(__import__('os').environ.get('MONSTER_WORKERS', '3'))
    chunks = [tiles[i::workers * 4] for i in range(workers * 4)]
    if workers > 1:
        import multiprocessing as mp
        with mp.get_context('fork').Pool(workers) as pool:
            res = pool.map(_tiles_job, chunks)
    else:
        res = [_tiles_job(c) for c in chunks]
    all_v = [r[0] for r in res if len(r[0])]
    all_id = [r[1] for r in res if len(r[1])]
    all_q = [r[2] for r in res if len(r[2])]
    return _assemble(all_v, all_id, all_q, verbose, t0)


_JOB = None


def _tiles_job(tiles):
    sdf, lo, h, tile, NCY, NCZ = _JOB
    n = tile + 3
    ar = np.arange(n, dtype=np.float64)
    all_v, all_id, all_q = [], [], []
    for (tx, ty, tz) in tiles:
        start = np.array([tx, ty, tz], dtype=np.int64) * tile  # first owned cell / grid point
        gofs = start - 1
        base = lo + gofs * h
        gx = base[0] + ar * h
        gy = base[1] + ar * h
        gz = base[2] + ar * h
        P = np.stack(np.meshgrid(gx, gy, gz, indexing='ij'), -1).reshape(-1, 3).astype(F)
        Fv = sdf.eval(P).reshape(n, n, n)
        ins = Fv < 0
        T = tile
        # owned cells local [1, T+1)
        cin = np.stack([ins[1 + dx:1 + dx + T, 1 + dy:1 + dy + T, 1 + dz:1 + dz + T] for dx, dy, dz in _CORNERS], 0)
        anyin = cin.any(0)
        allin = cin.all(0)
        act = anyin & ~allin
        if not act.any():
            continue
        ci, cj, ck = np.nonzero(act)
        cv = np.stack([Fv[1 + dx + ci, 1 + dy + cj, 1 + dz + ck] for dx, dy, dz in _CORNERS], 1).astype(np.float64)
        acc = np.zeros((len(ci), 3))
        cnt = np.zeros(len(ci))
        for a, b in _EDGES:
            va, vb = cv[:, a], cv[:, b]
            m = (va < 0) != (vb < 0)
            if not m.any():
                continue
            t = va[m] / (va[m] - vb[m])
            pos = _CORNERS[a] + t[:, None] * (_CORNERS[b] - _CORNERS[a])
            acc[m] += pos
            cnt[m] += 1
        off = acc / cnt[:, None]
        gc = np.stack([ci, cj, ck], 1) + start
        verts = lo + (gc + off) * h
        ids = (gc[:, 0] * NCY + gc[:, 1]) * NCZ + gc[:, 2]
        all_v.append(verts)
        all_id.append(ids)

        # faces for owned edges: lower grid point local l in [1, T+1)
        L = slice(1, T + 1)
        def cid(i, j, k):
            return (i * NCY + j) * NCZ + k
        # x edges
        e0 = ins[1:T + 1, 1:T + 1, 1:T + 1]
        for axis in range(3):
            if axis == 0:
                e1 = ins[2:T + 2, 1:T + 1, 1:T + 1]
            elif axis == 1:
                e1 = ins[1:T + 1, 2:T + 2, 1:T + 1]
            else:
                e1 = ins[1:T + 1, 1:T + 1, 2:T + 2]
            m = e0 != e1
            if not m.any():
                continue
            li, lj, lk = np.nonzero(m)
            gi, gj, gk = li + start[0], lj + start[1], lk + start[2]
            inner_low = e0[li, lj, lk]
            if axis == 0:
                q = np.stack([cid(gi, gj - 1, gk - 1), cid(gi, gj, gk - 1), cid(gi, gj, gk), cid(gi, gj - 1, gk)], 1)
            elif axis == 1:
                q = np.stack([cid(gi - 1, gj, gk - 1), cid(gi - 1, gj, gk), cid(gi, gj, gk), cid(gi, gj, gk - 1)], 1)
            else:
                q = np.stack([cid(gi - 1, gj - 1, gk), cid(gi, gj - 1, gk), cid(gi, gj, gk), cid(gi - 1, gj, gk)], 1)
            q[~inner_low] = q[~inner_low][:, ::-1]
            all_q.append(q)
    if not all_v:
        return np.zeros((0, 3)), np.zeros(0, np.int64), np.zeros((0, 4), np.int64)
    return np.concatenate(all_v), np.concatenate(all_id), (np.concatenate(all_q) if all_q else np.zeros((0, 4), np.int64))


def _assemble(all_v, all_id, all_q, verbose, t0):
    V = np.concatenate(all_v)
    ID = np.concatenate(all_id)
    Q = np.concatenate(all_q)
    order = np.argsort(ID)
    IDs = ID[order]
    pos = np.searchsorted(IDs, Q)
    pos = np.clip(pos, 0, len(IDs) - 1)
    ok = (IDs[pos] == Q).all(1)
    if verbose and (~ok).sum():
        print(f'[sdf] dropped {(~ok).sum()} dangling quads')
    Qi = order[pos[ok]]
    # drop unreferenced vertices
    used = np.zeros(len(V), bool)
    used[Qi.ravel()] = True
    remap = np.cumsum(used) - 1
    V = V[used]
    Qi = remap[Qi]
    if verbose:
        print(f'[sdf] surface nets: {len(V)} verts, {len(Qi)} quads in {time.time() - t0:.1f}s')
    return V, Qi


def taubin(V: np.ndarray, Q: np.ndarray, iters: int = 2, lam: float = 0.5, mu: float = -0.53) -> np.ndarray:
    """Shrink-free smoothing over the quad mesh graph."""
    E = np.concatenate([Q[:, [0, 1]], Q[:, [1, 2]], Q[:, [2, 3]], Q[:, [3, 0]]])
    E = np.unique(np.sort(E, 1), axis=0)
    E = np.concatenate([E, E[:, ::-1]])
    nv = len(V)
    deg = np.bincount(E[:, 0], minlength=nv).astype(np.float64)
    V = V.copy()
    for _ in range(iters):
        for f in (lam, mu):
            avg = np.stack([np.bincount(E[:, 0], weights=V[E[:, 1], c], minlength=nv) for c in range(3)], 1)
            avg /= np.maximum(deg, 1)[:, None]
            V = V + f * (avg - V)
    return V


# ---------------------------------------------------------------------------------------------
# surface queries (for placing bones/tendons/pits relative to the actual skin surface)
# ---------------------------------------------------------------------------------------------

def gradient(g: Prim, p: np.ndarray, eps: float = 4e-4) -> np.ndarray:
    E = np.eye(3) * eps
    cols = []
    for i in range(3):
        a = g.eval((p + E[i]).astype(F), exact=True) if isinstance(g, Group) else g.eval((p + E[i]).astype(F))
        b = g.eval((p - E[i]).astype(F), exact=True) if isinstance(g, Group) else g.eval((p - E[i]).astype(F))
        cols.append((a.astype(np.float64) - b) / (2 * eps))
    return np.stack(cols, 1)


def project(g: Prim, pts, iters: int = 10):
    """Newton-project points onto g's zero surface. Returns (points, unit outward normals)."""
    p = np.array(pts, dtype=np.float64).reshape(-1, 3)
    for _ in range(iters):
        d = (g.eval(p.astype(F), exact=True) if isinstance(g, Group) else g.eval(p.astype(F))).astype(np.float64)
        gr = gradient(g, p)
        gl2 = np.maximum((gr ** 2).sum(1), 1e-4)
        step = (d / gl2)[:, None] * gr
        n = np.linalg.norm(step, axis=1, keepdims=True)
        step = np.where(n > 0.02, step / np.maximum(n, 1e-9) * 0.02, step)
        p = p - step
    gr = gradient(g, p)
    nrm = gr / np.maximum(np.linalg.norm(gr, axis=1, keepdims=True), 1e-9)
    return p, nrm


def raycast(g: Prim, origin, direction, max_t: float = 0.4, steps: int = 800):
    """First inside->outside crossing along a ray that starts inside g. Returns (point, normal)."""
    o = np.asarray(origin, float)
    dvec = np.asarray(direction, float)
    dvec = dvec / np.linalg.norm(dvec)
    ts = np.linspace(0, max_t, steps)
    P = o + ts[:, None] * dvec
    d = g.eval(P.astype(F), exact=True) if isinstance(g, Group) else g.eval(P.astype(F))
    idx = np.nonzero((d[:-1] < 0) & (d[1:] >= 0))[0]
    if len(idx) == 0:
        i = int(np.argmin(np.abs(d)))
        p = P[i]
    else:
        i = idx[0]
        t = ts[i] + (ts[i + 1] - ts[i]) * (-d[i]) / (d[i + 1] - d[i])
        p = o + dvec * t
    p, n = project(g, [p], iters=3)
    return p[0], n[0]
