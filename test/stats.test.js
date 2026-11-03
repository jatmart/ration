import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/lib/core.js';
import * as stats from '../src/lib/stats.js';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const TODAY = '2026-11-02';

// A state installed on `installDay` with `days` of history.
function stateWith(days, installDay = '2026-01-01') {
  const [y, m, d] = installDay.split('-').map(Number);
  const s = core.defaultState(at(y, m, d));
  s.lastDay = TODAY;
  for (const [k, rec] of Object.entries(days)) {
    s.days[k] = { opens: {}, limited: {}, goal: 60, failed: false, loosened: false, ...rec };
  }
  return s;
}

test('week has seven day bars ending today', () => {
  const s = stateWith({ '2026-11-02': { limited: { a: 60 } }, '2026-10-27': { limited: { a: 30, b: 30 } }, '2026-10-26': { limited: { a: 999 } } });
  const r = stats.aggregate(s, 'week', TODAY);
  assert.equal(r.unit, 'day');
  assert.equal(r.buckets.length, 7);
  assert.equal(r.buckets[0].key, '2026-10-27');
  assert.equal(r.buckets[6].key, TODAY);
  assert.equal(r.total, 120);
  assert.deepEqual(r.byGroup, { a: 90, b: 30 });
  assert.equal(r.bestDay.day, '2026-10-27');
});

test('month has thirty day bars', () => {
  const r = stats.aggregate(stateWith({}), 'month', TODAY);
  assert.equal(r.buckets.length, 30);
  assert.equal(r.buckets[0].key, '2026-10-04');
});

test('year has twelve month bars, the current month last', () => {
  const s = stateWith({ '2025-12-15': { limited: { a: 100 } }, '2025-12-16': { limited: { a: 50 } }, '2025-11-30': { limited: { a: 7 } } }, '2025-01-01');
  const r = stats.aggregate(s, 'year', TODAY);
  assert.equal(r.unit, 'month');
  assert.equal(r.buckets.length, 12);
  assert.equal(r.buckets[0].key, '2025-12');
  assert.equal(r.buckets[0].total, 150);
  assert.equal(r.buckets[0].days, 31);
  assert.equal(r.buckets[11].key, '2026-11');
  assert.equal(r.buckets[11].days, 2);
  assert.equal(r.total, 150);
});

test('YTD starts on January 1', () => {
  const s = stateWith({ '2025-12-31': { limited: { a: 100 } }, '2026-01-01': { limited: { a: 5 } } }, '2025-06-01');
  const r = stats.aggregate(s, 'ytd', TODAY);
  assert.equal(r.start, '2026-01-01');
  assert.equal(r.unit, 'month');
  assert.equal(r.buckets.length, 11);
  assert.equal(r.total, 5);
});

test('YTD in early January uses day bars', () => {
  const s = stateWith({});
  const r = stats.aggregate(s, 'ytd', '2026-01-05');
  assert.equal(r.unit, 'day');
  assert.equal(r.buckets.length, 5);
});

test('all time starts at install, or earlier data', () => {
  const s = stateWith({ '2026-10-20': { limited: { a: 60 } } }, '2026-10-15');
  let r = stats.aggregate(s, 'all', TODAY);
  assert.equal(r.start, '2026-10-15');
  assert.equal(r.unit, 'day');
  s.days['2023-03-03'] = { opens: {}, limited: { a: 1 }, goal: 60, failed: false, loosened: false };
  r = stats.aggregate(s, 'all', TODAY);
  assert.equal(r.start, '2023-03-03');
  assert.equal(r.unit, 'year');
  assert.deepEqual(r.buckets.map((b) => b.key), ['2023', '2024', '2025', '2026']);
  assert.equal(r.total, 61);
});

test('averages skip days before install', () => {
  const s = stateWith({ '2026-11-01': { limited: { a: 600 } }, '2026-11-02': { limited: { a: 600 } } }, '2026-11-01');
  const r = stats.aggregate(s, 'week', TODAY);
  assert.equal(r.avgPerDay, 600);
});

test('days under goal count finished days since install only', () => {
  const s = stateWith(
    {
      '2026-10-30': { failed: true },
      '2026-10-31': { loosened: true },
      '2026-11-01': { limited: { a: 60 } },
      '2026-11-02': { failed: true },
    },
    '2026-10-29',
  );
  const r = stats.aggregate(s, 'week', TODAY);
  // Oct 29 (no data), Oct 30 (over), Oct 31 (loosened), Nov 1 (under). Today is unfinished.
  assert.equal(r.daysJudged, 4);
  assert.equal(r.daysUnder, 2);
});

test('opens add up per site over the range', () => {
  const s = stateWith({ '2026-11-01': { opens: { a: 2 } }, '2026-11-02': { opens: { a: 1, b: 3 } } });
  assert.deepEqual(stats.aggregate(s, 'week', TODAY).opens, { a: 3, b: 3 });
});

test('daysBetween counts both ends', () => {
  assert.equal(stats.daysBetween('2026-11-01', '2026-11-01'), 1);
  assert.equal(stats.daysBetween('2026-01-01', '2026-12-31'), 365);
  assert.equal(stats.daysBetween('2026-03-07', '2026-03-09'), 3);
});
