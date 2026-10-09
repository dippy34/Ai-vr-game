// Cross-platform equivalent of fonts.sh: download the same Latin font subsets.
import fs from 'node:fs/promises';
const dir = new URL('./fonts/', import.meta.url);
await fs.mkdir(dir, { recursive: true });
async function download(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' } });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return response;
}
const css = await (await download('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600&family=Special+Elite&family=Cormorant+Garamond:ital,wght@0,400;1,400&display=swap')).text();
await fs.writeFile(new URL('fonts.css', dir), css);
const downloaded = new Set();
for (const [, subset, block] of css.matchAll(/\/\* ([a-z-]+) \*\/\s*@font-face \{(.*?)\}/gs)) {
  if (subset !== 'latin') continue;
  const family = /font-family: '([^']+)'/.exec(block)[1].replaceAll(' ', '');
  const style = /font-style: (\w+)/.exec(block)[1];
  const url = /url\((.*?)\)/.exec(block)[1];
  const name = `${family}-${style}.woff2`;
  await fs.writeFile(new URL(name, dir), Buffer.from(await (await download(url)).arrayBuffer()));
  console.log('font', name);
  downloaded.add(name);
}
for (const name of ['Cinzel-normal.woff2', 'SpecialElite-normal.woff2', 'CormorantGaramond-normal.woff2', 'CormorantGaramond-italic.woff2']) {
  if (!downloaded.has(name)) throw new Error(`Google Fonts did not supply ${name}`);
}
