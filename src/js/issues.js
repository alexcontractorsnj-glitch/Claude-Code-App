// ============================================================================
//  issues.js — Field issue flags (pure). A lightweight observation a crew raises
//  ON a task (title + severity, optional photo) that a PM can PROMOTE into a
//  formal punch item or RFI — the "informal capture, formal record" split.
//  Shared by the browser stores and the Node server.
// ============================================================================

export const ISSUE_SEVERITIES = ['low', 'normal', 'high'];
export const ISSUE_STATUSES = ['open', 'resolved'];

export function makeIssue(existing, partial) {
  const maxId = Math.max(0, ...(existing || []).map((i) => +String(i.id).slice(2) || 0));
  const n = maxId + 1;
  return {
    id: 'is' + n,
    number: 'I-' + String(n).padStart(3, '0'),
    projectId: partial.projectId,
    taskId: partial.taskId || null,
    title: partial.title || 'Field issue',
    severity: ISSUE_SEVERITIES.includes(partial.severity) ? partial.severity : 'normal',
    status: ISSUE_STATUSES.includes(partial.status) ? partial.status : 'open',
    photo: partial.photo || null,              // { id, mime } reference to /api/photos
    promotedTo: partial.promotedTo || null,    // { kind:'punch'|'rfi', id } once promoted
    createdBy: partial.createdBy || null,
    createdAt: partial.createdAt || new Date().toISOString(),
    resolvedBy: partial.resolvedBy || null,
    resolvedAt: partial.resolvedAt || null,
    rev: 1,
  };
}

export const isOpenIssue = (i) => !!i && i.status === 'open';

export function issuesForTask(issues, taskId) {
  return (issues || [])
    .filter((i) => i.taskId === taskId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
export function issuesForProject(issues, projectId) {
  return (issues || []).filter((i) => projectId === 'all' || i.projectId === projectId);
}

// Roll-up for dashboards / the dispatcher.
export function issueSummary(issues, projectId) {
  const list = issuesForProject(issues, projectId);
  return {
    total: list.length,
    open: list.filter((i) => i.status === 'open').length,
    highOpen: list.filter((i) => i.status === 'open' && i.severity === 'high').length,
    promoted: list.filter((i) => i.promotedTo).length,
  };
}
