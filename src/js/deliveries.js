// ============================================================================
//  deliveries.js — Material/equipment deliveries (pure). What the AI dispatcher
//  watches: each delivery has a due date + status, optionally tied to the task
//  it feeds. Shared by browser stores and the Node server.
// ============================================================================
import { Dates } from './seed.js';

export const DELIVERY_STATUSES = ['scheduled', 'confirmed', 'in-transit', 'delayed', 'delivered'];

export function makeDelivery(existing, partial) {
  const maxId = Math.max(0, ...(existing || []).map((d) => +String(d.id).slice(2) || 0));
  return {
    id: 'dl' + (maxId + 1),
    projectId: partial.projectId,
    item: partial.item || 'Material delivery',
    supplier: partial.supplier || '',
    qty: partial.qty || '',
    due: partial.due || Dates.today(),
    status: DELIVERY_STATUSES.includes(partial.status) ? partial.status : 'scheduled',
    taskId: partial.taskId || null,
    notes: partial.notes || '',
    createdBy: partial.createdBy || null,
    createdAt: partial.createdAt || new Date().toISOString(),
    updatedBy: partial.updatedBy || null,
    updatedAt: partial.updatedAt || null,
    rev: 1,
  };
}

export function deliveriesFor(list, projectId) {
  return (list || [])
    .filter((d) => projectId === 'all' || d.projectId === projectId)
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}

export const isOpenDelivery = (d) => d && d.status !== 'delivered';

// Risk assessment for a delivery at a given data date.
export function deliveryRisk(d, today = Dates.today()) {
  if (!d || d.status === 'delivered') return { late: false, dueSoon: false, days: null };
  const days = Dates.diffDays(today, d.due);
  return {
    days,
    late: days < 0 || d.status === 'delayed',
    dueSoon: days >= 0 && days <= 2,
  };
}

// Roll-up for a project (or all): counts by risk, for dashboards + the dispatcher.
export function deliverySummary(list, projectId, today = Dates.today()) {
  const ds = deliveriesFor(list, projectId);
  let late = 0, soon = 0, open = 0, delivered = 0;
  ds.forEach((d) => {
    if (d.status === 'delivered') { delivered += 1; return; }
    open += 1;
    const r = deliveryRisk(d, today);
    if (r.late) late += 1; else if (r.dueSoon) soon += 1;
  });
  return { total: ds.length, open, late, soon, delivered };
}
