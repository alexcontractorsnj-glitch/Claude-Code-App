// ============================================================================
//  leveling.js — Resource leveling (pure functions, no DOM).
//  Detects crew over-allocation: a crew assigned to two tasks whose date
//  ranges overlap is double-booked. Also packs each crew's tasks into lanes
//  (greedy interval colouring) so the Resources view can show concurrency.
// ============================================================================
import { Dates } from './seed.js';
import { computeCriticalPath } from './cpm.js';

const overlaps = (a, b) => a.start <= b.end && b.start <= a.end;

// Assigned, schedulable work for a crew (milestones carry no resource load).
function crewTasks(tasks, crewId) {
  return tasks
    .filter((t) => t.crewId === crewId && !t.milestone)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

// Every distinct overlapping pair for a crew → a conflict record.
export function detectConflicts(tasks) {
  const crews = [...new Set(tasks.filter((t) => t.crewId && !t.milestone).map((t) => t.crewId))];
  const conflicts = [];
  crews.forEach((crewId) => {
    const list = crewTasks(tasks, crewId);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[j].start > list[i].end) break;        // sorted → no later task can overlap
        if (overlaps(list[i], list[j])) {
          const from = list[i].start > list[j].start ? list[i].start : list[j].start;
          const to = list[i].end < list[j].end ? list[i].end : list[j].end;
          conflicts.push({ crewId, a: list[i], b: list[j], from, to, days: Dates.diffDays(from, to) + 1 });
        }
      }
    }
  });
  return conflicts;
}

// Set of task ids involved in at least one conflict (for highlighting).
export function conflictTaskIds(tasks) {
  const ids = new Set();
  detectConflicts(tasks).forEach((c) => { ids.add(c.a.id); ids.add(c.b.id); });
  return ids;
}

// Would assigning `crewId` over [start,end] collide with that crew's existing
// work? Returns the overlapping tasks (excluding `selfId`). Used by the editor.
export function assignmentConflicts(tasks, crewId, start, end, selfId) {
  if (!crewId) return [];
  return tasks.filter((t) =>
    t.crewId === crewId && !t.milestone && t.id !== selfId &&
    overlaps({ start, end }, t));
}

// Greedy lane packing for one crew: each task gets the first lane whose last
// task ends before it starts. Lane count = peak concurrency (1 = no conflict).
export function packLanes(tasks, crewId) {
  const list = crewTasks(tasks, crewId);
  const laneEnds = [];        // last end date per lane
  const placed = list.map((t) => {
    let lane = laneEnds.findIndex((end) => end < t.start);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(t.end); }
    else laneEnds[lane] = t.end;
    return { task: t, lane };
  });
  return { placed, lanes: Math.max(1, laneEnds.length) };
}

// Portfolio summary for the KPI bar.
export function levelingSummary(tasks) {
  const conflicts = detectConflicts(tasks);
  const crews = new Set(conflicts.map((c) => c.crewId));
  return { conflictPairs: conflicts.length, crewsOverallocated: crews.size, taskIds: conflictTaskIds(tasks) };
}

// ---------------------------------------------------------------------------
//  Auto-leveling — a serial schedule-generation scheme over a day-indexed
//  timeline. Walks tasks in dependency (topological) order and places each at
//  the earliest date that respects its finish-to-start predecessors and its
//  crew's capacity (one task at a time per crew). Tasks only move LATER.
//
//  Options:
//    protectCritical  critical-path tasks get crew priority (non-critical work
//                     absorbs the delay) so the end date is protected.
//    freezeStarted    done / in-progress / already-started tasks are pinned at
//                     their current dates and just reserve their crew slot.
//    maxPushDays      cap how far any task may be pushed; a task that can't fit
//                     within the cap is clamped (may leave a residual conflict).
//  Pure + deterministic. Returns the proposed changes (only tasks that move).
// ---------------------------------------------------------------------------
const EPOCH = '2000-01-01';
const di = (d) => Dates.diffDays(EPOCH, d);            // date → day index
const dd = (i) => Dates.addDays(EPOCH, i);            // day index → date

// First start >= earliest where [start, start+len-1] hits no busy interval.
function firstFreeSlot(busy, earliest, len) {
  let s = earliest;
  const sorted = [...busy].sort((a, b) => a[0] - b[0]);
  let moved = true;
  while (moved) {
    moved = false;
    for (const [bs, be] of sorted) {
      if (s <= be && (s + len - 1) >= bs) { s = be + 1; moved = true; }
    }
  }
  return s;
}

export function proposeLeveling(tasks, opts = {}) {
  const { protectCritical = false, freezeStarted = false, maxPushDays = Infinity } = opts;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const dur = (t) => Math.max(1, Dates.diffDays(t.start, t.end) + 1);
  const critical = protectCritical ? computeCriticalPath(tasks) : new Set();
  // Freeze work that has genuinely started — done or in-progress. (A late but
  // not-started task is behind schedule, not "started", so it stays movable;
  // pinning it could strand it before a predecessor that legitimately moves.)
  const isFrozen = (t) => freezeStarted && !t.milestone &&
    (t.status === 'done' || t.status === 'in-progress');

  // Topological order; ties: critical first (if protecting), then start, then id.
  const rank = (id) => {
    const t = byId.get(id);
    return [protectCritical && critical.has(id) ? 0 : 1, di(t.start), t.id];
  };
  const cmpIds = (a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || (ra[2] < rb[2] ? -1 : ra[2] > rb[2] ? 1 : 0);
  };
  const indeg = new Map(tasks.map((t) => [t.id, 0]));
  const succ = new Map(tasks.map((t) => [t.id, []]));
  tasks.forEach((t) => (t.dependencies || []).forEach((d) => {
    if (byId.has(d)) { indeg.set(t.id, indeg.get(t.id) + 1); succ.get(d).push(t.id); }
  }));
  const ready = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id).sort(cmpIds);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    succ.get(id).forEach((s) => { indeg.set(s, indeg.get(s) - 1); if (indeg.get(s) === 0) ready.push(s); });
    ready.sort(cmpIds);
  }
  tasks.forEach((t) => { if (!order.includes(t.id)) order.push(t.id); });

  const schedEnd = new Map();   // id → finish (day index)
  const busy = new Map();       // crew → [ [startIdx,endIdx], ... ]
  const reserve = (crew, a, b) => { if (!busy.has(crew)) busy.set(crew, []); busy.get(crew).push([a, b]); };
  const changes = [];

  order.forEach((id) => {
    const t = byId.get(id);
    const len = dur(t);
    const oldS = di(t.start), oldE = di(t.end);

    if (isFrozen(t)) {                       // pinned — keep dates, just hold the slot
      schedEnd.set(id, oldE);
      if (t.crewId && !t.milestone) reserve(t.crewId, oldS, oldE);
      return;
    }

    let earliest = oldS;
    (t.dependencies || []).forEach((dep) => {
      if (schedEnd.has(dep)) earliest = Math.max(earliest, schedEnd.get(dep) + 1);
    });

    let startIdx;
    if (t.crewId && !t.milestone) {
      const desired = firstFreeSlot(busy.get(t.crewId) || [], earliest, len);
      const capped = Math.min(desired, oldS + maxPushDays);   // horizon is a soft cap…
      startIdx = Math.max(earliest, capped);                  // …but never break a dependency
      reserve(t.crewId, startIdx, startIdx + len - 1);
    } else {
      startIdx = earliest;                                    // no crew → just satisfy deps
    }
    const endIdx = t.milestone ? startIdx : startIdx + len - 1;
    schedEnd.set(id, endIdx);

    if (startIdx !== oldS) {
      changes.push({
        id, name: t.name, projectId: t.projectId,
        oldStart: t.start, oldEnd: t.end, newStart: dd(startIdx), newEnd: dd(endIdx),
        deltaDays: startIdx - oldS,
      });
    }
  });
  return changes;
}

// Apply a change list to a copy of the tasks (for previewing residual state).
export function applyChanges(tasks, changes) {
  const m = new Map(changes.map((c) => [c.id, c]));
  return tasks.map((t) => (m.has(t.id) ? { ...t, start: m.get(t.id).newStart, end: m.get(t.id).newEnd } : { ...t }));
}

