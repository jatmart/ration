// Renders the Chrome Web Store images from the real extension in Brave:
// five 1280x800 screenshots and the 440x280 small promo tile, in store/.
// Run: npm run store-assets   (set BRAVE_PATH if Brave lives somewhere else)
import puppeteer from 'puppeteer-core';
import { mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'store');
const BRAVE = process.env.BRAVE_PATH || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
mkdirSync(OUT, { recursive: true });

// A copy granted access to every site, so no permission prompt appears.
const profile = mkdtempSync(join(tmpdir(), 'ration-assets-'));
const EXT = join(profile, 'extension');
for (const part of ['manifest.json', 'src', 'icons']) cpSync(join(ROOT, part), join(EXT, part), { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['*://*/*'];
writeFileSync(join(EXT, 'manifest.json'), JSON.stringify(manifest));

const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: true,
  pipe: true,
  enableExtensions: [EXT],
  userDataDir: profile,
  args: ['--no-first-run', '--no-default-browser-check', '--hide-scrollbars'],
  defaultViewport: { width: 1280, height: 800 },
});

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/src/background.js'));
  const id = new URL(sw.url()).host;
  const ext = (p) => `chrome-extension://${id}/${p}`;
  const control = await (async () => {
    for (let i = 0; i < 100; i++) {
      const p = (await browser.pages()).find((x) => x.url().startsWith(ext('src/pages/dashboard.html')));
      if (p) return p;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('welcome page did not open');
  })();
  const call = (type, payload = {}) => control.evaluate((type, payload) => chrome.runtime.sendMessage({ type, ...payload }), type, payload);

  // ---------- demo data ----------

  const groups = [
    { id: 'yt', name: 'YouTube', domains: ['youtube.com', 'youtu.be'], opensPerDay: 3, minutesPerOpen: 10, waitSeconds: 10 },
    { id: 'rd', name: 'Reddit', domains: ['reddit.com', 'redd.it'], opensPerDay: 2, minutesPerOpen: 10, waitSeconds: 10 },
    { id: 'x', name: 'X', domains: ['x.com', 'twitter.com'], opensPerDay: 2, minutesPerOpen: 5, waitSeconds: 15 },
  ];
  await call('saveConfig', { config: { goalMinutes: 45, groups } });
  await control.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    const [y, m, d] = state.lastDay.split('-').map(Number);
    const key = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    // Usage that trends down over 60 days, with some noise.
    for (let i = 60; i >= 1; i--) {
      const dt = new Date(y, m - 1, d - i, 12);
      const fall = 0.45 + 0.55 * (i / 60);
      const wave = (n) => 0.75 + 0.5 * Math.abs(Math.sin(i * 1.7 + n));
      const limited = {
        yt: Math.round(1500 * fall * wave(1)),
        rd: Math.round(700 * fall * wave(2)),
        x: Math.round(320 * fall * wave(3)),
      };
      const total = limited.yt + limited.rd + limited.x;
      state.days[key(dt)] = {
        opens: { yt: 2 + (i % 2), rd: 1 + (i % 2), x: i % 3 ? 1 : 2 },
        limited,
        goal: 45,
        failed: total > 45 * 60,
        loosened: false,
      };
    }
    state.days[state.lastDay] = { opens: { yt: 1, rd: 2, x: 0 }, limited: { yt: 760, rd: 520, x: 0 }, goal: 45, failed: false, loosened: false };
    state.installedAt = new Date(y, m - 1, d - 60, 12).getTime();
    state.streak = { current: 12, best: 19, lastEvaluated: key(new Date(y, m - 1, d - 1, 12)) };
    for (const g of state.config.groups) g.createdAt = Date.now() - 60 * 86400_000;
    await chrome.storage.local.set({ state });
  });

  // Store images use the light theme.
  const light = (page) => page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  browser.on('targetcreated', async (t) => {
    const p = await t.page().catch(() => null);
    if (p) await light(p);
  });

  const hideNotices = (page) =>
    page.evaluate(() => document.querySelectorAll('.notice').forEach((n) => n.remove()));

  async function shot(page, name) {
    await page.screenshot({ path: join(OUT, name), clip: { x: 0, y: 0, width: 1280, height: 800 } });
    console.log(`store/${name}`);
  }

  // ---------- 1. the gate ----------

  const gate = await browser.newPage();
  await light(gate);
  await gate.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ').catch(() => {});
  await gate.waitForSelector('button.primary:not([disabled])', { timeout: 20_000 });
  await gate.evaluate(() => document.activeElement?.blur());
  await shot(gate, '1-gate.png');

  // ---------- 2. done for the day ----------

  await gate.goto('https://www.reddit.com/r/all').catch(() => {});
  await gate.waitForFunction(() => document.body.innerText.includes('used all'));
  await shot(gate, '2-done-for-today.png');
  await gate.close();

  // ---------- 3. stats ----------

  const dash = await browser.newPage();
  await light(dash);
  await dash.goto(ext('src/pages/dashboard.html#stats'));
  await dash.waitForSelector('.chart-svg path');
  await dash.evaluate(() => [...document.querySelectorAll('.seg button')].find((b) => b.textContent === 'Month').click());
  await hideNotices(dash);
  await dash.evaluate(() => window.scrollTo(0, 0));
  await shot(dash, '3-stats.png');

  // ---------- 4. limits ----------

  await dash.goto(ext('src/pages/dashboard.html#limits'));
  await dash.reload();
  await dash.waitForSelector('.site-row');
  await hideNotices(dash);
  await shot(dash, '4-limits.png');
  await dash.close();

  // ---------- 5. popup beside the privacy promise ----------

  const pop = await browser.newPage();
  await light(pop);
  await pop.setViewport({ width: 300, height: 100, deviceScaleFactor: 2 });
  await pop.goto(ext('src/pages/popup.html'));
  await pop.waitForSelector('.site');
  await hideNotices(pop);
  const popupPng = await (await pop.$('main')).screenshot({ encoding: 'base64' });
  await pop.close();

  const icon = readFileSync(join(ROOT, 'icons', 'icon128.png')).toString('base64');
  const frame = await browser.newPage();
  await frame.setContent(`<!doctype html><html><head><style>
    body { margin: 0; width: 1280px; height: 800px; display: grid; grid-template-columns: 1fr 1fr; align-items: center;
      background: #f3f2ee; font-family: system-ui, "Segoe UI", sans-serif; color: #1b1b19; }
    .copy { padding: 0 40px 0 110px; }
    .copy img { width: 72px; height: 72px; }
    h1 { font-size: 46px; line-height: 1.1; margin: 24px 0 18px; font-weight: 650; letter-spacing: -0.02em; }
    p { font-size: 20px; line-height: 1.5; color: #5f5e59; margin: 0; max-width: 470px; }
    .shot { justify-self: center; width: 330px; border-radius: 12px; background: #fafaf8; box-shadow: 0 18px 50px rgb(0 0 0 / 0.16), 0 0 0 1px rgb(0 0 0 / 0.06); }
  </style></head><body>
    <div class="copy">
      <img src="data:image/png;base64,${icon}" alt="">
      <h1>Everything stays on your device.</h1>
      <p>No account, no servers, no analytics. Ration never sends or sells what you do. It only sees the sites you choose to limit.</p>
    </div>
    <img class="shot" src="data:image/png;base64,${popupPng}" alt="">
  </body></html>`);
  await frame.screenshot({ path: join(OUT, '5-private.png') });
  console.log('store/5-private.png');

  // ---------- small promo tile, 440x280 ----------

  await frame.setViewport({ width: 440, height: 280 });
  await frame.setContent(`<!doctype html><html><head><style>
    body { margin: 0; width: 440px; height: 280px; display: flex; align-items: center; gap: 22px; padding: 0 34px; box-sizing: border-box;
      background: #f3f2ee; font-family: system-ui, "Segoe UI", sans-serif; color: #1b1b19; }
    img { width: 104px; height: 104px; flex: none; }
    h1 { font-size: 40px; margin: 0 0 8px; font-weight: 650; letter-spacing: -0.02em; }
    p { font-size: 16px; line-height: 1.4; margin: 0; color: #5f5e59; }
    b { color: #d6302a; font-weight: 600; }
  </style></head><body>
    <img src="data:image/png;base64,${icon}" alt="">
    <div><h1>Ration</h1><p>A few timed opens a day for distracting sites. <b>All local.</b></p></div>
  </body></html>`);
  await frame.screenshot({ path: join(OUT, 'promo-small-440x280.png') });
  console.log('store/promo-small-440x280.png');

  // ---------- marquee promo tile, 1400x560 ----------

  const stats = readFileSync(join(OUT, '3-stats.png')).toString('base64');
  await frame.setViewport({ width: 1400, height: 560 });
  await frame.setContent(`<!doctype html><html><head><style>
    body { margin: 0; width: 1400px; height: 560px; overflow: hidden; position: relative;
      background: #f3f2ee; font-family: system-ui, "Segoe UI", sans-serif; color: #1b1b19; }
    .copy { position: absolute; left: 96px; top: 50%; transform: translateY(-50%); width: 520px; }
    .brand { display: flex; align-items: center; gap: 16px; }
    .brand img { width: 64px; height: 64px; }
    .brand span { font-size: 34px; font-weight: 650; letter-spacing: -0.02em; }
    h1 { font-size: 44px; line-height: 1.12; margin: 30px 0 16px; font-weight: 650; letter-spacing: -0.02em; }
    p { font-size: 20px; line-height: 1.5; margin: 0; color: #5f5e59; }
    b { color: #d6302a; font-weight: 600; }
    .window { position: absolute; left: 700px; top: 64px; width: 800px; border-radius: 12px; overflow: hidden;
      background: #fafaf8; box-shadow: 0 24px 60px rgb(0 0 0 / 0.16), 0 0 0 1px rgb(0 0 0 / 0.07); }
    .bar { height: 30px; background: #e9e8e3; display: flex; align-items: center; gap: 7px; padding: 0 14px; }
    .bar i { width: 10px; height: 10px; border-radius: 50%; background: #cfcec8; }
    .window img { display: block; width: 1280px; transform-origin: 0 0; transform: scale(0.72) translateX(-250px); }
  </style></head><body>
    <div class="copy">
      <div class="brand"><img src="data:image/png;base64,${icon}" alt=""><span>Ration</span></div>
      <h1>A few timed opens a day for the sites that eat your time.</h1>
      <p>Streaks and stats to keep you honest. <b>Everything stays on your device.</b></p>
    </div>
    <div class="window"><div class="bar"><i></i><i></i><i></i></div><img src="data:image/png;base64,${stats}" alt=""></div>
  </body></html>`);
  await frame.screenshot({ path: join(OUT, 'promo-marquee-1400x560.png') });
  console.log('store/promo-marquee-1400x560.png');
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
