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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedState, makeTask, applyTaskPatch, normalizeState, nextBaselineId } from './src/js/seed.js';
import { buildApplication, appsForProject } from './src/js/billing.js';
import { makeDoc, DOC_KINDS } from './src/js/docs.js';
import { makeChangeOrder, CO_STATUSES } from './src/js/changeorders.js';
import { makeReport } from './src/js/fieldreports.js';
import { makePunchItem, PUNCH_STATUSES, PUNCH_PRIORITIES, cleanAttachments } from './src/js/punch.js';
import { makeMessage, capChannel, setRead, channelIdForProject } from './src/js/messaging.js';
import { makeDelivery, deliverySummary, DELIVERY_STATUSES } from './src/js/deliveries.js';
import { makeIssue, ISSUE_SEVERITIES, ISSUE_STATUSES } from './src/js/issues.js';
import { makeConstraint, CONSTRAINT_TYPES, CONSTRAINT_STATUSES } from './src/js/constraints.js';
import { analyzeField, fallbackBrief, dispatcherSystem, mentionsDispatcher, callSummary, DISPATCHER, DISPATCHER_TOOLS } from './src/js/dispatcher.js';
import {
  seedUsers, verifyPassword, hashPassword, can, isRole, publicUser,
  canEditProject, isUnrestricted,
  createSession, getSession, destroySession, destroyUserSessions,
  isLockedOut, recordFailure, clearFailures,
  parseCookies, sessionCookie, clearCookie, COOKIE,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// Load a gitignored .env so secrets (e.g. ANTHROPIC_API_KEY for the AI
// dispatcher) can live in a file instead of the shell. Zero-dep KEY=VALUE parser;
// real environment variables always win over the file.
(function loadDotenv() {
  try {
    for (const line of readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      }
    }
  } catch { /* no .env — fine */ }
})();

const PORT = process.argv[2] || process.env.PORT || 8000;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'schedule.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
const AUDIT_CAP = 500;                          // keep the most recent N entries
const VOICE_FILE = path.join(DATA_DIR, 'voice.json');
const VOICE_CAP = 300;                           // keep the most recent N voice notes
const MAX_VOICE_B64 = 1_400_000;                 // ~1MB of audio (≈ 45s opus) per note
const PHOTO_FILE = path.join(DATA_DIR, 'photos.json');
const PHOTO_CAP = 500;                            // keep the most recent N photos
const MAX_PHOTO_B64 = 1_800_000;                 // client compresses to ~1280px JPEG

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp',
};

// --- Persistence ------------------------------------------------------------
let state;
let users;                                    // [{ username, name, role, projects, passwordHash }]
let audit = [];                               // append-only activity log (capped)
let voice = {};                               // { id: { mime, data(base64), dur, by, at } } — audio blobs, kept out of /api/state
let photos = {};                              // { id: { mime, data(base64), w, h, by, at } } — image blobs, kept out of /api/state
let sse = new Set();                          // open Server-Sent-Events streams: { res, user }
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

async function loadVoice() {
  if (existsSync(VOICE_FILE)) {
    try { const v = JSON.parse(await readFile(VOICE_FILE, 'utf8')); if (v && typeof v === 'object') return v; }
    catch { /* corrupt → start fresh */ }
  }
  return {};
}
const persistVoice = () => persist(VOICE_FILE, voice);
let voiceSeq = 0;

async function loadPhotos() {
  if (existsSync(PHOTO_FILE)) {
    try { const v = JSON.parse(await readFile(PHOTO_FILE, 'utf8')); if (v && typeof v === 'object') return v; }
    catch { /* corrupt → fresh */ }
  }
  return {};
}
const persistPhotos = () => persist(PHOTO_FILE, photos);
let photoSeq = 0;

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
function bump() { state.rev = (state.rev || 0) + 1; sseNotify(); return state.rev; }
const etag = () => '"' + (state.rev || 0) + '"';

// --- Live event stream (SSE) ------------------------------------------------
// One push channel per connected client. We broadcast a tiny `sync` signal with
// the new global rev on every write (clients then pull /api/state — instant,
// no per-entity wiring), plus ephemeral `presence` and `typing` events.
function sseSend(client, event, data) {
  try { client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  catch { sse.delete(client); }
}
function sseBroadcast(event, data) { for (const c of [...sse]) sseSend(c, event, data); }
function sseToUser(username, event, data) {
  let n = 0;
  for (const c of [...sse]) if (c.user.username === username) { sseSend(c, event, data); n += 1; }
  return n;
}
function sseNotify() { sseBroadcast('sync', { rev: state.rev || 0 }); }
function onlineUsers() {
  const seen = new Map();
  for (const c of sse) if (!seen.has(c.user.username)) seen.set(c.user.username, { username: c.user.username, name: c.user.name });
  return [...seen.values()];
}
function broadcastPresence() { sseBroadcast('presence', { online: onlineUsers() }); }

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

// --- AI Dispatcher ----------------------------------------------------------
// Posts as a synthetic "Dispatcher" user; bypasses project scope (it's the
// system). Proactive scan turns findings into channel messages (deduped via
// state.dispatcher.posted). On @mention it runs a Claude tool-use agent that
// can take real, audited actions — falling back to a rule-based digest when no
// ANTHROPIC_API_KEY is configured.
const DISPATCHER_ACTOR = { name: DISPATCHER.name, role: 'system' };

function postDispatcher(channel, text, kind, linkedTo) {
  const msg = makeMessage(state.messages, { channelId: channel.id, authorId: DISPATCHER.id, authorName: DISPATCHER.name, body: text, linkedTo: linkedTo || null, createdAt: new Date().toISOString() });
  state.messages.push(msg);
  state.messages = capChannel(state.messages, channel.id);
  bump();
  persistState();
  logAudit(DISPATCHER_ACTOR, kind === 'reply' ? 'dispatcher.reply' : 'dispatcher.alert', { targetId: msg.id, targetName: channel.name, projectId: channel.projectId, detail: text.slice(0, 80) });
  return msg;
}

function runDispatcherScan() {
  if (!state.dispatcher) state.dispatcher = { posted: {} };
  const posted = state.dispatcher.posted || (state.dispatcher.posted = {});
  let n = 0;
  for (const f of analyzeField(state)) {
    if (f.severity === 'low' || posted[f.key]) continue;
    const channel = (state.channels || []).find((c) => c.id === f.channelId);
    if (!channel) continue;
    postDispatcher(channel, f.text, 'alert');
    posted[f.key] = new Date().toISOString();
    if (++n >= 6) break;                              // don't flood a single scan
  }
  if (n) persistState();
  return n;
}

let lastClaudeError = null;                    // surfaced to users so silent AI failures are diagnosable
const DISPATCHER_MODEL = () => process.env.DISPATCHER_MODEL || 'claude-opus-4-8';

async function callClaude(system, messages) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { lastClaudeError = 'no-key'; return null; }
  try {
    const res = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: DISPATCHER_MODEL(), max_tokens: 1024, system, tools: DISPATCHER_TOOLS, messages }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      console.error('dispatcher: Claude HTTP', res.status, detail);
      lastClaudeError = `http-${res.status}`;          // 401 = bad key, 404 = model not available, 429 = rate limited
      return null;
    }
    lastClaudeError = null;
    return await res.json();
  } catch (e) { console.error('dispatcher: Claude error', e.message); lastClaudeError = 'network'; return null; }
}

// A plain text completion (no tools) — used to enrich deterministic output like
// the post-call recap. Returns the text, or null on no-key / any failure.
async function claudeText(system, prompt, maxTokens = 220) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const model = process.env.DISPATCHER_MODEL || 'claude-opus-4-8';
  try {
    const res = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) { console.error('claudeText HTTP', res.status); return null; }
    const j = await res.json();
    const t = Array.isArray(j.content) ? j.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim() : '';
    return t || null;
  } catch (e) { console.error('claudeText error', e.message); return null; }
}

function execDispatcherTool(name, input, actor) {
  const by = actor ? '@' + actor.username : 'dispatcher';
  // The agent acts ON BEHALF OF the asker, so it must never let a project-scoped
  // PM mutate data outside their scope. Read-only status is unrestricted.
  const denied = (projectId) => actor && !canEditProject(actor, projectId)
    ? { ok: false, error: `you do not have access to project ${projectId}` } : null;
  try {
    if (name === 'get_field_status') {
      const pid = input.projectId || 'all';
      const tasks = (state.tasks || []).filter((t) => pid === 'all' || t.projectId === pid);
      return {
        project: pid, today: new Date().toISOString().slice(0, 10),
        deliveries: deliverySummary(state.deliveries, pid),
        openTasks: tasks.filter((t) => t.status !== 'done' && !t.milestone).length,
        blocked: tasks.filter((t) => t.status === 'blocked').length,
        findings: analyzeField(state).filter((f) => pid === 'all' || f.projectId === pid).map((f) => ({ severity: f.severity, text: f.text })),
      };
    }
    if (name === 'reschedule_task') {
      const t = (state.tasks || []).find((x) => x.id === input.taskId);
      if (!t) return { ok: false, error: 'task not found' };
      const d = denied(t.projectId); if (d) return d;
      const patch = {}; if (input.start) patch.start = input.start; if (input.end) patch.end = input.end;
      applyTaskPatch(t, patch); t.lastEditedBy = DISPATCHER.name; t.lastEditedAt = new Date().toISOString(); t.rev = (t.rev || 1) + 1;
      bump(); persistState();
      logAudit(DISPATCHER_ACTOR, 'dispatcher.action', { targetId: t.id, targetName: t.name, projectId: t.projectId, detail: `reschedule (${by}): ${JSON.stringify(patch)}` });
      return { ok: true, task: t.id, start: t.start, end: t.end };
    }
    if (name === 'set_task_status') {
      const t = (state.tasks || []).find((x) => x.id === input.taskId);
      if (!t) return { ok: false, error: 'task not found' };
      const d = denied(t.projectId); if (d) return d;
      applyTaskPatch(t, { status: input.status }); t.lastEditedBy = DISPATCHER.name; t.rev = (t.rev || 1) + 1;
      bump(); persistState();
      logAudit(DISPATCHER_ACTOR, 'dispatcher.action', { targetId: t.id, targetName: t.name, projectId: t.projectId, detail: `status ${t.status} (${by})` });
      return { ok: true, task: t.id, status: t.status, progress: t.progress };
    }
    if (name === 'update_delivery') {
      const d = (state.deliveries || []).find((x) => x.id === input.deliveryId);
      if (!d) return { ok: false, error: 'delivery not found' };
      const dn = denied(d.projectId); if (dn) return dn;
      if (input.status && DELIVERY_STATUSES.includes(input.status)) d.status = input.status;
      if (input.due) d.due = input.due;
      d.updatedBy = DISPATCHER.name; d.updatedAt = new Date().toISOString(); d.rev = (d.rev || 1) + 1;
      bump(); persistState();
      logAudit(DISPATCHER_ACTOR, 'dispatcher.action', { targetId: d.id, targetName: d.item, projectId: d.projectId, detail: `delivery ${d.status} due ${d.due} (${by})` });
      return { ok: true, delivery: d.id, status: d.status, due: d.due };
    }
    if (name === 'create_punch_item') {
      const d = denied(input.projectId); if (d) return d;
      if (!Array.isArray(state.punch)) state.punch = [];
      const p = makePunchItem(state.punch, { projectId: input.projectId, title: input.title, location: input.location, priority: input.priority, createdBy: DISPATCHER.name, createdAt: new Date().toISOString() });
      state.punch.push(p); bump(); persistState();
      logAudit(DISPATCHER_ACTOR, 'dispatcher.action', { targetId: p.id, targetName: `${p.number} ${p.title}`, projectId: p.projectId, detail: `punch via ${by}` });
      return { ok: true, punch: p.id, number: p.number };
    }
    if (name === 'clear_constraint') {
      const c = (state.constraints || []).find((x) => x.id === input.constraintId);
      if (!c) return { ok: false, error: 'constraint not found' };
      const d = denied(c.projectId); if (d) return d;
      c.status = 'cleared'; c.clearedBy = DISPATCHER.name; c.clearedAt = new Date().toISOString(); c.rev = (c.rev || 1) + 1;
      bump(); persistState();
      logAudit(DISPATCHER_ACTOR, 'dispatcher.action', { targetId: c.id, targetName: `${c.number} ${c.title}`, projectId: c.projectId, detail: `constraint cleared (${by})` });
      return { ok: true, constraint: c.id, status: c.status };
    }
    return { ok: false, error: 'unknown tool' };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

async function dispatcherReply(channel, actor, linkedTo = null) {
  // When the conversation is anchored to a task, scope context + the reply to it.
  const taskId = linkedTo && linkedTo.kind === 'task' ? linkedTo.id : null;
  const task = taskId ? (state.tasks || []).find((t) => t.id === taskId) : null;
  // No key → deterministic field digest.
  if (!process.env.ANTHROPIC_API_KEY) {
    return postDispatcher(channel, fallbackBrief(state, channel.projectId) + '\n\n_(AI offline — set ANTHROPIC_API_KEY for the full assistant.)_', 'reply', linkedTo);
  }
  const pool = taskId
    ? state.messages.filter((m) => m.linkedTo && m.linkedTo.id === taskId)
    : state.messages.filter((m) => m.channelId === channel.id);
  const recent = pool.slice(-10).map((m) => `${m.authorName}: ${m.body || (m.voice ? '(voice note)' : m.photo ? '(photo)' : '')}`).join('\n');
  const ctx = task ? `the task “${task.name}” (project ${channel.projectId})` : `channel “${channel.name}” (project ${channel.projectId})`;
  const system = dispatcherSystem(state, actor && actor.name);
  const messages = [{ role: 'user', content: `Recent conversation about ${ctx}:\n${recent}\n\nRespond as the Dispatcher to the latest message — check status first, take any clearly-requested actions, and reply concisely.` }];
  let text = null;
  try {
    for (let step = 0; step < 6; step++) {
      const resp = await callClaude(system, messages);
      if (!resp || !Array.isArray(resp.content)) break;
      messages.push({ role: 'assistant', content: resp.content });
      const toolUses = resp.content.filter((b) => b.type === 'tool_use');
      if (!toolUses.length) { text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(); break; }
      messages.push({ role: 'user', content: toolUses.map((tu) => ({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(execDispatcherTool(tu.name, tu.input, actor)) })) });
    }
  } catch (e) { console.error('dispatcher: agent', e.message); }
  if (text) return postDispatcher(channel, text, 'reply', linkedTo);
  // No AI text — say WHY, so a silent dispatcher is diagnosable instead of just
  // posting a generic digest that looks like it ignored the question.
  const why = lastClaudeError === 'http-401' ? '\n\n_(The Claude API key was rejected — check ANTHROPIC_API_KEY in Render.)_'
    : lastClaudeError === 'http-404' ? `\n\n_(Model “${DISPATCHER_MODEL()}” isn’t available on this key — set DISPATCHER_MODEL to one you have access to.)_`
    : lastClaudeError === 'http-429' ? '\n\n_(Claude API rate-limited — try again in a moment.)_'
    : lastClaudeError === 'network' ? '\n\n_(Couldn’t reach the Claude API from the server.)_'
    : '\n\n_(AI offline — set ANTHROPIC_API_KEY for the full assistant.)_';
  return postDispatcher(channel, fallbackBrief(state, channel.projectId) + why, 'reply', linkedTo);
}

// --- HTTP helpers -----------------------------------------------------------
function send(res, code, payload, headers = {}) {
  const body = payload == null ? '' : JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });   // headroom for voice-note uploads
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Resolve the authenticated user for a request from its session cookie.
function actorOf(req) {
  const token = parseCookies(req)[COOKIE];
  return getSession(token, (username) => users.find((u) => u.username === username));
}
// True when the original client request used HTTPS. Render (and most PaaS) put
// the app behind a TLS-terminating proxy and signal the real scheme via the
// x-forwarded-proto header; fall back to the direct socket for bare deploys.
function isHttps(req) {
  const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return xf === 'https' || !!(req.socket && req.socket.encrypted);
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
    return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token, { secure: isHttps(req) }) });
  }
  if (action === 'logout' && req.method === 'POST') {
    destroySession(parseCookies(req)[COOKIE]);
    return send(res, 204, null, { 'Set-Cookie': clearCookie({ secure: isHttps(req) }) });
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
    // Marking a channel read or sending a typing ping is a per-user, ephemeral
    // signal — allowed for any signed-in user (incl. read-only monitors).
    const ephemeral = (resource === 'channels' && (sub === 'read' || sub === 'typing') && method === 'POST')
      || (resource === 'signal' && method === 'POST');
    if (adminOnly && !can(actor.role, 'admin')) return send(res, 403, { error: 'admin privilege required' });
    if (isWrite && !adminOnly && !ephemeral && !can(actor.role, 'write')) {
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

    // Live event stream — long-lived response; do not route through send().
    if (resource === 'stream' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      const client = { res, user: actor };
      sse.add(client);
      sseSend(client, 'sync', { rev: state.rev || 0 });
      sseSend(client, 'presence', { online: onlineUsers() });
      broadcastPresence();
      const ka = setInterval(() => sseSend(client, 'ping', { t: 1 }), 25000);
      req.on('close', () => { clearInterval(ka); sse.delete(client); broadcastPresence(); });
      return;
    }

    // Typing indicator — ephemeral, relayed to other streams, never stored.
    if (resource === 'channels' && method === 'POST' && id && sub === 'typing') {
      if ((state.channels || []).some((c) => c.id === id)) sseBroadcast('typing', { channelId: id, user: actor.username, name: actor.name });
      return send(res, 204, null);
    }

    // WebRTC call signaling — relay offer/answer/ICE/end to the target user's
    // live streams. The server is a dumb relay (no media passes through it).
    if (resource === 'signal' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      if (!body.to || !body.type) return send(res, 400, { error: 'to and type are required' });
      const delivered = sseToUser(body.to, 'call', {
        type: body.type, from: actor.username, fromName: actor.name,
        sdp: body.sdp, candidate: body.candidate, video: body.video,
      });
      return send(res, 200, { delivered });
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

    if (resource === 'voice') {
      if (method === 'POST' && !id) {                 // upload a voice note → { id, dur, mime }
        const body = await readBody(req);
        const data = String(body.data || '');
        if (!data) return send(res, 400, { error: 'no audio data' });
        if (data.length > MAX_VOICE_B64) return send(res, 413, { error: 'voice note too large (max ~45s)' });
        const vid = 'v' + Date.now().toString(36) + (voiceSeq++).toString(36);
        voice[vid] = { mime: typeof body.mime === 'string' ? body.mime : 'audio/webm', data, dur: Math.min(120, +body.dur || 0), by: actor.username, at: new Date().toISOString() };
        const ids = Object.keys(voice);
        if (ids.length > VOICE_CAP) ids.slice(0, ids.length - VOICE_CAP).forEach((k) => delete voice[k]);  // trim oldest
        persistVoice();
        return send(res, 201, { id: vid, dur: voice[vid].dur, mime: voice[vid].mime });
      }
      if (method === 'GET' && id) {                    // stream a voice note's audio
        const v = voice[id];
        if (!v) return send(res, 404, { error: 'voice note not found' });
        const buf = Buffer.from(v.data, 'base64');
        res.writeHead(200, { 'Content-Type': v.mime, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000' });
        return res.end(buf);
      }
    }

    if (resource === 'photos') {
      if (method === 'POST' && !id) {                 // upload a photo → { id, mime, w, h }
        const body = await readBody(req);
        const data = String(body.data || '');
        if (!data) return send(res, 400, { error: 'no image data' });
        if (data.length > MAX_PHOTO_B64) return send(res, 413, { error: 'photo too large' });
        const pid = 'ph' + Date.now().toString(36) + (photoSeq++).toString(36);
        photos[pid] = { mime: typeof body.mime === 'string' ? body.mime : 'image/jpeg', data, w: +body.w || 0, h: +body.h || 0, by: actor.username, at: new Date().toISOString() };
        const ids = Object.keys(photos);
        if (ids.length > PHOTO_CAP) ids.slice(0, ids.length - PHOTO_CAP).forEach((k) => delete photos[k]);
        persistPhotos();
        return send(res, 201, { id: pid, mime: photos[pid].mime, w: photos[pid].w, h: photos[pid].h });
      }
      if (method === 'GET' && id) {
        const p = photos[id];
        if (!p) return send(res, 404, { error: 'photo not found' });
        const buf = Buffer.from(p.data, 'base64');
        res.writeHead(200, { 'Content-Type': p.mime, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000' });
        return res.end(buf);
      }
    }

    if (resource === 'messages') {
      if (!Array.isArray(state.messages)) state.messages = [];
      if (method === 'POST' && !id) {                 // send a message to a channel
        const body = await readBody(req);
        const ch = (state.channels || []).find((c) => c.id === body.channelId);
        if (!ch) return send(res, 400, { error: 'unknown channel' });
        // Posting to a project channel needs write access to that project.
        if (ch.type === 'project' && !canEditProject(actor, ch.projectId)) {
          return send(res, 403, { error: 'you do not have access to that project' });
        }
        const vref = body.voice && body.voice.id && voice[body.voice.id]
          ? { id: body.voice.id, dur: voice[body.voice.id].dur, mime: voice[body.voice.id].mime } : null;
        const pref = body.photo && body.photo.id && photos[body.photo.id]
          ? { id: body.photo.id, mime: photos[body.photo.id].mime, w: photos[body.photo.id].w, h: photos[body.photo.id].h } : null;
        const msg = makeMessage(state.messages, {
          channelId: ch.id, authorId: actor.username, authorName: actor.name,
          body: body.body, attachments: cleanAttachments(body.attachments, actor.name),
          voice: vref, photo: pref, linkedTo: body.linkedTo || null,
          clientId: typeof body.clientId === 'string' ? body.clientId.slice(0, 40) : null,
          createdAt: new Date().toISOString(),
        });
        if (!msg.body && !msg.attachments.length && !msg.voice && !msg.photo) return send(res, 400, { error: 'empty message' });
        state.messages.push(msg);
        state.messages = capChannel(state.messages, ch.id);
        state.reads = setRead(state.reads, actor.username, ch.id, msg.createdAt);  // author has read their own
        bump(); await persistState();
        logAudit(actor, 'message.send', { targetId: msg.id, targetName: ch.name, projectId: ch.projectId, detail: msg.voice ? '🎤 voice note' : msg.photo ? '📷 photo' : msg.body.slice(0, 80) });
        // @dispatcher → the AI replies asynchronously, in the same context
        // (task thread if the message was task-linked, else the channel).
        if (mentionsDispatcher(msg.body)) dispatcherReply(ch, actor, msg.linkedTo).catch((e) => console.error('dispatcher', e));
        return send(res, 201, msg, { ETag: etag() });
      }
    }

    if (resource === 'channels' && method === 'POST' && id && sub === 'read') {
      const ch = (state.channels || []).find((c) => c.id === id);
      if (!ch) return send(res, 404, { error: 'channel not found' });
      const body = await readBody(req).catch(() => ({}));
      state.reads = setRead(state.reads, actor.username, ch.id, body.at || new Date().toISOString());
      bump(); await persistState();
      return send(res, 200, { channelId: ch.id, at: state.reads[actor.username][ch.id] }, { ETag: etag() });
    }

    if (resource === 'deliveries') {
      if (!Array.isArray(state.deliveries)) state.deliveries = [];
      if (method === 'POST' && !id) {
        const body = await readBody(req);
        if (!canEditProject(actor, body.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const d = makeDelivery(state.deliveries, { ...body, createdBy: actor.name, createdAt: new Date().toISOString() });
        state.deliveries.push(d);
        bump(); await persistState();
        logAudit(actor, 'delivery.create', { targetId: d.id, targetName: d.item, projectId: d.projectId });
        return send(res, 201, d, { ETag: etag() });
      }
      if (method === 'PATCH' && id) {
        const d = state.deliveries.find((x) => x.id === id);
        if (!d) return send(res, 404, { error: 'delivery not found' });
        if (!canEditProject(actor, d.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const body = await readBody(req);
        ['item', 'supplier', 'qty', 'due', 'status', 'taskId', 'notes'].forEach((k) => { if (body[k] !== undefined) d[k] = body[k]; });
        if (!DELIVERY_STATUSES.includes(d.status)) d.status = 'scheduled';
        d.updatedBy = actor.name; d.updatedAt = new Date().toISOString(); d.rev = (d.rev || 1) + 1;
        bump(); await persistState();
        logAudit(actor, 'delivery.update', { targetId: d.id, targetName: d.item, projectId: d.projectId, detail: `${d.status} due ${d.due}` });
        return send(res, 200, d, { ETag: etag() });
      }
      if (method === 'DELETE' && id) {
        const d = state.deliveries.find((x) => x.id === id);
        if (!d) return send(res, 404, { error: 'delivery not found' });
        if (!canEditProject(actor, d.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        state.deliveries = state.deliveries.filter((x) => x.id !== id);
        bump(); await persistState();
        logAudit(actor, 'delivery.delete', { targetName: d.item, projectId: d.projectId });
        res.writeHead(204, { ETag: etag() }); return res.end();
      }
    }

    if (resource === 'issues') {
      if (!Array.isArray(state.issues)) state.issues = [];
      if (method === 'POST' && !id) {                 // flag a field issue
        const body = await readBody(req);
        if (!canEditProject(actor, body.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const pref = body.photo && body.photo.id && photos[body.photo.id] ? { id: body.photo.id, mime: photos[body.photo.id].mime } : null;
        const iss = makeIssue(state.issues, { ...body, photo: pref, createdBy: actor.name, createdAt: new Date().toISOString() });
        state.issues.push(iss);
        bump(); await persistState();
        logAudit(actor, 'issue.create', { targetId: iss.id, targetName: `${iss.number} ${iss.title}`, projectId: iss.projectId, detail: iss.severity });
        return send(res, 201, iss, { ETag: etag() });
      }
      if (method === 'POST' && id && sub === 'promote') {   // → formal punch item or RFI
        const iss = state.issues.find((x) => x.id === id);
        if (!iss) return send(res, 404, { error: 'issue not found' });
        if (!canEditProject(actor, iss.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const body = await readBody(req).catch(() => ({}));
        const to = body.to === 'rfi' ? 'rfi' : 'punch';
        let created, item;
        if (to === 'punch') {
          if (!Array.isArray(state.punch)) state.punch = [];
          item = makePunchItem(state.punch, { projectId: iss.projectId, taskId: iss.taskId, title: iss.title, priority: iss.severity === 'high' ? 'high' : 'normal', createdBy: actor.name, createdAt: new Date().toISOString() });
          state.punch.push(item); created = { kind: 'punch', id: item.id, number: item.number };
        } else {
          if (!Array.isArray(state.docs)) state.docs = [];
          item = makeDoc(state.docs, { kind: 'rfi', projectId: iss.projectId, taskId: iss.taskId, title: iss.title, createdBy: actor.name, createdAt: new Date().toISOString() });
          state.docs.push(item); created = { kind: 'rfi', id: item.id, number: item.number };
        }
        iss.promotedTo = { kind: created.kind, id: created.id };
        iss.status = 'resolved'; iss.resolvedBy = actor.name; iss.resolvedAt = new Date().toISOString(); iss.rev = (iss.rev || 1) + 1;
        bump(); await persistState();
        logAudit(actor, 'issue.promote', { targetId: iss.id, targetName: `${iss.number} → ${created.number}`, projectId: iss.projectId, detail: created.kind });
        return send(res, 200, { issue: iss, created, item }, { ETag: etag() });
      }
      if (method === 'PATCH' && id) {
        const iss = state.issues.find((x) => x.id === id);
        if (!iss) return send(res, 404, { error: 'issue not found' });
        if (!canEditProject(actor, iss.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const body = await readBody(req);
        ['title', 'severity', 'status'].forEach((k) => { if (body[k] !== undefined) iss[k] = body[k]; });
        if (!ISSUE_SEVERITIES.includes(iss.severity)) iss.severity = 'normal';
        if (!ISSUE_STATUSES.includes(iss.status)) iss.status = 'open';
        if (iss.status === 'resolved' && !iss.resolvedAt) { iss.resolvedBy = actor.name; iss.resolvedAt = new Date().toISOString(); }
        if (iss.status === 'open') { iss.resolvedBy = null; iss.resolvedAt = null; }
        iss.rev = (iss.rev || 1) + 1;
        bump(); await persistState();
        logAudit(actor, 'issue.update', { targetId: iss.id, targetName: `${iss.number} ${iss.title}`, projectId: iss.projectId, detail: `status ${iss.status}` });
        return send(res, 200, iss, { ETag: etag() });
      }
      if (method === 'DELETE' && id) {
        const iss = state.issues.find((x) => x.id === id);
        if (!iss) return send(res, 404, { error: 'issue not found' });
        if (!canEditProject(actor, iss.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        state.issues = state.issues.filter((x) => x.id !== id);
        bump(); await persistState();
        logAudit(actor, 'issue.delete', { targetName: `${iss.number} ${iss.title}`, projectId: iss.projectId });
        res.writeHead(204, { ETag: etag() }); return res.end();
      }
    }

    if (resource === 'constraints') {
      if (!Array.isArray(state.constraints)) state.constraints = [];
      if (method === 'POST' && !id) {                 // log a constraint
        const body = await readBody(req);
        if (!canEditProject(actor, body.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const cstr = makeConstraint(state.constraints, { ...body, createdBy: actor.name, createdAt: new Date().toISOString() });
        state.constraints.push(cstr);
        bump(); await persistState();
        logAudit(actor, 'constraint.create', { targetId: cstr.id, targetName: `${cstr.number} ${cstr.title}`, projectId: cstr.projectId, detail: cstr.type });
        return send(res, 201, cstr, { ETag: etag() });
      }
      if (method === 'PATCH' && id) {
        const cstr = state.constraints.find((x) => x.id === id);
        if (!cstr) return send(res, 404, { error: 'constraint not found' });
        if (!canEditProject(actor, cstr.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const body = await readBody(req);
        ['title', 'type', 'responsible', 'needBy', 'status', 'notes'].forEach((k) => { if (body[k] !== undefined) cstr[k] = body[k]; });
        if (!CONSTRAINT_TYPES.includes(cstr.type)) cstr.type = 'other';
        if (!CONSTRAINT_STATUSES.includes(cstr.status)) cstr.status = 'open';
        if (cstr.status === 'cleared' && !cstr.clearedAt) { cstr.clearedBy = actor.name; cstr.clearedAt = new Date().toISOString(); }
        if (cstr.status === 'open') { cstr.clearedBy = null; cstr.clearedAt = null; }
        cstr.rev = (cstr.rev || 1) + 1;
        bump(); await persistState();
        logAudit(actor, 'constraint.update', { targetId: cstr.id, targetName: `${cstr.number} ${cstr.title}`, projectId: cstr.projectId, detail: `status ${cstr.status}` });
        return send(res, 200, cstr, { ETag: etag() });
      }
      if (method === 'DELETE' && id) {
        const cstr = state.constraints.find((x) => x.id === id);
        if (!cstr) return send(res, 404, { error: 'constraint not found' });
        if (!canEditProject(actor, cstr.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        state.constraints = state.constraints.filter((x) => x.id !== id);
        bump(); await persistState();
        logAudit(actor, 'constraint.delete', { targetName: `${cstr.number} ${cstr.title}`, projectId: cstr.projectId });
        res.writeHead(204, { ETag: etag() }); return res.end();
      }
    }

    if (resource === 'dispatcher' && method === 'POST' && id === 'scan') {
      const n = runDispatcherScan();
      return send(res, 200, { posted: n }, { ETag: etag() });
    }
    // Diagnostic: is the AI actually wired up? Never returns the key itself —
    // just whether one is present, the model, and the last call's failure (if any).
    if (resource === 'dispatcher' && method === 'GET' && id === 'health') {
      return send(res, 200, {
        keyed: !!process.env.ANTHROPIC_API_KEY,
        model: DISPATCHER_MODEL(),
        lastError: lastClaudeError,                  // null = ok / never called; 'http-401' = bad key; etc.
        hint: !process.env.ANTHROPIC_API_KEY
          ? 'ANTHROPIC_API_KEY is NOT set on the server — set it in Render → Environment and redeploy.'
          : 'Key is present. If the AI is still silent, lastError tells you why (http-401 = bad key, http-404 = model not available).',
      });
    }
    // Direct chat with the agent — always answers (no @mention needed). Anchors
    // to a task thread when taskId is given, else to a project channel.
    if (resource === 'dispatcher' && method === 'POST' && id === 'ask') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { error: 'empty message' });
      let ch, linkedTo = null;
      if (body.taskId) {
        const t = (state.tasks || []).find((x) => x.id === body.taskId);
        if (!t) return send(res, 404, { error: 'task not found' });
        if (!canEditProject(actor, t.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        ch = (state.channels || []).find((c) => c.id === channelIdForProject(t.projectId));
        linkedTo = { kind: 'task', id: t.id };
      } else {
        ch = (state.channels || []).find((c) => c.id === body.channelId);
        if (!ch) return send(res, 400, { error: 'unknown channel' });
        if (ch.type === 'project' && !canEditProject(actor, ch.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
      }
      if (!ch) return send(res, 404, { error: 'no channel for that project' });
      const umsg = makeMessage(state.messages, { channelId: ch.id, authorId: actor.username, authorName: actor.name, body: text, linkedTo, createdAt: new Date().toISOString() });
      state.messages.push(umsg);
      state.messages = capChannel(state.messages, ch.id);
      state.reads = setRead(state.reads, actor.username, ch.id, umsg.createdAt);
      bump(); await persistState();
      logAudit(actor, 'message.send', { targetId: umsg.id, targetName: ch.name, projectId: ch.projectId, detail: '🤖 ask: ' + text.slice(0, 72) });
      dispatcherReply(ch, actor, linkedTo).catch((e) => console.error('dispatcher ask', e));   // reply arrives via sync
      return send(res, 201, umsg, { ETag: etag() });
    }

    if (resource === 'tasks') {
      if (method === 'GET' && id && sub === 'history') {
        // Full audit trail for one task (any authenticated user may view).
        return send(res, 200, audit.filter((e) => e.targetId === id).reverse());
      }
      if (method === 'POST' && id && sub === 'callsummary') {
        // Post-call recap into the task thread (the Dispatcher authors it). The
        // caller's client hits this when a task-linked call ends.
        const t = (state.tasks || []).find((x) => x.id === id);
        if (!t) return send(res, 404, { error: 'task not found' });
        if (!canEditProject(actor, t.projectId)) return send(res, 403, { error: 'you do not have access to that project' });
        const body = await readBody(req).catch(() => ({}));
        let text = callSummary(state, { taskId: id, callerName: actor.name, peerName: body.peerName || '', durationSec: +body.durationSec || 0, video: !!body.video });
        // With a key, prepend a grounded one-line AI note; the deterministic
        // recap below it is always present as the reliable record.
        if (process.env.ANTHROPIC_API_KEY) {
          const recent = (state.messages || []).filter((m) => m.linkedTo && m.linkedTo.id === id).slice(-6).map((m) => `${m.authorName}: ${m.body || '(voice/photo)'}`).join('\n');
          const ai = await claudeText(
            'You are the Dispatcher for a construction team. In ONE sentence, note what a just-finished phone call about a task most likely covered and the single most useful next step. Ground it ONLY in the facts provided — do not invent specifics. No preamble, no greeting.',
            `Task: "${t.name}". Call: ${actor.name}${body.peerName ? ` with ${body.peerName}` : ''}, ${body.video ? 'video' : 'audio'}.\nRecent activity on this task:\n${recent || '(none)'}\n\nDeterministic recap (for context):\n${text}`,
          ).catch(() => null);
          if (ai) text = `🤖 ${ai}\n\n${text}`;
        }
        const channel = (state.channels || []).find((c) => c.id === channelIdForProject(t.projectId));
        if (!channel) return send(res, 404, { error: 'no channel for project' });
        const msg = postDispatcher(channel, text, 'reply', { kind: 'task', id });
        return send(res, 201, msg, { ETag: etag() });
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
  if (urlPath.endsWith('/')) urlPath += 'index.html';   // directory index (e.g. /mobile/ → Corefield)
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
voice = await loadVoice();
photos = await loadPhotos();
server.listen(PORT, () => {
  console.log(`\n  BuildFlow ERP Schedule  →  http://localhost:${PORT}`);
  console.log(`  REST API                →  http://localhost:${PORT}/api/state`);
  console.log(`  Auth                    →  sign in required · demo: admin/admin123 (admin),`);
  console.log(`                              awhitfield/build123 (PM·Riverside), psandoval/north123 (PM·Northgate+Civic), viewer/view123`);
  console.log(`  Dispatcher              →  ${process.env.ANTHROPIC_API_KEY ? 'Claude agent ON' : 'rule-based (set ANTHROPIC_API_KEY for AI)'}\n`);
  console.log(`  Persisting to           →  ${path.relative(ROOT, DATA_FILE)} + auth.json + audit.json\n`);
});

// Proactive monitoring: scan the field every few minutes and post NEW findings
// into the relevant project channels (deduped, so it never repeats itself).
const DISPATCH_INTERVAL = +process.env.DISPATCHER_SCAN_MS || 300000;   // 5 min
if (typeof setInterval === 'function') {
  const timer = setInterval(() => { try { runDispatcherScan(); } catch (e) { console.error('dispatcher scan', e.message); } }, DISPATCH_INTERVAL);
  if (timer.unref) timer.unref();
}
