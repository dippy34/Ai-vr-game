/// <reference types="vitest/config" />
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

const MODELS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public', 'models');

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

// `npm run dev:https` serves over HTTPS on your LAN so a Quest headset can open it
// (WebXR requires a secure context). Plain `npm run dev` is fine for desktop testing.
export default defineConfig(({ mode }) => ({
  // Relative base so the build works from any host path (GitHub Pages, a PWA wrapper, etc.).
  base: './',
  plugins: [modelsManifest(), ...(mode === 'https' ? [basicSsl()] : [])],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}));
