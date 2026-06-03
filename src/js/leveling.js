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
