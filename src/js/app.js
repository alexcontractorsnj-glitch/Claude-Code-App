// ============================================================================
//  app.js — Application shell & controller.
//  Owns the view router, the top filters, the KPI summary bar, and the task
//  editor modal. Re-renders the active view whenever the store changes.
// ============================================================================
import { store, TRADES, STATUSES, STATUS_ORDER, Dates, computeCriticalPath } from './data.js';
import { el, clear, money, pct } from './utils.js';
import { renderGantt } from './views/gantt.js';
import { renderBoard } from './views/board.js';
import { renderCalendar } from './views/calendar.js';
import { renderCost } from './views/cost.js';
import { renderResources } from './views/resources.js';
import { renderBilling } from './views/billing.js';
import { renderDocuments } from './views/documents.js';
import { renderField } from './views/field.js';
import { renderPunch } from './views/punch.js';
import { DOC_KINDS } from './docs.js';
import { CO_STATUSES } from './changeorders.js';
import { WEATHER } from './fieldreports.js';
import { PUNCH_STATUSES, PUNCH_PRIORITIES } from './punch.js';
import { scheduleVariance, taskVariance, compareBaselines } from './variance.js';
import { levelingSummary, assignmentConflicts, proposeLeveling, applyChanges, detectConflicts } from './leveling.js';
import { computeAlerts, alertSummary } from './alerts.js';

const ctx = {
  view: 'gantt',
  projectId: 'all',
  tradeFilter: 'all',
  showCritical: true,
  showBaseline: true,
  calMonth: Dates.iso(new Date()).slice(0, 7),
  filter: (t) => ctx.tradeFilter === 'all' || t.trade === ctx.tradeFilter,
  openTask: (id) => openEditor(id),
  shiftMonth: (delta) => {
    const [y, m] = ctx.calMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    ctx.calMonth = Dates.iso(d).slice(0, 7);
    renderActiveView();
  },
  gotoToday: () => { ctx.calMonth = Dates.iso(new Date()).slice(0, 7); renderActiveView(); },
  canWrite: () => store.can('write'),
  canEditProject: (pid) => store.canEditProject(pid),
  setProject: (pid) => { ctx.projectId = pid; ctx.billingApp = null; renderHeaderAndView(); },
  openDoc: (id, kind) => openDocEditor(id, kind),
  openCo: (id, projectId) => openCoEditor(id, projectId),
  openReport: (id) => openReportEditor(id),
  openPunch: (id) => openPunchEditor(id),
  billingApp: null,
};

function renderHeaderAndView() {
  renderHeader(document.getElementById('app'));
  renderActiveView();
}

const VIEWS = {
  gantt: { label: 'Gantt', icon: '▦', render: renderGantt },
  board: { label: 'Board', icon: '▤', render: renderBoard },
  calendar: { label: 'Calendar', icon: '▣', render: renderCalendar },
  resources: { label: 'Resources', icon: '☷', render: renderResources },
  cost: { label: 'Cost / EVM', icon: '▥', render: renderCost },
  billing: { label: 'Billing', icon: '＄', render: renderBilling },
  documents: { label: 'Documents', icon: '✉', render: renderDocuments },
  field: { label: 'Field', icon: '☰', render: renderField },
  punch: { label: 'Punch', icon: '✔', render: renderPunch },
};

let viewMount; // the area where the active view renders

// --------------------------------------------------------------------------
function renderActiveView() {
  if (!built || !viewMount || !viewMount.isConnected) return;
  VIEWS[ctx.view].render(viewMount, ctx);
  renderKpis();
}

// --- KPI summary bar --------------------------------------------------------
function renderKpis() {
  const bar = document.getElementById('kpis');
  if (!bar) return;
  clear(bar);
  const tasks = store.tasks(ctx.projectId).filter(ctx.filter);
  const work = tasks.filter((t) => !t.milestone);
  const done = work.filter((t) => t.status === 'done').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  const avg = work.length ? work.reduce((a, t) => a + t.progress, 0) / work.length : 0;
  const today = Dates.today();
  const overdue = work.filter((t) => t.status !== 'done' && t.end < today).length;
  const crit = computeCriticalPath(store.tasks(ctx.projectId)).size;

  const budget = (ctx.projectId === 'all' ? store.projects : [store.project(ctx.projectId)])
    .filter(Boolean).reduce((a, p) => a + p.budget, 0);

  const kpi = (label, value, cls = '') =>
    el('div', { class: 'kpi ' + cls }, [
      el('div', { class: 'kpi-value' }, value),
      el('div', { class: 'kpi-label' }, label),
    ]);

  bar.append(
    kpi('Overall Progress', pct(avg)),
    kpi('Work Packages', String(work.length)),
    kpi('Completed', String(done), 'good'),
    kpi('Blocked', String(blocked), blocked ? 'bad' : ''),
    kpi('Overdue', String(overdue), overdue ? 'bad' : ''),
    kpi('Critical Path', crit + ' tasks', 'crit'),
  );

  const lvl = levelingSummary(tasks);
  bar.append(kpi('Crew Conflicts', String(lvl.conflictPairs), lvl.conflictPairs ? 'bad' : 'good'));

  // Baseline variance KPIs replace the static contract value when a baseline
  // exists (slip is more actionable to a PM than the headline number).
  const sv = scheduleVariance(tasks, store.baseline);
  if (sv && sv.counted) {
    const slip = Math.round(sv.avgFinishVar);
    bar.append(
      kpi('Behind Baseline', `${sv.slipped} tasks`, sv.slipped ? 'bad' : 'good'),
      kpi('Avg Finish Slip', `${slip >= 0 ? '+' : ''}${slip}d`, slip > 0 ? 'bad' : 'good'),
    );
  } else {
    bar.append(kpi('Contract Value', money(budget)));
  }
}

// --- Header / toolbar -------------------------------------------------------
function renderHeader(root) {
  const header = el('header', { class: 'app-header' }, [
    el('div', { class: 'brand' }, [
      el('div', { class: 'brand-mark' }, '◭'),
      el('div', {}, [
        el('div', { class: 'brand-name' }, 'BuildFlow'),
        el('div', { class: 'brand-sub' }, 'ERP · Construction Schedule'),
      ]),
    ]),
    el('div', { class: 'view-switch' },
      Object.entries(VIEWS).map(([key, v]) =>
        el('button', {
          class: 'view-btn' + (ctx.view === key ? ' active' : ''),
          onclick: () => { ctx.view = key; renderHeader(root); renderActiveView(); },
        }, [el('span', { class: 'view-icon' }, v.icon), v.label]))),
    el('div', { class: 'header-actions' }, [
      alertBell(),
      identityChip(root),
      store.can('write') ? el('button', { class: 'btn primary', onclick: () => openEditor(null) }, '+ New Task') : null,
    ]),
  ]);

  // Toolbar (filters)
  const projectOpts = [el('option', { value: 'all' }, 'All Projects'),
    ...store.projects.map((p) => el('option', { value: p.id }, p.name))];
  const tradeOpts = [el('option', { value: 'all' }, 'All Trades'),
    ...Object.entries(TRADES).map(([k, v]) => el('option', { value: k }, v.label))];

  const projSel = el('select', { class: 'select', onchange: (e) => { ctx.projectId = e.target.value; renderActiveView(); } }, projectOpts);
  projSel.value = ctx.projectId;
  const tradeSel = el('select', { class: 'select', onchange: (e) => { ctx.tradeFilter = e.target.value; renderActiveView(); } }, tradeOpts);
  tradeSel.value = ctx.tradeFilter;

  const toolbar = el('div', { class: 'toolbar' }, [
    el('div', { class: 'toolbar-left' }, [
      el('label', { class: 'tb-label' }, 'Project'), projSel,
      el('label', { class: 'tb-label' }, 'Trade'), tradeSel,
    ]),
    el('div', { class: 'toolbar-right' }, [
      baselineControls(),
      (ctx.view === 'resources' && store.canBaseline() && levelingSummary(store.tasks('all')).conflictPairs)
        ? el('button', { class: 'btn', title: 'Propose date shifts to resolve crew double-bookings', onclick: () => openLevelPreview() }, '⚖ Auto-level')
        : null,
      ctx.view === 'gantt' ? toggle('Critical Path', ctx.showCritical, (v) => { ctx.showCritical = v; renderActiveView(); }) : null,
      ctx.view === 'gantt' && store.baseline ? toggle('Baseline', ctx.showBaseline, (v) => { ctx.showBaseline = v; renderActiveView(); }) : null,
      store.can('admin') ? el('button', { class: 'btn ghost', onclick: () => { if (confirm('Reset all schedule data to the seeded sample?')) store.reset(); } }, '↺ Reset Demo') : null,
    ]),
  ]);

  // Mount header + toolbar
  let bar = root.querySelector('.app-header');
  if (bar) bar.replaceWith(header); else root.appendChild(header);
  let tb = root.querySelector('.toolbar');
  if (tb) tb.replaceWith(toolbar); else header.after(toolbar);
}

// Reusable iOS-style toggle.
function toggle(label, checked, onChange) {
  const c = el('input', { type: 'checkbox', onchange: (e) => onChange(e.target.checked) });
  c.checked = checked;
  return el('label', { class: 'toggle' }, [c, el('span', { class: 'toggle-track' }), label]);
}

const ROLE_LABEL = { admin: 'Admin', pm: 'Project Mgr', viewer: 'Viewer' };

// Identity area: signed-in user + role + logout (authenticated server mode),
// or an editable local identity chip (offline single-user mode).
function identityChip(root) {
  const avatar = (name) => el('span', { class: 'identity-avatar' },
    (name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase());

  if (store.mode === 'local') {
    return el('button', {
      class: 'identity', title: 'Click to change who you are (used to attribute edits)',
      onclick: () => {
        const name = window.prompt('Your name / role (used to attribute schedule edits):', store.user);
        if (name != null) { store.setUser(name); renderHeader(root); }
      },
    }, [avatar(store.user), el('span', { class: 'identity-name' }, store.user)]);
  }

  return el('div', { class: 'identity-box' }, [
    el('div', { class: 'identity' }, [
      avatar(store.user),
      el('div', { class: 'identity-meta' }, [
        el('span', { class: 'identity-name' }, store.user),
        el('span', { class: 'role-badge role-' + store.role }, ROLE_LABEL[store.role] || store.role),
      ]),
    ]),
    store.can('write') ? el('button', { class: 'btn ghost sm', title: 'Recent activity', onclick: () => openActivityPanel() }, 'Activity') : null,
    store.can('admin') ? el('button', { class: 'btn ghost sm', onclick: () => openUsersPanel() }, 'Users') : null,
    el('button', { class: 'btn ghost sm', title: 'Sign out', onclick: () => store.logout() }, 'Sign out'),
  ]);
}

// Baseline control: shows the active baseline, opens the history panel, and
// (for unrestricted writers) saves a new baseline. Read-only roles see the tag.
function baselineControls() {
  const b = store.baseline;
  const rw = store.canBaseline();
  const count = store.baselines.length;
  if (!b && !count) {
    return rw ? el('button', { class: 'btn ghost', title: 'Snapshot the current schedule as the plan to measure slip against',
      onclick: () => saveBaselinePrompt() }, '📌 Save Baseline') : null;
  }
  return el('div', { class: 'baseline-ctl' }, [
    el('button', { class: 'baseline-tag' + (rw ? ' clickable' : ''), title: b ? `Active baseline by ${b.savedBy || 'Unknown'} · click for history` : 'No active baseline',
      onclick: rw ? () => openBaselinePanel() : null },
      b ? `Baseline: ${b.label}${count > 1 ? ` (${count})` : ''} ▾` : `No baseline · ${count} saved ▾`),
    rw ? el('button', { class: 'btn ghost sm', title: 'Capture a new baseline from the current schedule', onclick: () => saveBaselinePrompt() }, '+ New') : null,
  ]);
}

function saveBaselinePrompt() {
  const label = window.prompt('Name this baseline (e.g. “Rev B — after client changes”):', 'Baseline ' + (store.baselines.length + 1));
  if (label != null) store.saveBaseline(label);
}

// Baseline history panel: activate / delete / save, with plan-drift vs the
// previous revision so you can see how the plan itself evolved.
function openBaselinePanel() {
  if (!store.canBaseline()) return;
  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const list = el('div', { class: 'bl-list' });

  function render() {
    clear(list);
    const bls = store.baselines;
    const activeId = store.baseline && store.baseline.id;
    // "No comparison" row
    list.appendChild(el('label', { class: 'bl-row' }, [
      radio(!activeId, () => { store.activateBaseline('none'); render(); renderHeader(document.getElementById('app')); renderActiveView(); }),
      el('div', { class: 'bl-meta' }, [el('div', { class: 'bl-label' }, 'No comparison'), el('div', { class: 'bl-sub' }, 'Hide baseline / variance')]),
    ]));
    bls.forEach((bl, i) => {
      const prev = i > 0 ? bls[i - 1] : null;
      const drift = prev ? compareBaselines(prev, bl) : null;
      list.appendChild(el('label', { class: 'bl-row' + (bl.id === activeId ? ' active' : '') }, [
        radio(bl.id === activeId, () => { store.activateBaseline(bl.id); render(); renderHeader(document.getElementById('app')); renderActiveView(); }),
        el('div', { class: 'bl-meta' }, [
          el('div', { class: 'bl-label' }, bl.label),
          el('div', { class: 'bl-sub' }, `${Dates.fmtLong(bl.savedAt)} · ${bl.savedBy || 'Unknown'} · ${Object.keys(bl.tasks || {}).length} tasks${drift ? ` · ${drift.changed} re-planned vs prev` : ''}`),
        ]),
        el('button', { class: 'btn ghost sm', onclick: (e) => { e.preventDefault(); if (confirm(`Delete baseline “${bl.label}”?`)) { store.deleteBaseline(bl.id); render(); renderHeader(document.getElementById('app')); renderActiveView(); } } }, 'Delete'),
      ]));
    });
    if (!bls.length) list.appendChild(el('div', { class: 'empty' }, 'No baselines saved yet.'));
  }

  const modal = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [el('h2', {}, 'Baselines'), el('button', { class: 'modal-x', onclick: close }, '✕')]),
    el('div', { class: 'modal-body' }, [
      el('div', { class: 'bl-intro' }, 'Variance (Gantt ghost bars, KPIs) is measured against the selected baseline. Switch the active baseline to compare progress against a different revision of the plan.'),
      list,
    ]),
    el('div', { class: 'modal-foot' }, [el('span'), el('div', { class: 'foot-right' }, [
      el('button', { class: 'btn ghost', onclick: close }, 'Close'),
      el('button', { class: 'btn primary', onclick: () => { saveBaselinePrompt(); setTimeout(render, 50); } }, '+ New baseline'),
    ])]),
  ]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  render();

  function radio(on, onPick) {
    const r = el('span', { class: 'bl-radio' + (on ? ' on' : ''), onclick: (e) => { e.preventDefault(); onPick(); } });
    return r;
  }
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
}

// Relative "time ago" for attribution timestamps.
function ago(iso) {
  if (!iso) return null;
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// Read-only panel in the editor: baseline variance + edit attribution.
function metaPanel(t) {
  const rows = [];
  const v = taskVariance(t, store.baseline);
  if (v) {
    const slip = v.finishVar;
    const cls = slip > 0 ? 'neg' : (slip < 0 ? 'pos' : '');
    rows.push(el('div', { class: 'meta-row' }, [
      el('span', { class: 'meta-k' }, 'Baseline'),
      el('span', { class: 'meta-v' }, `${Dates.fmt(v.baselineStart)} → ${Dates.fmt(v.baselineEnd)}`),
    ]));
    rows.push(el('div', { class: 'meta-row' }, [
      el('span', { class: 'meta-k' }, 'Finish variance'),
      el('span', { class: 'meta-v ' + cls },
        slip === 0 ? 'On plan' : `${slip > 0 ? '+' : ''}${slip} day${Math.abs(slip) === 1 ? '' : 's'} ${slip > 0 ? 'late' : 'early'}`),
    ]));
  }
  if (t.lastEditedBy) {
    rows.push(el('div', { class: 'meta-row' }, [
      el('span', { class: 'meta-k' }, 'Last edited'),
      el('span', { class: 'meta-v' }, `${t.lastEditedBy}${t.lastEditedAt ? ' · ' + ago(t.lastEditedAt) : ''}`),
    ]));
  }
  return rows.length ? el('div', { class: 'meta-panel' }, rows) : null;
}

// Lazy-loaded per-task audit trail shown inside the editor.
function historySection(taskId) {
  const body = el('div', { class: 'hist-body' });
  const btn = el('button', { class: 'btn ghost sm', onclick: load }, 'Show change history');
  function load() {
    btn.disabled = true; btn.textContent = 'Loading…';
    store.taskHistory(taskId).then((entries) => {
      btn.remove();
      if (!entries.length) { body.appendChild(el('div', { class: 'hist-empty' }, 'No recorded changes.')); return; }
      entries.forEach((e) => {
        const meta = ACTION_META[e.action] || { icon: '•', label: e.action };
        body.appendChild(el('div', { class: 'hist-row' }, [
          el('span', { class: 'hist-icon' }, meta.icon),
          el('span', { class: 'hist-text' }, [el('b', {}, e.user), ' ', meta.label,
            e.detail ? el('span', { class: 'hist-detail' }, ' — ' + e.detail) : null]),
          el('span', { class: 'hist-time', title: e.ts }, ago(e.ts) || ''),
        ]));
      });
    }).catch(() => { btn.disabled = false; btn.textContent = 'Failed — retry'; });
  }
  return el('div', { class: 'hist-section' }, [el('div', { class: 'hist-head' }, 'History'), btn, body]);
}

// --- Task editor modal ------------------------------------------------------
function openEditor(taskId) {
  const isNew = taskId == null;
  const editable = store.editableProjects();       // projects this user may write
  if (isNew && (!store.can('write') || !editable.length)) return;
  const defaultProj = ctx.projectId !== 'all' && editable.some((p) => p.id === ctx.projectId)
    ? ctx.projectId : (editable[0] && editable[0].id);
  const t = isNew ? {
    projectId: defaultProj,
    name: '', trade: ctx.tradeFilter === 'all' ? 'sitework' : ctx.tradeFilter,
    crewId: null, start: Dates.today(), end: Dates.addDays(Dates.today(), 4),
    dependencies: [], progress: 0, status: 'not-started', milestone: false,
  } : { ...store.task(taskId) };
  // Read-only unless the user may write to THIS task's project (scoping).
  const RW = isNew ? store.can('write') : store.canEditProject(t.projectId);
  // Project picker only offers projects the user can write (plus the current one).
  const projOptions = isNew ? editable
    : store.projects.filter((p) => p.id === t.projectId || store.canEditProject(p.id));

  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const f = {};

  const field = (label, input) => el('div', { class: 'form-field' }, [el('label', {}, label), input]);

  f.name = el('input', { class: 'input', type: 'text', value: t.name, placeholder: 'e.g. Foundation Pour' });
  f.project = el('select', { class: 'select' }, projOptions.map((p) => el('option', { value: p.id }, p.name))); f.project.value = t.projectId;
  f.trade = el('select', { class: 'select' }, Object.entries(TRADES).map(([k, v]) => el('option', { value: k }, v.label))); f.trade.value = t.trade;
  f.crew = el('select', { class: 'select' }, [el('option', { value: '' }, '— Unassigned —'), ...store.crews.map((c) => el('option', { value: c.id }, `${c.name} (${c.lead})`))]); f.crew.value = t.crewId || '';
  f.start = el('input', { class: 'input', type: 'date', value: t.start });
  f.end = el('input', { class: 'input', type: 'date', value: t.end });
  f.status = el('select', { class: 'select' }, STATUS_ORDER.map((s) => el('option', { value: s }, STATUSES[s].label))); f.status.value = t.status;
  f.progress = el('input', { class: 'input', type: 'range', min: '0', max: '100', step: '5', value: t.progress });
  const progLabel = el('span', { class: 'range-val' }, pct(t.progress));
  f.progress.addEventListener('input', () => progLabel.textContent = pct(+f.progress.value));
  f.milestone = el('input', { type: 'checkbox' }); f.milestone.checked = t.milestone;
  f.cost = el('input', { class: 'input', type: 'number', min: '0', step: '1000', value: t.cost || 0 });
  f.actualCost = el('input', { class: 'input', type: 'number', min: '0', step: '1000', value: t.actualCost || 0 });

  // Dependencies (multi-select of sibling tasks)
  const depCandidates = store.tasks(t.projectId).filter((x) => x.id !== taskId);
  f.deps = el('select', { class: 'select multi', multiple: true, size: Math.min(6, Math.max(3, depCandidates.length)) },
    depCandidates.map((x) => { const o = el('option', { value: x.id }, x.name); o.selected = t.dependencies.includes(x.id); return o; }));

  // Live crew double-booking warning (resource leveling).
  const crewWarn = el('div', { class: 'crew-warn', style: { display: 'none' } });
  function updateCrewWarn() {
    const cid = f.crew.value;
    if (!cid || f.milestone.checked) { crewWarn.style.display = 'none'; return; }
    const end = f.milestone.checked ? f.start.value : f.end.value;
    const cf = assignmentConflicts(store.tasks('all'), cid, f.start.value, end, taskId);
    if (cf.length) {
      const names = cf.slice(0, 2).map((x) => x.name).join(', ');
      crewWarn.textContent = `⚠ ${store.crew(cid).name} is already booked on ${names}${cf.length > 2 ? ` +${cf.length - 2} more` : ''} during these dates.`;
      crewWarn.style.display = 'block';
    } else { crewWarn.style.display = 'none'; }
  }
  [f.crew, f.start, f.end].forEach((n) => n.addEventListener('change', updateCrewWarn));
  f.milestone.addEventListener('change', updateCrewWarn);

  const modal = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [
      el('h2', {}, isNew ? 'New Work Package' : (RW ? 'Edit Work Package' : 'Work Package')),
      !RW ? el('span', { class: 'role-badge role-viewer' }, 'Read-only') : null,
      el('button', { class: 'modal-x', onclick: close }, '✕'),
    ]),
    el('div', { class: 'modal-body' }, [
      field('Task name', f.name),
      el('div', { class: 'form-row' }, [field('Project', f.project), field('Trade', f.trade)]),
      field('Assigned crew', el('div', {}, [f.crew, crewWarn])),
      el('div', { class: 'form-row' }, [field('Start', f.start), field('Finish', f.end)]),
      el('div', { class: 'form-row' }, [
        field('Status', f.status),
        field('Progress', el('div', { class: 'range-wrap' }, [f.progress, progLabel])),
      ]),
      el('div', { class: 'form-row' }, [
        field('Budgeted cost (BAC, $)', f.cost),
        field('Actual cost to date (AC, $)', f.actualCost),
      ]),
      field('Depends on (finish-to-start)', f.deps),
      el('label', { class: 'check-row' }, [f.milestone, el('span', {}, 'This is a milestone (zero-duration marker)')]),
      !isNew ? metaPanel(t) : null,
      (!isNew && store.mode === 'remote') ? historySection(taskId) : null,
    ]),
    el('div', { class: 'modal-foot' }, [
      (RW && !isNew) ? el('button', { class: 'btn danger', onclick: () => { if (confirm('Delete this task?')) { store.deleteTask(taskId); close(); } } }, 'Delete') : el('span'),
      el('div', { class: 'foot-right' }, [
        el('button', { class: 'btn ghost', onclick: close }, RW ? 'Cancel' : 'Close'),
        RW ? el('button', { class: 'btn primary', onclick: save }, isNew ? 'Create Task' : 'Save Changes') : null,
      ]),
    ]),
  ]);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  // Read-only: lock every field so a viewer can inspect but not change.
  if (!RW) modal.querySelectorAll('input, select, textarea').forEach((n) => { n.disabled = true; });
  if (RW) updateCrewWarn();
  setTimeout(() => { if (RW) f.name.focus(); }, 30);

  function collect() {
    let start = f.start.value, end = f.end.value;
    if (end < start) end = start;
    return {
      projectId: f.project.value, name: f.name.value.trim() || 'Untitled Task',
      trade: f.trade.value, crewId: f.crew.value || null,
      start, end: f.milestone.checked ? start : end,
      status: f.status.value, progress: +f.progress.value,
      milestone: f.milestone.checked,
      cost: Math.max(0, +f.cost.value || 0),
      actualCost: Math.max(0, +f.actualCost.value || 0),
      dependencies: [...f.deps.selectedOptions].map((o) => o.value),
    };
  }
  function save() {
    const data = collect();
    if (isNew) store.addTask(data); else store.updateTask(taskId, data);
    close();
  }
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
}

// --- Auto-leveling preview (with options) -----------------------------------
const HORIZONS = [['∞', Infinity], ['7d', 7], ['14d', 14], ['30d', 30], ['60d', 60]];

function openLevelPreview() {
  if (!store.canBaseline()) return;
  const opts = { protectCritical: false, freezeStarted: false, maxPushDays: Infinity };
  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const bodyWrap = el('div', { class: 'modal-body' });
  const footRight = el('div', { class: 'foot-right' });
  let changes = [];

  function recompute() {
    const tasks = store.tasks('all');
    changes = proposeLeveling(tasks, opts);
    const residual = detectConflicts(applyChanges(tasks, changes)).length;

    clear(bodyWrap);
    bodyWrap.appendChild(optionsBar());
    if (!changes.length) {
      bodyWrap.appendChild(el('div', { class: 'empty' }, 'No changes needed with these options — schedule is conflict-free.'));
    } else {
      bodyWrap.appendChild(el('div', { class: 'level-intro' }, [
        `${changes.length} task${changes.length === 1 ? '' : 's'} pushed later (dependencies preserved; nothing moves earlier). `,
        el('span', { class: residual ? 'level-resid bad' : 'level-resid good' },
          residual ? `${residual} conflict${residual === 1 ? '' : 's'} remain within the horizon` : 'all crew conflicts resolved ✓'),
      ]));
      bodyWrap.appendChild(el('div', { class: 'level-list' }, changes.map(rowFor)));
    }
    clear(footRight);
    footRight.append(
      el('button', { class: 'btn ghost', onclick: close }, changes.length ? 'Cancel' : 'Close'),
      changes.length ? el('button', { class: 'btn primary', onclick: apply }, `Apply ${changes.length} shift${changes.length === 1 ? '' : 's'}`) : null,
    );
  }

  function optionsBar() {
    const horizonSel = el('select', { class: 'select sm', onchange: (e) => { opts.maxPushDays = +e.target.value === 0 ? Infinity : +e.target.value; recompute(); } },
      HORIZONS.map(([lbl, v]) => el('option', { value: v === Infinity ? 0 : v }, 'Horizon ' + lbl)));
    horizonSel.value = opts.maxPushDays === Infinity ? 0 : opts.maxPushDays;
    return el('div', { class: 'level-opts' }, [
      toggle('Protect critical path', opts.protectCritical, (v) => { opts.protectCritical = v; recompute(); }),
      toggle('Freeze started work', opts.freezeStarted, (v) => { opts.freezeStarted = v; recompute(); }),
      horizonSel,
    ]);
  }

  function rowFor(c) {
    const proj = store.project(c.projectId);
    return el('div', { class: 'level-row' }, [
      el('div', { class: 'level-task' }, [
        el('span', { class: 'level-name' }, c.name),
        proj ? el('span', { class: 'level-proj', style: { color: proj.color } }, proj.name) : null,
      ]),
      el('span', { class: 'level-dates' }, `${Dates.fmt(c.oldStart)}→${Dates.fmt(c.oldEnd)}`),
      el('span', { class: 'level-arrow' }, '→'),
      el('span', { class: 'level-dates new' }, `${Dates.fmt(c.newStart)}→${Dates.fmt(c.newEnd)}`),
      el('span', { class: 'level-delta' }, `+${c.deltaDays}d`),
    ]);
  }

  const modal = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [el('h2', {}, 'Auto-level'), el('button', { class: 'modal-x', onclick: close }, '✕')]),
    bodyWrap,
    el('div', { class: 'modal-foot' }, [el('span'), footRight]),
  ]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  recompute();

  function apply() {
    const applied = changes.length;
    changes.forEach((c) => store.updateTask(c.id, { start: c.newStart, end: c.newEnd }));
    store._notify(`Auto-leveled ${applied} task${applied === 1 ? '' : 's'}.`, 'info');
    close();
  }
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
}

// --- Alerts (notification center) -------------------------------------------
const SEV_LABEL = { high: 'Critical', medium: 'Attention', low: 'Watch' };

function alertBell() {
  const s = alertSummary(computeAlerts(store.tasks('all'), store.baseline, store.docs, store.punch));
  return el('button', { class: 'alert-bell' + (s.high ? ' urgent' : ''), title: `${s.total} schedule alert${s.total === 1 ? '' : 's'}`, onclick: () => openAlertsPanel() }, [
    el('span', { class: 'bell-ico' }, '🔔'),
    s.total ? el('span', { class: 'bell-badge' + (s.high ? ' high' : '') }, String(s.total)) : null,
  ]);
}

function openAlertsPanel() {
  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const alerts = computeAlerts(store.tasks('all'), store.baseline, store.docs, store.punch);
  const body = el('div', { class: 'alert-list' });
  if (!alerts.length) {
    body.appendChild(el('div', { class: 'empty' }, '✓ No alerts — nothing overdue, blocked, or slipping.'));
  } else {
    ['high', 'medium', 'low'].forEach((sev) => {
      const group = alerts.filter((a) => a.severity === sev);
      if (!group.length) return;
      body.appendChild(el('div', { class: 'alert-group-head' }, [el('span', { class: 'sev-dot sev-' + sev }), `${SEV_LABEL[sev]} (${group.length})`]));
      group.forEach((a) => {
        const proj = store.project(a.projectId);
        body.appendChild(el('div', { class: 'alert-row', onclick: () => { close(); if (a.docId) ctx.openDoc(a.docId); else if (a.punchId) ctx.openPunch(a.punchId); else if (a.taskId) ctx.openTask(a.taskId); } }, [
          el('span', { class: 'sev-dot sev-' + a.severity }),
          el('div', { class: 'alert-main' }, [
            el('div', { class: 'alert-title' }, [a.title, proj ? el('span', { class: 'alert-proj', style: { color: proj.color } }, ' · ' + proj.name) : null]),
            el('div', { class: 'alert-msg' }, a.message),
          ]),
        ]));
      });
    });
  }
  const modal = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [el('h2', {}, 'Alerts'), el('button', { class: 'modal-x', onclick: close }, '✕')]),
    el('div', { class: 'modal-body' }, body),
  ]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
}

// --- Activity / audit log panel ---------------------------------------------
const ACTION_META = {
  'task.create': { icon: '＋', label: 'created' },
  'task.update': { icon: '✎', label: 'updated' },
  'task.delete': { icon: '🗑', label: 'deleted' },
  'baseline.save': { icon: '📌', label: 'saved baseline' },
  'baseline.activate': { icon: '◉', label: 'switched active baseline to' },
  'baseline.delete': { icon: '🗑', label: 'deleted baseline' },
  'baseline.clear': { icon: '✕', label: 'cleared the baseline' },
  'schedule.reset': { icon: '↺', label: 'reset the schedule' },
  'user.create': { icon: '👤', label: 'created user' },
  'user.update': { icon: '🔑', label: 'updated user' },
  'user.delete': { icon: '🗑', label: 'removed user' },
  'billing.create': { icon: '＄', label: 'generated' },
  'billing.delete': { icon: '🗑', label: 'deleted' },
  'doc.create': { icon: '✉', label: 'created' },
  'doc.update': { icon: '✎', label: 'updated' },
  'doc.delete': { icon: '🗑', label: 'deleted' },
  'co.create': { icon: '±', label: 'raised change order' },
  'co.update': { icon: '✎', label: 'updated change order' },
  'co.delete': { icon: '🗑', label: 'deleted change order' },
  'report.create': { icon: '☰', label: 'filed report' },
  'report.update': { icon: '✎', label: 'updated report' },
  'report.delete': { icon: '🗑', label: 'deleted report' },
  'punch.create': { icon: '✔', label: 'added punch item' },
  'punch.update': { icon: '✎', label: 'updated punch item' },
  'punch.delete': { icon: '🗑', label: 'deleted punch item' },
};

// Reusable attachments-by-reference editor (name + URL + caption rows).
function attachmentsEditor(initial) {
  const rows = el('div', { class: 'attach-rows' });
  const live = [];
  function rowEl(a) {
    const name = el('input', { class: 'input sm', value: a.name || '', placeholder: 'name' });
    const url = el('input', { class: 'input sm', value: a.url || '', placeholder: 'https://… link to photo/file' });
    const cap = el('input', { class: 'input sm', value: a.caption || '', placeholder: 'caption' });
    const rec = { name, url, cap }; live.push(rec);
    const r = el('div', { class: 'attach-row' }, [name, url, cap,
      el('button', { class: 'btn ghost sm', type: 'button', onclick: () => { const i = live.indexOf(rec); if (i >= 0) live.splice(i, 1); r.remove(); } }, '✕')]);
    return r;
  }
  (initial || []).forEach((a) => rows.appendChild(rowEl(a)));
  const wrap = el('div', { class: 'form-field' }, [
    el('label', {}, 'Attachments (links — no upload in this demo)'),
    rows,
    el('button', { class: 'btn ghost sm', type: 'button', onclick: () => rows.appendChild(rowEl({})) }, '+ Add attachment'),
  ]);
  return { wrap, get: () => live.map((r) => ({ name: r.name.value.trim(), url: r.url.value.trim(), caption: r.cap.value.trim() })).filter((a) => a.url || a.name) };
}

// --- Punch-item editor ------------------------------------------------------
function openPunchEditor(pid) {
  const isNew = pid == null;
  const editable = store.editableProjects();
  if (isNew && (!store.can('write') || !editable.length)) return;
  const p = isNew
    ? { projectId: (ctx.projectId !== 'all' && editable.some((x) => x.id === ctx.projectId)) ? ctx.projectId : (editable[0] && editable[0].id), title: '', location: '', trade: 'finishes', status: 'open', priority: 'normal', assignedTo: '', taskId: null, attachments: [] }
    : { ...store.punch.find((x) => x.id === pid) };
  const RW = isNew ? store.can('write') : store.canEditProject(p.projectId);
  const projOptions = isNew ? editable : store.projects.filter((x) => x.id === p.projectId || store.canEditProject(x.id));

  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const f = {};
  const field = (label, input) => el('div', { class: 'form-field' }, [el('label', {}, label), input]);
  f.title = el('input', { class: 'input', type: 'text', value: p.title || '', placeholder: 'e.g. Touch-up paint at stair 2' });
  f.project = el('select', { class: 'select' }, projOptions.map((x) => el('option', { value: x.id }, x.name))); f.project.value = p.projectId;
  f.status = el('select', { class: 'select' }, PUNCH_STATUSES.map((s) => el('option', { value: s }, s))); f.status.value = p.status;
  f.priority = el('select', { class: 'select' }, PUNCH_PRIORITIES.map((s) => el('option', { value: s }, s))); f.priority.value = p.priority;
  f.trade = el('select', { class: 'select' }, Object.entries(TRADES).map(([k, v]) => el('option', { value: k }, v.label))); f.trade.value = p.trade;
  f.location = el('input', { class: 'input', type: 'text', value: p.location || '', placeholder: 'Location / grid' });
  f.assignedTo = el('input', { class: 'input', type: 'text', value: p.assignedTo || '', placeholder: 'Responsible crew/sub' });
  const taskOpts = () => [el('option', { value: '' }, '— none —'), ...store.tasks(f.project.value).map((t) => el('option', { value: t.id }, t.name))];
  f.task = el('select', { class: 'select' }, taskOpts()); f.task.value = p.taskId || '';
  f.project.addEventListener('change', () => { clear(f.task); taskOpts().forEach((o) => f.task.appendChild(o)); });
  const attach = attachmentsEditor(p.attachments);

  const modal = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [el('h2', {}, isNew ? 'New Punch Item' : 'Punch · ' + p.number), !RW ? el('span', { class: 'role-badge role-viewer' }, 'Read-only') : null, el('button', { class: 'modal-x', onclick: close }, '✕')]),
    el('div', { class: 'modal-body' }, [
      field('Title', f.title),
      el('div', { class: 'form-row' }, [field('Project', f.project), field('Trade', f.trade)]),
      el('div', { class: 'form-row' }, [field('Status', f.status), field('Priority', f.priority)]),
      el('div', { class: 'form-row' }, [field('Location', f.location), field('Assigned to', f.assignedTo)]),
      field('Linked task', f.task),
      attach.wrap,
    ]),
    el('div', { class: 'modal-foot' }, [
      (RW && !isNew) ? el('button', { class: 'btn danger', onclick: () => { if (confirm('Delete this punch item?')) { store.deletePunch(pid); close(); renderActiveView(); } } }, 'Delete') : el('span'),
      el('div', { class: 'foot-right' }, [el('button', { class: 'btn ghost', onclick: close }, RW ? 'Cancel' : 'Close'), RW ? el('button', { class: 'btn primary', onclick: save }, isNew ? 'Create' : 'Save') : null]),
    ]),
  ]);
  overlay.appendChild(modal); document.body.appendChild(overlay);
  if (!RW) modal.querySelectorAll('.modal-body input, .modal-body select, .modal-body textarea, .attach-rows button, .form-field > button').forEach((n) => { n.disabled = true; });
  setTimeout(() => { if (RW) f.title.focus(); }, 30);

  async function save() {
    const data = { projectId: f.project.value, title: f.title.value.trim() || 'Punch item', location: f.location.value.trim(), trade: f.trade.value, status: f.status.value, priority: f.priority.value, assignedTo: f.assignedTo.value.trim(), taskId: f.task.value || null, attachments: attach.get() };
    if (isNew) await store.createPunch(data); else store.updatePunch(pid, data);
    close(); renderActiveView();
  }
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
}

// --- Change-order editor ----------------------------------------------------
function openCoEditor(coId, projectId) {
  const isNew = coId == null;
  const editable = store.editableProjects();
  if (isNew && (!store.can('write') || !editable.length)) return;
  const c = isNew
    ? { projectId: projectId || (editable[0] && editable[0].id), title: '', description: '', amount: 0, days: 0, status: 'draft' }
    : { ...store.changeOrders.find((x) => x.id === coId) };
  const RW = isNew ? store.can('write') : store.canEditProject(c.projectId);
  const projOptions = isNew ? editable : store.projects.filter((p) => p.id === c.projectId || store.canEditProject(p.id));

  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const f = {};
  const field = (label, input) => el('div', { class: 'form-field' }, [el('label', {}, label), input]);
  f.title = el('input', { class: 'input', type: 'text', value: c.title || '', placeholder: 'e.g. Added rooftop screen wall' });
  f.project = el('select', { class: 'select' }, projOptions.map((p) => el('option', { value: p.id }, p.name))); f.project.value = c.projectId;
  f.status = el('select', { class: 'select' }, CO_STATUSES.map((s) => el('option', { value: s }, s))); f.status.value = c.status;
  f.amount = el('input', { class: 'input', type: 'number', step: '1000', value: c.amount || 0 });
  f.days = el('input', { class: 'input', type: 'number', step: '1', value: c.days || 0 });
  f.description = el('textarea', { class: 'input', rows: '3', placeholder: 'Scope / justification' }, c.description || '');

  const modal = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [el('h2', {}, (isNew ? 'New Change Order' : 'Change Order · ' + c.number)), !RW ? el('span', { class: 'role-badge role-viewer' }, 'Read-only') : null, el('button', { class: 'modal-x', onclick: close }, '✕')]),
    el('div', { class: 'modal-body' }, [
      field('Title', f.title),
      el('div', { class: 'form-row' }, [field('Project', f.project), field('Status', f.status)]),
      el('div', { class: 'form-row' }, [field('Amount ($, − for credit)', f.amount), field('Schedule impact (days)', f.days)]),
      field('Description', f.description),
      (!isNew && c.approvedBy) ? el('div', { class: 'meta-panel' }, el('div', { class: 'meta-row' }, [el('span', { class: 'meta-k' }, 'Approved by'), el('span', { class: 'meta-v' }, c.approvedBy)])) : null,
    ]),
    el('div', { class: 'modal-foot' }, [
      (RW && !isNew) ? el('button', { class: 'btn danger', onclick: () => { if (confirm('Delete this change order?')) { store.deleteChangeOrder(coId); close(); renderActiveView(); } } }, 'Delete') : el('span'),
      el('div', { class: 'foot-right' }, [el('button', { class: 'btn ghost', onclick: close }, RW ? 'Cancel' : 'Close'), RW ? el('button', { class: 'btn primary', onclick: save }, isNew ? 'Create' : 'Save') : null]),
    ]),
  ]);
  overlay.appendChild(modal); document.body.appendChild(overlay);
  if (!RW) modal.querySelectorAll('input, select, textarea').forEach((n) => { n.disabled = true; });
  setTimeout(() => { if (RW) f.title.focus(); }, 30);

  async function save() {
    const data = { projectId: f.project.value, title: f.title.value.trim() || 'Change Order', description: f.description.value, amount: +f.amount.value || 0, days: +f.days.value || 0, status: f.status.value };
    if (isNew) await store.createChangeOrder(data); else store.updateChangeOrder(coId, data);
    close(); renderActiveView();
  }
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
}

// --- Daily field report editor ----------------------------------------------
function openReportEditor(repId) {
  const isNew = repId == null;
  const editable = store.editableProjects();
  if (isNew && (!store.can('write') || !editable.length)) return;
  const r = isNew
    ? { projectId: (ctx.projectId !== 'all' && editable.some((p) => p.id === ctx.projectId)) ? ctx.projectId : (editable[0] && editable[0].id), date: Dates.today(), weather: 'Clear', tempLow: '', tempHigh: '', manpower: 0, workPerformed: '', deliveries: '', delays: '', notes: '' }
    : { ...store.reports.find((x) => x.id === repId) };
  const RW = isNew ? store.can('write') : store.canEditProject(r.projectId);
  const projOptions = isNew ? editable : store.projects.filter((p) => p.id === r.projectId || store.canEditProject(p.id));

  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const f = {};
  const field = (label, input) => el('div', { class: 'form-field' }, [el('label', {}, label), input]);
  f.project = el('select', { class: 'select' }, projOptions.map((p) => el('option', { value: p.id }, p.name))); f.project.value = r.projectId;
  f.date = el('input', { class: 'input', type: 'date', value: r.date });
  f.weather = el('select', { class: 'select' }, WEATHER.map((w) => el('option', { value: w }, w))); f.weather.value = r.weather;
  f.tempLow = el('input', { class: 'input', type: 'number', value: r.tempLow ?? '', placeholder: 'low °' });
  f.tempHigh = el('input', { class: 'input', type: 'number', value: r.tempHigh ?? '', placeholder: 'high °' });
  f.manpower = el('input', { class: 'input', type: 'number', min: '0', value: r.manpower || 0 });
  f.workPerformed = el('textarea', { class: 'input', rows: '2', placeholder: 'Work performed' }, r.workPerformed || '');
  f.deliveries = el('textarea', { class: 'input', rows: '2', placeholder: 'Deliveries' }, r.deliveries || '');
  f.delays = el('textarea', { class: 'input', rows: '2', placeholder: 'Delays / issues' }, r.delays || '');
  const attach = attachmentsEditor(r.attachments);

  const modal = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [el('h2', {}, isNew ? 'New Daily Report' : 'Daily Report · ' + Dates.fmt(r.date)), !RW ? el('span', { class: 'role-badge role-viewer' }, 'Read-only') : null, el('button', { class: 'modal-x', onclick: close }, '✕')]),
    el('div', { class: 'modal-body' }, [
      el('div', { class: 'form-row' }, [field('Project', f.project), field('Date', f.date)]),
      el('div', { class: 'form-row' }, [field('Weather', f.weather), field('Temp low', f.tempLow), field('Temp high', f.tempHigh), field('Manpower', f.manpower)]),
      field('Work performed', f.workPerformed),
      field('Deliveries', f.deliveries),
      field('Delays / issues', f.delays),
      attach.wrap,
    ]),
    el('div', { class: 'modal-foot' }, [
      (RW && !isNew) ? el('button', { class: 'btn danger', onclick: () => { if (confirm('Delete this report?')) { store.deleteReport(repId); close(); renderActiveView(); } } }, 'Delete') : el('span'),
      el('div', { class: 'foot-right' }, [el('button', { class: 'btn ghost', onclick: close }, RW ? 'Cancel' : 'Close'), RW ? el('button', { class: 'btn primary', onclick: save }, isNew ? 'Create' : 'Save') : null]),
    ]),
  ]);
  overlay.appendChild(modal); document.body.appendChild(overlay);
  if (!RW) modal.querySelectorAll('input, select, textarea').forEach((n) => { n.disabled = true; });
  setTimeout(() => { if (RW) f.workPerformed.focus(); }, 30);

  async function save() {
    const data = { projectId: f.project.value, date: f.date.value, weather: f.weather.value, tempLow: f.tempLow.value, tempHigh: f.tempHigh.value, manpower: +f.manpower.value || 0, workPerformed: f.workPerformed.value, deliveries: f.deliveries.value, delays: f.delays.value, attachments: attach.get() };
    if (isNew) await store.createReport(data); else store.updateReport(repId, data);
    close(); renderActiveView();
  }
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
}

// --- Submittal / RFI editor -------------------------------------------------
function openDocEditor(docId, presetKind) {
  const isNew = docId == null;
  const editable = store.editableProjects();
  if (isNew && (!store.can('write') || !editable.length)) return;
  const d = isNew ? {
    kind: presetKind === 'rfi' ? 'rfi' : 'submittal',
    projectId: (ctx.projectId !== 'all' && editable.some((p) => p.id === ctx.projectId)) ? ctx.projectId : (editable[0] && editable[0].id),
    taskId: null, status: undefined, court: '', due: null, body: '', response: '',
  } : { ...store.docs.find((x) => x.id === docId) };
  const kind = d.kind;
  const meta = DOC_KINDS[kind];
  const RW = isNew ? store.can('write') : store.canEditProject(d.projectId);
  const projOptions = isNew ? editable : store.projects.filter((p) => p.id === d.projectId || store.canEditProject(p.id));

  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const f = {};
  const field = (label, input) => el('div', { class: 'form-field' }, [el('label', {}, label), input]);

  f.title = el('input', { class: 'input', type: 'text', value: d.title || '', placeholder: meta.label + ' title' });
  f.project = el('select', { class: 'select' }, projOptions.map((p) => el('option', { value: p.id }, p.name))); f.project.value = d.projectId;
  f.status = el('select', { class: 'select' }, meta.statuses.map((s) => el('option', { value: s }, s.replace('-', ' ')))); f.status.value = d.status || meta.statuses[0];
  f.court = el('input', { class: 'input', type: 'text', value: d.court || '', placeholder: meta.courtLabel });
  f.due = el('input', { class: 'input', type: 'date', value: d.due || '' });
  // task link — tasks in the chosen project
  const taskOpts = () => [el('option', { value: '' }, '— none —'), ...store.tasks(f.project.value).map((t) => el('option', { value: t.id }, t.name))];
  f.task = el('select', { class: 'select' }, taskOpts()); f.task.value = d.taskId || '';
  f.project.addEventListener('change', () => { clear(f.task); taskOpts().forEach((o) => f.task.appendChild(o)); });
  f.body = el('textarea', { class: 'input', rows: '3', placeholder: meta.bodyLabel }, d.body || '');
  f.response = el('textarea', { class: 'input', rows: '2', placeholder: meta.responseLabel }, d.response || '');

  const modal = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [
      el('h2', {}, (isNew ? 'New ' : '') + meta.label + (isNew ? '' : ' · ' + d.number)),
      !RW ? el('span', { class: 'role-badge role-viewer' }, 'Read-only') : null,
      el('button', { class: 'modal-x', onclick: close }, '✕'),
    ]),
    el('div', { class: 'modal-body' }, [
      field('Title', f.title),
      el('div', { class: 'form-row' }, [field('Project', f.project), field('Status', f.status)]),
      el('div', { class: 'form-row' }, [field(meta.courtLabel, f.court), field('Due', f.due)]),
      field('Linked task', f.task),
      field(meta.bodyLabel, f.body),
      field(meta.responseLabel, f.response),
      (!isNew && d.createdBy) ? el('div', { class: 'meta-panel' }, el('div', { class: 'meta-row' }, [el('span', { class: 'meta-k' }, 'Created'), el('span', { class: 'meta-v' }, `${d.createdBy}${d.updatedBy ? ' · last edit ' + d.updatedBy : ''}`)])) : null,
    ]),
    el('div', { class: 'modal-foot' }, [
      (RW && !isNew) ? el('button', { class: 'btn danger', onclick: () => { if (confirm('Delete this ' + meta.label.toLowerCase() + '?')) { store.deleteDoc(docId); close(); renderActiveView(); } } }, 'Delete') : el('span'),
      el('div', { class: 'foot-right' }, [
        el('button', { class: 'btn ghost', onclick: close }, RW ? 'Cancel' : 'Close'),
        RW ? el('button', { class: 'btn primary', onclick: save }, isNew ? 'Create' : 'Save') : null,
      ]),
    ]),
  ]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  if (!RW) modal.querySelectorAll('input, select, textarea').forEach((n) => { n.disabled = true; });
  setTimeout(() => { if (RW) f.title.focus(); }, 30);

  function collect() {
    return {
      kind, projectId: f.project.value, title: f.title.value.trim() || (meta.label),
      status: f.status.value, court: f.court.value.trim(), due: f.due.value || null,
      taskId: f.task.value || null, body: f.body.value, response: f.response.value,
    };
  }
  async function save() {
    const data = collect();
    if (isNew) await store.createDoc(data); else store.updateDoc(docId, data);
    close();
    renderActiveView();
  }
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
}

function openActivityPanel() {
  if (!store.can('write')) return;
  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const filterBar = el('div', { class: 'audit-filters' });
  const list = el('div', { class: 'activity-list' }, el('div', { class: 'login-err' }, 'Loading…'));
  const exportBtn = el('button', { class: 'btn ghost sm', disabled: true, onclick: () => exportCsv() }, '⤓ Export CSV');
  let all = [];
  const filt = { action: '', user: '', project: '', q: '' };

  const modal = el('div', { class: 'modal modal-wide' }, [
    el('div', { class: 'modal-head' }, [el('h2', {}, 'Activity Log'), exportBtn, el('button', { class: 'modal-x', onclick: close }, '✕')]),
    el('div', { class: 'modal-body' }, [filterBar, list]),
  ]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  store.listAudit(true).then((entries) => {
    all = entries;
    exportBtn.disabled = !entries.length;
    buildFilters();
    render();
  }).catch(() => { clear(list); list.appendChild(el('div', { class: 'login-err' }, 'Could not load activity.')); });

  function buildFilters() {
    const uniq = (k) => [...new Set(all.map((e) => e[k]).filter(Boolean))].sort();
    const sel = (key, label, vals, render2) => {
      const s = el('select', { class: 'select sm', onchange: (e) => { filt[key] = e.target.value; render(); } },
        [el('option', { value: '' }, label), ...vals.map((v) => el('option', { value: v }, render2 ? render2(v) : v))]);
      return s;
    };
    clear(filterBar);
    filterBar.append(
      sel('action', 'All actions', uniq('action'), (a) => (ACTION_META[a] ? a : a)),
      sel('user', 'All users', uniq('user')),
      sel('project', 'All projects', uniq('projectId'), (p) => { const pr = store.project(p); return pr ? pr.name : p; }),
      el('input', { class: 'input sm', type: 'search', placeholder: 'Search…', oninput: (e) => { filt.q = e.target.value.toLowerCase(); render(); } }),
    );
  }

  function filtered() {
    return all.filter((e) =>
      (!filt.action || e.action === filt.action) &&
      (!filt.user || e.user === filt.user) &&
      (!filt.project || e.projectId === filt.project) &&
      (!filt.q || `${e.user} ${e.action} ${e.targetName || ''} ${e.detail || ''}`.toLowerCase().includes(filt.q)));
  }

  function render() {
    const rows = filtered();
    clear(list);
    if (!rows.length) { list.appendChild(el('div', { class: 'empty' }, 'No matching activity.')); return; }
    rows.forEach((e) => {
      const meta = ACTION_META[e.action] || { icon: '•', label: e.action };
      const proj = e.projectId ? store.project(e.projectId) : null;
      list.appendChild(el('div', { class: 'activity-row' }, [
        el('span', { class: 'activity-icon' }, meta.icon),
        el('div', { class: 'activity-main' }, [
          el('div', { class: 'activity-text' }, [
            el('b', {}, e.user || 'system'), ' ', meta.label,
            e.targetName ? el('span', { class: 'activity-target' }, ' “' + e.targetName + '”') : null,
            proj ? el('span', { class: 'activity-proj', style: { color: proj.color } }, ' · ' + proj.name) : null,
          ]),
          e.detail ? el('div', { class: 'activity-detail' }, e.detail) : null,
        ]),
        el('span', { class: 'activity-time', title: e.ts }, ago(e.ts) || ''),
      ]));
    });
  }

  function exportCsv() {
    const rows = filtered();
    const cell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const header = ['timestamp', 'user', 'role', 'action', 'target', 'project', 'detail'];
    const lines = [header.join(',')].concat(rows.map((e) => [
      e.ts, e.user, e.role || '', e.action, e.targetName || '',
      (store.project(e.projectId) || {}).name || '', e.detail || '',
    ].map(cell).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `buildflow-activity-${Dates.today()}.csv` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(ev) { if (ev.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
}

// --- Admin: user management panel -------------------------------------------
function openUsersPanel() {
  if (!store.can('admin')) return;
  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const listBody = el('div', { class: 'users-list' });
  const err = el('div', { class: 'login-err' });
  const ROLES = ['viewer', 'pm', 'admin'];

  async function refresh() {
    err.textContent = '';
    clear(listBody);
    let users = [];
    try { users = await store.listUsers(); }
    catch (e) { err.textContent = 'Could not load users'; return; }
    users.forEach((u) => {
      const roleSel = el('select', { class: 'select sm', onchange: async (e) => {
        try { await store.setUserRole(u.username, e.target.value); await refresh(); }
        catch (er) { err.textContent = (er.data && er.data.error) || 'Update failed'; }
      } }, ROLES.map((r) => el('option', { value: r }, ROLE_LABEL[r])));
      roleSel.value = u.role;

      // Project-scope chips (only meaningful for pm; admins are always all-projects)
      const scope = u.role === 'pm'
        ? el('div', { class: 'scope-chips' }, [
            ...store.projects.map((p) => {
              const on = (u.projects || []).includes(p.id);
              return el('button', {
                class: 'scope-chip' + (on ? ' on' : ''),
                title: p.name, style: on ? { borderColor: p.color, color: p.color } : null,
                onclick: async () => {
                  const next = on ? u.projects.filter((x) => x !== p.id) : [...(u.projects || []), p.id];
                  try { await store.updateUser(u.username, { projects: next }); await refresh(); }
                  catch (er) { err.textContent = (er.data && er.data.error) || 'Update failed'; }
                },
              }, p.name.split(' ')[0]);
            }),
            el('span', { class: 'scope-hint' }, (u.projects || []).length ? '' : 'all projects'),
          ])
        : el('span', { class: 'scope-na' }, u.role === 'admin' ? 'all projects' : '—');

      listBody.appendChild(el('div', { class: 'user-row' }, [
        el('span', { class: 'identity-avatar' }, (u.name || u.username).split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()),
        el('div', { class: 'user-id' }, [el('div', { class: 'user-name' }, u.name || u.username), el('div', { class: 'user-uname' }, '@' + u.username)]),
        scope,
        roleSel,
        el('button', { class: 'btn ghost sm', onclick: async () => {
          if (!confirm(`Delete user “${u.username}”?`)) return;
          try { await store.deleteUser(u.username); await refresh(); }
          catch (er) { err.textContent = (er.data && er.data.error) || 'Delete failed'; }
        } }, 'Delete'),
      ]));
    });
  }

  const nu = el('input', { class: 'input sm', placeholder: 'username' });
  const np = el('input', { class: 'input sm', type: 'password', placeholder: 'password' });
  const nn = el('input', { class: 'input sm', placeholder: 'display name' });
  const nr = el('select', { class: 'select sm' }, ROLES.map((r) => el('option', { value: r }, ROLE_LABEL[r])));
  nr.value = 'pm';
  const addBtn = el('button', { class: 'btn primary sm', onclick: async () => {
    err.textContent = '';
    try {
      await store.createUser({ username: nu.value.trim(), password: np.value, name: nn.value.trim(), role: nr.value });
      nu.value = np.value = nn.value = '';
      await refresh();
    } catch (er) { err.textContent = (er.data && er.data.error) || 'Create failed'; }
  } }, 'Add user');

  const modal = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [el('h2', {}, 'User Management'), el('button', { class: 'modal-x', onclick: close }, '✕')]),
    el('div', { class: 'modal-body' }, [
      listBody,
      err,
      el('div', { class: 'user-add' }, [
        el('div', { class: 'user-add-title' }, 'Add a user'),
        el('div', { class: 'user-add-row' }, [nu, np, nn, nr, addBtn]),
      ]),
    ]),
  ]);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  refresh();

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
}

// --- Login screen -----------------------------------------------------------
function renderLogin(root) {
  built = false;
  clear(root);
  const u = el('input', { class: 'input', type: 'text', placeholder: 'Username', autocomplete: 'username' });
  const p = el('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const err = el('div', { class: 'login-err' });
  const btn = el('button', { class: 'btn primary login-btn', type: 'submit' }, 'Sign in');

  async function submit(e) {
    if (e) e.preventDefault();
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Signing in…';
    const res = await store.login(u.value.trim(), p.value);
    if (!res.ok) {
      err.textContent = res.error || 'Sign in failed';
      btn.disabled = false; btn.textContent = 'Sign in';
      p.value = ''; p.focus();
    }
    // on success, onAuth → renderShell builds the app
  }

  const form = el('form', { class: 'login-card', onsubmit: submit }, [
    el('div', { class: 'login-brand' }, [
      el('div', { class: 'brand-mark lg' }, '◭'),
      el('div', {}, [
        el('div', { class: 'brand-name' }, 'BuildFlow'),
        el('div', { class: 'brand-sub' }, 'ERP · Construction Schedule'),
      ]),
    ]),
    el('h2', { class: 'login-title' }, 'Sign in to continue'),
    el('label', { class: 'login-label' }, 'Username'), u,
    el('label', { class: 'login-label' }, 'Password'), p,
    err,
    btn,
    el('div', { class: 'login-demo' }, [
      el('div', { class: 'login-demo-title' }, 'Demo accounts'),
      el('div', {}, 'admin / admin123 — full access'),
      el('div', {}, 'awhitfield / build123 — PM, Riverside only'),
      el('div', {}, 'psandoval / north123 — PM, Northgate + Civic'),
      el('div', {}, 'viewer / view123 — read-only'),
    ]),
  ]);
  root.appendChild(el('div', { class: 'login-screen' }, form));
  setTimeout(() => u.focus(), 30);
}

function renderLoading(root) {
  clear(root);
  root.appendChild(el('div', { class: 'login-screen' },
    el('div', { class: 'loading' }, [el('div', { class: 'brand-mark lg' }, '◭'), el('div', {}, 'Loading…')])));
}

// --- App shell --------------------------------------------------------------
function buildApp(root) {
  clear(root);
  renderHeader(root);
  const kpis = el('div', { id: 'kpis', class: 'kpi-bar' });
  viewMount = el('main', { id: 'view', class: 'view-area' });
  const sync = el('span', { id: 'sync-pill', class: 'sync-pill local' }, 'Local cache');
  root.appendChild(kpis);
  root.appendChild(viewMount);
  root.appendChild(el('footer', { class: 'app-footer' }, [
    el('span', {}, 'BuildFlow ERP · Schedule module'),
    el('span', { class: 'foot-sep' }, '·'),
    sync,
  ]));
  root.appendChild(el('div', { class: 'toast-stack' }));
  built = true;
  renderActiveView();
}

// Decide what to show based on the store's auth state.
let built = false;
function renderShell(root, authState) {
  if (authState === 'required') return renderLogin(root);
  if (authState === 'unknown') return built ? null : renderLoading(root);
  // 'authed' or 'local'
  if (!built) buildApp(root); else { renderHeader(root); renderActiveView(); }
}

// --- Boot -------------------------------------------------------------------
export function boot() {
  const root = document.getElementById('app');

  // One-time global subscriptions (DOM targets are looked up each time and
  // skipped when absent, so this survives login/logout shell rebuilds).
  store.onStatus((mode, syncing) => {
    const sync = document.getElementById('sync-pill');
    if (!sync) return;
    sync.className = 'sync-pill ' + mode + (syncing ? ' syncing' : '');
    sync.textContent = syncing ? 'Saving…' : (mode === 'remote' ? 'Synced to server' : 'Local cache');
  });
  store.onNotice((msg, tone = 'info') => {
    const toasts = document.querySelector('.toast-stack');
    if (!toasts) return;
    const t = el('div', { class: 'toast ' + tone }, msg);
    toasts.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4200);
  });
  store.subscribe(() => renderActiveView());
  store.onAuth((authState) => renderShell(root, authState));

  renderShell(root, store.authState);
}

window.addEventListener('DOMContentLoaded', boot);
