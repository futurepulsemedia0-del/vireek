/**
 * Vireek Autonomous Emergency Network — dashboard client library.
 *
 * Triage -> Dispatch -> ETA -> Customer updates -> Technician prep -> Job -> Evidence -> Payment -> Follow-up,
 * with the Contractor Network as the fallback when the company cannot respond fast enough.
 *
 * Server counterparts:
 *   supabase/migrations/20270111000000_autonomous_emergency_network.sql
 *   supabase/functions/emergency-network-orchestrator
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type EmergencyTier = 'critical' | 'high' | 'standard';
export type EmergencyTrade = 'hvac' | 'plumbing' | 'electrical' | 'roofing' | 'restoration' | 'locksmith' | 'general';

export type IncidentStatus =
  | 'dispatching'
  | 'assigned'
  | 'network_search'
  | 'network_pending_approval'
  | 'handed_off'
  | 'en_route'
  | 'on_site'
  | 'resolved'
  | 'needs_human'
  | 'cancelled'
  | 'closed';

export type IncidentStage =
  | 'triage'
  | 'dispatch'
  | 'eta'
  | 'customer_updates'
  | 'tech_prep'
  | 'job'
  | 'evidence'
  | 'payment'
  | 'followup'
  | 'done';

export interface EmergencyIncident {
  id: string;
  source: 'call' | 'portal' | 'manual' | 'api';
  job_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  address: string | null;
  description: string | null;
  hazards: string[];
  required_trade: EmergencyTrade;
  severity_tier: EmergencyTier;
  severity_score: number;
  severity_reason: string | null;
  insurance_involved: boolean;
  sla_minutes: number;
  sla_due_at: string;
  status: IncidentStatus;
  stage: IncidentStage;
  assigned_technician_name: string | null;
  eta_minutes_est: number | null;
  decision: {
    route?: string;
    reason?: string;
    candidate?: { score: number; eta_minutes: number } | null;
  };
  handoff_id: string | null;
  partner_name: string | null;
  partner_phone: string | null;
  last_error: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export type EventStage = IncidentStage | 'network' | 'system';

export interface IncidentEvent {
  id: number;
  incident_id: string;
  stage: EventStage;
  outcome: 'ok' | 'skipped' | 'failed' | 'info';
  summary: string;
  actor: string;
  created_at: string;
}

export interface EmergencyNetworkSettings {
  user_id: string;
  enabled: boolean;
  auto_dispatch: boolean;
  auto_network_handoff: boolean;
  max_internal_eta_minutes: number;
  network_wait_minutes: number;
  sla_critical_minutes: number;
  sla_high_minutes: number;
  sla_standard_minutes: number;
  customer_updates: boolean;
  publish_estimated_eta: boolean;
  notify_phone: string | null;
  referral_fee_pct: number;
}

export type SettingsInput = Omit<EmergencyNetworkSettings, 'user_id'>;

export interface DeclareEmergencyInput {
  customer_name: string;
  customer_phone: string;
  address: string;
  description: string;
  hazards: string[];
  insurance_involved: boolean;
}

// ============================================================
// LABELS
// ============================================================

export const TIER_LABELS: Record<EmergencyTier, string> = { critical: 'Critical', high: 'High', standard: 'Standard' };

export const TIER_COLORS: Record<EmergencyTier, string> = {
  critical: 'bg-danger/10 text-danger',
  high: 'bg-warning-500/10 text-warning-500',
  standard: 'bg-bg-tertiary text-text-secondary',
};

export const STATUS_LABELS: Record<IncidentStatus, string> = {
  dispatching: 'Dispatching',
  assigned: 'Technician assigned',
  network_search: 'Searching the network',
  network_pending_approval: 'Needs your approval',
  handed_off: 'Handed to partner',
  en_route: 'Technician en route',
  on_site: 'Work in progress',
  resolved: 'Resolved',
  needs_human: 'Needs a person',
  cancelled: 'Cancelled',
  closed: 'Closed',
};

export const STATUS_COLORS: Record<IncidentStatus, string> = {
  dispatching: 'bg-accent/10 text-accent',
  assigned: 'bg-accent/10 text-accent',
  network_search: 'bg-accent/10 text-accent',
  network_pending_approval: 'bg-warning-500/10 text-warning-500',
  handed_off: 'bg-success-500/10 text-success-500',
  en_route: 'bg-success-500/10 text-success-500',
  on_site: 'bg-success-500/10 text-success-500',
  resolved: 'bg-success-500/10 text-success-500',
  needs_human: 'bg-danger/10 text-danger',
  cancelled: 'bg-bg-tertiary text-text-secondary',
  closed: 'bg-bg-tertiary text-text-secondary',
};

export const TRADE_LABELS: Record<EmergencyTrade, string> = {
  hvac: 'HVAC',
  plumbing: 'Plumbing',
  electrical: 'Electrical',
  roofing: 'Roofing',
  restoration: 'Restoration',
  locksmith: 'Locksmith',
  general: 'General',
};

export const SOURCE_LABELS: Record<EmergencyIncident['source'], string> = {
  call: 'Phone call',
  portal: 'Customer portal',
  manual: 'Dashboard',
  api: 'API',
};

export interface PipelineStep {
  key: IncidentStage;
  label: string;
}

/** The nine steps of the autonomous pipeline, in order. */
export const PIPELINE: PipelineStep[] = [
  { key: 'triage', label: 'Triage' },
  { key: 'dispatch', label: 'Dispatch' },
  { key: 'eta', label: 'ETA' },
  { key: 'customer_updates', label: 'Customer updates' },
  { key: 'tech_prep', label: 'Technician prep' },
  { key: 'job', label: 'Job' },
  { key: 'evidence', label: 'Evidence' },
  { key: 'payment', label: 'Payment' },
  { key: 'followup', label: 'Follow-up' },
];

export const HAZARD_CHOICES: Array<{ id: string; label: string }> = [
  { id: 'gas', label: 'Gas smell' },
  { id: 'smoke', label: 'Smoke / fire' },
  { id: 'electric', label: 'Electrical' },
  { id: 'water', label: 'Water / flooding' },
];

// ============================================================
// PURE HELPERS (unit-tested)
// ============================================================

const ACTIVE_STATUSES: IncidentStatus[] = [
  'dispatching',
  'assigned',
  'network_search',
  'network_pending_approval',
  'handed_off',
  'en_route',
  'on_site',
  'resolved',
  'needs_human',
];

export function isActive(status: IncidentStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function needsAttention(i: Pick<EmergencyIncident, 'status'>): boolean {
  return i.status === 'needs_human' || i.status === 'network_pending_approval';
}

export type SlaState = 'ok' | 'at_risk' | 'breached' | 'met' | 'missed';

export interface SlaView {
  state: SlaState;
  /** Whole minutes; negative once breached. */
  minutesLeft: number;
}

/**
 * Response-target state. "Met" means a technician (or partner) was committed before the deadline,
 * "missed" means the first response came after it.
 */
export function slaView(i: Pick<EmergencyIncident, 'sla_due_at' | 'sla_minutes' | 'first_response_at' | 'created_at'>, now: Date = new Date()): SlaView {
  const due = new Date(i.sla_due_at).getTime();
  if (i.first_response_at) {
    const responded = new Date(i.first_response_at).getTime();
    return { state: responded <= due ? 'met' : 'missed', minutesLeft: Math.floor((due - responded) / 60000) };
  }
  const minutesLeft = Math.floor((due - now.getTime()) / 60000);
  if (minutesLeft < 0) return { state: 'breached', minutesLeft };
  if (minutesLeft <= Math.max(5, Math.floor(i.sla_minutes * 0.25))) return { state: 'at_risk', minutesLeft };
  return { state: 'ok', minutesLeft };
}

export function formatSla(v: SlaView): string {
  const abs = Math.abs(v.minutesLeft);
  const text = abs >= 60 ? `${Math.floor(abs / 60)}h ${abs % 60}m` : `${abs}m`;
  switch (v.state) {
    case 'met':
      return 'Response target met';
    case 'missed':
      return 'Response target missed';
    case 'breached':
      return `Target passed ${text} ago`;
    default:
      return `${text} to response target`;
  }
}

export const SLA_COLORS: Record<SlaState, string> = {
  ok: 'text-text-secondary',
  at_risk: 'text-warning-500',
  breached: 'text-danger',
  met: 'text-success-500',
  missed: 'text-danger',
};

export type StepState = 'done' | 'current' | 'pending' | 'failed';

/** Which pipeline steps are done, current or still ahead for an incident. */
export function pipelineProgress(i: Pick<EmergencyIncident, 'stage' | 'status'>): Array<PipelineStep & { state: StepState }> {
  const currentIndex = i.stage === 'done' ? PIPELINE.length : Math.max(0, PIPELINE.findIndex((s) => s.key === i.stage));
  const failed = i.status === 'needs_human';
  return PIPELINE.map((s, idx) => {
    if (idx < currentIndex) return { ...s, state: 'done' as const };
    if (idx === currentIndex) return { ...s, state: failed ? ('failed' as const) : ('current' as const) };
    return { ...s, state: 'pending' as const };
  });
}

export function formatEtaMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export interface EmergencyStats {
  active: number;
  needsAttention: number;
  withPartner: number;
  slaBreached: number;
}

export function computeStats(incidents: EmergencyIncident[], now: Date = new Date()): EmergencyStats {
  const open = incidents.filter((i) => isActive(i.status));
  return {
    active: open.length,
    needsAttention: open.filter(needsAttention).length,
    withPartner: open.filter((i) => i.status === 'network_search' || i.status === 'handed_off').length,
    slaBreached: open.filter((i) => slaView(i, now).state === 'breached').length,
  };
}

export function validateSettings(s: SettingsInput): string | null {
  if (!Number.isFinite(s.max_internal_eta_minutes) || s.max_internal_eta_minutes < 5 || s.max_internal_eta_minutes > 240) return 'Maximum internal ETA must be between 5 and 240 minutes.';
  if (!Number.isFinite(s.network_wait_minutes) || s.network_wait_minutes < 3 || s.network_wait_minutes > 60) return 'Network wait must be between 3 and 60 minutes.';
  for (const v of [s.sla_critical_minutes, s.sla_high_minutes, s.sla_standard_minutes]) {
    if (!Number.isFinite(v) || v < 10 || v > 1440) return 'Response targets must be between 10 and 1440 minutes.';
  }
  if (!Number.isFinite(s.referral_fee_pct) || s.referral_fee_pct < 0 || s.referral_fee_pct > 50) return 'Referral fee must be between 0 and 50 percent.';
  if (s.notify_phone && !/^\+?[0-9 ()\-]{7,20}$/.test(s.notify_phone.trim())) return 'Enter a valid phone number for emergency alerts.';
  return null;
}

// ============================================================
// API
// ============================================================

function fail(error: { message: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

export async function fetchIncidents(limit = 60): Promise<EmergencyIncident[]> {
  const { data, error } = await supabase
    .from('emergency_incidents')
    .select(
      'id, source, job_id, customer_name, customer_phone, address, description, hazards, required_trade, severity_tier, severity_score, severity_reason, insurance_involved, sla_minutes, sla_due_at, status, stage, assigned_technician_name, eta_minutes_est, decision, handoff_id, partner_name, partner_phone, last_error, first_response_at, resolved_at, created_at, updated_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail(error, 'Could not load emergencies');
  return (data ?? []) as EmergencyIncident[];
}

export async function fetchIncidentEvents(incidentId: string): Promise<IncidentEvent[]> {
  const { data, error } = await supabase
    .from('emergency_incident_events')
    .select('id, incident_id, stage, outcome, summary, actor, created_at')
    .eq('incident_id', incidentId)
    .order('id', { ascending: true });
  if (error) fail(error, 'Could not load the incident timeline');
  return (data ?? []) as IncidentEvent[];
}

export async function fetchSettings(): Promise<EmergencyNetworkSettings> {
  const { data, error } = await supabase.rpc('get_emergency_network_settings');
  if (error || !data) fail(error, 'Could not load Emergency Network settings');
  return data as EmergencyNetworkSettings;
}

export async function saveSettings(s: SettingsInput): Promise<EmergencyNetworkSettings> {
  const problem = validateSettings(s);
  if (problem) throw new Error(problem);
  const { data, error } = await supabase.rpc('set_emergency_network_settings', {
    p_enabled: s.enabled,
    p_auto_dispatch: s.auto_dispatch,
    p_auto_network_handoff: s.auto_network_handoff,
    p_max_internal_eta_minutes: s.max_internal_eta_minutes,
    p_network_wait_minutes: s.network_wait_minutes,
    p_sla_critical_minutes: s.sla_critical_minutes,
    p_sla_high_minutes: s.sla_high_minutes,
    p_sla_standard_minutes: s.sla_standard_minutes,
    p_customer_updates: s.customer_updates,
    p_publish_estimated_eta: s.publish_estimated_eta,
    p_notify_phone: s.notify_phone?.trim() || null,
    p_referral_fee_pct: s.referral_fee_pct,
  });
  if (error || !data) fail(error, 'Could not save Emergency Network settings');
  return data as EmergencyNetworkSettings;
}

export async function declareEmergency(input: DeclareEmergencyInput): Promise<{ incident_id: string; status?: string; error?: string }> {
  const { data, error } = await supabase.functions.invoke('emergency-network-orchestrator', { body: { create: input } });
  if (error) {
    // supabase-js hides the JSON error body behind a generic message; read it when we can.
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const body = (await ctx.json()) as { error?: string };
        if (body?.error) throw new Error(body.error);
      } catch (e) {
        if (e instanceof Error && e.message) throw e;
      }
    }
    throw new Error(error.message || 'Could not declare the emergency');
  }
  if (!data?.incident_id) throw new Error(data?.error || 'Could not declare the emergency');
  return data as { incident_id: string; status?: string; error?: string };
}

/** Process one incident right now instead of waiting for the next cron tick. */
export async function runIncidentNow(incidentId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('emergency-network-orchestrator', { body: { incident_id: incidentId } });
  if (error) throw new Error(error.message || 'Could not run the incident');
}

export async function decideNetworkHandoff(incidentId: string, approve: boolean): Promise<void> {
  const { error } = await supabase.rpc('approve_emergency_network_handoff', { p_incident_id: incidentId, p_approve: approve });
  if (error) fail(error, 'Could not save your decision');
  void runIncidentNow(incidentId).catch(() => undefined); // best-effort immediate action; cron is the safety net
}

export async function retryIncident(incidentId: string): Promise<void> {
  const { error } = await supabase.rpc('retry_emergency_incident', { p_incident_id: incidentId });
  if (error) fail(error, 'Could not retry the incident');
  void runIncidentNow(incidentId).catch(() => undefined);
}

export async function cancelIncident(incidentId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_emergency_incident', { p_incident_id: incidentId, p_reason: reason });
  if (error) fail(error, 'Could not cancel the incident');
}
