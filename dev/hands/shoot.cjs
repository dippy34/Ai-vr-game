// Screenshot the hand sign test page (or the avatar page).
// usage: node dev/hands/shoot.cjs <out.png> ["<query>"] [w] [h] [page]   page: '' (hands) | 'avatar.html'
// Needs the dev server: npx vite --port 5199 (repo root).
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
(async () => {
  const [out, query = '', w = '1280', h = '960', pg = ''] = process.argv.slice(2);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
  const logs = [];
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(e.message));
  await page.goto(`http://localhost:5199/dev/hands/${pg}?${query}`);
  await page.waitForFunction(() => window.__ready === true || document.getElementById('info').textContent.startsWith('failed'), null, { timeout: 90000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: out });
  console.log(JSON.stringify(await page.evaluate(() => window.__stats ?? document.getElementById('info').textContent)).slice(0, 400));
  if (logs.length) console.log('console:', logs.join('\n'));
  await browser.close();
})();
