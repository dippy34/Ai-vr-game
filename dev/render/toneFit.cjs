// Fit a rational curve y = x(ax+b) / (x(cx+d)+e) to the AgX sigmoid (log2 encode -> polynomial ->
// pow 2.2*power), so the tone mapper needs no transcendentals (the constants in
// src/platform/render/fx/pipeline.ts TONE: divide a, b, d, e by c). Error measured in sRGB output.
//   node dev/render/toneFit.cjs [power=1.1]      (higher power = deeper toe, more contrast)
const P = +(process.argv[2] || 1.1);
const poly = (x) => {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
};
const F = (x) => {
  const l = Math.min(1, Math.max(0, (Math.log2(Math.max(x, 1e-10)) + 12.47393) / (4.026069 + 12.47393)));
  return Math.pow(Math.max(poly(l), 0), 2.2 * P);
};
const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const R = ([a, b, c, d, e], x) => Math.max(0, (x * (a * x + b)) / (x * (c * x + d) + e));
const xs = [];
for (let i = 0; i <= 240; i++) xs.push(Math.pow(2, -12 + (i / 240) * 16));
const err = (p) => {
  if (p.some((v) => v <= 0)) return 1e9;
  let s = 0, mx = 0;
  for (const x of xs) {
    const d = enc(Math.min(1, R(p, x))) - enc(Math.min(1, F(x)));
    s += d * d;
    mx = Math.max(mx, Math.abs(d));
  }
  return Math.sqrt(s / xs.length) + 0.5 * mx;
};
// Nelder-Mead in log space.
function nm(f, x0, iters = 20000) {
  const n = x0.length;
  let pts = [x0];
  for (let i = 0; i < n; i++) { const p = x0.slice(); p[i] += 0.5; pts.push(p); }
  const ev = (q) => f(q.map(Math.exp));
  let vals = pts.map(ev);
  for (let it = 0; it < iters; it++) {
    const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    pts = idx.map((i) => pts[i]); vals = idx.map((i) => vals[i]);
    const c = Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += pts[i][j] / n;
    const w = pts[n];
    const r = c.map((v, j) => v + (v - w[j]));
    const fr = ev(r);
    if (fr < vals[0]) {
      const e = c.map((v, j) => v + 2 * (v - w[j]));
      const fe = ev(e);
      if (fe < fr) { pts[n] = e; vals[n] = fe; } else { pts[n] = r; vals[n] = fr; }
    } else if (fr < vals[n - 1]) { pts[n] = r; vals[n] = fr; } else {
      const k = c.map((v, j) => v + 0.5 * (w[j] - v));
      const fk = ev(k);
      if (fk < vals[n]) { pts[n] = k; vals[n] = fk; } else {
        for (let i = 1; i <= n; i++) { pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j])); vals[i] = ev(pts[i]); }
      }
    }
  }
  return { p: pts[0].map(Math.exp), v: vals[0] };
}
let best = null;
for (const seed of [[2.51, 0.03, 2.43, 0.59, 0.14], [1, 0.01, 1, 0.3, 0.05], [3, 0.002, 3, 1, 0.3], [1.2, 0.05, 1.1, 0.8, 0.02]]) {
  const r = nm(err, seed.map(Math.log));
  if (!best || r.v < best.v) best = r;
}
console.log('params', best.p.map((v) => v.toPrecision(6)).join(', '), 'score', best.v.toFixed(5));
for (const x of [0.0005, 0.001, 0.002, 0.004, 0.008, 0.016, 0.03, 0.06, 0.12, 0.25, 0.5, 1, 2, 4, 8]) {
  console.log(x.toString().padEnd(7), 'agx', (255 * enc(F(x))).toFixed(1).padStart(6), 'fit', (255 * enc(Math.min(1, R(best.p, x)))).toFixed(1).padStart(6));
}
