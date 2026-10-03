/**
 * AI Reliability & Governance Engine — dashboard client library.
 *
 * Every AI decision Vireek makes is recorded with its reasoning, data, confidence,
 * model, applied policies, human review, real outcome and error attribution. This
 * module is the read/write surface the dashboard uses, plus the pure scoring helpers
 * (calibration, reliability score) so they can be unit-tested.
 *
 * Server counterpart: supabase/migrations/20270110000000_ai_reliability_governance_engine.sql
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type AiDecisionType =
  | 'dispatch'
  | 'pricing'
  | 'estimate'
  | 'diagnosis'
  | 'triage'
  | 'scheduling'
  | 'followup'
  | 'campaign'
  | 'financing'
  | 'communication'
  | 'agent_action'
  | 'other';

export type AiEngineKind = 'llm' | 'rules' | 'hybrid' | 'human';
export type AiGovernanceAction = 'auto_approved' | 'review_required' | 'blocked';
export type AiReviewStatus = 'not_required' | 'pending' | 'approved' | 'rejected' | 'overridden';
export type AiOutcome = 'pending' | 'successful' | 'partial' | 'failed' | 'no_effect';
export type AiErrorCategory =
  | 'bad_data'
  | 'wrong_reasoning'
  | 'hallucination'
  | 'policy_gap'
  | 'stale_context'
  | 'external_change'
  | 'human_error'
  | 'other';
export type AiPolicyResultKind = 'pass' | 'flag' | 'block' | 'skip';
export type AiReviewVerdict = 'approve' | 'reject' | 'override';

export interface AiReasonFactor {
  factor: string;
  weight?: number | null;
  value?: string | number | boolean | null;
}

export interface AiDataSource {
  source: string;
  ref?: string | null;
  fields?: string[];
}

export interface AiPolicyResult {
  policy: string;
  result: AiPolicyResultKind;
  detail?: string | null;
}

export interface AiDecisionRecord {
  id: string;
  user_id: string;
  decision_type: AiDecisionType;
  title: string;
  decision: string;
  reasoning: string;
  reason_factors: AiReasonFactor[];
  data_used: AiDataSource[];
  confidence: number | null;
  agent_source: string;
  engine_kind: AiEngineKind;
  model_provider: string | null;
  model_name: string | null;
  model_version: string | null;
  subject_table: string | null;
  subject_id: string | null;
  amount_cents: number | null;
  correlation_id: string | null;
  policies_applied: AiPolicyResult[];
  enforcement: 'pre_execution' | 'post_execution';
  governance_action: AiGovernanceAction;
  review_status: AiReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  override_value: unknown;
  executed: boolean;
  executed_at: string | null;
  execution_error: string | null;
  outcome: AiOutcome;
  outcome_recorded_at: string | null;
  outcome_notes: string | null;
  financial_impact_cents: number | null;
  ai_was_wrong: boolean | null;
  error_category: AiErrorCategory | null;
  error_explanation: string | null;
  linked_action_log_id: string | null;
  chain_pos: number;
  prev_hash: string | null;
  record_hash: string;
  created_at: string;
  updated_at: string;
}

export type AiEventType =
  | 'recorded'
  | 'review_requested'
  | 'approved'
  | 'rejected'
  | 'overridden'
  | 'executed'
  | 'execution_failed'
  | 'rolled_back'
  | 'outcome_recorded'
  | 'error_flagged'
  | 'violation'
  | 'settings_changed'
  | 'suggestion_accepted'
  | 'suggestion_dismissed';

export interface AiDecisionEvent {
  id: string;
  record_id: string | null;
  event_type: AiEventType;
  actor_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface AiGovernanceSettings {
  user_id: string;
  min_confidence_auto: number;
  require_confidence: boolean;
  require_review_amount_cents: number | null;
  always_review_types: AiDecisionType[];
  blocked_types: AiDecisionType[];
  type_overrides: Partial<Record<AiDecisionType, { min_confidence_auto: number }>>;
  updated_at: string;
}

export type AiSuggestionKind = 'always_review' | 'raise_confidence_threshold' | 'lower_confidence_threshold';

export interface AiGovernanceSuggestion {
  id: string;
  decision_type: AiDecisionType;
  kind: AiSuggestionKind;
  title: string;
  rationale: string;
  evidence: Record<string, unknown>;
  proposed_min_confidence: number | null;
  status: 'open' | 'accepted' | 'dismissed';
  decided_at: string | null;
  created_at: string;
}

export interface AiMetricsTotals {
  total: number;
  auto_approved: number;
  review_required: number;
  blocked: number;
  pending_reviews: number;
  approved: number;
  rejected: number;
  overridden: number;
  executed: number;
  outcomes_recorded: number;
  successful: number;
  partial: number;
  failed: number;
  no_effect: number;
  wrong: number;
  unattributed_failures: number;
  avg_confidence: number | null;
  net_impact_cents: number;
}

export interface CalibrationBin {
  bin_start: number;
  count: number;
  avg_confidence: number | null;
  success_rate: number | null;
}

export interface TypeBreakdown {
  decision_type: AiDecisionType;
  total: number;
  pending_reviews: number;
  avg_confidence: number | null;
  success_rate: number | null;
  scored: number;
  wrong: number;
}

export interface ModelBreakdown {
  model: string;
  engine_kind: AiEngineKind;
  total: number;
  avg_confidence: number | null;
  success_rate: number | null;
  scored: number;
  wrong: number;
}

export interface AiReliabilityMetrics {
  window_days: number;
  totals: AiMetricsTotals;
  calibration: CalibrationBin[];
  by_type: TypeBreakdown[];
  by_model: ModelBreakdown[];
  error_categories: Array<{ category: AiErrorCategory; count: number }>;
}

export interface ChainVerification {
  verified: boolean;
  checked: number;
  broken_at_position: number | null;
  broken_record_id: string | null;
  reason: string | null;
}

// ============================================================
// LABELS & STYLES
// ============================================================

export const DECISION_TYPES: AiDecisionType[] = [
  'dispatch',
  'pricing',
  'estimate',
  'diagnosis',
  'triage',
  'scheduling',
  'followup',
  'campaign',
  'financing',
  'communication',
  'agent_action',
  'other',
];

export const TYPE_LABELS: Record<AiDecisionType, string> = {
  dispatch: 'Dispatch',
  pricing: 'Pricing',
  estimate: 'Estimates',
  diagnosis: 'Diagnosis',
  triage: 'Emergency triage',
  scheduling: 'Scheduling',
  followup: 'Follow-ups',
  campaign: 'Campaigns',
  financing: 'Financing',
  communication: 'Communication',
  agent_action: 'Agent actions',
  other: 'Other',
};

export const GOVERNANCE_LABELS: Record<AiGovernanceAction, string> = {
  auto_approved: 'Auto-approved',
  review_required: 'Review required',
  blocked: 'Blocked',
};

export const GOVERNANCE_COLORS: Record<AiGovernanceAction, string> = {
  auto_approved: 'bg-success-500/10 text-success-500',
  review_required: 'bg-warning-500/10 text-warning-500',
  blocked: 'bg-danger/10 text-danger',
};

export const REVIEW_LABELS: Record<AiReviewStatus, string> = {
  not_required: 'No review needed',
  pending: 'Awaiting review',
  approved: 'Approved by human',
  rejected: 'Rejected by human',
  overridden: 'Overridden by human',
};

export const OUTCOME_LABELS: Record<AiOutcome, string> = {
  pending: 'Outcome pending',
  successful: 'Successful',
  partial: 'Partially successful',
  failed: 'Failed',
  no_effect: 'No effect',
};

export const OUTCOME_COLORS: Record<AiOutcome, string> = {
  pending: 'bg-bg-tertiary text-text-secondary',
  successful: 'bg-success-500/10 text-success-500',
  partial: 'bg-warning-500/10 text-warning-500',
  failed: 'bg-danger/10 text-danger',
  no_effect: 'bg-bg-tertiary text-text-secondary',
};

export const ERROR_CATEGORY_LABELS: Record<AiErrorCategory, string> = {
  bad_data: 'Bad or missing data',
  wrong_reasoning: 'Wrong reasoning',
  hallucination: 'Hallucination',
  policy_gap: 'Policy gap',
  stale_context: 'Stale context',
  external_change: 'Situation changed',
  human_error: 'Human error',
  other: 'Other',
};

export const ERROR_CATEGORIES: AiErrorCategory[] = [
  'bad_data',
  'wrong_reasoning',
  'hallucination',
  'policy_gap',
  'stale_context',
  'external_change',
  'human_error',
  'other',
];

export const EVENT_LABELS: Record<AiEventType, string> = {
  recorded: 'Decision recorded',
  review_requested: 'Human review requested',
  approved: 'Approved',
  rejected: 'Rejected',
  overridden: 'Overridden',
  executed: 'Executed',
  execution_failed: 'Execution failed',
  rolled_back: 'Rolled back',
  outcome_recorded: 'Outcome recorded',
  error_flagged: 'AI error flagged',
  violation: 'Governance violation',
  settings_changed: 'Policy changed',
  suggestion_accepted: 'Suggestion accepted',
  suggestion_dismissed: 'Suggestion dismissed',
};

export const POLICY_LABELS: Record<string, string> = {
  kill_switch: 'Kill switch',
  mandatory_review: 'Mandatory review',
  confidence_threshold: 'Confidence threshold',
  high_value_review: 'High-value review',
  agent_governance: 'Agent Governance',
};

export function policyLabel(policy: string): string {
  return POLICY_LABELS[policy] ?? policy.replace(/_/g, ' ');
}

export const POLICY_RESULT_COLORS: Record<AiPolicyResultKind, string> = {
  pass: 'bg-success-500/10 text-success-500',
  flag: 'bg-warning-500/10 text-warning-500',
  block: 'bg-danger/10 text-danger',
  skip: 'bg-bg-tertiary text-text-secondary',
};

export const SUGGESTION_KIND_LABELS: Record<AiSuggestionKind, string> = {
  always_review: 'Always review',
  raise_confidence_threshold: 'Raise threshold',
  lower_confidence_threshold: 'Lower threshold',
};

// ============================================================
// PURE HELPERS (unit-tested)
// ============================================================

export const MIN_SCORED_OUTCOMES = 10;

export function formatPct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** Fraction (0-1) to a percent string, e.g. 0.914 -> "91%". */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/** Share of scored outcomes that succeeded (partial counts half). Null when nothing is scored yet. */
export function computeSuccessRate(t: Pick<AiMetricsTotals, 'successful' | 'partial' | 'failed'>): number | null {
  const scored = t.successful + t.partial + t.failed;
  if (scored === 0) return null;
  return (t.successful + 0.5 * t.partial) / scored;
}

/**
 * Expected calibration error (0-1): how far stated confidence is from real success,
 * weighted by how many decisions sit in each confidence bucket. 0 = perfectly calibrated.
 */
export function computeCalibrationError(bins: CalibrationBin[]): number | null {
  const usable = bins.filter((b) => b.success_rate !== null && b.avg_confidence !== null && b.count > 0);
  const n = usable.reduce((sum, b) => sum + b.count, 0);
  if (n === 0) return null;
  return usable.reduce((sum, b) => sum + (b.count / n) * Math.abs((b.avg_confidence as number) / 100 - (b.success_rate as number)), 0);
}

/**
 * Signed calibration gap in percentage points for one bin: positive = over-confident
 * (the AI claimed more certainty than it earned), negative = under-confident.
 */
export function calibrationGap(bin: CalibrationBin): number | null {
  if (bin.success_rate === null || bin.avg_confidence === null) return null;
  return Math.round(bin.avg_confidence - bin.success_rate * 100);
}

/** Share of human-reviewed decisions where the human disagreed (rejected or overrode). */
export function computeOverrideRate(t: Pick<AiMetricsTotals, 'approved' | 'rejected' | 'overridden'>): number | null {
  const reviewed = t.approved + t.rejected + t.overridden;
  if (reviewed === 0) return null;
  return (t.rejected + t.overridden) / reviewed;
}

export type ReliabilityGrade = 'excellent' | 'good' | 'fair' | 'at_risk';

export interface ReliabilityComponent {
  key: 'quality' | 'calibration' | 'oversight' | 'coverage';
  label: string;
  /** 0-1 */
  value: number | null;
  weight: number;
  hint: string;
}

export interface ReliabilityScore {
  /** null = not enough evidence. Vireek does not guess a score. */
  score: number | null;
  grade: ReliabilityGrade | null;
  components: ReliabilityComponent[];
  scoredOutcomes: number;
  reason: string | null;
}

export const GRADE_LABELS: Record<ReliabilityGrade, string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Needs attention',
  at_risk: 'At risk',
};

export const GRADE_COLORS: Record<ReliabilityGrade, string> = {
  excellent: 'text-success-500',
  good: 'text-success-500',
  fair: 'text-warning-500',
  at_risk: 'text-danger',
};

export function gradeFor(score: number): ReliabilityGrade {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 60) return 'fair';
  return 'at_risk';
}

/**
 * Composite 0-100 reliability score built from real outcomes only:
 *   40%  quality      — success rate of decisions with a recorded outcome
 *   25%  calibration  — 1 - 2 x calibration error (does confidence predict success?)
 *   20%  oversight    — share of decisions needing review that a human has resolved
 *   15%  coverage     — share of executed decisions whose outcome has been recorded
 * Components with no data are dropped and the remaining weights renormalised.
 * With fewer than MIN_SCORED_OUTCOMES scored outcomes the score is null: no guessing.
 */
export function computeReliabilityScore(m: AiReliabilityMetrics): ReliabilityScore {
  const t = m.totals;
  const scoredOutcomes = t.successful + t.partial + t.failed;

  const quality = computeSuccessRate(t);
  const ece = computeCalibrationError(m.calibration);
  const calibration = ece === null ? null : Math.max(0, 1 - 2 * ece);
  const oversight = t.review_required > 0 ? Math.max(0, 1 - t.pending_reviews / t.review_required) : null;
  const coverage = t.executed > 0 ? Math.min(1, t.outcomes_recorded / t.executed) : null;

  const components: ReliabilityComponent[] = [
    { key: 'quality', label: 'Decision quality', value: quality, weight: 0.4, hint: 'Success rate of decisions with a recorded outcome' },
    { key: 'calibration', label: 'Confidence calibration', value: calibration, weight: 0.25, hint: 'Does stated confidence match real success?' },
    { key: 'oversight', label: 'Human oversight', value: oversight, weight: 0.2, hint: 'Flagged decisions that a human has resolved' },
    { key: 'coverage', label: 'Outcome coverage', value: coverage, weight: 0.15, hint: 'Executed decisions whose result is recorded' },
  ];

  if (scoredOutcomes < MIN_SCORED_OUTCOMES) {
    return {
      score: null,
      grade: null,
      components,
      scoredOutcomes,
      reason: `Needs at least ${MIN_SCORED_OUTCOMES} decisions with a recorded outcome (currently ${scoredOutcomes}).`,
    };
  }

  const available = components.filter((c) => c.value !== null);
  const weightSum = available.reduce((s, c) => s + c.weight, 0);
  const raw = available.reduce((s, c) => s + (c.value as number) * c.weight, 0) / weightSum;
  const score = Math.round(raw * 100);

  return { score, grade: gradeFor(score), components, scoredOutcomes, reason: null };
}

/** True when a record still needs someone to record its real-world result. */
export function awaitingOutcome(r: Pick<AiDecisionRecord, 'executed' | 'outcome' | 'review_status'>): boolean {
  return r.executed && r.outcome === 'pending' && r.review_status !== 'pending';
}

/** True when the AI is known to be wrong, or a failure has not been attributed yet. */
export function needsAttribution(r: Pick<AiDecisionRecord, 'outcome' | 'ai_was_wrong'>): boolean {
  return r.outcome === 'failed' && r.ai_was_wrong === null;
}

export function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—';
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

// ============================================================
// API
// ============================================================

function fail(error: { message: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

export async function fetchMetrics(days: number): Promise<AiReliabilityMetrics> {
  const { data, error } = await supabase.rpc('get_ai_reliability_metrics', { p_days: days });
  if (error || !data) fail(error, 'Could not load AI reliability metrics');
  return data as AiReliabilityMetrics;
}

export type DecisionView = 'all' | 'review' | 'awaiting_outcome' | 'wrong' | 'blocked';

export interface DecisionQuery {
  view: DecisionView;
  type: AiDecisionType | 'all';
  search: string;
  limit: number;
  offset: number;
}

export async function fetchDecisions(q: DecisionQuery): Promise<{ rows: AiDecisionRecord[]; total: number }> {
  let query = supabase
    .from('ai_decision_records')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(q.offset, q.offset + q.limit - 1);

  if (q.type !== 'all') query = query.eq('decision_type', q.type);

  switch (q.view) {
    case 'review':
      query = query.eq('review_status', 'pending');
      break;
    case 'awaiting_outcome':
      query = query.eq('executed', true).eq('outcome', 'pending').neq('review_status', 'pending');
      break;
    case 'wrong':
      query = query.or('ai_was_wrong.is.true,and(outcome.eq.failed,ai_was_wrong.is.null)');
      break;
    case 'blocked':
      query = query.eq('governance_action', 'blocked');
      break;
    default:
      break;
  }

  const term = q.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
  if (term) query = query.ilike('title', `%${term}%`);

  const { data, error, count } = await query;
  if (error) fail(error, 'Could not load AI decisions');
  return { rows: (data ?? []) as AiDecisionRecord[], total: count ?? 0 };
}

export async function fetchPendingReviewCount(): Promise<number> {
  const { count, error } = await supabase
    .from('ai_decision_records')
    .select('id', { count: 'exact', head: true })
    .eq('review_status', 'pending');
  if (error) fail(error, 'Could not load review queue');
  return count ?? 0;
}

export async function fetchDecisionEvents(recordId: string): Promise<AiDecisionEvent[]> {
  const { data, error } = await supabase
    .from('ai_decision_events')
    .select('id, record_id, event_type, actor_id, detail, created_at')
    .eq('record_id', recordId)
    .order('created_at', { ascending: true });
  if (error) fail(error, 'Could not load decision history');
  return (data ?? []) as AiDecisionEvent[];
}

export async function fetchSettings(): Promise<AiGovernanceSettings> {
  const { data, error } = await supabase.rpc('get_ai_governance_settings');
  if (error || !data) fail(error, 'Could not load AI governance settings');
  return data as AiGovernanceSettings;
}

export async function saveSettings(s: {
  min_confidence_auto: number;
  require_confidence: boolean;
  require_review_amount_cents: number | null;
  always_review_types: AiDecisionType[];
  blocked_types: AiDecisionType[];
  type_overrides: AiGovernanceSettings['type_overrides'];
}): Promise<AiGovernanceSettings> {
  const { data, error } = await supabase.rpc('upsert_ai_governance_settings', {
    p_min_confidence_auto: s.min_confidence_auto,
    p_require_confidence: s.require_confidence,
    p_require_review_amount_cents: s.require_review_amount_cents,
    p_always_review_types: s.always_review_types,
    p_blocked_types: s.blocked_types,
    p_type_overrides: s.type_overrides,
  });
  if (error || !data) fail(error, 'Could not save AI governance settings');
  return data as AiGovernanceSettings;
}

export async function reviewDecision(
  recordId: string,
  verdict: AiReviewVerdict,
  notes: string,
  overrideValue?: unknown,
): Promise<AiDecisionRecord> {
  const { data, error } = await supabase.rpc('review_ai_decision', {
    p_record_id: recordId,
    p_verdict: verdict,
    p_notes: notes.trim() || null,
    p_override_value: overrideValue === undefined ? null : overrideValue,
  });
  if (error || !data) fail(error, 'Could not save the review');
  return data as AiDecisionRecord;
}

export interface OutcomeInput {
  outcome: Exclude<AiOutcome, 'pending'>;
  financialImpactCents: number | null;
  aiWasWrong: boolean | null;
  errorCategory: AiErrorCategory | null;
  errorExplanation: string;
  notes: string;
}

export async function recordOutcome(recordId: string, o: OutcomeInput): Promise<AiDecisionRecord> {
  const { data, error } = await supabase.rpc('record_ai_decision_outcome', {
    p_record_id: recordId,
    p_outcome: o.outcome,
    p_financial_impact_cents: o.financialImpactCents,
    p_ai_was_wrong: o.aiWasWrong,
    p_error_category: o.aiWasWrong ? o.errorCategory : null,
    p_error_explanation: o.aiWasWrong ? o.errorExplanation.trim() || null : null,
    p_notes: o.notes.trim() || null,
  });
  if (error || !data) fail(error, 'Could not record the outcome');
  return data as AiDecisionRecord;
}

export async function verifyChain(): Promise<ChainVerification> {
  const { data, error } = await supabase.rpc('verify_ai_decision_chain', { p_limit: 5000 });
  if (error || !data) fail(error, 'Could not verify the audit chain');
  return data as ChainVerification;
}

export async function fetchSuggestions(): Promise<AiGovernanceSuggestion[]> {
  const { data, error } = await supabase
    .from('ai_governance_suggestions')
    .select('id, decision_type, kind, title, rationale, evidence, proposed_min_confidence, status, decided_at, created_at')
    .eq('status', 'open')
    .order('created_at', { ascending: false });
  if (error) fail(error, 'Could not load suggestions');
  return (data ?? []) as AiGovernanceSuggestion[];
}

export async function refreshSuggestions(): Promise<number> {
  const { data, error } = await supabase.rpc('refresh_ai_governance_suggestions');
  if (error) fail(error, 'Could not analyse decisions');
  return typeof data === 'number' ? data : 0;
}

export async function decideSuggestion(id: string, accept: boolean): Promise<void> {
  const { error } = await supabase.rpc('decide_ai_governance_suggestion', { p_id: id, p_accept: accept });
  if (error) fail(error, 'Could not update the suggestion');
}
