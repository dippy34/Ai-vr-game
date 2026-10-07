// Runs the headless body probe (dev/anim/probe.anim.ts) with vitest's TS pipeline.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: { environment: 'node', include: ['dev/anim/*.anim.ts'], testTimeout: 120000, silent: false },
});
