/**
 * Dispatch Optimizer — constructive insertion + local search.
 *
 * 1. Fixed (lock = full) jobs are placed first and never move.
 * 2. Remaining jobs are inserted one by one at their cheapest feasible position
 *    (most urgent first) — “cheapest insertion with time windows”.
 * 3. Seeded local search (relocate / swap / insert-unassigned) improves the plan.
 *    The only acceptance rule is “strictly better and still 100 % feasible”, so the
 *    plan can never get worse and never breaks a hard constraint.
 *
 * Deterministic: same input + same seed ⇒ identical output (unless the optional
 * wall-clock valve `timeBudgetMs` fires, which is reported in the result).
 */
import { createRng } from './rng.ts';
import {
  OPTIMIZER_ENGINE_VERSION,
  type CostBreakdown,
  type Metrics,
  type OptInput,
  type OptResult,
  type PlacedJob,
  type UnplacedJob,
} from './types.ts';
import {
  MIN,
  buildModel,
  commitChanges,
  deltaCost,
  emptyState,
  refreshDay,
  totalCost,
  walkRoute,
  type Model,
  type State,
  type Walk,
} from './model.ts';

const EPS = 1e-6;

const insertAt = (seq: readonly number[], pos: number, j: number): number[] => [...seq.slice(0, pos), j, ...seq.slice(pos)];
const without = (seq: readonly number[], j: number): number[] => seq.filter((x) => x !== j);

export interface Insertion {
  r: number;
  pos: number;
  walk: Walk;
  delta: number;
}

/** Cheapest feasible insertion of an unplaced job `j` into the given routes (default: all eligible). */
export function bestInsertion(m: Model, s: State, j: number, routes?: readonly number[]): Insertion | null {
  let best: Insertion | null = null;
  for (const r of routes ?? m.eligible[j]!) {
    const route = m.routes[r]!;
    const seq = s.seq[r]!;
    for (let pos = 0; pos <= seq.length; pos++) {
      const w = walkRoute(m, route, insertAt(seq, pos, j), true);
      if (!w.ok) continue;
      const d = deltaCost(m, s, [{ r, walk: w }], -m.unassignedCost[j]!);
      if (!best || d < best.delta - EPS || (Math.abs(d - best.delta) <= EPS && (r < best.r || (r === best.r && pos < best.pos)))) {
        best = { r, pos, walk: w, delta: d };
      }
    }
  }
  return best;
}

function orderForConstruction(m: Model, ids: number[]): number[] {
  const inf = Number.POSITIVE_INFINITY;
  return [...ids].sort((a, b) => {
    const ja = m.jobs[a]!;
    const jb = m.jobs[b]!;
    return (
      Number(jb.emergency) - Number(ja.emergency) ||
      jb.priority - ja.priority ||
      (ja.slaDeadlineMs ?? inf) - (jb.slaDeadlineMs ?? inf) ||
      (ja.window?.startMs ?? inf) - (jb.window?.startMs ?? inf) ||
      m.dur[b]! - m.dur[a]! ||
      ja.id.localeCompare(jb.id)
    );
  });
}

export interface SolveOutcome {
  state: State;
  frozenOut: boolean[];
  iterations: number;
  truncatedByTime: boolean;
}

export function solveModel(m: Model): SolveOutcome {
  const s = emptyState(m);
  const frozenOut: boolean[] = m.jobs.map(() => false);

  // ---- phase 1: fixed jobs --------------------------------------------------
  const fixed = m.jobs.map((_, i) => i).filter((i) => m.jobs[i]!.lock === 'full' && m.jobs[i]!.current.startMs !== null);
  fixed.sort((a, b) => m.jobs[a]!.current.startMs! - m.jobs[b]!.current.startMs! || m.jobs[a]!.id.localeCompare(m.jobs[b]!.id));
  for (const j of fixed) {
    const ins = bestInsertion(m, s, j);
    if (ins) {
      commitChanges(m, s, [{ r: ins.r, seq: insertAt(s.seq[ins.r]!, ins.pos, j), walk: ins.walk }]);
    } else {
      frozenOut[j] = true;
      const techIdx = m.techIdxById.get(m.jobs[j]!.current.techId ?? '');
      if (techIdx !== undefined) {
        const st = m.jobs[j]!.current.startMs!;
        m.blocks[techIdx]!.push([st, st + m.dur[j]! * MIN]);
      }
    }
  }
  // blocks discovered late must not invalidate already-placed fixed jobs silently
  for (let ri = 0; ri < m.routes.length; ri++) {
    const seq = s.seq[ri]!;
    if (!seq.length) continue;
    const w = walkRoute(m, m.routes[ri]!, seq, false);
    s.walk[ri] = w;
  }
  for (const day of m.dayRoutes.keys()) refreshDay(m, s, day);

  // ---- phase 2: constructive insertion --------------------------------------
  const rest = orderForConstruction(
    m,
    m.jobs.map((_, i) => i).filter((i) => m.jobs[i]!.lock !== 'full' || m.jobs[i]!.current.startMs === null),
  );
  for (const j of rest) {
    const ins = bestInsertion(m, s, j);
    if (ins && ins.delta < -EPS) commitChanges(m, s, [{ r: ins.r, seq: insertAt(s.seq[ins.r]!, ins.pos, j), walk: ins.walk }]);
  }

  // ---- phase 3: local search ------------------------------------------------
  const movable = rest;
  const rng = createRng(m.cfg.seed);
  const t0 = m.cfg.timeBudgetMs !== null ? Date.now() : 0;
  let iterations = 0;
  let noImprove = 0;
  let truncatedByTime = false;

  const tryInsertUnassigned = (j: number): boolean => {
    const ins = bestInsertion(m, s, j);
    if (!ins || ins.delta >= -EPS) return false;
    commitChanges(m, s, [{ r: ins.r, seq: insertAt(s.seq[ins.r]!, ins.pos, j), walk: ins.walk }]);
    return true;
  };

  const tryRelocate = (j: number): boolean => {
    const a = s.where[j]!;
    const elig = m.eligible[j]!;
    if (elig.length === 0) return false;
    const seqA = without(s.seq[a]!, j);
    const walkA = walkRoute(m, m.routes[a]!, seqA, true);
    if (!walkA.ok) return false;
    let bestD = -EPS;
    let apply: Array<{ r: number; seq: number[]; walk: Walk }> | null = null;
    const tried = new Set<number>();
    const samples = Math.min(6, elig.length);
    for (let n = 0; n < samples; n++) {
      const b = elig[rng.int(elig.length)]!;
      if (tried.has(b)) continue;
      tried.add(b);
      const base = b === a ? seqA : s.seq[b]!;
      for (let pos = 0; pos <= base.length; pos++) {
        if (b === a && pos === s.seq[a]!.indexOf(j)) {
          /* same slot — still a valid candidate only if different from current order */
        }
        const seqB = insertAt(base, pos, j);
        if (b === a && seqB.length === s.seq[a]!.length && seqB.every((x, i) => x === s.seq[a]![i])) continue;
        const wB = walkRoute(m, m.routes[b]!, seqB, true);
        if (!wB.ok) continue;
        const changes = b === a ? [{ r: b, walk: wB }] : [{ r: a, walk: walkA }, { r: b, walk: wB }];
        const d = deltaCost(m, s, changes, 0);
        if (d < bestD) {
          bestD = d;
          apply = b === a ? [{ r: b, seq: seqB, walk: wB }] : [{ r: a, seq: seqA, walk: walkA }, { r: b, seq: seqB, walk: wB }];
        }
      }
    }
    if (!apply) return false;
    commitChanges(m, s, apply);
    return true;
  };

  const trySwap = (j: number): boolean => {
    const a = s.where[j]!;
    const k = movable[rng.int(movable.length)]!;
    const b = s.where[k]!;
    if (k === j || b < 0 || b === a) return false;
    if (!m.eligible[j]!.includes(b) || !m.eligible[k]!.includes(a)) return false;
    const seqA = s.seq[a]!.map((x) => (x === j ? k : x));
    const seqB = s.seq[b]!.map((x) => (x === k ? j : x));
    const wA = walkRoute(m, m.routes[a]!, seqA, true);
    if (!wA.ok) return false;
    const wB = walkRoute(m, m.routes[b]!, seqB, true);
    if (!wB.ok) return false;
    const d = deltaCost(m, s, [{ r: a, walk: wA }, { r: b, walk: wB }], 0);
    if (d >= -EPS) return false;
    commitChanges(m, s, [{ r: a, seq: seqA, walk: wA }, { r: b, seq: seqB, walk: wB }]);
    return true;
  };

  if (movable.length > 0) {
    while (iterations < m.cfg.maxIterations && noImprove < m.cfg.stagnationLimit) {
      iterations++;
      if (m.cfg.timeBudgetMs !== null && (iterations & 127) === 0 && Date.now() - t0 > m.cfg.timeBudgetMs) {
        truncatedByTime = true;
        break;
      }
      const j = movable[rng.int(movable.length)]!;
      let improved: boolean;
      if (s.where[j] === -1) improved = tryInsertUnassigned(j);
      else improved = rng.next() < 0.7 ? tryRelocate(j) : trySwap(j);
      noImprove = improved ? 0 : noImprove + 1;
    }
  }

  return { state: s, frozenOut, iterations, truncatedByTime };
}

// ---------------------------------------------------------------------------
// Result building
// ---------------------------------------------------------------------------

export function computeMetrics(m: Model, s: State, frozenOut: readonly boolean[]): Metrics {
  let assigned = 0;
  let unassigned = 0;
  let revenueScheduled = 0;
  let revenueUnscheduled = 0;
  for (let j = 0; j < m.jobs.length; j++) {
    if (s.where[j]! >= 0) {
      assigned++;
      revenueScheduled += m.jobs[j]!.revenueCents;
    } else if (!frozenOut[j]) {
      unassigned++;
      revenueUnscheduled += m.jobs[j]!.revenueCents;
    }
  }
  let travelMin = 0;
  let slaMisses = 0;
  let slaLateMin = 0;
  let overtimeMin = 0;
  let serviceMin = 0;
  let availableMin = 0;
  let violations = 0;
  let unknown = 0;
  for (let ri = 0; ri < m.routes.length; ri++) {
    const w = s.walk[ri]!;
    const r = m.routes[ri]!;
    travelMin += w.travelMin;
    slaMisses += w.slaMisses;
    slaLateMin += w.slaLateMin;
    overtimeMin += w.overtimeMin;
    serviceMin += w.serviceMin;
    violations += w.violations;
    unknown += w.unknownLegs;
    if (!r.closed) availableMin += Math.max(0, (r.shift.endMs - r.startMs) / MIN);
  }
  let dev = 0;
  for (const v of s.dayDev.values()) dev += v;
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  return {
    assigned,
    unassigned,
    travelMin: r1(travelMin),
    slaMisses,
    slaLateMin: r1(slaLateMin),
    overtimeMin: r1(overtimeMin),
    utilization: availableMin > 0 ? Math.round((serviceMin / availableMin) * 1000) / 1000 : 0,
    revenueScheduledCents: revenueScheduled,
    revenueUnscheduledCents: revenueUnscheduled,
    fairnessDeviationHours: r1(dev),
    hardViolations: violations,
    unknownTravelLegs: unknown,
  };
}

export function placedJobs(m: Model, s: State): PlacedJob[] {
  const out: PlacedJob[] = [];
  for (let ri = 0; ri < m.routes.length; ri++) {
    const r = m.routes[ri]!;
    const w = s.walk[ri]!;
    s.seq[ri]!.forEach((j, pos) => {
      out.push({
        jobId: m.jobs[j]!.id,
        techId: m.techs[r.techIdx]!.id,
        routeId: r.id,
        dayKey: r.shift.dayKey,
        position: pos,
        startMs: w.starts[pos]!,
        endMs: w.ends[pos]!,
        travelMinFromPrev: Math.round(w.legMin[pos]! * 10) / 10,
        travelKnown: w.legKnown[pos]!,
        slaLateMin: Math.round(w.lateMin[pos]! * 10) / 10,
        overtimeMin: Math.round((Math.max(0, w.ends[pos]! - r.shift.endMs) / MIN) * 10) / 10,
      });
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.jobId.localeCompare(b.jobId));
}

export function unplacedReasons(m: Model, s: State, j: number): string[] {
  const elig = m.eligible[j]!;
  if (elig.length === 0) {
    if (m.techs.length === 0) return ['No technicians available'];
    const tally = new Map<string, number>();
    m.techs.forEach((_, ti) => {
      const rs = m.whyNot(j, ti);
      for (const r of rs.length ? rs : ['No shift with enough time']) tally.set(r, (tally.get(r) ?? 0) + 1);
    });
    return [...tally.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([r, n]) => (m.techs.length === 1 ? r : `${n} of ${m.techs.length} technicians: ${r}`));
  }
  const tally = new Map<string, number>();
  let feasibleButNotWorth = false;
  for (const r of elig) {
    const seq = s.seq[r]!;
    for (let pos = 0; pos <= seq.length; pos++) {
      const w = walkRoute(m, m.routes[r]!, insertAt(seq, pos, j), true);
      if (w.ok) feasibleButNotWorth = true;
      else tally.set(w.note ?? 'constraint', (tally.get(w.note ?? 'constraint') ?? 0) + 1);
    }
  }
  if (feasibleButNotWorth) return ['A slot exists but placing it would cost more than leaving it unscheduled — review the weights'];
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return [`Every eligible slot is full: ${top ? top[0] : 'no room'}`];
}

export function buildResult(m: Model, out: SolveOutcome): OptResult {
  const { state: s } = out;
  const c = totalCost(m, s);
  const cost: CostBreakdown = {
    unassigned: r2(c.unassigned),
    travel: r2(c.travel),
    sla: r2(c.sla),
    overtime: r2(c.overtime),
    fairness: r2(c.fairness),
    parts: r2(c.parts),
    stability: r2(c.stability),
    total: r2(c.total),
  };
  const unplaced: UnplacedJob[] = [];
  m.jobs.forEach((job, j) => {
    if (s.where[j] === -1 && !out.frozenOut[j]) unplaced.push({ jobId: job.id, reasons: unplacedReasons(m, s, j) });
  });
  return {
    engineVersion: OPTIMIZER_ENGINE_VERSION,
    seed: m.cfg.seed,
    placed: placedJobs(m, s),
    unplaced,
    unmodeledFixed: m.jobs.filter((_, j) => out.frozenOut[j]).map((j) => j.id),
    metrics: computeMetrics(m, s, out.frozenOut),
    cost,
    iterations: out.iterations,
    truncatedByTime: out.truncatedByTime,
  };
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Public entry point. Pure; never throws on empty input. */
export function optimize(input: OptInput): OptResult {
  const m = buildModel(input);
  return buildResult(m, solveModel(m));
}
