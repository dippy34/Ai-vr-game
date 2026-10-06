"""
Parametric RIGHT hand: skeleton + quad-dominant low-poly skin with explicit, deformation-friendly
topology (edge loops at every joint), skin weights and UV seams. Pure Python + mathutils, no bpy
scene work here (hands.py turns the result into Blender objects).

Hand space = Blender object space of the hand, meters:
  origin = wrist joint, +Y = toward the fingertips, +Z = out of the back of the hand,
  thumb on -X (right hand). The left hand is a mirror (x -> -x) built in hands.py.

Topology overview
  * Palm: rings (loops around the hand) from the forearm stub to the finger bases. Each loop has
    a dorsal row T[0..16] and a palmar row B[0..16] (radial -> ulnar), i.e. 4 segments per finger.
  * Fingers: 10-vertex rings (T0..T4 dorsal half, B4..B0 palmar half). The distal palm loop IS the
    four finger base rings (neighbours share their web vertices).
  * Thumb: a 10-vertex tube growing out of a hole in the palm's radial side; the hole's palmar edge
    runs along the thenar crease ("life line"), so the thenar mound is the base of the thumb tube.
  * Cuff: a separate knitted sleeve-cuff shell over the wrist (hides the cut-off).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from mathutils import Matrix, Quaternion, Vector

FINGERS = ('index', 'middle', 'ring', 'pinky')
K = 4  # segments per finger half ring -> 2*(K+1) = 10 verts per finger ring
NR = 2 * (K + 1)
# ring angles (deg): T0..T4 then B4..B0 (cyclic)
RING_PHI = [162 - 36 * j for j in range(K + 1)] + [-(162 - 36 * j) for j in reversed(range(K + 1))]


def v3(x, y, z) -> Vector:
    return Vector((x, y, z))


def lerp(a, b, t):
    return a + (b - a) * t


def smoothstep(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def interp(keys: list[tuple[float, float]], x: float) -> float:
    """Piecewise-linear interpolation through sorted (x, y) keys (clamped)."""
    if x <= keys[0][0]:
        return keys[0][1]
    for (x0, y0), (x1, y1) in zip(keys, keys[1:]):
        if x <= x1:
            t = (x - x0) / (x1 - x0)
            # smooth (cosine) interpolation keeps the silhouettes free of kinks
            t = 0.5 - 0.5 * math.cos(math.pi * t)
            return y0 + (y1 - y0) * t
    return keys[-1][1]


def spe(t: float, n: float) -> float:
    """Superellipse shaping: sign(t)|t|^(2/n)."""
    return math.copysign(abs(t) ** (2.0 / n), t)


# ---------------------------------------------------------------------------------------------
# Skeleton
# ---------------------------------------------------------------------------------------------

@dataclass
class Chain:
    name: str
    joints: list[Vector]           # 4 points: base joint, mid joint, distal joint, tip
    dorsal: list[Vector]           # per bone (3): unit vector out of the nail/back side
    flex: list[Vector] = field(default_factory=list)  # per bone: unit dir the bone bends toward (bone local +Z)
    scale: float = 1.0

    def bone_dir(self, k: int) -> Vector:
        return (self.joints[k + 1] - self.joints[k]).normalized()

    def length(self, k: int) -> float:
        return (self.joints[k + 1] - self.joints[k]).length

    def frame(self, s: float) -> tuple[Vector, Vector, Vector, Vector]:
        """Point + (d, u, v) frame at chain station s (0 = base joint, 1, 2 = mid joints, 3 = tip).
        Directions blend smoothly across joints so rings don't kink."""
        k = min(2, max(0, int(math.floor(s))))
        t = s - k
        p = self.joints[k].lerp(self.joints[k + 1], t)
        d = self.bone_dir(k)
        v = self.dorsal[k]
        # blend toward neighbour bone near the joints (half-angle at the joint itself)
        if t < 0.5 and k > 0:
            w = 0.5 * (1 - smoothstep(0.0, 0.5, t))
            d = d.lerp(self.bone_dir(k - 1), w).normalized()
            v = v.lerp(self.dorsal[k - 1], w)
        elif t > 0.5 and k < 2:
            w = 0.5 * smoothstep(0.5, 1.0, t)
            d = d.lerp(self.bone_dir(k + 1), w).normalized()
            v = v.lerp(self.dorsal[k + 1], w)
        v = (v - d * v.dot(d)).normalized()
        u = d.cross(v).normalized()
        return p, d, u, v


def rot(axis: Vector, deg: float) -> Matrix:
    return Matrix.Rotation(math.radians(deg), 3, axis)


def build_chain(name, base, yaw_deg, pitch_deg, lengths, rest_flex_deg, dorsal_roll_deg=0.0, scale=1.0):
    """A straight-ish finger: starts at `base`, heads +Y rotated by yaw (+ = toward ulnar/+X) and
    pitch (+ = up/dorsal), with small rest flexion per joint (deg, + = toward palm)."""
    d = Vector((0, 1, 0))
    v = Vector((0, 0, 1))
    m = rot(Vector((0, 0, 1)), -yaw_deg) @ rot(Vector((1, 0, 0)), pitch_deg)
    d = m @ d
    v = m @ v
    if dorsal_roll_deg:
        v = rot(d, dorsal_roll_deg) @ v
    joints = [base.copy()]
    dorsals = []
    for k in range(3):
        u = d.cross(v).normalized()
        # flex: rotate about -u (toward palm)
        fm = rot(u, -rest_flex_deg[k])
        d = (fm @ d).normalized()
        v = (fm @ v).normalized()
        joints.append(joints[-1] + d * lengths[k])
        dorsals.append(v.copy())
    return Chain(name, joints, dorsals, scale=scale)


@dataclass
class Skeleton:
    chains: dict[str, Chain]

    @staticmethod
    def default() -> 'Skeleton':
        c = {}
        # MCP joint centres. The knuckle arc: middle furthest, pinky well back.
        c['index'] = build_chain('index', v3(-0.0292, 0.0870, 0.0000), -1.5, 0.0, (0.0422, 0.0250, 0.0226), (1.5, 3.0, 2.0), scale=1.0)
        c['middle'] = build_chain('middle', v3(-0.0090, 0.0900, 0.0012), 0.0, 0.0, (0.0452, 0.0280, 0.0235), (1.5, 3.0, 2.0), scale=1.03)
        c['ring'] = build_chain('ring', v3(0.0106, 0.0858, 0.0002), 2.0, 0.0, (0.0434, 0.0270, 0.0230), (1.5, 3.5, 2.0), scale=0.97)
        c['pinky'] = build_chain('pinky', v3(0.0288, 0.0755, -0.0030), 5.5, -1.0, (0.0364, 0.0212, 0.0210), (2.0, 4.0, 2.5), scale=0.86)
        # Thumb: CMC joint at the radial-palmar base of the palm; points outward + forward, rolled
        # ~80 deg so the nail faces radially/up and the pad faces the index finger.
        cmc = v3(-0.0215, 0.0215, -0.0080)
        d1 = v3(-0.68, 0.73, -0.06).normalized()
        d2 = v3(-0.43, 0.90, 0.0).normalized()
        d3 = v3(-0.30, 0.95, 0.03).normalized()
        mcp = cmc + d1 * 0.0455
        ip = mcp + d2 * 0.0340
        tip = ip + d3 * 0.0300
        # progressive pronation: metacarpal back faces mostly up, the nail faces radially
        dors = []
        for dd, nv in ((d1, v3(-0.38, 0.0, 0.92)), (d2, v3(-0.64, 0.0, 0.77)), (d3, v3(-0.80, 0.02, 0.60))):
            vv = (nv - dd * nv.dot(dd)).normalized()
            dors.append(vv)
        c['thumb'] = Chain('thumb', [cmc, mcp, ip, tip], dors, scale=1.0)
        sk = Skeleton(c)
        for ch in sk.chains.values():
            ch.flex = [-dv for dv in ch.dorsal]
        # Fist convergence: tilt the flexion planes of ring/pinky toward the thumb side.
        for name, tilt in (('index', -2.0), ('middle', 2.0), ('ring', 6.0), ('pinky', 11.0)):
            ch = sk.chains[name]
            ch.flex = [(rot(ch.bone_dir(k), -tilt) @ ch.flex[k]).normalized() for k in range(3)]
        return sk


# ---------------------------------------------------------------------------------------------
# Cross-section profiles (half-width, dorsal half-height, palmar half-height) along a chain
# ---------------------------------------------------------------------------------------------

# stations s: 0 = MCP, 1 = PIP, 2 = DIP, 3 = tip
FINGER_PROFILE = {
    #        s     hw      hd      hp
    'hw': [(0.0, 0.0110), (0.45, 0.0102), (0.85, 0.0097), (1.0, 0.0100), (1.2, 0.0094), (1.75, 0.0088),
           (2.0, 0.0089), (2.3, 0.0087), (2.62, 0.0085), (2.86, 0.0075), (2.97, 0.0052)],
    'hd': [(0.0, 0.0086), (0.45, 0.0075), (0.85, 0.0071), (1.0, 0.0078), (1.2, 0.0067), (1.75, 0.0063),
           (2.0, 0.0065), (2.3, 0.0060), (2.62, 0.0057), (2.86, 0.0050), (2.97, 0.0030)],
    'hp': [(0.0, 0.0099), (0.45, 0.0091), (0.85, 0.0080), (1.0, 0.0075), (1.2, 0.0080), (1.75, 0.0071),
           (2.0, 0.0064), (2.3, 0.0073), (2.62, 0.0077), (2.86, 0.0066), (2.97, 0.0040)],
}
THUMB_PROFILE = {
    'hw': [(0.86, 0.0126), (1.0, 0.0124), (1.2, 0.0117), (1.6, 0.0114), (1.88, 0.0113),
           (2.0, 0.0115), (2.25, 0.0112), (2.6, 0.0109), (2.86, 0.0093), (2.97, 0.0060)],
    'hd': [(0.86, 0.0096), (1.0, 0.0098), (1.2, 0.0087), (1.6, 0.0082), (1.88, 0.0080),
           (2.0, 0.0082), (2.25, 0.0075), (2.6, 0.0069), (2.86, 0.0059), (2.97, 0.0035)],
    'hp': [(0.86, 0.0118), (1.0, 0.0098), (1.2, 0.0103), (1.6, 0.0099), (1.88, 0.0087),
           (2.0, 0.0080), (2.25, 0.0091), (2.6, 0.0095), (2.86, 0.0080), (2.97, 0.0046)],
}

FINGER_STATIONS = [0.64, 0.86, 0.94, 1.0, 1.06, 1.2, 1.75, 1.92, 2.0, 2.08, 2.25, 2.6, 2.86, 2.965]
THUMB_STATIONS = [0.86, 0.94, 1.0, 1.06, 1.2, 1.6, 1.86, 1.93, 2.0, 2.07, 2.25, 2.6, 2.86, 2.965]


def ring_points(p: Vector, u: Vector, v: Vector, hw: float, hd: float, hp: float, n: float = 2.5,
                center_off: float = 0.0) -> list[Vector]:
    c = p + v * center_off
    pts = []
    for phi in RING_PHI:
        a = math.radians(phi)
        cu, sv = math.cos(a), math.sin(a)
        h = hd if sv > 0 else hp
        pts.append(c + u * (hw * spe(cu, n)) + v * (h * spe(sv, n)))
    return pts


# ---------------------------------------------------------------------------------------------
# Mesh builder
# ---------------------------------------------------------------------------------------------

@dataclass
class HandMesh:
    verts: list[Vector] = field(default_factory=list)
    faces: list[tuple[int, ...]] = field(default_factory=list)
    weights: list[dict[str, float]] = field(default_factory=list)
    region: list[str] = field(default_factory=list)       # per vertex: 'skin' | 'cuff'
    seams: set[tuple[int, int]] = field(default_factory=set)
    # per vertex: (chain name or 'palm', station s) for detail generation
    station: list[tuple[str, float]] = field(default_factory=list)
    meta: dict = field(default_factory=dict)

    def add(self, p: Vector, w: dict[str, float], region='skin', station=('palm', 0.0)) -> int:
        self.verts.append(p.copy())
        tot = sum(w.values())
        self.weights.append({k: x / tot for k, x in w.items() if x > 1e-4})
        self.region.append(region)
        self.station.append(station)
        return len(self.verts) - 1

    def seam(self, a: int, b: int) -> None:
        self.seams.add((min(a, b), max(a, b)))

    def bridge(self, ra: list[int], rb: list[int], closed=True, skip: set[int] | None = None) -> None:
        n = len(ra)
        for i in range(n if closed else n - 1):
            if skip and i in skip:
                continue
            j = (i + 1) % n
            self.faces.append((ra[i], ra[j], rb[j], rb[i]))


def finger_weights(name: str, s: float) -> dict[str, float]:
    """Weights along a finger/thumb chain by station s. Bends happen over a narrow band around each
    joint (keeps the phalanges rigid and the knuckles full)."""
    b1, b2, b3 = f'{name}_1', f'{name}_2', f'{name}_3'
    if s < 0.9:
        return {b1: 1.0}
    if s < 1.1:
        t = smoothstep(0.86, 1.14, s)
        return {b1: 1 - t, b2: t}
    if s < 1.9:
        return {b2: 1.0}
    if s < 2.1:
        t = smoothstep(1.86, 2.14, s)
        return {b2: 1 - t, b3: t}
    return {b3: 1.0}


def joint_weights(name: str, s: float, phi_deg: float) -> dict[str, float]:
    """Like finger_weights, but around PIP/DIP the dorsal side follows the distal bone more and the
    palmar side the proximal one: the knuckle keeps its roundness when the finger curls (linear
    blend skinning would otherwise collapse a 50/50 ring to cos(angle/2) of its radius)."""
    w = finger_weights(name, s)
    j = round(s)
    if j in (1, 2) and abs(s - j) < 0.13:
        b0, b1 = f'{name}_{j}', f'{name}_{j + 1}'
        t = w.get(b1, 0.0)
        fall = 1 - abs(s - j) / 0.13
        t = min(1.0, max(0.0, t + 0.30 * math.sin(math.radians(phi_deg)) * fall))
        return {b0: 1 - t, b1: t}
    return w


def build_hand(sk: Skeleton | None = None) -> tuple[HandMesh, Skeleton]:
    sk = sk or Skeleton.default()
    hm = HandMesh()
    ch = sk.chains
    fingers = [ch[f] for f in FINGERS]

    # ---------------- finger base rings (distal palm loop) + knuckle loop -----------------
    # base ring: dorsal slanted just past the knuckle, palmar at the proximal finger crease.
    def base_ring(c: Chain) -> list[Vector]:
        pts = []
        for idx, phi in enumerate(RING_PHI):
            a = math.radians(phi)
            sv = math.sin(a)
            cu = math.cos(a)
            # offset along the finger (m): dorsal centre +6 mm, palmar centre +21 mm, sides ~+17 mm
            if sv > 0:
                s = lerp(0.37, 0.15, abs(sv) ** 1.5)
            else:
                s = lerp(0.40, 0.44, abs(sv) ** 1.2)
            p, d, u, v = c.frame(s)
            hw = interp(FINGER_PROFILE['hw'], s) * c.scale * 1.04
            hd = interp(FINGER_PROFILE['hd'], s) * c.scale * 1.05
            hp = interp(FINGER_PROFILE['hp'], s) * c.scale * 1.02
            h = hd if sv > 0 else hp
            pts.append(p + u * (hw * spe(cu, 2.6)) + v * (h * spe(sv, 2.6)))
        return pts

    base = [base_ring(c) for c in fingers]

    def knuckle_ring(c: Chain, fi: int) -> list[Vector]:
        """Dorsal: knuckle bumps (metacarpal heads) just proximal of the MCP. Palmar: palm pads."""
        p, d, u, v = c.frame(0.0)
        p = p - d * 0.0035
        sc = c.scale
        top = []
        # T0..T4 lateral positions / heights relative to the joint centre
        lat = [-1.0, -0.55, 0.0, 0.55, 1.0]
        hgt = [0.0074, 0.0112, 0.0128, 0.0112, 0.0074]
        for L, H in zip(lat, hgt):
            top.append(p + u * (L * 0.0102 * sc) + v * (H * (0.9 + 0.1 * sc)))
        bot = []
        latb = [-1.0, -0.5, 0.0, 0.5, 1.0]
        hb = [0.0118, 0.0128, 0.0131, 0.0128, 0.0118]
        for L, H in zip(latb, hb):
            bot.append(p + d * 0.0045 + u * (L * 0.0102 * sc) - v * (H * (0.92 + 0.08 * sc)))
        return top + list(reversed(bot))

    knuck = [knuckle_ring(c, i) for i, c in enumerate(fingers)]

    def merge_rows(rings: list[list[Vector]], edge_pull: float = 0.0) -> tuple[list[Vector], list[Vector]]:
        """Concatenate finger rings into palm rows T[0..16], B[0..16]; shared web verts averaged."""
        T: list[Vector] = []
        B: list[Vector] = []
        for f, r in enumerate(rings):
            t = r[:K + 1]
            b = list(reversed(r[K + 1:]))  # B0..B4
            if f == 0:
                T.extend(t)
                B.extend(b)
            else:
                T[-1] = (T[-1] + t[0]) / 2
                B[-1] = (B[-1] + b[0]) / 2
                T.extend(t[1:])
                B.extend(b[1:])
        return T, B

    T10, B10 = merge_rows(base)
    T9, B9 = merge_rows(knuck)
    # webs sit a little deeper (toward the palm) and further out than a plain average
    for f in range(1, 4):
        j = 4 * f
        T10[j] = T10[j] + v3(0, 0.0012, -0.0016)
        B10[j] = B10[j] + v3(0, 0.0004, 0.0012)
        T9[j] = T9[j] + v3(0, 0.0, -0.0012)

    # ---------------- palm rings r0..r8 (analytic) -----------------
    NT = 4 * K + 1  # 17
    # proximal -> distal ring y (at the middle finger), and blend weight toward the knuckle arc
    ring_y = [-0.040, -0.026, -0.011, 0.007, 0.0230, 0.0380, 0.0525, 0.0635, 0.0725]
    arc_w = [0.0, 0.0, 0.0, 0.05, 0.15, 0.32, 0.55, 0.78, 0.92]

    mcp_x = [c.joints[0].x for c in fingers]
    mcp_y = [c.joints[0].y for c in fingers]

    def arc_dy(x: float) -> float:
        return interp(list(zip(mcp_x, [y - mcp_y[1] for y in mcp_y])), x)

    # distributions of the top/bottom row at the finger bases (normalised 0..1)
    def norm_dist(row: list[Vector]) -> list[float]:
        x0, x1 = row[0].x, row[-1].x
        return [(p.x - x0) / (x1 - x0) for p in row]

    gT = norm_dist(T10)
    gB = norm_dist(B10)

    # lateral extents (dorsal row) per ring
    x_rad = [-0.0295, -0.0290, -0.0282, -0.0310, -0.0338, -0.0366, -0.0392, -0.0414, -0.0432]
    x_uln = [0.0300, 0.0298, 0.0300, 0.0330, 0.0360, 0.0378, 0.0390, 0.0395, 0.0395]
    # dorsal centre height, dorsal arch, palmar depth (centre), palmar ulnar (hypothenar) depth
    z_top = [0.0205, 0.0196, 0.0186, 0.0168, 0.0152, 0.0140, 0.0131, 0.0124, 0.0120]
    arch = [0.0060, 0.0058, 0.0052, 0.0040, 0.0031, 0.0026, 0.0024, 0.0023, 0.0022]
    z_bot_c = [-0.0185, -0.0178, -0.0168, -0.0150, -0.0128, -0.0112, -0.0106, -0.0108, -0.0115]
    z_bot_u = [-0.0185, -0.0178, -0.0168, -0.0166, -0.0160, -0.0152, -0.0140, -0.0128, -0.0124]
    # thumb hole: rings 3..7, explicit radial dorsal edge (T0) and thenar crease (B0)
    HOLE = (2, 6)
    T0_hole = {2: v3(-0.0288, -0.0110, 0.0136), 3: v3(-0.0318, 0.0070, 0.0119), 4: v3(-0.0350, 0.0230, 0.0101),
               5: v3(-0.0384, 0.0380, 0.0083), 6: v3(-0.0414, 0.0540, 0.0060)}
    B0_hole = {2: v3(-0.0085, -0.0110, -0.0180), 3: v3(-0.0095, 0.0070, -0.0166), 4: v3(-0.0128, 0.0230, -0.0149),
               5: v3(-0.0198, 0.0380, -0.0133), 6: v3(-0.0322, 0.0530, -0.0110)}

    def palm_ring(r: int) -> tuple[list[Vector], list[Vector]]:
        yb = ring_y[r]
        w = arc_w[r]
        xr, xu = x_rad[r], x_uln[r]
        # proximal rings use a near-uniform distribution
        blend = smoothstep(1.0, 8.0, r)
        T = []
        for j in range(NT):
            g = lerp(j / (NT - 1), gT[j], blend)
            x = lerp(xr, xu, g)
            cx = (xr + xu) / 2
            hwid = (xu - xr) / 2
            q = (x - cx) / hwid
            z = z_top[r] + arch[r] * (1 - q * q) - arch[r]
            # rounded edges
            edge = max(0.0, abs(q) - 0.72) / 0.28
            z -= (0.0068 if r < 3 else 0.0046) * edge ** 1.6
            y = yb + w * arc_dy(x)
            T.append(v3(x, y, z))
        if HOLE[0] <= r <= HOLE[1]:
            T[0] = T0_hole[r]
        B = []
        if HOLE[0] <= r <= HOLE[1]:
            xb0 = B0_hole[r].x
        elif r < HOLE[0]:
            xb0 = lerp(xr, B0_hole[HOLE[0]].x, 0.42 + 0.06 * r)   # thenar crease starts mid-wrist
        else:
            xb0 = xr - 0.0005
        xb1 = xu + 0.0008
        for j in range(NT):
            g = lerp(j / (NT - 1), gB[j], blend)
            x = lerp(xb0, xb1, g)
            q = (x - xb0) / (xb1 - xb0)  # 0 radial .. 1 ulnar
            # palm surface: central hollow, hypothenar side lower, rounded ulnar edge
            zc = z_bot_c[r]
            zu = z_bot_u[r]
            z = lerp(zc, zu, smoothstep(0.35, 0.9, q))
            if r < HOLE[0]:
                z = lerp(z, z_bot_u[r] * 0.92, 1 - smoothstep(0.0, 0.25, q))
            edge_u = max(0.0, q - 0.86) / 0.14
            z += 0.0052 * edge_u ** 1.5
            if r > HOLE[1]:
                edge_r = max(0.0, 0.12 - q) / 0.12
                z += 0.0040 * edge_r ** 1.5
            y = yb + w * arc_dy(x) + 0.0015 * w
            B.append(v3(x, y, z))
        if HOLE[0] <= r <= HOLE[1]:
            B[0] = B0_hole[r]
        return T, B

    rows: list[tuple[list[Vector], list[Vector]]] = [palm_ring(r) for r in range(9)]
    rows.append((T9, B9))
    rows.append((T10, B10))
    # r8 (just proximal to the knuckles): radial edge = first web space
    T8, B8 = rows[8]
    T8[0] = v3(-0.0436, 0.0728, 0.0042)
    B8[0] = v3(-0.0430, 0.0724, -0.0058)
    T7, B7 = rows[7]
    T7[0] = v3(-0.0432, 0.0638, 0.0046)
    B7[0] = v3(-0.0412, 0.0632, -0.0078)

    NPR = len(rows)  # 11 palm rings

    # ---------------- weights for palm vertices -----------------
    def palm_w(r: int, top: bool, j: int) -> dict[str, float]:
        w = {'wrist': 1.0}
        fi = min(3, j // K)
        frac = (j % K) / K
        shared = (j % K == 0) and 0 < j < NT - 1
        if r == NPR - 1:      # finger bases
            amt = 0.82 if top else 0.62
            if shared:
                a = f'{FINGERS[j // K - 1]}_1'
                b = f'{FINGERS[j // K]}_1'
                return {'wrist': 1 - amt * 0.85, a: amt * 0.425, b: amt * 0.425}
            fi = min(3, j // K) if j < NT - 1 else 3
            return {'wrist': 1 - amt, f'{FINGERS[fi]}_1': amt}
        if r == NPR - 2:      # knuckles
            amt = 0.10 if top else 0.25
            if shared:
                a = f'{FINGERS[j // K - 1]}_1'
                b = f'{FINGERS[j // K]}_1'
                return {'wrist': 1 - amt, a: amt / 2, b: amt / 2}
            fi = min(3, j // K) if j < NT - 1 else 3
            return {'wrist': 1 - amt, f'{FINGERS[fi]}_1': amt}
        return w

    def palm_thumb_w(r: int, top: bool, j: int) -> dict[str, float]:
        """Thenar region follows the thumb metacarpal a bit."""
        w = palm_w(r, top, j)
        if HOLE[0] <= r <= HOLE[1] + 1 and j <= 2:
            amt = [0.30, 0.12, 0.04][j] * (0.6 if top else 1.0)
            # nothing at the wrist end (the cuff stays put), full toward the web
            amt *= {HOLE[0]: 0.0, HOLE[0] + 1: 0.25, HOLE[0] + 2: 0.65}.get(r, 1.0)
            if r == HOLE[1] + 1:
                amt *= 0.5
            w = {k: x * (1 - amt) for k, x in w.items()}
            w['thumb_1'] = w.get('thumb_1', 0) + amt
        return w

    palm_ids: list[tuple[list[int], list[int]]] = []
    for r, (T, B) in enumerate(rows):
        ti = [hm.add(p, palm_thumb_w(r, True, j), station=('palm', r)) for j, p in enumerate(T)]
        bi = [hm.add(p, palm_thumb_w(r, False, j), station=('palm', r)) for j, p in enumerate(B)]
        palm_ids.append((ti, bi))

    def loop(r: int) -> list[int]:
        ti, bi = palm_ids[r]
        return ti + list(reversed(bi))

    # palm faces: loops r -> r+1, skipping the radial side face inside the thumb hole
    NL = 2 * NT  # 34
    radial_face = NL - 1  # face between B0 and T0 (wraps)
    for r in range(NPR - 1):
        skip = {radial_face} if HOLE[0] <= r < HOLE[1] else None
        hm.bridge(loop(r), loop(r + 1), closed=True, skip=skip)

    # seams along the dorsal edges (T0, T16), except where the thumb grows out
    for r in range(NPR - 1):
        a, b = palm_ids[r][0], palm_ids[r + 1][0]
        hm.seam(a[0], b[0])
        hm.seam(a[-1], b[-1])

    # ---------------- fingers -----------------
    def station_ring(c: Chain, s: float, profile, n_exp: float) -> list[Vector]:
        p, d, u, v = c.frame(s)
        hw = interp(profile['hw'], s) * c.scale
        hd = interp(profile['hd'], s) * c.scale
        hp = interp(profile['hp'], s) * c.scale
        # tissue sits slightly palmar of the bone axis
        return ring_points(p, u, v, hw, hd, hp, n=n_exp, center_off=-0.0006 * c.scale)

    def tube(c: Chain, ring0: list[int], stations: list[float], profile, n_exp: float, pre=None, seam_line=None):
        prev = ring0
        rings = [ring0]
        for pts, w, st in (pre or []):
            ids = [hm.add(q, {f'{c.name}_1': w, 'wrist': 1 - w}, station=(c.name, st)) for q in pts]
            hm.bridge(prev, ids)
            rings.append(ids)
            prev = ids
        for s in stations:
            pts = station_ring(c, s, profile, n_exp)
            ids = [hm.add(q, joint_weights(c.name, s, RING_PHI[i]), station=(c.name, s)) for i, q in enumerate(pts)]
            hm.bridge(prev, ids)
            rings.append(ids)
            prev = ids
        # cap: 2 x 3 grid
        last = prev
        p, d, u, v = c.frame(2.995)
        hd = interp(profile['hd'], 2.97) * c.scale
        hp = interp(profile['hp'], 2.97) * c.scale
        g11 = hm.add(p + d * 0.0006 + v * (hd * 0.30), finger_weights(c.name, 3.0), station=(c.name, 3.0))
        g12 = hm.add(p + d * 0.0003 - v * (hp * 0.45), finger_weights(c.name, 3.0), station=(c.name, 3.0))
        T0, T1, T2, T3, T4, B4, B3, B2, B1, B0 = last
        G = {(0, 1): T0, (0, 0): T1, (1, 0): T2, (2, 0): T3, (2, 1): T4, (2, 2): B4, (2, 3): B3,
             (1, 3): B2, (0, 3): B1, (0, 2): B0, (1, 1): g11, (1, 2): g12}
        for i in range(2):
            for jj in range(3):
                hm.faces.append((G[(i, jj)], G[(i + 1, jj)], G[(i + 1, jj + 1)], G[(i, jj + 1)]))
        # UV seams: base ring + one longitudinal line (each digit unwraps as its own compact strip;
        # detail is evaluated in 3D, so seams don't show)
        line = seam_line if seam_line is not None else K
        r0 = rings[0]
        for i in range(NR):
            hm.seam(r0[i], r0[(i + 1) % NR])
        for ra, rb in zip(rings, rings[1:]):
            hm.seam(ra[line], rb[line])
        return rings

    for fi, c in enumerate(fingers):
        ti, bi = palm_ids[NPR - 1]
        ring0 = ti[K * fi:K * fi + K + 1] + list(reversed(bi[K * fi:K * fi + K + 1]))
        tube(c, ring0, FINGER_STATIONS, FINGER_PROFILE, 2.25)

    # ---------------- thumb -----------------
    th = ch['thumb']
    hole = [palm_ids[r][0][0] for r in range(HOLE[0], HOLE[1] + 1)] + \
           [palm_ids[r][1][0] for r in range(HOLE[1], HOLE[0] - 1, -1)]
    # Thenar mound: grow out of the hole along its normal while morphing toward the MCP ring,
    # so the tube never folds back over the palm.
    mcp_ring = station_ring(th, THUMB_STATIONS[0], THUMB_PROFILE, 2.3)
    n_h = v3(-0.74, -0.05, -0.67).normalized()
    pre = []
    for t, bulge, wt in ((0.33, 0.0070, 0.62), (0.62, 0.0036, 0.90)):
        pts = []
        for i in range(NR):
            a_ = hm.verts[hole[i]]
            b_ = mcp_ring[i]
            q = a_.lerp(b_, t)
            sv = math.sin(math.radians(RING_PHI[i]))
            web_side = 0.35 if i in (K - 1, K, K + 1, K + 2) else 1.0   # toward the index: thin web
            q = q + n_h * (bulge * (1.0 if sv < 0 else 0.6) * web_side)
            pts.append(q)
        pre.append((pts, wt, t * THUMB_STATIONS[0]))
    # per-vertex weights for the thenar rings: weaker toward the wrist end of the hole
    ring_r = [HOLE[0] + (i if i <= K else NR - 1 - i) for i in range(NR)]
    rings_th = tube(th, hole, THUMB_STATIONS, THUMB_PROFILE, 2.3, pre=pre, seam_line=K + 1)
    for pi_, (_, wt, _) in enumerate(pre):
        ring = rings_th[1 + pi_]
        for i, vid in enumerate(ring):
            g = {HOLE[0]: 0.12 + 0.16 * pi_, HOLE[0] + 1: 0.45 + 0.2 * pi_, HOLE[0] + 2: 0.85}.get(ring_r[i], 1.0)
            w = wt * g
            hm.weights[vid] = {'thumb_1': w, 'wrist': 1 - w}

    # ---------------- relax -----------------
    # even out the palm / thenar quads without changing the shape (tangential), then soften the
    # crease where the thumb web meets the index base (a little true smoothing there)
    palm_set = set()
    for r in range(1, NPR - 1):
        palm_set.update(palm_ids[r][0][1:-1])
        palm_set.update(palm_ids[r][1][1:-1])
    thenar_set = set()
    for ring in rings_th[1:3]:
        thenar_set.update(ring)
    web = set()
    for r in range(HOLE[1], NPR - 1):
        web.add(palm_ids[r][0][0])
        web.add(palm_ids[r][1][0])
    for vid in list(rings_th[1]) + list(rings_th[2]):
        web.add(vid)
    relax(hm, palm_set | thenar_set, iters=6, factor=0.45, tangential=True)
    relax(hm, web, iters=3, factor=0.35, tangential=False)

    # the thenar crease ("life line") runs exactly along the palm / thumb junction
    life = [hm.verts[palm_ids[r][1][0]] for r in range(HOLE[1] + 1, HOLE[0] - 1, -1)]
    hm.meta['life_line'] = [(p.x, p.y) for p in life]

    # ---------------- cuff (knit sleeve end) -----------------
    build_cuff(hm, rows[2])

    return hm, sk


def relax(hm: HandMesh, vids: set[int], iters: int, factor: float, tangential: bool) -> None:
    nbr: dict[int, set[int]] = {}
    for f in hm.faces:
        n = len(f)
        for i in range(n):
            a, b = f[i], f[(i + 1) % n]
            nbr.setdefault(a, set()).add(b)
            nbr.setdefault(b, set()).add(a)
    for _ in range(iters):
        # vertex normals from faces
        normals = {v: Vector() for v in vids}
        for f in hm.faces:
            if not any(v in normals for v in f):
                continue
            p = [hm.verts[i] for i in f]
            nrm = (p[1] - p[0]).cross(p[2] - p[0])
            if len(p) == 4:
                nrm += (p[2] - p[0]).cross(p[3] - p[0])
            for v in f:
                if v in normals:
                    normals[v] += nrm
        new = {}
        for v in vids:
            ns = nbr.get(v)
            if not ns:
                continue
            avg = sum((hm.verts[i] for i in ns), Vector()) / len(ns)
            dv = (avg - hm.verts[v]) * factor
            if tangential and normals[v].length > 1e-12:
                n = normals[v].normalized()
                dv -= n * dv.dot(n)
            new[v] = hm.verts[v] + dv
        for v, p in new.items():
            hm.verts[v] = p


def build_cuff(hm: HandMesh, wrist_rows) -> None:
    """Ribbed knit cuff around the wrist: rolled distal rim, open-looking but capped proximal end."""
    N = 28
    T, B = wrist_rows
    cx = (T[0].x + T[-1].x) / 2
    # cross-section: rounded rectangle-ish ellipse a bit larger than the wrist
    ax_, az_ = 0.0335, 0.0228
    cz = 0.0012

    def ring(y, grow, zsh=0.0, n=2.6):
        pts = []
        for i in range(N):
            a = 2 * math.pi * i / N
            ca, sa = math.cos(a), math.sin(a)
            pts.append(v3(cx + (ax_ + grow) * spe(ca, n), y, cz + zsh + (az_ + grow) * spe(sa, n)))
        return pts

    profile = [
        # (y, radial growth, z shift)   distal rim rolls inward
        (-0.0095, -0.0042, 0.0),   # inner lip (tucked under, toward the skin)
        (-0.0072, -0.0004, 0.0),   # rim front
        (-0.0098, 0.0027, 0.0),    # rim outer bulge
        (-0.0150, 0.0022, 0.0),
        (-0.0250, 0.0015, 0.0),
        (-0.0360, 0.0020, 0.0),
        (-0.0470, 0.0028, 0.0),    # proximal edge
        (-0.0505, 0.0004, 0.0),
        (-0.0495, -0.0060, 0.0),   # inner turn (dark inside)
    ]
    rings = []
    for i, (y, g, zs) in enumerate(profile):
        pts = ring(y, g, zs)
        ids = [hm.add(p, {'wrist': 1.0}, region='cuff', station=('cuff', i)) for p in pts]
        rings.append(ids)
    for a, b in zip(rings, rings[1:]):
        hm.bridge(a, b)
    # cap the proximal inside with a fan (hidden, keeps the inside from showing through)
    last = rings[-1]
    c = sum((hm.verts[i] for i in last), Vector()) / N
    ci = hm.add(c + v3(0, 0.004, 0), {'wrist': 1.0}, region='cuff', station=('cuff', len(profile)))
    for i in range(N):
        hm.faces.append((last[i], last[(i + 1) % N], ci))
    # one seam line along the underside so the cuff unwraps as a strip; the hidden cap is its own island
    for a, b in zip(rings, rings[1:]):
        hm.seam(a[N * 3 // 4], b[N * 3 // 4])
    for i in range(N):
        hm.seam(last[i], last[(i + 1) % N])


def build() -> None:
    """Helper module (imported by hands.py / avatar.py): nothing to build on its own."""
