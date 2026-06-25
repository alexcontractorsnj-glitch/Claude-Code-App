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
const { bucketTasks, workSummary, stepProgress, coerceStatus, outboxAdd, outboxRemove, outboxSummary, applyPendingTasks, dueLabel } = await import('../src/mobile/core.js');
const { makeMessage, makeChannel, seedChannels, capChannel, setRead, lastRead, unreadCount, lastMessage, parseMentions, searchMessages, channelIdForProject, MSG_CAP, messagesForTask, taskActivityCount } = await import('../src/js/messaging.js');

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

section('corefield mobile (field core)');
const today = Dates.today();
const cfTasks = [
  { id: 'a', milestone: false, status: 'in-progress', start: Dates.addDays(today, -5), end: Dates.addDays(today, -1), progress: 40 }, // overdue
  { id: 'b', milestone: false, status: 'in-progress', start: Dates.addDays(today, -1), end: Dates.addDays(today, 3), progress: 20 },  // current
  { id: 'c', milestone: false, status: 'not-started', start: Dates.addDays(today, 4), end: Dates.addDays(today, 8), progress: 0 },    // upcoming
  { id: 'd', milestone: false, status: 'done', start: Dates.addDays(today, -10), end: Dates.addDays(today, -6), progress: 100 },      // done
  { id: 'm', milestone: true, status: 'not-started', start: Dates.addDays(today, 2), end: Dates.addDays(today, 2), progress: 0 },     // milestone
];
const buckets = bucketTasks(cfTasks, today);
ok(buckets.overdue.length === 1 && buckets.overdue[0].id === 'a', 'bucketTasks: overdue');
ok(buckets.current.length === 1 && buckets.current[0].id === 'b', 'bucketTasks: current');
ok(buckets.upcoming.length === 1 && buckets.upcoming[0].id === 'c', 'bucketTasks: upcoming');
ok(buckets.done.length === 1 && buckets.milestones.length === 1, 'bucketTasks: done + milestone lanes');
const ws = workSummary(cfTasks, today);
ok(ws.total === 4 && ws.overdue === 1 && ws.done === 1, 'workSummary counts exclude milestones');
ok(ws.progress === 40, 'workSummary avg progress'); // (40+20+0+100)/4

ok(stepProgress(40, 1) === 50 && stepProgress(0, -1) === 0 && stepProgress(90, 1) === 100, 'stepProgress clamps + snaps');
ok(coerceStatus(100, 'in-progress') === 'done', 'coerceStatus: 100% → done');
ok(coerceStatus(30, 'not-started') === 'in-progress', 'coerceStatus: progress starts work');
ok(coerceStatus(50, 'done') === 'in-progress', 'coerceStatus: <100 un-dones');

let q = [];
q = outboxAdd(q, { qid: 'q1', kind: 'task.patch', targetId: 'a', body: { progress: 60 } });
q = outboxAdd(q, { qid: 'q1', kind: 'task.patch', targetId: 'a', body: { progress: 75 } }); // de-dupe by qid
ok(q.length === 1 && q[0].body.progress === 75, 'outboxAdd de-dupes by qid');
q = outboxAdd(q, { qid: 'q2', kind: 'punch.patch', targetId: 'p1', body: { status: 'ready' } });
ok(outboxSummary(q).pending === 2 && outboxSummary(q).byKind['task.patch'] === 1, 'outboxSummary by kind');
const merged = applyPendingTasks(cfTasks, q);
ok(merged.find((t) => t.id === 'a').progress === 75 && merged.find((t) => t.id === 'a').pending === true, 'applyPendingTasks projects queued edits');
ok(merged.find((t) => t.id === 'a').status === 'in-progress', 'applyPendingTasks recomputes status');
ok(outboxRemove(q, 'q1').length === 1, 'outboxRemove drops by qid');

ok(dueLabel(Dates.addDays(today, -2), today).tone === 'bad', 'dueLabel: late = bad');
ok(dueLabel(today, today).text === 'due today', 'dueLabel: today');
ok(dueLabel(Dates.addDays(today, 5), today).tone === 'ok', 'dueLabel: far = ok');

section('messaging (channels + messages)');
ok(seed.channels.length === 3 && seed.channels[0].id === channelIdForProject(seed.projects[0].id), 'seed: one channel per project');
ok(seed.messages.length >= 6 && seed.messages.every((m) => m.id && m.channelId && m.authorName), 'seed messages well-formed');
const ch1 = channelIdForProject('p1');
let msgs = [];
msgs.push(makeMessage(msgs, { channelId: ch1, authorId: 'u1', authorName: 'U One', body: 'hi @bob', createdAt: '2026-06-01T10:00:00Z' }));
msgs.push(makeMessage(msgs, { channelId: ch1, authorId: 'u2', authorName: 'U Two', body: 'reply', createdAt: '2026-06-01T10:05:00Z' }));
ok(msgs[0].id === 'm1' && msgs[1].id === 'm2', 'message ids increment');
ok(parseMentions('hey @bob and @ann.lee, see @bob again').join(',') === 'bob,ann.lee', 'parseMentions dedupes');
ok(lastMessage(msgs, ch1).id === 'm2', 'lastMessage newest');
// unread for u2: m1 (from u1) is unread until read; own m2 never counts
ok(unreadCount(msgs, ch1, null, 'u2') === 1, 'unread excludes own + counts others');
const reads1 = setRead({}, 'u2', ch1, '2026-06-01T10:10:00Z');
ok(lastRead(reads1, 'u2', ch1) === '2026-06-01T10:10:00Z', 'setRead/lastRead roundtrip');
ok(unreadCount(msgs, ch1, lastRead(reads1, 'u2', ch1), 'u2') === 0, 'after read → zero unread');
ok(makeMessage([], { channelId: ch1, body: 'x'.repeat(5000) }).body.length === 4000, 'message body capped at MAX_BODY');
// cap: build CAP+5 messages then trim
let big = [];
for (let i = 0; i < MSG_CAP + 5; i++) big.push(makeMessage(big, { channelId: ch1, body: 'm' + i, createdAt: '2026-06-01T' + String(10 + Math.floor(i / 60)).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0') + ':00Z' }));
const capped = capChannel(big, ch1);
ok(capped.length === MSG_CAP, 'capChannel trims to MSG_CAP');
ok(capped[0].body === 'm5', 'capChannel keeps the most recent');
ok(searchMessages(msgs, 'REPLY').length === 1 && searchMessages(msgs, 'U One').length === 1, 'searchMessages by body + author');
ok(seedChannels(seed.projects).length === 3 && makeChannel({ projectId: 'pz' }).type === 'project', 'seedChannels/makeChannel');
const vmsg = makeMessage([], { channelId: ch1, body: '', voice: { id: 'v1', dur: 7, mime: 'audio/webm' } });
ok(vmsg.voice && vmsg.voice.id === 'v1' && vmsg.voice.dur === 7, 'message carries a voice ref');
ok(makeMessage([], { channelId: ch1, body: 'hi' }).voice === null, 'non-voice message has null voice');

section('deliveries + dispatcher');
const { makeDelivery, deliveryRisk, deliverySummary, deliveriesFor } = await import('../src/js/deliveries.js');
const { analyzeField, fallbackBrief, mentionsDispatcher, callSummary, fmtCallDur, DISPATCHER } = await import('../src/js/dispatcher.js');
ok(seed.deliveries.length === 6 && seed.deliveries.every((d) => d.id && d.due), 'seed has 6 deliveries');
ok(makeDelivery([], { projectId: 'p1', status: 'bogus' }).status === 'scheduled', 'delivery invalid status → default');
ok(deliveryRisk({ status: 'scheduled', due: Dates.addDays(Dates.today(), -3) }).late === true, 'deliveryRisk late');
ok(deliveryRisk({ status: 'delayed', due: Dates.addDays(Dates.today(), 5) }).late === true, 'delayed status counts as late');
ok(deliveryRisk({ status: 'scheduled', due: Dates.addDays(Dates.today(), 1) }).dueSoon === true, 'deliveryRisk due soon');
ok(deliveryRisk({ status: 'delivered', due: '2020-01-01' }).late === false, 'delivered never late');
const dsum = deliverySummary(seed.deliveries, 'all');
ok(dsum.late >= 2 && dsum.total === 6, 'deliverySummary counts late');
const findings = analyzeField(seed);
ok(findings.some((f) => f.kind === 'delivery-late' && f.channelId === channelIdForProject('p1')), 'dispatcher flags late delivery → project channel');
ok(findings.every((f) => f.key && f.channelId && f.severity), 'findings carry key/channel/severity');
ok(findings.length === new Set(findings.map((f) => f.key)).size, 'finding keys are unique (dedupe-able)');
ok(findings.some((f) => f.kind === 'constraint-overdue' && f.severity === 'high'), 'dispatcher flags overdue constraint');
const brief = fallbackBrief(seed, 'p1');
ok(/Deliveries:/.test(brief) && brief.length > 20, 'fallbackBrief produces a digest');
ok(/Constraints:/.test(brief) && /made ready/.test(brief), 'fallbackBrief includes constraint + % made ready line');
ok(mentionsDispatcher('hey @dispatcher whats up') && mentionsDispatcher('dispatcher: status?') && !mentionsDispatcher('no mention here'), 'mentionsDispatcher');
ok(DISPATCHER.id === 'dispatcher', 'dispatcher identity');
ok(fmtCallDur(0) === '0:00' && fmtCallDur(75) === '1:15' && fmtCallDur(3661) === '1h 01:01', 'fmtCallDur formats m:ss / h m:ss');
const recap = callSummary(seed, { taskId: 't4', callerName: 'A. Whitfield', peerName: 'D. Okafor', durationSec: 204, video: false });
ok(/📞 Call recap/.test(recap) && /A\. Whitfield ↔ D\. Okafor/.test(recap) && /audio · 3:24/.test(recap), 'callSummary header: people, media, duration');
ok(/Open follow-ups/.test(recap) && /🚧/.test(recap) && /⚠️/.test(recap), 'callSummary lists open constraints + issues on the task');
const recap2 = callSummary(seed, { taskId: 't1', callerName: 'A', peerName: 'B', durationSec: 30, video: true });
ok(/video/.test(recap2) && /nothing outstanding/.test(recap2), 'callSummary: clean task → nothing outstanding');

section('task activity (linkedTo)');
let tam = [];
tam.push(makeMessage(tam, { channelId: 'ch-p1', body: 'general chatter' }));
tam.push(makeMessage(tam, { channelId: 'ch-p1', body: 'on the footing', linkedTo: { kind: 'task', id: 't4' }, createdAt: '2026-06-01T09:00:00Z' }));
tam.push(makeMessage(tam, { channelId: 'ch-p1', body: 'footing follow-up', linkedTo: { kind: 'task', id: 't4' }, createdAt: '2026-06-01T10:00:00Z' }));
tam.push(makeMessage(tam, { channelId: 'ch-p1', body: 'about steel', linkedTo: { kind: 'task', id: 't7' } }));
ok(makeMessage([], { channelId: 'c', body: 'x' }).linkedTo === null, 'message linkedTo defaults null');
ok(messagesForTask(tam, 't4').length === 2 && taskActivityCount(tam, 't4') === 2, 'messagesForTask filters by task');
ok(messagesForTask(tam, 't4')[0].body === 'on the footing', 'task activity sorted oldest→newest');
ok(taskActivityCount(tam, 't7') === 1 && taskActivityCount(tam, 'tZ') === 0, 'taskActivityCount per task');
ok(!messagesForTask(tam, 't4').some((m) => m.body === 'general chatter'), 'general chatter excluded from task activity');

section('field issues');
const { makeIssue, issuesForTask, issueSummary, isOpenIssue } = await import('../src/js/issues.js');
ok(seed.issues.length === 3 && seed.issues[0].number === 'I-001', 'seed has 3 numbered issues');
ok(makeIssue([], { projectId: 'p1', severity: 'bogus' }).severity === 'normal', 'issue invalid severity → normal');
const il = [makeIssue([], { projectId: 'p1', taskId: 't4', severity: 'high' })];
il.push(makeIssue(il, { projectId: 'p1', taskId: 't4', status: 'resolved' }));
il.push(makeIssue(il, { projectId: 'p1', taskId: 't7' }));
ok(il[1].id === 'is2' && il[1].number === 'I-002', 'issue ids/numbers increment');
ok(issuesForTask(il, 't4').length === 2, 'issuesForTask filters');
const isum = issueSummary(il, 'p1');
ok(isum.total === 3 && isum.open === 2 && isum.highOpen === 1, 'issueSummary counts');
ok(isOpenIssue(il[0]) && !isOpenIssue(il[1]), 'isOpenIssue');

section('last-planner constraints');
const { makeConstraint, constraintsForTask, constraintSummary, madeReady, constraintOverdue, constraintDueSoon, isOpenConstraint } = await import('../src/js/constraints.js');
ok(seed.constraints.length === 9 && seed.constraints[0].number === 'C-001', 'seed has 9 numbered constraints');
ok(makeConstraint([], { projectId: 'p1', type: 'bogus' }).type === 'other', 'constraint invalid type → other');
const cl = [
  makeConstraint([], { projectId: 'p1', taskId: 't7', type: 'information', needBy: Dates.addDays(Dates.today(), -2) }), // open + overdue
  null, null,
];
cl[1] = makeConstraint(cl.filter(Boolean), { projectId: 'p1', taskId: 't7', status: 'cleared' });
cl[2] = makeConstraint(cl.filter(Boolean), { projectId: 'p1', taskId: 't8', status: 'cleared' });   // t8 fully cleared
ok(cl[0].id === 'cn1' && cl[1].number === 'C-002', 'constraint ids/numbers increment');
ok(constraintsForTask(cl, 't7').length === 2, 'constraintsForTask filters');
ok(constraintOverdue(cl[0]) && !constraintOverdue(cl[1]), 'constraintOverdue (open + past need-by)');
ok(constraintDueSoon(makeConstraint([], { projectId: 'p1', needBy: Dates.addDays(Dates.today(), 3) })), 'constraintDueSoon within lookahead');
ok(!constraintDueSoon(cl[1]), 'cleared constraint is not due-soon');
const csum = constraintSummary(cl, 'p1');
ok(csum.total === 3 && csum.open === 1 && csum.cleared === 2 && csum.overdue === 1, 'constraintSummary counts');
const mr = madeReady(cl, 'p1');
ok(mr.tasks === 2 && mr.ready === 1 && mr.percent === 50, 'madeReady: t8 ready, t7 blocked → 50%');
ok(madeReady([], 'p1').percent === null, 'madeReady null when no constraints');
ok(isOpenConstraint(cl[0]) && !isOpenConstraint(cl[1]), 'isOpenConstraint');

section('stateless sessions (survive restart)');
const auth = await import('../auth.js');
const findAdmin = (u) => (u === 'admin' ? { username: 'admin', name: 'Admin', role: 'admin', projects: [] } : null);
const tok = auth.createSession({ username: 'admin', name: 'Admin', role: 'admin', projects: [] });
ok(typeof tok === 'string' && tok.includes('.'), 'createSession returns a signed token');
ok(auth.getSession(tok, findAdmin)?.username === 'admin', 'valid token resolves the live user');
ok(auth.getSession(tok, () => null) === null, 'deleted user (findUser → null) is locked out');
ok(auth.getSession(tok + 'x', findAdmin) === null, 'tampered signature rejected');
ok(auth.getSession('garbage', findAdmin) === null && auth.getSession('', findAdmin) === null, 'malformed token rejected');
ok(auth.getSession(tok, findAdmin)?.role === 'admin', 'role comes from the LIVE user, not the token');

section('agent speech (TTS)');
const { speakable } = await import('../src/js/speech.js');
ok(speakable('🤖 Footing RFI-001 is overdue — chase the EOR.').includes('Footing RFI-001 is overdue'), 'speakable keeps the words');
ok(!/[🤖•*_]/.test(speakable('🤖 • *bold* `code`')), 'speakable strips emoji/markdown/bullets');
ok(speakable('   ') === '' && speakable(null) === '', 'speakable handles empty/null');

section('dictation language (EN/ES)');
const voiceMod = await import('../src/js/voice.js');
ok(voiceMod.getDictationLang() === 'en-US', 'default dictation language is English');
ok(voiceMod.cycleDictationLang() === 'es-US', 'cycle toggles English → Spanish');
ok(voiceMod.dictationLabel('en-US') === 'EN' && voiceMod.dictationLabel('es-US') === 'ES', 'dictationLabel EN/ES');
ok(voiceMod.DICTATION_LANGS.length === 2, 'two dictation languages configured');

console.log(`\n${fail === 0 ? '✓' : '✗'} units: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
