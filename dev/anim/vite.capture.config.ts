// No-HMR dev server for frame-stepped captures (dev/anim/*.cjs). Restart it to pick up changes:
//   npx vite --config dev/anim/vite.capture.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig, type ConfigEnv, type UserConfig } from 'vite';
import base from '../../vite.config.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig((env: ConfigEnv) => {
  const cfg = typeof base === 'function' ? (base as (e: ConfigEnv) => UserConfig)(env) : base;
  return mergeConfig(cfg, {
    root: ROOT,
    server: { port: Number(process.env.PORT ?? 5320), strictPort: true, hmr: false, watch: { ignored: ['**/*'] } },
  });
});
