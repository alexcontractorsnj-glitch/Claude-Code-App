// ============================================================================
//  billing.js — Schedule of Values & progress billing (pure, AIA G702/G703).
//  A payment application snapshots each line item's completed-to-date value at
//  creation; the G703 continuation sheet and G702 summary are derived from the
//  app plus the previous application (for "from previous" / "less previous
//  certificates"). Line items come straight from cost-loaded tasks.
// ============================================================================

// Snapshot one task as a SOV line at the current progress.
export function lineFromTask(t) {
  return {
    taskId: t.id, name: t.name, trade: t.trade,
    scheduledValue: t.cost || 0,
    completedToDate: Math.round((t.cost || 0) * (t.progress || 0) / 100),
  };
}

// Build a new application's stored payload from the current schedule.
export function buildApplication(project, tasks, meta, prevApp) {
  return {
    projectId: project.id,
    number: meta.number,
    periodTo: meta.periodTo,
    retainagePct: meta.retainagePct,
    createdBy: meta.createdBy,
    createdAt: meta.createdAt,
    previousNumber: prevApp ? prevApp.number : null,
    lines: tasks.filter((t) => !t.milestone && (t.cost || 0) > 0).map(lineFromTask),
  };
}

const retainageOf = (app) => (app.lines || []).reduce((a, l) => a + Math.round(l.completedToDate * (app.retainagePct || 0) / 100), 0);
const completedOf = (app) => (app.lines || []).reduce((a, l) => a + l.completedToDate, 0);

// G703 rows: per line item, with "from previous", "this period", retainage, etc.
export function g703Rows(app, prevApp) {
  const prev = new Map((prevApp && prevApp.lines || []).map((l) => [l.taskId, l]));
  return (app.lines || []).map((l) => {
    const fromPrevious = (prev.get(l.taskId) || {}).completedToDate || 0;
    const retainage = Math.round(l.completedToDate * (app.retainagePct || 0) / 100);
    return {
      ...l,
      fromPrevious,
      thisPeriod: l.completedToDate - fromPrevious,
      percent: l.scheduledValue ? l.completedToDate / l.scheduledValue : 0,
      balanceToFinish: l.scheduledValue - l.completedToDate,
      retainage,
    };
  });
}

// G702 summary block. `netCo` = net approved change-order value (adjusts the
// contract sum to date), so the billing reflects the revised contract.
export function g702Summary(app, prevApp, netCo = 0) {
  const originalContractSum = (app.lines || []).reduce((a, l) => a + l.scheduledValue, 0);
  const contractSum = originalContractSum + (netCo || 0);   // contract sum to date
  const totalCompleted = completedOf(app);
  const totalRetainage = retainageOf(app);
  const earnedLessRetainage = totalCompleted - totalRetainage;
  const lessPrevious = prevApp ? (completedOf(prevApp) - retainageOf(prevApp)) : 0;
  return {
    originalContractSum,
    netChangeByCO: netCo || 0,
    contractSum,
    totalCompleted,
    totalRetainage,
    earnedLessRetainage,
    lessPrevious,
    currentPaymentDue: earnedLessRetainage - lessPrevious,
    balanceToFinish: contractSum - earnedLessRetainage,
    percentComplete: contractSum ? totalCompleted / contractSum : 0,
  };
}

// Helper: the applications for a project, in number order.
export function appsForProject(payApps, projectId) {
  return (payApps || []).filter((a) => a.projectId === projectId).sort((a, b) => a.number - b.number);
}
