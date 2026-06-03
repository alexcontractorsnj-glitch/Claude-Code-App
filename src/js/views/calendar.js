// ============================================================================
//  calendar.js — Monthly calendar. Renders task spans across the days they
//  occupy + milestone markers. Month navigation is held in ctx.calMonth.
// ============================================================================
import { store, TRADES, STATUSES, Dates } from '../data.js';
import { el, clear } from '../utils.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function renderCalendar(mount, ctx) {
  clear(mount);
  const tasks = store.tasks(ctx.projectId).filter(ctx.filter);

  // Anchor month
  const anchor = ctx.calMonth ? new Date(ctx.calMonth + '-01T00:00:00') : new Date();
  const year = anchor.getFullYear(), month = anchor.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const gridStart = new Date(year, month, 1 - startOffset);
  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

  // ---- header / nav ----
  const head = el('div', { class: 'cal-head' }, [
    el('button', { class: 'cal-nav', onclick: () => ctx.shiftMonth(-1) }, '‹'),
    el('div', { class: 'cal-title' },
      anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })),
    el('button', { class: 'cal-nav', onclick: () => ctx.shiftMonth(1) }, '›'),
    el('button', { class: 'cal-today-btn', onclick: () => ctx.gotoToday() }, 'Today'),
  ]);
  mount.appendChild(head);

  const grid = el('div', { class: 'cal-grid' });
  WEEKDAYS.forEach((w) => grid.appendChild(el('div', { class: 'cal-weekday' }, w)));

  const todayIso = Dates.today();
  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const iso = Dates.iso(d);
    const inMonth = d.getMonth() === month;
    const cell = el('div', {
      class: 'cal-cell' + (inMonth ? '' : ' muted') + (iso === todayIso ? ' today' : ''),
    }, [
      el('div', { class: 'cal-daynum' }, String(d.getDate())),
      el('div', { class: 'cal-events' }),
    ]);
    cells.push({ iso, node: cell, events: cell.querySelector('.cal-events') });
    grid.appendChild(cell);
  }
  const cellByIso = new Map(cells.map((c) => [c.iso, c]));
  const rangeStart = cells[0].iso, rangeEnd = cells[cells.length - 1].iso;

  // Place each task's active days within this month grid
  tasks.forEach((t) => {
    // milestone = single marker
    if (t.milestone) {
      const c = cellByIso.get(t.start);
      if (c) c.events.appendChild(el('div', {
        class: 'cal-ms',
        title: t.name,
        onclick: (e) => { e.stopPropagation(); ctx.openTask(t.id); },
      }, [el('span', { class: 'ms-diamond' }, '◆'), el('span', { class: 'cal-ms-label' }, t.name)]));
      return;
    }
    // span: clamp to visible grid
    const s = t.start < rangeStart ? rangeStart : t.start;
    const e = t.end > rangeEnd ? rangeEnd : t.end;
    if (e < rangeStart || s > rangeEnd) return;
    const trade = TRADES[t.trade];
    let cur = s;
    while (cur <= e) {
      const c = cellByIso.get(cur);
      if (c) {
        const isStart = cur === t.start;
        const isEnd = cur === t.end;
        c.events.appendChild(el('div', {
          class: 'cal-bar' + (isStart ? ' start' : '') + (isEnd ? ' end' : '') +
                 (t.status === 'done' ? ' done' : '') + (t.status === 'blocked' ? ' blocked' : ''),
          style: { background: trade.color },
          title: `${t.name} (${STATUSES[t.status].label})`,
          onclick: (ev) => { ev.stopPropagation(); ctx.openTask(t.id); },
        }, isStart ? t.name : ''));
      }
      cur = Dates.addDays(cur, 1);
    }
  });

  mount.appendChild(grid);
}
