// ============================================================================
//  constraints.js — Last-Planner constraint log (pure). In the Last Planner
//  System a task is not "ready" to be released to the field until every
//  constraint blocking it is removed. Each constraint is a thing that must be
//  in place first — material, information (RFI/submittal), labor, equipment,
//  predecessor work, a permit/approval, access, or a safety condition — owned
//  by a responsible party, with a need-by date, tracked open → cleared.
//
//  The headline metric is "% Made Ready" (PMR): of the tasks that carried
//  constraints, how many got fully cleared — i.e. made ready for work. A high,
//  steady PMR means the lookahead is actually de-risking the schedule.
//
//  Shared by the browser stores and the Node server.
// ============================================================================
import { Dates } from './seed.js';

// The constraint categories of the Last Planner lookahead (the "can it be made
// ready?" screen). Order is the display order; keys are stored on the record.
export const CONSTRAINT_TYPES = [
  'material', 'information', 'labor', 'equipment',
  'prerequisite', 'approval', 'access', 'safety', 'other',
];
export const CONSTRAINT_TYPE_LABELS = {
  material: 'Material', information: 'Information (RFI/submittal)', labor: 'Labor',
  equipment: 'Equipment', prerequisite: 'Prerequisite work', approval: 'Permit / approval',
  access: 'Access / space', safety: 'Safety', other: 'Other',
};
export const CONSTRAINT_STATUSES = ['open', 'cleared'];

export function makeConstraint(existing, partial) {
  const maxId = Math.max(0, ...(existing || []).map((c) => +String(c.id).slice(2) || 0));
  const n = maxId + 1;
  return {
    id: 'cn' + n,
    number: 'C-' + String(n).padStart(3, '0'),
    projectId: partial.projectId,
    taskId: partial.taskId || null,
    title: partial.title || 'Constraint',
    type: CONSTRAINT_TYPES.includes(partial.type) ? partial.type : 'other',
    responsible: partial.responsible || '',          // party who must clear it
    needBy: partial.needBy || null,                  // YYYY-MM-DD it must be cleared by
    status: CONSTRAINT_STATUSES.includes(partial.status) ? partial.status : 'open',
    notes: partial.notes || '',
    createdBy: partial.createdBy || null,
    createdAt: partial.createdAt || new Date().toISOString(),
    clearedBy: partial.clearedBy || null,
    clearedAt: partial.clearedAt || null,
    rev: 1,
  };
}

export const isOpenConstraint = (c) => !!c && c.status === 'open';

// Is an open constraint past its need-by date at the given data date?
export function constraintOverdue(c, today = Dates.today()) {
  return isOpenConstraint(c) && !!c.needBy && Dates.diffDays(today, c.needBy) < 0;
}
// Open + need-by within the next `within` days (default lookahead 6 weeks).
export function constraintDueSoon(c, today = Dates.today(), within = 42) {
  if (!isOpenConstraint(c) || !c.needBy) return false;
  const d = Dates.diffDays(today, c.needBy);
  return d >= 0 && d <= within;
}

export function constraintsForTask(list, taskId) {
  return (list || [])
    .filter((c) => c.taskId === taskId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
export function constraintsForProject(list, projectId) {
  return (list || []).filter((c) => projectId === 'all' || c.projectId === projectId);
}

// A task is "made ready" once it carried at least one constraint and none of
// them remain open. % Made Ready = made-ready tasks / tasks that had constraints.
export function madeReady(list, projectId, today = Dates.today()) {
  const cs = constraintsForProject(list, projectId);
  const byTask = new Map();
  cs.forEach((c) => {
    if (!c.taskId) return;
    const e = byTask.get(c.taskId) || { open: 0, total: 0 };
    e.total += 1;
    if (isOpenConstraint(c)) e.open += 1;
    byTask.set(c.taskId, e);
  });
  let ready = 0;
  byTask.forEach((e) => { if (e.open === 0) ready += 1; });
  const tasks = byTask.size;
  return {
    tasks,                                  // tasks carrying constraints
    ready,                                  // of those, fully de-constrained
    blocked: tasks - ready,                 // still have ≥1 open constraint
    percent: tasks ? Math.round((ready / tasks) * 100) : null,
    overdue: cs.filter((c) => constraintOverdue(c, today)).length,
  };
}

// Roll-up for dashboards / the dispatcher.
export function constraintSummary(list, projectId, today = Dates.today()) {
  const cs = constraintsForProject(list, projectId);
  return {
    total: cs.length,
    open: cs.filter(isOpenConstraint).length,
    cleared: cs.filter((c) => c.status === 'cleared').length,
    overdue: cs.filter((c) => constraintOverdue(c, today)).length,
    dueSoon: cs.filter((c) => constraintDueSoon(c, today)).length,
    pmr: madeReady(cs, projectId, today).percent,
  };
}
