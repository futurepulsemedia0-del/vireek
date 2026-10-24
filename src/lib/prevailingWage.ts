/**
 * Prevailing-wage + overtime rules engine — pure, deterministic, no I/O.
 *
 * Everything here is data-driven: the wage table (determination + rates), the
 * overtime rule set, the worker's classification and fringe election all come
 * in as plain inputs, and the same inputs always produce the same output.
 * Persistence lives in prevailingWageApi.ts; exports live in prevailingWageExport.ts.
 *
 * LEGAL REVIEW REQUIRED. This is a calculation aid, not legal advice. Wage
 * determinations, classifications, apprentice ratios, fringe credit rules and
 * overtime rules differ by statute, contract and jurisdiction. A qualified
 * attorney or compliance professional must review every rate table and rule
 * set before it is used for certified payroll.
 *
 * Method (documented so it can be reviewed):
 *  1. All approved timesheet hours of an employee in the workweek are pooled
 *     (every job, prevailing-wage or not) — thresholds are about the person.
 *  2. Per day: hours above `dailyOtAfter` are overtime, above `dailyDtAfter`
 *     double-time. If the rule set has a seventh-day rule and the employee
 *     worked all 7 days, the 7th day is overtime for the first N hours, then
 *     double-time.
 *  3. Per week: straight-time hours above `weeklyOtAfter` become overtime.
 *     Hours already paid at a daily premium do not count again (no pyramiding).
 *  4. Weekend/holiday multipliers apply to the whole day; the highest
 *     applicable multiplier wins — premiums never stack.
 *  5. Each day's tier hours are shared across that day's timesheet rows in
 *     proportion to hours (largest-remainder, so no hour or cent is lost).
 *  6. Only rows of the job being reported are priced: base rate from the
 *     determination (effective-dated, by classification), fringe handled per
 *     the worker's plan contribution (rest paid in cash), overtime premium
 *     applied to the base rate (fringe straight-time unless the rule set says
 *     `multiplied`).
 *
 * Precision: hours are tracked in hundredths of an hour (36 s), money in
 * integer cents. Rounding is half-up and happens once per pay line.
 */

export const PW_ENGINE_VERSION = '1.0.0';

export const LEGAL_REVIEW_NOTICE =
  'Legal review required. Rates, classifications, overtime and fringe rules must be verified by a qualified attorney or compliance professional before use in certified payroll. This tool does not provide legal advice.';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export type LegalReviewStatus = 'unreviewed' | 'in_review' | 'approved';
export type SeventhDayRule = 'none' | 'ot_first_dt_after';
export type FringeOvertimeMode = 'straight' | 'multiplied';
export type HourTier = 'st' | 'ot' | 'dt';
export type HourType = 'ST' | 'OT' | 'DT' | 'PREM';
export type WarningSeverity = 'error' | 'warning' | 'info';

export interface OvertimeRuleSet {
  id: string;
  name: string;
  /** 0 = Sunday … 6 = Saturday. */
  workweekStartDow: number;
  dailyOtAfter: number | null;
  dailyDtAfter: number | null;
  weeklyOtAfter: number;
  seventhDayRule: SeventhDayRule;
  seventhDayOtHours: number;
  otMultiplier: number;
  dtMultiplier: number;
  saturdayMultiplier: number | null;
  sundayMultiplier: number | null;
  holidayMultiplier: number | null;
  /** ISO dates (YYYY-MM-DD). */
  holidays: string[];
  fringeOvertimeMode: FringeOvertimeMode;
  legalReviewStatus: LegalReviewStatus;
}

export interface WageRate {
  id: string;
  classification: string;
  /** ISO date the rate starts applying (inclusive). */
  effectiveFrom: string;
  /** ISO date the rate stops applying (inclusive) or null = open-ended. */
  effectiveTo: string | null;
  baseRateCents: number;
  fringeCents: number;
  isApprentice: boolean;
  otMultiplierOverride: number | null;
}

export interface WageDeterminationInfo {
  id: string;
  name: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  legalReviewStatus: LegalReviewStatus;
}

export interface TimeEntry {
  /** Timesheet row id. */
  id: string;
  employeeId: string;
  /** ISO work date. */
  workDate: string;
  hours: number;
  jobId: string | null;
}

export interface WorkerInfo {
  employeeId: string;
  name: string;
  /** Last four digits only — never store a full SSN here. */
  workerIdLast4?: string | null;
  address?: string | null;
  defaultClassification?: string | null;
  /** Cash hourly rate on file in Payroll → Employees. */
  hourlyRateCents?: number | null;
  /** Hourly contribution to bona fide plans (health, pension, …). */
  fringePlanCentsPerHour?: number;
}

export interface JobWorkerClassification {
  employeeId: string;
  classification: string;
  /** ISO date this classification starts applying for the job. */
  effectiveFrom: string;
}

export interface ComputeInput {
  jobId: string;
  /** Last day of the reported workweek (ISO). */
  weekEnding: string;
  rules: OvertimeRuleSet;
  determination: WageDeterminationInfo;
  rates: WageRate[];
  /** Approved timesheet rows for the workweek, ALL jobs of the employees. */
  entries: TimeEntry[];
  workers: WorkerInfo[];
  jobWorkerClasses: JobWorkerClassification[];
  /** Pending (not yet approved) timesheet rows excluded from the calculation. */
  pendingEntryCount?: number;
  /** True when other prevailing-wage jobs worked this week use a different rule set. */
  mixedRuleSets?: boolean;
}

export interface PwWarning {
  code: string;
  severity: WarningSeverity;
  message: string;
  employeeId?: string;
  date?: string;
}

export interface PayLine {
  key: string;
  employeeId: string;
  employeeName: string;
  classification: string;
  rateId: string;
  isApprentice: boolean;
  hourType: HourType;
  multiplierX100: number;
  /** Hours per day, aligned with ComputeResult.days. */
  dayHours: number[];
  hours: number;
  baseRateCents: number;
  /** Base hourly actually applied (prevailing, or higher when the rate on file is higher). */
  paidBaseCents: number;
  /** Cash hourly rate for this line: premium-adjusted base + fringe paid in cash. */
  cashHourlyCents: number;
  fringePlanHourlyCents: number;
  fringeCashHourlyCents: number;
  grossCashCents: number;
  fringePlanCents: number;
}

export interface EntryResult {
  entryId: string;
  employeeId: string;
  workDate: string;
  hours: number;
  status: 'priced' | 'no_classification' | 'no_rate';
  classification: string | null;
  hoursByType: Record<HourType, number>;
  grossCashCents: number;
  fringePlanCents: number;
}

export interface WorkerSummary {
  employeeId: string;
  name: string;
  address: string | null;
  workerIdLast4: string | null;
  classifications: string[];
  hours: number;
  straightHours: number;
  premiumHours: number;
  grossCashCents: number;
  fringePlanCents: number;
  unresolvedHours: number;
  hourlyRateCents: number | null;
}

export interface PayrollTotals {
  hours: number;
  straightHours: number;
  premiumHours: number;
  grossCashCents: number;
  fringePlanCents: number;
  /** Portion of grossCashCents that is fringe paid in cash. */
  fringeCashCents: number;
  totalCompCents: number;
  workerCount: number;
  unresolvedHours: number;
}

export interface ComputeResult {
  engineVersion: string;
  weekStart: string;
  weekEnding: string;
  days: string[];
  lines: PayLine[];
  entryResults: EntryResult[];
  workers: WorkerSummary[];
  warnings: PwWarning[];
  totals: PayrollTotals;
  /** Reasons certification must be blocked (empty = ready to certify). */
  certifyBlockers: string[];
}

// ------------------------------------------------------------------
// Dates (pure UTC string math — no timezone drift)
// ------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** First day of the workweek containing `date`. */
export function workweekStart(date: string, startDow: number): string {
  return addDays(date, -((dayOfWeek(date) - startDow + 7) % 7));
}

/** Last day of the workweek containing `date`. */
export function workweekEnding(date: string, startDow: number): string {
  return addDays(workweekStart(date, startDow), 6);
}

export function weekDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

// ------------------------------------------------------------------
// Number helpers
// ------------------------------------------------------------------

const toCenti = (hours: number): number => Math.round(hours * 100);
const toX100 = (multiplier: number): number => Math.round(multiplier * 100);
/** Half-up integer division for non-negative integers. */
const roundDiv = (a: number, b: number): number => Math.floor((a + b / 2) / b);

/**
 * Split an integer `total` across `weights` proportionally using the
 * largest-remainder method. Always sums exactly to `total`; ties go to the
 * earlier index so the result is deterministic.
 */
export function allocateProportional(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0 || sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map((r) => Math.floor(r));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k].i] += 1;
  return out;
}

/** Parse "1,234.50" / "$45" into integer cents. Null when not a valid non-negative amount. */
export function parseMoneyToCents(input: string): number | null {
  const s = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

export function formatMoney(cents: number | null | undefined): string {
  const v = (cents ?? 0) / 100;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatHours(hours: number): string {
  return (Math.round(hours * 100) / 100).toFixed(2).replace(/\.?0+$/, '') || '0';
}

const normClass = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

// ------------------------------------------------------------------
// Overtime bucketing
// ------------------------------------------------------------------

interface Bucket {
  st: number;
  ot: number;
  dt: number;
}

/** Split a workweek of per-day centi-hours into straight / overtime / double-time. */
export function bucketWeek(dayCenti: number[], rule: OvertimeRuleSet): Bucket[] {
  const dailyOt = rule.dailyOtAfter == null ? null : toCenti(rule.dailyOtAfter);
  const dailyDt = rule.dailyDtAfter == null ? null : toCenti(rule.dailyDtAfter);
  const weeklyOt = toCenti(rule.weeklyOtAfter);
  const seventhDay = rule.seventhDayRule === 'ot_first_dt_after' && dayCenti.length === 7 && dayCenti.every((h) => h > 0);
  let weeklyStraight = 0;

  return dayCenti.map((h, i) => {
    if (seventhDay && i === 6) {
      const ot = Math.min(h, toCenti(rule.seventhDayOtHours));
      return { st: 0, ot, dt: h - ot };
    }
    let dt = 0;
    let ot = 0;
    if (dailyDt !== null && h > dailyDt) dt = h - dailyDt;
    const upTo = dailyDt !== null ? Math.min(h, dailyDt) : h;
    if (dailyOt !== null && upTo > dailyOt) ot = upTo - dailyOt;
    let st = h - ot - dt;
    const room = Math.max(0, weeklyOt - weeklyStraight);
    const over = Math.max(0, st - room);
    st -= over;
    ot += over;
    weeklyStraight += st;
    return { st, ot, dt };
  });
}

/** Highest of the weekend / holiday multipliers that apply to `date` (100 = none). */
export function dayPremiumX100(date: string, rule: OvertimeRuleSet): number {
  let m = 100;
  const dow = dayOfWeek(date);
  if (dow === 6 && rule.saturdayMultiplier) m = Math.max(m, toX100(rule.saturdayMultiplier));
  if (dow === 0 && rule.sundayMultiplier) m = Math.max(m, toX100(rule.sundayMultiplier));
  if (rule.holidayMultiplier && rule.holidays.includes(date)) m = Math.max(m, toX100(rule.holidayMultiplier));
  return m;
}

// ------------------------------------------------------------------
// Rate resolution
// ------------------------------------------------------------------

/** The effective-dated rate for a classification on a date; latest start wins. */
export function resolveRate(rates: WageRate[], classification: string, date: string): WageRate | null {
  const key = normClass(classification);
  let best: WageRate | null = null;
  for (const r of rates) {
    if (normClass(r.classification) !== key) continue;
    if (r.effectiveFrom > date) continue;
    if (r.effectiveTo !== null && r.effectiveTo < date) continue;
    if (best === null || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  return best;
}

function resolveClassification(
  worker: WorkerInfo | undefined,
  jobClasses: JobWorkerClassification[],
  employeeId: string,
  date: string,
): string | null {
  let best: JobWorkerClassification | null = null;
  for (const c of jobClasses) {
    if (c.employeeId !== employeeId || c.effectiveFrom > date) continue;
    if (best === null || c.effectiveFrom > best.effectiveFrom) best = c;
  }
  if (best) return best.classification;
  const fallback = worker?.defaultClassification?.trim();
  return fallback ? fallback : null;
}

// ------------------------------------------------------------------
// Engine
// ------------------------------------------------------------------

interface Chunk {
  entryId: string;
  employeeId: string;
  jobId: string | null;
  date: string;
  tier: HourTier;
  centi: number;
  premiumX100: number;
}

const emptyByType = (): Record<HourType, number> => ({ ST: 0, OT: 0, DT: 0, PREM: 0 });

export function computeCertifiedPayroll(input: ComputeInput): ComputeResult {
  const { rules, determination, rates, workers, jobWorkerClasses } = input;
  const warnings: PwWarning[] = [];
  const weekStart = addDays(input.weekEnding, -6);
  const days = weekDays(weekStart);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const workerById = new Map(workers.map((w) => [w.employeeId, w]));

  if (dayOfWeek(weekStart) !== rules.workweekStartDow) {
    warnings.push({
      code: 'WEEK_BOUNDARY',
      severity: 'warning',
      message: `Week ending ${input.weekEnding} does not match the rule set's workweek start. Overtime thresholds assume the 7 days shown.`,
    });
  }

  // 1. Pool entries by employee/day (all jobs).
  const byEmployee = new Map<string, Map<number, { id: string; jobId: string | null; centi: number }[]>>();
  let ignoredOutside = 0;
  for (const e of input.entries) {
    const di = dayIndex.get(e.workDate);
    const centi = toCenti(e.hours);
    if (di === undefined) {
      ignoredOutside += 1;
      continue;
    }
    if (!Number.isFinite(e.hours) || centi <= 0) continue;
    const perDay = byEmployee.get(e.employeeId) ?? new Map();
    const list = perDay.get(di) ?? [];
    list.push({ id: e.id, jobId: e.jobId, centi });
    perDay.set(di, list);
    byEmployee.set(e.employeeId, perDay);
  }
  if (ignoredOutside > 0) {
    warnings.push({ code: 'OUT_OF_WEEK', severity: 'info', message: `${ignoredOutside} timesheet row(s) fall outside the reported week and were ignored.` });
  }

  // 2–5. Bucket each employee's week, then share each day's tiers across its rows.
  const chunks: Chunk[] = [];
  for (const [employeeId, perDay] of [...byEmployee.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dayCenti = days.map((_, i) => (perDay.get(i) ?? []).reduce((s, x) => s + x.centi, 0));
    dayCenti.forEach((c, i) => {
      if (c > 2400) {
        warnings.push({ code: 'DAY_OVER_24', severity: 'error', message: `${workerById.get(employeeId)?.name ?? 'Employee'} has ${formatHours(c / 100)} hours on ${days[i]} — more than 24. Fix the timesheet.`, employeeId, date: days[i] });
      }
    });
    const buckets = bucketWeek(dayCenti, rules);
    days.forEach((date, i) => {
      const rows = (perDay.get(i) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
      if (rows.length === 0) return;
      const premiumX100 = dayPremiumX100(date, rules);
      (['st', 'ot', 'dt'] as HourTier[]).forEach((tier) => {
        const total = buckets[i][tier];
        if (total <= 0) return;
        const shares = allocateProportional(total, rows.map((r) => r.centi));
        rows.forEach((r, k) => {
          if (shares[k] > 0) chunks.push({ entryId: r.id, employeeId, jobId: r.jobId, date, tier, centi: shares[k], premiumX100 });
        });
      });
    });
  }

  // 6. Price the chunks that belong to the reported job.
  const targetChunks = chunks.filter((c) => c.jobId === input.jobId);
  const lineMap = new Map<string, { line: PayLine; parts: { entryId: string; centi: number; type: HourType }[] }>();
  const entryMap = new Map<string, EntryResult>();
  const unresolvedByEmployee = new Map<string, number>();
  const missingClass = new Set<string>();
  const missingRate = new Set<string>();
  const apprenticeWarned = new Set<string>();
  const belowPrevailing = new Set<string>();
  let outsideWindow = false;

  const entryFor = (c: Chunk): EntryResult => {
    let r = entryMap.get(c.entryId);
    if (!r) {
      r = { entryId: c.entryId, employeeId: c.employeeId, workDate: c.date, hours: 0, status: 'priced', classification: null, hoursByType: emptyByType(), grossCashCents: 0, fringePlanCents: 0 };
      entryMap.set(c.entryId, r);
    }
    return r;
  };

  for (const c of targetChunks) {
    const worker = workerById.get(c.employeeId);
    const entry = entryFor(c);
    entry.hours += c.centi / 100;
    const classification = resolveClassification(worker, jobWorkerClasses, c.employeeId, c.date);
    if (!classification) {
      entry.status = 'no_classification';
      unresolvedByEmployee.set(c.employeeId, (unresolvedByEmployee.get(c.employeeId) ?? 0) + c.centi);
      missingClass.add(c.employeeId);
      continue;
    }
    entry.classification = classification;
    const rate = resolveRate(rates, classification, c.date);
    if (!rate) {
      entry.status = 'no_rate';
      unresolvedByEmployee.set(c.employeeId, (unresolvedByEmployee.get(c.employeeId) ?? 0) + c.centi);
      missingRate.add(`${c.employeeId}|${classification}|${c.date}`);
      continue;
    }
    if (c.date < determination.effectiveFrom || (determination.effectiveTo !== null && c.date > determination.effectiveTo)) outsideWindow = true;

    const tierMult = c.tier === 'st' ? 100 : c.tier === 'ot' ? toX100(rate.otMultiplierOverride ?? rules.otMultiplier) : toX100(rules.dtMultiplier);
    const mult = Math.max(tierMult, c.premiumX100);
    const hourType: HourType = c.tier === 'st' ? (mult > 100 ? 'PREM' : 'ST') : c.tier === 'ot' ? 'OT' : 'DT';

    const plan = Math.max(0, worker?.fringePlanCentsPerHour ?? 0);
    const fringeStraightCash = rate.fringeCents - Math.min(plan, rate.fringeCents);
    const empRate = worker?.hourlyRateCents ?? null;
    const paidBase = empRate !== null ? Math.max(rate.baseRateCents, empRate - fringeStraightCash) : rate.baseRateCents;
    if (empRate !== null && empRate < rate.baseRateCents + fringeStraightCash) belowPrevailing.add(c.employeeId);

    const baseHourly = mult === 100 ? paidBase : roundDiv(paidBase * mult, 100);
    const fringeReq = rules.fringeOvertimeMode === 'multiplied' && mult !== 100 ? roundDiv(rate.fringeCents * mult, 100) : rate.fringeCents;
    const planHourly = Math.min(plan, fringeReq);
    const fringeCashHourly = fringeReq - planHourly;

    const key = `${c.employeeId}|${normClass(classification)}|${rate.id}|${hourType}|${mult}`;
    let slot = lineMap.get(key);
    if (!slot) {
      slot = {
        line: {
          key,
          employeeId: c.employeeId,
          employeeName: worker?.name ?? 'Unknown employee',
          classification: rate.classification,
          rateId: rate.id,
          isApprentice: rate.isApprentice,
          hourType,
          multiplierX100: mult,
          dayHours: days.map(() => 0),
          hours: 0,
          baseRateCents: rate.baseRateCents,
          paidBaseCents: paidBase,
          cashHourlyCents: baseHourly + fringeCashHourly,
          fringePlanHourlyCents: planHourly,
          fringeCashHourlyCents: fringeCashHourly,
          grossCashCents: 0,
          fringePlanCents: 0,
        },
        parts: [],
      };
      lineMap.set(key, slot);
    }
    slot.line.dayHours[dayIndex.get(c.date) as number] += c.centi / 100;
    slot.parts.push({ entryId: c.entryId, centi: c.centi, type: hourType });
    entry.hoursByType[hourType] += c.centi / 100;
    if (rate.isApprentice && !apprenticeWarned.has(c.employeeId)) {
      apprenticeWarned.add(c.employeeId);
      warnings.push({ code: 'APPRENTICE_VERIFY', severity: 'info', message: `${worker?.name ?? 'Employee'} is paid an apprentice rate — verify program registration and the allowed apprentice-to-journeyworker ratio.`, employeeId: c.employeeId });
    }
  }

  // Finish lines: one rounding per line, then spread cents back to rows exactly.
  const lines: PayLine[] = [];
  for (const { line, parts } of [...lineMap.values()].sort((a, b) => a.line.key.localeCompare(b.line.key))) {
    const centi = parts.reduce((s, p) => s + p.centi, 0);
    line.hours = centi / 100;
    line.dayHours = line.dayHours.map((h) => Math.round(h * 100) / 100);
    line.grossCashCents = roundDiv(line.cashHourlyCents * centi, 100);
    line.fringePlanCents = roundDiv(line.fringePlanHourlyCents * centi, 100);
    const cash = allocateProportional(line.grossCashCents, parts.map((p) => p.centi));
    const plan = allocateProportional(line.fringePlanCents, parts.map((p) => p.centi));
    parts.forEach((p, i) => {
      const e = entryMap.get(p.entryId) as EntryResult;
      e.grossCashCents += cash[i];
      e.fringePlanCents += plan[i];
    });
    lines.push(line);
  }

  // Warnings.
  for (const id of [...missingClass].sort()) {
    warnings.push({ code: 'NO_CLASSIFICATION', severity: 'error', message: `${workerById.get(id)?.name ?? 'Employee'} has no work classification for this job. Assign one in Job setup — their hours are not priced.`, employeeId: id });
  }
  for (const k of [...missingRate].sort()) {
    const [id, cls, date] = k.split('|');
    warnings.push({ code: 'NO_RATE', severity: 'error', message: `No wage-table rate for "${cls}" on ${date}. Add the classification (or an effective-dated rate) to the wage table.`, employeeId: id, date });
  }
  for (const id of [...belowPrevailing].sort()) {
    warnings.push({ code: 'RATE_BELOW_PREVAILING', severity: 'warning', message: `${workerById.get(id)?.name ?? 'Employee'}'s hourly rate on file is below the required prevailing cash rate. The report shows the required rate — pay the difference or update the employee's rate.`, employeeId: id });
  }
  for (const w of workers) {
    if (w.hourlyRateCents == null && targetChunks.some((c) => c.employeeId === w.employeeId)) {
      warnings.push({ code: 'NO_HOURLY_RATE', severity: 'info', message: `${w.name} has no hourly rate on file; the report uses the prevailing rate. Regular payroll will not apply it automatically.`, employeeId: w.employeeId });
    }
  }
  if (outsideWindow) {
    warnings.push({ code: 'DETERMINATION_WINDOW', severity: 'warning', message: `Some work dates fall outside the wage determination's effective window (${determination.effectiveFrom} – ${determination.effectiveTo ?? 'open'}). Confirm the rate lock-in for this contract.` });
  }
  if ((input.pendingEntryCount ?? 0) > 0) {
    warnings.push({ code: 'PENDING_TIMESHEETS', severity: 'warning', message: `${input.pendingEntryCount} timesheet row(s) are still pending approval and are not included.` });
  }
  if (input.mixedRuleSets) {
    warnings.push({ code: 'MIXED_RULE_SETS', severity: 'warning', message: 'Some workers also worked on jobs that use a different overtime rule set this week. This report applies this job’s rule set to all of their hours — review manually.' });
  }
  if (determination.legalReviewStatus !== 'approved') {
    warnings.push({ code: 'WAGE_TABLE_UNREVIEWED', severity: 'warning', message: 'The wage table has not been marked legally reviewed.' });
  }
  if (rules.legalReviewStatus !== 'approved') {
    warnings.push({ code: 'RULE_SET_UNREVIEWED', severity: 'warning', message: 'The overtime rule set has not been marked legally reviewed.' });
  }

  // Worker summaries + totals.
  const sumBy = (arr: PayLine[], f: (l: PayLine) => number) => arr.reduce((s, l) => s + f(l), 0);
  const employeeIds = new Set<string>([...lines.map((l) => l.employeeId), ...unresolvedByEmployee.keys()]);
  const summaries: WorkerSummary[] = [...employeeIds]
    .map((id) => {
      const mine = lines.filter((l) => l.employeeId === id);
      const w = workerById.get(id);
      const hours = sumBy(mine, (l) => l.hours);
      const straight = sumBy(mine.filter((l) => l.hourType === 'ST'), (l) => l.hours);
      return {
        employeeId: id,
        name: w?.name ?? 'Unknown employee',
        address: w?.address ?? null,
        workerIdLast4: w?.workerIdLast4 ?? null,
        classifications: [...new Set(mine.map((l) => l.classification))],
        hours,
        straightHours: straight,
        premiumHours: Math.round((hours - straight) * 100) / 100,
        grossCashCents: sumBy(mine, (l) => l.grossCashCents),
        fringePlanCents: sumBy(mine, (l) => l.fringePlanCents),
        unresolvedHours: (unresolvedByEmployee.get(id) ?? 0) / 100,
        hourlyRateCents: w?.hourlyRateCents ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.employeeId.localeCompare(b.employeeId));

  const hours = sumBy(lines, (l) => l.hours);
  const straightHours = sumBy(lines.filter((l) => l.hourType === 'ST'), (l) => l.hours);
  const grossCashCents = sumBy(lines, (l) => l.grossCashCents);
  const fringePlanCents = sumBy(lines, (l) => l.fringePlanCents);
  const totals: PayrollTotals = {
    hours: Math.round(hours * 100) / 100,
    straightHours: Math.round(straightHours * 100) / 100,
    premiumHours: Math.round((hours - straightHours) * 100) / 100,
    grossCashCents,
    fringePlanCents,
    fringeCashCents: lines.reduce((s, l) => s + roundDiv(l.fringeCashHourlyCents * Math.round(l.hours * 100), 100), 0),
    totalCompCents: grossCashCents + fringePlanCents,
    workerCount: summaries.filter((s) => s.hours > 0).length,
    unresolvedHours: [...unresolvedByEmployee.values()].reduce((s, c) => s + c, 0) / 100,
  };

  const certifyBlockers: string[] = [];
  if (warnings.some((w) => w.severity === 'error')) certifyBlockers.push('Resolve all errors (missing classifications, missing rates, invalid hours).');
  if (determination.legalReviewStatus !== 'approved') certifyBlockers.push('Mark the wage table as legally reviewed.');
  if (rules.legalReviewStatus !== 'approved') certifyBlockers.push('Mark the overtime rule set as legally reviewed.');

  return {
    engineVersion: PW_ENGINE_VERSION,
    weekStart,
    weekEnding: input.weekEnding,
    days,
    lines,
    entryResults: [...entryMap.values()].sort((a, b) => a.workDate.localeCompare(b.workDate) || a.entryId.localeCompare(b.entryId)),
    workers: summaries,
    warnings,
    totals,
    certifyBlockers,
  };
}

// ------------------------------------------------------------------
// Form validators (return the first error message, or null)
// ------------------------------------------------------------------

export function validateRuleSetInput(r: Omit<OvertimeRuleSet, 'id' | 'legalReviewStatus'>): string | null {
  if (!r.name.trim()) return 'Give the rule set a name.';
  if (!(r.weeklyOtAfter > 0 && r.weeklyOtAfter <= 168)) return 'Weekly overtime threshold must be between 0 and 168 hours.';
  if (r.dailyOtAfter !== null && !(r.dailyOtAfter > 0 && r.dailyOtAfter <= 24)) return 'Daily overtime threshold must be between 0 and 24 hours.';
  if (r.dailyDtAfter !== null && !(r.dailyDtAfter > 0 && r.dailyDtAfter <= 24)) return 'Daily double-time threshold must be between 0 and 24 hours.';
  if (r.dailyDtAfter !== null && r.dailyOtAfter !== null && r.dailyDtAfter <= r.dailyOtAfter) return 'Double-time must start after overtime.';
  if (!(r.otMultiplier >= 1 && r.otMultiplier <= 5)) return 'Overtime multiplier must be between 1 and 5.';
  if (!(r.dtMultiplier >= r.otMultiplier && r.dtMultiplier <= 5)) return 'Double-time multiplier must be at least the overtime multiplier (max 5).';
  for (const m of [r.saturdayMultiplier, r.sundayMultiplier, r.holidayMultiplier]) {
    if (m !== null && !(m >= 1 && m <= 5)) return 'Weekend and holiday multipliers must be between 1 and 5.';
  }
  if (!(r.seventhDayOtHours > 0 && r.seventhDayOtHours <= 24)) return 'Seventh-day overtime hours must be between 0 and 24.';
  if (!(Number.isInteger(r.workweekStartDow) && r.workweekStartDow >= 0 && r.workweekStartDow <= 6)) return 'Pick a workweek start day.';
  if (r.holidays.some((h) => !isIsoDate(h))) return 'Holidays must be valid dates.';
  return null;
}

export function validateRateInput(r: { classification: string; baseRateCents: number | null; fringeCents: number | null; effectiveFrom: string; effectiveTo: string | null; otMultiplierOverride: number | null }): string | null {
  if (!r.classification.trim()) return 'Enter the classification (for example "Electrician — Journeyman").';
  if (r.baseRateCents === null || r.baseRateCents < 0 || r.baseRateCents > 100_000) return 'Enter a base hourly rate between $0.00 and $1,000.00.';
  if (r.fringeCents === null || r.fringeCents < 0 || r.fringeCents > 100_000) return 'Enter a fringe hourly amount between $0.00 and $1,000.00.';
  if (!isIsoDate(r.effectiveFrom)) return 'Enter a valid effective-from date.';
  if (r.effectiveTo !== null && (!isIsoDate(r.effectiveTo) || r.effectiveTo < r.effectiveFrom)) return 'Effective-to must be a valid date on or after effective-from.';
  if (r.otMultiplierOverride !== null && !(r.otMultiplierOverride >= 1 && r.otMultiplierOverride <= 5)) return 'Overtime multiplier override must be between 1 and 5.';
  return null;
}
