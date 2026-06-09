// ============================================================================
//  docs.js — Submittals & RFIs (pure model + helpers). Both are "project
//  documents" with a kind-specific status workflow, optionally linked to a task.
// ============================================================================
import { Dates } from './seed.js';

export const DOC_KINDS = {
  submittal: {
    label: 'Submittal',
    statuses: ['draft', 'submitted', 'under-review', 'approved', 'revise-resubmit', 'rejected'],
    closed: ['approved', 'rejected'],
    bodyLabel: 'Description', responseLabel: 'Reviewer comments',
    courtLabel: 'Ball in court',
  },
  rfi: {
    label: 'RFI',
    statuses: ['open', 'answered', 'closed'],
    closed: ['closed'],
    bodyLabel: 'Question', responseLabel: 'Answer',
    courtLabel: 'Assigned to',
  },
};

export const STATUS_TONE = {
  draft: 'muted', submitted: 'info', 'under-review': 'warn', approved: 'good',
  'revise-resubmit': 'warn', rejected: 'bad', open: 'warn', answered: 'info', closed: 'good',
};

export const isOpen = (d) => !DOC_KINDS[d.kind].closed.includes(d.status);

// Next per-(kind,project) sequence number, formatted like S-001 / RFI-001.
export function nextDocNumber(docs, kind, projectId) {
  const n = (docs || []).filter((d) => d.kind === kind && d.projectId === projectId).length + 1;
  const prefix = kind === 'rfi' ? 'RFI' : 'S';
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

export function makeDoc(existing, partial) {
  const maxId = Math.max(0, ...(existing || []).map((d) => +String(d.id).slice(1) || 0));
  const kind = partial.kind === 'rfi' ? 'rfi' : 'submittal';
  return {
    id: 'd' + (maxId + 1),
    kind,
    projectId: partial.projectId,
    taskId: partial.taskId || null,
    number: partial.number || nextDocNumber(existing, kind, partial.projectId),
    title: partial.title || (kind === 'rfi' ? 'New RFI' : 'New Submittal'),
    status: DOC_KINDS[kind].statuses.includes(partial.status) ? partial.status : DOC_KINDS[kind].statuses[0],
    court: partial.court || '',
    due: partial.due || null,
    body: partial.body || '',
    response: partial.response || '',
    createdBy: partial.createdBy || null,
    createdAt: partial.createdAt || new Date().toISOString(),
    updatedBy: partial.updatedBy || null,
    updatedAt: partial.updatedAt || null,
    rev: 1,
  };
}

// Open documents past their due date (feeds the alert center).
export function overdueDocs(docs) {
  const today = Dates.today();
  return (docs || []).filter((d) => isOpen(d) && d.due && d.due < today);
}

export function docCounts(docs) {
  const open = (docs || []).filter(isOpen);
  return {
    total: (docs || []).length,
    open: open.length,
    overdue: overdueDocs(docs).length,
    rfisOpen: open.filter((d) => d.kind === 'rfi').length,
    submittalsOpen: open.filter((d) => d.kind === 'submittal').length,
  };
}
