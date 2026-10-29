// AIA-style pay applications (G702 summary + G703 continuation sheet).
//
// Pure types and calculations only — no Supabase import on purpose, so every
// number is deterministic and unit tested (payApps.test.ts). Database access
// lives in payAppsApi.ts; the SQL twin of calculateApplication() is
// install_pay_app_recalc() in the 20280115000000 migration.
//
// MONEY RULES (what makes it reconcile to the cent)
//   • Everything is an integer number of cents. No floats ever touch a total.
//   • Percentages are integer basis points (45.25% → 4525) so rounding is
//     identical in TypeScript and in PostgreSQL.
//   • Retainage is rounded ONCE on the grand total (work, stored), never per
//     line, so the lines can never drift from the G702 summary.

import { dollarsToCents, formatMoney, friendlyError } from '@/lib/installProjects';

export type PayAppStatus = 'draft' | 'issued' | 'paid' | 'void';

export interface SovLine {
  id: string;
  project_id: string;
  item_no: string;
  description: string;
  scheduled_value_cents: number;
  /** Set when the line was added by a change order; null for original contract work. */
  change_order_ref: string | null;
  sort_order: number;
}

/** One G703 row. D = previous_cents, E = this_period_cents, F = stored_cents. */
export interface PayAppLine {
  id: string;
  pay_app_id: string;
  sov_line_id: string | null;
  sort_order: number;
  item_no: string;
  description: string;
  scheduled_value_cents: number;
  change_order_ref: string | null;
  previous_cents: number;
  this_period_cents: number;
  stored_cents: number;
}

export interface PayApp {
  id: string;
  project_id: string;
  application_no: number;
  status: PayAppStatus;
  period_to: string;
  application_date: string;
  retainage_percent: number;
  retainage_release_cents: number;
  notes: string | null;
  original_contract_cents: number;
  change_orders_cents: number;
  contract_to_date_cents: number;
  completed_stored_cents: number;
  retainage_work_cents: number;
  retainage_stored_cents: number;
  total_retainage_cents: number;
  earned_less_retainage_cents: number;
  previous_certificates_cents: number;
  current_payment_due_cents: number;
  balance_to_finish_cents: number;
  invoice_id: string | null;
  issued_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export const PAY_APP_STATUS_LABEL: Record<PayAppStatus, string> = {
  draft: 'Draft',
  issued: 'Issued',
  paid: 'Paid',
  void: 'Void',
};

export const MAX_SCHEDULED_CENTS = 100_000_000_000; // $1B per line — matches the SQL CHECK.

// ------------------------------------------------------------------
// Integer helpers
// ------------------------------------------------------------------

/** n / d rounded half away from zero (matches PostgreSQL round() on integers). */
export function roundDiv(n: number, d: number): number {
  if (d === 0) return 0;
  const sign = (n < 0) !== (d < 0) ? -1 : 1;
  const a = Math.abs(n);
  const b = Math.abs(d);
  return sign * Math.floor((a * 2 + b) / (b * 2));
}

/** 7.5 → 750. numeric(5,2) in SQL ↔ integer basis points here. */
export function percentToBps(percent: number): number {
  return Math.round(percent * 100);
}

/** Retainage on an amount at a project rate, rounded half-up to the cent. */
export function retainageOf(amountCents: number, retainagePercent: number): number {
  return roundDiv(amountCents * percentToBps(retainagePercent), 10_000);
}

/** "45", "45.5", "45.25%" → 4525 bps. Invalid / out of 0–100 → null. */
export function parsePercentToBps(input: string): number | null {
  const clean = input.replace(/[%\s]/g, '');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(clean)) return null;
  const bps = Math.round(Number(clean) * 100);
  return bps >= 0 && bps <= 10_000 ? bps : null;
}

/** Percent shown in the G703 "%" column: total completed & stored ÷ scheduled value. */
export function percentComplete(totalCents: number, scheduledCents: number): number {
  if (scheduledCents <= 0) return 0;
  return roundDiv(totalCents * 10_000, scheduledCents) / 100;
}

export function bpsToPercentInput(bps: number): string {
  return bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2).replace(/0$/, '');
}

/**
 * Work-in-place percentage → "this period" cents for a line.
 * E = round(C × pct) − D, so D + E lands exactly on the rounded percentage.
 */
export function thisPeriodFromPercent(scheduledCents: number, previousCents: number, bps: number): number {
  return roundDiv(scheduledCents * bps, 10_000) - previousCents;
}

/** Spread a total across weights to the exact cent (largest-remainder method). */
export function allocateByWeight(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0) return [];
  if (sum <= 0 || totalCents <= 0) return weights.map(() => 0);
  const base = weights.map((w) => Math.floor((totalCents * w) / sum));
  const rem = weights.map((w, i) => ({ i, r: (totalCents * w) % sum }));
  let left = totalCents - base.reduce((s, b) => s + b, 0);
  rem.sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of rem) {
    if (left <= 0) break;
    base[i] += 1;
    left -= 1;
  }
  return base;
}

// ------------------------------------------------------------------
// Core calculation (G703 rows → G702 summary)
// ------------------------------------------------------------------

export type CalcLineInput = Pick<
  PayAppLine,
  'scheduled_value_cents' | 'previous_cents' | 'this_period_cents' | 'stored_cents' | 'change_order_ref'
>;

export interface CalcLine {
  scheduledCents: number; // C
  previousCents: number; // D
  thisPeriodCents: number; // E
  storedCents: number; // F
  workToDateCents: number; // D + E
  totalCents: number; // G = D + E + F
  percent: number; // G ÷ C
  balanceCents: number; // H = C − G
}

export interface ApplicationTotals {
  scheduledCents: number;
  previousCents: number;
  thisPeriodCents: number;
  storedCents: number;
  workToDateCents: number;
  totalCents: number;
  balanceCents: number;
  percent: number;
  // G702
  originalContractCents: number; // 1
  changeOrdersCents: number; // 2
  contractToDateCents: number; // 3
  completedStoredCents: number; // 4
  retainageWorkCents: number; // 5a
  retainageStoredCents: number; // 5b
  retainageReleasedCents: number; // reduction / release
  totalRetainageCents: number; // 5 (net of release)
  earnedLessRetainageCents: number; // 6
  previousCertificatesCents: number; // 7
  currentPaymentDueCents: number; // 8
  balanceToFinishCents: number; // 9 (includes retainage)
}

export interface CalcResult {
  lines: CalcLine[];
  totals: ApplicationTotals;
}

export interface CalcParams {
  lines: CalcLineInput[];
  retainagePercent: number;
  retainageReleaseCents: number;
  previousCertificatesCents: number;
}

export function calculateApplication(p: CalcParams): CalcResult {
  const lines: CalcLine[] = p.lines.map((l) => {
    const workToDate = l.previous_cents + l.this_period_cents;
    const total = workToDate + l.stored_cents;
    return {
      scheduledCents: l.scheduled_value_cents,
      previousCents: l.previous_cents,
      thisPeriodCents: l.this_period_cents,
      storedCents: l.stored_cents,
      workToDateCents: workToDate,
      totalCents: total,
      percent: percentComplete(total, l.scheduled_value_cents),
      balanceCents: l.scheduled_value_cents - total,
    };
  });

  let scheduled = 0, previous = 0, thisPeriod = 0, stored = 0, original = 0, changes = 0;
  p.lines.forEach((l, i) => {
    scheduled += lines[i].scheduledCents;
    previous += lines[i].previousCents;
    thisPeriod += lines[i].thisPeriodCents;
    stored += lines[i].storedCents;
    if (l.change_order_ref) changes += l.scheduled_value_cents;
    else original += l.scheduled_value_cents;
  });
  const workToDate = previous + thisPeriod;
  const total = workToDate + stored;

  const retWork = retainageOf(workToDate, p.retainagePercent);
  const retStored = retainageOf(stored, p.retainagePercent);
  const released = p.retainageReleaseCents;
  const totalRetainage = retWork + retStored - released;
  const earned = total - totalRetainage;

  return {
    lines,
    totals: {
      scheduledCents: scheduled,
      previousCents: previous,
      thisPeriodCents: thisPeriod,
      storedCents: stored,
      workToDateCents: workToDate,
      totalCents: total,
      balanceCents: scheduled - total,
      percent: percentComplete(total, scheduled),
      originalContractCents: original,
      changeOrdersCents: changes,
      contractToDateCents: original + changes,
      completedStoredCents: total,
      retainageWorkCents: retWork,
      retainageStoredCents: retStored,
      retainageReleasedCents: released,
      totalRetainageCents: totalRetainage,
      earnedLessRetainageCents: earned,
      previousCertificatesCents: p.previousCertificatesCents,
      currentPaymentDueCents: earned - p.previousCertificatesCents,
      balanceToFinishCents: original + changes - earned,
    },
  };
}

/**
 * Independent cross-checks. Returns [] when every identity holds to the cent.
 * Used by the UI (never show a number that fails) and by the test-suite.
 */
export function reconcile(r: CalcResult): string[] {
  const t = r.totals;
  const out: string[] = [];
  const sum = (f: (l: CalcLine) => number) => r.lines.reduce((s, l) => s + f(l), 0);
  if (sum((l) => l.scheduledCents) !== t.scheduledCents) out.push('Σ C ≠ scheduled total');
  if (sum((l) => l.previousCents) !== t.previousCents) out.push('Σ D ≠ previous total');
  if (sum((l) => l.thisPeriodCents) !== t.thisPeriodCents) out.push('Σ E ≠ this-period total');
  if (sum((l) => l.storedCents) !== t.storedCents) out.push('Σ F ≠ stored total');
  if (sum((l) => l.totalCents) !== t.totalCents) out.push('Σ G ≠ completed & stored total');
  if (sum((l) => l.balanceCents) !== t.balanceCents) out.push('Σ H ≠ balance total');
  if (t.previousCents + t.thisPeriodCents + t.storedCents !== t.totalCents) out.push('D + E + F ≠ G');
  if (t.scheduledCents - t.totalCents !== t.balanceCents) out.push('C − G ≠ H');
  if (t.originalContractCents + t.changeOrdersCents !== t.contractToDateCents) out.push('Line 1 + 2 ≠ line 3');
  if (t.contractToDateCents !== t.scheduledCents) out.push('Line 3 ≠ G703 scheduled total');
  if (t.completedStoredCents !== t.totalCents) out.push('Line 4 ≠ G703 total');
  if (t.retainageWorkCents + t.retainageStoredCents - t.retainageReleasedCents !== t.totalRetainageCents) out.push('Line 5a + 5b − release ≠ line 5');
  if (t.completedStoredCents - t.totalRetainageCents !== t.earnedLessRetainageCents) out.push('Line 4 − 5 ≠ line 6');
  if (t.earnedLessRetainageCents - t.previousCertificatesCents !== t.currentPaymentDueCents) out.push('Line 6 − 7 ≠ line 8');
  if (t.contractToDateCents - t.earnedLessRetainageCents !== t.balanceToFinishCents) out.push('Line 3 − 6 ≠ line 9');
  if (t.balanceCents + t.totalRetainageCents !== t.balanceToFinishCents) out.push('G703 balance + retainage ≠ line 9');
  return out;
}

// ------------------------------------------------------------------
// Draft building & carry-forward
// ------------------------------------------------------------------

export interface LineEntry {
  thisPeriodCents: number;
  storedCents: number;
}

/** D for the next application = previous D + E (stored materials are NOT carried into D). */
export function carryForward(previousLines: Pick<PayAppLine, 'sov_line_id' | 'previous_cents' | 'this_period_cents'>[] | null | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of previousLines ?? []) if (l.sov_line_id) m.set(l.sov_line_id, l.previous_cents + l.this_period_cents);
  return m;
}

/** Master schedule of values + prior application + entries → editable G703 rows. */
export function buildDraftLines(
  sov: SovLine[],
  previousLines: PayAppLine[] | null | undefined,
  entries: Record<string, LineEntry | undefined>,
  payAppId = 'draft',
): PayAppLine[] {
  const prev = carryForward(previousLines);
  return [...sov]
    .sort((a, b) => a.sort_order - b.sort_order || a.item_no.localeCompare(b.item_no, undefined, { numeric: true }))
    .map((s, i) => {
      const e = entries[s.id];
      return {
        id: `${payAppId}:${s.id}`,
        pay_app_id: payAppId,
        sov_line_id: s.id,
        sort_order: i,
        item_no: s.item_no,
        description: s.description,
        scheduled_value_cents: s.scheduled_value_cents,
        change_order_ref: s.change_order_ref,
        previous_cents: prev.get(s.id) ?? 0,
        this_period_cents: e?.thisPeriodCents ?? 0,
        stored_cents: e?.storedCents ?? 0,
      };
    });
}

// ------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------

export interface PayAppIssue {
  code: 'line_negative' | 'line_over' | 'release_exceeds' | 'sov_mismatch' | 'no_lines' | 'period_before_previous';
  lineId?: string;
  message: string;
}

export function validateApplication(p: {
  lines: PayAppLine[];
  retainagePercent: number;
  retainageReleaseCents: number;
  contractValueCents: number;
  periodTo: string;
  previousPeriodTo: string | null;
}): PayAppIssue[] {
  const issues: PayAppIssue[] = [];
  if (p.lines.length === 0) issues.push({ code: 'no_lines', message: 'Add at least one schedule-of-values line.' });
  for (const l of p.lines) {
    const work = l.previous_cents + l.this_period_cents;
    if (work < 0) issues.push({ code: 'line_negative', lineId: l.id, message: `Item ${l.item_no}: work to date cannot be negative.` });
    if (l.stored_cents < 0) issues.push({ code: 'line_negative', lineId: l.id, message: `Item ${l.item_no}: stored materials cannot be negative.` });
    if (work + l.stored_cents > l.scheduled_value_cents) {
      issues.push({ code: 'line_over', lineId: l.id, message: `Item ${l.item_no}: completed + stored (${formatMoney(work + l.stored_cents)}) exceeds the scheduled value (${formatMoney(l.scheduled_value_cents)}).` });
    }
  }
  const work = p.lines.reduce((s, l) => s + l.previous_cents + l.this_period_cents, 0);
  const stored = p.lines.reduce((s, l) => s + l.stored_cents, 0);
  const held = retainageOf(work, p.retainagePercent) + retainageOf(stored, p.retainagePercent);
  if (p.retainageReleaseCents < 0 || p.retainageReleaseCents > held) {
    issues.push({ code: 'release_exceeds', message: `Retainage release cannot exceed the retainage held (${formatMoney(held)}).` });
  }
  if (p.previousPeriodTo && p.periodTo < p.previousPeriodTo) {
    issues.push({ code: 'period_before_previous', message: 'The period cannot end before the previous application’s period.' });
  }
  const original = p.lines.filter((l) => !l.change_order_ref).reduce((s, l) => s + l.scheduled_value_cents, 0);
  if (p.contractValueCents > 0 && original !== p.contractValueCents) {
    issues.push({ code: 'sov_mismatch', message: `Original schedule of values (${formatMoney(original)}) must equal the project contract value (${formatMoney(p.contractValueCents)}) before issuing.` });
  }
  return issues;
}

/** Issues that block saving a draft (sov_mismatch only blocks issuing). */
export const BLOCKS_SAVE: PayAppIssue['code'][] = ['line_negative', 'line_over', 'release_exceeds', 'period_before_previous'];

// ------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------

const PAY_APP_ERRORS: Record<string, string> = {
  pay_app_not_found: 'That pay application no longer exists.',
  pay_app_locked: 'Issued applications are locked. Void the latest one to make changes.',
  pay_app_line_over: 'A line’s completed + stored amount exceeds its scheduled value.',
  pay_app_line_negative: 'A line’s work to date cannot be negative.',
  pay_app_release_exceeds: 'The retainage release is larger than the retainage held.',
  pay_app_sov_mismatch: 'The original schedule of values must equal the project contract value before issuing.',
  pay_app_no_lines: 'Add at least one schedule-of-values line first.',
  pay_app_period_invalid: 'The period cannot end before the previous application’s period.',
  pay_app_not_latest: 'Only the most recent application can be voided.',
  pay_app_draft_exists: 'Issue or discard the open draft before voiding an issued application.',
  pay_app_invoiced: 'Void the linked invoice first.',
  pay_app_already_invoiced: 'This application already has an open invoice.',
  pay_app_nothing_due: 'There is no payment due on this application.',
  pay_app_bad_transition: 'That action is not available for this application’s status.',
  pay_app_bad_payload: 'The entered amounts were not valid. Reload and try again.',
  sov_locked: 'This line is on an issued application. Add a change-order line instead of editing its value.',
};

export function friendlyPayAppError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : '';
  for (const key of Object.keys(PAY_APP_ERRORS)) {
    if (message.includes(key)) {
      const item = /pay_app_line_(?:over|negative):\s*(.+)$/.exec(message)?.[1]?.trim();
      return item ? `Item ${item}: ${PAY_APP_ERRORS[key]}` : PAY_APP_ERRORS[key];
    }
  }
  if (/duplicate key value/i.test(message) && message.includes('idx_install_sov_item_no')) return 'That item number is already used in this schedule of values.';
  return friendlyError(error, fallback);
}

// ------------------------------------------------------------------
// Form helpers
// ------------------------------------------------------------------

export function parseMoneyInput(input: string): number | null {
  return dollarsToCents(input);
}

export function nextItemNo(sov: Pick<SovLine, 'item_no'>[]): string {
  const nums = sov.map((s) => Number(s.item_no)).filter((n) => Number.isInteger(n) && n > 0);
  return String((nums.length ? Math.max(...nums) : 0) + 1);
}
