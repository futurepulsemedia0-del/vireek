/**
 * Autonomous Business Scientist — client library.
 *
 * Closes the loop the other AI consoles leave open: Research + Problem
 * Discovery (reused from business_decisions, see the migration) ->
 * Hypothesis (AI-drafted server-side, see supabase/functions/
 * business-scientist-cycle) -> Simulation -> Experiment -> Measurement ->
 * Rollout. Every stage past "hypothesis" is plain, inspectable arithmetic
 * in this file — the model is never involved again after drafting the
 * hypothesis, and nothing here ever runs an experiment automatically:
 * the owner starts it, the owner enters what actually happened, and the
 * owner confirms the rollout.
 *
 * Server counterpart: supabase/migrations/20261203000000_autonomous_business_scientist.sql
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type StudyCategory = 'pricing' | 'dispatch' | 'staffing' | 'marketing' | 'collections' | 'retention' | 'operations';
export type StudyStage = 'hypothesis' | 'experimenting' | 'measuring' | 'decided' | 'rolled_out' | 'abandoned';
export type PredictedDirection = 'increase' | 'decrease';
export type ExperimentStatus = 'not_started' | 'running' | 'completed';
export type StudyDecision = 'rollout' | 'iterate' | 'abandon';

export interface SimulationResult {
  magnitude_low_pct: number;
  magnitude_expected_pct: number;
  magnitude_high_pct: number;
  dollars_low: number | null;
  dollars_expected: number | null;
  dollars_high: number | null;
  method: string;
}

export interface ExperimentDesign {
  control_desc: string;
  treatment_desc: string;
  success_metric: string;
  duration_days: number;
}

export interface MeasuredResult {
  control_value: number;
  control_n: number;
  treatment_value: number;
  treatment_n: number;
  lift_pct: number;
  significant: boolean;
  z_score: number | null;
  method: string;
}

export interface BusinessScientistStudy {
  id: string;
  source_decision_id: string | null;
  category: StudyCategory;
  problem_title: string;
  problem_evidence: { reasoning?: string; recommended_action?: string } | null;
  source_estimated_impact: number | null;
  stage: StudyStage;
  hypothesis: string | null;
  proposed_intervention: string | null;
  predicted_metric: string | null;
  predicted_direction: PredictedDirection | null;
  predicted_magnitude_pct: number | null;
  confidence_score: number | null;
  simulation: SimulationResult | null;
  experiment_design: ExperimentDesign | null;
  experiment_status: ExperimentStatus;
  experiment_started_at: string | null;
  experiment_ends_at: string | null;
  measured_result: MeasuredResult | null;
  decision: StudyDecision | null;
  decision_reasoning: string | null;
  rollout_action: string | null;
  rolled_out_at: string | null;
  abandoned_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScientistSettings {
  min_confidence_threshold: number;
  min_effect_pct: number;
  default_experiment_days: number;
}

// ============================================================
// THE MATH — simulation
// ============================================================

/**
 * Turns a hypothesis's predicted magnitude + confidence into a plain
 * low/expected/high band. A lower confidence score widens the band —
 * that's the whole model: no hidden distribution, no invented precision.
 */
export function simulateImpact(input: {
  magnitudePct: number;
  confidenceScore: number;
  baselineDollars: number | null;
}): SimulationResult {
  const errorBandPct = Math.max(5, Math.min(50, (100 - input.confidenceScore) / 2));
  const low = Math.max(0, input.magnitudePct * (1 - errorBandPct / 100));
  const high = input.magnitudePct * (1 + errorBandPct / 100);

  const hasBaseline = typeof input.baselineDollars === 'number' && input.baselineDollars > 0;
  return {
    magnitude_low_pct: Math.round(low * 10) / 10,
    magnitude_expected_pct: Math.round(input.magnitudePct * 10) / 10,
    magnitude_high_pct: Math.round(high * 10) / 10,
    dollars_low: hasBaseline ? Math.round((input.baselineDollars! * low) / 100) : null,
    dollars_expected: hasBaseline ? Math.round((input.baselineDollars! * input.magnitudePct) / 100) : null,
    dollars_high: hasBaseline ? Math.round((input.baselineDollars! * high) / 100) : null,
    method: `±${Math.round(errorBandPct)}% band derived from the ${input.confidenceScore}% hypothesis confidence score`,
  };
}

/** A predicted effect too small to justify pulling a slice of the real business into an experiment. */
export function passesExperimentGate(magnitudePct: number, minEffectPct: number): boolean {
  return magnitudePct >= minEffectPct;
}

export function draftExperimentDesign(study: Pick<BusinessScientistStudy, 'proposed_intervention' | 'predicted_metric'>, durationDays: number): ExperimentDesign {
  return {
    control_desc: 'Keep current behavior unchanged for the control group/period.',
    treatment_desc: study.proposed_intervention ?? '',
    success_metric: study.predicted_metric ?? '',
    duration_days: durationDays,
  };
}

// ============================================================
// THE MATH — measurement
// ============================================================

/**
 * Scores a real control-vs-treatment result the owner enters after the
 * experiment runs. When both values look like rates (0-100) and both
 * groups have a sample size, this runs an honest two-proportion z-test.
 * Otherwise it falls back to a plainly-labeled practical-significance
 * heuristic (minimum sample + minimum effect size) — never dressed up as
 * inferential statistics it isn't.
 */
export function evaluateExperiment(input: {
  controlValue: number;
  controlN: number;
  treatmentValue: number;
  treatmentN: number;
}): MeasuredResult {
  const { controlValue, controlN, treatmentValue, treatmentN } = input;
  const liftPct = controlValue === 0
    ? (treatmentValue === 0 ? 0 : 100)
    : ((treatmentValue - controlValue) / Math.abs(controlValue)) * 100;

  const looksLikeRate = controlValue >= 0 && controlValue <= 100 && treatmentValue >= 0 && treatmentValue <= 100;

  if (looksLikeRate && controlN > 0 && treatmentN > 0) {
    const p1 = controlValue / 100;
    const p2 = treatmentValue / 100;
    const pooled = (p1 * controlN + p2 * treatmentN) / (controlN + treatmentN);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / controlN + 1 / treatmentN));
    const z = se > 0 ? (p2 - p1) / se : 0;
    return {
      control_value: controlValue,
      control_n: controlN,
      treatment_value: treatmentValue,
      treatment_n: treatmentN,
      lift_pct: Math.round(liftPct * 10) / 10,
      significant: Math.abs(z) >= 1.96,
      z_score: Math.round(z * 100) / 100,
      method: 'two_proportion_z_test_95pct',
    };
  }

  const significant = controlN >= 20 && treatmentN >= 20 && Math.abs(liftPct) >= 10;
  return {
    control_value: controlValue,
    control_n: controlN,
    treatment_value: treatmentValue,
    treatment_n: treatmentN,
    lift_pct: Math.round(liftPct * 10) / 10,
    significant,
    z_score: null,
    method: 'practical_significance_heuristic_min20_min10pct',
  };
}

export function decideFromMeasurement(
  measured: MeasuredResult,
  predictedDirection: PredictedDirection | null,
  metricLabel?: string | null,
): { decision: StudyDecision; reasoning: string } {
  const movedRight = predictedDirection === 'increase' ? measured.lift_pct > 0 : measured.lift_pct < 0;
  const metric = metricLabel ?? 'the target metric';

  if (measured.significant && movedRight) {
    return {
      decision: 'rollout',
      reasoning: `Treatment moved ${metric} by ${measured.lift_pct}% (${measured.method}), in the predicted direction and large/consistent enough to trust. Recommend rolling out to the full business.`,
    };
  }
  if (measured.significant && !movedRight) {
    return {
      decision: 'abandon',
      reasoning: `The effect was real (${measured.lift_pct}% lift, ${measured.method}) but moved the wrong way. Recommend abandoning this intervention.`,
    };
  }
  return {
    decision: 'iterate',
    reasoning: `Result is inconclusive (${measured.lift_pct}% lift on ${measured.control_n}/${measured.treatment_n} samples) — not enough signal yet. Recommend a longer run or a larger sample before deciding.`,
  };
}

// ============================================================
// CRUD
// ============================================================

export async function fetchStudies(): Promise<BusinessScientistStudy[]> {
  const { data, error } = await supabase
    .from('business_scientist_studies')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data as BusinessScientistStudy[]) ?? [];
}

export async function fetchSettings(userId: string): Promise<ScientistSettings> {
  const { data, error } = await supabase
    .from('business_scientist_settings')
    .select('min_confidence_threshold, min_effect_pct, default_experiment_days')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ?? { min_confidence_threshold: 70, min_effect_pct: 3, default_experiment_days: 14 };
}

/** Invokes the server-side research cycle: pulls unactioned decisions, drafts hypotheses. */
export async function runResearchCycle(): Promise<{ studies_created: number }> {
  const { data, error } = await supabase.functions.invoke('business-scientist-cycle', { method: 'POST' });
  if (error) throw error;
  return data as { studies_created: number };
}

/**
 * Client-side simulation + gate for any study still sitting at
 * 'hypothesis' with no simulation yet. Call after fetchStudies() /
 * runResearchCycle() so freshly-drafted hypotheses immediately advance —
 * this is what makes the loop feel autonomous while keeping every number
 * inspectable (see simulateImpact / passesExperimentGate above).
 */
export async function advancePendingHypotheses(studies: BusinessScientistStudy[], settings: ScientistSettings): Promise<void> {
  const pending = studies.filter((s) => s.stage === 'hypothesis' && !s.simulation);
  for (const study of pending) {
    const simulation = simulateImpact({
      magnitudePct: study.predicted_magnitude_pct ?? 0,
      confidenceScore: study.confidence_score ?? 50,
      baselineDollars: study.source_estimated_impact,
    });

    if (passesExperimentGate(study.predicted_magnitude_pct ?? 0, settings.min_effect_pct)) {
      await supabase
        .from('business_scientist_studies')
        .update({
          simulation,
          stage: 'experimenting',
          experiment_design: draftExperimentDesign(study, settings.default_experiment_days),
        })
        .eq('id', study.id);
    } else {
      await supabase
        .from('business_scientist_studies')
        .update({
          simulation,
          stage: 'abandoned',
          decision: 'abandon',
          decision_reasoning: `Predicted effect (${study.predicted_magnitude_pct ?? 0}%) is below the ${settings.min_effect_pct}% minimum worth testing.`,
          abandoned_at: new Date().toISOString(),
        })
        .eq('id', study.id);
    }
  }
}

export async function startExperiment(studyId: string, durationDays: number): Promise<void> {
  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + durationDays * 86400000);
  const { error } = await supabase
    .from('business_scientist_studies')
    .update({
      experiment_status: 'running',
      experiment_started_at: startedAt.toISOString(),
      experiment_ends_at: endsAt.toISOString(),
    })
    .eq('id', studyId);
  if (error) throw error;
}

export async function submitMeasurement(
  study: BusinessScientistStudy,
  input: { controlValue: number; controlN: number; treatmentValue: number; treatmentN: number },
): Promise<void> {
  const measured = evaluateExperiment(input);
  const { decision, reasoning } = decideFromMeasurement(measured, study.predicted_direction, study.predicted_metric);
  const { error } = await supabase
    .from('business_scientist_studies')
    .update({
      experiment_status: 'completed',
      measured_result: measured,
      stage: 'decided',
      decision,
      decision_reasoning: reasoning,
    })
    .eq('id', study.id);
  if (error) throw error;
}

export async function confirmRollout(studyId: string, rolloutAction: string): Promise<void> {
  const { error } = await supabase
    .from('business_scientist_studies')
    .update({ stage: 'rolled_out', rollout_action: rolloutAction.trim(), rolled_out_at: new Date().toISOString() })
    .eq('id', studyId);
  if (error) throw error;
}

export async function abandonStudy(studyId: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from('business_scientist_studies')
    .update({ stage: 'abandoned', decision: 'abandon', decision_reasoning: reason.trim() || null, abandoned_at: new Date().toISOString() })
    .eq('id', studyId);
  if (error) throw error;
}

export async function deleteStudy(studyId: string): Promise<void> {
  const { error } = await supabase.from('business_scientist_studies').delete().eq('id', studyId);
  if (error) throw error;
}

// ============================================================
// DISPLAY HELPERS
// ============================================================

export const STAGE_LABELS: Record<StudyStage, string> = {
  hypothesis: 'Hypothesis',
  experimenting: 'Experimenting',
  measuring: 'Measuring',
  decided: 'Decided',
  rolled_out: 'Rolled out',
  abandoned: 'Abandoned',
};

export const STAGE_COLORS: Record<StudyStage, string> = {
  hypothesis: 'bg-accent/10 text-accent',
  experimenting: 'bg-warning-500/10 text-warning-500',
  measuring: 'bg-warning-500/10 text-warning-500',
  decided: 'bg-success-500/10 text-success-500',
  rolled_out: 'bg-success-500/10 text-success-500',
  abandoned: 'bg-danger/10 text-danger',
};

export function formatDollars(n: number | null): string {
  if (n === null) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
}
