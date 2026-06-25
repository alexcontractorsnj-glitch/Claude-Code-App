// ============================================================================
//  deliveries.js (view) — Material/equipment deliveries the AI Dispatcher
//  watches. Inline-editable list (status + due), an add row, a risk roll-up,
//  and a "Scan now" button to run the dispatcher on demand.
// ============================================================================
import { store, Dates, TRADES } from '../data.js';
import { el, clear } from '../utils.js';
import { DELIVERY_STATUSES, deliveryRisk } from '../deliveries.js';

const STATUS_TONE = { scheduled: '', confirmed: 'good', 'in-transit': 'good', delayed: 'bad', delivered: 'muted' };

export function renderDeliveries(mount, ctx) {
  clear(mount);
  const view = el('div', { class: 'cost-view' });
  const list = store.deliveriesFor(ctx.projectId);
  const s = store.deliverySummary(ctx.projectId);
  const canWrite = store.can('write');

  view.appendChild(el('div', { class: 'bill-controls' }, [
    el('div', { class: 'bill-title' }, `Deliveries${ctx.projectId === 'all' ? ' — all projects' : ''}`),
    canWrite ? el('button', {
      class: 'btn sm', title: 'Run the AI dispatcher now',
      onclick: async (e) => { e.target.textContent = '⏳ Scanning…'; const n = await store.scanDispatcher(); e.target.textContent = '⚡ Scan now'; store._notify(n ? `Dispatcher posted ${n} alert(s).` : 'Dispatcher: nothing new to flag.', 'info'); },
    }, '⚡ Scan now') : null,
  ]));

  // risk roll-up
  const card = (label, value, tone = '') => el('div', { class: 'evm-card ' + tone }, [el('div', { class: 'evm-label' }, label), el('div', { class: 'evm-value' }, value)]);
  view.appendChild(el('div', { class: 'evm-deck' }, [
    card('Open', String(s.open), s.open ? '' : 'good'),
    card('Late', String(s.late), s.late ? 'bad' : 'good'),
    card('Due Soon', String(s.soon), s.soon ? 'warn' : 'good'),
    card('Delivered', String(s.delivered), 'muted'),
  ]));

  // add row
  if (canWrite) {
    const proj = el('select', { class: 'select' }, store.editableProjects().map((p) => el('option', { value: p.id }, p.name)));
    const item = el('input', { class: 'input', placeholder: 'Item (e.g. Rebar #5)' });
    const sup = el('input', { class: 'input', placeholder: 'Supplier' });
    const due = el('input', { class: 'input', type: 'date', value: Dates.today() });
    view.appendChild(el('div', { class: 'dl-add' }, [
      proj, item, sup, due,
      el('button', { class: 'btn primary sm', onclick: () => {
        if (!item.value.trim()) { store._notify('Item is required.', 'warn'); return; }
        store.createDelivery({ projectId: proj.value, item: item.value.trim(), supplier: sup.value.trim(), due: due.value || Dates.today() });
        item.value = ''; sup.value = '';
      } }, '+ Add'),
    ]));
  }

  if (!list.length) { view.appendChild(el('div', { class: 'empty' }, 'No deliveries logged.')); mount.appendChild(view); return; }

  const table = el('div', { class: 'dl-list' });
  list.forEach((d) => {
    const proj = store.project(d.projectId);
    const r = deliveryRisk(d, Dates.today());
    const editable = store.canEditProject(d.projectId);
    const task = d.taskId ? store.task(d.taskId) : null;
    const statusSel = el('select', { class: 'select sm', disabled: !editable || undefined,
      onchange: (e) => store.updateDelivery(d.id, { status: e.target.value }) },
      DELIVERY_STATUSES.map((st) => el('option', { value: st, selected: st === d.status }, st)));
    const dueInput = el('input', { class: 'input sm', type: 'date', value: d.due, disabled: !editable || undefined,
      onchange: (e) => store.updateDelivery(d.id, { due: e.target.value }) });
    table.appendChild(el('div', { class: 'dl-row' + (r.late ? ' late' : r.dueSoon ? ' soon' : '') }, [
      el('div', { class: 'dl-main' }, [
        el('div', { class: 'dl-item' }, [
          ctx.projectId === 'all' && proj ? el('span', { class: 'dl-dot', style: { background: proj.color } }) : null,
          el('span', {}, d.item),
          r.late ? el('span', { class: 'dl-flag bad' }, r.days < 0 ? `${-r.days}d late` : 'delayed') : (r.dueSoon ? el('span', { class: 'dl-flag warn' }, r.days === 0 ? 'due today' : `in ${r.days}d`) : null),
        ]),
        el('div', { class: 'dl-sub' }, [d.supplier || '—', task ? ' · feeds ' + task.name : ''].join('')),
      ]),
      el('div', { class: 'dl-ctl' }, [dueInput, statusSel,
        editable ? el('button', { class: 'icon-btn', title: 'Delete', onclick: () => store.deleteDelivery(d.id) }, '✕') : null]),
    ]));
  });
  view.appendChild(table);
  mount.appendChild(view);
}
