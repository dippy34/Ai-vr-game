// Trailer title cards: HTML/CSS rendered by headless Chromium into transparent 1920x1080 PNGs
// (dev/trailer/out/cards/<id>.png), overlaid by dev/trailer/trailer.cjs.
//   sh dev/trailer/fonts.sh && node dev/trailer/cards.cjs
const fs = require('fs');
const path = require('path');
function loadPlaywright() {
  try { return require('playwright'); } catch {}
  return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
}

const FONTS = path.join(__dirname, 'fonts');
const OUT = path.join(__dirname, 'out', 'cards');
const font = (family, file, style = 'normal', weight = '100 900') =>
  `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};src:url(data:font/woff2;base64,${fs.readFileSync(path.join(FONTS, file)).toString('base64')}) format('woff2');}`;

const CSS = `
${font('Cinzel', 'Cinzel-normal.woff2')}
${font('Special Elite', 'SpecialElite-normal.woff2', 'normal', '400')}
${font('Cormorant', 'CormorantGaramond-normal.woff2', 'normal', '400')}
${font('Cormorant', 'CormorantGaramond-italic.woff2', 'italic', '400')}
html,body{margin:0;width:1920px;height:1080px;background:transparent;overflow:hidden}
.card{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#ece6da;text-align:center}
.card.black{background:#000}
.card.low{justify-content:flex-end;padding-bottom:150px;box-sizing:border-box}
.card.top{justify-content:flex-start;padding-top:70px;box-sizing:border-box;background:linear-gradient(180deg,rgba(0,0,0,.75),rgba(0,0,0,0) 28%)}
.card.tag{align-items:flex-start;justify-content:flex-start;padding:64px 0 0 84px;box-sizing:border-box;text-align:left}
.tagtop{font:600 30px/1 'Cinzel',serif;letter-spacing:.32em;color:#d2453a;text-shadow:0 0 10px #000,0 2px 3px #000}
.tagsub{font:400 30px/1.3 Arial,sans-serif;color:#e0d8ca;margin-top:14px;letter-spacing:.02em;text-shadow:0 0 10px #000}
.card.left{align-items:flex-start;justify-content:flex-end;padding:0 0 100px 140px;box-sizing:border-box;text-align:left;background:linear-gradient(0deg,rgba(0,0,0,.72),rgba(0,0,0,0) 45%)}
.line{font:400 58px/1.25 Arial,sans-serif;letter-spacing:.01em;text-shadow:0 0 18px #000,0 0 6px #000,0 3px 4px #000}
.small{font:400 italic 40px/1.4 'Cormorant',serif;color:#b9b0a2;margin-top:22px;letter-spacing:.02em;text-shadow:0 0 10px #000}
.red{color:#c4362b}
.title{font:400 300px/1 'Cinzel',serif;letter-spacing:.42em;margin-left:.42em;color:#f2ede4;text-shadow:0 0 40px rgba(0,0,0,.9)}
.rule{width:820px;height:2px;margin:46px 0 34px;background:linear-gradient(90deg,transparent,#8a1d16 20%,#c4362b 50%,#8a1d16 80%,transparent)}
.tag{font:400 italic 54px/1.2 'Cormorant',serif;color:#cfc6b6;letter-spacing:.04em}
.chap{font:600 46px/1 'Cinzel',serif;letter-spacing:.45em;color:#d2453a;text-shadow:0 0 10px #000,0 2px 3px #000}
.chapname{font:400 92px/1.1 'Cinzel',serif;letter-spacing:.18em;margin-top:18px;text-shadow:0 0 24px #000,0 3px 6px #000}
.status{font:400 40px/1.3 Arial,sans-serif;color:#ece6da;margin-top:34px;letter-spacing:.02em}
.concept{font:400 32px/1.3 Arial,sans-serif;color:#ece6da;margin-top:22px;letter-spacing:.04em;text-shadow:0 0 12px #000,0 2px 4px #000}
.feat{font:400 64px/1.7 'Cinzel',serif;letter-spacing:.14em}
.feat .dot{color:#c4362b;margin:0 .35em}
.endtitle{font:400 170px/1 'Cinzel',serif;letter-spacing:.42em;margin-left:.42em}
`;

const CARDS = {
  // Part 1: captured prologue gameplay, with fewer, direct captions.
  tag_real: `<div class="card tag"><div class="tagtop">Prologue · The Hale House</div><div class="tagsub">Gameplay · Work in progress</div></div>`,
  sound: `<div class="card low"><div class="line">It hunts by sound.</div></div>`,
  voice: `<div class="card low"><div class="line">Your mic can give you away.</div></div>`,
  hands: `<div class="card low"><div class="line">Use hand signals.</div></div>`,
  wind: `<div class="card low"><div class="line">Winding the light makes noise.</div></div>`,
  title: `<div class="card black"><div class="title">MUTE</div></div>`,
  // Part 2: chapter status. These are concepts, not completed levels.
  story: `<div class="card black"><div class="chap">Chapter 1</div><div class="chapname">Halcyon Acoustics</div><div class="status">Still in development</div></div>`,
  ch2: `<div class="card left"><div class="chap">Chapter 2</div><div class="chapname">The Echo Halls</div><div class="concept">Concept art · Not built yet</div></div>`,
  ch3: `<div class="card left"><div class="chap">Chapter 3</div><div class="chapname">The Nest</div><div class="concept">Concept art · Not built yet</div></div>`,
  ch4: `<div class="card left"><div class="chap">Chapter 4</div><div class="chapname">The Quiet Room</div><div class="concept">Concept art · Not built yet</div></div>`,
  features: `<div class="card black"><div class="feat">1–4 players<span class="dot">·</span>co-op</div><div class="feat">Meta Quest VR</div></div>`,
  end: `<div class="card black"><div class="endtitle">MUTE</div><div class="status">Chapter 1 in development</div></div>`,
};

(async () => {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const only = process.argv.slice(2);
  for (const [id, html] of Object.entries(CARDS)) {
    if (only.length && !only.includes(id)) continue;
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${html}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(OUT, `${id}.png`), omitBackground: true });
    console.log('card', id);
  }
  await browser.close();
})();
