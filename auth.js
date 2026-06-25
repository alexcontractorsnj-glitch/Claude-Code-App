// ============================================================================
//  auth.js — Server-side authentication & authorization (Node-only).
//  Real password hashing (scrypt + per-user salt), crypto-random session
//  tokens, login throttling, and role-based access control. Imported by
//  server.mjs only; never shipped to the browser.
//
//  Roles (ascending privilege):
//    viewer → read only
//    pm     → read + write (edit tasks, save baselines)
//    admin  → everything (reset, manage users)
// ============================================================================
import crypto from 'node:crypto';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 12 hours
const SESSION_TTL_S = 12 * 60 * 60;
const MAX_FAILS = 5;                           // per-username lockout threshold
const LOCK_MS = 60 * 1000;                     // lockout window after MAX_FAILS

// --- Password hashing (scrypt) ---------------------------------------------
export function hashPassword(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(pw, salt, 64, (err, dk) =>
      err ? reject(err) : resolve(salt + ':' + dk.toString('hex')));
  });
}

export function verifyPassword(pw, stored) {
  return new Promise((resolve) => {
    const [salt, key] = String(stored || '').split(':');
    if (!salt || !key) return resolve(false);
    crypto.scrypt(pw, salt, 64, (err, dk) => {
      if (err) return resolve(false);
      const keyBuf = Buffer.from(key, 'hex');
      // constant-time compare; lengths must match for timingSafeEqual
      resolve(keyBuf.length === dk.length && crypto.timingSafeEqual(keyBuf, dk));
    });
  });
}

// --- Seed demo users (passwords documented in README + login screen) -------
// `projects: []` means unrestricted (all projects). A non-empty list scopes a
// pm to only those project ids. Admins are always unrestricted.
export async function seedUsers() {
  const mk = async (username, name, role, pw, projects = []) =>
    ({ username, name, role, projects, passwordHash: await hashPassword(pw) });
  return [
    await mk('admin', 'System Admin', 'admin', 'admin123'),
    await mk('awhitfield', 'A. Whitfield', 'pm', 'build123', ['p1']),     // Riverside only
    await mk('psandoval', 'P. Sandoval', 'pm', 'north123', ['p2', 'p3']), // Northgate + Civic
    await mk('viewer', 'Client Viewer', 'viewer', 'view123'),
  ];
}

// --- Sessions (STATELESS, HMAC-signed) -------------------------------------
// A session is a signed token `payload.signature`, not a server-side row, so it
// SURVIVES server restarts / redeploys / free-tier sleep — the #1 cause of
// "it keeps logging me out / disconnecting" on ephemeral hosting. Set
// SESSION_SECRET in the environment (Render can generate + persist one) to keep
// the secret stable across restarts; without it a random per-boot secret is
// used and sessions reset on restart, exactly as the old in-memory map did.
const SECRET = (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16)
  ? process.env.SESSION_SECRET
  : crypto.randomBytes(32).toString('hex');

const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

export function createSession(user) {
  const payload = Buffer.from(JSON.stringify({ u: user.username, e: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return payload + '.' + sign(payload);
}

// Verify signature + expiry, then resolve the LIVE user via `findUser` so role/
// scope changes apply immediately and a deleted user is locked out at once
// (findUser returns undefined → null). No server-side state to lose on restart.
export function getSession(token, findUser) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || !data.u || !data.e || data.e < Date.now()) return null;
  const user = typeof findUser === 'function' ? findUser(data.u) : null;
  if (!user) return null;
  return { username: user.username, name: user.name, role: user.role, projects: Array.isArray(user.projects) ? user.projects : [] };
}

// Stateless tokens can't be revoked server-side; logout clears the cookie
// client-side, and role/delete changes take effect via the live lookup above.
export function destroySession() { /* no-op (stateless) */ }
export function destroyUserSessions() { /* no-op (stateless) */ }

// --- Login throttle (per username) -----------------------------------------
const attempts = new Map();   // username -> { fails, until }

export function isLockedOut(username) {
  const a = attempts.get(username);
  return !!(a && a.fails >= MAX_FAILS && a.until > Date.now());
}
export function recordFailure(username) {
  const a = attempts.get(username) || { fails: 0, until: 0 };
  a.fails += 1;
  if (a.fails >= MAX_FAILS) a.until = Date.now() + LOCK_MS;
  attempts.set(username, a);
}
export function clearFailures(username) { attempts.delete(username); }

// --- Role-based access control ---------------------------------------------
const RANK = { viewer: 0, pm: 1, admin: 2 };
export function can(role, action) {
  const r = RANK[role] ?? -1;
  if (action === 'read') return r >= 0;
  if (action === 'write') return r >= 1;
  if (action === 'admin') return r >= 2;
  return false;
}
export const isRole = (role) => Object.prototype.hasOwnProperty.call(RANK, role);

// Project scoping: admins and pms with an empty project list are unrestricted;
// otherwise a pm may only act on projects in their list.
export function isUnrestricted(user) {
  return !!user && (user.role === 'admin' || !Array.isArray(user.projects) || user.projects.length === 0);
}
export function canEditProject(user, projectId) {
  if (!can(user && user.role, 'write')) return false;
  return isUnrestricted(user) || user.projects.includes(projectId);
}

// --- Cookies ----------------------------------------------------------------
export function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (h) h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// NOTE: no `Secure` flag because the demo runs over plain HTTP on localhost.
// In production behind HTTPS, add `Secure` so the cookie is never sent in clear.
export const COOKIE = 'bf_session';
export function sessionCookie(token) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_S}`;
}
export function clearCookie() {
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

// Strip secrets before sending a user object to a client.
export const publicUser = (u) => ({
  username: u.username, name: u.name, role: u.role,
  projects: Array.isArray(u.projects) ? u.projects : [],
});
