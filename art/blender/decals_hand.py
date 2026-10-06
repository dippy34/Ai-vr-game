"""
Handwriting for MUTE's notes and wall scrawls (numpy only): a single-stroke "print" hand with
lower + upper case, laid out and drawn like a real pen would (wobble, slant, pressure, ink pooling,
baseline drift, per-letter variation). Not a font file: every letter is a few polylines/arcs, and
every copy of a letter comes out different.

    hand = Hand(slant=0.18, messy=0.4, seed=3)
    pen = Pen('ballpoint', width=3.2)
    cov = np.zeros((h, w), np.float32)
    write(cov, "It HEARS you.", x=60, y=120, size=36, hand=hand, pen=pen, max_width=900)

`cov` is ink coverage (0..1); composite it onto paper/wall yourself (see decals_notes / decals_img).
Glyph units: baseline y = 0, x-height = 1, caps = 1.55, ascenders = 1.7, descenders = -0.65.

Helper module only: build() is a no-op.
"""

from __future__ import annotations

import math

import numpy as np


def build() -> None:
    print('decals_hand: helper module (built through decals.py)')


# =============================================================================================
# Glyphs
# =============================================================================================

def arc(cx, cy, rx, ry, a0, a1, n=None):
    """Points on an elliptical arc, angles in degrees (CCW positive, y up)."""
    if n is None:
        n = max(4, int(abs(a1 - a0) / 15) + 1)
    return [(cx + rx * math.cos(math.radians(a0 + (a1 - a0) * k / (n - 1))),
             cy + ry * math.sin(math.radians(a0 + (a1 - a0) * k / (n - 1)))) for k in range(n)]


def dot(x, y):
    return [(x, y), (x + 0.03, y + 0.04)]


CAP = 1.55

# name -> (advance, [strokes])
G: dict[str, tuple[float, list]] = {}


def _g(ch, adv, *strokes):
    G[ch] = (adv, [list(s) for s in strokes])


# ---- lower case ------------------------------------------------------------------------------
_g('a', 1.0, arc(0.42, 0.5, 0.42, 0.5, 55, 370), [(0.85, 1.0), (0.84, 0.12), (0.93, 0.0)])
_g('b', 0.95, [(0.06, 1.7), (0.05, 0.0)], arc(0.47, 0.5, 0.4, 0.5, 165, -165))
_g('c', 0.82, arc(0.43, 0.5, 0.4, 0.5, 45, 318))
_g('d', 1.0, arc(0.42, 0.5, 0.42, 0.5, 25, 345), [(0.86, 1.7), (0.84, 0.1), (0.94, 0.0)])
_g('e', 0.88, [(0.06, 0.5), (0.8, 0.53)] + arc(0.43, 0.5, 0.38, 0.5, 8, 322)[1:])
_g('f', 0.62, [(0.78, 1.52), (0.62, 1.68), (0.44, 1.66), (0.33, 1.5), (0.31, 0.0)], [(0.04, 0.95), (0.64, 1.0)])
_g('g', 1.0, arc(0.42, 0.52, 0.42, 0.48, 50, 370), [(0.85, 1.0), (0.84, -0.38)] + arc(0.48, -0.38, 0.36, 0.27, 0, -165)[1:])
_g('h', 0.92, [(0.06, 1.7), (0.05, 0.0)], [(0.06, 0.55)] + arc(0.43, 0.58, 0.37, 0.42, 165, 0) + [(0.8, 0.0)])
_g('i', 0.38, [(0.13, 1.0), (0.12, 0.0)], dot(0.13, 1.36))
_g('j', 0.55, [(0.42, 1.0), (0.41, -0.35)] + arc(0.19, -0.36, 0.22, 0.28, 0, -155)[1:], dot(0.43, 1.36))
_g('k', 0.82, [(0.06, 1.7), (0.05, 0.0)], [(0.72, 1.02), (0.09, 0.45), (0.78, 0.0)])
_g('l', 0.4, [(0.13, 1.7), (0.12, 0.13), (0.24, 0.0)])
_g('m', 1.28, [(0.06, 1.0), (0.05, 0.0)], [(0.06, 0.6)] + arc(0.33, 0.62, 0.27, 0.37, 165, 0) + [(0.6, 0.0)],
   [(0.6, 0.6)] + arc(0.87, 0.62, 0.27, 0.37, 165, 0) + [(1.14, 0.0)])
_g('n', 0.92, [(0.06, 1.0), (0.05, 0.0)], [(0.06, 0.6)] + arc(0.43, 0.6, 0.37, 0.4, 165, 0) + [(0.8, 0.0)])
_g('o', 0.92, arc(0.44, 0.5, 0.42, 0.5, 105, 480))
_g('p', 0.96, [(0.06, 1.0), (0.05, -0.65)], arc(0.47, 0.5, 0.4, 0.5, 165, -165))
_g('q', 1.0, arc(0.42, 0.5, 0.42, 0.5, 25, 345), [(0.86, 1.0), (0.85, -0.65), (0.99, -0.5)])
_g('r', 0.66, [(0.06, 1.0), (0.05, 0.0)], [(0.06, 0.55)] + arc(0.41, 0.56, 0.35, 0.42, 165, 55))
_g('s', 0.76, arc(0.38, 0.755, 0.3, 0.245, 25, 270) + arc(0.38, 0.265, 0.32, 0.255, 90, -160)[1:])
_g('t', 0.66, [(0.31, 1.45), (0.3, 0.13), (0.42, 0.0), (0.58, 0.05)], [(0.03, 0.98), (0.63, 1.0)])
_g('u', 0.92, [(0.06, 1.0), (0.05, 0.42)] + arc(0.42, 0.42, 0.37, 0.42, 180, 360)[1:], [(0.8, 1.0), (0.81, 0.0)])
_g('v', 0.82, [(0.02, 1.0), (0.39, 0.0), (0.78, 1.0)])
_g('w', 1.18, [(0.02, 1.0), (0.29, 0.0), (0.57, 0.76), (0.85, 0.0), (1.12, 1.0)])
_g('x', 0.82, [(0.05, 1.0), (0.76, 0.0)], [(0.76, 1.0), (0.05, 0.0)])
_g('y', 0.86, [(0.03, 1.0), (0.41, 0.08)], [(0.81, 1.0), (0.36, -0.45), (0.21, -0.62), (0.05, -0.6)])
_g('z', 0.86, [(0.05, 1.0), (0.76, 1.0), (0.05, 0.0), (0.81, 0.0)])

# ---- upper case ------------------------------------------------------------------------------
_g('A', 1.12, [(0.0, 0.0), (0.53, CAP), (1.04, 0.0)], [(0.22, 0.6), (0.84, 0.6)])
_g('B', 1.02, [(0.06, 0.0), (0.05, CAP)], [(0.05, CAP), (0.45, CAP)] + arc(0.45, 1.18, 0.37, 0.37, 90, -90) + [(0.06, 0.81)],
   [(0.06, 0.81), (0.5, 0.81)] + arc(0.5, 0.405, 0.42, 0.405, 90, -90) + [(0.06, 0.0)])
_g('C', 1.08, arc(0.7, 0.775, 0.66, 0.78, 48, 312))
_g('D', 1.08, [(0.06, 0.0), (0.05, CAP)], [(0.05, CAP), (0.35, CAP)] + arc(0.35, 0.775, 0.62, 0.775, 90, -90) + [(0.06, 0.0)])
_g('E', 0.96, [(0.86, CAP), (0.06, CAP), (0.05, 0.0), (0.88, 0.0)], [(0.06, 0.8), (0.66, 0.8)])
_g('F', 0.92, [(0.86, CAP), (0.06, CAP), (0.05, 0.0)], [(0.06, 0.8), (0.66, 0.8)])
_g('G', 1.25, arc(0.64, 0.775, 0.6, 0.78, 48, 330) + [(1.17, 0.72), (0.76, 0.72)])
_g('H', 1.12, [(0.06, 0.0), (0.05, CAP)], [(0.97, 0.0), (0.96, CAP)], [(0.06, 0.8), (0.96, 0.8)])
_g('I', 0.66, [(0.02, CAP), (0.52, CAP)], [(0.27, CAP), (0.26, 0.0)], [(0.0, 0.0), (0.54, 0.0)])
_g('J', 1.0, [(0.86, CAP), (0.85, 0.42)] + arc(0.46, 0.42, 0.39, 0.42, 0, -180)[1:])
_g('K', 0.96, [(0.06, 0.0), (0.05, CAP)], [(0.86, CAP), (0.09, 0.66), (0.92, 0.0)])
_g('L', 0.86, [(0.06, CAP), (0.05, 0.0), (0.82, 0.0)])
_g('M', 1.32, [(0.05, 0.0), (0.1, CAP), (0.62, 0.5), (1.12, CAP), (1.17, 0.0)])
_g('N', 1.08, [(0.05, 0.0), (0.06, CAP), (0.92, 0.0), (0.93, CAP)])
_g('O', 1.36, arc(0.66, 0.775, 0.62, 0.78, 105, 478))
_g('P', 0.96, [(0.06, 0.0), (0.05, CAP), (0.46, CAP)] + arc(0.46, 1.13, 0.4, 0.42, 90, -90) + [(0.06, 0.71)])
_g('Q', 1.36, arc(0.66, 0.775, 0.62, 0.78, 105, 478), [(0.78, 0.36), (1.25, -0.12)])
_g('R', 1.02, [(0.06, 0.0), (0.05, CAP), (0.46, CAP)] + arc(0.46, 1.13, 0.4, 0.42, 90, -90) + [(0.06, 0.71)],
   [(0.4, 0.71), (0.94, 0.0)])
_g('S', 1.04, arc(0.52, 1.17, 0.42, 0.38, 22, 270) + arc(0.52, 0.4, 0.46, 0.4, 90, -162)[1:])
_g('T', 1.0, [(0.0, CAP), (0.98, CAP)], [(0.49, CAP), (0.48, 0.0)])
_g('U', 1.12, [(0.06, CAP), (0.05, 0.5)] + arc(0.52, 0.5, 0.46, 0.5, 180, 360)[1:] + [(0.98, CAP)])
_g('V', 1.1, [(0.0, CAP), (0.52, 0.0), (1.04, CAP)])
_g('W', 1.42, [(0.0, CAP), (0.33, 0.0), (0.67, 1.1), (1.0, 0.0), (1.34, CAP)])
_g('X', 1.02, [(0.05, CAP), (0.93, 0.0)], [(0.93, CAP), (0.05, 0.0)])
_g('Y', 1.02, [(0.0, CAP), (0.49, 0.76), (0.98, CAP)], [(0.49, 0.76), (0.48, 0.0)])
_g('Z', 1.06, [(0.05, CAP), (0.92, CAP), (0.05, 0.0), (0.97, 0.0)])

# ---- digits + punctuation --------------------------------------------------------------------
_g('0', 0.92, arc(0.45, 0.775, 0.4, 0.78, 100, 470))
_g('1', 0.6, [(0.08, 1.25), (0.32, CAP), (0.31, 0.0)])
_g('2', 0.9, arc(0.42, 1.12, 0.38, 0.4, 160, -20) + [(0.05, 0.0), (0.85, 0.0)])
_g('3', 0.88, arc(0.4, 1.16, 0.36, 0.36, 150, -90) + arc(0.4, 0.4, 0.42, 0.4, 90, -150)[1:])
_g('4', 0.92, [(0.66, 0.0), (0.66, CAP), (0.02, 0.48), (0.88, 0.48)])
_g('5', 0.9, [(0.82, CAP), (0.14, CAP), (0.1, 0.88)] + arc(0.44, 0.48, 0.4, 0.46, 125, -150)[1:])
_g('6', 0.9, [(0.74, CAP), (0.3, 1.1)] + arc(0.44, 0.45, 0.38, 0.45, 160, 520)[1:])
_g('7', 0.86, [(0.02, CAP), (0.84, CAP), (0.3, 0.0)])
_g('8', 0.9, arc(0.45, 1.17, 0.34, 0.36, -90, 270) + arc(0.45, 0.4, 0.4, 0.42, 90, 450)[1:])
_g('9', 0.9, arc(0.44, 1.1, 0.38, 0.44, 0, 360) + [(0.82, 1.0), (0.62, 0.0)])
_g('.', 0.36, dot(0.12, 0.0))
_g(',', 0.36, [(0.16, 0.08), (0.14, -0.04), (0.04, -0.26)])
_g("'", 0.32, [(0.17, 1.62), (0.11, 1.24)])
_g('!', 0.42, [(0.17, CAP), (0.13, 0.45)], dot(0.12, 0.0))
_g('?', 0.86, arc(0.41, 1.15, 0.35, 0.38, 155, -55) + [(0.44, 0.72), (0.42, 0.42)], dot(0.42, 0.0))
_g('-', 0.62, [(0.06, 0.55), (0.52, 0.57)])
_g(':', 0.36, dot(0.12, 0.0), dot(0.13, 0.85))
_g(' ', 0.5)


def glyph(ch: str):
    if ch in G:
        return G[ch]
    if ch.upper() in G:
        return G[ch.upper()]
    return G[' ']


# =============================================================================================
# Hand (writer style) + pen
# =============================================================================================

class Hand:
    """A person's handwriting: slant, messiness, letter size jitter, baseline drift, spacing."""

    def __init__(self, *, slant=0.15, messy=0.3, size_jitter=0.06, rot_jitter=2.5, baseline=0.08, spacing=1.06,
                 word_space=0.62, tremor=0.0, line_slope=0.0, caps=False, seed=1):
        self.slant = slant
        self.messy = messy
        self.size_jitter = size_jitter
        self.rot_jitter = math.radians(rot_jitter)
        self.baseline = baseline
        self.spacing = spacing
        self.word_space = word_space
        self.tremor = tremor
        self.line_slope = line_slope
        self.caps = caps
        self.rng = np.random.default_rng(seed)


class Pen:
    """
    kind: 'ballpoint' (even line, blobs at stroke starts, skips), 'pencil' (grainy, light),
    'fountain' (nib angle: thick/thin), 'marker', 'charcoal' (gritty, broken, smudged),
    'crayon' (waxy, broken, layered), 'finger' (fat, uneven, wet blob ends: blood), 'chalk'.
    """

    def __init__(self, kind='ballpoint', width=3.0, density=1.0, nib=35.0):
        self.kind = kind
        self.width = width
        self.density = density
        self.nib = math.radians(nib)


# =============================================================================================
# Rasterizing strokes into a coverage map
# =============================================================================================

def _resample(pts, step):
    out = [pts[0]]
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        L = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(math.ceil(L / step)))
        for k in range(1, n + 1):
            t = k / n
            out.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    return np.asarray(out, dtype=np.float32)


def stroke_cov(cov, pts, widths, dens, soft=0.8, mode='max'):
    """Variable-width polyline (pixel coords, y down) into `cov` (max-composited)."""
    h, w = cov.shape
    n = len(pts)
    if n < 2:
        return
    for i in range(n - 1):
        x0, y0 = float(pts[i][0]), float(pts[i][1])
        x1, y1 = float(pts[i + 1][0]), float(pts[i + 1][1])
        w0, w1 = float(widths[i]) / 2, float(widths[i + 1]) / 2
        d0, d1 = float(dens[i]), float(dens[i + 1])
        pad = max(w0, w1) + 2 * soft + 1
        ix0 = int(max(0, math.floor(min(x0, x1) - pad)))
        ix1 = int(min(w, math.ceil(max(x0, x1) + pad)))
        iy0 = int(max(0, math.floor(min(y0, y1) - pad)))
        iy1 = int(min(h, math.ceil(max(y0, y1) + pad)))
        if ix1 <= ix0 or iy1 <= iy0:
            continue
        yy, xx = np.mgrid[iy0:iy1, ix0:ix1].astype(np.float32)
        xx += 0.5
        yy += 0.5
        dx, dy = x1 - x0, y1 - y0
        L2 = dx * dx + dy * dy + 1e-9
        t = np.clip(((xx - x0) * dx + (yy - y0) * dy) / L2, 0, 1)
        px = x0 + t * dx - xx
        py = y0 + t * dy - yy
        dist = np.sqrt(px * px + py * py)
        hw = w0 + (w1 - w0) * t
        c = np.clip(0.5 - (dist - hw) / soft, 0, 1) * (d0 + (d1 - d0) * t)
        sub = cov[iy0:iy1, ix0:ix1]
        if mode == 'add':
            sub += c
        else:
            np.maximum(sub, c, out=sub)


def _smooth_noise(n, rng, octaves=3, scale=1.0):
    """1D smooth noise of length n (sum of random-phase sines), roughly in [-1, 1]."""
    t = np.linspace(0, 1, n, dtype=np.float32)
    out = np.zeros(n, dtype=np.float32)
    amp = 1.0
    freq = rng.uniform(0.6, 1.4) * scale
    for _ in range(octaves):
        out += amp * np.sin(2 * math.pi * (freq * t + rng.random()))
        amp *= 0.5
        freq *= 2.1
    return out / 1.75


def draw_stroke(cov, pts, pen: Pen, rng, wobble=0.0, tremor=0.0, size=30.0, extra=None):
    """One pen stroke (pixel coords) with the pen's character. `extra` = per-stroke dict hints."""
    if len(pts) < 2:
        if len(pts) == 1:
            pts = [pts[0], (pts[0][0] + 0.3, pts[0][1] + 0.3)]
        else:
            return
    step = max(1.2, pen.width * 0.45)
    p = _resample(pts, step)
    n = len(p)
    if n < 2:
        return
    # Wobble: a slow drift perpendicular-ish to the stroke + tremor (fast, small).
    if wobble > 0:
        L = float(np.sum(np.hypot(*np.diff(p, axis=0).T)))
        sc = max(0.5, L / max(size, 1.0))
        p[:, 0] += _smooth_noise(n, rng, 2, sc) * wobble
        p[:, 1] += _smooth_noise(n, rng, 2, sc) * wobble
    if tremor > 0:
        p += rng.normal(0, tremor, p.shape).astype(np.float32)
    t = np.linspace(0, 1, n, dtype=np.float32)
    base = pen.width
    k = pen.kind
    if k == 'fountain':
        d = np.diff(p, axis=0)
        ang = np.arctan2(d[:, 1], d[:, 0])
        ang = np.concatenate([ang, ang[-1:]])
        widths = base * (0.45 + 0.75 * np.abs(np.sin(ang - pen.nib)))
        widths *= 0.85 + 0.25 * np.sin(np.pi * t)
        dens = np.full(n, pen.density, np.float32)
        dens[: max(1, n // 12)] *= 1.08  # pooling at the start
    elif k == 'pencil':
        widths = base * (0.85 + 0.2 * np.sin(np.pi * t) + 0.1 * _smooth_noise(n, rng, 2))
        dens = pen.density * (0.7 + 0.3 * np.clip(np.sin(np.pi * t), 0, 1) ** 0.5)
    elif k == 'ballpoint':
        widths = base * (0.92 + 0.1 * _smooth_noise(n, rng, 2))
        dens = pen.density * np.clip(0.85 + 0.25 * _smooth_noise(n, rng, 3, 2.0), 0.55, 1.0)
        # tiny blob where the ball first touches, a skip now and then
        widths[: max(1, n // 15)] *= 1.18
        if rng.random() < 0.15 and n > 12:
            a = rng.integers(3, n - 6)
            dens[a:a + rng.integers(2, 5)] *= 0.35
    elif k == 'marker':
        widths = base * (0.95 + 0.08 * _smooth_noise(n, rng, 2))
        dens = np.full(n, pen.density, np.float32)
    elif k == 'finger':
        # A fingertip dipped in blood: fat at the start, running dry, uneven pressure.
        dry = 1.0 - 0.55 * t ** 1.4
        widths = base * (0.75 + 0.35 * dry) * (0.9 + 0.2 * _smooth_noise(n, rng, 3))
        dens = pen.density * np.clip(0.55 + 0.6 * dry + 0.15 * _smooth_noise(n, rng, 3, 3.0), 0.2, 1.0)
        widths[:2] *= 1.25
    else:  # charcoal / crayon / chalk: broken, layered, gritty (texture applied later)
        widths = base * (0.8 + 0.3 * np.clip(np.sin(np.pi * t), 0, 1) ** 0.6 + 0.15 * _smooth_noise(n, rng, 3, 2.0))
        dens = pen.density * np.clip(0.75 + 0.35 * _smooth_noise(n, rng, 3, 3.0), 0.3, 1.0)
    widths = np.maximum(widths, 0.6).astype(np.float32)
    dens = np.clip(dens, 0, 1.5).astype(np.float32)
    if k in ('charcoal', 'crayon', 'chalk'):
        passes = 3 if k == 'crayon' else 2
        for j in range(passes):
            off = rng.normal(0, base * 0.18, 2).astype(np.float32)
            stroke_cov(cov, p + off, widths * rng.uniform(0.55, 0.85), dens * rng.uniform(0.6, 0.9), soft=1.0)
    else:
        stroke_cov(cov, p, widths, dens, soft=0.75)


# =============================================================================================
# Layout + writing
# =============================================================================================

def _tokens(text):
    """Split into words; *word* marks emphasis (underlined). '\\n' forces a line break."""
    out = []
    for para in text.split('\n'):
        for w in para.split(' '):
            if not w:
                continue
            emph = w.startswith('*') and w.rstrip('.,!?').endswith('*')
            if emph:
                core = w.strip('*')
                trail = ''
                while core and core[-1] in '.,!?*':
                    trail = core[-1] + trail
                    core = core[:-1]
                w = core + trail.replace('*', '')
            out.append((w, emph))
        out.append(('\n', False))
    return out[:-1]


def word_width(word, size, hand):
    return sum(glyph(c)[0] for c in word) * size * hand.spacing


def layout(text, size, max_width, hand, line_h):
    """Lines of [(word, emph, x_offset)]; returns lines and the widest line width."""
    lines = [[]]
    x = 0.0
    sp = hand.word_space * size
    for w, emph in _tokens(text):
        if w == '\n':
            lines.append([])
            x = 0.0
            continue
        ww = word_width(w, size, hand)
        if lines[-1] and x + ww > max_width:
            lines.append([])
            x = 0.0
        lines[-1].append((w, emph, x))
        x += ww + sp * (0.85 + 0.3 * hand.rng.random())
    return lines


def write(cov, text, x, y, size, hand: Hand, pen: Pen, max_width=1e9, line_h=None, align='left',
          underline_pen=None, wobble=None):
    """
    Write `text` into coverage map `cov`. (x, y) = first baseline start, pixels (y down);
    size = x-height in pixels. Returns (x0, y0, x1, y1) bounds of what was written.
    """
    rng = hand.rng
    line_h = line_h or size * 2.6
    if hand.caps:
        text = text.upper()
    lines = layout(text, size, max_width, hand, line_h)
    wob = (wobble if wobble is not None else 0.035 + 0.06 * hand.messy) * size  # wobble = fraction of size
    bx0, by0, bx1, by1 = 1e9, 1e9, -1e9, -1e9
    for li, line in enumerate(lines):
        if not line:
            continue
        lw = line[-1][2] + word_width(line[-1][0], size, hand)
        lx = x + (max_width - lw) / 2 if align == 'center' else x
        lx += rng.normal(0, size * 0.12 * hand.messy)
        base_y = y + li * line_h
        drift = _smooth_noise(64, rng, 2)
        for (word, emph, wx) in line:
            cx = lx + wx
            w_start = cx
            for ch in word:
                adv, strokes = glyph(ch)
                s = size * (1 + rng.normal(0, hand.size_jitter))
                sx = s * (1 + rng.normal(0, hand.size_jitter * 0.5))
                rot = rng.normal(0, hand.rot_jitter)
                u = min(63, max(0, int((cx - lx) / max(1.0, max_width) * 63)))
                by = base_y + drift[u] * hand.baseline * size + (cx - lx) * hand.line_slope
                by += rng.normal(0, hand.baseline * size * 0.25)
                cr, sr = math.cos(rot), math.sin(rot)
                for st in strokes:
                    pts = []
                    for gx, gy in st:
                        gx2 = gx + hand.slant * gy
                        px, py = gx2 * sx, -gy * s
                        pts.append((cx + px * cr - py * sr, by + px * sr + py * cr))
                    draw_stroke(cov, pts, pen, rng, wobble=wob, tremor=hand.tremor, size=size)
                    for (qx, qy) in pts:
                        bx0, by0, bx1, by1 = min(bx0, qx), min(by0, qy), max(bx1, qx), max(by1, qy)
                cx += adv * size * hand.spacing * (1 + rng.normal(0, 0.03))
            if emph:
                up = underline_pen or pen
                ux0, ux1 = w_start - size * 0.1, cx - size * 0.15
                for k in range(2):
                    uy = base_y + size * (0.28 + 0.22 * k) + rng.normal(0, size * 0.04)
                    pts = [(ux0 + rng.normal(0, size * 0.1), uy), ((ux0 + ux1) / 2, uy + rng.normal(0, size * 0.06)),
                           (ux1 + rng.normal(0, size * 0.15), uy + (ux1 - ux0) * rng.normal(-0.02, 0.02))]
                    draw_stroke(cov, pts, up, rng, wobble=wob * 0.8, size=size)
    return bx0, by0, bx1, by1


def tally(cov, x, y, height, count, pen: Pen, rng, spacing=None, group_gap=None, wobble=1.0):
    """Tally marks: groups of four strokes with a diagonal through them. Returns the end x."""
    spacing = spacing or height * 0.2
    group_gap = group_gap or height * 0.45
    cx = x
    done = 0
    while done < count:
        n = min(5, count - done)
        x0 = cx
        for k in range(min(4, n)):
            lean = rng.normal(0.06, 0.04) * height
            top = y - height * (1 + rng.normal(0, 0.05))
            draw_stroke(cov, [(cx + lean, top), (cx + rng.normal(0, height * 0.02), y + rng.normal(0, height * 0.04))],
                        pen, rng, wobble=wobble, size=height)
            cx += spacing * (1 + rng.normal(0, 0.12))
        if n == 5:
            draw_stroke(cov, [(x0 - spacing * 0.6, y - height * 0.25 + rng.normal(0, height * 0.05)),
                              (cx - spacing * 0.2, y - height * 0.8 + rng.normal(0, height * 0.05))], pen, rng,
                        wobble=wobble, size=height)
        cx += group_gap
        done += n
    return cx
