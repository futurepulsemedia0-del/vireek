// Outcome-Based Pricing Engine — pure pricing core (no I/O, no imports).
//
// Turns "keep this equipment up X% of the time" into a contract price:
//   expected failures -> downtime -> maintenance plan -> cost -> SLA-credit risk -> price.
//
// Method (all deterministic — same input always gives the same quote):
//  1. Failure rate per asset: Gamma-Poisson (empirical Bayes). An equipment-type
//     prior is blended with the asset's own repair history; thin history keeps the
//     prior and widens the risk band.
//  2. Preventive-maintenance (PM) plan: PM visits/year reduce the failure rate
//     with diminishing returns. The engine searches the cheapest plan per asset.
//  3. Monte Carlo (common random numbers): 12 months x N trials of failures and
//     repair durations -> monthly uptime -> tiered SLA credits (capped) + cost.
//  4. Price = (expected cost + risk margin) / (1 - overhead - margin - credit load).
//     Credit exposure is a % of the fee, so it is solved algebraically, not guessed.
//  5. Guardrails: Vireek refuses (or flags for review) guarantees it cannot deliver
//     with enough probability, or that rest on too little data.
//
// IMPORTANT: the equipment priors below are conservative starting points, not measured
// facts. Calibrate them with your own history (they are blended away as real data arrives).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreditTier {
  /** Tier applies while monthly uptime shortfall (points below target) is <= upToPts. */
  upToPts: number;
  /** Credit as a percent of that month's fee. */
  creditPct: number;
}

export interface PricingAssumptions {
  laborCostPerHour: number;
  truckRollCost: number;
  consumablesPerVisit: number;
  overheadPct: number; // 0..1 of price
  targetMarginPct: number; // 0..1 of price
  riskAversionZ: number; // price at expected + z * stdev
  partsOnTruckRate: number; // 0..1 share of repairs finished on the first visit
  partsLeadHours: number; // extra downtime when the part is not on the truck
  responseHours: number; // time to arrive after a failure
  billRatePerHour: number; // for the T&M comparison only
  tripCharge: number; // T&M trip charge, comparison only
  partsMarkupPct: number; // T&M parts markup, comparison only
  durationCv: number; // variability of repair duration
  minPMeetProbability: number; // required P(annual uptime >= target)
  minDataConfidence: number; // below this -> human review
  minExpectedMarginPct: number; // below this -> human review
}

export const DEFAULT_ASSUMPTIONS: PricingAssumptions = {
  laborCostPerHour: 58,
  truckRollCost: 42,
  consumablesPerVisit: 15,
  overheadPct: 0.12,
  targetMarginPct: 0.22,
  riskAversionZ: 0.5,
  partsOnTruckRate: 0.78,
  partsLeadHours: 30,
  responseHours: 4,
  billRatePerHour: 135,
  tripCharge: 89,
  partsMarkupPct: 0.35,
  durationCv: 0.6,
  minPMeetProbability: 0.8,
  minDataConfidence: 0.3,
  minExpectedMarginPct: 0.12,
};

export const DEFAULT_CREDIT_SCHEDULE: CreditTier[] = [
  { upToPts: 0.5, creditPct: 5 },
  { upToPts: 1.5, creditPct: 15 },
  { upToPts: 3, creditPct: 30 },
  { upToPts: 100, creditPct: 50 },
];

export const DEFAULT_ANNUAL_CREDIT_CAP_PCT = 25;
export const MAX_ASSETS = 60;
export const MAX_PM_VISITS = 12;
export const PM_CANDIDATES = [0, 1, 2, 3, 4, 6, 8, 12];
export const DEFAULT_CURVE_TARGETS = [95, 97, 98, 99, 99.5, 99.9];
export const PRIOR_STRENGTH_YEARS = 3;
export const PRICING_MODEL_VERSION = 'outcome-v1';

export interface AssetInput {
  id: string;
  label: string;
  equipmentType: string;
  ageYears: number;
  expectedLifespanYears: number;
  serviceIntervalMonths: number;
  /** null when unknown. */
  monthsSinceService: number | null;
  /** Repair events seen in the observation window. */
  observedFailures: number;
  /** Length of the observation window in years (0 = no history). */
  observedYears: number;
  /** Hours per year the customer needs the asset (8760 = 24/7). */
  operatingHoursPerYear: number;
  /** Customer's cost of one hour of downtime (value story only). */
  downtimeCostPerHour: number;
}

export interface PricingInput {
  assets: AssetInput[];
  targetUptimePct: number;
  termMonths: number;
  assumptions?: Partial<PricingAssumptions>;
  creditSchedule?: CreditTier[];
  annualCreditCapPct?: number;
  trials?: number;
  seedSalt?: string;
  curveTargets?: number[];
}

export type Decision = 'offerable' | 'needs_review' | 'not_offerable';

export interface CostComponents {
  maintenance: number;
  intervention: number;
  riskMargin: number;
  creditReserve: number;
  overhead: number;
  margin: number;
}

export interface AssetPricing {
  id: string;
  label: string;
  equipmentType: string;
  pmVisitsPerYear: number;
  baseFailuresPerYear: number; // as-is rate, before the PM plan
  plannedFailuresPerYear: number; // with the PM plan
  expectedDowntimeHours: number;
  expectedUptimePct: number;
  pMeetTarget: number; // P(annual uptime >= target)
  expectedCreditPct: number; // of annual fee
  dataConfidence: number; // 0..1
  priceAnnual: number;
  priceMonthly: number;
  /** Authoritative billing amounts: monthly is rounded up, annual = 12 x monthly. */
  priceMonthlyCents: number;
  priceAnnualCents: number;
  components: CostComponents;
  feasible: boolean;
  notes: string[];
}

export interface PortfolioRisk {
  expectedMarginPct: number;
  p10MarginPct: number;
  probabilityOfLoss: number;
  expectedCreditPct: number; // of annual fee
  p90CreditPct: number;
  probabilityAnyCredit: number;
}

export interface CustomerValue {
  tmEquivalentAnnual: number;
  downtimeHoursAvoided: number;
  downtimeValueAvoided: number;
  netBenefitAnnual: number;
  priceVsTmPct: number | null;
}

export interface CurvePoint {
  targetUptimePct: number;
  priceAnnual: number;
  pMeetTarget: number;
  expectedMarginPct: number;
  decision: Decision;
}

export interface PricingResult {
  modelVersion: string;
  targetUptimePct: number;
  termMonths: number;
  assets: AssetPricing[];
  priceAnnualCents: number;
  priceMonthlyCents: number;
  priceTermCents: number;
  components: CostComponents;
  risk: PortfolioRisk;
  value: CustomerValue;
  dataConfidence: number;
  decision: Decision;
  reasons: string[];
  curve: CurvePoint[];
}

// ---------------------------------------------------------------------------
// Equipment priors (annual failure rate, repair hours, parts cost, PM hours)
// ---------------------------------------------------------------------------

interface Prior {
  failuresPerYear: number;
  repairHours: number;
  partsCost: number;
  pmHours: number;
}

const PRIOR_RULES: Array<[RegExp, Prior]> = [
  [/chiller/i, { failuresPerYear: 0.3, repairHours: 6, partsCost: 900, pmHours: 3.5 }],
  [/boiler/i, { failuresPerYear: 0.25, repairHours: 4.5, partsCost: 520, pmHours: 2.5 }],
  [/refriger|walk.?in|cooler|freezer|reach.?in/i, { failuresPerYear: 0.55, repairHours: 3.4, partsCost: 330, pmHours: 1.6 }],
  [/rtu|rooftop|package/i, { failuresPerYear: 0.45, repairHours: 3.2, partsCost: 260, pmHours: 1.6 }],
  [/heat.?pump/i, { failuresPerYear: 0.35, repairHours: 3, partsCost: 280, pmHours: 1.5 }],
  [/furnace|heater(?!.*water)/i, { failuresPerYear: 0.3, repairHours: 2.8, partsCost: 240, pmHours: 1.2 }],
  [/air.?handler|ahu|fan.?coil/i, { failuresPerYear: 0.35, repairHours: 2.8, partsCost: 210, pmHours: 1.3 }],
  [/split|condens|a\/?c|air.?cond|hvac/i, { failuresPerYear: 0.4, repairHours: 2.6, partsCost: 230, pmHours: 1.2 }],
  [/water.?heater/i, { failuresPerYear: 0.18, repairHours: 2.4, partsCost: 300, pmHours: 1 }],
  [/generator/i, { failuresPerYear: 0.2, repairHours: 4, partsCost: 600, pmHours: 2.5 }],
  [/pump/i, { failuresPerYear: 0.25, repairHours: 2.6, partsCost: 260, pmHours: 1.1 }],
];
const DEFAULT_PRIOR: Prior = { failuresPerYear: 0.35, repairHours: 3, partsCost: 280, pmHours: 1.5 };

export function priorForEquipment(equipmentType: string): Prior {
  for (const [re, prior] of PRIOR_RULES) if (re.test(equipmentType)) return prior;
  return DEFAULT_PRIOR;
}

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stateless deterministic uniform in (0,1) from four integers. */
function uniform(a: number, b: number, c: number, d: number): number {
  let h = a | 0;
  h = Math.imul(h ^ (b | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (c | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ (d | 0), 0x27d4eb2f);
  h ^= h >>> 15;
  return ((h >>> 0) + 0.5) / 4294967296;
}

function normal(a: number, b: number, c: number, d: number): number {
  const u1 = uniform(a, b, c, d * 2 + 1);
  const u2 = uniform(a, b, c, d * 2 + 2);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function quantile(sorted: Float64Array | number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function meanOf(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return a.length ? s / a.length : 0;
}

function stdevOf(a: ArrayLike<number>, mean: number): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - mean) ** 2;
  return a.length > 1 ? Math.sqrt(s / (a.length - 1)) : 0;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validatePricingInput(input: PricingInput): string[] {
  const errors: string[] = [];
  if (!input.assets.length) errors.push('Select at least one asset.');
  if (input.assets.length > MAX_ASSETS) errors.push(`At most ${MAX_ASSETS} assets can be priced in one guarantee.`);
  if (!(input.targetUptimePct >= 80 && input.targetUptimePct <= 99.99)) errors.push('Target uptime must be between 80% and 99.99%.');
  if (!Number.isInteger(input.termMonths) || input.termMonths < 1 || input.termMonths > 120) errors.push('Term must be 1–120 months.');
  const ids = new Set<string>();
  for (const a of input.assets) {
    if (ids.has(a.id)) errors.push(`Duplicate asset: ${a.label}.`);
    ids.add(a.id);
    if (!(a.operatingHoursPerYear >= 100 && a.operatingHoursPerYear <= 8760)) errors.push(`${a.label}: operating hours must be 100–8760 per year.`);
    if (!(a.ageYears >= 0) || !(a.expectedLifespanYears > 0)) errors.push(`${a.label}: age and expected lifespan are required.`);
    if (a.observedFailures < 0 || a.observedYears < 0) errors.push(`${a.label}: history cannot be negative.`);
  }
  const s = input.creditSchedule;
  if (s) {
    if (!s.length) errors.push('Credit schedule cannot be empty.');
    let prev = 0;
    for (const t of s) {
      if (!(t.upToPts > prev) || t.creditPct < 0 || t.creditPct > 100) errors.push('Credit schedule tiers must be ascending with 0–100% credits.');
      prev = t.upToPts;
    }
  }
  const cap = input.annualCreditCapPct;
  if (cap !== undefined && !(cap >= 0 && cap <= 100)) errors.push('Annual credit cap must be 0–100%.');
  return errors;
}

// ---------------------------------------------------------------------------
// Failure-rate model
// ---------------------------------------------------------------------------

export interface FailureEstimate {
  baseRate: number; // posterior mean failures/year (as-is)
  overdueMult: number;
  posteriorShape: number;
  dataConfidence: number;
  prior: Prior;
}

export function ageMultiplier(ageYears: number, lifespanYears: number): number {
  const r = lifespanYears > 0 ? ageYears / lifespanYears : 0;
  return Math.min(4, 1 + 3 * Math.max(0, r - 0.5) ** 2);
}

export function estimateFailureRate(a: AssetInput, termYears: number): FailureEstimate {
  const prior = priorForEquipment(a.equipmentType);
  // Use mid-term age: equipment keeps ageing while the guarantee runs.
  const midAge = a.ageYears + termYears / 2;
  const priorRate = prior.failuresPerYear * ageMultiplier(midAge, a.expectedLifespanYears);
  const k0 = PRIOR_STRENGTH_YEARS;
  const shape0 = priorRate * k0;
  const posteriorShape = shape0 + a.observedFailures;
  const baseRate = clamp(posteriorShape / (k0 + a.observedYears), 0.02, 24);
  const interval = Math.max(1, a.serviceIntervalMonths);
  const overdue = a.monthsSinceService === null ? 1.2 : a.monthsSinceService / interval;
  const overdueMult = 1 + 0.2 * clamp(overdue - 1, 0, 2);
  const dataConfidence = clamp(a.observedYears / (a.observedYears + k0), 0, 1);
  return { baseRate, overdueMult, posteriorShape, dataConfidence, prior };
}

/** Share of the failure rate removed by `visits` PM visits/year (diminishing returns). */
export function pmReduction(visits: number, serviceIntervalMonths: number): number {
  const recommended = Math.max(1, 12 / Math.max(1, serviceIntervalMonths));
  return 0.55 * (1 - Math.exp((-1.5 * visits) / recommended));
}

// ---------------------------------------------------------------------------
// Monte Carlo
// ---------------------------------------------------------------------------

interface Sim {
  monthlyDown: Float32Array; // trials*12, hours
  failures: Float32Array; // per trial, per year
}

function simulateAsset(
  seed: number,
  trials: number,
  lambdaPerYear: number,
  paramCv: number,
  meanDurationHours: number,
  durationCv: number,
  monthHours: number
): Sim {
  const monthlyDown = new Float32Array(trials * 12);
  const failures = new Float32Array(trials);
  const sig2 = Math.log(1 + durationCv * durationCv);
  const sig = Math.sqrt(sig2);
  const mu = Math.log(Math.max(0.05, meanDurationHours)) - sig2 / 2;
  const psig2 = Math.log(1 + paramCv * paramCv);
  const psig = Math.sqrt(psig2);
  for (let t = 0; t < trials; t++) {
    // Parameter uncertainty: thin data => wider spread of the true failure rate.
    const lam = lambdaPerYear * Math.exp(psig * normal(seed, t, 0, 0) - psig2 / 2);
    const lamM = clamp(lam / 12, 0, 10);
    const p0 = Math.exp(-lamM);
    let total = 0;
    for (let m = 0; m < 12; m++) {
      const u = uniform(seed, t, m + 1, 0);
      let k = 0;
      let p = p0;
      let cdf = p0;
      while (u > cdf && k < 12) {
        k++;
        p *= lamM / k;
        cdf += p;
      }
      let down = 0;
      for (let j = 0; j < k; j++) down += Math.exp(mu + sig * normal(seed, t, m + 1, j + 1));
      monthlyDown[t * 12 + m] = Math.min(down, monthHours);
      total += k;
    }
    failures[t] = total;
  }
  return { monthlyDown, failures };
}

function tierCredit(shortfallPts: number, schedule: CreditTier[]): number {
  if (shortfallPts <= 0) return 0;
  for (const tier of schedule) if (shortfallPts <= tier.upToPts) return tier.creditPct;
  return schedule[schedule.length - 1].creditPct;
}

interface TargetEval {
  creditFrac: Float32Array; // per trial, fraction of annual fee credited (capped)
  availability: Float32Array; // per trial annual uptime fraction
  pMeet: number;
  meanCredit: number;
  sdCredit: number;
}

function evaluateTarget(
  sim: Sim,
  trials: number,
  monthHours: number,
  annualHours: number,
  targetPct: number,
  schedule: CreditTier[],
  capFrac: number
): TargetEval {
  const creditFrac = new Float32Array(trials);
  const availability = new Float32Array(trials);
  let meet = 0;
  for (let t = 0; t < trials; t++) {
    let credit = 0;
    let down = 0;
    for (let m = 0; m < 12; m++) {
      const d = sim.monthlyDown[t * 12 + m];
      down += d;
      const upPct = (1 - d / monthHours) * 100;
      credit += tierCredit(targetPct - upPct, schedule) / 100 / 12;
    }
    creditFrac[t] = Math.min(credit, capFrac);
    availability[t] = 1 - down / annualHours;
    if (availability[t] * 100 >= targetPct) meet++;
  }
  const meanCredit = meanOf(creditFrac);
  return { creditFrac, availability, pMeet: meet / trials, meanCredit, sdCredit: stdevOf(creditFrac, meanCredit) };
}

// ---------------------------------------------------------------------------
// Pricing one asset at one PM level
// ---------------------------------------------------------------------------

interface Candidate {
  visits: number;
  lambdaEff: number;
  maintenanceCost: number;
  interventionCost: number;
  riskMargin: number;
  loadedCredit: number;
  meanOps: number;
  sdOps: number;
  price: number;
  denominator: number;
  eval: TargetEval;
  opsCost: Float32Array;
  meanDowntime: number;
  feasible: boolean;
}

interface AssetContext {
  input: AssetInput;
  est: FailureEstimate;
  seed: number;
  meanDuration: number;
  perFailureCost: number;
  pmVisitCost: number;
  monthHours: number;
  paramCv: number;
  sims: Map<number, Sim>;
  lambdaByVisits: Map<number, number>;
}

function buildContext(a: AssetInput, termYears: number, A: PricingAssumptions, salt: string): AssetContext {
  const est = estimateFailureRate(a, termYears);
  const p = est.prior;
  const onTruck = clamp(A.partsOnTruckRate, 0, 1);
  const meanDuration = A.responseHours + p.repairHours + (1 - onTruck) * A.partsLeadHours;
  const perFailureCost =
    A.truckRollCost + p.repairHours * A.laborCostPerHour + p.partsCost * 0.85 + (1 - onTruck) * A.truckRollCost;
  const pmVisitCost = A.truckRollCost * 0.5 + p.pmHours * A.laborCostPerHour + A.consumablesPerVisit;
  return {
    input: a,
    est,
    seed: hashString(`${salt}|${a.id}`),
    meanDuration,
    perFailureCost,
    pmVisitCost,
    monthHours: a.operatingHoursPerYear / 12,
    paramCv: 1 / Math.sqrt(Math.max(0.5, est.posteriorShape)),
    sims: new Map(),
    lambdaByVisits: new Map(),
  };
}

function lambdaFor(ctx: AssetContext, visits: number): number {
  return clamp(ctx.est.baseRate * ctx.est.overdueMult * (1 - pmReduction(visits, ctx.input.serviceIntervalMonths)), 0.01, 24);
}

function simFor(ctx: AssetContext, visits: number, trials: number, A: PricingAssumptions): Sim {
  let sim = ctx.sims.get(visits);
  if (!sim) {
    sim = simulateAsset(ctx.seed, trials, lambdaFor(ctx, visits), ctx.paramCv, ctx.meanDuration, A.durationCv, ctx.monthHours);
    ctx.sims.set(visits, sim);
  }
  return sim;
}

function priceCandidate(
  ctx: AssetContext,
  visits: number,
  trials: number,
  A: PricingAssumptions,
  targetPct: number,
  schedule: CreditTier[],
  capFrac: number
): Candidate {
  const sim = simFor(ctx, visits, trials, A);
  const ev = evaluateTarget(sim, trials, ctx.monthHours, ctx.input.operatingHoursPerYear, targetPct, schedule, capFrac);
  const maintenanceCost = visits * ctx.pmVisitCost;
  const opsCost = new Float32Array(trials);
  for (let t = 0; t < trials; t++) opsCost[t] = maintenanceCost + sim.failures[t] * ctx.perFailureCost;
  const meanOps = meanOf(opsCost);
  const sdOps = stdevOf(opsCost, meanOps);
  const interventionCost = meanOps - maintenanceCost;
  const riskMargin = A.riskAversionZ * sdOps;
  const loadedCredit = ev.meanCredit + A.riskAversionZ * ev.sdCredit;
  const denominator = 1 - A.overheadPct - A.targetMarginPct - loadedCredit;
  const feasible = denominator >= 0.2;
  const price = feasible ? (meanOps + riskMargin) / denominator : Infinity;
  let downSum = 0;
  for (let t = 0; t < trials; t++) {
    let d = 0;
    for (let m = 0; m < 12; m++) d += sim.monthlyDown[t * 12 + m];
    downSum += d;
  }
  return {
    visits,
    lambdaEff: lambdaFor(ctx, visits),
    maintenanceCost,
    interventionCost,
    riskMargin,
    loadedCredit,
    meanOps,
    sdOps,
    price,
    denominator,
    eval: ev,
    opsCost,
    meanDowntime: downSum / trials,
    feasible,
  };
}

/** Cheapest PM plan that clears the required probability; else the most reliable plan. */
function bestCandidate(
  ctx: AssetContext,
  trials: number,
  A: PricingAssumptions,
  targetPct: number,
  schedule: CreditTier[],
  capFrac: number
): { cand: Candidate; meetsRequirement: boolean } {
  let bestOk: Candidate | null = null;
  let bestReliable: Candidate | null = null;
  for (const v of PM_CANDIDATES) {
    const c = priceCandidate(ctx, v, trials, A, targetPct, schedule, capFrac);
    if (c.feasible && c.eval.pMeet >= A.minPMeetProbability && (!bestOk || c.price < bestOk.price)) bestOk = c;
    if (!bestReliable || c.eval.pMeet > bestReliable.eval.pMeet + 1e-9 || (Math.abs(c.eval.pMeet - bestReliable.eval.pMeet) <= 1e-9 && c.price < bestReliable.price)) {
      bestReliable = c;
    }
  }
  if (bestOk) return { cand: bestOk, meetsRequirement: true };
  return { cand: bestReliable as Candidate, meetsRequirement: false };
}

// ---------------------------------------------------------------------------
// Portfolio pricing
// ---------------------------------------------------------------------------

interface PortfolioPick {
  ctx: AssetContext;
  cand: Candidate;
  meetsRequirement: boolean;
}

function assemble(
  picks: PortfolioPick[],
  trials: number,
  A: PricingAssumptions,
  targetPct: number
): {
  assets: AssetPricing[];
  totalPrice: number;
  components: CostComponents;
  risk: PortfolioRisk;
  allFeasible: boolean;
  minPMeet: number;
} {
  const assets: AssetPricing[] = [];
  const components: CostComponents = { maintenance: 0, intervention: 0, riskMargin: 0, creditReserve: 0, overhead: 0, margin: 0 };
  let totalPrice = 0;
  let allFeasible = true;
  let minPMeet = 1;
  const margins = new Float64Array(trials);
  const credits = new Float64Array(trials);
  const anyCredit = new Uint8Array(trials);
  // Pooling benefit: independent assets do not all fail together, so the portfolio's
  // standard deviation is below the sum of the individual ones. Shrink each asset's risk
  // loading by that ratio (a single asset keeps ratio 1). Asset selection above stays
  // on the un-pooled (conservative) price.
  const opsTotal = new Float64Array(trials);
  const creditTotal = new Float64Array(trials);
  picks.forEach(({ cand }) => {
    for (let t = 0; t < trials; t++) {
      opsTotal[t] += cand.opsCost[t];
      creditTotal[t] += cand.eval.creditFrac[t] * (Number.isFinite(cand.price) ? cand.price : 0);
    }
  });
  const sumSdOps = picks.reduce((s, p) => s + p.cand.sdOps, 0);
  const diversOps = sumSdOps > 0 ? clamp(stdevOf(opsTotal, meanOf(opsTotal)) / sumSdOps, 0.2, 1) : 1;
  const sumSdCredit = picks.reduce((s, p) => s + p.cand.eval.sdCredit * (Number.isFinite(p.cand.price) ? p.cand.price : 0), 0);
  const diversCredit = sumSdCredit > 0 ? clamp(stdevOf(creditTotal, meanOf(creditTotal)) / sumSdCredit, 0.2, 1) : 1;
  const finite = picks.map(({ cand }) => {
    if (!Number.isFinite(cand.price)) return 0;
    const loaded = cand.eval.meanCredit + A.riskAversionZ * cand.eval.sdCredit * diversCredit;
    const den = 1 - A.overheadPct - A.targetMarginPct - loaded;
    return den >= 0.2 ? (cand.meanOps + A.riskAversionZ * cand.sdOps * diversOps) / den : cand.price;
  });
  const sumPrice = finite.reduce((s, n) => s + n, 0);

  picks.forEach(({ ctx, cand, meetsRequirement }, i) => {
    const feasible = meetsRequirement && cand.feasible;
    if (!feasible) allFeasible = false;
    minPMeet = Math.min(minPMeet, cand.eval.pMeet);
    const price = finite[i];
    totalPrice += price;
    const pooledCredit = cand.eval.meanCredit + A.riskAversionZ * cand.eval.sdCredit * diversCredit;
    const comp: CostComponents = {
      maintenance: cand.maintenanceCost,
      intervention: cand.interventionCost,
      riskMargin: A.riskAversionZ * cand.sdOps * diversOps,
      creditReserve: pooledCredit * price,
      overhead: A.overheadPct * price,
      margin: A.targetMarginPct * price,
    };
    (Object.keys(comp) as Array<keyof CostComponents>).forEach((k) => (components[k] += comp[k]));
    const notes: string[] = [];
    if (!meetsRequirement) notes.push(`Cannot reach ${round2(A.minPMeetProbability * 100)}% confidence of meeting ${targetPct}% even with ${cand.visits} PM visits/yr.`);
    if (!cand.feasible) notes.push('Credit exposure is too large relative to the fee at this target.');
    if (ctx.est.dataConfidence < A.minDataConfidence) notes.push('Thin repair history: price leans on equipment-type priors.');
    assets.push({
      id: ctx.input.id,
      label: ctx.input.label,
      equipmentType: ctx.input.equipmentType,
      pmVisitsPerYear: cand.visits,
      baseFailuresPerYear: round2(ctx.est.baseRate * ctx.est.overdueMult),
      plannedFailuresPerYear: round2(cand.lambdaEff),
      expectedDowntimeHours: round2(cand.meanDowntime),
      expectedUptimePct: round2((1 - cand.meanDowntime / ctx.input.operatingHoursPerYear) * 100),
      pMeetTarget: round2(cand.eval.pMeet),
      expectedCreditPct: round2(cand.eval.meanCredit * 100),
      dataConfidence: round2(ctx.est.dataConfidence),
      priceAnnual: round2(price),
      priceMonthly: round2(price / 12),
      priceMonthlyCents: price > 0 ? Math.ceil((price * 100) / 12 - 1e-9) : 0,
      priceAnnualCents: price > 0 ? Math.ceil((price * 100) / 12 - 1e-9) * 12 : 0,
      components: comp,
      feasible,
      notes,
    });
  });

  // Portfolio trial t = same trial index across assets (assets are independent: distinct seeds).
  const overheadTotal = A.overheadPct * sumPrice;
  for (let t = 0; t < trials; t++) {
    let revenue = 0;
    let cost = overheadTotal;
    let creditAmt = 0;
    let any = 0;
    picks.forEach(({ cand }, i) => {
      const price = finite[i];
      const cf = cand.eval.creditFrac[t];
      revenue += price * (1 - cf);
      cost += cand.opsCost[t];
      creditAmt += price * cf;
      if (cf > 0) any = 1;
    });
    margins[t] = sumPrice > 0 ? (revenue - cost) / sumPrice : 0;
    credits[t] = sumPrice > 0 ? creditAmt / sumPrice : 0;
    anyCredit[t] = any;
  }
  const sortedM = Float64Array.from(margins).sort();
  const sortedC = Float64Array.from(credits).sort();
  let losses = 0;
  let anyCount = 0;
  for (let t = 0; t < trials; t++) {
    if (margins[t] < 0) losses++;
    anyCount += anyCredit[t];
  }
  const risk: PortfolioRisk = {
    expectedMarginPct: round2(meanOf(margins) * 100),
    p10MarginPct: round2(quantile(sortedM, 0.1) * 100),
    probabilityOfLoss: round2(losses / trials),
    expectedCreditPct: round2(meanOf(credits) * 100),
    p90CreditPct: round2(quantile(sortedC, 0.9) * 100),
    probabilityAnyCredit: round2(anyCount / trials),
  };
  return { assets, totalPrice, components, risk, allFeasible, minPMeet };
}

function decide(
  allFeasible: boolean,
  risk: PortfolioRisk,
  dataConfidence: number,
  A: PricingAssumptions,
  assets: AssetPricing[]
): { decision: Decision; reasons: string[] } {
  const reasons: string[] = [];
  if (!allFeasible) {
    const bad = assets.filter((a) => !a.feasible).map((a) => a.label);
    reasons.push(`Not deliverable at the required confidence: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}.`);
    reasons.push('Lower the target, exclude these assets, or replace/repair them first.');
    return { decision: 'not_offerable', reasons };
  }
  if (dataConfidence < A.minDataConfidence) reasons.push('Repair history is thin — a person should confirm the failure assumptions.');
  if (risk.expectedMarginPct < A.minExpectedMarginPct * 100) reasons.push(`Expected margin ${risk.expectedMarginPct}% is below the ${A.minExpectedMarginPct * 100}% floor.`);
  if (risk.probabilityOfLoss > 0.15) reasons.push(`Probability of losing money on this contract is ${Math.round(risk.probabilityOfLoss * 100)}%.`);
  return reasons.length ? { decision: 'needs_review', reasons } : { decision: 'offerable', reasons: ['Within all pricing guardrails.'] };
}

export function priceOutcomeGuarantee(input: PricingInput): PricingResult {
  const errors = validatePricingInput(input);
  if (errors.length) throw new Error(errors[0]);

  const A: PricingAssumptions = { ...DEFAULT_ASSUMPTIONS, ...(input.assumptions ?? {}) };
  const schedule = input.creditSchedule ?? DEFAULT_CREDIT_SCHEDULE;
  const capFrac = (input.annualCreditCapPct ?? DEFAULT_ANNUAL_CREDIT_CAP_PCT) / 100;
  const trials = clamp(Math.round(input.trials ?? 1500), 200, 6000);
  const salt = input.seedSalt ?? 'vireek';
  const termYears = input.termMonths / 12;

  const contexts = input.assets.map((a) => buildContext(a, termYears, A, salt));
  const dataConfidence = round2(meanOf(contexts.map((c) => c.est.dataConfidence)));

  const pickFor = (target: number): PortfolioPick[] =>
    contexts.map((ctx) => {
      const { cand, meetsRequirement } = bestCandidate(ctx, trials, A, target, schedule, capFrac);
      return { ctx, cand, meetsRequirement };
    });

  // Curve first (simulations are cached per asset+visits, so the main target is nearly free).
  const curveTargets = Array.from(new Set([...(input.curveTargets ?? DEFAULT_CURVE_TARGETS), input.targetUptimePct])).sort((a, b) => a - b);
  const curve: CurvePoint[] = curveTargets.map((target) => {
    const asm = assemble(pickFor(target), trials, A, target);
    const d = decide(asm.allFeasible, asm.risk, dataConfidence, A, asm.assets);
    return {
      targetUptimePct: target,
      priceAnnual: asm.allFeasible ? round2(asm.totalPrice) : 0,
      pMeetTarget: round2(asm.minPMeet),
      expectedMarginPct: asm.risk.expectedMarginPct,
      decision: d.decision,
    };
  });

  const target = input.targetUptimePct;
  const picks = pickFor(target);
  const asm = assemble(picks, trials, A, target);
  const { decision, reasons } = decide(asm.allFeasible, asm.risk, dataConfidence, A, asm.assets);

  // Customer value: compare to buying the same work Time & Materials.
  let tm = 0;
  let avoidedHours = 0;
  let avoidedValue = 0;
  picks.forEach(({ ctx, cand }) => {
    const p = ctx.est.prior;
    const rec = Math.max(1, 12 / Math.max(1, ctx.input.serviceIntervalMonths));
    const noPmRate = ctx.est.baseRate * ctx.est.overdueMult;
    const ticket = A.tripCharge + p.repairHours * A.billRatePerHour + p.partsCost * (1 + A.partsMarkupPct);
    tm += rec * (A.tripCharge + p.pmHours * A.billRatePerHour) + noPmRate * ticket;
    const baseDown = noPmRate * ctx.meanDuration;
    const avoided = Math.max(0, baseDown - cand.meanDowntime);
    avoidedHours += avoided;
    avoidedValue += avoided * ctx.input.downtimeCostPerHour;
  });
  const price = asm.allFeasible ? asm.totalPrice : 0;
  const value: CustomerValue = {
    tmEquivalentAnnual: round2(tm),
    downtimeHoursAvoided: round2(avoidedHours),
    downtimeValueAvoided: round2(avoidedValue),
    netBenefitAnnual: round2(tm + avoidedValue - price),
    priceVsTmPct: tm > 0 && price > 0 ? round2(((price - tm) / tm) * 100) : null,
  };

  // Cents are authoritative and add up exactly: contract total = sum of per-asset (12 x monthly).
  const priceMonthlyCents = asm.allFeasible ? asm.assets.reduce((s, a) => s + a.priceMonthlyCents, 0) : 0;
  const priceAnnualCents = priceMonthlyCents * 12;
  const comp = asm.components;
  (Object.keys(comp) as Array<keyof CostComponents>).forEach((k) => (comp[k] = round2(comp[k])));

  return {
    modelVersion: PRICING_MODEL_VERSION,
    targetUptimePct: target,
    termMonths: input.termMonths,
    assets: asm.assets,
    priceAnnualCents,
    priceMonthlyCents,
    priceTermCents: Math.round((priceAnnualCents * input.termMonths) / 12),
    components: comp,
    risk: asm.risk,
    value,
    dataConfidence,
    decision,
    reasons,
    curve,
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

export const centsToDollars = (c: number) => c / 100;
export const dollarsToCents = (d: number) => Math.round(d * 100);

/** Allowed downtime per year in hours for a target (for plain-language display). */
export function allowedDowntimeHours(targetUptimePct: number, operatingHoursPerYear: number): number {
  return round2(((100 - targetUptimePct) / 100) * operatingHoursPerYear);
}

export const DECISION_LABELS: Record<Decision, string> = {
  offerable: 'Offerable',
  needs_review: 'Needs review',
  not_offerable: 'Not offerable',
};

/** Same tier math the database uses when it records a period (kept in sync with SQL). */
export function creditForPeriod(uptimePct: number, targetPct: number, schedule: CreditTier[]): number {
  return tierCredit(targetPct - uptimePct, schedule);
}
