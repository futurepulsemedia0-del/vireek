import type { Equipment, EquipmentMaintenanceAlert } from '@/lib/supabase';
import type { PropertyTwin } from '@/lib/propertyTwin';
import { CATEGORY_LABELS, classifyEquipment, monthsOverdue, type HealthCategoryKey } from '@/lib/homeHealthScore';
import { DEFAULT_COSTS, type CostProfile } from '@/lib/homeBudget';
import { failureProbability, yearsToQuantile } from '@/lib/lifetimeServicePlan';

/**
 * Vireek Service Finance Decision Engine.
 *
 * Connects Finance to Service Intelligence. For every active unit on a property it answers:
 * "which financial structure is the best economic path for THIS service?" — not merely
 * "does this customer want financing?".
 *
 * Inputs combined per unit:
 *   equipment condition + failure probability + replacement cost + customer economics
 *   + energy savings + warranty + expected remaining life.
 *
 * Paths compared (same horizon, same discount rate, same residual-life credit):
 *   repair             — repair-and-hold, replace only when it fails
 *   repair_membership  — keep the unit on a maintenance membership (lower hazard, repair discount)
 *   replace_cash       — planned replacement paid in cash
 *   replace_loan       — planned replacement on a consumer/commercial loan
 *   replace_lease      — planned replacement on lease-to-own
 *
 * Pure, deterministic and explainable: no network, no randomness. The same twin, the same
 * economics and the same `now` always produce the same decisions. Runtime imports are limited
 * to other pure Vireek modules, so it is safe to unit test.
 *
 * Honesty rules (all enforced in the output, never hidden):
 *   - Every default that is not measured is listed in `assumptions`.
 *   - Confidence drops when the unit's age, the customer's credit band or cash position is guessed.
 *   - APRs and merchant fees are PLANNING values; a real lender offer always overrides them.
 *   - Recommendations are decision support for the contractor, never a credit decision.
 */

// ---------------------------------------------------------------------- config

export const FINANCE_HORIZON_YEARS = 10;

/** Keep in sync with MIN_FINANCING_AMOUNT_CENTS in financing.ts (kept local so this module stays pure). */
const MIN_FINANCED_AMOUNT = 200;

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const MS_PER_MONTH = 30.4375 * 24 * 60 * 60 * 1000;
const REPAIR_WINDOW_MS = 24 * MS_PER_MONTH;
const MAINTENANCE_VISIT = /maint|tune|inspect|clean|flush|check|service\s*plan|seasonal|filter|annual|install/i;

const MIN_MULTIPLIER = 0.5;
const MAX_MULTIPLIER = 4;
const UNKNOWN_AGE_RATIO = 0.6;
const ALERT_HAZARD = { high: 1.5, medium: 1.25, low: 1.08 } as const;

/** Manufacturer warranties are typically parts-only: share of repair cost covered. */
const WARRANTY_COVERAGE = 0.5;
/** Unplanned (failure-driven) replacement costs more: rush parts, no time to shop, no financing choice. */
const EMERGENCY_PREMIUM = 0.12;
/** Membership: hazard reduction beyond fixing overdue service, repair discount, and priority-service effect. */
const MEMBERSHIP_HAZARD_FACTOR = 0.9;
const MEMBERSHIP_REPAIR_DISCOUNT = 0.15;
const MEMBERSHIP_DISRUPTION_FACTOR = 0.7;
/** Value assigned to unused life at the horizon (a buyer / the customer still gets that life). */
const RESIDUAL_RECOGNITION = 0.7;
/** Share of modelled energy savings that is realistically captured. */
const ENERGY_REALIZATION = 0.8;
/** Straight-line depreciation years for commercial customers. */
const DEPRECIATION_YEARS = 7;

/** Scenario weights on the existing unit's hazard: optimistic / expected / pessimistic. */
const SCENARIOS: ReadonlyArray<{ scale: number; weight: number }> = [
  { scale: 0.75, weight: 0.25 },
  { scale: 1, weight: 0.5 },
  { scale: 1.4, weight: 0.25 },
];

const DEFAULT_ENERGY_COST: Record<CustomerSegment, number> = { residential: 2400, commercial: 9000 };
/** Cost of one failure event beyond the repair itself (no heat/cooling/hot water, spoilage, lost sales). */
const DISRUPTION_COST: Record<CustomerSegment, number> = { residential: 250, commercial: 1200 };
const DEFAULT_DISCOUNT_RATE: Record<CustomerSegment, number> = { residential: 0.07, commercial: 0.12 };
const DEFAULT_COMMERCIAL_TAX_RATE = 0.25;
/** Cash the customer should keep after paying, or cash is not a safe path. */
const DEFAULT_RESERVE: Record<CustomerSegment, number> = { residential: 2000, commercial: 10000 };

const DEFAULT_FEE_PCT = { loan: 0.065, lease: 0.09 } as const;

export type CustomerSegment = 'residential' | 'commercial';
export type CreditBand = 'unknown' | 'excellent' | 'good' | 'fair' | 'poor';

/** Planning APRs by credit band. Real lender offers override these. `null` = lenders typically decline. */
export const PLANNING_APR: Readonly<Record<CreditBand, { loan: number | null; lease: number }>> = {
  excellent: { loan: 0.0799, lease: 0.1199 },
  good: { loan: 0.1199, lease: 0.1599 },
  fair: { loan: 0.1799, lease: 0.2199 },
  unknown: { loan: 0.1399, lease: 0.1799 },
  poor: { loan: null, lease: 0.2899 },
};

interface CategoryModel {
  life: number;
  shape: number;
  /** Share of a property's annual energy bill this system drives. */
  energyShare: number;
  /** Fractional saving of that share from a modern replacement of a fully-aged unit. */
  energySaving: number;
  leasable: boolean;
  newWarrantyYears: number;
  maxLoanTermMonths: number;
}

/** Same Weibull wear-out family as lifetimeServicePlan.ts / homeBudget.ts. `safety` is not financeable. */
const MODEL: Readonly<Partial<Record<HealthCategoryKey, CategoryModel>>> = {
  hvac: { life: 15, shape: 4, energyShare: 0.45, energySaving: 0.25, leasable: true, newWarrantyYears: 10, maxLoanTermMonths: 120 },
  water_heater: { life: 11, shape: 4, energyShare: 0.14, energySaving: 0.3, leasable: true, newWarrantyYears: 6, maxLoanTermMonths: 60 },
  roof: { life: 22, shape: 4, energyShare: 0, energySaving: 0, leasable: false, newWarrantyYears: 10, maxLoanTermMonths: 120 },
  electrical: { life: 35, shape: 3.5, energyShare: 0, energySaving: 0, leasable: false, newWarrantyYears: 5, maxLoanTermMonths: 84 },
  plumbing: { life: 30, shape: 3, energyShare: 0, energySaving: 0, leasable: false, newWarrantyYears: 5, maxLoanTermMonths: 84 },
};

const TERM_LADDER = [24, 36, 60, 84, 120] as const;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const money = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------- types

export type FinancePath = 'repair' | 'repair_membership' | 'replace_cash' | 'replace_loan' | 'replace_lease';
export type FinanceTiming = 'now' | 'plan' | 'monitor';
export type FinanceConfidence = 'low' | 'medium' | 'high';
export type FinanceRisk = 'low' | 'medium' | 'high';

export const FINANCE_PATH_LABELS: Record<FinancePath, string> = {
  repair: 'Repair & hold',
  repair_membership: 'Repair + membership',
  replace_cash: 'Replace — cash',
  replace_loan: 'Replace — financing (loan)',
  replace_lease: 'Replace — lease-to-own',
};

export const FINANCE_TIMING_LABELS: Record<FinanceTiming, string> = {
  now: 'Act now',
  plan: 'Plan & pre-qualify',
  monitor: 'Monitor',
};

export const FINANCE_CONFIDENCE_LABELS: Record<FinanceConfidence, string> = {
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
};

export interface CustomerEconomics {
  segment: CustomerSegment;
  creditBand: CreditBand;
  /** Liquid cash the customer could put toward this, in dollars. null = unknown. */
  cashAvailable: number | null;
  /** Maximum comfortable monthly payment, in dollars. null = no limit given. */
  monthlyBudget: number | null;
  /** Whole-property annual energy spend, in dollars. null = use a segment default. */
  annualEnergyCost: number | null;
  /** Years the customer expects to keep the property (1–10). null = at least the full horizon. */
  expectedStayYears: number | null;
  /** Annual rate at which the customer discounts future money (their cost of capital). null = segment default. */
  discountRate: number | null;
  /** Commercial customers only. null = default. */
  taxRate: number | null;
}

export const DEFAULT_ECONOMICS: Readonly<CustomerEconomics> = {
  segment: 'residential',
  creditBand: 'unknown',
  cashAvailable: null,
  monthlyBudget: null,
  annualEnergyCost: null,
  expectedStayYears: null,
  discountRate: null,
  taxRate: null,
};

export interface FinanceOptions {
  now?: number;
  /** Per-category cost overrides (e.g. from the price book). */
  costs?: Partial<Record<HealthCategoryKey, Partial<CostProfile>>>;
  /** Merchant fee charged by the lender/lessor, as a fraction of the financed amount. */
  financingFeePct?: Partial<{ loan: number; lease: number }>;
  /** Annual membership fee per category, in dollars. Default: one maintenance visit plus 10% (perks, priority, repair discount). */
  membershipAnnualFee?: Partial<Record<HealthCategoryKey, number>>;
}

export interface ContractorEconomics {
  grossRevenue: number;
  financingFee: number;
  netRevenue: number;
  /** Annual recurring revenue (memberships). */
  recurringRevenue: number;
}

export interface PathEvaluation {
  path: FinancePath;
  label: string;
  feasible: boolean;
  infeasibleReason: string | null;
  /** Probability-weighted present-value cost to the customer over the horizon (lower is better). */
  expectedCost: number;
  /** Present-value cost in the expected-hazard scenario. */
  baseCost: number;
  /** Largest amount by which this path loses to the best feasible path in any scenario. */
  worstRegret: number;
  /** Customer cash needed on day one. */
  upfrontCash: number;
  monthlyPayment: number;
  termMonths: number | null;
  apr: number | null;
  /** Total nominal payments over the full term (cash price for cash). */
  totalPaid: number;
  /** Interest/finance charge over the full term. */
  interestCost: number;
  /** Net annual energy saving the new unit is expected to deliver (0 for keep-the-unit paths). */
  energySavingPerYear: number;
  contractor: ContractorEconomics;
  /** 1 = best feasible path. Infeasible paths are ranked last, unranked (0). */
  rank: number;
}

export interface UnitFinanceDecision {
  equipmentId: string;
  label: string;
  categoryKey: HealthCategoryKey;
  categoryLabel: string;
  ageYears: number;
  ageAssumed: boolean;
  lifespanYears: number;
  /** 0–1 chance of at least one failure in the next 12 months / 5 years. */
  risk12m: number;
  risk5y: number;
  risk: FinanceRisk;
  /** Months until the median expected replacement of the existing unit (0 = already due). */
  medianMonthsToReplacement: number;
  replacementCost: number;
  timing: FinanceTiming;
  recommended: PathEvaluation;
  runnerUp: PathEvaluation | null;
  /** Cost advantage of the recommended path over the runner-up (0 if there is no runner-up). */
  margin: number;
  marginPct: number;
  /** Customer saving of the recommended path vs repair-and-hold, over the horizon (negative = costs more). */
  savingsVsRepair: number;
  confidence: FinanceConfidence;
  paths: PathEvaluation[];
  rationale: string[];
  flags: string[];
  nextAction: string;
}

export interface FinancePortfolio {
  unitsAnalyzed: number;
  replaceNowCount: number;
  planCount: number;
  monitorCount: number;
  pathMix: Record<FinancePath, number>;
  /** Customer cash needed today across units recommended for action now. */
  upfrontCashNow: number;
  monthlyPaymentsNow: number;
  financedVolumeNow: number;
  /** Contractor view of recommended "act now" replacements. */
  grossRevenueNow: number;
  financingFeesNow: number;
  netRevenueNow: number;
  /** Replacement revenue expected from units flagged "plan & pre-qualify" (next ~24 months). */
  pipelineGross24m: number;
  recurringRevenue: number;
  /** Total customer saving across units vs repair-and-hold. */
  totalSavingsVsRepair: number;
}

export interface ServiceFinancePlan {
  horizonYears: number;
  economics: CustomerEconomics;
  units: UnitFinanceDecision[];
  portfolio: FinancePortfolio;
  confidence: FinanceConfidence;
  assumptions: string[];
}

// ------------------------------------------------------------- input hygiene

function finiteOrNull(n: number | null | undefined, min: number, max: number): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return clamp(n, min, max);
}

/** Never trust UI input: clamps every field into a range the model is valid for. */
export function normalizeEconomics(input: Partial<CustomerEconomics> | undefined): CustomerEconomics {
  const e = { ...DEFAULT_ECONOMICS, ...input };
  const segment: CustomerSegment = e.segment === 'commercial' ? 'commercial' : 'residential';
  const creditBand: CreditBand = e.creditBand in PLANNING_APR ? e.creditBand : 'unknown';
  return {
    segment,
    creditBand,
    cashAvailable: finiteOrNull(e.cashAvailable, 0, 1e9),
    monthlyBudget: finiteOrNull(e.monthlyBudget, 0, 1e7),
    annualEnergyCost: finiteOrNull(e.annualEnergyCost, 0, 1e8),
    expectedStayYears: finiteOrNull(e.expectedStayYears, 1, FINANCE_HORIZON_YEARS),
    discountRate: finiteOrNull(e.discountRate, 0, 0.5),
    taxRate: finiteOrNull(e.taxRate, 0, 0.5),
  };
}

// ------------------------------------------------------------------ unit model

interface Unit {
  id: string;
  label: string;
  category: HealthCategoryKey;
  model: CategoryModel;
  age: number;
  ageAssumed: boolean;
  life: number;
  /** Hazard multiplier today / with service kept on schedule. */
  mNow: number;
  mServiced: number;
  /** Years from now until the existing warranty ends (0 = none/expired). */
  warrantyYears: number;
  /** Customer already pays for scheduled service, so a membership replaces that spend instead of adding to it. */
  maintenanceOnSchedule: boolean;
  costs: CostProfile;
  membershipFee: number;
}

function equipmentLabel(item: Equipment, category: HealthCategoryKey): string {
  const named = `${item.make ?? ''} ${item.model ?? ''}`.trim();
  return named || item.equipment_type || CATEGORY_LABELS[category];
}

function readRepairVisits(twin: PropertyTwin, now: number): Map<string, number> {
  const jobsById = new Map(twin.jobs.map((j) => [j.id, j]));
  const visits = new Map<string, number>();
  for (const link of twin.jobEquipmentLinks) {
    const job = jobsById.get(link.job_id);
    if (!job || job.job_status === 'cancelled' || job.job_status === 'no_show') continue;
    const when = job.scheduled_datetime ? new Date(job.scheduled_datetime).getTime() : null;
    if (when !== null && when < now - REPAIR_WINDOW_MS) continue;
    const kind = link.service_type ?? job.service_type ?? '';
    if (kind && MAINTENANCE_VISIT.test(kind)) continue;
    visits.set(link.equipment_id, (visits.get(link.equipment_id) ?? 0) + 1);
  }
  return visits;
}

function historyFactor(repairVisits: number): number {
  if (repairVisits >= 3) return 1.6;
  if (repairVisits === 2) return 1.3;
  if (repairVisits === 1) return 1.1;
  return 1;
}

function maintenanceFactor(overdueMonths: number | null): number {
  if (overdueMonths === null) return 1.1;
  if (overdueMonths <= 0) return 1;
  return 1 + Math.min(0.6, 0.03 * overdueMonths);
}

function alertFactor(alerts: EquipmentMaintenanceAlert[]): number {
  return alerts.reduce((max, a) => Math.max(max, ALERT_HAZARD[a.risk_level] ?? 1), 1);
}

function buildUnit(
  item: Equipment,
  twin: PropertyTwin,
  repairVisits: Map<string, number>,
  now: number,
  options: FinanceOptions,
): Unit | null {
  if (item.status !== 'active') return null;
  const category = classifyEquipment(item);
  if (!category) return null;
  const model = MODEL[category];
  if (!model) return null; // e.g. safety devices: below the financing minimum, not a financing decision

  const life = item.expected_lifespan_years > 0 ? clamp(item.expected_lifespan_years, 3, 60) : model.life;
  const installMs = item.install_date ? Date.parse(item.install_date) : NaN;
  const ageAssumed = !Number.isFinite(installMs);
  const age = ageAssumed ? life * UNKNOWN_AGE_RATIO : Math.max(0, (now - installMs) / MS_PER_YEAR);

  const alerts = twin.maintenanceAlerts.filter((a) => a.equipment_id === item.id && !a.is_dismissed);
  const hist = historyFactor(repairVisits.get(item.id) ?? 0);
  const mNow = clamp(hist * maintenanceFactor(monthsOverdue(item, now)) * alertFactor(alerts), MIN_MULTIPLIER, MAX_MULTIPLIER);
  const mServiced = clamp(hist * MEMBERSHIP_HAZARD_FACTOR, MIN_MULTIPLIER, MAX_MULTIPLIER);

  const warrantyMs = item.warranty_expires_at ? Date.parse(item.warranty_expires_at) : NaN;
  const warrantyYears = Number.isFinite(warrantyMs) && warrantyMs > now ? (warrantyMs - now) / MS_PER_YEAR : 0;

  const costs = { ...DEFAULT_COSTS[category], ...options.costs?.[category] };
  const membershipFee = Math.max(0, options.membershipAnnualFee?.[category] ?? Math.round(costs.maintenance * 1.1));
  const maintenanceOnSchedule = monthsOverdue(item, now) === 0;

  return { id: item.id, label: equipmentLabel(item, category), category, model, age, ageAssumed, life, mNow, mServiced, warrantyYears, maintenanceOnSchedule, costs, membershipFee };
}

// ------------------------------------------------------------ finance primitives

/** Level monthly payment for a fully amortising loan. APR 0 is handled. */
export function monthlyPayment(principal: number, apr: number, months: number): number {
  if (principal <= 0 || months <= 0) return 0;
  const r = apr / 12;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
}

function loanBalance(principal: number, apr: number, payment: number, paid: number): number {
  const r = apr / 12;
  if (r === 0) return Math.max(0, principal - payment * paid);
  return Math.max(0, principal * Math.pow(1 + r, paid) - (payment * (Math.pow(1 + r, paid) - 1)) / r);
}

function defaultTermMonths(price: number, maxTerm: number): number {
  const wanted = price < 1500 ? 24 : price < 5000 ? 36 : price < 12000 ? 60 : 84;
  return Math.min(wanted, maxTerm);
}

/** Smallest term (from the default upward) whose payment fits the budget; null if none does. */
function chooseTerm(price: number, apr: number, maxTerm: number, budget: number | null): number | null {
  const start = defaultTermMonths(price, maxTerm);
  const ladder: number[] = TERM_LADDER.filter((t) => t >= start && t <= maxTerm);
  if (ladder.length === 0) ladder.push(start);
  if (budget === null) return ladder[0];
  for (const term of ladder) {
    if (monthlyPayment(price, apr, term) <= budget) return term;
  }
  return null;
}

interface Env {
  econ: CustomerEconomics;
  horizon: number;
  discount: number;
  tax: number;
  energyAnnual: number;
  disruption: number;
  options: FinanceOptions;
}

const df = (env: Env, t: number) => Math.pow(1 + env.discount, -t);
const dfMonth = (env: Env, month: number) => Math.pow(1 + env.discount, -month / 12);

/** PV of a level annual amount received at the middle of each year in [from, to). */
function annuityPv(env: Env, amountPerYear: number, from: number, to: number): number {
  let pv = 0;
  for (let k = 0; from + k < to - 1e-9; k++) {
    const a = from + k;
    const b = Math.min(a + 1, to);
    pv += amountPerYear * (b - a) * df(env, (a + b) / 2);
  }
  return pv;
}

/** Tax value of straight-line depreciating `amount` bought at time `t` (commercial only). */
function depreciationShield(env: Env, amount: number, t: number): number {
  if (env.tax <= 0) return 0;
  let pv = 0;
  for (let y = 1; y <= DEPRECIATION_YEARS; y++) pv += (amount / DEPRECIATION_YEARS) * env.tax * df(env, t + y);
  return pv;
}

function energySavingPerYear(u: Unit, env: Env, ageAtReplacement: number): number {
  const ageRatio = clamp(ageAtReplacement / u.life, 0, 1);
  const gap = clamp(0.35 + 0.65 * ageRatio, 0.35, 1);
  return env.energyAnnual * u.model.energyShare * u.model.energySaving * gap * ENERGY_REALIZATION;
}

/** Routine service the customer already buys every year; a membership replaces it, every other path keeps it. */
function routineServiceCost(u: Unit, env: Env): number {
  return u.maintenanceOnSchedule ? annuityPv(env, u.costs.maintenance * (1 - env.tax), 0, env.horizon) : 0;
}

/**
 * Cost stream of a unit installed at `start`: expected repairs under warranty, planned
 * re-replacement if its life ends inside the horizon, and the residual value of unused life.
 */
function newUnitStream(u: Unit, env: Env, start: number): { cost: number; residual: number } {
  const medianLife = Math.max(1, yearsToQuantile(0, u.life, u.model.shape, 0.5, 1));
  let cost = 0;
  let t0 = start;
  for (let cycle = 0; cycle < 6; cycle++) {
    const end = Math.min(env.horizon, t0 + medianLife);
    for (let k = 0; t0 + k < end - 1e-9; k++) {
      const a = t0 + k;
      const b = Math.min(a + 1, end);
      const f = b - a;
      const events = failureProbability(k, u.life, u.model.shape, 1, 1) * f;
      const covered = k < u.model.newWarrantyYears ? WARRANTY_COVERAGE : 0;
      const perEvent = u.costs.repair * (1 - covered) + env.disruption;
      cost += events * perEvent * (1 - env.tax) * df(env, (a + b) / 2);
    }
    if (t0 + medianLife < env.horizon - 1e-9) {
      const at = t0 + medianLife;
      cost += u.costs.replacement * df(env, at) - depreciationShield(env, u.costs.replacement, at);
      t0 = at;
    } else {
      break;
    }
  }
  const residualYears = Math.max(0, t0 + medianLife - env.horizon);
  const residual = (residualYears / u.life) * u.costs.replacement * RESIDUAL_RECOGNITION * df(env, env.horizon);
  return { cost, residual };
}

/** Existing unit kept in service; replaced at its median end of life if that falls inside the horizon. */
function keepCost(u: Unit, env: Env, scale: number, membership: boolean): number {
  const m = clamp((membership ? u.mServiced : u.mNow) * scale, MIN_MULTIPLIER, MAX_MULTIPLIER);
  const medianRemaining = yearsToQuantile(u.age, u.life, u.model.shape, 0.5, m);
  const inService = Math.min(medianRemaining, env.horizon);
  let cost = 0;

  if (membership) {
    for (let y = 0; y < env.horizon; y++) cost += u.membershipFee * (1 - env.tax) * df(env, y);
  } else {
    cost += routineServiceCost(u, env);
  }

  for (let k = 0; k < inService - 1e-9; k++) {
    const a = k;
    const b = Math.min(k + 1, inService);
    const f = b - a;
    const events = failureProbability(u.age + k, u.life, u.model.shape, m, 1) * f;
    const covered = (a + b) / 2 < u.warrantyYears ? WARRANTY_COVERAGE : 0;
    const repair = u.costs.repair * (1 - covered) * (membership ? 1 - MEMBERSHIP_REPAIR_DISCOUNT : 1);
    const disruption = env.disruption * (membership ? MEMBERSHIP_DISRUPTION_FACTOR : 1);
    cost += events * (repair + disruption) * (1 - env.tax) * df(env, (a + b) / 2);
  }

  if (medianRemaining < env.horizon - 1e-9) {
    const premium = membership ? EMERGENCY_PREMIUM / 2 : EMERGENCY_PREMIUM;
    const price = u.costs.replacement * (1 + premium);
    cost += price * df(env, medianRemaining) - depreciationShield(env, price, medianRemaining);
    cost += env.disruption * (membership ? MEMBERSHIP_DISRUPTION_FACTOR : 1) * (1 - env.tax) * df(env, medianRemaining);
    const stream = newUnitStream(u, env, medianRemaining);
    cost += stream.cost - stream.residual;
    const saving = energySavingPerYear(u, env, u.age + medianRemaining);
    cost -= annuityPv(env, saving * (1 - env.tax), medianRemaining, env.horizon);
  } else {
    const residual = ((medianRemaining - env.horizon) / u.life) * u.costs.replacement * RESIDUAL_RECOGNITION * df(env, env.horizon);
    cost -= residual;
  }
  return cost;
}

interface ReplaceTerms {
  kind: 'cash' | 'loan' | 'lease';
  apr: number | null;
  term: number | null;
  payment: number;
}

/** Customer cost of replacing now, financed per `terms`. Identical for every hazard scenario. */
function replaceNowCost(u: Unit, env: Env, terms: ReplaceTerms): { cost: number; totalPaid: number; interest: number } {
  const price = u.costs.replacement;
  const stream = newUnitStream(u, env, 0);
  const saving = energySavingPerYear(u, env, u.age);
  let cost = stream.cost - stream.residual - annuityPv(env, saving * (1 - env.tax), 0, env.horizon) + routineServiceCost(u, env);
  let totalPaid = price;
  let interest = 0;

  if (terms.kind === 'cash' || terms.term === null || terms.apr === null) {
    cost += price - depreciationShield(env, price, 0);
    return { cost, totalPaid, interest };
  }

  const payment = terms.payment;
  totalPaid = payment * terms.term;
  interest = Math.max(0, totalPaid - price);
  const heldMonths = Math.min(terms.term, Math.round(env.horizon * 12));
  let pvPayments = 0;
  for (let i = 1; i <= heldMonths; i++) pvPayments += payment * dfMonth(env, i);
  // Selling/ending the horizon before the term ends: the remaining balance is settled then.
  if (heldMonths < terms.term) pvPayments += loanBalance(price, terms.apr, payment, heldMonths) * dfMonth(env, heldMonths);

  if (terms.kind === 'lease') {
    // Lease payments are fully deductible; the customer owns the unit at the end (nominal buyout).
    cost += pvPayments * (1 - env.tax);
  } else {
    const paidWithin = payment * heldMonths + (heldMonths < terms.term ? loanBalance(price, terms.apr, payment, heldMonths) : 0);
    const interestWithin = Math.max(0, paidWithin - price);
    const years = Math.max(1, Math.ceil(heldMonths / 12));
    let interestShield = 0;
    for (let y = 0; y < years; y++) interestShield += (interestWithin / years) * env.tax * df(env, y + 0.5);
    cost += pvPayments - depreciationShield(env, price, 0) - interestShield;
  }
  return { cost, totalPaid, interest };
}

// ------------------------------------------------------------- path evaluation

interface RawPath {
  path: FinancePath;
  feasible: boolean;
  reason: string | null;
  costByScenario: number[];
  upfront: number;
  payment: number;
  term: number | null;
  apr: number | null;
  totalPaid: number;
  interest: number;
  energy: number;
  contractor: ContractorEconomics;
}

function contractorFor(price: number, feePct: number, recurring: number): ContractorEconomics {
  const fee = price * feePct;
  return { grossRevenue: money(price), financingFee: money(fee), netRevenue: money(price - fee), recurringRevenue: money(recurring) };
}

function evaluateAll(u: Unit, env: Env): RawPath[] {
  const { econ } = env;
  const price = u.costs.replacement;
  const energy = money(energySavingPerYear(u, env, u.age) * (1 - env.tax));
  const out: RawPath[] = [];

  const keepRaw = (path: 'repair' | 'repair_membership'): RawPath => ({
    path,
    feasible: true,
    reason: null,
    costByScenario: SCENARIOS.map((s) => keepCost(u, env, s.scale, path === 'repair_membership')),
    upfront: path === 'repair_membership' ? u.membershipFee : 0,
    payment: 0,
    term: null,
    apr: null,
    totalPaid: 0,
    interest: 0,
    energy: 0,
    contractor: contractorFor(0, 0, path === 'repair_membership' ? u.membershipFee : 0),
  });
  out.push(keepRaw('repair'), keepRaw('repair_membership'));

  // ---- cash
  {
    const reserve = DEFAULT_RESERVE[econ.segment];
    const short = econ.cashAvailable !== null && econ.cashAvailable - price < reserve;
    const r = replaceNowCost(u, env, { kind: 'cash', apr: null, term: null, payment: 0 });
    out.push({
      path: 'replace_cash',
      feasible: !short,
      reason: short ? `Would leave less than ${formatUsd(reserve)} in reserve` : null,
      costByScenario: SCENARIOS.map(() => r.cost),
      upfront: money(price),
      payment: 0,
      term: null,
      apr: null,
      totalPaid: money(price),
      interest: 0,
      energy,
      contractor: contractorFor(price, 0, 0),
    });
  }

  // ---- loan
  {
    const apr = PLANNING_APR[econ.creditBand].loan;
    let feasible = true;
    let reason: string | null = null;
    let term: number | null = null;
    if (price < MIN_FINANCED_AMOUNT) {
      feasible = false;
      reason = `Below the ${formatUsd(MIN_FINANCED_AMOUNT)} financing minimum`;
    } else if (apr === null) {
      feasible = false;
      reason = 'Lenders typically decline this credit band';
    } else {
      term = chooseTerm(price, apr, u.model.maxLoanTermMonths, econ.monthlyBudget);
      if (term === null) {
        feasible = false;
        reason = 'Payment exceeds the monthly budget even at the longest term';
      }
    }
    if (feasible && term !== null && apr !== null) {
      const payment = monthlyPayment(price, apr, term);
      const r = replaceNowCost(u, env, { kind: 'loan', apr, term, payment });
      out.push({
        path: 'replace_loan', feasible, reason, costByScenario: SCENARIOS.map(() => r.cost), upfront: 0,
        payment: money(payment), term, apr, totalPaid: money(r.totalPaid), interest: money(r.interest), energy,
        contractor: contractorFor(price, feeRates(env).loan, 0),
      });
    } else {
      out.push(infeasible('replace_loan', reason, price, feeRates(env).loan));
    }
  }

  // ---- lease-to-own
  {
    const apr = PLANNING_APR[econ.creditBand].lease;
    let feasible = true;
    let reason: string | null = null;
    let term: number | null = null;
    if (!u.model.leasable) {
      feasible = false;
      reason = 'Lease-to-own is not offered for this system';
    } else if (price < MIN_FINANCED_AMOUNT) {
      feasible = false;
      reason = `Below the ${formatUsd(MIN_FINANCED_AMOUNT)} financing minimum`;
    } else {
      term = chooseTerm(price, apr, 84, econ.monthlyBudget);
      if (term === null) {
        feasible = false;
        reason = 'Payment exceeds the monthly budget even at the longest term';
      }
    }
    if (feasible && term !== null) {
      const payment = monthlyPayment(price, apr, term);
      const r = replaceNowCost(u, env, { kind: 'lease', apr, term, payment });
      out.push({
        path: 'replace_lease', feasible, reason, costByScenario: SCENARIOS.map(() => r.cost), upfront: 0,
        payment: money(payment), term, apr, totalPaid: money(r.totalPaid), interest: money(r.interest), energy,
        contractor: contractorFor(price, feeRates(env).lease, 0),
      });
    } else {
      out.push(infeasible('replace_lease', reason, price, feeRates(env).lease));
    }
  }
  return out;
}

function feeRates(env: Env): { loan: number; lease: number } {
  return {
    loan: clamp(env.options.financingFeePct?.loan ?? DEFAULT_FEE_PCT.loan, 0, 0.3),
    lease: clamp(env.options.financingFeePct?.lease ?? DEFAULT_FEE_PCT.lease, 0, 0.3),
  };
}

function infeasible(path: FinancePath, reason: string | null, price: number, feePct: number): RawPath {
  return {
    path, feasible: false, reason, costByScenario: SCENARIOS.map(() => Number.POSITIVE_INFINITY), upfront: 0, payment: 0,
    term: null, apr: null, totalPaid: 0, interest: 0, energy: 0, contractor: contractorFor(price, feePct, 0),
  };
}

function formatUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

// ------------------------------------------------------------------ decision

function riskLevel(risk5y: number): FinanceRisk {
  if (risk5y >= 0.5) return 'high';
  if (risk5y >= 0.2) return 'medium';
  return 'low';
}

function confidenceFrom(penalties: number): FinanceConfidence {
  if (penalties <= 0) return 'high';
  if (penalties === 1) return 'medium';
  return 'low';
}

function decideUnit(u: Unit, env: Env): UnitFinanceDecision {
  const raw = evaluateAll(u, env);

  const feasible = raw.filter((r) => r.feasible);
  const scenarioBest = SCENARIOS.map((_, i) => Math.min(...feasible.map((r) => r.costByScenario[i])));

  const evaluated: PathEvaluation[] = raw.map((r) => {
    const expected = r.feasible ? sum(r.costByScenario.map((c, i) => c * SCENARIOS[i].weight)) : Number.POSITIVE_INFINITY;
    const regret = r.feasible ? Math.max(...r.costByScenario.map((c, i) => c - scenarioBest[i])) : Number.POSITIVE_INFINITY;
    return {
      path: r.path,
      label: FINANCE_PATH_LABELS[r.path],
      feasible: r.feasible,
      infeasibleReason: r.reason,
      expectedCost: money(expected),
      baseCost: money(r.costByScenario[1]),
      worstRegret: money(regret),
      upfrontCash: money(r.upfront),
      monthlyPayment: r.payment,
      termMonths: r.term,
      apr: r.apr,
      totalPaid: r.totalPaid,
      interestCost: r.interest,
      energySavingPerYear: r.energy,
      contractor: r.contractor,
      rank: 0,
    };
  });

  const ranked = evaluated
    .filter((e) => e.feasible)
    .sort((a, b) => a.expectedCost - b.expectedCost || a.upfrontCash - b.upfrontCash);
  ranked.forEach((e, i) => (e.rank = i + 1));
  const paths = [...ranked, ...evaluated.filter((e) => !e.feasible)];

  // `repair` is always feasible, so `ranked` is never empty.
  const recommended = ranked[0];
  const runnerUp = ranked[1] ?? null;
  const repair = evaluated.find((e) => e.path === 'repair') as PathEvaluation;
  const margin = runnerUp ? runnerUp.expectedCost - recommended.expectedCost : 0;
  const marginPct = runnerUp && Math.abs(recommended.expectedCost) > 1 ? margin / Math.abs(recommended.expectedCost) : 0;
  const savingsVsRepair = money(repair.expectedCost - recommended.expectedCost);

  const risk12m = failureProbability(u.age, u.life, u.model.shape, u.mNow, 1);
  const risk5y = failureProbability(u.age, u.life, u.model.shape, u.mNow, 5);
  const medianMonths = Math.round(yearsToQuantile(u.age, u.life, u.model.shape, 0.5, u.mNow) * 12);

  const replacing = recommended.path.startsWith('replace_');
  const timing: FinanceTiming = replacing ? 'now' : medianMonths <= 24 || risk12m >= 0.3 ? 'plan' : 'monitor';

  // ---- confidence
  let penalties = 0;
  if (u.ageAssumed) penalties++;
  if (marginPct < 0.05 && runnerUp) penalties++;
  if ((recommended.path === 'replace_loan' || recommended.path === 'replace_lease') && env.econ.creditBand === 'unknown') penalties++;
  if (recommended.path === 'replace_cash' && env.econ.cashAvailable === null) penalties++;
  const confidence = confidenceFrom(penalties);

  // ---- flags
  const flags: string[] = [];
  if (u.ageAssumed) flags.push('No install date on record — age is assumed, so timing is an estimate.');
  if (risk12m >= 0.3 && !replacing) flags.push(`${Math.round(risk12m * 100)}% chance of failure within 12 months — have a financing option ready before it fails.`);
  if (!ranked.some((r) => r.path.startsWith('replace_'))) flags.push('No replacement structure is feasible for this customer right now.');
  if (env.econ.cashAvailable === null && recommended.path === 'replace_cash') flags.push('Assumes the customer can pay cash — confirm before quoting.');
  if (env.horizon < FINANCE_HORIZON_YEARS) flags.push(`Analysis uses a ${env.horizon}-year horizon (customer's expected stay).`);

  const rationale = buildRationale(u, env, recommended, repair, runnerUp, savingsVsRepair, risk12m, medianMonths);
  const nextAction = buildNextAction(u, recommended, timing, medianMonths);

  return {
    equipmentId: u.id,
    label: u.label,
    categoryKey: u.category,
    categoryLabel: CATEGORY_LABELS[u.category],
    ageYears: Math.round(u.age * 10) / 10,
    ageAssumed: u.ageAssumed,
    lifespanYears: u.life,
    risk12m: money(risk12m),
    risk5y: money(risk5y),
    risk: riskLevel(risk5y),
    medianMonthsToReplacement: medianMonths,
    replacementCost: money(u.costs.replacement),
    timing,
    recommended,
    runnerUp,
    margin: money(margin),
    marginPct: money(marginPct),
    savingsVsRepair,
    confidence,
    paths,
    rationale,
    flags,
    nextAction,
  };
}

function buildRationale(
  u: Unit,
  env: Env,
  best: PathEvaluation,
  repair: PathEvaluation,
  runnerUp: PathEvaluation | null,
  savingsVsRepair: number,
  risk12m: number,
  medianMonths: number,
): string[] {
  const lines: string[] = [];
  const yrs = env.horizon;
  if (best.path === 'repair') {
    lines.push(`Repairing and holding is the lowest-cost path over ${yrs} years — replacing now would cost more than the failure risk it removes.`);
  } else if (best.path === 'repair_membership') {
    lines.push(`Keeping the unit on a maintenance membership saves about ${formatUsd(savingsVsRepair)} over ${yrs} years versus repair-and-hold.`);
  } else {
    lines.push(`Replacing now beats repair-and-hold by about ${formatUsd(savingsVsRepair)} over ${yrs} years (failure cost, emergency premium and energy included).`);
  }
  if (best.path === 'replace_loan' || best.path === 'replace_lease') {
    const cashRival = runnerUp?.path === 'replace_cash' ? runnerUp : null;
    lines.push(
      `${FINANCE_PATH_LABELS[best.path]}: about ${formatUsd(best.monthlyPayment)}/mo for ${best.termMonths} months at a planning APR of ${((best.apr ?? 0) * 100).toFixed(1)}%` +
        (cashRival ? ' — it keeps the customer’s cash free and is still within range of paying cash.' : '.'),
    );
  }
  if (best.path === 'replace_cash') lines.push(`Paying cash avoids roughly ${formatUsd(Math.max(0, (runnerUp?.interestCost ?? 0)))} of finance charges.`);
  if (best.energySavingPerYear > 0) lines.push(`A modern unit is expected to save about ${formatUsd(best.energySavingPerYear)}/yr in energy.`);
  lines.push(`Failure risk: ${Math.round(risk12m * 100)}% in the next 12 months; median expected replacement in ${medianMonths <= 0 ? 'now (already due)' : medianMonths < 24 ? `${medianMonths} months` : `${Math.round(medianMonths / 12)} years`}.`);
  if (u.warrantyYears > 0 && best.path !== 'repair') lines.push('Existing warranty reduces repair cost but does not cover a full replacement.');
  if (repair.expectedCost > 0 && best.path !== 'repair' && best.path !== 'repair_membership') {
    lines.push(`Repair-and-hold is expected to cost about ${formatUsd(repair.expectedCost)} over ${yrs} years.`);
  }
  return lines;
}

function buildNextAction(u: Unit, best: PathEvaluation, timing: FinanceTiming, medianMonths: number): string {
  if (best.path === 'replace_loan') return `Offer financing on a ${formatUsd(u.costs.replacement)} replacement (about ${formatUsd(best.monthlyPayment)}/mo).`;
  if (best.path === 'replace_lease') return `Offer lease-to-own on a ${formatUsd(u.costs.replacement)} replacement (about ${formatUsd(best.monthlyPayment)}/mo).`;
  if (best.path === 'replace_cash') return `Quote a ${formatUsd(u.costs.replacement)} replacement; customer can pay cash.`;
  if (best.path === 'repair_membership') {
    return timing === 'plan'
      ? `Enrol in a maintenance membership and pre-qualify financing for ~${formatUsd(u.costs.replacement)} (replacement likely within ${Math.max(1, medianMonths)} months).`
      : 'Offer a maintenance membership; no financing needed yet.';
  }
  return timing === 'plan'
    ? `Repair now and pre-qualify financing for ~${formatUsd(u.costs.replacement)} (replacement likely within ${Math.max(1, medianMonths)} months).`
    : 'Repair as needed; no financing action yet.';
}

// -------------------------------------------------------------------- the plan

function emptyMix(): Record<FinancePath, number> {
  return { repair: 0, repair_membership: 0, replace_cash: 0, replace_loan: 0, replace_lease: 0 };
}

function summarize(units: UnitFinanceDecision[]): FinancePortfolio {
  const now = units.filter((u) => u.timing === 'now');
  const plan = units.filter((u) => u.timing === 'plan');
  const mix = emptyMix();
  for (const u of units) mix[u.recommended.path]++;
  const financed = now.filter((u) => u.recommended.path === 'replace_loan' || u.recommended.path === 'replace_lease');
  return {
    unitsAnalyzed: units.length,
    replaceNowCount: now.length,
    planCount: plan.length,
    monitorCount: units.filter((u) => u.timing === 'monitor').length,
    pathMix: mix,
    upfrontCashNow: money(sum(now.map((u) => u.recommended.upfrontCash))),
    monthlyPaymentsNow: money(sum(financed.map((u) => u.recommended.monthlyPayment))),
    financedVolumeNow: money(sum(financed.map((u) => u.replacementCost))),
    grossRevenueNow: money(sum(now.map((u) => u.recommended.contractor.grossRevenue))),
    financingFeesNow: money(sum(now.map((u) => u.recommended.contractor.financingFee))),
    netRevenueNow: money(sum(now.map((u) => u.recommended.contractor.netRevenue))),
    pipelineGross24m: money(sum(plan.map((u) => u.replacementCost))),
    recurringRevenue: money(sum(units.map((u) => u.recommended.contractor.recurringRevenue))),
    totalSavingsVsRepair: money(sum(units.map((u) => u.savingsVsRepair))),
  };
}

function buildAssumptions(econ: CustomerEconomics, env: Env, units: UnitFinanceDecision[]): string[] {
  const a: string[] = [];
  a.push(`Horizon ${env.horizon} years; customer discount rate ${(env.discount * 100).toFixed(0)}%${econ.discountRate === null ? ' (segment default)' : ''}. All dollars are today's dollars.`);
  a.push(
    econ.creditBand === 'unknown'
      ? 'Credit band unknown — a mid-range planning APR is used. Real lender offers always override these rates.'
      : `Planning APRs for a "${econ.creditBand}" credit band are estimates; real lender offers always override them.`,
  );
  a.push(
    econ.cashAvailable === null
      ? 'Customer cash position unknown — cash is assumed available.'
      : `Cash is only considered safe if the customer keeps ${formatUsd(DEFAULT_RESERVE[econ.segment])} in reserve.`,
  );
  if (econ.annualEnergyCost === null) a.push(`Energy bill not provided — a ${econ.segment} default of ${formatUsd(env.energyAnnual)}/yr is used for savings.`);
  a.push('Repair & hold means replace-on-failure. Memberships are priced at one maintenance visit plus 10% and replace routine service the customer already pays for.');
  a.push(`Failure events cost ${formatUsd(env.disruption)} beyond the repair itself; unplanned replacement carries a ${Math.round(EMERGENCY_PREMIUM * 100)}% premium.`);
  const fees = feeRates(env);
  a.push(`Lender/lessor merchant fees: ${(fees.loan * 100).toFixed(1)}% (loan), ${(fees.lease * 100).toFixed(1)}% (lease) of the financed amount.`);
  if (econ.segment === 'commercial') a.push(`Commercial tax treatment at ${(env.tax * 100).toFixed(0)}%: straight-line depreciation over ${DEPRECIATION_YEARS} years; lease payments expensed.`);
  if (units.some((u) => u.ageAssumed)) a.push('Units with no install date are assumed to be 60% through their expected life.');
  a.push('Decision support only — not a credit decision, tax advice or a lender approval.');
  return a;
}

export function computeServiceFinancePlan(
  twin: PropertyTwin,
  economics?: Partial<CustomerEconomics>,
  options: FinanceOptions = {},
): ServiceFinancePlan {
  const now = options.now ?? Date.now();
  const econ = normalizeEconomics(economics);
  const horizon = Math.round(econ.expectedStayYears ?? FINANCE_HORIZON_YEARS);
  const env: Env = {
    econ,
    horizon: clamp(horizon, 1, FINANCE_HORIZON_YEARS),
    discount: econ.discountRate ?? DEFAULT_DISCOUNT_RATE[econ.segment],
    tax: econ.segment === 'commercial' ? (econ.taxRate ?? DEFAULT_COMMERCIAL_TAX_RATE) : 0,
    energyAnnual: econ.annualEnergyCost ?? DEFAULT_ENERGY_COST[econ.segment],
    disruption: DISRUPTION_COST[econ.segment],
    options,
  };

  const repairVisits = readRepairVisits(twin, now);
  const units = twin.equipment
    .map((item) => buildUnit(item, twin, repairVisits, now, options))
    .filter((u): u is Unit => u !== null)
    .map((u) => decideUnit(u, env))
    // Most urgent economics first: act-now units, then by failure risk.
    .sort((a, b) => timingOrder(a.timing) - timingOrder(b.timing) || b.risk12m - a.risk12m);

  const portfolio = summarize(units);
  const penalized = units.filter((u) => u.confidence === 'low').length;
  const confidence: FinanceConfidence =
    units.length === 0 ? 'low' : penalized > units.length / 2 ? 'low' : units.some((u) => u.confidence !== 'high') ? 'medium' : 'high';

  return { horizonYears: env.horizon, economics: econ, units, portfolio, confidence, assumptions: buildAssumptions(econ, env, units) };
}

function timingOrder(t: FinanceTiming): number {
  return t === 'now' ? 0 : t === 'plan' ? 1 : 2;
}
