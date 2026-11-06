import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/lib/core.js';

const H = 60 * 60 * 1000;
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const T0 = at(2026, 11, 2, 10);

function group(over = {}) {
  return {
    id: 'yt',
    name: 'YouTube',
    domains: ['youtube.com', 'youtu.be'],
    opensPerDay: 3,
    minutesPerOpen: 10,
    waitSeconds: 10,
    ...over,
  };
}

// A state whose groups were created long ago, outside the grace period.
function stateWith(groups, now = T0, goalMinutes = 60) {
  const s = core.defaultState(now);
  s.config = { goalMinutes, groups: groups.map((g) => ({ createdAt: now - 48 * H, ...g })) };
  return s;
}

// Puts `host` in the active tab from `from` for `ms`, syncing each minute
// like the worker's minute alarm. Returns the end time.
function watch(s, host, from, ms) {
  s.tracking = { host, since: from };
  core.syncSessions(s, from);
  let t = from;
  while (t < from + ms) {
    t = Math.min(t + 60_000, from + ms);
    core.syncSessions(s, t);
  }
  s.tracking = null;
  core.syncSessions(s, t);
  return t;
}

// ---------- days ----------

test('day keys are local, zero-padded, and step across months and years', () => {
  assert.equal(core.localDayKey(at(2026, 1, 5)), '2026-01-05');
  assert.equal(core.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(core.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(core.addDays('2028-03-01', -1), '2028-02-29');
});

test('addDays steps whole days across every day of a year', () => {
  let k = '2026-01-01';
  for (let i = 0; i < 365; i++) k = core.addDays(k, 1);
  assert.equal(k, '2027-01-01');
});

test('nextMidnight returns the start of the next local day', () => {
  assert.equal(core.nextMidnight(at(2026, 11, 2, 23, 59)), at(2026, 11, 3, 0));
});

// ---------- domains ----------

test('normalizeDomain accepts URLs and bare domains', () => {
  assert.equal(core.normalizeDomain('https://www.YouTube.com/watch?v=1'), 'youtube.com');
  assert.equal(core.normalizeDomain('  m.reddit.com  '), 'm.reddit.com');
  assert.equal(core.normalizeDomain('*.tiktok.com'), 'tiktok.com');
  assert.equal(core.normalizeDomain('twitch.tv:443'), 'twitch.tv');
  assert.equal(core.normalizeDomain('blocked.test'), 'blocked.test');
});

test('normalizeDomain rejects junk', () => {
  for (const bad of ['', 'youtube', 'not a domain', 'http://', '-x.com', 'a..com', 42, null]) {
    assert.equal(core.normalizeDomain(bad), null, String(bad));
  }
});

test('group matching covers subdomains but not lookalike domains', () => {
  const cfg = { groups: [group()] };
  assert.equal(core.groupForUrl(cfg, 'https://www.youtube.com/')?.id, 'yt');
  assert.equal(core.groupForUrl(cfg, 'https://m.youtube.com/feed')?.id, 'yt');
  assert.equal(core.groupForUrl(cfg, 'https://youtu.be/abc')?.id, 'yt');
  assert.equal(core.groupForUrl(cfg, 'https://notyoutube.com/'), null);
  assert.equal(core.groupForUrl(cfg, 'https://youtube.com.evil.net/'), null);
  assert.equal(core.groupForUrl(cfg, 'chrome://settings'), null);
  assert.equal(core.groupForUrl(cfg, 'not a url'), null);
});

// ---------- config: tighten now, loosen later ----------

test('stricter numbers apply at once', () => {
  const s = stateWith([group()]);
  const res = core.saveConfig(s, { goalMinutes: 30, groups: [group({ opensPerDay: 2, minutesPerOpen: 5, waitSeconds: 30 })] }, T0);
  assert.deepEqual(res, { applied: true });
  const g = s.config.groups[0];
  assert.equal(g.opensPerDay, 2);
  assert.equal(g.minutesPerOpen, 5);
  assert.equal(g.waitSeconds, 30);
  assert.equal(s.config.goalMinutes, 30);
});

test('looser numbers apply at once and open the undo window', () => {
  const s = stateWith([group()]);
  const res = core.saveConfig(s, { goalMinutes: 90, groups: [group({ opensPerDay: 9, minutesPerOpen: 60, waitSeconds: 0 })] }, T0);
  assert.deepEqual(res, { applied: true });
  assert.equal(s.config.groups[0].opensPerDay, 9);
  assert.equal(s.config.groups[0].minutesPerOpen, 60);
  assert.equal(s.config.groups[0].waitSeconds, 0);
  assert.equal(s.config.goalMinutes, 90);
  assert.equal(s.change.since, T0);
  assert.equal(s.change.base.groups[0].opensPerDay, 3);
  assert.equal('pending' in s, false);
});

test('a mixed edit applies whole and counts as looser', () => {
  const s = stateWith([group()]);
  core.saveConfig(s, { goalMinutes: 60, groups: [group({ opensPerDay: 1, minutesPerOpen: 30 })] }, T0);
  assert.equal(s.config.groups[0].opensPerDay, 1);
  assert.equal(s.config.groups[0].minutesPerOpen, 30);
  assert.ok(core.stillLoose(s));
});

test('adding and removing a domain both apply at once', () => {
  const s = stateWith([group()]);
  core.saveConfig(s, { goalMinutes: 60, groups: [group({ domains: ['youtube.com', 'youtube-nocookie.com'] })] }, T0);
  assert.deepEqual(s.config.groups[0].domains, ['youtube.com', 'youtube-nocookie.com']);
  assert.ok(core.stillLoose(s), 'dropping youtu.be is looser');
});

test('removing a site applies at once and counts as looser', () => {
  const s = stateWith([group()]);
  const reddit = { id: 'rd', name: 'Reddit', domains: ['reddit.com'], opensPerDay: 2, minutesPerOpen: 5, waitSeconds: 5 };
  core.saveConfig(s, { goalMinutes: 60, groups: [reddit] }, T0);
  assert.deepEqual(s.config.groups.map((g) => g.id), ['rd']);
  assert.equal(s.config.groups[0].createdAt, T0);
  assert.ok(core.stillLoose(s));
});

test('a new site is free to edit or remove during the grace period only', () => {
  const s = stateWith([]);
  core.saveConfig(s, { goalMinutes: 60, groups: [group()] }, T0);
  core.saveConfig(s, { goalMinutes: 60, groups: [group({ opensPerDay: 20 })] }, T0 + 60_000);
  assert.equal(s.config.groups[0].opensPerDay, 20);
  assert.equal(core.stillLoose(s), false);

  core.saveConfig(s, { goalMinutes: 60, groups: [] }, T0 + 2 * 60_000);
  assert.equal(s.config.groups.length, 0);
  assert.equal(core.stillLoose(s), false);

  core.saveConfig(s, { goalMinutes: 60, groups: [group()] }, T0 + 2.5 * 60_000);
  core.saveConfig(s, { goalMinutes: 60, groups: [] }, T0 + 2.5 * 60_000 + core.GRACE_MS);
  assert.equal(s.config.groups.length, 0);
  assert.ok(core.stillLoose(s), 'after the grace period, removing counts as looser');
});

test('the page cannot fake createdAt to reopen the grace period', () => {
  const s = stateWith([group()]);
  const created = s.config.groups[0].createdAt;
  core.saveConfig(s, { goalMinutes: 60, groups: [{ ...group({ opensPerDay: 50 }), createdAt: T0 }] }, T0);
  assert.equal(s.config.groups[0].createdAt, created);
  assert.ok(core.stillLoose(s));
});

test('swapping a site for a new id counts as looser', () => {
  const s = stateWith([group()]);
  core.saveConfig(s, { goalMinutes: 60, groups: [group({ id: 'yt2', opensPerDay: 50 })] }, T0);
  assert.ok(core.stillLoose(s));
  assert.ok(core.stillLoose(s));
});

test('cleanConfig clamps numbers, drops bad domains and empty groups', () => {
  const c = core.cleanConfig({
    goalMinutes: -5,
    groups: [
      { id: 'a', name: '', domains: ['https://Example.com/x', 'junk', 'example.com'], opensPerDay: 999, minutesPerOpen: 0, waitSeconds: 'x' },
      { id: 'b', domains: ['nope'] },
      { id: 'a', domains: ['dup.com'] },
    ],
  });
  assert.equal(c.goalMinutes, 0);
  assert.equal(c.groups.length, 1);
  assert.deepEqual(c.groups[0], {
    id: 'a', name: 'example.com', domains: ['example.com'], opensPerDay: 50, minutesPerOpen: 1, waitSeconds: 10,
  });
});

test('an edit keeps createdAt from the live config', () => {
  const s = stateWith([group()]);
  const created = s.config.groups[0].createdAt;
  core.saveConfig(s, { goalMinutes: 60, groups: [group({ opensPerDay: 5 })] }, T0);
  assert.equal(s.config.groups[0].createdAt, created);
});

// ---------- sessions ----------

test('each open spends one of the day and lasts minutesPerOpen of active use', () => {
  const s = stateWith([group({ opensPerDay: 2 })]);
  let r = core.startSession(s, 'yt', T0);
  assert.equal(r.ok, true);
  assert.equal(r.session.limitMs, 10 * 60_000);
  assert.equal(core.opensLeft(s, s.config.groups[0]), 1);

  // A second start during the open reuses it and spends nothing.
  r = core.startSession(s, 'yt', T0 + 60_000);
  assert.equal(r.reused, true);
  assert.equal(core.opensLeft(s, s.config.groups[0]), 1);

  const end = watch(s, 'www.youtube.com', T0, 10 * 60_000);
  assert.deepEqual(core.expireSessions(s, end), ['yt']);
  r = core.startSession(s, 'yt', T0 + 11 * 60_000);
  assert.equal(r.ok, true);
  core.endSession(s, 'yt');
  r = core.startSession(s, 'yt', T0 + 12 * 60_000);
  assert.deepEqual(r, { ok: false, error: 'no-opens' });
});

test('zero opens means always blocked', () => {
  const s = stateWith([group({ opensPerDay: 0 })]);
  assert.equal(core.startSession(s, 'yt', T0).error, 'no-opens');
});

test('unknown groups cannot open', () => {
  const s = stateWith([group()]);
  assert.equal(core.startSession(s, 'nope', T0).error, 'unknown-group');
});

test('opens reset at midnight', () => {
  const s = stateWith([group({ opensPerDay: 1 })]);
  core.startSession(s, 'yt', T0);
  core.endSession(s, 'yt');
  assert.equal(core.startSession(s, 'yt', T0 + H).ok, false);
  core.tick(s, at(2026, 11, 3, 0, 1));
  assert.equal(core.startSession(s, 'yt', at(2026, 11, 3, 0, 1)).ok, true);
});

test('setting the clock back ends a running open and keeps spent opens spent', () => {
  const s = stateWith([group({ opensPerDay: 1 })]);
  core.tick(s, at(2026, 11, 3, 9));
  core.startSession(s, 'yt', at(2026, 11, 3, 9));
  // Clock moves back one day.
  const back = at(2026, 11, 2, 9);
  const fx = core.tick(s, back);
  assert.deepEqual(fx.expired, ['yt']);
  assert.equal(s.lastDay, '2026-11-03');
  assert.equal(core.startSession(s, 'yt', back).ok, false);
});

test('sessions of deleted groups expire', () => {
  const s = stateWith([group()]);
  core.startSession(s, 'yt', T0);
  s.config.groups = [];
  assert.deepEqual(core.expireSessions(s, T0 + 1000), ['yt']);
});

// ---------- tracking and streaks ----------

test('only time on limited sites is kept, and it counts toward the goal', () => {
  const s = stateWith([group()], T0, 1);
  core.recordTime(s, 'www.youtube.com', 50);
  core.recordTime(s, 'github.com', 500);
  const rec = s.days[s.lastDay];
  assert.deepEqual(rec.limited, { yt: 50 });
  assert.equal(JSON.stringify(rec).includes('github'), false);
  assert.equal(rec.failed, false);
  core.recordTime(s, 'm.youtube.com', 11);
  assert.equal(rec.failed, true);
});

test('time on other sites creates no day record', () => {
  const s = stateWith([group()]);
  core.recordTime(s, 'github.com', 500);
  assert.deepEqual(s.days, {});
});

test('flushTracking caps one segment at two minutes', () => {
  const s = stateWith([group()]);
  s.tracking = { host: 'youtube.com', since: T0 };
  assert.equal(core.flushTracking(s, T0 + 30_000), 30);
  assert.equal(s.tracking.since, T0 + 30_000);
  assert.equal(core.flushTracking(s, T0 + 30_000 + 8 * H), 120);
  assert.equal(s.days[s.lastDay].limited.yt, 150);
});

test('lowering the goal during a day does not fail that day', () => {
  const s = stateWith([group()], T0, 60);
  core.recordTime(s, 'youtube.com', 40 * 60);
  core.saveConfig(s, { goalMinutes: 30, groups: [group()] }, T0);
  core.recordTime(s, 'youtube.com', 60);
  assert.equal(s.days[s.lastDay].failed, false);
  // The next day uses the new goal.
  core.tick(s, at(2026, 11, 3, 9));
  core.recordTime(s, 'youtube.com', 31 * 60);
  assert.equal(s.days[s.lastDay].failed, true);
});

test('streak counts finished days under goal and resets on a failed day', () => {
  const s = stateWith([group()], at(2026, 11, 1, 9), 10);
  core.recordTime(s, 'youtube.com', 300);
  core.tick(s, at(2026, 11, 2, 9));
  assert.equal(s.streak.current, 1);
  core.recordTime(s, 'youtube.com', 601);
  core.tick(s, at(2026, 11, 3, 9));
  assert.equal(s.streak.current, 0);
  assert.equal(s.streak.best, 1);
  core.tick(s, at(2026, 11, 6, 9));
  // Days with no browsing count as days under goal.
  assert.equal(s.streak.current, 3);
  assert.equal(s.streak.best, 3);
  assert.equal(s.streak.lastEvaluated, '2026-11-05');
});

test('the install day starts the streak at zero until it ends', () => {
  const s = core.defaultState(T0);
  assert.equal(core.tick(s, T0 + H).dayChanged, false);
  assert.equal(s.streak.current, 0);
});

test('old days are kept for all-time stats', () => {
  const s = stateWith([]);
  s.days['2020-01-01'] = { opens: {}, limited: { yt: 5 }, goal: 60, failed: false, loosened: false };
  core.tick(s, at(2026, 11, 3, 9));
  assert.ok(s.days['2020-01-01']);
});

test('migrate keeps limits, streak, and opens from version 1', () => {
  const v1 = {
    version: 1,
    installedAt: T0 - 72 * H,
    lastDay: '2026-11-02',
    config: { goalMinutes: 45, groups: [{ ...group(), createdAt: T0 - 72 * H }] },
    pending: { config: { goalMinutes: 90, groups: [group()] }, requestedAt: T0 - H, applyAt: T0 + 23 * H },
    sessions: {},
    days: { '2026-11-02': { opens: { yt: 2 }, time: { 'github.com': 99, 'youtube.com': 30 }, limited: { yt: 30 }, failed: false } },
    streak: { current: 5, best: 9, lastEvaluated: '2026-11-01' },
    tracking: { host: 'github.com', since: T0 },
  };
  const s = core.migrate(structuredClone(v1), T0);
  assert.equal(s.streak.current, 5);
  assert.equal(s.config.groups[0].opensPerDay, 3);
  const rec = s.days['2026-11-02'];
  assert.equal(rec.time, undefined);
  assert.deepEqual(rec.opens, { yt: 2 });
  assert.equal(rec.goal, 45);
  assert.equal(rec.loosened, false);
  assert.deepEqual(s.groupMeta, { yt: { name: 'YouTube', slot: 0 } });
  assert.equal(s.tracking, null);
  assert.equal(s.version, core.STATE_VERSION);
  assert.equal(s.config.goalMinutes, 90);
  assert.equal('pending' in s, false, 'the queue is gone');
  // The queued edit predates the streak rule, so it does not reset the streak.
  core.tick(s, T0 + H);
  assert.equal(s.streak.current, 5);
});

test('migrate replaces missing or foreign state', () => {
  assert.equal(core.migrate(undefined, T0).version, core.STATE_VERSION);
  assert.equal(core.migrate({ version: 999 }, T0).config.groups.length, 0);
  const s = core.defaultState(T0);
  assert.equal(core.migrate(s, T0), s);
});

// ---------- rules and gate URLs ----------

test('buildRules blocks groups without a running open', () => {
  const s = stateWith([group(), { id: 'rd', name: 'Reddit', domains: ['reddit.com'], opensPerDay: 1, minutesPerOpen: 5, waitSeconds: 0 }]);
  const gate = 'chrome-extension://abc/src/pages/gate.html';
  let rules = core.buildRules(s, T0, gate);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].condition.requestDomains, ['youtube.com', 'youtu.be']);
  assert.equal(rules[0].action.redirect.regexSubstitution, `${gate}?g=yt&u=\\0`);
  assert.ok(new Set(rules.map((r) => r.id)).size === rules.length);

  core.startSession(s, 'yt', T0);
  rules = core.buildRules(s, T0 + 1000, gate);
  assert.deepEqual(rules.map((r) => r.condition.requestDomains[0]), ['reddit.com']);
  const end = watch(s, 'youtube.com', T0, 10 * 60_000);
  rules = core.buildRules(s, end, gate);
  assert.equal(rules.length, 2);
});

test('gate URLs round-trip targets with their own query strings', () => {
  const gate = 'chrome-extension://abc/src/pages/gate.html';
  const target = 'https://www.youtube.com/watch?v=abc&u=trick&t=10';
  const url = core.gateUrlFor(gate, 'id with space', target, 'expired');
  assert.deepEqual(core.parseGateUrl(url), { groupId: 'id with space', reason: 'expired', target });

  // The shape the network rule produces.
  const fromRule = `${gate}?g=yt&u=${target}`;
  assert.deepEqual(core.parseGateUrl(fromRule), { groupId: 'yt', reason: '', target });
});

test('parseGateUrl refuses targets that are not web pages', () => {
  const gate = 'chrome-extension://abc/src/pages/gate.html';
  assert.equal(core.parseGateUrl(`${gate}?g=yt&u=javascript:alert(1)`).target, '');
  assert.equal(core.parseGateUrl(`${gate}?g=yt`).target, '');
});

// ---------- formatting ----------

test('formatDuration and formatClock', () => {
  assert.equal(core.formatDuration(42), '42s');
  assert.equal(core.formatDuration(600), '10m');
  assert.equal(core.formatDuration(3600), '1h');
  assert.equal(core.formatDuration(5400), '1h 30m');
  assert.equal(core.formatClock(65_000), '1:05');
  assert.equal(core.formatClock(3_725_000), '1:02:05');
});

// ---------- loosening and the streak ----------

function streakState(current = 5) {
  const s = stateWith([group()]);
  s.streak = { current, best: current, lastEvaluated: '2026-11-01' };
  return s;
}

const looser = { goalMinutes: 60, groups: [group({ opensPerDay: 6 })] };
const original = { goalMinutes: 60, groups: [group()] };

test('a looser change resets the streak 3 minutes later', () => {
  const s = streakState();
  core.saveConfig(s, looser, T0);
  core.tick(s, T0 + core.GRACE_MS - 1);
  assert.equal(s.streak.current, 5);
  core.tick(s, T0 + core.GRACE_MS);
  assert.equal(s.streak.current, 0);
  assert.equal(core.stillLoose(s), false);
  // The day of the loosening does not count either.
  core.tick(s, at(2026, 11, 3, 9));
  assert.equal(s.streak.current, 0);
  assert.equal(s.streak.best, 5);
});

test('Undo within 3 minutes keeps the streak', () => {
  const s = streakState();
  core.saveConfig(s, looser, T0);
  core.undoLoosening(s, T0 + 60_000);
  assert.equal(s.config.groups[0].opensPerDay, 3);
  core.tick(s, T0 + core.GRACE_MS + 1);
  core.tick(s, at(2026, 11, 3, 9));
  assert.equal(s.streak.current, 6);
});

test('saving the old values back within 3 minutes keeps the streak', () => {
  const s = streakState();
  core.saveConfig(s, looser, T0);
  core.saveConfig(s, original, T0 + 2 * 60_000);
  core.tick(s, at(2026, 11, 3, 9));
  assert.equal(s.streak.current, 6);
});

test('a raised goal counts as loosening', () => {
  const s = streakState();
  core.saveConfig(s, { goalMinutes: 61, groups: [group()] }, T0);
  core.tick(s, T0 + core.GRACE_MS);
  assert.equal(s.streak.current, 0);
});

test('stricter changes never touch the streak', () => {
  const s = streakState();
  const stricter = { goalMinutes: 30, groups: [group({ opensPerDay: 1, minutesPerOpen: 5, waitSeconds: 60, domains: ['youtube.com', 'youtu.be', 'yt.be'] })] };
  assert.deepEqual(core.saveConfig(s, stricter, T0), { applied: true });
  core.tick(s, at(2026, 11, 3, 9));
  assert.equal(s.streak.current, 6);
});

test('edits to a site inside its free-edit period never touch the streak', () => {
  const s = streakState();
  const reddit = { id: 'rd', name: 'Reddit', domains: ['reddit.com'], opensPerDay: 1, minutesPerOpen: 5, waitSeconds: 5 };
  core.saveConfig(s, { goalMinutes: 60, groups: [group(), reddit] }, T0);
  core.saveConfig(s, { goalMinutes: 60, groups: [group()] }, T0 + 60_000);
  core.tick(s, at(2026, 11, 3, 9));
  assert.equal(s.streak.current, 6);
});

test('a second looser edit does not extend the 3-minute window', () => {
  const s = streakState();
  core.saveConfig(s, looser, T0);
  core.saveConfig(s, { goalMinutes: 60, groups: [group({ opensPerDay: 8 })] }, T0 + 2 * 60_000);
  core.tick(s, T0 + core.GRACE_MS);
  assert.equal(s.streak.current, 0);
});

test('a looser edit left in place while the browser was closed still resets the streak', () => {
  const s = streakState();
  core.saveConfig(s, looser, at(2026, 11, 2, 23, 59));
  // The browser closed before the window ended and opened two days later.
  core.tick(s, at(2026, 11, 4, 9));
  assert.equal(s.streak.current, 0);
  assert.equal(s.days['2026-11-03'].loosened, true);
});

// ---------- allotment and group memory ----------

test('allottedMinutes sums opens times minutes', () => {
  const groups = [group({ opensPerDay: 3, minutesPerOpen: 10 }), group({ id: 'b', opensPerDay: 2, minutesPerOpen: 15 })];
  assert.equal(core.allottedMinutes({ groups }), 60);
  assert.equal(core.allottedMinutes({ groups: [] }), 0);
});

test('groups keep their name and color slot after removal', () => {
  const s = stateWith([]);
  const reddit = { id: 'rd', name: 'Reddit', domains: ['reddit.com'], opensPerDay: 1, minutesPerOpen: 5, waitSeconds: 5 };
  core.saveConfig(s, { goalMinutes: 60, groups: [group(), reddit] }, T0);
  core.saveConfig(s, { goalMinutes: 60, groups: [reddit] }, T0 + 60_000);
  core.saveConfig(s, { goalMinutes: 60, groups: [{ ...reddit, name: 'Reddit!' }] }, T0 + 120_000);
  assert.deepEqual(s.groupMeta, { yt: { name: 'YouTube', slot: 0 }, rd: { name: 'Reddit!', slot: 1 } });
});

// ---------- goal changes apply at once ----------

test('a raised goal applies today and resets the streak unless lowered within 3 minutes', () => {
  const s = streakState();
  core.saveConfig(s, { goalMinutes: 120, groups: [group()] }, T0);
  assert.equal(s.config.goalMinutes, 120);
  assert.equal(core.dayGoalMinutes(s, s.lastDay), 120);
  assert.ok(core.stillLoose(s));
  core.saveConfig(s, original, T0 + 2 * 60_000);
  assert.equal(core.stillLoose(s), false);
  core.tick(s, at(2026, 11, 3, 9));
  assert.equal(s.streak.current, 6);
});

test('time used under a raised goal fails the day once the goal goes back', () => {
  const s = streakState();
  core.saveConfig(s, { goalMinutes: 120, groups: [group()] }, T0);
  core.recordTime(s, 'youtube.com', 90 * 60);
  assert.equal(s.days[s.lastDay].failed, false);
  core.saveConfig(s, original, T0 + 2 * 60_000);
  assert.equal(s.days[s.lastDay].failed, true);
});

test('undoLoosening restores the goal and limits, and keeps later tightenings', () => {
  const s = streakState();
  core.saveConfig(s, { goalMinutes: 90, groups: [group({ opensPerDay: 9, waitSeconds: 60 })] }, T0);
  const tt = { id: 'tt', name: 'TikTok', domains: ['tiktok.com'], opensPerDay: 1, minutesPerOpen: 5, waitSeconds: 5 };
  core.saveConfig(s, { goalMinutes: 90, groups: [group({ opensPerDay: 9, waitSeconds: 60 }), tt] }, T0 + 60_000);
  core.undoLoosening(s, T0 + 2 * 60_000);
  assert.equal(s.config.goalMinutes, 60);
  assert.equal(s.config.groups[0].opensPerDay, 3);
  assert.equal(s.config.groups[0].waitSeconds, 60, 'the longer wait stays');
  assert.equal(core.stillLoose(s), false);
  const added = s.config.groups.find((g) => g.id === 'tt');
  assert.equal(added.createdAt, T0 + 60_000, 'undo does not restart its free-edit period');
  core.tick(s, at(2026, 11, 3, 9));
  assert.equal(s.streak.current, 6);
});

test('undoLoosening brings back a removed site, and it keeps its access until then', () => {
  const s = streakState();
  const created = s.config.groups[0].createdAt;
  core.saveConfig(s, { goalMinutes: 60, groups: [] }, T0);
  assert.equal(s.config.groups.length, 0);
  assert.deepEqual(core.unusedOrigins(s, ['*://*.youtube.com/*']), [], 'Undo still needs this access');
  core.undoLoosening(s, T0 + 60_000);
  assert.equal(s.config.groups.length, 1);
  assert.equal(s.config.groups[0].createdAt, created);
  assert.equal(core.stillLoose(s), false);
});

test('access for a removed site goes once the window has ended', () => {
  const s = streakState();
  core.saveConfig(s, { goalMinutes: 60, groups: [] }, T0);
  assert.equal(core.tick(s, T0 + core.GRACE_MS).configChanged, true, 'the worker releases access on this signal');
  assert.deepEqual(core.unusedOrigins(s, ['*://*.youtube.com/*']), ['*://*.youtube.com/*']);
  assert.equal(s.streak.current, 0);
});

test('lowering the goal never opens a loosening window', () => {
  const s = streakState();
  core.saveConfig(s, { goalMinutes: 10, groups: [group()] }, T0);
  assert.equal(core.stillLoose(s), false);
  assert.equal(s.config.goalMinutes, 10);
});

// ---------- an open only runs on the active tab ----------

test('an open pauses while its site is not the active tab', () => {
  const s = stateWith([group({ minutesPerOpen: 10 })]);
  core.startSession(s, 'yt', T0);
  const sess = s.sessions.yt;

  // Ten minutes on another site: no time used.
  watch(s, 'github.com', T0, 10 * 60_000);
  assert.equal(core.sessionRemaining(sess, T0 + 10 * 60_000), 10 * 60_000);
  assert.ok(core.activeSession(s, 'yt', T0 + 10 * 60_000));

  // Four minutes on the site.
  const t = watch(s, 'm.youtube.com', T0 + 10 * 60_000, 4 * 60_000);
  assert.equal(core.sessionRemaining(sess, t), 6 * 60_000);

  // A long gap with no tab tracked: still paused.
  assert.equal(core.sessionRemaining(sess, t + 5 * H), 6 * 60_000);
});

test('a running open counts live time between syncs', () => {
  const s = stateWith([group()]);
  core.startSession(s, 'yt', T0);
  s.tracking = { host: 'youtube.com', since: T0 };
  core.syncSessions(s, T0);
  assert.equal(core.sessionRemaining(s.sessions.yt, T0 + 30_000), 10 * 60_000 - 30_000);
});

test('a running open never counts more than two minutes without a sync', () => {
  const s = stateWith([group()]);
  core.startSession(s, 'yt', T0);
  s.tracking = { host: 'youtube.com', since: T0 };
  core.syncSessions(s, T0);
  // The computer slept for eight hours with the site open.
  core.syncSessions(s, T0 + 8 * H);
  assert.equal(s.sessions.yt.usedMs, core.SEGMENT_CAP_MS);
});

test('only the open for the active site runs', () => {
  const rd = { id: 'rd', name: 'Reddit', domains: ['reddit.com'], opensPerDay: 1, minutesPerOpen: 5, waitSeconds: 0 };
  const s = stateWith([group(), rd]);
  core.startSession(s, 'yt', T0);
  core.startSession(s, 'rd', T0);
  watch(s, 'reddit.com', T0, 3 * 60_000);
  assert.equal(s.sessions.yt.usedMs, 0);
  assert.equal(s.sessions.rd.usedMs, 3 * 60_000);
});

test('migrate from version 2 converts opens and applies a queued edit', () => {
  const v2 = core.defaultState(T0);
  v2.version = 2;
  delete v2.change;
  v2.config = { goalMinutes: 30, groups: [{ ...group(), createdAt: T0 - 48 * H }] };
  v2.pending = { config: { goalMinutes: 45, groups: [group({ opensPerDay: 5 })] }, requestedAt: T0 - 60_000, applyAt: T0 + 23 * H, looseSince: T0 - 60_000, streakReset: false };
  v2.sessions = { yt: { start: T0 - 60_000, end: T0 + 4 * 60_000 } };
  const s = core.migrate(v2, T0);
  assert.equal(s.version, core.STATE_VERSION);
  assert.equal(s.config.goalMinutes, 45);
  assert.equal(s.config.groups[0].opensPerDay, 5);
  assert.equal('pending' in s, false);
  assert.equal(s.change.since, T0 - 60_000);
  assert.equal(s.change.base.goalMinutes, 30);
  assert.equal(s.change.base.groups[0].opensPerDay, 3);
  assert.deepEqual(s.sessions.yt, { start: T0 - 60_000, limitMs: 4 * 60_000, usedMs: 0, activeSince: null });
});

test('migrate from version 3 applies a queued edit and keeps the streak window', () => {
  const created = T0 - 48 * H;
  const v3 = core.defaultState(T0);
  v3.version = 3;
  delete v3.change;
  v3.streak.current = 7;
  v3.config = { goalMinutes: 60, groups: [{ ...group(), createdAt: created }] };
  v3.pending = { config: { goalMinutes: 60, groups: [group({ opensPerDay: 8 })] }, requestedAt: T0 - 60_000, applyAt: T0 + 23 * H };
  v3.loose = { since: T0 - 60_000, baseGoal: 60, basePending: null };
  const s = core.migrate(v3, T0);
  assert.equal(s.version, core.STATE_VERSION);
  assert.equal(s.config.groups[0].opensPerDay, 8);
  assert.equal(s.config.groups[0].createdAt, created);
  assert.equal('pending' in s, false);
  assert.ok(core.stillLoose(s), 'the edit that was queued still counts as looser');
  core.undoLoosening(s, T0);
  assert.equal(s.config.groups[0].opensPerDay, 3);
});

test('migrate from version 3 with nothing queued changes no limits', () => {
  const v3 = core.defaultState(T0);
  v3.version = 3;
  delete v3.change;
  v3.pending = null;
  v3.config = { goalMinutes: 45, groups: [{ ...group(), createdAt: T0 - 48 * H }] };
  const s = core.migrate(structuredClone(v3), T0);
  assert.deepEqual(s.config, v3.config);
  assert.equal(core.stillLoose(s), false);
});

// ---------- site access ----------

test('originsFor makes one pattern per domain that covers subdomains', () => {
  assert.deepEqual(core.originsFor(['youtube.com', 'youtu.be', 'youtube.com']), ['*://*.youtube.com/*', '*://*.youtu.be/*']);
});

test('domainCovered matches the patterns Brave grants', () => {
  assert.equal(core.domainCovered(['*://*.youtube.com/*'], 'youtube.com'), true);
  assert.equal(core.domainCovered(['*://*.youtube.com/*'], 'm.youtube.com'), true);
  assert.equal(core.domainCovered(['*://*.youtube.com/*'], 'notyoutube.com'), false);
  assert.equal(core.domainCovered(['*://*.test/*'], 'blocked.test'), true);
  assert.equal(core.domainCovered(['*://*/*'], 'anything.org'), true);
  assert.equal(core.domainCovered(['<all_urls>'], 'anything.org'), true);
  assert.equal(core.domainCovered(['https://*.youtube.com/*'], 'youtube.com'), false, 'http must be covered too');
  assert.equal(core.domainCovered([], 'youtube.com'), false);
});

test('unusedOrigins lists access no saved site or open undo window needs', () => {
  const s = stateWith([group()]);
  const rd = { id: 'rd', name: 'Reddit', domains: ['reddit.com'], opensPerDay: 1, minutesPerOpen: 5, waitSeconds: 0 };
  s.change = { since: T0, base: { goalMinutes: 60, groups: [group(), rd] } };
  const granted = ['*://*.youtube.com/*', '*://*.youtu.be/*', '*://*.reddit.com/*', '*://*.tiktok.com/*', '*://*/*'];
  assert.deepEqual(core.unusedOrigins(s, granted), ['*://*.tiktok.com/*']);
});

test('domains without access get a plain block that holds even during an open', () => {
  const s = stateWith([group()]);
  const canSee = (d) => d === 'youtube.com';
  let rules = core.buildRules(s, T0, 'chrome-extension://abc/gate.html', canSee);
  assert.deepEqual(rules.map((r) => [r.action.type, r.condition.requestDomains]), [
    ['redirect', ['youtube.com']],
    ['block', ['youtu.be']],
  ]);
  core.startSession(s, 'yt', T0);
  rules = core.buildRules(s, T0 + 1000, 'chrome-extension://abc/gate.html', canSee);
  assert.deepEqual(rules.map((r) => [r.action.type, r.condition.requestDomains]), [['block', ['youtu.be']]]);
  assert.equal(new Set(core.buildRules(stateWith([group(), { ...group(), id: 'b' }]), T0, 'x', () => false).map((r) => r.id)).size, 2);
});

// ---------- changing your mind after a tightening ----------

const M = 60_000;
const edit = (s, over, now, goalMinutes = 60) => core.saveConfig(s, { goalMinutes, groups: [group(over)] }, now);

test('a dropped limit can go back within 3 minutes with no streak risk', () => {
  const s = stateWith([group()]);
  s.streak.current = 12;
  edit(s, { opensPerDay: 2 }, T0);
  assert.equal(s.config.groups[0].opensPerDay, 2, 'the drop applies at once');
  edit(s, { opensPerDay: 3 }, T0 + 2 * M);
  assert.equal(s.config.groups[0].opensPerDay, 3);
  assert.equal(core.stillLoose(s), false);
  core.settleLoosening(s, T0 + 30 * M);
  assert.equal(s.streak.current, 12);
});

test('raising a drop after 3 minutes counts as looser, and it applies at once', () => {
  const s = stateWith([group()]);
  edit(s, { opensPerDay: 2 }, T0);
  edit(s, { opensPerDay: 3 }, T0 + core.GRACE_MS);
  assert.equal(s.config.groups[0].opensPerDay, 3);
  assert.equal(s.change.since, T0 + core.GRACE_MS);
  assert.equal(s.change.base.groups[0].opensPerDay, 2);
});

test('the window never reaches past the starting values', () => {
  const s = stateWith([group()]);
  edit(s, { opensPerDay: 2 }, T0);
  edit(s, { opensPerDay: 5 }, T0 + 60_000);
  assert.equal(s.config.groups[0].opensPerDay, 5);
  assert.equal(s.change.base.groups[0].opensPerDay, 3, 'measured from the start, not the drop');
  core.undoLoosening(s, T0 + 2 * 60_000);
  assert.equal(s.config.groups[0].opensPerDay, 3);
});

test('more drops do not extend the window or move its starting values', () => {
  const s = stateWith([group({ opensPerDay: 5 })]);
  edit(s, { opensPerDay: 4 }, T0);
  edit(s, { opensPerDay: 3 }, T0 + 2 * M);
  edit(s, { opensPerDay: 4 }, T0 + 2.5 * M);
  assert.equal(core.stillLoose(s), false, 'a partial step back is free');
  assert.equal(s.change.since, T0);
  edit(s, { opensPerDay: 5 }, T0 + 4 * M);
  assert.ok(core.stillLoose(s), 'the window ended 3 minutes after the first drop');
});

test('going all the way back closes the window, and the next drop gets its own', () => {
  const s = stateWith([group()]);
  edit(s, { opensPerDay: 2 }, T0);
  edit(s, { opensPerDay: 3 }, T0 + M);
  assert.equal(s.change, null);
  edit(s, { opensPerDay: 2 }, T0 + 20 * M);
  edit(s, { opensPerDay: 3 }, T0 + 22 * M);
  assert.equal(s.config.groups[0].opensPerDay, 3);
  assert.equal(core.stillLoose(s), false);
});

test('going up, back down, and up again counts as looser', () => {
  const s = stateWith([group()]);
  s.streak.current = 12;
  edit(s, { opensPerDay: 4 }, T0);
  edit(s, { opensPerDay: 3 }, T0 + M);
  edit(s, { opensPerDay: 4 }, T0 + 2 * M);
  assert.ok(core.stillLoose(s));
  assert.equal(core.looseDeadline(s), T0 + 2 * M + core.GRACE_MS);
  core.tick(s, T0 + 2 * M + core.GRACE_MS);
  assert.equal(s.streak.current, 0);
});

test('going up, below the start, and up again keeps the original start', () => {
  const s = stateWith([group()]);
  edit(s, { opensPerDay: 4 }, T0);
  edit(s, { opensPerDay: 2 }, T0 + M);
  assert.equal(core.stillLoose(s), false);
  edit(s, { opensPerDay: 4 }, T0 + 2 * M);
  assert.ok(core.stillLoose(s));
  assert.equal(s.change.base.groups[0].opensPerDay, 3);
});

test('a looser edit late in a window gets the full 3 minutes to undo', () => {
  const s = stateWith([group()]);
  edit(s, { opensPerDay: 2 }, T0);
  edit(s, { opensPerDay: 5 }, T0 + 2 * M);
  assert.equal(core.looseDeadline(s), T0 + 2 * M + core.GRACE_MS);
});

test('nothing is at risk after a stricter change', () => {
  const s = stateWith([group()]);
  edit(s, { opensPerDay: 2 }, T0);
  assert.equal(core.looseDeadline(s), null);
});

test('minutes, wait, and an added domain can go back too', () => {
  const s = stateWith([group()]);
  edit(s, { minutesPerOpen: 5, waitSeconds: 30, domains: ['youtube.com', 'youtu.be', 'yt.be'] }, T0);
  assert.equal(s.config.groups[0].domains.length, 3);
  edit(s, {}, T0 + M);
  const g = s.config.groups[0];
  assert.equal(g.minutesPerOpen, 10);
  assert.equal(g.waitSeconds, 10);
  assert.deepEqual(g.domains, ['youtube.com', 'youtu.be']);
});

test('dropping a domain from before the window still counts as looser', () => {
  const s = stateWith([group()]);
  edit(s, { opensPerDay: 2 }, T0);
  edit(s, { opensPerDay: 2, domains: ['youtube.com'] }, T0 + M);
  assert.deepEqual(s.config.groups[0].domains, ['youtube.com']);
  assert.ok(core.stillLoose(s));
});

test('a lowered goal can go back within 3 minutes', () => {
  const s = stateWith([group()]);
  s.streak.current = 12;
  edit(s, {}, T0, 45);
  edit(s, {}, T0 + M, 60);
  assert.equal(s.config.goalMinutes, 60);
  assert.equal(core.stillLoose(s), false);
  core.settleLoosening(s, T0 + 30 * M);
  assert.equal(s.streak.current, 12);
});

test('raising the goal past its starting value still counts as loosening', () => {
  const s = stateWith([group()]);
  edit(s, {}, T0, 45);
  edit(s, {}, T0 + M, 90);
  assert.ok(core.stillLoose(s));
  assert.equal(s.change.base.goalMinutes, 60);
});

test('setting the clock back closes the window', () => {
  const s = stateWith([group()]);
  edit(s, { opensPerDay: 2 }, T0);
  edit(s, { opensPerDay: 3 }, T0 - H);
  assert.ok(core.stillLoose(s), 'raising it counts as looser');
});

test('going back does not refund opens already used', () => {
  const s = stateWith([group()]);
  s.days[s.lastDay] = { opens: { yt: 2 }, limited: {}, goal: 60, failed: false, loosened: false };
  edit(s, { opensPerDay: 2 }, T0);
  assert.equal(core.opensLeft(s, s.config.groups[0]), 0);
  edit(s, { opensPerDay: 3 }, T0 + M);
  assert.equal(core.opensLeft(s, s.config.groups[0]), 1);
});

test('the page cannot set the window itself', () => {
  const s = stateWith([group()]);
  core.saveConfig(s, { goalMinutes: 60, change: { since: T0, base: { goalMinutes: 999, groups: [] } }, groups: [group()] }, T0);
  assert.equal(s.change, null);
});

test('migrate from version 4 keeps an open window and drops the rest', () => {
  const v4 = stateWith([group({ opensPerDay: 5 })]);
  v4.version = 4;
  delete v4.change;
  v4.loose = { since: T0, base: { goalMinutes: 60, groups: [group()] } };
  v4.tight = { since: T0, config: { goalMinutes: 60, groups: [group()] } };
  const s = core.migrate(v4, T0);
  assert.equal(s.version, core.STATE_VERSION);
  assert.equal('loose' in s, false);
  assert.equal('tight' in s, false);
  assert.ok(core.stillLoose(s));
});
