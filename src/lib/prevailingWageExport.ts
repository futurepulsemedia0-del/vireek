/**
 * Prevailing wage — report snapshot, CSV exports, rate import and templates.
 * Pure functions (no I/O) so they are unit-tested. See prevailingWage.ts for the
 * engine and the LEGAL REVIEW REQUIRED notice that applies to everything here.
 */

import {
  LEGAL_REVIEW_NOTICE,
  isIsoDate,
  parseMoneyToCents,
  type ComputeResult,
  type OvertimeRuleSet,
  type PayLine,
  type PwWarning,
  type PayrollTotals,
  type WorkerSummary,
} from './prevailingWage';

// ------------------------------------------------------------------
// Snapshot (stored as JSON on the certified payroll — immutable once certified)
// ------------------------------------------------------------------

export interface ReportDeductions {
  ficaCents: number;
  withholdingCents: number;
  otherCents: number;
}

export interface SnapshotWorker extends WorkerSummary {
  deductions: ReportDeductions;
  netCents: number;
}

export interface ReportMeta {
  contractorName: string;
  contractorAddress: string;
  projectName: string;
  contractNumber: string;
  awardingAgency: string;
  primeContractor: string;
  projectLocation: string;
  determinationName: string;
  determinationNumber: string;
  determinationRevision: string;
  program: string;
  ruleSetName: string;
  isFinal: boolean;
  noWork: boolean;
}

export interface ReportSnapshot {
  engineVersion: string;
  generatedAt: string;
  legalNotice: string;
  meta: ReportMeta;
  weekStart: string;
  weekEnding: string;
  days: string[];
  rules: Pick<
    OvertimeRuleSet,
    'id' | 'name' | 'workweekStartDow' | 'dailyOtAfter' | 'dailyDtAfter' | 'weeklyOtAfter' | 'seventhDayRule' | 'otMultiplier' | 'dtMultiplier' | 'fringeOvertimeMode'
  >;
  lines: PayLine[];
  workers: SnapshotWorker[];
  warnings: PwWarning[];
  totals: PayrollTotals;
}

export const NO_DEDUCTIONS: ReportDeductions = { ficaCents: 0, withholdingCents: 0, otherCents: 0 };

export function netPayCents(grossCents: number, d: ReportDeductions): number {
  return grossCents - d.ficaCents - d.withholdingCents - d.otherCents;
}

export function buildReportSnapshot(
  result: ComputeResult,
  rules: OvertimeRuleSet,
  meta: ReportMeta,
  deductions: Record<string, ReportDeductions> = {},
  now: Date = new Date(),
): ReportSnapshot {
  return {
    engineVersion: result.engineVersion,
    generatedAt: now.toISOString(),
    legalNotice: LEGAL_REVIEW_NOTICE,
    meta,
    weekStart: result.weekStart,
    weekEnding: result.weekEnding,
    days: result.days,
    rules: {
      id: rules.id,
      name: rules.name,
      workweekStartDow: rules.workweekStartDow,
      dailyOtAfter: rules.dailyOtAfter,
      dailyDtAfter: rules.dailyDtAfter,
      weeklyOtAfter: rules.weeklyOtAfter,
      seventhDayRule: rules.seventhDayRule,
      otMultiplier: rules.otMultiplier,
      dtMultiplier: rules.dtMultiplier,
      fringeOvertimeMode: rules.fringeOvertimeMode,
    },
    lines: result.lines,
    workers: result.workers
      .filter((w) => w.hours > 0)
      .map((w) => {
        const d = deductions[w.employeeId] ?? NO_DEDUCTIONS;
        return { ...w, deductions: d, netCents: netPayCents(w.grossCashCents, d) };
      }),
    warnings: result.warnings,
    totals: result.totals,
  };
}

// ------------------------------------------------------------------
// CSV
// ------------------------------------------------------------------

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** RFC 4180 quoting + spreadsheet formula-injection guard for user-entered text. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (!NUMERIC.test(s) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells: (string | number | boolean | null | undefined)[]): string {
  return cells.map(csvCell).join(',');
}

const dollars = (cents: number): string => (cents / 100).toFixed(2);

/** One row per worker × classification × hour type, with a column per day of the workweek. */
export function buildLinesCsv(snap: ReportSnapshot, payrollNumber: number): string {
  const head = [
    'Payroll No', 'Week Ending', 'Contractor', 'Project', 'Contract No', 'Worker', 'Worker ID (last 4)',
    'Classification', 'Hour Type', ...snap.days, 'Total Hours', 'Multiplier', 'Prevailing Base Rate',
    'Base Rate Paid', 'Fringe To Plans /hr', 'Fringe Cash /hr', 'Cash Hourly Rate', 'Gross Cash Wages', 'Fringe Contributions To Plans',
  ];
  const workers = new Map(snap.workers.map((w) => [w.employeeId, w]));
  const rows = snap.lines
    .slice()
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName) || a.classification.localeCompare(b.classification) || a.hourType.localeCompare(b.hourType))
    .map((l) =>
      csvRow([
        payrollNumber, snap.weekEnding, snap.meta.contractorName, snap.meta.projectName, snap.meta.contractNumber,
        l.employeeName, workers.get(l.employeeId)?.workerIdLast4 ?? '', l.classification, l.hourType,
        ...l.dayHours.map((h) => (h === 0 ? '' : h)), l.hours, (l.multiplierX100 / 100).toFixed(2), dollars(l.baseRateCents),
        dollars(l.paidBaseCents), dollars(l.fringePlanHourlyCents), dollars(l.fringeCashHourlyCents), dollars(l.cashHourlyCents),
        dollars(l.grossCashCents), dollars(l.fringePlanCents),
      ]),
    );
  return [csvRow(head), ...rows].join('\r\n') + '\r\n';
}

/** One row per worker with totals and deductions (the payroll-register half of a certified payroll). */
export function buildWorkersCsv(snap: ReportSnapshot, payrollNumber: number): string {
  const head = [
    'Payroll No', 'Week Ending', 'Worker', 'Worker ID (last 4)', 'Address', 'Classifications', 'Total Hours',
    'Straight Hours', 'Premium Hours', 'Gross Cash Wages', 'Fringe To Plans', 'FICA', 'Withholding', 'Other Deductions', 'Net Wages',
  ];
  const rows = snap.workers.map((w) =>
    csvRow([
      payrollNumber, snap.weekEnding, w.name, w.workerIdLast4 ?? '', w.address ?? '', w.classifications.join('; '), w.hours,
      w.straightHours, w.premiumHours, dollars(w.grossCashCents), dollars(w.fringePlanCents), dollars(w.deductions.ficaCents),
      dollars(w.deductions.withholdingCents), dollars(w.deductions.otherCents), dollars(w.netCents),
    ]),
  );
  return [csvRow(head), ...rows].join('\r\n') + '\r\n';
}

export function reportFileName(snap: Pick<ReportSnapshot, 'weekEnding' | 'meta'>, payrollNumber: number, kind: string, ext: string): string {
  const slug = (snap.meta.projectName || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  return `certified-payroll-${slug}-no${payrollNumber}-we${snap.weekEnding}-${kind}.${ext}`;
}

// ------------------------------------------------------------------
// Rate import (paste from a spreadsheet or a wage-determination table)
// ------------------------------------------------------------------

export interface ImportedRate {
  classification: string;
  baseRateCents: number;
  fringeCents: number;
  effectiveFrom: string;
  isApprentice: boolean;
}

export const MAX_IMPORT_ROWS = 500;

function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/**
 * Columns: classification, base rate, fringe [, effective-from] [, apprentice].
 * Comma- or tab-separated; a header row is detected and skipped.
 */
export function parseRatesCsv(text: string, defaultEffectiveFrom: string): { rows: ImportedRate[]; errors: string[] } {
  const rows: ImportedRate[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { rows, errors: ['Paste at least one row.'] };
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const seen = new Set<string>();
  let truncated = false;
  lines.forEach((line, idx) => {
    const cells = splitLine(line, delim);
    if (idx === 0 && /class|trade|craft/i.test(cells[0]) && parseMoneyToCents(cells[1] ?? '') === null) return; // header
    const n = idx + 1;
    if (rows.length >= MAX_IMPORT_ROWS) {
      if (!truncated) errors.push(`Only the first ${MAX_IMPORT_ROWS} rows are imported.`);
      truncated = true;
      return;
    }
    const [classification = '', base = '', fringe = '0', from = '', app = ''] = cells;
    const baseCents = parseMoneyToCents(base);
    const fringeCents = parseMoneyToCents(fringe === '' ? '0' : fringe);
    const effectiveFrom = from === '' ? defaultEffectiveFrom : from;
    if (!classification) return void errors.push(`Row ${n}: classification is empty.`);
    if (baseCents === null || baseCents > 100_000) return void errors.push(`Row ${n}: base rate "${base}" is not a valid hourly amount.`);
    if (fringeCents === null || fringeCents > 100_000) return void errors.push(`Row ${n}: fringe "${fringe}" is not a valid hourly amount.`);
    if (!isIsoDate(effectiveFrom)) return void errors.push(`Row ${n}: effective date "${from}" must look like 2027-01-31.`);
    const key = `${classification.trim().toLowerCase().replace(/\s+/g, ' ')}|${effectiveFrom}`;
    if (seen.has(key)) return void errors.push(`Row ${n}: "${classification}" is listed twice for ${effectiveFrom}.`);
    seen.add(key);
    rows.push({ classification: classification.trim().replace(/\s+/g, ' '), baseRateCents: baseCents, fringeCents, effectiveFrom, isApprentice: /^(1|y|yes|true|apprentice)$/i.test(app) });
  });
  return { rows, errors };
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Plain-English summary shown on each rule-set card so reviewers can read what the data does. */
export function describeRuleSet(r: OvertimeRuleSet): string[] {
  const out: string[] = [];
  out.push(`Workweek starts ${DAY_NAMES[r.workweekStartDow]}.`);
  if (r.dailyOtAfter !== null) out.push(`Daily: ×${r.otMultiplier} after ${r.dailyOtAfter} h${r.dailyDtAfter !== null ? `, ×${r.dtMultiplier} after ${r.dailyDtAfter} h` : ''}.`);
  out.push(`Weekly: ×${r.otMultiplier} after ${r.weeklyOtAfter} h (hours already paid at a daily premium are not counted again).`);
  if (r.seventhDayRule !== 'none') out.push(`Seventh consecutive day: ×${r.otMultiplier} for the first ${r.seventhDayOtHours} h, then ×${r.dtMultiplier}.`);
  const premiums = [r.saturdayMultiplier && `Saturday ×${r.saturdayMultiplier}`, r.sundayMultiplier && `Sunday ×${r.sundayMultiplier}`, r.holidayMultiplier && `holidays ×${r.holidayMultiplier} (${r.holidays.length} listed)`].filter(Boolean);
  if (premiums.length) out.push(`${premiums.join(', ')} — the highest multiplier applies; premiums never stack.`);
  out.push(r.fringeOvertimeMode === 'straight' ? 'Fringe is paid at the straight-time amount on every hour worked, including overtime.' : 'Fringe is multiplied along with the overtime premium.');
  return out;
}

// ------------------------------------------------------------------
// Rule-set starting points (always created as "unreviewed")
// ------------------------------------------------------------------

export type RuleSetValues = Omit<OvertimeRuleSet, 'id' | 'legalReviewStatus'>;

const baseRule: RuleSetValues = {
  name: '',
  workweekStartDow: 0,
  dailyOtAfter: null,
  dailyDtAfter: null,
  weeklyOtAfter: 40,
  seventhDayRule: 'none',
  seventhDayOtHours: 8,
  otMultiplier: 1.5,
  dtMultiplier: 2,
  saturdayMultiplier: null,
  sundayMultiplier: null,
  holidayMultiplier: null,
  holidays: [],
  fringeOvertimeMode: 'straight',
};

export const RULE_SET_TEMPLATES: { key: string; label: string; hint: string; values: RuleSetValues }[] = [
  {
    key: 'weekly40',
    label: 'Weekly 40 hours (federal-style)',
    hint: 'Time-and-a-half after 40 hours in the workweek. A starting point only — verify against your contract.',
    values: { ...baseRule, name: 'Weekly 40-hour overtime' },
  },
  {
    key: 'daily8_weekly40',
    label: 'Daily 8 + weekly 40',
    hint: 'Overtime after 8 hours a day and after 40 a week, without double-counting. Verify before use.',
    values: { ...baseRule, name: 'Daily 8 / weekly 40', dailyOtAfter: 8 },
  },
  {
    key: 'daily8_12_seventh',
    label: 'Daily 8/12 + seventh day',
    hint: 'Overtime after 8, double-time after 12, seventh consecutive day premium. Verify before use.',
    values: { ...baseRule, name: 'Daily 8/12 + seventh day', dailyOtAfter: 8, dailyDtAfter: 12, seventhDayRule: 'ot_first_dt_after' },
  },
];
