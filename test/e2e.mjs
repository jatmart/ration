// End-to-end test in a real Brave with a throwaway profile.
// Run: npm run e2e   (set BRAVE_PATH if Brave lives somewhere else)
// npm run e2e:dist tests the packaged copy in dist/ration instead of the source.
// Takes about 2 minutes, because one check runs a one-minute open with a pause in it.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'test', 'screenshots');
mkdirSync(SHOTS, { recursive: true });
const BRAVE = process.env.BRAVE_PATH || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

// Every *.test host resolves to this server.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>${req.headers.host}</title><h1 id="site">${req.headers.host}${req.url}</h1>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const site = (host, path = '/') => `http://${host}:${PORT}${path}`;

const profile = mkdtempSync(join(tmpdir(), 'ration-e2e-'));

// Ration asks for site access when you save a site, and a test cannot click
// Brave's prompt. The test copy is granted *.test up front, which stands in
// for clicking Allow. *.example stays without access.
const SRC = process.argv.includes('--dist') ? join(ROOT, 'dist', 'ration') : ROOT;
const EXT = join(profile, 'extension');
for (const part of ['manifest.json', 'src', 'icons']) cpSync(join(SRC, part), join(EXT, part), { recursive: true });
const testManifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
testManifest.host_permissions = ['*://*.test/*'];
writeFileSync(join(EXT, 'manifest.json'), JSON.stringify(testManifest, null, 2));

// Ration stops counting after 60 seconds with no keyboard or mouse input, and
// nobody touches the computer during a test run. The test copy always reads as active.
const workerPath = join(EXT, 'src', 'background.js');
const worker = readFileSync(workerPath, 'utf8');
const idleCall = 'chrome.idle.queryState(60)';
assert.ok(worker.includes(idleCall), 'background.js no longer checks for idle');
writeFileSync(workerPath, worker.replace(idleCall, "Promise.resolve('active')"));
const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: process.env.HEADED ? false : true,
  pipe: true,
  enableExtensions: [EXT],
  userDataDir: profile,
  args: [
    `--host-resolver-rules=MAP *.test 127.0.0.1, MAP *.example 127.0.0.1`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1100,900',
  ],
  defaultViewport: { width: 1000, height: 820 },
});

let failures = 0;
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`  ok  ${name} (${Date.now() - t}ms)`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.stack?.split('\n').slice(0, 3).join('\n       ')}`);
  }
}

async function waitFor(fn, { timeout = 10_000, every = 100, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${last}`);
}

try {
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('/src/background.js'),
    { timeout: 15_000 },
  );
  const extId = new URL(swTarget.url()).host;
  const ext = (p) => `chrome-extension://${extId}/${p}`;
  const GATE = ext('src/pages/gate.html');
  console.log(`Brave ${await browser.version()}, extension ${extId}`);

  // The install handler opens the welcome page. Use it to talk to the worker.
  const control = await waitFor(async () => {
    const pages = await browser.pages();
    return pages.find((p) => p.url().startsWith(ext('src/pages/dashboard.html')));
  }, { label: 'welcome page' });

  const call = (type, payload = {}) =>
    control.evaluate((type, payload) => chrome.runtime.sendMessage({ type, ...payload }), type, payload);
  const state = async () => (await call('getState')).state;
  const urlOf = (p) => p.url();

  const blocked = { id: 'blk', name: 'Blocked', domains: ['blocked.test'], opensPerDay: 2, minutesPerOpen: 5, waitSeconds: 2 };

  await step('welcome page opens on install', async () => {
    assert.match(control.url(), /dashboard\.html#limits$/);
  });

  await step('saving a new site applies at once', async () => {
    const res = await call('saveConfig', { config: { goalMinutes: 30, groups: [blocked] } });
    assert.equal(res.ok, true);
    const s = await state();
    assert.equal(s.config.groups[0].opensPerDay, 2);
    assert.equal(s.config.goalMinutes, 30);
  });

  const page = await browser.newPage();

  await step('a limited site sends you to the gate, with the full URL kept', async () => {
    await page.goto(site('blocked.test', '/watch?v=1&u=x&t=9'));
    await waitFor(() => urlOf(page).startsWith(GATE), { label: 'gate' });
    assert.ok(urlOf(page).endsWith(`&u=${site('blocked.test', '/watch?v=1&u=x&t=9')}`), urlOf(page));
    await page.waitForSelector('h1');
    assert.equal(await page.$eval('h1', (n) => n.textContent), 'Blocked');
    const icon = await page.$eval('link[rel=icon]', (n) => n.href);
    assert.ok(icon.includes('/_favicon/?pageUrl=' + encodeURIComponent(site('blocked.test', '/watch?v=1&u=x&t=9'))), icon);
    const text = await page.$eval('main', (n) => n.innerText);
    assert.match(text, /2 of 2 opens left today/);
  });

  await step('subdomains are limited too', async () => {
    const p2 = await browser.newPage();
    await p2.goto(site('www.blocked.test'));
    await waitFor(() => urlOf(p2).startsWith(GATE), { label: 'gate for subdomain' });
    await p2.close();
  });

  await step('other sites load normally', async () => {
    const p2 = await browser.newPage();
    await p2.goto(site('free.test', '/hello'));
    assert.equal(await p2.$eval('#site', (n) => n.textContent), `free.test:${PORT}/hello`);
    await p2.close();
  });

  await step('the open button stays disabled through the wait', async () => {
    await page.screenshot({ path: join(SHOTS, 'gate-wait.png') });
    const btn = await page.$('button.primary');
    assert.equal(await btn.evaluate((b) => b.disabled), true);
    await waitFor(() => btn.evaluate((b) => !b.disabled), { timeout: 6000, label: 'button enabled' });
  });

  await step('opening spends one open and loads the original page', async () => {
    await page.click('button.primary');
    await waitFor(() => urlOf(page) === site('blocked.test', '/watch?v=1&u=x&t=9'), { label: 'site loaded' });
    await page.waitForSelector('#site');
    const s = await state();
    assert.equal(s.days[s.lastDay].opens.blk, 1);
    assert.equal(s.sessions.blk.limitMs, 5 * 60_000);
  });

  await step('during an open, new tabs on the site load', async () => {
    const p2 = await browser.newPage();
    await p2.goto(site('blocked.test', '/other'));
    assert.equal(await p2.$eval('#site', (n) => n.textContent), `blocked.test:${PORT}/other`);
    await p2.close();
  });

  await step('ending the open sends open tabs back to the gate', async () => {
    await call('endSession', { groupId: 'blk' });
    await waitFor(() => urlOf(page).startsWith(GATE), { label: 'tab sent to gate' });
    assert.match(urlOf(page), /[?&]r=expired/);
    await page.waitForSelector('h1');
    assert.match(await page.$eval('.status', (n) => n.textContent), /Time/);
    assert.match(await page.$eval('main', (n) => n.innerText), /1 of 2 opens left today/);
  });

  await step('after the last open, the gate refuses', async () => {
    await page.reload();
    const btn = await page.waitForSelector('button.primary');
    await waitFor(() => btn.evaluate((b) => !b.disabled), { timeout: 6000, label: 'button enabled' });
    await btn.click();
    await waitFor(() => urlOf(page).startsWith(site('blocked.test')), { label: 'site loaded' });
    await call('endSession', { groupId: 'blk' });
    await waitFor(() => urlOf(page).startsWith(GATE), { label: 'gate again' });
    await page.waitForFunction(() => document.querySelector('main')?.innerText.includes('used all'));
    await page.screenshot({ path: join(SHOTS, 'gate-out.png') });
    const res = await call('startSession', { groupId: 'blk' });
    assert.deepEqual(res, { ok: false, error: 'no-opens' });
  });

  await step('looser settings apply at once, and Undo puts them back', async () => {
    // The site is seconds old, inside the free-edit period. Age it first.
    await control.evaluate(async () => {
      const { state } = await chrome.storage.local.get('state');
      state.config.groups[0].createdAt -= 60 * 60 * 1000;
      state.change = null;
      await chrome.storage.local.set({ state });
    });
    await call('saveConfig', {
      config: { goalMinutes: 90, groups: [{ ...blocked, opensPerDay: 9, waitSeconds: 30 }] },
    });
    let s = await state();
    assert.equal(s.config.groups[0].opensPerDay, 9);
    assert.equal(s.config.groups[0].waitSeconds, 30);
    assert.equal(s.config.goalMinutes, 90);
    assert.ok(s.change, 'the streak window is open');
    await waitFor(async () => (await control.evaluate(() => chrome.action.getBadgeText({}))) === '!', { label: 'streak warning on the icon' });
    await call('undoLoosening');
    s = await state();
    assert.equal(s.config.groups[0].opensPerDay, 2);
    assert.equal(s.config.groups[0].waitSeconds, 30, 'the stricter wait stays');
    assert.equal(s.change, null);
    await waitFor(async () => (await control.evaluate(() => chrome.action.getBadgeText({}))) === '', { label: 'icon clear' });
  });

  await step('a newly limited site closes tabs already open on it', async () => {
    const p2 = await browser.newPage();
    await p2.goto(site('later.test', '/feed'));
    await p2.waitForSelector('#site');
    const s = await state();
    const groups = [...s.config.groups, { id: 'later', name: 'Later', domains: ['later.test'], opensPerDay: 1, minutesPerOpen: 1, waitSeconds: 0 }];
    await call('saveConfig', { config: { goalMinutes: 90, groups } });
    await waitFor(() => urlOf(p2).startsWith(GATE), { label: 'open tab sent to gate' });
    await p2.close();
  });

  await step('in-page URL changes onto a limited site are caught', async () => {
    // Simulates a single-page app: the URL changes with no page load.
    const p2 = await browser.newPage();
    await p2.goto(site('later.test'));
    await waitFor(() => urlOf(p2).startsWith(GATE), { label: 'gate' });
    // Rules are off during an open, so the page loads. End it via storage
    // without the worker's tab pass, then change the URL in the page.
    await call('startSession', { groupId: 'later' });
    await p2.goto(site('later.test', '/a'));
    await p2.waitForSelector('#site');
    await control.evaluate(async () => {
      const { state } = await chrome.storage.local.get('state');
      delete state.sessions.later;
      await chrome.storage.local.set({ state });
    });
    await p2.evaluate(() => history.pushState({}, '', '/b'));
    await waitFor(() => urlOf(p2).startsWith(GATE), { label: 'gate after pushState' });
    await p2.close();
  });

  await step('an open counts down only while its site is the active tab (about 80s)', async () => {
    if (process.env.QUICK) return console.log('       skipped: QUICK is set');
    await call('undoLoosening');
    await call('saveConfig', {
      config: {
        goalMinutes: (await state()).config.goalMinutes,
        groups: [...(await state()).config.groups, { id: 'tim', name: 'Timed', domains: ['timed.test'], opensPerDay: 1, minutesPerOpen: 1, waitSeconds: 0 }],
      },
    });
    const left = (sess) => sess.limitMs - sess.usedMs - (sess.activeSince != null ? Date.now() - sess.activeSince : 0);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const p2 = await browser.newPage();
    await p2.goto(site('timed.test'));
    const btn = await p2.waitForSelector('button.primary:not([disabled])');
    await btn.click();
    await waitFor(() => urlOf(p2).startsWith(site('timed.test')), { label: 'site loaded' });
    await p2.bringToFront();
    await waitFor(async () => (await state()).sessions.tim?.activeSince != null, { label: 'open running on the active tab' });
    const badge = () => control.evaluate(() => chrome.action.getBadgeText({}));
    assert.match(await badge(), /^\d+m$/, 'badge shows minutes while running');
    await sleep(5000);

    // Another tab in front: the open pauses.
    const p3 = await browser.newPage();
    await p3.goto(site('free.test'));
    await p3.bringToFront();
    await waitFor(async () => (await state()).sessions.tim.activeSince == null, { label: 'open paused' });
    const pausedAt = left((await state()).sessions.tim);
    assert.equal(await badge(), '', 'badge is empty while paused');
    assert.ok(pausedAt < 57_000 && pausedAt > 40_000, `left after 5s of use: ${pausedAt}ms`);
    await sleep(15_000);
    const stillLeft = left((await state()).sessions.tim);
    assert.equal(stillLeft, pausedAt, 'no time used while paused');
    assert.ok(urlOf(p2).startsWith(site('timed.test')), 'site still open while paused');

    // Back in front: the open resumes and ends when its minute is used up.
    const resumed = Date.now();
    await p2.bringToFront();
    await waitFor(() => urlOf(p2).startsWith(GATE), { timeout: 100_000, every: 500, label: 'gate after expiry' });
    const took = (Date.now() - resumed) / 1000;
    console.log(`       paused with ${(pausedAt / 1000).toFixed(1)}s left, ended ${took.toFixed(1)}s after resuming`);
    assert.ok(took > pausedAt / 1000 - 3 && took < pausedAt / 1000 + 35, `ended ${took}s after resuming`);
    await p3.close();
    await p2.close();
  });

  await step('"Not now" closes the gate tab when the window has other tabs', async () => {
    const p2 = await browser.newPage();
    await p2.goto(site('blocked.test'));
    await waitFor(() => urlOf(p2).startsWith(GATE), { label: 'gate' });
    const notNow = await p2.waitForSelector('.actions button:not(.primary), .actions button.primary');
    await p2.evaluate(() => [...document.querySelectorAll('.actions button')].at(-1).click());
    await waitFor(() => p2.isClosed(), { label: 'tab closed' });
    void notNow;
  });

  await step('"Not now" shows the new tab page when the gate is the only tab', async () => {
    const before = new Set(await browser.pages());
    const tabId = await control.evaluate(async (url) => {
      const win = await chrome.windows.create({ url });
      return win.tabs[0].id;
    }, site('blocked.test'));
    const gatePage = await waitFor(async () => (await browser.pages()).find((p) => !before.has(p) && p.url().startsWith(GATE)), { label: 'gate in new window' });
    await gatePage.waitForSelector('.actions button');
    await gatePage.evaluate(() => [...document.querySelectorAll('.actions button')].at(-1).click());
    // The extension has no "tabs" permission, so read the address from the browser side.
    const url = await waitFor(() => (/^(chrome|brave):\/\/(newtab|new-tab-page)/.test(gatePage.url()) ? gatePage.url() : null), {
      label: 'new tab page',
    }).catch((e) => { throw new Error(`${e.message} Page URL: ${gatePage.url()}`); });
    console.log(`       went to ${url}`);
    await control.evaluate((id) => chrome.tabs.remove(id), tabId);
  });

  await step('pages render without errors (screenshots in test/screenshots)', async () => {
    // Seed 400 days of fake history so every range has something to draw.
    await control.evaluate(async () => {
      const { state } = await chrome.storage.local.get('state');
      const ids = ['blk', 'later', 'tim', 'rd-old'];
      state.groupMeta['rd-old'] = { name: 'Old site', slot: Object.keys(state.groupMeta).length };
      const [y, m, d] = state.lastDay.split('-').map(Number);
      for (let i = 0; i < 400; i++) {
        const dt = new Date(y, m - 1, d - i, 12);
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        const rec = state.days[key] || { opens: {}, limited: {}, goal: 30, failed: false, loosened: false };
        ids.forEach((id, j) => {
          if (id === 'rd-old' && i < 200) return;
          const s = Math.round((120 + ((i * 7 + j * 13) % 11) * 90) * (1 - j * 0.2));
          rec.limited[id] = (rec.limited[id] || 0) + s;
          rec.opens[id] = (rec.opens[id] || 0) + (i % 3);
        });
        rec.failed = Object.values(rec.limited).reduce((a, b) => a + b, 0) > 30 * 60;
        state.days[key] = rec;
      }
      state.installedAt = new Date(y, m - 1, d - 399, 12).getTime();
      state.streak.current = 4;
      state.streak.best = 11;
      await chrome.storage.local.set({ state });
    });

    const errors = [];
    const watch = (p) => {
      p.on('pageerror', (e) => errors.push(`${p.url()}: ${e.message}`));
      p.on('console', (m) => m.type() === 'error' && errors.push(`${p.url()}: ${m.text()}`));
    };
    const pickRange = (dash, label) =>
      dash.evaluate((label) => [...document.querySelectorAll('.seg button')].find((b) => b.textContent === label).click(), label);
    const barCount = (dash) => dash.$$eval('.chart-svg .hit', (n) => n.length);

    for (const scheme of ['light', 'dark']) {
      const dash = await browser.newPage();
      watch(dash);
      await dash.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await dash.goto(ext('src/pages/dashboard.html#stats'));
      await dash.waitForSelector('.chart-svg path');
      assert.equal(await barCount(dash), 7);
      const text = await dash.$eval('#view-stats', (n) => n.innerText);
      assert.match(text, /Limits allow/);
      const stray = text.match(/github|browsing/i);
      assert.equal(stray, null, stray && JSON.stringify(text.slice(stray.index - 60, stray.index + 40)));
      assert.ok(await dash.$('.chart-svg .goal-line'), 'daily view has a goal line');
      const hit = (await dash.$$('.chart-svg .hit'))[5];
      await hit.hover();
      await dash.waitForSelector('.chart-tip:not([hidden])');
      await dash.screenshot({ path: join(SHOTS, `dashboard-stats-${scheme}.png`), fullPage: true });

      if (scheme === 'light') {
        await pickRange(dash, 'Month');
        assert.equal(await barCount(dash), 30);
        await pickRange(dash, 'Year');
        assert.equal(await barCount(dash), 12);
        assert.equal(await dash.$('.chart-svg .goal-line'), null, 'month bars have no goal line');
        await dash.screenshot({ path: join(SHOTS, 'dashboard-stats-year.png'), fullPage: true });
        await pickRange(dash, 'YTD');
        const month = Number((await state()).lastDay.slice(5, 7));
        assert.equal(await barCount(dash), month <= 1 ? new Date().getDate() : month);
        await pickRange(dash, 'All time');
        assert.ok((await barCount(dash)) >= 13, 'all time spans 400 days of months');
        assert.match(await dash.$eval('#view-stats', (n) => n.innerText), /Old site/);
        await dash.screenshot({ path: join(SHOTS, 'dashboard-stats-all.png'), fullPage: true });
      }

      await dash.goto(ext('src/pages/dashboard.html#limits'));
      await dash.reload();
      await dash.waitForSelector('.site-row');
      assert.match(await dash.$eval('#allotment', (n) => n.innerText), /Limits allow/);
      await dash.screenshot({ path: join(SHOTS, `dashboard-limits-${scheme}.png`), fullPage: true });
      await dash.close();

      const pop = await browser.newPage();
      watch(pop);
      await pop.setViewport({ width: 340, height: 600 });
      await pop.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await pop.goto(ext('src/pages/popup.html'));
      await pop.waitForSelector('.group');
      assert.match(await pop.$eval('main', (n) => n.innerText), /Limits allow/);
      await pop.screenshot({ path: join(SHOTS, `popup-${scheme}.png`), fullPage: true });
      await pop.close();
    }
    assert.deepEqual(errors, []);
  });

  await step('a looser edit shows the undo box, and undoing keeps the streak', async () => {
    const dash = await browser.newPage();
    await dash.goto(ext('src/pages/dashboard.html#limits'));
    const goal = await dash.waitForSelector('#goal');
    await goal.click({ clickCount: 3 });
    await goal.type('500');
    await waitFor(async () => (await state()).config.goalMinutes === 500, { label: 'goal saved without leaving the field' });
    let s = await state();
    assert.equal(s.config.goalMinutes, 500, 'a raised goal applies at once');
    assert.ok(s.change, 'a loosening window is open');
    assert.equal(s.streak.current, 4);
    await dash.waitForSelector('.loose-box .streak-warn');
    await dash.screenshot({ path: join(SHOTS, 'dashboard-loosen-warning.png'), fullPage: true });
    await dash.evaluate(() => {
      location.hash = '#stats';
    });
    await dash.waitForSelector('#view-stats:not([hidden])');
    assert.ok(await dash.$('.loose-box:not([hidden])'), 'the warning follows you to the stats page');
    assert.match(await dash.$eval('#loose-text', (n) => n.textContent), /Undo within \d+:\d\d or your 4-day streak resets/);
    await dash.click('.loose-box button.primary');
    await dash.waitForFunction(() => document.querySelector('.loose-box').hidden);
    s = await state();
    assert.equal(s.change, null);
    assert.ok(s.config.goalMinutes < 500, `goal back to ${s.config.goalMinutes}`);
    assert.equal(s.streak.current, 4);
    await dash.close();
  });

  await step('a site Ration has no access to is blocked outright, with no gate', async () => {
    const s0 = await state();
    const groups = [...s0.config.groups, { id: 'nx', name: 'No access', domains: ['noaccess.example'], opensPerDay: 3, minutesPerOpen: 5, waitSeconds: 0 }];
    await call('saveConfig', { config: { goalMinutes: s0.config.goalMinutes, groups } });
    const p2 = await browser.newPage();
    const err = await p2.goto(site('noaccess.example')).then(() => null, (e) => e.message);
    assert.match(err || p2.url(), /ERR_BLOCKED_BY_CLIENT/);
    await p2.close();

    const dash = await browser.newPage();
    await dash.goto(ext('src/pages/dashboard.html#limits'));
    await dash.waitForFunction(() => document.getElementById('warnings').innerText.includes('noaccess.example'));
    await dash.close();

    // Remove it again. It is minutes old, so the removal applies at once.
    await call('saveConfig', { config: { goalMinutes: s0.config.goalMinutes, groups: groups.filter((g) => g.id !== 'nx') } });
    assert.ok(!(await state()).config.groups.some((g) => g.id === 'nx'));
  });

  const lastRow = async (dash) => (await dash.$$('.site-row')).at(-1);
  const lastGroup = async () => (await state()).config.groups.at(-1);
  const limitsPage = async () => {
    const dash = await browser.newPage();
    await dash.goto(ext('src/pages/dashboard.html#limits'));
    await dash.waitForSelector('.presets button');
    return dash;
  };
  const addOtherSite = async (dash, name, domain) => {
    await dash.evaluate(() => [...document.querySelectorAll('.presets button')].find((b) => b.textContent === 'Other site').click());
    const row = await lastRow(dash);
    await (await row.$('input.name')).type(name);
    if (domain) await (await row.$('.c-domains input')).type(domain);
    return row;
  };
  const assertQuiet = async (dash) => {
    assert.ok(await dash.evaluate(() => document.getElementById('savebar').hidden), 'nothing announces the save');
    assert.equal(await dash.evaluate(() => document.querySelector('.wrap').innerText.includes('Saved')), false);
  };

  await step('a new site saves itself, with nothing on screen', async () => {
    const dash = await limitsPage();
    assert.equal(await dash.$('#save'), null, 'there is no Save button');
    await addOtherSite(dash, 'UI site', 'https://ui.test/path');
    assert.ok(!(await state()).config.groups.some((g) => g.name === 'UI site'), 'nothing saves mid-typing');
    await dash.keyboard.press('Tab');
    await waitFor(async () => (await state()).config.groups.some((g) => g.name === 'UI site'), { label: 'site saved' });
    assert.deepEqual((await lastGroup()).domains, ['ui.test']);
    await dash.waitForFunction(() => [...document.querySelectorAll('.c-domains input')].at(-1).value === 'ui.test');
    await assertQuiet(dash);
    const p2 = await browser.newPage();
    await p2.goto(site('ui.test'));
    await waitFor(() => urlOf(p2).startsWith(GATE), { label: 'gate for the new site' });
    await p2.close();
    await dash.close();
  });

  await step('a number saves as you change it, and the cursor does not move', async () => {
    const dash = await limitsPage();
    const [opens] = await (await lastRow(dash)).$$('input[type=number]');
    await opens.click({ clickCount: 3 });
    await opens.type('25');
    await waitFor(async () => (await lastGroup()).opensPerDay === 25, { label: 'number saved without leaving the field' });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(await opens.evaluate((n) => document.activeElement === n && n.value === '25'), 'the cursor stays in the field');
    await assertQuiet(dash);
    await dash.close();
  });

  await step('a blank number goes back to its last value', async () => {
    const dash = await limitsPage();
    const before = (await lastGroup()).minutesPerOpen;
    const [, minutes] = await (await lastRow(dash)).$$('input[type=number]');
    await minutes.click({ clickCount: 3 });
    await dash.keyboard.press('Backspace');
    await dash.keyboard.press('Tab');
    await dash.waitForFunction((v) => [...document.querySelectorAll('.site-row')].at(-1).querySelectorAll('input[type=number]')[1].value === v, {}, String(before));
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal((await lastGroup()).minutesPerOpen, before);
    await assertQuiet(dash);
    await dash.close();
  });

  await step('an unfinished row does not stop other edits from saving', async () => {
    const dash = await limitsPage();
    const finished = (await dash.$$('.site-row')).length;
    await addOtherSite(dash, 'Unfinished');
    await dash.keyboard.press('Tab');
    const [opens] = await (await dash.$$('.site-row'))[finished - 1].$$('input[type=number]');
    await opens.click({ clickCount: 3 });
    await opens.type('21');
    await dash.keyboard.press('Tab');
    await waitFor(async () => (await lastGroup()).opensPerDay === 21, { label: 'edit saved past the unfinished row' });
    assert.equal((await state()).config.groups.length, finished);
    assert.equal((await dash.$$('.site-row')).length, finished + 1, 'the unfinished row stays on the page');
    await dash.close();
  });

  await step('a half-typed domain on a saved site keeps the site limited', async () => {
    const dash = await limitsPage();
    const domain = await (await lastRow(dash)).$('.c-domains input');
    await domain.click({ clickCount: 3 });
    await dash.keyboard.type('not a domain!');
    await dash.keyboard.press('Tab');
    await dash.waitForFunction(() => [...document.querySelectorAll('.site-row .err')].some((n) => n.textContent.includes('Not a domain')));
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual((await lastGroup()).domains, ['ui.test']);
    await dash.close();
  });

  await step('closing the page saves the last edit, with no leave prompt', async () => {
    const dash = await limitsPage();
    const [opens] = await (await lastRow(dash)).$$('input[type=number]');
    await opens.click({ clickCount: 3 });
    await opens.type('19');
    let prompted = false;
    dash.on('dialog', (d) => {
      prompted = true;
      d.accept();
    });
    await dash.close({ runBeforeUnload: true });
    await waitFor(async () => (await lastGroup()).opensPerDay === 19, { label: 'edit saved on close' });
    assert.equal(prompted, false);
  });

  await step('refusing site access keeps the site off and offers to ask again', async () => {
    const dash = await limitsPage();
    await dash.evaluate(() => {
      window.answer = false;
      chrome.permissions.request = async () => window.answer;
    });
    await addOtherSite(dash, 'Refused', 'refused.test');
    await dash.keyboard.press('Tab');
    await dash.waitForSelector('.site-row .err button');
    assert.ok(!(await state()).config.groups.some((g) => g.name === 'Refused'));
    await dash.evaluate(() => {
      window.answer = true;
    });
    await dash.click('.site-row .err button');
    await waitFor(async () => (await state()).config.groups.some((g) => g.name === 'Refused'), { label: 'saved after allowing' });
    await dash.waitForFunction(() => !document.querySelector('.site-row .err button'));
    await dash.close();
  });

  await step('the egg shows on the gate, the popup, and the dashboard', async () => {
    const eggHeight = (page, selector) =>
      page.$eval(selector, (img) => {
        if (!img.complete || !img.naturalWidth) throw new Error(`no image: ${img.src}`);
        return img.getBoundingClientRect().height;
      });
    const gatePage = await browser.newPage();
    await gatePage.goto(site('ui.test'));
    await gatePage.waitForSelector('h1 img.logo');
    await waitFor(() => gatePage.$eval('h1 img.logo', (img) => img.complete));
    assert.equal(await eggHeight(gatePage, 'h1 img.logo'), 34);
    await gatePage.close();

    const pop = await browser.newPage();
    await pop.goto(ext('src/pages/popup.html'));
    await pop.waitForSelector('h1 img.logo');
    await waitFor(() => pop.$eval('h1 img.logo', (img) => img.complete));
    assert.equal(await eggHeight(pop, 'h1 img.logo'), 28);
    await pop.close();

    const dash = await limitsPage();
    await waitFor(() => dash.$eval('header.top h1 img', (img) => img.complete));
    assert.equal(await eggHeight(dash, 'header.top h1 img'), 32);
    await dash.close();
  });

  await step('dropping an open and raising it back on the page has no wait', async () => {
    // This write goes around the worker's queue, so a worker save from the tab
    // that just closed can replace it. Repeat until it holds.
    let tries = 0;
    await waitFor(async () => {
      tries++;
      await control.evaluate(async () => {
        const { state } = await chrome.storage.local.get('state');
        state.config.groups.at(-1).createdAt = Date.now() - 60 * 60 * 1000;
        state.change = null;
        await chrome.storage.local.set({ state });
      });
      await new Promise((r) => setTimeout(r, 300));
      const s = await state();
      return Date.now() - s.config.groups.at(-1).createdAt > 30 * 60_000 && s.change === null;
    }, { label: 'site aged' });
    if (tries > 1) console.log(`       aging the site took ${tries} tries`);
    const dash = await limitsPage();
    const start = (await lastGroup()).opensPerDay;
    const setOpens = async (value) => {
      const [opens] = await (await lastRow(dash)).$$('input[type=number]');
      await opens.click({ clickCount: 3 });
      await opens.type(String(value));
      await dash.keyboard.press('Tab');
      await waitFor(async () => (await lastGroup()).opensPerDay === value, { label: `opens at ${value}` });
    };
    await setOpens(start - 1);
    await setOpens(start);
    assert.equal(await dash.$('.loose-box:not([hidden])'), null, 'going down and back shows nothing');

    await setOpens(start + 1);
    await dash.waitForSelector('.loose-box:not([hidden])');
    await setOpens(start);
    await dash.waitForFunction(() => document.querySelector('.loose-box').hidden);
    await setOpens(start + 1);
    await dash.waitForSelector('.loose-box:not([hidden])');
    await dash.click('.loose-box button.primary');
    await dash.waitForFunction(() => document.querySelector('.loose-box').hidden);
    await dash.close();
  });

  await step('notices name the right settings for this browser', async () => {
    const dash = await limitsPage();
    const chrome = /chrome(\.exe)?$/i.test(BRAVE);
    const text = await dash.evaluate(() => document.getElementById('warnings').innerText);
    assert.ok(text.includes(chrome ? 'chrome://extensions' : 'brave://extensions'), text);
    assert.ok(text.includes(chrome ? 'Allow in Incognito' : 'Allow in Private'), text);
    await dash.close();
  });
} catch (e) {
  failures++;
  console.error(e);
} finally {
  await browser.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
