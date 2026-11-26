/**
 * Customer Portal Submission — typed client.
 * Reads go through RLS (account-scoped + billing permission). Every write is the `portal-api` edge function or a SECURITY DEFINER RPC.
 * No function here receives or returns a stored credential value: secrets are write-only (credentialsPut); metadata returns field NAMES only.
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export const PORTAL_STATES = ['queued', 'prepared', 'awaiting_human', 'submitting', 'submitted', 'acknowledged', 'approved', 'rejected', 'scheduled_for_payment', 'paid', 'failed', 'cancelled'] as const;
export type PortalState = (typeof PORTAL_STATES)[number];
export type PortalChannel = 'email' | 'assisted' | 'api' | 'automation';
export const PORTAL_TYPES = ['generic', 'yardi_vendorcafe', 'coupa', 'ariba', 'appfolio', 'buildium', 'procore', 'email_ap', 'edi_cxml', 'other'] as const;
export type PortalType = (typeof PORTAL_TYPES)[number];

export interface SubmissionRow { id: string; invoice_id: string; profile_id: string; channel: PortalChannel; packet_version: number; state: PortalState; external_ref: string | null; rejection_reason: string | null; failure_code: string | null; pause_reason: string | null; submitted_at: string | null; state_changed_at: string; created_at: string }
export interface ProfileRow { id: string; customer_id: string; name: string; portal_type: PortalType; portal_url: string | null; ap_email: string | null; channel_preference: PortalChannel; current_version: number; automation_kill: boolean; status: 'active' | 'archived' }
export interface EventRow { id: string; event_type: string; from_state: PortalState | null; to_state: PortalState | null; actor_kind: 'user' | 'system' | 'worker' | 'portal'; created_at: string }
export interface EvidenceRow { id: string; kind: string; created_at: string; redacted: boolean }
export interface RemittanceRow { id: string; status: 'needs_review' | 'confirmed' | 'dismissed'; payment_ref: string | null; paid_on: string | null; created_at: string }
export interface RemittanceLineRow { id: string; remittance_id: string; invoice_number: string; amount_cents: number; match_status: 'matched' | 'amount_mismatch' | 'unmatched' | 'duplicate'; resolution: 'pending' | 'applied' | 'dismissed' }
export interface AccountSettings { submission_enabled: boolean; email_channel_enabled: boolean; assisted_channel_enabled: boolean; api_channel_enabled: boolean; automation_channel_enabled: boolean; automation_kill: boolean; require_approval: boolean }
export interface ProfileStat { profile_id: string; profile_name: string; total: number; succeeded: number; rejected: number; failed: number; success_rate: number | null; median_time_to_submit_seconds: number | null; drift_runs: number }
export interface CopyField { key: string; label: string; value: string; missing: boolean; required: boolean }
export interface AssistedPrep { fields: CopyField[]; checklist: { id: string; text: string }[]; deep_link: string | null; ready: boolean }

export class PortalError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export const DEFAULT_SETTINGS: AccountSettings = { submission_enabled: false, email_channel_enabled: false, assisted_channel_enabled: false, api_channel_enabled: false, automation_channel_enabled: false, automation_kill: false, require_approval: true };

async function call<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('portal-api', { body: { action, ...body } });
  if (error) {
    let code = 'internal_error';
    try { const ctx = (error as { context?: Response }).context; if (ctx) code = ((await ctx.json()) as { error?: string }).error ?? code; } catch { /* keep default */ }
    throw new PortalError(code);
  }
  const r = data as { ok: boolean; data?: T; error?: string };
  if (!r.ok) throw new PortalError(r.error ?? 'internal_error');
  return r.data as T;
}
const toB64 = async (f: File): Promise<string> => {
  const buf = new Uint8Array(await f.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
};

export const newRequestId = (): string => crypto.randomUUID();
export const enqueue = async (a: { invoiceId: string; profileId: string; channel: Exclude<PortalChannel, 'automation'>; requestId: string; packet: File }) =>
  call<{ submission_id: string; duplicate: boolean; state: PortalState }>('enqueue', { invoice_id: a.invoiceId, profile_id: a.profileId, channel: a.channel, request_id: a.requestId, packet_pdf_base64: await toB64(a.packet) });
export const sendEmail = (id: string) => call<{ state: PortalState; message_id: string }>('send_email', { submission_id: id });
export const assistedPrepare = (id: string) => call<AssistedPrep>('assisted_prepare', { submission_id: id });
export const assistedConfirm = async (id: string, reference: string, evidence: File | null) => call<unknown>('assisted_confirm', { submission_id: id, reference, evidence_base64: evidence ? await toB64(evidence) : undefined });
export const recordStatus = (id: string, raw: string, reason?: string) => call<unknown>('record_status', { submission_id: id, raw_status: raw, reason });
export const approveRun = (id: string) => call<unknown>('approve_run', { submission_id: id });
export const cancelSubmission = (id: string) => call<unknown>('cancel', { submission_id: id });
export const retrySubmission = (id: string) => call<unknown>('retry', { submission_id: id });
export const credentialsPut = (profileId: string, secrets: Record<string, string>) => call<{ has_secret: boolean; fields: string[] }>('credentials_put', { profile_id: profileId, secrets });
export const credentialsMeta = (profileId: string) => call<{ has_secret: boolean; fields: string[] }>('credentials_meta', { profile_id: profileId });
export const evidenceUrl = (id: string) => call<{ url: string | null }>('evidence_url', { evidence_id: id });
export const ingestRemittance = async (f: File) => call<{ remittance_id: string; lines: number; needs_manual_entry: boolean }>('remittance_ingest', { file_base64: await toB64(f) });

export async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new PortalError(error.code === '42501' ? 'not_allowed' : error.code === '55000' ? 'feature_disabled' : error.code === '22023' ? 'invalid_input' : 'internal_error');
  return data as T;
}

export interface LoadState<T> { loading: boolean; error: boolean; data: T | null; reload: () => void }
export function usePortalData<T>(loader: () => Promise<T>, deps: readonly unknown[] = []): LoadState<T> {
  const [s, set] = useState<{ loading: boolean; error: boolean; data: T | null }>({ loading: true, error: false, data: null });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    set((p) => ({ ...p, loading: true, error: false }));
    loader().then((data) => { if (live) set({ loading: false, error: false, data }); }).catch(() => { if (live) set({ loading: false, error: true, data: null }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  return { ...s, reload };
}

async function rows<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new PortalError('load_failed');
  return (data ?? []) as T[];
}
export const loadSubmissions = () => rows<SubmissionRow>(supabase.from('portal_submissions').select('id, invoice_id, profile_id, channel, packet_version, state, external_ref, rejection_reason, failure_code, pause_reason, submitted_at, state_changed_at, created_at').order('state_changed_at', { ascending: false }).limit(200));
export const loadProfiles = () => rows<ProfileRow>(supabase.from('customer_portal_profiles').select('id, customer_id, name, portal_type, portal_url, ap_email, channel_preference, current_version, automation_kill, status').order('name'));
export const loadEvents = (id: string) => rows<EventRow>(supabase.from('portal_submission_events').select('id, event_type, from_state, to_state, actor_kind, created_at').eq('submission_id', id).order('created_at'));
export const loadEvidence = (id: string) => rows<EvidenceRow>(supabase.from('portal_evidence').select('id, kind, created_at, redacted').eq('submission_id', id).order('created_at'));
export const loadRemittances = () => rows<RemittanceRow>(supabase.from('portal_remittances').select('id, status, payment_ref, paid_on, created_at').order('created_at', { ascending: false }).limit(100));
export const loadRemittanceLines = (id: string) => rows<RemittanceLineRow>(supabase.from('portal_remittance_lines').select('id, remittance_id, invoice_number, amount_cents, match_status, resolution').eq('remittance_id', id));
export const loadStats = async (): Promise<ProfileStat[]> => (await rpc<ProfileStat[] | null>('portal_profile_stats', { p_days: 90 })) ?? [];
export async function loadSettings(): Promise<AccountSettings> {
  const { data, error } = await supabase.from('portal_account_settings').select('submission_enabled, email_channel_enabled, assisted_channel_enabled, api_channel_enabled, automation_channel_enabled, automation_kill, require_approval').maybeSingle();
  if (error) throw new PortalError('load_failed');
  return (data as AccountSettings | null) ?? DEFAULT_SETTINGS;
}
