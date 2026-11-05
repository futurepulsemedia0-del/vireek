// supabase/functions/_shared/voice-autopilot/report.ts
//
// Weekly "What improved" report as STRUCTURED data (no prose here): the UI renders every sentence through i18next,
// so the report is translatable and the numbers can never disagree with the stored decision.
// Effect sizes are shown ONLY for concluded experiments, always with the repeated interval; early stops carry a
// "winner's curse" flag because early-stopped estimates are biased upward.

import type { ExperimentDimension } from "./locks.ts";
import type { Decision, MetricId } from "./decision.ts";

export interface ConcludedExperiment {
  id: string;
  name: string;
  scenario: string;
  dimension: ExperimentDimension;
  decision: Decision;
  metric: MetricId;
  /** Challenger minus control, in the metric's units (rates as fractions). */
  estimate: number | null;
  low: number | null;
  high: number | null;
  nControl: number;
  nChallenger: number;
  earlyStop: boolean;
  appliedAction: "promoted" | "awaiting_approval" | "rolled_back" | "stopped" | "none";
  concludedAt: string;
}
export interface RunningExperiment { id: string; name: string; dimension: ExperimentDimension; nMin: number; nTarget: number }
export interface PlannedTest { dimension: ExperimentDimension; scenario: string }

export type ReportItem =
  | { kind: "win"; exp: ConcludedExperiment }
  | { kind: "loss"; exp: ConcludedExperiment }
  | { kind: "inconclusive"; exp: ConcludedExperiment }
  | { kind: "rollback"; exp: ConcludedExperiment }
  | { kind: "running"; exp: RunningExperiment }
  | { kind: "learning"; code: "no_experiments" | "low_volume" | "all_inconclusive" }
  | { kind: "next"; test: PlannedTest };

export interface WeeklyReport { weekStart: string; weekEnd: string; items: ReportItem[]; limitations: ("sequential_intervals" | "early_stop_inflation" | "heuristic_metrics")[] }

/** Round-robin through dimensions so over time every lever gets tested. */
export function planNextTest(history: { dimension: ExperimentDimension }[], order: readonly ExperimentDimension[], scenario: string): PlannedTest {
  const counts = new Map<ExperimentDimension, number>(order.map((d) => [d, 0]));
  for (const h of history) counts.set(h.dimension, (counts.get(h.dimension) ?? 0) + 1);
  const next = [...order].sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0))[0];
  return { dimension: next, scenario };
}

export function buildWeeklyReport(input: {
  weekStart: string; weekEnd: string; concluded: ConcludedExperiment[]; running: RunningExperiment[]; next: PlannedTest | null; lowVolume: boolean;
}): WeeklyReport {
  const items: ReportItem[] = [];
  for (const e of input.concluded) {
    if (e.decision === "rollback") items.push({ kind: "rollback", exp: e });
    else if (e.decision === "promote_ready") items.push({ kind: "win", exp: e });
    else if (e.decision === "stop_harm") items.push({ kind: "loss", exp: e });
    else items.push({ kind: "inconclusive", exp: e });
  }
  for (const r of input.running) items.push({ kind: "running", exp: r });
  if (!input.concluded.length && !input.running.length) items.push({ kind: "learning", code: input.lowVolume ? "low_volume" : "no_experiments" });
  else if (input.concluded.length && input.concluded.every((e) => e.decision === "inconclusive")) items.push({ kind: "learning", code: "all_inconclusive" });
  if (input.next) items.push({ kind: "next", test: input.next });
  const limitations: WeeklyReport["limitations"] = ["sequential_intervals", "heuristic_metrics"];
  if (input.concluded.some((e) => e.earlyStop)) limitations.push("early_stop_inflation");
  return { weekStart: input.weekStart, weekEnd: input.weekEnd, items, limitations };
}
