// Checks the catch still plays through the CatchPoser contract with the procedural body:
// (a) a remote grab (it lunges at the bot "Sam"), filmed by the review camera, then
// (b) the local jumpscare, filmed from the player's own eyes. Writes a contact sheet.
//   node dev/anim/catch.cjs        (server from dev/anim/serve.sh on :5320)
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { setup } = require('../capture/harness.cjs');

const OUT = path.join(__dirname, 'out', 'catch');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const D = Math.PI / 180;

(async () => {
  const { browser, page, logs, step } = await setup({ width: 640, height: 360, base: `http://localhost:${process.env.PORT ?? 5320}/` });
  await page.evaluate(() => {
    const m = window.__mute;
    const r = m.renderer;
    const cam = new r.ctx.camera.constructor(50, innerWidth / innerHeight, 0.05, 60);
    const real = r.render.bind(r);
    window.__camPose = null;
    r.render = () => {
      r.hemi.intensity = Math.max(r.hemi.intensity, 1.6);
      const p = window.__camPose;
      if (!p) return real();
      cam.position.set(p.x, p.y, p.z);
      cam.lookAt(p.tx, p.ty, p.tz);
      cam.updateMatrixWorld(true);
      r.ctx.renderer.render(r.ctx.scene, cam);
    };
    window.__caught = (id) => {
      const s = m.game.current;
      const ev = { id, position: s.state.players[id].pose.head.position };
      r.caught(ev, s.state, s.localId, m.game.localPose);
    };
  });
  let n = 0;
  const shot = async (cmd) => step(cmd, path.join(OUT, `f_${String(n++).padStart(5, '0')}.jpg`));
  // (a) Sam stands in the foyer; the monster walks up to him and grabs him.
  const sam = { x: 0.7, z: 4.4, yaw: 180, eye: 1.62 };
  const cam = { x: -1.9, y: 1.6, z: 5.4, tx: 0.2, ty: 1.4, tz: 3.4 };
  await page.evaluate((c) => { window.__camPose = c; }, cam);
  for (let f = 0; f < 50; f++) {
    const z = 1.6 + Math.min(f, 40) * 0.04;
    const cmd = { x: -1.5, z: 6.5, yaw: 0, bot: sam, mon: { x: 0.65, z, yaw: 180, speed: f < 40 ? 1.2 : 0, gait: f < 40 ? 'walk' : 'still', mode: 'chase', alert: 1, focus: { x: 0.7, y: 1.5, z: 4.4 } } };
    if (f === 41) await page.evaluate(() => window.__caught('bot'));
    if (f % 4 === 0 || (f > 40 && f % 2 === 0)) await shot(cmd);
    else await step(cmd);
  }
  // (b) Local catch: the player faces it, it is caught; frames from the player's eyes.
  await page.evaluate(() => { window.__camPose = null; });
  for (let f = 0; f < 30; f++) {
    const cmd = { x: -0.8, z: 6.6, yaw: 180, pitch: 0, bot: sam, mon: { x: -0.8, z: 5.2, yaw: 0, speed: 0, gait: 'still', mode: f < 2 ? 'chase' : 'feeding', alert: 1 } };
    if (f === 2) await page.evaluate(() => window.__caught(window.__mute.game.current.localId));
    if (f % 3 === 2) await shot(cmd);
    else await step(cmd);
  }
  if (logs.length) console.log(logs.slice(0, 10).join('\n'));
  await browser.close();
  const out = path.join(__dirname, 'out', 'catch_sheet.jpg');
  execSync(`ffmpeg -loglevel error -y -i ${OUT}/f_%05d.jpg -vf "scale=320:-1,tile=6x${Math.ceil(n / 6)}" -frames:v 1 -q:v 3 ${out}`);
  console.log(`sheet ${out} (${n} frames)`);
  void D;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
