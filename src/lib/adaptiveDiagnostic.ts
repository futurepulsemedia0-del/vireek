/**
 * Vireek Adaptive Customer Diagnostic — pure domain layer (types + formatting). No network access.
 * Engine:   supabase/functions/_shared/adaptive-diagnostic/engine.ts
 * Server:   supabase/functions/adaptive-diagnostic/index.ts + migration 20270301000000
 * API:      src/lib/adaptiveDiagnosticApi.ts
 */

export type SessionStatus = 'open' | 'completed' | 'hazard' | 'unsupported';

export interface DiagOption {
  id: string;
  label: string;
}

export interface DiagQuestionView {
  code: string;
  text: string;
  help: string | null;
  options: DiagOption[];
}

/** What the customer-facing step API returns. It never contains diagnoses or probabilities. */
export interface StepResponse {
  sessionId: string;
  status: SessionStatus;
  hazard?: boolean;
  answered?: number;
  estimatedTotal?: number;
  question: DiagQuestionView | null;
  done: boolean;
}

export interface PosteriorEntry {
  code: string;
  p: number;
}

/** Row as the dashboard sees it (RLS-scoped). */
export interface DiagSession {
  id: string;
  job_id: string;
  domain_code: string | null;
  status: SessionStatus;
  answers: { q: string; a: string }[];
  posterior: PosteriorEntry[];
  top_hypothesis: string | null;
  confidence: number | null;
  hazard: boolean;
  stop_reason: string | null;
  customer_text: string | null;
  created_at: string;
  completed_at: string | null;
  confirmed_hypothesis: string | null;
  confirmed_at: string | null;
  top1_correct: boolean | null;
  outcome_applied_at: string | null;
}

export interface DiagHypothesisRow {
  code: string;
  label: string;
  parts_hint: string | null;
}

export interface DiagQuestionRow {
  code: string;
  text: string;
  options: DiagOption[];
}

export interface TrendBucket {
  bucket: number;
  n: number;
  accuracy: number;
  avg_questions: number;
}

export interface QuestionValue {
  code: string;
  text: string;
  asked_n: number;
  avg_gain_pp: number | null;
}

export interface LearningSummary {
  confirmed: number;
  accuracy: number | null;
  trend: TrendBucket[];
  questions: QuestionValue[];
  awaiting_outcome: number;
  unmapped: number;
}

export const OTHER_OUTCOME = '__other__';
/** Below this many confirmed uses a question's measured value is shown as "still learning". */
export const LEARNING_MIN_SAMPLES = 20;
export const TREND_MIN_BUCKET = 5;

export const STATUS_META: Record<SessionStatus, { label: string; tone: string }> = {
  open: { label: 'In progress', tone: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  completed: { label: 'Completed', tone: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  hazard: { label: 'Safety hazard', tone: 'bg-red-500/10 text-red-600 dark:text-red-400' },
  unsupported: { label: 'Not covered yet', tone: 'bg-bg-tertiary text-text-secondary' },
};

export function pct(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '—';
  return `${Math.round(p * 100)}%`;
}

export function confidenceLabel(p: number | null | undefined): 'High' | 'Medium' | 'Low' {
  if (p == null) return 'Low';
  if (p >= 0.75) return 'High';
  if (p >= 0.5) return 'Medium';
  return 'Low';
}

export function progressPercent(answered: number | undefined, total: number | undefined): number {
  if (!answered || !total || total <= 0) return 4;
  return Math.max(4, Math.min(96, Math.round((answered / total) * 100)));
}

export function getDiagnoseLink(token: string): string {
  return `${window.location.origin}/diagnose/${token}`;
}

export function diagnosticMessage(businessName: string | null, link: string): string {
  const who = businessName?.trim() || 'your service provider';
  return `Hi, this is ${who}. To help our technician arrive prepared, please answer a few quick questions (about 1 minute): ${link}`;
}

/** Signed accuracy change (percentage points) between the first and latest ten-job buckets, or null if too thin. */
export function accuracyChange(trend: TrendBucket[]): { first: number; latest: number; deltaPp: number } | null {
  const solid = trend.filter((b) => b.n >= TREND_MIN_BUCKET);
  if (solid.length < 2) return null;
  const first = solid[0].accuracy;
  const latest = solid[solid.length - 1].accuracy;
  return { first, latest, deltaPp: Math.round((latest - first) * 100) };
}

export function friendlyDiagError(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const msg = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : '';
  const m = /DIAG_[A-Z_]+:\s*(.+)$/.exec(msg);
  return m ? m[1] : fallback;
}
