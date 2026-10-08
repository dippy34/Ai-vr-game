// MUTE trailer: edits the captured gameplay shots (dev/trailer/shots.cjs), the title cards
// (dev/trailer/cards.cjs) and the concept art (docs/concept/raw/*.png or docs/concept/*.jpg) into
// dev/trailer/out/mute_trailer.mp4, with a soundtrack rendered offline from the game's own sounds
// plus a score (dev/trailer/audio.ts, through the no-HMR capture server).
//
//   node dev/trailer/trailer.cjs            (needs the frames, the cards and the server on :5320)
//   node dev/trailer/trailer.cjs --audio    (soundtrack only)
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
function loadPlaywright() {
  try { return require('playwright'); } catch {}
  return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
}

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const SEG = path.join(OUT, 'segments');
const CARDS = path.join(OUT, 'cards');
const FPS = 30;
const W = 1920, H = 1080;
const PORT = process.env.PORT ?? 5320;

/** The game's look, graded for a trailer: lifted a touch, contrast, fine grain, a vignette. */
const GRADE = `scale=${W}:${H}:flags=lanczos,eq=brightness=0.025:contrast=1.1:gamma=1.22:saturation=0.92,vignette=angle=PI/4.6,noise=alls=3:allf=t`;
const STILL_GRADE = `eq=contrast=1.05:gamma=1.05:saturation=0.9,vignette=angle=PI/4.4,noise=alls=4:allf=t`;

const concept = (name) => {
  for (const p of [`docs/concept/raw/${name}.png`, `docs/concept/${name}.jpg`]) if (fs.existsSync(path.join(ROOT, p))) return path.join(ROOT, p);
  throw new Error(`no concept image ${name}`);
};
const frame = (shot, f) => path.join(OUT, shot, `f_${String(f).padStart(5, '0')}.jpg`);

// ---------------------------------------------------------------------------------------------
// The edit. Times are seconds on the trailer timeline; card times are relative to the segment.
// ---------------------------------------------------------------------------------------------
const EDIT = [
  { kind: 'black', dur: 3.2, cards: [{ id: 'cant_see', from: 0.4, to: 2.9 }] },
  { kind: 'shot', shot: 'hall', from: 0, to: 199, fadeIn: 0.25, cards: [{ id: 'hears', from: 3.4, to: 6.2 }] },
  { kind: 'black', dur: 0.25 },
  { kind: 'shot', shot: 'door', from: 20, to: 243, cards: [{ id: 'footstep', from: 0.9, to: 3.5 }] },
  { kind: 'shot', shot: 'climb', from: 10, to: 219, cards: [{ id: 'breath', from: 0.8, to: 3.4 }], fadeOut: 0.4 },
  { kind: 'black', dur: 3.5, cards: [{ id: 'voice', from: 0.3, to: 3.2 }] },
  { kind: 'shot', shot: 'hands', from: 0, to: 119, fadeIn: 0.3, cards: [{ id: 'hands', from: 0.5, to: 3.7 }] },
  { kind: 'shot', shot: 'wind', from: 0, to: 'jumpscare', cards: [{ id: 'dying', from: 0.3, to: 2.3 }, { id: 'loud', from: 2.6, to: 4.4 }] },
  { kind: 'black', dur: 1.3 },
  { kind: 'black', dur: 5.4, cards: [{ id: 'title', from: 0.05, to: 5.1, fade: 0.08 }] },
  { kind: 'black', dur: 3.2, cards: [{ id: 'story', from: 0.3, to: 2.9 }] },
  { kind: 'still', image: () => frame('door', 168), dur: 2.8, zoom: 0.05, cards: [{ id: 'ch1', from: 0.3, to: 2.6 }], grade: GRADE },
  { kind: 'still', image: () => concept('ch2_echo_halls_wide'), dur: 2.8, zoom: 0.06, cards: [{ id: 'ch2', from: 0.3, to: 2.6 }] },
  { kind: 'still', image: () => concept('ch3_nest_den'), dur: 2.8, zoom: 0.06, cards: [{ id: 'ch3', from: 0.3, to: 2.6 }] },
  { kind: 'still', image: () => concept('ch4_quiet_room_vault'), dur: 2.8, zoom: 0.06, cards: [{ id: 'ch4', from: 0.3, to: 2.6 }] },
  { kind: 'still', image: () => concept('ch4_quiet_room_boss'), dur: 2.8, zoom: 0.08, cards: [{ id: 'boss', from: 0.4, to: 2.6 }] },
  { kind: 'black', dur: 4.2, cards: [{ id: 'features', from: 0.3, to: 3.9 }] },
  { kind: 'black', dur: 6.5, cards: [{ id: 'end', from: 0.4, to: 6.5, fadeOutDur: 0 }] },
];

/** Wind shot: the cut lands on the frame where the jumpscare has gone to black. */
function jumpscareCut() {
  const dir = path.join(OUT, 'wind');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort() : [];
  if (files.length < 240) return 262; // not captured yet (audio-only runs): a typical cut
  // Mean luma of each frame after the run starts; the first nearly black one (after a bright
  // jumpscare frame) is where the game cuts to black.
  let lit = false;
  for (let i = 200; i < files.length; i++) {
    const y = Number(execSync(`ffmpeg -loglevel error -i ${path.join(dir, files[i])} -vf scale=64:36,format=gray -f rawvideo - | od -An -tu1 -v | awk '{for(i=1;i<=NF;i++){s+=$i;n++}} END{print s/n}'`).toString());
    if (y > 30) lit = true;
    if (lit && y < 4) return i;
  }
  return files.length - 1;
}

function segDur(s) {
  if (s.kind === 'shot') return (s.toFrame - s.from + 1) / FPS;
  return s.dur;
}

// ---------------------------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------------------------

function cardFilters(cards, inputOffset, dur) {
  // Each card: fade its alpha in and out, overlay on the running stream [v].
  const parts = [];
  cards.forEach((c, i) => {
    const fade = c.fade ?? 0.5;
    const outDur = c.fadeOutDur ?? fade;
    const outAt = Math.min(c.to, dur) - outDur;
    let chain = `[${inputOffset + i}:v]format=rgba,fade=t=in:st=${c.from}:d=${fade}:alpha=1`;
    if (outDur > 0) chain += `,fade=t=out:st=${outAt.toFixed(3)}:d=${outDur}:alpha=1`;
    parts.push(`${chain}[c${i}]`);
    parts.push(`[v${i}][c${i}]overlay=0:0:enable='between(t,${c.from},${c.to})'[v${i + 1}]`);
  });
  return parts;
}

function encodeSegment(s, i) {
  const out = path.join(SEG, `s${String(i).padStart(2, '0')}.mp4`);
  const dur = segDur(s);
  const inputs = [];
  let base;
  if (s.kind === 'black') {
    inputs.push(`-f lavfi -t ${dur} -i color=c=black:s=${W}x${H}:r=${FPS}`);
    base = '[0:v]format=yuv420p[v0]';
  } else if (s.kind === 'shot') {
    const n = s.toFrame - s.from + 1;
    inputs.push(`-framerate ${FPS} -start_number ${s.from} -i ${path.join(OUT, s.shot, 'f_%05d.jpg')}`);
    let f = `[0:v]trim=end_frame=${n},${GRADE}`;
    if (s.fadeIn) f += `,fade=t=in:st=0:d=${s.fadeIn}`;
    if (s.fadeOut) f += `,fade=t=out:st=${(dur - s.fadeOut).toFixed(3)}:d=${s.fadeOut}`;
    base = `${f},format=yuv420p[v0]`;
  } else {
    const img = s.image();
    const frames = Math.round(dur * FPS);
    inputs.push(`-loop 1 -framerate ${FPS} -t ${dur} -i ${img}`);
    // Slow push-in (Ken Burns) on a 2x upscale, so the zoom is smooth.
    const z = s.zoom ?? 0.05;
    base = `[0:v]scale=${W * 2}:${H * 2}:flags=lanczos,zoompan=z='1+${z}*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},${s.grade ?? STILL_GRADE},fade=t=in:st=0:d=0.35,fade=t=out:st=${(dur - 0.35).toFixed(3)}:d=0.35,format=yuv420p[v0]`;
  }
  const cards = s.cards ?? [];
  for (const c of cards) inputs.push(`-loop 1 -framerate ${FPS} -t ${dur} -i ${path.join(CARDS, `${c.id}.png`)}`);
  const graph = [base, ...cardFilters(cards, 1, dur)].join(';');
  const last = `[v${cards.length}]`;
  fs.writeFileSync(`${out}.filter`, graph);
  execSync(`ffmpeg -loglevel error -y ${inputs.join(' ')} -filter_complex_script ${out}.filter -map "${last}" -t ${dur} -r ${FPS} -c:v libx264 -preset medium -crf 19 -pix_fmt yuv420p ${out}`, { stdio: 'inherit' });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Audio: cues on the trailer timeline
// ---------------------------------------------------------------------------------------------

function cues(starts) {
  const at = (segIndex, t) => starts[segIndex] + t;
  const C = [];
  const total = starts[starts.length - 1];
  // A low bed under almost everything, ducked for the silences.
  C.push({ t: 0, k: 'drone', dur: at(8, 0.2), freq: 41.2, gain: 0.045, attack: 3, release: 0.3 });
  C.push({ t: at(9, 0), k: 'drone', dur: total - at(9, 0), freq: 36.7, gain: 0.05, attack: 1.5, release: 4 });
  // 1. "It can't see you." A creak in the dark.
  C.push({ t: 1.6, k: 'sfx', fn: 'sfxWoodStep', args: [0.25, 1], pos: [1.5, 0, -2] });
  // 2. Hallway: the light clicks on; it turns to listen.
  C.push({ t: at(1, 0.9), k: 'sfx', fn: 'sfxLightSwitch', args: [true], pos: [0.15, -0.2, -0.3], gain: 1.6 });
  C.push({ t: at(1, 3.6), k: 'sfx', fn: 'sfxMonsterClicks', pos: [0, 0.6, -4.5], gain: 1.4 });
  C.push({ t: at(1, 4.2), k: 'tone', dur: 3.0, freq: 1840, gain: 0.018 });
  C.push({ t: at(1, 5.6), k: 'riser', dur: 1.05, gain: 0.25 });
  C.push({ t: at(2, 0), k: 'hit', gain: 0.85 });
  // 3. Door: heavy steps coming closer, then a sniff right in front of you.
  C.push({ t: at(3, 0), k: 'steps', dur: 5.0, every: 0.62, from: [-1.5, 0, -5], to: [-0.5, 0, -1.6], weight: 0.85, gain: 1.3 });
  C.push({ t: at(3, (184 - 20) / FPS), k: 'sfx', fn: 'sfxSniff', pos: [0, 0.3, -1.2], gain: 1.5 });
  C.push({ t: at(3, 0.5), k: 'heart', dur: 7, bpm0: 62, bpm1: 88, gain: 0.55 });
  // 4. Climb: crawling, a claw scrape on the table.
  C.push({ t: at(4, 0.8), k: 'sfx', fn: 'sfxMonsterCrawl', args: [true], pos: [0.5, 0, -2.5], gain: 1.3 });
  C.push({ t: at(4, 2.0), k: 'sfx', fn: 'sfxMonsterCrawl', args: [true], pos: [0, 0, -2.4], gain: 1.3 });
  C.push({ t: at(4, 3.1), k: 'sfx', fn: 'sfxClawScrape', pos: [-0.5, 0, -2.3], gain: 1.3 });
  C.push({ t: at(4, 4.3), k: 'sfx', fn: 'sfxMonsterCrawl', args: [false], pos: [-1, 0, -2.5], gain: 1.2 });
  C.push({ t: at(4, 1.0), k: 'heart', dur: 5.5, bpm0: 88, bpm1: 104, gain: 0.6 });
  // 5. "Even your real voice." Near silence, a held breath.
  C.push({ t: at(5, 0.2), k: 'sfx', fn: 'sfxHiss', pos: [3, 1.2, -6], gain: 0.5 });
  // 6. Hands: quiet, a few ticks of the house.
  C.push({ t: at(6, 0.5), k: 'sfx', fn: 'sfxTicks', pos: [2, 1.5, -3], gain: 0.6 });
  // 7. Wind: the light browns out, you wind it (the ratchet), it hears you and comes.
  C.push({ t: at(7, 2.4), k: 'crank', dur: 2.2, gain: 1.6 });
  C.push({ t: at(7, 3.9), k: 'sfx', fn: 'sfxMonsterClicks', pos: [0, 0.8, -7], gain: 1.3 });
  C.push({ t: at(7, 4.6), k: 'sfx', fn: 'sfxShriek', args: [1], pos: [0, 1.4, -6], gain: 1.2 });
  C.push({ t: at(7, 4.8), k: 'steps', dur: 2.4, every: 0.28, from: [0, 0, -6.5], to: [0, 0, -1], weight: 1, gain: 1.4 });
  C.push({ t: at(7, 4.4), k: 'heart', dur: 3.2, bpm0: 120, bpm1: 150, gain: 0.8 });
  C.push({ t: at(7, 4.5), k: 'riser', dur: 2.6, gain: 0.35 });
  // The catch: the game's own sting, cut to silence.
  C.push({ t: at(7, segDurs[7] - 1.15), k: 'sfx', fn: 'sfxCaughtSting', gain: 1.1 });
  C.push({ t: at(7, segDurs[7] - 1.15), k: 'hit', gain: 1.0 });
  // 8. Title.
  C.push({ t: at(9, 0.05), k: 'braam', dur: 4.6, gain: 0.55, freq: 49 });
  C.push({ t: at(9, 0.05), k: 'hit', gain: 0.8 });
  // 9. Montage pulses.
  for (let i = 11; i <= 15; i++) C.push({ t: at(i, 0.02), k: 'braam', dur: 2.2, gain: 0.22, freq: i % 2 ? 55 : 49 });
  C.push({ t: at(15, 0.3), k: 'sfx', fn: 'sfxShriek', args: [0.7], pos: [0, 2, -9], gain: 0.7 });
  // 10. End: one last ratchet in the dark, then a final hit on the card.
  C.push({ t: at(16, 1.0), k: 'crank', dur: 0.6, gain: 0.8 });
  C.push({ t: at(17, 0.35), k: 'braam', dur: 5.5, gain: 0.45, freq: 41 });
  C.push({ t: at(17, 0.35), k: 'hit', gain: 0.7 });
  return C;
}

let segDurs = [];

async function renderAudio(starts, file) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('audio page error:', e.message));
  await page.goto(`http://localhost:${PORT}/dev/trailer/audio.html`);
  await page.waitForFunction(() => !!window.__renderTrailerAudio, null, { timeout: 120000 });
  const total = starts[starts.length - 1];
  const b64 = await page.evaluate(([c, d]) => window.__renderTrailerAudio(c, d), [cues(starts), total]);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  await browser.close();
  console.log('audio', file, total.toFixed(1), 's');
}

(async () => {
  fs.mkdirSync(SEG, { recursive: true });
  for (const s of EDIT) if (s.kind === 'shot') s.toFrame = s.to === 'jumpscare' ? jumpscareCut() : s.to;
  segDurs = EDIT.map(segDur);
  const starts = [0];
  for (const d of segDurs) starts.push(starts[starts.length - 1] + d);
  console.log('segments', segDurs.map((d) => d.toFixed(2)).join(' '), 'total', starts[starts.length - 1].toFixed(2));
  const wav = path.join(OUT, 'trailer_audio.wav');
  await renderAudio(starts, wav);
  if (process.argv.includes('--audio')) return;
  // --preview N: only the first N segments (a rough cut while shots are still being captured).
  const pi = process.argv.indexOf('--preview');
  const upto = pi >= 0 ? Number(process.argv[pi + 1]) : EDIT.length;
  const files = EDIT.slice(0, upto).map((s, i) => {
    console.log('segment', i, s.kind, s.shot ?? s.cards?.[0]?.id ?? '');
    return encodeSegment(s, i);
  });
  const list = path.join(SEG, 'list.txt');
  fs.writeFileSync(list, files.map((f) => `file '${f}'`).join('\n'));
  const video = path.join(SEG, 'video.mp4');
  execSync(`ffmpeg -loglevel error -y -f concat -safe 0 -i ${list} -c copy ${video}`, { stdio: 'inherit' });
  const final = path.join(OUT, upto < EDIT.length ? 'mute_trailer_preview.mp4' : 'mute_trailer.mp4');
  execSync(`ffmpeg -loglevel error -y -i ${video} -i ${wav} -map 0:v -map 1:a -c:v copy -c:a aac -b:a 256k -shortest -movflags +faststart ${final}`, { stdio: 'inherit' });
  console.log(execSync(`ffprobe -v error -show_entries format=duration,size -of default=nw=1 ${final}`).toString());
})();
