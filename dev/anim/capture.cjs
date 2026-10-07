// Review footage for the procedural monster body. Drives dev/capture/harness.cjs (brain frozen,
// monster state scripted every 1/30 s frame) and films it with a free review camera.
//
//   npx vite --config dev/anim/vite.capture.config.ts      (no-HMR server on :5320, restart on changes)
//   node dev/anim/capture.cjs <scene> [--every N] [--size 960x540] [--from F] [--to F] [--sheet | --video]
//                                    [--game [--hemi I]]
//   --game   the game's own darkness and fog (review lighting lifts the ambient and pushes the fog
//            away); --hemi sets the ambient intensity (default: the game's own). The Crank Lights
//            follow the players, not the review camera, so raise --hemi to see the body.
//
// Scenes live in dev/anim/scenes.cjs. Frames go to dev/anim/out/<scene>/, the clip to
// dev/anim/out/<scene>.mp4 (every frame), or with --every N a contact sheet of every Nth frame
// (dev/anim/out/<scene>_sheet.jpg). Only captured frames are rendered (stepping is cheap).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { setup } = require('../capture/harness.cjs');
const scenes = require('./scenes.cjs');

const args = process.argv.slice(2);
const name = args[0];
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const scene = scenes[name];
if (!scene) {
  console.error(`unknown scene "${name}". Scenes: ${Object.keys(scenes).join(', ')}`);
  process.exit(1);
}
const every = Number(opt('every', 1));
const [W, H] = opt('size', '960x540').split('x').map(Number);
const from = Number(opt('from', 0));
const to = Number(opt('to', scene.frames - 1));
// --video: an MP4 even when skipping frames (encoded at 30 / every fps).
const video = args.includes('--video');
const sheet = !video && (args.includes('--sheet') || every > 1);
const OUT = path.join(__dirname, 'out');
const dir = path.join(OUT, name);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const t0 = Date.now();
  const { browser, page, logs, step } = await setup({ width: W, height: H, base: `http://localhost:${process.env.PORT ?? 5320}/` });
  await page.evaluate(() => {
    const m = window.__mute;
    const THREE = m.renderer.ctx.camera.constructor; // PerspectiveCamera class
    const cam = new THREE(50, innerWidth / innerHeight, 0.05, 60);
    window.__reviewCam = cam;
    window.__camPose = null;
    window.__draw = false;
    window.__monMs = [];
    const real = m.renderer.render.bind(m.renderer);
    const r = m.renderer;
    r.render = () => {
      if (!window.__draw) return;
      // Review lighting: the game is near-black; lift the ambient so the body reads.
      if (!window.__game) {
        r.hemi.intensity = window.__hemi ?? 2.2;
        const fog = r.ctx.scene.fog;
        if (fog) { fog.near = 30; fog.far = 80; }
      } else if (window.__hemi !== undefined && window.__hemi !== null) {
        r.hemi.intensity = window.__hemi;
      }
      const p = window.__camPose;
      if (p) {
        cam.aspect = innerWidth / innerHeight;
        cam.fov = p.fov ?? 50;
        cam.updateProjectionMatrix();
        cam.position.set(p.x, p.y, p.z);
        cam.lookAt(p.tx, p.ty, p.tz);
        cam.updateMatrixWorld(true);
        r.ctx.renderer.render(r.ctx.scene, cam);
      } else real();
    };
    // Time the monster's update (procedural body) per frame.
    const mon = r.monster;
    const up = mon.update.bind(mon);
    mon.update = (s, dt) => {
      const a = performance.now();
      up(s, dt);
      window.__monMs.push(performance.now() - a);
    };
  });
  if (scene.init) await page.evaluate(scene.init);
  const game = args.includes('--game');
  const hemi = opt('hemi', null);
  await page.evaluate(([g]) => {
    window.__game = g;
    // Game-look footage is for showing off: no HUD over it.
    if (g) for (const el of document.querySelectorAll('.hud')) el.style.display = 'none';
  }, [game]);
  let shots = 0;
  for (let f = 0; f <= to; f++) {
    const cmd = scene.frame(f);
    const shoot = f >= from && (f - from) % every === 0;
    const cam = scene.cam(f);
    await page.evaluate(([c, d, h]) => { window.__camPose = c; window.__draw = d; window.__hemi = h; },
      [cam, shoot, game ? (hemi === null ? null : Number(hemi)) : scene.hemi ?? 2.2]);
    const file = shoot ? path.join(dir, `f_${String(shots).padStart(5, '0')}.jpg`) : null;
    await step(cmd, file);
    if (shoot) shots++;
  }
  const ms = await page.evaluate(() => {
    const a = window.__monMs.slice(30).sort((x, y) => x - y);
    return { n: a.length, median: a[a.length >> 1], p95: a[Math.floor(a.length * 0.95)], max: a[a.length - 1] };
  });
  console.log(`monster.update ms: median ${ms.median?.toFixed(3)} p95 ${ms.p95?.toFixed(3)} max ${ms.max?.toFixed(3)} (n=${ms.n})`);
  if (logs.length) console.log(logs.slice(0, 10).join('\n'));
  await browser.close();
  if (sheet) {
    const cols = Number(opt('cols', 4));
    const rows = Math.ceil(shots / cols);
    const out = path.join(OUT, `${name}_sheet.jpg`);
    const sc = Number(opt('scale', 0.5));
    execSync(`ffmpeg -loglevel error -y -i ${dir}/f_%05d.jpg -vf "scale=${Math.round(W * sc)}:-1,tile=${cols}x${rows}" -frames:v 1 -q:v 3 ${out}`);
    console.log(`sheet ${out} (${shots} frames)`);
  } else {
    const out = path.join(OUT, `${name}.mp4`);
    if (every === 1) execSync(`sh ${path.join(__dirname, '../capture/encode.sh')} ${dir} ${out}`, { stdio: 'inherit' });
    else {
      execSync(`ffmpeg -loglevel error -y -framerate ${30 / every} -i ${dir}/f_%05d.jpg -c:v libx264 -preset slow -crf 18 -tune film -pix_fmt yuv420p -movflags +faststart ${out}`);
      execSync(`ffprobe -v error -show_entries format=duration,size -of default=nw=1 ${out}`, { stdio: 'inherit' });
    }
    console.log(`clip ${out}`);
  }
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
