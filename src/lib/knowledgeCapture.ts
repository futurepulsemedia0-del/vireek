/**
 * Knowledge Capture Engine - pure domain logic (no I/O, fully unit-tested).
 *
 * Confidence itself is computed in Postgres (kce_recompute_confidence) - the single
 * source of truth. This file only labels, explains, and gates what the database stores.
 */

export type KceStatus =
  'candidate' | 'in_review' | 'approved' | 'deployed' | 'rejected' | 'retired';

export type KceSourceType =
  | 'call'
  | 'job_note'
  | 'diagnosis'
  | 'live_copilot'
  | 'expert_session'
  | 'repair_outcome'
  | 'video'
  | 'voice_note'
  | 'correction'
  | 'manual';

export type KceManualSourceType = Extract<
  KceSourceType,
  'voice_note' | 'video' | 'correction' | 'manual'
>;

export type KceAction = 'start_review' | 'approve' | 'reject' | 'revise' | 'deploy' | 'retire';

export interface KceRule {
  id: string;
  status: KceStatus;
  title: string;
  trade: string | null;
  equipment_make: string | null;
  equipment_model: string | null;
  symptoms: string[];
  condition_summary: string;
  likely_cause: string;
  recommended_action: string;
  caveats: string | null;
  current_version: number;
  deployed_version: number | null;
  confidence_score: number;
  confidence_breakdown: Partial<Record<ConfidenceKey, { score: number; weight: number }>>;
  evidence_count: number;
  contributor_count: number;
  applied_count: number;
  success_count: number;
  needs_revalidation: boolean;
  origin_contributor_id: string | null;
  review_note: string | null;
  retired_reason: string | null;
  approved_at: string | null;
  deployed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KceEvidence {
  id: string;
  excerpt: string;
  specificity: number;
  contributor_id: string | null;
  created_at: string;
  capture: { source_type: KceSourceType } | null;
}

export interface KceVersion {
  id: string;
  version: number;
  snapshot: Record<string, unknown>;
  change_note: string | null;
  created_at: string;
}

export interface KceOverview {
  is_reviewer: boolean;
  status_counts: Partial<Record<KceStatus, number>>;
  avg_confidence_deployed?: number | null;
  needs_revalidation?: number;
  pending_captures?: number;
  failed_captures?: number;
  captures_30d?: number;
  applications_90d?: number;
  resolved_90d?: number;
  auto_capture?: boolean;
  sources?: Partial<Record<KceSourceType, number>>;
}

export interface ExpertRiskRow {
  team_member_id: string;
  member_name: string;
  expected_departure: string | null;
  notes: string | null;
  jobs_completed_180d: number;
  rules_originated: number;
  rules_deployed: number;
  sole_source_rules: number;
  captures_90d: number;
  last_capture_at: string | null;
}

export type ConfidenceKey =
  'specificity' | 'corroboration' | 'outcome' | 'verification' | 'recency';

export const DEPLOY_CONFIDENCE_FLOOR = 40;

export const STATUS_ORDER: KceStatus[] = [
  'candidate',
  'in_review',
  'approved',
  'deployed',
  'rejected',
  'retired',
];

export const STATUS_LABELS: Record<KceStatus, string> = {
  candidate: 'Candidate',
  in_review: 'In review',
  approved: 'Approved',
  deployed: 'Live',
  rejected: 'Rejected',
  retired: 'Retired',
};

export const STATUS_STYLES: Record<KceStatus, string> = {
  candidate: 'bg-accent/10 text-accent border-accent/25',
  in_review: 'bg-warning-500/10 text-warning-500 border-warning-500/25',
  approved: 'bg-success-500/10 text-success-500 border-success-500/25',
  deployed: 'bg-success-500/10 text-success-500 border-success-500/25',
  rejected: 'bg-bg-tertiary text-text-secondary border-border',
  retired: 'bg-bg-tertiary text-text-secondary border-border',
};

export const SOURCE_LABELS: Record<KceSourceType, string> = {
  call: 'Customer call',
  job_note: 'Technician job notes',
  diagnosis: 'AI diagnosis + outcome',
  live_copilot: 'Live copilot session',
  expert_session: 'Expert session',
  repair_outcome: 'Callback / repair outcome',
  video: 'Video',
  voice_note: 'Voice note',
  correction: 'Correction',
  manual: 'Written note',
};

export const CONFIDENCE_LABELS: Record<ConfidenceKey, string> = {
  specificity: 'Specificity of evidence',
  corroboration: 'Independent corroboration',
  outcome: 'Field outcomes',
  verification: 'Human verification',
  recency: 'Freshness',
};

export type ConfidenceTier = 'high' | 'medium' | 'low';

export function confidenceTier(score: number): ConfidenceTier {
  if (score >= 75) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

export const CONFIDENCE_TIER_LABELS: Record<ConfidenceTier, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

export const CONFIDENCE_TIER_STYLES: Record<ConfidenceTier, string> = {
  high: 'text-success-500',
  medium: 'text-warning-500',
  low: 'text-text-secondary',
};

/** "Trane XR16" / "Trane" / "Any equipment" */
export function equipmentLabel(rule: Pick<KceRule, 'equipment_make' | 'equipment_model'>): string {
  const label = [rule.equipment_make, rule.equipment_model].filter(Boolean).join(' ').trim();
  return label || 'Any equipment';
}

/** The rule as one readable sentence, e.g. for cards and the field panel. */
export function formatRuleSentence(
  rule: Pick<KceRule, 'equipment_make' | 'equipment_model' | 'symptoms' | 'likely_cause'>,
): string {
  const symptoms = rule.symptoms.length > 0 ? rule.symptoms.join(' + ') : 'these symptoms';
  return `On ${equipmentLabel(rule)}: when ${symptoms} appear, the cause is usually ${rule.likely_cause.replace(/\.$/, '')}.`;
}

export interface ConfidencePart {
  key: ConfidenceKey;
  label: string;
  score: number;
  weight: number;
  /** points this component adds to the final 0-100 score */
  contribution: number;
}

/** Turns the stored breakdown into an ordered, explainable list (largest contribution first). */
export function explainConfidence(
  breakdown: KceRule['confidence_breakdown'] | null | undefined,
): ConfidencePart[] {
  if (!breakdown) return [];
  const keys = Object.keys(CONFIDENCE_LABELS) as ConfidenceKey[];
  return keys
    .flatMap((key) => {
      const part = breakdown[key];
      if (!part) return [];
      return [
        {
          key,
          label: CONFIDENCE_LABELS[key],
          score: part.score,
          weight: part.weight,
          contribution: Math.round((part.score * part.weight) / 100),
        },
      ];
    })
    .sort((a, b) => b.contribution - a.contribution);
}

export function outcomeRate(rule: Pick<KceRule, 'applied_count' | 'success_count'>): number | null {
  if (rule.applied_count <= 0) return null;
  return Math.round((rule.success_count / rule.applied_count) * 100);
}

export interface ReviewContext {
  canReview: boolean;
  isOwner: boolean;
  /** team_members.id of the signed-in user (null for the owner) */
  myMemberId: string | null;
}

export interface AvailableAction {
  action: KceAction;
  label: string;
  tone: 'primary' | 'secondary' | 'danger';
  enabled: boolean;
  disabledReason?: string;
  /** reject/retire need a typed reason */
  needsNote: boolean;
}

/**
 * Which buttons a reviewer sees for a rule. Mirrors the database state machine - the DB is
 * still the authority, this just avoids offering actions that are guaranteed to fail.
 */
export function availableActions(
  rule: Pick<KceRule, 'status' | 'confidence_score' | 'origin_contributor_id'>,
  ctx: ReviewContext,
): AvailableAction[] {
  if (!ctx.canReview) return [];

  const ownContribution =
    !ctx.isOwner && ctx.myMemberId !== null && ctx.myMemberId === rule.origin_contributor_id;
  const approve: AvailableAction = {
    action: 'approve',
    label: 'Approve',
    tone: 'primary',
    enabled: !ownContribution,
    disabledReason: ownContribution
      ? 'A different reviewer must approve knowledge you contributed.'
      : undefined,
    needsNote: false,
  };
  const reject: AvailableAction = {
    action: 'reject',
    label: 'Reject',
    tone: 'danger',
    enabled: true,
    needsNote: true,
  };
  const revise: AvailableAction = {
    action: 'revise',
    label: 'Revise (new version)',
    tone: 'secondary',
    enabled: true,
    needsNote: false,
  };
  const retire: AvailableAction = {
    action: 'retire',
    label: 'Retire',
    tone: 'danger',
    enabled: true,
    needsNote: true,
  };

  switch (rule.status) {
    case 'candidate':
      return [
        {
          action: 'start_review',
          label: 'Start review',
          tone: 'secondary',
          enabled: true,
          needsNote: false,
        },
        approve,
        reject,
      ];
    case 'in_review':
      return [approve, reject];
    case 'approved': {
      const belowFloor = rule.confidence_score < DEPLOY_CONFIDENCE_FLOOR;
      return [
        {
          action: 'deploy',
          label: 'Deploy to field',
          tone: 'primary',
          enabled: !belowFloor,
          disabledReason: belowFloor
            ? `Confidence ${rule.confidence_score} is below the deployment floor of ${DEPLOY_CONFIDENCE_FLOOR}. Capture more evidence first.`
            : undefined,
          needsNote: false,
        },
        revise,
        retire,
      ];
    }
    case 'deployed':
      return [revise, retire];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Retirement risk
// ---------------------------------------------------------------------------

export const RISK_MODEL = {
  /** deployed+pipeline rules per 100 completed jobs we consider "well captured" */
  coverageTargetPer100: 4,
  /** days before departure at which urgency starts to build */
  horizonDays: 180,
  /** below this many completed jobs we don't judge coverage (not enough signal) */
  minJobsForCoverage: 5,
  /** single-source rules at which the concentration factor saturates */
  soleSourceSaturation: 10,
} as const;

export type RiskTier = 'critical' | 'high' | 'moderate' | 'low';

export interface ExpertRisk {
  score: number;
  tier: RiskTier;
  daysToDeparture: number | null;
  capturedPer100Jobs: number | null;
  reasons: string[];
  suggestedAction: string;
}

export const RISK_TIER_LABELS: Record<RiskTier, string> = {
  critical: 'Critical',
  high: 'High',
  moderate: 'Moderate',
  low: 'Low',
};

export const RISK_TIER_STYLES: Record<RiskTier, string> = {
  critical: 'bg-danger/10 text-danger border-danger/25',
  high: 'bg-warning-500/10 text-warning-500 border-warning-500/25',
  moderate: 'bg-accent/10 text-accent border-accent/25',
  low: 'bg-bg-tertiary text-text-secondary border-border',
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Explainable knowledge-loss risk for one technician (0-100):
 *   departure proximity (0-40) + coverage gap (0-35) + single-source concentration (0-25).
 * "Critical" is only reachable when a departure date is known.
 */
export function computeExpertRisk(row: ExpertRiskRow, now: Date = new Date()): ExpertRisk {
  const reasons: string[] = [];

  let daysToDeparture: number | null = null;
  let departure = 0;
  if (row.expected_departure) {
    const target = Date.parse(`${row.expected_departure}T00:00:00Z`);
    if (!Number.isNaN(target)) {
      daysToDeparture = Math.ceil((target - now.getTime()) / 86_400_000);
      departure =
        daysToDeparture <= 0
          ? 40
          : clamp(40 * (1 - daysToDeparture / RISK_MODEL.horizonDays), 0, 40);
      if (daysToDeparture <= 0) reasons.push('Planned departure date has passed.');
      else if (daysToDeparture <= RISK_MODEL.horizonDays)
        reasons.push(`Leaving in ${daysToDeparture} day${daysToDeparture === 1 ? '' : 's'}.`);
    }
  }

  let capturedPer100Jobs: number | null = null;
  let coverage = 0;
  if (row.jobs_completed_180d >= RISK_MODEL.minJobsForCoverage) {
    capturedPer100Jobs =
      Math.round((row.rules_originated * 100 * 10) / row.jobs_completed_180d) / 10;
    coverage = clamp(1 - capturedPer100Jobs / RISK_MODEL.coverageTargetPer100, 0, 1) * 35;
    if (coverage >= 17.5) {
      reasons.push(
        `Only ${row.rules_originated} rule${row.rules_originated === 1 ? '' : 's'} captured across ${row.jobs_completed_180d} recent jobs.`,
      );
    }
  }

  const concentration = clamp(row.sole_source_rules / RISK_MODEL.soleSourceSaturation, 0, 1) * 25;
  if (row.sole_source_rules >= 3) {
    reasons.push(
      `${row.sole_source_rules} rules exist only in this person's experience (no second source).`,
    );
  }

  if (row.captures_90d === 0 && row.jobs_completed_180d >= RISK_MODEL.minJobsForCoverage) {
    reasons.push('Nothing captured from them in the last 90 days.');
  }

  const score = Math.round(departure + coverage + concentration);
  const tier: RiskTier =
    score >= 70 ? 'critical' : score >= 45 ? 'high' : score >= 25 ? 'moderate' : 'low';

  const dominant = Math.max(departure, coverage, concentration);
  let suggestedAction = 'Keep capturing - no urgent gap detected.';
  if (dominant > 0) {
    if (dominant === departure)
      suggestedAction =
        'Schedule recorded expert sessions now: walk through their top 10 diagnostic patterns on video.';
    else if (dominant === coverage)
      suggestedAction =
        'Run a capture sprint: have them voice-note every non-trivial job for the next two weeks.';
    else
      suggestedAction =
        'Get a second technician to confirm their single-source rules so the knowledge has two owners.';
  }

  return { score, tier, daysToDeparture, capturedPer100Jobs, reasons, suggestedAction };
}

/** Lines → clean symptom list for the edit form. */
export function parseSymptoms(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/\r?\n|;/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ).slice(0, 8);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
