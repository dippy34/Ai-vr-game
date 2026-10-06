"""
Player body geometry (avatar_body.glb): worn field jacket with a stand-up collar, the hood of a
hoodie bunched behind the neck, upper-arm sleeve stubs, backpack + shoulder straps with a
sternum strap, and reflective tape bands (the `tint` node).

Blender space, meters: origin = neck base, front = +Y, +Z up, the avatar's right on +X.
Static meshes (the renderer hangs the body under the head).
"""

from __future__ import annotations

import math

import numpy as np

# torso sections: z, half-width, front depth, back depth (jacket over clothing)
TORSO = [
    (0.012, 0.076, 0.062, 0.080),
    (-0.004, 0.098, 0.076, 0.094),
    (-0.022, 0.138, 0.090, 0.106),
    (-0.042, 0.170, 0.100, 0.112),
    (-0.066, 0.190, 0.109, 0.116),
    (-0.100, 0.193, 0.117, 0.119),
    (-0.145, 0.180, 0.124, 0.121),
    (-0.205, 0.170, 0.128, 0.120),
    (-0.280, 0.163, 0.124, 0.114),
    (-0.360, 0.155, 0.116, 0.107),
    (-0.440, 0.157, 0.113, 0.107),
    (-0.515, 0.164, 0.114, 0.110),
    (-0.540, 0.166, 0.116, 0.112),
    (-0.552, 0.158, 0.107, 0.104),
    (-0.548, 0.136, 0.086, 0.084),
]
SE = 2.12   # superellipse exponent of the torso sections
NT = 32     # torso ring resolution


def spe(t, n):
    return np.sign(t) * np.abs(t) ** (2.0 / n)


def section(z):
    zs = np.array([s[0] for s in TORSO[:-3]])[::-1]
    vals = np.array([s[1:] for s in TORSO[:-3]])[::-1]
    return [np.interp(z, zs, vals[:, i]) for i in range(3)]


def torso_ring(z, a, yf, yb, n=NT, off=0.0):
    phi = 2 * np.pi * np.arange(n) / n
    s, c = np.sin(phi), np.cos(phi)
    d = np.where(c > 0, yf, yb)
    x = (a + off) * spe(s, SE)
    y = (d + off) * spe(c, SE)
    return np.stack([x, y, np.full(n, z)], axis=1)


def torso_project(p, off=0.0):
    """Closest-ish point on the torso surface (same height), pushed `off` outward."""
    p = np.atleast_2d(p).astype(np.float64)
    out = np.empty_like(p)
    for i, q in enumerate(p):
        a, yf, yb = section(q[2])
        d = yf if q[1] > 0 else yb
        phi = math.atan2(q[0] / a, q[1] / d)
        s, c = math.sin(phi), math.cos(phi)
        x = a * spe(s, SE)
        y = d * spe(c, SE)
        # 2D outward normal of the superellipse (numerical)
        e = 1e-3
        x2 = a * spe(math.sin(phi + e), SE)
        y2 = (yf if math.cos(phi + e) > 0 else yb) * spe(math.cos(phi + e), SE)
        tx, ty = x2 - x, y2 - y
        nx, ny = ty, -tx
        ln = math.hypot(nx, ny) or 1
        nx, ny = nx / ln, ny / ln
        if nx * x + ny * y < 0:
            nx, ny = -nx, -ny
        out[i] = (x + nx * off, y + ny * off, q[2])
    return out


def quad_grid(rings, closed=True, offset=0):
    """rings: list of (n,3) arrays -> verts, faces (quads between consecutive rings)."""
    n = len(rings[0])
    verts = np.concatenate(rings, axis=0)
    faces = []
    for r in range(len(rings) - 1):
        for i in range(n if closed else n - 1):
            j = (i + 1) % n
            faces.append((offset + r * n + i, offset + r * n + j, offset + (r + 1) * n + j, offset + (r + 1) * n + i))
    return verts, faces


class MeshBuilder:
    def __init__(self):
        self.verts: list[np.ndarray] = []
        self.faces: list[tuple] = []
        self.part: list[int] = []      # per vertex part id
        self.n = 0

    def add(self, verts, faces, part):
        verts = np.asarray(verts, dtype=np.float64)
        self.verts.append(verts)
        self.faces.extend(tuple(self.n + i for i in f) for f in faces)
        self.part.extend([part] * len(verts))
        self.n += len(verts)

    def arrays(self):
        return np.concatenate(self.verts, axis=0), self.faces, np.array(self.part)


PART_JACKET, PART_HOOD, PART_STRAP, PART_PACK, PART_INNER, PART_BUCKLE, PART_COLLAR, PART_SLEEVE = 0, 1, 2, 3, 4, 5, 6, 7


def torso(mb: MeshBuilder):
    rings = [torso_ring(*s) for s in TORSO]
    v, f = quad_grid(rings)
    base = mb.n
    mb.add(v, f, PART_JACKET)
    # mark the inner hem rows dark
    for k in range(len(TORSO) - 2, len(TORSO)):
        for i in range(NT):
            mb.part[base + k * NT + i] = PART_INNER
    # bottom cap
    c = np.array([[0.0, 0.0, TORSO[-1][0] + 0.01]])
    ci = mb.n
    mb.add(c, [], PART_INNER)
    last = base + (len(TORSO) - 1) * NT
    for i in range(NT):
        mb.faces.append((last + (i + 1) % NT, last + i, ci))


ARM_TOP = np.array([0.158, 0.004, -0.062])
ARM_DIR = np.array([0.13, 0.10, -1.0]) / np.linalg.norm([0.13, 0.10, -1.0])
ARM_LEN = 0.265
ARM_ST = [0.0, 0.10, 0.25, 0.42, 0.60, 0.76, 0.86, 0.93, 0.97, 0.955]
ARM_R = [0.048, 0.058, 0.0605, 0.059, 0.056, 0.0535, 0.0525, 0.0520, 0.0500, 0.0430]


def arm_frame(sx):
    d = ARM_DIR * np.array([sx, 1, 1])
    up = np.array([0, 1.0, 0])
    u = np.cross(d, up)
    u /= np.linalg.norm(u)
    w = np.cross(u, d)
    return d, u, w


def arms(mb: MeshBuilder, n=16):
    for sx in (-1, 1):
        top = ARM_TOP * np.array([sx, 1, 1])
        d, u, w = arm_frame(sx)
        rings = []
        for st, r in zip(ARM_ST, ARM_R):
            c = top + d * (st * ARM_LEN)
            phi = 2 * np.pi * np.arange(n) / n
            ring = c + np.outer(np.cos(phi) * r, u) + np.outer(np.sin(phi) * r * 1.08, w)
            rings.append(ring)
        v, f = quad_grid(rings)
        base = mb.n
        mb.add(v, f, PART_SLEEVE)
        for k in (len(rings) - 2, len(rings) - 1):
            for i in range(n):
                mb.part[base + k * n + i] = PART_INNER
        c = top + d * (ARM_ST[-1] * ARM_LEN - 0.006)
        ci = mb.n
        mb.add(c[None], [], PART_INNER)
        last = base + (len(rings) - 1) * n
        for i in range(n):
            mb.faces.append((last + i, last + (i + 1) % n, ci))


def collar(mb: MeshBuilder, n=32):
    """Stand-up jacket collar around the neck (zipped), slightly lower in front."""
    phi = 2 * np.pi * np.arange(n) / n
    c = np.cos(phi)

    def ring(r_x, r_y, z0, z_front_drop, yoff=-0.006):
        z = z0 - z_front_drop * np.clip(c, 0, 1) ** 1.5
        return np.stack([r_x * np.sin(phi), yoff + r_y * c, z], axis=1)

    rings = [
        ring(0.086, 0.086, -0.014, 0.004),   # base (outside)
        ring(0.079, 0.080, 0.034, 0.016),
        ring(0.080, 0.081, 0.068, 0.030),    # top fold (slight flare), zipped up under the chin
        ring(0.075, 0.076, 0.070, 0.030),
        ring(0.070, 0.071, 0.030, 0.016),    # inside
        ring(0.071, 0.072, -0.012, 0.004),
    ]
    v, f = quad_grid(rings)
    mb.add(v, f, PART_COLLAR)


def hood(mb: MeshBuilder, segs=14, n=12):
    """Hood bunched behind the neck: a soft, lumpy roll around the back of the collar."""
    rng = np.random.RandomState(5)
    rings = []
    for k in range(segs):
        t = k / (segs - 1)
        ang = math.radians(-118 + 236 * t)            # around the back of the neck
        R = 0.100 + 0.012 * math.cos(ang * 0.5)
        cen = np.array([R * math.sin(ang), -0.016 - R * math.cos(ang) * 1.0, -0.004 - 0.026 * abs(math.sin(ang)) ** 2])
        tang = np.array([math.cos(ang), math.sin(ang), 0.0])
        out = np.array([math.sin(ang), -math.cos(ang), 0.0])
        upv = np.cross(tang, out)
        rad = 0.046 * (0.50 + 0.50 * math.sin(math.pi * t) ** 0.6) * (1 + 0.08 * rng.randn())
        ring = []
        for i in range(n):
            ph = 2 * math.pi * i / n
            lump = 1 + 0.10 * math.sin(3 * ph + 4 * t) + 0.06 * rng.randn()
            q = cen + out * math.cos(ph) * rad * 1.15 * lump + upv * math.sin(ph) * rad * 0.85 * lump
            ring.append(q)
        # sit on the shoulders: never below the torso surface
        ring = np.array(ring)
        rings.append(ring)
    v, f = quad_grid(rings)
    mb.add(v, f, PART_HOOD)


def catmull(pts, n_out):
    pts = np.asarray(pts, dtype=np.float64)
    P = np.vstack([pts[0] * 2 - pts[1], pts, pts[-1] * 2 - pts[-2]])
    seg = len(pts) - 1
    out = []
    for i in range(n_out):
        t = i / (n_out - 1) * seg
        k = min(int(t), seg - 1)
        u = t - k
        p0, p1, p2, p3 = P[k], P[k + 1], P[k + 2], P[k + 3]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u ** 3))
    return np.array(out)


def ribbon(mb: MeshBuilder, path, normals, width, thick, part):
    """Flat strap along `path` with surface normals -> 4-sided tube (closed ends)."""
    n = len(path)
    rings = []
    for i in range(n):
        t = path[min(i + 1, n - 1)] - path[max(i - 1, 0)]
        t /= np.linalg.norm(t)
        nn = normals[i] - t * np.dot(normals[i], t)
        nn /= np.linalg.norm(nn)
        b = np.cross(t, nn)
        p = path[i]
        rings.append(np.array([p + b * width / 2 - nn * thick / 2, p + b * width / 2 + nn * thick / 2,
                               p - b * width / 2 + nn * thick / 2, p - b * width / 2 - nn * thick / 2]))
    v, f = quad_grid(rings)
    base = mb.n
    mb.add(v, f, part)
    last = base + (n - 1) * 4
    mb.faces.append((base + 3, base + 2, base + 1, base + 0))
    mb.faces.append((last + 0, last + 1, last + 2, last + 3))


def surface_normal(p):
    """Approximate torso normal at p (finite differences on the projection)."""
    q = torso_project(p, 0.0)[0]
    q2 = torso_project(p + np.array([0, 0, 0.004]), 0.0)[0]
    a, yf, yb = section(p[2])
    n2 = np.array([q[0] / a ** 2, q[1] / (yf if q[1] > 0 else yb) ** 2, 0.0])
    n2 /= np.linalg.norm(n2)
    vt = (q2 - q)
    vt /= np.linalg.norm(vt)
    n = n2 - vt * np.dot(n2, vt)
    return n / np.linalg.norm(n)


def straps(mb: MeshBuilder):
    for sx in (-1, 1):
        ctrl = [(0.068, -0.135, -0.105), (0.080, -0.104, -0.030), (0.090, -0.050, 0.004), (0.094, 0.020, 0.002),
                (0.098, 0.078, -0.040), (0.101, 0.118, -0.115), (0.108, 0.128, -0.200), (0.126, 0.118, -0.275),
                (0.152, 0.088, -0.330), (0.165, 0.040, -0.355)]
        ctrl = np.array(ctrl) * np.array([sx, 1, 1])
        path = catmull(ctrl, 22)
        # stick to the body surface with a small offset (front / sides) or on top of the hood (back)
        proj = []
        nrm = []
        for p in path:
            q = torso_project(p, 0.0075)[0]
            if p[2] > -0.03 and p[1] < 0.02:      # over the shoulder top / hood: keep designed height
                q = p.copy()
            nn = surface_normal(p)
            if p[2] > -0.02:
                nn = nn * 0.4 + np.array([0, 0, 1.0]) * 0.6
                nn /= np.linalg.norm(nn)
            proj.append(q)
            nrm.append(nn)
        ribbon(mb, np.array(proj), np.array(nrm), 0.050, 0.008, PART_STRAP)
    # sternum strap with a buckle
    pts = []
    nrm = []
    for x in np.linspace(-0.112, 0.112, 9):
        p = np.array([x, 0.12, -0.205])
        pts.append(torso_project(p, 0.0175)[0])
        nrm.append(surface_normal(p))
    ribbon(mb, np.array(pts), np.array(nrm), 0.020, 0.005, PART_STRAP)
    c = torso_project(np.array([0.0, 0.12, -0.205]), 0.0215)[0]
    box = np.array([[sx_ * 0.020, sy * 0.004, sz * 0.014] for sx_ in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]) + c
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    mb.add(box, faces, PART_BUCKLE)


def superellipsoid(center, half, e1=0.35, e2=0.35, nu=16, nv=12, part=PART_PACK, mb=None):
    center = np.asarray(center)
    half = np.asarray(half)
    verts = []
    for j in range(1, nv):
        v = -math.pi / 2 + math.pi * j / nv
        for i in range(nu):
            u = -math.pi + 2 * math.pi * i / nu
            cv, sv = math.cos(v), math.sin(v)
            cu, su = math.cos(u), math.sin(u)
            x = spe(cv, 2 / e1) * spe(cu, 2 / e2)
            y = spe(cv, 2 / e1) * spe(su, 2 / e2)
            zz = spe(sv, 2 / e1)
            verts.append(center + half * np.array([x, y, zz]))
    rings = [np.array(verts[k * nu:(k + 1) * nu]) for k in range(nv - 1)]
    v, f = quad_grid(rings)
    base = mb.n
    bot = np.array([center + half * np.array([0, 0, -1])])
    top = np.array([center + half * np.array([0, 0, 1])])
    mb.add(v, f, part)
    bi = mb.n
    mb.add(bot, [], part)
    ti = mb.n
    mb.add(top, [], part)
    last = base + (nv - 2) * nu
    for i in range(nu):
        mb.faces.append((base + (i + 1) % nu, base + i, bi))
        mb.faces.append((last + i, last + (i + 1) % nu, ti))


def backpack(mb: MeshBuilder):
    superellipsoid((0, -0.198, -0.290), (0.150, 0.072, 0.195), 0.30, 0.30, 16, 12, mb=mb)          # body
    superellipsoid((0, -0.206, -0.098), (0.136, 0.080, 0.032), 0.45, 0.30, 14, 8, mb=mb)           # top flap
    superellipsoid((0, -0.272, -0.335), (0.112, 0.026, 0.100), 0.30, 0.30, 12, 8, mb=mb)           # front pocket


def tint_bands():
    """Reflective tape: band across chest + back and around both sleeve stubs."""
    mb = MeshBuilder()
    rings = []
    for z, off in ((-0.165, 0.0016), (-0.168, 0.0030), (-0.192, 0.0030), (-0.195, 0.0016)):
        a, yf, yb = section(z)
        rings.append(torso_ring(z, a, yf, yb, n=NT, off=off))
    v, f = quad_grid(rings)
    mb.add(v, f, 0)
    n = 16
    for sx in (-1, 1):
        top = ARM_TOP * np.array([sx, 1, 1])
        d, u, w = arm_frame(sx)
        rings = []
        for st, off in ((0.72, 0.0016), (0.725, 0.0030), (0.82, 0.0030), (0.825, 0.0016)):
            r = float(np.interp(st, ARM_ST[:-1], ARM_R[:-1])) + off
            c = top + d * (st * ARM_LEN)
            phi = 2 * np.pi * np.arange(n) / n
            rings.append(c + np.outer(np.cos(phi) * r, u) + np.outer(np.sin(phi) * r * 1.08, w))
        v, f = quad_grid(rings)
        mb.add(v, f, 0)
    return mb.arrays()


def build_body():
    mb = MeshBuilder()
    torso(mb)
    arms(mb)
    collar(mb)
    hood(mb)
    straps(mb)
    backpack(mb)
    return mb.arrays()


def build() -> None:
    """Helper module (imported by avatar.py): nothing to build on its own."""
