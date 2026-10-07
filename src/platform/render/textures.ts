/**
 * Procedural canvas textures, generated once at runtime (no asset files).
 * All textures here are cached and shared (`userData.shared = true`), never disposed by levels.
 */

import * as THREE from 'three';
import { makeRng } from '../../core/math';

type Ctx = CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

const cache = new Map<string, THREE.Texture>();
let maxAniso = 1;

/** Called by the renderer once it knows the GPU's anisotropy limit. */
export function setTextureAnisotropy(n: number): void {
  maxAniso = Math.max(1, Math.min(4, n));
  for (const t of cache.values()) {
    t.anisotropy = maxAniso;
    t.needsUpdate = true;
  }
}

function cached(key: string, build: () => HTMLCanvasElement, color = true, repeat = true): THREE.Texture {
  let t = cache.get(key);
  if (!t) {
    t = new THREE.CanvasTexture(build());
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = maxAniso;
    t.userData.shared = true;
    cache.set(key, t);
  }
  return t;
}

function speckle(g: Ctx, w: number, h: number, rnd: () => number, n: number, dark: string, light: string): void {
  for (let i = 0; i < n; i++) {
    g.fillStyle = rnd() < 0.5 ? dark : light;
    const s = 1 + rnd() * 2;
    g.fillRect(rnd() * w, rnd() * h, s, s);
  }
}

function stain(g: Ctx, x: number, y: number, r: number, rgba: string): void {
  const gr = g.createRadialGradient(x, y, r * 0.1, x, y, r);
  gr.addColorStop(0, rgba);
  gr.addColorStop(0.7, rgba.replace(/[\d.]+\)$/, (m) => `${parseFloat(m) * 0.5})`));
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(x - r, y - r, r * 2, r * 2);
}

/**
 * Faded striped wallpaper. Tile = 2 m wide x 2.7 m tall (v = 0 at the floor).
 * Canvas bottom = floor (CanvasTexture flips Y), so grime is painted at the bottom.
 */
export function wallpaperTexture(): THREE.Texture {
  return cached('wallpaper', () => {
    const W = 1024, H = 1024;
    const [c, g] = makeCanvas(W, H);
    const rnd = makeRng(1337);
    g.fillStyle = '#8c8a6e';
    g.fillRect(0, 0, W, H);
    // Stripes: wide pale band + narrow darker band with pinstripes.
    const stripe = W / 8;
    for (let i = 0; i < 8; i++) {
      const x = i * stripe;
      g.fillStyle = '#787a5c';
      g.fillRect(x + stripe * 0.62, 0, stripe * 0.38, H);
      g.fillStyle = 'rgba(60,58,40,0.55)';
      g.fillRect(x + stripe * 0.6, 0, 3, H);
      g.fillRect(x + stripe * 0.97, 0, 3, H);
      g.fillStyle = 'rgba(170,160,120,0.35)';
      g.fillRect(x + stripe * 0.79, 0, 2, H);
      // Small damask motifs in the pale band.
      for (let y = 30; y < H; y += 74) {
        const cx = x + stripe * 0.31;
        const cy = y + ((i % 2) * 37);
        g.fillStyle = 'rgba(95,92,64,0.5)';
        g.beginPath();
        g.moveTo(cx, cy - 16);
        g.quadraticCurveTo(cx + 13, cy, cx, cy + 16);
        g.quadraticCurveTo(cx - 13, cy, cx, cy - 16);
        g.fill();
        g.beginPath();
        g.arc(cx, cy, 3.5, 0, Math.PI * 2);
        g.fillStyle = 'rgba(150,140,100,0.5)';
        g.fill();
      }
    }
    // Fading: big soft blotches, water streaks from the top, grime toward the floor.
    for (let i = 0; i < 26; i++) {
      stain(g, rnd() * W, rnd() * H, 40 + rnd() * 160, `rgba(${70 + rnd() * 30},${55 + rnd() * 20},${30},${0.12 + rnd() * 0.18})`);
    }
    for (let i = 0; i < 14; i++) {
      const x = rnd() * W;
      const len = 120 + rnd() * 420;
      const gr = g.createLinearGradient(0, 0, 0, len);
      gr.addColorStop(0, 'rgba(60,45,25,0.35)');
      gr.addColorStop(1, 'rgba(60,45,25,0)');
      g.fillStyle = gr;
      g.fillRect(x, 0, 4 + rnd() * 10, len);
    }
    const grime = g.createLinearGradient(0, H * 0.55, 0, H);
    grime.addColorStop(0, 'rgba(25,20,10,0)');
    grime.addColorStop(1, 'rgba(25,20,10,0.55)');
    g.fillStyle = grime;
    g.fillRect(0, 0, W, H);
    // Peeling seams: thin pale slivers where strips of paper curl away.
    for (let i = 0; i < 5; i++) {
      const x = Math.floor(rnd() * 8) * (W / 8) + (rnd() < 0.5 ? 0 : W / 8 - 3);
      const y = rnd() * H * 0.8;
      const len = 30 + rnd() * 90;
      g.fillStyle = 'rgba(165,155,125,0.35)';
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + 7 + rnd() * 6, y + len * 0.5, x + 1, y + len);
      g.lineTo(x, y + len);
      g.fill();
    }
    speckle(g, W, H, rnd, 9000, 'rgba(40,35,20,0.25)', 'rgba(200,190,160,0.12)');
    return c;
  });
}

/** Dark wood planks. Tile = 2 m x 2 m, planks run along u. */
export function floorTexture(): THREE.Texture {
  return cached('floor', () => {
    const W = 1024, H = 1024;
    const [c, g] = makeCanvas(W, H);
    const rnd = makeRng(4242);
    const rows = 14;
    const ph = H / rows;
    g.fillStyle = '#120c08';
    g.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) {
      const y = r * ph;
      let x = -rnd() * 400;
      while (x < W) {
        const len = 280 + rnd() * 500;
        const base = 40 + rnd() * 22;
        g.fillStyle = `rgb(${base + 18},${base * 0.62 + 6},${base * 0.38})`;
        g.fillRect(x + 2, y + 2, len - 3, ph - 3);
        // Grain lines.
        for (let k = 0; k < 9; k++) {
          g.strokeStyle = `rgba(${15 + rnd() * 15},${8 + rnd() * 8},4,${0.25 + rnd() * 0.35})`;
          g.lineWidth = 0.6 + rnd() * 1.6;
          g.beginPath();
          const yy = y + 4 + rnd() * (ph - 8);
          g.moveTo(x, yy);
          for (let s = 0; s <= 8; s++) g.lineTo(x + (len * s) / 8, yy + Math.sin(s * 1.3 + rnd()) * 2.2);
          g.stroke();
        }
        if (rnd() < 0.35) {
          const kx = x + rnd() * len, ky = y + ph * (0.3 + rnd() * 0.4);
          g.fillStyle = 'rgba(20,10,4,0.7)';
          g.beginPath();
          g.ellipse(kx, ky, 6 + rnd() * 6, 3 + rnd() * 2, 0, 0, Math.PI * 2);
          g.fill();
        }
        // Worn lighter middle / scratches.
        for (let k = 0; k < 4; k++) {
          g.strokeStyle = 'rgba(150,120,90,0.08)';
          g.lineWidth = 1;
          const sx = x + rnd() * len, sy = y + rnd() * ph;
          g.beginPath();
          g.moveTo(sx, sy);
          g.lineTo(sx + 20 + rnd() * 60, sy + (rnd() - 0.5) * 6);
          g.stroke();
        }
        // Nail heads.
        g.fillStyle = 'rgba(10,8,6,0.9)';
        g.fillRect(x + 8, y + 6, 3, 3);
        g.fillRect(x + 8, y + ph - 9, 3, 3);
        x += len;
      }
    }
    for (let i = 0; i < 18; i++) stain(g, rnd() * W, rnd() * H, 60 + rnd() * 140, 'rgba(5,3,2,0.25)');
    speckle(g, W, H, rnd, 5000, 'rgba(0,0,0,0.25)', 'rgba(160,130,100,0.06)');
    return c;
  });
}

/** Cracked, stained plaster ceiling. Tile = 2 m x 2 m. */
export function ceilingTexture(): THREE.Texture {
  return cached('ceiling', () => {
    const W = 512, H = 512;
    const [c, g] = makeCanvas(W, H);
    const rnd = makeRng(99);
    g.fillStyle = '#6c6a64';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 40; i++) stain(g, rnd() * W, rnd() * H, 20 + rnd() * 80, `rgba(${80 + rnd() * 40},${70 + rnd() * 30},${50},0.15)`);
    for (let i = 0; i < 6; i++) stain(g, rnd() * W, rnd() * H, 50 + rnd() * 90, 'rgba(70,52,28,0.35)');
    g.strokeStyle = 'rgba(25,22,18,0.55)';
    for (let i = 0; i < 9; i++) {
      let x = rnd() * W, y = rnd() * H;
      g.lineWidth = 0.6 + rnd();
      g.beginPath();
      g.moveTo(x, y);
      const n = 10 + rnd() * 25;
      let a = rnd() * Math.PI * 2;
      for (let k = 0; k < n; k++) {
        a += (rnd() - 0.5) * 1.2;
        x += Math.cos(a) * 8;
        y += Math.sin(a) * 8;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    speckle(g, W, H, rnd, 6000, 'rgba(30,28,24,0.2)', 'rgba(200,200,190,0.1)');
    return c;
  });
}

/** Neutral wood grain (mostly luminance) for furniture; tinted by vertex colors. Tile = 1 m. */
export function woodGrainTexture(): THREE.Texture {
  return cached('woodgrain', () => {
    const W = 512, H = 512;
    const [c, g] = makeCanvas(W, H);
    const rnd = makeRng(7);
    g.fillStyle = '#d8d0c8';
    g.fillRect(0, 0, W, H);
    for (let k = 0; k < 90; k++) {
      g.strokeStyle = `rgba(90,70,55,${0.12 + rnd() * 0.3})`;
      g.lineWidth = 0.6 + rnd() * 2.4;
      g.beginPath();
      const y0 = rnd() * H;
      g.moveTo(0, y0);
      for (let s = 0; s <= 16; s++) g.lineTo((W * s) / 16, y0 + Math.sin(s * 0.7 + k) * 4 + (rnd() - 0.5) * 2);
      g.stroke();
    }
    for (let i = 0; i < 10; i++) stain(g, rnd() * W, rnd() * H, 30 + rnd() * 90, 'rgba(60,45,35,0.18)');
    speckle(g, W, H, rnd, 2500, 'rgba(40,30,20,0.2)', 'rgba(255,255,255,0.08)');
    return c;
  });
}

/** Coarse woven fabric, neutral; tinted by vertex colors. Tile = 0.5 m. */
export function fabricTexture(): THREE.Texture {
  return cached('fabric', () => {
    const W = 256, H = 256;
    const [c, g] = makeCanvas(W, H);
    const rnd = makeRng(3);
    g.fillStyle = '#cfcac4';
    g.fillRect(0, 0, W, H);
    for (let y = 0; y < H; y += 3) {
      g.fillStyle = `rgba(80,75,70,${0.08 + rnd() * 0.1})`;
      g.fillRect(0, y, W, 1);
    }
    for (let x = 0; x < W; x += 3) {
      g.fillStyle = `rgba(80,75,70,${0.06 + rnd() * 0.08})`;
      g.fillRect(x, 0, 1, H);
    }
    for (let i = 0; i < 12; i++) stain(g, rnd() * W, rnd() * H, 15 + rnd() * 50, 'rgba(70,60,45,0.22)');
    speckle(g, W, H, rnd, 1500, 'rgba(30,25,20,0.2)', 'rgba(255,255,255,0.1)');
    return c;
  });
}

/** Night window: deep blue sky, faint moon haze, bare branches, dark mullion cross. */
export function windowTexture(): THREE.Texture {
  return cached('window', () => {
    const W = 256, H = 256;
    const [c, g] = makeCanvas(W, H);
    const rnd = makeRng(55);
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#6f86b3');
    sky.addColorStop(0.6, '#3b4d73');
    sky.addColorStop(1, '#1d2740');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    stain(g, W * 0.7, H * 0.22, 90, 'rgba(210,225,255,0.45)');
    // Bare branches silhouette.
    g.strokeStyle = 'rgba(8,10,16,0.9)';
    const branch = (x: number, y: number, a: number, len: number, w: number, depth: number): void => {
      if (depth <= 0 || len < 4) return;
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x2, y2);
      g.stroke();
      branch(x2, y2, a + (rnd() - 0.5) * 0.9 - 0.25, len * 0.72, w * 0.7, depth - 1);
      branch(x2, y2, a + (rnd() - 0.5) * 0.9 + 0.35, len * 0.6, w * 0.65, depth - 1);
    };
    branch(-10, H * 0.9, -0.6, 70, 7, 6);
    branch(W + 10, H * 0.55, Math.PI + 0.4, 50, 5, 5);
    // Grime on the glass.
    for (let i = 0; i < 10; i++) stain(g, rnd() * W, rnd() * H, 20 + rnd() * 60, 'rgba(20,24,30,0.35)');
    // Mullions + frame shadow.
    g.fillStyle = '#05060a';
    g.fillRect(W / 2 - 5, 0, 10, H);
    g.fillRect(0, H / 2 - 5, W, 10);
    g.strokeStyle = '#05060a';
    g.lineWidth = 10;
    g.strokeRect(0, 0, W, H);
    return c;
  }, true, false);
}

/** Moonlight shaft: bright near the window (v = 0), fading toward the floor (v = 1), soft edges. */
export function shaftTexture(): THREE.Texture {
  return cached('shaft', () => {
    const W = 64, H = 128;
    const [c, g] = makeCanvas(W, H);
    const img = g.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      // Canvas row 0 = v 1 (flipY), so the floor end is at the top of the canvas.
      const v = 1 - y / (H - 1);
      const along = Math.pow(1 - v, 1.3) * 0.85 + 0.15 * (1 - v);
      for (let x = 0; x < W; x++) {
        const u = x / (W - 1);
        const edge = Math.pow(Math.sin(Math.PI * u), 0.6);
        const b = Math.round(255 * along * edge);
        const i = (y * W + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }, true, false);
}

/** Soft radial glow (white center -> transparent black edge) for additive halos. */
export function glowTexture(): THREE.Texture {
  return cached('glow', () => {
    const W = 64;
    const [c, g] = makeCanvas(W, W);
    const gr = g.createRadialGradient(W / 2, W / 2, 0, W / 2, W / 2, W / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.25, 'rgba(255,255,255,0.45)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, W);
    return c;
  }, true, false);
}

/** Vertical cold glow for the open exit door (bright at the bottom-middle, fading up and out). */
export function doorGlowTexture(): THREE.Texture {
  return cached('doorglow', () => {
    const W = 64, H = 128;
    const [c, g] = makeCanvas(W, H);
    const img = g.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const v = 1 - y / (H - 1);
      for (let x = 0; x < W; x++) {
        const u = x / (W - 1);
        const edge = Math.pow(Math.sin(Math.PI * u), 0.8);
        const b = Math.round(255 * edge * (0.35 + 0.65 * Math.pow(1 - v, 1.2)));
        const i = (y * W + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }, true, false);
}

/**
 * Matcap for afterimages: unlit, a calm pale center with a bright rim (fresnel-ish), so frozen
 * hands read as glowing silhouettes with enough shading to see which fingers are bent.
 */
export function ghostMatcapTexture(): THREE.Texture {
  return cached('ghostmatcap', () => {
    const W = 128;
    const [c, g] = makeCanvas(W, W);
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, W);
    const gr = g.createRadialGradient(W * 0.42, W * 0.38, 0, W / 2, W / 2, W / 2);
    gr.addColorStop(0, '#e4ebf7');
    gr.addColorStop(0.5, '#b4c3dc');
    gr.addColorStop(0.8, '#c4d2ea');
    gr.addColorStop(0.94, '#ffffff');
    gr.addColorStop(1, '#ffffff');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(W / 2, W / 2, W / 2, 0, Math.PI * 2);
    g.fill();
    return c;
  }, true, false);
}

/** Fuse box front plate: scuffed gray steel, hazard stripe, stenciled label, rivets. */
export function fuseBoxTexture(): THREE.Texture {
  return cached('fusebox', () => {
    const W = 256, H = 336;
    const [c, g] = makeCanvas(W, H);
    const rnd = makeRng(21);
    g.fillStyle = '#5d6062';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 25; i++) stain(g, rnd() * W, rnd() * H, 10 + rnd() * 50, 'rgba(70,45,25,0.35)');
    // Hazard stripe at top.
    g.save();
    g.beginPath();
    g.rect(0, 14, W, 30);
    g.clip();
    g.fillStyle = '#b8901c';
    g.fillRect(0, 14, W, 30);
    g.fillStyle = '#16140f';
    for (let x = -40; x < W + 40; x += 28) {
      g.beginPath();
      g.moveTo(x, 44);
      g.lineTo(x + 14, 44);
      g.lineTo(x + 44, 14);
      g.lineTo(x + 30, 14);
      g.fill();
    }
    g.restore();
    g.fillStyle = '#d8d4c8';
    g.font = 'bold 34px monospace';
    g.textAlign = 'center';
    g.fillText('FUSES', W / 2, 88);
    g.font = 'bold 16px monospace';
    g.fillStyle = '#b9b4a6';
    g.fillText('MAIN POWER - EXIT', W / 2, 110);
    // Rivets.
    g.fillStyle = '#2a2c2e';
    for (const [x, y] of [[10, 6], [W - 10, 6], [10, H - 8], [W - 10, H - 8]]) {
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      g.fill();
    }
    speckle(g, W, H, rnd, 2500, 'rgba(20,20,20,0.3)', 'rgba(220,220,220,0.12)');
    g.strokeStyle = 'rgba(15,15,15,0.8)';
    g.lineWidth = 4;
    g.strokeRect(2, 2, W - 4, H - 4);
    return c;
  }, true, false);
}
