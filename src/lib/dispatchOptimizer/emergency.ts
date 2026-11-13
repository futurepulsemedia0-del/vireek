// Recreated: verify against original intent
// TODO(vireek): the original emergency re-planner is not in the repository; this is the shape the panel renders.
import type { Metrics } from './types';
import type { Suggestion } from './suggestions';
export interface AtRiskJob { jobId: string; slaMissed: boolean; [key: string]: unknown }
export type EmergencyResult =
  | { ok: true; suggestions: Suggestion[]; atRisk: AtRiskJob[]; doNothing?: Metrics; afterPlan?: Metrics }
  | { ok: false; reason?: string };
