// MUTE trailer: edits the captured gameplay shots (dev/trailer/shots.cjs), the title cards
// (dev/trailer/cards.cjs) and location art (docs/concept/raw/*.png or docs/concept/*.jpg) into
// dev/trailer/out/mute_trailer.mp4 (+ a smaller mute_trailer_web.mp4), with a soundtrack rendered
// offline from the game's own sounds plus a score (dev/trailer/audio.ts, through the no-HMR
// capture server).
//
// Two parts, on the owner's call: first the real game, straight away (no black cards between the
// shots), then the title, the Lab's development status and future location concepts. Every concept
// image says "Soon to come / Concept preview"; there are no campaign or demo calls to action.
//
//   node dev/trailer/trailer.cjs            (needs the frames, the cards and the server on :5320)
//   node dev/trailer/trailer.cjs --audio    (soundtrack only)
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
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
const MATTE = 72;
const MATTE_FILTER = `drawbox=x=0:y=0:w=iw:h=${MATTE}:color=black:t=fill,drawbox=x=0:y=ih-${MATTE}:w=iw:h=${MATTE}:color=black:t=fill`;
const PORT = process.env.PORT ?? 5320;
const COLOR_TAGS = 'h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1';

/** The game's look, graded for a trailer: lifted a touch, contrast, fine grain, a vignette. */
const GRADE = `scale=${W}:${H}:flags=lanczos,eq=brightness=0.025:contrast=1.1:gamma=1.22:saturation=0.92,vignette=angle=PI/4.6,noise=alls=3:allf=t`;
const STILL_GRADE = `eq=contrast=1.05:gamma=1.05:saturation=0.9,vignette=angle=PI/4.4,noise=alls=4:allf=t`;

/** A location picture: the full-HD render if there is one, else the 960x540 preview. */
const art = (name) => () => {
  for (const p of [`docs/concept/raw/${name}.png`, `docs/concept/${name}.jpg`]) if (fs.existsSync(path.join(ROOT, p))) return path.join(ROOT, p);
  throw new Error(`no location image ${name}`);
};
const frame = (shot, f) => path.join(OUT, shot, `f_${String(f).padStart(5, '0')}.jpg`);

// ---------------------------------------------------------------------------------------------
// The edit. Times are seconds on the trailer timeline; card times are relative to the segment.
// ---------------------------------------------------------------------------------------------
const EDIT = [
  // Part 1: the real game, straight away.
  { name: 'rush', kind: 'shot', shot: 'rush', from: 10, to: 72, fadeIn: 0.1, camera: [1.03, 1.09, 0.5, 0.38] },
  { name: 'hall', kind: 'shot', shot: 'hall', from: 24, to: 130, camera: [1.01, 1.055, 0.5, 0.35], cards: [{ id: 'tag_real', from: 0.1, to: 3.56, fade: 0.2 }, { id: 'sound', from: 1.0, to: 3.56, fade: 0.2, rise: 22 }] },
  { name: 'cut1', kind: 'black', dur: 0.13 },
  { name: 'door', kind: 'shot', shot: 'door', from: 40, to: 174, camera: [1.02, 1.08, 0.47, 0.35] },
  { name: 'climb', kind: 'shot', shot: 'climb', from: 38, to: 174, camera: [1.035, 1.11, 0.48, 0.4], cards: [{ id: 'voice', from: 1.6, to: 4.56, fade: 0.2, rise: 22 }] },
  { name: 'cut2', kind: 'black', dur: 0.1 },
  { name: 'hands', kind: 'shot', shot: 'hands', from: 12, to: 95, camera: [1.04, 1.075, 0.5, 0.44], cards: [{ id: 'hands', from: 0.25, to: 2.8, fade: 0.2, rise: 18 }] },
  { name: 'wind', kind: 'shot', shot: 'wind', from: 45, to: 209, camera: [1, 1.065, 0.5, 0.35], cards: [{ id: 'wind', from: 2.4, to: 4.0, fade: 0.12, rise: 18 }] },
  // Cut on the sting to the framed face, then let the real fade to black finish.
  { name: 'catch', kind: 'shot', shot: 'wind', from: 211, to: 'jumpscare' },
  { name: 'after', kind: 'black', dur: 0.6 },
  { name: 'title', kind: 'black', dur: 2.6, cards: [{ id: 'title', from: 0.05, to: 2.45, fade: 0.08, slam: 0.07 }] },
  // Part 2: plain place names; related images overlap by six frames instead of dipping to black.
  { name: 'story', kind: 'black', dur: 2.4, cards: [{ id: 'story', from: 0.15, to: 2.35, fade: 0.18, rise: 20 }] },
  { name: 'echo', kind: 'still', image: art('ch2_echo_halls_wide'), dur: 2, camera: [1.02, 1.09, 0.32, 0.42], fadeIn: 0.12, cards: [{ id: 'echo', from: 0, to: 2, fade: 0, fadeOutDur: 0, rise: 18 }] },
  { name: 'echo_chase', kind: 'still', image: art('ch2_echo_halls_chase'), dur: 1.7, overlap: 0.2, camera: [1.08, 1.13, 0.55, 0.35], fadeOut: 0.1, cards: [{ id: 'echo', from: 0, to: 1.7, fade: 0, fadeOutDur: 0 }] },
  { name: 'nest', kind: 'still', image: art('ch3_nest_tunnel'), dur: 2, camera: [1.04, 1.12, 0.52, 0.4], fadeIn: 0.12, cards: [{ id: 'nest', from: 0, to: 2, fade: 0, fadeOutDur: 0, rise: 18 }] },
  { name: 'nest_den', kind: 'still', image: art('ch3_nest_den'), dur: 1.7, overlap: 0.2, camera: [1.1, 1.035, 0.62, 0.48], fadeOut: 0.1, cards: [{ id: 'nest', from: 0, to: 1.7, fade: 0, fadeOutDur: 0 }] },
  { name: 'quiet', kind: 'still', image: art('ch4_quiet_room_vault'), dur: 2, camera: [1.02, 1.08, 0.5, 0.4], fadeIn: 0.12, cards: [{ id: 'quiet', from: 0, to: 2, fade: 0, fadeOutDur: 0, rise: 18 }] },
  { name: 'boss', kind: 'still', image: art('ch4_quiet_room_boss'), dur: 1.9, overlap: 0.2, camera: [1.04, 1.14, 0.53, 0.4], fadeOut: 0.1, cards: [{ id: 'quiet', from: 0, to: 1.9, fade: 0, fadeOutDur: 0 }] },
  { name: 'features', kind: 'black', dur: 2.3, cards: [{ id: 'features', from: 0.15, to: 2.2, fade: 0.2, rise: 18 }] },
  { name: 'end', kind: 'black', dur: 3.2, cards: [{ id: 'end', from: 0.1, to: 3.1, fade: 0.1, slam: 0.05, fadeOutDur: 0.35 }] },
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
    const pixels = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', path.join(dir, files[i]), '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-']);
    const y = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
    if (y > 30) lit = true;
    if (lit && y < 4) return i;
  }
  return files.length - 1;
}

function segDur(s) {
  if (s.kind === 'shot') return (s.toFrame - s.from + 1) / FPS;
  return Math.round(s.dur * FPS) / FPS;
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
    let chain = `[${inputOffset + i}:v]format=rgba`;
    const settle = `pow(1-min(1,max(0,(t-${c.from})/0.4)),3)`;
    if (c.slam) chain += `,scale=w='ceil(iw*(1+${c.slam}*${settle})/2)*2':h='ceil(ih*(1+${c.slam}*${settle})/2)*2':eval=frame`;
    if (fade > 0) chain += `,fade=t=in:st=${c.from}:d=${fade}:alpha=1`;
    if (outDur > 0) chain += `,fade=t=out:st=${outAt.toFixed(3)}:d=${outDur}:alpha=1`;
    parts.push(`${chain}[c${i}]`);
    parts.push(`[v${i}][c${i}]overlay=x='(main_w-overlay_w)/2':y='(main_h-overlay_h)/2+${c.rise ?? 0}*${settle}':enable='between(t,${c.from},${c.to})'[v${i + 1}]`);
  });
  return parts;
}

/** Small, continuous reframes: source remains at normal speed and joints stay untouched. */
function cameraFilter(s, frames) {
  const [from, to, x, y] = s.camera ?? [1, 1, 0.5, 0.5];
  const progress = `min(1,on/${Math.max(1, frames - 1)})`;
  return `scale=${W * 2}:${H * 2}:flags=lanczos,zoompan=z='${from}+(${to - from})*${progress}':x='(iw-iw/zoom)*${x}':y='(ih-ih/zoom)*${y}':d=1:s=${W}x${H}:fps=${FPS}`;
}

function encodeSegment(s, i) {
  const out = path.join(SEG, `s${String(i).padStart(2, '0')}.mp4`);
  const dur = segDur(s);
  const inputs = [];
  let base;
  if (s.kind === 'black') {
    inputs.push('-f', 'lavfi', '-t', String(dur), '-i', `color=c=black:s=${W}x${H}:r=${FPS}`);
    base = '[0:v]format=yuv420p[v0]';
  } else if (s.kind === 'shot') {
    const n = s.toFrame - s.from + 1;
    inputs.push('-framerate', String(FPS), '-start_number', String(s.from), '-i', path.join(OUT, s.shot, 'f_%05d.jpg'));
    let f = `[0:v]trim=end_frame=${n},${cameraFilter(s, n)},${GRADE}`;
    if (s.fadeIn) f += `,fade=t=in:st=0:d=${s.fadeIn}`;
    if (s.fadeOut) f += `,fade=t=out:st=${(dur - s.fadeOut).toFixed(3)}:d=${s.fadeOut}`;
    base = `${f},format=yuv420p[v0]`;
  } else {
    const img = s.image();
    const frames = Math.round(dur * FPS);
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', String(dur), '-i', img);
    let f = `[0:v]${cameraFilter(s, frames)},${s.grade ?? STILL_GRADE}`;
    if (s.fadeIn) f += `,fade=t=in:st=0:d=${s.fadeIn}`;
    if (s.fadeOut) f += `,fade=t=out:st=${(dur - s.fadeOut).toFixed(3)}:d=${s.fadeOut}`;
    base = `${f},format=yuv420p[v0]`;
  }
  const cards = s.cards ?? [];
  for (const c of cards) inputs.push('-loop', '1', '-framerate', String(FPS), '-t', String(dur), '-i', path.join(CARDS, `${c.id}.png`));
  // JPEG captures are full range; generated cards are limited range. Normalize every
  // segment before concatenating so the master has consistent blacks and HD color tags.
  const graph = [base, ...cardFilters(cards, 1, dur), `[v${cards.length}]scale=in_range=auto:out_range=tv:out_color_matrix=bt709,setsar=1,format=yuv420p,sidedata=mode=delete:type=ICC_PROFILE[out]`].join(';');
  const last = '[out]';
  fs.writeFileSync(`${out}.filter`, graph);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...inputs, '-filter_complex_script', `${out}.filter`, '-map', last, '-t', String(dur), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', out], { stdio: 'inherit' });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Audio: cues on the trailer timeline
// ---------------------------------------------------------------------------------------------

function cues(starts) {
  const seg = (name) => {
    const i = EDIT.findIndex((s) => s.name === name);
    if (i < 0) throw new Error(`no segment ${name}`);
    return i;
  };
  const at = (name, t = 0) => starts[seg(name)] + t;
  const len = (name) => segDurs[seg(name)];
  const C = [];
  const total = starts[starts.length - 1];
  // A low bed under almost everything, cut for the silence after the catch.
  C.push({ t: 0, k: 'drone', dur: at('after', 0.2), freq: 41.2, gain: 0.045, attack: 2, release: 0.3 });
  C.push({ t: at('title'), k: 'drone', dur: total - at('title'), freq: 36.7, gain: 0.05, attack: 1.5, release: 4 });
  // Cold open: close, fast footfalls as the player backs away from a charge.
  C.push({ t: at('rush', 0.05), k: 'hit', gain: 0.7 });
  C.push({ t: at('rush'), k: 'steps', dur: len('rush'), every: 0.28, from: [0, 0, -3], to: [0, 0, -1], weight: 1, gain: 1.4 });
  C.push({ t: at('rush', 0.08), k: 'sfx', fn: 'sfxShriek', args: [0.7], pos: [0, 1.3, -3], gain: 0.9 });
  C.push({ t: at('rush'), k: 'heart', dur: len('rush'), bpm0: 130, bpm1: 150, gain: 0.65 });
  // 1. Hallway: a creak in the dark, the light clicks on and finds it; it turns to listen.
  C.push({ t: at('hall', 0.1), k: 'sfx', fn: 'sfxLightSwitch', args: [true], pos: [0.15, -0.2, -0.3], gain: 1.6 });
  C.push({ t: at('hall', 2.8), k: 'sfx', fn: 'sfxMonsterClicks', pos: [0, 0.6, -4.5], gain: 1.4 });
  C.push({ t: at('hall', 2.5), k: 'tone', dur: 1.0, freq: 1840, gain: 0.018 });
  C.push({ t: at('hall', len('hall') - 0.7), k: 'riser', dur: 0.7, gain: 0.25 });
  C.push({ t: at('cut1'), k: 'hit', gain: 0.85 });
  // 2. Door: heavy steps coming closer, then a sniff right in front of you.
  C.push({ t: at('door'), k: 'steps', dur: len('door'), every: 0.62, from: [-1.5, 0, -5], to: [-0.5, 0, -1.6], weight: 0.85, gain: 1.3 });
  C.push({ t: at('door', 0.1), k: 'heart', dur: len('door') - 0.1, bpm0: 72, bpm1: 96, gain: 0.55 });
  // 3. Climb: crawling and a claw scrape on the table, then the microphone caption.
  C.push({ t: at('climb', 0.3), k: 'sfx', fn: 'sfxMonsterCrawl', args: [true], pos: [0.5, 0, -2.5], gain: 1.3 });
  C.push({ t: at('climb', 1.5), k: 'sfx', fn: 'sfxMonsterCrawl', args: [true], pos: [0, 0, -2.4], gain: 1.3 });
  C.push({ t: at('climb', 2.8), k: 'sfx', fn: 'sfxClawScrape', pos: [-0.5, 0, -2.3], gain: 1.3 });
  C.push({ t: at('climb', 4.0), k: 'sfx', fn: 'sfxMonsterCrawl', args: [false], pos: [-1, 0, -2.5], gain: 1.2 });
  C.push({ t: at('climb'), k: 'heart', dur: len('climb'), bpm0: 96, bpm1: 115, gain: 0.6 });
  C.push({ t: at('climb', 3.5), k: 'sfx', fn: 'sfxHiss', pos: [3, 1.2, -6], gain: 0.4 });
  // 4. Hands: quiet, a few ticks of the house.
  C.push({ t: at('hands', 0.5), k: 'sfx', fn: 'sfxTicks', pos: [2, 1.5, -3], gain: 0.6 });
  // 5. Wind: the light browns out, you wind it (the ratchet), it hears you and comes.
  C.push({ t: at('wind', 0.9), k: 'crank', dur: 2.2, gain: 1.6 });
  C.push({ t: at('wind', 2.4), k: 'sfx', fn: 'sfxMonsterClicks', pos: [0, 0.8, -7], gain: 1.3 });
  C.push({ t: at('wind', 3.1), k: 'sfx', fn: 'sfxShriek', args: [1], pos: [0, 1.4, -6], gain: 1.2 });
  C.push({ t: at('wind', 3.3), k: 'steps', dur: 2.4, every: 0.28, from: [0, 0, -6.5], to: [0, 0, -1], weight: 1, gain: 1.4 });
  C.push({ t: at('wind', 2.9), k: 'heart', dur: 3.2, bpm0: 120, bpm1: 150, gain: 0.8 });
  C.push({ t: at('wind', 3.0), k: 'riser', dur: 2.6, gain: 0.35 });
  // The catch: the game's own sting, cut to silence.
  C.push({ t: at('catch'), k: 'sfx', fn: 'sfxCaughtSting', gain: 1.1 });
  C.push({ t: at('catch'), k: 'hit', gain: 1.0 });
  // 6. Title.
  C.push({ t: at('title', 0.05), k: 'braam', dur: 2.6, gain: 0.55, freq: 49 });
  C.push({ t: at('title', 0.05), k: 'hit', gain: 0.8 });
  C.push({ t: at('story') - 0.3, k: 'whoosh', dur: 0.45, gain: 0.11 });
  // 7. Low impacts on new places; lighter sweeps connect each paired concept image.
  ['echo', 'echo_chase', 'nest', 'nest_den', 'quiet', 'boss'].forEach((n, i) =>
    C.push(i % 2
      ? { t: at(n) - 0.16, k: 'whoosh', dur: 0.4, gain: 0.09 }
      : { t: at(n, 0.02), k: 'braam', dur: 1.5, gain: 0.24, freq: 55 }));
  ['echo', 'nest', 'quiet'].forEach((n) => {
    C.push({ t: at(n) - 0.32, k: 'riser', dur: 0.32, gain: 0.12 });
    C.push({ t: at(n, 0.03), k: 'hit', gain: 0.22 });
  });
  C.push({ t: at('boss', 0.3), k: 'sfx', fn: 'sfxShriek', args: [0.7], pos: [0, 2, -9], gain: 0.7 });
  // 8. End: one last ratchet in the dark, then a final hit on the card.
  C.push({ t: at('features', 1.0), k: 'crank', dur: 0.6, gain: 0.8 });
  C.push({ t: at('end') - 0.25, k: 'whoosh', dur: 0.35, gain: 0.12 });
  C.push({ t: at('end', 0.1), k: 'braam', dur: 2.8, gain: 0.45, freq: 41 });
  C.push({ t: at('end', 0.1), k: 'hit', gain: 0.7 });
  // A real break in the mix after the catch, then a clean release at the end.
  C.push({ t: at('after') + 0.05, k: 'silence', dur: len('after') - 0.05 });
  return C;
}

let segDurs = [];

async function renderAudio(starts, file) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--autoplay-policy=no-user-gesture-required'] });
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
  for (let i = 0; i < segDurs.length; i++) starts.push(starts[i] + segDurs[i] - (EDIT[i + 1]?.overlap ?? 0));
  console.log('segments', segDurs.map((d) => d.toFixed(2)).join(' '), 'total', starts[starts.length - 1].toFixed(2));
  fs.writeFileSync(path.join(OUT, 'edit.json'), JSON.stringify(EDIT.map((s, i) => ({ name: s.name, start: starts[i], duration: segDurs[i], overlap: s.overlap ?? 0 })), null, 2));
  if (process.argv.includes('--plan')) return;
  const wav = path.join(OUT, 'trailer_audio.wav');
  await renderAudio(starts, wav);
  if (process.argv.includes('--audio')) return;
  // --preview N: only the first N segments (a rough cut while shots are still being captured).
  const pi = process.argv.indexOf('--preview');
  const upto = pi >= 0 ? Number(process.argv[pi + 1]) : EDIT.length;
  const segments = EDIT.slice(0, upto).map((s, i) => {
    console.log('segment', i, s.name);
    return { file: encodeSegment(s, i), duration: segDurs[i], overlap: s.overlap ?? 0 };
  });
  // Crossfade only related concept images. Gameplay retains decisive action cuts.
  const joined = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (!s.overlap) { joined.push(s); continue; }
    const previous = joined.pop();
    const file = path.join(SEG, `pair${i}.mp4`);
    const duration = previous.duration + s.duration - s.overlap;
    const graph = `[0:v]settb=1/${FPS},setpts=PTS-STARTPTS[a];[1:v]settb=1/${FPS},setpts=PTS-STARTPTS[b];[a][b]xfade=transition=fade:duration=${s.overlap}:offset=${previous.duration - s.overlap},format=yuv420p[out]`;
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', previous.file, '-i', s.file, '-filter_complex', graph, '-map', '[out]', '-t', String(duration), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', file], { stdio: 'inherit' });
    joined.push({ file, duration, overlap: 0 });
  }
  const files = joined.map((s) => s.file);
  const list = path.join(SEG, 'list.txt');
  fs.writeFileSync(list, files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const video = path.join(SEG, 'video.mp4');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video], { stdio: 'inherit' });
  const final = path.join(OUT, upto < EDIT.length ? 'mute_trailer_preview.mp4' : 'mute_trailer.mp4');
  // Apply the matte after range normalization and crossfades, so its black level is exact.
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', video, '-i', wav, '-map', '0:v', '-map', '1:a', '-vf', MATTE_FILTER, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-bsf:v', COLOR_TAGS, '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', final], { stdio: 'inherit' });
  console.log(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'default=nw=1', final]).toString());
  if (upto < EDIT.length) return;
  // A smaller copy for sharing and the web.
  const web = path.join(OUT, 'mute_trailer_web.mp4');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', final, '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-bsf:v', COLOR_TAGS, '-c:a', 'copy', '-movflags', '+faststart', web], { stdio: 'inherit' });
  console.log(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'default=nw=1', web]).toString());
})();
