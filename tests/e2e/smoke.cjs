// Robot playtest: drives the real game in headless Chromium (desktop mode) through solo play and
// two-tab local multiplayer, checking game state along the way. Robust to very low frame rates.
// usage: npm run dev (in another terminal), then: npm run test:e2e   [baseUrl] [screenshotDir]
function loadPlaywright() {
  try { return require('playwright'); } catch {}
  return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
}
const { chromium } = loadPlaywright();
const base = process.argv[2] || 'http://localhost:5173/';
const out = process.argv[3] || require('os').tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failures++;
};

function watch(page, tag) {
  page.setDefaultTimeout(180000);
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${tag}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
}

const state = (page) => page.evaluate(() => {
  const s = window.__mute.game.current;
  return s ? JSON.parse(JSON.stringify({ id: s.localId, st: s.state })) : null;
});

async function waitState(page, fn, arg, label, timeout = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await state(page);
    if (s && fn(s, arg)) return s;
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Put the local rig so the head is at (x,z) facing `yawDeg` (0 = -Z, 90 = -X). */
const teleport = (page, x, z, yawDeg) => page.evaluate(([x, z, yaw]) => {
  const { rig, camera } = window.__mute.renderer.ctx;
  rig.rotation.y = (yaw * Math.PI) / 180;
  rig.updateMatrixWorld(true);
  const head = camera.getWorldPosition(camera.position.clone());
  rig.position.x += x - head.x;
  rig.position.z += z - head.z;
  rig.updateMatrixWorld(true);
}, [x, z, yawDeg]);

(async () => {
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const ctx = await browser.newContext({ viewport: { width: 640, height: 400 } });
  await ctx.grantPermissions(['microphone']);

  // ------------------------------------------------------------ solo
  const page = await ctx.newPage();
  watch(page, 'solo');
  await page.goto(base);
  await page.fill('#mute-name', 'Tester');
  await page.click('text=Play solo');
  await page.waitForSelector('text=Start round', { state: 'visible' });
  let s = await state(page);
  check(s && s.st.phase === 'lobby', 'solo session in lobby');
  await page.click('text=Start round');
  s = await waitState(page, (s) => s.st.phase === 'playing', null, 'round start');
  check(true, 'round started');
  const cam = s.st.camera.position;
  console.log('camera at', cam, 'monster at', s.st.monster.position, 'mode', s.st.monster.mode);

  // stand next to the camera table, facing it (camera is at -X of the foyer)
  await teleport(page, cam.x + 0.9, cam.z, 90);
  await sleep(1500);
  await page.keyboard.press('e');
  s = await waitState(page, (s) => s.st.camera.holder === s.id, null, 'camera grabbed', 60000).catch((e) => (console.log(e.message), null));
  check(!!s, 'desktop E grabs the camera');

  if (s) {
    const film0 = s.st.camera.film;
    await page.mouse.click(320, 200);
    s = await waitState(page, (s, f) => s.st.camera.film === f - 1, film0, 'flash uses film', 60000).catch((e) => (console.log(e.message), null));
    check(!!s, 'click flashes the camera (film decremented)');
    await page.screenshot({ path: `${out}/a-flash.png` });
    await sleep(800);
    await page.screenshot({ path: `${out}/b-afterimage.png` });
  }

  // a hand sign
  await page.keyboard.down('2');
  await sleep(1500);
  await page.screenshot({ path: `${out}/c-sign-stop.png` });
  await page.keyboard.up('2');

  // monster should be moving over time
  const m0 = (await state(page)).st.monster.position;
  await sleep(8000);
  const s2 = await state(page);
  const moved = Math.hypot(s2.st.monster.position.x - m0.x, s2.st.monster.position.z - m0.z);
  console.log('monster moved', moved.toFixed(2), 'm, mode', s2.st.monster.mode, 'time', s2.st.time.toFixed(1));
  check(moved > 0.2, 'monster wanders');

  // menu
  await page.keyboard.press('Escape');
  await sleep(1500);
  const pauseVisible = await page.isVisible('text=Resume');
  check(pauseVisible, 'Esc opens the menu');
  await page.screenshot({ path: `${out}/d-menu.png` });
  await page.click('text=Leave game');
  await page.waitForSelector('text=Play solo', { state: 'visible' });
  check(true, 'leave returns to title');
  await page.close();

  // ------------------------------------------------------------ two tabs, local transport
  const host = await ctx.newPage();
  watch(host, 'host');
  await host.goto(base + '?net=local');
  await host.fill('#mute-name', 'Host');
  await host.click('text=Host a game');
  await host.waitForSelector('.code', { state: 'visible' });
  const code = (await host.textContent('.code')).trim();
  check(/^[A-Z0-9]{5}$/.test(code), `room code ${code}`);

  const guest = await ctx.newPage();
  watch(guest, 'guest');
  await guest.goto(base + '?net=local');
  await guest.fill('#mute-name', 'Guest');
  await guest.fill('input[placeholder="ROOM CODE"]', code);
  await guest.click('button:has-text("Join")');
  await guest.waitForSelector('text=Play on this screen', { state: 'visible' });
  await waitState(host, (s) => Object.keys(s.st.players).length === 2, null, 'host sees 2 players');
  check(true, 'host sees the guest');
  const hostNames = await host.$$eval('.players li', (els) => els.map((e) => e.textContent));
  const guestNames = await guest.$$eval('.players li', (els) => els.map((e) => e.textContent));
  console.log('lobby lists:', hostNames, guestNames);
  check(guestNames.length === 2, 'guest lobby lists both players');

  await host.click('text=Start round');
  await waitState(guest, (s) => s.st.phase === 'playing', null, 'guest gets round');
  check(true, 'guest receives the round start');
  await guest.click('text=Play on this screen');
  const g0 = await state(guest);
  const before = g0.st.players[g0.id].pose.head.position;
  // move the guest; the host should see the new pose
  await teleport(guest, before.x + 0.8, before.z - 1.2, 0);
  const hs = await waitState(host, (s, arg) => {
    const p = s.st.players[arg.id];
    return p && Math.hypot(p.pose.head.position.x - arg.x, p.pose.head.position.z - arg.z) < 0.3;
  }, { id: g0.id, x: before.x + 0.8, z: before.z - 1.2 }, 'host sees guest move', 60000).catch((e) => (console.log(e.message), null));
  check(!!hs, 'host receives guest pose');
  await sleep(1500);
  await host.screenshot({ path: `${out}/e-host-view.png` });
  await guest.screenshot({ path: `${out}/f-guest-view.png` });

  // guest leaves -> host drops them
  await guest.close();
  const h2 = await waitState(host, (s) => Object.keys(s.st.players).length === 1, null, 'host drops guest', 30000).catch((e) => (console.log(e.message), null));
  check(!!h2, 'host notices the guest leaving');

  await browser.close();
  console.log(`\n${failures} failures, ${errors.length} console errors`);
  for (const e of errors.slice(0, 30)) console.log(e);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('E2E CRASHED:', e);
  process.exit(2);
});
