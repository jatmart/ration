// Time on limited sites over a range, grouped into day, month, or year bars.
// Pure functions: no browser calls.
import { addDays, limitedSeconds } from './core.js';

export const RANGES = [
  { id: 'week', label: 'Week', title: 'last 7 days' },
  { id: 'month', label: 'Month', title: 'last 30 days' },
  { id: 'year', label: 'Year', title: 'last 12 months' },
  { id: 'ytd', label: 'YTD', title: 'this year so far' },
  { id: 'all', label: 'All time', title: 'since install' },
];

function shiftMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1, 12);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export function daysBetween(start, end) {
  const [a, b] = [start, end].map((k) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  });
  return Math.round((b - a) / 86_400_000) + 1;
}

// First day with any data, or the install day, whichever is earlier.
export function firstDay(state) {
  const install = new Date(state.installedAt);
  let first = `${install.getFullYear()}-${String(install.getMonth() + 1).padStart(2, '0')}-${String(install.getDate()).padStart(2, '0')}`;
  for (const k of Object.keys(state.days)) if (k < first) first = k;
  return first;
}

export function rangeBounds(range, today, first) {
  let start;
  if (range === 'week') start = addDays(today, -6);
  else if (range === 'month') start = addDays(today, -29);
  else if (range === 'year') start = shiftMonths(today, -11);
  else if (range === 'ytd') start = `${today.slice(0, 4)}-01-01`;
  else start = first;
  return { start, end: today };
}

// Day bars up to a month, month bars up to two years, then year bars.
export function bucketUnit(range, start, end) {
  if (range === 'week' || range === 'month') return 'day';
  if (range === 'year') return 'month';
  const span = daysBetween(start, end);
  if (span <= 31) return 'day';
  if (span <= 731) return 'month';
  return 'year';
}

function bucketKey(day, unit) {
  if (unit === 'day') return day;
  if (unit === 'month') return day.slice(0, 7);
  return day.slice(0, 4);
}

// Returns bars and totals for the range.
// Each bar: { key, unit, start, end, days, byGroup: { id: seconds }, total }.
export function aggregate(state, range, today) {
  const first = firstDay(state);
  const { start, end } = rangeBounds(range, today, first);
  const unit = bucketUnit(range, start, end);

  const buckets = [];
  const byKey = new Map();
  const byGroup = {};
  const opens = {};
  let total = 0;
  let daysJudged = 0;
  let daysUnder = 0;
  let bestDay = null;

  // Walk every day so empty days still get a bar.
  let d = start;
  for (let i = 0; d <= end && i < 40_000; i++, d = addDays(d, 1)) {
    const key = bucketKey(d, unit);
    let b = byKey.get(key);
    if (!b) {
      b = { key, unit, start: d, end: d, days: 0, byGroup: {}, total: 0 };
      byKey.set(key, b);
      buckets.push(b);
    }
    b.end = d;
    b.days += 1;
    const rec = state.days[d];
    if (rec) {
      for (const [id, s] of Object.entries(rec.limited || {})) {
        b.byGroup[id] = (b.byGroup[id] || 0) + s;
        byGroup[id] = (byGroup[id] || 0) + s;
      }
      for (const [id, n] of Object.entries(rec.opens || {})) opens[id] = (opens[id] || 0) + n;
      const sec = limitedSeconds(rec);
      b.total += sec;
      total += sec;
      if (!bestDay || sec > bestDay.seconds) bestDay = { day: d, seconds: sec };
    }
    // Finished days since install count toward "days under goal".
    if (d < today && d >= first) {
      daysJudged += 1;
      if (!rec || (!rec.failed && !rec.loosened)) daysUnder += 1;
    }
  }

  // Days before install have no data, so they do not lower the average.
  const dayCount = daysBetween(start < first ? first : start, end);
  return {
    range,
    unit,
    start,
    end,
    buckets,
    byGroup,
    opens,
    total,
    avgPerDay: total / Math.max(1, dayCount),
    daysJudged,
    daysUnder,
    bestDay,
  };
}
