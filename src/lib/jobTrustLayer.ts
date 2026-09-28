/**
 * Vireek Customer Trust Layer — client library.
 *
 * A measurable Trust Score (0-100) per job, built from 10 weighted signals
 * and shown to the customer as verifiable badges. Scores are computed
 * server-side only (SQL `_recompute_job_trust`); this file reads them,
 * records structured staff signals through `record_job_trust_event`, and
 * holds the pure helpers used by the dashboard and the public page.
 *
 * Server counterpart: supabase/migrations/20261230000000_customer_trust_layer.sql
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type TrustSignal =
  | 'eta_accuracy'
  | 'technician_identity'
  | 'price_transparency'
  | 'diagnosis_confidence'
  | 'quote_changes'
  | 'communication_quality'
  | 'arrival_punctuality'
  | 'work_evidence'
  | 'warranty'
  | 'payment_transparency';

/** Signals staff can record by hand; the rest are measured automatically. */
export type ManualTrustSignal = 'price_transparency' | 'quote_change' | 'diagnosis_confidence' | 'communication_quality' | 'warranty';

export type TrustTier = 'excellent' | 'good' | 'fair' | 'at_risk' | 'pending';
export type BadgeKey = 'technician_verified' | 'price_locked' | 'parts_verified' | 'work_documented' | 'warranty_active';
export type TrustBadges = Record<BadgeKey, boolean>;

export interface TrustDimension {
  signal: TrustSignal;
  weight: number;
  score: number;
  verified: boolean;
}

export interface JobTrustScore {
  job_id: string;
  user_id: string;
  trust_score: number | null;
  tier: TrustTier;
  coverage: number;
  dimensions: TrustDimension[];
  badges: Partial<TrustBadges>;
  updated_at: string;
  job: {
    id: string;
    customer_name: string;
    service_type: string | null;
    scheduled_datetime: string | null;
    job_status: string;
    reschedule_token: string | null;
  } | null;
}

export interface JobTrustEvent {
  id: string;
  job_id: string;
  signal: string;
  score: number;
  verified: boolean;
  source: 'system' | 'staff' | 'customer';
  detail: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface PublicJobTrust {
  business_name: string | null;
  service_type: string | null;
  technician_name: string | null;
  job_status: string;
  trust_score: number | null;
  tier: TrustTier;
  coverage: number;
  dimensions: { signal: TrustSignal; score: number; verified: boolean }[];
  badges: Partial<TrustBadges>;
  updated_at: string | null;
}

// ============================================================
// LABELS / COPY
// ============================================================

/** Display order — highest weight first (mirrors the SQL weights). */
export const ALL_SIGNALS: { signal: TrustSignal; weight: number }[] = [
  { signal: 'eta_accuracy', weight: 12 },
  { signal: 'technician_identity', weight: 12 },
  { signal: 'price_transparency', weight: 12 },
  { signal: 'work_evidence', weight: 12 },
  { signal: 'quote_changes', weight: 10 },
  { signal: 'arrival_punctuality', weight: 10 },
  { signal: 'diagnosis_confidence', weight: 8 },
  { signal: 'communication_quality', weight: 8 },
  { signal: 'warranty', weight: 8 },
  { signal: 'payment_transparency', weight: 8 },
];

export const SIGNAL_LABELS: Record<TrustSignal, string> = {
  eta_accuracy: 'ETA accuracy',
  technician_identity: 'Technician identity',
  price_transparency: 'Price transparency',
  diagnosis_confidence: 'Diagnosis confidence',
  quote_changes: 'Quote stability',
  communication_quality: 'Communication quality',
  arrival_punctuality: 'Arrival punctuality',
  work_evidence: 'Work evidence',
  warranty: 'Warranty',
  payment_transparency: 'Payment transparency',
};

/** Where each signal comes from — shown to staff so gaps are actionable. */
export const SIGNAL_SOURCES: Record<TrustSignal, string> = {
  eta_accuracy: 'Automatic: set an ETA before dispatch; measured when the job starts.',
  technician_identity: 'Automatic: assign a technician with active credentials on file.',
  price_transparency: 'Record a locked price with the customer.',
  diagnosis_confidence: 'Record the diagnosis confidence and whether parts are verified.',
  quote_changes: 'Appears once a price is locked; drops with every quote change.',
  communication_quality: 'Record first-response time and proactive updates.',
  arrival_punctuality: 'Automatic: measured against the scheduled time when the job starts.',
  work_evidence: 'Automatic: passes when job photos clear evidence verification.',
  warranty: 'Record the warranty length given to the customer.',
  payment_transparency: 'Automatic: compares the invoice to the agreed price.',
};

export const EVENT_LABELS: Record<string, string> = { ...SIGNAL_LABELS, quote_change: 'Quote change' };

export const TIER_LABELS: Record<TrustTier, string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  at_risk: 'At risk',
  pending: 'Verification in progress',
};

export const TIER_COLORS: Record<TrustTier, string> = {
  excellent: 'bg-success-500/10 text-success-500',
  good: 'bg-accent/10 text-accent',
  fair: 'bg-warning-500/10 text-warning-500',
  at_risk: 'bg-danger/10 text-danger',
  pending: 'bg-bg-tertiary text-text-secondary',
};

export const BADGE_DEFS: { key: BadgeKey; label: string; pending: string }[] = [
  { key: 'technician_verified', label: 'Technician verified', pending: 'Technician verification pending' },
  { key: 'price_locked', label: 'Price locked', pending: 'Price not locked yet' },
  { key: 'parts_verified', label: 'Parts verified', pending: 'Parts not verified yet' },
  { key: 'work_documented', label: 'Work documented', pending: 'Work documentation pending' },
  { key: 'warranty_active', label: 'Warranty active', pending: 'No warranty recorded yet' },
];

// ============================================================
// PURE HELPERS
// ============================================================

/** Mirrors the SQL tier rules. Below 40% coverage a score is never presented as final. */
export function tierFromScore(score: number | null, coverage: number): TrustTier {
  if (score === null || coverage < 40) return 'pending';
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 60) return 'fair';
  return 'at_risk';
}

export function scoreBarClass(score: number): string {
  if (score >= 90) return 'bg-success-500';
  if (score >= 75) return 'bg-accent';
  if (score >= 60) return 'bg-warning-500';
  return 'bg-danger';
}

export function badgeCount(badges: Partial<TrustBadges>): number {
  return BADGE_DEFS.filter((b) => badges[b.key] === true).length;
}

/** Vireek Trusted Service™: excellent tier, >= 80% evidence coverage, all five badges. */
export function isTrustedService(s: { tier: TrustTier; coverage: number; badges: Partial<TrustBadges> }): boolean {
  return s.tier === 'excellent' && s.coverage >= 80 && badgeCount(s.badges) === BADGE_DEFS.length;
}

/** Signals that have no evidence yet on this job. */
export function missingSignals(dimensions: { signal: TrustSignal }[]): TrustSignal[] {
  const have = new Set(dimensions.map((d) => d.signal));
  return ALL_SIGNALS.map((s) => s.signal).filter((s) => !have.has(s));
}

export interface TrustSummary {
  total: number;
  scored: number;
  avgScore: number | null;
  excellent: number;
  atRisk: number;
  trusted: number;
  signalAverages: Partial<Record<TrustSignal, number>>;
  weakest: { signal: TrustSignal; avg: number } | null;
}

export function summarizeTrust(rows: JobTrustScore[]): TrustSummary {
  const scoredRows = rows.filter((r) => r.trust_score !== null && r.tier !== 'pending');
  const sums: Partial<Record<TrustSignal, { sum: number; n: number }>> = {};
  for (const r of scoredRows) {
    for (const d of r.dimensions) {
      const cur = sums[d.signal] ?? { sum: 0, n: 0 };
      cur.sum += d.score;
      cur.n += 1;
      sums[d.signal] = cur;
    }
  }
  const signalAverages: Partial<Record<TrustSignal, number>> = {};
  let weakest: TrustSummary['weakest'] = null;
  for (const [signal, v] of Object.entries(sums) as [TrustSignal, { sum: number; n: number }][]) {
    const avg = v.sum / v.n;
    signalAverages[signal] = avg;
    if (!weakest || avg < weakest.avg) weakest = { signal, avg };
  }
  return {
    total: rows.length,
    scored: scoredRows.length,
    avgScore: scoredRows.length ? scoredRows.reduce((a, r) => a + (r.trust_score ?? 0), 0) / scoredRows.length : null,
    excellent: scoredRows.filter((r) => r.tier === 'excellent').length,
    atRisk: scoredRows.filter((r) => r.tier === 'at_risk').length,
    trusted: scoredRows.filter((r) => isTrustedService(r)).length,
    signalAverages,
    weakest,
  };
}

// ============================================================
// MANUAL SIGNAL FORMS
// ============================================================

export interface SignalField {
  key: string;
  label: string;
  kind: 'number' | 'boolean' | 'text';
  required?: boolean;
  placeholder?: string;
}

export const SIGNAL_FORMS: Record<ManualTrustSignal, { title: string; hint: string; fields: SignalField[] }> = {
  price_transparency: {
    title: 'Lock the price',
    hint: 'Score rises when the quote is itemized and the customer acknowledges it.',
    fields: [
      { key: 'locked_total', label: 'Locked total ($)', kind: 'number', required: true, placeholder: '0.00' },
      { key: 'itemized', label: 'Itemized breakdown shown to the customer', kind: 'boolean' },
      { key: 'customer_acknowledged', label: 'Customer acknowledged the price', kind: 'boolean' },
    ],
  },
  quote_change: {
    title: 'Record a quote change',
    hint: 'Unapproved changes cost more than customer-approved ones.',
    fields: [
      { key: 'previous_total', label: 'Previous total ($)', kind: 'number', required: true },
      { key: 'new_total', label: 'New total ($)', kind: 'number', required: true },
      { key: 'reason', label: 'Reason for the change', kind: 'text', required: true, placeholder: 'e.g. Additional part required' },
      { key: 'customer_approved', label: 'Customer approved the new total', kind: 'boolean' },
    ],
  },
  diagnosis_confidence: {
    title: 'Diagnosis confidence',
    hint: 'Confidence 0-100. Tick parts verified to earn the Parts verified badge.',
    fields: [
      { key: 'confidence_pct', label: 'Diagnosis confidence (%)', kind: 'number', required: true },
      { key: 'parts_verified', label: 'Required parts verified in stock / on the truck', kind: 'boolean' },
    ],
  },
  communication_quality: {
    title: 'Communication quality',
    hint: 'Faster first response and proactive updates score higher.',
    fields: [
      { key: 'response_minutes', label: 'Minutes to first response', kind: 'number', required: true },
      { key: 'updates_sent', label: 'Proactive updates sent', kind: 'number' },
    ],
  },
  warranty: {
    title: 'Warranty',
    hint: '365+ days scores 100; 0 days means no warranty.',
    fields: [{ key: 'warranty_days', label: 'Warranty length (days)', kind: 'number', required: true }],
  },
};

// ============================================================
// API
// ============================================================

const SCORE_SELECT =
  '*, job:jobs(id, customer_name, service_type, scheduled_datetime, job_status, reschedule_token)';

export async function fetchTrustScores(limit = 300): Promise<JobTrustScore[]> {
  const { data, error } = await supabase
    .from('job_trust_scores')
    .select(SCORE_SELECT)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as unknown as JobTrustScore[]) ?? [];
}

export async function fetchTrustEvents(jobId: string): Promise<JobTrustEvent[]> {
  const { data, error } = await supabase
    .from('job_trust_events')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data as JobTrustEvent[]) ?? [];
}

export async function refreshTrustScore(jobId: string): Promise<void> {
  const { error } = await supabase.rpc('refresh_job_trust_score', { p_job_id: jobId });
  if (error) throw error;
}

export async function recordTrustEvent(
  jobId: string,
  signal: ManualTrustSignal,
  inputs: Record<string, number | boolean | string>,
  detail?: string
): Promise<void> {
  const { error } = await supabase.rpc('record_job_trust_event', {
    p_job_id: jobId,
    p_signal: signal,
    p_inputs: inputs,
    p_detail: detail?.trim() || null,
  });
  if (error) throw error;
}

export async function fetchPublicTrust(token: string): Promise<PublicJobTrust | null> {
  const { data, error } = await supabase.rpc('get_public_job_trust', { p_token: token });
  if (error || !data) return null;
  return data as PublicJobTrust;
}

export function getPublicTrustLink(token: string): string {
  return `${window.location.origin}/verified/${token}`;
}

export async function fetchPublicTrustEnabled(): Promise<boolean> {
  const { data, error } = await supabase.rpc('get_trust_layer_settings');
  if (error) throw error;
  return data === true;
}

export async function setPublicTrustEnabled(enabled: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_public_trust_page', { p_enabled: enabled });
  if (error) throw error;
}
