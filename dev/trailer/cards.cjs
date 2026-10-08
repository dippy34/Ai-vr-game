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
.card.left{align-items:flex-start;justify-content:flex-end;padding:0 0 120px 140px;box-sizing:border-box;text-align:left}
.line{font:400 66px/1.25 'Special Elite',monospace;letter-spacing:.01em;text-shadow:0 0 18px #000,0 0 6px #000,0 3px 4px #000}
.small{font:400 italic 40px/1.4 'Cormorant',serif;color:#b9b0a2;margin-top:22px;letter-spacing:.02em;text-shadow:0 0 10px #000}
.red{color:#c4362b}
.title{font:400 300px/1 'Cinzel',serif;letter-spacing:.42em;margin-left:.42em;color:#f2ede4;text-shadow:0 0 40px rgba(0,0,0,.9)}
.rule{width:820px;height:2px;margin:46px 0 34px;background:linear-gradient(90deg,transparent,#8a1d16 20%,#c4362b 50%,#8a1d16 80%,transparent)}
.tag{font:400 italic 54px/1.2 'Cormorant',serif;color:#cfc6b6;letter-spacing:.04em}
.chap{font:600 46px/1 'Cinzel',serif;letter-spacing:.45em;color:#d2453a;text-shadow:0 0 10px #000,0 2px 3px #000}
.chapname{font:400 92px/1.1 'Cinzel',serif;letter-spacing:.18em;margin-top:18px;text-shadow:0 0 24px #000,0 3px 6px #000}
.feat{font:400 64px/1.7 'Cinzel',serif;letter-spacing:.14em}
.feat .dot{color:#c4362b;margin:0 .35em}
.endtitle{font:400 170px/1 'Cinzel',serif;letter-spacing:.42em;margin-left:.42em}
.cta{font:600 52px/1 'Cinzel',serif;letter-spacing:.32em;color:#c4362b;margin-top:44px}
.url{font:400 46px/1.3 'Special Elite',monospace;margin-top:56px;color:#ece6da}
.urlsub{font:400 italic 38px/1.3 'Cormorant',serif;color:#9e9586;margin-top:10px}
.foot{font:400 30px/1 'Cinzel',serif;letter-spacing:.3em;color:#857c6e;margin-top:70px}
`;

const CARDS = {
  cant_see: `<div class="card black"><div class="line">It can't see you.</div></div>`,
  hears: `<div class="card low"><div class="line">But it hears <span class="red">everything.</span></div></div>`,
  footstep: `<div class="card low"><div class="line">Every footstep.</div></div>`,
  breath: `<div class="card low"><div class="line">Every breath.</div></div>`,
  voice: `<div class="card black"><div class="line">Even your <span class="red">real voice.</span></div><div class="small">MUTE listens to your microphone.</div></div>`,
  hands: `<div class="card low"><div class="line">So you talk with your hands.</div></div>`,
  dying: `<div class="card low"><div class="line">Your only light is dying.</div></div>`,
  loud: `<div class="card low"><div class="line">Winding it is <span class="red">loud.</span></div></div>`,
  title: `<div class="card black"><div class="title">MUTE</div><div class="rule"></div><div class="tag">Don't make a sound.</div></div>`,
  story: `<div class="card black"><div class="line">Hollow Creek, 1996.</div><div class="small">Something got out of Halcyon Acoustics.</div></div>`,
  ch1: `<div class="card left"><div class="chap">Hollow Creek</div><div class="chapname">The Hale House</div></div>`,
  ch2: `<div class="card left"><div class="chap">Halcyon Acoustics</div><div class="chapname">The Echo Halls</div></div>`,
  ch3: `<div class="card left"><div class="chap">Halcyon Acoustics</div><div class="chapname">The Nest</div></div>`,
  ch4: `<div class="card left"><div class="chap">Halcyon Acoustics</div><div class="chapname">The Quiet Room</div></div>`,
  boss: `<div class="card low"><div class="line">Or make it <span class="red">scream.</span></div></div>`,
  features: `<div class="card black"><div class="feat">1–4 players<span class="dot">·</span>co-op</div><div class="feat">Meta Quest VR<span class="dot">·</span>PC</div><div class="feat">Plays in your browser</div></div>`,
  end: `<div class="card black"><div class="endtitle">MUTE</div><div class="cta">Coming to Kickstarter</div><div class="url">dippy34.github.io/Ai-vr-game</div><div class="urlsub">Play the free demo now.</div></div>`,
};

(async () => {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
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
