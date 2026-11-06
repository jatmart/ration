import * as core from '../lib/core.js';
import { getState, send, el, plural, incognitoAllowed, EXTENSIONS_PAGE, PRIVATE_SETTING } from './common.js';
import { renderStackedBars } from './chart.js';
import * as stats from '../lib/stats.js';

const PRESETS = [
  { name: 'YouTube', domains: ['youtube.com', 'youtu.be'] },
  { name: 'Reddit', domains: ['reddit.com', 'redd.it'] },
  { name: 'X', domains: ['x.com', 'twitter.com'] },
  { name: 'Instagram', domains: ['instagram.com'] },
  { name: 'TikTok', domains: ['tiktok.com'] },
  { name: 'Facebook', domains: ['facebook.com'] },
  { name: 'Twitch', domains: ['twitch.tv'] },
  { name: 'Netflix', domains: ['netflix.com'] },
];

const views = {
  stats: document.getElementById('view-stats'),
  limits: document.getElementById('view-limits'),
};
const savebar = document.getElementById('savebar');
const savemsg = document.getElementById('savemsg');

let data = null; // { state, now }
let range = 'week';
let draft = null; // { goalMinutes, groups: [{ id, name, domainsText, opensPerDay, minutesPerOpen, waitSeconds }] }
let draftBase = '';
let saving = false;
let saveAgain = false;
let settling = false;
const refused = new Set(); // Domains the user refused access to.
let rowUpdaters = [];

// ---------- routing ----------

function route() {
  const name = location.hash === '#limits' ? 'limits' : 'stats';
  for (const [k, v] of Object.entries(views)) {
    v.hidden = k !== name;
    const link = document.getElementById(`nav-${k}`);
    if (k === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', route);

// Domains of saved sites that Ration has no access to. Those sites are
// blocked outright, with no gate and no opens.
async function domainsWithoutAccess() {
  const { origins = [] } = await chrome.permissions.getAll();
  const domains = data.state.config.groups.flatMap((g) => g.domains);
  return [...new Set(domains)].filter((d) => !core.domainCovered(origins, d));
}

async function renderWarnings() {
  const box = document.createDocumentFragment();
  const missing = await domainsWithoutAccess();
  if (missing.length) {
    const allow = el('button', { class: 'primary' }, 'Allow access');
    allow.addEventListener('click', async () => {
      // Must be the first call in the click, or the browser refuses the request.
      const ok = await chrome.permissions.request({ origins: core.originsFor(missing) }).catch(() => false);
      if (ok) {
        await load();
        renderWarnings();
      }
    });
    box.append(
      el(
        'div',
        { class: 'notice' },
        el('p', {}, el('strong', {}, `Ration can’t see ${missing.join(', ')}. `), 'Until you allow access, these sites stay fully blocked, with no opens.'),
        el('div', { class: 'actions' }, allow),
      ),
    );
  }
  if (!(await incognitoAllowed())) {
    box.append(
      el(
        'p',
        { class: 'notice' },
        el('strong', {}, 'Private windows skip your limits. '),
        `Turn on ${PRIVATE_SETTING} under Ration’s Details at `,
        el('code', {}, EXTENSIONS_PAGE),
        '.',
      ),
    );
  }
  document.getElementById('warnings').replaceChildren(box);
}

// A label-and-value list laid out in one row.
function facts(pairs) {
  return el(
    'dl',
    { class: 'facts' },
    pairs.filter(Boolean).map(([label, value, small]) =>
      el('div', {}, el('dt', {}, label), el('dd', { class: 'num' }, value, small ? el('small', {}, ` ${small}`) : '')),
    ),
  );
}

// ---------- stats ----------

const SLOTS = 7; // Sites past the seventh share one "Other" color.
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const SHORT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const LONG = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
const MONTH = new Intl.DateTimeFormat(undefined, { month: 'short' });
const MONTH_LONG = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const keyDate = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d || 1, 12);
};

function barLabels(b, count) {
  if (b.unit === 'day') {
    const dt = keyDate(b.start);
    return { label: count <= 7 ? WEEKDAY.format(dt) : SHORT.format(dt), longLabel: LONG.format(dt) };
  }
  if (b.unit === 'month') {
    const dt = keyDate(b.start);
    const partial = b.days < new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
    return { label: MONTH.format(dt), longLabel: `${MONTH_LONG.format(dt)}${partial ? ` (${plural(b.days, 'day')})` : ''}` };
  }
  return { label: b.key, longLabel: `${b.key} (${plural(b.days, 'day')})` };
}

function groupName(state, id) {
  return state.config.groups.find((g) => g.id === id)?.name || state.groupMeta?.[id]?.name || 'Removed site';
}

const slotOf = (state, id) => state.groupMeta?.[id]?.slot ?? 99;
const clsOf = (state, id) => (slotOf(state, id) < SLOTS ? `c${slotOf(state, id)}` : 'c-other');

// One series per site, with a color fixed by the order sites were added.
function seriesFor(state, byGroup) {
  const ids = Object.keys(byGroup).filter((id) => byGroup[id] > 0);
  ids.sort((a, b) => slotOf(state, a) - slotOf(state, b));
  const series = [];
  let other = false;
  for (const id of ids) {
    if (slotOf(state, id) < SLOTS) series.push({ id, name: groupName(state, id), cls: clsOf(state, id) });
    else other = true;
  }
  if (other) series.push({ id: '__other', name: 'Other sites', cls: 'c-other' });
  return series;
}

function foldOther(state, values) {
  const out = {};
  for (const [id, s] of Object.entries(values)) {
    const key = slotOf(state, id) < SLOTS ? id : '__other';
    out[key] = (out[key] || 0) + s;
  }
  return out;
}

function todayBlock(state) {
  const used = core.limitedSeconds(state.days[state.lastDay]);
  const goal = core.dayGoalMinutes(state, state.lastDay) * 60;
  const allotted = core.allottedMinutes(state.config) * 60;
  const scale = Math.max(used, goal, allotted, 60);
  const pct = (v) => `${Math.min(100, (v / scale) * 100)}%`;
  const over = used > goal;
  const opensAllowed = state.config.groups.reduce((a, g) => a + g.opensPerDay, 0);
  const opensSpent = state.config.groups.reduce((a, g) => a + core.opensUsed(state, g.id), 0);

  return el(
    'div',
    { class: 'block' },
    el(
      'div',
      { class: 'hero-row' },
      el(
        'div',
        { class: 'hero' },
        el('span', { class: 'big num' }, core.formatDuration(used)),
        el('span', { class: over ? 'red' : 'muted' }, over ? 'on limited sites today, over your goal' : 'on limited sites today'),
      ),
      el(
        'div',
        { class: 'hero streak' },
        el('span', { class: 'big num' }, String(state.streak.current)),
        el('span', { class: 'muted' }, `day streak · best ${state.streak.best}`),
      ),
    ),
    el(
      'div',
      {
        class: 'bar wide',
        role: 'img',
        'aria-label': `${core.formatDuration(used)} used, goal ${core.formatDuration(goal)}, limits allow ${core.formatDuration(allotted)}`,
      },
      el('span', { class: 'allot', style: `width:${pct(allotted)}` }),
      el('span', { class: over ? 'fill over' : 'fill', style: `width:${pct(used)}` }),
      el('span', { class: 'tick', style: `left:${pct(goal)}` }),
    ),
    facts([
      ['Daily goal', core.formatDuration(goal), goal > state.config.goalMinutes * 60 ? `(${core.formatDuration(state.config.goalMinutes * 60)} from tomorrow)` : ''],
      ['Limits allow', core.formatDuration(allotted), 'a day'],
      ['Opens today', `${opensSpent} of ${opensAllowed}`],
    ]),
  );
}

function renderStats() {
  const { state } = data;
  const agg = stats.aggregate(state, range, state.lastDay);
  const meta = stats.RANGES.find((r) => r.id === range);

  const rangeBtns = el(
    'div',
    { class: 'seg', role: 'group', 'aria-label': 'Range' },
    stats.RANGES.map((r) =>
      el('button', { 'aria-pressed': String(range === r.id), onclick: () => { range = r.id; renderStats(); } }, r.label),
    ),
  );

  const series = seriesFor(state, agg.byGroup);
  const bars = agg.buckets.map((b) => ({ ...b, ...barLabels(b, agg.buckets.length), values: foldOther(state, b.byGroup) }));
  const chartBox = el('div', { class: 'chart' });
  const unitName = { day: 'Day', month: 'Month', year: 'Year' }[agg.unit];

  const history = el(
    'div',
    { class: 'block' },
    el('div', { class: 'block-head' }, el('h2', {}, `History, ${meta.title}`), rangeBtns),
    facts([
      ['Total', core.formatDuration(agg.total)],
      ['Per day', core.formatDuration(agg.avgPerDay)],
      agg.daysJudged ? ['Under goal', `${agg.daysUnder} of ${plural(agg.daysJudged, 'day')}`] : null,
      agg.bestDay?.seconds ? ['Most in a day', core.formatDuration(agg.bestDay.seconds), SHORT.format(keyDate(agg.bestDay.day))] : null,
    ]),
    series.length ? el('div', { class: 'legend' }, series.map((s) => el('span', {}, el('i', { class: `sw ${s.cls}` }), s.name))) : '',
    chartBox,
    el(
      'details',
      {},
      el('summary', {}, 'Table'),
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, el('th', {}, unitName), series.map((s) => el('th', { class: 'r' }, s.name)), el('th', { class: 'r' }, 'Total'))),
        el(
          'tbody',
          {},
          [...bars].reverse().map((b) =>
            el(
              'tr',
              {},
              el('td', {}, b.longLabel),
              series.map((s) => el('td', { class: 'r num' }, core.formatDuration(b.values[s.id] || 0))),
              el('td', { class: 'r num' }, core.formatDuration(b.total)),
            ),
          ),
        ),
      ),
    ),
  );

  // Per site over the range. Current sites always show, removed ones only with time.
  const siteIds = [...new Set([...state.config.groups.map((g) => g.id), ...Object.keys(agg.byGroup)])];
  siteIds.sort((a, b) => (agg.byGroup[b] || 0) - (agg.byGroup[a] || 0));
  const maxSite = Math.max(1, ...siteIds.map((id) => agg.byGroup[id] || 0));
  const first = stats.firstDay(state);
  const days = stats.daysBetween(agg.start < first ? first : agg.start, agg.end);
  const bySite = el(
    'div',
    { class: 'block' },
    el('h2', {}, 'By site'),
    siteIds.length
      ? el(
          'table',
          {},
          el(
            'thead',
            {},
            el('tr', {}, el('th', {}, 'Site'), el('th', { class: 'share' }, ''), el('th', { class: 'r' }, 'Time'), el('th', { class: 'r' }, 'Per day'), el('th', { class: 'r' }, 'Opens')),
          ),
          el(
            'tbody',
            {},
            siteIds.map((id) => {
              const sec = agg.byGroup[id] || 0;
              const cls = clsOf(state, id);
              const live = state.config.groups.some((g) => g.id === id);
              return el(
                'tr',
                {},
                el('td', {}, groupName(state, id), live ? '' : el('span', { class: 'tag' }, 'removed')),
                el('td', { class: 'share' }, el('div', { class: 'share-bar' }, el('span', { class: cls, style: `width:${(sec / maxSite) * 100}%` }))),
                el('td', { class: 'r num' }, core.formatDuration(sec)),
                el('td', { class: 'r num' }, core.formatDuration(sec / Math.max(1, days))),
                el('td', { class: 'r num' }, String(agg.opens[id] || 0)),
              );
            }),
          ),
        )
      : el('p', { class: 'muted' }, 'No sites limited yet. ', el('a', { href: '#limits' }, 'Add one.')),
  );

  views.stats.replaceChildren(todayBlock(state), history, bySite);
  const goalLine = agg.unit === 'day' ? core.dayGoalMinutes(state, state.lastDay) * 60 : null;
  renderStackedBars(chartBox, { series, bars, goal: goalLine, fmt: core.formatDuration });
}

// ---------- limits ----------

function toDraft(config) {
  return {
    goalMinutes: config.goalMinutes,
    groups: config.groups.map((g) => ({
      id: g.id,
      name: g.name,
      domainsText: g.domains.join(', '),
      opensPerDay: g.opensPerDay,
      minutesPerOpen: g.minutesPerOpen,
      waitSeconds: g.waitSeconds,
    })),
  };
}

function parseDomains(text) {
  const good = [];
  const bad = [];
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const d = core.normalizeDomain(part);
    if (d) {
      if (!good.includes(d)) good.push(d);
    } else bad.push(part);
  }
  return { good, bad };
}

function fromDraft(d) {
  return {
    goalMinutes: Number(d.goalMinutes),
    groups: d.groups.map((g) => ({
      id: g.id,
      name: g.name,
      domains: parseDomains(g.domainsText).good,
      opensPerDay: Number(g.opensPerDay),
      minutesPerOpen: Number(g.minutesPerOpen),
      waitSeconds: Number(g.waitSeconds),
    })),
  };
}

function baseDraft() {
  return toDraft(data.state.config);
}

function resetDraft() {
  draft = baseDraft();
  draftBase = JSON.stringify(draft);
}

const NEEDS_ACCESS = 'Not saved. Ration needs access to this site.';
const isBlank = (value) => String(value).trim() === '';

// Why a row cannot be saved yet, or an empty string.
function rowProblem(g) {
  const { good, bad } = parseDomains(g.domainsText);
  if (bad.length) return `Not a domain: ${bad.join(', ')}`;
  if (!good.length) return 'Add a domain.';
  if (good.some((d) => refused.has(d))) return NEEDS_ACCESS;
  if ([g.opensPerDay, g.minutesPerOpen, g.waitSeconds].some(isBlank)) return 'Fill in every number.';
  return '';
}

const savedConfig = () => core.cleanConfig(fromDraft(JSON.parse(draftBase)));
const isSaved = (g) => savedConfig().groups.some((x) => x.id === g.id);

// The draft without its unfinished rows. A saved row keeps its saved values
// until its edit is valid, so a half-typed edit never counts as removing a site.
function savableConfig() {
  const base = JSON.parse(draftBase);
  const groups = draft.groups.flatMap((g) => {
    if (!rowProblem(g)) return [g];
    return base.groups.filter((x) => x.id === g.id);
  });
  const goalMinutes = isBlank(draft.goalMinutes) ? base.goalMinutes : draft.goalMinutes;
  return core.cleanConfig(fromDraft({ goalMinutes, groups }));
}

function changed() {
  return Boolean(draft) && JSON.stringify(savableConfig()) !== JSON.stringify(savedConfig());
}

// Shown only when a save fails. A save that works shows nothing.
function showFailure(error) {
  savebar.hidden = !error;
  savemsg.textContent = error ? `Could not save: ${error}` : '';
}

// Color class for each site in the draft. Saved sites keep their slot.
// New sites take the next free slots, in the order they appear.
function draftColors() {
  const meta = data.state.groupMeta || {};
  let next = Object.keys(meta).length;
  const out = new Map();
  for (const g of draft.groups) {
    const slot = meta[g.id]?.slot ?? next++;
    out.set(g.id, slot < SLOTS ? `c${slot}` : 'c-other');
  }
  return out;
}

// A bar of what each site allows per day, against a mark at the goal.
function renderAllotment() {
  const box = document.getElementById('allotment');
  if (!box || !draft) return;
  const cfg = core.cleanConfig(fromDraft(draft));
  const colors = draftColors();
  const allotted = core.allottedMinutes(cfg) * 60;
  const goal = cfg.goalMinutes * 60;
  const scale = Math.max(allotted, goal, 60);
  const diff = allotted - goal;
  const pct = (v) => `${(v / scale) * 100}%`;

  box.replaceChildren(
    el(
      'div',
      { class: 'allot-bar', role: 'img', 'aria-label': `Limits allow ${core.formatDuration(allotted)}, goal ${core.formatDuration(goal)}` },
      cfg.groups.map((g) =>
        el('span', {
          class: `allot-seg ${colors.get(g.id)}`,
          style: `width:${pct(g.opensPerDay * g.minutesPerOpen * 60)}`,
          title: `${g.name}: ${g.opensPerDay} × ${g.minutesPerOpen} min`,
        }),
      ),
      el('span', { class: 'goal-mark', style: `left:${pct(goal)}`, title: `Goal: ${core.formatDuration(goal)}` }),
    ),
    el(
      'p',
      { class: 'allot-text num' },
      `Limits allow ${core.formatDuration(allotted)} a day`,
      diff > 0
        ? el('span', { class: 'red' }, `, ${core.formatDuration(diff)} more than the goal.`)
        : ', within the goal.',
    ),
  );
}

// Rebuilds the draft from saved state, keeping rows the user has not finished.
function syncDraft() {
  const unfinished = draft.groups.filter(rowProblem);
  resetDraft();
  for (const g of unfinished) {
    const at = draft.groups.findIndex((x) => x.id === g.id);
    if (at >= 0) draft.groups[at] = g;
    else draft.groups.push(g);
  }
  renderLimits();
}

async function afterAction() {
  await load();
  syncDraft();
  renderLoose();
}

// Saves each change as it happens.
function saveOnEdit(input, apply) {
  input.addEventListener('input', () => {
    apply(input.value);
    renderAllotment();
    saveDraft();
  });
}

// Keeps a number in range. A blank field goes back to its last value when the user leaves it.
function bindNumber(input, write, { min, max }) {
  let last = input.value;
  saveOnEdit(input, write);
  input.addEventListener('change', () => {
    last = isBlank(input.value) ? last : String(Math.min(max, Math.max(min, Math.round(Number(input.value)))));
    input.value = last;
    write(last);
    renderAllotment();
    saveDraft();
  });
}

function addedDomains(config) {
  const saved = new Set(savedConfig().groups.flatMap((g) => g.domains));
  return [...new Set(config.groups.flatMap((g) => g.domains))].filter((d) => !saved.has(d));
}

// The browser only shows its access prompt during a click or key press, so this
// function must reach chrome.permissions.request with no await before it.
async function saveDraft() {
  if (saving) {
    saveAgain = true;
    return;
  }
  if (!changed()) return;
  saving = true;
  try {
    const config = savableConfig();
    const added = addedDomains(config);
    const granted = added.length ? await chrome.permissions.request({ origins: core.originsFor(added) }).catch(() => false) : true;
    if (granted) {
      const res = await send('saveConfig', { config });
      await load();
      draftBase = JSON.stringify(baseDraft());
      showFailure(res.ok ? '' : res.error);
    } else {
      for (const d of added) refused.add(d);
    }
  } catch (e) {
    showFailure(e.message);
  }
  saving = false;
  // Updates the rows in place, so the cursor stays where it is.
  for (const update of rowUpdaters) update();
  renderLoose();
  renderWarnings();
  if (saveAgain) {
    saveAgain = false;
    saveDraft();
  }
}

// The banner sits above both views, so a streak at risk shows on every page.
function renderLoose() {
  const box = document.getElementById('loose');
  const deadline = data && core.looseDeadline(data.state);
  const left = deadline ? deadline - Date.now() : 0;
  box.hidden = left <= 0;
  if (left > 0) {
    const { current } = data.state.streak;
    const cost = current > 0 ? `your ${current}-day streak resets` : 'today won’t count';
    document.getElementById('loose-text').textContent = `You loosened your limits. Undo within ${core.formatClock(left)} or ${cost}.`;
  } else if (deadline && !settling) {
    settling = true;
    load()
      .then(() => {
        if (!views.stats.hidden) renderStats();
      })
      .finally(() => {
        settling = false;
      });
  }
}

function renderLimits() {
  rowUpdaters = [];
  const goalInput = el('input', { type: 'number', min: 0, max: 1440, step: 5, value: draft.goalMinutes, id: 'goal', 'aria-label': 'Daily goal in minutes' });
  bindNumber(
    goalInput,
    (value) => {
      draft.goalMinutes = value;
    },
    core.LIMITS.goalMinutes,
  );
  const goalBlock = el(
    'div',
    { class: 'block' },
    el('h2', {}, 'Daily goal'),
    el('div', { class: 'goal-row' }, goalInput, el('span', { class: 'muted' }, 'minutes on limited sites')),
    el('div', { id: 'allotment' }),
  );

  const used = new Set(draft.groups.flatMap((g) => parseDomains(g.domainsText).good));
  const presets = el(
    'div',
    { class: 'presets' },
    el('span', {}, 'Add'),
    PRESETS.filter((p) => !p.domains.some((d) => used.has(d))).map((p) => el('button', { onclick: () => addGroup(p.name, p.domains) }, p.name)),
    el('button', { onclick: () => addGroup('', []) }, 'Other site'),
  );

  const sitesBlock = el(
    'div',
    { class: 'block' },
    el('h2', {}, 'Sites'),
    el(
      'div',
      {},
      el(
        'div',
        { class: 'sites-head' },
        el('span', {}, 'Name'),
        el('span', {}, 'Domains'),
        el('span', {}, 'Opens'),
        el('span', {}, 'Minutes'),
        el('span', {}, 'Wait (s)'),
        el('span', {}),
      ),
      draft.groups.length
        ? (() => {
            const colors = draftColors();
            return draft.groups.map((g) => siteRow(g, colors.get(g.id)));
          })()
        : el('p', { class: 'empty' }, 'No sites yet.'),
    ),
    presets,
    el(
      'p',
      { class: 'faint', style: 'font-size:12px' },
      'When you add a site, your browser asks to let Ration see it. Ration uses that only to show its gate and time your opens, on this device.',
    ),
  );

  views.limits.replaceChildren(goalBlock, sitesBlock);
  renderAllotment();
}

function numberCell(label, g, key, { min, max }) {
  const input = el('input', { type: 'number', min, max, step: 1, value: g[key], 'aria-label': label, class: 'num' });
  bindNumber(
    input,
    (value) => {
      g[key] = value;
    },
    { min, max },
  );
  return el('div', {}, el('label', {}, label), input);
}

function rowStatus(g) {
  const { state, now } = data;
  const active = state.config.groups.find((x) => x.id === g.id);
  const graceLeft = active?.createdAt != null ? core.GRACE_MS - (now - active.createdAt) : null;
  if (!active) return el('p', { class: 'sub fresh' }, 'New');
  if (graceLeft > 0) return el('p', { class: 'sub fresh' }, `Free to edit for ${core.formatDuration(graceLeft / 1000)}`);
  const spent = core.opensUsed(state, g.id) >= active.opensPerDay;
  return el('p', { class: spent ? 'sub num spent' : 'sub num' }, `${core.opensUsed(state, g.id)} of ${active.opensPerDay} opens used today`);
}

function siteRow(g, colorClass) {
  const name = el('input', { type: 'text', value: g.name, placeholder: 'Name', 'aria-label': 'Name', class: `name ${colorClass}` });
  saveOnEdit(name, (value) => {
    g.name = value;
  });
  const domains = el('input', { type: 'text', value: g.domainsText, placeholder: 'example.com', spellcheck: 'false', 'aria-label': 'Domains, separated by commas' });
  const errLine = el('p', { class: 'err' });
  const statusBox = el('div', {});

  const allowAccess = () => {
    for (const d of parseDomains(g.domainsText).good) refused.delete(d);
    saveDraft();
  };
  const updateRow = () => {
    statusBox.replaceChildren(rowStatus(g));
    // A new row with no domain yet is unfinished, not wrong.
    const problem = isBlank(g.domainsText) && !isSaved(g) ? '' : rowProblem(g);
    errLine.replaceChildren(problem);
    if (problem === NEEDS_ACCESS) errLine.append(' ', el('button', { onclick: allowAccess }, 'Allow access'));
    errLine.hidden = !problem;
  };
  rowUpdaters.push(updateRow);
  updateRow();

  // Domains save when the user leaves the field, because each new domain
  // opens the browser's access prompt.
  domains.addEventListener('input', () => {
    g.domainsText = domains.value;
    renderAllotment();
  });
  domains.addEventListener('change', () => {
    const { good, bad } = parseDomains(g.domainsText);
    if (good.length && !bad.length) {
      g.domainsText = good.join(', ');
      domains.value = g.domainsText;
    }
    updateRow();
    saveDraft();
  });

  const remove = el(
    'button',
    {
      class: 'x',
      title: `Remove ${g.name || 'site'}`,
      'aria-label': `Remove ${g.name || 'site'}`,
      onclick: () => {
        draft.groups = draft.groups.filter((x) => x !== g);
        renderLimits();
        saveDraft();
      },
    },
    '×',
  );

  return el(
    'div',
    { class: 'site-row' },
    el('div', { class: 'c-name' }, name, statusBox),
    el('div', { class: 'c-domains' }, domains, errLine),
    numberCell('Opens', g, 'opensPerDay', core.LIMITS.opensPerDay),
    numberCell('Minutes', g, 'minutesPerOpen', core.LIMITS.minutesPerOpen),
    numberCell('Wait (s)', g, 'waitSeconds', core.LIMITS.waitSeconds),
    el('div', { class: 'c-x' }, remove),
  );
}

function addGroup(name, domains) {
  draft.groups.push({
    id: crypto.randomUUID(),
    name,
    domainsText: domains.join(', '),
    opensPerDay: 3,
    minutesPerOpen: 10,
    waitSeconds: 10,
  });
  renderLimits();
  saveDraft();
  const rows = views.limits.querySelectorAll('.site-row');
  const last = rows[rows.length - 1];
  last?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  last?.querySelector(name ? 'input[type=number]' : 'input.name')?.focus();
}

// A save may still be running when the page closes, so this sends the latest
// edit. A new domain stays unsaved, because the access prompt needs a live page.
window.addEventListener('pagehide', () => {
  if (!changed()) return;
  const config = savableConfig();
  if (!addedDomains(config).length) send('saveConfig', { config }).catch(() => {});
});

document.getElementById('undo').addEventListener('click', async () => {
  await send('undoLoosening');
  afterAction();
});

// ---------- load ----------

async function load() {
  data = await getState();
}

async function main() {
  await load();
  resetDraft();
  await renderWarnings();
  renderStats();
  renderLimits();
  route();
  renderLoose();
  setInterval(renderLoose, 1000);
  setInterval(async () => {
    await load();
    if (!views.stats.hidden) renderStats();
    if (!views.limits.hidden && !saving && !changed() && !document.activeElement?.matches('input, textarea')) syncDraft();
  }, 30_000);
}

main().catch((e) => {
  document.querySelector('.wrap').append(el('p', { class: 'muted' }, `Ration could not load: ${e.message}`));
});
