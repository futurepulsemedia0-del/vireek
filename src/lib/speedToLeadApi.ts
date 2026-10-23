/**
 * Speed-to-lead - data access. Every read is scoped by account_owner_id and protected by RLS
 * (see 20271102000000_speed_to_lead.sql). Consent proof and requests are written only by the server.
 */

import { supabase } from '@/lib/supabase';
import {
  DEFAULT_SETTINGS,
  generateToken,
  sha256Hex,
  type SourceKind,
  type SpeedToLeadMetrics,
  type SpeedToLeadRequest,
  type SpeedToLeadSettings,
  type SpeedToLeadSource,
} from '@/lib/speedToLead';

interface PgError {
  code?: string;
  message: string;
}

function toError(error: PgError, fallback: string): Error {
  if (error.code === '42501') return new Error("You don't have permission to change speed-to-lead settings.");
  if (error.code === '22023') return new Error('That phone number is not valid.');
  if (error.code === '23514') return new Error('One of the values is outside the allowed range.');
  return new Error(fallback);
}

const SETTINGS_COLUMNS =
  'enabled, sla_seconds, max_attempts, retry_delays_minutes, call_window_start, call_window_end, lead_ttl_hours, qualification_notes, notify_on_handoff';
const SOURCE_COLUMNS = 'id, name, kind, token_hint, disclosure_text, disclosure_version, enabled, last_lead_at, created_at';
const REQUEST_COLUMNS =
  'id, full_name, phone_e164, service, received_at, status, final_reason, attempt_count, needs_human, human_reason, handled_at, first_dial_at, time_to_first_dial_ms, sla_met, next_attempt_at';

export function intakeEndpointUrl(): string {
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
  return `${base.replace(/\/$/, '')}/functions/v1/speed-to-lead-intake`;
}

export async function fetchSettings(accountOwnerId: string): Promise<SpeedToLeadSettings> {
  const { data, error } = await supabase
    .from('speed_to_lead_settings')
    .select(SETTINGS_COLUMNS)
    .eq('account_owner_id', accountOwnerId)
    .maybeSingle();
  if (error) throw toError(error, 'Could not load settings.');
  if (!data) return { ...DEFAULT_SETTINGS };
  const row = data as unknown as Record<string, string | number | boolean | number[] | null>;
  return {
    ...DEFAULT_SETTINGS,
    ...(row as unknown as SpeedToLeadSettings),
    call_window_start: String(row.call_window_start).slice(0, 5),
    call_window_end: String(row.call_window_end).slice(0, 5),
  };
}

export async function saveSettings(accountOwnerId: string, s: SpeedToLeadSettings): Promise<void> {
  const { error } = await supabase
    .from('speed_to_lead_settings')
    .upsert({ account_owner_id: accountOwnerId, ...s, qualification_notes: s.qualification_notes?.trim() || null }, { onConflict: 'account_owner_id' });
  if (error) throw toError(error, 'Could not save settings.');
}

export async function fetchSources(accountOwnerId: string): Promise<SpeedToLeadSource[]> {
  const { data, error } = await supabase
    .from('speed_to_lead_sources')
    .select(SOURCE_COLUMNS)
    .eq('account_owner_id', accountOwnerId)
    .order('created_at', { ascending: false });
  if (error) throw toError(error, 'Could not load sources.');
  return (data as unknown as SpeedToLeadSource[]) ?? [];
}

/** Creates a source and returns the plaintext token ONCE. Only its SHA-256 is stored. */
export async function createSource(
  accountOwnerId: string,
  input: { name: string; kind: SourceKind; disclosure_text: string },
): Promise<{ source: SpeedToLeadSource; token: string }> {
  const token = generateToken();
  const { data, error } = await supabase
    .from('speed_to_lead_sources')
    .insert({
      account_owner_id: accountOwnerId,
      name: input.name.trim(),
      kind: input.kind,
      disclosure_text: input.disclosure_text.trim(),
      token_hash: await sha256Hex(token),
      token_hint: token.slice(-4),
    })
    .select(SOURCE_COLUMNS)
    .single();
  if (error || !data) throw toError(error ?? { message: 'x' }, 'Could not create the source.');
  return { source: data as unknown as SpeedToLeadSource, token };
}

export async function updateSource(
  id: string,
  patch: Partial<Pick<SpeedToLeadSource, 'name' | 'enabled' | 'disclosure_text'>>,
): Promise<SpeedToLeadSource> {
  const { data, error } = await supabase.from('speed_to_lead_sources').update(patch).eq('id', id).select(SOURCE_COLUMNS).single();
  if (error || !data) throw toError(error ?? { message: 'x' }, 'Could not update the source.');
  return data as unknown as SpeedToLeadSource;
}

export async function deleteSource(id: string): Promise<void> {
  const { error } = await supabase.from('speed_to_lead_sources').delete().eq('id', id);
  if (error) throw toError(error, 'Could not delete the source.');
}

export async function fetchRequests(accountOwnerId: string, limit = 50): Promise<SpeedToLeadRequest[]> {
  const { data, error } = await supabase
    .from('speed_to_lead_requests')
    .select(REQUEST_COLUMNS)
    .eq('account_owner_id', accountOwnerId)
    .order('received_at', { ascending: false })
    .limit(limit);
  if (error) throw toError(error, 'Could not load leads.');
  return (data as unknown as SpeedToLeadRequest[]) ?? [];
}

export async function fetchMetrics(days = 30): Promise<SpeedToLeadMetrics | null> {
  const { data, error } = await supabase.rpc('speed_to_lead_metrics', { p_days: days });
  if (error) throw toError(error, 'Could not load metrics.');
  const row = (data as unknown as SpeedToLeadMetrics[] | null)?.[0];
  return row ?? null;
}

export async function revokeConsent(phoneE164: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('speed_to_lead_revoke', { p_phone: phoneE164, p_note: note.trim() || null });
  if (error) throw toError(error, 'Could not record the revocation.');
}

export async function markHandled(requestId: string): Promise<void> {
  const { error } = await supabase.rpc('speed_to_lead_mark_handled', { p_request_id: requestId });
  if (error) throw toError(error, 'Could not mark this lead as handled.');
}
