// ============================================================================
//  cost.js — Cost / Earned-Value (EVM) reporting view.
//  KPI deck (BAC/PV/EV/AC/CPI/SPI/EAC/VAC) + a planned-value S-curve with the
//  EV & AC markers at the data date and an EAC forecast, + a per-project table.
// ============================================================================
import { store, Dates } from '../data.js';
import { computeEVM, evmSeries, evmHealth } from '../evm.js';
import { el, clear, money } from '../utils.js';

// signed, compact money (e.g. +$1.2M, −$340K)
function smoney(n) {
  const s = n < 0 ? '−' : '+';
  return s + money(Math.abs(Math.round(n)));
}
const ratio = (r) => (isFinite(r) ? r.toFixed(2) : '—');

export function renderCost(mount, ctx) {
  clear(mount);
  const tasks = store.tasks(ctx.projectId).filter(ctx.filter);
  const today = Dates.today();
  const m = computeEVM(tasks, today);

  const view = el('div', { class: 'cost-view' });

  // ---- EVM KPI deck -------------------------------------------------------
  const cpiTone = m.CPI >= 0.99 ? 'good' : (m.CPI >= 0.92 ? 'warn' : 'bad');
  const spiTone = m.SPI >= 0.99 ? 'good' : (m.SPI >= 0.92 ? 'warn' : 'bad');
  const card = (label, value, sub, tone = '') =>
    el('div', { class: 'evm-card ' + tone }, [
      el('div', { class: 'evm-label' }, label),
      el('div', { class: 'evm-value' }, value),
      sub ? el('div', { class: 'evm-sub' }, sub) : null,
    ]);

  view.appendChild(el('div', { class: 'evm-deck' }, [
    card('BAC · Budget at Completion', money(m.BAC), 'Total contract value'),
    card('PV · Planned Value', money(m.PV), `${Math.round(m.percentPlanned * 100)}% should be done`),
    card('EV · Earned Value', money(m.EV), `${Math.round(m.percentComplete * 100)}% actually done`),
    card('AC · Actual Cost', money(m.AC), `${Math.round(m.percentSpent * 100)}% of budget spent`),
    card('CPI · Cost Performance', ratio(m.CPI), m.CPI >= 1 ? 'Under budget' : 'Over budget', cpiTone),
    card('SPI · Schedule Performance', ratio(m.SPI), m.SPI >= 1 ? 'Ahead of plan' : 'Behind plan', spiTone),
    card('CV / SV · Variances', `${smoney(m.CV)} / ${smoney(m.SV)}`, 'Cost / schedule variance',
      (m.CV < 0 || m.SV < 0) ? 'warn' : 'good'),
    card('EAC · Forecast at Completion', money(m.EAC),
      `VAC ${smoney(m.VAC)} vs budget`, m.VAC < 0 ? 'bad' : 'good'),
  ]));

  // ---- S-curve ------------------------------------------------------------
  view.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('span', {}, 'Cost Performance Curve'),
      el('span', { class: 'panel-legend' }, [
        legendDot('#5b6b7b', 'PV (planned)'),
        legendDot('#34c759', 'EV (earned)'),
        legendDot('#f5a623', 'AC (actual)'),
        legendDot('#ff5252', 'EAC (forecast)'),
      ]),
    ]),
    buildSCurve(tasks, today),
  ]));

  // ---- Per-project table --------------------------------------------------
  const projects = ctx.projectId === 'all' ? store.projects : [store.project(ctx.projectId)].filter(Boolean);
  const rows = projects.map((p) => {
    const pm = computeEVM(tasks.filter((t) => t.projectId === p.id), today);
    const health = evmHealth(pm.CPI, pm.SPI);
    return el('tr', {}, [
      el('td', {}, [el('span', { class: 'proj-dot', style: { background: p.color } }), p.name]),
      el('td', { class: 'num' }, money(pm.BAC)),
      el('td', { class: 'num' }, money(pm.PV)),
      el('td', { class: 'num' }, money(pm.EV)),
      el('td', { class: 'num' }, money(pm.AC)),
      el('td', { class: 'num ' + (pm.CPI >= 1 ? 'pos' : 'neg') }, ratio(pm.CPI)),
      el('td', { class: 'num ' + (pm.SPI >= 1 ? 'pos' : 'neg') }, ratio(pm.SPI)),
      el('td', { class: 'num' }, money(pm.EAC)),
      el('td', { class: 'num ' + (pm.VAC < 0 ? 'neg' : 'pos') }, smoney(pm.VAC)),
      el('td', {}, el('span', { class: 'health ' + health.tone }, health.label)),
    ]);
  });
  // totals
  const tot = el('tr', { class: 'tot' }, [
    el('td', {}, 'Portfolio total'),
    el('td', { class: 'num' }, money(m.BAC)), el('td', { class: 'num' }, money(m.PV)),
    el('td', { class: 'num' }, money(m.EV)), el('td', { class: 'num' }, money(m.AC)),
    el('td', { class: 'num ' + (m.CPI >= 1 ? 'pos' : 'neg') }, ratio(m.CPI)),
    el('td', { class: 'num ' + (m.SPI >= 1 ? 'pos' : 'neg') }, ratio(m.SPI)),
    el('td', { class: 'num' }, money(m.EAC)),
    el('td', { class: 'num ' + (m.VAC < 0 ? 'neg' : 'pos') }, smoney(m.VAC)),
    el('td', {}, (() => { const h = evmHealth(m.CPI, m.SPI); return el('span', { class: 'health ' + h.tone }, h.label); })()),
  ]);

  view.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, 'Earned Value by Project'),
    el('table', { class: 'evm-table' }, [
      el('thead', {}, el('tr', {}, ['Project', 'BAC', 'PV', 'EV', 'AC', 'CPI', 'SPI', 'EAC', 'VAC', 'Health']
        .map((h, i) => el('th', { class: i > 0 && i < 9 ? 'num' : '' }, h)))),
      el('tbody', {}, [...rows, tot]),
    ]),
  ]));

  mount.appendChild(view);
}

function legendDot(color, label) {
  return el('span', { class: 'lg' }, [el('span', { class: 'lg-dot', style: { background: color } }), label]);
}

// Build the SVG cost-performance curve.
function buildSCurve(tasks, today) {
  const W = 960, H = 340, padL = 64, padR = 24, padT = 18, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const s = evmSeries(tasks, today);

  if (!s.points.length) return el('div', { class: 'empty' }, 'No cost-loaded tasks to chart.');

  const maxY = Math.max(s.BAC, s.eac, s.ac, 1) * 1.08;
  const totalDays = Math.max(1, Dates.diffDays(s.start, s.end));
  const xFor = (date) => padL + (Dates.diffDays(s.start, date) / totalDays) * plotW;
  const yFor = (v) => padT + plotH - (Math.min(v, maxY) / maxY) * plotH;

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'scurve');
  svg.setAttribute('preserveAspectRatio', 'none');

  const add = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    svg.appendChild(e);
    return e;
  };

  // Y gridlines + $ labels
  for (let i = 0; i <= 4; i++) {
    const val = (maxY / 4) * i;
    const y = yFor(val);
    add('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'grid' });
    add('text', { x: padL - 8, y: y + 4, class: 'axis-lbl', 'text-anchor': 'end' }, money(val));
  }
  // X labels (start, today, end)
  add('text', { x: padL, y: H - 10, class: 'axis-lbl', 'text-anchor': 'start' }, Dates.fmt(s.start));
  add('text', { x: W - padR, y: H - 10, class: 'axis-lbl', 'text-anchor': 'end' }, Dates.fmt(s.end));

  // PV area + line
  const pvPts = s.points.map((p) => `${xFor(p.date).toFixed(1)},${yFor(p.pv).toFixed(1)}`).join(' ');
  add('polyline', { points: pvPts, class: 'pv-line' });

  // today marker
  const tx = xFor(today > s.end ? s.end : (today < s.start ? s.start : today));
  add('line', { x1: tx, x2: tx, y1: padT, y2: padT + plotH, class: 'today-v' });
  add('text', { x: tx + 4, y: padT + 12, class: 'axis-lbl accent' }, 'Today');

  // EV / AC points at today
  const evY = yFor(s.ev), acY = yFor(s.ac);
  // EAC forecast: project from AC@today to EAC@end (dashed)
  add('line', { x1: tx, y1: acY, x2: xFor(s.end), y2: yFor(s.eac), class: 'eac-line' });
  add('circle', { cx: xFor(s.end), cy: yFor(s.eac), r: 4, class: 'eac-dot' });
  add('text', { x: xFor(s.end) - 6, y: yFor(s.eac) - 8, class: 'axis-lbl eac', 'text-anchor': 'end' }, 'EAC ' + money(s.eac));

  add('circle', { cx: tx, cy: evY, r: 5, class: 'ev-dot' });
  add('circle', { cx: tx, cy: acY, r: 5, class: 'ac-dot' });

  const box = el('div', { class: 'scurve-wrap' });
  box.appendChild(svg);
  return box;
}
