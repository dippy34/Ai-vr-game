// Trailer gameplay shots: first-person, the game's own look (darkness, fog, your Crank Light),
// frame-stepped at 30 fps through dev/capture/harness.cjs with a scripted monster.
//
//   PORT=5320 npx vite --config dev/anim/vite.capture.config.ts     (no-HMR server)
//   node dev/trailer/shots.cjs [shot ...] [--size 1280x720] [--test]
//
// Frames go to dev/trailer/out/<shot>/f_%05d.jpg. --test renders three sample frames per shot (at
// 25 / 50 / 85 %, each after a short warm-up) into dev/trailer/out/test_<shot>_<n>.jpg.
const fs = require('fs');
const path = require('path');
const { build } = require('../anim/scenes.cjs');

const D = Math.PI / 180;
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const [W, H] = opt('size', '1280x720').split('x').map(Number);
const TEST = args.includes('--test');
const wanted = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--size')));
const OUT = path.join(__dirname, 'out');

/** Yaw (deg, rig convention: 0 looks down -Z) that looks from (x, z) toward (tx, tz). */
const look = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z)) / D;
/** A slow handheld sway (deg). */
const sway = (f, a = 1) => ({ yaw: a * (0.7 * Math.sin(f / 30 * 0.8) + 0.25 * Math.sin(f / 30 * 2.1)), pitch: a * 0.45 * Math.sin(f / 30 * 1.3 + 1) });
const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
const smooth = (t) => {
  const k = Math.max(0, Math.min(1, t));
  return k * k * (3 - 2 * k);
};

// ---- the shots --------------------------------------------------------------------------------

// A. Light on in the dark hallway; the beam sweeps and finds it standing there. It turns to listen.
const hallMon = build({ x: -5.7, z: -0.15, yaw: -90 }, [
  { gait: 'still', act: 'none', alert: 0.3, wait: 3.6 },
  { act: 'listen', focus: { x: -10.2, y: 1.6, z: 0 }, mode: 'investigate', alert: 0.6, wait: 3.0 },
]);
const hall = {
  frames: 200,
  cmd: (f) => {
    const s = sway(f);
    const t = f / 30;
    return {
      x: -10.2, z: 0.05,
      yaw: lerp(-62, -91, smooth((t - 1.2) / 2.6)) + s.yaw,
      pitch: -3 + s.pitch,
      light: t >= 0.9,
      mon: hallMon[Math.min(f, hallMon.length - 1)],
    };
  },
};

// B. It ducks through the living-room door, coming straight at you.
const doorMon = build({ x: -8.6, z: -0.5, yaw: -120 }, [
  { gait: 'walk', alert: 0.5 },
  { path: [[-7.4, -0.2], [-6.5, 0.6], [-6.4, 1.9], [-6.0, 3.3]], speed: 0.9 },
  { gait: 'still', act: 'sniff', focus: { x: -4.9, y: 1.5, z: 4.6 }, wait: 2.0 },
]);
const door = {
  frames: Math.min(doorMon.length, 250),
  cmd: (f) => {
    const m = doorMon[Math.min(f, doorMon.length - 1)];
    const s = sway(f, 0.8);
    const px = -4.85, pz = 4.7;
    return { x: px, z: pz, yaw: look(px, pz, m.x * 0.6 + -6.45 * 0.4, m.z * 0.6 + 1.2 * 0.4) + s.yaw, pitch: -4 + s.pitch, light: true, mon: m };
  },
};

// C. On all fours over the coffee table.
const coffeeTop = (x, z) => {
  const inX = Math.min(x - -8.3, -7.1 - x);
  const inZ = Math.min(z - 4.2, 4.8 - z);
  const k = Math.max(0, Math.min(1, (Math.min(inX, inZ * 2) + 0.15) / 0.35));
  return 0.45 * k * k * (3 - 2 * k);
};
const climbMon = build({ x: -5.9, z: 4.45, yaw: 90 }, [
  { gait: 'creep', y: coffeeTop, alert: 0.5 },
  { path: [[-6.3, 4.5]], speed: 0.6, stop: false },
  { act: 'climb', posture: 'crawl', path: [[-7.0, 4.5], [-7.7, 4.5], [-8.4, 4.5]], speed: 0.42, stop: false },
  { act: 'none', posture: 'tall', path: [[-9.2, 4.4], [-9.6, 4.0]], speed: 0.6 },
  { gait: 'still', wait: 0.6 },
]);
const climb = {
  frames: Math.min(climbMon.length, 240),
  cmd: (f) => {
    const m = climbMon[Math.min(f, climbMon.length - 1)];
    const s = sway(f, 0.7);
    const px = -7.4, pz = 2.0;
    return { x: px, z: pz, yaw: look(px, pz, m.x, m.z) + s.yaw, pitch: -14 + s.pitch, light: true, mon: m };
  },
};

// D. Talking with your hands: Sam signs "stop", then "come here", in your beam.
const hands = {
  frames: 120,
  cmd: (f) => {
    const t = f / 30;
    const s = sway(f, 0.5);
    const sign = t < 0.4 ? null : t < 2.2 ? 'stop' : 'comeHere';
    const signStart = sign === 'stop' ? 0.4 : 2.2;
    return {
      // At this distance the flashlight sits below the eyes. Aim up slightly so its
      // beam reaches Sam's raised palm rather than only lighting his chest.
      x: 0.0, z: 6.35, yaw: 4 + s.yaw, pitch: 10 + s.pitch, light: true,
      bot: { x: 0.08, z: 5.4, yaw: 180, pitch: -10, sign, signStart },
      sign: t > 2.9 ? 'thumbsUp' : null,
      mon: { x: -9.5, z: -6.5, yaw: 0, gait: 'still', act: 'none' },
    };
  },
};

// E. Your light is dying. You wind it. It hears the ratchet and comes for you.
const RUN_FROM = 1.2;
const windMon = build({ x: RUN_FROM, z: 0.1, yaw: -90 }, [
  { gait: 'still', act: 'none', alert: 0.3, wait: 3.9 },
  { act: 'listen', focus: { x: 8.6, y: 1.5, z: 0 }, mode: 'investigate', alert: 0.8, wait: 0.8 },
  { act: 'none', gait: 'run', mode: 'chase', alert: 1, focus: { x: 8.6, y: 1.4, z: 0 } },
  // The capture hands control back to the real chase before its face reaches the camera.
  { path: [[4.0, -0.15], [6.6, 0.05], [8.2, 0.0]], speed: 3.3, accel: 6 },
]);
const windRelease = windMon.findIndex(m => Math.hypot(m.x - 8.6, m.z) <= 1.6);
const wind = {
  frames: 280,
  cmd: (f) => {
    const t = f / 30;
    const s = sway(f, t > 4 ? 1.6 : 1);
    const winding = t >= 2.4 && t < 4.6;
    const runEnd = windMon.length;
    const c = { x: 8.6, z: 0.0, yaw: 90 + s.yaw, pitch: -2 + s.pitch, light: true, crank: winding };
    // Battery: dying (flickers) until you wind it, then full and bright.
    c.charge = t < 2.4 ? 0.11 - t * 0.02 : t < 4.6 ? 0.06 + (t - 2.4) * 0.25 : 0.6;
    if (f < runEnd && Math.hypot(windMon[f].x - c.x, windMon[f].z - c.z) > 1.6) {
      c.freeze = true;
      c.mon = windMon[f];
    } else {
      // Let the sim close the last distance and trigger its real catch and jumpscare.
      c.freeze = false;
      if (f === windRelease) c.noise = 0.42; // hand the crank sound to the real hearing rules
    }
    return c;
  },
};

// F. A close chase down the hallway: the player backs away as it charges.
const rushMon = build({ x: -3.0, z: 0.05, yaw: 90 }, [
  { gait: 'run', mode: 'chase', alert: 1, focus: { x: -10.8, y: 1.5, z: 0.05 } },
  { path: [[-5.5, 0.05], [-7.2, 0.08], [-8.4, 0.05]], speed: 3.4, accel: 6 },
]);
const rush = {
  frames: 90,
  cmd: (f) => {
    const t = f / 30;
    const s = sway(f, 1.2);
    return {
      x: lerp(-7.8, -10.8, smooth(t / 2.4)), z: 0.05,
      yaw: -90 + s.yaw, pitch: -2 + s.pitch, light: true,
      mon: rushMon[Math.min(f, rushMon.length - 1)],
    };
  },
};

const SHOTS = { hall, door, climb, hands, wind, rush };

// ---- runner -----------------------------------------------------------------------------------

async function capture() {
  const { setup } = require('../capture/harness.cjs');
  fs.mkdirSync(OUT, { recursive: true });
  const names = wanted.length ? wanted : Object.keys(SHOTS);
  for (const name of names) {
    const shot = SHOTS[name];
    if (!shot) throw new Error(`unknown shot ${name}: ${Object.keys(SHOTS).join(', ')}`);
    // A fresh round per shot (the wind shot ends in a catch).
    const { browser, page, logs, step } = await setup({ width: W, height: H, base: `http://localhost:${process.env.PORT ?? 5320}/` });
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('.hud')) el.style.display = 'none';
    });
    const dir = path.join(OUT, name);
    fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    let caught = false;
    if (TEST) {
      // Sample frames: warm up 12 frames before each one so the body has settled.
      for (const [n, k] of [0.25, 0.5, 0.85].entries()) {
        const target = Math.floor(shot.frames * k);
        for (let f = Math.max(0, target - 12); f < target; f++) await step(shot.cmd(f), null);
        await step(shot.cmd(target), path.join(OUT, `test_${name}_${n}.jpg`));
      }
    } else {
      for (let f = 0; f < shot.frames; f++) {
        const info = await step(shot.cmd(f), path.join(dir, `f_${String(f).padStart(5, '0')}.jpg`));
        caught ||= info.status === 'caught';
        if (f % 30 === 0) console.log(`${name} ${f}/${shot.frames} ${((Date.now() - t0) / 1000).toFixed(0)}s`, JSON.stringify(info));
      }
    }
    console.log(`== ${name} done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    if (logs.length) console.log(logs.slice(0, 5).join('\n'));
    await browser.close();
    if (!TEST && name === 'wind' && !caught) throw new Error('The wind shot did not reach the real catch. Re-capture before exporting the trailer.');
  }
}

module.exports = { SHOTS };
if (require.main === module) capture();
