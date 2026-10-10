// The review video for the monster sounds: one labelled card per sound (dev/sounds/out/mp3) with
// the sound under it, into dev/sounds/out/monster_sounds_review.mp4. Called by render.cjs.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
function loadPlaywright() {
  try { return require('playwright'); } catch {}
  return require(execSync('npm root -g').toString().trim() + '/playwright');
}

const OUT = path.join(__dirname, 'out');
const FONTS = path.join(__dirname, '..', 'trailer', 'fonts');
const W = 1280, H = 720;
const font = (family, file, style = 'normal') => {
  const p = path.join(FONTS, file);
  return fs.existsSync(p) ? `@font-face{font-family:'${family}';font-style:${style};src:url(data:font/woff2;base64,${fs.readFileSync(p).toString('base64')}) format('woff2');}` : '';
};
const CSS = `
${font('Cinzel', 'Cinzel-normal.woff2')}
${font('Cormorant', 'CormorantGaramond-normal.woff2')}
${font('Cormorant', 'CormorantGaramond-italic.woff2', 'italic')}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:radial-gradient(ellipse at 50% 45%,#16120f 0%,#090807 70%,#050404 100%);color:#ece6da}
.wrap{position:absolute;left:140px;right:140px;top:170px}
.cat{font:600 26px/1 'Cinzel',serif;letter-spacing:.4em;color:#c4362b}
.title{font:400 62px/1.15 'Cinzel',serif;letter-spacing:.06em;margin-top:22px}
.desc{font:italic 400 34px/1.4 'Cormorant',serif;color:#bdb4a5;margin-top:26px;max-width:940px}
.count{position:absolute;right:60px;bottom:44px;font:400 22px/1 'Cinzel',serif;letter-spacing:.2em;color:#6f675c}
.foot{position:absolute;left:60px;bottom:44px;font:400 22px/1 'Cinzel',serif;letter-spacing:.3em;color:#6f675c}
.meter{position:absolute;left:140px;top:586px;font:600 18px/1 'Cinzel',serif;letter-spacing:.35em;color:#857c6e}
.track{position:absolute;left:140px;width:1000px;top:614px;height:18px;background:#1d1915;border-radius:3px}
.stages{position:absolute;left:140px;width:1000px;top:600px;height:46px}
.stage{position:absolute;top:0;height:46px;border-left:2px solid #3a332c;padding-left:8px;font:400 18px/1.2 'Cormorant',serif;color:#9e9586;box-sizing:border-box}
.big{font:400 120px/1 'Cinzel',serif;letter-spacing:.4em;margin-left:.4em}
`;

/** The scene's stages (seconds), matching dev/sounds/monster.ts. */
const SCENE = [[0, 'It rests'], [8.4, 'You start walking'], [10.5, 'It listens'], [16, 'It hears you'], [18.4, 'The chase'], [21, 'The catch']];
const SCENE_DUR = 27;

function cardHtml(name, [cat, title, desc], i, n) {
  let extra = '';
  if (name === 'listening') extra = `<div class="meter">Your noise</div><div class="track"></div>`;
  if (name === 'scene') {
    extra = `<div class="stages">${SCENE.map(([t, label], k) => {
      const next = k + 1 < SCENE.length ? SCENE[k + 1][0] : SCENE_DUR;
      return `<div class="stage" style="left:${(t / SCENE_DUR) * 1000}px;width:${((next - t) / SCENE_DUR) * 1000}px">${label}</div>`;
    }).join('')}</div>`;
  }
  return `<div class="wrap"><div class="cat">${cat}</div><div class="title">${title}</div><div class="desc">${desc}</div></div>${extra}
    <div class="foot">MUTE · monster sounds</div><div class="count">${i} / ${n}</div>`;
}

function dur(file) {
  return Number(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${file}`).toString());
}

async function reel(names, INFO) {
  const dir = path.join(OUT, 'reel');
  fs.mkdirSync(dir, { recursive: true });
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const shot = async (html, file) => {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${html}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: file });
  };
  await shot(`<div class="wrap" style="top:230px;text-align:center;left:0;right:0"><div class="big">MUTE</div>
    <div class="desc" style="margin:34px auto 0">New monster sounds, for approval. Headphones on.</div></div>`, path.join(dir, 'intro.png'));
  const segs = [];
  const seg = (png, audio, seconds, vf = '') => {
    const out = path.join(dir, `seg${String(segs.length).padStart(2, '0')}.mp4`);
    const a = audio ? `-i ${audio}` : `-f lavfi -t ${seconds} -i anullsrc=r=48000:cl=stereo`;
    execSync(`ffmpeg -loglevel error -y -loop 1 -framerate 30 -i ${png} ${a} -filter_complex "[0:v]${vf ? vf + ',' : ''}format=yuv420p[v];[1:a]aresample=48000,aformat=channel_layouts=stereo,apad[a]" -map "[v]" -map "[a]" -t ${seconds.toFixed(2)} -r 30 -c:v libx264 -preset medium -tune stillimage -crf 24 -c:a aac -b:a 192k -ar 48000 ${out}`);
    segs.push(out);
  };
  seg(path.join(dir, 'intro.png'), null, 3.5);
  for (const [k, name] of names.entries()) {
    const png = path.join(dir, `${name}.png`);
    await shot(cardHtml(name, INFO[name], k + 1, names.length), png);
    const mp3 = path.join(OUT, 'mp3', `${name}.mp3`);
    const d = dur(mp3);
    let vf = '';
    // The noise meter fills with your footsteps (dev/sounds/monster.ts: 0.8 s .. 12.3 s).
    if (name === 'listening') vf = `drawbox=x=140:y=614:w='max(1,1000*min(1,max(0,(t-0.8)/11.5)))':h=18:color=0xc4362b@0.95:t=fill`;
    if (name === 'scene') vf = `drawbox=x='140+1000*t/${SCENE_DUR}':y=596:w=3:h=54:color=0xece6da@0.9:t=fill`;
    seg(png, mp3, d + 0.8, vf);
  }
  await browser.close();
  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, segs.map((f) => `file '${f}'`).join('\n'));
  const final = path.join(OUT, 'monster_sounds_review.mp4');
  execSync(`ffmpeg -loglevel error -y -f concat -safe 0 -i ${list} -c copy -movflags +faststart ${final}`);
  console.log('review video', final, dur(final).toFixed(1), 's');
}

module.exports = { reel };
