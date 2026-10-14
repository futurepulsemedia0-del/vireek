import { supabase } from '@/lib/supabase';

/**
 * Vireek Outcome Clearinghouse - client library.
 *
 * Backed by supabase/migrations/20270415000000_outcome_clearinghouse.sql.
 * The database is the single source of truth: status, confidence, provenance and the hash-chained
 * ledger are computed server-side. This file only (a) types and reads that data, (b) wraps the RPCs,
 * and (c) holds pure, unit-tested helpers (spec check, gating, labels, error mapping).
 *
 *   Evidence + Measurements + Customer + Durability + Payment -> confidence -> verified outcome
 *   -> dispute window -> settlement legs (payment / warranty / insurance) -> reputation
 */

export type ClearingStatus = 'claimed' | 'verified' | 'partially_verified' | 'unverified' | 'disputed' | 'settled' | 'voided';
export type ConfidenceBand = 'high' | 'moderate' | 'low' | 'insufficient';
export type OutcomeType = 'repair_restored' | 'install_commissioned' | 'maintenance_completed' | 'inspection_completed' | 'other';
export type MeasurementPhase = 'before' | 'after' | 'monitor';
export type MeasurementSource = 'technician' | 'device' | 'telemetry' | 'customer' | 'third_party';
export type DisputeReason = 'not_fixed' | 'recurred' | 'work_not_done' | 'quality' | 'overcharge' | 'damage' | 'other';
export type DisputeStatus = 'open' | 'resolved_upheld' | 'resolved_rejected' | 'withdrawn';
export type DisputeResolution = 'upheld' | 'rejected' | 'withdrawn';
export type LegKind = 'payment' | 'warranty' | 'insurance';
export type LegStatus = 'planned' | 'cleared' | 'held' | 'executed' | 'cancelled';

export const STATUS_META: Record<ClearingStatus, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' | 'info' }> = {
  claimed: { label: 'Awaiting completion', tone: 'neutral' },
  verified: { label: 'Verified', tone: 'good' },
  partially_verified: { label: 'Partially verified', tone: 'warn' },
  unverified: { label: 'Unverified', tone: 'bad' },
  disputed: { label: 'Disputed', tone: 'bad' },
  settled: { label: 'Settled', tone: 'info' },
  voided: { label: 'Voided', tone: 'neutral' },
};

export const TONE_CLASS: Record<'good' | 'warn' | 'bad' | 'neutral' | 'info', string> = {
  good: 'bg-success-500/10 text-success-500',
  warn: 'bg-warning-500/10 text-warning-500',
  bad: 'bg-danger/10 text-danger',
  neutral: 'bg-bg-tertiary text-text-secondary',
  info: 'bg-accent/10 text-accent',
};

export const BAND_LABEL: Record<ConfidenceBand, string> = {
  high: 'High confidence',
  moderate: 'Moderate confidence',
  low: 'Low confidence',
  insufficient: 'Insufficient evidence',
};

export const OUTCOME_TYPES: Array<{ value: OutcomeType; label: string }> = [
  { value: 'repair_restored', label: 'Repair - service restored' },
  { value: 'install_commissioned', label: 'Installation - commissioned' },
  { value: 'maintenance_completed', label: 'Maintenance completed' },
  { value: 'inspection_completed', label: 'Inspection completed' },
  { value: 'other', label: 'Other' },
];

export const DISPUTE_REASONS: Array<{ value: DisputeReason; label: string }> = [
  { value: 'not_fixed', label: 'The problem is not fixed' },
  { value: 'recurred', label: 'The problem came back' },
  { value: 'work_not_done', label: 'Work was not done' },
  { value: 'quality', label: 'Quality of the work' },
  { value: 'overcharge', label: 'Overcharge' },
  { value: 'damage', label: 'Damage caused' },
  { value: 'other', label: 'Something else' },
];

export const FLAG_LABELS: Record<string, string> = {
  no_evidence: 'No evidence recorded on the job',
  evidence_chain_broken: 'Evidence hash chain is broken',
  job_not_completed: 'Job is not completed yet',
  no_result_proof: 'No passed test or in-spec after-reading',
  measurement_out_of_spec: 'An after-reading is outside its expected range',
  customer_disputed_job: 'Customer disputed this job',
  callback_recorded: 'A callback was recorded',
  dispute_upheld: 'A dispute was upheld',
  guarantee_claim_open: 'A guarantee claim is open',
  no_durability_signal: 'No outcome guarantee is tracking this job',
  no_customer_confirmation: 'No customer confirmation yet',
};

export const SOURCE_LABEL: Record<MeasurementSource, string> = {
  technician: 'Technician',
  device: 'Instrument',
  telemetry: 'Telemetry',
  customer: 'Customer',
  third_party: 'Third party',
};

export interface AssessmentComponent {
  key: 'evidence' | 'measurements' | 'customer' | 'durability' | 'commercial';
  label: string;
  weight: number;
  score: number;
  points: number;
  detail: string;
}

export interface Assessment {
  engine_version: number;
  components: AssessmentComponent[];
  flags: string[];
  hard_checks: {
    job_completed: boolean;
    chain_intact: boolean;
    result_proof: boolean;
    no_adverse_signal: boolean;
    no_open_dispute: boolean;
    meets_threshold: boolean;
  };
  verdict: ClearingStatus;
  threshold: number;
  provenance: {
    evidence_head_hash: string | null;
    evidence_entries: number;
    measurements: number;
    measurement_sources: string[];
    guarantee_status: string | null;
  };
  assessed_at?: string;
}

export interface ClearingSettings {
  user_id: string;
  min_release_confidence: number;
  dispute_window_days: number;
  auto_settle: boolean;
  auto_open: boolean;
}

export interface ClearingTotals {
  records: number;
  claimed: number;
  verified: number;
  partially_verified: number;
  unverified: number;
  disputed: number;
  settled: number;
  avg_confidence: number | null;
}

export interface ClearingRow {
  id: string;
  job_id: string;
  status: ClearingStatus;
  confidence: number;
  band: ConfidenceBand;
  outcome_type: OutcomeType;
  claim_statement: string;
  verified_at: string | null;
  dispute_window_ends_at: string | null;
  settled_at: string | null;
  customer_confirmed: boolean;
  public_enabled: boolean;
  open_dispute: boolean;
  customer_name: string | null;
  service_type: string | null;
  technician_name: string | null;
  created_at: string;
}

export interface ClearingCandidate {
  job_id: string;
  customer_name: string | null;
  service_type: string | null;
  address: string | null;
  completed_at: string | null;
  technician_name: string | null;
}

export interface ClearingOverview {
  is_manager: boolean;
  settings: ClearingSettings;
  totals: ClearingTotals;
  money: { cleared_cents: number; held_cents: number; executed_cents: number } | null;
  records: ClearingRow[];
  candidates: ClearingCandidate[];
}

export interface ClearingRecord {
  id: string;
  job_id: string;
  technician_id: string | null;
  outcome_type: OutcomeType;
  claim_statement: string;
  status: ClearingStatus;
  status_before_dispute: ClearingStatus | null;
  confidence: number;
  confidence_band: ConfidenceBand;
  assessment: Assessment | Record<string, never>;
  assessed_at: string | null;
  evidence_head_hash: string | null;
  evidence_entries: number;
  verified_at: string | null;
  dispute_window_ends_at: string | null;
  settled_at: string | null;
  settle_override_note: string | null;
  void_reason: string | null;
  customer_confirmed_at: string | null;
  public_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChainProof {
  valid: boolean;
  entries: number;
  broken_seq: number | null;
  reason: string | null;
  head_hash: string | null;
}

export interface ClearingEvent {
  id: string;
  seq: number;
  event_type: string;
  payload: Record<string, unknown>;
  actor_type: 'technician' | 'staff' | 'customer' | 'system' | 'external';
  actor_name: string | null;
  recorded_at: string;
  prev_hash: string | null;
  entry_hash: string;
}

export interface Measurement {
  id: string;
  metric_key: string;
  label: string;
  unit: string | null;
  phase: MeasurementPhase;
  value: number;
  expected_min: number | null;
  expected_max: number | null;
  source: MeasurementSource;
  device_ref: string | null;
  captured_at: string;
  within_spec: boolean | null;
}

export interface Dispute {
  id: string;
  opened_by_type: 'customer' | 'staff' | 'insurer' | 'system';
  reason_code: DisputeReason;
  description: string;
  status: DisputeStatus;
  resolution_note: string | null;
  opened_at: string;
  resolved_at: string | null;
}

export interface SettlementLeg {
  id: string;
  kind: LegKind;
  status: LegStatus;
  hold_reason: string | null;
  amount_cents: number | null;
  executed_ref: string | null;
  cleared_at: string | null;
  executed_at: string | null;
}

export interface ClearingDetail {
  is_manager: boolean;
  record: ClearingRecord;
  job: {
    id: string;
    customer_name: string | null;
    service_type: string | null;
    address: string | null;
    job_status: string | null;
    completed_at: string | null;
    invoice_amount: number | null;
    technician_name: string | null;
  };
  chain: ChainProof;
  events: ClearingEvent[];
  measurements: Measurement[];
  disputes: Dispute[];
  settlements: SettlementLeg[];
}

export interface ReputationRow {
  team_member_id: string | null;
  name: string;
  outcomes: number;
  verified: number;
  verified_rate: number;
  avg_confidence: number;
  disputes: number;
  disputes_upheld: number;
  score: number;
  provisional: boolean;
}

export interface ShareLinks {
  public_enabled: boolean;
  verify_token: string;
  customer_token: string;
}

export interface PublicOutcome {
  role: 'customer' | 'verifier';
  business_name: string | null;
  outcome_type: OutcomeType;
  claim_statement: string;
  status: ClearingStatus;
  confidence: number;
  band: ConfidenceBand;
  completed_on: string | null;
  verified_at: string | null;
  settled_at: string | null;
  customer_confirmed: boolean;
  open_dispute: boolean;
  can_respond: boolean;
  can_dispute: boolean;
  components: Array<{ key: string; label: string; weight: number; points: number }>;
  measurements: Array<{
    label: string;
    phase: MeasurementPhase;
    value: number;
    unit: string | null;
    expected_min: number | null;
    expected_max: number | null;
    within_spec: boolean | null;
    source: MeasurementSource;
    captured_at: string;
  }>;
  proof: { ledger: ChainProof; evidence_head_hash: string | null; evidence_entries: number; assessed_at: string | null };
  generated_at: string;
}

export interface MeasurementInput {
  metricKey: string;
  label: string;
  unit: string;
  phase: MeasurementPhase;
  value: string;
  expectedMin: string;
  expectedMax: string;
  source: 'technician' | 'device';
  deviceRef: string;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

export const shortHash = (h: string | null | undefined, n = 10): string => (h ? `${h.slice(0, n)}…` : '—');

export function bandFor(confidence: number): ConfidenceBand {
  if (confidence >= 85) return 'high';
  if (confidence >= 70) return 'moderate';
  if (confidence >= 40) return 'low';
  return 'insufficient';
}

export function confidenceTone(confidence: number): 'good' | 'warn' | 'bad' {
  if (confidence >= 70) return 'good';
  if (confidence >= 40) return 'warn';
  return 'bad';
}

/** Mirrors the server rule so the UI can preview it; the server stays authoritative. */
export function evaluateSpec(value: number, min: number | null, max: number | null): boolean | null {
  if (!Number.isFinite(value)) return null;
  if (min === null && max === null) return null;
  return (min === null || value >= min) && (max === null || value <= max);
}

/** Parses a decimal typed by a user; accepts a comma as decimal separator. Returns null when empty/invalid. */
export function parseNumber(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  if (t === '') return null;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function slugifyMetric(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

export interface MeasurementValidation {
  ok: boolean;
  error?: string;
  value?: number;
  min?: number | null;
  max?: number | null;
  key?: string;
}

export function validateMeasurement(input: MeasurementInput): MeasurementValidation {
  const label = input.label.trim();
  if (label.length < 1 || label.length > 80) return { ok: false, error: 'Enter a label (up to 80 characters).' };
  const key = (input.metricKey.trim() || slugifyMetric(label)).toLowerCase();
  if (!/^[a-z0-9_]{2,48}$/.test(key)) return { ok: false, error: 'Metric key must be 2-48 characters: a-z, 0-9 and _.' };
  const value = parseNumber(input.value);
  if (value === null) return { ok: false, error: 'Enter the measured value as a number.' };
  const min = parseNumber(input.expectedMin);
  const max = parseNumber(input.expectedMax);
  if (input.expectedMin.trim() !== '' && min === null) return { ok: false, error: 'Expected minimum is not a number.' };
  if (input.expectedMax.trim() !== '' && max === null) return { ok: false, error: 'Expected maximum is not a number.' };
  if (min !== null && max !== null && min > max) return { ok: false, error: 'Expected minimum is above expected maximum.' };
  if (input.source === 'device' && input.deviceRef.trim() === '') return { ok: false, error: 'Name the instrument (model or serial) for a device reading.' };
  if (input.unit.trim().length > 16) return { ok: false, error: 'Unit is too long (16 characters max).' };
  return { ok: true, value, min, max, key };
}

export function windowRemainingMs(rec: Pick<ClearingRecord, 'dispute_window_ends_at'>, now = Date.now()): number | null {
  if (!rec.dispute_window_ends_at) return null;
  return Math.max(0, new Date(rec.dispute_window_ends_at).getTime() - now);
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'closed';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))} min left`;
  if (hours < 48) return `${hours} h left`;
  return `${Math.floor(hours / 24)} days left`;
}

export interface SettleGate {
  allowed: boolean;
  /** true when only a manager override (with a written note) can clear it. */
  needsOverride: boolean;
  reason: string | null;
}

/** Same gating the server enforces (status, dispute window, open dispute). */
export function settleGate(rec: ClearingRecord, now = Date.now()): SettleGate {
  if (rec.status === 'settled') return { allowed: false, needsOverride: false, reason: 'Already settled.' };
  if (rec.status === 'voided') return { allowed: false, needsOverride: false, reason: 'This outcome was voided.' };
  if (rec.status === 'disputed') return { allowed: false, needsOverride: false, reason: 'A dispute is open - resolve it first.' };
  if (rec.status === 'partially_verified') {
    return { allowed: false, needsOverride: true, reason: 'Partially verified: a manager can clear it with a written reason.' };
  }
  if (rec.status !== 'verified') {
    return { allowed: false, needsOverride: false, reason: 'Only verified outcomes can be settled.' };
  }
  const remaining = windowRemainingMs(rec, now);
  if (remaining === null || remaining > 0) {
    return { allowed: false, needsOverride: true, reason: remaining === null ? 'Dispute window not started.' : `Dispute window open (${formatRemaining(remaining)}).` };
  }
  return { allowed: true, needsOverride: false, reason: null };
}

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(cents / 100);
}

export function formatSpec(m: { expected_min: number | null; expected_max: number | null; unit: string | null }): string {
  const u = m.unit ? ` ${m.unit}` : '';
  if (m.expected_min !== null && m.expected_max !== null) return `${m.expected_min}–${m.expected_max}${u}`;
  if (m.expected_min !== null) return `≥ ${m.expected_min}${u}`;
  if (m.expected_max !== null) return `≤ ${m.expected_max}${u}`;
  return 'no range';
}

const ERROR_PREFIXES: Array<[string, string]> = [
  ['OUTCOME_CLEARING_FORBIDDEN', 'You do not have permission to do that.'],
  ['OUTCOME_CLEARING_NOT_FOUND', 'That record could not be found.'],
  ['OUTCOME_CLEARING_DISPUTE_OPEN', 'A dispute is already open on this outcome.'],
  ['OUTCOME_CLEARING_WINDOW_OPEN', 'The dispute window is still open.'],
];

/** Turns a Supabase/Postgres error into a short, human message. */
export function clearingErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const raw = typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : '';
  if (!raw.includes('OUTCOME_CLEARING_')) return fallback;
  const detail = raw.replace(/^.*?OUTCOME_CLEARING_[A-Z_]+:\s*/s, '').trim();
  if (detail && detail !== raw) return detail.charAt(0).toUpperCase() + detail.slice(1);
  for (const [prefix, msg] of ERROR_PREFIXES) if (raw.includes(prefix)) return msg;
  return fallback;
}

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args ?? {});
  if (error) throw error;
  return data as T;
}

export const fetchOverview = (limit = 150) => rpc<ClearingOverview>('outcome_clearing_overview', { p_limit: limit });
export const fetchDetail = (recordId: string) => rpc<ClearingDetail>('outcome_clearing_record_detail', { p_record_id: recordId });
export const fetchReputation = () => rpc<ReputationRow[]>('outcome_clearing_reputation');
export const verifyLedger = (recordId: string) => rpc<ChainProof>('outcome_clearing_verify', { p_record_id: recordId });

export const openRecord = (jobId: string, type: OutcomeType = 'repair_restored', claim?: string) =>
  rpc<string>('outcome_clearing_open', { p_job_id: jobId, p_outcome_type: type, p_claim: claim?.trim() || null });

export const assessNow = (recordId: string) => rpc<unknown>('outcome_clearing_assess_now', { p_record_id: recordId });

export function addMeasurement(recordId: string, v: Required<Pick<MeasurementValidation, 'value' | 'key'>> & {
  min: number | null; max: number | null; input: MeasurementInput;
}) {
  return rpc<unknown>('outcome_clearing_add_measurement', {
    p_record_id: recordId,
    p_metric_key: v.key,
    p_label: v.input.label.trim(),
    p_unit: v.input.unit.trim() || null,
    p_phase: v.input.phase,
    p_value: v.value,
    p_expected_min: v.min,
    p_expected_max: v.max,
    p_source: v.input.source,
    p_device_ref: v.input.deviceRef.trim() || null,
  });
}

export const openDispute = (recordId: string, reason: DisputeReason, description: string, reportedBy: 'staff' | 'customer' | 'insurer' = 'staff') =>
  rpc<string>('outcome_clearing_open_dispute', { p_record_id: recordId, p_reason: reason, p_description: description.trim(), p_reported_by: reportedBy });

export const resolveDispute = (disputeId: string, resolution: DisputeResolution, note: string) =>
  rpc<unknown>('outcome_clearing_resolve_dispute', { p_dispute_id: disputeId, p_resolution: resolution, p_note: note.trim() });

export const settleRecord = (recordId: string, overrideNote?: string) =>
  rpc<unknown>('outcome_clearing_settle', { p_record_id: recordId, p_override_note: overrideNote?.trim() || null });

export const executeLeg = (legId: string, reference: string) =>
  rpc<unknown>('outcome_clearing_execute_leg', { p_leg_id: legId, p_reference: reference.trim() });

export const voidRecord = (recordId: string, reason: string) =>
  rpc<unknown>('outcome_clearing_void', { p_record_id: recordId, p_reason: reason.trim() });

export const setPublic = (recordId: string, enabled: boolean) =>
  rpc<unknown>('outcome_clearing_set_public', { p_record_id: recordId, p_enabled: enabled });

export const getShareLinks = (recordId: string) => rpc<ShareLinks>('outcome_clearing_share_links', { p_record_id: recordId });
export const rotateTokens = (recordId: string) => rpc<ShareLinks>('outcome_clearing_rotate_tokens', { p_record_id: recordId });

export const saveSettings = (s: Pick<ClearingSettings, 'min_release_confidence' | 'dispute_window_days' | 'auto_settle' | 'auto_open'>) =>
  rpc<unknown>('outcome_clearing_save_settings', {
    p_min_confidence: s.min_release_confidence,
    p_dispute_window_days: s.dispute_window_days,
    p_auto_settle: s.auto_settle,
    p_auto_open: s.auto_open,
  });

export const fetchPublicOutcome = (token: string) => rpc<PublicOutcome | null>('outcome_clearing_public_view', { p_token: token });

export const respondPublic = (token: string, action: 'confirm' | 'dispute', reason?: DisputeReason, description?: string) =>
  rpc<{ ok: boolean }>('outcome_clearing_public_respond', {
    p_token: token,
    p_action: action,
    p_reason: reason ?? null,
    p_description: description?.trim() ?? null,
  });

export function verifyUrl(origin: string, token: string): string {
  return `${origin}/outcome/${token}`;
}
