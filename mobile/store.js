// ============================================================================
//  store.js — Corefield mobile store (browser).
//  Talks to the same BuildFlow REST API as the desktop app, but tuned for the
//  field: it caches the last schedule to LocalStorage for instant/offline boot
//  and routes failed writes through an OFFLINE OUTBOX that replays in order when
//  connectivity returns. Pure rules live in ../src/mobile/core.js.
// ============================================================================

import { TRADES, STATUSES, Dates, normalizeState, seedState, makeTask, applyTaskPatch } from '../src/js/seed.js';
import { makePunchItem } from '../src/js/punch.js';
import { makeReport } from '../src/js/fieldreports.js';
import {
  makeMessage, capChannel, setRead, lastRead, unreadCount,
  messagesForChannel, lastMessage, channelIdForProject, messagesForTask,
} from '../src/js/messaging.js';
import { CallManager } from '../src/js/webrtc.js';
import {
  bucketTasks, workSummary, applyPendingTasks, coerceStatus,
  outboxAdd, outboxRemove, outboxSummary,
} from '../src/mobile/core.js';

export { TRADES, STATUSES, Dates, bucketTasks, workSummary };

const API = '/api';
const TIMEOUT = 6000;
const POLL_MS = 8000;
const LS_STATE = 'corefield.state.v1';
const LS_OUTBOX = 'corefield.outbox.v1';
const LS_PROJECT = 'corefield.project.v1';

// --- fetch helper: resolves { status, data, etag }; rejects Error w/ .status --
// A network failure (offline) is tagged err.offline so writes know to queue.
async function api(method, path, body, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(API + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
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
    return { status: res.status, data: res.status === 204 ? null : await res.json(), etag };
  } catch (e) {
    if (e && e.status) throw e;          // HTTP error → rethrow as-is
    const off = new Error('offline');    // abort / network failure
    off.offline = true;
    throw off;
  } finally {
    clearTimeout(timer);
  }
}

const revOf = (etag) => {
  const n = parseInt(String(etag || '').replace(/"/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};
const lsGet = (k, fallback) => {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
};
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } };

let qseq = 0;
const newQid = () => 'q' + Date.now().toString(36) + (qseq++).toString(36);

class MobileStore {
  constructor() {
    this.listeners = new Set();
    this.noticeListeners = new Set();
    this.authListeners = new Set();

    this.authState = 'unknown';        // unknown | required | authed
    this.user = null; this.role = null; this.scope = [];
    this.local = false;                // true when there's no /api backend (static host) → demo mode
    this.online = true;
    this.rev = null;
    this._poll = null;

    this.state = normalizeState(lsGet(LS_STATE, null) || { tasks: [] });
    this.outbox = lsGet(LS_OUTBOX, []);
    this.projectId = lsGet(LS_PROJECT, 'all');
    this.onlineUsers = [];             // [{username,name}] SSE presence
    this.typing = {};                  // { channelId: { name: expiryMs } }
    this._es = null;                   // EventSource (live stream)
    this.callListeners = new Set();
    this.calls = new CallManager((to, msg) => this._sendSignal(to, msg), (snap) => this.callListeners.forEach((fn) => fn(snap)));

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this._setOnline(true));
      window.addEventListener('offline', () => this._setOnline(false));
    }
    this._boot();
  }

  // ---- pub/sub ----
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onNotice(fn) { this.noticeListeners.add(fn); return () => this.noticeListeners.delete(fn); }
  onAuth(fn) { this.authListeners.add(fn); return () => this.authListeners.delete(fn); }
  _emit() { lsSet(LS_STATE, this.state); this.listeners.forEach((fn) => fn()); }
  _emitAuth() { this.authListeners.forEach((fn) => fn(this.authState)); }
  notify(msg, tone = 'info') { this.noticeListeners.forEach((fn) => fn(msg, tone)); }

  // ---- boot / auth ----
  async _boot() {
    try {
      const { data } = await api('GET', '/auth/me');
      this._applyUser(data.user);
      this.authState = 'authed';
      this._emitAuth();
      await this._hydrate();
      this._flush();
      this._startPolling();
      this._startStream();
    } catch (err) {
      if (err && err.status === 401) { this.authState = 'required'; this._emitAuth(); }
      else if (err && err.offline && this.user) { this._setOnline(false); this.authState = 'authed'; this._emitAuth(); }
      else { this._enterLocal(); }              // no /api backend (e.g. GitHub Pages) → demo mode
    }
  }

  // Static-host demo mode: no server, no login. Runs on seeded data with full
  // local rights and LocalStorage-only persistence (mirrors the desktop app's
  // offline fallback), so Corefield works on any plain static host.
  _enterLocal() {
    this.local = true;
    this.user = this.user || 'Field Demo';
    this.role = 'admin'; this.scope = [];
    if (!this.state || !Array.isArray(this.state.tasks) || !this.state.tasks.length) {
      this.state = normalizeState(seedState());
    }
    this.authState = 'authed';
    this._emitAuth();
    this._emit();
  }

  resetLocalDemo() {
    if (!this.local) return;
    this.state = normalizeState(seedState());
    this.outbox = [];
    this._emit();
    this.notify('Demo data reset.', 'info');
  }

  _applyUser(u) {
    if (!u) return;
    this.user = u.name || u.username;
    this.username = u.username || u.name;
    this.role = u.role;
    this.scope = Array.isArray(u.projects) ? u.projects : [];
  }
  _uid() { return this.username || this.user || 'me'; }

  async login(username, password) {
    try {
      const { data } = await api('POST', '/auth/login', { username, password });
      this._applyUser(data.user);
      this.authState = 'authed';
      this._setOnline(true);
      this._emitAuth();
      await this._hydrate();
      this._flush();
      this._startPolling();
      this._startStream();
      return { ok: true };
    } catch (err) {
      if (err && err.offline) return { ok: false, error: 'No connection — check signal and retry.' };
      return { ok: false, error: (err && err.data && err.data.error) || 'Sign in failed' };
    }
  }

  async logout() {
    if (this.local) { this.resetLocalDemo(); return; }   // no session to drop in demo mode
    try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
    this._stopStream();
    this.user = null; this.role = null; this.authState = 'required';
    this._emitAuth();
  }

  // ---- capability mirrors (server is the real boundary) ----
  can(action) {
    if (this.local) return true;
    if (this.authState !== 'authed') return false;
    const rank = { viewer: 0, pm: 1, admin: 2 }[this.role] ?? -1;
    if (action === 'read') return rank >= 0;
    if (action === 'write') return rank >= 1;
    return rank >= 2;
  }
  isUnrestricted() { return this.local || this.role === 'admin' || (this.can('write') && this.scope.length === 0); }
  canEditProject(pid) {
    if (this.local) return true;
    if (!this.can('write')) return false;
    return this.isUnrestricted() || this.scope.includes(pid);
  }
  editableProjects() {
    return this.isUnrestricted() ? this.projects : this.projects.filter((p) => this.scope.includes(p.id));
  }

  _setOnline(v) {
    if (this.local) return;            // demo mode ignores connectivity
    const was = this.online;
    this.online = v;
    if (v && !was) { this.notify('Back online — syncing…', 'info'); this._flush(); this._refresh(); }
    if (!v && was) this.notify('Offline — changes will sync when you reconnect.', 'warn');
    this._emit();
  }

  // ---- state hydrate + polling ----
  async _hydrate() {
    const { data, etag } = await api('GET', '/state');
    if (data && data.tasks) {
      this.state = normalizeState(data);
      this.rev = revOf(etag) ?? data.rev ?? this.rev;
      this.online = true;
      this._emit();
    }
  }
  async _refresh() {
    if (this.local) return;
    try { await this._hydrate(); } catch { /* stay on cache */ }
  }
  _startPolling() {
    if (this._poll || typeof setInterval !== 'function') return;
    this._poll = setInterval(async () => {
      if (this.authState !== 'authed') return;
      try {
        const { status, data, etag } = await api('GET', '/state', null,
          this.rev != null ? { 'If-None-Match': '"' + this.rev + '"' } : {});
        this._setOnline(true);
        if (status === 304) return;
        const newRev = revOf(etag) ?? (data && data.rev);
        if (data && data.tasks && newRev !== this.rev) {
          this.state = normalizeState(data);
          this.rev = newRev;
          this._emit();
        }
      } catch (err) {
        if (err && err.status === 401) { this._sessionLost(); return; }
        this._setOnline(false);
      }
    }, POLL_MS);
  }
  _sessionLost() {
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
    this._stopStream();
    this.role = null; this.authState = 'required';
    this._emitAuth();
  }

  // --- Live stream (SSE): instant updates + presence + typing ---------------
  _startStream() {
    if (this._es || this.local || typeof EventSource === 'undefined') return;
    try { this._es = new EventSource(API + '/stream'); } catch { return; }
    this._es.addEventListener('sync', (e) => { try { if (JSON.parse(e.data).rev !== this.rev) this._pull(); } catch { /* ignore */ } });
    this._es.addEventListener('presence', (e) => { try { this.onlineUsers = JSON.parse(e.data).online || []; this.listeners.forEach((fn) => fn()); } catch { /* ignore */ } });
    this._es.addEventListener('typing', (e) => { try { const d = JSON.parse(e.data); if (d.user !== this.username) this._setTyping(d.channelId, d.name); } catch { /* ignore */ } });
    this._es.addEventListener('call', (e) => { try { this.calls.handleSignal(JSON.parse(e.data)); } catch { /* ignore */ } });
    this._es.onerror = () => { /* auto-reconnects; polling covers gaps */ };
  }
  _stopStream() { if (this._es) { try { this._es.close(); } catch { /* ignore */ } this._es = null; } this.onlineUsers = []; }

  // ---- calls (1:1 audio/video) ----
  _sendSignal(to, msg) { api('POST', '/signal', { to, ...msg }).catch(() => {}); }
  onCall(fn) { this.callListeners.add(fn); return () => this.callListeners.delete(fn); }
  callPeer(peer, video) { return this.calls.call(peer, video); }
  peopleOnline() { return this.onlineUsers.filter((u) => u.username && u.username !== this.username); }
  onlineCount() { return this.onlineUsers.length; }
  _pull() {
    if (this._pulling || this.local) return;
    this._pulling = true;
    api('GET', '/state', null, this.rev != null ? { 'If-None-Match': '"' + this.rev + '"' } : {})
      .then(({ status, data, etag }) => {
        if (status === 304) return;
        const nr = revOf(etag) ?? (data && data.rev);
        if (data && data.tasks && nr !== this.rev) { this.state = normalizeState(data); this.rev = nr; this._emit(); }
      })
      .catch((e) => { if (e && e.status === 401) this._sessionLost(); })
      .finally(() => { this._pulling = false; });
  }
  _setTyping(channelId, name) {
    this.typing[channelId] = this.typing[channelId] || {};
    this.typing[channelId][name] = Date.now() + 4000;
    this.listeners.forEach((fn) => fn());
    clearTimeout(this._typingT);
    this._typingT = setTimeout(() => this._pruneTyping(), 4200);
  }
  _pruneTyping() {
    const now = Date.now(); let changed = false;
    for (const c of Object.keys(this.typing)) for (const n of Object.keys(this.typing[c])) if (this.typing[c][n] <= now) { delete this.typing[c][n]; changed = true; }
    if (changed) this.listeners.forEach((fn) => fn());
  }
  typingIn(channelId) {
    const m = this.typing[channelId]; if (!m) return [];
    const now = Date.now();
    return Object.keys(m).filter((n) => m[n] > now && n !== this.user);
  }
  postTyping(channelId) {
    const now = Date.now();
    if ((this._lastTyping && now - this._lastTyping < 2000) || this.local) return;
    this._lastTyping = now;
    api('POST', '/channels/' + channelId + '/typing').catch(() => {});
  }

  // ---- selectors (read from the live, pending-merged state) ----
  get projects() { return this.state.projects || []; }
  get crews() { return this.state.crews || []; }
  project(id) { return this.projects.find((p) => p.id === id) || null; }
  crew(id) { return this.crews.find((c) => c.id === id) || null; }
  setProject(pid) { this.projectId = pid; lsSet(LS_PROJECT, pid); this._emit(); }

  // Tasks for the active project, with any queued offline edits projected on top.
  tasks(projectId = this.projectId) {
    let list = this.state.tasks || [];
    if (projectId && projectId !== 'all') list = list.filter((t) => t.projectId === projectId);
    return applyPendingTasks(list, this.outbox);
  }
  task(id) { return this.tasks('all').find((t) => t.id === id) || null; }
  punch(projectId = this.projectId) {
    const list = this.state.punch || [];
    return projectId && projectId !== 'all' ? list.filter((p) => p.projectId === projectId) : list;
  }
  reports(projectId = this.projectId) {
    const list = (this.state.reports || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    return projectId && projectId !== 'all' ? list.filter((r) => r.projectId === projectId) : list;
  }

  summary(projectId = this.projectId) { return workSummary(this.tasks(projectId)); }
  pendingCount() { return outboxSummary(this.outbox).pending; }

  // ---- messaging ----
  get channels() { return (this.state.channels || []).filter((c) => !c.archived); }
  get messages() { return this.state.messages || []; }
  channel(id) { return this.channels.find((c) => c.id === id) || null; }
  channelFor(projectId) { return this.channels.find((c) => c.id === channelIdForProject(projectId)) || null; }
  messagesFor(channelId) { return messagesForChannel(this.messages, channelId); }
  lastMessageFor(channelId) { return lastMessage(this.messages, channelId); }
  lastReadAt(channelId) { return lastRead(this.state.reads, this._uid(), channelId); }
  unread(channelId) { return unreadCount(this.messages, channelId, this.lastReadAt(channelId), this._uid()); }
  totalUnread() { return this.channels.reduce((a, c) => a + this.unread(c.id), 0); }
  canPost(channelId) {
    const ch = this.channel(channelId);
    if (!ch) return false;
    return ch.type === 'project' ? this.canEditProject(ch.projectId) : this.can('write');
  }

  sendMessage(channelId, body, linkedTo) {
    const ch = this.channel(channelId);
    if (!ch || !String(body || '').trim()) return;
    if (!this.canPost(channelId)) { this.notify('You don’t have access to that channel.', 'warn'); return; }
    this._queueWrite({ kind: 'message.send', channelId, method: 'POST', path: '/messages', body: { channelId, body: String(body).trim(), linkedTo: linkedTo || null } });
    this.markRead(channelId);
  }

  // ---- task Activity (a task's slice of its project channel) ----
  messagesForTask(taskId) { return messagesForTask(this.messages, taskId); }
  taskActivityCount(taskId) { return messagesForTask(this.messages, taskId).length; }
  canPostTask(taskId) { const t = this.task(taskId); return !!t && this.canEditProject(t.projectId); }
  postTaskMessage(taskId, body) {
    const t = this.task(taskId); if (!t) return;
    const ch = this.channelFor(t.projectId); if (!ch) return;
    this.sendMessage(ch.id, body, { kind: 'task', id: taskId });
  }
  postTaskVoice(taskId, clip) {
    const t = this.task(taskId); if (!t) return;
    const ch = this.channelFor(t.projectId); if (!ch) return;
    this.sendVoice(ch.id, clip, { kind: 'task', id: taskId });
  }

  voiceSrc(msg) {
    if (!msg || !msg.voice) return null;
    return msg.voice.url || ('/api/voice/' + msg.voice.id);
  }

  // Send a voice note (queued through the outbox so it survives no signal).
  // clip = { mime, b64, dur }.
  sendVoice(channelId, clip, linkedTo) {
    const ch = this.channel(channelId);
    if (!ch || !clip || !clip.b64) return;
    if (!this.canPost(channelId)) { this.notify('You don’t have access to that channel.', 'warn'); return; }
    this._queueWrite({ kind: 'voice.send', channelId, linkedTo: linkedTo || null, method: 'POST', path: '/messages', body: { channelId, mime: clip.mime, b64: clip.b64, dur: clip.dur } });
    this.markRead(channelId);
  }

  markRead(channelId) {
    if (this.unread(channelId) === 0) return;     // nothing new → no write/emit (avoids render loops)
    const at = new Date().toISOString();
    this.state.reads = setRead(this.state.reads, this._uid(), channelId, at);
    if (!this.local && this.authState === 'authed') {
      api('POST', '/channels/' + channelId + '/read', { at }).then(({ etag }) => { this.rev = revOf(etag) ?? this.rev; }).catch(() => {});
    }
    this._emit();
  }

  // ---- writes (optimistic; queue + replay when offline) ----
  // Each write applies locally first, then tries the API. A network failure
  // pushes the op to the outbox; an auth/permission error is surfaced honestly.
  updateTaskProgress(id, progress) {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) return;
    if (!this.canEditProject(t.projectId)) { this.notify('You don’t have access to that project.', 'warn'); return; }
    const body = { progress, status: coerceStatus(progress, t.status) };
    this._queueWrite({ kind: 'task.patch', targetId: id, method: 'PATCH', path: '/tasks/' + id, body, rev: t.rev });
  }
  updateTaskStatus(id, status) {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) return;
    if (!this.canEditProject(t.projectId)) { this.notify('You don’t have access to that project.', 'warn'); return; }
    const body = { status };
    if (status === 'done') body.progress = 100;
    this._queueWrite({ kind: 'task.patch', targetId: id, method: 'PATCH', path: '/tasks/' + id, body, rev: t.rev });
  }
  updatePunchStatus(id, status) {
    const p = (this.state.punch || []).find((x) => x.id === id);
    if (!p) return;
    if (!this.canEditProject(p.projectId)) { this.notify('You don’t have access to that project.', 'warn'); return; }
    this._queueWrite({ kind: 'punch.patch', targetId: id, method: 'PATCH', path: '/punch/' + id, body: { status } });
  }
  createPunch(partial) {
    if (!this.canEditProject(partial.projectId)) { this.notify('You don’t have access to that project.', 'warn'); return; }
    this._queueWrite({ kind: 'punch.create', method: 'POST', path: '/punch', body: partial });
  }
  createReport(partial) {
    if (!this.canEditProject(partial.projectId)) { this.notify('You don’t have access to that project.', 'warn'); return; }
    this._queueWrite({ kind: 'report.create', method: 'POST', path: '/reports', body: partial });
  }

  // Apply optimistically, then attempt the network call (queue on failure).
  // In demo (local) mode there's no server, so writes are committed locally
  // through the domain factories and persisted to LocalStorage only.
  _queueWrite(op) {
    op.qid = newQid();
    if (this.local) return this._localWrite(op);
    this._applyLocal(op);
    this.outbox = outboxAdd(this.outbox, op);
    lsSet(LS_OUTBOX, this.outbox);
    this._emit();
    this._flush();
  }

  _localWrite(op) {
    if (op.kind === 'task.patch') {
      const t = this.state.tasks.find((x) => x.id === op.targetId);
      if (t) { applyTaskPatch(t, op.body); t.rev = (t.rev || 1) + 1; }
    } else if (op.kind === 'punch.patch') {
      const p = (this.state.punch || []).find((x) => x.id === op.targetId);
      if (p) Object.assign(p, op.body, { updatedAt: new Date().toISOString() });
    } else if (op.kind === 'punch.create') {
      if (!Array.isArray(this.state.punch)) this.state.punch = [];
      this.state.punch.push(makePunchItem(this.state.punch, { ...op.body, createdBy: this.user }));
    } else if (op.kind === 'report.create') {
      if (!Array.isArray(this.state.reports)) this.state.reports = [];
      this.state.reports.push(makeReport(this.state.reports, { ...op.body, createdBy: this.user }));
    } else if (op.kind === 'message.send') {
      if (!Array.isArray(this.state.messages)) this.state.messages = [];
      this.state.messages.push(makeMessage(this.state.messages, { channelId: op.channelId, authorId: this._uid(), authorName: this.user, body: op.body.body, linkedTo: op.body.linkedTo || null }));
      this.state.messages = capChannel(this.state.messages, op.channelId);
    } else if (op.kind === 'voice.send') {
      if (!Array.isArray(this.state.messages)) this.state.messages = [];
      this.state.messages.push(makeMessage(this.state.messages, { channelId: op.channelId, authorId: this._uid(), authorName: this.user, linkedTo: op.linkedTo || null, voice: { url: `data:${op.body.mime};base64,${op.body.b64}`, dur: op.body.dur, mime: op.body.mime } }));
      this.state.messages = capChannel(this.state.messages, op.channelId);
    }
    this._emit();
  }

  // Optimistic local apply so the UI updates instantly (online or not).
  _applyLocal(op) {
    if (op.kind === 'task.patch') {
      const t = this.state.tasks.find((x) => x.id === op.targetId);
      if (t) Object.assign(t, op.body);
    } else if (op.kind === 'punch.patch') {
      const p = (this.state.punch || []).find((x) => x.id === op.targetId);
      if (p) Object.assign(p, op.body);
    } else if (op.kind === 'punch.create') {
      // Provisional record so it shows immediately; replaced on server echo.
      if (!Array.isArray(this.state.punch)) this.state.punch = [];
      this.state.punch.push({ id: op.qid, number: '…', status: 'open', priority: 'normal', attachments: [], _provisional: true, ...op.body });
    } else if (op.kind === 'report.create') {
      if (!Array.isArray(this.state.reports)) this.state.reports = [];
      this.state.reports.push({ id: op.qid, attachments: [], _provisional: true, ...op.body });
    } else if (op.kind === 'message.send') {
      if (!Array.isArray(this.state.messages)) this.state.messages = [];
      this.state.messages.push({ id: op.qid, channelId: op.channelId, authorId: this._uid(), authorName: this.user, body: op.body.body, attachments: [], linkedTo: op.body.linkedTo || null, createdAt: new Date().toISOString(), _provisional: true });
    } else if (op.kind === 'voice.send') {
      if (!Array.isArray(this.state.messages)) this.state.messages = [];
      this.state.messages.push({ id: op.qid, channelId: op.channelId, authorId: this._uid(), authorName: this.user, body: '', attachments: [], linkedTo: op.linkedTo || null, voice: { url: `data:${op.body.mime};base64,${op.body.b64}`, dur: op.body.dur, mime: op.body.mime }, createdAt: new Date().toISOString(), _provisional: true });
    }
  }

  // Replay the outbox in order. Stops on the first network failure (still
  // offline); drops ops that the server rejects (conflict / permission) with a
  // note, so the queue can never wedge.
  async _flush() {
    if (this.local || this._flushing || !this.outbox.length) return;
    if (this.authState !== 'authed') return;
    this._flushing = true;
    try {
      while (this.outbox.length) {
        const op = this.outbox[0];
        try {
          let data, etag;
          if (op.kind === 'voice.send') {
            // Two-step: upload the audio blob, then post the message referencing it.
            const up = await api('POST', '/voice', { mime: op.body.mime, data: op.body.b64, dur: op.body.dur });
            ({ data, etag } = await api('POST', '/messages', { channelId: op.channelId, voice: { id: up.data.id }, linkedTo: op.linkedTo || null }));
          } else {
            const headers = op.rev != null ? { 'If-Match': '"' + op.rev + '"' } : {};
            ({ data, etag } = await api(op.method, op.path, op.body, headers));
          }
          this.rev = revOf(etag) ?? this.rev;
          this._reconcile(op, data);
          this.outbox = outboxRemove(this.outbox, op.qid);
          lsSet(LS_OUTBOX, this.outbox);
        } catch (err) {
          if (err && err.offline) { this._setOnline(false); break; }   // try again later
          if (err && err.status === 401) { this._persistOutbox(); this._sessionLost(); break; }
          // 403/404/409 etc. — the op can't succeed; drop it and tell the user.
          const why = (err && err.data && err.data.error) || ('HTTP ' + (err && err.status));
          this.notify(`A queued change was rejected (${why}).`, 'warn');
          this.outbox = outboxRemove(this.outbox, op.qid);
          lsSet(LS_OUTBOX, this.outbox);
        }
      }
      this._emit();
      if (!this.outbox.length) this._refresh();
    } finally {
      this._flushing = false;
    }
  }
  _persistOutbox() { lsSet(LS_OUTBOX, this.outbox); }

  // Fold a server echo back into local state (rev bumps, real ids for creates).
  _reconcile(op, data) {
    if (!data) return;
    if (op.kind === 'task.patch') {
      const t = this.state.tasks.find((x) => x.id === op.targetId);
      if (t && data.rev != null) { t.rev = data.rev; Object.assign(t, data); }
    } else if (op.kind === 'punch.patch') {
      const p = (this.state.punch || []).find((x) => x.id === op.targetId);
      if (p) Object.assign(p, data);
    } else if (op.kind === 'punch.create') {
      const i = (this.state.punch || []).findIndex((x) => x.id === op.qid);
      if (i >= 0) this.state.punch[i] = data; else this.state.punch.push(data);
    } else if (op.kind === 'report.create') {
      const i = (this.state.reports || []).findIndex((x) => x.id === op.qid);
      if (i >= 0) this.state.reports[i] = data; else this.state.reports.push(data);
    } else if (op.kind === 'message.send' || op.kind === 'voice.send') {
      const i = (this.state.messages || []).findIndex((x) => x.id === op.qid);
      if (i >= 0) this.state.messages[i] = data; else this.state.messages.push(data);
    }
  }
}

export const store = new MobileStore();
