// ============================================================================
//  punch.js — Punch list & closeout (pure). Punch items are deficiencies found
//  near completion that must be corrected & accepted before closeout. Includes
//  closeout-readiness roll-up and lightweight attachments (by reference).
// ============================================================================
export const PUNCH_STATUSES = ['open', 'ready', 'accepted', 'rejected'];
export const PUNCH_TONE = { open: 'warn', ready: 'info', accepted: 'good', rejected: 'bad' };
export const PUNCH_PRIORITIES = ['low', 'normal', 'high'];

export const isOpenPunch = (p) => p.status !== 'accepted';

export function nextPunchNumber(items, projectId) {
  const n = (items || []).filter((p) => p.projectId === projectId).length + 1;
  return 'P-' + String(n).padStart(3, '0');
}

// Sanitise attachments-by-reference (no binary upload: name + url + caption).
export function cleanAttachments(arr, user) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((a) => a && (a.url || a.name))
    .slice(0, 20)
    .map((a) => ({
      name: String(a.name || a.url || 'attachment').slice(0, 120),
      url: String(a.url || '').slice(0, 2000),
      caption: String(a.caption || '').slice(0, 200),
      addedBy: a.addedBy || user || null,
      addedAt: a.addedAt || new Date().toISOString(),
    }));
}

export function makePunchItem(existing, partial) {
  const maxId = Math.max(0, ...(existing || []).map((p) => +String(p.id).slice(2) || 0));
  return {
    id: 'pi' + (maxId + 1),
    projectId: partial.projectId,
    taskId: partial.taskId || null,
    number: partial.number || nextPunchNumber(existing, partial.projectId),
    title: partial.title || 'Punch item',
    location: partial.location || '',
    trade: partial.trade || 'finishes',
    status: PUNCH_STATUSES.includes(partial.status) ? partial.status : 'open',
    priority: PUNCH_PRIORITIES.includes(partial.priority) ? partial.priority : 'normal',
    assignedTo: partial.assignedTo || '',
    attachments: cleanAttachments(partial.attachments, partial.createdBy),
    createdBy: partial.createdBy || null,
    createdAt: partial.createdAt || new Date().toISOString(),
    updatedBy: partial.updatedBy || null,
    updatedAt: partial.updatedAt || null,
    rev: 1,
  };
}

// Closeout readiness for a project (or all).
export function closeoutSummary(items, projectId) {
  const list = (items || []).filter((p) => projectId === 'all' || p.projectId === projectId);
  const by = (s) => list.filter((p) => p.status === s).length;
  const accepted = by('accepted');
  return {
    total: list.length,
    open: by('open'),
    ready: by('ready'),
    accepted,
    rejected: by('rejected'),
    blocking: list.filter(isOpenPunch).length,                 // anything not accepted
    highOpen: list.filter((p) => isOpenPunch(p) && p.priority === 'high').length,
    percentAccepted: list.length ? accepted / list.length : 1,  // 100% when empty → ready
  };
}
