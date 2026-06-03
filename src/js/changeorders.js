// ============================================================================
//  changeorders.js — Contract change orders (pure). Approved COs adjust the
//  contract sum (and schedule) and flow into the G702 billing summary.
// ============================================================================
export const CO_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'void'];
export const CO_TONE = { draft: 'muted', pending: 'warn', approved: 'good', rejected: 'bad', void: 'muted' };

export function nextCoNumber(cos, projectId) {
  const n = (cos || []).filter((c) => c.projectId === projectId).length + 1;
  return 'CO-' + String(n).padStart(3, '0');
}

export function makeChangeOrder(existing, partial) {
  const maxId = Math.max(0, ...(existing || []).map((c) => +String(c.id).slice(2) || 0));
  return {
    id: 'co' + (maxId + 1),
    projectId: partial.projectId,
    number: partial.number || nextCoNumber(existing, partial.projectId),
    title: partial.title || 'Change Order',
    description: partial.description || '',
    amount: Number(partial.amount) || 0,            // signed $ (negative = credit)
    days: Number(partial.days) || 0,                // schedule impact, days
    status: CO_STATUSES.includes(partial.status) ? partial.status : 'draft',
    createdBy: partial.createdBy || null,
    createdAt: partial.createdAt || new Date().toISOString(),
    approvedBy: partial.approvedBy || null,
    approvedAt: partial.approvedAt || null,
    rev: 1,
  };
}

const approved = (cos, projectId) => (cos || []).filter((c) => c.projectId === projectId && c.status === 'approved');

export const netApprovedAmount = (cos, projectId) => approved(cos, projectId).reduce((a, c) => a + (c.amount || 0), 0);
export const approvedDays = (cos, projectId) => approved(cos, projectId).reduce((a, c) => a + (c.days || 0), 0);

export function coSummary(cos, projectId) {
  const list = (cos || []).filter((c) => c.projectId === projectId);
  return {
    count: list.length,
    pending: list.filter((c) => c.status === 'pending').length,
    approvedAmount: netApprovedAmount(cos, projectId),
    approvedDays: approvedDays(cos, projectId),
  };
}
