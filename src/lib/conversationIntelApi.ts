import { supabase } from '@/lib/supabase';
import type {
  ConsentMode,
  InsightKind,
  RecordingStatus,
  Severity,
  Speaker,
} from '../../supabase/functions/_shared/conversation-intel/engine';

/**
 * Conversation Intelligence — Supabase access. Consent rules, scoping and retention are enforced by
 * RLS + SECURITY DEFINER RPCs (see 20271102000000_conversation_intelligence.sql); nothing here trusts the client.
 */

export const AUDIO_BUCKET = 'conversation-recordings';
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export interface IntelSettings {
  enabled: boolean;
  audio_retention_days: number;
  transcript_retention_days: number;
  auto_create_tasks: boolean;
}

export const DEFAULT_SETTINGS: IntelSettings = {
  enabled: false,
  audio_retention_days: 30,
  transcript_retention_days: 90,
  auto_create_tasks: true,
};

export interface RecordingRow {
  id: string;
  job_id: string | null;
  technician_member_id: string | null;
  customer_name: string | null;
  jurisdiction_state: string | null;
  consent_mode: ConsentMode;
  customer_consent_status: 'not_asked' | 'granted' | 'declined' | 'withdrawn';
  customer_consent_method: string | null;
  customer_consent_at: string | null;
  status: RecordingStatus;
  duration_seconds: number | null;
  summary: string | null;
  analysis_error: string | null;
  analyzed_at: string | null;
  audio_expires_at: string | null;
  created_at: string;
  technician: { member_name: string | null; member_email: string } | null;
}

export interface InsightRow {
  id: string;
  recording_id: string;
  kind: InsightKind;
  text: string;
  speaker: Speaker;
  severity: Severity;
  evidence: string | null;
  due_description: string | null;
  due_at: string | null;
  resolved: boolean | null;
  note: string | null;
  commitment_id: string | null;
  task_id: string | null;
}

export interface CoachingNoteRow {
  recording_id: string;
  technician_member_id: string | null;
  summary: string | null;
  strengths: string[];
  improvements: string[];
  focus_next: string | null;
  score_communication: number | null;
  score_commitment_clarity: number | null;
  score_objection_handling: number | null;
  score_safety_awareness: number | null;
  score_upsell_discovery: number | null;
  created_at: string;
}

export interface RecordingDetail {
  transcript: string | null;
  insights: InsightRow[];
  coaching: CoachingNoteRow | null;
}

export interface CoachingRollupRow {
  technician_member_id: string | null;
  technician_name: string;
  conversations: number;
  avg_communication: number | null;
  avg_commitment_clarity: number | null;
  avg_objection_handling: number | null;
  avg_safety_awareness: number | null;
  avg_upsell_discovery: number | null;
  promises_made: number;
  promises_kept: number;
  promises_broken: number;
  objections_unresolved: number;
  upsells_found: number;
  safety_flags: number;
}

export interface JobOption {
  id: string;
  customer_name: string;
  address: string | null;
}

const RECORDING_COLUMNS =
  'id, job_id, technician_member_id, customer_name, jurisdiction_state, consent_mode, customer_consent_status, ' +
  'customer_consent_method, customer_consent_at, status, duration_seconds, summary, analysis_error, analyzed_at, ' +
  'audio_expires_at, created_at, technician:team_members(member_name, member_email)';

let ownerIdCache: string | null = null;
export async function getOwnerId(): Promise<string> {
  if (ownerIdCache) return ownerIdCache;
  const { data, error } = await supabase.rpc('get_account_owner_id');
  if (error || !data) throw new Error('Could not resolve your account.');
  ownerIdCache = data as string;
  return ownerIdCache;
}

/** Pulls the human message out of a failed Edge Function call. */
async function invokeMessage(error: unknown, fallback: string): Promise<string> {
  try {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      const body = (await ctx.json()) as { error?: string };
      if (body?.error) return body.error;
    }
  } catch {
    /* fall through */
  }
  return fallback;
}

export async function fetchSettings(): Promise<IntelSettings> {
  const { data, error } = await supabase
    .from('conversation_intel_settings')
    .select('enabled, audio_retention_days, transcript_retention_days, auto_create_tasks')
    .maybeSingle();
  if (error) throw error;
  return (data as IntelSettings | null) ?? DEFAULT_SETTINGS;
}

export async function saveSettings(next: IntelSettings): Promise<void> {
  const user_id = await getOwnerId();
  const { error } = await supabase
    .from('conversation_intel_settings')
    .upsert({ user_id, ...next, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function fetchRecordings(limit = 60): Promise<RecordingRow[]> {
  const { data, error } = await supabase
    .from('conversation_recordings')
    .select(RECORDING_COLUMNS)
    .neq('status', 'pending_consent')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as unknown as RecordingRow[]) ?? [];
}

export async function fetchRecordingDetail(id: string): Promise<RecordingDetail> {
  const [rec, ins, coach] = await Promise.all([
    supabase.from('conversation_recordings').select('transcript').eq('id', id).maybeSingle(),
    supabase
      .from('conversation_insights')
      .select('id, recording_id, kind, text, speaker, severity, evidence, due_description, due_at, resolved, note, commitment_id, task_id')
      .eq('recording_id', id)
      .order('created_at', { ascending: true }),
    supabase.from('conversation_coaching_notes').select('*').eq('recording_id', id).maybeSingle(),
  ]);
  if (rec.error) throw rec.error;
  if (ins.error) throw ins.error;
  return {
    transcript: (rec.data as { transcript: string | null } | null)?.transcript ?? null,
    insights: (ins.data as InsightRow[]) ?? [],
    coaching: (coach.data as CoachingNoteRow | null) ?? null,
  };
}

export async function fetchCoachingRollup(days: number): Promise<CoachingRollupRow[]> {
  const { data, error } = await supabase.rpc('get_conversation_coaching_rollup', { p_days: days });
  if (error) throw error;
  return (data as CoachingRollupRow[]) ?? [];
}

export async function fetchRecentJobs(): Promise<JobOption[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, customer_name, address')
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  return (data as JobOption[]) ?? [];
}

// ── Consent session ─────────────────────────────────────────────────────────

export async function startSession(args: {
  jobId: string | null;
  customerName: string;
  state: string | null;
  consentMode: ConsentMode;
  disclosureVersion: string;
  disclosureText: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('start_conversation_session', {
    p_job_id: args.jobId,
    p_customer_name: args.customerName,
    p_state: args.state,
    p_consent_mode: args.consentMode,
    p_disclosure_version: args.disclosureVersion,
    p_disclosure_text: args.disclosureText,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function recordConsent(id: string, granted: boolean, method: 'tap_on_device' | 'both'): Promise<void> {
  const { error } = await supabase.rpc('record_conversation_consent', { p_id: id, p_granted: granted, p_method: method });
  if (error) throw new Error(error.message);
}

export function audioExtension(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase();
  if (base === 'audio/webm') return 'webm';
  if (base === 'audio/ogg') return 'ogg';
  if (base === 'audio/mp4') return 'm4a';
  if (base === 'audio/mpeg') return 'mp3';
  if (base === 'audio/wav') return 'wav';
  return 'webm';
}

export async function uploadAndAttach(id: string, blob: Blob, mime: string, durationSeconds: number): Promise<void> {
  if (blob.size === 0) throw new Error('The recording is empty.');
  if (blob.size > MAX_AUDIO_BYTES) throw new Error('The recording is over 10 MB. Record shorter conversations.');
  const base = mime.split(';')[0].trim().toLowerCase() || 'audio/webm';
  const path = `${await getOwnerId()}/${id}.${audioExtension(base)}`;

  const up = await supabase.storage.from(AUDIO_BUCKET).upload(path, blob, { contentType: base, upsert: false });
  if (up.error) throw new Error('Could not upload the recording. Check your connection and try again.');

  const { error } = await supabase.rpc('attach_conversation_audio', {
    p_id: id,
    p_path: path,
    p_mime: base,
    p_bytes: blob.size,
    p_duration_seconds: Math.round(durationSeconds),
  });
  if (error) throw new Error(error.message);
}

export async function analyzeRecording(id: string): Promise<void> {
  const { error } = await supabase.functions.invoke('conversation-intel-analyze', { body: { recordingId: id } });
  if (error) throw new Error(await invokeMessage(error, 'Analysis failed. You can retry from the conversation list.'));
}

/** Deletes everything derived from a recording; removes the audio object right away (best effort — a cron sweep backs it up). */
export async function discardRecording(id: string): Promise<void> {
  const { error } = await supabase.rpc('discard_conversation_recording', { p_id: id });
  if (error) throw new Error(error.message);
  void supabase.functions.invoke('conversation-intel-purge', { body: {} }).catch(() => undefined);
}

export interface RecentCoachingNote extends CoachingNoteRow {
  recording: { customer_name: string | null; created_at: string } | null;
  technician: { member_name: string | null; member_email: string } | null;
}

export async function fetchRecentCoachingNotes(limit = 12): Promise<RecentCoachingNote[]> {
  const { data, error } = await supabase
    .from('conversation_coaching_notes')
    .select('*, recording:conversation_recordings(customer_name, created_at), technician:team_members(member_name, member_email)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as unknown as RecentCoachingNote[]) ?? [];
}
