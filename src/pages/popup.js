import * as core from '../lib/core.js';
import { getState, send, el, plural, incognitoAllowed, EXTENSIONS_PAGE, PRIVATE_SETTING, logo } from './common.js';

const app = document.getElementById('app');
let data = null;
let privateOk = true;
let fetchedAt = 0;
let missing = []; // limited domains Ration has no access to

function openDashboard(hash) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/pages/dashboard.html${hash}`) });
  window.close();
}

function render() {
  if (!data) return;
  const { state } = data;
  // Shift the fetched time forward by the time since the fetch, for live countdowns.
  const now = data.now + (Date.now() - fetchedAt);
  const used = core.limitedSeconds(state.days[state.lastDay]);
  const goal = core.dayGoalMinutes(state, state.lastDay) * 60;
  const allotted = core.allottedMinutes(state.config) * 60;
  const over = used > goal;
  const scale = Math.max(goal, used, 1);

  const header = el(
    'div',
    { class: 'top' },
    el('h1', {}, logo(), 'Ration'),
    el(
      'div',
      { class: 'streak', title: `Best: ${plural(state.streak.best, 'day')}` },
      el('span', { class: 'streak-num num' }, String(state.streak.current)),
      el('span', { class: 'streak-label' }, 'day streak'),
    ),
  );

  const warn = privateOk
    ? ''
    : el(
        'p',
        { class: 'notice' },
        'Private windows skip your limits. Turn on ',
        el('strong', {}, PRIVATE_SETTING),
        ' under Ration’s Details at ',
        el('code', {}, EXTENSIONS_PAGE),
        '.',
      );

  const today = el(
    'div',
    { class: 'today' },
    el(
      'div',
      { class: 'line' },
      el('span', { class: 'big num' }, core.formatDuration(used)),
      el('span', { class: over ? 'red num' : 'muted num' }, `of ${core.formatDuration(goal)} goal`),
    ),
    el('div', { class: 'bar' }, el('span', { class: over ? 'fill over' : 'fill', style: `width:${Math.min(100, (used / scale) * 100)}%` })),
    el(
      'p',
      { class: 'note num' },
      over ? 'Over today’s goal. Your streak resets tonight. ' : '',
      `Limits allow ${core.formatDuration(allotted)} a day.`,
      goal > state.config.goalMinutes * 60 ? ` New goal of ${core.formatDuration(state.config.goalMinutes * 60)} starts tomorrow.` : '',
    ),
  );

  let sites;
  if (state.config.groups.length === 0) {
    sites = el(
      'div',
      { class: 'today' },
      el('p', { class: 'muted' }, 'No sites limited yet.'),
      el('div', {}, el('button', { class: 'primary', onclick: () => openDashboard('#limits') }, 'Add a site')),
    );
  } else {
    sites = el(
      'div',
      { class: 'sites' },
      state.config.groups.map((g) => {
        const s = core.activeSession(state, g.id, now);
        const running = s && s.activeSince != null;
        const right = s
          ? el(
              'div',
              { class: 'right' },
              el(
                'span',
                { class: running ? 'live num' : 'num', title: running ? 'Counting down' : 'Paused until the site is your active tab' },
                core.formatClock(core.sessionRemaining(s, now)),
                running ? '' : ' paused',
              ),
              el(
                'button',
                {
                  title: 'End this open now. The open stays spent.',
                  onclick: async () => {
                    await send('endSession', { groupId: g.id });
                    refresh();
                  },
                },
                'End',
              ),
            )
          : el('div', { class: 'right num' }, `${core.opensLeft(state, g)} of ${g.opensPerDay} left`);
        return el('div', { class: 'site group' }, el('span', { class: 'name' }, g.name), right);
      }),
    );
  }

  const notes = [];
  const deadline = core.looseDeadline(state);
  if (deadline) notes.push(`You loosened your limits. Undo on the Limits page within ${core.formatClock(deadline - Date.now())} to keep your streak.`);
  const note = notes.length ? el('p', { class: 'notice num' }, notes.join(' ')) : '';

  const foot = el(
    'div',
    { class: 'foot' },
    el('button', { onclick: () => openDashboard('#stats') }, 'Stats'),
    el('button', { onclick: () => openDashboard('#limits') }, 'Limits'),
  );

  const access = missing.length
    ? el(
        'p',
        { class: 'notice' },
        el('strong', {}, `No access to ${missing.join(', ')}. `),
        'Blocked outright until you ',
        el('a', { href: '#', onclick: (e) => { e.preventDefault(); openDashboard('#limits'); } }, 'allow access'),
        '.',
      )
    : '';

  app.replaceChildren(header, warn, access, today, sites, note, foot);
}

async function refresh() {
  data = await getState();
  fetchedAt = Date.now();
  const { origins = [] } = await chrome.permissions.getAll();
  const domains = [...new Set(data.state.config.groups.flatMap((g) => g.domains))];
  missing = domains.filter((d) => !core.domainCovered(origins, d));
  render();
}

async function main() {
  privateOk = await incognitoAllowed();
  await refresh();
  setInterval(render, 1000);
  setInterval(refresh, 15000);
}

main().catch((e) => app.replaceChildren(el('p', { class: 'muted' }, `Ration could not load: ${e.message}`)));
