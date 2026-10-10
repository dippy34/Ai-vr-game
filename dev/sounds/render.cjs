// Renders the monster voice v2 previews (dev/sounds/monster.ts) to dev/sounds/out/:
// a WAV per sound, a loudness-matched MP3 per sound, and one labelled review video.
//
//   npx vite --port 5330 --strictPort &      (any dev server that serves the repo)
//   node dev/sounds/render.cjs [name ...] [--no-reel]
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
function loadPlaywright() {
  try { return require('playwright'); } catch {}
  return require(execSync('npm root -g').toString().trim() + '/playwright');
}

const OUT = path.join(__dirname, 'out');
const PORT = process.env.PORT ?? 5330;
const args = process.argv.slice(2);
const wanted = args.filter((a) => !a.startsWith('--'));

/** What each sound is, for the review video, and how loud its MP3 is (integrated LUFS). */
const INFO = {
  rest_breath: ['Resting', 'Breathing', 'Slow and wet. Bubbles on the way in, a rattle on the way out.', -22],
  rest_croak: ['Resting', 'The croak', 'A broken clicking deep in its throat that swells into a groan.', -21],
  rest_whisper: ['Resting', 'Whispers', 'It whispers to itself. Sometimes a child whispers with it.', -22],
  rest_tom: ['Resting', "Tom's voice", 'A stolen recording of Tom crying. The tape catches, then drags down into his voice.', -20],
  rest_ellie: ['Resting', "Ellie's lullaby", 'Ellie humming, stolen. On the last note it slows into a man\'s groan.', -20],
  rest_bones: ['Resting', 'Bones', 'Joints cracking and sinew straining as it shifts its weight.', -21],
  rest_mix: ['Resting', 'All of it, at random', 'What you hear near it while it rests. Mixed at random, never the same twice.', -21],
  listening: ['Listening', 'It listens harder the louder you are', 'Your footsteps go from tiptoe to stomping. Its clicks speed up, a growl builds, the implant in its head starts to whine.', -19],
  activate_1: ['Activation', 'It heard you (1 of 3)', 'A gasp. A beat of silence. Then every stolen voice screams at once.', -15],
  activate_2: ['Activation', 'It heard you (2 of 3)', 'Same idea, different voices: it never screams the same way twice.', -15],
  activate_3: ['Activation', 'It heard you (3 of 3)', 'Ends in snarling breaths as it starts the chase.', -15],
  jumpscare_1: ['Jumpscare', 'The catch (1 of 2)', 'Point blank: an impact, a scream cluster in your face, a hard cut to ringing ears.', -13],
  jumpscare_2: ['Jumpscare', 'The catch (2 of 2)', 'Another take. Every catch is a little different.', -13],
  scene: ['All together', 'How it plays', 'It rests and hums. You start walking. It listens. It hears you. The chase. The catch.', -16],
};

function lufs(file) {
  const out = execSync(`ffmpeg -nostats -i ${file} -af ebur128=peak=true -f null - 2>&1`).toString();
  const m = out.match(/I:\s+(-?[\d.]+) LUFS/g);
  return Number(m[m.length - 1].match(/(-?[\d.]+)/)[1]);
}

(async () => {
  fs.mkdirSync(path.join(OUT, 'wav'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'mp3'), { recursive: true });
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://localhost:${PORT}/dev/sounds/monster.html`);
  await page.waitForFunction(() => !!window.__renderMonsterSound, null, { timeout: 120000 });
  const all = await page.evaluate(() => window.__monsterSounds);
  const names = wanted.length ? wanted : all;
  const report = [];
  for (const name of names) {
    const r = await page.evaluate((n) => window.__renderMonsterSound(n), name);
    const wavFile = path.join(OUT, 'wav', `${name}.wav`);
    fs.writeFileSync(wavFile, Buffer.from(r.b64, 'base64'));
    const target = INFO[name]?.[3] ?? -18;
    const gain = target - lufs(wavFile);
    const mp3 = path.join(OUT, 'mp3', `${name}.mp3`);
    execSync(`ffmpeg -loglevel error -y -i ${wavFile} -af "volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:level=false" -c:a libmp3lame -b:a 192k ${mp3}`);
    report.push(`${name.padEnd(13)} ${r.seconds.toFixed(1)}s  raw peak ${r.peak.toFixed(2)}  rms ${r.rms.toFixed(3)}  -> ${target} LUFS (${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB)`);
  }
  await browser.close();
  console.log(report.join('\n'));
  if (errors.length) console.log('page errors:\n' + errors.slice(0, 8).join('\n'));
  if (args.includes('--no-reel')) return;
  require('./reel.cjs').reel(names.filter((n) => INFO[n]), INFO);
})();
