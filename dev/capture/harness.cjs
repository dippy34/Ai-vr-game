// Gameplay-footage harness: a solo round on the no-HMR dev server (port 5302) with a bot
// teammate ("Sam"), a directable monster, and one game frame (1/30 s of game time) per call.
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');

async function setup({ width = 960, height = 540, base = 'http://localhost:5302/' } = {}) {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog', '--disable-renderer-backgrounding'] });
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(400000);
  const logs = [];
  page.on('console', (m) => m.type() === 'error' && logs.push(`error: ${m.text().slice(0, 300)}`));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}\n${(e.stack || '').slice(0, 600)}`));
  // No WebAudio / mic: the AudioManager becomes a no-op (swiftshader boxes choke on the graph).
  await page.addInitScript(() => {
    delete window.AudioContext; delete window.webkitAudioContext;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('no mic'));
  });
  await page.goto(base);
  await page.click('text=Play solo');
  await page.waitForSelector('text=Start round', { state: 'visible' });
  await page.waitForFunction(() => !!window.__mute.renderer.monster.mixer && window.__mute.renderer.surfaces.loaded, null, { timeout: 380000 });
  await page.waitForTimeout(2500);
  // Sam joins in the lobby, then the round starts.
  await page.evaluate(() => window.__mute.game.current.sim.addPlayer('bot', 'Sam', false));
  await page.click('text=Start round');
  await page.waitForTimeout(1500);
  await page.evaluate(async () => {
    const m = window.__mute;
    const s = m.game.current;
    const sim = s.sim;
    const signs = await import('/src/platform/input/signs.ts');
    m.renderer.ctx.renderer.setAnimationLoop(null);
    window.__mic = 0;
    m.audio.getMicLevel = () => window.__mic;

    const qMul = (a, b) => ({
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    });
    const rot = (q, v) => {
      const p = qMul(qMul(q, { x: v.x, y: v.y, z: v.z, w: 0 }), { x: -q.x, y: -q.y, z: -q.z, w: q.w });
      return { x: p.x, y: p.y, z: p.z };
    };
    const yawPitch = (yaw, pitch) => qMul({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, { x: Math.sin(pitch / 2), y: 0, z: 0, w: Math.cos(pitch / 2) });
    const D = Math.PI / 180;
    const botPose = (b, t) => {
      const q = yawPitch(b.yaw * D, (b.pitch ?? 0) * D);
      const head = { position: { x: b.x, y: b.eye ?? 1.62, z: b.z }, rotation: q };
      const preset = b.sign ? signs.SIGN_PRESETS.find((p) => p.id === b.sign) : null;
      const hand = (h) => {
        const l = signs.desktopHandTarget(h, h === 'right' ? preset : null, t - (b.signStart ?? 0));
        const o = rot(q, l.position);
        return { tracked: true, position: { x: head.position.x + o.x, y: head.position.y + o.y, z: head.position.z + o.z }, rotation: qMul(q, l.rotation), curls: l.curls };
      };
      return { head, left: hand('left'), right: hand('right') };
    };

    // Monster brain on/off (frozen = it stands where it's put and ignores every sound).
    // Frozen = it stays wherever cmd.mon puts it, hears nothing, catches no one (sim test hook).
    window.__freeze = (on) => sim.setMonsterFrozen(on);
    window.__freeze(true);

    // Captions.
    const style = document.createElement('style');
    style.textContent = `
      #cap { position: fixed; left: 0; right: 0; bottom: 12%; text-align: center; z-index: 99; pointer-events: none;
             font: 600 28px/1.35 Georgia, 'Times New Roman', serif; color: #f1ece2; letter-spacing: .02em;
             text-shadow: 0 0 6px #000, 0 2px 3px #000; transition: none; padding: 0 8%; }
      #cap small { display: block; font: 500 18px/1.4 system-ui, sans-serif; color: #b9b2a6; letter-spacing: .04em; margin-top: 4px; }
      #card { position: fixed; inset: 0; z-index: 100; background: #000; display: none; align-items: center; justify-content: center;
              flex-direction: column; color: #eee; font-family: Georgia, serif; text-align: center; }
      #card h1 { font-size: 120px; letter-spacing: .55em; margin: 0 0 0 .55em; font-weight: 400; }
      #card p { font: 400 21px/1.6 system-ui, sans-serif; color: #aaa; margin: 14px 0 0; letter-spacing: .06em; }
      #fade { position: fixed; inset: 0; z-index: 98; background: #000; opacity: 0; pointer-events: none; }`;
    document.head.append(style);
    for (const id of ['cap', 'card', 'fade']) { const d = document.createElement('div'); d.id = id; document.body.append(d); }

    // HUD toasts on video time (their setTimeout would run on wall-clock time).
    const hud = m.ui.hud;
    let toastUntil = -1;
    let videoNow = 0;
    hud.showMessage = (text, seconds = 3) => {
      hud.toast.textContent = text;
      hud.toast.classList.add('show');
      toastUntil = videoNow + seconds * 1000;
    };
    let lastCap = null;
    let lastCard = null;
    window.__step = (cmd, nowMs) => {
      videoNow = nowMs;
      if (toastUntil >= 0 && nowMs >= toastUntil) { hud.toast.classList.remove('show'); toastUntil = -1; }
      const { rig, camera } = m.renderer.ctx;
      if (cmd.yaw !== undefined) rig.rotation.y = cmd.yaw * D;
      if (cmd.pitch !== undefined) m.input.pitch = cmd.pitch * D;
      if (cmd.x !== undefined) {
        rig.updateMatrixWorld(true);
        const head = camera.getWorldPosition(camera.position.clone());
        rig.position.x += cmd.x - head.x;
        rig.position.z += cmd.z - head.z;
      }
      if (cmd.use) m.input.pendingUse = true;
      if (cmd.trigger) m.input.pendingTrigger = true;
      if (cmd.sign !== undefined) {
        const preset = cmd.sign ? signs.SIGN_PRESETS.find((p) => p.id === cmd.sign) : null;
        m.input.sign = preset ? { preset, start: m.input.time, held: true } : null;
      }
      window.__mic = cmd.mic ?? 0;
      if (cmd.bot && s.state.players.bot) {
        const pose = botPose(cmd.bot, nowMs / 1000);
        sim.setPlayerPose('bot', pose);
        m.renderer.setRemotePose('bot', pose);
      }
      if (cmd.freeze !== undefined) window.__freeze(cmd.freeze);
      if (cmd.mon) {
        const mon = s.state.monster;
        const prevAct = mon.act;
        mon.position = { x: cmd.mon.x, y: cmd.mon.y ?? 0, z: cmd.mon.z };
        mon.yaw = cmd.mon.yaw * D;
        mon.alert = cmd.mon.alert ?? 0.7;
        mon.mode = cmd.mon.mode ?? 'wander';
        if (cmd.mon.speed !== undefined) mon.speed = cmd.mon.speed;
        if (cmd.mon.gait) mon.gait = cmd.mon.gait;
        if (cmd.mon.posture) mon.posture = cmd.mon.posture;
        if (cmd.mon.act) {
          mon.act = cmd.mon.act;
          if (cmd.mon.act !== prevAct) mon.actStart = s.state.time;
        }
        if (cmd.mon.focus !== undefined) mon.focus = cmd.mon.focus;
      }
      const cap = cmd.caption ?? '';
      if (cap !== lastCap) { document.getElementById('cap').innerHTML = cap; lastCap = cap; }
      const card = cmd.card ?? '';
      if (card !== lastCard) {
        const el = document.getElementById('card');
        el.innerHTML = card;
        el.style.display = card ? 'flex' : 'none';
        lastCard = card;
      }
      document.getElementById('cap').style.opacity = String(cmd.capAlpha ?? 1);
      document.getElementById('card').style.opacity = String(cmd.cardAlpha ?? 1);
      document.getElementById('fade').style.opacity = String(cmd.fade ?? 0);
      m.game.frame(nowMs);
      const me = s.state.players[s.localId];
      return { mode: s.state.monster.mode, mx: +s.state.monster.position.x.toFixed(2), mz: +s.state.monster.position.z.toFixed(2), status: me.status, light: me.light.on, charge: +me.light.charge.toFixed(2), winding: me.light.cranking, phase: s.state.phase };
    };
  });
  let now = await page.evaluate(() => performance.now());
  const FRAME_MS = 1000 / 30;
  async function step(cmd, file) {
    now += FRAME_MS;
    const info = await page.evaluate(([c, t]) => window.__step(c, t), [cmd, now]);
    if (file) await page.screenshot({ path: file, type: 'jpeg', quality: 92 });
    return info;
  }
  return { browser, page, logs, step };
}

module.exports = { setup };
