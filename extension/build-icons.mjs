// Generates TagNest extension icons (16/32/48/128) as PNGs using only Node built-ins.
// A warm amber rounded-square "tag" with a nest notch and a hang loop.
// Run: node extension/build-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, 'icons');
mkdirSync(OUT, { recursive: true });

// SDF helpers -----------------------------------------------------------
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}
function sdSeg(px, py, ax, ay, bx, by, w) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) - w / 2;
}

function sample(x, y, S) {
  const c = S / 2;
  const r = S * 0.30;         // rounded-rect half-size
  const R = r * 0.32;         // corner radius
  const dBody = sdRoundRect(x, y, c, c, r, r, R);

  if (dBody > 0) return null; // transparent outside

  // Brand amber base, brightening toward top-left.
  const lam = Math.min(1, (x + y) / (S * 1.5));
  const base = {
    r: 214 + lam * 30,  // 214->244
    g: 128 + lam * 44,  // 128->172
    b: 40 + lam * 40,   // 40->80
  };

  // Subtle vertical vignette ring near edge for depth.
  let col = base;
  if (dBody > -R * 0.5) col = { r: base.r * 0.82, g: base.g * 0.8, b: base.b * 0.76 };

  // A cleaner "nest notch": two crossing light strokes (suggest a woven nest)
  // drawn as a thin lighter V near the centre.
  const lw = Math.max(1.4, S * 0.016);
  const dV1 = sdSeg(x, y, c - r * 0.45, c - r * 0.1, c, c + r * 0.42, lw);
  const dV2 = sdSeg(x, y, c + r * 0.45, c - r * 0.1, c, c + r * 0.42, lw);
  if (Math.min(dV1, dV2) < Math.max(1.2, S * 0.02)) {
    col = { r: 255, g: 236, b: 200 };
  }

  // Hang loop: a small circle near the top-right corner, punched with canvas.
  const dLoop = sdCircle(x, y, c + r * 0.62, c - r * 0.62, r * 0.3);
  if (Math.abs(dLoop) < Math.max(1.5, S * 0.028)) {
    const t = Math.abs(dLoop) / Math.max(1.5, S * 0.028);
    const punch = { r: 246, g: 241, b: 233 };
    col = { r: col.r + (punch.r - col.r) * (1 - t), g: col.g + (punch.g - col.g) * (1 - t), b: col.b + (punch.b - col.b) * (1 - t) };
  }

  return { r: Math.round(col.r), g: Math.round(col.g), b: Math.round(col.b) };
}

function render(size) {
  const SS = 3; // supersample
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0, r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          const c = sample(fx, fy, size);
          if (c) { r += c.r; g += c.g; b += c.b; a++; }
        }
      }
      const p = (y * size + x) * 4;
      const n = SS * SS;
      if (a === 0) { out[p + 3] = 0; continue; }
      const alpha = (a / n) * 255;
      if (alpha < 1) { out[p + 3] = 0; continue; }
      out[p] = (r / n);
      out[p + 1] = (g / n);
      out[p + 2] = (b / n);
      out[p + 3] = Math.min(255, Math.round(alpha));
    }
  }
  return out;
}

// PNG encoding ----------------------------------------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = c >>> 1 ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [16, 32, 48, 128]) {
  const rgba = render(size);
  const png = encodePng(size, size, rgba);
  const file = join(OUT, `icon${size}.png`);
  writeFileSync(file, png);
  console.log('wrote', file, png.length, 'bytes');
}
