import * as THREE from 'three';
import { rand } from './util';

type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void;

/** Low-res canvas texture with nearest filtering, the base of every surface in the Machine Party look. */
export function canvasTex(w: number, h: number, draw: Draw, repeat: [number, number] = [1, 1]) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestMipmapLinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  return t;
}

export function speckle(g: CanvasRenderingContext2D, w: number, h: number, cols: string[], n = 300, max = 3) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = cols[i % cols.length];
    g.globalAlpha = rand(0.08, 0.5);
    const s = Math.ceil(rand(1, max));
    g.fillRect(Math.floor(rand(0, w)), Math.floor(rand(0, h)), s, s);
  }
  g.globalAlpha = 1;
}

export function blotches(g: CanvasRenderingContext2D, w: number, h: number, col: string, n = 12, r0 = 4, r1 = 18, a0 = 0.06, a1 = 0.25) {
  for (let i = 0; i < n; i++) {
    const x = rand(0, w), y = rand(0, h), r = rand(r0, r1);
    g.globalAlpha = rand(a0, a1);
    g.fillStyle = col;
    g.beginPath();
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2, rr = r * rand(0.6, 1.2);
      g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.fill();
  }
  g.globalAlpha = 1;
}

function streaks(g: CanvasRenderingContext2D, w: number, h: number, col: string, n = 20) {
  for (let i = 0; i < n; i++) {
    g.globalAlpha = rand(0.05, 0.22);
    g.fillStyle = col;
    const x = rand(0, w);
    g.fillRect(Math.floor(x), Math.floor(rand(0, h * 0.4)), Math.ceil(rand(1, 3)), Math.floor(rand(h * 0.2, h)));
  }
  g.globalAlpha = 1;
}

function noiseFill(g: CanvasRenderingContext2D, w: number, h: number, base: [number, number, number], amp: number) {
  const img = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const n = (Math.random() - 0.5) * amp;
    img.data[i * 4] = base[0] + n;
    img.data[i * 4 + 1] = base[1] + n;
    img.data[i * 4 + 2] = base[2] + n;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

export const Tex = {
  concrete: (rep: [number, number] = [1, 1]) =>
    canvasTex(128, 128, (g, w, h) => {
      noiseFill(g, w, h, [92, 90, 84], 26);
      blotches(g, w, h, '#2e2a24', 14, 6, 26);
      blotches(g, w, h, '#a29d90', 8, 4, 14, 0.04, 0.14);
      streaks(g, w, h, '#1d1a16', 16);
      blotches(g, w, h, '#4a2a18', 3, 3, 10, 0.1, 0.3);
      g.strokeStyle = 'rgba(20,18,15,.55)';
      g.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        let x = rand(0, w), y = rand(0, h);
        g.beginPath();
        g.moveTo(x, y);
        for (let k = 0; k < 6; k++) g.lineTo((x += rand(-8, 8)), (y += rand(2, 10)));
        g.stroke();
      }
    }, rep),
  floor: (rep: [number, number] = [1, 1]) =>
    canvasTex(128, 128, (g, w, h) => {
      noiseFill(g, w, h, [62, 60, 56], 22);
      blotches(g, w, h, '#1b1916', 18, 6, 30, 0.08, 0.3);
      blotches(g, w, h, '#3b1e12', 5, 3, 12, 0.1, 0.3);
      g.fillStyle = 'rgba(15,14,12,.6)';
      g.fillRect(0, 0, w, 1);
      g.fillRect(0, 0, 1, h);
    }, rep),
  rust: (rep: [number, number] = [1, 1]) =>
    canvasTex(64, 64, (g, w, h) => {
      noiseFill(g, w, h, [96, 52, 30], 40);
      blotches(g, w, h, '#2a140a', 14, 2, 8, 0.2, 0.5);
      blotches(g, w, h, '#b2662e', 8, 2, 6, 0.1, 0.3);
      speckle(g, w, h, ['#1a0d06', '#c27a3c'], 200, 2);
    }, rep),
  metal: (rep: [number, number] = [1, 1]) =>
    canvasTex(64, 64, (g, w, h) => {
      noiseFill(g, w, h, [110, 112, 112], 18);
      streaks(g, w, h, '#2b2b2b', 10);
      blotches(g, w, h, '#5a3218', 5, 2, 7, 0.15, 0.4);
    }, rep),
  wood: (rep: [number, number] = [1, 1]) =>
    canvasTex(64, 64, (g, w, h) => {
      noiseFill(g, w, h, [52, 34, 22], 14);
      g.globalAlpha = 0.25;
      for (let y = 0; y < h; y += 3) {
        g.fillStyle = Math.random() < 0.5 ? '#1c120b' : '#4a3020';
        g.fillRect(0, y, w, 1);
      }
      g.globalAlpha = 1;
    }, rep),
  cloth: (rep: [number, number] = [1, 1]) =>
    canvasTex(128, 256, (g, w, h) => {
      noiseFill(g, w, h, [176, 168, 148], 16);
      g.globalAlpha = 0.1;
      g.fillStyle = '#3a3226';
      for (let x = 0; x < w; x += 16) g.fillRect(x, 0, 1, h);
      for (let y = 0; y < h; y += 16) g.fillRect(0, y, w, 1);
      g.globalAlpha = 1;
      blotches(g, w, h, '#6b5a3c', 22, 3, 14, 0.12, 0.35);
      blotches(g, w, h, '#4a1a12', 8, 3, 10, 0.12, 0.4);
      blotches(g, w, h, '#2b2418', 10, 2, 5, 0.2, 0.5);
      speckle(g, w, h, ['#3a2e1e', '#57471f'], 260, 2);
    }, rep),
  hazard: (rep: [number, number] = [1, 1]) =>
    canvasTex(64, 16, (g, w, h) => {
      g.fillStyle = '#c99a12';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#121110';
      for (let x = -h; x < w + h; x += 16) {
        g.beginPath();
        g.moveTo(x, h);
        g.lineTo(x + 8, h);
        g.lineTo(x + 8 + h, 0);
        g.lineTo(x + h, 0);
        g.fill();
      }
      blotches(g, w, h, '#2a2016', 10, 1, 5, 0.2, 0.5);
      speckle(g, w, h, ['#000', '#6b5a2a'], 120, 2);
    }, rep),
  /** Numbered jumpsuit: a stencilled number on the chest and back halves of a box-mapped texture. */
  jumpsuit: (hex: string, num: number) =>
    canvasTex(64, 64, (g, w, h) => {
      g.fillStyle = hex;
      g.fillRect(0, 0, w, h);
      speckle(g, w, h, ['#000', '#fff'], 260, 2);
      blotches(g, w, h, '#1d160f', 8, 3, 9, 0.1, 0.3);
      g.fillStyle = 'rgba(0,0,0,.35)';
      g.fillRect(w / 2 - 1, 0, 2, h);
      g.fillStyle = 'rgba(235,228,210,.92)';
      g.fillRect(14, 18, 36, 26);
      g.fillStyle = '#111';
      g.font = 'bold 22px monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(num).padStart(2, '0'), 32, 32);
    }),
  newspaper: () =>
    canvasTex(256, 170, (g, w, h) => {
      g.fillStyle = '#cfc6ad';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#161616';
      g.textAlign = 'center';
      g.font = 'bold 24px Georgia, serif';
      g.fillText('THE DAILY GRIND', w / 2, 26);
      g.fillRect(8, 32, w - 16, 2);
      g.font = 'bold 12px Georgia, serif';
      g.fillText('WORKPLACE ACCIDENTS AT RECORD LOW', w / 2, 50);
      g.fillStyle = '#4a4a4a';
      g.fillRect(10, 60, 84, 58);
      g.fillStyle = '#777';
      for (let r = 0; r < 6; r++) g.fillRect(10, 124 + r * 6, 84, 2);
      for (let c = 0; c < 2; c++) for (let r = 0; r < 17; r++) g.fillRect(102 + c * 76, 60 + r * 6, 68, 2);
      speckle(g, w, h, ['#8a7a5a'], 80, 3);
      blotches(g, w, h, '#6b5a3a', 4, 4, 12, 0.08, 0.2);
    }),
  /** Alpha-only blood splat used for decals; variant changes the silhouette. */
  splat: (variant: number) =>
    canvasTex(64, 64, (g, w, h) => {
      g.fillStyle = '#fff';
      const cx = w / 2, cy = h / 2;
      const blob = (x: number, y: number, r: number) => {
        g.beginPath();
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2, rr = r * rand(0.75, 1.15);
          g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        }
        g.fill();
      };
      if (variant === 0) {
        blob(cx, cy, 13);
        for (let i = 0; i < 14; i++) {
          const a = rand(0, 7), d = rand(14, 28);
          blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rand(1, 4));
        }
      } else if (variant === 1) {
        for (let i = 0; i < 6; i++) blob(cx + rand(-10, 10), cy + rand(-10, 10), rand(5, 11));
        for (let i = 0; i < 20; i++) blob(rand(4, w - 4), rand(4, h - 4), rand(0.8, 2.4));
      } else if (variant === 2) {
        for (let i = 0; i < 9; i++) blob(cx + i * 2.4 - 10, cy + rand(-3, 3), 7 - i * 0.5);
        for (let i = 0; i < 12; i++) blob(cx + rand(0, 26), cy + rand(-10, 10), rand(1, 3));
      } else {
        blob(cx, cy, 24);
        for (let i = 0; i < 8; i++) {
          const a = rand(0, 7);
          blob(cx + Math.cos(a) * 22, cy + Math.sin(a) * 22, rand(4, 8));
        }
      }
    }),
};
