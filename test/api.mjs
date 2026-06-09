// ============================================================================
//  API / integration tests — boots server.mjs on a test port and exercises
//  auth, RBAC, project scope, and CRUD over HTTP. Run: npm test
//  Uses a fresh data dir (server writes ./data; we clean it around the run).
// ============================================================================
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PORT = process.env.TEST_PORT || 8399;
const BASE = `http://localhost:${PORT}`;
const DATA = join(ROOT, 'data');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  ✗ ' + m); } };

// cookie-jar fetch
let cookie = '';
async function http(method, path, body, headers = {}) {
  const h = { ...headers };
  if (body) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  let data = null; try { data = await res.json(); } catch { /* 204 */ }
  return { status: res.status, data, etag: res.headers.get('ETag') };
}
const login = async (u, p) => { cookie = ''; await http('POST', '/api/auth/login', { username: u, password: p }); };

rmSync(DATA, { recursive: true, force: true });
const srv = spawn('node', ['server.mjs', String(PORT)], { cwd: ROOT, stdio: 'ignore' });

async function ready() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/'); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

try {
  if (!await ready()) throw new Error('server did not start');

  // --- auth + RBAC ---
  ok((await http('GET', '/api/state')).status === 401, 'unauthenticated → 401');
  ok((await http('POST', '/api/auth/login', { username: 'admin', password: 'nope' })).status === 401, 'bad password → 401');
  await login('admin', 'admin123');
  ok((await http('GET', '/api/auth/me')).data.user.role === 'admin', 'admin session');
  ok((await http('GET', '/api/state')).status === 200, 'admin reads state');

  // attribution unspoofable
  const p = await http('PATCH', '/api/tasks/t1', { progress: 30 }, { 'If-Match': '"1"', 'X-User': 'SPOOF' });
  ok(p.data.lastEditedBy === 'System Admin', 'attribution from session, ignores X-User');

  // ETag / 304 / 409
  ok((await http('GET', '/api/state', null, { 'If-None-Match': (await http('GET', '/api/state')).etag })).status === 304, 'conditional GET → 304');
  ok((await http('PATCH', '/api/tasks/t1', { progress: 5 }, { 'If-Match': '"1"' })).status === 409, 'stale If-Match → 409');

  // viewer read-only
  await login('viewer', 'view123');
  ok((await http('GET', '/api/state')).status === 200, 'viewer reads');
  ok((await http('POST', '/api/baseline')).status === 403, 'viewer write → 403');
  ok((await http('GET', '/api/audit')).status === 403, 'viewer audit → 403');

  // scoped PM (awhitfield → p1)
  await login('awhitfield', 'build123');
  ok((await http('POST', '/api/docs', { kind: 'rfi', projectId: 'p1', title: 'x' })).status === 201, 'scoped PM writes own project');
  ok((await http('POST', '/api/docs', { kind: 'rfi', projectId: 'p2', title: 'x' })).status === 403, 'scoped PM other project → 403');
  ok((await http('POST', '/api/baseline')).status === 403, 'scoped PM baseline (needs unrestricted) → 403');

  // admin: billing, change orders, punch, reports + audit
  await login('admin', 'admin123');
  ok((await http('POST', '/api/billing', { projectId: 'p1', retainagePct: 5 })).data.number === 1, 'generate payment application');
  const co = await http('POST', '/api/changeorders', { projectId: 'p1', amount: 1000, status: 'draft' });
  ok((await http('PATCH', '/api/changeorders/' + co.data.id, { status: 'approved' })).data.approvedBy === 'System Admin', 'approve CO stamps approver');
  const pu = await http('POST', '/api/punch', { projectId: 'p1', title: 'crack', attachments: [{ url: 'http://x' }, {}] });
  ok(pu.data.attachments.length === 1, 'punch attachment sanitized');
  ok((await http('GET', '/api/tasks/t1/history')).data.length >= 1, 'per-task history');
  const actions = new Set((await http('GET', '/api/audit?all=1')).data.map((e) => e.action));
  ok(['billing.create', 'co.create', 'co.update', 'punch.create'].every((a) => actions.has(a)), 'audit captured new actions');

  // admin user management
  ok((await http('POST', '/api/users', { username: 'tmp', password: 'pw123456', role: 'pm' })).status === 201, 'admin creates user');
  ok((await http('DELETE', '/api/users/admin')).status === 400, 'cannot delete last admin');

  console.log(`\n${fail === 0 ? '✓' : '✗'} api: ${pass} passed, ${fail} failed`);
} catch (e) {
  console.error('api: harness error —', e.message);
  fail++;
} finally {
  srv.kill();
  rmSync(DATA, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
