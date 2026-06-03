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
import { scheduleVariance, taskVariance } from './variance.js';

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
};

const VIEWS = {
  gantt: { label: 'Gantt', icon: '▦', render: renderGantt },
  board: { label: 'Board', icon: '▤', render: renderBoard },
  calendar: { label: 'Calendar', icon: '▣', render: renderCalendar },
  cost: { label: 'Cost / EVM', icon: '▥', render: renderCost },
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
    store.can('admin') ? el('button', { class: 'btn ghost sm', onclick: () => openUsersPanel() }, 'Users') : null,
    el('button', { class: 'btn ghost sm', title: 'Sign out', onclick: () => store.logout() }, 'Sign out'),
  ]);
}

// Baseline save/clear control with the saved-date indicator. Editing requires
// write access; read-only roles just see the baseline tag.
function baselineControls() {
  const b = store.baseline;
  const rw = store.can('write');
  if (!b) {
    return rw ? el('button', { class: 'btn ghost', title: 'Snapshot the current schedule as the plan to measure slip against',
      onclick: () => store.saveBaseline() }, '📌 Save Baseline') : null;
  }
  return el('div', { class: 'baseline-ctl' }, [
    el('span', { class: 'baseline-tag', title: `Baseline by ${b.savedBy || 'Unknown'}` }, `Baseline · ${Dates.fmt(b.savedAt)}`),
    rw ? el('button', { class: 'btn ghost sm', onclick: () => store.saveBaseline() }, 'Re-baseline') : null,
    rw ? el('button', { class: 'btn ghost sm', onclick: () => { if (confirm('Clear the saved baseline?')) store.clearBaseline(); } }, 'Clear') : null,
  ]);
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

// --- Task editor modal ------------------------------------------------------
function openEditor(taskId) {
  const RW = store.can('write');           // read-only roles can view but not edit
  const isNew = taskId == null;
  if (isNew && !RW) return;                // viewers can't create
  const t = isNew ? {
    projectId: ctx.projectId === 'all' ? store.projects[0].id : ctx.projectId,
    name: '', trade: ctx.tradeFilter === 'all' ? 'sitework' : ctx.tradeFilter,
    crewId: null, start: Dates.today(), end: Dates.addDays(Dates.today(), 4),
    dependencies: [], progress: 0, status: 'not-started', milestone: false,
  } : { ...store.task(taskId) };

  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
  const f = {};

  const field = (label, input) => el('div', { class: 'form-field' }, [el('label', {}, label), input]);

  f.name = el('input', { class: 'input', type: 'text', value: t.name, placeholder: 'e.g. Foundation Pour' });
  f.project = el('select', { class: 'select' }, store.projects.map((p) => el('option', { value: p.id }, p.name))); f.project.value = t.projectId;
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

  const modal = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-head' }, [
      el('h2', {}, isNew ? 'New Work Package' : (RW ? 'Edit Work Package' : 'Work Package')),
      !RW ? el('span', { class: 'role-badge role-viewer' }, 'Read-only') : null,
      el('button', { class: 'modal-x', onclick: close }, '✕'),
    ]),
    el('div', { class: 'modal-body' }, [
      field('Task name', f.name),
      el('div', { class: 'form-row' }, [field('Project', f.project), field('Trade', f.trade)]),
      field('Assigned crew', f.crew),
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
      listBody.appendChild(el('div', { class: 'user-row' }, [
        el('span', { class: 'identity-avatar' }, (u.name || u.username).split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()),
        el('div', { class: 'user-id' }, [el('div', { class: 'user-name' }, u.name || u.username), el('div', { class: 'user-uname' }, '@' + u.username)]),
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
      el('div', {}, 'awhitfield / build123 — project manager (edit)'),
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
