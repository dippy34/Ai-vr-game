// Scripted monster states for dev/anim/capture.cjs. Each scene: { frames, frame(f) -> harness cmd,
// cam(f) -> review camera {x,y,z,tx,ty,tz,fov} }. Positions are real spots in src/core/level.ts.
//
// A scene is a list of steps run at 30 fps:
//   { path: [[x,z], ...], speed, accel }   follow a Catmull-Rom curve through the points
//   { wait: seconds }                       stand still
//   { turn: degrees, rate }                 turn in place (deg/s)
// Any other keys (gait, posture, act, focus, mode, alert, y) persist into later frames, like the
// sim's own fields. `y` may be a function (x, z) -> height (climbing).
const D = Math.PI / 180;
const FPS = 30;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function catmull(pts, n) {
  const out = [];
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 1; i < P.length - 2; i++) {
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
      const f = (j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t * t + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t * t * t);
      out.push([f(0), f(1)]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function build(start, steps) {
  const frames = [];
  let x = start.x;
  let z = start.z;
  let yaw = (start.yaw ?? 0) * D;
  let speed = 0;
  const fields = { gait: 'still', posture: 'tall', act: 'none', focus: null, mode: 'wander', alert: 0.3, y: 0 };
  const push = () => {
    const y = typeof fields.y === 'function' ? fields.y(x, z) : fields.y;
    frames.push({ x, z, y, yaw: yaw / D, speed, gait: fields.gait, posture: fields.posture, act: fields.act, focus: fields.focus, mode: fields.mode, alert: fields.alert });
  };
  for (const s of steps) {
    for (const k of ['gait', 'posture', 'act', 'focus', 'mode', 'alert', 'y']) if (k in s) fields[k] = s[k];
    if (s.path) {
      const pts = catmull([[x, z], ...s.path], 24);
      // Arc-length table.
      const L = [0];
      for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const total = L[L.length - 1];
      const accel = s.accel ?? 2.5;
      let d = 0;
      while (d < total - 1e-3) {
        const left = total - d;
        const vStop = Math.sqrt(2 * accel * left);
        const target = Math.min(s.speed, s.stop === false ? s.speed : vStop);
        speed = speed < target ? Math.min(target, speed + accel / FPS) : Math.max(target, speed - accel * 1.5 / FPS);
        speed = Math.max(speed, 0.05);
        d = Math.min(total, d + speed / FPS);
        let i = 1;
        while (i < L.length - 1 && L[i] < d) i++;
        const k = (d - L[i - 1]) / Math.max(1e-6, L[i] - L[i - 1]);
        const nx = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k;
        const nz = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k;
        const want = Math.atan2(-(nx - x), -(nz - z));
        if (Math.hypot(nx - x, nz - z) > 1e-4) yaw += Math.max(-4.5 / FPS, Math.min(4.5 / FPS, wrap(want - yaw)));
        x = nx;
        z = nz;
        push();
      }
      if (s.stop !== false) speed = 0;
    } else if (s.turn !== undefined) {
      const rate = (s.rate ?? 120) * D;
      let left = s.turn * D;
      speed = 0;
      while (Math.abs(left) > 1e-4) {
        const d = Math.sign(left) * Math.min(Math.abs(left), rate / FPS);
        yaw += d;
        left -= d;
        push();
      }
    } else if (s.wait !== undefined) {
      speed = 0;
      for (let i = 0; i < Math.round(s.wait * FPS); i++) push();
    } else {
      push();
    }
  }
  return frames;
}

function scene(start, steps, cam, extra = {}) {
  const frames = build(start, steps);
  const camFn = typeof cam === 'function' ? cam : () => cam;
  return {
    frames: frames.length,
    // Park the local player out of the way (the review camera films instead).
    frame: (f) => ({ x: extra.px ?? 9.5, z: extra.pz ?? 6.5, yaw: 0, pitch: 0, mon: frames[Math.min(f, frames.length - 1)] }),
    cam: (f) => camFn(f, frames[Math.min(f, frames.length - 1)]),
    hemi: extra.hemi,
  };
}

/** Camera that keeps the monster framed from a fixed spot (gentle follow). */
const follow = (x, y, z, dy = 1.1, fov = 50) => (f, m) => ({ x, y, z, tx: m.x, ty: (m.y ?? 0) + dy, tz: m.z, fov });

// Coffee table in the living room: x [-8.3, -7.1], z [4.2, 4.8], top 0.45.
const coffeeTop = (x, z) => {
  // What the sim would set: the surface under its center, eased at the edges (it climbs up).
  const inX = Math.min(x - -8.3, -7.1 - x);
  const inZ = Math.min(z - 4.2, 4.8 - z);
  const k = Math.max(0, Math.min(1, (Math.min(inX, inZ * 2) + 0.15) / 0.35));
  return 0.45 * k * k * (3 - 2 * k);
};

const TOUR_STEPS = [
      { gait: 'walk', alert: 0.35 },
      { path: [[-2.0, -0.56], [0.6, -0.6], [1.55, -0.62]], speed: 0.85, stop: false },
      { path: [[2.3, -0.85], [2.55, -1.6], [2.7, -2.7]], speed: 0.75, stop: false },
      { path: [[3.35, -4.3], [3.2, -4.85], [2.3, -5.05], [0.9, -5.05]], speed: 0.75, stop: false },
      { path: [[1.4, -6.4], [2.6, -6.95], [2.95, -7.05]], speed: 0.55 },
      { gait: 'still', act: 'listen', focus: { x: 3.0, y: 1.6, z: -8.2 }, mode: 'investigate', alert: 0.55, wait: 4.5 },
      { act: 'none', focus: null, mode: 'wander', wait: 0.8 },
    ];
const DOOR_STEPS = [
      { path: [[-7.4, -0.2], [-6.5, 0.6], [-6.4, 1.9], [-6.0, 3.4]], speed: 0.9 },
      { wait: 0.8 },
      { turn: 170, rate: 100 },
      { posture: 'crawl', gait: 'creep' },
      { path: [[-6.3, 2.4], [-6.5, 1.2], [-6.7, -0.1], [-7.6, -0.5]], speed: 0.6 },
      { posture: 'tall', gait: 'still', wait: 0.8 },
    ];

/** Camera cuts: the first shot whose test passes films the frame. */
const cuts = (...shots) => (f, m) => {
  const s = shots.find((x) => x.when(m, f)) ?? shots[shots.length - 1];
  return { x: s.x, y: s.y, z: s.z, tx: m.x + (s.dx ?? 0), ty: (m.y ?? 0) + (s.ty ?? 1.1), tz: m.z, fov: s.fov ?? 52 };
};

module.exports = {
  // Close-ups for checking contacts (not part of the footage set).
  trailClose: scene({ x: -4.4, z: -0.5, yaw: -90 }, TOUR_STEPS, (f, m) => ({ x: m.x + 1.6, y: 1.3, z: 0.6, tx: m.x - 0.1, ty: 1.15, tz: -0.95, fov: 50 })),
  jambClose: scene({ x: -8.6, z: -0.5, yaw: -120 }, DOOR_STEPS, () => ({ x: -5.35, y: 1.45, z: 2.9, tx: -6.45, ty: 1.35, tz: 1.2, fov: 48 })),
  // (6) Affordances in one path: fingertips along the hallway wall, pivoting on the study door's
  // jamb as it turns in, the jambs, a hand on the desk as it passes, hands on the moonlit window.
  tour: scene(
    { x: -4.4, z: -0.5, yaw: -90 },
    TOUR_STEPS,
    cuts(
      { when: (m) => m.z > -1.75, x: 3.75, y: 1.75, z: 0.75, fov: 50 },
      { when: (m) => m.z > -6.3 && !(m.x < 2.2 && m.z < -5.6), x: -1.05, y: 1.7, z: -4.3, fov: 54 },
      { when: () => true, x: 0.35, y: 1.7, z: -4.4, ty: 1.25, fov: 46 },
    ),
  ),
  // Close-up side view for tuning: across the living room along X, stop, turn in place, back.
  lab: scene(
    { x: -3.9, z: 3.2, yaw: 90 },
    [
      { path: [[-5.5, 3.25], [-8.2, 3.1]], speed: 1.0 },
      { wait: 0.5 },
      { turn: 160, rate: 140 },
      { gait: 'creep', path: [[-6.8, 3.2], [-5.6, 3.3]], speed: 0.45 },
      { gait: 'still', wait: 0.6 },
    ],
    (f, m) => ({ x: m.x * 0.5 + -6.0 * 0.5, y: 1.4, z: 7.2, tx: m.x, ty: 1.15, tz: m.z, fov: 46 }),
  ),
  // (1) A winding walk across the living room, a turn in place, and back (default contract: the
  // sim's current fields, so gait/posture are inferred from speed and geometry).
  walk: scene(
    { x: -4.0, z: 6.6, yaw: 120 },
    [
      { path: [[-5.2, 5.4], [-5.6, 3.6], [-6.8, 3.2], [-8.6, 3.3], [-9.4, 4.0]], speed: 1.0 },
      { wait: 0.6 },
      { turn: 150, rate: 110 },
      { wait: 0.5 },
      { path: [[-8.4, 3.0], [-6.6, 2.6], [-5.6, 3.4]], speed: 1.1 },
      { wait: 1.0 },
    ],
    follow(-10.15, 1.6, 7.25, 1.05, 40),
  ),
  // (2) Through the living-room door (hallway south wall, gap x [-7.0, -5.9] at z = 1.2), at an
  // angle, then back out on all fours through the same frame.
  door: scene(
    { x: -8.6, z: -0.5, yaw: -120 },
    DOOR_STEPS,
    (f, m) => ({ x: -4.75, y: 1.5, z: 4.4, tx: -6.45 + (m.x + 6.45) * 0.35, ty: 1.15, tz: 1.2 + (m.z - 1.2) * 0.35, fov: 52 }),
  ),
  // (3) Over the living-room coffee table (top 0.45 m) along X, on all fours.
  climb: scene(
    { x: -5.9, z: 4.45, yaw: 90 },
    [
      { gait: 'creep', y: coffeeTop },
      { path: [[-6.3, 4.5]], speed: 0.6, stop: false },
      { act: 'climb', posture: 'crawl', path: [[-7.0, 4.5], [-7.7, 4.5], [-8.4, 4.5]], speed: 0.42, stop: false },
      { act: 'none', posture: 'tall', path: [[-9.2, 4.4], [-9.6, 4.0]], speed: 0.6 },
      { gait: 'still', wait: 1.0 },
    ],
    follow(-7.6, 1.35, 1.9, 0.6, 55),
  ),
  // (4) Creep -> stop and listen toward a sound -> sniff -> sweep.
  acts: scene(
    { x: -4.0, z: 6.9, yaw: 140 },
    [
      { gait: 'creep', mode: 'investigate', alert: 0.6 },
      { path: [[-4.6, 5.8], [-5.4, 4.7]], speed: 0.5 },
      { gait: 'still', act: 'listen', focus: { x: -7.4, y: 1.2, z: 2.6 }, alert: 0.7, wait: 3.0 },
      { act: 'sniff', focus: { x: -6.6, y: 0.7, z: 3.4 }, wait: 2.6 },
      { act: 'sweep', focus: { x: -6.3, y: 1.0, z: 3.7 }, alert: 0.95, wait: 2.4 },
      { act: 'none', focus: null, alert: 0.8, wait: 0.8 },
    ],
    follow(-7.3, 1.65, 6.95, 1.25, 52),
  ),
  // (5) A run down the hallway toward the camera (chase).
  run: scene(
    { x: -10.2, z: 0.1, yaw: -90 },
    [
      { gait: 'run', mode: 'chase', alert: 1, focus: { x: 2.4, y: 1.3, z: -0.1 } },
      { path: [[-7.0, -0.2], [-3.0, 0.25], [0.6, 0]], speed: 3.1, accel: 5 },
      { gait: 'still', wait: 1.0 },
      { mode: 'investigate', focus: null, alert: 0.8, wait: 0.8 },
    ],
    follow(3.4, 1.9, -0.8, 0.7, 55),
  ),
};
