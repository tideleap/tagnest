// Generates PWA app icons (192/512) that match public/favicon.svg exactly:
// an amber rounded-square with a white bookmark tab and an amber punched hole.
// Uses only Node built-ins. Run: node scripts/gen-pwa-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, '..', 'public');
mkdirSync(OUT, { recursive: true });

// Palette from public/favicon.svg
const AMBER = { r: 217, g: 131, b: 36 };   // #D98324
const WHITE = { r: 255, g: 255, b: 255 };

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// Signed distance for the favicon's white bookmark tab (a vertical tab that
// tapers into a point, with a rounded amber hole near the top).
function bookmarkSDF(x, y, S) {
  const c = S / 2;
  // Tab body: a tall vertical band, bottom pointing down like a bookmark tail.
  const left = c - S * 0.315;
  const right = c + S * 0.315;
  const top = c - S * 0.30;
  const bot = c + S * 0.24;
  const insideX = x >= left && x <= right;
  const insideY = y >= top && y <= bot;
  if (!insideX || !insideY) return 999; // outside the tab

  // Tapered bottom: narrower as y increases (a subtle bookmark point).
  const taper = (y - top) / (bot - top); // 0..1
  const half = (right - left) / 2 * (1 - taper * 0.55) + S * 0.02;
  const halfX = Math.abs(x - c);
  if (halfX > half) return 999;

  // Rounded amber hole near the top (like the favicon's circle).
  const dHole = Math.hypot(x - c, y - (top + S * 0.135)) - S * 0.075;
  return dHole;
}

function sample(x, y, S) {
  const c = S / 2;
  const R = S * 0.30;      // rounded-square half-size
  const dBody = sdRoundRect(x, y, c, c, R, R, R * 0.55);
  if (dBody > 0) return null; // outside the icon bounds
  let col = { ...AMBER };

  // Subtle edge shadow for depth (consistent with the icon family).
  if (dBody > -R * 0.5) col = { r: 190, g: 114, b: 30 };

  // White bookmark tab
  const dTab = bookmarkSDF(x, y, S);
  if (dTab < 999) {
    const edge = Math.max(1.2, S * 0.02);
    if (dTab < edge) col = { r: 226, g: 222, b: 214 }; // anti-aliased edge
    else col = WHITE;
    return col;
  }

  return col;
}

function render(size) {
  const SS = 3;
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
      if (a === 0) { out[p + 3] = 0; continue; }
      const alpha = (a / (SS * SS)) * 255;
      if (alpha < 1) { out[p + 3] = 0; continue; }
      out[p] = (r / (SS * SS));
      out[p + 1] = (g / (SS * SS));
      out[p + 2] = (b / (SS * SS));
      out[p + 3] = 255;
    }
  }
  return out;
}

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

for (const size of [192, 512]) {
  const rgba = render(size);
  const png = encodePng(size, size, rgba);
  const file = join(OUT, `pwa-icon-${size}.png`);
  writeFileSync(file, png);
  console.log('wrote', file, png.length, 'bytes');
}
