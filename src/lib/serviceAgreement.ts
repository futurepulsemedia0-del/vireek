// Service Agreement OS — domain layer.
//
// Reuses (never duplicates) the existing contract stack:
//   commercial_contracts, contract_intelligence_profiles (terms), contract_sla_breaches,
//   job_contract_coverage, customer_sites, equipment, jobs, job_profitability (view).
// Adds only what was missing: covered assets/services, included visits, PM plans, claims,
// price history and the renewal pipeline (see 20270410000000_service_agreement_os.sql).
//
// Everything below the "Loaders" banner talks to Supabase; everything above is pure and
// unit-tested (serviceAgreement.test.ts).

import { supabase } from './supabase';
import { isLiveContract, type BillingFrequency, type ContractStatus } from './contracts';
import { emptyTerms, normalizeTerms, type ContractTerms } from './contractIntelligence';

// ============================================================
// Types
// ============================================================

export type CoverageLevel = 'full' | 'labor_only' | 'parts_only' | 'inspection_only' | 'excluded';
export type ServiceCoverage = 'included' | 'discounted' | 'excluded';
export type EntitlementKind = 'pm_visit' | 'service_call' | 'emergency_call' | 'labor_hours';
export type EntitlementPeriod = 'month' | 'quarter' | 'year' | 'term';
export type VisitStatus = 'scheduled' | 'completed' | 'missed' | 'cancelled';
export type ClaimType = 'coverage_dispute' | 'sla_credit' | 'parts_labor' | 'warranty_recovery' | 'other';
export type ClaimStatus = 'open' | 'under_review' | 'approved' | 'denied' | 'settled' | 'closed';
export type RenewalStatus = 'pending' | 'quoted' | 'accepted' | 'declined' | 'lapsed';
export type PriceChangeKind = 'initial' | 'escalation' | 'renewal' | 'amendment' | 'discount';
export type HealthGrade = 'healthy' | 'watch' | 'at_risk' | 'critical';

export interface AgreementRow {
  id: string;
  customer_id: string | null;
  contract_number: string | null;
  contract_name: string;
  contract_type: string;
  status: ContractStatus;
  start_date: string | null;
  end_date: string | null;
  auto_renew: boolean;
  renewal_notice_days: number;
  billing_frequency: BillingFrequency;
  contract_value_cents: number | null;
  sla_response_minutes_standard: number | null;
  sla_response_minutes_critical: number | null;
  sla_resolution_hours: number | null;
  penalty_percentage: number | null;
  penalty_cap_percentage: number | null;
  signed_at: string | null;
  document_url: string | null;
}

export interface CustomerLite {
  id: string;
  name: string;
  customer_type: string;
}

export interface SiteLite {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
}

export interface EquipmentLite {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  status: string;
  warranty_expires_at: string | null;
  last_service_date: string | null;
  service_interval_months: number;
  site_id?: string | null;
}

export interface AssetRow {
  id: string;
  contract_id: string;
  site_id: string | null;
  equipment_id: string | null;
  coverage_level: CoverageLevel;
  notes: string | null;
}

export interface ServiceRow {
  id: string;
  contract_id: string;
  service_type: string;
  coverage: ServiceCoverage;
  labor_covered: boolean;
  parts_covered: boolean;
  discount_percent: number;
  per_visit_cap_cents: number | null;
  notes: string | null;
}

export interface EntitlementRow {
  id: string;
  contract_id: string;
  kind: EntitlementKind;
  included_quantity: number;
  period: EntitlementPeriod;
  overage_rate_cents: number | null;
}

export interface PmPlanRow {
  id: string;
  contract_id: string;
  name: string;
  site_id: string | null;
  equipment_id: string | null;
  equipment_type: string | null;
  frequency_months: number;
  checklist: string[];
  estimated_minutes: number | null;
  next_due_date: string | null;
  last_completed_date: string | null;
  active: boolean;
}

export interface VisitRow {
  id: string;
  contract_id: string;
  entitlement_kind: EntitlementKind;
  pm_plan_id: string | null;
  job_id: string | null;
  visit_date: string;
  status: VisitStatus;
  quantity: number;
  billable: boolean;
  notes: string | null;
  completed_at: string | null;
}

export interface ClaimRow {
  id: string;
  contract_id: string;
  job_id: string | null;
  breach_id: string | null;
  warranty_claim_id: string | null;
  claim_type: ClaimType;
  status: ClaimStatus;
  title: string;
  description: string | null;
  claimed_cents: number | null;
  approved_cents: number | null;
  settled_cents: number | null;
  opened_at: string;
  resolved_at: string | null;
  resolution_notes: string | null;
}

export interface PriceChangeRow {
  id: string;
  contract_id: string;
  kind: PriceChangeKind;
  effective_date: string;
  previous_cents: number | null;
  new_cents: number;
  reason: string | null;
  created_at: string;
}

export interface RenewalRow {
  id: string;
  contract_id: string;
  status: RenewalStatus;
  proposed_value_cents: number | null;
  proposed_start: string | null;
  proposed_end: string | null;
  proposed_changes: string | null;
  quoted_at: string | null;
  decided_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface BreachRow {
  id: string;
  contract_id: string;
  job_id: string | null;
  breach_type: string;
  severity: 'minor' | 'major' | 'critical';
  minutes_over: number | null;
  penalty_amount_cents: number | null;
  resolved: boolean;
  created_at: string;
}

export interface JobFinancial {
  job_id: string;
  revenue_cents: number;
  total_cost_cents: number;
  labor_cost_cents: number;
  material_cost_cents: number;
}

export interface AttributedJob {
  id: string;
  created_at: string;
  job_status: string;
  service_type: string | null;
  site_id: string | null;
  customer_name: string | null;
  verdict: string | null;
  billing_action: string | null;
}

// ============================================================
// Labels & styles (same token vocabulary as lib/contracts.ts)
// ============================================================

export const COVERAGE_LEVEL_LABELS: Record<CoverageLevel, string> = {
  full: 'Full coverage',
  labor_only: 'Labor only',
  parts_only: 'Parts only',
  inspection_only: 'Inspection only',
  excluded: 'Excluded',
};
export const COVERAGE_LEVEL_OPTIONS = Object.keys(COVERAGE_LEVEL_LABELS) as CoverageLevel[];
export const COVERAGE_LEVEL_STYLES: Record<CoverageLevel, string> = {
  full: 'bg-success-500/10 text-success-500',
  labor_only: 'bg-accent/10 text-accent',
  parts_only: 'bg-accent/10 text-accent',
  inspection_only: 'bg-warning-500/10 text-warning-500',
  excluded: 'bg-danger/10 text-danger',
};

export const SERVICE_COVERAGE_LABELS: Record<ServiceCoverage, string> = {
  included: 'Included',
  discounted: 'Discounted',
  excluded: 'Excluded',
};
export const SERVICE_COVERAGE_OPTIONS = Object.keys(SERVICE_COVERAGE_LABELS) as ServiceCoverage[];

export const ENTITLEMENT_KIND_LABELS: Record<EntitlementKind, string> = {
  pm_visit: 'Preventive-maintenance visits',
  service_call: 'Service calls',
  emergency_call: 'Emergency calls',
  labor_hours: 'Labor hours',
};
export const ENTITLEMENT_KIND_OPTIONS = Object.keys(ENTITLEMENT_KIND_LABELS) as EntitlementKind[];

export const PERIOD_LABELS: Record<EntitlementPeriod, string> = {
  month: 'per month',
  quarter: 'per quarter',
  year: 'per year',
  term: 'per contract term',
};
export const PERIOD_OPTIONS = Object.keys(PERIOD_LABELS) as EntitlementPeriod[];

export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = {
  scheduled: 'Scheduled',
  completed: 'Completed',
  missed: 'Missed',
  cancelled: 'Cancelled',
};
export const VISIT_STATUS_OPTIONS = Object.keys(VISIT_STATUS_LABELS) as VisitStatus[];

export const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
  coverage_dispute: 'Coverage dispute',
  sla_credit: 'SLA credit',
  parts_labor: 'Parts / labor claim',
  warranty_recovery: 'Manufacturer recovery',
  other: 'Other',
};
export const CLAIM_TYPE_OPTIONS = Object.keys(CLAIM_TYPE_LABELS) as ClaimType[];

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  open: 'Open',
  under_review: 'Under review',
  approved: 'Approved',
  denied: 'Denied',
  settled: 'Settled',
  closed: 'Closed',
};
export const CLAIM_STATUS_OPTIONS = Object.keys(CLAIM_STATUS_LABELS) as ClaimStatus[];
export const CLAIM_STATUS_STYLES: Record<ClaimStatus, string> = {
  open: 'bg-warning-500/10 text-warning-500',
  under_review: 'bg-accent/10 text-accent',
  approved: 'bg-success-500/10 text-success-500',
  denied: 'bg-bg-tertiary text-text-secondary',
  settled: 'bg-success-500/10 text-success-500',
  closed: 'bg-bg-tertiary text-text-secondary',
};

export const RENEWAL_STATUS_LABELS: Record<RenewalStatus, string> = {
  pending: 'Preparing',
  quoted: 'Quote sent',
  accepted: 'Accepted',
  declined: 'Declined',
  lapsed: 'Lapsed',
};
export const RENEWAL_STATUS_OPTIONS = Object.keys(RENEWAL_STATUS_LABELS) as RenewalStatus[];

export const PRICE_KIND_LABELS: Record<PriceChangeKind, string> = {
  initial: 'Initial price',
  escalation: 'Escalation',
  renewal: 'Renewal',
  amendment: 'Amendment',
  discount: 'Discount',
};

export const HEALTH_LABELS: Record<HealthGrade, string> = {
  healthy: 'Healthy',
  watch: 'Watch',
  at_risk: 'At risk',
  critical: 'Critical',
};
export const HEALTH_STYLES: Record<HealthGrade, string> = {
  healthy: 'bg-success-500/10 text-success-500',
  watch: 'bg-accent/10 text-accent',
  at_risk: 'bg-warning-500/10 text-warning-500',
  critical: 'bg-danger/10 text-danger',
};

export const PM_STATUS_LABELS = {
  overdue: 'Overdue',
  due_soon: 'Due soon',
  scheduled: 'On track',
  paused: 'Paused',
  unscheduled: 'No due date',
} as const;
export type PmStatus = keyof typeof PM_STATUS_LABELS;
export const PM_STATUS_STYLES: Record<PmStatus, string> = {
  overdue: 'bg-danger/10 text-danger',
  due_soon: 'bg-warning-500/10 text-warning-500',
  scheduled: 'bg-success-500/10 text-success-500',
  paused: 'bg-bg-tertiary text-text-secondary',
  unscheduled: 'bg-bg-tertiary text-text-secondary',
};

// ============================================================
// Small pure helpers
// ============================================================

const DAY_MS = 86_400_000;
const AVG_MONTH_DAYS = 30.4375;

/** Local-calendar YYYY-MM-DD (avoids the UTC off-by-one of toISOString()). */
export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parses a YYYY-MM-DD (or ISO) string as a LOCAL midnight date. */
export function parseDay(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), 1);
  r.setMonth(r.getMonth() + months);
  const lastDay = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(d.getDate(), lastDay));
  return r;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function formatDate(s: string | null | undefined): string {
  if (!s) return '—';
  return parseDay(s).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(cents / 100)).toLocaleString('en-US')}`;
}

export function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const BILLING_PERIOD_MONTHS: Record<BillingFrequency, number | null> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
  one_time: null,
};

// ============================================================
// Pricing
// ============================================================

/**
 * contract_value_cents is the fee PER BILLING PERIOD (same reading as
 * computePenaltyCents in contractIntelligence.ts). Returns the annualised recurring value,
 * or null for one-time agreements.
 */
export function annualizedValueCents(contract: Pick<AgreementRow, 'contract_value_cents' | 'billing_frequency'>): number | null {
  const months = BILLING_PERIOD_MONTHS[contract.billing_frequency];
  if (!months || contract.contract_value_cents === null) return null;
  return Math.round(contract.contract_value_cents * (12 / months));
}

export interface EscalationProjection {
  kind: 'none' | 'fixed_percent' | 'cpi';
  nextDate: string | null;
  percent: number | null;
  currentCents: number | null;
  projectedCents: number | null;
  deltaCents: number | null;
  daysAway: number | null;
}

export function projectEscalation(
  contract: Pick<AgreementRow, 'contract_value_cents'>,
  terms: ContractTerms,
  today: Date = new Date()
): EscalationProjection {
  const p = terms.pricing;
  const current = contract.contract_value_cents;
  const base: EscalationProjection = {
    kind: p.escalation_type,
    nextDate: p.next_escalation_date,
    percent: p.escalation_percent,
    currentCents: current,
    projectedCents: null,
    deltaCents: null,
    daysAway: p.next_escalation_date ? Math.round((parseDay(p.next_escalation_date).getTime() - startOfDay(today).getTime()) / DAY_MS) : null,
  };
  if (p.escalation_type === 'fixed_percent' && p.escalation_percent !== null && current !== null) {
    let pct = p.escalation_percent;
    if (p.escalation_cap_percent !== null) pct = Math.min(pct, p.escalation_cap_percent);
    const projected = Math.round(current * (1 + pct / 100));
    return { ...base, percent: pct, projectedCents: projected, deltaCents: projected - current };
  }
  return base;
}

// ============================================================
// Entitlements (included visits / hours)
// ============================================================

const PERIOD_MONTHS: Record<Exclude<EntitlementPeriod, 'term'>, number> = { month: 1, quarter: 3, year: 12 };

export interface PeriodWindow {
  start: Date;
  /** Exclusive end. */
  end: Date;
}

/**
 * The entitlement window containing `now`. Windows are anniversary-based (they restart on the
 * contract's start date, like the agreement itself), not calendar-based. 'term' = whole term.
 */
export function periodWindow(
  period: EntitlementPeriod,
  contract: Pick<AgreementRow, 'start_date' | 'end_date'>,
  now: Date = new Date()
): PeriodWindow {
  const today = startOfDay(now);
  const start = contract.start_date ? parseDay(contract.start_date) : new Date(today.getFullYear(), 0, 1);
  if (period === 'term') {
    const end = contract.end_date ? new Date(parseDay(contract.end_date).getTime() + DAY_MS) : addMonths(start, 12);
    return { start, end };
  }
  const step = PERIOD_MONTHS[period];
  const monthsElapsed = (today.getFullYear() - start.getFullYear()) * 12 + (today.getMonth() - start.getMonth());
  let k = Math.max(0, Math.floor(monthsElapsed / step));
  let ws = addMonths(start, k * step);
  if (ws.getTime() > today.getTime() && k > 0) {
    k -= 1;
    ws = addMonths(start, k * step);
  }
  return { start: ws, end: addMonths(start, (k + 1) * step) };
}

export interface EntitlementUsage {
  kind: EntitlementKind;
  included: number;
  used: number;
  scheduled: number;
  remaining: number;
  overage: number;
  overageCostCents: number | null;
  utilizationPct: number;
  window: PeriodWindow;
  /** Share of the window already elapsed (0–100). */
  elapsedPct: number;
}

export function entitlementUsage(
  ent: EntitlementRow,
  visits: VisitRow[],
  contract: Pick<AgreementRow, 'start_date' | 'end_date'>,
  now: Date = new Date()
): EntitlementUsage {
  const window = periodWindow(ent.period, contract, now);
  const inWindow = visits.filter((v) => {
    if (v.entitlement_kind !== ent.kind) return false;
    const t = parseDay(v.visit_date).getTime();
    return t >= window.start.getTime() && t < window.end.getTime();
  });
  const used = inWindow.filter((v) => v.status === 'completed').reduce((s, v) => s + num(v.quantity), 0);
  const scheduled = inWindow.filter((v) => v.status === 'scheduled').reduce((s, v) => s + num(v.quantity), 0);
  const included = num(ent.included_quantity);
  const overage = Math.max(0, used - included);
  const span = window.end.getTime() - window.start.getTime();
  return {
    kind: ent.kind,
    included,
    used,
    scheduled,
    remaining: Math.max(0, included - used),
    overage,
    overageCostCents: ent.overage_rate_cents === null ? null : Math.round(overage * ent.overage_rate_cents),
    utilizationPct: included > 0 ? (used / included) * 100 : used > 0 ? 100 : 0,
    window,
    elapsedPct: span > 0 ? clamp(((startOfDay(now).getTime() - window.start.getTime()) / span) * 100, 0, 100) : 0,
  };
}

// ============================================================
// Preventive maintenance
// ============================================================

export const PM_DUE_SOON_DAYS = 30;

export function pmStatus(plan: Pick<PmPlanRow, 'active' | 'next_due_date'>, today: Date = new Date()): { status: PmStatus; days: number | null } {
  if (!plan.active) return { status: 'paused', days: null };
  if (!plan.next_due_date) return { status: 'unscheduled', days: null };
  const days = Math.round((parseDay(plan.next_due_date).getTime() - startOfDay(today).getTime()) / DAY_MS);
  if (days < 0) return { status: 'overdue', days };
  if (days <= PM_DUE_SOON_DAYS) return { status: 'due_soon', days };
  return { status: 'scheduled', days };
}

/** First due date when a plan is created without one: one interval after the last completion, else today. */
export function defaultNextDue(frequencyMonths: number, lastCompleted: string | null, today: Date = new Date()): string {
  const base = lastCompleted ? addMonths(parseDay(lastCompleted), frequencyMonths) : startOfDay(today);
  return toDateKey(base);
}

// ============================================================
// Profitability
// ============================================================

export interface ProfitabilityInput {
  contract: Pick<AgreementRow, 'contract_value_cents' | 'billing_frequency' | 'start_date' | 'end_date'>;
  jobs: JobFinancial[];
  breaches: Pick<BreachRow, 'penalty_amount_cents'>[];
  claims: Pick<ClaimRow, 'claim_type' | 'status' | 'approved_cents' | 'settled_cents'>[];
  now?: Date;
}

export interface Profitability {
  elapsedMonths: number;
  recurringRevenueCents: number;
  jobRevenueCents: number;
  totalRevenueCents: number;
  costToServeCents: number;
  laborCostCents: number;
  partsCostCents: number;
  penaltiesCents: number;
  claimPayoutsCents: number;
  recoveriesCents: number;
  grossProfitCents: number;
  marginPct: number | null;
  jobCount: number;
  costPerJobCents: number | null;
  /** True when there is not enough history for the margin to mean anything. */
  lowConfidence: boolean;
}

export function elapsedMonths(contract: Pick<AgreementRow, 'start_date' | 'end_date'>, now: Date = new Date()): number {
  if (!contract.start_date) return 0;
  const start = parseDay(contract.start_date).getTime();
  const endCap = contract.end_date ? parseDay(contract.end_date).getTime() + DAY_MS : Infinity;
  const to = Math.min(startOfDay(now).getTime() + DAY_MS, endCap);
  return Math.max(0, (to - start) / DAY_MS / AVG_MONTH_DAYS);
}

/** Claim cash-out / cash-in. Manufacturer recoveries are inflows; every other claim type is an outflow. */
export function claimCashCents(c: Pick<ClaimRow, 'claim_type' | 'status' | 'approved_cents' | 'settled_cents'>): { out: number; in: number } {
  const paid = c.status === 'settled' ? (c.settled_cents ?? c.approved_cents ?? 0) : c.status === 'approved' ? (c.approved_cents ?? 0) : 0;
  return c.claim_type === 'warranty_recovery' ? { out: 0, in: paid } : { out: paid, in: 0 };
}

export function computeProfitability(input: ProfitabilityInput): Profitability {
  const { contract, jobs, breaches, claims } = input;
  const months = elapsedMonths(contract, input.now);
  const value = contract.contract_value_cents ?? 0;
  const periodMonths = BILLING_PERIOD_MONTHS[contract.billing_frequency];

  let recurring = 0;
  if (periodMonths) {
    recurring = Math.round((value / periodMonths) * months);
  } else if (contract.start_date) {
    // One-time fee: recognised pro-rata over the term when there is one, else in full once started.
    if (contract.end_date) {
      const termMonths = Math.max(1 / AVG_MONTH_DAYS, (parseDay(contract.end_date).getTime() + DAY_MS - parseDay(contract.start_date).getTime()) / DAY_MS / AVG_MONTH_DAYS);
      recurring = Math.round(value * clamp(months / termMonths, 0, 1));
    } else {
      recurring = months > 0 ? value : 0;
    }
  }

  const jobRevenue = jobs.reduce((s, j) => s + num(j.revenue_cents), 0);
  const cost = jobs.reduce((s, j) => s + num(j.total_cost_cents), 0);
  const labor = jobs.reduce((s, j) => s + num(j.labor_cost_cents), 0);
  const parts = jobs.reduce((s, j) => s + num(j.material_cost_cents), 0);
  const penalties = breaches.reduce((s, b) => s + num(b.penalty_amount_cents), 0);
  const cash = claims.map(claimCashCents);
  const payouts = cash.reduce((s, c) => s + c.out, 0);
  const recoveries = cash.reduce((s, c) => s + c.in, 0);

  const totalRevenue = recurring + jobRevenue;
  const gross = totalRevenue - cost - penalties - payouts + recoveries;
  return {
    elapsedMonths: months,
    recurringRevenueCents: recurring,
    jobRevenueCents: jobRevenue,
    totalRevenueCents: totalRevenue,
    costToServeCents: cost,
    laborCostCents: labor,
    partsCostCents: parts,
    penaltiesCents: penalties,
    claimPayoutsCents: payouts,
    recoveriesCents: recoveries,
    grossProfitCents: gross,
    marginPct: totalRevenue > 0 ? (gross / totalRevenue) * 100 : null,
    jobCount: jobs.length,
    costPerJobCents: jobs.length > 0 ? Math.round(cost / jobs.length) : null,
    lowConfidence: months < 2 || jobs.length < 3,
  };
}

export interface RepriceSuggestion {
  targetMarginPct: number;
  currentFeeCents: number;
  suggestedFeeCents: number;
  increasePct: number;
}

/**
 * What per-period fee would hit `targetMarginPct` if the observed run-rate of costs, penalties and
 * claims continues. Null when the agreement already meets the target, or there is not enough data.
 */
export function suggestReprice(
  contract: Pick<AgreementRow, 'contract_value_cents' | 'billing_frequency'>,
  profit: Profitability,
  targetMarginPct = 25
): RepriceSuggestion | null {
  const periodMonths = BILLING_PERIOD_MONTHS[contract.billing_frequency];
  const fee = contract.contract_value_cents;
  if (!periodMonths || !fee || profit.lowConfidence || profit.elapsedMonths <= 0) return null;
  if (profit.marginPct !== null && profit.marginPct >= targetMarginPct) return null;

  const perMonth = (cents: number) => cents / profit.elapsedMonths;
  const burn = perMonth(profit.costToServeCents + profit.penaltiesCents + profit.claimPayoutsCents - profit.recoveriesCents);
  const otherRevenue = perMonth(profit.jobRevenueCents);
  const requiredRecurringPerMonth = burn / (1 - targetMarginPct / 100) - otherRevenue;
  const suggested = Math.max(fee, Math.round(requiredRecurringPerMonth * periodMonths));
  if (suggested <= fee) return null;
  return { targetMarginPct, currentFeeCents: fee, suggestedFeeCents: suggested, increasePct: ((suggested - fee) / fee) * 100 };
}

// ============================================================
// Renewal
// ============================================================

export type RenewalRisk = 'none' | 'watch' | 'urgent' | 'lapsed' | 'secured';

export interface RenewalState {
  daysLeft: number | null;
  inNoticeWindow: boolean;
  risk: RenewalRisk;
  headline: string;
}

export function renewalState(
  contract: Pick<AgreementRow, 'status' | 'end_date' | 'auto_renew' | 'renewal_notice_days'>,
  renewal: Pick<RenewalRow, 'status'> | null,
  today: Date = new Date()
): RenewalState {
  const daysLeft = daysUntilFrom(contract.end_date, today);
  const inWindow = daysLeft !== null && daysLeft >= 0 && daysLeft <= contract.renewal_notice_days;
  if (contract.status === 'renewed' || renewal?.status === 'accepted') {
    return { daysLeft, inNoticeWindow: inWindow, risk: 'secured', headline: 'Renewal secured' };
  }
  if (!isLiveContract(contract.status) && contract.status !== 'expired') {
    return { daysLeft, inNoticeWindow: false, risk: 'none', headline: 'Not in force' };
  }
  if (daysLeft === null) return { daysLeft, inNoticeWindow: false, risk: 'none', headline: 'Open-ended agreement' };
  if (daysLeft < 0 || contract.status === 'expired') {
    return { daysLeft, inNoticeWindow: false, risk: 'lapsed', headline: renewal?.status === 'declined' ? 'Declined and expired' : 'Expired without renewal' };
  }
  if (renewal?.status === 'declined') return { daysLeft, inNoticeWindow: inWindow, risk: 'urgent', headline: 'Customer declined — win back before expiry' };
  if (renewal?.status === 'quoted') return { daysLeft, inNoticeWindow: inWindow, risk: daysLeft <= 30 ? 'urgent' : 'watch', headline: 'Quote sent — awaiting decision' };
  if (contract.auto_renew && !inWindow) return { daysLeft, inNoticeWindow: inWindow, risk: 'none', headline: 'Auto-renews' };
  if (inWindow) return { daysLeft, inNoticeWindow: true, risk: 'urgent', headline: contract.auto_renew ? 'In notice window — review before auto-renew' : 'In notice window — no renewal started' };
  if (daysLeft <= 90) return { daysLeft, inNoticeWindow: false, risk: 'watch', headline: 'Expires within 90 days' };
  return { daysLeft, inNoticeWindow: false, risk: 'none', headline: 'In term' };
}

function daysUntilFrom(dateStr: string | null | undefined, today: Date): number | null {
  if (!dateStr) return null;
  return Math.round((parseDay(dateStr).getTime() - startOfDay(today).getTime()) / DAY_MS);
}

// ============================================================
// Health score & recommended actions
// ============================================================

export interface HealthFactor {
  key: 'sla' | 'pm' | 'entitlements' | 'claims' | 'profitability' | 'renewal' | 'completeness';
  label: string;
  weight: number;
  score: number;
  detail: string;
}

export interface HealthInput {
  contract: Pick<AgreementRow, 'status' | 'end_date' | 'auto_renew' | 'renewal_notice_days'>;
  breaches: Pick<BreachRow, 'severity' | 'resolved' | 'created_at'>[];
  pmPlans: Pick<PmPlanRow, 'active' | 'next_due_date'>[];
  claims: Pick<ClaimRow, 'status'>[];
  renewal: Pick<RenewalRow, 'status'> | null;
  termsReview: 'none' | 'draft' | 'verified';
  assetCount: number;
  /** Optional: only available in the detail view. */
  usage?: EntitlementUsage[];
  profit?: Profitability | null;
  now?: Date;
}

export interface Health {
  score: number;
  grade: HealthGrade;
  factors: HealthFactor[];
}

export function gradeFor(score: number): HealthGrade {
  if (score >= 85) return 'healthy';
  if (score >= 65) return 'watch';
  if (score >= 40) return 'at_risk';
  return 'critical';
}

function marginScore(m: number): number {
  if (m <= -40) return 0;
  if (m < 0) return ((m + 40) / 40) * 50;
  if (m < 30) return 50 + (m / 30) * 50;
  return 100;
}

export function computeHealth(input: HealthInput): Health {
  const now = input.now ?? new Date();
  const factors: HealthFactor[] = [];
  const cutoff = now.getTime() - 90 * DAY_MS;

  // SLA performance (last 90 days)
  const recent = input.breaches.filter((b) => new Date(b.created_at).getTime() >= cutoff);
  const unresolved = recent.filter((b) => !b.resolved);
  const heavy = unresolved.filter((b) => b.severity !== 'minor').length;
  const light = unresolved.length - heavy;
  const slaPenalty = heavy * 25 + light * 10 + (recent.length - unresolved.length) * 3;
  factors.push({
    key: 'sla',
    label: 'SLA performance',
    weight: 25,
    score: clamp(100 - slaPenalty, 0, 100),
    detail: recent.length === 0 ? 'No breaches in 90 days' : `${recent.length} breach${recent.length === 1 ? '' : 'es'} in 90 days, ${unresolved.length} unresolved`,
  });

  // PM compliance
  const active = input.pmPlans.filter((p) => p.active);
  if (active.length > 0) {
    const states = active.map((p) => pmStatus(p, now).status);
    const overdue = states.filter((s) => s === 'overdue').length;
    factors.push({
      key: 'pm',
      label: 'Preventive maintenance',
      weight: 15,
      score: clamp(100 - (overdue / active.length) * 100, 0, 100),
      detail: overdue === 0 ? `${active.length} plan${active.length === 1 ? '' : 's'} on schedule` : `${overdue} of ${active.length} overdue`,
    });
  }

  // Included-visit utilisation (detail view only)
  if (input.usage && input.usage.length > 0) {
    const scores = input.usage.map((u) => {
      if (u.included <= 0) return 100;
      if (u.utilizationPct > 100) return clamp(100 - (u.utilizationPct - 100), 40, 100);
      if (u.elapsedPct >= 50 && u.utilizationPct < 40) return 70;
      return 100;
    });
    const worst = Math.min(...scores);
    const over = input.usage.filter((u) => u.overage > 0).length;
    const under = input.usage.filter((u) => u.included > 0 && u.elapsedPct >= 50 && u.utilizationPct < 40).length;
    factors.push({
      key: 'entitlements',
      label: 'Included visits',
      weight: 10,
      score: worst,
      detail: over > 0 ? `${over} allowance${over === 1 ? '' : 's'} exceeded` : under > 0 ? `${under} under-used (churn risk)` : 'Usage within allowance',
    });
  }

  // Claims
  const openClaims = input.claims.filter((c) => c.status === 'open' || c.status === 'under_review').length;
  factors.push({
    key: 'claims',
    label: 'Claims',
    weight: 10,
    score: clamp(100 - openClaims * 20, 20, 100),
    detail: openClaims === 0 ? 'No open claims' : `${openClaims} open claim${openClaims === 1 ? '' : 's'}`,
  });

  // Profitability (detail view only)
  if (input.profit && input.profit.marginPct !== null && !input.profit.lowConfidence) {
    factors.push({
      key: 'profitability',
      label: 'Profitability',
      weight: 20,
      score: marginScore(input.profit.marginPct),
      detail: `${formatPct(input.profit.marginPct)} margin to date`,
    });
  }

  // Renewal
  const rs = renewalState(input.contract, input.renewal, now);
  if (rs.daysLeft !== null || rs.risk === 'secured') {
    const score = rs.risk === 'secured' ? 100 : rs.risk === 'lapsed' ? 10 : rs.risk === 'urgent' ? 40 : rs.risk === 'watch' ? 75 : 100;
    factors.push({ key: 'renewal', label: 'Renewal', weight: 10, score, detail: rs.headline });
  }

  // Data completeness (terms verified + assets mapped)
  const termsScore = input.termsReview === 'verified' ? 100 : input.termsReview === 'draft' ? 60 : 30;
  const assetScore = input.assetCount > 0 ? 100 : 50;
  factors.push({
    key: 'completeness',
    label: 'Terms & coverage data',
    weight: 10,
    score: Math.round((termsScore + assetScore) / 2),
    detail: `${input.termsReview === 'verified' ? 'Terms verified' : input.termsReview === 'draft' ? 'Terms unverified' : 'No structured terms'}, ${input.assetCount} covered asset${input.assetCount === 1 ? '' : 's'}`,
  });

  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const score = Math.round(factors.reduce((s, f) => s + f.score * f.weight, 0) / totalWeight);
  return { score, grade: gradeFor(score), factors };
}

export type AgreementTab = 'overview' | 'coverage' | 'sla' | 'maintenance' | 'visits' | 'pricing' | 'renewal' | 'claims' | 'profitability';

export interface RecommendedAction {
  severity: 'critical' | 'warning' | 'info';
  text: string;
  tab: AgreementTab;
}

export interface ActionInput {
  contract: AgreementRow;
  health: Health;
  pmPlans: PmPlanRow[];
  usage: EntitlementUsage[];
  claims: ClaimRow[];
  breaches: BreachRow[];
  renewal: RenewalRow | null;
  profit: Profitability | null;
  reprice: RepriceSuggestion | null;
  escalation: EscalationProjection;
  assetCount: number;
  termsReview: 'none' | 'draft' | 'verified';
  now?: Date;
}

export function recommendActions(i: ActionInput): RecommendedAction[] {
  const now = i.now ?? new Date();
  const out: RecommendedAction[] = [];
  const rs = renewalState(i.contract, i.renewal, now);

  const unresolved = i.breaches.filter((b) => !b.resolved);
  if (unresolved.length > 0) {
    out.push({ severity: unresolved.some((b) => b.severity === 'critical') ? 'critical' : 'warning', text: `${unresolved.length} unresolved SLA breach${unresolved.length === 1 ? '' : 'es'} — review credits and root cause.`, tab: 'sla' });
  }
  const overdue = i.pmPlans.filter((p) => pmStatus(p, now).status === 'overdue');
  if (overdue.length > 0) out.push({ severity: 'warning', text: `${overdue.length} preventive-maintenance plan${overdue.length === 1 ? ' is' : 's are'} overdue — schedule visits.`, tab: 'maintenance' });
  const over = i.usage.filter((u) => u.overage > 0);
  if (over.length > 0) out.push({ severity: 'warning', text: `${ENTITLEMENT_KIND_LABELS[over[0].kind]} exceeded the included allowance — bill overage or reprice.`, tab: 'visits' });
  const under = i.usage.filter((u) => u.included > 0 && u.elapsedPct >= 50 && u.utilizationPct < 40);
  if (under.length > 0) out.push({ severity: 'info', text: `${ENTITLEMENT_KIND_LABELS[under[0].kind]} are under-used — book them to prove value before renewal.`, tab: 'visits' });
  if (rs.risk === 'urgent' || rs.risk === 'lapsed') out.push({ severity: rs.risk === 'lapsed' ? 'critical' : 'warning', text: `${rs.headline}.`, tab: 'renewal' });
  else if (rs.risk === 'watch' && !i.renewal) out.push({ severity: 'info', text: 'Expires within 90 days — start the renewal early.', tab: 'renewal' });
  if (i.profit && i.profit.marginPct !== null && !i.profit.lowConfidence && i.profit.marginPct < 0) {
    out.push({ severity: 'critical', text: `Losing money: ${formatPct(i.profit.marginPct)} margin to date.`, tab: 'profitability' });
  }
  if (i.reprice) out.push({ severity: 'info', text: `To reach ${i.reprice.targetMarginPct}% margin, price at ${formatMoney(i.reprice.suggestedFeeCents)} per period (+${formatPct(i.reprice.increasePct)}).`, tab: 'pricing' });
  if (i.escalation.daysAway !== null && i.escalation.daysAway >= 0 && i.escalation.daysAway <= 60) {
    out.push({ severity: 'info', text: `Price escalation due ${formatDate(i.escalation.nextDate)}${i.escalation.projectedCents !== null ? ` (to ${formatMoney(i.escalation.projectedCents)})` : ''}.`, tab: 'pricing' });
  }
  const openClaims = i.claims.filter((c) => c.status === 'open' || c.status === 'under_review');
  if (openClaims.length > 0) out.push({ severity: 'warning', text: `${openClaims.length} open claim${openClaims.length === 1 ? '' : 's'} need a decision.`, tab: 'claims' });
  if (i.termsReview !== 'verified') out.push({ severity: 'info', text: i.termsReview === 'none' ? 'No structured terms yet — add them in Contract Intelligence so jobs are evaluated automatically.' : 'Verify the extracted contract terms in Contract Intelligence.', tab: 'overview' });
  if (i.assetCount === 0 && i.contract.customer_id) out.push({ severity: 'info', text: 'Map the covered properties and equipment so coverage is exact.', tab: 'coverage' });

  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 8);
}

// ============================================================
// Derived view-model (one pass over the loaded 360° data)
// ============================================================

export interface Derived {
  usage: EntitlementUsage[];
  profit: Profitability;
  health: Health;
  reprice: RepriceSuggestion | null;
  escalation: EscalationProjection;
  /** Latest renewal record (open one if any). */
  renewal: RenewalRow | null;
  renewalState: RenewalState;
  actions: RecommendedAction[];
}

export function deriveAgreement(d: Agreement360, now: Date = new Date()): Derived {
  const usage = d.entitlements.map((e) => entitlementUsage(e, d.visits, d.contract, now));
  const profit = computeProfitability({ contract: d.contract, jobs: d.jobFinancials, breaches: d.breaches, claims: d.claims, now });
  const renewal = d.renewals.find((r) => r.status === 'pending' || r.status === 'quoted') ?? d.renewals[0] ?? null;
  const health = computeHealth({
    contract: d.contract,
    breaches: d.breaches,
    pmPlans: d.pmPlans,
    claims: d.claims,
    renewal,
    termsReview: d.termsReview,
    assetCount: d.assets.length,
    usage,
    profit: d.financialsAvailable ? profit : null,
    now,
  });
  const reprice = d.financialsAvailable ? suggestReprice(d.contract, profit) : null;
  const escalation = projectEscalation(d.contract, d.terms, now);
  const rs = renewalState(d.contract, renewal, now);
  const actions = recommendActions({
    contract: d.contract,
    health,
    pmPlans: d.pmPlans,
    usage,
    claims: d.claims,
    breaches: d.breaches,
    renewal,
    profit: d.financialsAvailable ? profit : null,
    reprice,
    escalation,
    assetCount: d.assets.length,
    termsReview: d.termsReview,
    now,
  });
  return { usage, profit, health, reprice, escalation, renewal, renewalState: rs, actions };
}

// ============================================================
// Coverage helpers
// ============================================================

export function siteLabel(s: Pick<SiteLite, 'name' | 'city' | 'state'>): string {
  const place = [s.city, s.state].filter(Boolean).join(', ');
  return place ? `${s.name} — ${place}` : s.name;
}

export function equipmentLabel(e: Pick<EquipmentLite, 'equipment_type' | 'make' | 'model'>): string {
  return [e.make, e.model].filter(Boolean).join(' ') ? `${e.equipment_type} · ${[e.make, e.model].filter(Boolean).join(' ')}` : e.equipment_type;
}

/** Equipment whose warranty ends before the agreement does — the agreement carries the risk beyond it. */
export function warrantyGapEquipment(
  assets: AssetRow[],
  equipment: EquipmentLite[],
  contractEnd: string | null
): EquipmentLite[] {
  const ids = new Set(assets.map((a) => a.equipment_id).filter((x): x is string => !!x));
  return equipment.filter((e) => {
    if (!ids.has(e.id)) return false;
    if (!e.warranty_expires_at) return true;
    return contractEnd ? e.warranty_expires_at < contractEnd : e.warranty_expires_at < toDateKey(new Date());
  });
}

// ============================================================
// Loaders (Supabase)
// ============================================================

const CONTRACT_COLS =
  'id, customer_id, contract_number, contract_name, contract_type, status, start_date, end_date, auto_renew, renewal_notice_days, billing_frequency, contract_value_cents, sla_response_minutes_standard, sla_response_minutes_critical, sla_resolution_hours, penalty_percentage, penalty_cap_percentage, signed_at, document_url';

export class AgreementDataError extends Error {
  migrationMissing: boolean;
  constructor(message: string, migrationMissing = false) {
    super(message);
    this.migrationMissing = migrationMissing;
  }
}

interface PgErrorLike {
  code?: string;
  message?: string;
}

export function isMissingRelation(err: PgErrorLike | null | undefined): boolean {
  if (!err) return false;
  return err.code === '42P01' || err.code === 'PGRST205' || /does not exist|schema cache/i.test(err.message ?? '');
}

function check<T>(res: { data: T | null; error: PgErrorLike | null }, what: string): T {
  if (res.error) {
    throw new AgreementDataError(isMissingRelation(res.error) ? `The ${what} table is missing — run the Service Agreement OS migration.` : `Could not load ${what}.`, isMissingRelation(res.error));
  }
  return (res.data ?? ([] as unknown)) as T;
}

export interface Agreement360 {
  contract: AgreementRow;
  customer: CustomerLite | null;
  terms: ContractTerms;
  termsReview: 'none' | 'draft' | 'verified';
  assets: AssetRow[];
  services: ServiceRow[];
  entitlements: EntitlementRow[];
  pmPlans: PmPlanRow[];
  visits: VisitRow[];
  claims: ClaimRow[];
  priceChanges: PriceChangeRow[];
  renewals: RenewalRow[];
  breaches: BreachRow[];
  sites: SiteLite[];
  equipment: EquipmentLite[];
  jobs: AttributedJob[];
  jobFinancials: JobFinancial[];
  /** False when the job_profitability view could not be read (profitability then shows revenue only). */
  financialsAvailable: boolean;
}

const chunk = <T,>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export async function loadAgreement360(contractId: string): Promise<Agreement360 | null> {
  const contractRes = await supabase.from('commercial_contracts').select(CONTRACT_COLS).eq('id', contractId).maybeSingle();
  if (contractRes.error) throw new AgreementDataError('Could not load the agreement.');
  const contract = contractRes.data as AgreementRow | null;
  if (!contract) return null;

  const customerId = contract.customer_id;
  const jobsFrom = contract.start_date ?? '1970-01-01';

  const [customer, profile, assets, services, entitlements, pmPlans, visits, claims, priceChanges, renewals, breaches, sites, equipment, coverage, customerJobs] = await Promise.all([
    customerId ? supabase.from('customers').select('id, name, customer_type').eq('id', customerId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    supabase.from('contract_intelligence_profiles').select('terms, review_status').eq('contract_id', contractId).maybeSingle(),
    supabase.from('agreement_assets').select('id, contract_id, site_id, equipment_id, coverage_level, notes').eq('contract_id', contractId).limit(2000),
    supabase.from('agreement_services').select('id, contract_id, service_type, coverage, labor_covered, parts_covered, discount_percent, per_visit_cap_cents, notes').eq('contract_id', contractId).order('service_type').limit(500),
    supabase.from('agreement_entitlements').select('id, contract_id, kind, included_quantity, period, overage_rate_cents').eq('contract_id', contractId),
    supabase.from('agreement_pm_plans').select('id, contract_id, name, site_id, equipment_id, equipment_type, frequency_months, checklist, estimated_minutes, next_due_date, last_completed_date, active').eq('contract_id', contractId).order('next_due_date', { ascending: true, nullsFirst: false }).limit(1000),
    supabase.from('agreement_visits').select('id, contract_id, entitlement_kind, pm_plan_id, job_id, visit_date, status, quantity, billable, notes, completed_at').eq('contract_id', contractId).order('visit_date', { ascending: false }).limit(2000),
    supabase.from('agreement_claims').select('id, contract_id, job_id, breach_id, warranty_claim_id, claim_type, status, title, description, claimed_cents, approved_cents, settled_cents, opened_at, resolved_at, resolution_notes').eq('contract_id', contractId).order('opened_at', { ascending: false }).limit(500),
    supabase.from('agreement_price_changes').select('id, contract_id, kind, effective_date, previous_cents, new_cents, reason, created_at').eq('contract_id', contractId).order('effective_date', { ascending: false }).order('created_at', { ascending: false }).limit(200),
    supabase.from('agreement_renewals').select('id, contract_id, status, proposed_value_cents, proposed_start, proposed_end, proposed_changes, quoted_at, decided_at, notes, created_at').eq('contract_id', contractId).order('created_at', { ascending: false }).limit(50),
    supabase.from('contract_sla_breaches').select('id, contract_id, job_id, breach_type, severity, minutes_over, penalty_amount_cents, resolved, created_at').eq('contract_id', contractId).order('created_at', { ascending: false }).limit(500),
    customerId ? supabase.from('customer_sites').select('id, name, address, city, state').eq('customer_id', customerId).order('name').limit(500) : Promise.resolve({ data: [], error: null }),
    customerId ? supabase.from('equipment').select('id, equipment_type, make, model, serial_number, status, warranty_expires_at, last_service_date, service_interval_months').eq('customer_id', customerId).neq('status', 'removed').order('equipment_type').limit(1000) : Promise.resolve({ data: [], error: null }),
    supabase.from('job_contract_coverage').select('job_id, contract_id, verdict, billing_action').eq('contract_id', contractId).limit(2000),
    customerId
      ? supabase.from('jobs').select('id, created_at, job_status, service_type, site_id, customer_name').eq('customer_id', customerId).gte('created_at', jobsFrom).order('created_at', { ascending: false }).limit(1500)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const coverageRows = (coverage.error ? [] : (coverage.data ?? [])) as { job_id: string; verdict: string; billing_action: string }[];
  const coverageByJob = new Map(coverageRows.map((c) => [c.job_id, c]));

  // Jobs in the contract window for this customer; a job already evaluated against ANOTHER contract is excluded.
  const windowEnd = contract.end_date ? parseDay(contract.end_date).getTime() + DAY_MS : Infinity;
  const candidate = ((customerJobs.error ? [] : customerJobs.data) ?? []) as Omit<AttributedJob, 'verdict' | 'billing_action'>[];
  const inWindow = candidate.filter((j) => new Date(j.created_at).getTime() < windowEnd);
  const otherContractJobs = new Set<string>();
  if (inWindow.length > 0) {
    const otherRes = await supabase.from('job_contract_coverage').select('job_id, contract_id').in('job_id', inWindow.slice(0, 500).map((j) => j.id)).neq('contract_id', contractId);
    for (const r of ((otherRes.error ? [] : otherRes.data) ?? []) as { job_id: string }[]) otherContractJobs.add(r.job_id);
  }
  const jobs: AttributedJob[] = inWindow
    .filter((j) => !otherContractJobs.has(j.id))
    .map((j) => ({ ...j, verdict: coverageByJob.get(j.id)?.verdict ?? null, billing_action: coverageByJob.get(j.id)?.billing_action ?? null }));

  let jobFinancials: JobFinancial[] = [];
  let financialsAvailable = true;
  if (jobs.length > 0) {
    const results = await Promise.all(
      chunk(
        jobs.map((j) => j.id),
        150
      ).map((ids) => supabase.from('job_profitability').select('job_id, revenue_cents, total_cost_cents, labor_cost_cents, material_cost_cents').in('job_id', ids))
    );
    if (results.some((r) => r.error)) {
      financialsAvailable = false;
    } else {
      jobFinancials = results.flatMap((r) => (r.data ?? []) as Record<string, unknown>[]).map((r) => ({
        job_id: String(r.job_id),
        revenue_cents: num(r.revenue_cents),
        total_cost_cents: num(r.total_cost_cents),
        labor_cost_cents: num(r.labor_cost_cents),
        material_cost_cents: num(r.material_cost_cents),
      }));
    }
  }

  const profileRow = (profile.error ? null : profile.data) as { terms: unknown; review_status: 'draft' | 'verified' } | null;

  return {
    contract,
    customer: (customer.error ? null : customer.data) as CustomerLite | null,
    terms: profileRow ? normalizeTerms(profileRow.terms) : emptyTerms(),
    termsReview: profileRow ? profileRow.review_status : 'none',
    assets: check<AssetRow[]>(assets as never, 'agreement_assets'),
    services: check<ServiceRow[]>(services as never, 'agreement_services').map((s) => ({ ...s, discount_percent: num(s.discount_percent) })),
    entitlements: check<EntitlementRow[]>(entitlements as never, 'agreement_entitlements').map((e) => ({ ...e, included_quantity: num(e.included_quantity) })),
    pmPlans: check<PmPlanRow[]>(pmPlans as never, 'agreement_pm_plans').map((p) => ({ ...p, checklist: p.checklist ?? [] })),
    visits: check<VisitRow[]>(visits as never, 'agreement_visits').map((v) => ({ ...v, quantity: num(v.quantity) })),
    claims: check<ClaimRow[]>(claims as never, 'agreement_claims'),
    priceChanges: check<PriceChangeRow[]>(priceChanges as never, 'agreement_price_changes'),
    renewals: check<RenewalRow[]>(renewals as never, 'agreement_renewals'),
    breaches: check<BreachRow[]>(breaches as never, 'contract_sla_breaches'),
    sites: ((sites.error ? [] : sites.data) ?? []) as SiteLite[],
    equipment: ((equipment.error ? [] : equipment.data) ?? []) as EquipmentLite[],
    jobs,
    jobFinancials,
    financialsAvailable,
  };
}

// ----- Portfolio ---------------------------------------------------------

export interface PortfolioRow {
  contract: AgreementRow;
  customerName: string;
  assetCount: number;
  openClaims: number;
  overduePm: number;
  activePm: number;
  unresolvedBreaches: number;
  penaltyCents90: number;
  renewal: RenewalRow | null;
  renewalState: RenewalState;
  termsReview: 'none' | 'draft' | 'verified';
  health: Health;
  annualValueCents: number | null;
}

export interface Portfolio {
  rows: PortfolioRow[];
  migrationMissing: boolean;
}

export async function loadPortfolio(): Promise<Portfolio> {
  const contractsRes = await supabase
    .from('commercial_contracts')
    .select(`${CONTRACT_COLS}, customer:customer_id (name)`)
    .neq('status', 'terminated')
    .order('end_date', { ascending: true, nullsFirst: false })
    .limit(500);
  if (contractsRes.error) throw new AgreementDataError('Could not load agreements.');

  const raw = (contractsRes.data ?? []) as unknown as (AgreementRow & { customer: { name: string } | null })[];
  if (raw.length === 0) return { rows: [], migrationMissing: false };

  const [assets, plans, claims, breaches, renewals, profiles] = await Promise.all([
    supabase.from('agreement_assets').select('contract_id').limit(10000),
    supabase.from('agreement_pm_plans').select('contract_id, active, next_due_date').limit(10000),
    supabase.from('agreement_claims').select('contract_id, status').limit(10000),
    supabase.from('contract_sla_breaches').select('contract_id, severity, resolved, created_at, penalty_amount_cents').limit(10000),
    supabase.from('agreement_renewals').select('id, contract_id, status, proposed_value_cents, proposed_start, proposed_end, proposed_changes, quoted_at, decided_at, notes, created_at').order('created_at', { ascending: false }).limit(5000),
    supabase.from('contract_intelligence_profiles').select('contract_id, review_status').limit(5000),
  ]);

  const migrationMissing = [assets, plans, claims, renewals].some((r) => isMissingRelation(r.error));
  if (migrationMissing) return { rows: [], migrationMissing: true };

  const group = <T extends { contract_id: string }>(res: { data: T[] | null; error: unknown }): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of (res.error ? [] : (res.data ?? []))) {
      const list = m.get(r.contract_id);
      if (list) list.push(r);
      else m.set(r.contract_id, [r]);
    }
    return m;
  };
  const assetsBy = group(assets as { data: { contract_id: string }[] | null; error: unknown });
  const plansBy = group(plans as { data: { contract_id: string; active: boolean; next_due_date: string | null }[] | null; error: unknown });
  const claimsBy = group(claims as { data: { contract_id: string; status: ClaimStatus }[] | null; error: unknown });
  const breachesBy = group(breaches as { data: { contract_id: string; severity: 'minor' | 'major' | 'critical'; resolved: boolean; created_at: string; penalty_amount_cents: number | null }[] | null; error: unknown });
  const renewalsBy = group(renewals as { data: RenewalRow[] | null; error: unknown });
  const reviewBy = new Map(((profiles.error ? [] : profiles.data) ?? []).map((p) => [(p as { contract_id: string }).contract_id, (p as { review_status: 'draft' | 'verified' }).review_status]));

  const now = new Date();
  const cutoff = now.getTime() - 90 * DAY_MS;

  const rows: PortfolioRow[] = raw.map((c) => {
    const { customer, ...contract } = c;
    const cBreaches = breachesBy.get(c.id) ?? [];
    const cPlans = plansBy.get(c.id) ?? [];
    const cClaims = claimsBy.get(c.id) ?? [];
    const renewal = (renewalsBy.get(c.id) ?? [])[0] ?? null;
    const termsReview = reviewBy.get(c.id) ?? 'none';
    const assetCount = (assetsBy.get(c.id) ?? []).length;
    const health = computeHealth({ contract, breaches: cBreaches, pmPlans: cPlans, claims: cClaims, renewal, termsReview, assetCount, now });
    return {
      contract,
      customerName: customer?.name ?? 'No customer linked',
      assetCount,
      openClaims: cClaims.filter((x) => x.status === 'open' || x.status === 'under_review').length,
      overduePm: cPlans.filter((p) => pmStatus(p, now).status === 'overdue').length,
      activePm: cPlans.filter((p) => p.active).length,
      unresolvedBreaches: cBreaches.filter((b) => !b.resolved).length,
      penaltyCents90: cBreaches.filter((b) => new Date(b.created_at).getTime() >= cutoff).reduce((s, b) => s + num(b.penalty_amount_cents), 0),
      renewal,
      renewalState: renewalState(contract, renewal, now),
      termsReview,
      health,
      annualValueCents: annualizedValueCents(contract),
    };
  });
  return { rows, migrationMissing: false };
}

export interface PortfolioKpis {
  live: number;
  annualRecurringCents: number;
  atRiskRenewals: number;
  unresolvedBreaches: number;
  overduePm: number;
  openClaims: number;
  avgHealth: number | null;
}

export function portfolioKpis(rows: PortfolioRow[]): PortfolioKpis {
  const live = rows.filter((r) => isLiveContract(r.contract.status));
  return {
    live: live.length,
    annualRecurringCents: live.reduce((s, r) => s + (r.annualValueCents ?? 0), 0),
    atRiskRenewals: live.filter((r) => r.renewalState.risk === 'urgent' || r.renewalState.risk === 'lapsed').length,
    unresolvedBreaches: live.reduce((s, r) => s + r.unresolvedBreaches, 0),
    overduePm: live.reduce((s, r) => s + r.overduePm, 0),
    openClaims: live.reduce((s, r) => s + r.openClaims, 0),
    avgHealth: live.length > 0 ? Math.round(live.reduce((s, r) => s + r.health.score, 0) / live.length) : null,
  };
}

// ============================================================
// Writers
// ============================================================

export type AgreementTable =
  | 'agreement_assets'
  | 'agreement_services'
  | 'agreement_entitlements'
  | 'agreement_pm_plans'
  | 'agreement_visits'
  | 'agreement_claims'
  | 'agreement_price_changes'
  | 'agreement_renewals';

/** Maps raw Postgres/PostgREST errors to a sentence a dispatcher can act on. */
export function friendlyWriteError(err: (PgErrorLike & { details?: string }) | null | undefined): string {
  if (!err) return 'Something went wrong.';
  if (isMissingRelation(err)) return 'The Service Agreement OS migration has not been applied yet.';
  if (err.code === '23505') return 'That record already exists on this agreement.';
  if (err.code === '23514') return err.message && !/violates check constraint/i.test(err.message) ? err.message : 'One of the values is outside the allowed range.';
  if (err.code === '42501' || err.code === 'PGRST301') return 'You do not have permission to change this agreement.';
  if (err.code === '23503') return 'A linked record no longer exists. Refresh and try again.';
  return 'Could not save. Please try again.';
}

export interface WriteResult {
  error: string | null;
}

/** `ownerId` must be the ACCOUNT OWNER's id (teamMember?.account_owner_id ?? user.id) — RLS requires it. */
export async function insertAgreementRow(table: AgreementTable, ownerId: string, row: Record<string, unknown>): Promise<WriteResult> {
  const { error } = await supabase.from(table).insert({ ...row, user_id: ownerId });
  return { error: error ? friendlyWriteError(error) : null };
}

/** Bulk insert (one round trip, all-or-nothing). */
export async function insertAgreementRows(table: AgreementTable, ownerId: string, rows: Record<string, unknown>[]): Promise<WriteResult> {
  if (rows.length === 0) return { error: null };
  const { error } = await supabase.from(table).insert(rows.map((r) => ({ ...r, user_id: ownerId })));
  return { error: error ? friendlyWriteError(error) : null };
}

export async function updateAgreementRow(table: AgreementTable, id: string, patch: Record<string, unknown>): Promise<WriteResult> {
  const { error } = await supabase.from(table).update(patch).eq('id', id);
  return { error: error ? friendlyWriteError(error) : null };
}

export async function deleteAgreementRow(table: AgreementTable, id: string): Promise<WriteResult> {
  const { error } = await supabase.from(table).delete().eq('id', id);
  return { error: error ? friendlyWriteError(error) : null };
}

/**
 * Applies a new per-period fee. The history row is written FIRST so the DB's auto-capture trigger
 * (which skips duplicates written within a minute) does not add a second, generic "amendment" row.
 */
export async function applyPriceChange(params: {
  ownerId: string;
  contractId: string;
  kind: PriceChangeKind;
  previousCents: number | null;
  newCents: number;
  effectiveDate: string;
  reason: string;
}): Promise<WriteResult> {
  const hist = await insertAgreementRow('agreement_price_changes', params.ownerId, {
    contract_id: params.contractId,
    kind: params.kind,
    effective_date: params.effectiveDate,
    previous_cents: params.previousCents,
    new_cents: params.newCents,
    reason: params.reason.trim() || null,
  });
  if (hist.error) return hist;
  const { error } = await supabase.from('commercial_contracts').update({ contract_value_cents: params.newCents }).eq('id', params.contractId);
  return { error: error ? friendlyWriteError(error) : null };
}
