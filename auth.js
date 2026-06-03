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
export async function seedUsers() {
  const mk = async (username, name, role, pw) =>
    ({ username, name, role, passwordHash: await hashPassword(pw) });
  return [
    await mk('admin', 'System Admin', 'admin', 'admin123'),
    await mk('awhitfield', 'A. Whitfield', 'pm', 'build123'),
    await mk('viewer', 'Client Viewer', 'viewer', 'view123'),
  ];
}

// --- Sessions (in-memory; cleared on restart) ------------------------------
const sessions = new Map();   // token -> { username, name, role, expires }

export function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    username: user.username, name: user.name, role: user.role,
    expires: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

export function getSession(token) {
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return s;
}

export function destroySession(token) { if (token) sessions.delete(token); }

// Drop every session belonging to a user (e.g. after delete / role change).
export function destroyUserSessions(username) {
  for (const [tok, s] of sessions) if (s.username === username) sessions.delete(tok);
}

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
export const publicUser = (u) => ({ username: u.username, name: u.name, role: u.role });
