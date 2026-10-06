"""
Tileable texture toolkit for MUTE's architectural surfaces (numpy only, used by surfaces_*.py).

Everything here is PERIODIC BY CONSTRUCTION, so the texture sets tile without seams:
  * lattice noise (Perlin / value / Worley) uses integer lattice periods with wrapped indices,
  * blurs and spectral noise are done in the Fourier domain (circular convolution),
  * local shapes (stains, cracks, strokes) are drawn into wrapped windows with toroidal offsets,
  * derivatives (normal maps, edges) use np.roll central differences.

Array convention: a texture is an (N, N) or (N, N, C) float32 array, ROW 0 = BOTTOM (v = 0), column
0 = left (u = 0), exactly like Blender's Image.pixels. Colors are sRGB-encoded 0..1.
Normal maps: tangent space, OpenGL / +Y up (green = slope toward +v), as glTF and three.js expect.
Helper module only: build() is a no-op.
"""

from __future__ import annotations

import math
import os

import numpy as np

F32 = np.float32


def build() -> None:
    print('surfaces_lib: helper module (built through surfaces.py)')


# =============================================================================================
# Small utilities
# =============================================================================================

def hexc(h: str) -> np.ndarray:
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], dtype=F32)


def sstep(e0, e1, x):
    d = np.asarray(e1 - e0, dtype=F32)
    d = np.where(np.abs(d) < 1e-9, np.float32(1e-9), d)
    t = np.clip((x - e0) / d, 0, 1)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    if isinstance(t, np.ndarray) and t.ndim == 2 and (np.ndim(a) == 3 or np.ndim(b) == 3):
        t = t[..., None]
    return a + (b - a) * t


def lum(c: np.ndarray) -> np.ndarray:
    return c[..., 0] * 0.2126 + c[..., 1] * 0.7152 + c[..., 2] * 0.0722


def saturate(c: np.ndarray, s) -> np.ndarray:
    """Scale saturation by s (array or scalar) around luminance."""
    l = lum(c)[..., None]
    if isinstance(s, np.ndarray) and s.ndim == 2:
        s = s[..., None]
    return l + (c - l) * s


def norm01(a: np.ndarray) -> np.ndarray:
    lo, hi = float(a.min()), float(a.max())
    return ((a - lo) / max(hi - lo, 1e-9)).astype(F32)


def standardize(a: np.ndarray) -> np.ndarray:
    return ((a - a.mean()) / max(float(a.std()), 1e-9)).astype(F32)


class Tex:
    """Coordinate frame of one square texture: n pixels covering `size_m` meters, periodic."""

    def __init__(self, n: int = 1024, size_m: float = 1.0, seed: int = 1):
        self.n = n
        self.size_m = size_m
        self.texel = size_m / n  # meters per pixel
        self.rng = np.random.default_rng(seed)
        yy, xx = np.mgrid[0:n, 0:n].astype(F32)
        self.u = (xx + 0.5) / n
        self.v = (yy + 0.5) / n
        self._fx = None

    # meters <-> pixels
    def px(self, meters: float) -> float:
        return meters / self.texel

    def zeros(self, c: int | None = None) -> np.ndarray:
        return np.zeros((self.n, self.n) if c is None else (self.n, self.n, c), F32)

    def full(self, color) -> np.ndarray:
        a = np.empty((self.n, self.n, 3), F32)
        a[:] = np.asarray(color, F32)
        return a

    def freqs(self):
        if self._fx is None:
            fy = np.fft.fftfreq(self.n).astype(F32)[:, None]
            fx = np.fft.rfftfreq(self.n).astype(F32)[None, :]
            self._fx = (fx, fy)
        return self._fx

    # ----------------------------------------------------------------------------------- blurs
    def blur(self, a: np.ndarray, sx: float, sy: float | None = None) -> np.ndarray:
        """Periodic gaussian blur, sigma in PIXELS (anisotropic if sy given)."""
        sy = sx if sy is None else sy
        if sx <= 0 and sy <= 0:
            return a
        fx, fy = self.freqs()
        k = np.exp(-2 * math.pi ** 2 * ((sx * fx) ** 2 + (sy * fy) ** 2)).astype(F32)
        if a.ndim == 3:
            return np.stack([self.blur(a[..., i], sx, sy) for i in range(a.shape[2])], axis=-1)
        return np.fft.irfft2(np.fft.rfft2(a) * k, s=a.shape).astype(F32)

    def spectral(self, beta: float = 2.0, fmin: float = 1.0, fmax: float | None = None, aniso=(1.0, 1.0)) -> np.ndarray:
        """Periodic 1/f^beta noise (power spectrum), standardized. f in cycles per tile.
        aniso=(ax, ay) scales the frequency axes: ax > 1 => features elongated along u,
        ay > 1 => elongated along v."""
        fx, fy = self.freqs()
        f = np.sqrt((fx * self.n * aniso[0]) ** 2 + (fy * self.n * aniso[1]) ** 2)
        amp = np.where(f >= fmin, 1.0 / np.maximum(f, 1e-6) ** (beta / 2), 0.0)
        if fmax:
            amp *= np.exp(-(f / fmax) ** 2)
        w = self.rng.standard_normal((self.n, self.n)).astype(F32)
        out = np.fft.irfft2(np.fft.rfft2(w) * amp.astype(F32), s=w.shape)
        return standardize(out)

    # ----------------------------------------------------------------------------------- noise
    def perlin(self, px: int, py: int | None = None, u=None, v=None, seed=None) -> np.ndarray:
        """Periodic gradient noise with integer lattice periods (px along u, py along v), ~[-1, 1]."""
        py = px if py is None else py
        rng = self.rng if seed is None else np.random.default_rng(seed)
        ang = rng.uniform(0, 2 * math.pi, (py, px)).astype(F32)
        gx, gy = np.cos(ang), np.sin(ang)
        u = self.u if u is None else u
        v = self.v if v is None else v
        x = u * px
        y = v * py
        x0f = np.floor(x)
        y0f = np.floor(y)
        fx = (x - x0f).astype(F32)
        fy = (y - y0f).astype(F32)
        x0 = x0f.astype(np.int64) % px
        y0 = y0f.astype(np.int64) % py
        x1 = (x0 + 1) % px
        y1 = (y0 + 1) % py

        def dot(iy, ix, dx, dy):
            return gx[iy, ix] * dx + gy[iy, ix] * dy

        n00 = dot(y0, x0, fx, fy)
        n10 = dot(y0, x1, fx - 1, fy)
        n01 = dot(y1, x0, fx, fy - 1)
        n11 = dot(y1, x1, fx - 1, fy - 1)
        wx = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
        wy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
        a = n00 + (n10 - n00) * wx
        b = n01 + (n11 - n01) * wx
        return ((a + (b - a) * wy) * 1.41).astype(F32)

    def fbm(self, px: int, py: int | None = None, octaves: int = 5, gain: float = 0.5, u=None, v=None,
            ridged: bool = False) -> np.ndarray:
        py = px if py is None else py
        out = np.zeros_like(self.u if u is None else u, dtype=F32)
        amp, tot = 1.0, 0.0
        for o in range(octaves):
            n = self.perlin(px * 2 ** o, py * 2 ** o, u, v)
            if ridged:
                n = 1 - np.abs(n) * 2
            out += n * amp
            tot += amp
            amp *= gain
        return out / tot

    def worley(self, cells: int, cells_v: int | None = None, jitter: float = 1.0, u=None, v=None, seed=None):
        """Periodic Worley noise on a jittered grid. Returns (F1, F2, cell_id) with distances in
        cell units (of the u axis). One feature point per cell."""
        cv = cells if cells_v is None else cells_v
        rng = self.rng if seed is None else np.random.default_rng(seed)
        pts = (rng.random((cv, cells, 2)) * jitter + (1 - jitter) / 2).astype(F32)
        u = self.u if u is None else u
        v = self.v if v is None else v
        x = u * cells
        y = v * cv
        ix = np.floor(x).astype(np.int64)
        iy = np.floor(y).astype(np.int64)
        fx = (x - ix).astype(F32)
        fy = (y - iy).astype(F32)
        f1 = np.full(u.shape, 1e9, F32)
        f2 = np.full(u.shape, 1e9, F32)
        cid = np.zeros(u.shape, np.int64)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                cx = (ix + dx) % cells
                cy = (iy + dy) % cv
                p = pts[cy, cx]
                ddx = dx + p[..., 0] - fx
                ddy = (dy + p[..., 1] - fy) * (cells / cv)
                d = np.sqrt(ddx * ddx + ddy * ddy)
                closer = d < f1
                f2 = np.where(closer, f1, np.minimum(f2, d))
                cid = np.where(closer, cy * cells + cx, cid)
                f1 = np.where(closer, d, f1)
        return f1, f2, cid

    # ---------------------------------------------------------------------------- resampling
    def sample(self, a: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
        """Bilinear periodic lookup of texture `a` at tile coords (u, v)."""
        n = self.n
        x = u * n - 0.5
        y = v * n - 0.5
        x0f = np.floor(x)
        y0f = np.floor(y)
        fx = (x - x0f).astype(F32)
        fy = (y - y0f).astype(F32)
        x0 = x0f.astype(np.int64) % n
        y0 = y0f.astype(np.int64) % n
        x1 = (x0 + 1) % n
        y1 = (y0 + 1) % n
        if a.ndim == 3:
            fx = fx[..., None]
            fy = fy[..., None]
        top = a[y0, x0] * (1 - fx) + a[y0, x1] * fx
        bot = a[y1, x0] * (1 - fx) + a[y1, x1] * fx
        return (top * (1 - fy) + bot * fy).astype(F32)

    def warp(self, a: np.ndarray, du: np.ndarray, dv: np.ndarray) -> np.ndarray:
        return self.sample(a, self.u + du, self.v + dv)

    def tdelta(self, cu: float, cv: float):
        """Toroidal offset (in tile units, -0.5..0.5) from point (cu, cv) to every pixel."""
        du = (self.u - cu + 0.5) % 1.0 - 0.5
        dv = (self.v - cv + 0.5) % 1.0 - 0.5
        return du.astype(F32), dv.astype(F32)

    # ----------------------------------------------------------------------- local windows
    def window(self, cx: float, cy: float, rx: float, ry: float | None = None):
        """Wrapped pixel window around (cx, cy) in PIXELS. Returns (index, X, Y): index for
        fancy-indexing a full texture, X/Y = pixel-center offsets from (cx, cy) (unwrapped)."""
        ry = rx if ry is None else ry
        n = self.n
        rx = min(rx, n / 2 - 1)
        ry = min(ry, n / 2 - 1)
        c0, c1 = int(math.floor(cx - rx)), int(math.ceil(cx + rx))
        r0, r1 = int(math.floor(cy - ry)), int(math.ceil(cy + ry))
        cols = np.arange(c0, c1 + 1)
        rows = np.arange(r0, r1 + 1)
        X = (cols + 0.5 - cx).astype(F32)[None, :].repeat(len(rows), 0)
        Y = (rows + 0.5 - cy).astype(F32)[:, None].repeat(len(cols), 1)
        return np.ix_(rows % n, cols % n), X, Y

    def stroke(self, mask: np.ndarray, pts, widths, soft: float = 0.8, mode: str = 'max', value: float = 1.0) -> None:
        """Draw a polyline (pixel coords, may leave the tile: it wraps) into `mask` (in place).
        widths: scalar or per-vertex full widths in pixels (tapers interpolate)."""
        pts = np.asarray(pts, dtype=np.float64)
        w = np.broadcast_to(np.asarray(widths, dtype=np.float64), (len(pts),))
        for i in range(len(pts) - 1):
            (x0, y0), (x1, y1) = pts[i], pts[i + 1]
            r = max(w[i], w[i + 1]) / 2 + soft + 1
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            hx, hy = abs(x1 - x0) / 2 + r, abs(y1 - y0) / 2 + r
            idx, X, Y = self.window(cx, cy, hx, hy)
            ax, ay = x0 - cx, y0 - cy
            bx, by = x1 - cx, y1 - cy
            ex, ey = bx - ax, by - ay
            ll = ex * ex + ey * ey + 1e-9
            t = np.clip(((X - ax) * ex + (Y - ay) * ey) / ll, 0, 1)
            d = np.sqrt((X - ax - t * ex) ** 2 + (Y - ay - t * ey) ** 2)
            rad = (w[i] + (w[i + 1] - w[i]) * t) / 2
            cov = np.clip((rad - d) / soft + 0.5, 0, 1).astype(F32) * value
            if mode == 'max':
                mask[idx] = np.maximum(mask[idx], cov)
            else:  # 'add'
                mask[idx] = mask[idx] + cov

    def blob(self, mask: np.ndarray, cx: float, cy: float, rx: float, ry: float, rot: float = 0.0,
             soft: float = 1.0, value: float = 1.0, mode: str = 'max', falloff: str = 'hard') -> None:
        """Ellipse (pixel coords) into mask. falloff 'hard' (AA edge) or 'smooth' (radial)."""
        r = max(rx, ry) + soft + 2
        idx, X, Y = self.window(cx, cy, r)
        c, s = math.cos(rot), math.sin(rot)
        xr = c * X + s * Y
        yr = -s * X + c * Y
        d = np.sqrt((xr / rx) ** 2 + (yr / ry) ** 2)
        if falloff == 'hard':
            cov = np.clip((1 - d) * min(rx, ry) / soft + 0.5, 0, 1)
        else:
            cov = np.clip(1 - d, 0, 1) ** 2
        cov = cov.astype(F32) * value
        if mode == 'max':
            mask[idx] = np.maximum(mask[idx], cov)
        elif mode == 'add':
            mask[idx] = mask[idx] + cov
        else:  # 'min'
            mask[idx] = np.minimum(mask[idx], 1 - cov)

    # --------------------------------------------------------------------------- generators
    def crack_path(self, x0: float, y0: float, length_px: float, angle: float, step: float = 3.0,
                   wiggle: float = 0.35, drift: float = 0.0):
        """Random-walk polyline (pixel coords) for a crack/scratch."""
        rng = self.rng
        pts = [(x0, y0)]
        a = angle
        n = max(2, int(length_px / step))
        for _ in range(n):
            a += rng.normal(0, wiggle) * 0.5 + drift
            a = a * 0.9 + angle * 0.1
            x0 += math.cos(a) * step
            y0 += math.sin(a) * step
            pts.append((x0, y0))
        return pts

    def crack_network(self, mask: np.ndarray, count: int, length_px=(40, 200), width=(0.6, 1.4), branch: float = 0.5,
                      wiggle: float = 0.5, angle=None, depth: int = 2) -> None:
        rng = self.rng

        def grow(x, y, L, a, w, d):
            pts = self.crack_path(x, y, L, a, step=2.5, wiggle=wiggle)
            ws = np.linspace(w, w * 0.35, len(pts))
            self.stroke(mask, pts, ws, soft=0.7)
            if d > 0:
                for _ in range(rng.poisson(branch * 2)):
                    k = rng.integers(1, len(pts) - 1)
                    bx, by = pts[k]
                    ba = a + rng.choice([-1, 1]) * rng.uniform(0.5, 1.2)
                    grow(bx, by, L * rng.uniform(0.25, 0.6), ba, ws[k] * 0.8, d - 1)

        for _ in range(count):
            a = rng.uniform(0, 2 * math.pi) if angle is None else angle + rng.normal(0, 0.4)
            grow(rng.uniform(0, self.n), rng.uniform(0, self.n), rng.uniform(*length_px), a,
                 rng.uniform(*width), depth)

    # ------------------------------------------------------------------------------ outputs
    def normal_from_height(self, h_m: np.ndarray, strength: float = 1.0) -> np.ndarray:
        """Tangent-space normal map (encoded 0..1, OpenGL +Y) from a height field in meters."""
        t = self.texel
        dx = (np.roll(h_m, -1, 1) - np.roll(h_m, 1, 1)) / (2 * t)
        dy = (np.roll(h_m, -1, 0) - np.roll(h_m, 1, 0)) / (2 * t)
        nx = -dx * strength
        ny = -dy * strength
        inv = 1.0 / np.sqrt(nx * nx + ny * ny + 1.0)
        nrm = np.stack([nx * inv, ny * inv, inv], axis=-1)
        return (nrm * 0.5 + 0.5).astype(F32)

    def cavity(self, h_m: np.ndarray, radii_m=(0.002, 0.008, 0.03), scale_m: float = 0.001) -> np.ndarray:
        """0 (open) .. 1 (deep cavity) from how far each pixel sits below its blurred surroundings."""
        acc = np.zeros_like(h_m)
        for r in radii_m:
            b = self.blur(h_m, max(r / self.texel, 0.5))
            acc += np.clip((b - h_m) / scale_m, 0, None)
        return np.clip(acc / len(radii_m), 0, 1).astype(F32)


# =============================================================================================
# Saving (through bpy, which writes WebP)
# =============================================================================================

def save_image(path: str, arr: np.ndarray, quality: int = 90) -> str:
    """Write an (N, N, 3|4) or (N, N) float array (row 0 = bottom) as WebP/PNG via Blender."""
    import bpy

    if arr.ndim == 2:
        arr = np.repeat(arr[..., None], 3, axis=2)
    h, w = arr.shape[:2]
    alpha = arr.shape[2] == 4
    if not alpha:
        arr = np.concatenate([arr, np.ones((h, w, 1), F32)], axis=2)
    name = os.path.basename(path)
    img = bpy.data.images.new(name, w, h, alpha=alpha, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'  # raw byte values in = raw bytes out
    img.pixels.foreach_set(np.clip(arr, 0, 1).astype(F32).ravel())
    ext = os.path.splitext(path)[1].lower()
    img.file_format = 'WEBP' if ext == '.webp' else 'PNG'
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(filepath=path, quality=quality)
    bpy.data.images.remove(img)
    return path


def seam_report(name: str, a: np.ndarray) -> str:
    """Seam check: the mean jump across the wrap edge vs. the jumps between every other pair of
    adjacent columns / rows. Seamless if the wrap is no worse than the worst interior line (pattern
    edges that fall on the wrap, like plank gaps, are legitimately as strong as their copies)."""
    if a.ndim == 3:
        a = lum(a)
    out = []
    for axis, label in ((1, 'u'), (0, 'v')):
        d = np.abs(np.diff(a, axis=axis, append=np.take(a, [0], axis=axis))).mean(axis=1 - axis)
        wrap, inner = float(d[-1]), d[:-1]
        ok = wrap <= float(inner.max()) * 1.001 + 1e-6
        out.append(f'{label}: wrap {wrap:.4f} / median {float(np.median(inner)):.4f} / max {float(inner.max()):.4f}'
                   f' {"ok" if ok else "SEAM?"}')
    return f'{name}: ' + ', '.join(out)
