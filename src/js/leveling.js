// ============================================================================
//  leveling.js — Resource leveling (pure functions, no DOM).
//  Detects crew over-allocation: a crew assigned to two tasks whose date
//  ranges overlap is double-booked. Also packs each crew's tasks into lanes
//  (greedy interval colouring) so the Resources view can show concurrency.
// ============================================================================
import { Dates } from './seed.js';

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
//  Auto-leveling — a serial schedule-generation scheme. Walks tasks in
//  dependency (topological) order, scheduling each at the earliest date that
//  respects (a) its finish-to-start predecessors and (b) its crew's capacity
//  (one task per crew at a time). Tasks only ever move LATER, never earlier, so
//  the result is a conflict-free, dependency-valid schedule. Pure + deterministic.
//  Returns the list of proposed changes (only tasks whose dates move).
// ---------------------------------------------------------------------------
const cmp = (a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export function proposeLeveling(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const dur = (t) => Math.max(1, Dates.diffDays(t.start, t.end) + 1);

  // Topological order, breaking ties by (start, id) for determinism.
  const indeg = new Map(tasks.map((t) => [t.id, 0]));
  const succ = new Map(tasks.map((t) => [t.id, []]));
  tasks.forEach((t) => (t.dependencies || []).forEach((d) => {
    if (byId.has(d)) { indeg.set(t.id, indeg.get(t.id) + 1); succ.get(d).push(t.id); }
  }));
  const ready = tasks.filter((t) => indeg.get(t.id) === 0).sort(cmp).map((t) => t.id);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    succ.get(id).forEach((s) => {
      indeg.set(s, indeg.get(s) - 1);
      if (indeg.get(s) === 0) ready.push(s);
    });
    ready.sort((a, b) => cmp(byId.get(a), byId.get(b)));
  }
  tasks.forEach((t) => { if (!order.includes(t.id)) order.push(t.id); }); // any cycle remnants

  const schedEnd = new Map();   // task id → scheduled finish
  const crewFree = new Map();   // crew id → next free date
  const changes = [];
  order.forEach((id) => {
    const t = byId.get(id);
    let start = t.start;
    (t.dependencies || []).forEach((dep) => {
      if (schedEnd.has(dep)) { const after = Dates.addDays(schedEnd.get(dep), 1); if (after > start) start = after; }
    });
    if (t.crewId && !t.milestone) { const cf = crewFree.get(t.crewId); if (cf && cf > start) start = cf; }
    const end = t.milestone ? start : Dates.addDays(start, dur(t) - 1);
    schedEnd.set(id, end);
    if (t.crewId && !t.milestone) crewFree.set(t.crewId, Dates.addDays(end, 1));
    if (start !== t.start || end !== t.end) {
      changes.push({
        id, name: t.name, projectId: t.projectId,
        oldStart: t.start, oldEnd: t.end, newStart: start, newEnd: end,
        deltaDays: Dates.diffDays(t.start, start),
      });
    }
  });
  return changes;
}

