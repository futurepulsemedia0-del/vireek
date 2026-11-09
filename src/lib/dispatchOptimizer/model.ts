/**
 * Dispatch Optimizer — compiled model, route simulation and objective.
 *
 * Everything the solver, the replay evaluator, the explainer and the tests share lives here,
 * so "feasible" and "cost" mean exactly one thing everywhere.
 */
import { isValidPoint } from '../dispatchIntelligence.ts';
import { haversineTravel } from './travel.ts';
import {
  DEFAULT_CONFIG,
  DEFAULT_WEIGHTS,
  type GeoPoint,
  type OptConfig,
  type OptInput,
  type OptJob,
  type OptShift,
  type OptTech,
} from './types.ts';

export const MIN = 60_000;

/** Cost scale (“points”). One point ≈ one minute of driving at default weights. */
export const COST = {
  UNASSIGNED_BASE: 1000,
  REVENUE_PER_DOLLAR: 0.5,
  PRIORITY_UNIT: 50,
  EMERGENCY_BONUS: 500,
  BREACH_BASE: 150,
  BREACH_PER_MIN: 3,
  RISK_MAX: 40,
  OVERTIME_PER_MIN: 2,
  FAIRNESS_PER_HOUR: 10,
  PARTS_MISSING: 60,
} as const;

export interface Route {
  idx: number;
  id: string;
  techIdx: number;
  shift: OptShift;
  /** Effective start: not before the shift, “now” or the technician’s availability. */
  startMs: number;
  startNode: number;
  /** No insertions allowed (shift already over, or synthetic holder). */
  closed: boolean;
}

export interface Model {
  cfg: OptConfig;
  nowMs: number;
  techs: OptTech[];
  jobs: OptJob[];
  routes: Route[];
  nodes: Array<GeoPoint | null>;
  jobNode: number[];
  dur: number[];
  lower: number[];
  upper: number[];
  eligible: number[][];
  techIdxById: Map<string, number>;
  jobIdxById: Map<string, number>;
  dayRoutes: Map<string, number[]>;
  /** Fixed jobs that could not be placed in any route: [startMs, endMs] per technician. */
  blocks: Array<Array<[number, number]>>;
  unassignedCost: number[];
  partsMissing(jobIdx: number, techIdx: number): number;
  travel(a: number, b: number): { min: number; known: boolean };
  /** Why a technician cannot take a job (static reasons only). */
  whyNot(jobIdx: number, techIdx: number): string[];
}

const norm = (s: string): string => s.trim().toLowerCase();

export function resolveConfig(partial?: Partial<OptConfig>): OptConfig {
  const c: OptConfig = { ...DEFAULT_CONFIG, ...(partial ?? {}), weights: { ...DEFAULT_WEIGHTS, ...(partial?.weights ?? {}) } };
  const clampW = (n: number): number => (Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : 1);
  c.weights = {
    revenue: clampW(c.weights.revenue),
    travel: clampW(c.weights.travel),
    slaRisk: clampW(c.weights.slaRisk),
    overtimeFairness: clampW(c.weights.overtimeFairness),
  };
  c.maxIterations = Math.max(0, Math.min(500_000, Math.floor(c.maxIterations)));
  c.stagnationLimit = Math.max(1, Math.floor(c.stagnationLimit));
  c.unknownTravelMin = Math.max(0, c.unknownTravelMin);
  c.slaBufferMin = Math.max(1, c.slaBufferMin);
  c.stabilityPenalty = Math.max(0, c.stabilityPenalty);
  return c;
}

export function buildModel(input: OptInput): Model {
  const cfg = resolveConfig(input.config);
  const techs = input.techs;
  const jobs = input.jobs;
  const travelFn = input.travel ?? haversineTravel();
  const nowMs = input.nowMs;

  const techIdxById = new Map(techs.map((t, i) => [t.id, i]));
  const jobIdxById = new Map(jobs.map((j, i) => [j.id, i]));

  const nodes: Array<GeoPoint | null> = [];
  const techNode = techs.map((t) => {
    nodes.push(isValidPoint(t.start) ? t.start : null);
    return nodes.length - 1;
  });
  const jobNode = jobs.map((j) => {
    nodes.push(isValidPoint(j.point) ? j.point : null);
    return nodes.length - 1;
  });

  const N = nodes.length;
  const cache = new Float64Array(N * N).fill(Number.NaN);
  const travel = (a: number, b: number): { min: number; known: boolean } => {
    const k = a * N + b;
    let v = cache[k]!;
    if (Number.isNaN(v)) {
      const r = a === b ? 0 : travelFn(nodes[a]!, nodes[b]!);
      v = r === null || !Number.isFinite(r) || r < 0 ? -1 : r;
      cache[k] = v;
    }
    return v < 0 ? { min: cfg.unknownTravelMin, known: false } : { min: v, known: true };
  };

  const routes: Route[] = [];
  const dayRoutes = new Map<string, number[]>();
  techs.forEach((t, techIdx) => {
    const shifts = [...t.shifts].sort((a, b) => a.startMs - b.startMs);
    shifts.forEach((shift, si) => {
      const startMs = Math.max(shift.startMs, t.availableFromMs ?? Number.NEGATIVE_INFINITY, nowMs);
      const hardEnd = shift.endMs + Math.max(0, t.maxOvertimeMin) * MIN;
      const idx = routes.length;
      routes.push({ idx, id: `${t.id}#${si}`, techIdx, shift, startMs, startNode: techNode[techIdx]!, closed: startMs >= hardEnd });
      const list = dayRoutes.get(shift.dayKey) ?? [];
      list.push(idx);
      dayRoutes.set(shift.dayKey, list);
    });
  });

  const techSkills = techs.map((t) => new Set(t.skills.map(norm)));
  const techCerts = techs.map((t) => new Set(t.certifications.map(norm)));

  const dur = jobs.map((j) => (Number.isFinite(j.durationMin) && j.durationMin > 0 ? j.durationMin : 60));
  const lower = jobs.map((j) => {
    let lo = Math.max(j.earliestMs ?? Number.NEGATIVE_INFINITY, j.window?.startMs ?? Number.NEGATIVE_INFINITY);
    if (j.lock === 'full' && j.current.startMs !== null) lo = Math.max(lo, j.current.startMs);
    return lo;
  });
  const upper = jobs.map((j) => {
    let hi = j.window?.endMs ?? Number.POSITIVE_INFINITY;
    if (cfg.slaHard && j.slaDeadlineMs !== null) hi = Math.min(hi, j.slaDeadlineMs);
    if (j.lock === 'full' && j.current.startMs !== null) hi = Math.min(hi, j.current.startMs);
    return hi;
  });

  const partsMissing = (jobIdx: number, techIdx: number): number => {
    const fit = input.partsFit?.[jobs[jobIdx]!.id]?.[techs[techIdx]!.id];
    if (!fit || !(fit.required > 0)) return 0;
    return Math.max(0, Math.min(1, 1 - fit.onVan / fit.required));
  };

  const staticReasons = (jobIdx: number, techIdx: number): string[] => {
    const j = jobs[jobIdx]!;
    const t = techs[techIdx]!;
    const out: string[] = [];
    if (j.lock !== 'none' && j.current.techId !== t.id) out.push('Job is locked to another technician');
    const missingSkills = j.requiredSkills.filter((s) => !techSkills[techIdx]!.has(norm(s)));
    if (missingSkills.length) out.push(`Missing skill: ${missingSkills.join(', ')}`);
    const missingCerts = j.requiredCerts.filter((c) => !techCerts[techIdx]!.has(norm(c)));
    if (missingCerts.length) out.push(`Missing certification: ${missingCerts.join(', ')}`);
    if (cfg.partsPolicy === 'hard' && partsMissing(jobIdx, techIdx) > 0) out.push('Van does not carry the required parts');
    return out;
  };

  const eligible = jobs.map((j, ji) => {
    const list: number[] = [];
    for (const r of routes) {
      if (r.closed) continue;
      if (staticReasons(ji, r.techIdx).length) continue;
      const t = techs[r.techIdx]!;
      const start = Math.max(r.startMs, lower[ji]!);
      if (start > upper[ji]!) continue;
      if (start + dur[ji]! * MIN > r.shift.endMs + Math.max(0, t.maxOvertimeMin) * MIN) continue;
      if (j.lock === 'full' && !(j.current.startMs !== null && j.current.startMs >= r.shift.startMs && j.current.startMs < r.shift.endMs + Math.max(0, t.maxOvertimeMin) * MIN)) continue;
      list.push(r.idx);
    }
    return list;
  });

  const w = cfg.weights;
  const unassignedCost = jobs.map(
    (j) =>
      COST.UNASSIGNED_BASE +
      w.revenue * ((Math.max(0, j.revenueCents) / 100) * COST.REVENUE_PER_DOLLAR + Math.max(1, j.priority) * COST.PRIORITY_UNIT + (j.emergency ? COST.EMERGENCY_BONUS : 0)),
  );

  const whyNot = (jobIdx: number, techIdx: number): string[] => {
    const reasons = staticReasons(jobIdx, techIdx);
    const t = techs[techIdx]!;
    if (t.shifts.length === 0) reasons.push('Not working in this period (shift or time off)');
    else if (!reasons.length && !eligible[jobIdx]!.some((ri) => routes[ri]!.techIdx === techIdx)) reasons.push('No shift with enough time before the deadline, window or overtime limit');
    return reasons;
  };

  return {
    cfg,
    nowMs,
    techs,
    jobs,
    routes,
    nodes,
    jobNode,
    dur,
    lower,
    upper,
    eligible,
    techIdxById,
    jobIdxById,
    dayRoutes,
    blocks: techs.map(() => []),
    unassignedCost,
    partsMissing,
    travel,
    whyNot,
  };
}

// ---------------------------------------------------------------------------
// Route simulation
// ---------------------------------------------------------------------------

export interface Walk {
  ok: boolean;
  violations: number;
  note: string | null;
  cost: number;
  travelMin: number;
  slaCost: number;
  slaMisses: number;
  slaLateMin: number;
  overtimeMin: number;
  serviceMin: number;
  workMin: number;
  unknownLegs: number;
  starts: number[];
  ends: number[];
  legMin: number[];
  legKnown: boolean[];
  lateMin: number[];
}

const FAILED: Walk = {
  ok: false,
  violations: 1,
  note: null,
  cost: Number.POSITIVE_INFINITY,
  travelMin: 0,
  slaCost: 0,
  slaMisses: 0,
  slaLateMin: 0,
  overtimeMin: 0,
  serviceMin: 0,
  workMin: 0,
  unknownLegs: 0,
  starts: [],
  ends: [],
  legMin: [],
  legKnown: [],
  lateMin: [],
};

export const EMPTY_WALK: Walk = { ...FAILED, ok: true, violations: 0, cost: 0 };

/**
 * Simulates one shift route. strict: stop at the first hard violation (solver use).
 * loose: count violations and keep going (replay of an existing schedule).
 * `lowerOverride` replaces a job's earliest start (replay: the planned start time).
 */
export function walkRoute(m: Model, r: Route, seq: readonly number[], strict: boolean, lowerOverride?: ReadonlyMap<number, number>): Walk {
  if (seq.length === 0) return EMPTY_WALK;
  const tech = m.techs[r.techIdx]!;
  const w = m.cfg.weights;
  const hardEnd = r.shift.endMs + Math.max(0, tech.maxOvertimeMin) * MIN;
  const blocks = m.blocks[r.techIdx]!;

  let violations = 0;
  let note: string | null = null;
  const flag = (msg: string): boolean => {
    violations++;
    if (note === null) note = msg;
    return strict;
  };

  if (seq.length > Math.max(1, tech.maxJobsPerShift) && flag('capacity') ) return { ...FAILED, note };

  const starts: number[] = [];
  const ends: number[] = [];
  const legMin: number[] = [];
  const legKnown: boolean[] = [];
  const lateMin: number[] = [];
  let t = r.startMs;
  let prev = r.startNode;
  let travelMin = 0;
  let serviceMin = 0;
  let slaCost = 0;
  let slaMisses = 0;
  let slaLateMin = 0;
  let unknownLegs = 0;
  let partsCost = 0;
  let stabCost = 0;

  for (let k = 0; k < seq.length; k++) {
    const j = seq[k]!;
    const job = m.jobs[j]!;
    const leg = m.travel(prev, m.jobNode[j]!);
    if (!leg.known) unknownLegs++;
    const arrive = t + leg.min * MIN;
    const lo = lowerOverride?.has(j) ? Math.max(lowerOverride.get(j)!, m.lower[j]!) : m.lower[j]!;
    const start = Math.max(arrive, lo);
    if (start > m.upper[j]! && flag('outside customer window or fixed time')) return { ...FAILED, note };
    const end = start + m.dur[j]! * MIN;
    if (end > hardEnd && flag('beyond overtime limit')) return { ...FAILED, note };
    for (const [bs, be] of blocks) {
      if (start < be && bs < end && flag('overlaps a fixed job')) return { ...FAILED, note };
    }

    let late = 0;
    if (job.slaDeadlineMs !== null) {
      const mult = (1 + (Math.max(1, job.priority) - 1) * 0.25) * (job.emergency ? 2 : 1);
      const slackMin = (job.slaDeadlineMs - start) / MIN;
      if (slackMin < 0) {
        late = -slackMin;
        slaMisses++;
        slaLateMin += late;
        slaCost += (COST.BREACH_BASE + COST.BREACH_PER_MIN * late) * mult;
      } else if (slackMin < m.cfg.slaBufferMin) {
        slaCost += (COST.RISK_MAX * (m.cfg.slaBufferMin - slackMin)) / m.cfg.slaBufferMin * mult;
      }
    }
    const miss = m.partsMissing(j, r.techIdx);
    if (miss > 0) partsCost += miss * COST.PARTS_MISSING;
    if (job.current.techId !== null && job.current.techId !== tech.id) stabCost += m.cfg.stabilityPenalty;

    travelMin += leg.min;
    serviceMin += m.dur[j]!;
    starts.push(start);
    ends.push(end);
    legMin.push(leg.min);
    legKnown.push(leg.known);
    lateMin.push(late);
    t = end;
    prev = m.jobNode[j]!;
  }

  const overtimeMin = Math.max(0, t - r.shift.endMs) / MIN;
  const cost = w.travel * travelMin + w.slaRisk * slaCost + w.overtimeFairness * COST.OVERTIME_PER_MIN * overtimeMin + partsCost + stabCost;
  return {
    ok: violations === 0,
    violations,
    note,
    cost,
    travelMin,
    slaCost,
    slaMisses,
    slaLateMin,
    overtimeMin,
    serviceMin,
    workMin: serviceMin + travelMin,
    unknownLegs,
    starts,
    ends,
    legMin,
    legKnown,
    lateMin,
  };
}

// ---------------------------------------------------------------------------
// State (sequences + cached walks + fairness)
// ---------------------------------------------------------------------------

export interface State {
  seq: number[][];
  walk: Walk[];
  where: Int32Array;
  dayDev: Map<string, number>;
}

/** Σ |workHours − meanHours| over the routes of one day, with optional overrides. */
export function dayDeviationHours(m: Model, s: State, day: string, overrides?: ReadonlyArray<{ r: number; walk: Walk }>): number {
  const ids = m.dayRoutes.get(day);
  if (!ids || ids.length < 2) return 0;
  const vals: number[] = [];
  for (const ri of ids) {
    const o = overrides?.find((c) => c.r === ri);
    vals.push(((o ? o.walk : s.walk[ri]!).workMin) / 60);
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals.reduce((a, b) => a + Math.abs(b - mean), 0);
}

export function emptyState(m: Model): State {
  const s: State = {
    seq: m.routes.map(() => []),
    walk: m.routes.map(() => EMPTY_WALK),
    where: new Int32Array(m.jobs.length).fill(-1),
    dayDev: new Map(),
  };
  for (const day of m.dayRoutes.keys()) s.dayDev.set(day, 0);
  return s;
}

export function refreshDay(m: Model, s: State, day: string): void {
  s.dayDev.set(day, dayDeviationHours(m, s, day));
}

/** Cost change if `changes` replaced those routes' walks and `unassignedDelta` (negative = jobs placed). */
export function deltaCost(m: Model, s: State, changes: ReadonlyArray<{ r: number; walk: Walk }>, unassignedDelta: number): number {
  let d = unassignedDelta;
  const days = new Set<string>();
  for (const c of changes) {
    d += c.walk.cost - s.walk[c.r]!.cost;
    days.add(m.routes[c.r]!.shift.dayKey);
  }
  const wf = m.cfg.weights.overtimeFairness * COST.FAIRNESS_PER_HOUR;
  for (const day of days) d += wf * (dayDeviationHours(m, s, day, changes) - (s.dayDev.get(day) ?? 0));
  return d;
}

export function commitChanges(m: Model, s: State, changes: ReadonlyArray<{ r: number; seq: number[]; walk: Walk }>): void {
  const days = new Set<string>();
  for (const c of changes) {
    s.seq[c.r] = c.seq;
    s.walk[c.r] = c.walk;
    days.add(m.routes[c.r]!.shift.dayKey);
    for (const j of c.seq) s.where[j] = c.r;
  }
  for (const day of days) refreshDay(m, s, day);
}

export function stateFromSequences(m: Model, seqs: number[][], strict = false): State {
  const s = emptyState(m);
  seqs.forEach((seq, ri) => {
    s.seq[ri] = [...seq];
    s.walk[ri] = walkRoute(m, m.routes[ri]!, seq, strict);
    for (const j of seq) s.where[j] = ri;
  });
  for (const day of m.dayRoutes.keys()) refreshDay(m, s, day);
  return s;
}

export function totalCost(m: Model, s: State): { total: number; unassigned: number; travel: number; sla: number; overtime: number; fairness: number; parts: number; stability: number } {
  const w = m.cfg.weights;
  let unassigned = 0;
  for (let j = 0; j < m.jobs.length; j++) if (s.where[j] === -1) unassigned += m.unassignedCost[j]!;
  let travel = 0;
  let sla = 0;
  let overtime = 0;
  let parts = 0;
  let stability = 0;
  for (let ri = 0; ri < m.routes.length; ri++) {
    const wk = s.walk[ri]!;
    travel += w.travel * wk.travelMin;
    sla += w.slaRisk * wk.slaCost;
    overtime += w.overtimeFairness * COST.OVERTIME_PER_MIN * wk.overtimeMin;
    const tech = m.techs[m.routes[ri]!.techIdx]!;
    for (const j of s.seq[ri]!) {
      parts += m.partsMissing(j, m.routes[ri]!.techIdx) * COST.PARTS_MISSING;
      const cur = m.jobs[j]!.current.techId;
      if (cur !== null && cur !== tech.id) stability += m.cfg.stabilityPenalty;
    }
  }
  let dev = 0;
  for (const v of s.dayDev.values()) dev += v;
  const fairness = w.overtimeFairness * COST.FAIRNESS_PER_HOUR * dev;
  const total = unassigned + travel + sla + overtime + fairness + parts + stability;
  return { total, unassigned, travel, sla, overtime, fairness, parts, stability };
}

export function cloneState(s: State): State {
  return { seq: s.seq.map((q) => [...q]), walk: [...s.walk], where: Int32Array.from(s.where), dayDev: new Map(s.dayDev) };
}
