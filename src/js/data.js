// ============================================================================
//  data.js — Single source of truth for the BuildFlow ERP Schedule System
//  Construction-domain model: Projects → Tasks (work packages) with trades,
//  crews, finish-to-start dependencies, progress, and milestones.
//  Persisted to LocalStorage so the app is genuinely usable, not a mockup.
// ============================================================================

const STORAGE_KEY = 'buildflow.schedule.v1';

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
  parse: (s) => { const d = new Date(s + 'T00:00:00'); return d; },
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
function seed() {
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

  // Helper to build a task with a start offset (days from project start) + duration
  let n = 0;
  const mk = (proj, name, trade, crew, offset, dur, deps, progress, status, milestone = false) => {
    n += 1;
    const s = Dates.addDays(start, offset);
    const e = Dates.addDays(s, Math.max(0, dur - 1));
    return {
      id: 't' + n, projectId: proj, name, trade, crewId: crew,
      start: s, end: e, dependencies: deps, progress,
      status, milestone, priority: 'normal',
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

  return { projects, tasks, crews, version: 1 };
}

// --- Store: load / save / mutate -------------------------------------------
class Store {
  constructor() {
    this.listeners = new Set();
    this.state = this._load();
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* fall through to seed */ }
    const fresh = seed();
    this._persist(fresh);
    return fresh;
  }

  _persist(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { console.warn('Persist failed', e); }
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { this._persist(this.state); this.listeners.forEach((fn) => fn(this.state)); }

  // --- selectors ---
  get projects() { return this.state.projects; }
  get crews() { return this.state.crews; }
  tasks(projectId) {
    return projectId && projectId !== 'all'
      ? this.state.tasks.filter((t) => t.projectId === projectId)
      : this.state.tasks;
  }
  task(id) { return this.state.tasks.find((t) => t.id === id); }
  crew(id) { return this.state.crews.find((c) => c.id === id) || null; }
  project(id) { return this.state.projects.find((p) => p.id === id) || null; }

  // --- mutations ---
  updateTask(id, patch) {
    const t = this.task(id);
    if (!t) return;
    Object.assign(t, patch);
    // Keep status & progress coherent
    if (patch.progress != null) {
      if (patch.progress >= 100) t.status = 'done';
      else if (patch.progress > 0 && t.status === 'not-started') t.status = 'in-progress';
    }
    if (patch.status === 'done') t.progress = 100;
    if (patch.status === 'not-started' && t.progress === 100) t.progress = 0;
    this._emit();
  }

  addTask(task) {
    const id = 't' + (Math.max(0, ...this.state.tasks.map((t) => +t.id.slice(1))) + 1);
    const full = {
      id, projectId: task.projectId, name: task.name || 'New Task',
      trade: task.trade || 'sitework', crewId: task.crewId || null,
      start: task.start, end: task.end,
      dependencies: task.dependencies || [], progress: task.progress || 0,
      status: task.status || 'not-started', milestone: !!task.milestone,
      priority: task.priority || 'normal',
    };
    this.state.tasks.push(full);
    this._emit();
    return full;
  }

  deleteTask(id) {
    this.state.tasks = this.state.tasks.filter((t) => t.id !== id);
    // strip dangling dependencies
    this.state.tasks.forEach((t) => {
      t.dependencies = t.dependencies.filter((d) => d !== id);
    });
    this._emit();
  }

  reset() {
    this.state = seed();
    this._emit();
  }
}

export const store = new Store();

// ============================================================================
//  Critical Path Method (CPM) — forward/backward pass over the dependency DAG.
//  Returns a Set of task ids that lie on the critical path (zero total float).
// ============================================================================
export function computeCriticalPath(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const dur = (t) => Math.max(1, Dates.diffDays(t.start, t.end) + 1);

  // Topological order
  const indeg = new Map(tasks.map((t) => [t.id, 0]));
  tasks.forEach((t) => t.dependencies.forEach((d) => {
    if (byId.has(d)) indeg.set(t.id, (indeg.get(t.id) || 0) + 1);
  }));
  const queue = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  const order = [];
  const succ = new Map(tasks.map((t) => [t.id, []]));
  tasks.forEach((t) => t.dependencies.forEach((d) => {
    if (byId.has(d)) succ.get(d).push(t.id);
  }));
  const indegW = new Map(indeg);
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    succ.get(id).forEach((s) => {
      indegW.set(s, indegW.get(s) - 1);
      if (indegW.get(s) === 0) queue.push(s);
    });
  }

  // Forward pass: earliest start/finish (in "project days")
  const ES = new Map(), EF = new Map();
  order.forEach((id) => {
    const t = byId.get(id);
    const deps = t.dependencies.filter((d) => byId.has(d));
    const es = deps.length ? Math.max(...deps.map((d) => EF.get(d))) : 0;
    ES.set(id, es);
    EF.set(id, es + dur(t));
  });
  const projectEnd = Math.max(0, ...[...EF.values()]);

  // Backward pass: latest start/finish
  const LS = new Map(), LF = new Map();
  [...order].reverse().forEach((id) => {
    const t = byId.get(id);
    const sc = succ.get(id);
    const lf = sc.length ? Math.min(...sc.map((s) => LS.get(s))) : projectEnd;
    LF.set(id, lf);
    LS.set(id, lf - dur(t));
  });

  // Critical = zero total float
  const critical = new Set();
  order.forEach((id) => {
    if (Math.abs((LS.get(id) || 0) - (ES.get(id) || 0)) < 0.5) critical.add(id);
  });
  return critical;
}
