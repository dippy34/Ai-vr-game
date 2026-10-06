/// <reference types="vitest/config" />
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const MODELS_DIR = join(ROOT, 'public', 'models');
/** three's Basis Universal transcoder (for KTX2 textures), version-locked to the installed three. */
const BASIS_DIR = join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
const BASIS_FILES = ['basis_transcoder.js', 'basis_transcoder.wasm'];

function modelNames(): string[] {
  try {
    return readdirSync(MODELS_DIR)
      .filter((f) => f.endsWith('.glb') && !f.startsWith('_'))
      .map((f) => f.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Serves/emits models/manifest.json = the list of GLBs in public/models, so the game only
 * requests models that exist (anything else uses its procedural fallback).
 */
function modelsManifest(): Plugin {
  return {
    name: 'mute-models-manifest',
    configureServer(server) {
      server.middlewares.use('/models/manifest.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(modelNames()));
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'models/manifest.json', source: JSON.stringify(modelNames()) });
    },
  };
}

/**
 * Dev server: serves /basis/basis_transcoder.{js,wasm}, which KTX2Loader loads at runtime (builds
 * don't need this: Vite emits them as hashed assets from KTX2Loader's own `new URL(...)`).
 */
function basisTranscoder(): Plugin {
  return {
    name: 'mute-basis-transcoder',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/basis', (req, res, next) => {
        const file = (req.url ?? '').split('?')[0].replace(/^\//, '');
        if (!BASIS_FILES.includes(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(join(BASIS_DIR, file)));
      });
    },
  };
}

/**
 * `MUTE_KTX2=1 npm run dev` (= `npm run dev:ktx2`): serve the GPU-compressed copies the production
 * build makes (scripts/optimize-assets.mjs, cached by content hash) so dev matches a build. Restart
 * the dev server after re-exporting models. Without the flag, dev uses the WebP originals.
 */
function devCompressedAssets(): Plugin {
  const out = join(ROOT, 'node_modules', '.cache', 'mute-ktx2', 'dev-out');
  const TYPES: Record<string, string> = { glb: 'model/gltf-binary', json: 'application/json', ktx2: 'image/ktx2' };
  return {
    name: 'mute-dev-ktx2',
    apply: 'serve',
    async configureServer(server) {
      const script = pathToFileURL(join(ROOT, 'scripts', 'optimize-assets.mjs')).href;
      const { optimizeAssets } = await import(/* @vite-ignore */ script);
      await optimizeAssets({ outDir: out, log: (m: string) => server.config.logger.info(m) });
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        const m = /^\/((?:models\/ktx2\/[\w-]+\.(?:glb|json))|(?:textures\/(?:[\w-]+\.ktx2|textures\.json)))$/.exec(url);
        const file = m ? join(out, m[1]) : '';
        if (!m || !existsSync(file)) return next();
        res.setHeader('Content-Type', TYPES[file.split('.').pop()!] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(file));
      });
    },
  };
}

// `npm run dev:https` serves over HTTPS on your LAN so a Quest headset can open it
// (WebXR requires a secure context). Plain `npm run dev` is fine for desktop testing.
export default defineConfig(({ mode }) => ({
  // Relative base so the build works from any host path (GitHub Pages, a PWA wrapper, etc.).
  base: './',
  plugins: [
    modelsManifest(),
    basisTranscoder(),
    ...(process.env.MUTE_KTX2 === '1' ? [devCompressedAssets()] : []),
    ...(mode === 'https' ? [basicSsl()] : []),
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Generous: some suites simulate minutes of game time and CI/dev machines can be busy.
    testTimeout: 20000,
  },
}));
