// supabase/functions/_shared/economics/routingEval.ts
//
// Orchestrates a baseline-vs-candidate evaluation for ONE task type and decides with evaluateRoute().
// The model call itself is injected (`run`), so this file is pure, deterministic and unit-testable; the edge function
// economics-routing-eval supplies the real provider calls. A failed run scores 0 for that variant (conservative).

import { evaluateRoute, costDeltaPct, DEFAULT_GATE, type GateConfig, type GateResult } from "./routingGate.ts";
import type { RouteEntryLike } from "./routeOverrides.ts";

export interface EvalCaseLite { id: string; critical?: boolean }
export interface VariantRun { score: number; costMicro: number | null; latencyMs: number; error?: string }
export interface VariantSpec { provider: string; model: string }

export interface RoutingEvalReport {
  task: string; baseline: VariantSpec; candidate: VariantSpec; n: number;
  gate: GateResult;
  cost: { baselineMicroPerCall: number | null; candidateMicroPerCall: number | null; deltaPct: number | null; unpricedRuns: number };
  latencyMsMedian: { baseline: number | null; candidate: number | null };
  errors: { baseline: number; candidate: number };
  recommendation: "enable" | "keep_baseline";
  overrideEntries: RouteEntryLike[] | null;
}

const med = (v: number[]): number | null => {
  if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export async function runRoutingEval<C extends EvalCaseLite>(args: {
  task: string; cases: readonly C[]; baseline: VariantSpec; candidate: VariantSpec;
  run: (c: C, v: VariantSpec) => Promise<VariantRun>; gate?: GateConfig;
}): Promise<RoutingEvalReport> {
  const { task, cases, baseline, candidate } = args;
  const b: VariantRun[] = [], k: VariantRun[] = [];
  for (const c of cases) {
    const safe = async (v: VariantSpec): Promise<VariantRun> => {
      try { return await args.run(c, v); } catch (e) { return { score: 0, costMicro: null, latencyMs: 0, error: e instanceof Error ? e.message : String(e) }; }
    };
    b.push(await safe(baseline)); k.push(await safe(candidate));
  }
  const gate = evaluateRoute(cases.map((c, i) => ({ caseId: c.id, baseline: b[i].score, candidate: k[i].score, critical: c.critical })), args.gate ?? DEFAULT_GATE);
  const priced = (rs: VariantRun[]) => rs.filter((r) => r.costMicro !== null).map((r) => r.costMicro as number);
  const unpricedRuns = [...b, ...k].filter((r) => r.costMicro === null).length;
  const avg = (rs: VariantRun[]) => (unpricedRuns === 0 && rs.length ? priced(rs).reduce((s, x) => s + x, 0) / rs.length : null);
  const bc = avg(b), cc = avg(k);
  const errors = { baseline: b.filter((r) => r.error).length, candidate: k.filter((r) => r.error).length };
  // Enabling requires: the quality gate passed AND a measured, strictly lower cost AND no more errors than the baseline.
  const cheaper = bc !== null && cc !== null && cc < bc;
  const enable = gate.pass && cheaper && errors.candidate <= errors.baseline;
  return {
    task, baseline, candidate, n: gate.n, gate,
    cost: { baselineMicroPerCall: bc, candidateMicroPerCall: cc, deltaPct: bc !== null && cc !== null ? costDeltaPct(bc, cc) : null, unpricedRuns },
    latencyMsMedian: { baseline: med(b.map((r) => r.latencyMs)), candidate: med(k.map((r) => r.latencyMs)) },
    errors, recommendation: enable ? "enable" : "keep_baseline",
    overrideEntries: enable ? [{ provider: candidate.provider, model: candidate.model, priority: 1 }] : null,
  };
}
