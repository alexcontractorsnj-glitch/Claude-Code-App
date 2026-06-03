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
import { seedState, makeTask, applyTaskPatch, normalizeState } from './src/js/seed.js';
import {
  seedUsers, verifyPassword, hashPassword, can, isRole, publicUser,
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

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// --- Persistence ------------------------------------------------------------
let state;
let users;                                    // [{ username, name, role, passwordHash }]
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
      if (Array.isArray(u) && u.length) return u;
    } catch { /* corrupt → reseed */ }
  }
  const fresh = await seedUsers();
  await persist(AUTH_FILE, fresh);
  return fresh;
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
async function handleUsers(req, res, target) {
  const method = req.method;
  if (method === 'GET' && !target) return send(res, 200, users.map(publicUser));
  if (method === 'POST' && !target) {
    const { username, password, name, role } = await readBody(req);
    if (!username || !password || !isRole(role)) return send(res, 400, { error: 'username, password and a valid role are required' });
    if (users.some((u) => u.username === username)) return send(res, 409, { error: 'username already exists' });
    const user = { username, name: name || username, role, passwordHash: await hashPassword(password) };
    users.push(user);
    await persistUsers();
    return send(res, 201, publicUser(user));
  }
  if (method === 'PATCH' && target) {          // change role
    const u = users.find((x) => x.username === target);
    if (!u) return send(res, 404, { error: 'user not found' });
    const { role } = await readBody(req);
    if (!isRole(role)) return send(res, 400, { error: 'valid role required' });
    u.role = role;
    destroyUserSessions(u.username);           // force re-login so the new role takes effect
    await persistUsers();
    return send(res, 200, publicUser(u));
  }
  if (method === 'DELETE' && target) {
    if (users.filter((u) => u.role === 'admin').length === 1 && users.find((u) => u.username === target)?.role === 'admin') {
      return send(res, 400, { error: 'cannot delete the last admin' });
    }
    users = users.filter((u) => u.username !== target);
    destroyUserSessions(target);
    await persistUsers();
    res.writeHead(204); return res.end();
  }
  return send(res, 404, { error: 'unknown users endpoint' });
}

// --- REST API ---------------------------------------------------------------
async function handleApi(req, res, urlPath) {
  const parts = urlPath.split('/').filter(Boolean);   // ['api', 'tasks', ':id?']
  const resource = parts[1];
  const id = parts[2];
  const method = req.method;

  try {
    // Auth endpoints are reachable without a session.
    if (resource === 'auth') return await handleAuth(req, res, id);

    // Everything else requires a valid session.
    const actor = actorOf(req);
    if (!actor) return send(res, 401, { error: 'authentication required' });

    // Authorization: reads need a session; writes need pm+, admin ops need admin.
    const isWrite = method !== 'GET' && method !== 'HEAD';
    const adminOnly = resource === 'reset' || resource === 'users';
    if (adminOnly && !can(actor.role, 'admin')) return send(res, 403, { error: 'admin privilege required' });
    if (isWrite && !adminOnly && !can(actor.role, 'write')) {
      return send(res, 403, { error: 'write privilege required (read-only role)' });
    }

    if (resource === 'users') return await handleUsers(req, res, id);

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
      return send(res, 200, state, { ETag: etag() });
    }

    if (resource === 'baseline') {
      if (method === 'POST') {                 // snapshot current schedule as the plan
        state.baseline = {
          label: 'Baseline', savedAt: new Date().toISOString().slice(0, 10),
          savedBy: actor.name,
          tasks: Object.fromEntries(state.tasks.map((t) => [t.id, { start: t.start, end: t.end, cost: t.cost || 0 }])),
        };
        bump();
        await persistState();
        return send(res, 200, state.baseline, { ETag: etag() });
      }
      if (method === 'DELETE') {
        state.baseline = null;
        bump();
        await persistState();
        res.writeHead(204, { ETag: etag() }); return res.end();
      }
    }

    if (resource === 'tasks') {
      if (method === 'POST') {
        const body = await readBody(req);
        const task = body.id ? body : makeTask(state.tasks, body);
        if (task.rev == null) task.rev = 1;
        stamp(task, actor);                    // attribution from the session — unspoofable
        if (!state.tasks.some((t) => t.id === task.id)) state.tasks.push(task);
        bump();
        await persistState();
        return send(res, 201, task, { ETag: etag() });
      }
      if (method === 'PATCH' && id) {
        const t = state.tasks.find((x) => x.id === id);
        if (!t) return send(res, 404, { error: 'task not found' });
        const ifMatch = req.headers['if-match'];
        if (ifMatch && ifMatch.replace(/"/g, '') !== String(t.rev || 1)) {
          return send(res, 409, { error: 'revision conflict', current: t }, { ETag: etag() });
        }
        applyTaskPatch(t, await readBody(req));
        stamp(t, actor);
        t.rev = (t.rev || 1) + 1;
        bump();
        await persistState();
        return send(res, 200, t, { ETag: etag() });
      }
      if (method === 'DELETE' && id) {
        state.tasks = state.tasks.filter((t) => t.id !== id);
        state.tasks.forEach((t) => { t.dependencies = t.dependencies.filter((d) => d !== id); });
        bump();
        await persistState();
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
server.listen(PORT, () => {
  console.log(`\n  BuildFlow ERP Schedule  →  http://localhost:${PORT}`);
  console.log(`  REST API                →  http://localhost:${PORT}/api/state`);
  console.log(`  Auth                    →  sign in required · demo: admin/admin123, awhitfield/build123, viewer/view123`);
  console.log(`  Persisting to           →  ${path.relative(ROOT, DATA_FILE)} + auth.json\n`);
});
