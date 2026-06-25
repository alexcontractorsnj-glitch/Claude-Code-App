// ============================================================================
//  constraints.js (view) — The Last-Planner make-ready log. Lists every
//  constraint (open-first, overdue-flagged) with inline clear, an add row, and
//  a roll-up deck headed by the "% Made Ready" KPI — the share of constrained
//  tasks that have been fully de-constrained and released to the field.
// ============================================================================
import { store, Dates } from '../data.js';
import { el, clear } from '../utils.js';
import { CONSTRAINT_TYPES, CONSTRAINT_TYPE_LABELS, constraintOverdue } from '../constraints.js';

export function renderConstraints(mount, ctx) {
  clear(mount);
  const view = el('div', { class: 'cost-view' });
  const all = store.constraintsForProject(ctx.projectId)
    .slice()
    .sort((a, b) => {
      if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open' ? -1 : 1;
      return (a.needBy || '9999') < (b.needBy || '9999') ? -1 : 1;
    });
  const s = store.constraintSummary(ctx.projectId);
  const mr = store.madeReady(ctx.projectId);
  const canWrite = store.can('write');

  view.appendChild(el('div', { class: 'bill-controls' }, [
    el('div', { class: 'bill-title' }, `Make-Ready Constraints${ctx.projectId === 'all' ? ' — all projects' : ''}`),
    canWrite ? el('button', {
      class: 'btn sm', title: 'Run the AI dispatcher now',
      onclick: async (e) => { e.target.textContent = '⏳ Scanning…'; const n = await store.scanDispatcher(); e.target.textContent = '⚡ Scan now'; store._notify(n ? `Dispatcher posted ${n} alert(s).` : 'Dispatcher: nothing new to flag.', 'info'); },
    }, '⚡ Scan now') : null,
  ]));

  const card = (label, value, tone = '') => el('div', { class: 'evm-card ' + tone }, [el('div', { class: 'evm-label' }, label), el('div', { class: 'evm-value' }, value)]);
  view.appendChild(el('div', { class: 'evm-deck' }, [
    card('% Made Ready', mr.percent == null ? '—' : mr.percent + '%', mr.percent == null ? 'muted' : mr.percent >= 80 ? 'good' : mr.percent >= 50 ? 'warn' : 'bad'),
    card('Open', String(s.open), s.open ? '' : 'good'),
    card('Overdue', String(s.overdue), s.overdue ? 'bad' : 'good'),
    card('Cleared', String(s.cleared), 'muted'),
  ]));
  view.appendChild(el('div', { class: 'mr-note' }, mr.tasks
    ? `${mr.ready}/${mr.tasks} constrained task${mr.tasks === 1 ? '' : 's'} made ready${mr.blocked ? ` · ${mr.blocked} still blocked` : ''}.`
    : 'No tasks carry constraints yet.'));

  // add row
  if (canWrite) {
    const proj = el('select', { class: 'select' }, store.editableProjects().map((p) => el('option', { value: p.id }, p.name)));
    const taskSel = el('select', { class: 'select' });
    const fillTasks = () => { clear(taskSel); taskSel.appendChild(el('option', { value: '' }, '— Task (optional) —')); store.tasks(proj.value).filter((t) => !t.milestone).forEach((t) => taskSel.appendChild(el('option', { value: t.id }, t.name))); };
    fillTasks(); proj.addEventListener('change', fillTasks);
    const title = el('input', { class: 'input', placeholder: 'Constraint (e.g. Steel shop drawings approved)' });
    const type = el('select', { class: 'select' }, CONSTRAINT_TYPES.map((v) => el('option', { value: v }, CONSTRAINT_TYPE_LABELS[v])));
    const who = el('input', { class: 'input', placeholder: 'Responsible' });
    const due = el('input', { class: 'input', type: 'date' });
    view.appendChild(el('div', { class: 'cn-add' }, [
      proj, taskSel, title, type, who, due,
      el('button', { class: 'btn primary sm', onclick: () => {
        if (!title.value.trim()) { store._notify('Constraint description is required.', 'warn'); return; }
        store.createConstraint({ projectId: proj.value, taskId: taskSel.value || null, title: title.value.trim(), type: type.value, responsible: who.value.trim(), needBy: due.value || null });
        title.value = ''; who.value = ''; due.value = '';
      } }, '+ Add'),
    ]));
  }

  if (!all.length) { view.appendChild(el('div', { class: 'empty' }, 'No constraints logged.')); mount.appendChild(view); return; }

  const table = el('div', { class: 'cn-list' });
  all.forEach((c) => {
    const proj = store.project(c.projectId);
    const task = c.taskId ? store.task(c.taskId) : null;
    const editable = store.canEditProject(c.projectId);
    const overdue = constraintOverdue(c);
    table.appendChild(el('div', { class: 'cn-row type-' + c.type + (c.status === 'cleared' ? ' cleared' : '') + (overdue ? ' overdue' : '') }, [
      el('div', { class: 'cn-main' }, [
        el('div', { class: 'cn-title' }, [
          ctx.projectId === 'all' && proj ? el('span', { class: 'dl-dot', style: { background: proj.color } }) : null,
          el('span', {}, `${c.number}  ${c.title}`),
          overdue ? el('span', { class: 'dl-flag bad' }, 'overdue') : null,
        ]),
        el('div', { class: 'cn-meta' }, `${CONSTRAINT_TYPE_LABELS[c.type] || c.type}${c.responsible ? ' · ' + c.responsible : ''}${c.needBy ? ' · need-by ' + Dates.fmt(c.needBy) : ''}${task ? ' · ' + task.name : ''}${c.status === 'cleared' ? ' · cleared by ' + (c.clearedBy || '') : ''}`),
      ]),
      el('div', { class: 'cn-ctl' }, [
        (editable && c.status === 'open') ? el('button', { class: 'btn sm', title: 'Mark cleared', onclick: () => store.updateConstraint(c.id, { status: 'cleared' }) }, '✓ Clear') : null,
        (editable && c.status === 'cleared') ? el('button', { class: 'btn sm ghost', title: 'Reopen', onclick: () => store.updateConstraint(c.id, { status: 'open' }) }, '↺ Reopen') : null,
        editable ? el('button', { class: 'icon-btn', title: 'Delete', onclick: () => store.deleteConstraint(c.id) }, '✕') : null,
      ]),
    ]));
  });
  view.appendChild(table);
  mount.appendChild(view);
}
