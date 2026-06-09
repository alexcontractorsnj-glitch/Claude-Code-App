// ============================================================================
//  resources.js — Resource-leveling view. One row per crew; each crew's tasks
//  are lane-packed so overlaps (double-bookings) are visible, and conflicting
//  bars are ringed in red. Reuses the Gantt's day-grid layout.
// ============================================================================
import { store, TRADES, Dates } from '../data.js';
import { packLanes, conflictTaskIds } from '../leveling.js';
import { el, clear, shade } from '../utils.js';

const DAY_W = 26;
const LANE_H = 30;
const HEADER_H = 48;
const ROW_PAD = 8;

export function renderResources(mount, ctx) {
  clear(mount);
  const all = store.tasks(ctx.projectId).filter(ctx.filter);
  const assigned = all.filter((t) => t.crewId && !t.milestone);
  if (!assigned.length) {
    mount.appendChild(el('div', { class: 'empty' }, 'No crew-assigned tasks to level.'));
    return;
  }

  const conflicts = conflictTaskIds(all);     // computed over the whole (unfiltered-by-trade) set below
  // Timeline bounds
  const starts = assigned.map((t) => t.start).sort();
  const ends = assigned.map((t) => t.end).sort();
  const min = Dates.addDays(starts[0], -2);
  const max = Dates.addDays(ends[ends.length - 1], 3);
  const totalDays = Dates.diffDays(min, max) + 1;
  const W = totalDays * DAY_W;
  const xOf = (d) => Dates.diffDays(min, d) * DAY_W;

  // Crews that actually have work in this filtered set, in declared order.
  const crewIds = store.crews.map((c) => c.id).filter((id) => assigned.some((t) => t.crewId === id));
  const packs = new Map(crewIds.map((id) => [id, packLanes(all, id)]));
  const rowH = (id) => packs.get(id).lanes * LANE_H + ROW_PAD;

  const wrap = el('div', { class: 'gantt' });

  // Left: crew labels
  const left = el('div', { class: 'gantt-left' });
  left.appendChild(el('div', { class: 'gantt-left-head' }, 'Crew / Resource'));
  const leftBody = el('div', { class: 'gantt-left-body' });
  crewIds.forEach((id) => {
    const crew = store.crew(id);
    const lanes = packs.get(id).lanes;
    const over = lanes > 1;
    leftBody.appendChild(el('div', {
      class: 'res-name-row' + (over ? ' over' : ''),
      style: { height: rowH(id) + 'px' },
      title: crew.lead ? `Lead: ${crew.lead}` : '',
    }, [
      el('span', { class: 'trade-chip', style: { background: TRADES[crew.trade].color } }),
      el('div', { class: 'res-name-meta' }, [
        el('div', { class: 'res-name' }, crew.name),
        el('div', { class: 'res-sub' }, TRADES[crew.trade].label),
      ]),
      over ? el('span', { class: 'res-conflict', title: 'Double-booked' }, '⚠ ' + lanes + '×') : null,
    ]));
  });
  left.appendChild(leftBody);
  wrap.appendChild(left);

  // Right: timeline
  const right = el('div', { class: 'gantt-right' });
  const chart = el('div', { class: 'gantt-chart', style: { width: W + 'px' } });

  // axis
  const axis = el('div', { class: 'gantt-axis', style: { width: W + 'px', height: HEADER_H + 'px' } });
  let cursor = min, lastMonth = -1;
  for (let i = 0; i < totalDays; i++) {
    const d = Dates.parse(cursor);
    const x = i * DAY_W;
    if (d.getMonth() !== lastMonth) {
      lastMonth = d.getMonth();
      axis.appendChild(el('div', { class: 'axis-month', style: { left: x + 'px' } },
        d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })));
    }
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    axis.appendChild(el('div', { class: 'axis-day' + (weekend ? ' weekend' : ''), style: { left: x + 'px' } }, String(d.getDate())));
    cursor = Dates.addDays(cursor, 1);
  }
  chart.appendChild(axis);

  const gridH = crewIds.reduce((a, id) => a + rowH(id), 0);

  // SVG background: weekend bands, row separators, today line
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'gantt-svg'); svg.setAttribute('width', W); svg.setAttribute('height', gridH);
  svg.style.top = HEADER_H + 'px';
  cursor = min;
  for (let i = 0; i < totalDays; i++) {
    const d = Dates.parse(cursor);
    if (d.getDay() === 0 || d.getDay() === 6) {
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', i * DAY_W); r.setAttribute('y', 0); r.setAttribute('width', DAY_W);
      r.setAttribute('height', gridH); r.setAttribute('class', 'weekend-band'); svg.appendChild(r);
    }
    cursor = Dates.addDays(cursor, 1);
  }
  let yAcc = 0;
  crewIds.forEach((id) => {
    yAcc += rowH(id);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', 0); line.setAttribute('x2', W); line.setAttribute('y1', yAcc); line.setAttribute('y2', yAcc);
    line.setAttribute('class', 'row-sep'); svg.appendChild(line);
  });
  const today = Dates.today();
  if (Dates.diffDays(min, today) >= 0 && Dates.diffDays(today, max) >= 0) {
    const tx = xOf(today) + DAY_W / 2;
    const tl = document.createElementNS(ns, 'line');
    tl.setAttribute('x1', tx); tl.setAttribute('x2', tx); tl.setAttribute('y1', 0); tl.setAttribute('y2', gridH);
    tl.setAttribute('class', 'today-line'); svg.appendChild(tl);
  }
  chart.appendChild(svg);

  // Bars
  const bars = el('div', { class: 'gantt-bars', style: { top: HEADER_H + 'px', height: gridH + 'px' } });
  let rowTop = 0;
  crewIds.forEach((id) => {
    const { placed } = packs.get(id);
    placed.forEach(({ task, lane }) => {
      // only render bars present in the filtered set
      if (!assigned.some((t) => t.id === task.id)) return;
      const x = xOf(task.start);
      const w = (Dates.diffDays(task.start, task.end) + 1) * DAY_W;
      const y = rowTop + lane * LANE_H + 4;
      const trade = TRADES[task.trade];
      const isConflict = conflicts.has(task.id);
      bars.appendChild(el('div', {
        class: 'res-bar' + (isConflict ? ' conflict' : ''),
        style: { left: x + 'px', top: y + 'px', width: Math.max(DAY_W, w) + 'px', background: shade(trade.color, 0.5), borderColor: trade.color },
        title: `${task.name}\n${Dates.fmtLong(task.start)} → ${Dates.fmtLong(task.end)}${isConflict ? '\n⚠ Crew double-booked' : ''}`,
        onclick: () => ctx.openTask(task.id),
      }, el('span', { class: 'bar-label' }, task.name)));
    });
    rowTop += rowH(id);
  });
  chart.appendChild(bars);

  right.appendChild(chart);
  wrap.appendChild(right);
  mount.appendChild(wrap);
  right.addEventListener('scroll', () => { leftBody.scrollTop = right.scrollTop; });
  requestAnimationFrame(() => { const tx = xOf(today); if (tx > 0) right.scrollLeft = Math.max(0, tx - right.clientWidth / 2.5); });
}
