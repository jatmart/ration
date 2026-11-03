// Pure state logic. No chrome.* calls here, so Node tests can import this file.

export const STATE_VERSION = 3;
export const PENDING_DELAY_MS = 24 * 60 * 60 * 1000;
// New sites stay free to edit for this long. A loosening edit undone
// within this long keeps the streak.
export const GRACE_MS = 10 * 60 * 1000;
// One tracked segment never adds more than this. The minute alarm flushes
// tracking, so a longer gap means the computer slept or the browser closed.
export const SEGMENT_CAP_MS = 2 * 60 * 1000;

export const LIMITS = {
  opensPerDay: { min: 0, max: 50 },
  minutesPerOpen: { min: 1, max: 240 },
  waitSeconds: { min: 0, max: 300 },
  goalMinutes: { min: 0, max: 1440 },
};

// ---------- days ----------

const pad = (n) => String(n).padStart(2, '0');

export function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  // Noon avoids DST edges, where local midnight can repeat or vanish.
  return localDayKey(new Date(y, m - 1, d + n, 12).getTime());
}

export function nextMidnight(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

// ---------- domains ----------

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

// Turns "https://www.YouTube.com/watch?v=1" into "youtube.com".
// Returns null for input that is not a domain.
export function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.replace(/^[^@]*@/, '');
  s = s.replace(/:\d+$/, '');
  s = s.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  return DOMAIN_RE.test(s) ? s : null;
}

export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

export function displayHost(host) {
  return host.replace(/^www\./, '');
}

export function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

export function groupForHost(config, host) {
  if (!host) return null;
  return config.groups.find((g) => g.domains.some((d) => hostMatches(host, d))) || null;
}

export function groupForUrl(config, url) {
  return groupForHost(config, hostOf(url));
}

// ---------- config ----------

function clampInt(v, { min, max }, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function cleanGroup(raw) {
  const domains = [];
  for (const d of Array.isArray(raw.domains) ? raw.domains : []) {
    const n = normalizeDomain(d);
    if (n && !domains.includes(n)) domains.push(n);
  }
  return {
    id: String(raw.id || '').slice(0, 64),
    name: String(raw.name || domains[0] || 'Untitled').trim().slice(0, 60) || 'Untitled',
    domains,
    opensPerDay: clampInt(raw.opensPerDay, LIMITS.opensPerDay, 3),
    minutesPerOpen: clampInt(raw.minutesPerOpen, LIMITS.minutesPerOpen, 10),
    waitSeconds: clampInt(raw.waitSeconds, LIMITS.waitSeconds, 10),
  };
}

// Strips anything the page should not control, such as createdAt.
export function cleanConfig(raw) {
  const groups = [];
  const seen = new Set();
  for (const g of Array.isArray(raw?.groups) ? raw.groups : []) {
    const c = cleanGroup(g);
    if (!c.id || seen.has(c.id) || c.domains.length === 0) continue;
    seen.add(c.id);
    groups.push(c);
  }
  return {
    goalMinutes: clampInt(raw?.goalMinutes, LIMITS.goalMinutes, 60),
    groups,
  };
}

const union = (a, b) => [...a, ...b.filter((x) => !a.includes(x))];

// Returns the strictest mix of `active` and `desired`:
// every change that tightens a limit, and none that loosens one.
// A group still inside its grace period takes `desired` as-is.
// The daily goal is not a limit: it always takes `desired`.
export function tightenConfig(active, desired, now, { grace = true } = {}) {
  const inGrace = (g) => grace && g.createdAt != null && now - g.createdAt < GRACE_MS;
  const activeById = new Map(active.groups.map((g) => [g.id, g]));
  const desiredIds = new Set(desired.groups.map((g) => g.id));
  const groups = [];

  for (const d of desired.groups) {
    const a = activeById.get(d.id);
    if (!a) {
      groups.push({ ...d, createdAt: now });
    } else if (inGrace(a)) {
      groups.push({ ...d, createdAt: a.createdAt });
    } else {
      groups.push({
        id: a.id,
        name: d.name,
        createdAt: a.createdAt,
        domains: union(a.domains, d.domains),
        opensPerDay: Math.min(a.opensPerDay, d.opensPerDay),
        minutesPerOpen: Math.min(a.minutesPerOpen, d.minutesPerOpen),
        waitSeconds: Math.max(a.waitSeconds, d.waitSeconds),
      });
    }
  }
  for (const a of active.groups) {
    if (!desiredIds.has(a.id) && !inGrace(a)) groups.push(a);
  }
  return {
    goalMinutes: desired.goalMinutes,
    groups,
  };
}

// Compares the parts of two configs that change enforcement.
// Names, order, and createdAt do not count.
export function sameRules(a, b) {
  if (a.goalMinutes !== b.goalMinutes) return false;
  if (a.groups.length !== b.groups.length) return false;
  const byId = new Map(b.groups.map((g) => [g.id, g]));
  for (const g of a.groups) {
    const o = byId.get(g.id);
    if (!o) return false;
    if (g.opensPerDay !== o.opensPerDay) return false;
    if (g.minutesPerOpen !== o.minutesPerOpen) return false;
    if (g.waitSeconds !== o.waitSeconds) return false;
    if ([...g.domains].sort().join() !== [...o.domains].sort().join()) return false;
  }
  return true;
}

// Returns true when `b` loosens nothing compared with `a`.
export function atLeastAsStrict(b, a) {
  return sameRules(tightenConfig(a, b, 0, { grace: false }), b);
}

// Saves an edit. Tighter limits and any goal change apply now.
// Looser limits wait PENDING_DELAY_MS.
// Returns { applied: boolean, pending: boolean }.
export function saveConfig(state, rawDesired, now) {
  const desired = cleanConfig(rawDesired);
  const prevPending = state.pending;
  const prevGoal = state.config.goalMinutes;
  // Pin today's starting goal before the goal changes, so a goal raised
  // and then lowered cannot become today's starting goal.
  if (desired.goalMinutes !== prevGoal) dayRecord(state, state.lastDay);
  const next = tightenConfig(state.config, desired, now);
  const changed = !sameRules(state.config, next) || namesDiffer(state.config, next);
  state.config = next;

  rememberGroups(state, next);
  rememberGroups(state, desired);

  let limitsLoosened = false;
  if (sameRules(next, desired)) {
    state.pending = null;
  } else {
    // A new edit that is no looser than the queued one keeps its timer.
    // A looser edit restarts the wait.
    const keepTimer = prevPending && atLeastAsStrict(desired, prevPending.config);
    limitsLoosened = !keepTimer;
    state.pending = {
      config: desired,
      requestedAt: keepTimer ? prevPending.requestedAt : now,
      applyAt: keepTimer ? prevPending.applyAt : now + PENDING_DELAY_MS,
    };
  }

  // Open a 10-minute window on the first loosening. A later loosening
  // inside the window does not restart it.
  if ((limitsLoosened || desired.goalMinutes > prevGoal) && !state.loose) {
    state.loose = {
      since: now,
      baseGoal: prevGoal,
      basePending: prevPending ? structuredClone(prevPending) : null,
    };
  }
  closeLooseIfUndone(state);
  markFailedIfOver(state);
  return { applied: changed, pending: !!state.pending };
}

// True while anything is looser than it was when the window opened.
export function stillLoose(state) {
  const w = state.loose;
  if (!w) return false;
  if (state.config.goalMinutes > w.baseGoal) return true;
  if (!state.pending) return false;
  return !w.basePending || !atLeastAsStrict(state.pending.config, w.basePending.config);
}

function closeLooseIfUndone(state) {
  if (state.loose && !stillLoose(state)) state.loose = null;
}

// Puts back everything the open window loosened. Keeps later tightenings.
export function undoLoosening(state, now) {
  const w = state.loose;
  if (!w) return false;
  if (state.config.goalMinutes > w.baseGoal) state.config.goalMinutes = w.baseGoal;
  if (state.pending) {
    if (!w.basePending) {
      state.pending = null;
    } else {
      const merged = tightenConfig(w.basePending.config, state.pending.config, now, { grace: false });
      merged.goalMinutes = state.config.goalMinutes;
      merged.groups = merged.groups.map(({ createdAt, ...g }) => g);
      state.pending = sameRules(merged, state.config)
        ? null
        : { config: merged, requestedAt: w.basePending.requestedAt, applyAt: w.basePending.applyAt };
    }
  }
  closeLooseIfUndone(state);
  markFailedIfOver(state);
  return true;
}

// Keeps a name and a fixed color slot for every group ever saved,
// so history still shows deleted sites with the same color.
export function rememberGroups(state, config) {
  for (const g of config.groups) {
    const meta = state.groupMeta[g.id];
    if (meta) meta.name = g.name;
    else state.groupMeta[g.id] = { name: g.name, slot: Object.keys(state.groupMeta).length };
  }
}

// The most time the current limits allow in one day, in minutes.
export function allottedMinutes(config) {
  return config.groups.reduce((a, g) => a + g.opensPerDay * g.minutesPerOpen, 0);
}

// When the window closes, anything still looser resets the streak,
// and the day the window closed cannot count toward the streak.
export function settleLoosening(state, now) {
  const w = state.loose;
  if (!w || now < w.since + GRACE_MS) return false;
  const reset = stillLoose(state);
  if (reset) {
    let day = localDayKey(w.since + GRACE_MS);
    const firstOpen = addDays(state.streak.lastEvaluated, 1);
    if (day < firstOpen) day = firstOpen;
    dayRecord(state, day).loosened = true;
    state.streak.current = 0;
  }
  state.loose = null;
  return reset;
}

function namesDiffer(a, b) {
  const names = (c) => c.groups.map((g) => `${g.id}:${g.name}`).join('|');
  return names(a) !== names(b);
}

export function cancelPending(state) {
  state.pending = null;
  closeLooseIfUndone(state);
}

export function applyPendingIfDue(state, now) {
  if (!state.pending || now < state.pending.applyAt) return false;
  const createdById = new Map(state.config.groups.map((g) => [g.id, g.createdAt]));
  state.config = {
    goalMinutes: state.config.goalMinutes,
    groups: state.pending.config.groups.map((g) => ({
      ...g,
      createdAt: createdById.get(g.id) ?? now,
    })),
  };
  state.pending = null;
  return true;
}

// ---------- state ----------

export function defaultState(now) {
  const today = localDayKey(now);
  return {
    version: STATE_VERSION,
    installedAt: now,
    lastDay: today,
    config: { goalMinutes: 60, groups: [] },
    pending: null,
    sessions: {},
    days: {},
    streak: { current: 0, best: 0, lastEvaluated: addDays(today, -1) },
    tracking: null,
    groupMeta: {},
    loose: null,
  };
}

// `goal` is the goal in force when the day began. Lowering the goal later
// in the day does not fail a day that was on track. Raising it counts today.
export function dayRecord(state, day) {
  if (!state.days[day]) {
    state.days[day] = { opens: {}, limited: {}, goal: state.config.goalMinutes, failed: false, loosened: false };
  }
  return state.days[day];
}

export function dayGoalMinutes(state, day) {
  const start = state.days[day]?.goal;
  if (day === state.lastDay) return Math.max(start ?? 0, state.config.goalMinutes);
  return start ?? state.config.goalMinutes;
}

function markFailedIfOver(state) {
  const rec = state.days[state.lastDay];
  if (rec && limitedSeconds(rec) > dayGoalMinutes(state, state.lastDay) * 60) rec.failed = true;
}

export const sum = (obj) => Object.values(obj || {}).reduce((a, b) => a + b, 0);

export function limitedSeconds(rec) {
  return sum(rec?.limited);
}

// Moves the state forward to the current day.
// The day never moves backward, so a clock set back cannot restore spent opens.
export function rollover(state, now) {
  const key = localDayKey(now);
  const today = key > state.lastDay ? key : state.lastDay;
  if (today === state.lastDay && state.streak.lastEvaluated >= addDays(today, -1)) return false;

  const st = state.streak;
  let d = addDays(st.lastEvaluated, 1);
  // A large clock jump would loop for a long time. 3660 days is ten years.
  for (let i = 0; d < today && i < 3660; i++) {
    const rec = state.days[d];
    if (rec && (rec.failed || rec.loosened)) {
      st.current = 0;
    } else {
      st.current += 1;
      st.best = Math.max(st.best, st.current);
    }
    st.lastEvaluated = d;
    d = addDays(d, 1);
  }
  state.lastDay = today;
  return true;
}

export function opensUsed(state, groupId) {
  return state.days[state.lastDay]?.opens[groupId] || 0;
}

export function opensLeft(state, group) {
  return Math.max(0, group.opensPerDay - opensUsed(state, group.id));
}

// An open's time runs only while its site is the active tab of a focused
// window. `activeSince` marks the start of the current running stretch.
export function sessionRemaining(s, now) {
  const running = s.activeSince != null ? Math.min(Math.max(0, now - s.activeSince), SEGMENT_CAP_MS) : 0;
  return s.limitMs - s.usedMs - running;
}

export function activeSession(state, groupId, now) {
  const s = state.sessions[groupId];
  if (!s) return null;
  // A start in the future means the clock went back. End the open.
  if (s.start > now + 60_000 || (s.activeSince ?? 0) > now + 60_000) return null;
  return sessionRemaining(s, now) > 0 ? s : null;
}

// Banks running time, then runs only the session whose site is tracked.
export function syncSessions(state, now) {
  const tracked = state.tracking ? groupForHost(state.config, state.tracking.host) : null;
  for (const [id, s] of Object.entries(state.sessions)) {
    if (s.activeSince != null) {
      s.usedMs += Math.min(Math.max(0, now - s.activeSince), SEGMENT_CAP_MS);
      s.activeSince = null;
    }
    if (tracked && tracked.id === id && s.usedMs < s.limitMs) s.activeSince = now;
  }
}

// Starts one open for a group. Spends one of today's opens.
export function startSession(state, groupId, now) {
  const group = state.config.groups.find((g) => g.id === groupId);
  if (!group) return { ok: false, error: 'unknown-group' };
  const existing = activeSession(state, groupId, now);
  if (existing) return { ok: true, session: existing, reused: true };
  if (opensLeft(state, group) <= 0) return { ok: false, error: 'no-opens' };

  const rec = dayRecord(state, state.lastDay);
  rec.opens[groupId] = (rec.opens[groupId] || 0) + 1;
  const session = { start: now, limitMs: group.minutesPerOpen * 60_000, usedMs: 0, activeSince: null };
  state.sessions[groupId] = session;
  return { ok: true, session, reused: false };
}

export function endSession(state, groupId) {
  const had = groupId in state.sessions;
  delete state.sessions[groupId];
  return had;
}

// Removes used-up sessions, sessions for deleted groups, and sessions from
// an earlier day, so paused minutes never carry past midnight.
// A session that starts in the future means someone set the clock back,
// and that would stretch the session, so it ends too.
export function expireSessions(state, now) {
  const expired = [];
  const ids = new Set(state.config.groups.map((g) => g.id));
  for (const [id, s] of Object.entries(state.sessions)) {
    const stale = localDayKey(s.start) < state.lastDay;
    if (stale || !ids.has(id) || !activeSession(state, id, now)) {
      delete state.sessions[id];
      expired.push(id);
    }
  }
  return expired;
}

// Books time on a limited site. Time on other sites is not kept.
export function recordTime(state, host, seconds) {
  if (!host || !(seconds > 0)) return;
  const group = groupForHost(state.config, host);
  if (!group) return;
  const rec = dayRecord(state, state.lastDay);
  rec.limited[group.id] = (rec.limited[group.id] || 0) + seconds;
  markFailedIfOver(state);
}

// Ends the current tracking segment and books its time.
export function flushTracking(state, now) {
  const t = state.tracking;
  if (!t) return 0;
  const ms = Math.min(Math.max(0, now - t.since), SEGMENT_CAP_MS);
  const seconds = Math.round(ms / 1000);
  recordTime(state, t.host, seconds);
  t.since = now;
  return seconds;
}

// Runs on every state access: new day, due pending edits, ended sessions.
export function tick(state, now) {
  // Settle first, so the day of the loosening counts as failed when it rolls over.
  settleLoosening(state, now);
  const dayChanged = rollover(state, now);
  const configChanged = applyPendingIfDue(state, now);
  const expired = expireSessions(state, now);
  return { dayChanged, configChanged, expired };
}

export function migrate(raw, now) {
  if (!raw || typeof raw !== 'object') return defaultState(now);
  if (raw.version === 1) {
    // Version 2 keeps time for limited sites only, keeps it forever,
    // and stores each day's goal.
    for (const rec of Object.values(raw.days || {})) {
      delete rec.time;
      rec.goal ??= raw.config.goalMinutes;
      rec.loosened ??= false;
    }
    if (raw.pending) {
      // The streak rule for loosening did not exist when this edit was made.
      raw.pending.looseSince ??= raw.pending.requestedAt;
      raw.pending.streakReset ??= true;
    }
    raw.groupMeta = {};
    rememberGroups(raw, raw.config);
    if (raw.pending) rememberGroups(raw, raw.pending.config);
    raw.tracking = null;
    raw.version = 2;
  }
  if (raw.version === 2) {
    // Version 3: goal changes apply at once, a separate window tracks
    // loosening, and an open's time only runs on the active tab.
    raw.loose = null;
    if (raw.pending) {
      const p = raw.pending;
      if (!p.streakReset) raw.loose = { since: p.looseSince, baseGoal: raw.config.goalMinutes, basePending: null };
      raw.config.goalMinutes = p.config.goalMinutes;
      delete p.looseSince;
      delete p.streakReset;
      if (sameRules(raw.config, p.config)) raw.pending = null;
    }
    for (const [id, s] of Object.entries(raw.sessions || {})) {
      raw.sessions[id] = { start: s.start, limitMs: Math.max(0, s.end - now), usedMs: 0, activeSince: null };
    }
    raw.version = 3;
  }
  if (raw.version !== STATE_VERSION) return defaultState(now);
  return raw;
}

// ---------- blocking rules ----------

// ---------- site access ----------

// Ration asks for access only to the sites it limits. One pattern per
// domain covers the domain and its subdomains.
export function originFor(domain) {
  return `*://*.${domain}/*`;
}

export function originsFor(domains) {
  return [...new Set(domains)].map(originFor);
}

// True when a granted origin pattern lets Ration see and redirect `domain`
// and its subdomains.
export function domainCovered(origins, domain) {
  for (const o of origins) {
    if (o === '<all_urls>') return true;
    const m = /^(\*|https?):\/\/([^/]+)\//.exec(o);
    if (!m || m[1] !== '*') continue;
    const host = m[2];
    if (host === '*') return true;
    if (host.startsWith('*.')) {
      const base = host.slice(2);
      if (domain === base || domain.endsWith(`.${base}`)) return true;
    }
  }
  return false;
}

// Granted origins that no saved or queued site needs any more.
export function unusedOrigins(state, origins) {
  const needed = new Set(
    [...state.config.groups, ...(state.pending?.config.groups || [])].flatMap((g) => g.domains).map(originFor),
  );
  return origins.filter((o) => /^\*:\/\/\*\.[^/]+\/\*$/.test(o) && !needed.has(o));
}

// ---------- blocking rules ----------

// Up to two declarativeNetRequest rules per group:
// - A redirect to the gate for domains Ration can see, while no open runs.
//   The original URL goes last, raw, after "&u=", because regexSubstitution
//   cannot URL-encode.
// - A plain block for domains Ration has no access to. Redirects need site
//   access and blocks do not, so a site stays shut even if its access is
//   turned off. With no access Ration cannot time an open, so these
//   domains stay blocked during opens too.
export function buildRules(state, now, gateUrl, canSee = () => true) {
  const rules = [];
  state.config.groups.forEach((g, i) => {
    const visible = g.domains.filter((d) => canSee(d));
    const hidden = g.domains.filter((d) => !canSee(d));
    if (visible.length && !activeSession(state, g.id, now)) {
      rules.push({
        id: i * 2 + 1,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: { regexSubstitution: `${gateUrl}?g=${encodeURIComponent(g.id)}&u=\\0` },
        },
        condition: {
          regexFilter: '^https?://.*',
          requestDomains: visible,
          resourceTypes: ['main_frame'],
        },
      });
    }
    if (hidden.length) {
      rules.push({
        id: i * 2 + 2,
        priority: 1,
        action: { type: 'block' },
        condition: { requestDomains: hidden, resourceTypes: ['main_frame'] },
      });
    }
  });
  return rules;
}

export function gateUrlFor(gateUrl, groupId, url, reason) {
  const r = reason ? `&r=${encodeURIComponent(reason)}` : '';
  return `${gateUrl}?g=${encodeURIComponent(groupId)}${r}&u=${url}`;
}

// Reads the gate's query string. The target URL is everything after "&u=".
export function parseGateUrl(href) {
  const q = href.indexOf('?');
  const i = href.indexOf('&u=');
  const head = new URLSearchParams(href.slice(q + 1, i >= 0 ? i : undefined));
  const target = i >= 0 ? href.slice(i + 3) : '';
  return {
    groupId: head.get('g') || '',
    reason: head.get('r') || '',
    target: hostOf(target) ? target : '',
  };
}

// ---------- formatting ----------

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

export function formatClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}:${pad(m % 60)}:${pad(s % 60)}`;
  return `${m}:${pad(s % 60)}`;
}
