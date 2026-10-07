// In-browser cost of the monster's update (procedural body + writing the bones), timed over
// batches (headless Chromium coarsens performance.now() to 0.1 ms per call).
//   node dev/anim/bench.cjs        (server from dev/anim/serve.sh on :5320)
const { setup } = require('../capture/harness.cjs');

(async () => {
  const { browser, page } = await setup({ width: 320, height: 180, base: `http://localhost:${process.env.PORT ?? 5320}/` });
  const r = await page.evaluate(() => {
    const mon = window.__mute.renderer.monster;
    const base = window.__mute.game.current.state.monster;
    const s = JSON.parse(JSON.stringify(base));
    const run = (n, t0) => {
      for (let i = 0; i < n; i++) {
        const t = (t0 + i) / 60;
        // Wander a loop through the living room and hallway door, with turns and stops.
        const k = (t % 24) / 24;
        const a = k * Math.PI * 2;
        s.position = { x: -6.45 + Math.sin(a) * 1.8, y: 0, z: 2.2 + Math.cos(a * 2) * 2.4 };
        s.yaw = Math.atan2(-Math.cos(a), Math.sin(a * 2) * 2.6);
        s.speed = 1;
        s.gait = 'walk';
        mon.update(s, 1 / 60);
      }
    };
    run(600, 0); // warm up the JIT
    const out = [];
    for (let b = 0; b < 10; b++) {
      const t0 = performance.now();
      run(300, 600 + b * 300);
      out.push((performance.now() - t0) / 300);
    }
    out.sort((x, y) => x - y);
    return { median: out[5], best: out[0], worst: out[9] };
  });
  console.log(`monster.update in Chromium (swiftshader box): median ${r.median.toFixed(4)} ms, best ${r.best.toFixed(4)}, worst ${r.worst.toFixed(4)} (batches of 300)`);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
