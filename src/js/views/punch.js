// ============================================================================
//  punch.js (view) — Punch list & closeout readiness. A readiness deck plus the
//  punch-item table (status, priority, location, trade, assignee, attachments).
// ============================================================================
import { store, TRADES } from '../data.js';
import { closeoutSummary, PUNCH_TONE, isOpenPunch } from '../punch.js';
import { el, clear, pct } from '../utils.js';

export function renderPunch(mount, ctx) {
  clear(mount);
  const view = el('div', { class: 'cost-view' });
  const items = store.punch.filter((p) => ctx.projectId === 'all' || p.projectId === ctx.projectId);
  const s = closeoutSummary(store.punch, ctx.projectId);

  view.appendChild(el('div', { class: 'bill-controls' }, [
    el('div', { class: 'bill-title' }, `Punch List & Closeout${ctx.projectId === 'all' ? ' — all projects' : ''}`),
    store.can('write') ? el('button', { class: 'btn primary sm', onclick: () => ctx.openPunch(null) }, '+ New Punch Item') : null,
  ]));

  // closeout readiness deck
  const ready = s.blocking === 0;
  const card = (label, value, tone = '') => el('div', { class: 'evm-card ' + tone }, [el('div', { class: 'evm-label' }, label), el('div', { class: 'evm-value' }, value)]);
  view.appendChild(el('div', { class: 'evm-deck' }, [
    card('Closeout Readiness', pct(s.percentAccepted * 100), ready ? 'good' : (s.percentAccepted >= 0.9 ? 'warn' : 'bad')),
    card('Open', String(s.open), s.open ? 'warn' : 'good'),
    card('Ready for Review', String(s.ready), 'info'),
    card('Accepted', String(s.accepted), 'good'),
    card('Rejected', String(s.rejected), s.rejected ? 'bad' : ''),
    card('High Priority Open', String(s.highOpen), s.highOpen ? 'bad' : 'good'),
  ]));

  // punch table
  const th = (t) => el('th', {}, t);
  const rows = items.sort((a, b) => (isOpenPunch(b) - isOpenPunch(a)) || (a.number < b.number ? -1 : 1)).map((p) => {
    const proj = store.project(p.projectId);
    const task = p.taskId ? store.task(p.taskId) : null;
    return el('tr', { style: { cursor: 'pointer' }, onclick: () => ctx.openPunch(p.id) }, [
      el('td', {}, p.number),
      el('td', {}, [
        el('div', {}, [el('span', { class: 'trade-chip', style: { background: (TRADES[p.trade] || {}).color || '#888', display: 'inline-block', marginRight: '7px' } }), p.title]),
        p.attachments && p.attachments.length ? el('span', { class: 'punch-attach' }, `📎 ${p.attachments.length}`) : null,
        task ? el('span', { class: 'doc-link', onclick: (e) => { e.stopPropagation(); ctx.openTask(task.id); } }, ' ↳ ' + task.name) : null,
      ]),
      el('td', {}, ctx.projectId === 'all' && proj ? el('span', { style: { color: proj.color } }, proj.name) : (p.location || '—')),
      el('td', {}, p.assignedTo || '—'),
      el('td', {}, el('span', { class: 'prio prio-' + p.priority }, p.priority)),
      el('td', {}, el('span', { class: 'status-badge tone-' + (PUNCH_TONE[p.status] || 'muted') }, p.status)),
    ]);
  });
  view.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, ready && items.length ? '✓ No blocking items — ready for closeout' : 'Punch Items'),
    items.length ? el('div', { class: 'table-scroll' }, el('table', { class: 'evm-table' }, [
      el('thead', {}, el('tr', {}, [th('#'), th('Item'), th(ctx.projectId === 'all' ? 'Project' : 'Location'), th('Assigned'), th('Priority'), th('Status')])),
      el('tbody', {}, rows),
    ])) : el('div', { class: 'docs-empty' }, 'No punch items.'),
  ]));

  mount.appendChild(view);
}
