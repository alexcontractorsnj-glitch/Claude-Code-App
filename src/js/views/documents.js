// ============================================================================
//  documents.js (view) — Submittals & RFIs, split into two columns. Each card
//  shows number, title, status, ball-in-court, due date (overdue flagged) and
//  the linked task. Writers get "New" buttons; clicking a card opens the editor.
// ============================================================================
import { store, Dates } from '../data.js';
import { DOC_KINDS, STATUS_TONE, isOpen } from '../docs.js';
import { el, clear } from '../utils.js';

export function renderDocuments(mount, ctx) {
  clear(mount);
  const all = store.docs.filter((d) => ctx.projectId === 'all' || d.projectId === ctx.projectId);
  const today = Dates.today();
  const grid = el('div', { class: 'docs-grid' });

  ['submittal', 'rfi'].forEach((kind) => {
    const meta = DOC_KINDS[kind];
    const list = all.filter((d) => d.kind === kind);
    const open = list.filter(isOpen).length;
    const col = el('div', { class: 'docs-col' });
    col.appendChild(el('div', { class: 'docs-col-head' }, [
      el('span', { class: 'docs-col-title' }, meta.label + 's'),
      el('span', { class: 'docs-count' }, `${open} open / ${list.length}`),
      store.can('write') ? el('button', { class: 'btn ghost sm', onclick: () => ctx.openDoc(null, kind) }, '+ New') : null,
    ]));
    const body = el('div', { class: 'docs-list' });
    if (!list.length) body.appendChild(el('div', { class: 'docs-empty' }, `No ${meta.label.toLowerCase()}s.`));
    list.sort((a, b) => (isOpen(b) - isOpen(a)) || (a.number < b.number ? -1 : 1)).forEach((d) => {
      const proj = store.project(d.projectId);
      const task = d.taskId ? store.task(d.taskId) : null;
      const overdue = isOpen(d) && d.due && d.due < today;
      body.appendChild(el('div', { class: 'doc-card', onclick: () => ctx.openDoc(d.id) }, [
        el('div', { class: 'doc-top' }, [
          el('span', { class: 'doc-num' }, d.number),
          el('span', { class: 'status-badge tone-' + (STATUS_TONE[d.status] || 'muted') }, d.status.replace('-', ' ')),
        ]),
        el('div', { class: 'doc-title' }, d.title),
        el('div', { class: 'doc-meta' }, [
          ctx.projectId === 'all' && proj ? el('span', { style: { color: proj.color } }, proj.name + ' · ') : null,
          d.court ? el('span', {}, meta.courtLabel + ': ' + d.court) : null,
        ]),
        el('div', { class: 'doc-foot' }, [
          d.due ? el('span', { class: 'doc-due' + (overdue ? ' overdue' : '') }, (overdue ? '⚠ due ' : 'due ') + Dates.fmt(d.due)) : el('span', { class: 'doc-due' }, 'no due date'),
          task ? el('span', { class: 'doc-link', onclick: (e) => { e.stopPropagation(); ctx.openTask(task.id); } }, '↳ ' + task.name) : null,
        ]),
      ]));
    });
    col.appendChild(body);
    grid.appendChild(col);
  });

  mount.appendChild(grid);
}
