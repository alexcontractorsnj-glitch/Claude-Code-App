#!/usr/bin/env node
// ============================================================================
//  server.mjs — Zero-dependency static host + REST API for BuildFlow.
//  Persists schedule state to ./data/schedule.json. Shares the domain core
//  (seed, makeTask, applyTaskPatch) with the browser via src/js/seed.js.
//
//  Usage:  node server.mjs [port]      →  http://localhost:8000
//  REST:
//    GET    /api/state            → { projects, crews, tasks, version }
//    POST   /api/tasks            → create  (body: task or partial) → task
//    PATCH  /api/tasks/:id        → update  (body: patch)           → task
//    DELETE /api/tasks/:id        → delete                          → 204
//    POST   /api/reset            → reseed                          → state
// ============================================================================
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedState, makeTask, applyTaskPatch, normalizeState, nextBaselineId } from './src/js/seed.js';
import { buildApplication, appsForProject } from './src/js/billing.js';
import { makeDoc, DOC_KINDS } from './src/js/docs.js';
import { makeChangeOrder, CO_STATUSES } from './src/js/changeorders.js';
import { makeReport } from './src/js/fieldreports.js';
import { makePunchItem, PUNCH_STATUSES, PUNCH_PRIORITIES, cleanAttachments } from './src/js/punch.js';
import {
  seedUsers, verifyPassword, hashPassword, can, isRole, publicUser,
  canEditProject, isUnrestricted,
  createSession, getSession, destroySession, destroyUserSessions,
  isLockedOut, recordFailure, clearFailures,
  parseCookies, sessionCookie, clearCookie, COOKIE,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.argv[2] || process.env.PORT || 8000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'schedule.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
const AUDIT_CAP = 500;                          // keep the most recent N entries

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// --- Persistence ------------------------------------------------------------
let state;
let users;                                    // [{ username, name, role, projects, passwordHash }]
let audit = [];                               // append-only activity log (capped)
let writeChain = Promise.resolve();           // serialize writes

async function loadState() {
  if (existsSync(DATA_FILE)) {
    try { return normalizeState(JSON.parse(await readFile(DATA_FILE, 'utf8'))); }
    catch { /* corrupt → reseed below */ }
  }
  const fresh = seedState();
  await persist(DATA_FILE, fresh);
  return fresh;
}

async function loadUsers() {
  if (existsSync(AUTH_FILE)) {
    try {
      const u = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
      if (Array.isArray(u) && u.length) {
        u.forEach((x) => { if (!Array.isArray(x.projects)) x.projects = []; });  // backfill
        return u;
      }
    } catch { /* corrupt → reseed */ }
  }
  const fresh = await seedUsers();
  await persist(AUTH_FILE, fresh);
  return fresh;
}

async function loadAudit() {
  if (existsSync(AUDIT_FILE)) {
    try {
      const a = JSON.parse(await readFile(AUDIT_FILE, 'utf8'));
      if (Array.isArray(a)) return a;
    } catch { /* corrupt → start fresh */ }
  }
  return [];
}

// Append an immutable activity entry, attributed to the acting session user.
let auditSeq = 0;
function logAudit(actor, action, entry = {}) {
  audit.push({
    id: 'a' + Date.now().toString(36) + (auditSeq++).toString(36),
    ts: new Date().toISOString(),
    user: (actor && actor.name) || 'system',
    role: (actor && actor.role) || null,
    action,                                   // e.g. task.update, baseline.save, user.create
    ...entry,                                 // { targetId, targetName, detail }
  });
  if (audit.length > AUDIT_CAP) audit = audit.slice(-AUDIT_CAP);
  persist(AUDIT_FILE, audit);
}

// Global revision: bumped on every write so clients can detect others' edits
// (sent as an ETag) and we can serve cheap 304s when nothing changed.
function bump() { state.rev = (state.rev || 0) + 1; return state.rev; }
const etag = () => '"' + (state.rev || 0) + '"';

// Edit attribution comes from the authenticated session — it can't be spoofed
// by a header. `actor` is the session user resolved by the auth gate.
function stamp(task, actor) {
  task.lastEditedBy = (actor && actor.name) || task.lastEditedBy || 'Unknown';
  task.lastEditedAt = new Date().toISOString();
}

function persist(file, next) {
  // Chain writes so concurrent requests can't interleave file output.
  writeChain = writeChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(next, null, 2));
  }).catch((e) => console.error('persist failed', e));
  return writeChain;
}
const persistState = () => persist(DATA_FILE, state);
const persistUsers = () => persist(AUTH_FILE, users);

// --- HTTP helpers -----------------------------------------------------------
function send(res, code, payload, headers = {}) {
  const body = payload == null ? '' : JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Resolve the authenticated user for a request from its session cookie.
function actorOf(req) {
  const token = parseCookies(req)[COOKIE];
  return getSession(token);
}

// --- Auth routes (no session required for login) ---------------------------
async function handleAuth(req, res, action) {
  if (action === 'login' && req.method === 'POST') {
    const { username = '', password = '' } = await readBody(req).catch(() => ({}));
    if (isLockedOut(username)) {
      return send(res, 429, { error: 'Too many attempts. Try again in a minute.' });
    }
    const user = users.find((u) => u.username === username);
    const okPw = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !okPw) {
      recordFailure(username);                 // generic message — don't reveal which part failed
      return send(res, 401, { error: 'Invalid username or password' });
    }
    clearFailures(username);
    const token = createSession(user);
    return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token) });
  }
  if (action === 'logout' && req.method === 'POST') {
    destroySession(parseCookies(req)[COOKIE]);
    return send(res, 204, null, { 'Set-Cookie': clearCookie() });
  }
  if (action === 'me' && req.method === 'GET') {
    const a = actorOf(req);
    return a ? send(res, 200, { user: publicUser(a) }) : send(res, 401, { error: 'not signed in' });
  }
  return send(res, 404, { error: 'unknown auth endpoint' });
}

// --- Admin: user management ------------------------------------------------
const cleanProjects = (p) => (Array.isArray(p) ? p.filter((x) => typeof x === 'string') : []);

async function handleUsers(req, res, target, actor) {
  const method = req.method;
  if (method === 'GET' && !target) return send(res, 200, users.map(publicUser));
  if (method === 'POST' && !target) {
    const { username, password, name, role, projects } = await readBody(req);
    if (!username || !password || !isRole(role)) return send(res, 400, { error: 'username, password and a valid role are required' });
    if (users.some((u) => u.username === username)) return send(res, 409, { error: 'username already exists' });
    const user = { username, name: name || username, role, projects: cleanProjects(projects), passwordHash: await hashPassword(password) };
    users.push(user);
    await persistUsers();
    logAudit(actor, 'user.create', { targetId: username, targetName: user.name, detail: `role ${role}` });
    return send(res, 201, publicUser(user));
  }
  if (method === 'PATCH' && target) {          // change role and/or project scope
    const u = users.find((x) => x.username === target);
    if (!u) return send(res, 404, { error: 'user not found' });
    const body = await readBody(req);
    if (body.role !== undefined) {
      if (!isRole(body.role)) return send(res, 400, { error: 'valid role required' });
      u.role = body.role;
    }
    if (body.projects !== undefined) u.projects = cleanProjects(body.projects);
    destroyUserSessions(u.username);           // force re-login so the change takes effect
    await persistUsers();
    logAudit(actor, 'user.update', { targetId: u.username, targetName: u.name, detail: `role ${u.role}, ${u.projects.length || 'all'} projects` });
    return send(res, 200, publicUser(u));
  }
  if (method === 'DELETE' && target) {
    if (users.filter((u) => u.role === 'admin').length === 1 && users.find((u) => u.username === target)?.role === 'admin') {
      return send(res, 400, { error: 'cannot delete the last admin' });
    }
    users = users.filter((u) => u.username !== target);
    destroyUserSessions(target);
    await persistUsers();
    logAudit(actor, 'user.delete', { targetId: target });
    res.writeHead(204); return res.end();
  }
  return send(res, 404, { error: 'unknown users endpoint' });
}

// --- REST API ---------------------------------------------------------------
async function handleApi(req, res, urlPath) {
  const parts = urlPath.split('/').filter(Boolean);   // ['api', 'tasks', ':id?', ':sub?']
  const resource = parts[1];
  const id = parts[2];
  const sub = parts[3];
  const method = req.method;

  try {
    // Auth endpoints are reachable without a session.
    if (resource === 'auth') return await handleAuth(req, res, id);

    // Everything else requires a valid session.
    const actor = actorOf(req);
    if (!actor) return send(res, 401, { error: 'authentication required' });

    // Authorization: reads need a session; writes need pm+; admin ops need admin.
    const isWrite = method !== 'GET' && method !== 'HEAD';
    const adminOnly = resource === 'reset' || resource === 'users';
    if (adminOnly && !can(actor.role, 'admin')) return send(res, 403, { error: 'admin privilege required' });
    if (isWrite && !adminOnly && !can(actor.role, 'write')) {
      return send(res, 403, { error: 'write privilege required (read-only role)' });
    }
    // Baseline is schedule-wide → only an unrestricted writer (admin / global pm).
    if (resource === 'baseline' && isWrite && !isUnrestricted(actor)) {
      return send(res, 403, { error: 'baseline requires unrestricted (all-project) access' });
    }
    // Activity log is visible to writers and admins.
    if (resource === 'audit' && !can(actor.role, 'write')) {
      return send(res, 403, { error: 'write privilege required' });
    }

    if (resource === 'users') {
      const r = await handleUsers(req, res, id, actor);
      return r;
    }

    if (resource === 'audit' && method === 'GET') {
      const q = new URLSearchParams((req.url.split('?')[1] || ''));
      const n = q.get('all') ? AUDIT_CAP : 200;             // ?all=1 → full log for export
      return send(res, 200, audit.slice(-n).reverse());     // most-recent first
    }

    if (resource === 'state' && method === 'GET') {
      const inm = req.headers['if-none-match'];
      if (inm && inm.replace(/"/g, '') === String(state.rev || 0)) {
        res.writeHead(304, { ETag: etag() }); return res.end();
      }
      return send(res, 200, state, { ETag: etag() });
    }

    if (resource === 'reset' && method === 'POST') {
      const rev = (state.rev || 0) + 1;        // keep advancing so caches invalidate
      state = seedState();
      state.rev = rev;
      await persistState();
      logAudit(actor, 'schedule.reset', { detail: 'reseeded to sample data' });
      return send(res, 200, state, { ETag: etag() });
    }

    if (resource === 'baseline') {
      if (!Array.isArray(state.baselines)) state.baselines = state.baseline ? [state.baseline] : [];

      if (method === 'POST' && !id) {          // capture a new baseline → make it active
        const body = await readBody(req).catch(() => ({}));
        const snap = {
          id: nextBaselineId(state.baselines),
          label: (body.label || '').trim() || ('Baseline ' + (state.baselines.length + 1)),
          savedAt: new Date().toISOString().slice(0, 10), savedBy: actor.name,
          tasks: Object.fromEntries(state.tasks.map((t) => [t.id, { start: t.start, end: t.end, cost: t.cost || 0 }])),
        };
        state.baselines.push(snap);
        state.baseline = snap;
        bump();
        await persistState();
        logAudit(actor, 'baseline.save', { targetName: snap.label, detail: `${state.tasks.length} tasks captured` });
        return send(res, 200, snap, { ETag: etag() });
      }
      if (method === 'POST' && id && sub === 'activate') {   // switch the comparison baseline
        if (id === 'none') { state.baseline = null; }
        else {
          const b = state.baselines.find((x) => x.id === id);
          if (!b) return send(res, 404, { error: 'baseline not found' });
          state.baseline = b;
        }
        bump();
        await persistState();
        logAudit(actor, 'baseline.activate', { targetId: id, detail: state.baseline ? state.baseline.label : 'none' });
        return send(res, 200, state.baseline, { ETag: etag() });
      }
      if (method === 'DELETE' && id) {         // remove a baseline from history
        const removed = state.baselines.find((x) => x.id === id);
        state.baselines = state.baselines.filter((x) => x.id !== id);
        if (state.baseline && state.baseline.id === id) {
          state.baseline = state.baselines[state.baselines.length - 1] || null;
        }
        bump();
        await persistState();
        logAudit(actor, 'baseline.delete', { targetName: removed ? removed.label : id });
        res.writeHead(204, { ETag: etag() }); return res.end();
      }
    }

    if (resource === 'billing') {
      if (!Array.isArray(state.payApps)) state.payApps = [];
      if (method === 'POST' && !id) {                 // generate a payment application
        const body = await readBody(req);
        const project = state.projects.find((p) => p.id === body.projectId);
        if (!project) return send(res, 400, { error: 'unknown project' });
        if (!canEditProject(actor, project.id)) return send(res, 403, { error: 'you do not have access to that project' });
        const prior = appsForProject(state.payApps, project.id);
        const app = buildApplication(project, state.tasks, {
          number: prior.length + 1,
          retainagePct: Math.min(50, Math.max(0, +body.retainagePct || 0)),
          periodTo: body.periodTo || new Date().toISOString().slice(0, 10),
          createdBy: actor.name, createdAt: new Date().toISOString(),
        }, prior[prior.length - 1]);
        app.id = 'pa' + (Math.max(0, ...state.payApps.map((a) => +String(a.id).slice(2) || 0)) + 1);
        state.payApps.push(app);
        bump();
        await persistState();
        logAudit(actor, 'billing.create', { targetName: `Application #${app.number}`, projectId: project.id });
        return send(res, 201, app, { ETag: etag() });
      }
      if (method === 'DELETE' && id) {
        const app = state.payApps.find((a) => a.id === id);
        if (!app) return send(res, 404, { error: 'application not found' });
        if (!canEditProject(actor, app.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        state.payApps = state.payApps.filter((a) => a.id !== id);
        bump();
        await persistState();
        logAudit(actor, 'billing.delete', { targetName: `Application #${app.number}`, projectId: app.projectId });
        res.writeHead(204, { ETag: etag() }); return res.end();
      }
    }

    if (resource === 'docs') {
      if (!Array.isArray(state.docs)) state.docs = [];
      if (method === 'POST' && !id) {                 // create a submittal / RFI
        const body = await readBody(req);
        if (!canEditProject(actor, body.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const doc = makeDoc(state.docs, { ...body, createdBy: actor.name, createdAt: new Date().toISOString() });
        state.docs.push(doc);
        bump();
        await persistState();
        logAudit(actor, 'doc.create', { targetId: doc.id, targetName: `${doc.number} ${doc.title}`, projectId: doc.projectId });
        return send(res, 201, doc, { ETag: etag() });
      }
      if (method === 'PATCH' && id) {
        const doc = state.docs.find((d) => d.id === id);
        if (!doc) return send(res, 404, { error: 'document not found' });
        if (!canEditProject(actor, doc.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const body = await readBody(req);
        ['title', 'status', 'court', 'due', 'body', 'response', 'taskId'].forEach((k) => {
          if (body[k] !== undefined) doc[k] = body[k];
        });
        if (!DOC_KINDS[doc.kind].statuses.includes(doc.status)) doc.status = DOC_KINDS[doc.kind].statuses[0];
        doc.updatedBy = actor.name; doc.updatedAt = new Date().toISOString(); doc.rev = (doc.rev || 1) + 1;
        bump();
        await persistState();
        logAudit(actor, 'doc.update', { targetId: doc.id, targetName: `${doc.number} ${doc.title}`, projectId: doc.projectId, detail: `status ${doc.status}` });
        return send(res, 200, doc, { ETag: etag() });
      }
      if (method === 'DELETE' && id) {
        const doc = state.docs.find((d) => d.id === id);
        if (!doc) return send(res, 404, { error: 'document not found' });
        if (!canEditProject(actor, doc.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        state.docs = state.docs.filter((d) => d.id !== id);
        bump();
        await persistState();
        logAudit(actor, 'doc.delete', { targetId: id, targetName: `${doc.number} ${doc.title}`, projectId: doc.projectId });
        res.writeHead(204, { ETag: etag() }); return res.end();
      }
    }

    if (resource === 'changeorders') {
      if (!Array.isArray(state.changeOrders)) state.changeOrders = [];
      if (method === 'POST' && !id) {
        const body = await readBody(req);
        if (!canEditProject(actor, body.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const co = makeChangeOrder(state.changeOrders, { ...body, createdBy: actor.name, createdAt: new Date().toISOString() });
        if (co.status === 'approved') { co.approvedBy = actor.name; co.approvedAt = new Date().toISOString(); }
        state.changeOrders.push(co);
        bump(); await persistState();
        logAudit(actor, 'co.create', { targetId: co.id, targetName: `${co.number} ${co.title}`, projectId: co.projectId });
        return send(res, 201, co, { ETag: etag() });
      }
      if (method === 'PATCH' && id) {
        const co = state.changeOrders.find((c) => c.id === id);
        if (!co) return send(res, 404, { error: 'change order not found' });
        if (!canEditProject(actor, co.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const body = await readBody(req);
        const wasApproved = co.status === 'approved';
        ['title', 'description', 'amount', 'days', 'status'].forEach((k) => { if (body[k] !== undefined) co[k] = body[k]; });
        if (!CO_STATUSES.includes(co.status)) co.status = 'draft';
        if (co.status === 'approved' && !wasApproved) { co.approvedBy = actor.name; co.approvedAt = new Date().toISOString(); }
        if (co.status !== 'approved') { co.approvedBy = null; co.approvedAt = null; }
        co.rev = (co.rev || 1) + 1;
        bump(); await persistState();
        logAudit(actor, 'co.update', { targetId: co.id, targetName: `${co.number} ${co.title}`, projectId: co.projectId, detail: `status ${co.status}` });
        return send(res, 200, co, { ETag: etag() });
      }
      if (method === 'DELETE' && id) {
        const co = state.changeOrders.find((c) => c.id === id);
        if (!co) return send(res, 404, { error: 'change order not found' });
        if (!canEditProject(actor, co.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        state.changeOrders = state.changeOrders.filter((c) => c.id !== id);
        bump(); await persistState();
        logAudit(actor, 'co.delete', { targetName: `${co.number} ${co.title}`, projectId: co.projectId });
        res.writeHead(204, { ETag: etag() }); return res.end();
      }
    }

    if (resource === 'reports') {
      if (!Array.isArray(state.reports)) state.reports = [];
      if (method === 'POST' && !id) {
        const body = await readBody(req);
        if (!canEditProject(actor, body.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const r = makeReport(state.reports, { ...body, createdBy: actor.name, createdAt: new Date().toISOString() });
        state.reports.push(r);
        bump(); await persistState();
        logAudit(actor, 'report.create', { targetId: r.id, targetName: `Daily report ${r.date}`, projectId: r.projectId });
        return send(res, 201, r, { ETag: etag() });
      }
      if (method === 'PATCH' && id) {
        const r = state.reports.find((x) => x.id === id);
        if (!r) return send(res, 404, { error: 'report not found' });
        if (!canEditProject(actor, r.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const body = await readBody(req);
        ['date', 'weather', 'tempLow', 'tempHigh', 'manpower', 'workPerformed', 'deliveries', 'delays', 'notes'].forEach((k) => { if (body[k] !== undefined) r[k] = body[k]; });
        if (body.attachments !== undefined) r.attachments = cleanAttachments(body.attachments, actor.name);
        r.rev = (r.rev || 1) + 1;
        bump(); await persistState();
        logAudit(actor, 'report.update', { targetId: r.id, targetName: `Daily report ${r.date}`, projectId: r.projectId });
        return send(res, 200, r, { ETag: etag() });
      }
      if (method === 'DELETE' && id) {
        const r = state.reports.find((x) => x.id === id);
        if (!r) return send(res, 404, { error: 'report not found' });
        if (!canEditProject(actor, r.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        state.reports = state.reports.filter((x) => x.id !== id);
        bump(); await persistState();
        logAudit(actor, 'report.delete', { targetName: `Daily report ${r.date}`, projectId: r.projectId });
        res.writeHead(204, { ETag: etag() }); return res.end();
      }
    }

    if (resource === 'punch') {
      if (!Array.isArray(state.punch)) state.punch = [];
      if (method === 'POST' && !id) {
        const body = await readBody(req);
        if (!canEditProject(actor, body.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const p = makePunchItem(state.punch, { ...body, createdBy: actor.name, createdAt: new Date().toISOString() });
        state.punch.push(p);
        bump(); await persistState();
        logAudit(actor, 'punch.create', { targetId: p.id, targetName: `${p.number} ${p.title}`, projectId: p.projectId });
        return send(res, 201, p, { ETag: etag() });
      }
      if (method === 'PATCH' && id) {
        const p = state.punch.find((x) => x.id === id);
        if (!p) return send(res, 404, { error: 'punch item not found' });
        if (!canEditProject(actor, p.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const body = await readBody(req);
        ['title', 'location', 'trade', 'status', 'priority', 'assignedTo', 'taskId'].forEach((k) => { if (body[k] !== undefined) p[k] = body[k]; });
        if (body.attachments !== undefined) p.attachments = cleanAttachments(body.attachments, actor.name);
        if (!PUNCH_STATUSES.includes(p.status)) p.status = 'open';
        if (!PUNCH_PRIORITIES.includes(p.priority)) p.priority = 'normal';
        p.updatedBy = actor.name; p.updatedAt = new Date().toISOString(); p.rev = (p.rev || 1) + 1;
        bump(); await persistState();
        logAudit(actor, 'punch.update', { targetId: p.id, targetName: `${p.number} ${p.title}`, projectId: p.projectId, detail: `status ${p.status}` });
        return send(res, 200, p, { ETag: etag() });
      }
      if (method === 'DELETE' && id) {
        const p = state.punch.find((x) => x.id === id);
        if (!p) return send(res, 404, { error: 'punch item not found' });
        if (!canEditProject(actor, p.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        state.punch = state.punch.filter((x) => x.id !== id);
        bump(); await persistState();
        logAudit(actor, 'punch.delete', { targetName: `${p.number} ${p.title}`, projectId: p.projectId });
        res.writeHead(204, { ETag: etag() }); return res.end();
      }
    }

    if (resource === 'tasks') {
      if (method === 'GET' && id && sub === 'history') {
        // Full audit trail for one task (any authenticated user may view).
        return send(res, 200, audit.filter((e) => e.targetId === id).reverse());
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const task = body.id ? body : makeTask(state.tasks, body);
        if (!canEditProject(actor, task.projectId)) {
          return send(res, 403, { error: 'you do not have access to that project' });
        }
        if (task.rev == null) task.rev = 1;
        stamp(task, actor);                    // attribution from the session — unspoofable
        if (!state.tasks.some((t) => t.id === task.id)) state.tasks.push(task);
        bump();
        await persistState();
        logAudit(actor, 'task.create', { targetId: task.id, targetName: task.name, projectId: task.projectId });
        return send(res, 201, task, { ETag: etag() });
      }
      if (method === 'PATCH' && id) {
        const t = state.tasks.find((x) => x.id === id);
        if (!t) return send(res, 404, { error: 'task not found' });
        if (!canEditProject(actor, t.projectId)) {
          return send(res, 403, { error: 'you do not have access to that project' });
        }
        const ifMatch = req.headers['if-match'];
        if (ifMatch && ifMatch.replace(/"/g, '') !== String(t.rev || 1)) {
          return send(res, 409, { error: 'revision conflict', current: t }, { ETag: etag() });
        }
        const patch = await readBody(req);
        applyTaskPatch(t, patch);
        stamp(t, actor);
        t.rev = (t.rev || 1) + 1;
        bump();
        await persistState();
        logAudit(actor, 'task.update', {
          targetId: t.id, targetName: t.name, projectId: t.projectId,
          detail: 'changed ' + Object.keys(patch).filter((k) => !['lastEditedBy', 'lastEditedAt'].includes(k)).join(', '),
        });
        return send(res, 200, t, { ETag: etag() });
      }
      if (method === 'DELETE' && id) {
        const t = state.tasks.find((x) => x.id === id);
        if (!t) return send(res, 404, { error: 'task not found' });
        if (!canEditProject(actor, t.projectId)) {
          return send(res, 403, { error: 'you do not have access to that project' });
        }
        state.tasks = state.tasks.filter((x) => x.id !== id);
        state.tasks.forEach((x) => { x.dependencies = x.dependencies.filter((d) => d !== id); });
        bump();
        await persistState();
        logAudit(actor, 'task.delete', { targetId: id, targetName: t.name, projectId: t.projectId });
        res.writeHead(204, { ETag: etag() }); return res.end();
      }
    }

    return send(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    return send(res, 400, { error: String(e && e.message || e) });
  }
}

// --- Static files -----------------------------------------------------------
async function handleStatic(req, res, urlPath) {
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  }
}

// --- Boot -------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath.startsWith('/api/')) return handleApi(req, res, urlPath);
  return handleStatic(req, res, urlPath);
});

state = await loadState();
users = await loadUsers();
audit = await loadAudit();
server.listen(PORT, () => {
  console.log(`\n  BuildFlow ERP Schedule  →  http://localhost:${PORT}`);
  console.log(`  REST API                →  http://localhost:${PORT}/api/state`);
  console.log(`  Auth                    →  sign in required · demo: admin/admin123 (admin),`);
  console.log(`                              awhitfield/build123 (PM·Riverside), psandoval/north123 (PM·Northgate+Civic), viewer/view123`);
  console.log(`  Persisting to           →  ${path.relative(ROOT, DATA_FILE)} + auth.json + audit.json\n`);
});
