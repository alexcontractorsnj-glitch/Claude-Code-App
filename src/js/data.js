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
  seedState, makeTask, applyTaskPatch, normalizeState, nextBaselineId, SCHEMA_VERSION,
} from './seed.js';
import { buildApplication, appsForProject } from './billing.js';
import { makeDoc } from './docs.js';
import { makeChangeOrder } from './changeorders.js';
import { makeReport } from './fieldreports.js';
import { makePunchItem } from './punch.js';
import {
  makeMessage, capChannel, setRead, lastRead, unreadCount,
  messagesForChannel, lastMessage, channelIdForProject, messagesForTask,
} from './messaging.js';
import { makeDelivery, deliveriesFor, deliverySummary } from './deliveries.js';
import { makeIssue, issuesForTask, issueSummary } from './issues.js';
import { CallManager } from './webrtc.js';

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
    this.scope = [];              // project scope ([] = all / unrestricted)
    this.user = this._loadUser(); // display name (local identity, or session user)
    this.onlineUsers = [];        // [{username,name}] currently connected (SSE presence)
    this.typing = {};             // { channelId: { name: expiryMs } }
    this._es = null;              // EventSource (live stream)
    this.callListeners = new Set();
    this.calls = new CallManager((to, msg) => this._sendSignal(to, msg), (snap) => this.callListeners.forEach((fn) => fn(snap)));
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
    this.username = u.username || u.name;       // stable id for message attribution + read state
    this.role = u.role;
    this.scope = Array.isArray(u.projects) ? u.projects : [];
  }
  _uid() { return this.username || this.user || 'me'; }

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
    this._stopStream();
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

  // Unrestricted = admin or a pm with no project list.
  isUnrestricted() { return this.mode === 'local' || this.role === 'admin' || (this.can('write') && this.scope.length === 0); }
  // Per-project write permission (project scoping).
  canEditProject(projectId) {
    if (this.mode === 'local') return true;
    if (!this.can('write')) return false;
    return this.isUnrestricted() || this.scope.includes(projectId);
  }
  // Baseline is schedule-wide → only unrestricted writers.
  canBaseline() { return this.can('write') && this.isUnrestricted(); }
  // Projects this user may create tasks in (for the editor's project picker).
  editableProjects() {
    return this.isUnrestricted() ? this.state.projects : this.state.projects.filter((p) => this.scope.includes(p.id));
  }

  // ---- admin: user management + audit (thin API wrappers) ----
  listUsers() { return api('GET', '/users').then((r) => r.data); }
  createUser(u) { return api('POST', '/users', u).then((r) => r.data); }
  updateUser(username, patch) { return api('PATCH', '/users/' + username, patch).then((r) => r.data); }
  setUserRole(username, role) { return this.updateUser(username, { role }); }
  deleteUser(username) { return api('DELETE', '/users/' + username).then(() => true); }
  listAudit(all) { return api('GET', '/audit' + (all ? '?all=1' : '')).then((r) => r.data); }
  taskHistory(id) { return api('GET', '/tasks/' + id + '/history').then((r) => r.data); }

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
      this._startStream();
    }
    this._emitStatus();
  }

  // Session expired (or revoked) mid-session → bounce to the login screen.
  _sessionLost() {
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
    this._stopStream();
    this.role = null;
    this.authState = 'required';
    this._setSyncing(false);
    this._emitAuth();
  }

  // --- Live stream (SSE): instant updates + presence + typing ---------------
  // A tiny `sync` signal triggers a conditional re-pull; polling stays as a
  // fallback (and mostly returns 304 once the stream is live).
  _startStream() {
    if (this._es || typeof EventSource === 'undefined') return;
    try { this._es = new EventSource(API + '/stream'); } catch { return; }
    this._es.addEventListener('sync', (e) => { try { if (JSON.parse(e.data).rev !== this.rev) this._pull(); } catch { /* ignore */ } });
    this._es.addEventListener('presence', (e) => { try { this.onlineUsers = JSON.parse(e.data).online || []; this.listeners.forEach((fn) => fn(this.state)); } catch { /* ignore */ } });
    this._es.addEventListener('typing', (e) => { try { const d = JSON.parse(e.data); if (d.user !== this.username) this._setTyping(d.channelId, d.name); } catch { /* ignore */ } });
    this._es.addEventListener('call', (e) => { try { this.calls.handleSignal(JSON.parse(e.data)); } catch { /* ignore */ } });
    this._es.onerror = () => { /* EventSource auto-reconnects; polling covers gaps */ };
  }
  _stopStream() { if (this._es) { try { this._es.close(); } catch { /* ignore */ } this._es = null; } this.onlineUsers = []; }

  // ---- calls (1:1 audio/video) ----
  _sendSignal(to, msg) { api('POST', '/signal', { to, ...msg }).catch(() => {}); }
  onCall(fn) { this.callListeners.add(fn); return () => this.callListeners.delete(fn); }
  callPeer(peer, video) { return this.calls.call(peer, video); }
  peopleOnline() { return this.onlineUsers.filter((u) => u.username && u.username !== this.username); }

  _pull() {
    if (this._pulling || this.mode !== 'remote') return;
    this._pulling = true;
    api('GET', '/state', null, this.rev != null ? { 'If-None-Match': '"' + this.rev + '"' } : {})
      .then(({ status, data, etag }) => {
        if (status === 304) return;
        const newRev = revOf(etag) ?? (data && data.rev);
        if (data && data.tasks && newRev !== this.rev) {
          this.state = normalizeState(data); this.rev = newRev; this._cacheLocal(this.state);
          this.listeners.forEach((fn) => fn(this.state));
        }
      })
      .catch((e) => { if (e && e.status === 401) this._sessionLost(); })
      .finally(() => { this._pulling = false; });
  }

  // Typing presence (4s TTL per typer), driven by relayed `typing` events.
  _setTyping(channelId, name) {
    this.typing[channelId] = this.typing[channelId] || {};
    this.typing[channelId][name] = Date.now() + 4000;
    this.listeners.forEach((fn) => fn(this.state));
    clearTimeout(this._typingT);
    this._typingT = setTimeout(() => this._pruneTyping(), 4200);
  }
  _pruneTyping() {
    const now = Date.now(); let changed = false;
    for (const c of Object.keys(this.typing)) for (const n of Object.keys(this.typing[c])) if (this.typing[c][n] <= now) { delete this.typing[c][n]; changed = true; }
    if (changed) this.listeners.forEach((fn) => fn(this.state));
  }
  typingIn(channelId) {
    const m = this.typing[channelId]; if (!m) return [];
    const now = Date.now();
    return Object.keys(m).filter((n) => m[n] > now && n !== this.user);
  }
  postTyping(channelId) {
    const now = Date.now();
    if (this._lastTyping && now - this._lastTyping < 2000) return;     // throttle
    this._lastTyping = now;
    if (this.mode === 'remote') api('POST', '/channels/' + channelId + '/typing').catch(() => {});
  }
  onlineCount() { return this.onlineUsers.length; }

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
    const t = this.task(id);
    if (!t) return;
    if (!this._guardProject(t.projectId)) return;
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
    if (!this._guardProject(partial.projectId)) return null;
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

  // ---- baseline history (planned vs. actual) ----
  get baselines() { return this.state.baselines || []; }

  saveBaseline(label) {
    if (!this.canBaseline()) { this._notify('Saving a baseline requires all-project access.', 'warn'); return; }
    if (!Array.isArray(this.state.baselines)) this.state.baselines = this.state.baseline ? [this.state.baseline] : [];
    const snap = {
      id: nextBaselineId(this.state.baselines),
      label: (label || '').trim() || ('Baseline ' + (this.state.baselines.length + 1)),
      savedAt: Dates.today(), savedBy: this.user,
      tasks: Object.fromEntries(this.state.tasks.map((t) => [t.id, { start: t.start, end: t.end, cost: t.cost || 0 }])),
    };
    this.state.baselines.push(snap);
    this.state.baseline = snap;
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('POST', '/baseline', { label: snap.label })
        .then(({ data, etag }) => { if (data && data.id) { snap.id = data.id; } this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); })
        .catch((err) => this._writeFailed(err));
    }
    this._notify(`Baseline “${snap.label}” saved.`, 'info');
  }

  activateBaseline(id) {
    if (!this.canBaseline()) { this._notify('Switching baselines requires all-project access.', 'warn'); return; }
    this.state.baseline = id === 'none' ? null : (this.state.baselines || []).find((b) => b.id === id) || null;
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('POST', '/baseline/' + id + '/activate')
        .then(({ etag }) => { this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); })
        .catch((err) => this._writeFailed(err));
    }
  }

  deleteBaseline(id) {
    if (!this.canBaseline()) { this._notify('Deleting a baseline requires all-project access.', 'warn'); return; }
    this.state.baselines = (this.state.baselines || []).filter((b) => b.id !== id);
    if (this.state.baseline && this.state.baseline.id === id) {
      this.state.baseline = this.state.baselines[this.state.baselines.length - 1] || null;
    }
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('DELETE', '/baseline/' + id)
        .then(({ etag }) => { this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); })
        .catch((err) => this._writeFailed(err));
    }
  }

  clearBaseline() { this.activateBaseline('none'); }

  // ---- billing (schedule of values / payment applications) ----
  get payApps() { return this.state.payApps || []; }

  async createPayApp(projectId, retainagePct) {
    if (!this.canEditProject(projectId)) { this._notify('You don’t have access to that project.', 'warn'); return null; }
    if (!Array.isArray(this.state.payApps)) this.state.payApps = [];
    if (this.mode === 'remote') {
      this._setSyncing(true);
      try {
        const { data, etag } = await api('POST', '/billing', { projectId, retainagePct });
        this.rev = revOf(etag) ?? this.rev;
        this.state.payApps.push(data); this._emit();
        return data;
      } catch (e) { this._writeFailed(e); return null; }
      finally { this._setSyncing(false); }
    }
    const project = this.project(projectId);
    const prior = appsForProject(this.state.payApps, projectId);
    const app = buildApplication(project, this.state.tasks, {
      number: prior.length + 1, retainagePct: Math.min(50, Math.max(0, +retainagePct || 0)),
      periodTo: Dates.today(), createdBy: this.user, createdAt: new Date().toISOString(),
    }, prior[prior.length - 1]);
    app.id = 'pa' + (Math.max(0, ...this.state.payApps.map((a) => +String(a.id).slice(2) || 0)) + 1);
    this.state.payApps.push(app); this._emit();
    return app;
  }

  deletePayApp(id) {
    const app = this.payApps.find((a) => a.id === id);
    if (app && !this._guardProject(app.projectId)) return;
    this.state.payApps = this.payApps.filter((a) => a.id !== id);
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('DELETE', '/billing/' + id).then(({ etag }) => { this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); }).catch((e) => this._writeFailed(e));
    }
  }

  // ---- documents (submittals & RFIs) ----
  get docs() { return this.state.docs || []; }

  async createDoc(partial) {
    if (!this.canEditProject(partial.projectId)) { this._notify('You don’t have access to that project.', 'warn'); return null; }
    if (!Array.isArray(this.state.docs)) this.state.docs = [];
    if (this.mode === 'remote') {
      this._setSyncing(true);
      try {
        const { data, etag } = await api('POST', '/docs', partial);
        this.rev = revOf(etag) ?? this.rev;
        this.state.docs.push(data); this._emit();
        return data;
      } catch (e) { this._writeFailed(e); return null; }
      finally { this._setSyncing(false); }
    }
    const doc = makeDoc(this.state.docs, { ...partial, createdBy: this.user, createdAt: new Date().toISOString() });
    this.state.docs.push(doc); this._emit();
    return doc;
  }

  updateDoc(id, patch) {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc) return;
    if (!this._guardProject(doc.projectId)) return;
    Object.assign(doc, patch, { updatedBy: this.user, updatedAt: new Date().toISOString() });
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('PATCH', '/docs/' + id, patch).then(({ data, etag }) => {
        if (data && data.rev != null) doc.rev = data.rev;
        this.rev = revOf(etag) ?? this.rev; this._setSyncing(false);
      }).catch((e) => this._writeFailed(e));
    }
  }

  deleteDoc(id) {
    const doc = this.docs.find((d) => d.id === id);
    if (doc && !this._guardProject(doc.projectId)) return;
    this.state.docs = this.docs.filter((d) => d.id !== id);
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('DELETE', '/docs/' + id).then(({ etag }) => { this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); }).catch((e) => this._writeFailed(e));
    }
  }

  // ---- change orders ----
  get changeOrders() { return this.state.changeOrders || []; }

  async createChangeOrder(partial) {
    if (!this.canEditProject(partial.projectId)) { this._notify('You don’t have access to that project.', 'warn'); return null; }
    if (!Array.isArray(this.state.changeOrders)) this.state.changeOrders = [];
    if (this.mode === 'remote') {
      this._setSyncing(true);
      try { const { data, etag } = await api('POST', '/changeorders', partial); this.rev = revOf(etag) ?? this.rev; this.state.changeOrders.push(data); this._emit(); return data; }
      catch (e) { this._writeFailed(e); return null; } finally { this._setSyncing(false); }
    }
    const co = makeChangeOrder(this.state.changeOrders, { ...partial, createdBy: this.user, createdAt: new Date().toISOString() });
    if (co.status === 'approved') { co.approvedBy = this.user; co.approvedAt = new Date().toISOString(); }
    this.state.changeOrders.push(co); this._emit(); return co;
  }

  updateChangeOrder(id, patch) {
    const co = this.changeOrders.find((c) => c.id === id);
    if (!co || !this._guardProject(co.projectId)) return;
    const wasApproved = co.status === 'approved';
    Object.assign(co, patch);
    if (co.status === 'approved' && !wasApproved) { co.approvedBy = this.user; co.approvedAt = new Date().toISOString(); }
    if (co.status !== 'approved') { co.approvedBy = null; co.approvedAt = null; }
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('PATCH', '/changeorders/' + id, patch).then(({ data, etag }) => { if (data && data.rev != null) co.rev = data.rev; this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); }).catch((e) => this._writeFailed(e));
    }
  }

  deleteChangeOrder(id) {
    const co = this.changeOrders.find((c) => c.id === id);
    if (co && !this._guardProject(co.projectId)) return;
    this.state.changeOrders = this.changeOrders.filter((c) => c.id !== id);
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('DELETE', '/changeorders/' + id).then(({ etag }) => { this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); }).catch((e) => this._writeFailed(e));
    }
  }

  // ---- daily field reports ----
  get reports() { return this.state.reports || []; }

  async createReport(partial) {
    if (!this.canEditProject(partial.projectId)) { this._notify('You don’t have access to that project.', 'warn'); return null; }
    if (!Array.isArray(this.state.reports)) this.state.reports = [];
    if (this.mode === 'remote') {
      this._setSyncing(true);
      try { const { data, etag } = await api('POST', '/reports', partial); this.rev = revOf(etag) ?? this.rev; this.state.reports.push(data); this._emit(); return data; }
      catch (e) { this._writeFailed(e); return null; } finally { this._setSyncing(false); }
    }
    const r = makeReport(this.state.reports, { ...partial, createdBy: this.user, createdAt: new Date().toISOString() });
    this.state.reports.push(r); this._emit(); return r;
  }

  updateReport(id, patch) {
    const r = this.reports.find((x) => x.id === id);
    if (!r || !this._guardProject(r.projectId)) return;
    Object.assign(r, patch);
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('PATCH', '/reports/' + id, patch).then(({ data, etag }) => { if (data && data.rev != null) r.rev = data.rev; this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); }).catch((e) => this._writeFailed(e));
    }
  }

  deleteReport(id) {
    const r = this.reports.find((x) => x.id === id);
    if (r && !this._guardProject(r.projectId)) return;
    this.state.reports = this.reports.filter((x) => x.id !== id);
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('DELETE', '/reports/' + id).then(({ etag }) => { this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); }).catch((e) => this._writeFailed(e));
    }
  }

  // ---- punch list / closeout ----
  get punch() { return this.state.punch || []; }

  async createPunch(partial) {
    if (!this.canEditProject(partial.projectId)) { this._notify('You don’t have access to that project.', 'warn'); return null; }
    if (!Array.isArray(this.state.punch)) this.state.punch = [];
    if (this.mode === 'remote') {
      this._setSyncing(true);
      try { const { data, etag } = await api('POST', '/punch', partial); this.rev = revOf(etag) ?? this.rev; this.state.punch.push(data); this._emit(); return data; }
      catch (e) { this._writeFailed(e); return null; } finally { this._setSyncing(false); }
    }
    const p = makePunchItem(this.state.punch, { ...partial, createdBy: this.user, createdAt: new Date().toISOString() });
    this.state.punch.push(p); this._emit(); return p;
  }

  updatePunch(id, patch) {
    const p = this.punch.find((x) => x.id === id);
    if (!p || !this._guardProject(p.projectId)) return;
    Object.assign(p, patch, { updatedBy: this.user, updatedAt: new Date().toISOString() });
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('PATCH', '/punch/' + id, patch).then(({ data, etag }) => { if (data && data.rev != null) p.rev = data.rev; this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); }).catch((e) => this._writeFailed(e));
    }
  }

  deletePunch(id) {
    const p = this.punch.find((x) => x.id === id);
    if (p && !this._guardProject(p.projectId)) return;
    this.state.punch = this.punch.filter((x) => x.id !== id);
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('DELETE', '/punch/' + id).then(({ etag }) => { this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); }).catch((e) => this._writeFailed(e));
    }
  }

  // ---- messaging (channels + messages) ----
  get channels() { return (this.state.channels || []).filter((c) => !c.archived); }
  get messages() { return this.state.messages || []; }
  channelFor(projectId) { return this.channels.find((c) => c.id === channelIdForProject(projectId)) || null; }
  channel(id) { return this.channels.find((c) => c.id === id) || null; }
  messagesFor(channelId) { return messagesForChannel(this.messages, channelId); }
  lastMessageFor(channelId) { return lastMessage(this.messages, channelId); }
  lastReadAt(channelId) { return lastRead(this.state.reads, this._uid(), channelId); }
  unread(channelId) { return unreadCount(this.messages, channelId, this.lastReadAt(channelId), this._uid()); }
  totalUnread() { return this.channels.reduce((a, c) => a + this.unread(c.id), 0); }
  // Can the current user post to this channel? (project channels are scope-gated)
  canPost(channelId) {
    const ch = this.channel(channelId);
    if (!ch) return false;
    return ch.type === 'project' ? this.canEditProject(ch.projectId) : this.can('write');
  }

  // ---- task Activity (a task's slice of its project channel, via linkedTo) ----
  messagesForTask(taskId) { return messagesForTask(this.messages, taskId); }
  taskActivityCount(taskId) { return messagesForTask(this.messages, taskId).length; }
  canPostTask(taskId) { const t = this.task(taskId); return !!t && this.canEditProject(t.projectId); }
  postTaskMessage(taskId, body) {
    const t = this.task(taskId); if (!t) return null;
    const ch = this.channelFor(t.projectId); if (!ch) return null;
    return this.sendMessage(ch.id, body, { linkedTo: { kind: 'task', id: taskId } });
  }
  postTaskVoice(taskId, clip) {
    const t = this.task(taskId); if (!t) return null;
    const ch = this.channelFor(t.projectId); if (!ch) return null;
    return this.sendVoice(ch.id, clip, { kind: 'task', id: taskId });
  }
  postTaskPhoto(taskId, pic) {
    const t = this.task(taskId); if (!t) return null;
    const ch = this.channelFor(t.projectId); if (!ch) return null;
    return this.sendPhoto(ch.id, pic, { kind: 'task', id: taskId });
  }
  // All photos in scope (for the project Photos gallery).
  photosFor(projectId) {
    return (this.messages || [])
      .filter((m) => m.photo && (projectId === 'all' || (this.channel(m.channelId) || {}).projectId === projectId))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async sendMessage(channelId, body, extra = {}) {
    const ch = this.channel(channelId);
    if (!ch) return null;
    if (!this.canPost(channelId)) { this._notify('You don’t have access to that project’s channel.', 'warn'); return null; }
    if (this.mode === 'remote') {
      this._setSyncing(true);
      try {
        const { data, etag } = await api('POST', '/messages', { channelId, body, ...extra });
        this.rev = revOf(etag) ?? this.rev;
        this.state.messages.push(data);
        this.state.reads = setRead(this.state.reads, this._uid(), channelId, data.createdAt);
        this._emit();
        return data;
      } catch (e) { this._writeFailed(e); return null; }
      finally { this._setSyncing(false); }
    }
    const msg = makeMessage(this.state.messages, { channelId, authorId: this._uid(), authorName: this.user, body, ...extra });
    if (!msg.body && !msg.attachments.length) return null;
    this.state.messages.push(msg);
    this.state.messages = capChannel(this.state.messages, channelId);
    this.state.reads = setRead(this.state.reads, this._uid(), channelId, msg.createdAt);
    this._emit();
    return msg;
  }

  // Playback URL for a voice note: a demo data-URL, or the server stream.
  voiceSrc(msg) {
    if (!msg || !msg.voice) return null;
    return msg.voice.url || ('/api/voice/' + msg.voice.id);
  }

  // Send a voice note. `clip` = { mime, b64, dur }. Remote uploads the audio to
  // /api/voice (kept out of /api/state) then posts a message referencing it;
  // local/demo embeds the audio as a data-URL on the message.
  async sendVoice(channelId, clip, linkedTo) {
    const ch = this.channel(channelId);
    if (!ch || !clip || !clip.b64) return null;
    if (!this.canPost(channelId)) { this._notify('You don’t have access to that channel.', 'warn'); return null; }
    if (this.mode === 'remote') {
      this._setSyncing(true);
      try {
        const up = await api('POST', '/voice', { mime: clip.mime, data: clip.b64, dur: clip.dur });
        const { data, etag } = await api('POST', '/messages', { channelId, voice: { id: up.data.id }, linkedTo: linkedTo || null });
        this.rev = revOf(etag) ?? this.rev;
        this.state.messages.push(data);
        this.state.reads = setRead(this.state.reads, this._uid(), channelId, data.createdAt);
        this._emit();
        return data;
      } catch (e) { this._writeFailed(e); return null; }
      finally { this._setSyncing(false); }
    }
    const msg = makeMessage(this.state.messages, {
      channelId, authorId: this._uid(), authorName: this.user, linkedTo: linkedTo || null,
      voice: { url: `data:${clip.mime};base64,${clip.b64}`, dur: clip.dur, mime: clip.mime },
    });
    this.state.messages.push(msg);
    this.state.messages = capChannel(this.state.messages, channelId);
    this.state.reads = setRead(this.state.reads, this._uid(), channelId, msg.createdAt);
    this._emit();
    return msg;
  }

  photoSrc(msg) {
    if (!msg || !msg.photo) return null;
    return msg.photo.url || ('/api/photos/' + msg.photo.id);
  }
  // Send a photo. `pic` = { mime, b64, w, h }. Remote uploads to /api/photos
  // (out of /api/state) then posts a message referencing it; demo embeds a data-URL.
  async sendPhoto(channelId, pic, linkedTo) {
    const ch = this.channel(channelId);
    if (!ch || !pic || !pic.b64) return null;
    if (!this.canPost(channelId)) { this._notify('You don’t have access to that channel.', 'warn'); return null; }
    if (this.mode === 'remote') {
      this._setSyncing(true);
      try {
        const up = await api('POST', '/photos', { mime: pic.mime, data: pic.b64, w: pic.w, h: pic.h });
        const { data, etag } = await api('POST', '/messages', { channelId, photo: { id: up.data.id }, linkedTo: linkedTo || null });
        this.rev = revOf(etag) ?? this.rev;
        this.state.messages.push(data);
        this.state.reads = setRead(this.state.reads, this._uid(), channelId, data.createdAt);
        this._emit();
        return data;
      } catch (e) { this._writeFailed(e); return null; }
      finally { this._setSyncing(false); }
    }
    const msg = makeMessage(this.state.messages, {
      channelId, authorId: this._uid(), authorName: this.user, linkedTo: linkedTo || null,
      photo: { url: `data:${pic.mime};base64,${pic.b64}`, w: pic.w, h: pic.h },
    });
    this.state.messages.push(msg);
    this.state.messages = capChannel(this.state.messages, channelId);
    this.state.reads = setRead(this.state.reads, this._uid(), channelId, msg.createdAt);
    this._emit();
    return msg;
  }

  markRead(channelId) {
    if (this.unread(channelId) === 0) return;     // nothing new → no write/emit (avoids render loops)
    const at = new Date().toISOString();
    const before = this.lastReadAt(channelId);
    this.state.reads = setRead(this.state.reads, this._uid(), channelId, at);
    this._emit();
    if (this.mode === 'remote' && before !== at) {
      api('POST', '/channels/' + channelId + '/read', { at })
        .then(({ etag }) => { this.rev = revOf(etag) ?? this.rev; })
        .catch(() => { /* read receipts are best-effort */ });
    }
  }

  // ---- deliveries (what the dispatcher watches) ----
  get deliveries() { return this.state.deliveries || []; }
  deliveriesFor(projectId) { return deliveriesFor(this.deliveries, projectId); }
  deliverySummary(projectId) { return deliverySummary(this.deliveries, projectId); }

  async createDelivery(partial) {
    if (!this.canEditProject(partial.projectId)) { this._notify('You don’t have access to that project.', 'warn'); return null; }
    if (!Array.isArray(this.state.deliveries)) this.state.deliveries = [];
    if (this.mode === 'remote') {
      this._setSyncing(true);
      try { const { data, etag } = await api('POST', '/deliveries', partial); this.rev = revOf(etag) ?? this.rev; this.state.deliveries.push(data); this._emit(); return data; }
      catch (e) { this._writeFailed(e); return null; } finally { this._setSyncing(false); }
    }
    const d = makeDelivery(this.state.deliveries, { ...partial, createdBy: this.user, createdAt: new Date().toISOString() });
    this.state.deliveries.push(d); this._emit(); return d;
  }
  updateDelivery(id, patch) {
    const d = this.deliveries.find((x) => x.id === id);
    if (!d || !this._guardProject(d.projectId)) return;
    Object.assign(d, patch, { updatedBy: this.user, updatedAt: new Date().toISOString() });
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('PATCH', '/deliveries/' + id, patch).then(({ data, etag }) => { if (data && data.rev != null) d.rev = data.rev; this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); }).catch((e) => this._writeFailed(e));
    }
  }
  deleteDelivery(id) {
    const d = this.deliveries.find((x) => x.id === id);
    if (d && !this._guardProject(d.projectId)) return;
    this.state.deliveries = this.deliveries.filter((x) => x.id !== id);
    this._emit();
    if (this.mode === 'remote') {
      this._setSyncing(true);
      api('DELETE', '/deliveries/' + id).then(({ etag }) => { this.rev = revOf(etag) ?? this.rev; this._setSyncing(false); }).catch((e) => this._writeFailed(e));
    }
  }
  // Trigger a proactive dispatcher scan (admin/PM); returns #posted.
  scanDispatcher() { return api('POST', '/dispatcher/scan').then((r) => (r.data && r.data.posted) || 0).catch(() => 0); }

  // ---- field issues (lightweight, promotable to punch/RFI) ----
  get issues() { return this.state.issues || []; }
  issuesForTask(taskId) { return issuesForTask(this.issues, taskId); }
  issueSummary(projectId) { return issueSummary(this.issues, projectId); }

  async createIssue(partial) {
    if (!this.canEditProject(partial.projectId)) { this._notify('You don’t have access to that project.', 'warn'); return null; }
    if (!Array.isArray(this.state.issues)) this.state.issues = [];
    if (this.mode === 'remote') {
      this._setSyncing(true);
      try { const { data, etag } = await api('POST', '/issues', partial); this.rev = revOf(etag) ?? this.rev; this.state.issues.push(data); this._emit(); return data; }
      catch (e) { this._writeFailed(e); return null; } finally { this._setSyncing(false); }
    }
    const iss = makeIssue(this.state.issues, { ...partial, createdBy: this.user, createdAt: new Date().toISOString() });
    this.state.issues.push(iss); this._emit(); return iss;
  }
  updateIssue(id, patch) {
    const iss = this.issues.find((x) => x.id === id);
    if (!iss || !this._guardProject(iss.projectId)) return;
    Object.assign(iss, patch);
    this._emit();
    if (this.mode === 'remote') api('PATCH', '/issues/' + id, patch).then(({ data, etag }) => { if (data) Object.assign(iss, data); this.rev = revOf(etag) ?? this.rev; }).catch((e) => this._writeFailed(e));
  }
  async promoteIssue(id, to) {
    const iss = this.issues.find((x) => x.id === id);
    if (!iss || !this._guardProject(iss.projectId)) return null;
    if (this.mode === 'remote') {
      this._setSyncing(true);
      try {
        const { data, etag } = await api('POST', '/issues/' + id + '/promote', { to });
        this.rev = revOf(etag) ?? this.rev;
        if (data && data.issue) Object.assign(iss, data.issue);
        if (data && data.item && data.created) {                    // splice the new punch/RFI in directly
          const arr = data.created.kind === 'punch' ? (this.state.punch = this.state.punch || []) : (this.state.docs = this.state.docs || []);
          if (!arr.some((x) => x.id === data.item.id)) arr.push(data.item);
        }
        this._emit();
        return data;
      }
      catch (e) { this._writeFailed(e); return null; } finally { this._setSyncing(false); }
    }
    iss.promotedTo = { kind: to, id: 'local' }; iss.status = 'resolved'; this._emit();
    return { issue: iss, created: { kind: to } };
  }
  deleteIssue(id) {
    const iss = this.issues.find((x) => x.id === id);
    if (iss && !this._guardProject(iss.projectId)) return;
    this.state.issues = this.issues.filter((x) => x.id !== id);
    this._emit();
    if (this.mode === 'remote') api('DELETE', '/issues/' + id).then(({ etag }) => { this.rev = revOf(etag) ?? this.rev; }).catch((e) => this._writeFailed(e));
  }

  deleteTask(id) {
    const target = this.task(id);
    if (target && !this._guardProject(target.projectId)) return;
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

  // Client-side permission gates (defence in depth; the server also enforces).
  _guardWrite() {
    if (this.can('write')) return true;
    this._notify('You have read-only access — that change was blocked.', 'warn');
    return false;
  }
  _guardProject(projectId) {
    if (this.canEditProject(projectId)) return true;
    const p = this.project(projectId);
    this._notify(`You don’t have access to ${p ? p.name : 'that project'} — change blocked.`, 'warn');
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

// CPM lives in its own pure module (shared with leveling.js); re-export so
// existing consumers can keep importing it from data.js.
export { computeCriticalPath } from './cpm.js';
