// ============================================================================
//  Unit tests for BuildFlow's pure logic (no server, no DOM). Run: npm test
//  Browser globals are shimmed so the store module can import cleanly.
// ============================================================================
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.fetch = () => Promise.reject(new Error('offline (unit test)'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  ✗ ' + m); } };
const near = (a, b, e = 0.01) => Math.abs(a - b) < e;
const section = (n) => console.log('\n— ' + n);

const { seedState, normalizeState, nextBaselineId, Dates } = await import('../src/js/seed.js');
const { computeCriticalPath } = await import('../src/js/cpm.js');
const { computeEVM, plannedFraction, evmHealth } = await import('../src/js/evm.js');
const { taskVariance, scheduleVariance, compareBaselines } = await import('../src/js/variance.js');
const { detectConflicts, packLanes, assignmentConflicts, proposeLeveling, applyChanges } = await import('../src/js/leveling.js');
const { lineFromTask, buildApplication, g703Rows, g702Summary, appsForProject } = await import('../src/js/billing.js');
const { makeChangeOrder, netApprovedAmount } = await import('../src/js/changeorders.js');
const { makeReport, reportsFor } = await import('../src/js/fieldreports.js');
const { makeDoc, nextDocNumber, isOpen, overdueDocs } = await import('../src/js/docs.js');
const { makePunchItem, closeoutSummary, isOpenPunch, cleanAttachments } = await import('../src/js/punch.js');
const { computeAlerts, alertSummary } = await import('../src/js/alerts.js');

section('seed + dates');
const seed = seedState();
ok(seed.tasks.length === 25, 'seed has 25 tasks');
ok(seed.projects.length === 3 && seed.crews.length === 8, 'seed: 3 projects, 8 crews');
ok(Dates.diffDays('2026-01-01', '2026-01-08') === 7, 'diffDays');
ok(Dates.addDays('2026-01-30', 2) === '2026-02-01', 'addDays crosses month');
ok(nextBaselineId(seed.baselines) === 'b2', 'nextBaselineId');
ok(normalizeState({ tasks: [], baseline: { tasks: {} } }).baselines.length === 1, 'normalizeState migrates baseline');

section('CPM');
const cp = computeCriticalPath([
  { id: 'A', start: '2026-01-01', end: '2026-01-05', dependencies: [] },
  { id: 'B', start: '2026-01-06', end: '2026-01-10', dependencies: ['A'] },
  { id: 'C', start: '2026-01-11', end: '2026-01-15', dependencies: ['B'] },
  { id: 'D', start: '2026-01-06', end: '2026-01-07', dependencies: ['A'] },
]);
ok(cp.has('A') && cp.has('B') && cp.has('C') && !cp.has('D'), 'CPM flags chain, excludes slack');

section('EVM');
const past0 = Dates.addDays(Dates.today(), -20), past1 = Dates.addDays(Dates.today(), -10);
const m = computeEVM([{ id: 't', milestone: false, start: past0, end: past1, cost: 1000, progress: 50, actualCost: 600 }]);
ok(near(m.EV, 500) && near(m.AC, 600) && near(m.PV, 1000), 'EVM PV/EV/AC');
ok(near(m.CPI, 0.8333) && near(m.SPI, 0.5) && near(m.EAC, 1200), 'EVM CPI/SPI/EAC');
ok(plannedFraction({ start: past0, end: past1 }, Dates.today()) === 1, 'plannedFraction past = 1');
ok(evmHealth(0.8, 1).tone === 'bad' && evmHealth(1, 1).tone === 'good', 'evmHealth');

section('variance');
ok(taskVariance(seed.tasks.find((t) => t.id === 't4'), seed.baseline).finishVar === 2, 't4 drift +2');
ok(scheduleVariance(seed.tasks, seed.baseline).slipped >= 8, 'schedule variance slipped count');
ok(compareBaselines({ tasks: { a: { start: '1', end: '2' } } }, { tasks: { a: { start: '9', end: '2' }, b: {} } }).changed === 1, 'compareBaselines changed=1');

section('resource leveling');
const lvT = [
  { id: '1', crewId: 'X', milestone: false, start: '2026-01-01', end: '2026-01-10', dependencies: [] },
  { id: '2', crewId: 'X', milestone: false, start: '2026-01-05', end: '2026-01-15', dependencies: [] },
  { id: '3', crewId: 'X', milestone: false, start: '2026-02-01', end: '2026-02-05', dependencies: [] },
];
ok(detectConflicts(lvT).length === 1, 'one crew conflict');
ok(packLanes(lvT, 'X').lanes === 2, 'X needs 2 lanes');
ok(assignmentConflicts(lvT, 'X', '2026-01-08', '2026-01-09', '999').length === 2, 'assignment conflict count');
ok(detectConflicts(seed.tasks).length === 9, 'seed has 9 conflicts');
const leveled = applyChanges(seed.tasks, proposeLeveling(seed.tasks));
ok(detectConflicts(leveled).length === 0, 'auto-level resolves all conflicts');
ok(proposeLeveling(seed.tasks).every((c) => c.deltaDays >= 0), 'auto-level never moves earlier');
const crit = computeCriticalPath(seed.tasks);
const sum = (ch, pred) => ch.filter(pred).reduce((a, c) => a + Math.abs(c.deltaDays), 0);
ok(sum(proposeLeveling(seed.tasks, { protectCritical: true }), (c) => crit.has(c.id))
   < sum(proposeLeveling(seed.tasks), (c) => crit.has(c.id)), 'protectCritical reduces critical movement');
const depsValid = (ts) => { const x = new Map(ts.map((t) => [t.id, t])); return ts.every((t) => (t.dependencies || []).every((d) => !x.get(d) || t.start > x.get(d).end)); };
ok(depsValid(applyChanges(seed.tasks, proposeLeveling(seed.tasks, { freezeStarted: true, maxPushDays: 60 }))), 'leveling keeps deps valid');

section('billing (G702/G703 + change orders)');
const proj = { id: 'p1' };
const bt = [{ id: 't1', name: 'A', milestone: false, cost: 100000, progress: 50 }, { id: 't2', name: 'B', milestone: false, cost: 200000, progress: 25 }, { id: 'm', milestone: true, cost: 0, progress: 0 }];
const app1 = buildApplication(proj, bt, { number: 1, retainagePct: 10 }, null);
ok(app1.lines.length === 2, 'milestones excluded from SOV');
const s1 = g702Summary(app1, null);
ok(s1.contractSum === 300000 && s1.totalCompleted === 100000 && s1.totalRetainage === 10000, 'G702 totals');
ok(s1.currentPaymentDue === 90000, 'G702 current due');
bt[0].progress = 100; bt[1].progress = 50;
const app2 = buildApplication(proj, bt, { number: 2, retainagePct: 10 }, app1);
const s2 = g702Summary(app2, app1);
ok(s2.lessPrevious === 90000 && s2.currentPaymentDue === 90000, 'G702 less-previous chaining');
ok(g703Rows(app2, app1).find((r) => r.taskId === 't1').thisPeriod === 50000, 'G703 this-period');
const cos = []; cos.push(makeChangeOrder(cos, { projectId: 'p1', amount: 185000, status: 'approved' })); cos.push(makeChangeOrder(cos, { projectId: 'p1', amount: 50000, status: 'pending' }));
ok(netApprovedAmount(cos, 'p1') === 185000, 'net approved CO excludes pending');
ok(g702Summary(app1, null, 185000).contractSum === 485000, 'approved CO → contract to date');

section('documents');
ok(nextDocNumber([], 'rfi', 'p1') === 'RFI-001', 'doc numbering');
ok(makeDoc([], { kind: 'rfi', projectId: 'p1', status: 'bogus' }).status === 'open', 'doc invalid status → default');
ok(isOpen({ kind: 'submittal', status: 'under-review' }) && !isOpen({ kind: 'submittal', status: 'approved' }), 'doc isOpen');
ok(overdueDocs([{ kind: 'rfi', status: 'open', due: Dates.addDays(Dates.today(), -1) }]).length === 1, 'overdueDocs');

section('field reports');
ok(makeReport([], { projectId: 'p1', weather: 'bogus' }).weather === 'Clear', 'report invalid weather → Clear');
ok(reportsFor([{ id: 'fr1', projectId: 'p1', date: '2026-06-01' }, { id: 'fr2', projectId: 'p1', date: '2026-06-03' }], 'p1')[0].date === '2026-06-03', 'reportsFor newest first');

section('punch + attachments');
const pl = []; pl.push(makePunchItem(pl, { projectId: 'p1', priority: 'high', status: 'open' })); pl.push(makePunchItem(pl, { projectId: 'p1', status: 'accepted' }));
const cs = closeoutSummary(pl, 'p1');
ok(cs.blocking === 1 && cs.highOpen === 1 && near(cs.percentAccepted, 0.5), 'closeout summary');
ok(closeoutSummary([], 'p1').percentAccepted === 1, 'empty punch = ready');
ok(cleanAttachments([{ url: 'http://x' }, {}], 'me').length === 1, 'attachment sanitize drops empties');

section('alerts');
const al = computeAlerts(seed.tasks, seed.baseline, seed.docs, seed.punch);
ok(al.some((a) => a.type === 'milestone-overdue' || a.type === 'overdue'), 'alerts include overdue');
ok(al.some((a) => a.type === 'rfi-overdue'), 'alerts include overdue RFI');
ok(al.some((a) => a.type === 'punch-high'), 'alerts include high-priority punch');
ok(alertSummary(al).total === al.length, 'alert summary total');

console.log(`\n${fail === 0 ? '✓' : '✗'} units: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
