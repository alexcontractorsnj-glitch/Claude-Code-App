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
  seedState, makeTask, applyTaskPatch, SCHEMA_VERSION,
} from './seed.js';

// Re-export domain constants so existing view imports (`from '../data.js'`) hold.
export { TRADES, STATUSES, STATUS_ORDER, Dates };

const STORAGE_KEY = 'buildflow.schedule.v1';
const API = '/api';
const API_TIMEOUT = 2500;

// --- Tiny fetch helper with timeout ----------------------------------------
async function api(method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT);
  try {
    const res = await fetch(API + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.status === 204 ? null : await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// --- Store ------------------------------------------------------------------
class Store {
  constructor() {
    this.listeners = new Set();
    this.statusListeners = new Set();
    this.mode = 'local';          // 'local' until the API answers
    this.syncing = false;
    this.state = this._loadLocal();
    this._hydrateRemote();        // fire-and-forget; re-emits if server responds
  }

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
    try {
      const remote = await api('GET', '/state');
      if (remote && remote.tasks) {
        this.state = remote;
        this.mode = 'remote';
        this._cacheLocal(remote);
        this._emit({ persistLocalOnly: true }); // server already has it
      }
    } catch (e) {
      this.mode = 'local';        // file:// or no API — stay on LocalStorage
    } finally {
      this._emitStatus();
    }
  }

  // ---- pub/sub ----
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onStatus(fn) { this.statusListeners.add(fn); return () => this.statusListeners.delete(fn); }
  _emit() { this._cacheLocal(this.state); this.listeners.forEach((fn) => fn(this.state)); }
  _emitStatus() { this.statusListeners.forEach((fn) => fn(this.mode, this.syncing)); }

  _setSyncing(v) { this.syncing = v; this._emitStatus(); }

  // Run a remote write in the background; downgrade to local mode on failure.
  async _push(fn) {
    if (this.mode !== 'remote') return;
    this._setSyncing(true);
    try { await fn(); }
    catch (e) { this.mode = 'local'; console.warn('Remote sync lost — using local cache', e); }
    finally { this._setSyncing(false); }
  }

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

  // ---- mutations (optimistic: local first, then sync) ----
  updateTask(id, patch) {
    const t = this.task(id);
    if (!t) return;
    applyTaskPatch(t, patch);
    this._emit();
    this._push(() => api('PATCH', '/tasks/' + id, patch));
  }

  addTask(partial) {
    const full = makeTask(this.state.tasks, partial);
    this.state.tasks.push(full);
    this._emit();
    this._push(() => api('POST', '/tasks', full));
    return full;
  }

  deleteTask(id) {
    this.state.tasks = this.state.tasks.filter((t) => t.id !== id);
    this.state.tasks.forEach((t) => {
      t.dependencies = t.dependencies.filter((d) => d !== id);
    });
    this._emit();
    this._push(() => api('DELETE', '/tasks/' + id));
  }

  async reset() {
    if (this.mode === 'remote') {
      this._setSyncing(true);
      try {
        const fresh = await api('POST', '/reset');
        if (fresh && fresh.tasks) { this.state = fresh; this._emit(); return; }
      } catch (e) { this.mode = 'local'; }
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
