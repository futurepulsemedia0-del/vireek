import { supabase } from '@/lib/supabase';
import {
  csvCell,
  validateAttachment,
  type HazardCategory,
  type IncidentCategory,
  type IncidentSeverity,
  type IncidentStatus,
  type Precaution,
  type RegionProfile,
  type RiskTier,
} from '@/lib/safety/core';

/**
 * Site Safety Intelligence — client API.
 * The database and the safety-api / safety-tick edge functions are the authority. This file is thin
 * wrappers plus a tiny offline queue. All decision logic lives in src/lib/safety/core.ts.
 */

export * from '@/lib/safety/core';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export interface BriefFact {
  id: string;
  category: HazardCategory;
  text: string;
  source: string;
  occurred_on: string;
  expires_on: string;
  status: 'confirmed' | 'unreviewed';
  quote?: string | null;
  review_note?: string | null;
}

export interface SafetyBrief {
  enabled: boolean;
  tier?: RiskTier;
  computed_tier?: RiskTier;
  overridden?: boolean;
  capped_pending_review?: boolean;
  precautions?: Precaution[];
  outside_daytime?: boolean;
  acknowledged?: boolean;
  site_known?: boolean;
  facts?: BriefFact[];
  job_flag?: { note: string | null } | null;
  contact?: string;
}

export interface MySession {
  active: boolean;
  session_id?: string;
  status?: 'active' | 'escalating';
  is_drill?: boolean;
  started_at?: string;
  expected_end_at?: string;
  next_checkin_due_at?: string;
  last_checkin_at?: string | null;
}

export interface StartSessionResult {
  success: boolean;
  error?: 'safety_disabled' | 'consent_required' | 'drills_disabled';
  session_id?: string;
  existing?: boolean;
  next_checkin_due_at?: string;
  expected_end_at?: string;
  is_drill?: boolean;
}

export interface Transparency {
  enabled: boolean;
  is_member: boolean;
  region_profile: RegionProfile;
  notice_version: number;
  monitoring_consent_required: boolean;
  location_sharing_enabled: boolean;
  location_visibility: 'on_escalation' | 'during_job';
  location_retention_days: number;
  checkin_interval_minutes: number;
  chain_steps: string[];
  duress_word_enabled: boolean;
  sms_fallback_enabled: boolean;
  consent_action: 'granted' | 'revoked' | null;
  consent_version: number | null;
  consent_current: boolean;
  location_opt_in: boolean;
  has_emergency_contact: boolean;
  emergency_contact_name: string | null;
  has_duress_word: boolean;
  sms_number: string | null;
  stored_location_points: number;
}

export interface SafetySettings {
  enabled: boolean;
  region_profile: RegionProfile;
  labor_review_ack: boolean;
  monitoring_consent_required: boolean;
  notice_version: number;
  location_sharing_enabled: boolean;
  location_visibility: 'on_escalation' | 'during_job';
  location_retention_days: number;
  checkin_interval_minutes: number;
  checkin_grace_minutes: number;
  overrun_prompt_minutes: number;
  unreachable_minutes: number;
  escalation_chain: Array<{ step: string; delay_min: number }>;
  dispatcher_phone: string | null;
  company_next_phone: string | null;
  duress_word_enabled: boolean;
  sms_fallback_enabled: boolean;
  drills_enabled: boolean;
  fact_ttl_days: number;
  show_unreviewed_call_facts: boolean;
  auto_notify_customer_on_decline: boolean;
  decline_customer_message: string | null;
  appeal_contact: string | null;
  incident_retention_months: number;
  timezone: string;
}

export interface ActiveSession {
  session_id: string;
  status: 'active' | 'escalating' | 'duress';
  is_drill: boolean;
  started_at: string;
  expected_end_at: string;
  next_checkin_due_at: string;
  last_checkin_at: string | null;
  last_seen_at: string;
  technician_name: string | null;
  job_id: string;
  customer_name: string;
  address: string | null;
  last_location: { lat: number; lng: number; accuracy_m: number | null; recorded_at: string } | null;
}

export interface FactRowManager {
  id: string;
  category: HazardCategory;
  fact_text: string;
  quote: string | null;
  source: string;
  occurred_on: string;
  expires_on: string;
  review_status: 'pending_review' | 'confirmed' | 'rejected' | 'disputed';
  customer_visible: boolean;
  legal_review: 'not_required' | 'needs_review' | 'approved' | 'blocked';
  appeal_contact: string | null;
  review_due_on: string | null;
  site_key: string;
}

export interface IncidentRow {
  id: string;
  case_number: number;
  category: IncidentCategory;
  severity: IncidentSeverity;
  status: IncidentStatus;
  occurred_at: string;
  description: string;
  job_id: string | null;
  regulatory_reportable: boolean;
  regulator_ref: string | null;
  wellbeing_due_at: string | null;
  wellbeing_checked_at: string | null;
  attachments: Array<{ path: string; name: string; type: string; size: number }>;
  created_at: string;
}

export interface DeclineRow {
  id: string;
  job_id: string;
  team_member_id: string | null;
  action: 'decline' | 'reschedule';
  reason_code: string;
  status: 'open' | 'rescheduled' | 'reassigned' | 'closed';
  customer_notice_status: 'pending' | 'sent' | 'skipped' | 'failed';
  created_at: string;
}

export interface AuditRow {
  id: string;
  period_start: string;
  period_end: string;
  finding_count: number;
  status: 'open' | 'reviewed_no_action' | 'action_required' | 'actioned';
  review_note: string | null;
  report: {
    jobs: number;
    flagged_jobs: number;
    overall_flag_rate: number;
    findings: Array<{ code: string; detail: Record<string, number | string> }>;
    by_area: Array<{ area: string; jobs: number; flagged: number; rate: number; ratio: number }>;
    overturn_by_source: Array<{ source: string; reviewed: number; rejected: number; rate: number }>;
  };
}

export interface Trends {
  incidents: Array<{ month: string; category: IncidentCategory; severity: IncidentSeverity; count: number }>;
  sessions: Array<{ month: string; total: number; escalated: number; duress: number; false_alarms: number }>;
  declines: Array<{ month: string; count: number }>;
}

/* ------------------------------------------------------------------ */
/*  RPC plumbing                                                        */
/* ------------------------------------------------------------------ */

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

async function api<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('safety-api', { body });
  if (error) throw new Error(error.message);
  return data as T;
}

/* ------------------------------------------------------------------ */
/*  Technician                                                          */
/* ------------------------------------------------------------------ */

export const fetchBrief = (jobId: string) => api<SafetyBrief>({ action: 'brief', job_id: jobId });
export const ackBrief = (jobId: string) => api<{ ok: boolean }>({ action: 'ack_brief', job_id: jobId });
export const addFact = (input: { jobId: string; category: HazardCategory; text: string; occurredOn?: string; source?: string }) =>
  api<{ ok?: boolean; id?: string; error?: string; codes?: string[] }>({
    action: 'add_fact', job_id: input.jobId, category: input.category, fact_text: input.text, occurred_on: input.occurredOn, source: input.source,
  });

export const fetchMySession = (jobId: string) => rpc<MySession>('safety_my_session', { p_job_id: jobId });
export const startSession = (jobId: string, expectedMinutes?: number, drill = false) =>
  rpc<StartSessionResult>('safety_start_session', { p_job_id: jobId, p_expected_minutes: expectedMinutes ?? null, p_drill: drill });
export const heartbeat = (sessionId: string) => rpc<void>('safety_heartbeat', { p_session: sessionId });
export const extendSession = (sessionId: string, minutes: number) => rpc<{ success: boolean; expected_end_at: string }>('safety_extend', { p_session: sessionId, p_minutes: minutes });
export const endSession = (sessionId: string, outcome: 'completed' | 'cancelled' | 'false_alarm' = 'completed') =>
  rpc<{ success: boolean }>('safety_end_session', { p_session: sessionId, p_outcome: outcome });

/** Wake the engine right away instead of waiting for the next cron minute. Best effort. */
export async function pokeEngine(sessionId: string): Promise<void> {
  try {
    await supabase.functions.invoke('safety-tick', { body: { mode: 'session', session_id: sessionId } });
  } catch {
    /* the cron run is the safety net */
  }
}

export async function checkIn(sessionId: string, method: 'tap' | 'voice' = 'tap', text?: string) {
  return rpc<{ success: boolean; status?: string; next_checkin_due_at?: string; error?: string }>('safety_checkin', { p_session: sessionId, p_method: method, p_text: text ?? null });
}

export async function raiseDuress(sessionId: string): Promise<void> {
  await rpc('safety_duress', { p_session: sessionId });
  void pokeEngine(sessionId);
}

export const requestDecline = (jobId: string, action: 'decline' | 'reschedule', reason: string, note?: string) =>
  rpc<{ success: boolean; existing?: boolean; id?: string }>('safety_request_decline', { p_job_id: jobId, p_action: action, p_reason: reason, p_note: note ?? null });

export const fetchTransparency = () => rpc<Transparency>('safety_my_transparency');
export const setConsent = (action: 'granted' | 'revoked') =>
  rpc<{ success: boolean }>('safety_set_consent', { p_action: action, p_source: 'app', p_user_agent: typeof navigator === 'undefined' ? null : navigator.userAgent.slice(0, 300) });
export const setMyPrefs = (p: { locationOptIn?: boolean; contactName?: string; contactPhone?: string; clearContact?: boolean; duressWord?: string; clearDuress?: boolean }) =>
  rpc<{ success: boolean }>('safety_set_my_prefs', {
    p_location_opt_in: p.locationOptIn ?? null,
    p_contact_name: p.contactName ?? null,
    p_contact_phone: p.contactPhone ?? null,
    p_clear_contact: p.clearContact ?? false,
    p_duress_word: p.duressWord ?? null,
    p_clear_duress: p.clearDuress ?? false,
  });

export async function recordLocation(sessionId: string, p: { lat: number; lng: number; accuracy: number | null; at: number }) {
  return rpc<{ stored: boolean; reason?: string }>('safety_record_location', {
    p_session: sessionId, p_lat: p.lat, p_lng: p.lng, p_accuracy: p.accuracy, p_recorded_at: new Date(p.at).toISOString(),
  });
}

/* ------------------------------------------------------------------ */
/*  Incidents (technician + manager)                                    */
/* ------------------------------------------------------------------ */

export const reportIncident = (i: { category: IncidentCategory; severity: IncidentSeverity; description: string; jobId?: string | null; occurredAt?: string }) =>
  rpc<{ success: boolean; id: string; case_number: number; wellbeing_due_at: string | null }>('safety_report_incident', {
    p: { category: i.category, severity: i.severity, description: i.description, job_id: i.jobId ?? null, occurred_at: i.occurredAt ?? null },
  });

export async function uploadIncidentAttachment(ownerId: string, incidentId: string, file: File, existingCount: number): Promise<string | null> {
  const problem = validateAttachment({ type: file.type, size: file.size }, existingCount);
  if (problem) return problem;
  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100) || 'file';
  const path = `${ownerId}/${incidentId}/${Date.now()}-${safeName}`.slice(0, 300);
  const { error } = await supabase.storage.from('safety-attachments').upload(path, file, { contentType: file.type, upsert: false });
  if (error) return 'upload_failed';
  try {
    await rpc('safety_incident_add_attachment', { p_id: incidentId, p_path: path, p_name: file.name, p_type: file.type, p_size: file.size });
  } catch {
    return 'register_failed';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Manager                                                             */
/* ------------------------------------------------------------------ */

export async function fetchSettings(): Promise<{ configured: boolean; settings: SafetySettings | null; policy: Partial<Record<RiskTier, Precaution[]>> }> {
  return rpc('safety_get_settings');
}
export const saveSettings = (patch: Partial<SafetySettings>) => rpc<{ success: boolean; notice_bumped: boolean; notice_version: number }>('safety_save_settings', { p: patch });
export const savePolicy = (tier: RiskTier, precautions: Precaution[]) => rpc<{ success: boolean }>('safety_save_policy', { p_tier: tier, p_precautions: precautions });
export const fetchActiveSessions = () => rpc<ActiveSession[]>('safety_active_sessions');
export const managerEndSession = endSession;

export async function listFacts(status: FactRowManager['review_status'] | 'all' = 'pending_review', limit = 100): Promise<FactRowManager[]> {
  let q = supabase.from('safety_hazard_facts')
    .select('id, category, fact_text, quote, source, occurred_on, expires_on, review_status, customer_visible, legal_review, appeal_contact, review_due_on, site_key')
    .order('created_at', { ascending: false }).limit(limit);
  if (status !== 'all') q = q.eq('review_status', status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as FactRowManager[];
}
export const reviewFact = (id: string, action: 'confirm' | 'reject' | 'dispute' | 'reopen' | 'update_notice', extra: { note?: string; legalReview?: string; customerVisible?: boolean; appealContact?: string; reviewDueOn?: string } = {}) =>
  rpc<{ success: boolean }>('safety_review_fact', {
    p_id: id, p_action: action, p_note: extra.note ?? null, p_legal_review: extra.legalReview ?? null,
    p_customer_visible: extra.customerVisible ?? null, p_appeal_contact: extra.appealContact ?? null, p_review_due_on: extra.reviewDueOn ?? null,
  });

const INCIDENT_COLS = 'id, case_number, category, severity, status, occurred_at, description, job_id, regulatory_reportable, regulator_ref, wellbeing_due_at, wellbeing_checked_at, attachments, created_at';
export async function listIncidents(limit = 200): Promise<IncidentRow[]> {
  const { data, error } = await supabase.from('safety_incidents').select(INCIDENT_COLS).order('occurred_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as IncidentRow[];
}
export const transitionIncident = (id: string, to: IncidentStatus, note?: string) => rpc<{ success: boolean }>('safety_incident_transition', { p_id: id, p_to: to, p_note: note ?? null });
export const addIncidentNote = (id: string, note: string) => rpc<{ success: boolean }>('safety_incident_note', { p_id: id, p_note: note });
export const completeWellbeing = (id: string, note?: string) => rpc<{ success: boolean }>('safety_incident_wellbeing', { p_id: id, p_note: note ?? null });
export const setReportable = (id: string, flag: boolean, ref?: string) => rpc<{ success: boolean }>('safety_incident_set_reportable', { p_id: id, p_flag: flag, p_ref: ref ?? null });

export async function listDeclines(): Promise<DeclineRow[]> {
  const { data, error } = await supabase.from('safety_decline_requests')
    .select('id, job_id, team_member_id, action, reason_code, status, customer_notice_status, created_at').order('created_at', { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as DeclineRow[];
}
export const resolveDecline = (id: string, status: 'rescheduled' | 'reassigned' | 'closed') => rpc<{ success: boolean }>('safety_resolve_decline', { p_id: id, p_status: status });

export const fetchTrends = (months = 12) => rpc<Trends>('safety_trends', { p_months: months });
export async function listAudits(): Promise<AuditRow[]> {
  const { data, error } = await supabase.from('safety_fairness_audits').select('id, period_start, period_end, finding_count, status, review_note, report').order('created_at', { ascending: false }).limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as AuditRow[];
}
export const reviewAudit = (id: string, status: 'reviewed_no_action' | 'action_required' | 'actioned', note?: string) => rpc<{ success: boolean }>('safety_review_audit', { p_id: id, p_status: status, p_note: note ?? null });

/** CSV for regulatory recordkeeping. Cells are formula-injection safe. */
export function incidentsToCsv(rows: IncidentRow[]): string {
  const head = ['case_number', 'occurred_at', 'category', 'severity', 'status', 'regulatory_reportable', 'regulator_ref', 'job_id', 'wellbeing_checked_at', 'description'];
  const lines = rows.map((r) => [r.case_number, r.occurred_at, r.category, r.severity, r.status, r.regulatory_reportable, r.regulator_ref, r.job_id, r.wellbeing_checked_at, r.description].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\r\n');
}

/* ------------------------------------------------------------------ */
/*  Offline + low-signal fallback                                       */
/* ------------------------------------------------------------------ */

const QUEUE_KEY = 'vireek.safety.queue.v1';
const QUEUE_MAX = 20;
const QUEUE_MAX_AGE_MS = 6 * 3_600_000;

export interface QueuedAction {
  kind: 'checkin' | 'duress';
  sessionId: string;
  at: number;
}

function readQueue(): QueuedAction[] {
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter((a): a is QueuedAction => !!a && typeof a === 'object' && ((a as QueuedAction).kind === 'checkin' || (a as QueuedAction).kind === 'duress') && typeof (a as QueuedAction).sessionId === 'string' && typeof (a as QueuedAction).at === 'number');
  } catch {
    return [];
  }
}
function writeQueue(q: QueuedAction[]): void {
  try { window.localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-QUEUE_MAX))); } catch { /* storage full or private mode */ }
}

export function queueAction(a: QueuedAction): void { writeQueue([...readQueue(), a]); }
export function queuedCount(): number { return readQueue().length; }

/** Replays queued actions. A duress is always replayed first. Stale check-ins are dropped; stale duress is not. */
export async function flushQueue(now = Date.now()): Promise<number> {
  const q = readQueue().filter((a) => a.kind === 'duress' || now - a.at < QUEUE_MAX_AGE_MS);
  if (q.length === 0) { writeQueue([]); return 0; }
  const ordered = [...q.filter((a) => a.kind === 'duress'), ...q.filter((a) => a.kind === 'checkin')];
  const left: QueuedAction[] = [];
  let sent = 0;
  for (const a of ordered) {
    try {
      if (a.kind === 'duress') await raiseDuress(a.sessionId);
      else await checkIn(a.sessionId, 'tap');
      sent += 1;
    } catch {
      left.push(a);
    }
  }
  writeQueue(left);
  return sent;
}

/** sms: link for the fallback when there is no data signal. HELP needs no code. */
export function smsHelpHref(smsNumber: string | null): string | null {
  if (!smsNumber || !/^\+?[0-9]{6,15}$/.test(smsNumber)) return null;
  return `sms:${smsNumber}?&body=${encodeURIComponent('HELP')}`;
}

/** Voice check-in using the browser/OS speech recogniser when present. Needs physical-device testing. */
export function voiceCheckinSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return !!(w.SpeechRecognition ?? w.webkitSpeechRecognition);
}

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export function listenForCheckin(lang: string, timeoutMs = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) { resolve(null); return; }
    const rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    rec.onresult = (e) => finish(e.results[0]?.[0]?.transcript?.trim() || null);
    rec.onerror = () => finish(null);
    rec.onend = () => finish(null);
    window.setTimeout(() => { try { rec.stop(); } catch { /* already stopped */ } finish(null); }, timeoutMs);
    try { rec.start(); } catch { finish(null); }
  });
}

/** Is a spoken phrase a plain "I am fine"? Anything else is sent as typed text so the duress word still works. */
export function isPlainOkPhrase(text: string): boolean {
  return /\b(check in|checking in|i'?m (ok|okay|fine|safe)|all (good|fine|ok|okay)|okay|safe)\b/i.test(text);
}
