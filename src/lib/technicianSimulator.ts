/**
 * AI Technician Simulator - client library.
 *
 * The scenario, its hidden ground truth, the score and the pass flag all live
 * server-side (supabase/functions/technician-simulator). This file only calls
 * that Edge Function and reads the caller's own attempts. Nothing here can
 * change a score, which is what makes a simulator result trustworthy in the
 * Trust Passport.
 *
 * Keep the types below in sync with technician-simulator/normalize.ts and
 * scoring.ts, and tradeForServiceType() in sync with the same function in
 * technician-simulator/index.ts.
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type SimTrade = 'hvac' | 'plumbing' | 'electrical' | 'appliance';
export type SimDifficulty = 'foundation' | 'professional' | 'master';
export type SimDecision = 'repair_now' | 'quote_and_schedule' | 'escalate_specialist';
export type SimCertLevel = 'none' | 'foundation' | 'professional' | 'master';

export interface SimBrief {
  title: string;
  trade: SimTrade;
  difficulty: SimDifficulty;
  equipment: { type: string; make: string; model: string; age_years: number | null };
  customer_complaint: string;
  environment: string;
  candidate_causes: { id: string; label: string }[];
  measurement_options: { id: string; label: string; tool: string; location: string; minutes: number; intrusive: boolean }[];
  question_topics: { id: string; topic: string }[];
  safety_checks: { id: string; label: string }[];
  parts_catalog: { id: string; label: string }[];
  time_limit_minutes: number;
}

export type SimEvent =
  | { type: 'question'; fact_ids: string[]; via: 'topic' | 'free_text'; t: string }
  | { type: 'measurement'; id: string; t: string }
  | { type: 'safety_ack'; ids: string[]; t: string }
  | { type: 'safety_violation'; measurement_id: string; t: string };

export interface SimScoreBreakdown {
  diagnosis: number;
  evidence: number;
  information: number;
  safety: number;
  parts_decision: number;
  calibration: number;
}

export interface SimResult {
  score: number;
  passed: boolean;
  diagnosis_correct: boolean;
  breakdown: SimScoreBreakdown;
  flags: string[];
  stats: {
    measurements_taken: number;
    decisive_taken: number;
    noise_taken: number;
    minutes_spent: number;
    critical_facts_found: number;
    critical_facts_total: number;
    required_safety_done: number;
    required_safety_total: number;
    safety_violations: number;
  };
  reveal: {
    root_cause: string;
    chosen_cause: string;
    correct_decision: SimDecision;
    decision_rationale: string;
    decisive_tests: { label: string; reading: string; taken: boolean }[];
    correct_parts: { label: string; chosen: boolean }[];
    wrong_parts_chosen: string[];
    missed_critical_questions: { topic: string; answer: string }[];
    missed_safety: string[];
    decision_was_correct: boolean;
  };
  coaching: { summary: string; strengths: string[]; improvements: string[]; next_focus: string; source: 'ai' | 'rules' };
  chosen: { cause_id: string; part_ids: string[]; decision: SimDecision; confidence: number };
}

export interface SimAttempt {
  id: string;
  status: 'active' | 'submitted' | 'expired';
  trade: SimTrade;
  difficulty: SimDifficulty;
  brief: SimBrief;
  events: SimEvent[];
  started_at: string;
  expires_at: string;
  submitted_at: string | null;
  score: number | null;
  passed: boolean | null;
  result: SimResult | null;
}

export interface SimMeasureResponse {
  measurement_id: string;
  blocked: boolean;
  repeat: boolean;
  reading?: string;
  message?: string;
}

export interface SimAskResponse {
  answer: string;
  fact_ids: string[];
  repeat: boolean;
}

export interface SimTradeSummary {
  level: SimCertLevel;
  attempts: number;
  passed: number;
  passed_foundation: number;
  passed_professional: number;
  passed_master: number;
  avg_score: number | null;
  best_score: number | null;
}

export interface TechnicianSimulatorSummary {
  technician_id: string;
  attempts_completed: number;
  attempts_passed: number;
  avg_score: number | null;
  last_attempt_at: string | null;
  trades: Partial<Record<SimTrade, SimTradeSummary>>;
}

// ============================================================
// METADATA
// ============================================================

export const SIM_TRADES: SimTrade[] = ['hvac', 'plumbing', 'electrical', 'appliance'];
export const SIM_DIFFICULTIES: SimDifficulty[] = ['foundation', 'professional', 'master'];

export const SIM_TRADE_META: Record<SimTrade, { label: string }> = {
  hvac: { label: 'HVAC' },
  plumbing: { label: 'Plumbing' },
  electrical: { label: 'Electrical' },
  appliance: { label: 'Appliance' },
};

export const SIM_DIFFICULTY_META: Record<SimDifficulty, { label: string; blurb: string }> = {
  foundation: { label: 'Foundation', blurb: 'Clear symptoms, one or two decisive tests.' },
  professional: { label: 'Professional', blurb: 'Overlapping symptoms and misleading clues.' },
  master: { label: 'Master', blurb: 'Compound or intermittent faults with a real safety hazard.' },
};

export const SIM_CERT_META: Record<SimCertLevel, { label: string; className: string }> = {
  none: { label: 'Not certified', className: 'bg-bg-tertiary text-text-secondary' },
  foundation: { label: 'Foundation', className: 'bg-accent/10 text-accent' },
  professional: { label: 'Professional', className: 'bg-success-500/10 text-success-500' },
  master: { label: 'Master', className: 'bg-warning-500/10 text-warning-500' },
};

export const SIM_DECISION_META: Record<SimDecision, { label: string; hint: string }> = {
  repair_now: { label: 'Repair now', hint: 'Fix it on this visit.' },
  quote_and_schedule: { label: 'Quote & schedule', hint: 'Needs parts, time or approval.' },
  escalate_specialist: { label: 'Escalate to specialist', hint: 'Needs a licensed specialist or manufacturer.' },
};

export const SIM_SCORE_MAX: SimScoreBreakdown = {
  diagnosis: 35,
  evidence: 20,
  information: 10,
  safety: 20,
  parts_decision: 10,
  calibration: 5,
};

export const SIM_SCORE_LABELS: Record<keyof SimScoreBreakdown, string> = {
  diagnosis: 'Diagnosis',
  evidence: 'Evidence quality',
  information: 'Customer questions',
  safety: 'Safety',
  parts_decision: 'Parts & decision',
  calibration: 'Confidence calibration',
};

export const SIM_PASS_MARK = 70;
export const SIM_QUESTION_MAX_CHARS = 300;
export const SIM_REASONING_MAX_CHARS = 800;

/** Mirror of tradeForServiceType() in the Edge Function. Maps free-text job service types to a simulator trade. */
export function tradeForServiceType(serviceType: string | null | undefined): SimTrade | null {
  const v = (serviceType ?? '').toLowerCase();
  if (/(hvac|a\/c|\bac\b|air ?con|furnace|heat ?pump|cooling|heating|refrigerant|condens|duct|thermostat)/.test(v)) return 'hvac';
  if (/(plumb|water heater|drain|sewer|toilet|faucet|pipe|leak|sump|garbage disposal)/.test(v)) return 'plumbing';
  if (/(electric|breaker|panel|outlet|wiring|circuit|lighting|generator|ev charger)/.test(v)) return 'electrical';
  if (/(appliance|washer|dryer|dishwasher|refrigerator|fridge|oven|range|microwave|freezer)/.test(v)) return 'appliance';
  return null;
}

// ============================================================
// EDGE FUNCTION CALLS
// ============================================================

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('technician-simulator', { body });
  if (error) {
    throw new Error(await functionErrorMessage(error, 'Could not reach the simulator. Check your connection and try again.'));
  }
  if (data?.error) throw new Error(String(data.error));
  return data as T;
}

export async function startSimulation(input: {
  trade?: SimTrade | null;
  difficulty?: SimDifficulty | null;
  sourceJobId?: string | null;
}): Promise<{ attempt: SimAttempt; resumed: boolean }> {
  return invoke({
    action: 'start',
    trade: input.trade ?? null,
    difficulty: input.difficulty ?? null,
    sourceJobId: input.sourceJobId ?? null,
  });
}

export const askCustomerTopic = (attemptId: string, factId: string) =>
  invoke<SimAskResponse>({ action: 'ask', attemptId, factId });

export const askCustomerFreeText = (attemptId: string, question: string) =>
  invoke<SimAskResponse>({ action: 'ask', attemptId, question: question.trim().slice(0, SIM_QUESTION_MAX_CHARS) });

export const takeMeasurement = (attemptId: string, measurementId: string) =>
  invoke<SimMeasureResponse>({ action: 'measure', attemptId, measurementId });

export const acknowledgeSafety = (attemptId: string, safetyIds: string[]) =>
  invoke<{ acknowledged: string[] }>({ action: 'ack_safety', attemptId, safetyIds });

export const abandonSimulation = (attemptId: string) => invoke<{ ok: boolean }>({ action: 'abandon', attemptId });

export const submitDiagnosis = (input: {
  attemptId: string;
  causeId: string;
  partIds: string[];
  decision: SimDecision;
  confidence: number;
  reasoning?: string;
}) =>
  invoke<SimResult & { attempt_id: string }>({
    action: 'submit',
    attemptId: input.attemptId,
    causeId: input.causeId,
    partIds: input.partIds,
    decision: input.decision,
    confidence: input.confidence,
    reasoning: (input.reasoning ?? '').trim().slice(0, SIM_REASONING_MAX_CHARS),
  });

// ============================================================
// READS (RLS scopes attempts to the signed-in user)
// ============================================================

const ATTEMPT_COLUMNS =
  'id, status, trade, difficulty, brief, events, started_at, expires_at, submitted_at, score, passed, result';

/** The person's live attempt, if any and not yet expired. */
export async function fetchActiveAttempt(): Promise<SimAttempt | null> {
  const { data, error } = await supabase
    .from('simulator_attempts')
    .select(ATTEMPT_COLUMNS)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  return (data as SimAttempt | null) ?? null;
}

export async function fetchAttemptHistory(limit = 15): Promise<SimAttempt[]> {
  const { data, error } = await supabase
    .from('simulator_attempts')
    .select(ATTEMPT_COLUMNS)
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as SimAttempt[]) ?? [];
}

/** Derived certification summary per technician (no writable certification table exists). */
export async function fetchSimulatorSummaries(): Promise<TechnicianSimulatorSummary[]> {
  const { data, error } = await supabase.rpc('get_technician_simulator_summary', { p_technician_id: null });
  if (error) throw error;
  return (data as TechnicianSimulatorSummary[]) ?? [];
}

// ============================================================
// HELPERS
// ============================================================

export function topCertLevel(summary: TechnicianSimulatorSummary | undefined): SimCertLevel {
  if (!summary) return 'none';
  const order: SimCertLevel[] = ['none', 'foundation', 'professional', 'master'];
  return Object.values(summary.trades).reduce<SimCertLevel>(
    (best, t) => (t && order.indexOf(t.level) > order.indexOf(best) ? t.level : best),
    'none',
  );
}

export function remainingSeconds(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
}

export function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
