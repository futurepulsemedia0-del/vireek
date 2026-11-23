// Pure helpers for partner revenue-share statements (/staff/partner-payouts): types, defensive parsing of the
// staff_partner_* RPC payloads, an integrity check, exact cent maths and the CSV builder. No I/O, no DOM.
// Source of truth for every number is the database (20290306000100_partner_revenue_share.sql); nothing here
// recomputes a payout, it only verifies that the statement adds up before it is exported or shown.
import { buildCsv, exportFilename, type CsvValue } from '@/lib/documents/exportFile';

export type PayoutStatus = 'calculated' | 'carried_forward' | 'approved' | 'paid' | 'void';
export type CarryReason = 'below_minimum' | 'negative_balance' | 'nothing_due';
export type LineType = 'earn' | 'clawback' | 'reinstatement' | 'legacy';

export interface PayoutRow {
  id: string;
  partner_id: string;
  company_name: string;
  channel: string | null;
  source: 'monthly' | 'adhoc';
  period_start: string | null;
  period_end: string | null;
  status: PayoutStatus;
  carry_reason: CarryReason | null;
  gross_cents: number;
  clawback_cents: number;
  net_cents: number;
  min_payout_cents: number;
  entry_count: number;
  agreement_version: number | null;
  calculated_at: string;
  approved_at: string | null;
  paid_at: string | null;
  payment_method: string | null;
  payment_reference: string | null;
}

export interface StatementLine {
  id: string;
  entry_type: LineType;
  earned_at: string;
  period_index: number | null;
  base_cents: number | null;
  rate_pct: number | null;
  amount_cents: number;
  stripe_invoice_id: string | null;
  source_kind: string | null;
  ref: string;
}

export interface PartnerStatement {
  id: string;
  partner_id: string;
  source: 'monthly' | 'adhoc';
  period_start: string | null;
  period_end: string | null;
  status: PayoutStatus;
  carry_reason: CarryReason | null;
  gross_cents: number;
  clawback_cents: number;
  net_cents: number;
  min_payout_cents: number;
  entry_count: number;
  agreement_version: number | null;
  calculated_at: string;
  approved_at: string | null;
  paid_at: string | null;
  payment_method: string | null;
  payment_reference: string | null;
  partner: { company_name: string; tier: string; channel: string | null; referral_code: string; commission_rate: number; commission_months: number };
  agreement: { version: number; revenue_share_pct: number; term_months: number; min_payout_cents: number; document_ref: string | null } | null;
  activity: { earned_cents: number; clawback_cents: number; reinstated_cents: number; legacy_cents: number; entries: number };
  carried_in_cents: number;
  held_cents: number;
  rounding_mismatches: number;
  lines_truncated: boolean;
  lines: StatementLine[];
}

export interface AgreementRow {
  id: string;
  version: number;
  status: 'draft' | 'active' | 'superseded' | 'terminated';
  revenue_share_pct: number;
  term_months: number;
  min_payout_cents: number;
  effective_from: string;
  effective_to: string | null;
  document_ref: string | null;
  counsel_confirmed_at: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : d;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : num(v, Number.NaN)) as number | null;

const STATUSES: ReadonlySet<string> = new Set(['calculated', 'carried_forward', 'approved', 'paid', 'void']);
const CARRY: ReadonlySet<string> = new Set(['below_minimum', 'negative_balance', 'nothing_due']);
const LINE_TYPES: ReadonlySet<string> = new Set(['earn', 'clawback', 'reinstatement', 'legacy']);
const AGREEMENT_STATUSES: ReadonlySet<string> = new Set(['draft', 'active', 'superseded', 'terminated']);

const carryOrNull = (v: unknown): CarryReason | null => (typeof v === 'string' && CARRY.has(v) ? (v as CarryReason) : null);

export function parsePayouts(raw: unknown): PayoutRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: PayoutRow[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.id !== 'string' || !STATUSES.has(String(r.status))) continue;
    rows.push({
      id: r.id,
      partner_id: str(r.partner_id),
      company_name: str(r.company_name, '—'),
      channel: strOrNull(r.channel),
      source: r.source === 'adhoc' ? 'adhoc' : 'monthly',
      period_start: strOrNull(r.period_start),
      period_end: strOrNull(r.period_end),
      status: r.status as PayoutStatus,
      carry_reason: carryOrNull(r.carry_reason),
      gross_cents: num(r.gross_cents),
      clawback_cents: num(r.clawback_cents),
      net_cents: num(r.net_cents),
      min_payout_cents: num(r.min_payout_cents),
      entry_count: num(r.entry_count),
      agreement_version: numOrNull(r.agreement_version),
      calculated_at: str(r.calculated_at),
      approved_at: strOrNull(r.approved_at),
      paid_at: strOrNull(r.paid_at),
      payment_method: strOrNull(r.payment_method),
      payment_reference: strOrNull(r.payment_reference),
    });
  }
  return rows;
}

function parseLine(l: unknown): StatementLine | null {
  if (!isObj(l) || typeof l.id !== 'string' || !LINE_TYPES.has(String(l.entry_type))) return null;
  return {
    id: l.id,
    entry_type: l.entry_type as LineType,
    earned_at: str(l.earned_at),
    period_index: numOrNull(l.period_index),
    base_cents: numOrNull(l.base_cents),
    rate_pct: numOrNull(l.rate_pct),
    amount_cents: num(l.amount_cents),
    stripe_invoice_id: strOrNull(l.stripe_invoice_id),
    source_kind: strOrNull(l.source_kind),
    ref: str(l.ref, l.id.slice(0, 8)),
  };
}

/** Returns null when the payload is not a statement (so callers can show an error instead of an empty document). */
export function parseStatement(raw: unknown): PartnerStatement | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !STATUSES.has(String(raw.status))) return null;
  const snap = isObj(raw.statement) ? raw.statement : {};
  const partner = isObj(snap.partner) ? snap.partner : {};
  const agr = isObj(snap.agreement) ? snap.agreement : null;
  const act = isObj(snap.activity) ? snap.activity : {};
  const lines: StatementLine[] = [];
  for (const l of Array.isArray(snap.lines) ? snap.lines : []) {
    const p = parseLine(l);
    if (p) lines.push(p);
  }
  return {
    id: raw.id,
    partner_id: str(raw.partner_id),
    source: raw.source === 'adhoc' ? 'adhoc' : 'monthly',
    period_start: strOrNull(raw.period_start),
    period_end: strOrNull(raw.period_end),
    status: raw.status as PayoutStatus,
    carry_reason: carryOrNull(raw.carry_reason),
    gross_cents: num(raw.gross_cents),
    clawback_cents: num(raw.clawback_cents),
    net_cents: num(raw.net_cents),
    min_payout_cents: num(raw.min_payout_cents),
    entry_count: num(raw.entry_count),
    agreement_version: numOrNull(raw.agreement_version),
    calculated_at: str(raw.calculated_at),
    approved_at: strOrNull(raw.approved_at),
    paid_at: strOrNull(raw.paid_at),
    payment_method: strOrNull(raw.payment_method),
    payment_reference: strOrNull(raw.payment_reference),
    partner: {
      company_name: str(partner.company_name, '—'),
      tier: str(partner.tier),
      channel: strOrNull(partner.channel),
      referral_code: str(partner.referral_code),
      commission_rate: num(partner.commission_rate),
      commission_months: num(partner.commission_months),
    },
    agreement: agr
      ? {
          version: num(agr.version),
          revenue_share_pct: num(agr.revenue_share_pct),
          term_months: num(agr.term_months),
          min_payout_cents: num(agr.min_payout_cents),
          document_ref: strOrNull(agr.document_ref),
        }
      : null,
    activity: {
      earned_cents: num(act.earned_cents),
      clawback_cents: num(act.clawback_cents),
      reinstated_cents: num(act.reinstated_cents),
      legacy_cents: num(act.legacy_cents),
      entries: num(act.entries),
    },
    carried_in_cents: num(snap.carried_in_cents),
    held_cents: num(snap.held_cents),
    rounding_mismatches: num(snap.rounding_mismatches),
    lines_truncated: snap.lines_truncated === true,
    lines,
  };
}

export function parseAgreements(raw: unknown): AgreementRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: AgreementRow[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.id !== 'string' || !AGREEMENT_STATUSES.has(String(r.status))) continue;
    rows.push({
      id: r.id,
      version: num(r.version),
      status: r.status as AgreementRow['status'],
      revenue_share_pct: num(r.revenue_share_pct),
      term_months: num(r.term_months),
      min_payout_cents: num(r.min_payout_cents),
      effective_from: str(r.effective_from),
      effective_to: strOrNull(r.effective_to),
      document_ref: strOrNull(r.document_ref),
      counsel_confirmed_at: strOrNull(r.counsel_confirmed_at),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------------------------------------ cent maths */

/**
 * Commission in cents, exactly as Postgres computes it: round(base x rate / 100) on numeric, half away from zero.
 * Integer arithmetic on the rate in hundredths of a percent, so there is no floating-point drift (the float form
 * Math.round(base * 19.99 / 100) is off by one cent for base 5000).
 */
export function exactCommissionCents(baseCents: number, ratePct: number): number {
  if (!Number.isFinite(baseCents) || !Number.isFinite(ratePct)) return 0;
  const hundredths = Math.round(ratePct * 100);
  const product = Math.abs(Math.trunc(baseCents)) * Math.abs(hundredths);
  const cents = Math.floor((product + 5000) / 10000);
  return baseCents < 0 !== hundredths < 0 ? -cents : cents;
}

/** Cents -> "1234.56" (no currency symbol, no grouping), safe for CSV. Integer maths only. */
export function centsToDecimal(cents: number): string {
  const v = Math.trunc(Number.isFinite(cents) ? cents : 0);
  const abs = Math.abs(v);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return v < 0 ? `-${s}` : s;
}

/* ------------------------------------------------------------------------------------------ integrity check */

export interface StatementCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Proves a statement adds up before it is shown/exported: net = gross + clawbacks, the lines sum to the totals,
 * and every earn line still equals round(base x rate). Lines are only compared when they were not truncated.
 */
export function verifyStatement(s: PartnerStatement): StatementCheck {
  const problems: string[] = [];
  if (s.net_cents !== s.gross_cents + s.clawback_cents) problems.push('net ≠ gross + clawbacks');
  if (s.gross_cents < 0 || s.clawback_cents > 0) problems.push('gross must be ≥ 0 and clawbacks ≤ 0');
  if (s.rounding_mismatches > 0) problems.push(`${s.rounding_mismatches} earn line(s) do not match round(base × rate)`);

  if (!s.lines_truncated && s.source === 'monthly') {
    const pos = s.lines.filter((l) => l.amount_cents > 0).reduce((a, l) => a + l.amount_cents, 0);
    const neg = s.lines.filter((l) => l.amount_cents < 0).reduce((a, l) => a + l.amount_cents, 0);
    if (pos !== s.gross_cents) problems.push('line total does not match gross');
    if (neg !== s.clawback_cents) problems.push('line total does not match clawbacks');
    if (s.lines.length !== s.entry_count) problems.push('line count does not match entry count');
  }
  for (const l of s.lines) {
    if (l.entry_type === 'earn' && l.base_cents !== null && l.rate_pct !== null && exactCommissionCents(l.base_cents, l.rate_pct) !== l.amount_cents) {
      problems.push(`earn line ${l.ref} ≠ round(base × rate)`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/* ------------------------------------------------------------------------------------------------- labels */

export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  calculated: 'Ready for approval',
  carried_forward: 'Carried forward',
  approved: 'Approved',
  paid: 'Paid',
  void: 'Void',
};

export const CARRY_REASON_LABEL: Record<CarryReason, string> = {
  below_minimum: 'Below the minimum payout',
  negative_balance: 'Clawbacks exceed earnings (negative balance)',
  nothing_due: 'Nothing due',
};

export const LINE_TYPE_LABEL: Record<LineType, string> = {
  earn: 'Commission',
  clawback: 'Clawback',
  reinstatement: 'Reinstatement',
  legacy: 'Pre-ledger estimate (approved)',
};

/** "2026-02-01" -> "February 2026" (UTC, so a statement never shifts a month with the viewer's time zone). */
export function periodLabel(periodStart: string | null): string {
  if (!periodStart || !/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) return 'Ad-hoc payout';
  const d = new Date(`${periodStart}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return periodStart;
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Last completed calendar month (UTC) as YYYY-MM-01: the default for the monthly run. */
export function lastClosedMonth(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based; previous month = m - 1
  const d = new Date(Date.UTC(y, m - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** True only for a YYYY-MM-01 value that is a completed month (UTC); mirrors the database check. */
export function isClosedMonth(periodStart: string, now: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-01$/.test(periodStart)) return false;
  const start = new Date(`${periodStart}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return false;
  const next = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
  return next <= Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** Readable text for the guardrail errors raised by the revenue-share RPCs. */
export function cleanPayoutError(message: string): string {
  const m = /(?:agreement_guardrail|payout_guardrail|commission_guardrail|stale_payout|period_not_closed):\s*(.+)$/s.exec(message);
  if (m) return m[1].trim();
  if (/Staff only/i.test(message)) return 'Staff only.';
  return message;
}

/* ------------------------------------------------------------------------------------------------------ CSV */

export type StatementAudience = 'finance' | 'partner';

const CSV_HEADERS_FINANCE = ['Partner', 'Statement period', 'Line type', 'Date', 'Ref', 'Stripe invoice', 'Referral month #', 'Base (USD)', 'Rate %', 'Amount (cents)', 'Amount (USD)'] as const;
const CSV_HEADERS_PARTNER = ['Partner', 'Statement period', 'Line type', 'Date', 'Ref', 'Referral month #', 'Base (USD)', 'Rate %', 'Amount (cents)', 'Amount (USD)'] as const;

const usd = (cents: number): number => Number(centsToDecimal(cents));
const dateOnly = (iso: string): string => (iso.length >= 10 ? iso.slice(0, 10) : iso);

/**
 * One row per statement line, then labelled summary rows. Text cells go through the shared formula-injection guard
 * (buildCsv/csvCell); amounts are real numbers, so a negative clawback stays numeric. `partner` audience drops
 * Stripe invoice ids (internal identifiers) and keeps everything a partner needs to reconcile.
 */
export function buildStatementCsv(s: PartnerStatement, audience: StatementAudience = 'finance'): string {
  const finance = audience === 'finance';
  const label = periodLabel(s.period_start);
  const row = (type: string, date: string, ref: string, invoice: string, idx: number | null, base: number | null, rate: number | null, cents: number | null): CsvValue[] => {
    const common: CsvValue[] = [s.partner.company_name, label, type, date, ref];
    const tail: CsvValue[] = [idx, base === null ? '' : usd(base), rate, cents, cents === null ? '' : usd(cents)];
    return finance ? [...common, invoice, ...tail] : [...common, ...tail];
  };

  const rows: CsvValue[][] = s.lines.map((l) =>
    row(LINE_TYPE_LABEL[l.entry_type], dateOnly(l.earned_at), l.ref, l.stripe_invoice_id ?? '', l.period_index, l.base_cents, l.rate_pct, l.amount_cents),
  );
  rows.push(row('SUMMARY', '', 'Gross commissions', '', null, null, null, s.gross_cents));
  rows.push(row('SUMMARY', '', 'Clawbacks netted', '', null, null, null, s.clawback_cents));
  rows.push(row('SUMMARY', '', 'Net balance', '', null, null, null, s.net_cents));
  rows.push(row('SUMMARY', '', 'Minimum payout', '', null, null, null, s.min_payout_cents));
  rows.push(row('SUMMARY', '', `Status: ${PAYOUT_STATUS_LABEL[s.status]}${s.carry_reason ? ` (${CARRY_REASON_LABEL[s.carry_reason]})` : ''}`, '', null, null, null, null));
  if (s.lines_truncated) rows.push(row('SUMMARY', '', 'Line list truncated at 5000; totals are complete', '', null, null, null, null));
  return buildCsv(finance ? CSV_HEADERS_FINANCE : CSV_HEADERS_PARTNER, rows);
}

export function statementFilename(s: Pick<PartnerStatement, 'period_start' | 'partner'>, ext: 'csv' | 'pdf', audience: StatementAudience = 'finance', date = new Date()): string {
  return exportFilename({
    business: s.partner.company_name,
    kind: audience === 'partner' ? 'partner-statement' : 'partner-statement-finance',
    ext,
    detail: s.period_start ? s.period_start.slice(0, 7) : 'adhoc',
    date,
  });
}
