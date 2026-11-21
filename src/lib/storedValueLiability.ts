/**
 * Stored-value liability — pure domain helpers (no I/O). UI, API layer and tests import from here.
 * Data comes from the views in migration 20290306000000_stored_value_liability.sql.
 *
 * Nothing in this file (or the UI built on it) states a legal conclusion. "Past review period"
 * only compares last activity with a window the tenant (or counsel-reviewed config) supplied.
 * [COUNSEL][VERIFY]
 */

export type InstrumentKind = 'gift_card' | 'store_credit' | 'loyalty_points';
export type InactivityBucket = '0_180' | '181_365' | '366_730' | '731_plus';

export const INSTRUMENT_KINDS: readonly InstrumentKind[] = ['gift_card', 'store_credit', 'loyalty_points'];
export const INACTIVITY_BUCKETS: readonly InactivityBucket[] = ['0_180', '181_365', '366_730', '731_plus'];

export interface LiabilitySummaryRow {
  account_owner_id: string;
  instrument_kind: InstrumentKind;
  currency: string;
  instrument_count: number;
  outstanding_cents: number;
  expired_count: number;
  expired_cents: number;
  past_review_count: number;
  past_review_cents: number;
  unreconciled_count: number;
  oldest_activity_at: string | null;
}

export interface DormancyRow {
  account_owner_id: string;
  instrument_kind: InstrumentKind;
  currency: string;
  inactivity_bucket: InactivityBucket;
  instrument_count: number;
  balance_cents: number;
}

export interface InstrumentRow {
  account_owner_id: string;
  instrument_id: string;
  instrument_kind: InstrumentKind;
  balance_cents: number;
  currency: string;
  issued_at: string;
  expires_at: string | null;
  last_activity_at: string;
  reference_suffix: string;
  ledger_reconciled: boolean | null;
  is_expired: boolean;
  days_inactive: number;
  inactivity_bucket: InactivityBucket;
  review_period_months: number | null;
  past_review_period: boolean;
}

export interface StoredValueSettings {
  state_code: string | null;
  review_period_months: number | null;
  include_loyalty_points: boolean;
}

export const DEFAULT_SETTINGS: StoredValueSettings = {
  state_code: null,
  review_period_months: null,
  include_loyalty_points: false,
};

export interface LiabilityTotals {
  currency: string;
  instrumentCount: number;
  outstandingCents: number;
  expiredCents: number;
  pastReviewCents: number;
  unreconciledCount: number;
}

/** Sums rows per currency. Loyalty points are excluded unless the tenant opted in. Never mixes currencies. */
export function summarizeLiability(rows: readonly LiabilitySummaryRow[], includeLoyalty: boolean): LiabilityTotals[] {
  const byCurrency = new Map<string, LiabilityTotals>();
  for (const r of rows) {
    if (r.instrument_kind === 'loyalty_points' && !includeLoyalty) continue;
    const key = r.currency.toLowerCase();
    const t =
      byCurrency.get(key) ??
      { currency: key, instrumentCount: 0, outstandingCents: 0, expiredCents: 0, pastReviewCents: 0, unreconciledCount: 0 };
    t.instrumentCount += r.instrument_count;
    t.outstandingCents += r.outstanding_cents;
    t.expiredCents += r.expired_cents;
    t.pastReviewCents += r.past_review_cents;
    t.unreconciledCount += r.unreconciled_count;
    byCurrency.set(key, t);
  }
  return [...byCurrency.values()].sort((a, b) => b.outstandingCents - a.outstandingCents);
}

/** Distribution for one currency in fixed bucket order (empty buckets included so charts never jump). */
export function dormancyDistribution(
  rows: readonly DormancyRow[],
  currency: string,
  includeLoyalty: boolean,
): { bucket: InactivityBucket; count: number; cents: number }[] {
  const cur = currency.toLowerCase();
  return INACTIVITY_BUCKETS.map((bucket) => {
    let count = 0;
    let cents = 0;
    for (const r of rows) {
      if (r.currency.toLowerCase() !== cur || r.inactivity_bucket !== bucket) continue;
      if (r.instrument_kind === 'loyalty_points' && !includeLoyalty) continue;
      count += r.instrument_count;
      cents += r.balance_cents;
    }
    return { bucket, count, cents };
  });
}

export function formatCents(cents: number, currency = 'usd', locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** Accepts null (clears the value). Returns an i18n error key, or null when valid. */
export function validateSettings(input: { state_code: string; review_period_months: string }): {
  error: 'invalidState' | 'invalidPeriod' | null;
  value: { state_code: string | null; review_period_months: number | null };
} {
  const state = input.state_code.trim().toUpperCase();
  if (state !== '' && !/^[A-Z]{2}$/.test(state)) return { error: 'invalidState', value: { state_code: null, review_period_months: null } };
  const rawPeriod = input.review_period_months.trim();
  let period: number | null = null;
  if (rawPeriod !== '') {
    if (!/^\d{1,3}$/.test(rawPeriod)) return { error: 'invalidPeriod', value: { state_code: null, review_period_months: null } };
    period = Number(rawPeriod);
    if (period < 1 || period > 120) return { error: 'invalidPeriod', value: { state_code: null, review_period_months: null } };
  }
  return { error: null, value: { state_code: state === '' ? null : state, review_period_months: period } };
}

// ---------------------------------------------------------------------------
// CSV export (RFC 4180 + spreadsheet formula-injection guard)
// ---------------------------------------------------------------------------

export const CSV_COLUMNS = [
  'kind',
  'reference_last4',
  'currency',
  'balance',
  'issued_at',
  'expires_at',
  'last_activity_at',
  'days_inactive',
  'inactivity_bucket',
  'is_expired',
  'review_period_months',
  'past_review_period',
  'ledger_reconciled',
] as const;

/** Escapes one CSV cell. Leading = + - @ TAB CR are neutralised so Excel/Sheets never run them as formulas. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function instrumentsToCsv(rows: readonly InstrumentRow[], includeLoyalty: boolean): string {
  const lines: string[] = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    if (r.instrument_kind === 'loyalty_points' && !includeLoyalty) continue;
    lines.push(
      [
        r.instrument_kind,
        r.reference_suffix,
        r.currency,
        (r.balance_cents / 100).toFixed(2),
        r.issued_at,
        r.expires_at,
        r.last_activity_at,
        r.days_inactive,
        r.inactivity_bucket,
        r.is_expired,
        r.review_period_months,
        r.past_review_period,
        r.ledger_reconciled,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`; // BOM keeps UTF-8 intact in Excel
}

export function csvFileName(now: Date = new Date()): string {
  return `stored-value-${now.toISOString().slice(0, 10)}.csv`;
}
