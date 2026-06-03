// ============================================================================
//  cpm.js — Critical Path Method (pure). Forward/backward pass over the
//  dependency DAG → Set of task ids with zero total float (the critical path).
//  Kept dependency-free (only Dates) so leveling.js can use it too.
// ============================================================================
import { Dates } from './seed.js';

export function computeCriticalPath(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const deps = (t) => (t.dependencies || []);
  const dur = (t) => Math.max(1, Dates.diffDays(t.start, t.end) + 1);

  const indeg = new Map(tasks.map((t) => [t.id, 0]));
  tasks.forEach((t) => deps(t).forEach((d) => {
    if (byId.has(d)) indeg.set(t.id, (indeg.get(t.id) || 0) + 1);
  }));
  const succ = new Map(tasks.map((t) => [t.id, []]));
  tasks.forEach((t) => deps(t).forEach((d) => {
    if (byId.has(d)) succ.get(d).push(t.id);
  }));
  const queue = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  const order = [];
  const indegW = new Map(indeg);
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    succ.get(id).forEach((s) => {
      indegW.set(s, indegW.get(s) - 1);
      if (indegW.get(s) === 0) queue.push(s);
    });
  }

  const ES = new Map(), EF = new Map();
  order.forEach((id) => {
    const t = byId.get(id);
    const d = deps(t).filter((x) => byId.has(x));
    const es = d.length ? Math.max(...d.map((x) => EF.get(x))) : 0;
    ES.set(id, es);
    EF.set(id, es + dur(t));
  });
  const projectEnd = Math.max(0, ...[...EF.values()]);

  const LS = new Map(), LF = new Map();
  [...order].reverse().forEach((id) => {
    const t = byId.get(id);
    const sc = succ.get(id);
    const lf = sc.length ? Math.min(...sc.map((s) => LS.get(s))) : projectEnd;
    LF.set(id, lf);
    LS.set(id, lf - dur(t));
  });

  const critical = new Set();
  order.forEach((id) => {
    if (Math.abs((LS.get(id) || 0) - (ES.get(id) || 0)) < 0.5) critical.add(id);
  });
  return critical;
}
