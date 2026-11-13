// Recreated: verify against original intent
// Shared client types for the Dispatch Optimizer (panel <-> edge function).
// Derived from how OptimizerPanel and the dispatch-optimizer edge function use them.
// TODO(vireek): the original engine types (also used by model.ts / solver.ts) are not in the repository. Only the
// surface the panel and the edge function contract use is typed here; verify against the original.
export interface OptShift { dayKey: string; startMs: number; endMs: number }
export interface OptTech { id: string; name: string; shifts: OptShift[]; [key: string]: unknown }
export interface OptJob { id: string; [key: string]: unknown }
export interface OptInput { techs: OptTech[]; jobs: OptJob[]; [key: string]: unknown }

/** Schedule quality numbers compared before / after a suggestion set. */
export interface Metrics {
  unassigned: number;
  travelMin: number;
  slaMisses: number;
  overtimeMin: number;
  hardViolations: number;
  [key: string]: number;
}
