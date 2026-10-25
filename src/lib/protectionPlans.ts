/**
 * Service Protection Plans — domain logic + data access.
 * Server counterpart: supabase/migrations/20271110000000_service_protection_plans.sql
 *
 * The pure money/date functions below mirror the SQL functions 1:1
 * (protection_coverage_end, protection_earned_cents, protection_refund_cents,
 * protection_payable_cents). Change one, change the other. All money is integer cents.
 * Dates are 'YYYY-MM-DD' strings handled in UTC so results never depend on the browser's timezone.
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// Types
// ============================================================

export type ContractStatus = 'pending_payment' | 'active' | 'expired' | 'cancelled';
/** Status as the customer experiences it (adds "scheduled" for renewals that start later). */
export type EffectiveStatus = ContractStatus | 'scheduled';
export type ContractSource = 'manual' | 'invoice' | 'quote' | 'renewal';
export type PlanClaimStatus = 'eligible' | 'packet_pending' | 'submitted' | 'approved' | 'denied' | 'credit_received' | 'closed';
export type PayoutMethod = 'account_credit' | 'check' | 'ach' | 'other';
export type CollectionMethod = 'cash' | 'check' | 'card' | 'bank_transfer' | 'other';

export interface PlanTemplate {
  id: string;
  name: string;
  description: string;
  term_months: number;
  price_cents: number;
  renewal_price_cents: number | null;
  deductible_cents: number;
  per_claim_limit_cents: number | null;
  aggregate_limit_cents: number | null;
  waiting_period_days: number;
  free_look_days: number;
  cancellation_fee_cents: number;
  reserve_percent: number;
  max_equipment: number;
  eligible_equipment_types: string[];
  max_equipment_age_years: number | null;
  covered_items: string[];
  exclusions: string[];
  terms: string;
  renewable: boolean;
  active: boolean;
  sort_order: number;
}

export interface CoveredUnit {
  equipment_id: string;
  linked_at: string;
  equipment: { id: string; equipment_type: string; make: string | null; model: string | null; serial_number: string | null } | null;
}

export interface ProtectionContract {
  id: string;
  template_id: string | null;
  contract_number: string;
  status: ContractStatus;
  source: ContractSource;
  customer_id: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  plan_name: string;
  term_months: number;
  price_cents: number;
  deductible_cents: number;
  per_claim_limit_cents: number | null;
  aggregate_limit_cents: number | null;
  waiting_period_days: number;
  free_look_days: number;
  cancellation_fee_cents: number;
  reserve_percent: number;
  max_equipment: number;
  renewable: boolean;
  quote_id: string | null;
  job_id: string | null;
  invoice_id: string | null;
  renewed_from_id: string | null;
  coverage_start: string | null;
  coverage_end: string | null;
  activated_at: string | null;
  activation_blocker: string | null;
  cancelled_effective: string | null;
  cancel_reason: string | null;
  refund_cents: number;
  paid_out_cents: number;
  renewal_offered_at: string | null;
  public_token: string;
  created_at: string;
  protection_contract_equipment: CoveredUnit[];
}

export interface PlanClaim {
  id: string;
  protection_contract_id: string;
  equipment_id: string | null;
  claim_number: string | null;
  status: PlanClaimStatus;
  customer_name: string;
  failure_date: string | null;
  failure_description: string | null;
  part_cost_cents: number | null;
  labor_cost_cents: number | null;
  claimed_amount_cents: number | null;
  deductible_cents: number | null;
  approved_amount_cents: number | null;
  credit_received_cents: number | null;
  credit_received_at: string | null;
  credit_method: PayoutMethod | null;
  denial_reason: string | null;
  notes: string | null;
  repair_job_id: string | null;
  submitted_at: string | null;
  created_at: string;
}

export interface ProtectionFinancials {
  as_of: string;
  contracts: { active: number; pending: number; expired: number; cancelled: number };
  written_premium_cents: number;
  refunds_cents: number;
  earned_cents: number;
  unearned_cents: number;
  claims_paid_cents: number;
  open_claims: number;
  case_reserve_cents: number;
  reserve_funded_cents: number;
  reserve_released_cents: number;
  reserve_balance_cents: number;
  reserve_shortfall_cents: number;
  /** Percent, or null when nothing has been earned yet. */
  loss_ratio_percent: number | null;
  underwriting_result_cents: number;
  monthly: { month: string; premium_written_cents: number; claims_paid_cents: number; refunds_cents: number }[];
}

export interface OpenInvoice {
  id: string;
  invoice_number: string | null;
  customer_name: string;
  status: string;
}

export interface OpenQuote {
  id: string;
  customer_name: string;
  status: string;
  optional_items: { id: string }[];
}

export interface CustomerOption {
  id: string;
  name: string;
}

export interface EquipmentOption {
  id: string;
  customer_id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  install_date: string | null;
  status: string;
}

// ============================================================
// Constants
// ============================================================

export const OFFER_ITEM_PREFIX = 'protection:';
export const MAX_PRICE_CENTS = 10_000_000;
export const RENEWAL_WINDOW_DAYS = 90;
export const RENEWAL_GRACE_DAYS = 30;
export const CLAIM_REPORTING_DAYS = 30;

export const CONTRACT_STATUS_LABELS: Record<EffectiveStatus, string> = {
  pending_payment: 'Awaiting payment',
  scheduled: 'Scheduled',
  active: 'Active',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

export const CONTRACT_STATUS_COLORS: Record<EffectiveStatus, string> = {
  pending_payment: 'bg-warning-500/10 text-warning-500',
  scheduled: 'bg-accent/10 text-accent',
  active: 'bg-success-500/10 text-success-500',
  expired: 'bg-bg-tertiary text-text-secondary',
  cancelled: 'bg-danger/10 text-danger',
};

export const CLAIM_STATUS_LABELS: Record<PlanClaimStatus, string> = {
  eligible: 'Received',
  packet_pending: 'Gathering documents',
  submitted: 'Under review',
  approved: 'Approved — payout due',
  denied: 'Denied',
  credit_received: 'Paid',
  closed: 'Closed',
};

export const CLAIM_STATUS_COLORS: Record<PlanClaimStatus, string> = {
  eligible: 'bg-bg-tertiary text-text-secondary',
  packet_pending: 'bg-accent/10 text-accent',
  submitted: 'bg-warning-500/10 text-warning-500',
  approved: 'bg-success-500/10 text-success-500',
  denied: 'bg-danger/10 text-danger',
  credit_received: 'bg-success-500/10 text-success-500',
  closed: 'bg-bg-tertiary text-text-secondary',
};

export const PAYOUT_METHOD_LABELS: Record<PayoutMethod, string> = {
  account_credit: 'Account / bill credit',
  check: 'Check',
  ach: 'ACH / bank transfer',
  other: 'Other',
};

export const COLLECTION_METHOD_LABELS: Record<CollectionMethod, string> = {
  cash: 'Cash',
  check: 'Check',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  other: 'Other',
};

export const OPEN_CLAIM_STATUSES: readonly PlanClaimStatus[] = ['eligible', 'packet_pending', 'submitted', 'approved'];

export const TEMPLATE_PRESETS: ReadonlyArray<Pick<PlanTemplate,
  'name' | 'description' | 'term_months' | 'price_cents' | 'deductible_cents' | 'per_claim_limit_cents' | 'aggregate_limit_cents' | 'covered_items' | 'exclusions'>> = [
  {
    name: 'Essential Protection',
    description: 'Parts and labor for covered breakdowns.',
    term_months: 12,
    price_cents: 19_900,
    deductible_cents: 7_500,
    per_claim_limit_cents: 100_000,
    aggregate_limit_cents: 200_000,
    covered_items: ['Parts', 'Labor'],
    exclusions: ['Cosmetic damage', 'Pre-existing conditions', 'Improper use or neglect'],
  },
  {
    name: 'Complete Protection',
    description: 'Broader coverage with a lower deductible and higher limits.',
    term_months: 36,
    price_cents: 54_900,
    deductible_cents: 0,
    per_claim_limit_cents: 250_000,
    aggregate_limit_cents: 600_000,
    covered_items: ['Parts', 'Labor', 'Refrigerant'],
    exclusions: ['Cosmetic damage', 'Pre-existing conditions', 'Acts of nature'],
  },
];

// ============================================================
// Money + dates (pure)
// ============================================================

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDate(value: string): number {
  const m = DATE_RE.exec(value.slice(0, 10));
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function todayString(now: Date = new Date()): string {
  return formatDate(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

export function addDays(date: string, days: number): string {
  return formatDate(parseDate(date) + days * DAY_MS);
}

export function diffDays(later: string, earlier: string): number {
  return Math.round((parseDate(later) - parseDate(earlier)) / DAY_MS);
}

/** start + N months, clamped to the last day of the target month (matches Postgres date + interval). */
export function addMonths(date: string, months: number): string {
  const ms = parseDate(date);
  const d = new Date(ms);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return formatDate(Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay)));
}

/** Inclusive last covered day: start + term - 1 day. */
export function coverageEnd(start: string, termMonths: number): string {
  return addDays(addMonths(start, termMonths), -1);
}

export function termDays(start: string, end: string): number {
  return diffDays(end, start) + 1;
}

export function earnedCents(priceCents: number, start: string | null, end: string | null, asOf: string): number {
  if (!start || !end) return 0;
  const total = termDays(start, end);
  if (total <= 0) return 0;
  const elapsed = Math.min(Math.max(diffDays(asOf, start) + 1, 0), total);
  return Math.floor((priceCents * elapsed) / total);
}

export function unearnedCents(priceCents: number, start: string | null, end: string | null, asOf: string): number {
  return priceCents - earnedCents(priceCents, start, end, asOf);
}

export interface RefundInput {
  priceCents: number;
  start: string | null;
  end: string | null;
  effective: string;
  freeLookDays: number;
  feeCents: number;
  paidOutCents: number;
  /** Claims that are not denied (open, approved or paid). */
  claimsFiled: number;
}

export function refundCents(i: RefundInput): number {
  if (!i.start || !i.end || diffDays(i.end, i.start) < 0) return i.priceCents;
  const total = termDays(i.start, i.end);
  const used = Math.min(Math.max(diffDays(i.effective, i.start), 0), total);
  if (diffDays(i.effective, i.start) <= i.freeLookDays && i.paidOutCents === 0 && i.claimsFiled === 0) return i.priceCents;
  const unearned = Math.floor((i.priceCents * (total - used)) / total);
  return Math.min(i.priceCents, Math.max(0, unearned - i.feeCents - i.paidOutCents));
}

/** min(claimed − deductible, per-claim limit, aggregate remaining), floored at 0. null limit = unlimited. */
export function payableCents(claimed: number, deductible: number, perClaimLimit: number | null, aggregateRemaining: number | null): number {
  let net = Math.max(claimed - deductible, 0);
  if (perClaimLimit !== null) net = Math.min(net, perClaimLimit);
  if (aggregateRemaining !== null) net = Math.min(net, Math.max(aggregateRemaining, 0));
  return net;
}

/** aggregate_limit − paid − approved-but-unpaid (excluding one claim). null = unlimited. */
export function remainingCents(
  contract: Pick<ProtectionContract, 'aggregate_limit_cents' | 'paid_out_cents'>,
  claims: Pick<PlanClaim, 'id' | 'status' | 'approved_amount_cents'>[],
  excludeClaimId?: string,
): number | null {
  if (contract.aggregate_limit_cents === null) return null;
  const committed = claims
    .filter((c) => c.status === 'approved' && c.id !== excludeClaimId)
    .reduce((s, c) => s + (c.approved_amount_cents ?? 0), 0);
  return Math.max(0, contract.aggregate_limit_cents - contract.paid_out_cents - committed);
}

/** First date a unit is covered: max(coverage start, link date) + waiting period. */
export function coveredFrom(
  contract: Pick<ProtectionContract, 'coverage_start' | 'waiting_period_days'>,
  linkedAt: string,
): string | null {
  if (!contract.coverage_start) return null;
  const linked = linkedAt.slice(0, 10);
  const base = parseDate(linked) > parseDate(contract.coverage_start) ? linked : contract.coverage_start;
  return addDays(base, contract.waiting_period_days);
}

export type ClaimBlock =
  | 'not_active'
  | 'outside_term'
  | 'reporting_window_closed'
  | 'waiting_period'
  | 'aggregate_limit_reached'
  | 'future_date';

/** Mirrors the checks in file_protection_claim(); the server remains the authority. */
export function claimBlockReason(
  contract: Pick<ProtectionContract, 'status' | 'coverage_start' | 'coverage_end' | 'waiting_period_days' | 'aggregate_limit_cents' | 'paid_out_cents'>,
  unit: Pick<CoveredUnit, 'linked_at'>,
  failureDate: string,
  claims: Pick<PlanClaim, 'id' | 'status' | 'approved_amount_cents'>[],
  today: string = todayString(),
): ClaimBlock | null {
  if (contract.status !== 'active' && contract.status !== 'expired') return 'not_active';
  if (!contract.coverage_start || !contract.coverage_end) return 'not_active';
  if (parseDate(failureDate) > parseDate(today)) return 'future_date';
  if (parseDate(failureDate) < parseDate(contract.coverage_start) || parseDate(failureDate) > parseDate(contract.coverage_end)) return 'outside_term';
  if (diffDays(today, contract.coverage_end) > CLAIM_REPORTING_DAYS) return 'reporting_window_closed';
  const from = coveredFrom(contract, unit.linked_at);
  if (from && parseDate(failureDate) < parseDate(from)) return 'waiting_period';
  const remaining = remainingCents(contract, claims);
  if (remaining !== null && remaining <= 0) return 'aggregate_limit_reached';
  return null;
}

export const CLAIM_BLOCK_MESSAGES: Record<ClaimBlock, string> = {
  not_active: 'This plan is not active.',
  outside_term: 'The failure date is outside the plan’s coverage term.',
  reporting_window_closed: `The ${CLAIM_REPORTING_DAYS}-day reporting window after the plan ended has closed.`,
  waiting_period: 'The failure happened inside the waiting period for this unit.',
  aggregate_limit_reached: 'The plan’s total coverage limit has been used up.',
  future_date: 'The failure date cannot be in the future.',
};

export function effectiveStatus(c: Pick<ProtectionContract, 'status' | 'coverage_start' | 'coverage_end'>, today: string = todayString()): EffectiveStatus {
  if (c.status === 'active' && c.coverage_end && parseDate(c.coverage_end) < parseDate(today)) return 'expired';
  if (c.status === 'active' && c.coverage_start && parseDate(c.coverage_start) > parseDate(today)) return 'scheduled';
  return c.status;
}

export type RenewalState = 'not_applicable' | 'too_early' | 'due' | 'renewed' | 'lapsed';

export function renewalState(
  c: Pick<ProtectionContract, 'id' | 'status' | 'coverage_end' | 'renewable'>,
  all: Pick<ProtectionContract, 'renewed_from_id' | 'status'>[],
  today: string = todayString(),
): RenewalState {
  if (!c.renewable || !c.coverage_end || (c.status !== 'active' && c.status !== 'expired')) return 'not_applicable';
  const children = all.filter(
    (x) => x.renewed_from_id === c.id && (x.status === 'pending_payment' || x.status === 'active'),
  );
  if (children.length > 0) return 'renewed';
  const untilEnd = diffDays(c.coverage_end, today);
  if (untilEnd > RENEWAL_WINDOW_DAYS) return 'too_early';
  if (untilEnd < -RENEWAL_GRACE_DAYS) return 'lapsed';
  return 'due';
}

export function daysLeftLabel(end: string | null, today: string = todayString()): string {
  if (!end) return '—';
  const d = diffDays(end, today);
  if (d === 0) return 'Ends today';
  if (d === 1) return '1 day left';
  if (d > 1) return `${d} days left`;
  if (d === -1) return 'Ended yesterday';
  return `Ended ${-d} days ago`;
}

export function isOpenClaim(status: PlanClaimStatus): boolean {
  return OPEN_CLAIM_STATUSES.includes(status);
}

// ============================================================
// Formatting + parsing (pure)
// ============================================================

export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rest = abs % 100;
  const base = `$${dollars.toLocaleString('en-US')}${rest === 0 ? '' : `.${String(rest).padStart(2, '0')}`}`;
  return negative ? `−${base}` : base;
}

export type MoneyParse = { ok: true; cents: number } | { ok: false; error: string };

/** "$1,234.50" → 123450. Rejects negatives, >2 decimals and anything non-numeric. */
export function parseMoney(input: string, opts: { allowZero?: boolean; max?: number } = {}): MoneyParse {
  const cleaned = input.trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { ok: false, error: 'Enter an amount like 249 or 249.50.' };
  const cents = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(cents)) return { ok: false, error: 'Enter a valid amount.' };
  if (!opts.allowZero && cents <= 0) return { ok: false, error: 'Amount must be greater than $0.' };
  const max = opts.max ?? MAX_PRICE_CENTS;
  if (cents > max) return { ok: false, error: `Amount cannot exceed ${formatMoney(max)}.` };
  return { ok: true, cents };
}

export function termLabel(months: number): string {
  if (months % 12 === 0) {
    const y = months / 12;
    return y === 1 ? '1 year' : `${y} years`;
  }
  return months === 1 ? '1 month' : `${months} months`;
}

export function offerItemId(templateId: string): string {
  return `${OFFER_ITEM_PREFIX}${templateId}`;
}

export function isOfferedOnQuote(quote: Pick<OpenQuote, 'optional_items'>, templateId: string): boolean {
  const id = offerItemId(templateId);
  return Array.isArray(quote.optional_items) && quote.optional_items.some((i) => i?.id === id);
}

// ============================================================
// Template form validation (pure)
// ============================================================

export interface TemplateInput {
  name: string;
  description: string;
  term_months: number;
  price_cents: number;
  renewal_price_cents: number | null;
  deductible_cents: number;
  per_claim_limit_cents: number | null;
  aggregate_limit_cents: number | null;
  waiting_period_days: number;
  free_look_days: number;
  cancellation_fee_cents: number;
  reserve_percent: number;
  max_equipment: number;
  eligible_equipment_types: string[];
  max_equipment_age_years: number | null;
  covered_items: string[];
  exclusions: string[];
  terms: string;
  renewable: boolean;
  active: boolean;
}

export const EMPTY_TEMPLATE: TemplateInput = {
  name: '',
  description: '',
  term_months: 12,
  price_cents: 0,
  renewal_price_cents: null,
  deductible_cents: 0,
  per_claim_limit_cents: null,
  aggregate_limit_cents: null,
  waiting_period_days: 30,
  free_look_days: 30,
  cancellation_fee_cents: 0,
  reserve_percent: 35,
  max_equipment: 1,
  eligible_equipment_types: [],
  max_equipment_age_years: null,
  covered_items: [],
  exclusions: [],
  terms: '',
  renewable: true,
  active: true,
};

const intIn = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;

export function cleanList(items: string[], maxLen: number, maxItems = 30): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const t = raw.trim().slice(0, maxLen);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function parseList(text: string): string[] {
  return text.split(/[\n,]/);
}

/** Mirrors the CHECK constraints on protection_plan_templates. Returns [] when valid. */
export function validateTemplate(t: TemplateInput): string[] {
  const e: string[] = [];
  if (t.name.trim().length < 1 || t.name.trim().length > 120) e.push('Give the plan a name (max 120 characters).');
  if (t.description.length > 1000) e.push('Description is limited to 1,000 characters.');
  if (!intIn(t.term_months, 1, 120)) e.push('Term must be between 1 and 120 months.');
  if (!intIn(t.price_cents, 1, MAX_PRICE_CENTS)) e.push('Price must be between $0.01 and $100,000.');
  if (t.renewal_price_cents !== null && !intIn(t.renewal_price_cents, 1, MAX_PRICE_CENTS)) e.push('Renewal price must be between $0.01 and $100,000.');
  if (!intIn(t.deductible_cents, 0, 1_000_000)) e.push('Deductible must be between $0 and $10,000.');
  if (t.per_claim_limit_cents !== null && !intIn(t.per_claim_limit_cents, 1, 2_147_483_647)) e.push('Per-claim limit must be above $0.');
  if (t.aggregate_limit_cents !== null && !intIn(t.aggregate_limit_cents, 1, 2_147_483_647)) e.push('Total coverage limit must be above $0.');
  if (t.per_claim_limit_cents !== null && t.aggregate_limit_cents !== null && t.per_claim_limit_cents > t.aggregate_limit_cents) {
    e.push('The per-claim limit cannot exceed the total coverage limit.');
  }
  if (!intIn(t.waiting_period_days, 0, 365)) e.push('Waiting period must be between 0 and 365 days.');
  if (!intIn(t.free_look_days, 0, 90)) e.push('Free-look period must be between 0 and 90 days.');
  if (!intIn(t.cancellation_fee_cents, 0, 1_000_000)) e.push('Cancellation fee must be between $0 and $10,000.');
  if (!(Number.isFinite(t.reserve_percent) && t.reserve_percent >= 0 && t.reserve_percent <= 100)) e.push('Claims reserve must be between 0% and 100%.');
  if (!intIn(t.max_equipment, 1, 50)) e.push('Units per plan must be between 1 and 50.');
  if (t.max_equipment_age_years !== null && !intIn(t.max_equipment_age_years, 0, 60)) e.push('Maximum unit age must be between 0 and 60 years.');
  if (t.terms.length > 20_000) e.push('Terms are limited to 20,000 characters.');
  if (t.deductible_cents > 0 && t.per_claim_limit_cents !== null && t.deductible_cents >= t.per_claim_limit_cents) {
    e.push('The deductible should be lower than the per-claim limit, otherwise nothing is ever payable.');
  }
  return e;
}

/** Normalises list fields before saving; never mutates the input. */
export function toTemplateRow(t: TemplateInput): TemplateInput {
  return {
    ...t,
    name: t.name.trim(),
    description: t.description.trim(),
    eligible_equipment_types: cleanList(t.eligible_equipment_types, 60),
    covered_items: cleanList(t.covered_items, 120),
    exclusions: cleanList(t.exclusions, 160),
    terms: t.terms.trim(),
  };
}

// ============================================================
// Errors
// ============================================================

const ERROR_MESSAGES: Array<[string, string]> = [
  ['not_authenticated', 'Please sign in again.'],
  ['permission_denied', 'You do not have permission to manage billing.'],
  ['template_not_found', 'That plan no longer exists.'],
  ['template_inactive', 'That plan is switched off. Activate it first.'],
  ['customer_not_found', 'Customer not found.'],
  ['equipment_required', 'Choose at least one unit to cover.'],
  ['equipment_not_found', 'One of the selected units no longer exists.'],
  ['equipment_not_active', 'Only active units can be covered (not replaced or removed ones).'],
  ['equipment_customer_mismatch', 'All covered units must belong to the plan’s customer.'],
  ['equipment_type_not_eligible', 'This plan does not cover that type of equipment.'],
  ['equipment_too_old', 'That unit is older than this plan allows.'],
  ['equipment_age_unknown', 'This plan has an age limit — add the unit’s install date first.'],
  ['too_many_equipment', 'This plan covers fewer units than selected.'],
  ['equipment_already_covered', 'A unit is already covered by another active plan for those dates.'],
  ['invoice_not_found', 'Invoice not found.'],
  ['invoice_not_open', 'Only draft or unpaid invoices can take a plan.'],
  ['invoice_line_missing', 'The plan line was removed from the paid invoice. Activate manually or re-attach.'],
  ['activate_via_invoice', 'This plan is on an invoice — it activates automatically when that invoice is paid.'],
  ['contract_not_found', 'Plan not found.'],
  ['contract_not_pending', 'This plan is no longer waiting for payment.'],
  ['contract_not_editable', 'This plan can no longer be edited.'],
  ['contract_not_cancellable', 'This plan cannot be cancelled.'],
  ['contract_not_renewable', 'This plan cannot be renewed.'],
  ['contract_not_active', 'This plan is not active.'],
  ['contract_not_deletable', 'Sold plans cannot be deleted — cancel them instead.'],
  ['already_renewed', 'A renewal already exists for this plan.'],
  ['renewal_too_early', `Renewals open ${RENEWAL_WINDOW_DAYS} days before the plan ends.`],
  ['renewal_window_closed', `The renewal window closed ${RENEWAL_GRACE_DAYS} days after the plan ended. Sell a new plan instead.`],
  ['invalid_payment_method', 'Choose how the payment was received.'],
  ['invalid_start_date', 'Start date must be within 30 days back or 90 days ahead.'],
  ['invalid_effective_date', 'Pick a valid cancellation date (not before any claim).'],
  ['reason_required', 'A reason is required.'],
  ['open_claims', 'Resolve or pay the open claims before cancelling.'],
  ['quote_not_found', 'Quote not found.'],
  ['quote_not_open', 'Plans can only be offered on draft or sent quotes.'],
  ['already_offered', 'This plan is already offered on that quote.'],
  ['too_many_items', 'A quote can carry at most 12 add-ons.'],
  ['job_not_found', 'Job not found.'],
  ['failure_outside_term', CLAIM_BLOCK_MESSAGES.outside_term],
  ['reporting_window_closed', CLAIM_BLOCK_MESSAGES.reporting_window_closed],
  ['within_waiting_period', CLAIM_BLOCK_MESSAGES.waiting_period],
  ['aggregate_limit_reached', CLAIM_BLOCK_MESSAGES.aggregate_limit_reached],
  ['equipment_not_covered', 'That unit is not covered by this plan.'],
  ['invalid_failure_date', CLAIM_BLOCK_MESSAGES.future_date],
  ['description_required', 'Describe what failed.'],
  ['invalid_amount', 'Enter the part and/or labor cost.'],
  ['claim_not_found', 'Claim not found.'],
  ['claim_not_pending', 'This claim has already been decided.'],
  ['claim_not_approved', 'Approve the claim before paying it.'],
  ['claim_not_closable', 'Only paid or denied claims can be closed.'],
  ['exceeds_coverage', 'That amount is more than the plan covers for this claim.'],
  ['nothing_payable', 'After the deductible and limits nothing is payable.'],
  ['invalid_action', 'Unknown action.'],
  ['protection_claim_locked', 'Plan claims can only be changed from the Protection Plans page.'],
  ['protection_claims_via_rpc_only', 'Plan claims can only be filed from the Protection Plans page.'],
];

export function protectionErrorMessage(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const raw = e instanceof Error ? e.message : typeof (e as { message?: unknown })?.message === 'string' ? (e as { message: string }).message : '';
  if (!raw) return fallback;
  const hit = ERROR_MESSAGES.find(([code]) => raw.includes(code));
  return hit ? hit[1] : fallback;
}

/** Human text for protection_contracts.activation_blocker (a raw error code). */
export function blockerMessage(code: string | null): string | null {
  if (!code) return null;
  const hit = ERROR_MESSAGES.find(([c]) => code.includes(c));
  return hit ? hit[1] : 'Activation needs attention.';
}

// ============================================================
// Parsing server JSON (defensive — never throws)
// ============================================================

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function parseFinancials(raw: unknown): ProtectionFinancials {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const c = (r.contracts && typeof r.contracts === 'object' ? r.contracts : {}) as Record<string, unknown>;
  const monthly = Array.isArray(r.monthly) ? r.monthly : [];
  return {
    as_of: typeof r.as_of === 'string' ? r.as_of : todayString(),
    contracts: { active: num(c.active), pending: num(c.pending), expired: num(c.expired), cancelled: num(c.cancelled) },
    written_premium_cents: num(r.written_premium_cents),
    refunds_cents: num(r.refunds_cents),
    earned_cents: num(r.earned_cents),
    unearned_cents: num(r.unearned_cents),
    claims_paid_cents: num(r.claims_paid_cents),
    open_claims: num(r.open_claims),
    case_reserve_cents: num(r.case_reserve_cents),
    reserve_funded_cents: num(r.reserve_funded_cents),
    reserve_released_cents: num(r.reserve_released_cents),
    reserve_balance_cents: num(r.reserve_balance_cents),
    reserve_shortfall_cents: num(r.reserve_shortfall_cents),
    loss_ratio_percent: typeof r.loss_ratio_percent === 'number' && Number.isFinite(r.loss_ratio_percent) ? r.loss_ratio_percent : null,
    underwriting_result_cents: num(r.underwriting_result_cents),
    monthly: monthly
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
      .map((m) => ({
        month: typeof m.month === 'string' ? m.month : '',
        premium_written_cents: num(m.premium_written_cents),
        claims_paid_cents: num(m.claims_paid_cents),
        refunds_cents: num(m.refunds_cents),
      })),
  };
}

export interface PublicCertificate {
  business_name: string | null;
  contract_number: string;
  plan_name: string;
  status: ContractStatus;
  customer_name: string;
  coverage_start: string | null;
  coverage_end: string | null;
  term_months: number;
  price_cents: number;
  deductible_cents: number;
  per_claim_limit_cents: number | null;
  aggregate_limit_cents: number | null;
  waiting_period_days: number;
  free_look_days: number;
  covered_items: string[];
  exclusions: string[];
  terms: string;
  equipment: { equipment_type: string; make: string | null; model: string | null; serial_last4: string | null }[];
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const nullableNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nullableStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function parseCertificate(raw: unknown): PublicCertificate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.contract_number !== 'string' || typeof r.plan_name !== 'string') return null;
  const status = r.status === 'active' || r.status === 'expired' || r.status === 'pending_payment' || r.status === 'cancelled' ? r.status : 'pending_payment';
  return {
    business_name: nullableStr(r.business_name),
    contract_number: r.contract_number,
    plan_name: r.plan_name,
    status,
    customer_name: typeof r.customer_name === 'string' ? r.customer_name : '',
    coverage_start: nullableStr(r.coverage_start),
    coverage_end: nullableStr(r.coverage_end),
    term_months: num(r.term_months),
    price_cents: num(r.price_cents),
    deductible_cents: num(r.deductible_cents),
    per_claim_limit_cents: nullableNum(r.per_claim_limit_cents),
    aggregate_limit_cents: nullableNum(r.aggregate_limit_cents),
    waiting_period_days: num(r.waiting_period_days),
    free_look_days: num(r.free_look_days),
    covered_items: strList(r.covered_items),
    exclusions: strList(r.exclusions),
    terms: typeof r.terms === 'string' ? r.terms : '',
    equipment: (Array.isArray(r.equipment) ? r.equipment : [])
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .map((e) => ({
        equipment_type: typeof e.equipment_type === 'string' ? e.equipment_type : 'Equipment',
        make: nullableStr(e.make),
        model: nullableStr(e.model),
        serial_last4: nullableStr(e.serial_last4),
      })),
  };
}

export function certificateLink(token: string, origin: string = typeof window !== 'undefined' ? window.location.origin : ''): string {
  return `${origin}/protection/${token}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================
// Data access (throws Error with the server's code in the message)
// ============================================================

const TEMPLATE_COLUMNS =
  'id, name, description, term_months, price_cents, renewal_price_cents, deductible_cents, per_claim_limit_cents, aggregate_limit_cents, waiting_period_days, free_look_days, cancellation_fee_cents, reserve_percent, max_equipment, eligible_equipment_types, max_equipment_age_years, covered_items, exclusions, terms, renewable, active, sort_order';

const CONTRACT_COLUMNS =
  'id, template_id, contract_number, status, source, customer_id, customer_name, customer_email, customer_phone, plan_name, term_months, price_cents, deductible_cents, per_claim_limit_cents, aggregate_limit_cents, waiting_period_days, free_look_days, cancellation_fee_cents, reserve_percent, max_equipment, renewable, quote_id, job_id, invoice_id, renewed_from_id, coverage_start, coverage_end, activated_at, activation_blocker, cancelled_effective, cancel_reason, refund_cents, paid_out_cents, renewal_offered_at, public_token, created_at, protection_contract_equipment(equipment_id, linked_at, equipment(id, equipment_type, make, model, serial_number))';

const CLAIM_COLUMNS =
  'id, protection_contract_id, equipment_id, claim_number, status, customer_name, failure_date, failure_description, part_cost_cents, labor_cost_cents, claimed_amount_cents, deductible_cents, approved_amount_cents, credit_received_cents, credit_received_at, credit_method, denial_reason, notes, repair_job_id, submitted_at, created_at';

function fail(error: { message?: string } | null | undefined, fallback: string): never {
  throw new Error(error?.message || fallback);
}

export async function fetchTemplates(): Promise<PlanTemplate[]> {
  const { data, error } = await supabase
    .from('protection_plan_templates')
    .select(TEMPLATE_COLUMNS)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) fail(error, 'Could not load plans');
  return (data ?? []) as unknown as PlanTemplate[];
}

export async function saveTemplate(ownerId: string, input: TemplateInput, id?: string): Promise<void> {
  const row = toTemplateRow(input);
  const errors = validateTemplate(row);
  if (errors.length) throw new Error(errors[0]);
  const query = id
    ? supabase.from('protection_plan_templates').update(row).eq('id', id)
    : supabase.from('protection_plan_templates').insert({ ...row, user_id: ownerId });
  const { error } = await query;
  if (error) fail(error, 'Could not save the plan');
}

export async function setTemplateActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('protection_plan_templates').update({ active }).eq('id', id);
  if (error) fail(error, 'Could not update the plan');
}

export async function fetchContracts(): Promise<ProtectionContract[]> {
  const { data, error } = await supabase
    .from('protection_contracts')
    .select(CONTRACT_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) fail(error, 'Could not load protection plans');
  return (data ?? []) as unknown as ProtectionContract[];
}

export async function fetchContractsForInvoice(invoiceId: string): Promise<ProtectionContract[]> {
  const { data, error } = await supabase
    .from('protection_contracts')
    .select(CONTRACT_COLUMNS)
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: true });
  if (error) fail(error, 'Could not load protection plans');
  return (data ?? []) as unknown as ProtectionContract[];
}

export async function fetchPlanClaims(): Promise<PlanClaim[]> {
  const { data, error } = await supabase
    .from('warranty_claims')
    .select(CLAIM_COLUMNS)
    .eq('claim_type', 'protection_plan')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) fail(error, 'Could not load claims');
  return (data ?? []) as unknown as PlanClaim[];
}

export async function fetchOpenInvoices(): Promise<OpenInvoice[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, invoice_number, customer_name, status')
    .in('status', ['draft', 'sent', 'viewed'])
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) fail(error, 'Could not load invoices');
  return (data ?? []) as unknown as OpenInvoice[];
}

export async function fetchOpenQuotes(): Promise<OpenQuote[]> {
  const { data, error } = await supabase
    .from('quotes')
    .select('id, customer_name, status, optional_items')
    .in('status', ['draft', 'sent'])
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) fail(error, 'Could not load quotes');
  return ((data ?? []) as unknown as OpenQuote[]).map((q) => ({ ...q, optional_items: Array.isArray(q.optional_items) ? q.optional_items : [] }));
}

export async function searchCustomers(term: string): Promise<CustomerOption[]> {
  const t = term.trim().replace(/[%,()]/g, ' ').slice(0, 60);
  let q = supabase.from('customers').select('id, name').order('name', { ascending: true }).limit(20);
  if (t) q = q.ilike('name', `%${t}%`);
  const { data, error } = await q;
  if (error) fail(error, 'Could not load customers');
  return (data ?? []) as unknown as CustomerOption[];
}

export async function fetchCustomerEquipment(customerId: string): Promise<EquipmentOption[]> {
  const { data, error } = await supabase
    .from('equipment')
    .select('id, customer_id, equipment_type, make, model, serial_number, install_date, status')
    .eq('customer_id', customerId)
    .eq('status', 'active')
    .order('equipment_type', { ascending: true });
  if (error) fail(error, 'Could not load equipment');
  return (data ?? []) as unknown as EquipmentOption[];
}

export async function fetchFinancials(): Promise<ProtectionFinancials> {
  const { data, error } = await supabase.rpc('get_protection_plan_financials', { p_as_of: null });
  if (error) fail(error, 'Could not load financials');
  return parseFinancials(data);
}

/** Idempotent: expires finished plans and releases reserves. Safe to call on every page load. */
export async function runLifecycle(): Promise<void> {
  try {
    await supabase.rpc('run_protection_lifecycle');
  } catch {
    /* housekeeping only — never blocks the page */
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) fail(error, 'Request failed');
  return data as T;
}

export const sellPlan = (p: { templateId: string; customerId: string; equipmentIds: string[]; invoiceId?: string | null; jobId?: string | null }) =>
  rpc<{ id: string; contract_number: string }>('sell_protection_plan', {
    p_template_id: p.templateId,
    p_customer_id: p.customerId,
    p_equipment_ids: p.equipmentIds,
    p_invoice_id: p.invoiceId ?? null,
    p_job_id: p.jobId ?? null,
  });

export const offerOnQuote = (quoteId: string, templateId: string, optionIds: string[] = []) =>
  rpc<{ item_id: string }>('offer_protection_plan_on_quote', { p_quote_id: quoteId, p_template_id: templateId, p_option_ids: optionIds });

export const removeFromQuote = (quoteId: string, templateId: string) =>
  rpc<null>('remove_protection_plan_from_quote', { p_quote_id: quoteId, p_template_id: templateId });

export const attachToInvoice = (contractId: string, invoiceId: string) =>
  rpc<null>('attach_protection_contract_to_invoice', { p_contract_id: contractId, p_invoice_id: invoiceId });

export const linkEquipment = (contractId: string, equipmentIds: string[]) =>
  rpc<null>('link_protection_equipment', { p_contract_id: contractId, p_equipment_ids: equipmentIds });

export const unlinkEquipment = (contractId: string, equipmentId: string) =>
  rpc<null>('unlink_protection_equipment', { p_contract_id: contractId, p_equipment_id: equipmentId });

export const activateContract = (contractId: string, method: CollectionMethod, startDate?: string | null) =>
  rpc<{ status: string }>('activate_protection_contract', { p_contract_id: contractId, p_payment_method: method, p_start_date: startDate ?? null });

export const cancelContract = (contractId: string, reason: string, effectiveDate?: string | null) =>
  rpc<{ refund_cents: number }>('cancel_protection_contract', { p_contract_id: contractId, p_reason: reason, p_effective_date: effectiveDate ?? null });

export const createRenewal = (contractId: string, invoiceId?: string | null) =>
  rpc<{ id: string; contract_number: string }>('create_protection_renewal', { p_contract_id: contractId, p_invoice_id: invoiceId ?? null });

export const fileClaim = (p: {
  contractId: string; equipmentId: string; failureDate: string; description: string; partCostCents: number; laborCostCents: number; repairJobId?: string | null;
}) =>
  rpc<string>('file_protection_claim', {
    p_contract_id: p.contractId,
    p_equipment_id: p.equipmentId,
    p_failure_date: p.failureDate,
    p_failure_description: p.description,
    p_part_cost_cents: p.partCostCents,
    p_labor_cost_cents: p.laborCostCents,
    p_repair_job_id: p.repairJobId ?? null,
  });

export const decideClaim = (claimId: string, action: 'approve' | 'deny', opts: { approvedCents?: number | null; note?: string | null } = {}) =>
  rpc<{ approved_cents: number }>('decide_protection_claim', {
    p_claim_id: claimId,
    p_action: action,
    p_approved_cents: opts.approvedCents ?? null,
    p_note: opts.note ?? null,
  });

export const settleClaim = (claimId: string, method: PayoutMethod, reference?: string | null) =>
  rpc<{ paid_cents: number }>('settle_protection_claim', { p_claim_id: claimId, p_method: method, p_reference: reference ?? null });

export const closeClaim = (claimId: string) => rpc<null>('close_protection_claim', { p_claim_id: claimId });

/** Never throws: a missing RPC or bad token simply means "no certificate". */
export async function fetchCertificate(token: string): Promise<PublicCertificate | null> {
  if (!UUID_RE.test(token)) return null;
  try {
    const { data, error } = await supabase.rpc('get_protection_contract_for_token', { p_token: token });
    if (error) return null;
    return parseCertificate(data);
  } catch {
    return null;
  }
}
