/**
 * Vireek Remote Resolution Engine — shared types, labels and pure helpers.
 * No I/O here (see remoteResolutionApi.ts), so everything in this file is unit-testable.
 */

export type RrStatus =
  | 'intake'
  | 'troubleshooting'
  | 'resolved_pending'
  | 'resolved_remotely'
  | 'dispatch_required'
  | 'reopened'
  | 'expired'
  | 'withdrawn';

export type RrBand = 'high' | 'medium' | 'low';
export type RrTone = 'success' | 'warning' | 'danger' | 'neutral';

export type DispatchReason =
  | 'safety'
  | 'low_probability'
  | 'steps_exhausted'
  | 'no_safe_steps'
  | 'insufficient_evidence'
  | 'customer_request'
  | 'customer_not_fixed'
  | 'staff_override';

export type SafetyReason =
  | 'gas'
  | 'carbon_monoxide'
  | 'electrical_hazard'
  | 'fire_smoke'
  | 'flooding'
  | 'sewage'
  | 'structural'
  | 'vulnerable_extreme_temp';

export interface RrQuestion {
  id: string;
  text: string;
  type: 'choice' | 'yes_no' | 'text' | 'number';
  options: string[];
  why: string;
}

export interface RrStep {
  id: string;
  title: string;
  instructions: string;
  expected: string;
  safety_note: string;
  minutes: number;
  result: null | 'no_change' | 'fixed' | 'cannot_do';
}

export interface RrFactor {
  label: string;
  effect: 'up' | 'down' | 'neutral';
  detail: string;
}

export interface RrHypothesis {
  cause: string;
  likelihood: number;
  remote_fixable: boolean;
  needs_parts: boolean;
  evidence_for: string[];
  evidence_against: string[];
}

/** Staff view: a row of remote_resolution_cases. */
export interface RrCase {
  id: string;
  job_id: string;
  status: RrStatus;
  symptom: string;
  locale: string | null;
  category: string;
  safety_hold: boolean;
  safety_reasons: SafetyReason[];
  probability: number | null;
  attempt_probability: number | null;
  band: RrBand | null;
  completeness: number | null;
  factors: RrFactor[];
  hypotheses: RrHypothesis[];
  next_question: RrQuestion | null;
  photo_request: string | null;
  audio_request: string | null;
  steps: RrStep[];
  turns: number;
  truck_roll_cost_cents: number;
  avoided_cost_cents: number | null;
  dispatch_reason: DispatchReason | null;
  ai_provider: string | null;
  expires_at: string;
  decided_at: string | null;
  resolved_at: string | null;
  verification_until: string | null;
  verified_at: string | null;
  reopened_at: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface RrSignal {
  id: string;
  kind: 'answer' | 'photo' | 'audio' | 'sensor' | 'history' | 'step_result' | 'note' | 'system';
  source: 'customer' | 'staff' | 'ai' | 'device' | 'system';
  key: string;
  value: Record<string, unknown>;
  confidence: number | null;
  created_at: string;
}

/** Customer view: what get_remote_resolution_room(token) returns. Never contains the probability. */
export interface RrRoom {
  business_name: string | null;
  customer_first_name: string | null;
  service_type: string | null;
  job_status: string;
  limits: { photos: number; audio: number; turns: number };
  case: null | {
    id: string;
    status: RrStatus;
    symptom: string;
    locale: string | null;
    band: RrBand | null;
    safety_hold: boolean;
    safety_reasons: SafetyReason[];
    next_question: RrQuestion | null;
    photo_request: string | null;
    audio_request: string | null;
    steps: RrStep[];
    turns: number;
    photos_used: number;
    audio_used: number;
    dispatch_reason: DispatchReason | null;
    verification_until: string | null;
    resolved_at: string | null;
    verified_at: string | null;
    updated_at: string;
  };
}

export interface RrSettings {
  enabled: boolean;
  truck_roll_cost_cents: number;
  attempt_threshold: number;
  verification_hours: number;
  hold_hours: number;
}

export interface RrStats {
  days: number;
  cases: number;
  active: number;
  pending_verification: number;
  resolved_remotely: number;
  dispatched: number;
  reopened: number;
  avoided_cost_cents: number;
  pending_savings_cents: number;
  attempted: number;
  resolved_of_attempted: number;
  avg_attempt_probability: number | null;
  brier: number | null;
  calibration: { bucket: number; n: number; predicted: number; actual: number }[];
}

export interface RrDevice {
  id: string;
  equipment_id: string;
  label: string;
  vendor: string | null;
  key_prefix: string;
  active: boolean;
  last_seen_at: string | null;
  created_at: string;
}

export const LIMITS = {
  symptom: [5, 1000] as const,
  freeText: 500,
  photos: 4,
  audio: 2,
  audioSeconds: 8,
};

export const STATUS_META: Record<RrStatus, { label: string; tone: RrTone; active: boolean }> = {
  intake: { label: 'Gathering details', tone: 'warning', active: true },
  troubleshooting: { label: 'Troubleshooting', tone: 'warning', active: true },
  resolved_pending: { label: 'Fixed - verifying', tone: 'success', active: false },
  resolved_remotely: { label: 'Resolved remotely', tone: 'success', active: false },
  dispatch_required: { label: 'Technician needed', tone: 'danger', active: false },
  reopened: { label: 'Problem is back', tone: 'danger', active: false },
  expired: { label: 'Expired', tone: 'neutral', active: false },
  withdrawn: { label: 'Skipped by staff', tone: 'neutral', active: false },
};

export const BAND_META: Record<RrBand, { label: string; tone: RrTone }> = {
  high: { label: 'Likely fixable remotely', tone: 'success' },
  medium: { label: 'Could go either way', tone: 'warning' },
  low: { label: 'Technician likely needed', tone: 'danger' },
};

export const DISPATCH_REASON_LABELS: Record<DispatchReason, string> = {
  safety: 'Safety risk',
  low_probability: 'Unlikely to be fixed remotely',
  steps_exhausted: 'Safe steps did not help',
  no_safe_steps: 'No safe step for the customer to try',
  insufficient_evidence: 'Not enough information after the maximum number of questions',
  customer_request: 'Customer asked for a visit',
  customer_not_fixed: 'Customer says it is not fixed',
  staff_override: 'Staff dispatched',
};

export const CATEGORY_LABELS: Record<string, string> = {
  hvac_cooling: 'AC / cooling',
  hvac_heating: 'Heating',
  plumbing_clog: 'Clog / drain',
  plumbing_leak: 'Leak',
  water_heater: 'Water heater',
  electrical_power: 'Power / electrical',
  appliance: 'Appliance',
  other: 'Other',
  unknown: 'Not classified yet',
};

export const SAFETY_GUIDANCE: Record<SafetyReason, string> = {
  gas: 'If you smell gas: do not use switches, flames or phones inside. Leave the building and call your gas utility or 911 from outside.',
  carbon_monoxide: 'If a carbon monoxide alarm is sounding or anyone feels dizzy or sick: get everyone outside into fresh air and call 911.',
  electrical_hazard: 'Do not touch the equipment. If it is safe to do so, switch off the power at the main breaker. If you see fire or feel unwell, call 911.',
  fire_smoke: 'If there is fire or smoke: leave the building and call 911 immediately.',
  flooding: 'If water is actively flooding: shut off the main water valve if you can reach it safely, and keep clear of anything electrical that is wet.',
  sewage: 'Avoid contact with the water, keep children and pets away, and do not run more water down the drains.',
  structural: 'Stay out of the affected area until it has been inspected.',
  vulnerable_extreme_temp: 'Someone in your home may be at risk from the temperature. Move them to a safe, comfortable place if you can, and call 911 if they feel unwell.',
};

export const METRIC_LABELS: Record<string, string> = {
  supply_air_temp_f: 'Supply air (°F)',
  return_air_temp_f: 'Return air (°F)',
  delta_t_f: 'Temperature drop (°F)',
  indoor_temp_f: 'Indoor temp (°F)',
  outdoor_temp_f: 'Outdoor temp (°F)',
  setpoint_f: 'Thermostat setpoint (°F)',
  humidity_pct: 'Humidity (%)',
  compressor_amps: 'Compressor (A)',
  fan_amps: 'Fan (A)',
  water_pressure_psi: 'Water pressure (psi)',
  water_flow_gpm: 'Water flow (gpm)',
  water_temp_f: 'Water temp (°F)',
  power_voltage: 'Voltage (V)',
  leak_detected: 'Leak detected',
  filter_clogged: 'Filter clogged',
  door_open: 'Door open',
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function formatUsd(cents: number | null | undefined): string {
  const n = (cents ?? 0) / 100;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 1000 ? 0 : 2 });
}

export function isActive(status: RrStatus): boolean {
  return STATUS_META[status].active;
}

/** The case can still be turned into a job closure (the customer said it is fixed). */
export function canCloseJob(status: RrStatus): boolean {
  return status === 'resolved_pending' || status === 'resolved_remotely';
}

export function timeLeftLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'ended';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h left`;
  if (h >= 1) return `${h}h ${m}m left`;
  return `${Math.max(m, 1)}m left`;
}

export function pct(n: number | null | undefined, digits = 0): string {
  return n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(digits)}%`;
}

export function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

/** "Not enough data" below 10 attempted cases: a calibration number on 3 cases is noise, not insight. */
export function calibrationReady(stats: Pick<RrStats, 'attempted'>): boolean {
  return stats.attempted >= 10;
}

export function brierLabel(brier: number | null): string {
  if (brier == null) return 'No data yet';
  if (brier <= 0.12) return 'Excellent';
  if (brier <= 0.2) return 'Good';
  if (brier <= 0.25) return 'Needs more data';
  return 'Poorly calibrated';
}

export const BUCKET_LABELS = ['0-24%', '25-49%', '50-74%', '75-100%'];

export function stepsProgress(steps: RrStep[]): { done: number; total: number } {
  return { done: steps.filter((s) => s.result).length, total: steps.length };
}

export function pendingStep(steps: RrStep[]): RrStep | null {
  return steps.find((s) => !s.result) ?? null;
}

export function resolveLink(token: string, origin: string): string {
  return `${origin}/resolve/${token}`;
}

export function friendlyDbError(message: string): string {
  const m = /^(RR_[A-Z_]+):\s*(.*)$/m.exec(message);
  if (!m) return message.length > 160 ? 'Something went wrong. Please try again.' : message;
  switch (m[1]) {
    case 'RR_NOT_DISPATCHABLE':
      return 'Remote resolution is only available while the job is still scheduled.';
    case 'RR_DISABLED':
      return 'Remote resolution is turned off for this account.';
    case 'RR_FORBIDDEN':
      return m[2] || 'You do not have permission to do that.';
    case 'RR_INVALID_TRANSITION':
      return 'This case already moved on. Refresh and try again.';
    default:
      return m[2] || 'Something went wrong. Please try again.';
  }
}

export function validateSymptom(text: string): string | null {
  const t = text.trim();
  if (t.length < LIMITS.symptom[0]) return `Describe the problem in at least ${LIMITS.symptom[0]} characters.`;
  if (t.length > LIMITS.symptom[1]) return `Keep it under ${LIMITS.symptom[1]} characters.`;
  return null;
}

export function validateSettings(s: RrSettings): string[] {
  const errs: string[] = [];
  if (!Number.isInteger(s.truck_roll_cost_cents) || s.truck_roll_cost_cents < 0 || s.truck_roll_cost_cents > 10_000_000) {
    errs.push('Truck-roll cost must be between $0 and $100,000.');
  }
  if (!Number.isInteger(s.attempt_threshold) || s.attempt_threshold < 20 || s.attempt_threshold > 95) {
    errs.push('Attempt threshold must be between 20% and 95%.');
  }
  if (!Number.isInteger(s.verification_hours) || s.verification_hours < 24 || s.verification_hours > 168) {
    errs.push('Verification window must be 24 to 168 hours.');
  }
  if (!Number.isInteger(s.hold_hours) || s.hold_hours < 1 || s.hold_hours > 24) {
    errs.push('Attempt window must be 1 to 24 hours.');
  }
  return errs;
}

export function respondErrorMessage(code: string): string {
  switch (code) {
    case 'not_active':
      return 'This request has already finished.';
    case 'expired':
      return 'This request has expired. Please contact the business.';
    case 'stale_question':
    case 'stale_step':
      return 'The page was out of date. We refreshed it - please try again.';
    case 'photo_limit':
      return 'You have reached the photo limit.';
    case 'audio_limit':
      return 'You have reached the recording limit.';
    case 'ai_unavailable':
    case 'ai_bad_output':
      return 'Our assistant is busy. Try again in a moment, or ask for a technician.';
    case 'window_closed':
      return 'This remote fix is too old to reopen here. Please contact the business.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
