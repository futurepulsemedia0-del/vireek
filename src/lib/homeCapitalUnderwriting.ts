import type { Equipment, EquipmentMaintenanceAlert } from '@/lib/supabase';
import type { PropertyTwin } from '@/lib/propertyTwin';
import type { WarrantyClaimLite } from '@/lib/homeLifetimeGraph';
import { CATEGORY_LABELS, HEALTH_CATEGORIES, classifyEquipment, monthsOverdue, type HealthCategoryKey } from '@/lib/homeHealthScore';
import { DEFAULT_COSTS, climateForState, type ClimateClass, type CostProfile } from '@/lib/homeBudget';
import {
  CLIMATE_HAZARD,
  PROPERTY_HAZARD,
  SYSTEM_MODEL,
  UNKNOWN_AGE_RATIO,
  WARRANTY_COVERAGE,
  alertFactor,
  computeLifetimeServicePlan,
  failureProbability,
  historyFactor,
  homeAgeFromYearBuilt,
  isValidYearBuilt,
  maintenanceFactor,
  readRepairVisits,
} from '@/lib/lifetimeServicePlan';
import {
  MIN_NET_BENEFIT,
  analyzeEnergy,
  computeHomeIntelligenceGraph,
  type DataSignal,
  type EnergyReading,
  type EnergySignal,
  type GraphConfidence,
} from '@/lib/homeIntelligenceGraph';
import {
  PLANNING_APR,
  computeServiceFinancePlan,
  monthlyPayment,
  normalizeEconomics,
  type CustomerEconomics,
  type PathEvaluation,
  type UnitFinanceDecision,
} from '@/lib/serviceFinance';

/**
 * Vireek Home Risk & Capital Underwriting Engine — pure logic (no network, no randomness).
 *
 * Turns the Home Passport (equipment, age, repair/maintenance history, warranties, climate, energy,
 * property type) into the thing a lender, insurer or contractor actually needs: how risky is this
 * home today, and what capital will it need over the next 10 years?
 *
 * It COMPOSES the existing engines instead of re-inventing them, so every Vireek surface tells the
 * same story:
 *   - Hazard model & units ........ same Weibull wear-out + climate × property × repairs × service ×
 *                                   alerts × energy multipliers as homeIntelligenceGraph.ts
 *   - 1–10 year maintenance/inspections ... lifetimeServicePlan.ts roadmap
 *   - Financing paths ............. serviceFinance.ts (cash / loan / lease / membership)
 *   - Data coverage & drivers ..... homeIntelligenceGraph.ts
 *
 * What this module adds:
 *   1. Underwriting Risk Index (0–100, higher = riskier) with grade A–E, an uncertainty band and an
 *      explainable five-component breakdown.
 *   2. Optimal replacement timing from an age-replacement policy (minimise long-run cost per year
 *      given planned vs. emergency cost), bounded by a risk tolerance and snapped to a good season.
 *   3. One action per need — repair, replace, maintain, inspect, insure — each with a cost range,
 *      urgency, risk reduction, funding method and ready-made hand-offs to service, quote,
 *      financing, warranty, rebates and the marketplace.
 *   4. A 10-year capital plan with expected unplanned spend, debt service, cash-out and the monthly
 *      reserve that never runs a deficit.
 *
 * All money is in today's US dollars and is an EXPECTED value, never a quote, a credit decision or
 * an insurance offer. Home-age estimates are always labelled and never presented as measured.
 */

export const UNDERWRITING_ENGINE_VERSION = 'hcu-1.0';
export const CAPITAL_HORIZON_YEARS = 10;

// ---------------------------------------------------------------------- config

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const MS_PER_MONTH = 30.4375 * 24 * 60 * 60 * 1000;
const BASE_HAZARD = 0.02; // keep equal to lifetimeServicePlan.ts
const MIN_MULTIPLIER = 0.5;
const MAX_MULTIPLIER = 4;

/** Mirrors serviceFinance.ts: unplanned replacement costs more and disrupts the household/business. */
const EMERGENCY_PREMIUM = 0.12;
const DISRUPTION_COST: Record<CustomerEconomics['segment'], number> = { residential: 250, commercial: 1200 };
const DEFAULT_SHOCK_CAPACITY: Record<CustomerEconomics['segment'], number> = { residential: 5000, commercial: 25000 };
/** Manufacturer warranty on a newly installed unit, years (used only for the contingency estimate). */
const NEW_UNIT_WARRANTY_YEARS = 5;

const MIN_RISK_TOLERANCE = 0.1;
const MAX_RISK_TOLERANCE = 0.6;
export const DEFAULT_RISK_TOLERANCE = 0.3;

const SEARCH_STEP_YEARS = 0.1;
const SEARCH_MAX_YEARS = 30;
const RUN_TO_FAILURE_YEARS = 120;

/** Insurance/protection loading over expected loss (expenses, margin, adverse selection). Indicative only. */
const PROTECTION_LOADING = 0.35;
const PROTECTION_COVERAGE_SHARE = 0.7;
const PROTECTION_MIN_LOSS_5Y = 1500;
/** Share of the 12-month risk a competent inspection is assumed to remove (finds issues early). */
const INSPECTION_DETECTION = 0.2;

const COST_BAND: Record<'replace' | 'repair' | 'maintain' | 'inspect' | 'insure', readonly [number, number]> = {
  replace: [0.85, 1.35],
  repair: [0.7, 1.5],
  maintain: [0.9, 1.2],
  inspect: [0.9, 1.3],
  insure: [0.8, 1.3],
};

/** 1–5: how costly/dangerous a failure is. Only used to rank urgency. */
const CATEGORY_IMPACT: Record<HealthCategoryKey, number> = { roof: 5, electrical: 5, safety: 5, hvac: 4, water_heater: 4, plumbing: 4 };

/** Months (1–12) with the best pricing and contractor availability, by climate. */
const SHOULDER_MONTHS: Partial<Record<HealthCategoryKey, Partial<Record<ClimateClass, readonly number[]>> & { default: readonly number[] }>> = {
  hvac: { hot: [3, 4, 10, 11], cold: [5, 6, 8, 9], default: [4, 5, 9, 10] },
  roof: { default: [5, 6, 9, 10] },
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const combine = (ps: number[]) => 1 - ps.reduce((acc, p) => acc * (1 - clamp(p, 0, 1)), 1);

// ----------------------------------------------------------------------- types

export type CapitalAction = 'repair' | 'replace' | 'maintain' | 'inspect' | 'insure';
export type FundingMethod = 'cash' | 'loan' | 'lease' | 'warranty' | 'membership';
export type Urgency = 'critical' | 'high' | 'medium' | 'low';
export type RiskGrade = 'A' | 'B' | 'C' | 'D' | 'E';
export type TimingBasis = 'due_now' | 'economic' | 'risk_tolerance' | 'schedule';

export const ACTION_LABELS: Record<CapitalAction, string> = {
  repair: 'Repair', replace: 'Replace', maintain: 'Maintain', inspect: 'Inspect', insure: 'Insure / protect',
};
export const FUNDING_LABELS: Record<FundingMethod, string> = {
  cash: 'Cash', loan: 'Finance (loan)', lease: 'Finance (lease)', warranty: 'Warranty-covered', membership: 'Service membership',
};
export const URGENCY_LABELS: Record<Urgency, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
export const GRADE_TIERS: Record<RiskGrade, string> = { A: 'Preferred', B: 'Strong', C: 'Standard', D: 'Elevated', E: 'High risk' };

export interface FundingPlan {
  method: FundingMethod;
  /** Customer cash needed when the work happens, dollars. */
  upfrontCash: number;
  monthlyPayment: number;
  termMonths: number | null;
  apr: number | null;
  /** Net annual energy saving the new unit is expected to deliver (replacements only). */
  energySavingPerYear: number;
  note: string;
}

export interface CapitalTiming {
  /** Months from now to the recommended date (0 = now). */
  targetMonths: number;
  target: string;
  windowStart: string;
  windowEnd: string;
  basis: TimingBasis;
  /** True when the date was nudged into a better-priced season. */
  seasonal: boolean;
  note: string;
}

export interface WarrantyStatus {
  active: boolean;
  expiresAt: string | null;
  /** Active warranty AND a failure signal AND no claim already open for the unit. */
  claimEligible: boolean;
  openClaim: boolean;
}

export interface CapitalConnect {
  /** Service type to put on the job. */
  serviceType: string;
  quoteLine: { description: string; quantity: number; unit_price_cents: number };
  /** Which marketplace sources the work: parts for equipment, labor for installs, none for plans. */
  marketplace: 'parts' | 'labor' | null;
  financeEligible: boolean;
  rebateEligible: boolean;
}

export interface CapitalItem {
  key: string;
  unitId: string | null;
  equipmentId: string | null;
  categoryKey: HealthCategoryKey | null;
  categoryLabel: string;
  label: string;
  action: CapitalAction;
  title: string;
  rationale: string;
  urgency: Urgency;
  urgencyScore: number;
  costLow: number;
  costMid: number;
  costHigh: number;
  /** Mid estimate after warranty coverage. */
  outOfPocketMid: number;
  risk12mBefore: number;
  risk12mAfter: number;
  /** risk12mBefore − risk12mAfter, once the action is done. */
  riskReduction: number;
  expectedLossAvoided: number;
  netBenefit: number;
  netBenefitNote: string;
  timing: CapitalTiming;
  funding: FundingPlan;
  basis: 'equipment' | 'home_age' | 'portfolio';
  confidence: GraphConfidence;
  /** False for estimates made from the home's age: verify the unit before quoting or booking. */
  actionable: boolean;
  warranty: WarrantyStatus;
  connect: CapitalConnect;
  drivers: string[];
}

export interface CapitalYear {
  year: number;
  calendarYear: number;
  replacements: number;
  maintenance: number;
  inspections: number;
  /** Expected unplanned repair spend on systems that are still in service. */
  contingency: number;
  total: number;
  /** Principal financed by loans/leases this year (not paid in cash). */
  financedPrincipal: number;
  debtService: number;
  /** Cash that actually leaves the owner's pocket under the recommended funding. */
  cashOut: number;
  cumulativeCashOut: number;
  itemKeys: string[];
}

export interface ScoreComponent {
  key: 'exposure' | 'capital' | 'severity' | 'documentation' | 'protection';
  label: string;
  weight: number;
  /** 0–100, higher = riskier. */
  value: number;
  contribution: number;
  detail: string;
}

export interface ProtectionAssessment {
  recommended: boolean;
  uncoveredExpectedLoss5y: number;
  largestShock: number;
  shockCapacity: number;
  indicativeAnnualPremium: number;
  coveredLoss5y: number;
  reason: string;
}

export interface UnderwritingSummary {
  riskIndex: number;
  riskIndexLow: number;
  riskIndexHigh: number;
  grade: RiskGrade;
  tier: string;
  components: ScoreComponent[];
  risk12m: number;
  risk5y: number;
  riskAfter12m: number;
  expectedLoss12m: number;
  expectedLoss5y: number;
  capital: { next12m: number; years1to3: number; years1to5: number; tenYear: number; tenYearReplacements: number };
  reserve: { suggestedMonthly: number; fundingGap: number | null; annualReserve: number | null };
  protection: ProtectionAssessment;
  counts: Record<CapitalAction, number> & { financed: number; urgent: number };
}

export interface HomeCapitalUnderwriting {
  engineVersion: string;
  yearBuilt: number | null;
  climate: ClimateClass;
  riskTolerance: number;
  summary: UnderwritingSummary;
  items: CapitalItem[];
  years: CapitalYear[];
  energy: EnergySignal;
  dataGaps: DataSignal[];
  completenessPct: number;
  confidence: GraphConfidence;
  assumptions: string[];
}

export interface UnderwritingInput {
  twin: PropertyTwin;
  yearBuilt: number | null;
  energyReadings?: EnergyReading[];
  warrantyClaims?: Array<Pick<WarrantyClaimLite, 'equipment_id' | 'status' | 'credit_received_cents'>>;
  economics?: Partial<CustomerEconomics>;
}

export interface UnderwritingOptions {
  now?: number;
  /** Per-category overrides of the default cost profile (e.g. from the price book). */
  costs?: Partial<Record<HealthCategoryKey, Partial<CostProfile>>>;
  /** Latest acceptable cumulative failure probability before a planned replacement (0.1–0.6). */
  riskTolerance?: number;
  /** Dollars per year the owner already sets aside for capital work. null/undefined = unknown. */
  annualReserve?: number | null;
}

// ---------------------------------------------------------------------- units

interface Factors { env: number; history: number; service: number; alert: number; energy: number }
const product = (f: Factors) => f.env * f.history * f.service * f.alert * f.energy;

interface CapUnit {
  id: string;
  equipmentId: string | null;
  key: HealthCategoryKey;
  label: string;
  basis: 'equipment' | 'home_age';
  age: number;
  ageAssumed: boolean;
  life: number;
  shape: number;
  f: Factors;
  costs: CostProfile;
  warrantyUntil: number | null;
  warrantyExpiresAt: string | null;
  visits: number;
  overdueMonths: number | null;
  alerts: EquipmentMaintenanceAlert[];
}

const SEVERITY = { high: 3, medium: 2, low: 1 } as const;

function ageYears(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / MS_PER_YEAR);
}

/** Same construction as homeIntelligenceGraph.ts so the numbers agree everywhere. */
function buildUnits(
  twin: PropertyTwin,
  yearBuilt: number | null,
  energy: EnergySignal,
  costFor: (k: HealthCategoryKey) => CostProfile,
  now: number,
): CapUnit[] {
  const climate = climateForState(twin.site?.state);
  const propertyFactor = PROPERTY_HAZARD[twin.site?.site_type ?? 'other'] ?? 1;
  const envFactor = (key: HealthCategoryKey) => (CLIMATE_HAZARD[climate][key] ?? 1) * propertyFactor;
  const energyFactor = (key: HealthCategoryKey) => (key === 'hvac' ? energy.hvacMultiplier : 1);

  const visits = readRepairVisits(twin, now);
  const alertsByUnit = new Map<string, EquipmentMaintenanceAlert[]>();
  for (const a of twin.maintenanceAlerts) {
    if (a.is_dismissed) continue;
    const list = alertsByUnit.get(a.equipment_id) ?? [];
    list.push(a);
    alertsByUnit.set(a.equipment_id, list);
  }

  const units: CapUnit[] = [];
  const covered = new Set<HealthCategoryKey>();

  for (const item of twin.equipment as Equipment[]) {
    if (item.status !== 'active') continue;
    const key = classifyEquipment(item);
    if (!key) continue;
    covered.add(key);
    const model = SYSTEM_MODEL[key];
    const life = item.expected_lifespan_years > 0 ? item.expected_lifespan_years : model.life;
    const known = ageYears(item.install_date, now);
    const alerts = alertsByUnit.get(item.id) ?? [];
    const warranty = item.warranty_expires_at ? new Date(item.warranty_expires_at).getTime() : NaN;
    units.push({
      id: `eq:${item.id}`,
      equipmentId: item.id,
      key,
      label: [item.make, item.model].filter(Boolean).join(' ') || item.equipment_type,
      basis: 'equipment',
      age: known ?? life * UNKNOWN_AGE_RATIO,
      ageAssumed: known === null,
      life,
      shape: model.shape,
      f: {
        env: envFactor(key),
        history: historyFactor(visits.get(item.id) ?? 0),
        service: maintenanceFactor(monthsOverdue(item, now)),
        alert: alertFactor(alerts),
        energy: energyFactor(key),
      },
      costs: costFor(key),
      warrantyUntil: Number.isNaN(warranty) ? null : warranty,
      warrantyExpiresAt: item.warranty_expires_at ?? null,
      visits: visits.get(item.id) ?? 0,
      overdueMonths: monthsOverdue(item, now),
      alerts,
    });
  }

  const homeAge = homeAgeFromYearBuilt(yearBuilt, now);
  if (homeAge !== null) {
    for (const key of HEALTH_CATEGORIES) {
      const model = SYSTEM_MODEL[key];
      if (!model.estimableFromHomeAge || covered.has(key)) continue;
      units.push({
        id: `est:${key}`,
        equipmentId: null,
        key,
        label: CATEGORY_LABELS[key],
        basis: 'home_age',
        age: homeAge <= model.life ? homeAge : homeAge % model.life,
        ageAssumed: true,
        life: model.life,
        shape: model.shape,
        f: { env: envFactor(key), history: 1, service: 1, alert: 1, energy: energyFactor(key) },
        costs: costFor(key),
        warrantyUntil: null,
        warrantyExpiresAt: null,
        visits: 0,
        overdueMonths: null,
        alerts: [],
      });
    }
  }
  return units;
}

// ------------------------------------------------------------------ hazard math

const prob = (u: CapUnit, f: Factors, years: number, age: number = u.age) => failureProbability(age, u.life, u.shape, product(f), years);

/** Cumulative wear-out hazard over the next `t` years (the Weibull part, before the multiplier). */
function wearHazard(age: number, life: number, shape: number, t: number): number {
  const a = Math.max(0, age);
  return Math.pow((a + t) / life, shape) - Math.pow(a / life, shape);
}

/** Probability of surviving `t` more years (uncapped; includes the constant base hazard). */
function survival(age: number, life: number, shape: number, m: number, t: number): number {
  return Math.exp(-(wearHazard(age, life, shape, t) * m + BASE_HAZARD * t));
}

const warrantyActive = (u: CapUnit, atMs: number) => u.warrantyUntil !== null && u.warrantyUntil > atMs;

/** Expected cost of one failure event now: young units mostly need a repair, old units a replacement. */
function eventCost(u: CapUnit, now: number): number {
  const blend = clamp((u.age / u.life - 0.6) / 0.4, 0, 1);
  const base = u.costs.repair + (u.costs.replacement - u.costs.repair) * blend;
  return base * (warrantyActive(u, now + 0.5 * MS_PER_YEAR) ? 1 - WARRANTY_COVERAGE : 1);
}

export interface SteadyStatePolicy {
  /** Optimal replacement age of a fresh unit in years, or null when running to failure is cheaper. */
  years: number | null;
  /** Long-run cost per year under the better of the two policies. */
  rate: number;
}

/**
 * Renewal-reward (age-replacement) policy for a FRESH unit: replace at age t to minimise the long-run
 * cost per year, rate(t) = [Cp·S(t) + Cf·(1 − S(t))] / ∫₀ᵗ S(u) du, with Cp the planned and Cf the
 * (higher) unplanned replacement cost. Used for every cycle after the first.
 */
export function steadyStatePolicy(life: number, shape: number, m: number, plannedCost: number, failureCost: number): SteadyStatePolicy {
  const mm = clamp(m, MIN_MULTIPLIER, MAX_MULTIPLIER);
  const steps = Math.round(RUN_TO_FAILURE_YEARS / SEARCH_STEP_YEARS);
  let integral = 0;
  let prevS = 1;
  let bestT: number | null = null;
  let bestRate = Infinity;
  let endRate = Infinity;
  for (let i = 1; i <= steps; i++) {
    const t = i * SEARCH_STEP_YEARS;
    const s = survival(0, life, shape, mm, t);
    integral += ((prevS + s) / 2) * SEARCH_STEP_YEARS;
    prevS = s;
    const rate = (plannedCost * s + failureCost * (1 - s)) / integral;
    if (t <= SEARCH_MAX_YEARS && rate < bestRate) {
      bestRate = rate;
      bestT = t;
    }
    if (i === steps) endRate = rate;
  }
  return bestT !== null && bestT < SEARCH_MAX_YEARS && bestRate < endRate ? { years: bestT, rate: bestRate } : { years: null, rate: endRate };
}

export interface ReplacementPolicy {
  /** Years until the economically optimal replacement, or null when waiting for failure is cheaper. */
  economicYears: number | null;
  /** Years until the cumulative wear-out failure probability reaches the risk tolerance. */
  toleranceYears: number;
  /** Expected saving (dollars) of replacing after `years` instead of only on failure; negative = a premium paid for safety. */
  savingAt: (years: number) => number;
}

/**
 * When to replace an EXISTING unit (conditioned on its age and condition). Each year of life left in
 * the old unit is worth `steadyRate` (the cost per year a fresh unit would otherwise incur), so
 *   J(t) = [Cp·S(t) + Cf·(1 − S(t))] − steadyRate · ∫₀ᵗ S(u) du
 * is the expected cost of replacing at t; the optimum is where the hazard crosses steadyRate/(Cf − Cp).
 */
export function replacementPolicy(
  age: number, life: number, shape: number, m: number, plannedCost: number, failureCost: number, steadyRate: number, riskTolerance: number,
): ReplacementPolicy {
  const mm = clamp(m, MIN_MULTIPLIER, MAX_MULTIPLIER);
  const steps = Math.round(RUN_TO_FAILURE_YEARS / SEARCH_STEP_YEARS);
  const j: number[] = [];
  let integral = 0;
  let prevS = 1;
  let bestT: number | null = null;
  let bestJ = Infinity;
  let toleranceYears = Infinity;
  for (let i = 1; i <= steps; i++) {
    const t = i * SEARCH_STEP_YEARS;
    const s = survival(age, life, shape, mm, t);
    integral += ((prevS + s) / 2) * SEARCH_STEP_YEARS;
    prevS = s;
    // Tolerance is about wear-out (replacement-class) failure, not the random base hazard, which is mostly repairs.
    if (toleranceYears === Infinity && 1 - Math.exp(-wearHazard(age, life, shape, t) * mm) >= riskTolerance) toleranceYears = t;
    const value = plannedCost * s + failureCost * (1 - s) - steadyRate * integral;
    j.push(value);
    if (t <= SEARCH_MAX_YEARS && value < bestJ) {
      bestJ = value;
      bestT = t;
    }
  }
  const jInfinity = j[j.length - 1];
  const economic = bestT !== null && bestT < SEARCH_MAX_YEARS && bestJ < jInfinity ? bestT : null;
  const savingAt = (years: number) => jInfinity - j[clamp(Math.round(years / SEARCH_STEP_YEARS), 1, j.length) - 1];
  return { economicYears: economic, toleranceYears, savingAt };
}

// ----------------------------------------------------------------- timing helpers

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function timingFor(months: number, now: number, windowBefore: number, windowAfter: number, basis: TimingBasis, note: string, seasonal = false): CapitalTiming {
  const m = Math.max(0, Math.round(months));
  return {
    targetMonths: m,
    target: isoDate(now + m * MS_PER_MONTH),
    windowStart: isoDate(now + Math.max(0, m - windowBefore) * MS_PER_MONTH),
    windowEnd: isoDate(now + (m + windowAfter) * MS_PER_MONTH),
    basis,
    seasonal,
    note,
  };
}

/** Moves a replacement up to ±3 months into the best-priced season, never past the tolerance bound. */
function snapToSeason(months: number, boundMonths: number, key: HealthCategoryKey, climate: ClimateClass, now: number): { months: number; seasonal: boolean } {
  const table = SHOULDER_MONTHS[key];
  if (!table || months <= 2) return { months, seasonal: false };
  const preferred = table[climate] ?? table.default;
  let best: number | null = null;
  for (let delta = 0; delta <= 3; delta++) {
    for (const sign of [-1, 1]) {
      const candidate = months + sign * delta;
      if (candidate < 0 || candidate > boundMonths) continue;
      const month = new Date(now + candidate * MS_PER_MONTH).getUTCMonth() + 1;
      if (preferred.includes(month)) {
        best = candidate;
        break;
      }
    }
    if (best !== null) break;
  }
  return best === null ? { months, seasonal: false } : { months: best, seasonal: best !== months };
}

function urgencyOf(p12: number, monthsToTarget: number, categoryKey: HealthCategoryKey | null, extraImpact?: number): { score: number; level: Urgency } {
  const impact = (extraImpact ?? (categoryKey ? CATEGORY_IMPACT[categoryKey] : 4)) / 5;
  const proximity = 1 - clamp(monthsToTarget / 24, 0, 1);
  const score = Math.round(100 * (0.45 * Math.min(1, p12 / 0.5) + 0.35 * proximity + 0.2 * impact));
  return { score, level: score >= 70 ? 'critical' : score >= 50 ? 'high' : score >= 30 ? 'medium' : 'low' };
}

// -------------------------------------------------------------- funding helpers

function bestReplacePath(decision: UnitFinanceDecision | undefined): PathEvaluation | null {
  if (!decision) return null;
  const options = decision.paths.filter((p) => p.path.startsWith('replace_') && p.feasible);
  if (options.length === 0) return null;
  return [...options].sort((a, b) => a.expectedCost - b.expectedCost)[0];
}

function fundingForReplacement(
  cost: number, decision: UnitFinanceDecision | undefined, econ: CustomerEconomics, warrantyCovered: boolean,
): FundingPlan {
  const path = bestReplacePath(decision);
  if (path) {
    const method: FundingMethod = path.path === 'replace_loan' ? 'loan' : path.path === 'replace_lease' ? 'lease' : 'cash';
    return {
      method,
      upfrontCash: r2(path.upfrontCash),
      monthlyPayment: r2(path.monthlyPayment),
      termMonths: path.termMonths,
      apr: path.apr,
      energySavingPerYear: r2(path.energySavingPerYear),
      note: method === 'cash' ? 'Cash is the cheapest feasible path for this customer.' : `${path.label}: lowest expected total cost among feasible paths.`,
    };
  }
  // No finance decision (home-age estimate or no feasible path): plan a loan only if cash cannot absorb it.
  const cash = econ.cashAvailable;
  const needsFinancing = cash !== null && cost > cash;
  const apr = PLANNING_APR[econ.creditBand].loan;
  if (needsFinancing && apr !== null) {
    const term = cost > 8000 ? 120 : cost > 3000 ? 84 : 60;
    return { method: 'loan', upfrontCash: 0, monthlyPayment: r2(monthlyPayment(cost, apr, term)), termMonths: term, apr, energySavingPerYear: 0, note: 'Estimated loan at a planning rate — a real lender offer will differ.' };
  }
  return { method: 'cash', upfrontCash: r2(cost), monthlyPayment: 0, termMonths: null, apr: null, energySavingPerYear: 0, note: warrantyCovered ? 'Existing warranty does not cover a planned replacement.' : 'Plan to fund from reserves.' };
}

const cashFunding = (cost: number, note: string): FundingPlan => ({ method: 'cash', upfrontCash: r2(cost), monthlyPayment: 0, termMonths: null, apr: null, energySavingPerYear: 0, note });

function bandCosts(mid: number, kind: keyof typeof COST_BAND) {
  const [lo, hi] = COST_BAND[kind];
  return { costLow: r2(mid * lo), costMid: r2(mid), costHigh: r2(mid * hi) };
}

function driverLines(u: CapUnit, energy: EnergySignal): string[] {
  const lines: string[] = [];
  lines.push(`${u.ageAssumed ? 'Assumed ' : ''}${u.age.toFixed(1)} of ${u.life} expected years${u.basis === 'home_age' ? ' (estimated from home age)' : ''}.`);
  if (u.visits > 0) lines.push(`${u.visits} repair visit${u.visits === 1 ? '' : 's'} in the last 24 months.`);
  if (u.f.service > 1) lines.push(u.overdueMonths === null ? 'No service record on file.' : `Service overdue by about ${Math.max(1, Math.round(u.overdueMonths))} months.`);
  const top = [...u.alerts].sort((a, b) => SEVERITY[b.risk_level] - SEVERITY[a.risk_level])[0];
  if (top) lines.push(`Open alert: ${top.predicted_issue}`);
  if (u.f.energy > 1) lines.push(energy.summary);
  return lines;
}

// ------------------------------------------------------------------- the engine

export function computeHomeCapitalUnderwriting(input: UnderwritingInput, options: UnderwritingOptions = {}): HomeCapitalUnderwriting | null {
  const now = options.now ?? Date.now();
  const { twin } = input;
  const yearBuilt = input.yearBuilt != null && isValidYearBuilt(input.yearBuilt, now) ? input.yearBuilt : null;
  const econ = normalizeEconomics(input.economics);
  const tolerance = clamp(Number.isFinite(options.riskTolerance as number) ? (options.riskTolerance as number) : DEFAULT_RISK_TOLERANCE, MIN_RISK_TOLERANCE, MAX_RISK_TOLERANCE);
  const annualReserve = options.annualReserve != null && Number.isFinite(options.annualReserve) && options.annualReserve >= 0 ? options.annualReserve : null;

  const graph = computeHomeIntelligenceGraph(twin, { now, yearBuilt, energyReadings: input.energyReadings, costs: options.costs });
  if (!graph) return null;
  const plan = computeLifetimeServicePlan(twin, yearBuilt, { now, costs: options.costs });
  const finance = computeServiceFinancePlan(twin, econ, { now, costs: options.costs });
  const energy = analyzeEnergy(input.energyReadings ?? [], now);
  const costFor = (k: HealthCategoryKey): CostProfile => ({ ...DEFAULT_COSTS[k], ...options.costs?.[k] });
  const units = buildUnits(twin, yearBuilt, energy, costFor, now);
  if (units.length === 0) return null;

  const climate = climateForState(twin.site?.state);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const decisionByEquipment = new Map(finance.units.map((d) => [d.equipmentId, d]));
  const claimsByEquipment = new Map<string, Array<Pick<WarrantyClaimLite, 'status' | 'credit_received_cents'>>>();
  for (const c of input.warrantyClaims ?? []) {
    if (!c.equipment_id) continue;
    const list = claimsByEquipment.get(c.equipment_id) ?? [];
    list.push(c);
    claimsByEquipment.set(c.equipment_id, list);
  }
  const OPEN_CLAIM = new Set(['eligible', 'packet_pending', 'submitted']);
  const disruption = DISRUPTION_COST[econ.segment];

  const items: CapitalItem[] = [];
  const replaceSchedule: Array<{ unit: CapUnit; item: CapitalItem; tYears: number; nextCycleYears: number | null }> = [];
  const riskAfterByUnit = new Map<string, number>();

  for (const u of units) {
    const p12 = prob(u, u.f, 1);
    const eCost = eventCost(u, now);
    const node = nodeById.get(u.id);
    const decision = u.equipmentId ? decisionByEquipment.get(u.equipmentId) : undefined;
    const confidence: GraphConfidence = node?.confidence ?? (u.basis === 'home_age' ? 'low' : u.ageAssumed ? 'medium' : 'high');
    const claims = u.equipmentId ? claimsByEquipment.get(u.equipmentId) ?? [] : [];
    const openClaim = claims.some((c) => OPEN_CLAIM.has(c.status));
    const warrantyNow = warrantyActive(u, now);
    const failureSignal = u.alerts.length > 0 || u.visits > 0;
    const warranty: WarrantyStatus = { active: warrantyNow, expiresAt: u.warrantyExpiresAt, claimEligible: warrantyNow && failureSignal && !openClaim, openClaim };
    const actionable = u.basis === 'equipment';
    const drivers = driverLines(u, energy);
    let riskAfter = p12;

    // ---------------------------------------------------------------- replace
    const plannedCost = u.costs.replacement;
    const failureCost = plannedCost * (1 + EMERGENCY_PREMIUM) + disruption;
    const steady = steadyStatePolicy(u.life, u.shape, u.f.env, plannedCost, failureCost);
    const policy = replacementPolicy(u.age, u.life, u.shape, product(u.f), plannedCost, failureCost, steady.rate, tolerance);
    const toleranceBound = policy.toleranceYears;
    const optimal = policy.economicYears === null ? toleranceBound : Math.min(policy.economicYears, toleranceBound);
    const inspectionOnly = u.basis === 'home_age' && SYSTEM_MODEL[u.key].kind === 'inspection';
    if (!inspectionOnly && optimal <= CAPITAL_HORIZON_YEARS) {
      const basis: TimingBasis = optimal <= 0.25 ? 'due_now' : toleranceBound < (policy.economicYears ?? Infinity) ? 'risk_tolerance' : 'economic';
      const rawMonths = Math.round(optimal * 12);
      const snap = basis === 'due_now' || p12 >= 0.4 ? { months: rawMonths, seasonal: false } : snapToSeason(rawMonths, Math.floor(toleranceBound * 12), u.key, climate, now);
      const note =
        basis === 'due_now'
          ? 'Failure risk is high enough that waiting costs more than replacing — plan the replacement now.'
          : basis === 'risk_tolerance'
            ? `The chance this unit wears out reaches your ${Math.round(tolerance * 100)}% tolerance around this date, ahead of the economic optimum.`
            : 'Lowest long-run cost per year: replacing on a plan avoids the emergency premium and downtime of a failure.';
      const timing = timingFor(snap.months, now, 3, 3, basis, snap.seasonal ? `${note} Moved into a better-priced season.` : note, snap.seasonal);
      const cost = bandCosts(plannedCost, 'replace');
      const newRisk = failureProbability(0, u.life, u.shape, u.f.env, 1);
      const newEvent = u.costs.repair;
      const avoided = Math.max(0, p12 * eCost - newRisk * newEvent);
      const saving = policy.savingAt(snap.months / 12);
      const funding = fundingForReplacement(plannedCost, decision, econ, warrantyNow);
      const urgency = urgencyOf(p12, snap.months, u.key);
      const nextCycleYears = steady.years === null ? null : steady.years;
      const item: CapitalItem = {
        key: `${u.id}:replace`,
        unitId: u.id,
        equipmentId: u.equipmentId,
        categoryKey: u.key,
        categoryLabel: CATEGORY_LABELS[u.key],
        label: u.label,
        action: 'replace',
        title: actionable ? `Replace ${u.label}` : `Reserve for ${CATEGORY_LABELS[u.key].toLowerCase()} replacement (unverified)`,
        rationale: actionable
          ? `${u.age.toFixed(1)}-year-old ${u.label} against a ${u.life}-year expected life. ${note}`
          : `No ${CATEGORY_LABELS[u.key].toLowerCase()} on record — estimated from the home's age. Verify the unit before quoting.`,
        urgency: urgency.level,
        urgencyScore: urgency.score,
        ...cost,
        outOfPocketMid: r2(plannedCost),
        risk12mBefore: r4(p12),
        risk12mAfter: r4(newRisk),
        riskReduction: r4(Math.max(0, p12 - newRisk)),
        expectedLossAvoided: r2(avoided),
        netBenefit: r2(saving),
        netBenefitNote: 'Expected saving vs. replacing only when it fails (emergency premium, downtime, lost life). Negative = the price of staying inside your risk tolerance.',
        timing,
        funding,
        basis: u.basis,
        confidence,
        actionable,
        warranty,
        connect: {
          serviceType: `${CATEGORY_LABELS[u.key]} replacement`,
          quoteLine: { description: `${CATEGORY_LABELS[u.key]} replacement — ${u.label}`, quantity: 1, unit_price_cents: Math.round(plannedCost * 100) },
          marketplace: 'parts',
          financeEligible: plannedCost >= 200,
          rebateEligible: u.key === 'hvac' || u.key === 'water_heater',
        },
        drivers,
      };
      items.push(item);
      replaceSchedule.push({ unit: u, item, tYears: snap.months / 12, nextCycleYears });
      if (snap.months <= 12) riskAfter = Math.min(riskAfter, newRisk);
    }
    const replacingSoon = replaceSchedule.some((r) => r.unit.id === u.id && r.item.timing.targetMonths <= 3);

    // ----------------------------------------------------------------- repair
    if (actionable && !replacingSoon && (u.alerts.some((a) => a.risk_level !== 'low') || u.visits >= 2)) {
      const top = [...u.alerts].sort((a, b) => SEVERITY[b.risk_level] - SEVERITY[a.risk_level])[0];
      const fixed = top ? prob(u, { ...u.f, alert: 1 }, 1) : prob(u, { ...u.f, history: 1 }, 1);
      const reduction = Math.max(0, p12 - fixed) * (top ? 1 : 0.5);
      const mid = u.costs.repair;
      const cover = warrantyNow ? WARRANTY_COVERAGE : 0;
      const months = top?.risk_level === 'high' ? 0 : 3;
      const urgency = urgencyOf(p12, months, u.key);
      const avoided = Math.max(0, reduction * eCost);
      const outOfPocket = mid * (1 - cover);
      items.push({
        key: `${u.id}:repair`,
        unitId: u.id,
        equipmentId: u.equipmentId,
        categoryKey: u.key,
        categoryLabel: CATEGORY_LABELS[u.key],
        label: u.label,
        action: 'repair',
        title: top ? `Repair: ${top.predicted_issue.slice(0, 80)}` : `Diagnose recurring failures — ${u.label}`,
        rationale: top
          ? top.recommended_action ?? 'A predictive alert is open on this unit; resolve it before it becomes a failure.'
          : `${u.visits} repair visits in 24 months is a recurring-failure pattern. Find the root cause before paying for a fourth visit.`,
        urgency: urgency.level,
        urgencyScore: urgency.score,
        ...bandCosts(mid, 'repair'),
        outOfPocketMid: r2(outOfPocket),
        risk12mBefore: r4(p12),
        risk12mAfter: r4(p12 - reduction),
        riskReduction: r4(reduction),
        expectedLossAvoided: r2(avoided),
        netBenefit: r2(avoided - outOfPocket),
        netBenefitNote: 'Expected failure cost avoided over 12 months, minus the repair price.',
        timing: timingFor(months, now, 0, 6, 'schedule', months === 0 ? 'High-severity alert — schedule immediately.' : 'Schedule within the next quarter.'),
        funding: warrantyNow ? { ...cashFunding(outOfPocket, 'Active manufacturer warranty covers part of the repair cost.'), method: 'warranty' } : cashFunding(outOfPocket, 'Typical repair — pay from operating cash.'),
        basis: u.basis,
        confidence,
        actionable,
        warranty,
        connect: {
          serviceType: `${CATEGORY_LABELS[u.key]} repair`,
          quoteLine: { description: `${CATEGORY_LABELS[u.key]} repair — ${u.label}`, quantity: 1, unit_price_cents: Math.round(mid * 100) },
          marketplace: 'parts',
          financeEligible: mid >= 200,
          rebateEligible: false,
        },
        drivers,
      });
      riskAfter = Math.min(riskAfter, fixed);
    }

    // --------------------------------------------------------------- maintain
    if (actionable && !replacingSoon && u.f.service > 1) {
      const after = prob(u, { ...u.f, service: 1 }, 1);
      const reduction = Math.max(0, p12 - after);
      const avoided = reduction * eCost;
      const mid = u.costs.maintenance;
      const net = avoided - mid;
      if (net >= MIN_NET_BENEFIT || u.key === 'safety') {
        const membership = decision?.recommended.path === 'repair_membership';
        const fee = Math.round(mid * 1.1);
        const months = u.overdueMonths === null ? 2 : 1;
        const urgency = urgencyOf(p12, months, u.key);
        items.push({
          key: `${u.id}:maintain`,
          unitId: u.id,
          equipmentId: u.equipmentId,
          categoryKey: u.key,
          categoryLabel: CATEGORY_LABELS[u.key],
          label: u.label,
          action: 'maintain',
          title: u.overdueMonths === null ? `Baseline service — ${u.label}` : `Overdue service — ${u.label}`,
          rationale: u.overdueMonths === null ? 'No service record on file: a first visit establishes condition and starts the record.' : 'Deferred maintenance adds wear risk. Bringing service back on schedule removes it.',
          urgency: urgency.level,
          urgencyScore: urgency.score,
          ...bandCosts(mid, 'maintain'),
          outOfPocketMid: r2(mid),
          risk12mBefore: r4(p12),
          risk12mAfter: r4(after),
          riskReduction: r4(reduction),
          expectedLossAvoided: r2(avoided),
          netBenefit: r2(net),
          netBenefitNote: 'Expected failure cost avoided over 12 months, minus the service price.',
          timing: timingFor(months, now, 0, 3, 'schedule', 'Book the next available visit.'),
          funding: membership
            ? { ...cashFunding(fee, 'A maintenance membership beats pay-per-visit for this unit.'), method: 'membership' }
            : cashFunding(mid, 'Routine service — operating cash.'),
          basis: u.basis,
          confidence,
          actionable,
          warranty,
          connect: {
            serviceType: `${CATEGORY_LABELS[u.key]} maintenance`,
            quoteLine: { description: `${CATEGORY_LABELS[u.key]} service — ${u.label}`, quantity: 1, unit_price_cents: Math.round(mid * 100) },
            marketplace: null,
            financeEligible: false,
            rebateEligible: false,
          },
          drivers,
        });
        riskAfter = Math.min(riskAfter, after);
      }
    }
    riskAfterByUnit.set(u.id, riskAfter);
  }

  // ------------------------------------------------------ inspections (system level)
  if (plan) {
    for (const s of plan.systems) {
      const due = s.inspectionInMonths;
      if (due === null || due > 24) continue;
      const lead = nodeById.get(`sys:${s.categoryKey}`);
      const p12 = lead?.risk12m ?? 0;
      const mid = costFor(s.categoryKey).maintenance;
      const reduction = p12 * INSPECTION_DETECTION;
      const urgency = urgencyOf(p12, due, s.categoryKey);
      items.push({
        key: `sys:${s.categoryKey}:inspect`,
        unitId: `sys:${s.categoryKey}`,
        equipmentId: null,
        categoryKey: s.categoryKey,
        categoryLabel: s.label,
        label: s.label,
        action: 'inspect',
        title: `${s.label} inspection`,
        rationale: `${s.headline}. ${s.rationale}`,
        urgency: urgency.level,
        urgencyScore: urgency.score,
        ...bandCosts(mid, 'inspect'),
        outOfPocketMid: r2(mid),
        risk12mBefore: r4(p12),
        risk12mAfter: r4(p12 - reduction),
        riskReduction: r4(reduction),
        expectedLossAvoided: r2(reduction * costFor(s.categoryKey).repair),
        netBenefit: r2(reduction * costFor(s.categoryKey).repair - mid),
        netBenefitNote: `Assumes an inspection removes ${Math.round(INSPECTION_DETECTION * 100)}% of the 12-month risk by finding issues early.`,
        timing: timingFor(due, now, 0, 3, 'schedule', due === 0 ? 'Due now.' : `Recommended every ${s.inspectionIntervalMonths ?? 12} months for a property of this age.`),
        funding: cashFunding(mid, 'Routine inspection — operating cash.'),
        basis: s.basis,
        confidence: s.basis === 'equipment' ? 'medium' : 'low',
        actionable: true,
        warranty: { active: false, expiresAt: null, claimEligible: false, openClaim: false },
        connect: {
          serviceType: `${s.label} inspection`,
          quoteLine: { description: `${s.label} inspection`, quantity: 1, unit_price_cents: Math.round(mid * 100) },
          marketplace: null,
          financeEligible: false,
          rebateEligible: false,
        },
        drivers: [s.rationale],
      });
    }
  }
  // Home-age estimates for replaceable systems: verify before spending.
  for (const u of units) {
    if (u.basis !== 'home_age' || SYSTEM_MODEL[u.key].kind !== 'replacement') continue;
    const p12 = prob(u, u.f, 1);
    if (prob(u, u.f, 5) < 0.2) continue;
    const mid = u.costs.maintenance;
    const urgency = urgencyOf(p12, 3, u.key);
    items.push({
      key: `${u.id}:inspect`,
      unitId: u.id,
      equipmentId: null,
      categoryKey: u.key,
      categoryLabel: CATEGORY_LABELS[u.key],
      label: u.label,
      action: 'inspect',
      title: `Verify ${CATEGORY_LABELS[u.key].toLowerCase()} condition and add it to the Home Passport`,
      rationale: `Nothing on record, but a ${homeAgeFromYearBuilt(yearBuilt, now) ?? '?'}-year-old home implies this system is nearing the end of its life. A baseline inspection turns an estimate into evidence.`,
      urgency: urgency.level,
      urgencyScore: urgency.score,
      ...bandCosts(mid, 'inspect'),
      outOfPocketMid: r2(mid),
      risk12mBefore: r4(p12),
      risk12mAfter: r4(p12),
      riskReduction: 0,
      expectedLossAvoided: 0,
      netBenefit: 0,
      netBenefitNote: 'Value is information: it replaces an estimate with a measured age, making the plan and the score more accurate.',
      timing: timingFor(3, now, 0, 3, 'schedule', 'Schedule within the next quarter.'),
      funding: cashFunding(mid, 'Routine inspection — operating cash.'),
      basis: 'home_age',
      confidence: 'low',
      actionable: true,
      warranty: { active: false, expiresAt: null, claimEligible: false, openClaim: false },
      connect: {
        serviceType: `${CATEGORY_LABELS[u.key]} inspection`,
        quoteLine: { description: `${CATEGORY_LABELS[u.key]} baseline inspection`, quantity: 1, unit_price_cents: Math.round(mid * 100) },
        marketplace: null,
        financeEligible: false,
        rebateEligible: false,
      },
      drivers: driverLines(u, energy),
    });
  }

  // ---------------------------------------------------------------- protection
  const lossByUnit = units.map((u) => ({ u, loss5y: prob(u, u.f, 5) * eventCost(u, now) }));
  const total5y = sum(lossByUnit.map((x) => x.loss5y));
  const coveredLoss5y = sum(lossByUnit.filter((x) => warrantyActive(x.u, now + 3 * MS_PER_YEAR)).map((x) => x.loss5y));
  const uncovered5y = Math.max(0, total5y - coveredLoss5y);
  const exposed = units.filter((u) => prob(u, u.f, 5) >= 0.25 && !warrantyActive(u, now + 3 * MS_PER_YEAR));
  const largestShock = exposed.length ? Math.max(...exposed.map((u) => u.costs.replacement * (1 + EMERGENCY_PREMIUM) + disruption)) : 0;
  const shockCapacity = econ.cashAvailable ?? DEFAULT_SHOCK_CAPACITY[econ.segment];
  const premium = (uncovered5y / 5) * (1 + PROTECTION_LOADING);
  const protectionRecommended = uncovered5y >= PROTECTION_MIN_LOSS_5Y && largestShock > shockCapacity;
  const protection: ProtectionAssessment = {
    recommended: protectionRecommended,
    uncoveredExpectedLoss5y: r2(uncovered5y),
    largestShock: r2(largestShock),
    shockCapacity: r2(shockCapacity),
    indicativeAnnualPremium: r2(premium),
    coveredLoss5y: r2(coveredLoss5y),
    reason: protectionRecommended
      ? `One unplanned failure (about ${Math.round(largestShock).toLocaleString('en-US')} dollars) could exceed the cash available to absorb it, and ${Math.round(uncovered5y).toLocaleString('en-US')} dollars of expected 5-year loss is not under warranty.`
      : uncovered5y < PROTECTION_MIN_LOSS_5Y
        ? 'Expected uncovered loss is small — protection would cost more than the risk it removes.'
        : 'The largest plausible failure fits within available cash, so self-insuring is reasonable.',
  };
  if (protectionRecommended) {
    const mid = premium;
    const urgency = urgencyOf(Math.min(1, largestShock / (shockCapacity * 2)) * 0.3, 12, null, 4);
    items.push({
      key: 'portfolio:insure',
      unitId: null,
      equipmentId: null,
      categoryKey: null,
      categoryLabel: 'Whole home',
      label: 'Major-systems protection',
      action: 'insure',
      title: 'Protect major systems against a large unplanned failure',
      rationale: protection.reason,
      urgency: urgency.level,
      urgencyScore: urgency.score,
      ...bandCosts(mid, 'insure'),
      outOfPocketMid: r2(mid),
      risk12mBefore: 0,
      risk12mAfter: 0,
      riskReduction: 0,
      expectedLossAvoided: r2(uncovered5y * PROTECTION_COVERAGE_SHARE),
      netBenefit: r2(uncovered5y * PROTECTION_COVERAGE_SHARE - premium * 5),
      netBenefitNote: 'Five-year expected claims paid vs. premiums. Usually negative: you are paying to cap a large loss, not to profit.',
      timing: timingFor(2, now, 0, 4, 'schedule', 'Put protection in place before the highest-risk system fails.'),
      funding: { ...cashFunding(mid, 'Indicative annual cost of a service membership or equipment-breakdown plan — not a quote.'), method: 'membership' },
      basis: 'portfolio',
      confidence: graph.confidence,
      actionable: true,
      warranty: { active: false, expiresAt: null, claimEligible: false, openClaim: false },
      connect: {
        serviceType: 'Service membership',
        quoteLine: { description: 'Major-systems service membership (annual)', quantity: 1, unit_price_cents: Math.round(mid * 100) },
        marketplace: null,
        financeEligible: false,
        rebateEligible: false,
      },
      drivers: [`Largest single failure ≈ ${Math.round(largestShock).toLocaleString('en-US')} dollars; available cash ≈ ${Math.round(shockCapacity).toLocaleString('en-US')} dollars.`],
    });
  }

  items.sort((a, b) => b.urgencyScore - a.urgencyScore || b.netBenefit - a.netBenefit || a.key.localeCompare(b.key));

  // --------------------------------------------------------------- 10-year plan
  const years: CapitalYear[] = Array.from({ length: CAPITAL_HORIZON_YEARS }, (_, i) => ({
    year: i + 1,
    calendarYear: new Date(now + (i + 0.5) * MS_PER_YEAR).getUTCFullYear(),
    replacements: 0, maintenance: plan ? plan.roadmap[i].maintenance : 0, inspections: plan ? plan.roadmap[i].inspections : 0,
    contingency: 0, total: 0, financedPrincipal: 0, debtService: 0, cashOut: 0, cumulativeCashOut: 0, itemKeys: [],
  }));
  const yearIndex = (tYears: number) => Math.min(CAPITAL_HORIZON_YEARS, Math.max(1, Math.ceil(tYears - 1e-9))) - 1;
  const debtMonthly = new Array<number>(CAPITAL_HORIZON_YEARS * 12).fill(0);
  const replacedAt = new Map<string, number[]>();

  for (const r of replaceSchedule) {
    const times = [r.tYears];
    if (r.nextCycleYears !== null) {
      for (let k = 1; k <= 3; k++) {
        const next = times[times.length - 1] + Math.max(1, r.nextCycleYears);
        if (next > CAPITAL_HORIZON_YEARS) break;
        times.push(next);
      }
    }
    replacedAt.set(r.unit.id, times);
    times.forEach((t, idx) => {
      const y = yearIndex(t);
      const cost = r.unit.costs.replacement;
      const financed = idx === 0 && (r.item.funding.method === 'loan' || r.item.funding.method === 'lease');
      years[y].replacements += cost;
      if (idx === 0) years[y].itemKeys.push(r.item.key);
      if (financed) {
        years[y].financedPrincipal += Math.max(0, cost - r.item.funding.upfrontCash);
        const start = Math.round(t * 12);
        const term = r.item.funding.termMonths ?? 0;
        for (let m = start; m < Math.min(start + term, debtMonthly.length); m++) debtMonthly[m] += r.item.funding.monthlyPayment;
      }
    });
  }

  for (let i = 0; i < CAPITAL_HORIZON_YEARS; i++) {
    const y = years[i];
    for (const it of items) if (it.action !== 'replace' && it.timing.targetMonths < (i + 1) * 12 && it.timing.targetMonths >= i * 12 && !y.itemKeys.includes(it.key)) y.itemKeys.push(it.key);
    // Expected unplanned repairs while each system is still in service.
    for (const u of units) {
      const times = replacedAt.get(u.id);
      const firstReplace = times ? times[0] : Infinity;
      const exposure = clamp(firstReplace - i, 0, 1);
      if (exposure > 0) {
        const covered = warrantyActive(u, now + (i + 0.5) * MS_PER_YEAR);
        y.contingency += prob(u, u.f, exposure, u.age + i) * u.costs.repair * (covered ? 1 - WARRANTY_COVERAGE : 1);
      } else if (firstReplace < Infinity) {
        const newAge = i - firstReplace;
        if (newAge >= NEW_UNIT_WARRANTY_YEARS) y.contingency += failureProbability(newAge, u.life, u.shape, u.f.env, 1) * u.costs.repair;
      }
    }
    y.debtService = sum(debtMonthly.slice(i * 12, i * 12 + 12));
  }
  let cumulative = 0;
  for (const y of years) {
    y.replacements = r2(y.replacements);
    y.maintenance = r2(y.maintenance);
    y.inspections = r2(y.inspections);
    y.contingency = r2(y.contingency);
    y.financedPrincipal = r2(y.financedPrincipal);
    y.debtService = r2(y.debtService);
    y.total = r2(y.replacements + y.maintenance + y.inspections + y.contingency);
    y.cashOut = r2(y.total - y.financedPrincipal + y.debtService);
    cumulative += y.cashOut;
    y.cumulativeCashOut = r2(cumulative);
  }

  const reserveMonthly = Math.ceil(Math.max(0, ...years.map((y) => y.cumulativeCashOut / (12 * y.year))));
  const fundingGap = annualReserve === null ? null : r2(Math.max(0, ...years.map((y) => y.cumulativeCashOut - annualReserve * y.year)));

  // ---------------------------------------------------------------------- score
  const risk12m = combine(units.map((u) => prob(u, u.f, 1)));
  const risk5y = combine(units.map((u) => prob(u, u.f, 5)));
  const riskAfter12m = combine(units.map((u) => riskAfterByUnit.get(u.id) ?? prob(u, u.f, 1)));
  const expectedLoss12m = sum(units.map((u) => prob(u, u.f, 1) * eventCost(u, now)));
  const replacementValue = sum(units.map((u) => u.costs.replacement));
  const capital5y = sum(years.slice(0, 5).map((y) => y.replacements + y.contingency));
  const equipmentUnits = units.filter((u) => u.basis === 'equipment');
  const overdueShare = equipmentUnits.length ? equipmentUnits.filter((u) => u.f.service > 1).length / equipmentUnits.length : 0;
  const uncoveredShare = total5y > 0 ? uncovered5y / total5y : 0;

  const parts: Array<Omit<ScoreComponent, 'contribution'>> = [
    { key: 'exposure', label: 'Failure exposure', weight: 0.35, value: Math.min(1, risk12m / 0.6) * 100, detail: `${Math.round(risk12m * 100)}% chance of at least one failure or serious issue in the next 12 months.` },
    { key: 'capital', label: 'Capital pressure', weight: 0.25, value: Math.min(1, capital5y / Math.max(1, replacementValue) / 0.7) * 100, detail: `${Math.round(capital5y).toLocaleString('en-US')} dollars of replacements and expected repairs fall due within 5 years against ${Math.round(replacementValue).toLocaleString('en-US')} dollars of system replacement value.` },
    { key: 'severity', label: 'Severity vs. capacity', weight: 0.15, value: Math.min(1, largestShock / (shockCapacity * 2)) * 100, detail: largestShock > 0 ? `Largest plausible failure ≈ ${Math.round(largestShock).toLocaleString('en-US')} dollars vs. ${Math.round(shockCapacity).toLocaleString('en-US')} dollars of capacity${econ.cashAvailable === null ? ' (assumed)' : ''}.` : 'No system with a meaningful chance of a large failure in 5 years.' },
    { key: 'documentation', label: 'Records & upkeep', weight: 0.15, value: 0.5 * (100 - graph.completenessPct) + 0.5 * overdueShare * 100, detail: `${graph.completenessPct}% of underwriting inputs connected; ${Math.round(overdueShare * 100)}% of documented units have overdue or missing service.` },
    { key: 'protection', label: 'Protection gap', weight: 0.1, value: uncoveredShare * 100, detail: `${Math.round(uncoveredShare * 100)}% of expected 5-year loss is not covered by an active warranty.` },
  ];
  const components: ScoreComponent[] = parts.map((p) => ({ ...p, value: Math.round(p.value), contribution: r2(p.weight * p.value) }));
  const riskIndex = Math.round(clamp(sum(components.map((c) => c.contribution)), 0, 100));
  const band = graph.confidence === 'high' ? 4 : graph.confidence === 'medium' ? 7 : 12;
  const grade: RiskGrade = riskIndex < 20 ? 'A' : riskIndex < 35 ? 'B' : riskIndex < 50 ? 'C' : riskIndex < 65 ? 'D' : 'E';

  const counts = { repair: 0, replace: 0, maintain: 0, inspect: 0, insure: 0, financed: 0, urgent: 0 };
  for (const it of items) {
    counts[it.action] += 1;
    if (it.funding.method === 'loan' || it.funding.method === 'lease') counts.financed += 1;
    if (it.urgency === 'critical' || it.urgency === 'high') counts.urgent += 1;
  }

  const assumptions: string[] = [
    ...graph.assumptions,
    `Replacement timing minimises long-run cost per year (planned vs. emergency cost, +${Math.round(EMERGENCY_PREMIUM * 100)}% premium and ${disruption.toLocaleString('en-US')} dollars of disruption), capped at the date the chance of wear-out failure reaches your ${Math.round(tolerance * 100)}% tolerance.`,
    'Cost ranges are planning bands around price-book defaults, not quotes. Future cycles of a replaced unit are assumed paid in cash.',
    `Protection is indicative: expected loss loaded by ${Math.round(PROTECTION_LOADING * 100)}%. It is not an insurance quote or a credit decision.`,
  ];
  if (econ.cashAvailable === null) assumptions.push(`Cash available is unknown — a ${DEFAULT_SHOCK_CAPACITY[econ.segment].toLocaleString('en-US')} dollar shock capacity is assumed.`);
  if (annualReserve === null) assumptions.push('No annual reserve provided, so no funding gap is reported — see the suggested monthly reserve.');

  return {
    engineVersion: UNDERWRITING_ENGINE_VERSION,
    yearBuilt,
    climate,
    riskTolerance: tolerance,
    summary: {
      riskIndex,
      riskIndexLow: Math.max(0, riskIndex - band),
      riskIndexHigh: Math.min(100, riskIndex + band),
      grade,
      tier: GRADE_TIERS[grade],
      components,
      risk12m: r4(risk12m),
      risk5y: r4(risk5y),
      riskAfter12m: r4(riskAfter12m),
      expectedLoss12m: r2(expectedLoss12m),
      expectedLoss5y: r2(total5y),
      capital: {
        next12m: years[0].total,
        years1to3: r2(sum(years.slice(0, 3).map((y) => y.total))),
        years1to5: r2(sum(years.slice(0, 5).map((y) => y.total))),
        tenYear: r2(sum(years.map((y) => y.total))),
        tenYearReplacements: r2(sum(years.map((y) => y.replacements))),
      },
      reserve: { suggestedMonthly: reserveMonthly, fundingGap, annualReserve },
      protection,
      counts,
    },
    items,
    years,
    energy,
    dataGaps: graph.signals.filter((s) => s.state !== 'connected'),
    completenessPct: graph.completenessPct,
    confidence: graph.confidence,
    assumptions,
  };
}
