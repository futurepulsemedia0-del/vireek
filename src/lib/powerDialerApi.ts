/**
 * Power dialer - data access. Reads are scoped by account_owner_id (RLS enforces it too); every state
 * change goes through a database function so pacing, DNC and disposition rules cannot be bypassed.
 */
import { supabase } from '@/lib/supabase';
import {
  dialerErrorMessage, parseWrapUp,
  type CallerIdOption, type CampaignForm, type CampaignStatus, type DialerCampaign, type DialerContact, type DialerStats, type Disposition,
} from '@/lib/powerDialer';

const CAMPAIGN_COLS =
  'id, name, description, status, pacing_mode, preview_seconds, wrap_up_seconds, max_attempts, retry_minutes, max_calls_per_hour, phone_number_id, script, created_at';
const CONTACT_COLS = 'id, campaign_id, name, phone_e164, notes, status, attempts, last_disposition, next_attempt_at, claim_expires_at';

interface PgError { code?: string; message: string; details?: string | null }
const fail = (e: PgError) => new Error(dialerErrorMessage(e));

export class WrapUpError extends Error {
  constructor(public seconds: number) { super('Wrap-up in progress'); }
}

export async function fetchCampaigns(ownerId: string): Promise<DialerCampaign[]> {
  const { data, error } = await supabase.from('dialer_campaigns').select(CAMPAIGN_COLS).eq('account_owner_id', ownerId).order('created_at', { ascending: false });
  if (error) throw fail(error);
  return (data as unknown as DialerCampaign[]) ?? [];
}

export async function fetchCampaign(ownerId: string, id: string): Promise<DialerCampaign | null> {
  const { data, error } = await supabase.from('dialer_campaigns').select(CAMPAIGN_COLS).eq('account_owner_id', ownerId).eq('id', id).maybeSingle();
  if (error) throw fail(error);
  return (data as unknown as DialerCampaign | null) ?? null;
}

export async function fetchStats(ownerId: string): Promise<Record<string, DialerStats>> {
  const { data, error } = await supabase
    .from('dialer_campaign_stats')
    .select('campaign_id, total_contacts, ready_now, pending, claimed, done, dnc, total_attempts, booked, interested')
    .eq('account_owner_id', ownerId);
  if (error) throw fail(error);
  const map: Record<string, DialerStats> = {};
  for (const r of (data as unknown as DialerStats[]) ?? []) map[r.campaign_id] = r;
  return map;
}

export async function fetchCallerIds(ownerId: string): Promise<CallerIdOption[]> {
  const { data, error } = await supabase
    .from('phone_numbers').select('id, phone_number, friendly_name').eq('account_id', ownerId).eq('status', 'active').eq('voice_enabled', true).order('created_at');
  if (error) return [];
  return (data as unknown as CallerIdOption[]) ?? [];
}

function payload(f: CampaignForm) {
  return {
    name: f.name.trim(), description: f.description.trim() || null, pacing_mode: f.pacing_mode,
    preview_seconds: f.preview_seconds, wrap_up_seconds: f.wrap_up_seconds, max_attempts: f.max_attempts,
    retry_minutes: f.retry_minutes, max_calls_per_hour: f.max_calls_per_hour,
    phone_number_id: f.phone_number_id || null, script: f.script.trim() || null,
  };
}

export async function createCampaign(ownerId: string, f: CampaignForm): Promise<DialerCampaign> {
  const { data, error } = await supabase.from('dialer_campaigns').insert({ account_owner_id: ownerId, ...payload(f) }).select(CAMPAIGN_COLS).single();
  if (error) throw fail(error);
  return data as unknown as DialerCampaign;
}

export async function updateCampaign(id: string, f: CampaignForm): Promise<DialerCampaign> {
  const { data, error } = await supabase.from('dialer_campaigns').update(payload(f)).eq('id', id).select(CAMPAIGN_COLS).single();
  if (error) throw fail(error);
  return data as unknown as DialerCampaign;
}

export async function setCampaignStatus(id: string, status: CampaignStatus): Promise<void> {
  const { error } = await supabase.from('dialer_campaigns').update({ status }).eq('id', id);
  if (error) throw fail(error);
}

export async function importContacts(campaignId: string, rows: { name: string; phone: string; notes?: string }[]) {
  const { data, error } = await supabase.rpc('dialer_import_contacts', { p_campaign_id: campaignId, p_contacts: rows });
  if (error) throw fail(error);
  return data as { received: number; inserted: number; invalid: number; suppressed: number; duplicates: number };
}

export async function importFromCrm(campaignId: string, source: 'customers' | 'leads', filter?: string) {
  const { data, error } = await supabase.rpc('dialer_import_from_crm', { p_campaign_id: campaignId, p_source: source, p_filter: filter || null });
  if (error) throw fail(error);
  return (data as { inserted: number }).inserted;
}

/** Next contact for this agent, or null when nothing is due. Throws WrapUpError during the wrap-up pause. */
export async function claimNext(campaignId: string): Promise<DialerContact | null> {
  const { data, error } = await supabase.rpc('dialer_claim_next', { p_campaign_id: campaignId });
  if (error) {
    const wrap = parseWrapUp(error);
    if (wrap !== null) throw new WrapUpError(wrap);
    throw fail(error);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return (row as DialerContact | undefined) ?? null;
}

export type DialResult = { kind: 'placed' } | { kind: 'blocked'; reason: 'dnc' | 'quiet_hours'; retryAt?: string } | { kind: 'not_configured' };

export async function placeCall(contactId: string): Promise<DialResult> {
  const { data, error } = await supabase.functions.invoke('dialer-call', { body: { contact_id: contactId } });
  if (error) {
    let code = 'twilio_failed';
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) code = ((await ctx.json()) as { error?: string }).error ?? code;
    } catch { /* keep default */ }
    if (code === 'not_configured') return { kind: 'not_configured' };
    throw new Error(dialerErrorMessage({ message: code }));
  }
  const d = (data ?? {}) as { blocked?: 'dnc' | 'quiet_hours'; retry_at?: string; error?: string };
  if (d.error) throw new Error(dialerErrorMessage({ message: d.error }));
  if (d.blocked) return { kind: 'blocked', reason: d.blocked, retryAt: d.retry_at };
  return { kind: 'placed' };
}

export async function completeAttempt(contactId: string, disposition: Disposition, note: string, callbackAt: string | null): Promise<void> {
  const { error } = await supabase.rpc('dialer_complete_attempt', {
    p_contact_id: contactId, p_disposition: disposition, p_note: note.trim() || null, p_callback_at: callbackAt,
  });
  if (error) throw fail(error);
}

export async function deferContact(contactId: string, until: Date): Promise<void> {
  const { error } = await supabase.rpc('dialer_defer_contact', { p_contact_id: contactId, p_until: until.toISOString() });
  if (error) throw fail(error);
}

export async function fetchRecentContacts(campaignId: string): Promise<DialerContact[]> {
  const { data, error } = await supabase
    .from('dialer_contacts').select(CONTACT_COLS).eq('campaign_id', campaignId).not('last_attempt_at', 'is', null)
    .order('last_attempt_at', { ascending: false }).limit(15);
  if (error) throw fail(error);
  return (data as unknown as DialerContact[]) ?? [];
}
