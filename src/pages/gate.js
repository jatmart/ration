import * as core from '../lib/core.js';
import { getState, send, el, plural } from './common.js';

const app = document.getElementById('app');
const { groupId, reason, target } = core.parseGateUrl(location.href);

// Brave saves the last page's favicon for every URL in a redirect chain,
// bookmarks included. Showing the site's own favicon here keeps its
// bookmark icon intact.
function useSiteFavicon(url) {
  const link = document.createElement('link');
  link.rel = 'icon';
  link.href = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
  document.head.append(link);
}

// Closes this tab. When it is the window's only tab, closing it would
// close the window, so the tab goes to the new tab page instead.
async function closeTab() {
  const tab = await chrome.tabs.getCurrent();
  if (!tab) return window.close();
  const siblings = await chrome.tabs.query({ windowId: tab.windowId });
  if (siblings.length > 1) await chrome.tabs.remove(tab.id);
  else await chrome.tabs.update(tab.id, { url: 'chrome://newtab/' });
}

// Set the icon before anything awaits, so it is in place when Brave looks.
if (target) useSiteFavicon(target);

function go(url) {
  location.replace(url);
}

function fallbackTarget(group) {
  return target || `https://${group.domains[0]}/`;
}

async function main() {
  const { state, now } = await getState();
  const group = state.config.groups.find((g) => g.id === groupId);

  if (!group) {
    // The group no longer exists, so nothing blocks this site.
    if (target) return go(target);
    app.replaceChildren(el('p', { class: 'muted' }, 'Nothing to show here.'));
    return;
  }
  if (!document.querySelector('link[rel=icon]')) useSiteFavicon(fallbackTarget(group));
  if (core.activeSession(state, group.id, now)) return go(fallbackTarget(group));

  document.title = group.name;
  render(state, group, now);
}

function render(state, group, now) {
  const left = core.opensLeft(state, group);
  const host = target ? core.displayHost(core.hostOf(target)) : group.domains[0];
  const timeToday = state.days[state.lastDay]?.limited[group.id] || 0;
  const expired = reason === 'expired';
  const alarm = expired || left <= 0;

  const header = el(
    'header',
    { class: 'head' },
    el(
      'div',
      {},
      alarm
      ? el('p', { class: 'status red' }, expired ? 'Time’s up' : 'Done for today')
      : '',
      el('h1', {}, group.name),
      el('p', { class: 'host' }, host),
    ),
    el(
      'div',
      { class: 'streak', title: `Best: ${plural(state.streak.best, 'day')}` },
      el('span', { class: 'streak-num num' }, String(state.streak.current)),
      el('span', { class: 'streak-label' }, 'day streak'),
    ),
  );

  const foot = el('p', { class: 'foot num' }, `${core.formatDuration(timeToday)} on ${group.name} today`);

  if (left <= 0) {
    const reset = core.nextMidnight(now) - now;
    app.replaceChildren(
      header,
      el(
        'div',
        { class: 'facts out' },
        el(
          'span',
          {},
          group.opensPerDay > 0 ? `You’ve used all ${plural(group.opensPerDay, 'open')} for today.` : `${group.name} is blocked.`,
        ),
        el('span', { class: 'muted num' }, `Opens reset in ${core.formatDuration(reset / 1000)}.`),
      ),
      el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: closeTab }, 'Close')),
      foot,
    );
    return;
  }

  const minutes = group.minutesPerOpen;
  const label = `Open for ${plural(minutes, 'minute')}`;
  const openBtn = el('button', { class: 'primary num', disabled: true }, label);

  app.replaceChildren(
    header,
    el(
      'div',
      { class: 'facts' },
      el('span', {}, el('span', { class: 'num' }, `${left} of ${plural(group.opensPerDay, 'open')}`), ' left today'),
      el('span', { class: 'muted' }, `${plural(minutes, 'minute')} each`),
    ),
    el('div', { class: 'actions' }, openBtn, el('button', { class: 'secondary', onclick: closeTab }, 'Not now')),
    foot,
  );

  openBtn.addEventListener('click', async () => {
    openBtn.disabled = true;
    const res = await send('startSession', { groupId: group.id });
    if (res.ok) return go(fallbackTarget(group));
    openBtn.textContent = res.error === 'no-opens' ? 'No opens left' : 'Could not open';
    setTimeout(main, 1200);
  });

  // The wait only runs while this tab is visible.
  let remainingMs = group.waitSeconds * 1000;
  let last = performance.now();
  function frame() {
    const t = performance.now();
    if (!document.hidden) remainingMs -= t - last;
    last = t;
    if (remainingMs <= 0) {
      openBtn.textContent = label;
      openBtn.disabled = false;
      openBtn.focus();
      return;
    }
    openBtn.textContent = `Open in ${Math.ceil(remainingMs / 1000)}`;
    setTimeout(frame, 100);
  }
  frame();
}

main().catch((e) => {
  app.replaceChildren(el('p', { class: 'muted' }, `Ration could not load: ${e.message}`));
});
