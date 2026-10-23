import { CATEGORY_LABELS, classifyEquipment, type HealthCategoryKey } from '@/lib/homeHealthScore';
import { DEFAULT_COSTS } from '@/lib/homeBudget';
import { failureProbability, yearsToQuantile } from '@/lib/lifetimeServicePlan';
import { PLANNING_APR, monthlyPayment, type CreditBand } from '@/lib/serviceFinance';

/**
 * VIREEK Repair-vs-Replace Advisor: pure, deterministic decision engine.
 *
 * Question answered for ONE machine: "Should this customer pay for the repair on the table, or replace the unit?"
 *
 * Inputs combined:
 *   equipment age + warranty (Equipment Passport / equipment row)
 *   repair history (completed repair jobs + passport events from any contractor)
 *   predicted failure risk (Predictive Failure Network forecast, used to CALIBRATE the wear-out curve)
 *   efficiency of the old vs. the new unit (energy savings)
 *   available rebates (Rebate Intelligence report for the replacement option)
 *   customer economics (credit band, cash, monthly budget) -> financing options
 *
 * Output: a five-year cost comparison (nominal + present value, three scenarios), a repair/replace verdict with
 * plain-language reasons, financing options, confidence, and every assumption that was not measured.
 *
 * No I/O, no randomness, no clock reads (the caller passes `now`): the same input always yields the same advice.
 * Runtime imports are limited to other pure Vireek modules, so this file is safe to unit test.
 *
 * Honesty rules (enforced in the output, never hidden):
 *   - Every default that was not measured is listed in `assumptions`; missing facts are listed in `dataGaps`.
 *   - Rebates are weighted by the Rebate Intelligence confidence model; forced (emergency) replacements keep only half.
 *   - Financing APRs are PLANNING values unless a lender quote is supplied. Nothing here is a credit decision.
 *   - When the answer flips between scenarios the result says so (strength = 'toss_up' or robust = false).
 */

export const ADVISOR_ENGINE_VERSION = 'repair-replace-1.0.0';
export const ADVISOR_HORIZON_YEARS = 5;

// ---------------------------------------------------------------------- config

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const MS_PER_MONTH = 30.4375 * 24 * 60 * 60 * 1000;
const REPAIR_WINDOW_MS = 24 * MS_PER_MONTH;

/** Yearly random-failure floor for a new unit. Matches lifetimeServicePlan.ts. */
const NEW_UNIT_BASE_HAZARD = 0.02;
const MIN_MULTIPLIER = 0.5;
const MAX_MULTIPLIER = 4;
const UNKNOWN_AGE_RATIO = 0.6;
/** Share of a new unit's remaining life credited at the horizon (a buyer / the customer still gets that life). */
const RESIDUAL_RECOGNITION = 0.7;
/** Unplanned replacement costs more: rush parts, no time to shop, no financing choice. */
const EMERGENCY_PREMIUM = 0.12;
/** A forced replacement cannot be pre-approved, so only this share of expected rebates is kept. */
const EMERGENCY_REBATE_RETENTION = 0.5;
/** Manufacturer warranties are typically parts-only: share of a repair covered. */
const WARRANTY_COVERAGE = 0.5;
/** Share of modelled energy savings that is realistically captured. */
const ENERGY_REALIZATION = 0.8;
const REPAIR_COST_INFLATION = 0.03;
/** Keep in sync with MIN_FINANCING_AMOUNT_CENTS in financing.ts (kept local so this module stays pure). */
const MIN_FINANCED_CENTS = 20_000;
const SAFETY_DISRUPTION_FACTOR = 3;

const DISCOUNT_RATE = { residential: 0.07, commercial: 0.12 } as const;
const DISRUPTION_CENTS = { residential: 25_000, commercial: 120_000 } as const;
const DEFAULT_ENERGY_CENTS = { residential: 240_000, commercial: 900_000 } as const;

interface CategoryModel {
  life: number;
  shape: number;
  /** Share of a property's annual energy bill this system drives. */
  energyShare: number;
  maxLoanMonths: number;
  leasable: boolean;
}

/** Same Weibull wear-out family as lifetimeServicePlan.ts / serviceFinance.ts. */
const MODELS: Readonly<Partial<Record<HealthCategoryKey, CategoryModel>>> = {
  hvac: { life: 15, shape: 4, energyShare: 0.45, maxLoanMonths: 120, leasable: true },
  water_heater: { life: 11, shape: 4, energyShare: 0.14, maxLoanMonths: 60, leasable: true },
};
const GENERIC_MODEL: CategoryModel = { life: 15, shape: 4, energyShare: 0, maxLoanMonths: 60, leasable: false };

/** Scenario weights on the hazard of the existing unit, rebate outcome and realised energy savings. */
const SCENARIOS = [
  { key: 'repair_friendly', label: 'Repairs hold up well', weight: 0.25, hazard: 0.75, rebate: 'conservative', energy: 0.7 },
  { key: 'expected', label: 'Expected', weight: 0.5, hazard: 1, rebate: 'expected', energy: 1 },
  { key: 'replace_friendly', label: 'Repairs keep coming', weight: 0.25, hazard: 1.4, rebate: 'best', energy: 1.15 },
] as const;
type Scenario = (typeof SCENARIOS)[number];

// ---------------------------------------------------------------------- types

export type AdvisorVerdict = 'repair' | 'replace';
export type VerdictStrength = 'clear' | 'lean' | 'toss_up';
export type AdvisorConfidence = 'high' | 'medium' | 'low';
export type ReasonTone = 'replace' | 'repair' | 'neutral';
export type CostLineKey =
  | 'repair_now'
  | 'replacement'
  | 'future_repairs'
  | 'forced_replacement'
  | 'disruption'
  | 'rebates'
  | 'energy_savings';

export const COST_LINE_LABELS: Record<CostLineKey, string> = {
  repair_now: 'Repair today',
  replacement: 'New equipment, installed',
  future_repairs: 'Expected future repairs',
  forced_replacement: 'Expected emergency replacement',
  disruption: 'Cost of breakdowns (no heat / cooling / hot water)',
  rebates: 'Rebates and tax credits',
  energy_savings: 'Energy savings',
};

export interface EfficiencyRatings {
  seer2?: number | null;
  hspf2?: number | null;
  afue?: number | null;
  uef?: number | null;
}

export interface RepairEvent {
  date: string | null;
  /** What the customer paid. null = a repair is on record but the cost is unknown. */
  costCents: number | null;
  source: 'job' | 'passport';
}

/** Predictive Failure Network forecast, reduced to what the advisor needs. */
export interface ForecastSignal {
  /** Probability of failure within `horizonDays`, 0-1. */
  probability: number;
  horizonDays: number;
  confidence: 'high' | 'moderate' | 'low';
  calibrated: boolean;
  band: 'critical' | 'high' | 'elevated' | 'low';
  topModeLabel: string | null;
  safetyCriticalModes: string[];
  issuedAt: string | null;
}

export interface RebateProgramLine {
  name: string;
  amountCents: number;
  expectedCents: number;
  status: 'eligible' | 'likely' | 'needs_info';
  timing: 'point_of_sale' | 'post_install' | 'tax_filing';
  endDate: string | null;
  requiresPreApproval: boolean;
}

/** Rebate Intelligence result for the replacement option, reduced to what the advisor needs. */
export interface RebateSummary {
  /** Expected (confidence-weighted) amounts by payout timing. */
  atInstallCents: number;
  afterInstallCents: number;
  taxFilingCents: number;
  expectedCents: number;
  /** Confirmed-eligible programs only. */
  conservativeCents: number;
  /** Everything that could apply, including programs that still need information. */
  bestCaseCents: number;
  programs: RebateProgramLine[];
  deadlines: { program: string; daysLeft: number; endDate: string }[];
  warnings: string[];
  actions: string[];
}

export interface AdvisorInput {
  now: number;
  unit: {
    id: string;
    label: string;
    equipmentType: string;
    make?: string | null;
    model?: string | null;
    installDate: string | null;
    expectedLifespanYears: number | null;
    warrantyExpiresAt: string | null;
    lastServiceDate: string | null;
    serviceIntervalMonths: number | null;
    /** Current ratings of the OLD unit (nameplate). */
    efficiency: EfficiencyRatings | null;
    /** The unit is not working right now. */
    isDown?: boolean;
  };
  history: RepairEvent[];
  forecast: ForecastSignal | null;
  repair: { quoteCents: number | null; description?: string };
  replacement: {
    label: string;
    installedCostCents: number;
    efficiency?: EfficiencyRatings | null;
    expectedLifeYears?: number | null;
    /** Entered by the contractor for this option; overrides the efficiency-based estimate. */
    annualEnergySavingsCents?: number | null;
  };
  rebates: RebateSummary | null;
  energy?: { annualSystemCostCents?: number | null };
  customer?: {
    segment?: 'residential' | 'commercial';
    creditBand?: CreditBand;
    cashAvailableCents?: number | null;
    monthlyBudgetCents?: number | null;
    /** Annual rate at which the customer discounts future money. */
    discountRate?: number | null;
  };
  /** A real lender offer (e.g. a Wisetack quote). Always shown instead of planning estimates when present. */
  lender?: { aprBps: number; termMonths: number; label?: string } | null;
}

export interface CostLine {
  key: CostLineKey;
  label: string;
  nominalCents: number;
  presentValueCents: number;
}

export interface PathCost {
  path: AdvisorVerdict;
  label: string;
  /** Cash due now. */
  upfrontCents: number;
  /** Nominal five-year spend after rebates and energy savings, before crediting remaining equipment life. */
  outOfPocketCents: number;
  /** Value of equipment life still left at the horizon (shown as a credit). */
  residualCreditCents: number;
  /** outOfPocket minus residual credit. */
  netCostCents: number;
  /** Present value of netCost: what the decision is based on. */
  presentValueCents: number;
  lines: CostLine[];
  /** Cumulative nominal out-of-pocket at the end of years 1..5. */
  cumulativeByYear: number[];
}

export interface ScenarioOutcome {
  key: Scenario['key'];
  label: string;
  weight: number;
  repairPvCents: number;
  replacePvCents: number;
  winner: AdvisorVerdict;
}

export interface RuleCheck {
  id: 'half_cost' | 'late_life' | 'age_cost' | 'repeat_repairs' | 'safety';
  label: string;
  triggered: boolean;
  detail: string;
}

export interface Reason {
  id: string;
  tone: ReasonTone;
  text: string;
}

export interface FinancingOption {
  id: string;
  kind: 'cash' | 'loan' | 'lease_to_own';
  label: string;
  termMonths: number | null;
  aprBps: number | null;
  aprSource: 'planning_estimate' | 'lender_quote' | null;
  feasible: boolean;
  reason: string | null;
  financedCents: number;
  monthlyCents: number | null;
  totalPaidCents: number;
  interestCents: number;
  interestWithinHorizonCents: number;
  balanceAtHorizonCents: number;
  /** Monthly payment if post-install rebates are applied to the loan when they arrive. */
  monthlyAfterRebatePaydownCents: number | null;
  /** Payment minus the energy the new unit saves each month (can be negative: it pays for itself). */
  monthlyNetOfEnergySavingsCents: number | null;
  fitsBudget: boolean | null;
  recommended: boolean;
}

export interface UnitSummary {
  id: string;
  label: string;
  category: HealthCategoryKey | null;
  categoryLabel: string;
  ageYears: number;
  ageKnown: boolean;
  lifespanYears: number;
  lifeUsedPct: number;
  warrantyActive: boolean;
  recentRepairs: number;
  recentRepairSpendCents: number;
  isDown: boolean;
}

export interface RiskSummary {
  risk12m: number;
  risk5y: number;
  /** Median time until the old unit's next failure, in months (0 = already due). */
  medianMonthsToNextFailure: number;
  hazardMultiplier: number;
  forecastWeight: number;
}

export interface AdvisorResult {
  engineVersion: string;
  generatedAt: string;
  horizonYears: number;
  unit: UnitSummary;
  risk: RiskSummary;
  repair: PathCost;
  replace: PathCost;
  scenarios: ScenarioOutcome[];
  verdict: AdvisorVerdict;
  strength: VerdictStrength;
  /** The verdict holds in every scenario. */
  robust: boolean;
  /** keep-and-repair net cost minus replace net cost, nominal. Positive = replacing is cheaper over five years. */
  netAdvantageOfReplacingCents: number;
  /** Same, in present value: this is what the verdict is based on. */
  pvAdvantageOfReplacingCents: number;
  /** PV gap below which the call is a toss-up. */
  tossUpThresholdCents: number;
  annualEnergySavingsCents: number;
  rules: RuleCheck[];
  reasons: Reason[];
  rebates: RebateSummary | null;
  financing: FinancingOption[];
  confidence: AdvisorConfidence;
  confidenceScore: number;
  assumptions: string[];
  dataGaps: string[];
  nextSteps: string[];
}

export class AdvisorInputError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join(' '));
    this.name = 'AdvisorInputError';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------- small helpers

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export const usd = (cents: number): string => {
  const dollars = Math.round(Math.abs(cents) / 100);
  return `${cents < 0 ? '-' : ''}$${dollars.toLocaleString('en-US')}`;
};
const pct = (p: number) => `${Math.round(p * 100)}%`;

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00.000Z` : iso);
  return Number.isFinite(t) ? t : null;
}

export function validateAdvisorInput(input: AdvisorInput): string[] {
  const problems: string[] = [];
  if (!finite(input.now)) problems.push('A valid current time is required.');
  if (!finite(input.replacement?.installedCostCents) || input.replacement.installedCostCents <= 0) {
    problems.push('Enter the installed price of the replacement unit.');
  }
  const q = input.repair?.quoteCents;
  if (q !== null && q !== undefined && (!finite(q) || q < 0)) problems.push('The repair quote must be zero or more.');
  if (input.unit?.installDate && parseMs(input.unit.installDate) === null) problems.push('The install date is not a valid date.');
  return problems;
}

/** Amortised loan balance after `paid` payments. Works for APR 0. */
export function loanBalance(principal: number, apr: number, payment: number, paid: number): number {
  const r = apr / 12;
  if (r === 0) return Math.max(0, principal - payment * paid);
  const g = Math.pow(1 + r, paid);
  return Math.max(0, principal * g - (payment * (g - 1)) / r);
}

// ---------------------------------------------------------------------- failure model

/**
 * Solves for the hazard multiplier that makes the wear-out curve reproduce a forecast probability over `years`.
 * failureProbability is monotonic in the multiplier, so bisection is exact to well under 0.1% of probability.
 * `saturated: 'high'` means the forecast is riskier than the curve can express (the true multiplier is AT LEAST the maximum).
 */
export function calibrateMultiplier(
  age: number,
  life: number,
  shape: number,
  targetProbability: number,
  years: number,
): { multiplier: number; saturated: 'high' | 'low' | null } {
  const target = clamp(targetProbability, 0.001, 0.949);
  if (failureProbability(age, life, shape, MIN_MULTIPLIER, years) >= target) return { multiplier: MIN_MULTIPLIER, saturated: 'low' };
  if (failureProbability(age, life, shape, MAX_MULTIPLIER, years) <= target) return { multiplier: MAX_MULTIPLIER, saturated: 'high' };
  let lo = MIN_MULTIPLIER;
  let hi = MAX_MULTIPLIER;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (failureProbability(age, life, shape, mid, years) < target) lo = mid;
    else hi = mid;
  }
  return { multiplier: (lo + hi) / 2, saturated: null };
}

function historyFactor(repairs: number): number {
  if (repairs >= 3) return 1.6;
  if (repairs === 2) return 1.3;
  if (repairs === 1) return 1.1;
  return 1;
}

function maintenanceFactor(overdueMonths: number | null): number {
  if (overdueMonths === null) return 1.1;
  if (overdueMonths <= 0) return 1;
  return 1 + Math.min(0.6, 0.03 * overdueMonths);
}

function forecastWeight(f: ForecastSignal): number {
  const base = f.confidence === 'high' ? 0.65 : f.confidence === 'moderate' ? 0.5 : 0.3;
  return clamp(base + (f.calibrated ? 0.15 : 0), 0, 0.8);
}

/** Share of failures at this point of the unit's life that are not worth repairing (cost more than they are worth). */
function terminalShare(lifeRatio: number): number {
  return clamp((lifeRatio - 0.55) / 0.9, 0.05, 0.75);
}

// ---------------------------------------------------------------------- energy

/** Typical ratings of the old unit by install era. Used only when the nameplate ratings are unknown (and flagged). */
const ERA_DEFAULT: Record<keyof EfficiencyRatings, [number, number, number]> = {
  seer2: [9, 11.5, 14],
  hspf2: [6.5, 7.5, 8.5],
  afue: [78, 80, 90],
  uef: [0.58, 0.6, 0.64],
};
const METRICS = ['seer2', 'hspf2', 'afue', 'uef'] as const;

function eraDefault(metric: keyof EfficiencyRatings, installMs: number | null): number | null {
  if (installMs === null) return null;
  const year = new Date(installMs).getUTCFullYear();
  const [old, mid, recent] = ERA_DEFAULT[metric];
  return year <= 2005 ? old : year <= 2014 ? mid : recent;
}

/** Fraction of the system's energy use a replacement saves, from old vs. new ratings (higher rating = more efficient). */
export function energySavingFraction(
  oldRatings: EfficiencyRatings | null | undefined,
  newRatings: EfficiencyRatings | null | undefined,
  installMs: number | null,
): { fraction: number; assumedOld: boolean } | null {
  const fractions: number[] = [];
  let assumedOld = false;
  for (const m of METRICS) {
    const next = newRatings?.[m];
    if (!finite(next) || next <= 0) continue;
    let prev = oldRatings?.[m];
    if (!finite(prev) || prev <= 0) {
      prev = eraDefault(m, installMs);
      assumedOld = true;
    }
    if (prev === null || prev === undefined) continue;
    fractions.push(clamp(1 - prev / next, 0, 0.6));
  }
  if (fractions.length === 0) return null;
  return { fraction: sum(fractions) / fractions.length, assumedOld };
}

// ---------------------------------------------------------------------- ledger

class Ledger {
  private entries: { key: CostLineKey; t: number; cents: number }[] = [];
  residual = 0;
  add(key: CostLineKey, t: number, cents: number) {
    if (cents !== 0 && Number.isFinite(cents)) this.entries.push({ key, t, cents });
  }
  /** nominal and present value per line, plus cumulative nominal by year. */
  summarize(rate: number) {
    const byKey = new Map<CostLineKey, { nominal: number; pv: number }>();
    const cumulative = Array.from({ length: ADVISOR_HORIZON_YEARS }, () => 0);
    for (const e of this.entries) {
      const cur = byKey.get(e.key) ?? { nominal: 0, pv: 0 };
      cur.nominal += e.cents;
      cur.pv += e.cents / Math.pow(1 + rate, e.t);
      byKey.set(e.key, cur);
      const bucket = Math.min(ADVISOR_HORIZON_YEARS - 1, Math.max(0, Math.ceil(e.t - 1e-9) - 1));
      for (let y = bucket; y < ADVISOR_HORIZON_YEARS; y++) cumulative[y] += e.cents;
    }
    return { byKey, cumulative, residualPv: this.residual / Math.pow(1 + rate, ADVISOR_HORIZON_YEARS) };
  }
}

// ---------------------------------------------------------------------- context

interface Ctx {
  now: number;
  rate: number;
  segment: 'residential' | 'commercial';
  model: CategoryModel;
  category: HealthCategoryKey | null;
  age: number;
  life: number;
  multiplier: number;
  forecastWeight: number;
  forecastFloorEvents: number;
  warrantyEndYears: number | null;
  quoteCents: number;
  baseRepairCents: number;
  installedCents: number;
  newLife: number;
  disruptionCents: number;
  annualSavingCents: number;
  rebates: { at: number; after: number; tax: number; expected: number; conservative: number; best: number };
}

function scenarioRebates(c: Ctx['rebates'], kind: Scenario['rebate']) {
  const target = kind === 'conservative' ? c.conservative : kind === 'best' ? c.best : c.expected;
  if (c.expected > 0) {
    const k = target / c.expected;
    return { at: c.at * k, after: c.after * k, tax: c.tax * k };
  }
  return { at: 0, after: target, tax: 0 };
}

function evalScenario(c: Ctx, sc: Scenario) {
  const keep = new Ledger();
  const repl = new Ledger();
  const reb = scenarioRebates(c.rebates, sc.rebate);
  const rebateTotal = reb.at + reb.after + reb.tax;
  const saving = c.annualSavingCents * sc.energy;
  const newResidual = (yearsOfUse: number) => c.installedCents * Math.max(0, 1 - yearsOfUse / c.newLife) * RESIDUAL_RECOGNITION;

  // ---- Replace now
  repl.add('replacement', 0, c.installedCents);
  repl.add('rebates', 0, -reb.at);
  repl.add('rebates', 2 / 12, -reb.after);
  repl.add('rebates', 14 / 12, -reb.tax);
  for (let y = 0; y < ADVISOR_HORIZON_YEARS; y++) {
    repl.add('energy_savings', y + 0.5, -saving);
    // A new unit still fails now and then; its warranty covers part of that.
    repl.add('future_repairs', y + 0.5, NEW_UNIT_BASE_HAZARD * c.baseRepairCents * (1 - WARRANTY_COVERAGE));
  }
  repl.residual = -newResidual(ADVISOR_HORIZON_YEARS);

  // ---- Keep and repair
  keep.add('repair_now', 0, c.quoteCents);
  const multiplier = clamp(c.multiplier * sc.hazard, MIN_MULTIPLIER, MAX_MULTIPLIER);
  let survives = 1; // probability the old unit has not yet been forced into replacement
  let residual = 0;
  for (let y = 0; y < ADVISOR_HORIZON_YEARS; y++) {
    const t = y + 0.5;
    const p = failureProbability(c.age + y, c.life, c.model.shape, multiplier, 1);
    // Expected failures this year while the old unit is in service (year one is floored by the near-term forecast).
    const events = Math.max(-Math.log(1 - p), y === 0 ? c.forecastFloorEvents * sc.hazard : 0);
    const q = terminalShare((c.age + t) / c.life);
    const terminalRate = events * q;
    const repairRate = events * (1 - q);
    const survivesMid = survives * Math.exp(-terminalRate / 2);
    const pTerminal = survives * (1 - Math.exp(-terminalRate));
    const warrantied = c.warrantyEndYears !== null && c.warrantyEndYears > t;
    const repairCost = c.baseRepairCents * Math.pow(1 + REPAIR_COST_INFLATION, t) * (warrantied ? 1 - WARRANTY_COVERAGE : 1);

    keep.add('future_repairs', t, survivesMid * repairRate * repairCost);
    keep.add('disruption', t, (survivesMid * repairRate + pTerminal) * c.disruptionCents);
    keep.add('forced_replacement', t, pTerminal * c.installedCents * (1 + EMERGENCY_PREMIUM));
    keep.add('rebates', t, -pTerminal * rebateTotal * EMERGENCY_REBATE_RETENTION);
    keep.add('energy_savings', t + (ADVISOR_HORIZON_YEARS - t) / 2, -pTerminal * saving * (ADVISOR_HORIZON_YEARS - t));
    residual += pTerminal * newResidual(ADVISOR_HORIZON_YEARS - t);
    survives *= Math.exp(-terminalRate);
  }
  residual += survives * c.installedCents * Math.max(0, 1 - (c.age + ADVISOR_HORIZON_YEARS) / c.life) * RESIDUAL_RECOGNITION;
  keep.residual = -residual;

  return { keep, repl };
}

// ---------------------------------------------------------------------- financing

export function buildFinancingOptions(p: {
  installedCents: number;
  atInstallRebateCents: number;
  afterInstallRebateCents: number;
  annualSavingCents: number;
  creditBand: CreditBand;
  cashAvailableCents: number | null;
  monthlyBudgetCents: number | null;
  model: CategoryModel;
  lender: AdvisorInput['lender'];
}): FinancingOption[] {
  const financed = Math.max(0, Math.round(p.installedCents - p.atInstallRebateCents));
  const monthlySaving = p.annualSavingCents / 12;
  const out: FinancingOption[] = [];

  out.push({
    id: 'cash',
    kind: 'cash',
    label: 'Pay in full',
    termMonths: null,
    aprBps: null,
    aprSource: null,
    feasible: p.cashAvailableCents === null || p.cashAvailableCents >= financed,
    reason: p.cashAvailableCents !== null && p.cashAvailableCents < financed ? 'More than the cash available.' : null,
    financedCents: 0,
    monthlyCents: null,
    totalPaidCents: financed,
    interestCents: 0,
    interestWithinHorizonCents: 0,
    balanceAtHorizonCents: 0,
    monthlyAfterRebatePaydownCents: null,
    monthlyNetOfEnergySavingsCents: null,
    fitsBudget: null,
    recommended: false,
  });

  const make = (
    id: string,
    kind: 'loan' | 'lease_to_own',
    label: string,
    term: number,
    apr: number | null,
    source: 'planning_estimate' | 'lender_quote',
  ): FinancingOption => {
    let reason: string | null = null;
    if (financed < MIN_FINANCED_CENTS) reason = `Below the ${usd(MIN_FINANCED_CENTS)} minimum for financing.`;
    else if (apr === null) reason = 'Lenders typically decline loans at this credit band.';
    const feasible = reason === null && apr !== null;
    const rate = apr ?? 0;
    const monthly = feasible ? Math.round(monthlyPayment(financed, rate, term)) : null;
    const total = monthly === null ? 0 : monthly * term;
    const paidInHorizon = Math.min(term, ADVISOR_HORIZON_YEARS * 12);
    const balance = monthly === null ? 0 : Math.round(loanBalance(financed, rate, monthly, paidInHorizon));
    const afterPaydown = feasible
      ? Math.round(monthlyPayment(Math.max(0, financed - p.afterInstallRebateCents), rate, term))
      : null;
    return {
      id,
      kind,
      label,
      termMonths: term,
      aprBps: apr === null ? null : Math.round(apr * 10_000),
      aprSource: source,
      feasible,
      reason,
      financedCents: financed,
      monthlyCents: monthly,
      totalPaidCents: total,
      interestCents: monthly === null ? 0 : Math.max(0, total - financed),
      interestWithinHorizonCents: monthly === null ? 0 : Math.max(0, Math.round(monthly * paidInHorizon - (financed - balance))),
      balanceAtHorizonCents: balance,
      monthlyAfterRebatePaydownCents: afterPaydown,
      monthlyNetOfEnergySavingsCents: monthly === null ? null : Math.round(monthly - monthlySaving),
      fitsBudget: monthly === null || p.monthlyBudgetCents === null ? null : monthly <= p.monthlyBudgetCents,
      recommended: false,
    };
  };

  if (p.lender && finite(p.lender.aprBps) && finite(p.lender.termMonths) && p.lender.termMonths > 0) {
    out.push(
      make('lender', 'loan', p.lender.label ?? 'Lender offer', Math.round(p.lender.termMonths), Math.max(0, p.lender.aprBps) / 10_000, 'lender_quote'),
    );
  }
  const band = PLANNING_APR[p.creditBand];
  for (const term of [36, 60, 84, 120]) {
    if (term > p.model.maxLoanMonths) continue;
    out.push(make(`loan-${term}`, 'loan', `${term}-month loan`, term, band.loan, 'planning_estimate'));
  }
  if (p.model.leasable) {
    for (const term of [36, 60]) out.push(make(`lease-${term}`, 'lease_to_own', `${term}-month lease-to-own`, term, band.lease, 'planning_estimate'));
  }

  // Recommended: a real lender offer, else the shortest loan that fits the budget, else a term that suits the amount.
  const loans = out.filter((o) => o.kind === 'loan' && o.feasible);
  let pick: FinancingOption | undefined = loans.find((o) => o.id === 'lender');
  if (!pick && loans.length > 0) {
    const planning = loans.filter((o) => o.aprSource === 'planning_estimate');
    if (p.monthlyBudgetCents !== null) {
      pick = planning.find((o) => o.fitsBudget === true) ?? planning[planning.length - 1];
    } else {
      const want = financed < 500_000 ? 36 : financed < 1_200_000 ? 60 : 84;
      pick = planning.find((o) => (o.termMonths ?? 0) >= want) ?? planning[planning.length - 1];
    }
  }
  if (pick) pick.recommended = true;
  else if (out[0].feasible) out[0].recommended = true;
  return out;
}

// ---------------------------------------------------------------------- main

export function adviseRepairOrReplace(input: AdvisorInput): AdvisorResult {
  const problems = validateAdvisorInput(input);
  if (problems.length > 0) throw new AdvisorInputError(problems);

  const { unit } = input;
  const assumptions: string[] = [
    'Failure model: wear-out (Weibull) curve, the same one used by the Lifetime Service Plan, calibrated to the predictive-failure forecast when one exists.',
    'Costs are estimates for planning. A signed quote always overrides them.',
  ];
  const dataGaps: string[] = [];
  const now = input.now;
  const segment = input.customer?.segment === 'commercial' ? 'commercial' : 'residential';
  const rate = clamp(input.customer?.discountRate ?? DISCOUNT_RATE[segment], 0, 0.5);
  if (!finite(input.customer?.discountRate)) assumptions.push(`Future money is discounted at ${pct(rate)} a year (typical for a ${segment} customer).`);

  // ---- unit
  const category = classifyEquipment({ equipment_type: unit.equipmentType, make: unit.make ?? null, model: unit.model ?? null });
  const model = (category && MODELS[category]) || GENERIC_MODEL;
  if (!category || !MODELS[category]) assumptions.push('Equipment type is not HVAC or a water heater, so a generic 15-year wear model was used.');
  const life = finite(unit.expectedLifespanYears) && unit.expectedLifespanYears > 0 ? unit.expectedLifespanYears : model.life;
  const installMs = parseMs(unit.installDate);
  const ageKnown = installMs !== null;
  const age = ageKnown ? Math.max(0, (now - installMs) / MS_PER_YEAR) : life * UNKNOWN_AGE_RATIO;
  if (!ageKnown) {
    assumptions.push(`The install date is unknown, so the unit is assumed to be ${Math.round(UNKNOWN_AGE_RATIO * 100)}% through its ${life}-year life.`);
    dataGaps.push('Install date: add it to the equipment record (or scan the nameplate) to sharpen the advice.');
  }
  const lifeRatio = age / life;
  const warrantyMs = parseMs(unit.warrantyExpiresAt);
  const warrantyActive = warrantyMs !== null && warrantyMs > now;
  const warrantyEndYears = warrantyMs === null ? null : (warrantyMs - now) / MS_PER_YEAR;

  // ---- repair history (maintenance visits never count as failures)
  const recent = input.history.filter((h) => {
    const t = parseMs(h.date);
    return t !== null && now - t <= REPAIR_WINDOW_MS && now - t >= 0;
  });
  const knownCosts = input.history.map((h) => h.costCents).filter((c): c is number => finite(c) && c > 0);
  const historyAvg = knownCosts.length > 0 ? sum(knownCosts) / knownCosts.length : null;
  const recentSpend = sum(recent.map((h) => h.costCents ?? 0).filter((c) => c > 0));
  if (input.history.length > 0 && knownCosts.length < input.history.length) {
    dataGaps.push('Some past repairs have no cost on record; the average of the known ones was used.');
  }

  // ---- repair cost basis
  const quoteGiven = finite(input.repair.quoteCents);
  const defaultRepair = Math.round(DEFAULT_COSTS[category ?? 'hvac'].repair * 100);
  const quoteCents = quoteGiven ? Math.round(input.repair.quoteCents as number) : Math.round(historyAvg ?? defaultRepair);
  const baseRepairCents = quoteGiven && historyAvg !== null ? (quoteCents + historyAvg) / 2 : quoteCents;
  if (!quoteGiven) {
    assumptions.push(
      `No repair quote was entered, so a typical repair of ${usd(quoteCents)} (${historyAvg !== null ? 'from this unit\u2019s history' : 'category average'}) was used.`,
    );
    dataGaps.push('Repair quote: enter the actual quote for the repair being proposed.');
  }

  // ---- hazard: history x maintenance prior, blended with the predictive forecast
  const overdue =
    unit.lastServiceDate && parseMs(unit.lastServiceDate) !== null && finite(unit.serviceIntervalMonths) && unit.serviceIntervalMonths > 0
      ? (now - (parseMs(unit.lastServiceDate) as number)) / MS_PER_MONTH - unit.serviceIntervalMonths
      : null;
  const prior = clamp(historyFactor(recent.length) * maintenanceFactor(overdue), MIN_MULTIPLIER, MAX_MULTIPLIER);
  let multiplier = prior;
  let weight = 0;
  let forecastFloorEvents = 0;
  const forecast = input.forecast && finite(input.forecast.probability) && input.forecast.horizonDays > 0 ? input.forecast : null;
  if (forecast) {
    weight = forecastWeight(forecast);
    const fit = calibrateMultiplier(age, life, model.shape, forecast.probability, forecast.horizonDays / 365.25);
    multiplier =
      fit.saturated === 'high'
        ? MAX_MULTIPLIER // the forecast is riskier than any normal wear-out curve: take the evidence at face value
        : clamp(Math.exp((1 - weight) * Math.log(prior) + weight * Math.log(fit.multiplier)), MIN_MULTIPLIER, MAX_MULTIPLIER);
    // Failure within the forecast window is also failure within the year: year one can never be calmer than the forecast.
    if (forecast.horizonDays <= 366) {
      forecastFloorEvents = -Math.log(1 - clamp(forecast.probability, 0, 0.95)) * (forecast.confidence === 'low' ? 0.5 : 1);
    }
    if (fit.saturated === 'high') {
      assumptions.push('Predictive monitoring rates this unit riskier than a normal wear-out curve can express; the maximum hazard was used.');
    }
    assumptions.push(
      `The ${forecast.horizonDays}-day failure forecast (${pct(forecast.probability)}) was extended to five years using the wear-out curve; it carries ${pct(weight)} weight against the unit\u2019s repair history.`,
    );
  } else {
    dataGaps.push('Predictive forecast: run a Predictive Failure scan so the risk reflects network data, weather and usage.');
  }
  const model12m = failureProbability(age, life, model.shape, multiplier, 1);
  const risk12m = Math.max(model12m, 1 - Math.exp(-forecastFloorEvents));
  const risk5y = Math.max(risk12m, failureProbability(age, life, model.shape, multiplier, ADVISOR_HORIZON_YEARS));
  const medianMonths = Math.round(yearsToQuantile(age, life, model.shape, 0.5, multiplier) * 12);

  // ---- replacement economics
  const installedCents = Math.round(input.replacement.installedCostCents);
  const newLife = finite(input.replacement.expectedLifeYears) && input.replacement.expectedLifeYears > 0 ? input.replacement.expectedLifeYears : model.life;
  const annualSystemEnergy =
    finite(input.energy?.annualSystemCostCents) && (input.energy?.annualSystemCostCents as number) > 0
      ? (input.energy?.annualSystemCostCents as number)
      : Math.round(DEFAULT_ENERGY_CENTS[segment] * model.energyShare);
  let annualSavingCents = 0;
  let savingKnown = false;
  if (finite(input.replacement.annualEnergySavingsCents) && input.replacement.annualEnergySavingsCents >= 0) {
    annualSavingCents = Math.round(input.replacement.annualEnergySavingsCents * ENERGY_REALIZATION);
    savingKnown = true;
  } else {
    const f = energySavingFraction(unit.efficiency, input.replacement.efficiency, installMs);
    if (f) {
      annualSavingCents = Math.round(annualSystemEnergy * f.fraction * ENERGY_REALIZATION);
      savingKnown = true;
      if (f.assumedOld) {
        assumptions.push('The old unit\u2019s efficiency was estimated from its install era; scan the nameplate for an exact figure.');
        dataGaps.push('Nameplate efficiency of the existing unit (SEER2 / HSPF2 / AFUE / UEF).');
      }
      if (!finite(input.energy?.annualSystemCostCents)) {
        assumptions.push(`This system\u2019s yearly energy cost was assumed to be ${usd(annualSystemEnergy)} (typical for ${segment} ${category ? CATEGORY_LABELS[category].toLowerCase() : 'equipment'}).`);
      }
    } else {
      dataGaps.push('Efficiency rating of the replacement unit: add it to see energy savings.');
    }
  }
  assumptions.push(`${pct(ENERGY_REALIZATION)} of modelled energy savings is counted as realistically captured.`);

  const rebateSummary = input.rebates;
  if (!rebateSummary) dataGaps.push('Rebates: run the rebate analysis (state, ZIP, utility) to include incentives.');
  const reb = {
    at: Math.max(0, rebateSummary?.atInstallCents ?? 0),
    after: Math.max(0, rebateSummary?.afterInstallCents ?? 0),
    tax: Math.max(0, rebateSummary?.taxFilingCents ?? 0),
    expected: Math.max(0, rebateSummary?.expectedCents ?? 0),
    conservative: Math.max(0, rebateSummary?.conservativeCents ?? 0),
    best: Math.max(0, rebateSummary?.bestCaseCents ?? 0),
  };
  reb.expected = reb.at + reb.after + reb.tax; // timing parts are authoritative
  reb.conservative = Math.min(reb.conservative, reb.expected);
  reb.best = Math.max(reb.best, reb.expected);
  if (reb.expected > 0) {
    assumptions.push('Rebates are confidence-weighted by Rebate Intelligence; an emergency replacement keeps only half because it cannot be pre-approved.');
  }

  const safetyModes = (forecast?.safetyCriticalModes ?? []).filter(Boolean);
  const disruption = DISRUPTION_CENTS[segment] * (safetyModes.length > 0 ? SAFETY_DISRUPTION_FACTOR : 1);
  assumptions.push(`Each breakdown is assumed to cost the customer ${usd(disruption)} beyond the repair itself (no heat / cooling / hot water${safetyModes.length > 0 ? ', plus safety exposure' : ''}).`);

  const ctx: Ctx = {
    now,
    rate,
    segment,
    model,
    category,
    age,
    life,
    multiplier,
    forecastWeight: weight,
    forecastFloorEvents,
    warrantyEndYears,
    quoteCents,
    baseRepairCents,
    installedCents,
    newLife,
    disruptionCents: disruption,
    annualSavingCents,
    rebates: reb,
  };

  // ---- scenarios
  const runs = SCENARIOS.map((sc) => {
    const { keep, repl } = evalScenario(ctx, sc);
    return { sc, keep: keep.summarize(rate), repl: repl.summarize(rate), keepRes: keep.residual, replRes: repl.residual };
  });
  const lineKeys = Object.keys(COST_LINE_LABELS) as CostLineKey[];
  const combine = (which: 'keep' | 'repl', path: AdvisorVerdict): PathCost => {
    const lines: CostLine[] = lineKeys
      .map((key) => ({
        key,
        label: COST_LINE_LABELS[key],
        nominalCents: Math.round(sum(runs.map((r) => (r[which].byKey.get(key)?.nominal ?? 0) * r.sc.weight))),
        presentValueCents: Math.round(sum(runs.map((r) => (r[which].byKey.get(key)?.pv ?? 0) * r.sc.weight))),
      }))
      .filter((l) => l.nominalCents !== 0 || l.presentValueCents !== 0);
    const outOfPocket = sum(lines.map((l) => l.nominalCents));
    const residualCredit = Math.round(sum(runs.map((r) => -(which === 'keep' ? r.keepRes : r.replRes) * r.sc.weight)));
    const residualPv = sum(runs.map((r) => r[which].residualPv * r.sc.weight));
    const pv = sum(lines.map((l) => l.presentValueCents)) + Math.round(residualPv);
    const cumulativeByYear = Array.from({ length: ADVISOR_HORIZON_YEARS }, (_, y) => Math.round(sum(runs.map((r) => r[which].cumulative[y] * r.sc.weight))));
    const reb0 = scenarioRebates(reb, 'expected');
    return {
      path,
      label: path === 'repair' ? 'Repair and keep the current unit' : 'Replace with a new unit',
      upfrontCents: path === 'repair' ? quoteCents : Math.max(0, Math.round(installedCents - reb0.at)),
      outOfPocketCents: outOfPocket,
      residualCreditCents: residualCredit,
      netCostCents: outOfPocket - residualCredit,
      presentValueCents: pv,
      lines,
      cumulativeByYear,
    };
  };
  const repair = combine('keep', 'repair');
  const replace = combine('repl', 'replace');

  const scenarios: ScenarioOutcome[] = runs.map((r) => {
    const keepPv = sum([...r.keep.byKey.values()].map((v) => v.pv)) + r.keep.residualPv;
    const replPv = sum([...r.repl.byKey.values()].map((v) => v.pv)) + r.repl.residualPv;
    return {
      key: r.sc.key,
      label: r.sc.label,
      weight: r.sc.weight,
      repairPvCents: Math.round(keepPv),
      replacePvCents: Math.round(replPv),
      winner: keepPv > replPv ? 'replace' : 'repair',
    };
  });

  // ---- verdict
  const pvAdvantage = repair.presentValueCents - replace.presentValueCents; // > 0: replacing is cheaper
  const threshold = Math.max(25_000, Math.round(installedCents * 0.04));
  const ageCostDollars = age * (quoteCents / 100);
  const rules: RuleCheck[] = [
    {
      id: 'half_cost',
      label: 'The repair costs half or more of a new unit',
      triggered: quoteCents >= installedCents * 0.5,
      detail: `Repair ${usd(quoteCents)} vs. replacement ${usd(installedCents)} (${pct(quoteCents / installedCents)}).`,
    },
    {
      id: 'late_life',
      label: 'The unit is in the last 20% of its expected life',
      triggered: lifeRatio >= 0.8,
      detail: `${pct(lifeRatio)} of a ${life}-year life used.`,
    },
    {
      id: 'age_cost',
      label: 'Age in years times repair cost in dollars is over 5,000',
      triggered: ageCostDollars > 5000,
      detail: `${age.toFixed(1)} years \u00d7 ${usd(quoteCents)} = ${Math.round(ageCostDollars).toLocaleString('en-US')}.`,
    },
    {
      id: 'repeat_repairs',
      label: 'Three or more repairs in the last two years',
      triggered: recent.length >= 3,
      detail: `${recent.length} repair${recent.length === 1 ? '' : 's'} in the last 24 months.`,
    },
    {
      id: 'safety',
      label: 'A safety-related failure is flagged',
      triggered: safetyModes.length > 0,
      detail: safetyModes.length > 0 ? safetyModes.join(', ') : 'No safety-related failure mode is flagged.',
    },
  ];
  const replaceSignals = rules.filter((r) => r.triggered).length;

  let verdict: AdvisorVerdict;
  let strength: VerdictStrength;
  const robust = scenarios.every((s) => s.winner === scenarios[1].winner) && Math.abs(pvAdvantage) >= threshold;
  if (pvAdvantage >= threshold) {
    verdict = 'replace';
    strength = pvAdvantage >= threshold * 3 && robust ? 'clear' : 'lean';
  } else if (pvAdvantage <= -threshold) {
    verdict = 'repair';
    strength = -pvAdvantage >= threshold * 3 && robust ? 'clear' : 'lean';
  } else {
    verdict = replaceSignals >= 2 ? 'replace' : 'repair';
    strength = 'toss_up';
  }

  // ---- confidence
  let score = 1;
  if (!ageKnown) score -= 0.25;
  if (!quoteGiven) score -= 0.15;
  if (!forecast) score -= 0.1;
  else if (forecast.confidence === 'low') score -= 0.05;
  if (!rebateSummary) score -= 0.1;
  if (!savingKnown) score -= 0.05;
  if (input.history.length > 0 && knownCosts.length === 0) score -= 0.05;
  if (!category || !MODELS[category]) score -= 0.1;
  score = clamp(score, 0, 1);
  let confidence: AdvisorConfidence = score >= 0.8 ? 'high' : score >= 0.6 ? 'medium' : 'low';
  if (!robust && confidence === 'high') confidence = 'medium';

  // ---- reasons (plain language, customer-safe)
  const unitName = unit.label || (category ? CATEGORY_LABELS[category] : 'equipment');
  const reasons: Reason[] = [];
  reasons.push({
    id: 'age',
    tone: lifeRatio >= 0.8 ? 'replace' : lifeRatio <= 0.5 ? 'repair' : 'neutral',
    text: ageKnown
      ? `This ${unitName} is about ${Math.round(age)} years old, roughly ${pct(lifeRatio)} of the ${life} years this kind of equipment is built to last.`
      : `We don\u2019t have an install date, so we assumed this ${unitName} is about ${Math.round(age)} years old. Adding the real date would sharpen this advice.`,
  });
  reasons.push({
    id: 'risk',
    tone: risk12m >= 0.35 ? 'replace' : risk12m < 0.15 ? 'repair' : 'neutral',
    text:
      `Our failure model puts the chance of another breakdown at ${pct(risk12m)} within a year and ${pct(risk5y)} within five years` +
      (forecast ? `; our predictive monitoring currently rates the near-term risk as ${forecast.band}.` : '.'),
  });
  if (recent.length >= 2) {
    reasons.push({
      id: 'history',
      tone: 'replace',
      text: `It has needed ${recent.length} repairs in the last two years${recentSpend > 0 ? ` (about ${usd(recentSpend)} spent)` : ''}, a sign the problems are recurring.`,
    });
  } else if (recent.length === 0) {
    reasons.push({ id: 'history', tone: 'repair', text: 'No other repairs are on record for the last two years, so this looks like an isolated problem rather than a pattern.' });
  }
  if (safetyModes.length > 0) {
    reasons.push({
      id: 'safety',
      tone: 'replace',
      text: `Our monitoring flags a safety-related risk (${safetyModes.slice(0, 2).join(', ')}). Safety-related failures are not worth gambling on.`,
    });
  }
  const diff = repair.netCostCents - replace.netCostCents;
  reasons.push({
    id: 'cost',
    tone: verdict === 'replace' ? 'replace' : 'repair',
    text:
      verdict === 'replace'
        ? `Over five years we expect to spend about ${usd(repair.outOfPocketCents)} keeping the current unit going, versus ${usd(replace.outOfPocketCents)} for a new one after rebates and energy savings${diff > 0 ? `, about ${usd(diff)} less once the remaining value of each is counted` : ''}.`
        : `Over five years we expect to spend about ${usd(repair.outOfPocketCents)} repairing and running the current unit, versus ${usd(replace.outOfPocketCents)} for a new one. Replacing does not pay for itself within five years.`,
  });
  if (rules[0].triggered) {
    reasons.push({ id: 'half_cost', tone: 'replace', text: `The repair quote is ${pct(quoteCents / installedCents)} of the price of a new unit. Above about half, replacing is usually the better investment.` });
  }
  if (reb.expected > 0) {
    const soon = rebateSummary?.deadlines[0];
    reasons.push({
      id: 'rebates',
      tone: 'replace',
      text: `${usd(reb.expected)} in rebates and tax credits is expected to apply to a new unit${soon ? `; the earliest program (${soon.program}) ends in ${soon.daysLeft} day${soon.daysLeft === 1 ? '' : 's'}` : ''}. Rebates generally cannot be claimed on an emergency replacement.`,
    });
  }
  if (annualSavingCents > 0) {
    const frac = annualSystemEnergy > 0 ? annualSavingCents / ENERGY_REALIZATION / annualSystemEnergy : 0;
    reasons.push({
      id: 'energy',
      tone: 'replace',
      text: `A new unit should lower this system\u2019s energy bill by about ${usd(annualSavingCents)} a year${frac > 0 && !finite(input.replacement.annualEnergySavingsCents) ? ` (around ${pct(Math.min(frac, 0.6))} less energy)` : ''}.`,
    });
  }
  if (warrantyActive) {
    reasons.push({ id: 'warranty', tone: 'repair', text: 'The unit is still under warranty, which can cover part of the cost of future repairs.' });
  }
  if (strength === 'toss_up') {
    reasons.push({
      id: 'close',
      tone: 'neutral',
      text: `This is a close call: the two choices are within ${usd(threshold)} of each other over five years, so either is reasonable. The tie-breakers point to ${verdict === 'replace' ? 'replacing' : 'repairing'}.`,
    });
  } else if (!robust) {
    reasons.push({
      id: 'sensitivity',
      tone: 'neutral',
      text: 'The best choice changes if repairs hold up better, or worse, than expected, so we lean on the most likely case.',
    });
  }

  // ---- next steps
  const nextSteps: string[] = [];
  if (verdict === 'replace') {
    if (rebateSummary?.actions.some((a) => /pre-approval/i.test(a))) nextSteps.push('Get program pre-approval before any equipment is ordered or installed.');
    nextSteps.push('Choose a financing option and confirm the installed price.');
    nextSteps.push('Schedule the installation' + (unit.isDown ? ' (the current unit is down, so sooner is better).' : '.'));
  } else {
    nextSteps.push('Approve the repair.');
    nextSteps.push(`Plan for a replacement within about ${Math.max(6, Math.min(60, medianMonths || 12))} months and keep the rebate options in mind.`);
    nextSteps.push('Put the unit on a maintenance plan to keep failures down.');
  }
  for (const d of rebateSummary?.deadlines ?? []) {
    if (d.daysLeft <= 90) nextSteps.push(`${d.program} ends on ${d.endDate}.`);
  }

  const financing = buildFinancingOptions({
    installedCents,
    atInstallRebateCents: Math.round(reb.at),
    afterInstallRebateCents: Math.round(reb.after),
    annualSavingCents,
    creditBand: input.customer?.creditBand ?? 'unknown',
    cashAvailableCents: finite(input.customer?.cashAvailableCents) ? (input.customer?.cashAvailableCents as number) : null,
    monthlyBudgetCents: finite(input.customer?.monthlyBudgetCents) ? (input.customer?.monthlyBudgetCents as number) : null,
    model,
    lender: input.lender ?? null,
  });
  if (!input.lender) assumptions.push('Financing rates are planning estimates by credit band, not an offer. Approval, rate and terms are set by the lender.');

  return {
    engineVersion: ADVISOR_ENGINE_VERSION,
    generatedAt: new Date(now).toISOString(),
    horizonYears: ADVISOR_HORIZON_YEARS,
    unit: {
      id: unit.id,
      label: unitName,
      category,
      categoryLabel: category ? CATEGORY_LABELS[category] : 'Equipment',
      ageYears: Math.round(age * 10) / 10,
      ageKnown,
      lifespanYears: life,
      lifeUsedPct: Math.round(lifeRatio * 100),
      warrantyActive,
      recentRepairs: recent.length,
      recentRepairSpendCents: recentSpend,
      isDown: !!unit.isDown,
    },
    risk: {
      risk12m: Math.round(risk12m * 1000) / 1000,
      risk5y: Math.round(risk5y * 1000) / 1000,
      medianMonthsToNextFailure: medianMonths,
      hazardMultiplier: Math.round(multiplier * 100) / 100,
      forecastWeight: weight,
    },
    repair,
    replace,
    scenarios,
    verdict,
    strength,
    robust,
    netAdvantageOfReplacingCents: repair.netCostCents - replace.netCostCents,
    pvAdvantageOfReplacingCents: pvAdvantage,
    tossUpThresholdCents: threshold,
    annualEnergySavingsCents: annualSavingCents,
    rules,
    reasons: reasons.slice(0, 8),
    rebates: rebateSummary,
    financing,
    confidence,
    confidenceScore: Math.round(score * 100) / 100,
    assumptions,
    dataGaps,
    nextSteps,
  };
}

/** True when a job / passport service type describes a repair (maintenance, install and inspection visits never count as failures). */
export function isRepairVisit(...types: (string | null | undefined)[]): boolean {
  const text = types.filter(Boolean).join(' ');
  return /repair|fix|breakdown|emergency|no\s*(heat|cool|ac|hot)|part\s*replace/i.test(text);
}
