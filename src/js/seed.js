// ============================================================================
//  seed.js — Shared, environment-agnostic domain core.
//  Imported by BOTH the browser (data.js) and the Node API server (server.mjs),
//  so the seed data + date math + constants live in exactly one place.
//  No browser-only or node-only globals in here.
// ============================================================================

export const SCHEMA_VERSION = 1;

import { seedChannels, makeMessage, channelIdForProject } from './messaging.js';
import { makeDelivery } from './deliveries.js';

// --- Construction trades (drives color + grouping) --------------------------
export const TRADES = {
  sitework:    { label: 'Sitework / Excavation', color: '#8d6e63' },
  foundation:  { label: 'Foundation / Concrete', color: '#607d8b' },
  structure:   { label: 'Structural / Steel',    color: '#455a64' },
  framing:     { label: 'Framing',               color: '#ff8f00' },
  envelope:    { label: 'Envelope / Roofing',    color: '#5d4037' },
  mep:         { label: 'MEP (Mech/Elec/Plumb)', color: '#1976d2' },
  finishes:    { label: 'Interior Finishes',     color: '#7b1fa2' },
  sitefinish:  { label: 'Site / Landscaping',    color: '#388e3c' },
  inspection:  { label: 'Inspection / Closeout',  color: '#c62828' },
};

export const STATUSES = {
  'not-started': { label: 'Not Started', color: '#9e9e9e' },
  'in-progress': { label: 'In Progress', color: '#1e88e5' },
  'blocked':     { label: 'Blocked',     color: '#e53935' },
  'done':        { label: 'Done',        color: '#43a047' },
};

export const STATUS_ORDER = ['not-started', 'in-progress', 'blocked', 'done'];

// --- Date helpers -----------------------------------------------------------
export const Dates = {
  parse: (s) => new Date(s + 'T00:00:00'),
  iso: (d) => {
    const dt = (d instanceof Date) ? d : new Date(d);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },
  addDays: (s, n) => {
    const d = Dates.parse(typeof s === 'string' ? s : Dates.iso(s));
    d.setDate(d.getDate() + n);
    return Dates.iso(d);
  },
  diffDays: (a, b) => {
    const d1 = Dates.parse(typeof a === 'string' ? a : Dates.iso(a));
    const d2 = Dates.parse(typeof b === 'string' ? b : Dates.iso(b));
    return Math.round((d2 - d1) / 86400000);
  },
  today: () => Dates.iso(new Date()),
  fmt: (s) => {
    const d = Dates.parse(typeof s === 'string' ? s : Dates.iso(s));
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  },
  fmtLong: (s) => {
    const d = Dates.parse(typeof s === 'string' ? s : Dates.iso(s));
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  },
};

// --- Seed data: a realistic mid-rise commercial build -----------------------
// Anchored relative to "today" so the Gantt/today-line always look alive.
export function seedState() {
  const t0 = Dates.today();
  const start = Dates.addDays(t0, -28); // project began 4 weeks ago

  const crews = [
    { id: 'c1', name: 'Apex Earthworks',     trade: 'sitework',   lead: 'M. Rodriguez' },
    { id: 'c2', name: 'Ironclad Concrete',   trade: 'foundation', lead: 'D. Okafor' },
    { id: 'c3', name: 'Summit Steel Erectors', trade: 'structure', lead: 'J. Park' },
    { id: 'c4', name: 'Timberline Framing',  trade: 'framing',    lead: 'R. Alvarez' },
    { id: 'c5', name: 'Crown Roofing & Envelope', trade: 'envelope', lead: 'S. Chen' },
    { id: 'c6', name: 'Volt & Flow MEP',     trade: 'mep',        lead: 'T. Nguyen' },
    { id: 'c7', name: 'Finishline Interiors', trade: 'finishes',  lead: 'K. Adebayo' },
    { id: 'c8', name: 'GreenScape Site',     trade: 'sitefinish', lead: 'L. Moreau' },
  ];

  let n = 0;
  const mk = (proj, name, trade, crew, offset, dur, deps, progress, status, milestone = false) => {
    n += 1;
    const s = Dates.addDays(start, offset);
    const e = Dates.addDays(s, Math.max(0, dur - 1));
    return {
      id: 't' + n, projectId: proj, name, trade, crewId: crew,
      start: s, end: e, dependencies: deps, progress,
      status, milestone, priority: 'normal',
      cost: 0, actualCost: 0, rev: 1,   // cost loaded below; rev for optimistic locking
      lastEditedBy: null, lastEditedAt: null,
    };
  };

  const tasks = [
    // ---- P1: Riverside Commercial Complex ----
    mk('p1', 'Mobilization & Site Survey', 'sitework', 'c1', 0, 4, [], 100, 'done'),
    mk('p1', 'Clear & Grub / Excavation', 'sitework', 'c1', 4, 8, ['t1'], 100, 'done'),
    mk('p1', 'Underground Utilities', 'mep', 'c6', 12, 6, ['t2'], 100, 'done'),
    mk('p1', 'Footings & Foundation Pour', 'foundation', 'c2', 12, 10, ['t2'], 80, 'in-progress'),
    mk('p1', 'Foundation Cure & Strip', 'foundation', 'c2', 22, 5, ['t4'], 20, 'in-progress'),
    mk('p1', 'Foundation Inspection', 'inspection', null, 27, 1, ['t5'], 0, 'not-started', true),
    mk('p1', 'Structural Steel Erection', 'structure', 'c3', 28, 14, ['t6'], 0, 'not-started'),
    mk('p1', 'Metal Decking & Slabs', 'structure', 'c3', 40, 8, ['t7'], 0, 'not-started'),
    mk('p1', 'Exterior Framing', 'framing', 'c4', 46, 12, ['t8'], 0, 'not-started'),
    mk('p1', 'Roofing & Envelope Dry-In', 'envelope', 'c5', 56, 10, ['t9'], 0, 'blocked'),
    mk('p1', 'MEP Rough-In', 'mep', 'c6', 58, 16, ['t9'], 0, 'not-started'),
    mk('p1', 'Topping Out Milestone', 'structure', null, 48, 1, ['t8'], 0, 'not-started', true),
    mk('p1', 'Interior Finishes', 'finishes', 'c7', 74, 20, ['t10', 't11'], 0, 'not-started'),
    mk('p1', 'Final Inspection & TCO', 'inspection', null, 96, 2, ['t13'], 0, 'not-started', true),

    // ---- P2: Northgate Logistics Warehouse ----
    mk('p2', 'Site Grading & Pad Prep', 'sitework', 'c1', 6, 10, [], 100, 'done'),
    mk('p2', 'Tilt-Up Panel Casting', 'foundation', 'c2', 16, 12, ['t15'], 60, 'in-progress'),
    mk('p2', 'Panel Erection', 'structure', 'c3', 28, 8, ['t16'], 0, 'not-started'),
    mk('p2', 'Roof Joists & Deck', 'envelope', 'c5', 36, 10, ['t17'], 0, 'not-started'),
    mk('p2', 'Dock Equipment & MEP', 'mep', 'c6', 46, 12, ['t18'], 0, 'not-started'),
    mk('p2', 'Sitework & Paving', 'sitefinish', 'c8', 58, 14, ['t18'], 0, 'not-started'),

    // ---- P3: Civic Center Renovation ----
    mk('p3', 'Selective Demolition', 'sitework', 'c1', 2, 8, [], 100, 'done'),
    mk('p3', 'Structural Reinforcement', 'structure', 'c3', 10, 12, ['t21'], 45, 'in-progress'),
    mk('p3', 'MEP Upgrade Rough-In', 'mep', 'c6', 20, 15, ['t22'], 10, 'blocked'),
    mk('p3', 'Interior Buildout', 'finishes', 'c7', 35, 18, ['t23'], 0, 'not-started'),
    mk('p3', 'Landscaping & Plaza', 'sitefinish', 'c8', 50, 10, ['t24'], 0, 'not-started'),
  ];

  const projects = [
    { id: 'p1', name: 'Riverside Commercial Complex', client: 'Riverside Holdings LLC',
      location: 'Riverside, CA', color: '#1e88e5', budget: 14200000, manager: 'A. Whitfield' },
    { id: 'p2', name: 'Northgate Logistics Warehouse', client: 'Northgate Distribution',
      location: 'Reno, NV', color: '#43a047', budget: 8600000, manager: 'P. Sandoval' },
    { id: 'p3', name: 'Civic Center Renovation', client: 'City of Lakeview',
      location: 'Lakeview, OR', color: '#fb8c00', budget: 5300000, manager: 'C. Bauer' },
  ];

  // --- Cost-load each task (for Earned-Value reporting) --------------------
  // Split each project's contract value across its work packages, weighted by
  // duration. Milestones carry no cost. Actual cost is seeded with a small,
  // deterministic per-task variance so CPI/SPI are realistic (not all 1.00).
  projects.forEach((proj) => {
    const pts = tasks.filter((t) => t.projectId === proj.id && !t.milestone);
    const totalDur = pts.reduce((a, t) => a + (Dates.diffDays(t.start, t.end) + 1), 0) || 1;
    pts.forEach((t) => {
      const dur = Dates.diffDays(t.start, t.end) + 1;
      t.cost = Math.round((proj.budget * dur / totalDur) / 1000) * 1000; // BAC, to nearest $1k
      const earned = t.cost * (t.progress / 100);
      const idNum = +String(t.id).slice(1) || 0;
      const factor = 1 + (((idNum % 5) - 2) * 0.05); // 0.90 .. 1.10, deterministic
      t.actualCost = Math.round(earned * factor); // money spent so far
    });
  });

  // --- Capture a baseline from the planned dates, then drift "actuals" ------
  // A real project's current schedule slips from its original plan; we snapshot
  // the plan as the baseline, then push a few work packages out so the variance
  // view + Gantt ghost bars show meaningful slip out of the box.
  const baseline = {
    id: 'b1', label: 'Original Plan', savedAt: start, savedBy: 'Planning',
    tasks: Object.fromEntries(tasks.map((t) => [t.id, { start: t.start, end: t.end, cost: t.cost }])),
  };
  const drift = { t4: 2, t5: 3, t7: 4, t9: 3, t10: 6, t11: 4, t16: 3, t22: 4, t23: 7, t24: 5 };
  tasks.forEach((t) => {
    const d = drift[t.id];
    if (d) { t.start = Dates.addDays(t.start, d); t.end = Dates.addDays(t.end, d); }
  });

  // --- Seed a few project documents (submittals + RFIs) --------------------
  const t0i = Dates.today();
  const docs = [
    { id: 'd1', kind: 'submittal', projectId: 'p1', taskId: 't7', number: 'S-001', title: 'Structural steel shop drawings', status: 'under-review', court: 'Architect', due: Dates.addDays(t0i, 5), body: 'Shop drawings for primary steel frame, sequences A–C.', response: '', createdBy: 'A. Whitfield', createdAt: Dates.addDays(t0i, -6), updatedBy: null, updatedAt: null, rev: 1 },
    { id: 'd2', kind: 'submittal', projectId: 'p1', taskId: 't9', number: 'S-002', title: 'Exterior framing — cold-formed metal', status: 'approved', court: 'GC', due: null, body: 'Product data + calcs for CFMF.', response: 'Approved as noted.', createdBy: 'A. Whitfield', createdAt: Dates.addDays(t0i, -12), updatedBy: 'A. Whitfield', updatedAt: Dates.addDays(t0i, -3), rev: 2 },
    { id: 'd3', kind: 'rfi', projectId: 'p1', taskId: 't4', number: 'RFI-001', title: 'Footing rebar conflict at grid B-3', status: 'open', court: 'Structural Engineer', due: Dates.addDays(t0i, -2), body: 'Rebar congestion at pile cap conflicts with anchor bolts — clarify priority.', response: '', createdBy: 'A. Whitfield', createdAt: Dates.addDays(t0i, -4), updatedBy: null, updatedAt: null, rev: 1 },
    { id: 'd4', kind: 'rfi', projectId: 'p2', taskId: 't16', number: 'RFI-001', title: 'Tilt-up panel embed locations', status: 'answered', court: 'EOR', due: Dates.addDays(t0i, 3), body: 'Confirm embed plate layout for panels 4–7.', response: 'See sketch SK-12; embeds shifted 3" north.', createdBy: 'P. Sandoval', createdAt: Dates.addDays(t0i, -8), updatedBy: 'P. Sandoval', updatedAt: Dates.addDays(t0i, -1), rev: 2 },
    { id: 'd5', kind: 'submittal', projectId: 'p2', taskId: 't17', number: 'S-001', title: 'Roof joist & deck package', status: 'submitted', court: 'Architect', due: Dates.addDays(t0i, 10), body: 'Joist girder layout + deck attachment.', response: '', createdBy: 'P. Sandoval', createdAt: Dates.addDays(t0i, -2), updatedBy: null, updatedAt: null, rev: 1 },
    { id: 'd6', kind: 'rfi', projectId: 'p3', taskId: 't23', number: 'RFI-001', title: 'Existing MEP routing in chase 2', status: 'open', court: 'MEP Engineer', due: Dates.addDays(t0i, -5), body: 'As-builts disagree with field — confirm duct routing.', response: '', createdBy: 'P. Sandoval', createdAt: Dates.addDays(t0i, -7), updatedBy: null, updatedAt: null, rev: 1 },
  ];

  // --- Seed change orders + a few daily field reports ----------------------
  const changeOrders = [
    { id: 'co1', projectId: 'p1', number: 'CO-001', title: 'Added rooftop screen wall', description: 'Owner-requested architectural screen at mechanical units.', amount: 185000, days: 5, status: 'approved', createdBy: 'A. Whitfield', createdAt: Dates.addDays(t0i, -18), approvedBy: 'System Admin', approvedAt: Dates.addDays(t0i, -10), rev: 2 },
    { id: 'co2', projectId: 'p1', number: 'CO-002', title: 'Unforeseen rock excavation', description: 'Differing site condition — rock at footings, grid C–E.', amount: 92000, days: 8, status: 'pending', createdBy: 'A. Whitfield', createdAt: Dates.addDays(t0i, -3), approvedBy: null, approvedAt: null, rev: 1 },
    { id: 'co3', projectId: 'p2', number: 'CO-001', title: 'Dock leveler upgrade credit', description: 'Value-engineered leveler model — credit to owner.', amount: -24000, days: 0, status: 'approved', createdBy: 'P. Sandoval', createdAt: Dates.addDays(t0i, -14), approvedBy: 'System Admin', approvedAt: Dates.addDays(t0i, -9), rev: 2 },
  ];
  const reports = [
    { id: 'fr1', projectId: 'p1', date: Dates.addDays(t0i, -1), weather: 'Clear', tempLow: 52, tempHigh: 74, manpower: 18, workPerformed: 'Foundation pour grid A–C; stripped forms at grid D.', deliveries: 'Rebar (2 loads), formwork lumber.', delays: '', notes: 'Inspector on site AM; passed footing inspection.', attachments: [{ name: 'Pour progress', url: 'https://example.com/photos/pour-ac.jpg', caption: 'Grid A–C pour midday', addedBy: 'A. Whitfield', addedAt: Dates.addDays(t0i, -1) }], createdBy: 'A. Whitfield', createdAt: Dates.addDays(t0i, -1), rev: 1 },
    { id: 'fr2', projectId: 'p1', date: Dates.today(), weather: 'Rain', tempLow: 48, tempHigh: 60, manpower: 9, workPerformed: 'Limited work — cure & protect fresh concrete.', deliveries: '', delays: 'Rain delay PM; pump truck rescheduled.', notes: '', attachments: [], createdBy: 'A. Whitfield', createdAt: Dates.today(), rev: 1 },
    { id: 'fr3', projectId: 'p2', date: Dates.today(), weather: 'Windy', tempLow: 41, tempHigh: 58, manpower: 22, workPerformed: 'Tilt-up panel casting beds 4–7; embeds set.', deliveries: 'Concrete (6 trucks), embed plates.', delays: '', notes: 'High wind watch — crane ops monitored.', attachments: [], createdBy: 'P. Sandoval', createdAt: Dates.today(), rev: 1 },
  ];

  // --- Seed punch-list items -----------------------------------------------
  const punch = [
    { id: 'pi1', projectId: 'p1', taskId: 't4', number: 'P-001', title: 'Honeycombing at foundation wall NE corner', location: 'Grid A-1, footing', trade: 'foundation', status: 'open', priority: 'high', assignedTo: 'Ironclad Concrete', attachments: [{ name: 'NE corner photo', url: 'https://example.com/photos/ne-corner.jpg', caption: 'Voids visible at cold joint', addedBy: 'A. Whitfield', addedAt: Dates.addDays(t0i, -2) }], createdBy: 'A. Whitfield', createdAt: Dates.addDays(t0i, -2), updatedBy: null, updatedAt: null, rev: 1 },
    { id: 'pi2', projectId: 'p1', taskId: null, number: 'P-002', title: 'Touch-up paint at stair 2 handrail', location: 'Stair 2, L1', trade: 'finishes', status: 'ready', priority: 'low', assignedTo: 'Finishline Interiors', attachments: [], createdBy: 'A. Whitfield', createdAt: Dates.addDays(t0i, -1), updatedBy: null, updatedAt: null, rev: 1 },
    { id: 'pi3', projectId: 'p3', taskId: 't24', number: 'P-001', title: 'Ceiling tile alignment in lobby', location: 'Lobby grid', trade: 'finishes', status: 'accepted', priority: 'normal', assignedTo: 'Finishline Interiors', attachments: [], createdBy: 'P. Sandoval', createdAt: Dates.addDays(t0i, -5), updatedBy: 'P. Sandoval', updatedAt: Dates.addDays(t0i, -1), rev: 2 },
  ];

  // --- Seed material deliveries (some late / due-soon for the dispatcher) ---
  const deliveries = [];
  const dl = (projectId, item, supplier, dueOffset, status, taskId) => {
    deliveries.push(makeDelivery(deliveries, { projectId, item, supplier, due: Dates.addDays(t0i, dueOffset), status, taskId, createdBy: 'Planning', createdAt: Dates.addDays(t0i, -7) }));
  };
  dl('p1', 'Rebar — #5/#6 (footings)', 'Nucor Steel', -2, 'delayed', 't4');     // LATE
  dl('p1', 'Structural steel — sequence A', 'Summit Mill', 6, 'confirmed', 't7');
  dl('p1', 'Ready-mix concrete (foundation)', 'Riverside Concrete', 1, 'scheduled', 't5'); // due soon, unconfirmed
  dl('p2', 'Tilt-up embed plates', 'Dayton Superior', 0, 'scheduled', 't16');   // due TODAY, unconfirmed
  dl('p2', 'Roof joists & deck', 'Vulcraft', 9, 'scheduled', 't18');
  dl('p3', 'MEP rough-in package', 'Ferguson', -1, 'delayed', 't23');           // LATE

  // --- Seed team-messaging: one channel per project + a little chatter -------
  const channels = seedChannels(projects);
  const messages = [];
  const at = (mins) => new Date(Date.parse(t0i + 'T07:00:00') + mins * 60000).toISOString();
  const say = (projectId, authorId, authorName, body, mins) => {
    messages.push(makeMessage(messages, { channelId: channelIdForProject(projectId), authorId, authorName, body, createdAt: at(mins) }));
  };
  say('p1', 'awhitfield', 'A. Whitfield', 'Morning all — footing inspection at 9. Keep grid A–C clear for the inspector.', 0);
  say('p1', 'c2lead', 'D. Okafor', 'Copy. Forms stripped at D, we’re ready. Pump truck confirmed for 1pm.', 14);
  say('p1', 'awhitfield', 'A. Whitfield', 'Heads up @psandoval steel shop drawings still under review — may slip erection a day.', 33);
  say('p2', 'psandoval', 'P. Sandoval', 'Tilt-up beds 4–7 casting today. High-wind watch this afternoon — crane ops monitor.', 5);
  say('p2', 'c1lead', 'M. Rodriguez', 'Pad prep done. Embed plates delivered and staged.', 22);
  say('p3', 'psandoval', 'P. Sandoval', 'Civic: MEP rough-in still blocked on the chase-2 RFI. Chasing the engineer today.', 9);
  // `baseline` is the ACTIVE baseline (variance compares against it); `baselines`
  // is the full history. They share the same object reference for the active one.
  return { projects, tasks, crews, baseline, baselines: [baseline], payApps: [], docs, changeOrders, reports, punch, deliveries, channels, messages, reads: {}, dispatcher: { posted: {} }, version: SCHEMA_VERSION, rev: 1 };
}

// Next baseline id for a state (b1, b2, …).
export function nextBaselineId(baselines) {
  const max = Math.max(0, ...(baselines || []).map((b) => +String(b.id).slice(1) || 0));
  return 'b' + (max + 1);
}

// --- Pure helpers shared by client + server --------------------------------
// Build a fully-populated task from a partial, assigning a fresh id.
export function makeTask(existing, partial) {
  const maxId = Math.max(0, ...existing.map((t) => +String(t.id).slice(1) || 0));
  return {
    id: 't' + (maxId + 1),
    projectId: partial.projectId,
    name: partial.name || 'New Task',
    trade: partial.trade || 'sitework',
    crewId: partial.crewId || null,
    start: partial.start,
    end: partial.end,
    dependencies: partial.dependencies || [],
    progress: partial.progress || 0,
    status: partial.status || 'not-started',
    milestone: !!partial.milestone,
    priority: partial.priority || 'normal',
    cost: partial.cost || 0,
    actualCost: partial.actualCost || 0,
    rev: 1,
    lastEditedBy: partial.lastEditedBy || null,
    lastEditedAt: partial.lastEditedAt || null,
  };
}

// Apply a patch to a task with progress/status coherence rules. Mutates `t`.
// `rev` is managed by the caller (store/server) and never set from a patch.
export function applyTaskPatch(t, patch) {
  const { rev, id, ...safe } = patch; // never let a patch overwrite identity/rev
  Object.assign(t, safe);
  if (safe.progress != null) {
    if (safe.progress >= 100) t.status = 'done';
    else if (safe.progress > 0 && t.status === 'not-started') t.status = 'in-progress';
  }
  if (safe.status === 'done') t.progress = 100;
  if (safe.status === 'not-started' && t.progress === 100) t.progress = 0;
  return t;
}

// Backfill fields on a state loaded from disk/cache that predates newer schema
// additions (cost/actualCost/rev). Idempotent. Mutates and returns `state`.
export function normalizeState(state) {
  if (!state || !Array.isArray(state.tasks)) return seedState();
  if (state.rev == null) state.rev = 1;
  if (!Array.isArray(state.payApps)) state.payApps = [];
  if (!Array.isArray(state.docs)) state.docs = [];
  if (!Array.isArray(state.changeOrders)) state.changeOrders = [];
  if (!Array.isArray(state.reports)) state.reports = [];
  if (!Array.isArray(state.punch)) state.punch = [];
  // Messaging: ensure arrays + a default channel for every project.
  if (!Array.isArray(state.channels)) state.channels = [];
  if (!Array.isArray(state.messages)) state.messages = [];
  if (!Array.isArray(state.deliveries)) state.deliveries = [];
  if (!state.reads || typeof state.reads !== 'object') state.reads = {};
  if (!state.dispatcher || typeof state.dispatcher !== 'object') state.dispatcher = { posted: {} };
  if (!state.dispatcher.posted) state.dispatcher.posted = {};
  (state.projects || []).forEach((p) => {
    if (!state.channels.some((c) => c.id === channelIdForProject(p.id))) {
      state.channels.push({ id: channelIdForProject(p.id), type: 'project', projectId: p.id, name: p.name, memberIds: [], createdBy: null, createdAt: new Date().toISOString(), archived: false });
    }
  });
  state.reports.forEach((r) => { if (!Array.isArray(r.attachments)) r.attachments = []; });
  if (state.baseline === undefined) state.baseline = null;
  // Migrate single-baseline states to the baselines[] history model.
  if (!Array.isArray(state.baselines)) {
    state.baselines = state.baseline ? [state.baseline] : [];
  }
  state.baselines.forEach((b, i) => { if (!b.id) b.id = 'b' + (i + 1); if (!b.label) b.label = 'Baseline ' + (i + 1); });
  // Point the active baseline at its entry in the history (by id) when possible.
  if (state.baseline) {
    if (!state.baseline.id) state.baseline.id = state.baselines[0] && state.baselines[0].id;
    const match = state.baselines.find((b) => b.id === state.baseline.id);
    state.baseline = match || state.baseline;
  }
  state.tasks.forEach((t) => {
    if (t.cost == null) t.cost = 0;
    if (t.actualCost == null) t.actualCost = 0;
    if (t.rev == null) t.rev = 1;
    if (t.lastEditedBy === undefined) t.lastEditedBy = null;
    if (t.lastEditedAt === undefined) t.lastEditedAt = null;
    if (!Array.isArray(t.dependencies)) t.dependencies = [];
  });
  return state;
}
