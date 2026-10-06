// House review: a top-down plan screenshot (ceiling hidden, work light) of the dressed level, a
// summary of the set-dressing placements, and renderer.stats() from a few in-game viewpoints
// (fog on, normal darkness).
//   npx vite --port 5199   then:   node dev/render/house.cjs [baseUrl] [outDir]
function loadPlaywright() {
  try { return require('playwright'); } catch {}
  return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
}
const { chromium } = loadPlaywright();
const base = process.argv[2] || 'http://localhost:5199/';
const out = process.argv[3] || require('os').tmpdir();
const VIEWS = [
  // name, head x, z, yaw (deg, 0 = looking -Z / north, 90 = looking -X / west)
  ['foyer', 0, 5.6, 0], ['hallway', 0, 0, 90], ['living', -4.2, 6.6, 65], ['dining', 4.2, 2.4, -55],
  ['kitchen', 5.6, -2.4, -140], ['study', 0.4, -2.2, 160], ['bedroom', -6.0, -2.2, 130], ['bathroom', -3.2, -5.0, 0],
];

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(300000);
  await page.goto(base);
  await page.click('text=Play solo');
  await page.waitForSelector('text=Start round', { state: 'visible' });
  // Models arrive asynchronously; the level is rebuilt with them once they all have.
  await page.waitForFunction(() => (window.__mute.renderer.level?.dressing?.placed.length ?? 0) > 0, null, { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.click('text=Play on this screen');
  const frames = async (n) => {
    const f0 = await page.evaluate(() => window.__mute.renderer.ctx.renderer.info.render.frame);
    await page.waitForFunction(([f0, n]) => window.__mute.renderer.ctx.renderer.info.render.frame >= f0 + n, [f0, n]);
  };
  const look = (x, y, z, yaw, pitch) => page.evaluate(([x, y, z, yaw, pitch]) => {
    const m = window.__mute;
    m.game.current.state.phase = 'lobby';
    const { rig, camera } = m.renderer.ctx;
    rig.rotation.y = (yaw * Math.PI) / 180;
    m.input.pitch = (pitch * Math.PI) / 180;
    rig.position.y = y;
    rig.updateMatrixWorld(true);
    const head = camera.getWorldPosition(camera.position.clone());
    rig.position.x += x - head.x;
    rig.position.z += z - head.z;
  }, [x, y, z, yaw, pitch]);

  const summary = await page.evaluate(() => {
    const d = window.__mute.renderer.level.dressing;
    const byRoom = {};
    for (const p of d?.placed ?? []) (byRoom[p.room] ??= []).push(p.name);
    return { count: d?.placed.length ?? 0, boardedWindows: [...(d?.boarded ?? [])], byRoom };
  });
  console.log('dressing:', JSON.stringify(summary, null, 1));

  for (const [name, x, z, yaw] of VIEWS) {
    await look(x, 0, z, yaw, -8);
    await frames(3);
    console.log(name.padEnd(9), JSON.stringify(await page.evaluate(() => window.__mute.renderer.stats())));
  }

  // Plan view: work light, no fog, no ceiling, camera high above the middle of the house.
  await page.evaluate(() => {
    const r = window.__mute.renderer;
    r.hemi.intensity = 2.6;
    r.ctx.scene.fog = null;
    for (const c of r.level.group.children) if (c.name === 'ceilings') c.visible = false;
  });
  await look(0, 9.4, 0.9, 0, -85);
  await frames(3);
  await page.screenshot({ path: `${out}/house-plan.png` });
  console.log('plan view:', `${out}/house-plan.png`);
  await browser.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
