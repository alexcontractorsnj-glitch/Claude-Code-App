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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.argv[2] || process.env.PORT || 8000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'schedule.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// --- Persistence ------------------------------------------------------------
let state;
let writeChain = Promise.resolve();           // serialize writes

async function loadState() {
  if (existsSync(DATA_FILE)) {
    try { return normalizeState(JSON.parse(await readFile(DATA_FILE, 'utf8'))); }
    catch { /* corrupt → reseed below */ }
  }
  const fresh = seedState();
  await persist(fresh);
  return fresh;
}

// Global revision: bumped on every write so clients can detect others' edits
// (sent as an ETag) and we can serve cheap 304s when nothing changed.
function bump() { state.rev = (state.rev || 0) + 1; return state.rev; }
const etag = () => '"' + (state.rev || 0) + '"';

// Edit attribution (NOT auth): trust the X-User header from the trusted LAN
// client. Returns the caller's display name, or null.
function who(req) {
  const h = req.headers['x-user'];
  if (!h) return null;
  try { return decodeURIComponent(h).slice(0, 60); } catch { return String(h).slice(0, 60); }
}
function stamp(task, req) {
  task.lastEditedBy = who(req) || task.lastEditedBy || 'Unknown';
  task.lastEditedAt = new Date().toISOString();
}

function persist(next) {
  // Chain writes so concurrent requests can't interleave file output.
  writeChain = writeChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(next, null, 2));
  }).catch((e) => console.error('persist failed', e));
  return writeChain;
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
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// --- REST API ---------------------------------------------------------------
async function handleApi(req, res, urlPath) {
  const parts = urlPath.split('/').filter(Boolean);   // ['api', 'tasks', ':id?']
  const resource = parts[1];
  const id = parts[2];
  const method = req.method;

  try {
    if (resource === 'state' && method === 'GET') {
      // Conditional GET: 304 when the client already has the current revision.
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
      await persist(state);
      return send(res, 200, state, { ETag: etag() });
    }

    if (resource === 'baseline') {
      if (method === 'POST') {                 // snapshot current schedule as the plan
        const body = await readBody(req).catch(() => ({}));
        state.baseline = {
          label: 'Baseline', savedAt: new Date().toISOString().slice(0, 10),
          savedBy: who(req) || body.savedBy || 'Unknown',
          tasks: Object.fromEntries(state.tasks.map((t) => [t.id, { start: t.start, end: t.end, cost: t.cost || 0 }])),
        };
        bump();
        await persist(state);
        return send(res, 200, state.baseline, { ETag: etag() });
      }
      if (method === 'DELETE') {
        state.baseline = null;
        bump();
        await persist(state);
        res.writeHead(204, { ETag: etag() }); return res.end();
      }
    }

    if (resource === 'tasks') {
      if (method === 'POST') {
        const body = await readBody(req);
        const task = body.id ? body : makeTask(state.tasks, body);
        if (task.rev == null) task.rev = 1;
        stamp(task, req);                      // attribute the edit to the caller
        // guard against duplicate ids from the optimistic client
        if (!state.tasks.some((t) => t.id === task.id)) state.tasks.push(task);
        bump();
        await persist(state);
        return send(res, 201, task, { ETag: etag() });
      }
      if (method === 'PATCH' && id) {
        const t = state.tasks.find((x) => x.id === id);
        if (!t) return send(res, 404, { error: 'task not found' });
        // Optimistic concurrency: reject if the client's rev is stale.
        const ifMatch = req.headers['if-match'];
        if (ifMatch && ifMatch.replace(/"/g, '') !== String(t.rev || 1)) {
          return send(res, 409, { error: 'revision conflict', current: t }, { ETag: etag() });
        }
        applyTaskPatch(t, await readBody(req));
        stamp(t, req);
        t.rev = (t.rev || 1) + 1;
        bump();
        await persist(state);
        return send(res, 200, t, { ETag: etag() });
      }
      if (method === 'DELETE' && id) {
        state.tasks = state.tasks.filter((t) => t.id !== id);
        state.tasks.forEach((t) => { t.dependencies = t.dependencies.filter((d) => d !== id); });
        bump();
        await persist(state);
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
server.listen(PORT, () => {
  console.log(`\n  BuildFlow ERP Schedule  →  http://localhost:${PORT}`);
  console.log(`  REST API                →  http://localhost:${PORT}/api/state`);
  console.log(`  Persisting to           →  ${path.relative(ROOT, DATA_FILE)}\n`);
});
