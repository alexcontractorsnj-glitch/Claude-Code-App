// ============================================================================
//  dispatcher.js — The AI Dispatcher's brain (pure, no network/DOM).
//  • analyzeField()   → structured findings (late deliveries, overdue/blocked
//                       work, slipping milestones, overdue RFIs, high punch).
//  • fallbackBrief()  → a deterministic status digest used when no Claude key.
//  • DISPATCHER_TOOLS + dispatcherSystem() → the tool schema + system prompt the
//                       server hands to the Claude Messages API for the
//                       conversational, action-taking agent.
//  The server (server.mjs) owns the side-effects: posting messages, executing
//  tools against state, calling Claude. This module stays pure + testable.
// ============================================================================
import { Dates } from './seed.js';
import { computeAlerts } from './alerts.js';
import { deliveryRisk, deliverySummary, DELIVERY_STATUSES } from './deliveries.js';
import { channelIdForProject } from './messaging.js';

export const DISPATCHER = { id: 'dispatcher', name: 'Dispatcher 🤖' };

const RANK = { high: 0, medium: 1, low: 2 };
const ALERT_ICON = {
  overdue: '⏰', blocked: '⛔', 'milestone-overdue': '🏁', 'milestone-slip': '📉',
  slip: '📉', 'rfi-overdue': '❓', 'submittal-overdue': '📄', 'punch-high': '🔧',
};
const taskName = (state, id) => { const t = (state.tasks || []).find((x) => x.id === id); return t ? t.name : null; };

// The complete set of issues the dispatcher cares about, each tied to a project
// channel and given a stable `key` so the server won't re-post duplicates.
export function analyzeField(state, today = Dates.today()) {
  const findings = [];
  const add = (projectId, kind, severity, text, key) => {
    if (projectId) findings.push({ projectId, channelId: channelIdForProject(projectId), kind, severity, text, key });
  };

  (state.deliveries || []).forEach((d) => {
    if (d.status === 'delivered') return;
    const r = deliveryRisk(d, today);
    const feeds = taskName(state, d.taskId);
    if (r.late) {
      add(d.projectId, 'delivery-late', 'high',
        `🚚 Delivery “${d.item}”${d.supplier ? ` (${d.supplier})` : ''} is ${r.days < 0 ? `${-r.days} day(s) late` : 'flagged delayed'} — was due ${Dates.fmt(d.due)}.${feeds ? ` Puts “${feeds}” at risk.` : ''}`,
        'dl-late-' + d.id);
    } else if (r.dueSoon && d.status !== 'confirmed') {
      add(d.projectId, 'delivery-soon', 'medium',
        `🚚 “${d.item}” due ${r.days === 0 ? 'today' : `in ${r.days} day(s)`} and not yet confirmed${d.supplier ? ` with ${d.supplier}` : ''}.`,
        'dl-soon-' + d.id);
    }
  });

  (state.issues || []).forEach((iss) => {
    if (iss.status !== 'open' || iss.severity !== 'high') return;
    const on = taskName(state, iss.taskId);
    add(iss.projectId, 'issue-high', 'high', `⚠️ Field issue ${iss.number}: ${iss.title}${on ? ` (on “${on}”)` : ''}`, 'iss-' + iss.id);
  });

  computeAlerts(state.tasks || [], state.baseline, state.docs || [], state.punch || []).forEach((a) => {
    add(a.projectId, a.kind || a.type, a.severity === 'high' ? 'high' : a.severity === 'low' ? 'low' : 'medium',
      `${ALERT_ICON[a.type] || '•'} ${a.title}: ${a.message}`,
      'al-' + a.type + '-' + (a.taskId || a.docId || a.punchId || ''));
  });

  findings.sort((x, y) => RANK[x.severity] - RANK[y.severity]);
  return findings;
}

// A deterministic field digest — the dispatcher's reply when there's no API key
// (and a useful proactive summary in general).
export function fallbackBrief(state, projectId = 'all', today = Dates.today()) {
  const findings = analyzeField(state, today).filter((f) => projectId === 'all' || f.projectId === projectId);
  const ds = deliverySummary(state.deliveries, projectId, today);
  const lines = [];
  if (!findings.length) {
    lines.push('✅ Nothing flagged right now — deliveries on track, no overdue or blocked work.');
  } else {
    lines.push(`Here’s what needs attention (${findings.length}):`);
    findings.slice(0, 8).forEach((f) => lines.push('• ' + f.text));
    if (findings.length > 8) lines.push(`…and ${findings.length - 8} more.`);
  }
  lines.push(`Deliveries: ${ds.late} late · ${ds.soon} due soon · ${ds.open} open · ${ds.delivered} delivered.`);
  return lines.join('\n');
}

// --- Claude agent wiring (the server executes these) ------------------------
export const DISPATCHER_TOOLS = [
  { name: 'get_field_status', description: 'Read the current schedule + delivery status (counts, late/blocked items). Call this before answering status questions.', input_schema: { type: 'object', properties: { projectId: { type: 'string', description: 'a project id like p1/p2/p3, or omit for all projects' } } } },
  { name: 'reschedule_task', description: 'Move a task to new start and/or end dates (YYYY-MM-DD). Dependencies/progress rules apply server-side.', input_schema: { type: 'object', properties: { taskId: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } }, required: ['taskId'] } },
  { name: 'set_task_status', description: 'Set a task status.', input_schema: { type: 'object', properties: { taskId: { type: 'string' }, status: { type: 'string', enum: ['not-started', 'in-progress', 'blocked', 'done'] } }, required: ['taskId', 'status'] } },
  { name: 'update_delivery', description: 'Update a delivery’s status and/or due date (YYYY-MM-DD).', input_schema: { type: 'object', properties: { deliveryId: { type: 'string' }, status: { type: 'string', enum: DELIVERY_STATUSES }, due: { type: 'string' } }, required: ['deliveryId'] } },
  { name: 'create_punch_item', description: 'Create a punch-list deficiency item.', input_schema: { type: 'object', properties: { projectId: { type: 'string' }, title: { type: 'string' }, location: { type: 'string' }, priority: { type: 'string', enum: ['low', 'normal', 'high'] } }, required: ['projectId', 'title'] } },
];

export function dispatcherSystem(state, actorName) {
  const projects = (state.projects || []).map((p) => `${p.id}="${p.name}"`).join(', ');
  return [
    'You are the Dispatcher for BuildFlow, a construction scheduling system.',
    'You help field crews and project managers by answering questions and taking concrete actions on the schedule, deliveries, due dates, and field issues.',
    'Be concise and practical — people read this on a phone on a job site. Prefer short sentences and bullet points.',
    'Always call get_field_status to check current state before answering status questions or making changes.',
    'When you change something, state exactly what you changed and why. If a request is ambiguous or risky (e.g. moving the critical path), ask one brief clarifying question instead of guessing.',
    `You are replying to ${actorName || 'a user'}. Projects: ${projects}. Today is ${Dates.today()}.`,
  ].join(' ');
}

// Detect an @dispatcher mention in a message body.
export function mentionsDispatcher(body) {
  return /(^|\s)@?dispatcher\b/i.test(String(body || ''));
}
