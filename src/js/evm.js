// ============================================================================
//  evm.js — Earned Value Management (pure functions, no DOM).
//  Standard EVM at a "data date" (default: today):
//    BAC = budget at completion (Σ task cost)
//    PV  = planned value   (Σ cost × planned %-complete by schedule)
//    EV  = earned value    (Σ cost × actual %-complete)
//    AC  = actual cost     (Σ money spent)
//    CPI = EV / AC   (>1 under budget) ·  SPI = EV / PV   (>1 ahead)
//    CV  = EV − AC   ·  SV = EV − PV
//    EAC = BAC / CPI ·  ETC = EAC − AC ·  VAC = BAC − EAC
// ============================================================================
import { Dates } from './seed.js';

const bac = (t) => (t.milestone ? 0 : (t.cost || 0));
const ev  = (t) => bac(t) * ((t.progress || 0) / 100);
const ac  = (t) => (t.milestone ? 0 : (t.actualCost || 0));

// Fraction of a task that *should* be done by `date`, linearly across its span.
export function plannedFraction(t, date) {
  if (t.milestone) return date >= t.start ? 1 : 0;
  const dur = Dates.diffDays(t.start, t.end) + 1;
  if (date < t.start) return 0;
  if (date >= t.end) return 1;
  const elapsed = Dates.diffDays(t.start, date) + 1;
  return Math.max(0, Math.min(1, elapsed / dur));
}

export const taskPV = (t, date) => bac(t) * plannedFraction(t, date);

// Aggregate EVM metrics for a set of tasks at `dataDate`.
export function computeEVM(tasks, dataDate = Dates.today()) {
  let BAC = 0, PV = 0, EV = 0, AC = 0;
  tasks.forEach((t) => {
    BAC += bac(t);
    PV  += taskPV(t, dataDate);
    EV  += ev(t);
    AC  += ac(t);
  });
  const CPI = AC > 0 ? EV / AC : (EV > 0 ? Infinity : 1);
  const SPI = PV > 0 ? EV / PV : (EV > 0 ? Infinity : 1);
  const EAC = CPI > 0 && isFinite(CPI) ? BAC / CPI : BAC;
  return {
    BAC, PV, EV, AC,
    CPI, SPI,
    CV: EV - AC, SV: EV - PV,
    EAC, ETC: EAC - AC, VAC: BAC - EAC,
    percentComplete: BAC > 0 ? EV / BAC : 0,
    percentSpent: BAC > 0 ? AC / BAC : 0,
    percentPlanned: BAC > 0 ? PV / BAC : 0,
  };
}

// Cumulative planned-value S-curve sampled weekly across the schedule, plus the
// single EV/AC points at the data date and the projected EAC at completion.
export function evmSeries(tasks, dataDate = Dates.today(), samples = 28) {
  const work = tasks.filter((t) => !t.milestone && t.cost);
  if (!work.length) return { points: [], today: null, end: null, BAC: 0 };
  const min = work.map((t) => t.start).sort()[0];
  const max = work.map((t) => t.end).sort().slice(-1)[0];
  const totalDays = Math.max(1, Dates.diffDays(min, max));
  const step = Math.max(1, Math.round(totalDays / samples));

  const BAC = work.reduce((a, t) => a + (t.cost || 0), 0);
  const points = [];
  for (let d = 0; d <= totalDays; d += step) {
    const date = Dates.addDays(min, d);
    const pv = work.reduce((a, t) => a + taskPV(t, date), 0);
    points.push({ date, pv });
  }
  // ensure the final point lands exactly on project end (PV = BAC)
  if (points.length && points[points.length - 1].date !== max) {
    points.push({ date: max, pv: BAC });
  }
  const at = computeEVM(work, dataDate);
  return { points, BAC, start: min, end: max, today: dataDate, ev: at.EV, ac: at.AC, eac: at.EAC, pvNow: at.PV };
}

// Health verdict from a CPI/SPI pair → label + tone for the UI.
export function evmHealth(cpi, spi) {
  const worst = Math.min(cpi, spi);
  if (worst >= 0.99) return { label: 'On Track', tone: 'good' };
  if (worst >= 0.92) return { label: 'At Risk', tone: 'warn' };
  return { label: 'Critical', tone: 'bad' };
}
