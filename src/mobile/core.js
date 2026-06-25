// ============================================================================
//  core.js — Corefield mobile, pure logic core (no DOM, no browser globals).
//  Imported by the mobile store/UI AND by the test suite, so the field-app
//  rules (task bucketing, progress stepping, status coherence, and the offline
//  write outbox) live in exactly one place and stay unit-testable.
//
//  Corefield is the on-site, phone-first companion to BuildFlow: a crew opens
//  it in the field to see today's work, bump % complete, log a daily report,
//  and clear punch items — even with no signal (writes queue and replay).
// ============================================================================

import { Dates } from '../js/seed.js';

// --- "My Work" bucketing ----------------------------------------------------
// A field worker cares about four lanes, in priority order: what's late, what's
// happening now, what's coming, and what's already done. Milestones are markers,
// not crew work, so they're surfaced separately (never in the work lanes).
export function bucketTasks(tasks, today = Dates.today()) {
  const overdue = [], current = [], upcoming = [], done = [], milestones = [];
  for (const t of tasks) {
    if (t.milestone) { if (t.status !== 'done') milestones.push(t); continue; }
    if (t.status === 'done') { done.push(t); continue; }
    if (t.end < today) overdue.push(t);
    else if (t.start <= today) current.push(t);   // started (or starts today) and not finished
    else upcoming.push(t);
  }
  const byEnd = (a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0);
  const byStart = (a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  return {
    overdue: overdue.sort(byEnd),
    current: current.sort(byEnd),
    upcoming: upcoming.sort(byStart),
    done: done.sort(byEnd),
    milestones: milestones.sort(byStart),
  };
}

// Compact counts for the home header / tab badges.
export function workSummary(tasks, today = Dates.today()) {
  const b = bucketTasks(tasks, today);
  const work = tasks.filter((t) => !t.milestone);
  const pct = work.length
    ? Math.round(work.reduce((a, t) => a + (t.progress || 0), 0) / work.length)
    : 0;
  return {
    overdue: b.overdue.length,
    current: b.current.length,
    upcoming: b.upcoming.length,
    done: b.done.length,
    total: work.length,
    progress: pct,
  };
}

// --- Progress stepping ------------------------------------------------------
// Field updates are coarse — thumb-friendly 25% steps, clamped to 0..100.
export const PROGRESS_STEP = 25;
export function stepProgress(progress, dir, step = PROGRESS_STEP) {
  const p = Number(progress) || 0;
  // Move to the next grid line in the step direction (so 40 +1 → 50, not 75).
  const next = dir > 0 ? (Math.floor(p / step) + 1) * step : (Math.ceil(p / step) - 1) * step;
  return Math.max(0, Math.min(100, next));
}

// Mirror the server's progress/status coherence (seed.applyTaskPatch) so the
// optimistic UI shows the same status the API will compute. Pure.
export function coerceStatus(progress, status) {
  const p = Number(progress) || 0;
  if (p >= 100) return 'done';
  if (status === 'done' && p < 100) return 'in-progress';
  if (p > 0 && status === 'not-started') return 'in-progress';
  return status;
}

// --- Offline write outbox ---------------------------------------------------
// On a job site signal drops constantly. Writes that can't reach the server are
// queued here (persisted by the store) and replayed in order when back online.
// These reducers are pure: they take a queue + op and return a new queue.
export function outboxAdd(queue, op) {
  // De-dupe by qid so a retried enqueue can't double-post.
  return [...queue.filter((o) => o.qid !== op.qid), op];
}
export function outboxRemove(queue, qid) {
  return queue.filter((o) => o.qid !== qid);
}
export function outboxSummary(queue) {
  const by = {};
  for (const o of queue) by[o.kind] = (by[o.kind] || 0) + 1;
  return { pending: queue.length, byKind: by };
}

// Project queued task PATCHes onto a freshly-fetched task list so unsynced
// field edits stay visible after a reload/poll (last write per task wins).
export function applyPendingTasks(tasks, queue) {
  const patches = new Map();
  for (const o of queue) {
    if (o.kind === 'task.patch' && o.targetId) {
      patches.set(o.targetId, { ...(patches.get(o.targetId) || {}), ...o.body });
    }
  }
  if (!patches.size) return tasks;
  return tasks.map((t) => {
    const p = patches.get(t.id);
    if (!p) return t;
    const merged = { ...t, ...p, pending: true };
    if (p.progress != null) merged.status = coerceStatus(p.progress, merged.status);
    if (p.status != null) merged.status = p.status;
    return merged;
  });
}

// --- Small presentation helpers (pure) --------------------------------------
export function initials(name) {
  return String(name || '?')
    .split(/[\s.]+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join('') || '?';
}

// "in 3 days" / "2 days late" / "today" — a field-friendly due readout.
export function dueLabel(end, today = Dates.today()) {
  const d = Dates.diffDays(today, end);
  if (d === 0) return { text: 'due today', tone: 'warn' };
  if (d < 0) return { text: `${-d} day${d === -1 ? '' : 's'} late`, tone: 'bad' };
  if (d <= 2) return { text: `due in ${d} day${d === 1 ? '' : 's'}`, tone: 'warn' };
  return { text: `due in ${d} days`, tone: 'ok' };
}
