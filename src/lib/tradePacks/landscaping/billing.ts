/**
 * Landscaping pack — batch recurring invoicing (pure).
 *
 * KEEP IN SYNC with public.landscape_run_billing() (SQL). The database is authoritative; this
 * mirror drives the “preview this month's invoices” screen and is pinned by billing.test.ts.
 *
 * Rules
 *  - One draft invoice per (contract, calendar month). The idempotency key is `${contractId}:${YYYY-MM}`;
 *    the database enforces it with a UNIQUE constraint, so re-running a batch can never double-bill.
 *  - per_visit  : every COMPLETED, not-yet-billed maintenance visit dated on/before the period end is a line
 *                 at the price snapshotted on the visit (late completions roll into the next run).
 *  - monthly_flat: one line for the fee, prorated by active days (contract dates and pauses excluded).
 *                 Weather/holiday skips do NOT reduce a flat fee — the customer pays for the service
 *                 relationship, not each mow. Pause windows DO, day by day.
 *  - add-on visits (snow, fertilization, cleanup …) are always billed when completed.
 *  - Nothing to bill ⇒ no invoice (not a $0 invoice).
 *  - Drafts only: a human (or the existing send flow) sends them. This module never talks to a payment provider.
 */

import { addDays, daysBetween, daysInMonth, toISO, type ISODate } from './calendar.ts';
import type { BillingMode, VisitRow } from './types.ts';
import type { PauseWindow } from './recurrence.ts';

export interface BillingContract {
  id: string;
  title: string;
  billing_mode: BillingMode;
  monthly_fee_cents: number;
  tax_percent: number;
  start_date: ISODate;
  end_date: ISODate | null;
  pauses: PauseWindow[];
  status: 'draft' | 'active' | 'paused' | 'ended';
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

export interface InvoiceDraft {
  idempotencyKey: string;
  contractId: string;
  period: string;
  lines: InvoiceLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Visit ids covered, so the caller can mark them billed atomically with the invoice insert. */
  visitIds: string[];
}

export type BillingOutcome =
  | { kind: 'invoice'; draft: InvoiceDraft }
  | { kind: 'nothing_to_bill'; contractId: string; period: string }
  | { kind: 'not_billable'; contractId: string; period: string; reason: 'draft' | 'invalid_period' };

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isValidPeriod(p: string): boolean {
  return PERIOD_RE.test(p);
}

export function periodBounds(period: string): { start: ISODate; end: ISODate } {
  const m = PERIOD_RE.exec(period);
  if (!m) throw new Error('Invalid billing period (expected YYYY-MM)');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return { start: toISO(y, mo, 1), end: toISO(y, mo, daysInMonth(y, mo)) };
}

export function idempotencyKey(contractId: string, period: string): string {
  return `${contractId}:${period}`;
}

export function taxCentsFor(subtotalCents: number, taxPercent: number): number {
  if (!Number.isFinite(taxPercent) || taxPercent <= 0) return 0;
  return Math.round((subtotalCents * taxPercent) / 100);
}

/** Calendar days of `period` on which the contract is in force and not paused. */
export function activeDaysInPeriod(c: Pick<BillingContract, 'start_date' | 'end_date' | 'pauses'>, period: string): { active: number; total: number } {
  const { start, end } = periodBounds(period);
  const total = daysBetween(start, end) + 1;
  const from = c.start_date > start ? c.start_date : start;
  const to = c.end_date && c.end_date < end ? c.end_date : end;
  if (to < from) return { active: 0, total };
  // Union of pause windows clipped to [from, to] (windows may overlap; count each day once).
  const clipped = (c.pauses ?? [])
    .map((p) => ({ from: p.from > from ? p.from : from, to: p.to === null || p.to > to ? to : p.to }))
    .filter((p) => p.to >= p.from)
    .sort((a, b) => (a.from < b.from ? -1 : 1));
  let paused = 0;
  let cursor: ISODate | null = null;
  for (const p of clipped) {
    const s: ISODate = cursor && p.from <= cursor ? addDays(cursor, 1) : p.from;
    if (p.to >= s) paused += daysBetween(s, p.to) + 1;
    if (!cursor || p.to > cursor) cursor = p.to;
  }
  return { active: Math.max(0, daysBetween(from, to) + 1 - paused), total };
}

const monthLabel = (period: string) => {
  const { start } = periodBounds(period);
  return new Date(`${start}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const dayLabel = (iso: ISODate) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * Build the draft invoice for one contract and month from its unbilled completed visits.
 * Pure and deterministic: same inputs ⇒ same draft (lines ordered by visit date, then id).
 */
export function buildInvoiceDraft(contract: BillingContract, visits: readonly VisitRow[], period: string): BillingOutcome {
  if (!isValidPeriod(period)) return { kind: 'not_billable', contractId: contract.id, period, reason: 'invalid_period' };
  if (contract.status === 'draft') return { kind: 'not_billable', contractId: contract.id, period, reason: 'draft' };
  const { end } = periodBounds(period);

  const billable = visits
    .filter((v) => v.contract_id === contract.id && v.status === 'completed' && !v.billed_invoice_id && v.visit_date <= end && v.price_cents > 0)
    .sort((a, b) => (a.visit_date === b.visit_date ? (a.id < b.id ? -1 : 1) : a.visit_date < b.visit_date ? -1 : 1));

  const lines: InvoiceLine[] = [];
  const visitIds: string[] = [];

  if (contract.billing_mode === 'monthly_flat') {
    const { active, total } = activeDaysInPeriod(contract, period);
    const amount = active === total ? contract.monthly_fee_cents : Math.round((contract.monthly_fee_cents * active) / total);
    if (active > 0 && amount > 0) {
      const suffix = active === total ? '' : ` (${active} of ${total} days)`;
      lines.push({ description: `${contract.title} — ${monthLabel(period)}${suffix}`, quantity: 1, unit_price_cents: amount });
    }
    for (const v of billable) {
      if (v.kind === 'maintenance' || v.kind === 'makeup') continue; // covered by the flat fee
      lines.push({ description: `${contract.title} — add-on, ${dayLabel(v.visit_date)}`, quantity: 1, unit_price_cents: v.price_cents });
      visitIds.push(v.id);
    }
  } else {
    for (const v of billable) {
      const what = v.kind === 'addon' ? 'add-on' : 'visit';
      lines.push({ description: `${contract.title} — ${what}, ${dayLabel(v.visit_date)}`, quantity: 1, unit_price_cents: v.price_cents });
      visitIds.push(v.id);
    }
  }

  // Flat-fee maintenance visits are marked billed too, so they are never re-listed.
  if (contract.billing_mode === 'monthly_flat' && lines.length) {
    for (const v of billable) if ((v.kind === 'maintenance' || v.kind === 'makeup') && v.visit_date <= end) visitIds.push(v.id);
  }

  if (!lines.length) return { kind: 'nothing_to_bill', contractId: contract.id, period };

  const subtotalCents = lines.reduce((s, l) => s + l.quantity * l.unit_price_cents, 0);
  const taxCents = taxCentsFor(subtotalCents, contract.tax_percent);
  return {
    kind: 'invoice',
    draft: {
      idempotencyKey: idempotencyKey(contract.id, period),
      contractId: contract.id,
      period,
      lines,
      subtotalCents,
      taxCents,
      totalCents: subtotalCents + taxCents,
      visitIds,
    },
  };
}

export interface BatchResult {
  period: string;
  created: InvoiceDraft[];
  skippedExisting: string[];
  nothingToBill: string[];
  notBillable: string[];
}

/**
 * Plan a whole batch. `existingKeys` are idempotency keys already stored — those contracts are
 * skipped untouched, which is exactly what makes a retried or double-clicked run safe.
 * Paused contracts are included: a pause removes days from a flat fee but may still owe completed visits.
 */
export function planBatch(
  contracts: readonly BillingContract[],
  visitsByContract: ReadonlyMap<string, readonly VisitRow[]>,
  period: string,
  existingKeys: ReadonlySet<string>,
): BatchResult {
  const result: BatchResult = { period, created: [], skippedExisting: [], nothingToBill: [], notBillable: [] };
  for (const c of [...contracts].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (existingKeys.has(idempotencyKey(c.id, period))) {
      result.skippedExisting.push(c.id);
      continue;
    }
    const out = buildInvoiceDraft(c, visitsByContract.get(c.id) ?? [], period);
    if (out.kind === 'invoice') result.created.push(out.draft);
    else if (out.kind === 'nothing_to_bill') result.nothingToBill.push(c.id);
    else result.notBillable.push(c.id);
  }
  return result;
}

