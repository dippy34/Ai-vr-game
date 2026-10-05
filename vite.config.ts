/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev:https` serves over HTTPS on your LAN so a Quest headset can open it
// (WebXR requires a secure context). Plain `npm run dev` is fine for desktop testing.
export default defineConfig(({ mode }) => ({
  // Relative base so the build works from any host path (GitHub Pages, a PWA wrapper, etc.).
  base: './',
  plugins: mode === 'https' ? [basicSsl()] : [],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}));
