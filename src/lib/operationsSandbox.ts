/**
 * Vireek Operations Sandbox — pure simulation engine (no I/O, fully testable).
 *
 * "Run the business before changing the business."
 *
 * A virtual copy of the operation is calibrated from real jobs, calls, team,
 * invoices and outcomes (see operationsSandboxApi.ts). A scenario (hire,
 * reprice, open a region, put AI on more calls, tighten the SLA) is then
 * played forward month by month for six months.
 *
 * How it stays honest:
 *  - Capacity and demand are modelled separately. Hiring adds capacity, not
 *    demand, so the model shows when extra technicians would sit idle.
 *  - Every baseline input is tagged measured or assumed, and the confidence
 *    score falls with every assumed input.
 *  - Results are P10 / P50 / P90 ranges from a seeded Monte Carlo over the
 *    uncertain parameters, not a single made-up number. Same inputs always
 *    give the same output.
 *  - Guardrails flag saturation, SLA, churn, margin and cash-strain risk
 *    before anything is changed in the real business.
 */

// ============================================================
// CONSTANTS
// ============================================================

export const SIM = {
  horizonMonths: 6,
  runs: 300,
  workdays: 22,
  /** Share of a technician's max jobs/day that is realistically completed. */
  practicalUtilization: 0.8,
  defaultJobsPerDay: 5,
  /** Arrival within this many minutes of the scheduled time counts as on time. */
  slaGraceMinutes: 15,
  /** Share of demand that comes from repeat customers (links churn to revenue). */
  repeatDemandShare: 0.5,
  /** Share of demand lost to peak-day saturation when the team is at its limit. */
  saturationLossShare: 0.12,
  /** Served jobs can never exceed this share of available capacity. */
  capacityCeiling: 0.98,
} as const;

export const SERVICE_FLOOR = { slaPct: 85, utilizationPct: 92 } as const;

// ============================================================
// TYPES
// ============================================================

export type Provenance = 'measured' | 'assumed';

export type BaselineKey =
  | 'jobsPerMonth'
  | 'avgTicket'
  | 'technicians'
  | 'capacity'
  | 'sla'
  | 'calls'
  | 'bookRate'
  | 'rework'
  | 'churn'
  | 'daysToPay';

export interface Baseline {
  jobsPerMonth: number;
  avgTicket: number;
  technicians: number;
  /** Practical jobs one technician completes per month (calibrated, see calibrateBaseline). */
  jobsPerTechMonth: number;
  slaOnTimePct: number;
  callsPerMonth: number;
  /** 0..1 */
  missedCallRate: number;
  /** 0..1, booked calls / answered calls */
  bookRate: number;
  /** 0..1 */
  reworkRate: number;
  /** Customer churn, percent per month */
  churnMonthlyPct: number;
  daysToPay: number;
  provenance: Record<BaselineKey, Provenance>;
  sample: { jobs: number; calls: number; customers: number; windowMonths: number };
}

export interface Assumptions {
  /** Fully loaded monthly cost of one technician (USD). */
  techMonthlyCost: number;
  /** Parts + materials as a share of revenue, 0..1. */
  materialsPct: number;
  /** Fuel, vehicle and travel cost of one truck roll (USD). */
  truckRollCost: number;
  /** Fixed overhead as a share of today's revenue, 0..1. */
  overheadPct: number;
  /** Price elasticity of demand (negative). */
  priceElasticity: number;
  /** Response-time commitment in force today (hours). */
  responseHours: number;
  /** Staff cost avoided per call that AI takes over from a person (USD). */
  staffCostPerCall: number;
  /** One-off cost to recruit and equip one technician (USD). */
  recruitCost: number;
  /** Customer churn, percent per month. Only used while the twin has no measured churn. */
  churnMonthlyPct: number;
}

export type LeverType = 'hire_technicians' | 'price_change' | 'new_region' | 'ai_call_coverage' | 'sla_target';

export interface LeverInstance {
  type: LeverType;
  params: Record<string, number>;
}

export interface LeverField {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  suffix: string;
  help?: string;
}

export interface LeverDef {
  type: LeverType;
  label: string;
  question: string;
  description: string;
  fields: LeverField[];
}

export type MetricKey =
  | 'revenue'
  | 'grossProfit'
  | 'marginPct'
  | 'utilizationPct'
  | 'slaPct'
  | 'churnPct'
  | 'jobsPerTechDay'
  | 'truckRolls'
  | 'cashFlow';

export interface MetricsSnapshot {
  jobs: number;
  revenue: number;
  grossProfit: number;
  marginPct: number;
  utilizationPct: number;
  slaPct: number;
  churnPct: number;
  jobsPerTechDay: number;
  truckRolls: number;
  cashFlow: number;
}

export interface MonthState extends MetricsSnapshot {
  month: number;
  demand: number;
  capacity: number;
  headcount: number;
  oneTimeCost: number;
}

export interface Range {
  p10: number;
  p50: number;
  p90: number;
}

export type Severity = 'high' | 'medium' | 'low';
export type VerdictKey = 'recommended' | 'proceed_with_guardrails' | 'not_recommended' | 'inconclusive';

export interface Risk {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  mitigation: string;
}

export interface Driver {
  tone: 'positive' | 'negative' | 'neutral';
  title: string;
  detail: string;
}

export interface SimulationResult {
  baseline: MetricsSnapshot;
  projected: MetricsSnapshot;
  baselineTimeline: MonthState[];
  timeline: MonthState[];
  deltas: Record<MetricKey, number>;
  ranges: Record<MetricKey, Range>;
  cash: {
    cumulativeDelta: number[];
    trough: number;
    troughMonth: number;
    /** First month the cumulative cash difference is back at or above zero; null if not within the horizon. */
    paybackMonth: number | null;
    sixMonthDelta: number;
  };
  probability: { runRateUplift: number; cashPositive: number };
  confidence: { score: number; label: 'high' | 'medium' | 'low'; reasons: string[] };
  verdict: { key: VerdictKey; headline: string; summary: string };
  drivers: Driver[];
  risks: Risk[];
  binding: 'demand' | 'capacity';
}

// ============================================================
// DEFAULTS
// ============================================================

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  techMonthlyCost: 6800,
  materialsPct: 0.24,
  truckRollCost: 38,
  overheadPct: 0.14,
  priceElasticity: -0.8,
  responseHours: 4,
  staffCostPerCall: 3.5,
  recruitCost: 3000,
  churnMonthlyPct: 2.5,
};

export interface AssumptionField {
  key: keyof Assumptions;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  /** Shown as a percentage in the UI while stored as a 0..1 ratio. */
  asPercent?: boolean;
  prefix?: string;
  suffix?: string;
}

export const ASSUMPTION_FIELDS: AssumptionField[] = [
  { key: 'techMonthlyCost', label: 'Technician cost / month', help: 'Wage, payroll tax, benefits, vehicle, tools.', min: 1000, max: 30000, step: 100, prefix: '$' },
  { key: 'materialsPct', label: 'Parts & materials', help: 'Share of revenue spent on parts and materials.', min: 0, max: 0.8, step: 0.01, asPercent: true, suffix: '%' },
  { key: 'truckRollCost', label: 'Cost per truck roll', help: 'Fuel, wear and travel time of one dispatch.', min: 0, max: 400, step: 1, prefix: '$' },
  { key: 'overheadPct', label: 'Fixed overhead', help: 'Office, software, insurance as a share of today\'s revenue.', min: 0, max: 0.6, step: 0.01, asPercent: true, suffix: '%' },
  { key: 'priceElasticity', label: 'Price elasticity', help: 'Demand change per 1% price change. -0.8 means a 10% price rise loses about 8% of volume.', min: -2.2, max: -0.1, step: 0.05 },
  { key: 'responseHours', label: 'Response commitment today', help: 'Hours to arrival you currently promise customers.', min: 0.5, max: 48, step: 0.5, suffix: ' h' },
  { key: 'staffCostPerCall', label: 'Staff cost per call', help: 'Cost avoided when AI answers a call a person used to take.', min: 0, max: 40, step: 0.5, prefix: '$' },
  { key: 'recruitCost', label: 'Cost to hire one technician', help: 'Recruiting, onboarding, uniform, tools (one-off).', min: 0, max: 30000, step: 250, prefix: '$' },
  { key: 'churnMonthlyPct', label: 'Customer churn / month', help: 'Used until memberships provide a measured rate.', min: 0.2, max: 15, step: 0.1, suffix: '%' },
];

export function sanitizeAssumptions(raw: unknown): Assumptions {
  const out: Assumptions = { ...DEFAULT_ASSUMPTIONS };
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const f of ASSUMPTION_FIELDS) {
    const v = src[f.key];
    if (typeof v === 'number' && Number.isFinite(v)) out[f.key] = clamp(v, f.min, f.max);
  }
  return out;
}

/** Used when the account has no usable history yet. Every field is flagged as assumed. */
export function defaultBaseline(): Baseline {
  const technicians = 4;
  const jobsPerTechMonth = SIM.defaultJobsPerDay * SIM.practicalUtilization * SIM.workdays;
  const jobsPerMonth = Math.round(technicians * jobsPerTechMonth * 0.72);
  return calibrateBaseline({
    jobsPerMonth,
    avgTicket: 420,
    technicians,
    jobsPerTechMonth,
    slaOnTimePct: 88,
    callsPerMonth: 320,
    missedCallRate: 0.18,
    bookRate: 0.38,
    reworkRate: 0.08,
    churnMonthlyPct: 2.5,
    daysToPay: 18,
    provenance: {
      jobsPerMonth: 'assumed',
      avgTicket: 'assumed',
      technicians: 'assumed',
      capacity: 'assumed',
      sla: 'assumed',
      calls: 'assumed',
      bookRate: 'assumed',
      rework: 'assumed',
      churn: 'assumed',
      daysToPay: 'assumed',
    },
    sample: { jobs: 0, calls: 0, customers: 0, windowMonths: 0 },
  });
}

/**
 * Keeps the twin self-consistent: it must never claim today's volume exceeds
 * today's capacity (which would make every scenario nonsensical).
 */
export function calibrateBaseline(b: Baseline): Baseline {
  const technicians = Math.max(1, Math.round(b.technicians));
  const needed = b.jobsPerMonth / (technicians * SIM.capacityCeiling * 0.99);
  return {
    ...b,
    technicians,
    jobsPerMonth: Math.max(1, b.jobsPerMonth),
    avgTicket: Math.max(1, b.avgTicket),
    jobsPerTechMonth: Math.max(b.jobsPerTechMonth, needed, 1),
    slaOnTimePct: clamp(b.slaOnTimePct, 20, 99.5),
    missedCallRate: clamp(b.missedCallRate, 0, 0.95),
    bookRate: clamp(b.bookRate, 0.02, 0.95),
    reworkRate: clamp(b.reworkRate, 0.005, 0.4),
    churnMonthlyPct: clamp(b.churnMonthlyPct, 0.2, 15),
    daysToPay: clamp(b.daysToPay, 0, 120),
    callsPerMonth: Math.max(0, b.callsPerMonth),
  };
}

// ============================================================
// LEVERS
// ============================================================

export const LEVER_DEFS: LeverDef[] = [
  {
    type: 'hire_technicians',
    label: 'Hire technicians',
    question: 'What if I hire more technicians?',
    description: 'Adds capacity and cost immediately. New hires reach full productivity after the ramp.',
    fields: [
      { key: 'count', label: 'Technicians to hire', min: 1, max: 15, step: 1, default: 3, suffix: '' },
      { key: 'rampMonths', label: 'Months to full productivity', min: 1, max: 6, step: 1, default: 2, suffix: ' mo' },
    ],
  },
  {
    type: 'price_change',
    label: 'Change prices',
    question: 'What if I change prices?',
    description: 'Moves ticket size against expected volume loss and churn.',
    fields: [{ key: 'pct', label: 'Price change', min: -20, max: 30, step: 1, default: 8, suffix: '%' }],
  },
  {
    type: 'new_region',
    label: 'Open a new region',
    question: 'What if I open a new region?',
    description: 'New demand at maturity, paid for with setup cost, longer drives and a ramp-up period.',
    fields: [
      { key: 'demandPct', label: 'New demand at maturity', min: 5, max: 60, step: 1, default: 15, suffix: '% of today\'s jobs', help: 'Extra monthly jobs the region produces once mature.' },
      { key: 'setupCost', label: 'Setup cost', min: 0, max: 60000, step: 500, default: 6000, suffix: ' USD', help: 'Marketing launch, permits, signage.' },
      { key: 'drivePenaltyPct', label: 'Extra drive time', min: 0, max: 40, step: 1, default: 12, suffix: '%', help: 'Capacity lost to longer drives on region jobs.' },
      { key: 'rampMonths', label: 'Months to mature', min: 1, max: 9, step: 1, default: 4, suffix: ' mo' },
    ],
  },
  {
    type: 'ai_call_coverage',
    label: 'AI answers more calls',
    question: 'What if AI answers more of my calls?',
    description: 'Recovers calls that go unanswered and takes routine calls off your staff.',
    fields: [{ key: 'pct', label: 'Share of inbound calls AI answers', min: 5, max: 60, step: 1, default: 20, suffix: '%' }],
  },
  {
    type: 'sla_target',
    label: 'Change the SLA',
    question: 'What if I change my response-time commitment?',
    description: 'A tighter promise lifts conversion and retention but needs reserve capacity and more dispatches.',
    fields: [{ key: 'toHours', label: 'New response commitment', min: 0.5, max: 24, step: 0.5, default: 2, suffix: ' h' }],
  },
];

export function leverDef(type: LeverType): LeverDef {
  const def = LEVER_DEFS.find((d) => d.type === type);
  if (!def) throw new Error(`Unknown lever: ${type}`);
  return def;
}

export function defaultLever(type: LeverType): LeverInstance {
  const def = leverDef(type);
  return { type, params: Object.fromEntries(def.fields.map((f) => [f.key, f.default])) };
}

export interface Preset {
  id: string;
  label: string;
  description: string;
  levers: LeverInstance[];
}

export const PRESETS: Preset[] = [
  { id: 'hire-3', label: 'Hire 3 technicians', description: 'Capacity vs idle time and cash.', levers: [{ type: 'hire_technicians', params: { count: 3, rampMonths: 2 } }] },
  { id: 'price-8', label: 'Raise prices 8%', description: 'Margin gain vs lost volume.', levers: [{ type: 'price_change', params: { pct: 8 } }] },
  { id: 'region', label: 'Open a new region', description: 'New demand vs drive time and setup.', levers: [{ type: 'new_region', params: { demandPct: 15, setupCost: 6000, drivePenaltyPct: 12, rampMonths: 4 } }] },
  { id: 'ai-20', label: 'AI answers 20% of calls', description: 'Recovered calls and staff time.', levers: [{ type: 'ai_call_coverage', params: { pct: 20 } }] },
  { id: 'sla-2h', label: 'SLA 4h → 2h', description: 'Faster promise vs reserve capacity.', levers: [{ type: 'sla_target', params: { toHours: 2 } }] },
  {
    id: 'growth-combo',
    label: 'Growth bundle',
    description: '2 hires + AI on 25% of calls + 5% price rise.',
    levers: [
      { type: 'hire_technicians', params: { count: 2, rampMonths: 2 } },
      { type: 'ai_call_coverage', params: { pct: 25 } },
      { type: 'price_change', params: { pct: 5 } },
    ],
  },
];

interface Resolved {
  hire?: { count: number; ramp: number };
  price?: { pct: number };
  region?: { demandPct: number; setupCost: number; drivePenaltyPct: number; ramp: number };
  ai?: { pct: number };
  sla?: { toHours: number };
}

function param(lever: LeverInstance, key: string): number {
  const field = leverDef(lever.type).fields.find((f) => f.key === key);
  if (!field) throw new Error(`Unknown field ${key} on ${lever.type}`);
  const raw = lever.params[key];
  const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : field.default;
  return clamp(v, field.min, field.max);
}

/** One lever per type (the last one wins); every parameter is clamped to its allowed range. */
export function resolveLevers(levers: LeverInstance[]): Resolved {
  const r: Resolved = {};
  for (const l of levers) {
    switch (l.type) {
      case 'hire_technicians':
        r.hire = { count: Math.round(param(l, 'count')), ramp: param(l, 'rampMonths') };
        break;
      case 'price_change':
        r.price = { pct: param(l, 'pct') };
        break;
      case 'new_region':
        r.region = { demandPct: param(l, 'demandPct'), setupCost: param(l, 'setupCost'), drivePenaltyPct: param(l, 'drivePenaltyPct'), ramp: param(l, 'rampMonths') };
        break;
      case 'ai_call_coverage':
        r.ai = { pct: param(l, 'pct') };
        break;
      case 'sla_target':
        r.sla = { toHours: param(l, 'toHours') };
        break;
    }
  }
  return r;
}

// ============================================================
// MATH HELPERS
// ============================================================

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Pressure curve: 0 up to 70% utilization, rising sharply toward 100%. */
function saturation(u: number): number {
  return Math.pow(clamp((u - 0.7) / 0.3, 0, 1.2), 2);
}

/** Share of demand lost because the team is stretched. */
function demandLoss(u: number): number {
  return SIM.saturationLossShare * clamp((u - 0.8) / 0.2, 0, 1);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function randn(rng: () => number): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ============================================================
// CORE: ONE MONTH-BY-MONTH RUN
// ============================================================

interface Draw {
  elasticity: number;
  rampMult: number;
  demandReal: number;
  productivity: number;
  churnSens: number;
  aiConv: number;
}

function centralDraw(a: Assumptions): Draw {
  return { elasticity: a.priceElasticity, rampMult: 1, demandReal: 1, productivity: 1, churnSens: 1, aiConv: 0.9 };
}

function randomDraw(a: Assumptions, rng: () => number): Draw {
  return {
    elasticity: clamp(a.priceElasticity + 0.25 * randn(rng), -2.2, -0.15),
    rampMult: 0.75 + 0.75 * rng(),
    demandReal: clamp(1 + 0.25 * randn(rng), 0.5, 1.5),
    productivity: clamp(1 + 0.08 * randn(rng), 0.8, 1.15),
    churnSens: 0.7 + 0.7 * rng(),
    aiConv: clamp(0.9 + 0.1 * randn(rng), 0.6, 1.1),
  };
}

function simulateTimeline(b: Baseline, a: Assumptions, r: Resolved, d: Draw): MonthState[] {
  const H = SIM.horizonMonths;
  const T = b.technicians;
  const cap0 = T * b.jobsPerTechMonth;
  const ticket = b.avgTicket;
  const R0 = b.jobsPerMonth * ticket;

  // Latent demand: what would be requested if peak-day saturation did not turn jobs away.
  let D0 = b.jobsPerMonth;
  for (let i = 0; i < 12; i++) D0 = b.jobsPerMonth / (1 - demandLoss(D0 / cap0));
  const sat0 = saturation(b.jobsPerMonth / cap0);

  const hireCount = r.hire?.count ?? 0;
  const headcount = T + hireCount;
  const priceP = (r.price?.pct ?? 0) / 100;
  const slaLog = r.sla ? clamp(Math.log2(a.responseHours / r.sla.toHours), -3, 3) : 0;
  const reserve = clamp(0.1 * Math.max(0, slaLog), 0, 0.35);
  const collectedNow = clamp(1 - b.daysToPay / 30, 0.1, 1);
  const overhead = a.overheadPct * R0;
  const missedCalls = b.callsPerMonth * b.missedCallRate;

  const out: MonthState[] = [];
  let cumChurnDelta = 0;
  let prevRevenue = R0;
  let prevSla = b.slaOnTimePct;

  for (let t = 1; t <= H; t++) {
    const hireRamp = hireCount > 0 ? clamp(t / Math.max(1, (r.hire?.ramp ?? 1) * d.rampMult), 0.2, 1) : 0;
    const effTechs = T + hireCount * Math.min(1, hireRamp * d.productivity);

    const regionRamp = r.region ? clamp(t / Math.max(1, r.region.ramp * d.rampMult), 0, 1) : 0;
    const regionShare = r.region ? (r.region.demandPct / 100) * regionRamp * d.demandReal : 0;
    const regionWork = regionShare / (1 + regionShare);
    const driveLoss = r.region ? (r.region.drivePenaltyPct / 100) * regionWork : 0;

    const capacity = effTechs * b.jobsPerTechMonth * (1 - reserve) * (1 - driveLoss);

    // ---- demand ----
    const priceVol = Math.pow(1 + priceP, d.elasticity);
    const slaLift = 1 + 0.025 * slaLog + 0.0015 * (prevSla - b.slaOnTimePct);
    const retention = clamp(1 - SIM.repeatDemandShare * cumChurnDelta, 0.5, 1.5);
    let aiJobs = 0;
    let aiSaving = 0;
    if (r.ai) {
      const aiRamp = Math.min(1, t / 2);
      const aiCalls = b.callsPerMonth * (r.ai.pct / 100);
      const recovered = Math.min(aiCalls, missedCalls);
      aiJobs = recovered * b.bookRate * d.aiConv * d.demandReal * aiRamp;
      aiSaving = Math.max(0, aiCalls - recovered) * a.staffCostPerCall * aiRamp;
    }
    const demand = D0 * priceVol * slaLift * (1 + regionShare) * retention + aiJobs;

    // ---- served work ----
    const served = Math.max(0, Math.min(demand * (1 - demandLoss(demand / Math.max(capacity, 1))), capacity * SIM.capacityCeiling));
    const util = capacity > 0 ? served / capacity : 0;
    const uSla = clamp(served / Math.max(capacity / Math.max(1 - reserve, 0.01), 1), 0, 1.2);

    // ---- service quality ----
    const headroom = clamp((uSla - 0.5) / 0.4, 0.25, 1.2);
    const tightPenalty = slaLog > 0 ? 9 * slaLog * headroom : -5.4 * Math.abs(slaLog);
    const sla = clamp(b.slaOnTimePct + 22 * (sat0 - saturation(uSla)) - tightPenalty + reserve * 70 * headroom, 20, 98);

    const priceChurn = priceP > 0 ? 0.045 * Math.max(0, priceP * 100 - 2) : 0.01 * priceP * 100;
    const slaChurn = -0.1 * slaLog;
    const satChurn = 0.3 * (saturation(uSla) - sat0);
    const aiChurn = r.ai ? -0.04 * Math.min(1, r.ai.pct / 30) * Math.min(1, t / 2) : 0;
    const churnMult = clamp(1 + (priceChurn + slaChurn + satChurn + aiChurn) * d.churnSens, 0.5, 2.5);
    const churnPct = b.churnMonthlyPct * churnMult;
    cumChurnDelta += (churnPct - b.churnMonthlyPct) / 100;

    // ---- dispatches ----
    const newHireRework = headcount > 0 ? 0.02 * (hireCount / headcount) * (1 - Math.min(1, hireRamp)) : 0;
    const rework = clamp(b.reworkRate * (1 + 0.6 * (saturation(uSla) - sat0)) + newHireRework, 0.005, 0.45);
    const truckRolls = served * (1 + rework) * (1 + 0.04 * Math.max(0, slaLog));

    // ---- money ----
    const revenue = served * ticket * (1 + priceP);
    const materials = served * ticket * a.materialsPct;
    const labor = headcount * a.techMonthlyCost;
    const rollCost = truckRolls * a.truckRollCost * (1 + (r.region ? (r.region.drivePenaltyPct / 100) * regionWork : 0));
    const grossProfit = revenue - materials - labor - rollCost + aiSaving;
    const oneTime = t === 1 ? hireCount * a.recruitCost + (r.region?.setupCost ?? 0) : 0;
    const collected = collectedNow * revenue + (1 - collectedNow) * prevRevenue;
    const cashFlow = collected - (materials + labor + rollCost + overhead + oneTime - aiSaving);

    out.push({
      month: t,
      jobs: served,
      revenue,
      grossProfit,
      marginPct: revenue > 0 ? (grossProfit / revenue) * 100 : 0,
      utilizationPct: util * 100,
      slaPct: sla,
      churnPct,
      jobsPerTechDay: served / Math.max(1, headcount) / SIM.workdays,
      truckRolls,
      cashFlow,
      demand,
      capacity,
      headcount,
      oneTimeCost: oneTime,
    });
    prevRevenue = revenue;
    prevSla = sla;
  }
  return out;
}

const snapshot = (m: MonthState): MetricsSnapshot => ({
  jobs: m.jobs,
  revenue: m.revenue,
  grossProfit: m.grossProfit,
  marginPct: m.marginPct,
  utilizationPct: m.utilizationPct,
  slaPct: m.slaPct,
  churnPct: m.churnPct,
  jobsPerTechDay: m.jobsPerTechDay,
  truckRolls: m.truckRolls,
  cashFlow: m.cashFlow,
});

// ============================================================
// METRIC PRESENTATION
// ============================================================

export interface MetricDef {
  key: MetricKey;
  label: string;
  hint: string;
  /** Which direction is an improvement. */
  better: 'up' | 'down' | 'neutral';
}

export const METRIC_DEFS: MetricDef[] = [
  { key: 'revenue', label: 'Revenue / month', hint: 'Invoiced revenue from completed jobs', better: 'up' },
  { key: 'marginPct', label: 'Gross margin', hint: 'After parts, technician cost and truck rolls', better: 'up' },
  { key: 'utilizationPct', label: 'Technician utilization', hint: 'Booked work vs available capacity', better: 'neutral' },
  { key: 'slaPct', label: 'SLA on time', hint: 'Arrivals inside the promised window', better: 'up' },
  { key: 'churnPct', label: 'Customer churn / month', hint: 'Customers lost per month', better: 'down' },
  { key: 'jobsPerTechDay', label: 'Technician workload', hint: 'Jobs per technician per working day', better: 'neutral' },
  { key: 'truckRolls', label: 'Truck rolls / month', hint: 'Dispatches including rework visits', better: 'down' },
  { key: 'cashFlow', label: 'Cash flow / month', hint: 'Cash in minus cash out, with payment lag', better: 'up' },
];

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function formatMetric(key: MetricKey, v: number): string {
  if (!Number.isFinite(v)) return '—';
  switch (key) {
    case 'revenue':
    case 'grossProfit':
    case 'cashFlow':
      return usd0.format(v);
    case 'marginPct':
    case 'utilizationPct':
    case 'slaPct':
      return `${v.toFixed(1)}%`;
    case 'churnPct':
      return `${v.toFixed(2)}%`;
    case 'jobsPerTechDay':
      return v.toFixed(1);
    case 'truckRolls':
      return Math.round(v).toLocaleString('en-US');
  }
}

/** Percentage-point metrics read better as "+2.1 pts" than "+3%". */
export function formatDelta(key: MetricKey, delta: number): string {
  if (!Number.isFinite(delta)) return '—';
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  const abs = Math.abs(delta);
  switch (key) {
    case 'revenue':
    case 'grossProfit':
    case 'cashFlow':
      return `${sign}${usd0.format(abs)}`;
    case 'marginPct':
    case 'utilizationPct':
    case 'slaPct':
      return `${sign}${abs.toFixed(1)} pts`;
    case 'churnPct':
      return `${sign}${abs.toFixed(2)} pts`;
    case 'jobsPerTechDay':
      return `${sign}${abs.toFixed(1)}`;
    case 'truckRolls':
      return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
  }
}

export type DeltaTone = 'good' | 'bad' | 'neutral';

export function deltaTone(key: MetricKey, delta: number): DeltaTone {
  const def = METRIC_DEFS.find((m) => m.key === key);
  const eps: Record<MetricKey, number> = { revenue: 1, grossProfit: 1, marginPct: 0.05, utilizationPct: 0.5, slaPct: 0.1, churnPct: 0.01, jobsPerTechDay: 0.05, truckRolls: 1, cashFlow: 1 };
  if (!def || Math.abs(delta) < eps[key]) return 'neutral';
  if (def.better === 'neutral') return 'neutral';
  const up = delta > 0;
  return (def.better === 'up') === up ? 'good' : 'bad';
}

// ============================================================
// PUBLIC: RUN A SCENARIO
// ============================================================

const EXTRA_KEYS: MetricKey[] = ['grossProfit'];
const ALL_KEYS: MetricKey[] = [...METRIC_DEFS.map((m) => m.key), ...EXTRA_KEYS];

export function runScenario(baselineInput: Baseline, assumptions: Assumptions, levers: LeverInstance[], runs: number = SIM.runs): SimulationResult {
  const a = assumptions;
  const b = calibrateBaseline(baselineInput.provenance.churn === 'assumed' ? { ...baselineInput, churnMonthlyPct: a.churnMonthlyPct } : baselineInput);
  const resolved = resolveLevers(levers);
  const hasLevers = levers.length > 0;

  const baselineTimeline = simulateTimeline(b, a, {}, centralDraw(a));
  const timeline = simulateTimeline(b, a, resolved, centralDraw(a));
  const base = baselineTimeline[SIM.horizonMonths - 1];
  const last = timeline[SIM.horizonMonths - 1];

  const baseline = snapshot(base);
  const projected = snapshot(last);
  const deltas = Object.fromEntries(ALL_KEYS.map((k) => [k, projected[k] - baseline[k]])) as Record<MetricKey, number>;

  // ---- cash curve vs doing nothing ----
  const cumulativeDelta: number[] = [];
  let run = 0;
  timeline.forEach((m, i) => {
    run += m.cashFlow - baselineTimeline[i].cashFlow;
    cumulativeDelta.push(run);
  });
  const trough = Math.min(0, ...cumulativeDelta);
  const troughMonth = trough < 0 ? cumulativeDelta.indexOf(trough) + 1 : 0;
  let paybackMonth: number | null = null;
  if (trough >= 0) paybackMonth = 0;
  else {
    for (let i = troughMonth; i < cumulativeDelta.length; i++) {
      if (cumulativeDelta[i] >= 0) {
        paybackMonth = i + 1;
        break;
      }
    }
  }

  // ---- Monte Carlo (seeded: identical inputs always give identical output) ----
  const rng = mulberry32(hashString(JSON.stringify({ b, a, resolved })));
  const samples: Record<MetricKey, number[]> = Object.fromEntries(ALL_KEYS.map((k) => [k, [] as number[]])) as Record<MetricKey, number[]>;
  let upliftHits = 0;
  let cashHits = 0;
  const n = hasLevers ? Math.max(20, runs) : 1;
  for (let i = 0; i < n; i++) {
    const tl = hasLevers ? simulateTimeline(b, a, resolved, randomDraw(a, rng)) : timeline;
    const m = snapshot(tl[SIM.horizonMonths - 1]);
    for (const k of ALL_KEYS) samples[k].push(m[k]);
    if (m.grossProfit - baseline.grossProfit > 0) upliftHits++;
    const cash = tl.reduce((s, x, idx) => s + x.cashFlow - baselineTimeline[idx].cashFlow, 0);
    if (cash > 0) cashHits++;
  }
  const ranges = Object.fromEntries(
    ALL_KEYS.map((k) => {
      const s = [...samples[k]].sort((x, y) => x - y);
      return [k, { p10: percentile(s, 0.1), p50: percentile(s, 0.5), p90: percentile(s, 0.9) }];
    }),
  ) as Record<MetricKey, Range>;
  const probability = hasLevers ? { runRateUplift: upliftHits / n, cashPositive: cashHits / n } : { runRateUplift: 0, cashPositive: 0 };

  const binding: 'demand' | 'capacity' = last.demand * (1 - demandLoss(last.demand / Math.max(last.capacity, 1))) > last.capacity * SIM.capacityCeiling * 0.97 ? 'capacity' : 'demand';

  const confidence = scoreConfidence(b, ranges.grossProfit, baseline.revenue);
  const risks = hasLevers ? findRisks(baseline, projected, deltas, trough, troughMonth, binding, resolved) : [];
  const drivers = hasLevers ? explainDrivers(b, a, resolved, last, base, binding) : [];
  const verdict = decide(hasLevers, probability.runRateUplift, risks, confidence.label, deltas.grossProfit, paybackMonth);

  return {
    baseline,
    projected,
    baselineTimeline,
    timeline,
    deltas,
    ranges,
    cash: { cumulativeDelta, trough, troughMonth, paybackMonth, sixMonthDelta: run },
    probability,
    confidence,
    verdict,
    drivers,
    risks,
    binding,
  };
}

// ============================================================
// CONFIDENCE, RISKS, DRIVERS, VERDICT
// ============================================================

function scoreConfidence(b: Baseline, gp: Range, revenue: number): SimulationResult['confidence'] {
  const keys = Object.keys(b.provenance) as BaselineKey[];
  const assumed = keys.filter((k) => b.provenance[k] === 'assumed');
  const reasons: string[] = [];
  let score = 100 - assumed.length * 5;
  if (assumed.length > 0) reasons.push(`${assumed.length} of ${keys.length} twin inputs are assumed, not measured. Connect more data or calibrate them to raise confidence.`);
  if (b.sample.jobs < 30) {
    score -= 15;
    reasons.push(`Only ${b.sample.jobs} completed jobs in the window; small samples make baselines noisy.`);
  } else if (b.sample.jobs < 100) {
    score -= 6;
    reasons.push(`${b.sample.jobs} completed jobs in the window; accuracy improves with more history.`);
  }
  const spread = (gp.p90 - gp.p10) / (Math.abs(gp.p50) + 0.05 * Math.max(revenue, 1));
  const spreadPenalty = clamp(spread * 5, 0, 20);
  score -= spreadPenalty;
  if (spreadPenalty >= 10) reasons.push('The outcome is highly sensitive to uncertain parameters (price response, ramp speed, demand realization).');
  score = Math.round(clamp(score, 5, 98));
  return { score, label: score >= 75 ? 'high' : score >= 55 ? 'medium' : 'low', reasons };
}

function findRisks(base: MetricsSnapshot, p: MetricsSnapshot, d: Record<MetricKey, number>, trough: number, troughMonth: number, binding: 'demand' | 'capacity', r: Resolved): Risk[] {
  const risks: Risk[] = [];
  if (p.utilizationPct > SERVICE_FLOOR.utilizationPct) {
    risks.push({ key: 'saturation', severity: 'high', title: 'Team runs at the limit', detail: `Utilization reaches ${p.utilizationPct.toFixed(0)}%, so late arrivals, rework and lost jobs rise sharply.`, mitigation: 'Add capacity, cap daily bookings, or stage the change in smaller steps.' });
  } else if (p.utilizationPct > 85) {
    risks.push({ key: 'saturation', severity: 'medium', title: 'Little capacity headroom', detail: `Utilization reaches ${p.utilizationPct.toFixed(0)}%, leaving no buffer for emergencies.`, mitigation: 'Hold an emergency reserve or add part-time or overflow capacity.' });
  }
  if (p.slaPct < 80 || d.slaPct < -8) {
    risks.push({ key: 'sla', severity: 'high', title: 'SLA falls sharply', detail: `On-time arrivals drop to ${p.slaPct.toFixed(0)}% (${formatDelta('slaPct', d.slaPct)}).`, mitigation: 'Pair the change with reserve capacity or a softer commitment.' });
  } else if (p.slaPct < SERVICE_FLOOR.slaPct || d.slaPct < -4) {
    risks.push({ key: 'sla', severity: 'medium', title: 'SLA under pressure', detail: `On-time arrivals fall to ${p.slaPct.toFixed(0)}% (${formatDelta('slaPct', d.slaPct)}).`, mitigation: 'Watch on-time rate weekly during rollout.' });
  }
  if (d.churnPct > 0.5) {
    risks.push({ key: 'churn', severity: 'high', title: 'Customer churn rises', detail: `Monthly churn grows by ${d.churnPct.toFixed(2)} pts, which compounds into lost repeat revenue.`, mitigation: 'Grandfather loyal customers or soften the change for repeat accounts.' });
  } else if (d.churnPct > 0.25) {
    risks.push({ key: 'churn', severity: 'medium', title: 'Churn edges up', detail: `Monthly churn grows by ${d.churnPct.toFixed(2)} pts.`, mitigation: 'Track repeat-customer rate and satisfaction after the change.' });
  }
  if (d.marginPct < -3) {
    risks.push({ key: 'margin', severity: 'high', title: 'Margin erodes', detail: `Gross margin drops ${Math.abs(d.marginPct).toFixed(1)} pts.`, mitigation: 'Revisit pricing or stage costs behind proven demand.' });
  } else if (d.marginPct < -1.5) {
    risks.push({ key: 'margin', severity: 'medium', title: 'Margin slips', detail: `Gross margin drops ${Math.abs(d.marginPct).toFixed(1)} pts.`, mitigation: 'Confirm the extra volume or price covers the added cost.' });
  }
  const strain = base.revenue > 0 ? -trough / base.revenue : 0;
  if (strain > 0.25) {
    risks.push({ key: 'cash', severity: 'high', title: 'Heavy cash strain', detail: `Cash is ${usd0.format(-trough)} below the do-nothing path by month ${troughMonth}.`, mitigation: 'Confirm cash runway or phase the investment.' });
  } else if (strain > 0.1) {
    risks.push({ key: 'cash', severity: 'medium', title: 'Cash dip before payback', detail: `Cash is ${usd0.format(-trough)} below the do-nothing path by month ${troughMonth}.`, mitigation: 'Make sure you can fund the dip before committing.' });
  }
  if (r.hire && binding === 'demand' && p.utilizationPct < 60) {
    risks.push({ key: 'idle', severity: 'medium', title: 'New capacity would sit idle', detail: `Utilization falls to ${p.utilizationPct.toFixed(0)}%: demand, not capacity, is the constraint today.`, mitigation: 'Pair hiring with demand growth (AI call coverage, a new region) or hire fewer.' });
  }
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return risks.sort((x, y) => order[x.severity] - order[y.severity]);
}

function explainDrivers(b: Baseline, a: Assumptions, r: Resolved, last: MonthState, base: MonthState, binding: 'demand' | 'capacity'): Driver[] {
  const out: Driver[] = [];
  const jobsDelta = last.jobs - base.jobs;
  if (r.hire) {
    const slots = Math.round(r.hire.count * b.jobsPerTechMonth);
    out.push(
      binding === 'demand' && last.utilizationPct < 75
        ? { tone: 'negative', title: `+${r.hire.count} technicians add ${slots} job slots, but demand fills only part of them`, detail: `Jobs change by ${jobsDelta >= 0 ? '+' : '−'}${Math.abs(Math.round(jobsDelta))} per month while labor cost rises ${usd0.format(r.hire.count * a.techMonthlyCost)}.` }
        : { tone: 'positive', title: `+${r.hire.count} technicians unlock ${Math.max(0, Math.round(jobsDelta))} more jobs per month`, detail: 'Capacity was the constraint, so extra technicians convert waiting demand into revenue.' },
    );
  }
  if (r.price) {
    const vol = last.demand / Math.max(base.demand, 1) - 1;
    out.push({ tone: r.price.pct >= 0 ? 'positive' : 'neutral', title: `${r.price.pct >= 0 ? '+' : ''}${r.price.pct}% price moves volume ${vol >= 0 ? '+' : '−'}${Math.abs(vol * 100).toFixed(1)}%`, detail: `At elasticity ${a.priceElasticity.toFixed(2)}, each job earns ${usd0.format(b.avgTicket * (1 + r.price.pct / 100))} against ${usd0.format(b.avgTicket)} today. Parts cost does not rise with price.` });
  }
  if (r.region) {
    out.push({ tone: 'neutral', title: `New region reaches ${r.region.demandPct}% extra demand after about ${r.region.ramp} months`, detail: `Longer drives cost ${r.region.drivePenaltyPct}% of region capacity and ${usd0.format(r.region.setupCost)} is spent up front.` });
  }
  if (r.ai) {
    const recovered = Math.min(b.callsPerMonth * (r.ai.pct / 100), b.callsPerMonth * b.missedCallRate);
    out.push({ tone: 'positive', title: `AI recovers about ${Math.round(recovered)} unanswered calls per month`, detail: `At a ${(b.bookRate * 100).toFixed(0)}% booking rate that is roughly ${Math.round(recovered * b.bookRate * 0.9)} extra jobs, plus staff time saved on routine calls.` });
  }
  if (r.sla) {
    const reserve = Math.round(clamp(0.1 * Math.max(0, Math.log2(a.responseHours / r.sla.toHours)), 0, 0.35) * 100);
    out.push({ tone: reserve > 0 ? 'neutral' : 'positive', title: `${a.responseHours} h → ${r.sla.toHours} h response promise`, detail: reserve > 0 ? `Needs about ${reserve}% reserve capacity and more dedicated dispatches, in exchange for better conversion and retention.` : 'A looser promise frees capacity but may reduce conversion and retention.' });
  }
  return out;
}

function decide(hasLevers: boolean, uplift: number, risks: Risk[], confidence: 'high' | 'medium' | 'low', gpDelta: number, payback: number | null): SimulationResult['verdict'] {
  if (!hasLevers) return { key: 'inconclusive', headline: 'Add a change to simulate', summary: 'Pick a what-if above or build your own. Nothing changes in the real business.' };
  const highs = risks.filter((r) => r.severity === 'high').length;
  const pctUplift = Math.round(uplift * 100);
  const profitLine = `${pctUplift}% of simulated futures end with higher monthly gross profit${payback !== null && payback > 0 ? `; cash pays back in month ${payback}` : payback === null ? '; cash does not pay back within 6 months' : ''}.`;
  if (uplift >= 0.75 && highs === 0 && gpDelta > 0) {
    if (confidence === 'low') return { key: 'proceed_with_guardrails', headline: 'Promising, but data is thin', summary: `${profitLine} Confidence is low, so validate with a small pilot first.` };
    return { key: 'recommended', headline: 'Recommended', summary: profitLine };
  }
  if (uplift >= 0.55) return { key: 'proceed_with_guardrails', headline: 'Proceed with guardrails', summary: `${profitLine} Review the risks below before committing.` };
  return { key: 'not_recommended', headline: 'Not recommended as configured', summary: `${profitLine} Adjust the change or combine it with demand growth.` };
}
