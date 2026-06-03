// ============================================================================
//  alerts.js — Derived schedule alerts (pure). Surfaces milestones that have
//  slipped or come due, plus overdue and blocked work, from the live schedule
//  (and the active baseline, when set). No DOM, no network.
//
//  NOTE: this is the in-app notification *center*. Pushing these out over
//  email/webhook is a thin server extension (a job that POSTs new alerts to a
//  configured endpoint) — deliberately out of scope for the offline demo.
// ============================================================================
import { Dates } from './seed.js';
import { taskVariance } from './variance.js';

const RANK = { high: 0, medium: 1, low: 2 };

export function computeAlerts(tasks, baseline) {
  const today = Dates.today();
  const out = [];
  const push = (severity, type, t, message) =>
    out.push({ severity, type, taskId: t.id, projectId: t.projectId, title: t.name, message });

  tasks.forEach((t) => {
    if (t.status === 'done') return;
    const v = baseline ? taskVariance(t, baseline) : null;

    if (t.milestone) {
      if (t.end < today) push('high', 'milestone-overdue', t, `Milestone overdue — was due ${Dates.fmt(t.end)}`);
      else if (v && v.finishVar > 0) push('medium', 'milestone-slip', t, `Milestone slipped +${v.finishVar}d vs baseline (now ${Dates.fmt(t.end)})`);
      return;
    }
    if (t.end < today) push('high', 'overdue', t, `Overdue — was due ${Dates.fmt(t.end)} · ${t.progress}% done`);
    else if (t.status === 'blocked') push('medium', 'blocked', t, 'Blocked — needs attention');
    else if (v && v.finishVar >= 7) push('low', 'slip', t, `Slipping +${v.finishVar}d vs baseline`);
  });

  out.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.title < b.title ? -1 : 1));
  return out;
}

export function alertSummary(alerts) {
  return {
    total: alerts.length,
    high: alerts.filter((a) => a.severity === 'high').length,
    medium: alerts.filter((a) => a.severity === 'medium').length,
    low: alerts.filter((a) => a.severity === 'low').length,
  };
}
