// Vireek Field Intelligence Engine — shared types and pure helpers.
//
// All labeling happens in Postgres (supabase/migrations/20270205000000_field_intelligence_engine.sql).
// Nothing in this file talks to the network: it only describes, formats and grades what the database returns.

export type OutcomeLabel = 'pending' | 'success' | 'partial' | 'failure' | 'ambiguous';
export type ActionKind = 'diagnosis' | 'part' | 'repair';
export type Uncertainty = 'low' | 'medium' | 'high';
export type FinalLabel = 'success' | 'partial' | 'failure';

export const MIN_GRADE_SAMPLE = 20;

export const LABEL_META: Record<OutcomeLabel, { label: string; description: string; tone: string }> = {
  success: { label: 'Success', description: 'Held up with no negative signal through the matured horizon.', tone: 'bg-success-500/10 text-success-500' },
  partial: { label: 'Partial', description: 'Fixed, but soft negative signals exist (repeat visit, dispute, low rating, follow-up).', tone: 'bg-warning-500/10 text-warning-500' },
  failure: { label: 'Failure', description: 'Callback attributable to the original work, or left unresolved.', tone: 'bg-danger/10 text-danger' },
  ambiguous: { label: 'Ambiguous', description: 'Signals conflict or the callback is not attributable. Needs a human decision.', tone: 'bg-accent/10 text-accent' },
  pending: { label: 'Pending', description: 'Too recent to judge. Labels mature at 7, 30, 90 and 365 days.', tone: 'bg-bg-tertiary text-text-secondary' },
};

export const KIND_LABELS: Record<ActionKind, string> = {
  diagnosis: 'Diagnosis',
  part: 'Part',
  repair: 'Repair action',
};

const REASON_LABELS: Record<string, string> = {
  callback: 'Callback after the visit',
  callback_not_attributable: 'Callback judged not attributable',
  unresolved: 'Marked unresolved',
  fixed_first_visit: 'Fixed on first visit',
};

export function formatReason(reason: string): string {
  if (reason.startsWith('soft_signals:')) {
    const n = Number(reason.split(':')[1]);
    return Number.isFinite(n) && n > 0 ? `${n} soft signal${n === 1 ? '' : 's'} (repeat visit, dispute, rating or warranty)` : 'Soft signals';
  }
  return REASON_LABELS[reason] ?? reason.replace(/_/g, ' ');
}

export function formatTag(tag: string | null | undefined): string {
  if (!tag) return '—';
  return tag.replace(/_/g, ' ');
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** "62% (41–78%)" — success rate with its Wilson interval; the interval is what makes small samples honest. */
export function formatRateWithInterval(rate: number | null, lower: number | null, upper: number | null): string {
  if (rate === null || rate === undefined) return '—';
  if (lower === null || upper === null || lower === undefined || upper === undefined) return formatPercent(rate);
  return `${formatPercent(rate)} (${formatPercent(lower)}–${formatPercent(upper)})`;
}

export interface CalibrationBin {
  bin: number;
  n: number;
  avg_predicted: number;
  observed_rate: number;
}

export interface CalibrationBlock {
  n: number;
  brier?: number;
  ece?: number;
  base_rate?: number;
  bins?: CalibrationBin[];
}

export interface LearningMetrics {
  total_observations: number;
  label_counts: Partial<Record<OutcomeLabel, number>>;
  adjudication_backlog: number;
  human: { n: number; override_rate: number | null };
  coverage: {
    with_equipment: number;
    with_diagnosis: number;
    with_parts: number;
    with_technician: number;
    multimodal: number;
    with_cost: number;
  };
  copilot_agreement: { n: number; rate: number | null };
  ftf: CalibrationBlock | null;
  assurance: CalibrationBlock | null;
  ftf_brier_delta: number | null;
}

export type CalibrationGrade = 'insufficient' | 'excellent' | 'good' | 'fair' | 'poor';

/**
 * Grades a probability model by how honest its numbers are.
 * ECE = average gap between what the model claimed and what happened. Needs enough settled jobs to mean anything.
 */
export function gradeCalibration(block: CalibrationBlock | null | undefined): CalibrationGrade {
  if (!block || !block.n || block.n < MIN_GRADE_SAMPLE || block.ece === undefined) return 'insufficient';
  if (block.ece <= 0.05) return 'excellent';
  if (block.ece <= 0.1) return 'good';
  if (block.ece <= 0.2) return 'fair';
  return 'poor';
}

export const GRADE_META: Record<CalibrationGrade, { label: string; tone: string }> = {
  insufficient: { label: `Needs ${MIN_GRADE_SAMPLE}+ settled jobs`, tone: 'text-text-secondary' },
  excellent: { label: 'Well calibrated', tone: 'text-success-500' },
  good: { label: 'Good', tone: 'text-success-500' },
  fair: { label: 'Drifting', tone: 'text-warning-500' },
  poor: { label: 'Needs retraining', tone: 'text-danger' },
};

export interface CoverageRow {
  key: keyof LearningMetrics['coverage'];
  label: string;
  count: number;
  share: number;
}

const COVERAGE_LABELS: Record<keyof LearningMetrics['coverage'], string> = {
  with_equipment: 'Equipment linked',
  with_diagnosis: 'Technician diagnosis recorded',
  with_parts: 'Parts recorded',
  with_technician: 'Technician assigned',
  with_cost: 'Job cost recorded',
  multimodal: 'Photo / sensor evidence',
};

/** How complete the captured chain is. Missing links are the real ceiling on model quality, so they are shown first. */
export function coverageRows(metrics: LearningMetrics | null | undefined): CoverageRow[] {
  const total = metrics?.total_observations ?? 0;
  if (!metrics || total <= 0) return [];
  return (Object.keys(COVERAGE_LABELS) as (keyof LearningMetrics['coverage'])[])
    .map((key) => {
      const count = metrics.coverage?.[key] ?? 0;
      return { key, label: COVERAGE_LABELS[key], count, share: Math.min(1, count / total) };
    })
    .sort((a, b) => a.share - b.share);
}

/** Single 0–1 score: the average of the five core chain links (multimodal is a bonus signal, not a requirement). */
export function dataCompletenessScore(metrics: LearningMetrics | null | undefined): number | null {
  const rows = coverageRows(metrics).filter((r) => r.key !== 'multimodal');
  if (rows.length === 0) return null;
  return rows.reduce((sum, r) => sum + r.share, 0) / rows.length;
}

export function settledCount(counts: LearningMetrics['label_counts'] | undefined): number {
  if (!counts) return 0;
  return (counts.success ?? 0) + (counts.partial ?? 0) + (counts.failure ?? 0);
}

export function brierTrend(delta: number | null | undefined): { text: string; tone: string } | null {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return null;
  if (Math.abs(delta) < 0.005) return { text: 'Stable vs last run', tone: 'text-text-secondary' };
  return delta < 0
    ? { text: `Improving (${delta.toFixed(3)} Brier)`, tone: 'text-success-500' }
    : { text: `Degrading (+${delta.toFixed(3)} Brier)`, tone: 'text-danger' };
}

export interface ObservationRow {
  id: string;
  job_id: string;
  service_type: string | null;
  equipment_make: string | null;
  equipment_model: string | null;
  equipment_type: string | null;
  equipment_age_months: number | null;
  symptoms: string | null;
  symptom_tags: string[];
  diagnosis: string | null;
  diagnosis_tag: string | null;
  technician_id: string | null;
  parts: { part_number: string | null; name: string | null; qty?: number }[];
  duration_minutes: number | null;
  cost_cents: number | null;
  revenue_cents: number | null;
  observed_at: string;
  outcome_label: OutcomeLabel;
  label_confidence: number;
  uncertainty: Uncertainty;
  outcome_reasons: string[];
  matured_horizon: 'none' | 'd7' | 'd30' | 'd90' | 'd365';
}

export function describeEquipment(o: Pick<ObservationRow, 'equipment_make' | 'equipment_model' | 'equipment_type' | 'equipment_age_months'>): string {
  const name = [o.equipment_make, o.equipment_model].filter(Boolean).join(' ') || o.equipment_type || 'Equipment not linked';
  if (o.equipment_age_months === null || o.equipment_age_months === undefined) return name;
  const years = Math.floor(o.equipment_age_months / 12);
  return `${name} · ${years > 0 ? `${years} yr` : `${o.equipment_age_months} mo`} old`;
}

/** Which action kinds a reviewer may mark as the failed step. Success never needs one. */
export function failedKindsFor(label: FinalLabel, selected: ActionKind[]): ActionKind[] {
  return label === 'success' ? [] : selected;
}
