// ============================================================================
//  board.js — Kanban board. Columns = status. Drag a card between columns to
//  change its status (mutates the shared store → Gantt/Calendar update too).
// ============================================================================
import { store, TRADES, STATUSES, STATUS_ORDER, Dates } from '../data.js';
import { el, clear, pct } from '../utils.js';

export function renderBoard(mount, ctx) {
  clear(mount);
  const tasks = store.tasks(ctx.projectId).filter(ctx.filter);
  const board = el('div', { class: 'board' });

  STATUS_ORDER.forEach((status) => {
    const colTasks = tasks.filter((t) => t.status === status);
    const col = el('div', { class: 'board-col', dataset: { status } });

    col.appendChild(el('div', { class: 'board-col-head' }, [
      el('span', { class: 'col-dot', style: { background: STATUSES[status].color } }),
      el('span', { class: 'col-title' }, STATUSES[status].label),
      el('span', { class: 'col-count' }, String(colTasks.length)),
    ]));

    const list = el('div', { class: 'board-list' });

    // drop handling
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      if (id) store.updateTask(id, { status });
    });

    colTasks.forEach((t) => {
      const proj = store.project(t.projectId);
      const crew = store.crew(t.crewId);
      const trade = TRADES[t.trade];
      const card = el('div', {
        class: 'card' + (t.milestone ? ' milestone' : ''),
        draggable: 'true',
        style: { borderLeftColor: trade.color },
        onclick: () => ctx.openTask(t.id),
      }, [
        el('div', { class: 'card-top' }, [
          el('span', { class: 'card-trade', style: { background: trade.color } }, trade.label),
          t.milestone ? el('span', { class: 'card-ms' }, '◆ Milestone') : null,
        ]),
        el('div', { class: 'card-title' }, t.name),
        el('div', { class: 'card-meta' }, [
          el('span', { class: 'card-proj', style: { color: proj.color } }, proj.name),
        ]),
        el('div', { class: 'card-dates' },
          `${Dates.fmt(t.start)} → ${Dates.fmt(t.end)}`),
        crew ? el('div', { class: 'card-crew' }, [
          el('span', { class: 'crew-avatar' }, crew.name.split(' ').map((w) => w[0]).slice(0, 2).join('')),
          el('span', {}, crew.name),
        ]) : null,
        el('div', { class: 'card-progress' }, [
          el('div', { class: 'card-progress-bar' }, [
            el('div', { class: 'card-progress-fill', style: { width: t.progress + '%', background: STATUSES[t.status].color } }),
          ]),
          el('span', { class: 'card-progress-label' }, pct(t.progress)),
        ]),
        t.lastEditedBy ? el('div', { class: 'card-edit' }, `✎ ${t.lastEditedBy}`) : null,
      ]);

      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', t.id);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      list.appendChild(card);
    });

    if (!colTasks.length) list.appendChild(el('div', { class: 'board-empty' }, 'Drop tasks here'));
    col.appendChild(list);
    board.appendChild(col);
  });

  mount.appendChild(board);
}
