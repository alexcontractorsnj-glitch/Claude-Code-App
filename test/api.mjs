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

  // --- messaging ---
  const chP1 = 'ch-p1';
  const sent = await http('POST', '/api/messages', { channelId: chP1, body: 'hello crew @viewer' });
  ok(sent.status === 201 && sent.data.authorId === 'admin' && sent.data.authorName === 'System Admin', 'message send: attributed to session');
  ok((await http('POST', '/api/messages', { channelId: 'ch-nope', body: 'x' })).status === 400, 'message to unknown channel → 400');
  ok((await http('POST', '/api/messages', { channelId: chP1, body: '' })).status === 400, 'empty message → 400');
  // viewer can read messages (in state) + post a read receipt, but cannot send
  await login('viewer', 'view123');
  ok((await http('GET', '/api/state')).data.messages.some((m) => m.channelId === chP1), 'viewer reads messages in state');
  ok((await http('POST', '/api/messages', { channelId: chP1, body: 'nope' })).status === 403, 'viewer cannot send → 403');
  ok((await http('POST', '/api/channels/' + chP1 + '/read', {})).status === 200, 'viewer can mark channel read');
  // scoped PM may post to own project channel, not others'
  await login('awhitfield', 'build123');
  ok((await http('POST', '/api/messages', { channelId: 'ch-p1', body: 'on it' })).status === 201, 'scoped PM posts to own channel');
  ok((await http('POST', '/api/messages', { channelId: 'ch-p2', body: 'nope' })).status === 403, 'scoped PM other channel → 403');
  await login('admin', 'admin123');
  ok((await http('GET', '/api/audit?all=1')).data.some((e) => e.action === 'message.send'), 'message.send audited');

  // --- photos on a task ---
  const pdata = Buffer.from('fake-image-bytes').toString('base64');
  const pup = await http('POST', '/api/photos', { mime: 'image/jpeg', data: pdata, w: 1280, h: 960 });
  ok(pup.status === 201 && pup.data.id && pup.data.w === 1280, 'photo upload → id + dims');
  const pmsg = await http('POST', '/api/messages', { channelId: 'ch-p1', photo: { id: pup.data.id }, linkedTo: { kind: 'task', id: 't4' } });
  ok(pmsg.status === 201 && pmsg.data.photo && pmsg.data.photo.id === pup.data.id && pmsg.data.linkedTo.id === 't4', 'photo message linked to task');
  ok(JSON.stringify(await http('GET', '/api/state')).indexOf(pdata) === -1, 'image bytes NOT in /api/state');
  const pfetch = await fetch(BASE + '/api/photos/' + pup.data.id, { headers: { Cookie: cookie } });
  ok(pfetch.status === 200 && pfetch.headers.get('content-type') === 'image/jpeg', 'photo GET streams image');
  ok((await http('POST', '/api/photos', { mime: 'image/jpeg', data: 'A'.repeat(1_900_000) })).status === 413, 'oversize photo → 413');
  await login('viewer', 'view123');
  ok((await http('POST', '/api/photos', { mime: 'image/jpeg', data: pdata })).status === 403, 'viewer cannot upload photo → 403');
  await login('admin', 'admin123');

  // task Activity — a message linked to a task (the task's slice of the channel)
  const tmsg = await http('POST', '/api/messages', { channelId: 'ch-p1', body: 'Footing rebar looks good', linkedTo: { kind: 'task', id: 't4' } });
  ok(tmsg.status === 201 && tmsg.data.linkedTo && tmsg.data.linkedTo.id === 't4', 'message carries linkedTo task');
  const stTask = (await http('GET', '/api/state')).data;
  ok(stTask.messages.filter((m) => m.linkedTo && m.linkedTo.kind === 'task' && m.linkedTo.id === 't4').length >= 1, 'linked message persisted in shared store (one source, two views)');

  // --- voice notes ---
  const b64 = Buffer.from('fake-audio-bytes').toString('base64');
  const up = await http('POST', '/api/voice', { mime: 'audio/webm', data: b64, dur: 5 });
  ok(up.status === 201 && up.data.id && up.data.dur === 5, 'voice upload → id');
  const vmsg = await http('POST', '/api/messages', { channelId: 'ch-p1', voice: { id: up.data.id } });
  ok(vmsg.status === 201 && vmsg.data.voice && vmsg.data.voice.id === up.data.id, 'voice message references the upload');
  ok(JSON.stringify(await http('GET', '/api/state')).indexOf(b64) === -1, 'audio bytes are NOT in /api/state (kept lean)');
  const fetched = await fetch(BASE + '/api/voice/' + up.data.id, { headers: { Cookie: cookie } });
  ok(fetched.status === 200 && fetched.headers.get('content-type') === 'audio/webm', 'voice GET streams audio');
  ok((await http('POST', '/api/voice', { mime: 'audio/webm', data: 'A'.repeat(1_500_000), dur: 99 })).status === 413, 'oversize voice → 413');
  await login('viewer', 'view123');
  ok((await http('POST', '/api/voice', { mime: 'audio/webm', data: b64, dur: 5 })).status === 403, 'viewer cannot upload voice → 403');
  await login('admin', 'admin123');

  // --- deliveries ---
  const del = await http('POST', '/api/deliveries', { projectId: 'p1', item: 'Anchor bolts', supplier: 'Hilti', due: '2026-01-01' });
  ok(del.status === 201 && del.data.id && del.data.status === 'scheduled', 'create delivery');
  ok((await http('PATCH', '/api/deliveries/' + del.data.id, { status: 'delivered' })).data.status === 'delivered', 'update delivery status');
  await login('awhitfield', 'build123');
  ok((await http('POST', '/api/deliveries', { projectId: 'p2', item: 'x' })).status === 403, 'scoped PM delivery other project → 403');
  await login('admin', 'admin123');
  ok((await http('DELETE', '/api/deliveries/' + del.data.id)).status === 204, 'delete delivery');

  // --- AI dispatcher (no key in test env → rule-based fallback) ---
  const scan = await http('POST', '/api/dispatcher/scan');
  ok(scan.status === 200 && scan.data.posted > 0, 'dispatcher scan posts proactive alerts');
  ok((await http('GET', '/api/state')).data.messages.some((m) => m.authorId === 'dispatcher'), 'dispatcher alert appears in a channel');
  ok((await http('GET', '/api/audit?all=1')).data.some((e) => e.action === 'dispatcher.alert'), 'dispatcher alert audited');
  let guard = 0;                                          // scan caps posts/run → drain the rest
  while ((await http('POST', '/api/dispatcher/scan')).data.posted > 0 && guard++ < 12) { /* drain */ }
  ok(guard < 12, 'dispatcher drains its backlog');
  ok((await http('POST', '/api/dispatcher/scan')).data.posted === 0, 'dispatcher dedupes — nothing new after drain');
  // @dispatcher mention → async reply (fallback digest when no key)
  const before = (await http('GET', '/api/state')).data.messages.filter((m) => m.authorId === 'dispatcher').length;
  await http('POST', '/api/messages', { channelId: 'ch-p1', body: '@dispatcher what is the status?' });
  await new Promise((r) => setTimeout(r, 500));
  const after = (await http('GET', '/api/state')).data.messages.filter((m) => m.authorId === 'dispatcher').length;
  ok(after > before, '@dispatcher mention triggers a reply');

  // --- field issues (flag → promote to punch/RFI) ---
  const iss = await http('POST', '/api/issues', { projectId: 'p1', taskId: 't4', title: 'Crack at grid C', severity: 'high' });
  ok(iss.status === 201 && iss.data.number && iss.data.status === 'open', 'create field issue');
  const promo = await http('POST', '/api/issues/' + iss.data.id + '/promote', { to: 'punch' });
  ok(promo.status === 200 && promo.data.created.kind === 'punch' && promo.data.issue.status === 'resolved' && promo.data.issue.promotedTo, 'promote issue → punch + auto-resolve');
  ok((await http('GET', '/api/state')).data.punch.some((p) => p.id === promo.data.created.id && p.taskId === 't4'), 'promoted punch item exists, linked to the task');
  const iss2 = await http('POST', '/api/issues', { projectId: 'p1', title: 'minor scuff' });
  ok((await http('PATCH', '/api/issues/' + iss2.data.id, { status: 'resolved' })).data.status === 'resolved', 'resolve issue');
  ok((await http('GET', '/api/audit?all=1')).data.some((e) => e.action === 'issue.promote'), 'issue.promote audited');
  await login('viewer', 'view123');
  ok((await http('POST', '/api/issues', { projectId: 'p1', title: 'x' })).status === 403, 'viewer cannot flag an issue → 403');
  await login('awhitfield', 'build123');
  ok((await http('POST', '/api/issues', { projectId: 'p2', title: 'x' })).status === 403, 'scoped PM flags other project → 403');
  await login('admin', 'admin123');

  // --- Last-Planner constraints (make-ready log) ---
  const cstr = await http('POST', '/api/constraints', { projectId: 'p1', taskId: 't9', title: 'Anchor bolt template approved', type: 'information', responsible: 'EOR', needBy: '2026-07-01' });
  ok(cstr.status === 201 && cstr.data.number && cstr.data.status === 'open' && cstr.data.type === 'information', 'create constraint');
  ok((await http('POST', '/api/constraints', { projectId: 'p1', title: 'bad', type: 'nope' })).data.type === 'other', 'invalid constraint type → other');
  const cleared = await http('PATCH', '/api/constraints/' + cstr.data.id, { status: 'cleared' });
  ok(cleared.status === 200 && cleared.data.status === 'cleared' && cleared.data.clearedBy, 'clear constraint stamps clearedBy');
  ok((await http('GET', '/api/state')).data.constraints.some((c) => c.id === cstr.data.id && c.status === 'cleared'), 'cleared constraint persisted in state');
  ok((await http('GET', '/api/audit?all=1')).data.some((e) => e.action === 'constraint.update'), 'constraint.update audited');
  ok((await http('DELETE', '/api/constraints/' + cstr.data.id)).status === 204, 'delete constraint');
  await login('viewer', 'view123');
  ok((await http('POST', '/api/constraints', { projectId: 'p1', title: 'x' })).status === 403, 'viewer cannot log a constraint → 403');
  await login('admin', 'admin123');

  // --- task-linked call recap (posts a dispatcher message into the task thread) ---
  const recap = await http('POST', '/api/tasks/t4/callsummary', { peerName: 'D. Okafor', durationSec: 204, video: false });
  ok(recap.status === 201 && recap.data.authorId === 'dispatcher' && recap.data.linkedTo && recap.data.linkedTo.id === 't4', 'call recap posted, linked to the task');
  ok(/📞 Call recap/.test(recap.data.body) && /3:24/.test(recap.data.body), 'recap body has header + duration');
  const tact = await http('GET', '/api/state');
  ok(tact.data.messages.some((m) => m.id === recap.data.id && m.linkedTo && m.linkedTo.id === 't4'), 'recap appears in the task activity (linkedTo)');
  ok((await http('POST', '/api/tasks/nope/callsummary', { durationSec: 5 })).status === 404, 'call recap for missing task → 404');

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
