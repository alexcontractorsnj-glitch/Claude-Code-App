// ============================================================================
//  data.js — Browser store. Single source of truth for the UI.
//  Domain model + seed live in seed.js (shared with the Node API server).
//
//  Persistence is layered:
//    • LocalStorage  — always written (offline cache, instant boot).
//    • REST API      — used when reachable (server is then authoritative).
//  The store exposes the SAME synchronous interface either way; remote calls
//  happen optimistically in the background, so views never change.
// ============================================================================

import {
  TRADES, STATUSES, STATUS_ORDER, Dates,
  seedState, makeTask, applyTaskPatch, normalizeState, SCHEMA_VERSION,
} from './seed.js';

// Re-export domain constants so existing view imports (`from '../data.js'`) hold.
export { TRADES, STATUSES, STATUS_ORDER, Dates };

const STORAGE_KEY = 'buildflow.schedule.v1';
const USER_KEY = 'buildflow.user';
const API = '/api';
const API_TIMEOUT = 2500;
const POLL_MS = 4000;            // how often to check the server for others' edits

// --- Fetch helper: returns { status, data, etag }; throws Error w/ .status --
async function api(method, path, body, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT);
  try {
    const res = await fetch(API + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',     // send the session cookie
      signal: ctrl.signal,
    });
    const etag = res.headers.get('ETag');
    if (res.status === 304) return { status: 304, data: null, etag };
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      try { err.data = await res.json(); } catch { /* ignore */ }
      throw err;
    }
    const data = res.status === 204 ? null : await res.json();
    return { status: res.status, data, etag };
  } finally {
    clearTimeout(timer);
  }
}

// Parse a global revision number out of an ETag header (`"7"` → 7).
function revOf(etag) {
  if (!etag) return null;
  const n = parseInt(String(etag).replace(/"/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

// --- Store ------------------------------------------------------------------
class Store {
  constructor() {
    this.listeners = new Set();
    this.statusListeners = new Set();
    this.noticeListeners = new Set();
    this.authListeners = new Set();
    this.mode = 'local';          // 'local' until the API answers
    this.syncing = false;
    this.rev = null;              // last global revision seen from the server
    this._poll = null;
    this.authState = 'unknown';   // unknown | local | required | authed
    this.role = null;             // server role when authenticated
    this.user = this._loadUser(); // display name (local identity, or session user)
    this.state = normalizeState(this._loadLocal());
    this._boot();                 // detect auth, then hydrate if allowed
  }

  // Decide between authenticated-server mode and offline local mode.
  async _boot() {
    try {
      const { data } = await api('GET', '/auth/me');
      this._applyUser(data.user);
      this.mode = 'remote';
      this.authState = 'authed';
      this._emitAuth();
      await this._hydrateRemote();
    } catch (err) {
      if (err && err.status === 401) {
        this.mode = 'remote';
        this.authState = 'required';   // server is there, but we must sign in
        this._emitAuth();
      } else {
        this.mode = 'local';           // no API (file:// or static host) → single-user
        this.authState = 'local';
        this._emitAuth();
      }
      this._emitStatus();
    }
  }

  _applyUser(u) {
    if (!u) return;
    this.user = u.name || u.username;
    this.role = u.role;
  }

  // ---- auth actions ----
  async login(username, password) {
    try {
      const { data } = await api('POST', '/auth/login', { username, password });
      this._applyUser(data.user);
      this.mode = 'remote';
      this.authState = 'authed';
      this._emitAuth();
      await this._hydrateRemote();
      return { ok: true };
    } catch (err) {
      const msg = (err && err.data && err.data.error) || 'Sign in failed';
      return { ok: false, error: msg };
    }
  }

  async logout() {
    try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
    this.role = null;
    this.authState = 'required';
    this._emitAuth();
  }

  // Capability check. Local (no server) mode is single-user → full rights.
  can(action) {
    if (this.mode === 'local') return true;
    if (this.authState !== 'authed') return false;
    const rank = { viewer: 0, pm: 1, admin: 2 }[this.role] ?? -1;
    if (action === 'read') return rank >= 0;
    if (action === 'write') return rank >= 1;
    if (action === 'admin') return rank >= 2;
    return false;
  }

  // ---- admin: user management (thin API wrappers) ----
  listUsers() { return api('GET', '/users').then((r) => r.data); }
  createUser(u) { return api('POST', '/users', u).then((r) => r.data); }
  setUserRole(username, role) { return api('PATCH', '/users/' + username, { role }).then((r) => r.data); }
  deleteUser(username) { return api('DELETE', '/users/' + username).then(() => true); }

  // ---- team identity (attribution, not authentication) ----
  _loadUser() {
    try { return localStorage.getItem(USER_KEY) || 'Site Office'; }
    catch { return 'Site Office'; }
  }
  setUser(name) {
    this.user = (name || '').trim() || 'Site Office';
    try { localStorage.setItem(USER_KEY, this.user); } catch { /* non-fatal */ }
    this._emitStatus();
  }
  _stamp() { return { lastEditedBy: this.user, lastEditedAt: new Date().toISOString() }; }

  // ---- persistence layers ----
  _loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && s.tasks) return s;
      }
    } catch (e) { /* fall through */ }
    const fresh = seedState();
    this._cacheLocal(fresh);
    return fresh;
  }

  _cacheLocal(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { /* private mode / quota — non-fatal */ }
  }

  async _hydrateRemote() {
    const { data, etag } = await api('GET', '/state');
    if (data && data.tasks) {
      this.state = normalizeState(data);
      this.rev = revOf(etag) ?? data.rev ?? this.rev;
      this.mode = 'remote';
      this._cacheLocal(this.state);
      this.listeners.forEach((fn) => fn(this.state));
      this._startPolling();
    }
    this._emitStatus();
  }

  // Session expired (or revoked) mid-session → bounce to the login screen.
  _sessionLost() {
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
    this.role = null;
    this.authState = 'required';
    this._setSyncing(false);
    this._emitAuth();
  }

  // Poll the server; only re-hydrate when the global rev advances past ours
  // (i.e. another client wrote). Cheap: 304 Not Modified when nothing changed.
  _startPolling() {
    if (this._poll || typeof setInterval !== 'function') return;
    this._poll = setInterval(async () => {
      if (this.mode !== 'remote' || this.syncing) return;
      try {
        const { status, data, etag } = await api('GET', '/state', null,
          this.rev != null ? { 'If-None-Match': '"' + this.rev + '"' } : {});
        if (status === 304) return;
        const newRev = revOf(etag) ?? (data && data.rev);
        if (data && data.tasks && newRev !== this.rev) {
          this.state = normalizeState(data);
          this.rev = newRev;
          this._cacheLocal(this.state);
          this.listeners.forEach((fn) => fn(this.state));
          this._notify('Schedule updated by another user', 'info');
        }
      } catch (e) {
        if (e && e.status === 401) { this._sessionLost(); return; }
        this.mode = 'local';
        this._emitStatus();
        clearInterval(this._poll); this._poll = null;
      }
    }, POLL_MS);
  }

  // ---- pub/sub ----
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onStatus(fn) { this.statusListeners.add(fn); return () => this.statusListeners.delete(fn); }
  onNotice(fn) { this.noticeListeners.add(fn); return () => this.noticeListeners.delete(fn); }
  onAuth(fn) { this.authListeners.add(fn); return () => this.authListeners.delete(fn); }
  _emit() { this._cacheLocal(this.state); this.listeners.forEach((fn) => fn(this.state)); }
  _emitStatus() { this.statusListeners.forEach((fn) => fn(this.mode, this.syncing)); }
  _emitAuth() { this.authListeners.forEach((fn) => fn(this.authState, this.user, this.role)); }

  // Common handling for a failed write: session loss → re-login, forbidden →
  // notify + reconcile, anything else → fall back to local cache.
  _writeFailed(err) {
    this._setSyncing(false);
    if (err && err.status === 401) { this._sessionLost(); return; }
    if (err && err.status === 403) {
      this._notify('Your role doesn’t allow that change — reverting.', 'warn');
      if (this.authState === 'authed') this._hydrateRemote().catch(() => {});
      return;
    }
    this.mode = 'local';
    this._emitStatus();
  }
  _notify(msg, tone) { this.noticeListeners.forEach((fn) => fn(msg, tone)); }

  _setSyncing(v) { this.syncing = v; this._emitStatus(); }

  // ---- selectors ----
  get projects() { return this.state.projects; }
  get crews() { return this.state.crews; }
  tasks(projectId) {
    return projectId && projectId !== 'all'
      ? this.state.tasks.filter((t) => t.projectId === projectId)
      : this.state.tasks;
  }
  task(id) { return this.state.tasks.find((t) => t.id === id); }
  crew(id) { return this.state.crews.find((c) => c.id === id) || null; }
  project(id) { return this.state.projects.find((p) => p.id === id) || null; }
  get baseline() { return this.state.baseline || null; }

  // ---- mutations (optimistic: local first, then sync) ----
  // Each edit is stamped with the current user + time (attribution). PATCH
  // carries If-Match with the task's known rev — a 409 means someone else
  // changed it first → we re-hydrate from the server and tell the user.
  updateTask(id, patch) {
    if (!this._guardWrite()) return;
    const t = this.task(id);
    if (!t) return;
    const baseRev = t.rev || 1;
    const stamped = { ...patch, ...this._stamp() };
    applyTaskPatch(t, stamped);
    this._emit();
    if (this.mode !== 'remote') return;
    this._setSyncing(true);
    api('PATCH', '/tasks/' + id, stamped, { 'If-Match': '"' + baseRev + '"' })
      .then(({ data, etag }) => {
        const cur = this.task(id);
        if (cur && data && data.rev != null) cur.rev = data.rev;
        this.rev = revOf(etag) ?? this.rev;
        this._setSyncing(false);
      })
      .catch((err) => {
        if (err.status === 409) {
          this._setSyncing(false);
          const who = err.data && err.data.current && err.data.current.lastEditedBy;
          this._notify(`“${t.name}” was just changed by ${who || 'another user'} — reloaded the latest.`, 'warn');
          this._hydrateRemote().catch(() => {});
        } else {
          this._writeFailed(err);
        }
      });
  }

  addTask(partial) {
    if (!this._guardWrite()) return null;
    const full = makeTask(this.state.tasks, { ...partial, ...this._stamp() });
    this.state.tasks.push(full);
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('POST', '/tasks', full)
        .then(({ etag }) => { this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); })
        .catch((err) => this._writeFailed(err));
    }
    return full;
  }

  // ---- baseline (planned vs. actual) ----
  saveBaseline() {
    if (!this._guardWrite()) return;
    const snap = {
      label: 'Baseline', savedAt: Dates.today(), savedBy: this.user,
      tasks: Object.fromEntries(this.state.tasks.map((t) => [t.id, { start: t.start, end: t.end, cost: t.cost || 0 }])),
    };
    this.state.baseline = snap;
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('POST', '/baseline', { savedBy: this.user })
        .then(({ etag }) => { this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); })
        .catch((err) => this._writeFailed(err));
    }
    this._notify('Baseline saved — variance is now measured against today’s plan.', 'info');
  }

  clearBaseline() {
    if (!this._guardWrite()) return;
    this.state.baseline = null;
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('DELETE', '/baseline')
        .then(({ etag }) => { this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); })
        .catch((err) => this._writeFailed(err));
    }
  }

  deleteTask(id) {
    if (!this._guardWrite()) return;
    this.state.tasks = this.state.tasks.filter((t) => t.id !== id);
    this.state.tasks.forEach((t) => {
      t.dependencies = t.dependencies.filter((d) => d !== id);
    });
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('DELETE', '/tasks/' + id)
        .then(({ etag }) => { this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); })
        .catch((err) => this._writeFailed(err));
    }
  }

  // Client-side permission gate (defence in depth; the server also enforces).
  _guardWrite() {
    if (this.can('write')) return true;
    this._notify('You have read-only access — that change was blocked.', 'warn');
    return false;
  }

  async reset() {
    if (this.mode === 'remote') {
      if (!this.can('admin')) { this._notify('Only an admin can reset the schedule.', 'warn'); return; }
      this._setSyncing(true);
      try {
        const { data, etag } = await api('POST', '/reset');
        if (data && data.tasks) {
          this.state = normalizeState(data);
          this.rev = revOf(etag) ?? data.rev ?? this.rev;
          this._emit();
          return;
        }
      } catch (e) { this._writeFailed(e); }
      finally { this._setSyncing(false); }
    }
    this.state = seedState();
    this._emit();
  }
}

export const store = new Store();
export { SCHEMA_VERSION };

// ============================================================================
//  Critical Path Method (CPM) — forward/backward pass over the dependency DAG.
//  Returns a Set of task ids on the critical path (zero total float).
// ============================================================================
export function computeCriticalPath(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const dur = (t) => Math.max(1, Dates.diffDays(t.start, t.end) + 1);

  const indeg = new Map(tasks.map((t) => [t.id, 0]));
  tasks.forEach((t) => t.dependencies.forEach((d) => {
    if (byId.has(d)) indeg.set(t.id, (indeg.get(t.id) || 0) + 1);
  }));
  const succ = new Map(tasks.map((t) => [t.id, []]));
  tasks.forEach((t) => t.dependencies.forEach((d) => {
    if (byId.has(d)) succ.get(d).push(t.id);
  }));
  const queue = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  const order = [];
  const indegW = new Map(indeg);
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    succ.get(id).forEach((s) => {
      indegW.set(s, indegW.get(s) - 1);
      if (indegW.get(s) === 0) queue.push(s);
    });
  }

  const ES = new Map(), EF = new Map();
  order.forEach((id) => {
    const t = byId.get(id);
    const deps = t.dependencies.filter((d) => byId.has(d));
    const es = deps.length ? Math.max(...deps.map((d) => EF.get(d))) : 0;
    ES.set(id, es);
    EF.set(id, es + dur(t));
  });
  const projectEnd = Math.max(0, ...[...EF.values()]);

  const LS = new Map(), LF = new Map();
  [...order].reverse().forEach((id) => {
    const t = byId.get(id);
    const sc = succ.get(id);
    const lf = sc.length ? Math.min(...sc.map((s) => LS.get(s))) : projectEnd;
    LF.set(id, lf);
    LS.set(id, lf - dur(t));
  });

  const critical = new Set();
  order.forEach((id) => {
    if (Math.abs((LS.get(id) || 0) - (ES.get(id) || 0)) < 0.5) critical.add(id);
  });
  return critical;
}
