/**
 * In-home sales presentation — pure domain logic.
 *
 * Everything money-related REUSES the existing engines so a number on the
 * tablet can never disagree with the quote, the financing page or payroll:
 *   - option totals / ladder / photos  -> src/lib/estimates.ts
 *   - monthly payment                  -> src/lib/financing.ts (estimateMonthlyPaymentCents)
 *   - commission                       -> src/lib/commissionEngine.ts (resolveCommission)
 * The database (supabase/migrations/20271102000000_in_home_sales.sql) stays
 * authoritative for the sold total; this module only previews and explains.
 *
 * All money is integer cents.
 */

import {
  TIER_ORDER,
  depositCents,
  optionTotals,
  recommendedOption,
  sortOptionsByValue,
  upgradeGapCents,
  type EstimateOption,
  type EstimatePhoto,
} from '@/lib/estimates';
import { estimateMonthlyPaymentCents } from '@/lib/financing';
import { periodStart, resolveCommission, type CommissionTier, type TierMode, type TierPeriod } from '@/lib/commissionEngine';

// ============================================================
// TYPES
// ============================================================

export type SalesRole = 'manager' | 'advisor';
export type PresentationStatus = 'draft' | 'presented' | 'sold' | 'lost';
export type PresentationView = 'options' | 'compare';

export interface SalesAccess {
  role: SalesRole | null;
  member_id: string | null;
}

export interface SalesAppointment {
  job_id: string;
  customer_name: string;
  customer_phone: string | null;
  address: string | null;
  scheduled_datetime: string | null;
  assigned_member_id: string | null;
  advisor_name: string | null;
  lead_id: string | null;
  customer_id: string | null;
  notes: string | null;
  from_technician: boolean;
  referred_by: string | null;
  presentation_id: string | null;
  presentation_status: PresentationStatus | null;
  sold_total_cents: number | null;
}

export interface SalesTeamMember {
  member_id: string;
  name: string;
  email: string;
  role: string;
  is_comfort_advisor: boolean;
}

export interface PresentableQuote {
  id: string;
  customer_name: string;
  status: string;
  created_at: string;
  option_count: number;
}

export interface PresentableTemplate {
  id: string;
  name: string;
  category: string | null;
}

export interface PresentationRow {
  id: string;
  advisor_user_id: string;
  appointment_job_id: string;
  lead_id: string | null;
  customer_id: string | null;
  quote_id: string;
  status: PresentationStatus;
  selected_option_id: string | null;
  financing_term_months: number | null;
  deposit_due_cents: number;
  sold_subtotal_cents: number | null;
  sold_total_cents: number | null;
  install_job_id: string | null;
  signature_request_id: string | null;
  lost_reason: string | null;
  presented_at: string | null;
  closed_at: string | null;
  created_at: string;
}

export interface PresentationEquipment {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  install_date: string | null;
  warranty_expires_at: string | null;
  expected_lifespan_years: number;
  last_service_date: string | null;
  notes: string | null;
}

export interface PresentationHistoryItem {
  id: string;
  service_type: string | null;
  job_status: string;
  date: string | null;
  invoice_amount: number | null;
}

export interface PresentationJobPhoto {
  id: string;
  storage_path: string;
  caption: string | null;
  kind: string;
  created_at: string;
}

export interface FinancingTerm {
  term_months: number;
  apr_bps: number;
  samples: number;
}

export interface PaymentTerm {
  term_months: number;
  apr_bps: number;
  /** 'lender' = observed on this account's approved financing_offers; 'indicative' = default estimate. */
  source: 'lender' | 'indicative';
}

export interface PresentationPayload {
  presentation: PresentationRow;
  job: { id: string; customer_name: string; customer_phone: string | null; address: string | null; scheduled_datetime: string | null };
  quote: {
    id: string;
    status: string;
    customer_name: string;
    customer_phone: string | null;
    customer_email: string | null;
    options: EstimateOption[];
    photos: EstimatePhoto[];
    tax_percent: number;
    deposit_percent: number;
    recommended_option_id: string | null;
    presentation_note: string | null;
  };
  equipment: PresentationEquipment[];
  history: PresentationHistoryItem[];
  job_photos: PresentationJobPhoto[];
  financing: { connected: boolean; terms: FinancingTerm[] };
  deposit_paid_cents: number;
  signed_request_id: string | null;
}

export interface PerformanceSale {
  advisor_user_id: string;
  closed_at: string;
  subtotal_cents: number;
}

export interface PerformanceAdvisor {
  advisor_user_id: string;
  name: string;
  appointments: number;
  presented: number;
  sold: number;
  lost: number;
  sold_subtotal_cents: number;
  sold_total_cents: number;
  financed: number;
  deposit_due_cents: number;
  deposit_collected_cents: number;
  employee_rate_percent: number | null;
  plan: { mode: TierMode; period: TierPeriod; tiers: CommissionTier[] } | null;
}

export interface PerformancePayload {
  role: SalesRole;
  advisors: PerformanceAdvisor[];
  sales: PerformanceSale[];
}

export interface AdvisorRow extends PerformanceAdvisor {
  closeRatePct: number | null;
  avgTicketCents: number | null;
  financedSharePct: number | null;
  commissionCents: number | null;
  commissionSource: 'plan' | 'employee_rate' | 'no_rule';
}

// ============================================================
// FORMATTING + ERRORS
// ============================================================

export function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
}

export function moneyExact(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

const ERROR_MESSAGES: Record<string, string> = {
  forbidden: "You don't have access to in-home sales. Ask the owner to enable you as a comfort advisor.",
  not_authenticated: 'Please sign in again.',
  not_found: 'This appointment or presentation was not found.',
  name_required: "Enter the customer's name.",
  invalid_advisor: 'Pick a team member who is enabled as a comfort advisor.',
  lead_not_found: 'That lead no longer exists.',
  customer_not_found: 'That customer no longer exists.',
  quote_required: 'Pick an estimate or a template to present.',
  quote_not_presentable: 'That estimate has no options to present, or it was already answered.',
  quote_unavailable: 'This estimate was already accepted or declined.',
  template_not_found: 'That template is no longer available.',
  invalid_option: 'That option is not part of this estimate.',
  signature_required: 'The customer must sign before the sale can be closed.',
  deposit_exceeds_total: 'The deposit cannot be more than the total.',
  already_lost: 'This presentation was already marked as lost.',
  already_sold: 'This presentation was already sold.',
  reason_required: 'Add a short reason (at least 3 characters).',
  not_a_service_visit: 'A sales lead can only be created from a service visit.',
  invalid_range: 'Pick a valid date range (max 2 years).',
  not_sold: 'Close the sale before taking a deposit.',
  invalid_method: 'Unsupported payment method.',
  invalid_amount: 'Enter a valid amount.',
  exceeds_balance: 'That is more than the amount still due.',
  invalid_check_number: 'Enter a valid check number (letters, digits, dashes).',
  duplicate_check_number: 'This check number was already recorded.',
  tendered_less_than_amount: 'Cash received is less than the amount being applied.',
};

export class SalesError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(ERROR_MESSAGES[code] ?? (code.includes(' ') ? code : 'Something went wrong. Please try again.'));
    this.code = code;
  }
}

/** Raw PostgREST/Postgres message -> friendly sentence. Codes are the RAISE EXCEPTION text. */
export function salesErrorMessage(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (e instanceof SalesError) return e.message;
  const raw = typeof e === 'string' ? e : e instanceof Error ? e.message : (e as { message?: unknown } | null)?.message;
  if (typeof raw === 'string') {
    const key = raw.trim();
    if (ERROR_MESSAGES[key]) return ERROR_MESSAGES[key];
  }
  return fallback;
}

// ============================================================
// GOOD / BETTER / BEST LADDER
// ============================================================

export interface LadderEntry {
  option: EstimateOption;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Extra cost vs the cheapest option (0 for the cheapest). */
  upgradeGapCents: number;
  recommended: boolean;
}

/** Cheapest → most expensive; ties keep Good/Better/Best order (same rule as the customer page). */
export function buildLadder(options: EstimateOption[], taxPercent: number): LadderEntry[] {
  const sorted = sortOptionsByValue(options, taxPercent);
  const rec = recommendedOption(sorted);
  return sorted.map((option) => {
    const t = optionTotals(option, taxPercent);
    return {
      option,
      subtotalCents: t.subtotalCents,
      taxCents: t.taxCents,
      totalCents: t.totalCents,
      upgradeGapCents: upgradeGapCents(option, options, taxPercent),
      recommended: rec?.id === option.id,
    };
  });
}

export function defaultSelectedOptionId(ladder: LadderEntry[]): string | null {
  return (ladder.find((l) => l.recommended) ?? ladder[Math.min(1, ladder.length - 1)])?.option.id ?? null;
}

// ============================================================
// MONTHLY PAYMENT  (financing_offers terms, indicative fallback)
// ============================================================

/** Shown only when this account has no approved financing history yet; always labelled "indicative". */
export const INDICATIVE_TERM: PaymentTerm = { term_months: 60, apr_bps: 999, source: 'indicative' };

export function resolvePaymentTerms(terms: FinancingTerm[]): PaymentTerm[] {
  const clean = terms
    .filter((t) => Number.isInteger(t.term_months) && t.term_months > 0 && Number.isFinite(t.apr_bps) && t.apr_bps >= 0)
    .map((t): PaymentTerm => ({ term_months: t.term_months, apr_bps: t.apr_bps, source: 'lender' }))
    .sort((a, b) => a.term_months - b.term_months);
  return clean.length > 0 ? clean : [INDICATIVE_TERM];
}

/** Amount to finance = total minus the deposit paid up front (never negative). */
export function financedAmountCents(totalCents: number, depositDueCents: number): number {
  return Math.max(0, Math.round(totalCents) - Math.max(0, Math.round(depositDueCents)));
}

export function monthlyForTerm(totalCents: number, depositDueCents: number, term: PaymentTerm): number | null {
  return estimateMonthlyPaymentCents(financedAmountCents(totalCents, depositDueCents), term.apr_bps, term.term_months);
}

export function describeTerm(term: PaymentTerm): string {
  const apr = term.apr_bps === 0 ? '0% APR' : `${(term.apr_bps / 100).toFixed(2)}% APR`;
  return `${term.term_months} mo · ${apr}`;
}

// ============================================================
// DEPOSIT
// ============================================================

export function defaultDepositCents(totalCents: number, depositPercent: number): number {
  return Math.min(Math.max(0, totalCents), depositCents(totalCents, depositPercent));
}

export function validateDeposit(depositCentsInput: number, totalCents: number): string | null {
  if (!Number.isFinite(depositCentsInput) || depositCentsInput < 0) return 'Enter a valid deposit.';
  if (depositCentsInput > totalCents) return 'The deposit cannot be more than the total.';
  return null;
}

// ============================================================
// REPAIR vs REPLACE
// ============================================================

export interface RepairReplaceInput {
  repairCents: number;
  replaceCents: number;
  /** null when the equipment age is unknown. */
  equipmentAgeYears: number | null;
  expectedLifespanYears: number;
  /** Years the repair is expected to buy (advisor-editable assumption). */
  repairExtendsYears: number;
  horizonYears: number;
}

export interface RepairReplaceResult {
  repairLifeYears: number;
  replaceLifeYears: number;
  repairPerYearCents: number;
  replacePerYearCents: number;
  repairHorizonCents: number;
  replaceHorizonCents: number;
  /** Positive = replacing costs less over the horizon. */
  replaceSavingsCents: number;
  verdict: 'replace' | 'repair' | 'close';
}

export const DEFAULT_REPAIR_EXTENDS_YEARS = 2;
export const DEFAULT_HORIZON_YEARS = 10;
export const DEFAULT_LIFESPAN_YEARS = 15;

export function equipmentAgeYears(installDate: string | null | undefined, now: Date = new Date()): number | null {
  if (!installDate) return null;
  const d = new Date(installDate);
  if (Number.isNaN(d.getTime())) return null;
  const years = (now.getTime() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
  return years < 0 ? 0 : Math.round(years * 10) / 10;
}

/**
 * Transparent cost-of-use comparison (value consumed over the horizon — no
 * hidden failure model, no double counting of a replacement you would buy
 * either way). Inputs are the two prices, the equipment age/lifespan and the
 * advisor's stated "how long will the repair last" assumption — all shown on screen.
 *
 *  repair path  = repair price spread over its life, then the replacement's
 *                 price spread over the years it is used inside the horizon
 *  replace path = replacement price spread over its life, for the horizon
 *
 * Comparing the two is equivalent to comparing cost per year of life.
 */
export function compareRepairReplace(input: RepairReplaceInput): RepairReplaceResult {
  const horizon = Math.max(1, input.horizonYears);
  const lifespan = Math.max(1, input.expectedLifespanYears);
  const remaining = input.equipmentAgeYears === null ? null : Math.max(0, lifespan - input.equipmentAgeYears);
  const extendsYears = Math.max(0.5, input.repairExtendsYears);
  const repairLife = Math.max(0.5, remaining === null ? extendsYears : Math.min(extendsYears, Math.max(remaining, 0.5)));
  const replaceLife = lifespan;

  const repairHorizon =
    horizon <= repairLife
      ? (input.repairCents * horizon) / repairLife
      : input.repairCents + (input.replaceCents * (horizon - repairLife)) / replaceLife;
  const replaceHorizon = (input.replaceCents * horizon) / replaceLife;
  const repairHorizonCents = Math.round(repairHorizon);
  const replaceHorizonCents = Math.round(replaceHorizon);
  const savings = repairHorizonCents - replaceHorizonCents;
  const base = Math.max(repairHorizonCents, replaceHorizonCents, 1);
  const verdict: RepairReplaceResult['verdict'] = Math.abs(savings) / base <= 0.1 ? 'close' : savings > 0 ? 'replace' : 'repair';

  return {
    repairLifeYears: Math.round(repairLife * 10) / 10,
    replaceLifeYears: replaceLife,
    repairPerYearCents: Math.round(input.repairCents / repairLife),
    replacePerYearCents: Math.round(input.replaceCents / replaceLife),
    repairHorizonCents,
    replaceHorizonCents,
    replaceSavingsCents: savings,
    verdict,
  };
}

/** Repair = cheapest option, Replace = most expensive. null when there are fewer than two options. */
export function pickRepairAndReplace(ladder: LadderEntry[]): { repair: LadderEntry; replace: LadderEntry } | null {
  if (ladder.length < 2) return null;
  return { repair: ladder[0], replace: ladder[ladder.length - 1] };
}

// ============================================================
// SALE VALIDATION
// ============================================================

export function validateSale(input: {
  optionId: string | null;
  ladder: LadderEntry[];
  signed: boolean;
  depositCents: number;
}): string[] {
  const errors: string[] = [];
  const picked = input.ladder.find((l) => l.option.id === input.optionId);
  if (!picked) errors.push('Choose one option to sell.');
  if (!input.signed) errors.push('The customer must sign.');
  if (picked) {
    const depositError = validateDeposit(input.depositCents, picked.totalCents);
    if (depositError) errors.push(depositError);
  }
  return errors;
}

export function tierRank(tier: EstimateOption['tier']): number {
  return TIER_ORDER.indexOf(tier);
}

// ============================================================
// PERFORMANCE  (close rate, average ticket, commission)
// ============================================================

export function closeRatePct(sold: number, lost: number): number | null {
  const decided = sold + lost;
  return decided > 0 ? Math.round((sold / decided) * 1000) / 10 : null;
}

export function avgTicketCents(soldTotalCents: number, sold: number): number | null {
  return sold > 0 ? Math.round(soldTotalCents / sold) : null;
}

/**
 * Commission on a SOLD basis (pre-tax subtotal) using the advisor's real plan.
 * Payroll commissions (commission_records) are generated later on COLLECTED
 * revenue for the assigned technician — this figure is the advisor's earned-on-sale
 * estimate, so it is labelled "estimated" everywhere it appears.
 * Tier accumulation resets whenever the plan's period (month/quarter/year) rolls over.
 */
export function advisorCommission(
  advisor: Pick<PerformanceAdvisor, 'advisor_user_id' | 'plan' | 'employee_rate_percent'>,
  sales: PerformanceSale[]
): { cents: number | null; source: AdvisorRow['commissionSource'] } {
  const mine = sales
    .filter((s) => s.advisor_user_id === advisor.advisor_user_id)
    .sort((a, b) => a.closed_at.localeCompare(b.closed_at));
  const hasPlan = Boolean(advisor.plan && advisor.plan.tiers.length > 0);
  const flat = advisor.employee_rate_percent ?? 0;
  if (!hasPlan && flat <= 0) return { cents: null, source: 'no_rule' };

  let total = 0;
  let cumulative = 0;
  let currentPeriod = '';
  for (const sale of mine) {
    if (hasPlan && advisor.plan) {
      const p = periodStart(sale.closed_at.slice(0, 10), advisor.plan.period);
      if (p !== currentPeriod) {
        currentPeriod = p;
        cumulative = 0;
      }
    }
    const r = resolveCommission({
      basisCents: sale.subtotal_cents,
      cumulativeBeforeCents: cumulative,
      plan: hasPlan && advisor.plan ? { mode: advisor.plan.mode, tiers: advisor.plan.tiers } : null,
      employeeRatePercent: flat,
    });
    total += r.commissionCents;
    cumulative += sale.subtotal_cents;
  }
  return { cents: total, source: hasPlan ? 'plan' : 'employee_rate' };
}

export function buildAdvisorRows(payload: PerformancePayload): AdvisorRow[] {
  return payload.advisors.map((a) => {
    const c = advisorCommission(a, payload.sales);
    return {
      ...a,
      closeRatePct: closeRatePct(a.sold, a.lost),
      avgTicketCents: avgTicketCents(a.sold_total_cents, a.sold),
      financedSharePct: a.sold > 0 ? Math.round((a.financed / a.sold) * 1000) / 10 : null,
      commissionCents: c.cents,
      commissionSource: c.source,
    };
  });
}

export interface TeamTotals {
  appointments: number;
  sold: number;
  lost: number;
  soldTotalCents: number;
  closeRatePct: number | null;
  avgTicketCents: number | null;
  commissionCents: number;
}

export function teamTotals(rows: AdvisorRow[]): TeamTotals {
  const sold = rows.reduce((s, r) => s + r.sold, 0);
  const lost = rows.reduce((s, r) => s + r.lost, 0);
  const soldTotalCents = rows.reduce((s, r) => s + r.sold_total_cents, 0);
  return {
    appointments: rows.reduce((s, r) => s + r.appointments, 0),
    sold,
    lost,
    soldTotalCents,
    closeRatePct: closeRatePct(sold, lost),
    avgTicketCents: avgTicketCents(soldTotalCents, sold),
    commissionCents: rows.reduce((s, r) => s + (r.commissionCents ?? 0), 0),
  };
}

/** Default report window: first day of this month → today (local), as YYYY-MM-DD. */
export function defaultRange(now: Date = new Date()): { start: string; end: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { start: iso(new Date(now.getFullYear(), now.getMonth(), 1)), end: iso(now) };
}

export const APPOINTMENT_STATUS_LABEL: Record<PresentationStatus | 'none', string> = {
  none: 'Not started',
  draft: 'Ready to present',
  presented: 'Presented',
  sold: 'Sold',
  lost: 'Lost',
};
