import * as core from './lib/core.js';

const GATE = chrome.runtime.getURL('src/pages/gate.html');
const DASHBOARD = chrome.runtime.getURL('src/pages/dashboard.html');
const TICK = 'tick';

// ---------- state access ----------

// chrome.storage has no transactions. This queue runs one
// read-modify-write at a time inside this service worker.
let queue = Promise.resolve();

function withState(fn) {
  const run = queue.then(async () => {
    const now = Date.now();
    const { state: raw } = await chrome.storage.local.get('state');
    const state = core.migrate(raw, now);
    const effects = core.tick(state, now);
    const result = await fn(state, now, effects);
    await chrome.storage.local.set({ state });
    await afterChange(state, now, effects);
    return result;
  });
  queue = run.catch((e) => console.error('[ration]', e));
  return run;
}

async function readState() {
  const { state } = await chrome.storage.local.get('state');
  return core.migrate(state, Date.now());
}

async function afterChange(state, now, effects) {
  await syncRules(state, now);
  // Only after a limits change. Doing this when access is added would race
  // with the save that follows the grant, and give the new access back.
  if (effects.configChanged || effects.release) await releaseUnusedAccess(state);
  updateBadge(state, now);
  await scheduleSessionAlarms(state);
  if (effects.expired.length || effects.configChanged || effects.enforce) {
    await enforceAllTabs(state, now, effects.expired);
  }
}

// ---------- blocking ----------

async function grantedOrigins() {
  const { origins = [] } = await chrome.permissions.getAll();
  return origins;
}

async function syncRules(state, now) {
  const origins = await grantedOrigins();
  const want = core.buildRules(state, now, GATE, (d) => core.domainCovered(origins, d));
  const have = await chrome.declarativeNetRequest.getDynamicRules();
  const key = (rules) => JSON.stringify(rules.map((r) => [r.id, r.action, r.condition]));
  const sorted = (rules) => [...rules].sort((a, b) => a.id - b.id);
  if (key(sorted(want)) === key(sorted(have))) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: have.map((r) => r.id),
    addRules: want,
  });
}

// Ration asks for access one site at a time and gives it back when no
// saved limit or open undo window uses that site any more.
async function releaseUnusedAccess(state) {
  const unused = core.unusedOrigins(state, await grantedOrigins());
  if (unused.length) await chrome.permissions.remove({ origins: unused }).catch(() => {});
}

function blockedGroup(state, url, now) {
  if (!url || url.startsWith(GATE)) return null;
  const group = core.groupForUrl(state.config, url);
  if (!group || core.activeSession(state, group.id, now)) return null;
  return group;
}

async function sendToGate(tabId, group, url, reason) {
  const target = core.gateUrlFor(GATE, group.id, url, reason);
  try {
    await chrome.tabs.update(tabId, { url: target });
  } catch {
    // Some tabs refuse extension pages, such as private tabs in some setups.
    // Closing the tab keeps the site blocked.
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

// The network rules only catch new page loads. This pass catches pages
// that were already open, or that changed URL without a load (YouTube, Reddit).
async function enforceAllTabs(state, now, expiredIds = []) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl;
    const group = blockedGroup(state, url, now);
    if (group) await sendToGate(tab.id, group, url, expiredIds.includes(group.id) ? 'expired' : '');
  }
}

async function checkTab(tabId, url) {
  const now = Date.now();
  const state = await readState();
  const group = blockedGroup(state, url, now);
  if (group) await sendToGate(tabId, group, url, '');
}

// ---------- sessions ----------

// When a running open will end. Paused opens have no end time.
function endTime(s) {
  return s.activeSince != null ? s.activeSince + (s.limitMs - s.usedMs) : null;
}

// chrome.alarms fires no sooner than 30 seconds out, so a short timer
// backs it up while the worker is awake.
let endTimer = null;

async function scheduleSessionAlarms(state) {
  const alarms = await chrome.alarms.getAll();
  const want = new Map(
    Object.entries(state.sessions)
      .map(([id, s]) => [`end:${id}`, endTime(s)])
      .filter(([, when]) => when != null),
  );
  clearTimeout(endTimer);
  if (want.size) {
    const soonest = Math.min(...want.values());
    endTimer = setTimeout(() => withState(() => {}), Math.max(0, soonest - Date.now()) + 50);
  }
  for (const a of alarms) {
    if (a.name.startsWith('end:') && want.get(a.name) !== a.scheduledTime) {
      await chrome.alarms.clear(a.name);
    }
  }
  const have = new Set((await chrome.alarms.getAll()).map((a) => a.name));
  for (const [name, when] of want) {
    if (!have.has(name)) chrome.alarms.create(name, { when });
  }
}

// Shows the minutes left on the running open. A paused open shows nothing,
// because no time is being spent.
function updateBadge(state, now) {
  const running = Object.keys(state.sessions)
    .map((id) => core.activeSession(state, id, now))
    .find((s) => s && s.activeSince != null);
  // A streak at risk shows on the icon, so it stays visible on any page.
  const mins = running ? Math.ceil(core.sessionRemaining(running, now) / 60_000) : 0;
  const text = running ? (mins < 100 ? `${mins}m` : `${Math.round(mins / 60)}h`) : core.looseDeadline(state) ? '!' : '';
  chrome.action.setBadgeBackgroundColor({ color: '#d6302a' });
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
  chrome.action.setBadgeText({ text });
}

// ---------- screen time tracking ----------

// Time counts while a browser window has focus and the person is present.
// An idle person still counts while the tab plays sound, so videos count.
async function currentContext() {
  try {
    const win = await chrome.windows.getLastFocused();
    if (!win || !win.focused) return null;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (!tab) return null;
    const host = core.hostOf(tab.url);
    if (!host) return null;
    const idle = await chrome.idle.queryState(60);
    if (idle === 'locked') return null;
    if (idle === 'idle' && !tab.audible) return null;
    return { host };
  } catch {
    return null;
  }
}

async function refreshTracking() {
  const ctx = await currentContext();
  await withState((state, now, effects) => {
    core.flushTracking(state, now);
    // Only limited sites are tracked. Other browsing is never stored.
    const limited = ctx && core.groupForHost(state.config, ctx.host);
    state.tracking = limited ? { host: ctx.host, since: now } : null;
    // An open's time runs only while its site is the tracked tab.
    core.syncSessions(state, now);
    effects.expired.push(...core.expireSessions(state, now));
  });
}

// ---------- events ----------

async function ensureTickAlarm() {
  const a = await chrome.alarms.get(TICK);
  if (!a) chrome.alarms.create(TICK, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureTickAlarm();
  await withState((state, now, effects) => {
    effects.enforce = true;
  });
  if (reason === 'install') chrome.tabs.create({ url: `${DASHBOARD}#limits` });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureTickAlarm();
  await withState((state, now, effects) => {
    // The last segment ended when the browser closed. Drop it unbooked.
    state.tracking = null;
    effects.enforce = true;
  });
  refreshTracking();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === TICK || alarm.name.startsWith('end:')) {
    await refreshTracking();
  }
});

chrome.tabs.onActivated.addListener(() => refreshTracking());

// Site access changed in Brave's settings: rebuild the rules at once.
chrome.permissions.onAdded.addListener(() => withState((state, now, effects) => { effects.enforce = true; }));
chrome.permissions.onRemoved.addListener(() => withState((state, now, effects) => { effects.enforce = true; }));
chrome.windows.onFocusChanged.addListener(() => refreshTracking());
chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener(() => refreshTracking());

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url) checkTab(tabId, info.url);
  if (tab.active && (info.url || 'audible' in info)) refreshTracking();
});

chrome.tabs.onCreated.addListener((tab) => {
  const url = tab.pendingUrl || tab.url;
  if (url) checkTab(tab.id, url);
});

// ---------- messages from extension pages ----------

const handlers = {
  async getState() {
    return withState((state, now) => {
      core.flushTracking(state, now);
      return { state, now };
    });
  },

  async startSession({ groupId }) {
    const res = await withState((state, now) => core.startSession(state, groupId, now));
    // The gate tab is about to load the site. Start the clock once it does.
    setTimeout(refreshTracking, 400);
    return res;
  },

  async endSession({ groupId }) {
    return withState((state, now, effects) => {
      core.endSession(state, groupId);
      effects.expired.push(groupId);
      return { ok: true };
    });
  },

  async saveConfig({ config }) {
    return withState((state, now, effects) => {
      const res = core.saveConfig(state, config, now);
      effects.enforce = true;
      effects.release = true;
      return { ok: true, ...res, config: state.config };
    });
  },


  async undoLoosening() {
    return withState((state, now, effects) => {
      core.undoLoosening(state, now);
      effects.enforce = true;
      effects.release = true;
      return { ok: true };
    });
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only this extension's own pages may change state.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  const handler = handlers[msg?.type];
  if (!handler) return;
  handler(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

ensureTickAlarm();
