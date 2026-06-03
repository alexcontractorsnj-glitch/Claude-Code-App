// ============================================================================
//  billing.js (view) — Schedule of Values & progress billing. Per project:
//  a G702 summary + G703 continuation sheet for the latest (or selected)
//  payment application, with generate / delete / CSV export. Before any app
//  exists, shows a live preview from current progress.
// ============================================================================
import { store, TRADES } from '../data.js';
import { g703Rows, g702Summary, appsForProject, buildApplication } from '../billing.js';
import { el, clear, money, pct } from '../utils.js';

function csvDownload(rows, name) {
  const cell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['Item', 'Trade', 'Scheduled Value', 'From Previous', 'This Period', 'Completed to Date', '%', 'Balance to Finish', 'Retainage'];
  const lines = [head.join(',')].concat(rows.map((r) => [
    r.name, (TRADES[r.trade] || {}).label || r.trade, r.scheduledValue, r.fromPrevious, r.thisPeriod,
    r.completedToDate, Math.round(r.percent * 100) + '%', r.balanceToFinish, r.retainage,
  ].map(cell).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderBilling(mount, ctx) {
  clear(mount);
  const view = el('div', { class: 'cost-view' });

  // Portfolio mode: a card per project linking into its billing detail.
  if (ctx.projectId === 'all') {
    view.appendChild(el('div', { class: 'panel-head' }, 'Billing — select a project'));
    const grid = el('div', { class: 'evm-deck' });
    store.projects.forEach((p) => {
      const apps = appsForProject(store.payApps, p.id);
      const last = apps[apps.length - 1];
      const s = last ? g702Summary(last, apps[apps.length - 2]) : null;
      grid.appendChild(el('div', { class: 'evm-card', style: { cursor: 'pointer', borderLeftColor: p.color }, onclick: () => ctx.setProject(p.id) }, [
        el('div', { class: 'evm-label' }, p.name),
        el('div', { class: 'evm-value' }, s ? money(s.currentPaymentDue) : '—'),
        el('div', { class: 'evm-sub' }, last ? `App #${last.number} · ${Math.round(s.percentComplete * 100)}% complete` : 'No applications yet'),
      ]));
    });
    view.appendChild(grid);
    mount.appendChild(view);
    return;
  }

  const project = store.project(ctx.projectId);
  const apps = appsForProject(store.payApps, project.id);
  const rw = store.canEditProject(project.id);

  // Which app to show (default latest), and a live preview if none exist.
  let sel = apps[apps.length - 1];
  let preview = false;
  if (!sel) {
    sel = buildApplication(project, store.tasks(project.id), { number: 1, retainagePct: 0, periodTo: '', createdBy: '', createdAt: '' }, null);
    preview = true;
  }
  const prevApp = preview ? null : apps[apps.indexOf(sel) - 1];
  const summary = g702Summary(sel, prevApp);
  const rows = g703Rows(sel, prevApp);

  // ---- controls ----
  const retain = el('input', { class: 'input sm', type: 'number', min: '0', max: '50', step: '0.5', value: '5', style: { width: '64px' } });
  const controls = el('div', { class: 'bill-controls' }, [
    el('div', { class: 'bill-title' }, [
      el('span', { class: 'proj-dot', style: { background: project.color } }),
      `${project.name} — ${preview ? 'Preview (not yet billed)' : 'Payment Application #' + sel.number}`,
    ]),
    el('div', { class: 'bill-actions' }, [
      apps.length > 1 ? (() => {
        const s = el('select', { class: 'select sm', onchange: (e) => { ctx.billingApp = e.target.value; renderBilling(mount, ctx); } },
          apps.map((a) => el('option', { value: a.id }, 'App #' + a.number + ' · ' + a.periodTo)));
        s.value = sel.id; return s;
      })() : null,
      rw ? el('label', { class: 'bill-retain' }, ['Retainage %', retain]) : null,
      rw ? el('button', { class: 'btn primary sm', onclick: async () => { await store.createPayApp(project.id, +retain.value || 0); ctx.billingApp = null; renderBilling(mount, ctx); } }, '+ Generate Application') : null,
      el('button', { class: 'btn ghost sm', onclick: () => csvDownload(rows, `${project.name.replace(/\W+/g, '-')}-G703-${preview ? 'preview' : 'app' + sel.number}.csv`) }, '⤓ Export G703'),
      (rw && !preview) ? el('button', { class: 'btn ghost sm', onclick: () => { if (confirm(`Delete Application #${sel.number}?`)) { store.deletePayApp(sel.id); ctx.billingApp = null; renderBilling(mount, ctx); } } }, 'Delete') : null,
    ]),
  ]);
  view.appendChild(controls);

  // ---- G702 summary ----
  const card = (label, value, tone = '') => el('div', { class: 'evm-card ' + tone }, [el('div', { class: 'evm-label' }, label), el('div', { class: 'evm-value' }, value)]);
  view.appendChild(el('div', { class: 'evm-deck' }, [
    card('Original Contract Sum', money(summary.contractSum)),
    card('Completed & Stored', money(summary.totalCompleted), 'good'),
    card('Retainage', money(summary.totalRetainage)),
    card('Less Previous Certs', money(summary.lessPrevious)),
    card('Current Payment Due', money(summary.currentPaymentDue), 'good'),
    card('Balance to Finish', money(summary.balanceToFinish)),
  ]));

  // ---- G703 continuation sheet ----
  const th = (t, n) => el('th', { class: n ? 'num' : '' }, t);
  const td = (v, n, cls = '') => el('td', { class: (n ? 'num ' : '') + cls }, v);
  const body = rows.map((r) => el('tr', {}, [
    el('td', {}, [el('span', { class: 'trade-chip', style: { background: (TRADES[r.trade] || {}).color || '#888', display: 'inline-block', marginRight: '7px' } }), r.name]),
    td(money(r.scheduledValue), true), td(money(r.fromPrevious), true), td(money(r.thisPeriod), true),
    td(money(r.completedToDate), true), td(pct(r.percent * 100), true),
    td(money(r.balanceToFinish), true), td(money(r.retainage), true),
  ]));
  view.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, 'Schedule of Values (G703)'),
    el('div', { class: 'table-scroll' }, el('table', { class: 'evm-table' }, [
      el('thead', {}, el('tr', {}, [th('Item'), th('Scheduled Value', 1), th('From Previous', 1), th('This Period', 1), th('Completed', 1), th('%', 1), th('Balance', 1), th('Retainage', 1)])),
      el('tbody', {}, body),
    ])),
  ]));

  mount.appendChild(view);
}
