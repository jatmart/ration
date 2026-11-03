// Draws the toolbar icons as PNG files with no dependencies: a white egg
// timer with a dial band and a red pointer.
// Run: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const OUTLINE = [88, 88, 84];
const BAND = [112, 112, 106];
const TICK = [40, 40, 38];
const RED = [214, 48, 42];

// Egg geometry in a 0..1 square. The bottom is wider than the top.
const CX = 0.5;
// The egg fills the square top to bottom, so it reads at 16 pixels.
const CY = 0.5;
const A = 0.41; // half width at the middle
const B = 0.495; // half height
const TAPER = 0.15;
const BAND_Y = 0.6; // the split between dome and base

// Returns a signed value: below 1 inside the egg, 1 on the edge.
function eggValue(x, y) {
  const yn = (y - CY) / B;
  const w = A * (1 + TAPER * yn);
  const xn = (x - CX) / w;
  return Math.sqrt(xn * xn + yn * yn);
}

function mix(a, b, t) {
  return a.map((v, i) => v + (b[i] - v) * t);
}

// Color of one sample point, or null outside the egg.
function sample(x, y, size) {
  const v = eggValue(x, y);
  if (v > 1) return null;
  const px = 1 / size;
  const edge = Math.max(1.2 * px, 0.022);
  // Distance from the edge, roughly, in icon units.
  const inset = (1 - v) * A;
  if (inset < edge) return OUTLINE;

  // Soft light from the upper left.
  const lx = (x - CX) / A;
  const ly = (y - CY) / B;
  const light = Math.max(0, Math.min(1, 0.5 + 0.35 * (lx * 0.6 + ly * 0.8) + 0.25 * v * v));
  const c = mix([255, 255, 254], [222, 222, 217], light);

  // Groove between dome and base.
  const bandH = Math.max(px * 1.4, 0.034);
  if (Math.abs(y - BAND_Y) < bandH / 2) return BAND;

  // Dial ticks above the band: majors every fourth tick, minors between
  // them on the large sizes only.
  if (size >= 32) {
    const minor = size >= 96;
    const step = minor ? 0.026 : size >= 48 ? 0.09 : 0.11;
    const range = minor ? 8 : 2;
    const tickW = Math.max(px * 1.0, 0.009);
    const majorH = size >= 48 ? 0.055 : 0.07;
    const below = BAND_Y - bandH / 2 - (size >= 96 ? 0.012 : 0);
    for (let k = -range; k <= range; k++) {
      const isMajor = minor ? k % 4 === 0 : true;
      const h = isMajor ? majorH : majorH * 0.45;
      const tx = CX + k * step;
      if (Math.abs(x - tx) < tickW / 2 && y < below && y > below - h) return TICK;
    }
  }

  // Red pointer under the band, pointing up.
  const triTop = BAND_Y + bandH / 2 + (size >= 32 ? 0.035 : 0.05);
  const triH = size >= 32 ? 0.13 : 0.22;
  const triW = size >= 32 ? 0.16 : 0.3;
  const t = (y - triTop) / triH;
  if (t >= 0 && t <= 1 && Math.abs(x - CX) <= (triW / 2) * t) return RED;

  return c;
}

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Every size fills its square, so the egg stays readable everywhere.
function png(size) {
  const SS = 8;
  const pad = 0;
  const inner = 1 - 2 * pad;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let n = 0, r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((px + (sx + 0.5) / SS) / size - pad) / inner;
          const v = ((py + (sy + 0.5) / SS) / size - pad) / inner;
          const c = sample(u, v, size * inner);
          if (!c) continue;
          n++; r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      if (n) {
        raw[o] = Math.round(r / n);
        raw[o + 1] = Math.round(g / n);
        raw[o + 2] = Math.round(b / n);
      }
      raw[o + 3] = Math.round((n / (SS * SS)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon${s}.png`), png(s));
  console.log(`icons/icon${s}.png`);
}
