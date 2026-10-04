/**
 * Event Prediction Mesh — pure forecasting engine.
 *
 * The Event Bus answers "what happened?". The Mesh answers "which events are
 * likely to happen next, and what should we do before they do?".
 *
 * No I/O and no imports: everything here is deterministic, explainable and
 * unit-tested (eventPredictionMesh.test.ts). Data gathering lives in
 * eventPredictionMeshApi.ts.
 *
 * How it works
 *  1. Signals (weather, equipment age, past failures, parts, workforce,
 *     demand, SLA load, sentiment) are normalised to 0..1 "pressure" values.
 *  2. Each of the five forecast events scores a weighted blend of the signals
 *     that are actually available. Missing data never counts as "safe": it
 *     lowers confidence and shrinks the probability toward a base rate.
 *  3. Events are linked by a causal mesh (demand spike -> dispatch pressure
 *     -> SLA breach -> customer escalation, ...). Parent probabilities lift
 *     child probabilities with a noisy-OR rule, so second-order effects show
 *     up before the first-order event has even happened.
 *  4. Predictions at or above the action threshold produce preemptive
 *     actions that a human approves or dismisses. Nothing is executed
 *     automatically.
 */

export const MESH_ENGINE_VERSION = '1.0.0';

export type MeshEventKind =
  'demand_spike' | 'parts_shortage' | 'dispatch_pressure' | 'sla_breach' | 'customer_escalation';

/** Topological order of the causal mesh — parents always come before children. */
export const MESH_EVENT_ORDER: MeshEventKind[] = [
  'demand_spike',
  'parts_shortage',
  'dispatch_pressure',
  'sla_breach',
  'customer_escalation',
];

export const EVENT_LABELS: Record<MeshEventKind, string> = {
  demand_spike: 'Demand spike',
  parts_shortage: 'Parts shortage',
  dispatch_pressure: 'Dispatch pressure',
  sla_breach: 'SLA breach',
  customer_escalation: 'Customer escalation',
};

export const EVENT_DESCRIPTIONS: Record<MeshEventKind, string> = {
  demand_spike: 'Inbound calls and jobs rising well above the normal run rate.',
  parts_shortage: 'Parts needed for upcoming work not available when the job starts.',
  dispatch_pressure: 'More booked work than technicians can absorb in the window.',
  sla_breach: 'Contracted response or completion times at risk of being missed.',
  customer_escalation: 'Unhappy customers likely to escalate, complain or churn.',
};

/** Relative business impact (1–5), used to rank predictions by expected cost. */
export const EVENT_IMPACT: Record<MeshEventKind, number> = {
  demand_spike: 2,
  parts_shortage: 3,
  dispatch_pressure: 3,
  sla_breach: 5,
  customer_escalation: 4,
};

export type MeshLevel = 'low' | 'elevated' | 'high' | 'critical';

export const LEVEL_LABELS: Record<MeshLevel, string> = {
  low: 'Low',
  elevated: 'Elevated',
  high: 'High',
  critical: 'Critical',
};

export const LEVEL_COLORS: Record<MeshLevel, string> = {
  low: 'bg-success-500/10 text-success-500',
  elevated: 'bg-accent/10 text-accent',
  high: 'bg-warning-500/10 text-warning-500',
  critical: 'bg-danger/10 text-danger',
};

export const LEVEL_THRESHOLDS = { elevated: 0.3, high: 0.55, critical: 0.75 } as const;

export function levelOf(probability: number): MeshLevel {
  if (probability >= LEVEL_THRESHOLDS.critical) return 'critical';
  if (probability >= LEVEL_THRESHOLDS.high) return 'high';
  if (probability >= LEVEL_THRESHOLDS.elevated) return 'elevated';
  return 'low';
}

// ============================================================
// SIGNALS (engine inputs). A null group means "source unavailable".
// ============================================================

export interface MeshSignals {
  horizonHours: number;
  weather: { activeAlerts: number; severeAlerts: number; surgeModeActive: boolean } | null;
  equipment: {
    activeCount: number;
    nearEndOfLifeShare: number;
    serviceOverdueShare: number;
  } | null;
  failures: { recentRatePct: number | null; priorRatePct: number | null; sample: number } | null;
  parts: {
    backorderedOnUpcoming: number;
    neededOnUpcoming: number;
    belowReorderShare: number;
    trackedParts: number;
  } | null;
  workforce: {
    activeTechnicians: number;
    /** Total job capacity across the whole horizon (sum of max jobs/day x days). */
    horizonCapacityJobs: number;
    upcomingJobs: number;
    unassignedUpcoming: number;
  } | null;
  demand: {
    recentDaily: number;
    baselineDaily: number;
    missedRatePct: number;
    emergenciesRecent: number;
  } | null;
  sla: {
    upcomingSlaJobs: number;
    unassignedSlaJobs: number;
    dueWithin24h: number;
    recentBreaches30d: number;
  } | null;
  sentiment: {
    negativeShareRecent: number | null;
    callsRecent: number;
    openReworkJobs: number;
    openRecoverySignals: number;
  } | null;
  unavailableSources: string[];
}

export const EMPTY_SIGNALS: MeshSignals = {
  horizonHours: 72,
  weather: null,
  equipment: null,
  failures: null,
  parts: null,
  workforce: null,
  demand: null,
  sla: null,
  sentiment: null,
  unavailableSources: [],
};

// ============================================================
// SMALL MATH HELPERS
// ============================================================

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
/** Saturating curve: 0 at x<=0, ~0.63 at x=k, approaches 1 for large x. */
const sat = (x: number, k: number): number =>
  x <= 0 || k <= 0 ? 0 : clamp01(1 - Math.exp(-x / k));
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
const round = (n: number, dp = 3): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};
const safeDiv = (a: number, b: number): number => (b > 0 ? a / b : 0);

// ============================================================
// DRIVERS
// ============================================================

export type DriverKey =
  | 'weather'
  | 'equipment_age'
  | 'past_failures'
  | 'parts'
  | 'workforce'
  | 'demand_trend'
  | 'emergencies'
  | 'sla_load'
  | 'sentiment';

export const DRIVER_LABELS: Record<DriverKey, string> = {
  weather: 'Weather',
  equipment_age: 'Equipment age',
  past_failures: 'Past failures',
  parts: 'Parts availability',
  workforce: 'Technician capacity',
  demand_trend: 'Demand trend',
  emergencies: 'Emergency calls',
  sla_load: 'SLA load',
  sentiment: 'Customer sentiment',
};

export interface Driver {
  key: DriverKey;
  /** 0..1 pressure from this signal. */
  value: number;
  /** Weight inside the event's scoring blend. */
  weight: number;
  detail: string;
}

type DriverFn = (s: MeshSignals) => { value: number; detail: string } | null;

const pct = (n: number): string => `${Math.round(n)}%`;

const DRIVER_FNS: Record<DriverKey, DriverFn> = {
  weather: (s) => {
    const w = s.weather;
    if (!w) return null;
    const value = clamp01(
      Math.max(
        sat(w.severeAlerts, 1.2),
        sat(w.activeAlerts, 3) * 0.7,
        w.surgeModeActive ? 0.55 : 0,
      ),
    );
    const detail =
      w.severeAlerts > 0
        ? `${w.severeAlerts} severe weather alert${w.severeAlerts === 1 ? '' : 's'} active`
        : w.activeAlerts > 0
          ? `${w.activeAlerts} weather alert${w.activeAlerts === 1 ? '' : 's'} active`
          : w.surgeModeActive
            ? 'Surge mode is active'
            : 'No active weather alerts';
    return { value, detail };
  },
  equipment_age: (s) => {
    const e = s.equipment;
    if (!e || e.activeCount === 0) return null;
    const value = clamp01(e.nearEndOfLifeShare * 0.7 + e.serviceOverdueShare * 0.3);
    return {
      value,
      detail: `${pct(e.nearEndOfLifeShare * 100)} of tracked equipment near end of life, ${pct(e.serviceOverdueShare * 100)} overdue for service`,
    };
  },
  past_failures: (s) => {
    const f = s.failures;
    if (!f || f.sample < 5 || f.recentRatePct === null) return null;
    const level = sat(f.recentRatePct, 12);
    const trend = f.priorRatePct !== null ? sat(f.recentRatePct - f.priorRatePct, 6) : 0;
    return {
      value: clamp01(level * 0.65 + trend * 0.35),
      detail:
        f.priorRatePct !== null
          ? `Callback/rework rate ${pct(f.recentRatePct)} (was ${pct(f.priorRatePct)})`
          : `Callback/rework rate ${pct(f.recentRatePct)}`,
    };
  },
  parts: (s) => {
    const p = s.parts;
    if (!p) return null;
    const blocked = p.backorderedOnUpcoming * 1 + p.neededOnUpcoming * 0.35;
    const value = clamp01(sat(blocked, 3) * 0.7 + p.belowReorderShare * 0.3);
    return {
      value,
      detail: `${p.backorderedOnUpcoming} backordered and ${p.neededOnUpcoming} unallocated part line${p.neededOnUpcoming === 1 ? '' : 's'} on upcoming jobs; ${pct(p.belowReorderShare * 100)} of parts at or below reorder point`,
    };
  },
  workforce: (s) => {
    const w = s.workforce;
    if (!w) return null;
    if (w.activeTechnicians === 0 && w.upcomingJobs === 0) return null;
    const utilisation =
      w.horizonCapacityJobs > 0
        ? w.upcomingJobs / w.horizonCapacityJobs
        : w.upcomingJobs > 0
          ? 2
          : 0;
    const unassignedShare = safeDiv(w.unassignedUpcoming, w.upcomingJobs);
    const value = clamp01(
      sat(Math.max(0, utilisation - 0.55), 0.55) * 0.75 + unassignedShare * 0.25,
    );
    return {
      value,
      detail: `${w.upcomingJobs} jobs booked vs ~${Math.round(w.horizonCapacityJobs)} job capacity (${pct(utilisation * 100)}); ${w.unassignedUpcoming} unassigned`,
    };
  },
  demand_trend: (s) => {
    const d = s.demand;
    if (!d || d.baselineDaily <= 0) return null;
    const ratio = d.recentDaily / d.baselineDaily;
    return {
      value: sat(ratio - 1, 0.6),
      detail: `${round(d.recentDaily, 1)} calls/day vs ${round(d.baselineDaily, 1)} baseline (${ratio >= 1 ? '+' : ''}${Math.round((ratio - 1) * 100)}%)`,
    };
  },
  emergencies: (s) => {
    const d = s.demand;
    if (!d) return null;
    return {
      value: sat(d.emergenciesRecent, 4),
      detail: `${d.emergenciesRecent} emergency call${d.emergenciesRecent === 1 ? '' : 's'} in the last 7 days`,
    };
  },
  sla_load: (s) => {
    const l = s.sla;
    if (!l) return null;
    if (l.upcomingSlaJobs === 0) return { value: 0, detail: 'No SLA-bound jobs in the window' };
    const value = clamp01(
      safeDiv(l.unassignedSlaJobs, l.upcomingSlaJobs) * 0.45 +
        sat(l.dueWithin24h, 4) * 0.3 +
        sat(l.recentBreaches30d, 3) * 0.25,
    );
    return {
      value,
      detail: `${l.upcomingSlaJobs} SLA-bound jobs, ${l.unassignedSlaJobs} unassigned, ${l.dueWithin24h} starting within 24h; ${l.recentBreaches30d} breach${l.recentBreaches30d === 1 ? '' : 'es'} in the last 30 days`,
    };
  },
  sentiment: (s) => {
    const c = s.sentiment;
    if (!c) return null;
    const neg = c.negativeShareRecent !== null && c.callsRecent >= 5 ? c.negativeShareRecent : null;
    const open = c.openReworkJobs + c.openRecoverySignals;
    if (neg === null && open === 0 && c.callsRecent < 5) return null;
    const value = clamp01(
      (neg !== null ? sat(neg * 100, 25) * 0.6 : 0) + sat(open, 4) * (neg !== null ? 0.4 : 0.8),
    );
    const openText = `${c.openReworkJobs} open rework job${c.openReworkJobs === 1 ? '' : 's'}, ${c.openRecoverySignals} open recovery signal${c.openRecoverySignals === 1 ? '' : 's'}`;
    return {
      value,
      detail: neg !== null ? `${pct(neg * 100)} of recent calls negative; ${openText}` : openText,
    };
  },
};

/** Which drivers feed which event, with weights (each event's weights sum to 1). */
export const EVENT_DRIVER_WEIGHTS: Record<MeshEventKind, Partial<Record<DriverKey, number>>> = {
  demand_spike: {
    weather: 0.3,
    demand_trend: 0.25,
    equipment_age: 0.2,
    past_failures: 0.15,
    emergencies: 0.1,
  },
  parts_shortage: {
    parts: 0.45,
    equipment_age: 0.15,
    past_failures: 0.1,
    weather: 0.1,
    demand_trend: 0.2,
  },
  dispatch_pressure: {
    workforce: 0.45,
    demand_trend: 0.2,
    weather: 0.1,
    emergencies: 0.1,
    sla_load: 0.15,
  },
  sla_breach: { sla_load: 0.3, workforce: 0.25, parts: 0.2, past_failures: 0.15, weather: 0.1 },
  customer_escalation: {
    sentiment: 0.35,
    past_failures: 0.25,
    sla_load: 0.2,
    workforce: 0.1,
    weather: 0.1,
  },
};

/** Base rate used when evidence is thin. */
export const EVENT_BASE_RATE: Record<MeshEventKind, number> = {
  demand_spike: 0.1,
  parts_shortage: 0.12,
  dispatch_pressure: 0.12,
  sla_breach: 0.08,
  customer_escalation: 0.08,
};

/** Causal edges: parent event raises the likelihood of the child event. */
export interface MeshEdge {
  from: MeshEventKind;
  to: MeshEventKind;
  strength: number;
  why: string;
}

export const MESH_EDGES: MeshEdge[] = [
  {
    from: 'demand_spike',
    to: 'dispatch_pressure',
    strength: 0.55,
    why: 'More inbound work competes for the same technicians',
  },
  {
    from: 'demand_spike',
    to: 'parts_shortage',
    strength: 0.35,
    why: 'Higher volume burns through stock faster',
  },
  {
    from: 'parts_shortage',
    to: 'sla_breach',
    strength: 0.5,
    why: 'Missing parts force return visits and delay completion',
  },
  {
    from: 'dispatch_pressure',
    to: 'sla_breach',
    strength: 0.6,
    why: 'Stretched crews miss response windows',
  },
  {
    from: 'dispatch_pressure',
    to: 'customer_escalation',
    strength: 0.25,
    why: 'Long waits and reschedules frustrate customers',
  },
  {
    from: 'sla_breach',
    to: 'customer_escalation',
    strength: 0.65,
    why: 'A missed commitment is the strongest escalation trigger',
  },
];

// ============================================================
// PREDICTIONS
// ============================================================

export interface CascadeContribution {
  from: MeshEventKind;
  /** How much probability this parent added to the child. */
  lift: number;
  why: string;
}

export interface Prediction {
  kind: MeshEventKind;
  label: string;
  /** Final probability after causal propagation. */
  probability: number;
  /** Probability from this event's own evidence only. */
  baseProbability: number;
  /** 0..1 — share of this event's weighting backed by real data. */
  confidence: number;
  level: MeshLevel;
  /** probability * impact — used for ranking. */
  expectedImpact: number;
  drivers: Driver[];
  cascade: CascadeContribution[];
  windowStart: string;
  windowEnd: string;
}

export interface MeshOptions {
  now?: Date;
  /** Probability at or above which preemptive actions are proposed. */
  actionThreshold?: number;
}

export const DEFAULT_ACTION_THRESHOLD = 0.5;

function scoreEvent(
  kind: MeshEventKind,
  signals: MeshSignals,
): { base: number; confidence: number; drivers: Driver[] } {
  const weights = EVENT_DRIVER_WEIGHTS[kind];
  const drivers: Driver[] = [];
  let totalWeight = 0;
  let presentWeight = 0;
  let weighted = 0;

  for (const [key, weight] of Object.entries(weights) as [DriverKey, number][]) {
    totalWeight += weight;
    const out = DRIVER_FNS[key](signals);
    if (!out) continue;
    presentWeight += weight;
    weighted += weight * out.value;
    drivers.push({ key, value: round(out.value), weight, detail: out.detail });
  }

  const confidence = totalWeight > 0 ? presentWeight / totalWeight : 0;
  if (presentWeight === 0) return { base: EVENT_BASE_RATE[kind], confidence: 0, drivers };

  const score = weighted / presentWeight; // 0..1, renormalised over available data
  const raw = sigmoid(7 * (score - 0.45)); // 0.5 at score 0.45
  const prior = EVENT_BASE_RATE[kind];
  // Shrink toward the base rate when evidence is thin (full trust at >=60% coverage).
  const trust = Math.min(1, confidence / 0.6);
  const base = clamp01(prior + (raw - prior) * trust);
  drivers.sort((a, b) => b.value * b.weight - a.value * a.weight);
  return { base, confidence, drivers };
}

export function predictEvents(signals: MeshSignals, options: MeshOptions = {}): Prediction[] {
  const now = options.now ?? new Date();
  const windowStart = now.toISOString();
  const windowEnd = new Date(now.getTime() + signals.horizonHours * 3_600_000).toISOString();

  const byKind = new Map<MeshEventKind, Prediction>();

  for (const kind of MESH_EVENT_ORDER) {
    const { base, confidence, drivers } = scoreEvent(kind, signals);

    // Noisy-OR over parents that have already been finalised.
    let survive = 1 - base;
    const cascade: CascadeContribution[] = [];
    for (const edge of MESH_EDGES) {
      if (edge.to !== kind) continue;
      const parent = byKind.get(edge.from);
      if (!parent) continue;
      const push = clamp01(parent.probability * edge.strength);
      if (push <= 0.005) continue;
      const before = 1 - survive;
      survive *= 1 - push;
      cascade.push({ from: edge.from, lift: round(1 - survive - before), why: edge.why });
    }
    const probability = clamp01(1 - survive);

    byKind.set(kind, {
      kind,
      label: EVENT_LABELS[kind],
      probability: round(probability),
      baseProbability: round(base),
      confidence: round(confidence),
      level: levelOf(probability),
      expectedImpact: round(probability * EVENT_IMPACT[kind], 2),
      drivers,
      cascade,
      windowStart,
      windowEnd,
    });
  }

  return MESH_EVENT_ORDER.map((k) => byKind.get(k) as Prediction);
}

/** Predictions ranked by expected business impact (probability x impact). */
export function rankPredictions(predictions: Prediction[]): Prediction[] {
  return [...predictions].sort(
    (a, b) => b.expectedImpact - a.expectedImpact || b.probability - a.probability,
  );
}

// ============================================================
// DATA COVERAGE
// ============================================================

const SIGNAL_GROUPS = [
  'weather',
  'equipment',
  'failures',
  'parts',
  'workforce',
  'demand',
  'sla',
  'sentiment',
] as const;

/** Fraction (0..1) of signal groups that were available. */
export function dataCoverage(signals: MeshSignals): number {
  const present = SIGNAL_GROUPS.filter((g) => signals[g] !== null).length;
  return round(present / SIGNAL_GROUPS.length, 2);
}

// ============================================================
// PREEMPTIVE ACTIONS
// ============================================================

export type ActionUrgency = 'now' | 'today' | 'this_week';

export const URGENCY_LABELS: Record<ActionUrgency, string> = {
  now: 'Do now',
  today: 'Today',
  this_week: 'This week',
};

export interface PreemptiveAction {
  /** Stable key — lets a newer run supersede an older proposal. */
  key: string;
  kind: MeshEventKind;
  title: string;
  detail: string;
  /** Existing dashboard route that executes the action. */
  href: string;
  urgency: ActionUrgency;
  /** Only proposed when one of these drivers is firing (>= 0.4). Empty = always. */
  triggerDrivers: DriverKey[];
}

export const ACTION_CATALOG: PreemptiveAction[] = [
  {
    key: 'demand_spike.activate_surge',
    kind: 'demand_spike',
    title: 'Switch on Surge Mode before the spike lands',
    detail:
      'Shorten call handling, prioritise emergencies and cap routine bookings while demand is elevated.',
    href: '/dashboard/weather-surge',
    urgency: 'now',
    triggerDrivers: ['weather', 'demand_trend', 'emergencies'],
  },
  {
    key: 'demand_spike.capacity_control',
    kind: 'demand_spike',
    title: 'Tighten demand control and open the waitlist',
    detail:
      'Throttle low-value bookings so emergency and high-value work keeps priority access to capacity.',
    href: '/dashboard/capacity-demand',
    urgency: 'today',
    triggerDrivers: [],
  },
  {
    key: 'parts_shortage.reserve_stock',
    kind: 'parts_shortage',
    title: 'Allocate and reserve parts for upcoming jobs',
    detail: 'Resolve backordered and unallocated part lines before the first affected job starts.',
    href: '/dashboard/inventory',
    urgency: 'now',
    triggerDrivers: ['parts'],
  },
  {
    key: 'parts_shortage.restock_trucks',
    kind: 'parts_shortage',
    title: 'Pre-stock trucks and raise purchase orders',
    detail:
      'Order the fast-moving parts for aging equipment and weather-driven repairs ahead of demand.',
    href: '/dashboard/inventory',
    urgency: 'today',
    triggerDrivers: ['equipment_age', 'weather', 'demand_trend'],
  },
  {
    key: 'dispatch_pressure.assign_jobs',
    kind: 'dispatch_pressure',
    title: 'Assign every open job now',
    detail: 'Clear unassigned work from the board while there is still slack to rebalance.',
    href: '/dashboard/dispatch',
    urgency: 'now',
    triggerDrivers: ['workforce'],
  },
  {
    key: 'dispatch_pressure.call_in_crews',
    kind: 'dispatch_pressure',
    title: 'Activate on-call coverage or borrow capacity',
    detail:
      'Bring in the on-call rotation, or request overflow capacity from the contractor network.',
    href: '/dashboard/on-call',
    urgency: 'today',
    triggerDrivers: [],
  },
  {
    key: 'sla_breach.protect_sla_jobs',
    kind: 'sla_breach',
    title: 'Protect SLA-bound jobs first',
    detail:
      'Pin the most time-critical contract jobs to your best-fit technicians and confirm ETAs.',
    href: '/dashboard/dispatch',
    urgency: 'now',
    triggerDrivers: ['sla_load', 'workforce'],
  },
  {
    key: 'sla_breach.notify_customers',
    kind: 'sla_breach',
    title: 'Warn at-risk customers before the window closes',
    detail:
      'A proactive heads-up with a firm new ETA turns a probable breach into a managed expectation.',
    href: '/dashboard/service-recovery',
    urgency: 'today',
    triggerDrivers: [],
  },
  {
    key: 'customer_escalation.recovery_outreach',
    kind: 'customer_escalation',
    title: 'Start service-recovery outreach',
    detail:
      'Contact customers with rework, long waits or negative calls before they escalate publicly.',
    href: '/dashboard/service-recovery',
    urgency: 'today',
    triggerDrivers: ['sentiment', 'past_failures'],
  },
  {
    key: 'customer_escalation.review_next_actions',
    kind: 'customer_escalation',
    title: 'Review the next-best actions queue',
    detail: 'Work the highest-value retention and recovery actions already ranked for you.',
    href: '/dashboard/next-best-actions',
    urgency: 'this_week',
    triggerDrivers: [],
  },
];

export interface ProposedAction extends PreemptiveAction {
  /** Probability of the event that triggered this proposal. */
  probability: number;
  level: MeshLevel;
}

/** Actions to propose for the given predictions, highest-risk events first. */
export function proposeActions(
  predictions: Prediction[],
  threshold: number = DEFAULT_ACTION_THRESHOLD,
): ProposedAction[] {
  const out: ProposedAction[] = [];
  for (const p of rankPredictions(predictions)) {
    if (p.probability < threshold) continue;
    const firing = new Set(p.drivers.filter((d) => d.value >= 0.4).map((d) => d.key));
    for (const action of ACTION_CATALOG) {
      if (action.kind !== p.kind) continue;
      if (action.triggerDrivers.length > 0 && !action.triggerDrivers.some((k) => firing.has(k)))
        continue;
      out.push({ ...action, probability: p.probability, level: p.level });
    }
  }
  return out;
}

// ============================================================
// CALIBRATION — how right were past forecasts?
// ============================================================

export interface ResolvedPrediction {
  kind: MeshEventKind;
  probability: number;
  observed: boolean;
}

/** Brier score: mean squared error of probabilities. 0 = perfect, 0.25 = coin flip. */
export function brierScore(rows: ResolvedPrediction[]): number | null {
  if (rows.length === 0) return null;
  const sum = rows.reduce((acc, r) => acc + (r.probability - (r.observed ? 1 : 0)) ** 2, 0);
  return round(sum / rows.length, 4);
}

export interface CalibrationBucket {
  label: string;
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number;
  observedRate: number;
}

const BUCKETS: [number, number][] = [
  [0, 0.2],
  [0.2, 0.4],
  [0.4, 0.6],
  [0.6, 0.8],
  [0.8, 1.0001],
];

export function calibrationBuckets(rows: ResolvedPrediction[]): CalibrationBucket[] {
  return BUCKETS.map(([lower, upper]) => {
    const inBucket = rows.filter((r) => r.probability >= lower && r.probability < upper);
    const count = inBucket.length;
    return {
      label: `${Math.round(lower * 100)}–${Math.min(100, Math.round(upper * 100))}%`,
      lower,
      upper,
      count,
      meanPredicted: count ? round(inBucket.reduce((a, r) => a + r.probability, 0) / count) : 0,
      observedRate: count ? round(inBucket.filter((r) => r.observed).length / count) : 0,
    };
  });
}

// ============================================================
// REPORT
// ============================================================

export interface MeshReport {
  engineVersion: string;
  horizonHours: number;
  generatedAt: string;
  dataCoverage: number;
  predictions: Prediction[];
  actions: ProposedAction[];
  signature: string;
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function buildMeshReport(signals: MeshSignals, options: MeshOptions = {}): MeshReport {
  const now = options.now ?? new Date();
  const predictions = predictEvents(signals, { ...options, now });
  const actions = proposeActions(predictions, options.actionThreshold ?? DEFAULT_ACTION_THRESHOLD);
  const fingerprint = predictions.map((p) => `${p.kind}:${p.probability}`).join('|');
  return {
    engineVersion: MESH_ENGINE_VERSION,
    horizonHours: signals.horizonHours,
    generatedAt: now.toISOString(),
    dataCoverage: dataCoverage(signals),
    predictions,
    actions,
    signature: fnv1a(`${MESH_ENGINE_VERSION}|${signals.horizonHours}|${fingerprint}`),
  };
}
