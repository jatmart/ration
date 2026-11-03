// Stacked bars of time on limited sites, one segment per site.
// Plain SVG. Hover or focus a bar for its values.

const SVG = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// Round axis steps in minutes, from 5 minutes to 1000 hours.
const STEPS = [5, 10, 15, 30, 60, 120, 180, 300, 600, 1200, 1800, 3000, 6000, 12000, 30000, 60000];

function niceStep(maxMinutes) {
  for (const s of STEPS) if (maxMinutes / s <= 4) return s;
  return STEPS[STEPS.length - 1];
}

function axisLabel(min) {
  if (min === 0) return '0';
  if (min < 60) return `${min}m`;
  return min % 60 ? `${Math.floor(min / 60)}h${min % 60}` : `${min / 60}h`;
}

/**
 * series: [{ id, name, cls }] in stacking order, bottom first.
 * bars:   [{ label, longLabel, values: { id: seconds }, days }].
 * goal:   seconds for a dashed reference line, or null.
 */
export function renderStackedBars(container, { series, bars, goal, fmt }) {
  container.replaceChildren();
  const W = 640;
  const H = 230;
  const pad = { top: 12, right: 8, bottom: 26, left: 44 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;

  const totals = bars.map((b) => series.reduce((a, s) => a + (b.values[s.id] || 0), 0));
  const maxSec = Math.max(5 * 60, goal || 0, ...totals);
  const step = niceStep(maxSec / 60);
  const top = Math.ceil(maxSec / 60 / step) * step;
  const y = (sec) => ih - (sec / 60 / top) * ih;

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img' });
  root.setAttribute('aria-label', 'Time on limited sites. A table view follows the chart.');
  const g = svg('g', { transform: `translate(${pad.left},${pad.top})` });
  root.append(g);

  for (let v = 0; v <= top; v += step) {
    const yy = y(v * 60);
    g.append(svg('line', { x1: 0, x2: iw, y1: yy, y2: yy, class: v === 0 ? 'axis-base' : 'grid' }));
    const t = svg('text', { x: -8, y: yy + 4, class: 'tick', 'text-anchor': 'end' });
    t.textContent = axisLabel(v);
    g.append(t);
  }

  const band = iw / bars.length;
  const barW = Math.max(3, Math.min(48, band * 0.64));
  const showEvery = bars.length > 14 ? Math.ceil(bars.length / 8) : 1;
  const GAP = 2;
  const bodies = svg('g');
  const hits = svg('g');
  g.append(bodies);

  if (goal) {
    const gy = y(goal);
    g.append(svg('line', { x1: 0, x2: iw, y1: gy, y2: gy, class: 'goal-line' }));
    const t = svg('text', { x: iw, y: gy - 5, class: 'goal-label', 'text-anchor': 'end' });
    t.textContent = `goal ${fmt(goal)}`;
    g.append(t);
  }
  g.append(hits);

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.append(root, tip);

  bars.forEach((b, i) => {
    const cx = band * i + band / 2;
    const x = cx - barW / 2;
    const r = Math.min(4, barW / 2);
    const parts = series.filter((s) => (b.values[s.id] || 0) > 0);
    let acc = 0;
    parts.forEach((s, j) => {
      const v = b.values[s.id];
      const yBottom = y(acc) - (j > 0 ? GAP : 0);
      acc += v;
      const yTop = y(acc);
      const h = yBottom - yTop;
      if (h <= 0.5) return;
      const isTop = j === parts.length - 1;
      bodies.append(barPath(x, yTop, barW, h, isTop ? r : 0, s.cls));
    });

    // Label every few bars and always the last one, skipping a regular
    // label that would crowd the last.
    const last = bars.length - 1;
    if (i === last || (i % showEvery === 0 && last - i >= Math.ceil(showEvery / 2) + 1)) {
      const t = svg('text', { x: cx, y: ih + 18, class: 'tick', 'text-anchor': 'middle' });
      t.textContent = b.label;
      g.append(t);
    }

    // The hit target spans the whole column: wider and taller than the bar.
    const hit = svg('rect', { x: band * i, y: 0, width: band, height: ih, class: 'hit', tabindex: 0 });
    hit.setAttribute('aria-label', `${b.longLabel}: ${fmt(totals[i])}`);
    const show = () => {
      tip.replaceChildren();
      const h = document.createElement('strong');
      h.textContent = b.longLabel;
      tip.append(h);
      for (const s of [...parts].reverse()) tip.append(row(s.cls, s.name, fmt(b.values[s.id])));
      tip.append(row('', 'Total', fmt(totals[i]), 'total'));
      if (b.days > 1) tip.append(row('', 'Per day', fmt(totals[i] / b.days)));
      tip.hidden = false;
      const box = container.getBoundingClientRect();
      const scale = box.width / W;
      tip.style.left = `${Math.min(Math.max((pad.left + cx) * scale, 90), box.width - 90)}px`;
      tip.style.top = `${(pad.top + Math.min(y(totals[i]), ih - 10)) * scale}px`;
      hit.classList.add('on');
    };
    const hide = () => {
      tip.hidden = true;
      hit.classList.remove('on');
    };
    hit.addEventListener('mouseenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('blur', hide);
    hits.append(hit);
  });
}

function row(cls, label, value, extra = '') {
  const r = document.createElement('div');
  r.className = `tip-row ${extra}`;
  const sw = document.createElement('span');
  sw.className = cls ? `sw ${cls}` : 'sw';
  const l = document.createElement('span');
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'num';
  v.textContent = value;
  r.append(sw, l, v);
  return r;
}

// A bar with its top corners rounded by r and a square base.
function barPath(x, yTop, w, h, r, cls) {
  r = Math.min(r, h);
  const d = r > 0
    ? `M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + w - r} Q${x + w},${yTop} ${x + w},${yTop + r} V${yTop + h} Z`
    : `M${x},${yTop + h} V${yTop} H${x + w} V${yTop + h} Z`;
  return svg('path', { d, class: cls });
}
