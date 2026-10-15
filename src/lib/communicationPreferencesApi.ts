import { supabase } from '@/lib/supabase';
import type { PreferenceForm, PreferenceRow, SubmitOutcome } from '@/lib/communicationPreferences';

/** Public (anon) read. Returns null for an unknown token — never reveals whether a token "almost" matched. */
export async function fetchPreferences(token: string): Promise<PreferenceRow | null> {
  const { data, error } = await supabase.rpc('get_customer_preferences', { p_token: token });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : null;
  return (row as PreferenceRow | undefined) ?? null;
}

export async function savePreferences(token: string, f: PreferenceForm): Promise<SubmitOutcome> {
  const { data, error } = await supabase.rpc('update_customer_preferences', {
    p_token: token,
    p_sms: f.sms,
    p_email: f.email,
    p_voice: f.voice,
    p_reminders: f.reminders,
    p_surveys: f.surveys,
    p_marketing: f.marketing,
    p_language: f.language,
    p_frequency: f.frequency,
    p_unsubscribe_all: f.unsubscribeAll,
  });
  if (error) throw error;
  return data as SubmitOutcome;
}

/** Staff-only: token for building a customer's preference link (e.g. in message footers). */
export async function getPreferenceToken(customerId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('ensure_customer_preference_token', { p_customer_id: customerId });
  if (error) throw error;
  return (data as string | null) ?? null;
}

export function getPreferenceLink(token: string): string {
  return `${window.location.origin}/preferences/${token}`;
}
