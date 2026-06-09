// ============================================================================
//  variance.js — Baseline vs. actual schedule variance (pure functions).
//  A baseline is a snapshot of planned { start, end, cost } per task. Variance
//  is measured in calendar days: positive = slipped later than planned.
// ============================================================================
import { Dates } from './seed.js';

// Per-task variance vs. baseline, or null if the task isn't in the baseline.
export function taskVariance(task, baseline) {
  const b = baseline && baseline.tasks && baseline.tasks[task.id];
  if (!b) return null;
  return {
    startVar: Dates.diffDays(b.start, task.start),  // +N = starts N days later
    finishVar: Dates.diffDays(b.end, task.end),     // +N = finishes N days later
    costVar: (task.cost || 0) - (b.cost || 0),      // +$ = over the planned cost
    baselineStart: b.start,
    baselineEnd: b.end,
  };
}

// Compare two baseline snapshots → how the *plan itself* changed between
// revisions (count of tasks whose planned start/end moved, plus added/removed).
export function compareBaselines(prev, next) {
  if (!prev || !next) return { changed: 0, added: 0, removed: 0 };
  const a = prev.tasks || {}, b = next.tasks || {};
  let changed = 0, added = 0, removed = 0;
  Object.keys(b).forEach((id) => {
    if (!a[id]) { added += 1; return; }
    if (a[id].start !== b[id].start || a[id].end !== b[id].end) changed += 1;
  });
  Object.keys(a).forEach((id) => { if (!b[id]) removed += 1; });
  return { changed, added, removed };
}

// Portfolio roll-up of schedule slip across a set of tasks.
export function scheduleVariance(tasks, baseline) {
  if (!baseline) return null;
  let counted = 0, slipped = 0, ahead = 0, sumFinish = 0, maxSlip = 0, worst = null;
  tasks.forEach((t) => {
    const v = taskVariance(t, baseline);
    if (!v) return;
    counted += 1;
    sumFinish += v.finishVar;
    if (v.finishVar > 0) slipped += 1;
    if (v.finishVar < 0) ahead += 1;
    if (v.finishVar > maxSlip) { maxSlip = v.finishVar; worst = t; }
  });
  return {
    counted, slipped, ahead, onPlan: counted - slipped - ahead,
    avgFinishVar: counted ? sumFinish / counted : 0,
    maxSlip, worst,
  };
}
