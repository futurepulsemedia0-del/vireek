// Recreated: verify against original intent
// TODO(vireek): the original suggestion builder is not in the repository; this is the shape the panel renders.
export interface SuggestionAlternative { techId: string; summary: string }
export interface SuggestionExplanation {
  headline: string;
  reasons: string[];
  warnings: string[];
  alternatives: SuggestionAlternative[];
}
export interface SuggestionImpact {
  travelMin: number;
  slaMisses: number;
  revenueRecoveredCents: number;
  [key: string]: number;
}
export interface Suggestion {
  id: string;
  rank: number;
  kind: 'assign' | 'reassign' | string;
  jobId: string;
  jobLabel: string;
  techId: string;
  techName: string;
  fromTechId?: string | null;
  startMs: number;
  impact: SuggestionImpact;
  explanation: SuggestionExplanation;
}
