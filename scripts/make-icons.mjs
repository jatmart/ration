// Draws the egg timer logo as SVG and renders each icon size in Brave. Each size
// gets its own detail level, so the dial stays readable at 16 pixels.
// Run: npm run icons   (set BRAVE_PATH if Brave lives somewhere else)
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const BRAVE = process.env.BRAVE_PATH || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const EGG = 'M64 0C37 0 10 37 10 75c0 31 24 53 54 53s54-22 54-53C118 37 91 0 64 0Z';

// The dial circles the egg, so the seam and the ticks are drawn on a tilted ring.
const RING_X = 56; // half width, a little past the egg's edge, so lines meet the outline
const RING_Y = 9; // how far the ring bows down at the center
const SEAM_Y = 70; // height of the ring at the egg's edges
const TICK_LEAN = 0.96; // the egg narrows upward, so tick tops lean toward the center

const DETAIL = {
  16: { outline: 8, seam: 11, tick: 7, major: 17, minor: 0, step: 45, majorEvery: 45, pointer: [15, 31, 15], numbers: false },
  32: { outline: 5, seam: 7, tick: 4, major: 15, minor: 0, step: 22.5, majorEvery: 22.5, pointer: [17, 20, 8], numbers: false },
  48: { outline: 4, seam: 5.5, tick: 2.7, major: 13, minor: 0, step: 15, majorEvery: 15, pointer: [15, 18, 8], numbers: false },
  128: { outline: 2.5, seam: 3.5, tick: 1.5, major: 10, minor: 5, step: 5, majorEvery: 25, pointer: [12, 15, 10], numbers: true },
};

const ringPoint = (deg, lift) => {
  const a = (deg * Math.PI) / 180;
  return { x: 64 + RING_X * Math.sin(a), y: SEAM_Y + RING_Y * Math.cos(a) - lift };
};

function ticks(d) {
  const out = [];
  for (let deg = -90; deg <= 90; deg += d.step) {
    const isMajor = deg % d.majorEvery === 0;
    const length = isMajor ? d.major : d.minor;
    if (!length) continue;
    const a = ringPoint(deg, 0);
    const b = ringPoint(deg * TICK_LEAN, length);
    out.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${d.tick}"/>`);
  }
  return out.join('');
}

function numbers(d) {
  if (!d.numbers) return '';
  return [
    [-50, 50],
    [-25, 55],
    [0, 0],
    [25, 5],
    [50, 10],
  ]
    .map(([deg, label]) => {
      // Same lean as the tick, so each number sits directly above its line.
      const p = ringPoint(deg * TICK_LEAN, d.major + 2);
      const squeeze = Math.cos((deg * Math.PI) / 180);
      return `<text transform="translate(${p.x} ${p.y}) scale(${squeeze} 1)">${label}</text>`;
    })
    .join('');
}

function eggSvg(size) {
  const d = DETAIL[size];
  const [gap, height, halfWidth] = d.pointer;
  const seam = `M${64 - RING_X} ${SEAM_Y}Q64 ${SEAM_Y + 2 * RING_Y} ${64 + RING_X} ${SEAM_Y}`;
  const tipY = SEAM_Y + RING_Y + gap - 6;
  // Keeps the outline inside the square while the egg still touches its edges.
  const fit = (128 - d.outline) / 128;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${size}" height="${size}">
    <defs>
      <radialGradient id="shell" cx="0.36" cy="0.26" r="0.86">
        <stop offset="0" stop-color="#ffffff"/>
        <stop offset="0.55" stop-color="#f6f4ee"/>
        <stop offset="1" stop-color="#d3cfc4"/>
      </radialGradient>
      <linearGradient id="base" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0.13"/>
        <stop offset="0.3" stop-color="#000" stop-opacity="0.03"/>
        <stop offset="1" stop-color="#000" stop-opacity="0"/>
      </linearGradient>
      <clipPath id="inside"><path d="${EGG}"/></clipPath>
    </defs>
    <g transform="translate(64 64) scale(${fit}) translate(-64 -64)">
      <path d="${EGG}" fill="url(#shell)"/>
      <g clip-path="url(#inside)">
        <path d="${seam}L140 140L-12 140Z" fill="url(#base)"/>
        <g stroke="#3c3b37" stroke-linecap="butt">${ticks(d)}</g>
        <g fill="#3c3b37" font-family="Segoe UI, sans-serif" font-size="10.5" font-weight="600" text-anchor="middle">${numbers(d)}</g>
        <path d="${seam}" fill="none" stroke="#55534d" stroke-width="${d.seam}"/>
        <path d="M64 ${tipY}l${halfWidth} ${height}h${-2 * halfWidth}Z" fill="#d6302a"/>
      </g>
      <path d="${EGG}" fill="none" stroke="#67655e" stroke-width="${d.outline}"/>
    </g>
  </svg>`;
}

mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: BRAVE, headless: true, pipe: true });
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    await page.setViewport({ width: size, height: size });
    await page.setContent(`<!doctype html><html style="margin:0;background:transparent"><body style="margin:0;background:transparent">${eggSvg(size).replace('<svg ', '<svg style="display:block" ')}</body></html>`);
    await page.screenshot({ path: join(OUT, `icon${size}.png`), omitBackground: true });
    console.log(`icons/icon${size}.png`);
  }
} finally {
  await browser.close();
}
