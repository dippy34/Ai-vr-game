"""
2D image synthesis for MUTE's set dressing (numpy only): portrait photo, landscape painting,
clock dial, oriental rug, newspaper, missing poster, child's crayon drawing, letters, glass cracks.

All functions return float arrays HxWx3 (or HxW), top row first, values sRGB-encoded 0..1.
Helper module only: build() is a no-op.
"""

from __future__ import annotations

import math

import numpy as np


def build() -> None:
    print('dressing_img: helper module (built through dressing.py)')


# =============================================================================================
# Basics
# =============================================================================================

def hexa(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], dtype=np.float32)


class Canvas:
    def __init__(self, w, h, color=(1, 1, 1), seed=1):
        self.w, self.h = w, h
        self.a = np.empty((h, w, 3), dtype=np.float32)
        self.a[:] = np.asarray(color, dtype=np.float32)
        self.rng = np.random.default_rng(seed)
        self.yy, self.xx = np.mgrid[0:h, 0:w].astype(np.float32) + 0.5

    def fill(self, m, color, alpha=1.0):
        m = np.clip(m * alpha, 0, 1)[..., None]
        c = np.asarray(color, dtype=np.float32)
        self.a = self.a * (1 - m) + c * m

    def mul(self, m):
        self.a *= m[..., None] if m.ndim == 2 else m

    def add(self, v):
        self.a = self.a + v

    # shapes (pixel coords, y down)
    def ellipse(self, cx, cy, rx, ry, rot=0.0, soft=1.0):
        x = self.xx - cx
        y = self.yy - cy
        if rot:
            c, s = math.cos(rot), math.sin(rot)
            x, y = c * x + s * y, -s * x + c * y
        d = (np.sqrt((x / rx) ** 2 + (y / ry) ** 2) - 1.0) * min(rx, ry)
        return np.clip(0.5 - d / soft, 0, 1)

    def poly(self, pts, soft=1.0):
        """Even-odd fill of a polygon, antialiased by distance to the outline."""
        x, y = self.xx, self.yy
        inside = np.zeros((self.h, self.w), dtype=bool)
        n = len(pts)
        dmin = np.full((self.h, self.w), 1e9, dtype=np.float32)
        for i in range(n):
            x0, y0 = pts[i]
            x1, y1 = pts[(i + 1) % n]
            cond = ((y0 > y) != (y1 > y))
            with np.errstate(divide='ignore', invalid='ignore'):
                xi = (x1 - x0) * (y - y0) / (y1 - y0 + 1e-12) + x0
            inside ^= cond & (x < xi)
            dmin = np.minimum(dmin, seg_dist(x, y, x0, y0, x1, y1))
        sd = np.where(inside, -dmin, dmin)
        return np.clip(0.5 - sd / soft, 0, 1)

    def stroke(self, pts, width, color, alpha=1.0, soft=1.0, taper=False):
        """Polyline stroke (computed only in its bounding box)."""
        pts = np.asarray(pts, dtype=np.float32)
        if len(pts) == 1:
            pts = np.vstack([pts, pts + 0.01])
        pad = width + 2 * soft + 2
        x0 = int(max(0, math.floor(pts[:, 0].min() - pad)))
        x1 = int(min(self.w, math.ceil(pts[:, 0].max() + pad)))
        y0 = int(max(0, math.floor(pts[:, 1].min() - pad)))
        y1 = int(min(self.h, math.ceil(pts[:, 1].max() + pad)))
        if x1 <= x0 or y1 <= y0:
            return
        xx = self.xx[y0:y1, x0:x1]
        yy = self.yy[y0:y1, x0:x1]
        d = np.full(xx.shape, 1e9, dtype=np.float32)
        n = len(pts)
        for i in range(n - 1):
            w = width
            if taper:
                w = width * (1.0 - 0.7 * (i / max(1, n - 2)))
            di = seg_dist(xx, yy, *pts[i], *pts[i + 1]) - w / 2
            d = np.minimum(d, di)
        m = np.clip(0.5 - d / soft, 0, 1) * alpha
        c = np.asarray(color, dtype=np.float32)
        sub = self.a[y0:y1, x0:x1]
        self.a[y0:y1, x0:x1] = sub * (1 - m[..., None]) + c * m[..., None]

    def text(self, s, x, y, size, width, color, alpha=1.0, angle=0.0, spacing=1.35, jitter=0.0, soft=0.8,
             wobble=0.0, slant=0.0, align='left', fit=None):
        """Stroke-font text; (x, y) = baseline start (pixels), size = cap height. fit = max width."""
        total = len(s) * 4.0 * size / 6.0 * spacing - (spacing - 1) * 4.0 * size / 6.0
        if fit is not None and total > fit:
            k = fit / total
            size *= k
            width = max(0.8, width * (0.5 + 0.5 * k))
        sc = size / 6.0
        adv = 4.0 * sc * spacing
        total = len(s) * adv - (spacing - 1) * 4.0 * sc
        if align == 'center':
            x -= math.cos(angle) * total / 2
            y -= math.sin(angle) * total / 2
        ca, sa = math.cos(angle), math.sin(angle)
        rng = self.rng
        for k, ch in enumerate(s.upper()):
            g = FONT.get(ch)
            if g is None:
                continue
            ox = k * adv
            for line in g:
                pts = []
                for (gx, gy) in line:
                    px = ox + gx * sc + slant * gy * sc
                    py = -gy * sc
                    if jitter:
                        px += rng.normal(0, jitter)
                        py += rng.normal(0, jitter)
                    pts.append((x + px * ca - py * sa, y + px * sa + py * ca))
                if wobble:
                    pts = wobbly(pts, wobble, rng)
                self.stroke(pts, width, color, alpha, soft)
        return total


def seg_dist(x, y, x0, y0, x1, y1):
    dx, dy = x1 - x0, y1 - y0
    L2 = dx * dx + dy * dy + 1e-12
    t = np.clip(((x - x0) * dx + (y - y0) * dy) / L2, 0, 1)
    px = x0 + t * dx - x
    py = y0 + t * dy - y
    return np.sqrt(px * px + py * py)


def wobbly(pts, amp, rng, step=3.0):
    """Resample a polyline and jitter it (hand-drawn look)."""
    out = []
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        L = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(L / step))
        for k in range(n):
            t = k / n
            out.append((x0 + (x1 - x0) * t + rng.normal(0, amp), y0 + (y1 - y0) * t + rng.normal(0, amp)))
    out.append(pts[-1])
    return out


def box_blur(a, r, axis):
    if r < 1:
        return a
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r + 1, r)
    p = np.pad(a, pad, mode='edge')
    cs = np.cumsum(p, axis=axis, dtype=np.float64)
    n = a.shape[axis]
    hi = np.take(cs, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(cs, np.arange(0, n), axis=axis)
    return ((hi - lo) / (2 * r + 1)).astype(np.float32)


def blur(a, sigma):
    """Approximate gaussian (3 box passes)."""
    if sigma <= 0.3:
        return a
    r = max(1, int(round(sigma * 0.85)))
    for _ in range(3):
        a = box_blur(box_blur(a, r, 0), r, 1)
    return a


def vnoise(w, h, cell, seed=0, octaves=4, persist=0.5):
    """fBm value noise in [0, 1], `cell` = size of the first octave in pixels."""
    rng = np.random.default_rng(seed)
    out = np.zeros((h, w), dtype=np.float32)
    amp, tot = 1.0, 0.0
    c = float(cell)
    for _ in range(octaves):
        gw, gh = int(w / c) + 3, int(h / c) + 3
        g = rng.random((gh, gw)).astype(np.float32)
        ys = (np.arange(h) + 0.5) / c
        xs = (np.arange(w) + 0.5) / c
        y0 = np.floor(ys).astype(int)
        x0 = np.floor(xs).astype(int)
        fy = ys - y0
        fx = xs - x0
        fy = fy * fy * (3 - 2 * fy)
        fx = fx * fx * (3 - 2 * fx)
        a = g[y0][:, x0]
        b = g[y0][:, x0 + 1]
        cc = g[y0 + 1][:, x0]
        d = g[y0 + 1][:, x0 + 1]
        top = a + (b - a) * fx[None, :]
        bot = cc + (d - cc) * fx[None, :]
        out += amp * (top + (bot - top) * fy[:, None])
        tot += amp
        amp *= persist
        c = max(1.0, c / 2)
    return out / tot


def smooth(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    t = np.asarray(t, dtype=np.float32)
    if t.ndim == 2:
        t = t[..., None]
    return a * (1 - t) + np.asarray(b, dtype=np.float32) * t


def to_gray(a):
    return a[..., 0] * 0.3 + a[..., 1] * 0.59 + a[..., 2] * 0.11


# =============================================================================================
# Stroke font: glyphs on a 4 x 6 grid (y up), lists of polylines
# =============================================================================================

_O = [(1, 0), (0, 1), (0, 5), (1, 6), (3, 6), (4, 5), (4, 1), (3, 0), (1, 0)]
_P = [(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)]
FONT = {
    'A': [[(0, 0), (2, 6), (4, 0)], [(0.8, 2.4), (3.2, 2.4)]],
    'B': [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)], [(3, 3), (4, 2), (4, 1), (3, 0), (0, 0)]],
    'C': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 1), (1, 0), (3, 0), (4, 1)]],
    'D': [[(0, 0), (0, 6), (2.5, 6), (4, 4.5), (4, 1.5), (2.5, 0), (0, 0)]],
    'E': [[(4, 6), (0, 6), (0, 0), (4, 0)], [(0, 3), (3, 3)]],
    'F': [[(4, 6), (0, 6), (0, 0)], [(0, 3), (3, 3)]],
    'G': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 1), (1, 0), (3, 0), (4, 1), (4, 3), (2, 3)]],
    'H': [[(0, 0), (0, 6)], [(4, 0), (4, 6)], [(0, 3), (4, 3)]],
    'I': [[(2, 0), (2, 6)], [(1, 6), (3, 6)], [(1, 0), (3, 0)]],
    'J': [[(4, 6), (4, 1), (3, 0), (1, 0), (0, 1)]],
    'K': [[(0, 0), (0, 6)], [(4, 6), (0, 2)], [(1.3, 3.3), (4, 0)]],
    'L': [[(0, 6), (0, 0), (4, 0)]],
    'M': [[(0, 0), (0, 6), (2, 3), (4, 6), (4, 0)]],
    'N': [[(0, 0), (0, 6), (4, 0), (4, 6)]],
    'O': [_O],
    'P': [_P],
    'Q': [_O, [(2.5, 1.5), (4, 0)]],
    'R': [_P, [(2, 3), (4, 0)]],
    'S': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 4), (1, 3), (3, 3), (4, 2), (4, 1), (3, 0), (1, 0), (0, 1)]],
    'T': [[(0, 6), (4, 6)], [(2, 6), (2, 0)]],
    'U': [[(0, 6), (0, 1), (1, 0), (3, 0), (4, 1), (4, 6)]],
    'V': [[(0, 6), (2, 0), (4, 6)]],
    'W': [[(0, 6), (1, 0), (2, 4), (3, 0), (4, 6)]],
    'X': [[(0, 0), (4, 6)], [(0, 6), (4, 0)]],
    'Y': [[(0, 6), (2, 3), (4, 6)], [(2, 3), (2, 0)]],
    'Z': [[(0, 6), (4, 6), (0, 0), (4, 0)]],
    '0': [_O, [(0.5, 1), (3.5, 5)]],
    '1': [[(1, 5), (2, 6), (2, 0)], [(1, 0), (3, 0)]],
    '2': [[(0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (0, 0), (4, 0)]],
    '3': [[(0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (3, 3), (1.5, 3)], [(3, 3), (4, 2), (4, 1), (3, 0), (1, 0), (0, 1)]],
    '4': [[(3, 0), (3, 6), (0, 2), (4, 2)]],
    '5': [[(4, 6), (0, 6), (0, 3.5), (3, 3.5), (4, 2.5), (4, 1), (3, 0), (1, 0), (0, 1)]],
    '6': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 1), (1, 0), (3, 0), (4, 1), (4, 2.5), (3, 3.5), (0, 3.5)]],
    '7': [[(0, 6), (4, 6), (1.5, 0)]],
    '8': [[(1, 3), (0, 4), (0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (3, 3), (1, 3), (0, 2), (0, 1), (1, 0), (3, 0),
           (4, 1), (4, 2), (3, 3)]],
    '9': [[(0, 1), (1, 0), (3, 0), (4, 1), (4, 5), (3, 6), (1, 6), (0, 5), (0, 3.5), (1, 2.5), (4, 2.5)]],
    '.': [[(2, 0), (2, 0.4)]],
    ',': [[(2, 0.4), (1.5, -1)]],
    '-': [[(1, 3), (3, 3)]],
    "'": [[(2, 6), (2, 4.5)]],
    '!': [[(2, 6), (2, 2)], [(2, 0.2), (2, 0.5)]],
    '?': [[(0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (2, 2.5), (2, 1.6)], [(2, 0.2), (2, 0.5)]],
    ':': [[(2, 1), (2, 1.4)], [(2, 4), (2, 4.4)]],
    '&': [[(4, 0), (1, 4), (1, 5), (2, 6), (3, 5), (3, 4), (0, 1.5), (0, 1), (1, 0), (2.5, 0), (4, 2)]],
    ' ': [],
}


# =============================================================================================
# Photo: family portrait (oval, sepia, father's face scratched out)
# =============================================================================================

def draw_face(cv, cx, cy, rx, ry, hair=None, tone=0.86, turn=0.0, girl=False):
    """A soft, studio-lit face (sepia photo look): neck, ears, shading, sockets, eyes, nose, mouth."""
    cv.fill(cv.poly([(cx - rx * 0.42, cy + ry * 0.6), (cx + rx * 0.42, cy + ry * 0.6),
                     (cx + rx * 0.5, cy + ry * 1.5), (cx - rx * 0.5, cy + ry * 1.5)], 1.2), tone * 0.72)
    for sgn in (-1, 1):
        cv.fill(cv.ellipse(cx + sgn * rx * 0.97, cy + ry * 0.08, rx * 0.16, ry * 0.21, 0, 1.2), tone * 0.78)
    # jaw slightly narrower than the forehead
    cv.fill(cv.ellipse(cx, cy - ry * 0.05, rx, ry * 0.95, 0, 1.2), tone)
    cv.fill(cv.ellipse(cx, cy + ry * 0.35, rx * 0.8, ry * 0.65, 0, 1.2), tone)
    face_m = np.maximum(cv.ellipse(cx, cy - ry * 0.05, rx, ry * 0.95, 0, 2.0), cv.ellipse(cx, cy + ry * 0.35, rx * 0.8, ry * 0.65, 0, 2))
    sh = smooth((cv.xx - cx) / rx, 0.0, 1.05) * face_m
    cv.mul(1 - 0.3 * sh)
    for sgn in (-1, 1):
        ex = cx + sgn * rx * 0.38 + turn * rx
        ey = cy - ry * 0.1
        cv.fill(cv.ellipse(ex, ey, rx * 0.26, ry * 0.14, 0, 2.5), 0.0, 0.28)          # socket
        cv.fill(cv.ellipse(ex, ey + ry * 0.01, rx * 0.15, ry * 0.065, 0, 1.0), 0.95, 0.5)  # eye white
        cv.fill(cv.ellipse(ex + turn * rx * 0.2, ey + ry * 0.01, rx * 0.075, ry * 0.07, 0, 0.8), 0.05, 0.9)
        cv.fill(cv.ellipse(ex - rx * 0.03, ey - ry * 0.02, rx * 0.025, ry * 0.022, 0, 0.6), 0.95, 0.7)
        cv.stroke([(ex - rx * 0.22 * sgn, ey - ry * 0.2), (ex, ey - ry * 0.25 - (0.03 if girl else 0) * ry),
                   (ex + rx * 0.22 * sgn, ey - ry * 0.21)], max(1.2, ry * 0.07), (0.12, 0.12, 0.12), 0.75, 1.0)
    nx = cx + turn * rx
    cv.fill(cv.poly([(nx + rx * 0.03, cy - ry * 0.05), (nx + rx * 0.17, cy + ry * 0.3), (nx - rx * 0.04, cy + ry * 0.34)], 1.6), 0.0, 0.22)
    cv.fill(cv.ellipse(nx, cy + ry * 0.33, rx * 0.16, ry * 0.06, 0, 1.2), 0.0, 0.12)
    for sgn in (-1, 1):
        cv.fill(cv.ellipse(nx + sgn * rx * 0.07, cy + ry * 0.34, rx * 0.045, ry * 0.025, 0, 0.8), 0.1, 0.55)
    my = cy + ry * 0.56
    cv.fill(cv.ellipse(nx, my - ry * 0.01, rx * 0.22, ry * 0.05, 0, 1.0), 0.25, 0.5)
    cv.stroke([(nx - rx * 0.24, my), (nx, my + ry * 0.02), (nx + rx * 0.24, my - ry * 0.01)], max(1.0, ry * 0.045),
              (0.08, 0.08, 0.08), 0.85, 0.9)
    cv.fill(cv.ellipse(nx, my + ry * 0.11, rx * 0.15, ry * 0.045, 0, 1.5), 0.0, 0.15)
    cv.fill(cv.ellipse(cx, cy + ry * 1.0, rx * 0.6, ry * 0.1, 0, 3), 0.0, 0.3)
    if hair is not None:
        hair(cx, cy, rx, ry)


def _hair_cap(cv, cx, cy, rx, ry, line, col, part=0.0):
    """Hair mass above a curved hairline at (cy - line * ry)."""
    hl = cy - ry * line + ry * 0.25 * ((cv.xx - cx) / rx) ** 2
    m = cv.ellipse(cx, cy - ry * 0.25, rx * 1.08, ry * 0.95, 0, 1.2) * smooth(hl - cv.yy, -1.0, 1.5)
    cv.fill(m, col)
    # sheen
    cv.fill(m * cv.ellipse(cx - rx * 0.3, cy - ry * 0.8, rx * 0.45, ry * 0.18, -0.3, 6), 0.45, 0.35)
    if part:
        cv.stroke([(cx + rx * part, cy - ry * 0.95), (cx + rx * part * 0.8, cy - ry * 0.55)], 1.0, (0.4, 0.4, 0.4), 0.5)


def portrait_photo(w=320, h=400, seed=7):
    cv = Canvas(w, h, (0.5, 0.5, 0.5), seed)
    X, Y = cv.xx / w, cv.yy / h
    halo = np.exp(-(((X - 0.48) / 0.4) ** 2 + ((Y - 0.38) / 0.45) ** 2))
    mott = vnoise(w, h, 60, seed, 4)
    cv.a[:] = (0.25 + 0.42 * halo + 0.14 * (mott - 0.5))[..., None]
    S = lambda a: a * w  # noqa: E731
    T = lambda a: a * h  # noqa: E731

    # ---- father: very tall, standing behind on the right; head almost leaving the frame
    coat = [(S(0.40), T(0.38)), (S(0.50), T(0.285)), (S(0.76), T(0.285)), (S(0.90), T(0.38)), (S(0.95), T(1.0)),
            (S(0.36), T(1.0))]
    cv.fill(cv.poly(coat, 1.5), 0.1)
    cv.fill(cv.poly([(S(0.57), T(0.27)), (S(0.69), T(0.27)), (S(0.67), T(0.44)), (S(0.63), T(0.48)), (S(0.59), T(0.44))], 1.2), 0.88)
    cv.fill(cv.poly([(S(0.617), T(0.30)), (S(0.643), T(0.30)), (S(0.652), T(0.46)), (S(0.63), T(0.49)), (S(0.608), T(0.46))], 1.0), 0.2)
    cv.stroke([(S(0.565), T(0.285)), (S(0.598), T(0.47)), (S(0.55), T(0.64))], 2.0, (0.26, 0.26, 0.26), 0.8)
    cv.stroke([(S(0.695), T(0.285)), (S(0.662), T(0.47)), (S(0.715), T(0.64))], 2.0, (0.26, 0.26, 0.26), 0.8)
    for by in (0.55, 0.62):
        cv.fill(cv.ellipse(S(0.63), T(by), 2.0, 2.0, 0, 0.8), 0.4)
    # long arm reaching down to the mother's shoulder, very long fingers
    cv.stroke([(S(0.46), T(0.35)), (S(0.40), T(0.47)), (S(0.37), T(0.50))], S(0.075), (0.09, 0.09, 0.09), 1.0, 2.0)
    for k in range(4):
        cv.stroke([(S(0.36), T(0.505)), (S(0.335 - 0.012 * k), T(0.53 + 0.008 * k))], 2.6, (0.66, 0.66, 0.66), 0.95, 1.0)
    cv.fill(cv.ellipse(S(0.36), T(0.505), S(0.03), T(0.018), 0.4, 1.2), 0.68)
    draw_face(cv, S(0.63), T(0.165), S(0.088), T(0.078),
              lambda cx, cy, rx, ry: _hair_cap(cv, cx, cy, rx, ry, 0.62, 0.12, part=-0.4), 0.84, 0.05)
    scratch_out(cv, S(0.63), T(0.165), S(0.088) * 1.3, T(0.078) * 1.25, seed + 5)

    # ---- mother, seated center-left
    dress = [(S(0.20), T(0.55)), (S(0.29), T(0.485)), (S(0.47), T(0.485)), (S(0.56), T(0.55)), (S(0.66), T(0.82)),
             (S(0.70), T(1.0)), (S(0.10), T(1.0)), (S(0.15), T(0.8))]
    cv.fill(cv.poly(dress, 1.5), 0.19)
    cv.fill(cv.poly([(S(0.30), T(0.48)), (S(0.46), T(0.48)), (S(0.44), T(0.54)), (S(0.38), T(0.57)), (S(0.32), T(0.54))], 1.2), 0.84)
    for k in range(10):
        cv.fill(cv.ellipse(S(0.305 + k * 0.0165), T(0.54 + 0.022 * math.sin(k * 0.62)), S(0.009), T(0.008), 0, 0.8), 0.9)
    cv.fill(cv.ellipse(S(0.38), T(0.59), S(0.013), T(0.013), 0, 0.8), 0.8)
    for k in range(5):  # buttons + dress folds
        cv.stroke([(S(0.25 + 0.07 * k), T(0.66)), (S(0.22 + 0.08 * k), T(0.98))], 2.0, (0.3, 0.3, 0.3), 0.35, 2)
    cv.fill(cv.ellipse(S(0.40), T(0.78), S(0.065), T(0.032), -0.2, 1.5), 0.74)
    cv.fill(cv.ellipse(S(0.45), T(0.77), S(0.05), T(0.028), 0.3, 1.5), 0.7)

    def woman_hair(cx, cy, rx, ry):
        _hair_cap(cv, cx, cy, rx, ry, 0.5, 0.16)
        cv.fill(cv.ellipse(cx + rx * 0.15, cy - ry * 1.08, rx * 0.55, ry * 0.38, 0, 1.2), 0.15)
        for sgn in (-1, 1):
            cv.fill(cv.ellipse(cx + sgn * rx * 0.95, cy - ry * 0.35, rx * 0.28, ry * 0.45, 0, 1.5), 0.17)

    draw_face(cv, S(0.38), T(0.395), S(0.08), T(0.07), woman_hair, 0.88, -0.05)

    # ---- girl, standing front-left in a white dress, holding a doll
    gd = [(S(0.08), T(0.71)), (S(0.12), T(0.645)), (S(0.26), T(0.645)), (S(0.30), T(0.71)), (S(0.35), T(0.95)),
          (S(0.03), T(0.95))]
    cv.fill(cv.poly(gd, 1.5), 0.8)
    cv.fill(cv.poly([(S(0.05), T(0.84)), (S(0.33), T(0.84)), (S(0.345), T(0.89)), (S(0.04), T(0.89))], 1.5), 0.0, 0.12)
    for k in range(4):
        x0 = S(0.11 + 0.05 * k)
        cv.stroke([(x0, T(0.72)), (x0 - S(0.01), T(0.94))], 2.0, (0.45, 0.45, 0.45), 0.35, 2)
    cv.fill(cv.ellipse(S(0.27), T(0.76), S(0.022), T(0.032), 0, 1), 0.72)
    cv.fill(cv.ellipse(S(0.285), T(0.725), S(0.018), T(0.018), 0, 1), 0.64)

    def girl_hair(cx, cy, rx, ry):
        _hair_cap(cv, cx, cy, rx, ry, 0.45, 0.22, part=0.0)
        for sgn in (-1, 1):
            cv.fill(cv.ellipse(cx + sgn * rx * 1.05, cy + ry * 0.4, rx * 0.24, ry * 0.7, 0, 1.2), 0.24)
        cv.fill(cv.poly([(cx + rx * 0.3, cy - ry * 1.0), (cx + rx * 1.15, cy - ry * 1.55), (cx + rx * 1.15, cy - ry * 0.55)], 1.0), 0.9)
        cv.fill(cv.poly([(cx + rx * 0.3, cy - ry * 1.0), (cx - rx * 0.45, cy - ry * 1.55), (cx - rx * 0.45, cy - ry * 0.55)], 1.0), 0.86)
        cv.fill(cv.ellipse(cx + rx * 0.3, cy - ry * 1.0, rx * 0.15, ry * 0.15, 0, 1.0), 0.75)

    draw_face(cv, S(0.19), T(0.575), S(0.07), T(0.06), girl_hair, 0.9, 0.04, girl=True)

    cv.mul(1 - 0.35 * smooth(Y, 0.88, 1.0))
    a = blur(cv.a, 0.8)
    g = to_gray(a)
    g = 0.13 + 0.74 * np.clip(g, 0, 1) ** 1.05
    g = g + (vnoise(w, h, 1.5, seed + 2, 2) - 0.5) * 0.05
    a = lerp(hexa('34261a'), hexa('dccaa6'), np.clip(g, 0, 1))
    r = np.sqrt(((X - 0.5) / 0.5) ** 2 + ((Y - 0.5) / 0.5) ** 2)
    mirror = smooth(r, 0.78, 1.05) * (0.6 + 0.4 * vnoise(w, h, 20, seed + 3, 3))
    a = lerp(a, hexa('5d6062'), mirror * 0.5)
    fox = vnoise(w, h, 3, seed + 4, 2)
    a = lerp(a, hexa('7a5634'), smooth(fox, 0.82, 0.87) * 0.5)
    tide = vnoise(w, h, 90, seed + 6, 3)
    t = smooth(tide, 0.6, 0.62) * (1 - smooth(tide, 0.62, 0.66))
    low = smooth(Y, 0.6, 0.75)
    a = lerp(a, hexa('6b4a2a'), t * 0.4 * low)
    a = lerp(a, hexa('a88a5c'), smooth(tide, 0.62, 0.7) * 0.2 * low)
    return np.clip(a, 0, 1)


def girl_photo(w=160, h=200, seed=8):
    """School-style head-and-shoulders photo of the girl (for the MISSING poster)."""
    cv = Canvas(w, h, (0.55, 0.55, 0.55), seed)
    X, Y = cv.xx / w, cv.yy / h
    cv.a[:] = (0.5 + 0.25 * np.exp(-(((X - 0.5) / 0.4) ** 2 + ((Y - 0.4) / 0.5) ** 2)))[..., None]
    cv.fill(cv.poly([(w * 0.1, h), (w * 0.2, h * 0.78), (w * 0.8, h * 0.78), (w * 0.9, h)], 1.5), 0.82)
    cv.fill(cv.poly([(w * 0.38, h * 0.78), (w * 0.62, h * 0.78), (w * 0.5, h * 0.9)], 1.2), 0.92)

    def hair(cx, cy, rx, ry):
        _hair_cap(cv, cx, cy, rx, ry, 0.45, 0.22)
        for sgn in (-1, 1):
            cv.fill(cv.ellipse(cx + sgn * rx * 1.02, cy + ry * 0.35, rx * 0.2, ry * 0.6, 0, 1.2), 0.24)
        bx, by = cx + rx * 0.55, cy - ry * 0.95
        cv.fill(cv.poly([(bx, by), (bx + rx * 0.45, by - ry * 0.28), (bx + rx * 0.45, by + ry * 0.25)], 1.0), 0.9)
        cv.fill(cv.poly([(bx, by), (bx - rx * 0.4, by - ry * 0.28), (bx - rx * 0.4, by + ry * 0.25)], 1.0), 0.86)

    draw_face(cv, w * 0.5, h * 0.47, w * 0.24, h * 0.2, hair, 0.9, 0.03, girl=True)
    g = to_gray(blur(cv.a, 0.8))
    return np.clip(g, 0, 1)


def scratch_out(cv, cx, cy, rx, ry, seed):
    """Violent scratches through the emulsion: bright paper lines + torn patches."""
    rng = np.random.default_rng(seed)
    paper = hexa('f2ebdc')
    # torn-off emulsion patch (irregular)
    ang = np.linspace(0, 2 * np.pi, 22, endpoint=False)
    rad = 0.55 + 0.35 * rng.random(22)
    pts = [(cx + math.cos(a_) * rx * r_ * 0.75, cy + math.sin(a_) * ry * r_ * 0.7) for a_, r_ in zip(ang, rad)]
    cv.fill(cv.poly(pts, 1.0), paper * 0.95, 0.9)
    for _ in range(46):
        a0 = rng.normal(-0.9, 0.5)
        L = rng.uniform(0.9, 2.2)
        x0 = cx + rng.uniform(-1, 1) * rx * 0.8
        y0 = cy + rng.uniform(-1, 1) * ry * 0.8
        dx, dy = math.cos(a0) * rx * L / 2, math.sin(a0) * ry * L / 2
        pts = wobbly([(x0 - dx, y0 - dy), (x0 + dx, y0 + dy)], 0.6, rng, 4.0)
        cv.stroke(pts, rng.uniform(0.9, 2.2), paper * rng.uniform(0.8, 1.0), rng.uniform(0.6, 1.0), 0.7)
    # dark gouged pressure lines (pen/knife point)
    for _ in range(10):
        a0 = rng.uniform(0, math.pi)
        x0, y0 = cx + rng.normal(0, rx * 0.3), cy + rng.normal(0, ry * 0.3)
        dx, dy = math.cos(a0) * rx * 0.9, math.sin(a0) * ry * 0.9
        cv.stroke(wobbly([(x0 - dx, y0 - dy), (x0 + dx, y0 + dy)], 0.5, rng, 3.0), 1.0, (0.06, 0.05, 0.04), 0.6, 0.7)


# =============================================================================================
# Painting: dusk landscape with a distant figure, darkened varnish, a knife slash
# =============================================================================================

def landscape_painting(w=512, h=352, seed=11):
    cv = Canvas(w, h, (0.5, 0.5, 0.5), seed)
    X, Y = cv.xx / w, cv.yy / h
    sky_top = hexa('3c4a55')
    sky_mid = hexa('8d8a72')
    sky_low = hexa('c9a86a')
    t = np.clip(Y / 0.55, 0, 1)
    a = lerp(lerp(sky_top, sky_mid, smooth(t, 0, 0.6)), sky_low, smooth(t, 0.55, 1.0))
    # clouds: streaky brush noise
    cl = vnoise(w, h, 70, seed, 5)
    cl2 = blur(vnoise(w * 1, h, 12, seed + 1, 3), 2)
    cloud = smooth(cl * 0.7 + cl2 * 0.3, 0.52, 0.72) * (1 - smooth(Y, 0.3, 0.5))
    a = lerp(a, hexa('5a5a56'), cloud * 0.7)
    a = lerp(a, hexa('b8a476'), smooth(cl, 0.35, 0.2) * (1 - smooth(Y, 0.2, 0.5)) * 0.35)
    cv.a = a
    # far hills, near hills
    xs = np.arange(w) / w
    n1 = vnoise(w, 1, 90, seed + 2, 4)[0]
    n2 = vnoise(w, 1, 60, seed + 3, 4)[0]
    hill1 = 0.50 - 0.08 * np.sin(xs * 3.1 + 0.6) - 0.06 * (n1 - 0.5)
    hill2 = 0.60 - 0.05 * np.sin(xs * 5.0 + 2.0) - 0.08 * (n2 - 0.5) + 0.04 * xs
    m1 = smooth(Y - hill1[None, :], -0.002, 0.004)
    cv.fill(m1, hexa('4e5a52'))
    cv.a = lerp(cv.a, hexa('6f7764'), m1 * smooth(Y, 0.5, 0.65) * 0.4)
    m2 = smooth(Y - hill2[None, :], -0.002, 0.004)
    field = lerp(hexa('5c5a3a'), hexa('3a3a26'), smooth(Y, 0.6, 1.0))
    fn = vnoise(w, h, 18, seed + 4, 4)
    field = lerp(field, hexa('7a6e44'), smooth(fn, 0.55, 0.8) * 0.5)
    cv.a = lerp(cv.a, field, m2)
    # a winding path toward the house
    path = np.abs(X - (0.42 + 0.12 * np.sin((1 - Y) * 9.0) * (Y - 0.6) * 2.5)) - (0.004 + 0.06 * smooth(Y, 0.62, 1.0))
    cv.fill(smooth(-path, -0.004, 0.004) * (Y > 0.62), hexa('8a7a58'), 0.65)
    # farmhouse on the hill (small, dark, one window lit faintly)
    hx, hy = 0.62 * w, hill2[int(0.62 * w)] * h + 2
    cv.fill(cv.poly([(hx - 18, hy), (hx - 18, hy - 16), (hx, hy - 30), (hx + 18, hy - 16), (hx + 18, hy)], 1.0), hexa('2a2620'))
    cv.fill(cv.poly([(hx + 18, hy), (hx + 18, hy - 16), (hx + 40, hy - 14), (hx + 40, hy)], 1.0), hexa('23201b'))
    cv.fill(cv.poly([(hx + 8, hy - 26), (hx + 12, hy - 26), (hx + 12, hy - 34), (hx + 8, hy - 34)], 0.8), hexa('201d18'))
    cv.fill(cv.ellipse(hx - 6, hy - 10, 2.2, 2.6, 0, 0.8), hexa('c49a4a'), 0.8)
    # dead tree on the right
    rng = np.random.default_rng(seed + 9)

    def branch(x, y, ang, L, wd, depth):
        x1, y1 = x + math.cos(ang) * L, y - math.sin(ang) * L
        cv.stroke(wobbly([(x, y), (x1, y1)], 0.6, rng, 4), wd, hexa('1d1a16'), 1.0, 1.0)
        if depth > 0:
            for _ in range(2 if depth < 3 else 3):
                branch(x1, y1, ang + rng.uniform(-0.7, 0.7), L * rng.uniform(0.55, 0.75), wd * 0.62, depth - 1)

    branch(0.82 * w, 0.86 * h, math.radians(92), 0.2 * h, 8.0, 5)
    # a tall thin figure standing in the field, far away (barely there)
    fxp, fyp = 0.53 * w, 0.715 * h
    cv.fill(cv.poly([(fxp - 1.6, fyp), (fxp + 1.6, fyp), (fxp + 1.2, fyp - 24), (fxp - 1.2, fyp - 24)], 0.8), hexa('15130f'), 0.85)
    cv.fill(cv.ellipse(fxp, fyp - 26, 1.8, 2.4, 0, 0.6), hexa('15130f'), 0.85)
    cv.stroke([(fxp - 1.4, fyp - 22), (fxp - 2.6, fyp - 6)], 1.0, hexa('15130f'), 0.8)
    cv.stroke([(fxp + 1.4, fyp - 22), (fxp + 2.8, fyp - 5)], 1.0, hexa('15130f'), 0.8)
    # foreground grass strokes
    for _ in range(260):
        x0 = rng.uniform(0, w)
        y0 = rng.uniform(0.8 * h, h)
        L = rng.uniform(4, 14)
        a0 = math.radians(90 + rng.normal(0, 15))
        c = hexa('2e2c1c') if rng.random() < 0.6 else hexa('6a6038')
        cv.stroke([(x0, y0), (x0 + math.cos(a0) * L, y0 - math.sin(a0) * L)], 1.2, c, 0.6)
    a = cv.a
    # brush texture: directional smear
    bt = blur(vnoise(w, h, 3, seed + 5, 2), 0.6)
    a = a * (0.92 + 0.16 * bt[..., None])
    # darkened, yellowed varnish + vignette (grime collected toward the frame)
    a = a * hexa('c8b07a') * 1.05
    v = np.sqrt(((X - 0.5) / 0.6) ** 2 + ((Y - 0.5) / 0.6) ** 2)
    a = a * (1 - 0.45 * smooth(v, 0.55, 1.05))[..., None]
    a = 0.07 + a * 1.0
    # slash: a knife cut across the canvas, lower left to upper right
    cv.a = a
    _slash(cv, w, h, seed, paint=True)
    return np.clip(cv.a, 0, 1)


def _slash_path(w, h):
    return [(0.16 * w, 0.80 * h), (0.27 * w, 0.64 * h), (0.37 * w, 0.52 * h), (0.47 * w, 0.43 * h)]


def _slash(cv, w, h, seed, paint):
    rng = np.random.default_rng(seed + 9)
    sl = wobbly(_slash_path(w, h), 0.7, rng, 4)
    if paint:
        # paint cracked and flaked along the cut, raw canvas fibers at the lips, black gap
        cv.stroke(sl, 11.0, hexa('3a3226'), 0.5, 3.0, taper=True)
        frng = np.random.default_rng(seed + 10)
        for (x, y) in sl[::2]:
            for _ in range(2):
                a0 = frng.uniform(0, 2 * math.pi)
                L = frng.uniform(2, 6)
                cv.stroke([(x, y), (x + math.cos(a0) * L, y + math.sin(a0) * L)], 0.7, hexa('a89a78'), 0.5, 0.6)
        cv.stroke(sl, 5.0, hexa('8a7c5e'), 0.9, 1.0, taper=True)
        cv.stroke([(x + 0.8, y + 0.6) for x, y in sl], 3.8, hexa('020202'), 1.0, 0.8, taper=True)
    else:
        cv.stroke(sl, 4.0, (0, 0, 0), 1.0, 1.5, taper=True)


def slash_mask(w=512, h=352, seed=11):
    """Height map for the slash (for bump): 0 = gap, 1 = canvas."""
    cv = Canvas(w, h, (1, 1, 1), seed)
    _slash(cv, w, h, seed, paint=False)
    return blur(cv.a, 1.0)[..., 0]


# =============================================================================================
# Clock dial
# =============================================================================================

def clock_dial(n=512, seed=3):
    cv = Canvas(n, n, hexa('d8cfb8'), seed)
    c = n / 2
    X, Y = cv.xx - c, cv.yy - c
    R = np.sqrt(X * X + Y * Y) / c
    ink = hexa('17130f')
    # chapter ring circles
    for rr, wd in ((0.94, 2.2), (0.87, 1.4), (0.64, 1.6)):
        d = np.abs(R - rr) * c - wd / 2
        cv.fill(np.clip(0.5 - d, 0, 1), ink, 0.95)
    # minute ticks
    for k in range(60):
        a = 2 * math.pi * k / 60
        r0, r1 = (0.87, 0.94)
        wd = 2.6 if k % 5 == 0 else 1.2
        sx, sy = math.sin(a), -math.cos(a)
        cv.stroke([(c + sx * r0 * c, c + sy * r0 * c), (c + sx * r1 * c, c + sy * r1 * c)], wd, ink, 0.95, 0.8)
    # roman numerals (radial, feet toward the center)
    nums = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI']
    size = 0.155 * c
    for k, s in enumerate(nums):
        a = 2 * math.pi * k / 12
        rr = 0.665 * c
        bx, by = c + math.sin(a) * rr, c - math.cos(a) * rr
        ang = a  # text baseline direction rotated with the dial position
        width = sum(_roman_w(ch) for ch in s) * size
        # baseline start so the numeral is centered on its radius line
        ux, uy = math.cos(ang), math.sin(ang)
        x0, y0 = bx - ux * width / 2, by - uy * width / 2
        cur = 0.0
        for ch in s:
            _roman(cv, ch, x0 + ux * cur, y0 + uy * cur, size, ang, ink)
            cur += _roman_w(ch) * size
    # maker name + "MADE IN U.S.A."
    cv.text('W. HARROW & SONS', c, c - 0.30 * c, 0.055 * c, 1.6, ink, 0.85, 0.0, 1.25, align='center')
    cv.text('NEW HAVEN', c, c - 0.22 * c, 0.04 * c, 1.2, ink, 0.8, 0.0, 1.3, align='center')
    # winding holes with brass bushings + grime rings
    for hx in (-0.3, 0.3):
        px, py = c + hx * c, c + 0.32 * c
        cv.fill(cv.ellipse(px, py, 0.075 * c, 0.075 * c, 0, 2.0), hexa('3d3020'), 0.5)
        cv.fill(cv.ellipse(px, py, 0.045 * c, 0.045 * c, 0, 1.0), hexa('8a6a34'))
        cv.fill(cv.ellipse(px, py, 0.022 * c, 0.022 * c, 0, 1.0), hexa('0b0907'))
        # key scuffs around the holes
        rng = cv.rng
        for _ in range(8):
            a0 = rng.uniform(0, 2 * math.pi)
            r0 = 0.05 * c
            cv.stroke([(px + math.cos(a0) * r0, py + math.sin(a0) * r0),
                       (px + math.cos(a0 + 0.6) * r0 * 1.4, py + math.sin(a0 + 0.6) * r0 * 1.4)], 1.0, hexa('4a3c2a'), 0.5)
    # center boss
    cv.fill(cv.ellipse(c, c, 0.05 * c, 0.05 * c, 0, 1.0), hexa('2a2219'))
    a = cv.a
    # aging: yellowed toward the edge, tobacco/water stain, crazing, chipped enamel
    st = vnoise(n, n, 120, seed, 4)
    a = lerp(a, hexa('b49a68'), smooth(R, 0.5, 1.0) * 0.45 + smooth(st, 0.55, 0.8) * 0.35)
    tide = vnoise(n, n, 160, seed + 1, 3)
    ring = smooth(tide, 0.62, 0.635) * (1 - smooth(tide, 0.635, 0.66))
    a = lerp(a, hexa('8a6a40'), ring * 0.3)
    fox = vnoise(n, n, 3, seed + 2, 2)
    a = lerp(a, hexa('7a5530'), smooth(fox, 0.82, 0.87) * 0.6)
    chip = vnoise(n, n, 14, seed + 3, 3)
    chipm = smooth(chip, 0.74, 0.75) * smooth(R, 0.85, 0.98)
    a = lerp(a, hexa('2a2622'), chipm)
    outside = R > 1.0
    a[outside] = hexa('3a3026')
    return np.clip(a, 0, 1)


def _roman_w(ch):
    return {'I': 0.32, 'V': 0.72, 'X': 0.72}[ch]


def _roman(cv, ch, x, y, size, ang, ink):
    """One serif roman numeral glyph; (x, y) = baseline left; rotated by ang (dial angle)."""
    ca, sa = math.cos(ang), math.sin(ang)

    def P(u, v):  # u along baseline, v up (away from the dial center)
        return (x + u * size * ca + v * size * sa, y + u * size * sa - v * size * ca)

    thick = size * 0.13
    thin = size * 0.05
    if ch == 'I':
        cv.stroke([P(0.16, 0.0), P(0.16, 1.0)], thick, ink, 0.95, 0.8)
        cv.stroke([P(0.02, 0.0), P(0.30, 0.0)], thin, ink, 0.95, 0.8)
        cv.stroke([P(0.02, 1.0), P(0.30, 1.0)], thin, ink, 0.95, 0.8)
    elif ch == 'V':
        cv.stroke([P(0.06, 1.0), P(0.36, 0.0)], thick, ink, 0.95, 0.8)
        cv.stroke([P(0.36, 0.0), P(0.66, 1.0)], thin, ink, 0.95, 0.8)
        cv.stroke([P(-0.04, 1.0), P(0.2, 1.0)], thin, ink, 0.95, 0.8)
        cv.stroke([P(0.54, 1.0), P(0.76, 1.0)], thin, ink, 0.95, 0.8)
    elif ch == 'X':
        cv.stroke([P(0.06, 1.0), P(0.66, 0.0)], thick, ink, 0.95, 0.8)
        cv.stroke([P(0.06, 0.0), P(0.66, 1.0)], thin, ink, 0.95, 0.8)
        for u in (0.06, 0.66):
            cv.stroke([P(u - 0.12, 1.0), P(u + 0.12, 1.0)], thin, ink, 0.95, 0.8)
            cv.stroke([P(u - 0.12, 0.0), P(u + 0.12, 0.0)], thin, ink, 0.95, 0.8)


def regulator_glass(w=256, h=256, seed=4):
    """Gold-leaf 'REGULATOR' lettering mask for the lower door pane (texture's lower half = that pane;
    the upper half stays clear for the dial window)."""
    cv = Canvas(w, h, (0, 0, 0), seed)
    cv.text('REGULATOR', w / 2, h * 0.87, h * 0.055, h * 0.014, (1, 1, 1), 1.0, 0.0, 1.3, align='center',
            fit=w * 0.74)
    # thin gold border line around the lower pane
    yy, xx = cv.yy, cv.xx
    b = ((np.abs(xx - w * 0.06) < 0.8) | (np.abs(xx - w * 0.94) < 0.8)) & (yy > h * 0.53) & (yy < h * 0.95)
    b |= ((np.abs(yy - h * 0.53) < 0.8) | (np.abs(yy - h * 0.95) < 0.8)) & (xx > w * 0.06) & (xx < w * 0.94)
    cv.a[b] = 1.0
    m = cv.a[..., 0]
    flake = vnoise(w, h, 4, seed, 3)
    m = m * (1 - smooth(flake, 0.7, 0.74))
    # thin border line
    return np.clip(m, 0, 1)


# =============================================================================================
# Glass cracks (impact star + concentric rings)
# =============================================================================================

def crack_map(w=256, h=320, cx=0.62, cy=0.32, seed=5, rays=11):
    cv = Canvas(w, h, (0, 0, 0), seed)
    rng = np.random.default_rng(seed)
    px, py = cx * w, cy * h
    for k in range(rays):
        a = 2 * math.pi * k / rays + rng.normal(0, 0.18)
        L = rng.uniform(0.5, 1.4) * max(w, h)
        pts = [(px, py)]
        x, y = px, py
        steps = 12
        for s in range(steps):
            a += rng.normal(0, 0.12)
            x += math.cos(a) * L / steps
            y += math.sin(a) * L / steps
            pts.append((x, y))
        cv.stroke(pts, 1.4, (1, 1, 1), 0.95, 0.7, taper=True)
        # small side branches
        for _ in range(2):
            i0 = rng.integers(2, steps - 2)
            bx, by = pts[i0]
            ba = a + rng.choice([-1, 1]) * rng.uniform(0.5, 1.1)
            bl = rng.uniform(0.05, 0.18) * max(w, h)
            cv.stroke([(bx, by), (bx + math.cos(ba) * bl, by + math.sin(ba) * bl)], 1.0, (1, 1, 1), 0.8, 0.7, taper=True)
    for ring in (0.06, 0.13, 0.22):
        rr = ring * max(w, h)
        n = 28
        pts = []
        for k in range(n + 1):
            a = 2 * math.pi * k / n
            r = rr * rng.uniform(0.85, 1.15)
            pts.append((px + math.cos(a) * r, py + math.sin(a) * r))
        # broken ring: draw random arcs
        for k in range(n):
            if rng.random() < 0.6:
                cv.stroke([pts[k], pts[k + 1]], 1.1, (1, 1, 1), 0.85, 0.7)
    # crushed spot at the impact
    cv.fill(cv.ellipse(px, py, 6, 6, 0, 2.0), (1, 1, 1), 0.9)
    return np.clip(cv.a[..., 0], 0, 1)


# =============================================================================================
# Oriental rug
# =============================================================================================

def rug_pattern(w=1024, h=720, seed=21):
    """Persian-style design at knot resolution, then aged: faded, worn to the warp, frayed edges."""
    kx, ky = w // 4, h // 4  # knot grid
    Y, X = np.mgrid[0:ky, 0:kx].astype(np.float32)
    u = (X + 0.5) / kx  # 0..1 along length
    v = (Y + 0.5) / ky
    # distances to the edge in "short side" units
    du = np.minimum(u, 1 - u) * (w / h)
    dv = np.minimum(v, 1 - v)
    d = np.minimum(du, dv)
    RED = hexa('7e3127')
    NAVY = hexa('263045')
    IVORY = hexa('cdbd9a')
    CAMEL = hexa('9c7444')
    DARK = hexa('24180f')
    GREEN = hexa('4a5a44')
    img = np.zeros((ky, kx, 3), dtype=np.float32)
    img[:] = RED
    # field lattice: small octagon guls on red, alternating navy/camel
    cu, cv_ = (u - 0.5) * (w / h), v - 0.5
    gu = (cu / 0.11) % 1.0 - 0.5
    gv = (cv_ / 0.11) % 1.0 - 0.5
    idx = (np.floor(cu / 0.11) + np.floor(cv_ / 0.11)) % 2
    oct_ = np.maximum(np.abs(gu) + np.abs(gv) * 0.7, np.maximum(np.abs(gu), np.abs(gv)) * 1.25)
    gm = oct_ < 0.36
    img[gm & (idx == 0)] = NAVY
    img[gm & (idx == 1)] = CAMEL
    inner = oct_ < 0.18
    img[inner] = IVORY
    img[(oct_ < 0.09)] = DARK
    ring = (oct_ > 0.36) & (oct_ < 0.40)
    img[ring] = DARK
    # central medallion: stepped lozenge (diamond) with a navy body and ivory heart
    mu, mv = np.abs(cu) / 0.42, np.abs(cv_) / 0.30
    dia = mu + mv
    step = np.floor(np.maximum(mu, mv) * 8) / 8
    lozenge = (dia + 0.12 * step) < 1.0
    img[lozenge] = NAVY
    img[((dia + 0.12 * step) > 0.94) & lozenge] = IVORY
    img[((dia + 0.12 * step) > 0.97) & lozenge] = DARK
    heart = (mu * 1.6 + mv * 1.6) < 0.62
    img[heart] = IVORY
    img[(mu * 1.6 + mv * 1.6 < 0.4)] = RED
    img[(mu * 1.6 + mv * 1.6 < 0.2)] = CAMEL
    img[(np.abs(mu * 1.6 + mv * 1.6 - 0.62) < 0.03)] = DARK
    # pendants at the ends of the medallion
    for s in (-1, 1):
        pu = np.abs(cu - s * 0.45) / 0.07
        pm = (pu + np.abs(cv_) / 0.05) < 1.0
        img[pm] = IVORY
        img[(pu + np.abs(cv_) / 0.05) < 0.5] = NAVY
    # corner spandrels (quarter medallions)
    for su in (0, 1):
        for sv in (0, 1):
            qu = np.abs(u - su) * (w / h)
            qv = np.abs(v - sv)
            qd = (qu - 0.158) / 0.30 + (qv - 0.158) / 0.20
            sp = (qd < 1.0) & (qu > 0.158) & (qv > 0.158)
            img[sp] = NAVY
            img[sp & (qd > 0.90)] = IVORY
            img[sp & (qd > 0.95)] = DARK
            img[sp & (qd < 0.72) & (qd > 0.66)] = CAMEL
    # borders: outer guard, main border (ivory ground + rosette chain), inner guards
    bands = [(0.0, 0.018, DARK), (0.018, 0.03, CAMEL), (0.03, 0.04, DARK), (0.04, 0.125, IVORY),
             (0.125, 0.134, DARK), (0.134, 0.15, RED), (0.15, 0.158, DARK)]
    for a0, a1, col in bands:
        img[(d >= a0) & (d < a1)] = col
    # main border motif: rosettes along the band, with a vine
    inb = (d >= 0.04) & (d < 0.125)
    along = np.where(du < dv, v * 1.0, u * (w / h))  # coordinate along the nearest edge
    pos = (along / 0.12) % 1.0 - 0.5
    across = (d - 0.0825) / 0.04
    ros = np.sqrt(pos ** 2 * 1.4 + across ** 2 * 0.6)
    img[inb & (ros < 0.42)] = RED
    img[inb & (ros < 0.24)] = NAVY
    img[inb & (ros < 0.1)] = IVORY
    vine = inb & (np.abs(across - 0.55 * np.sin(pos * 2 * np.pi)) < 0.12) & (ros > 0.45)
    img[vine] = GREEN
    # upsample to pixels (nearest) + soft
    big = np.repeat(np.repeat(img, 4, axis=0), 4, axis=1)[:h, :w]
    big = blur(big, 0.7)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    U, V = (xx + 0.5) / w, (yy + 0.5) / h
    # pile variation (abrash): horizontal color bands of slightly different dye lots
    ab = vnoise(w, h, 140, seed, 3)
    ab_rows = vnoise(1, h, 30, seed + 1, 2)[:, :1]
    big = big * (0.88 + 0.2 * ab[..., None] * 0.6 + 0.12 * ab_rows[..., None])
    # knot texture
    kn = vnoise(w, h, 2, seed + 2, 1)
    big = big * (0.9 + 0.18 * kn[..., None])
    # sun fading toward one long side, overall dulling
    fade = 0.25 + 0.35 * smooth(V, 0.3, 1.0)
    g = to_gray(big)[..., None]
    big = lerp(big, g * hexa('d8c8a8') * 1.15, fade)
    # wear: pile worn down to the warp/weft (pale grid) along the traffic path + edges
    wn = vnoise(w, h, 22, seed + 3, 5)
    path = np.exp(-((V - 0.55 - 0.1 * np.sin(U * 4)) / 0.2) ** 2) * smooth(np.abs(U - 0.5), 0.45, 0.1)
    edge = smooth(np.minimum(np.minimum(U, 1 - U) * 1.4, np.minimum(V, 1 - V)), 0.025, 0.0)
    wv = wn * 0.75 + path * 0.35 + edge * 0.5
    worn_soft = smooth(wv, 0.55, 0.72)    # pile thinned: pattern still there, duller
    worn = smooth(wv, 0.7, 0.76)          # bald: down to the warp threads
    warp = (np.sin(xx * np.pi / 2.0) * 0.5 + 0.5) * 0.6 + (np.sin(yy * np.pi / 1.5) * 0.5 + 0.5) * 0.4
    warp_col = lerp(hexa('6e6050'), hexa('b3a386'), warp)
    big = lerp(big, to_gray(big)[..., None] * 0.6 + hexa('6a5a48') * 0.4, worn_soft * 0.35)
    big = lerp(big, warp_col * (0.75 + 0.5 * big), worn * 0.8)
    return np.clip(big, 0, 1), np.clip(worn, 0, 1)


def fringe(w=512, h=64, seed=22):
    """Fringe strip: RGB + alpha (cotton tassels, matted, some missing)."""
    rng = np.random.default_rng(seed)
    cv = Canvas(w, h, hexa('b8a888'), seed)
    alpha = np.zeros((h, w), dtype=np.float32)
    n = w // 5
    for k in range(n):
        if rng.random() < 0.12:
            continue
        x0 = (k + 0.5) * w / n + rng.normal(0, 0.6)
        L = h * rng.uniform(0.55, 1.0)
        x1 = x0 + rng.normal(0, 2.5)
        pts = wobbly([(x0, 0), (x1, L)], 0.5, rng, 6)
        sub = Canvas(w, h, (0, 0, 0), seed)
        sub.stroke(pts, rng.uniform(2.0, 3.0), (1, 1, 1), 1.0, 0.8)
        alpha = np.maximum(alpha, sub.a[..., 0])
    shade = vnoise(w, h, 6, seed, 2)
    col = lerp(hexa('6e624c'), hexa('c4b494'), shade)
    col = col * (1 - 0.4 * (np.mgrid[0:h, 0:w][0] / h))[..., None]
    return np.clip(col, 0, 1), alpha


# =============================================================================================
# Paper: newspaper, missing poster, child's drawing, letters
# =============================================================================================

PAPER = hexa('d9cdb0')
INK = hexa('1e1a16')


def _age_paper(a, seed, strength=1.0, edge=0.5):
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    U, V = (xx + 0.5) / w, (yy + 0.5) / h
    de = np.minimum(np.minimum(U, 1 - U), np.minimum(V, 1 - V))
    a = lerp(a, hexa('a88a58'), smooth(de, 0.08, 0.0) * 0.55 * edge * strength)
    yel = vnoise(w, h, 80, seed, 3)
    a = lerp(a, hexa('b89c66'), smooth(yel, 0.45, 0.8) * 0.4 * strength)
    fox = vnoise(w, h, 3, seed + 1, 2)
    a = lerp(a, hexa('8a5c30'), smooth(fox, 0.8, 0.86) * 0.6 * strength)
    tide = vnoise(w, h, 70, seed + 2, 3)
    ring = smooth(tide, 0.64, 0.65) * (1 - smooth(tide, 0.65, 0.68))
    a = lerp(a, hexa('7a5a34'), ring * 0.5 * strength)
    a = lerp(a, hexa('b49464'), smooth(tide, 0.65, 0.75) * 0.3 * strength)
    return a


def text_lines(cv, x0, y0, x1, y1, line_h, ink=INK, alpha=0.75, word=(6, 22), gap=4, para=0.08, height=0.55):
    rng = cv.rng
    y = y0
    while y + line_h <= y1:
        x = x0 + (rng.uniform(8, 16) if rng.random() < para else 0)
        end = x1 - (rng.uniform(0, (x1 - x0) * 0.5) if rng.random() < para else 0)
        while x < end:
            L = rng.uniform(*word)
            L = min(L, end - x)
            if L > 2:
                cv.fill(_rect(cv, x, y - line_h * height, x + L, y), ink, alpha * rng.uniform(0.6, 1.0))
            x += L + gap
        y += line_h


def _rect(cv, x0, y0, x1, y1, soft=0.6):
    return (np.clip((cv.xx - x0) / soft + 0.5, 0, 1) * np.clip((x1 - cv.xx) / soft + 0.5, 0, 1) *
            np.clip((cv.yy - y0) / soft + 0.5, 0, 1) * np.clip((y1 - cv.yy) / soft + 0.5, 0, 1))


def newspaper(w=384, h=512, seed=31):
    cv = Canvas(w, h, PAPER, seed)
    m = 14
    cv.text('THE EVENING CHRONICLE', w / 2, 44, 26, 4.0, INK, 0.95, 0.0, 1.25, align='center', fit=w - 2 * m)
    cv.fill(_rect(cv, m, 54, w - m, 56.5), INK, 0.9)
    cv.text('OCTOBER 30 1971     FINAL EDITION     10 CENTS', w / 2, 66, 6, 1.0, INK, 0.8, 0.0, 1.3, align='center', fit=w - 2 * m)
    cv.fill(_rect(cv, m, 71, w - m, 72.5), INK, 0.9)
    cv.text('FAMILY STILL MISSING', w / 2, 112, 30, 5.5, INK, 0.95, 0.0, 1.18, align='center', fit=w - 2 * m)
    cv.text('NO TRACE FOUND IN HOLLOW ROAD HOUSE', w / 2, 134, 11, 1.8, INK, 0.9, 0.0, 1.25, align='center', fit=w - 2 * m)
    # photo box (halftone of a house)
    px0, py0, px1, py1 = m, 146, w * 0.55, 300
    ph = Canvas(int(px1 - px0), int(py1 - py0), (0.55, 0.55, 0.55), seed)
    pw, phh = ph.w, ph.h
    ph.fill(_rect(ph, 0, phh * 0.62, pw, phh), (0.25, 0.25, 0.25))
    ph.fill(ph.poly([(pw * 0.2, phh * 0.65), (pw * 0.2, phh * 0.35), (pw * 0.5, phh * 0.12), (pw * 0.8, phh * 0.35),
                     (pw * 0.8, phh * 0.65)]), (0.12, 0.12, 0.12))
    for wx in (0.3, 0.62):
        ph.fill(_rect(ph, pw * wx, phh * 0.42, pw * (wx + 0.08), phh * 0.54), (0.7, 0.7, 0.7))
    ph.fill(_rect(ph, pw * 0.46, phh * 0.48, pw * 0.54, phh * 0.65), (0.05, 0.05, 0.05))
    hg = to_gray(blur(ph.a, 1.5))
    dots = (np.sin(ph.xx * 1.6) * np.sin(ph.yy * 1.6) * 0.5 + 0.5)
    half = (hg > dots * 0.9).astype(np.float32)
    region = cv.a[int(py0):int(py0) + phh, int(px0):int(px0) + pw]
    region[:] = lerp(INK, PAPER, half * 0.85 + 0.1)
    cv.text('THE HOUSE ON HOLLOW ROAD', px0, py1 + 12, 6, 1.0, INK, 0.8, 0.0, 1.25)
    text_lines(cv, w * 0.58, 152, w - m, 312, 8.5)
    # columns below
    cols = 3
    cw = (w - 2 * m) / cols
    for k in range(cols):
        x0 = m + k * cw + 4
        x1 = m + (k + 1) * cw - 4
        y0 = 330
        if k == 1:
            cv.text('NEIGHBORS HEARD', (x0 + x1) / 2, 336, 7, 1.4, INK, 0.9, 0.0, 1.2, align='center')
            cv.text('NOTHING', (x0 + x1) / 2, 348, 7, 1.4, INK, 0.9, 0.0, 1.2, align='center')
            y0 = 362
        text_lines(cv, x0, y0, x1, h - m, 8.0)
        if k:
            cv.fill(_rect(cv, x0 - 5, 320, x0 - 4.2, h - m), INK, 0.6)
    cv.fill(_rect(cv, m, 318, w - m, 319.5), INK, 0.8)
    a = _age_paper(cv.a, seed, 1.0)
    return np.clip(a, 0, 1)


def newspaper_back(w=384, h=512, seed=32):
    cv = Canvas(w, h, PAPER, seed)
    m = 14
    cv.text('CLASSIFIED', w / 2, 34, 16, 2.6, INK, 0.9, 0.0, 1.2, align='center')
    cols = 4
    cw = (w - 2 * m) / cols
    for k in range(cols):
        text_lines(cv, m + k * cw + 3, 50, m + (k + 1) * cw - 3, h - m, 7.0, word=(4, 14), para=0.25)
    # an advert box
    cv.fill(_rect(cv, m + cw * 2 + 3, 200, w - m - 3, 290), PAPER)
    cv.fill(_rect(cv, m + cw * 2 + 3, 200, w - m - 3, 202), INK)
    cv.fill(_rect(cv, m + cw * 2 + 3, 288, w - m - 3, 290), INK)
    cv.text('RCA COLOR TV', m + cw * 3, 236, 12, 2.2, INK, 0.9, 0.0, 1.1, align='center')
    cv.text('NOW ONLY 399', m + cw * 3, 262, 9, 1.6, INK, 0.9, 0.0, 1.1, align='center')
    return np.clip(_age_paper(cv.a, seed, 1.0), 0, 1)


def missing_poster(w=320, h=420, seed=33, photo=None):
    cv = Canvas(w, h, hexa('dcd3bb'), seed)
    cv.text('MISSING', w / 2, 62, 46, 8.0, INK, 0.95, 0.0, 1.2, align='center', fit=w - 30)
    # photo of the girl (crop from the family portrait)
    x0, y0, x1, y1 = w * 0.22, 82, w * 0.78, 262
    th, tw = int(y1 - y0), int(x1 - x0)
    g = girl_photo(tw, th, seed)
    # photocopied: contrasty, slightly blotchy
    g = np.clip((g - 0.1) * 1.25, 0, 1) * (0.88 + 0.12 * vnoise(tw, th, 3, seed, 1))
    cv.a[int(y0):int(y0) + th, int(x0):int(x0) + tw] = lerp(INK, hexa('d0c6ae'), g * 0.9 + 0.05)
    cv.fill(_rect(cv, x0 - 2, y0 - 2, x1 + 2, y0), INK, 0.9)
    cv.fill(_rect(cv, x0 - 2, y1, x1 + 2, y1 + 2), INK, 0.9)
    cv.fill(_rect(cv, x0 - 2, y0, x0, y1), INK, 0.9)
    cv.fill(_rect(cv, x1, y0, x1 + 2, y1), INK, 0.9)
    cv.text('ELLIE MARSH  AGE 7', w / 2, 290, 13, 2.2, INK, 0.92, 0.0, 1.22, align='center', fit=w - 40)
    cv.text('LAST SEEN OCT 21 1971', w / 2, 312, 9, 1.5, INK, 0.9, 0.0, 1.2, align='center')
    text_lines(cv, 26, 334, w - 26, 384, 9.0, word=(8, 26))
    cv.text('PLEASE CALL', w / 2, 404, 11, 1.8, INK, 0.9, 0.0, 1.2, align='center')
    # tape marks + nail hole at the top corners (it was on a wall once)
    for tx in (18, w - 18):
        cv.fill(_rect(cv, tx - 16, 2, tx + 16, 20), hexa('b8a070'), 0.55)
    cv.fill(cv.ellipse(w / 2, 10, 3, 3, 0, 1), hexa('1a1410'), 0.9)
    a = _age_paper(cv.a, seed, 1.2)
    return np.clip(a, 0, 1)


def child_drawing(w=384, h=288, seed=34):
    """Crayon drawing: house, sun, mom, dad, girl... and the tall one with no face. 'SHHH'."""
    cv = Canvas(w, h, hexa('ddd5c0'), seed)
    rng = cv.rng

    def crayon(pts, width, col, alpha=0.85):
        pts = wobbly(pts, 0.9, rng, 3.0)
        for k in range(3):  # waxy, broken strokes
            off = rng.normal(0, width * 0.25, 2)
            cv.stroke([(x + off[0], y + off[1]) for x, y in pts], width * rng.uniform(0.5, 0.8), col,
                      alpha * rng.uniform(0.5, 0.8), 0.9)

    def scribble(x0, y0, x1, y1, col, n=14, width=3):
        pts = []
        for k in range(n):
            t = k / (n - 1)
            pts.append((x0 + (x1 - x0) * rng.random(), y0 + (y1 - y0) * t))
        crayon(pts, width, col, 0.6)

    green, blue, red, yellow, black, brown = (hexa('4f7a3a'), hexa('3a5a9a'), hexa('b03a2a'), hexa('d8b030'),
                                              hexa('151210'), hexa('7a4a2a'))
    # ground + sky
    crayon([(0, h * 0.82), (w * 0.3, h * 0.80), (w * 0.6, h * 0.83), (w, h * 0.81)], 5, green)
    for k in range(6):
        crayon([(k * w / 6, h * 0.84), (k * w / 6 + 30, h * 0.98)], 4, green, 0.4)
    crayon([(0, 10), (w, 14)], 6, blue, 0.5)
    # sun
    sx, sy = w * 0.88, 40
    crayon([(sx + 20 * math.cos(a), sy + 20 * math.sin(a)) for a in np.linspace(0, 2 * np.pi, 16)], 4, yellow)
    for a in np.linspace(0, 2 * np.pi, 9)[:-1]:
        crayon([(sx + 26 * math.cos(a), sy + 26 * math.sin(a)), (sx + 40 * math.cos(a), sy + 40 * math.sin(a))], 3, yellow)
    # house
    hx0, hx1, hy0, hy1 = w * 0.05, w * 0.33, h * 0.42, h * 0.82
    crayon([(hx0, hy1), (hx0, hy0), (hx1, hy0), (hx1, hy1)], 4, brown)
    crayon([(hx0 - 8, hy0), ((hx0 + hx1) / 2, h * 0.2), (hx1 + 8, hy0)], 4, red)
    crayon([(w * 0.17, hy1), (w * 0.17, h * 0.62), (w * 0.22, h * 0.62), (w * 0.22, hy1)], 3, brown)
    crayon([(w * 0.08, h * 0.5), (w * 0.14, h * 0.5), (w * 0.14, h * 0.57), (w * 0.08, h * 0.57), (w * 0.08, h * 0.5)], 3, black)

    def person(x, y_feet, hgt, col, face=True, dress=False):
        hr = hgt * 0.12
        hy = y_feet - hgt + hr
        crayon([(x + hr * math.cos(a), hy + hr * math.sin(a)) for a in np.linspace(0, 2 * np.pi, 12)], 3, black)
        if face:
            crayon([(x - hr * 0.35, hy - hr * 0.1), (x - hr * 0.3, hy - hr * 0.05)], 2.5, black)
            crayon([(x + hr * 0.35, hy - hr * 0.1), (x + hr * 0.3, hy - hr * 0.05)], 2.5, black)
            crayon([(x - hr * 0.4, hy + hr * 0.35), (x, hy + hr * 0.55), (x + hr * 0.4, hy + hr * 0.35)], 2, red)
        body_top = hy + hr
        if dress:
            crayon([(x, body_top), (x - hgt * 0.16, y_feet - hgt * 0.25), (x + hgt * 0.16, y_feet - hgt * 0.25), (x, body_top)], 3, col)
            scribble(x - hgt * 0.1, body_top + 6, x + hgt * 0.1, y_feet - hgt * 0.28, col, 8, 3)
            hip = y_feet - hgt * 0.25
        else:
            crayon([(x, body_top), (x, y_feet - hgt * 0.35)], 3, col)
            hip = y_feet - hgt * 0.35
        crayon([(x, hip), (x - hgt * 0.1, y_feet)], 3, black)
        crayon([(x, hip), (x + hgt * 0.1, y_feet)], 3, black)
        crayon([(x - hgt * 0.2, body_top + hgt * 0.15), (x + hgt * 0.2, body_top + hgt * 0.15)], 3, col)

    gy = h * 0.83
    person(w * 0.42, gy, 100, blue)                # dad
    person(w * 0.53, gy, 88, red, dress=True)       # mom
    person(w * 0.62, gy, 52, yellow, dress=True)   # me
    # the tall one: black, scribbled, arms to the ground, no face
    tx = w * 0.80
    top = h * 0.12
    crayon([(tx + 11 * math.cos(a), top + 14 + 13 * math.sin(a)) for a in np.linspace(0, 2 * np.pi, 12)], 4, black)
    for k in range(6):
        scribble(tx - 6, top + 6, tx + 6, top + 24, black, 6, 3)
    scribble(tx - 8, top + 28, tx + 8, gy - 60, black, 30, 4)
    crayon([(tx - 4, gy - 60), (tx - 12, gy)], 4, black)
    crayon([(tx + 4, gy - 60), (tx + 10, gy)], 4, black)
    crayon([(tx - 8, top + 36), (tx - 26, top + 90), (tx - 30, gy - 4)], 3.5, black)
    crayon([(tx + 8, top + 36), (tx + 28, top + 95), (tx + 32, gy - 2)], 3.5, black)
    for fx in (-30, 32):
        for k in range(4):
            crayon([(tx + fx, gy - 4), (tx + fx + (k - 1.5) * 4, gy + 8)], 2, black)
    # writing
    cv.text('SHHH', w * 0.36, h * 0.25, 30, 5.0, red, 0.85, -0.06, 1.3, jitter=1.4, wobble=1.0)
    cv.text('IT CAN HEAR', w * 0.40, h * 0.37, 15, 3.2, black, 0.8, 0.03, 1.25, jitter=1.0, wobble=0.8)
    a = cv.a
    # crayon paper tooth: wax skips on the grain
    tooth = vnoise(w, h, 1.5, seed + 9, 1)
    a = lerp(a, hexa('ddd5c0'), smooth(tooth, 0.65, 0.85) * 0.5 * (to_gray(a) < 0.7))
    a = _age_paper(a, seed, 0.8)
    # fold lines (folded in four)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    for line in (np.abs(xx - w / 2), np.abs(yy - h / 2)):
        a = lerp(a, hexa('a89470'), np.exp(-line ** 2 / 1.5) * 0.6)
    return np.clip(a, 0, 1)


def handwritten(w=320, h=420, seed=35):
    cv = Canvas(w, h, hexa('d6ccb2'), seed)
    rng = cv.rng
    ink = hexa('2a2a3a')
    # ruled lines
    for y in range(60, h - 20, 18):
        cv.fill(_rect(cv, 0, y, w, y + 0.8), hexa('8a9ab0'), 0.4)
    cv.fill(_rect(cv, 36, 0, 37, h), hexa('b06060'), 0.4)
    # cursive-like scribbles
    for li, y in enumerate(range(58, h - 30, 18)):
        x = 44 if li else 120
        end = w - rng.uniform(14, 60)
        if li > 13:
            end = w * rng.uniform(0.3, 0.6)
        pts = []
        while x < end:
            wl = rng.uniform(14, 40)
            n = int(wl / 3)
            for k in range(n):
                t = k / n
                yy_ = y - 3 - 4 * abs(math.sin((x + t * wl) * 0.45 + rng.normal(0, 0.3))) - (6 if rng.random() < 0.06 else 0)
                pts.append((x + t * wl, yy_))
            cv.stroke(pts, 1.1, ink, 0.8, 0.7)
            pts = []
            x += wl + rng.uniform(4, 8)
        if li in (6, 7):  # angry crossing-out
            cv.stroke(wobbly([(50, y - 5), (end, y - 6)], 1.5, rng, 6), 3.0, ink, 0.8)
    cv.text('IT LISTENS', w * 0.2, h - 34, 14, 2.4, ink, 0.85, -0.03, 1.2, jitter=0.8, wobble=0.6)
    a = _age_paper(cv.a, seed, 1.0)
    # ink bleed
    return np.clip(blur(a, 0.5), 0, 1)


def typed_page(w=320, h=420, seed=36, title='NOTICE'):
    cv = Canvas(w, h, hexa('d8cfb6'), seed)
    cv.text(title, w / 2, 48, 13, 2.0, INK, 0.9, 0.0, 1.3, align='center')
    text_lines(cv, 30, 80, w - 30, h - 60, 11.0, word=(5, 24), gap=5, height=0.5)
    cv.stroke([(w * 0.55, h - 40), (w * 0.62, h - 50), (w * 0.7, h - 38), (w * 0.85, h - 46)], 1.2, hexa('2a2a4a'), 0.8)
    return np.clip(_age_paper(cv.a, seed, 1.1), 0, 1)


def blank_paper(w=128, h=160, seed=37, base='d6cbb0'):
    cv = Canvas(w, h, hexa(base), seed)
    return np.clip(_age_paper(cv.a, seed, 1.1), 0, 1)


def plate_pattern(n=512, seed=41):
    """Blue transferware ring pattern for a plate (top-down planar mapping; center = 0.5, 0.5)."""
    cv = Canvas(n, n, hexa('e2dccb'), seed)
    c = n / 2
    X, Y = (cv.xx - c) / c, (cv.yy - c) / c
    R = np.sqrt(X * X + Y * Y)
    A = np.arctan2(Y, X)
    blue = hexa('3e5677')
    # rim band (between r = 0.74 and 0.98): scalloped floral
    m = np.zeros_like(R)
    k = 12
    for i in range(k):  # rim: 5-petal flowers alternating with leaf pairs on a vine
        a0 = 2 * np.pi * i / k
        fx, fy = math.cos(a0) * 0.86, math.sin(a0) * 0.86
        for p in range(5):
            pa = a0 + 2 * np.pi * p / 5
            px, py = fx + math.cos(pa) * 0.045, fy + math.sin(pa) * 0.045
            m = np.maximum(m, (((X - px) ** 2 + (Y - py) ** 2) < 0.032 ** 2).astype(np.float32))
        m[((X - fx) ** 2 + (Y - fy) ** 2) < 0.016 ** 2] = 0.3
        for sgn in (-1, 1):
            la = a0 + np.pi / k
            lx, ly = math.cos(la) * (0.86 + sgn * 0.045), math.sin(la) * (0.86 + sgn * 0.045)
            dx, dy = X - lx, Y - ly
            ca, sa = math.cos(la + sgn * 0.6), math.sin(la + sgn * 0.6)
            u_, v_ = dx * ca + dy * sa, -dx * sa + dy * ca
            m = np.maximum(m, ((u_ / 0.018) ** 2 + (v_ / 0.042) ** 2 < 1).astype(np.float32))
    vine = (np.abs(R - (0.86 + 0.03 * np.sin(A * k * 2))) < 0.006) & (R > 0.76)
    m[vine] = 1.0
    for rr in (0.745, 0.975):
        m = np.maximum(m, np.clip(1 - np.abs(R - rr) * c / 1.6, 0, 1))
    # central spray: a big rose (concentric petals) with leaves and buds
    rose = np.clip(1 - np.abs(((R * 9.0 + 0.6 * np.sin(A * 5)) % 1.0) - 0.5) * 5, 0, 1) * (R < 0.13)
    m = np.maximum(m, rose)
    for i in range(7):
        la = 2 * np.pi * i / 7 + 0.3
        lx, ly = math.cos(la) * 0.22, math.sin(la) * 0.22
        dx, dy = X - lx, Y - ly
        ca, sa = math.cos(la), math.sin(la)
        u_, v_ = dx * ca + dy * sa, -dx * sa + dy * ca
        m = np.maximum(m, ((u_ / 0.085) ** 2 + (v_ / 0.035) ** 2 < 1).astype(np.float32) * 0.85)
        m[(np.abs(v_) < 0.004) & (np.abs(u_) < 0.08)] = 0.2
    m = np.maximum(m, np.clip(1 - np.abs(R - 0.45) * c / 1.2, 0, 1) * 0.8)
    m = blur(m[..., None].repeat(3, -1), 0.8)[..., 0]
    mott = vnoise(n, n, 6, seed, 2)
    a = lerp(cv.a, blue, m * (0.7 + 0.3 * mott))
    # crazing + tea stains in the well
    st = vnoise(n, n, 60, seed + 1, 3)
    a = lerp(a, hexa('a08a60'), smooth(st, 0.6, 0.8) * 0.4 * (R < 0.7))
    return np.clip(a, 0, 1)


def crack_map_rays(w, h, cx, cy, angles, seed=5):
    """Cracks radiating from (cx, cy) (normalized, y down) along the given angles (image space,
    radians, y down), plus a few extra hairline rays and broken concentric rings."""
    cv = Canvas(w, h, (0, 0, 0), seed)
    rng = np.random.default_rng(seed)
    px, py = cx * w, cy * h
    R = 1.6 * max(w, h)
    allr = [(a, 1.6, 1.0) for a in angles] + [(rng.uniform(0, 2 * math.pi), rng.uniform(0.15, 0.6), 0.6)
                                               for _ in range(8)]
    for a, Lr, alpha in allr:
        pts = [(px, py)]
        x, y = px, py
        steps = 14
        aa = a
        for s in range(steps):
            aa += rng.normal(0, 0.03)
            x += math.cos(aa) * Lr * R / steps
            y += math.sin(aa) * Lr * R / steps
            pts.append((x, y))
        cv.stroke(pts, 1.5, (1, 1, 1), 0.95 * alpha, 0.7, taper=True)
        for _ in range(2):
            i0 = rng.integers(1, steps - 1)
            bx, by = pts[i0]
            ba = aa + rng.choice([-1, 1]) * rng.uniform(0.4, 1.0)
            bl = rng.uniform(0.04, 0.12) * max(w, h)
            cv.stroke([(bx, by), (bx + math.cos(ba) * bl, by + math.sin(ba) * bl)], 1.0, (1, 1, 1), 0.7, 0.7, taper=True)
    for ring in (0.05, 0.11, 0.19):
        rr = ring * max(w, h)
        n = 30
        pts = [(px + math.cos(2 * math.pi * k / n) * rr * rng.uniform(0.85, 1.15),
                py + math.sin(2 * math.pi * k / n) * rr * rng.uniform(0.85, 1.15)) for k in range(n + 1)]
        for k in range(n):
            if rng.random() < 0.55:
                cv.stroke([pts[k], pts[k + 1]], 1.1, (1, 1, 1), 0.8, 0.7)
    cv.fill(cv.ellipse(px, py, 7, 7, 0, 2.5), (1, 1, 1), 0.9)
    return np.clip(cv.a[..., 0], 0, 1)
