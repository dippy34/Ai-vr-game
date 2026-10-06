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

/**
 * A spot ~0.6-1.2 m from `t` (XZ) where a player fits and sees `t` with no wall in between, plus the
 * yaw (deg) that faces it. Computed in the page from the live level data.
 */
const standSpot = (page, t) => page.evaluate((t) => {
  const L = window.__mute.game.current.level;
  const low = (b) => b.min.y < 2;
  const solid = L.boxes.filter((b) => (b.kind === 'wall' || b.kind === 'furniture') && low(b)).concat([L.exit.door]);
  const walls = L.boxes.filter((b) => b.kind === 'wall' && low(b)).concat([L.exit.door]);
  const clear = (x, z, r) => solid.every((b) => {
    const cx = Math.max(b.min.x, Math.min(x, b.max.x));
    const cz = Math.max(b.min.z, Math.min(z, b.max.z));
    return (x - cx) ** 2 + (z - cz) ** 2 > r * r;
  });
  const hits = (ax, az, bx, bz, b) => {
    let t0 = 0, t1 = 1;
    for (const [a, d, lo, hi] of [[ax, bx - ax, b.min.x, b.max.x], [az, bz - az, b.min.z, b.max.z]]) {
      if (Math.abs(d) < 1e-12) { if (a < lo || a > hi) return false; continue; }
      let ta = (lo - a) / d, tb = (hi - a) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
    return true;
  };
  for (const r of [0.6, 0.8, 1.0, 1.2]) {
    for (let a = 0; a < 24; a++) {
      const ang = (a / 24) * Math.PI * 2;
      const x = t.x + r * Math.cos(ang), z = t.z + r * Math.sin(ang);
      if (!clear(x, z, 0.4) || walls.some((b) => hits(x, z, t.x, t.z, b))) continue;
      return { x, z, yawDeg: (Math.atan2(-(t.x - x), -(t.z - z)) * 180) / Math.PI };
    }
  }
  return null;
}, t);

/** Wait until the monster is at least `d` m (XZ) from (x, z), so a teleport there is safe. */
async function monsterAway(page, x, z, d = 4) {
  await waitState(page, (s) => Math.hypot(s.st.monster.position.x - x, s.st.monster.position.z - z) >= d, null,
    'monster to move away', 60000).catch(() => {});
}

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
  // The fake capture device beeps, which the monster hears as a loud voice and charges at. Keep
  // our "voice" silent so the solo checks don't race a monster that is already on its way.
  await page.waitForFunction(() => !!window.__mute);
  await page.evaluate(() => { window.__mute.audio.getMicLevel = () => 0; });
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

  // monster should be moving over time (judged on sim time: at swiftshader frame rates a few
  // wall-clock seconds can be less than one of its wander pauses)
  const m0s = await state(page);
  const m0 = m0s.st.monster.position;
  const dist = (s) => Math.hypot(s.st.monster.position.x - m0.x, s.st.monster.position.z - m0.z);
  const s2 = await waitState(page, (s) => dist(s) > 0.2 || s.st.time - m0s.st.time > 12, null, 'monster to move', 120000)
    .catch(() => null) || (await state(page));
  const moved = dist(s2);
  console.log('monster moved', moved.toFixed(2), 'm, mode', s2.st.monster.mode, 'in', (s2.st.time - m0s.st.time).toFixed(1),
    's of sim time, phase', s2.st.phase);
  check(moved > 0.2 && s2.st.phase === 'playing', 'monster wanders (and has not caught the silent player)');

  // menu
  await page.keyboard.press('Escape');
  await sleep(1500);
  const pauseVisible = await page.isVisible('text=Resume');
  check(pauseVisible, 'Esc opens the menu');
  await page.screenshot({ path: `${out}/d-menu.png` });
  await page.click('text=Leave game');
  await page.waitForSelector('text=Play solo', { state: 'visible' });
  check(true, 'leave returns to title');

  // ------------------------------------------------------------ solo: a full round, start to escape
  await page.click('text=Play solo');
  await page.waitForSelector('text=Start round', { state: 'visible' });
  await page.click('text=Start round');
  s = await waitState(page, (s) => s.st.phase === 'playing' && s.st.fusesInserted === 0, null, 'second round start');
  const box = { x: 1.5, z: 7.3 }; // stand here facing +Z (yaw 180): both desktop hands are at the fuse box
  let inserted = 0;
  for (let k = 0; k < s.st.fusesRequired; k++) {
    s = await state(page);
    const fuse = s.st.items.find((i) => i.kind === 'fuse' && i.where === 'world');
    if (!fuse) break;
    const spot = await standSpot(page, fuse.position);
    if (!spot) { console.log('no spot next to fuse', fuse.position); break; }
    await monsterAway(page, spot.x, spot.z);
    await teleport(page, spot.x, spot.z, spot.yawDeg);
    await sleep(800);
    await page.keyboard.press('e');
    const held = await waitState(page, (s) => s.st.items.some((i) => i.kind === 'fuse' && i.where === 'held' && i.holder === s.id),
      null, 'fuse grabbed', 30000).catch((e) => (console.log(e.message, 'at', spot, 'fuse', fuse.position), null));
    if (!held) break;
    await monsterAway(page, box.x, box.z);
    await teleport(page, box.x, box.z, 180);
    const after = await waitState(page, (s, n) => s.st.fusesInserted > n, inserted, 'fuse inserted', 30000)
      .catch((e) => (console.log(e.message), null));
    if (!after) break;
    inserted = after.st.fusesInserted;
  }
  check(inserted === s.st.fusesRequired, `carried ${inserted}/${s.st.fusesRequired} fuses to the fuse box (E + walk)`);
  s = await state(page);
  check(s.st.exitOpen, 'all fuses open the exit');
  await teleport(page, 0, 9.0, 180);
  s = await waitState(page, (s) => s.st.phase !== 'playing', null, 'round end', 30000).catch((e) => (console.log(e.message), null));
  check(!!s && s.st.phase === 'won' && s.st.players[s.id].status === 'escaped', `walking out the open door wins (${s && s.st.phase})`);
  await page.screenshot({ path: `${out}/g-escaped.png` });
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
  // Esc in the lobby must not swap the lobby (room code, Enter VR) for the pause menu.
  await host.keyboard.press('Escape');
  await sleep(1200);
  check((await host.isVisible('.code')) && !(await host.isVisible('text=Resume')), 'Esc in the lobby keeps the lobby open');

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

  // a guest joins mid-round; then the host leaves -> the guest is back on the title with a message
  const guest2 = await ctx.newPage();
  watch(guest2, 'guest2');
  await guest2.goto(base + '?net=local');
  await guest2.fill('#mute-name', 'Late');
  await guest2.fill('input[placeholder="ROOM CODE"]', code);
  // Under heavy load the host tab can miss the local transport's 2 s join window: retry, but say why.
  let joined2 = false;
  for (let attempt = 0; attempt < 3 && !joined2; attempt++) {
    await guest2.click('button:has-text("Join")');
    joined2 = await guest2.waitForSelector('text=Play on this screen', { state: 'visible', timeout: 45000 }).then(() => true, () => false);
    if (!joined2) console.log('late join attempt failed:', JSON.stringify(await guest2.textContent('.screen:not([hidden]) .error').catch(() => '?')));
  }
  check(joined2, 'a guest can join a round in progress');
  const g2 = await waitState(guest2, (s) => s.st.phase === 'playing' && !!s.st.players[s.id], null, 'late guest in the round', 30000)
    .catch((e) => (console.log(e.message), null));
  check(!!g2 && g2.st.players[g2.id].status === 'alive', 'a guest joining mid-round is alive in the running round');
  await guest2.click('text=Play on this screen');
  await host.keyboard.press('Escape');
  await host.waitForSelector('text=Leave game', { state: 'visible' });
  const pauseText = (await host.textContent('.screen:not([hidden]) .panel')) || '';
  check(pauseText.includes(code), 'the pause menu shows the room code (for late invites)');
  await host.click('text=Leave game');
  const back = await guest2.waitForSelector('text=Play solo', { state: 'visible', timeout: 30000 }).then(() => true, () => false);
  const msg = back ? (await guest2.textContent('.screen:not([hidden]) .error')) || '' : '';
  check(back && /host/i.test(msg), `host leaving sends the guest back to the title ("${msg}")`);
  check((await state(guest2)) === null, 'the guest session is closed');

  await browser.close();
  console.log(`\n${failures} failures, ${errors.length} console errors`);
  for (const e of errors.slice(0, 30)) console.log(e);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('E2E CRASHED:', e);
  for (const err of errors.slice(0, 30)) console.log(err);
  process.exit(2);
});
