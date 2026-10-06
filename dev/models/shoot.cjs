// Screenshot a model in the three.js viewer (the real game renderer).
// usage: node dev/models/shoot.cjs <out.png> "<query string>"   e.g.  "model=monster&anim=Walk&t=0.3&mood=flash"
// Needs the dev server running: npx vite --port 5199 (from the repo root).
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
(async () => {
  const [out, query] = process.argv.slice(2);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 720, height: 720 } });
  const logs = [];
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(e.message));
  await page.goto(`http://localhost:5199/dev/models/?${query}`);
  await page.waitForFunction(() => window.__ready === true || document.getElementById('info').textContent.startsWith('failed'), null, { timeout: 60000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: out });
  console.log(JSON.stringify(await page.evaluate(() => window.__stats ?? document.getElementById('info').textContent)));
  if (logs.length) console.log('console:', logs.join('\n'));
  await browser.close();
})();
