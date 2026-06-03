// ============================================================================
//  gantt.js — Time-scaled Gantt chart with dependency arrows + critical path.
//  Pure DOM/SVG, no libraries. Bars are positioned by date against a day grid.
// ============================================================================
import { store, TRADES, STATUSES, Dates, computeCriticalPath } from '../data.js';
import { taskVariance } from '../variance.js';
import { el, clear, pct, shade } from '../utils.js';

const DAY_W = 26;       // px per day
const ROW_H = 38;       // px per task row
const HEADER_H = 48;    // px for the date axis

export function renderGantt(mount, ctx) {
  clear(mount);
  const tasks = store.tasks(ctx.projectId).filter(ctx.filter);
  if (!tasks.length) {
    mount.appendChild(el('div', { class: 'empty' }, 'No tasks match the current filter.'));
    return;
  }

  // Timeline bounds (pad a few days each side)
  const allStarts = tasks.map((t) => t.start).sort();
  const allEnds = tasks.map((t) => t.end).sort();
  const min = Dates.addDays(allStarts[0], -2);
  const max = Dates.addDays(allEnds[allEnds.length - 1], 3);
  const totalDays = Dates.diffDays(min, max) + 1;
  const W = totalDays * DAY_W;

  const critical = ctx.showCritical ? computeCriticalPath(store.tasks(ctx.projectId)) : new Set();
  const xOf = (date) => Dates.diffDays(min, date) * DAY_W;

  // Group rows by project (when viewing "all") then keep task order
  const rows = [];
  const groups = ctx.projectId === 'all'
    ? store.projects.map((p) => p.id) : [ctx.projectId];
  groups.forEach((pid) => {
    const proj = store.project(pid);
    const pt = tasks.filter((t) => t.projectId === pid);
    if (!pt.length) return;
    if (ctx.projectId === 'all') rows.push({ type: 'group', project: proj });
    pt.forEach((t) => rows.push({ type: 'task', task: t }));
  });

  const gridH = rows.length * ROW_H;

  // ---- Layout: left fixed pane (task names) + scrollable chart ----
  const wrap = el('div', { class: 'gantt' });

  // Left labels column
  const left = el('div', { class: 'gantt-left' });
  left.appendChild(el('div', { class: 'gantt-left-head' }, 'Work Package'));
  const leftBody = el('div', { class: 'gantt-left-body' });
  rows.forEach((r) => {
    if (r.type === 'group') {
      leftBody.appendChild(el('div', { class: 'gantt-group-row', style: { borderColor: r.project.color } },
        [el('span', { class: 'dot', style: { background: r.project.color } }), r.project.name]));
    } else {
      const t = r.task;
      const row = el('div', {
        class: 'gantt-name-row' + (critical.has(t.id) ? ' critical' : ''),
        onclick: () => ctx.openTask(t.id),
        title: 'Click to edit',
      }, [
        el('span', { class: 'trade-chip', style: { background: TRADES[t.trade].color } }),
        el('span', { class: 'gantt-name' }, t.name),
        t.milestone ? el('span', { class: 'ms-flag' }, '◆') : null,
      ]);
      leftBody.appendChild(row);
    }
  });
  left.appendChild(leftBody);
  wrap.appendChild(left);

  // Right scrollable chart
  const right = el('div', { class: 'gantt-right' });
  const chart = el('div', { class: 'gantt-chart', style: { width: W + 'px' } });

  // Date axis (months + day ticks)
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
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    axis.appendChild(el('div', {
      class: 'axis-day' + (isWeekend ? ' weekend' : ''),
      style: { left: x + 'px' },
    }, String(d.getDate())));
    cursor = Dates.addDays(cursor, 1);
  }
  chart.appendChild(axis);

  // Grid body (weekend bands + today line) via SVG behind the bars
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'gantt-svg');
  svg.setAttribute('width', W);
  svg.setAttribute('height', gridH);
  svg.style.top = HEADER_H + 'px';

  // weekend bands
  cursor = min;
  for (let i = 0; i < totalDays; i++) {
    const d = Dates.parse(cursor);
    if (d.getDay() === 0 || d.getDay() === 6) {
      const band = document.createElementNS(svgNS, 'rect');
      band.setAttribute('x', i * DAY_W); band.setAttribute('y', 0);
      band.setAttribute('width', DAY_W); band.setAttribute('height', gridH);
      band.setAttribute('class', 'weekend-band');
      svg.appendChild(band);
    }
    cursor = Dates.addDays(cursor, 1);
  }
  // horizontal row separators
  rows.forEach((_, i) => {
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', 0); line.setAttribute('x2', W);
    line.setAttribute('y1', (i + 1) * ROW_H); line.setAttribute('y2', (i + 1) * ROW_H);
    line.setAttribute('class', 'row-sep');
    svg.appendChild(line);
  });

  // Build a y-index map for tasks (to draw dependency arrows)
  const yIndex = new Map();
  rows.forEach((r, i) => { if (r.type === 'task') yIndex.set(r.task.id, i); });

  // Dependency arrows (finish-to-start)
  const arrowDefs = document.createElementNS(svgNS, 'defs');
  arrowDefs.innerHTML = `<marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="#90a4ae"/></marker>
    <marker id="arrow-crit" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="#e53935"/></marker>`;
  svg.appendChild(arrowDefs);

  rows.forEach((r) => {
    if (r.type !== 'task') return;
    const t = r.task;
    t.dependencies.forEach((depId) => {
      if (!yIndex.has(depId)) return;
      const dep = store.task(depId);
      const x1 = xOf(Dates.addDays(dep.end, 1));
      const y1 = yIndex.get(depId) * ROW_H + ROW_H / 2;
      const x2 = xOf(t.start);
      const y2 = yIndex.get(t.id) * ROW_H + ROW_H / 2;
      const isCrit = critical.has(depId) && critical.has(t.id);
      const path = document.createElementNS(svgNS, 'path');
      const midX = Math.max(x1 + 10, x2 - 10);
      path.setAttribute('d', `M${x1},${y1} H${midX} V${y2} H${x2}`);
      path.setAttribute('class', 'dep-line' + (isCrit ? ' crit' : ''));
      path.setAttribute('marker-end', isCrit ? 'url(#arrow-crit)' : 'url(#arrow)');
      svg.appendChild(path);
    });
  });

  // today line
  const today = Dates.today();
  if (Dates.diffDays(min, today) >= 0 && Dates.diffDays(today, max) >= 0) {
    const tx = xOf(today) + DAY_W / 2;
    const tl = document.createElementNS(svgNS, 'line');
    tl.setAttribute('x1', tx); tl.setAttribute('x2', tx);
    tl.setAttribute('y1', 0); tl.setAttribute('y2', gridH);
    tl.setAttribute('class', 'today-line');
    svg.appendChild(tl);
  }
  chart.appendChild(svg);

  // Bars layer (HTML for easy interaction)
  const barsLayer = el('div', { class: 'gantt-bars', style: { top: HEADER_H + 'px', height: gridH + 'px' } });

  // Floating readout shown while dragging (shared across all bars)
  const tip = el('div', { class: 'gantt-drag-tip' });
  barsLayer.appendChild(tip);

  // ---- Drag-to-reschedule -------------------------------------------------
  // kind: 'move' (shift both ends) | 'left' (change start) | 'right' (change
  // end) | 'milestone' (move the single date). Snaps to whole days. Commits to
  // the store on release, which triggers a full re-render (deps/CP refresh).
  function attachDrag(node, t, kind, posKey) {
    node.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (kind === 'move' && e.target.classList.contains('bar-handle')) return; // let handle own it
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const origLeft = parseFloat(node.style.left);
      const origWidth = kind === 'milestone' ? 0 : parseFloat(node.style.width);
      const span = Dates.diffDays(t.start, t.end); // duration - 1
      let moved = false, preview = null;
      document.body.classList.add('dragging-gantt');
      node.classList.add('dragging');
      tip.style.display = 'block';

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        if (Math.abs(dx) > 3) moved = true;
        let dd = Math.round(dx / DAY_W);
        let nl = origLeft, nw = origWidth, ns = t.start, ne = t.end;
        if (kind === 'move' || kind === 'milestone') {
          nl = origLeft + dd * DAY_W;
          ns = Dates.addDays(t.start, dd);
          ne = kind === 'milestone' ? ns : Dates.addDays(t.end, dd);
        } else if (kind === 'left') {
          dd = Math.min(dd, span);             // keep >= 1 day
          nl = origLeft + dd * DAY_W;
          nw = origWidth - dd * DAY_W;
          ns = Dates.addDays(t.start, dd);
        } else if (kind === 'right') {
          dd = Math.max(dd, -span);            // keep >= 1 day
          nw = origWidth + dd * DAY_W;
          ne = Dates.addDays(t.end, dd);
        }
        node.style.left = nl + 'px';
        if (kind !== 'milestone') node.style.width = Math.max(DAY_W, nw) + 'px';
        preview = { start: ns, end: ne };
        tip.textContent = kind === 'milestone' ? Dates.fmt(ns) : `${Dates.fmt(ns)} → ${Dates.fmt(ne)}`;
        tip.style.left = nl + 'px';
        tip.style.top = (parseFloat(node.style.top) - 24) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('dragging-gantt');
        tip.style.display = 'none';
        node._suppressClick = moved;
        if (moved && preview && (preview.start !== t.start || preview.end !== t.end)) {
          store.updateTask(t.id, { start: preview.start, end: preview.end });
        } else {
          node.classList.remove('dragging');
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  rows.forEach((r, i) => {
    if (r.type !== 'task') return;
    const t = r.task;
    const x = xOf(t.start);
    const w = (Dates.diffDays(t.start, t.end) + 1) * DAY_W;
    const y = i * ROW_H + 6;
    const trade = TRADES[t.trade];
    const isCrit = critical.has(t.id);
    const open = (node) => () => { if (node._suppressClick) { node._suppressClick = false; return; } ctx.openTask(t.id); };

    // Baseline ghost bar (planned schedule) drawn beneath the live bar.
    const variance = (ctx.showBaseline && store.baseline) ? taskVariance(t, store.baseline) : null;
    if (variance) {
      const bx = xOf(variance.baselineStart);
      const bw = (Dates.diffDays(variance.baselineStart, variance.baselineEnd) + 1) * DAY_W;
      barsLayer.appendChild(el('div', {
        class: 'baseline-bar' + (variance.finishVar > 0 ? ' late' : variance.finishVar < 0 ? ' early' : ''),
        style: { left: bx + 'px', top: (y + 27) + 'px', width: Math.max(DAY_W, bw) + 'px' },
        title: `Baseline: ${Dates.fmtLong(variance.baselineStart)} → ${Dates.fmtLong(variance.baselineEnd)}`,
      }));
    }
    const slipNote = variance && variance.finishVar
      ? `\nBaseline finish: ${Dates.fmtLong(variance.baselineEnd)} (${variance.finishVar > 0 ? '+' : ''}${variance.finishVar}d ${variance.finishVar > 0 ? 'late' : 'early'})`
      : '';

    if (t.milestone) {
      const ms = el('div', {
        class: 'milestone' + (isCrit ? ' critical' : ''),
        style: { left: (x + DAY_W / 2 - 9) + 'px', top: (y) + 'px' },
        title: `${t.name} — ${Dates.fmtLong(t.start)} (drag to move)`,
      });
      ms.addEventListener('click', open(ms));
      attachDrag(ms, t, 'milestone');
      barsLayer.appendChild(ms);
      barsLayer.appendChild(el('div', { class: 'milestone-label', style: { left: (x + DAY_W) + 'px', top: y + 'px' } }, t.name));
      return;
    }

    const bar = el('div', {
      class: 'bar' + (isCrit ? ' critical' : '') + (t.status === 'blocked' ? ' blocked' : ''),
      style: {
        left: x + 'px', top: y + 'px', width: Math.max(DAY_W, w) + 'px',
        background: shade(trade.color, 0.55), borderColor: trade.color,
      },
      title: `${t.name}\n${Dates.fmtLong(t.start)} → ${Dates.fmtLong(t.end)}\n${pct(t.progress)} complete${isCrit ? ' • CRITICAL PATH' : ''}${slipNote}\nDrag to reschedule · drag edges to resize`,
    }, [
      el('div', { class: 'bar-fill', style: { width: t.progress + '%', background: trade.color } }),
      el('span', { class: 'bar-label' }, t.name),
      el('div', { class: 'bar-handle left' }),
      el('div', { class: 'bar-handle right' }),
    ]);
    bar.addEventListener('click', open(bar));
    attachDrag(bar, t, 'move');
    attachDrag(bar.querySelector('.bar-handle.left'), t, 'left');
    attachDrag(bar.querySelector('.bar-handle.right'), t, 'right');
    barsLayer.appendChild(bar);
  });
  chart.appendChild(barsLayer);

  right.appendChild(chart);
  wrap.appendChild(right);
  mount.appendChild(wrap);

  // Sync vertical scroll between left labels and chart
  right.addEventListener('scroll', () => { leftBody.scrollTop = right.scrollTop; });

  // Scroll so "today" is roughly in view
  requestAnimationFrame(() => {
    const tx = xOf(today);
    if (tx > 0) right.scrollLeft = Math.max(0, tx - right.clientWidth / 2.5);
  });
}
