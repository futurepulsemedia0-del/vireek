import { supabase } from '@/lib/supabase';
import {
  DEFAULT_QUIET_HOURS,
  decideSend,
  isValidTimezone,
  normalizeSettings,
  type Channel,
  type Decision,
  type QuietHoursSettings,
} from '../../supabase/functions/_shared/messaging/quietHoursCore';

// The dashboard preview uses the exact same engine the edge functions enforce.
export { DEFAULT_QUIET_HOURS, isValidTimezone, normalizeSettings };
export type { Channel, Decision, QuietHoursSettings };

export interface DeferredMessage {
  id: string;
  channel: Channel;
  purpose: 'marketing' | 'service' | 'emergency';
  to_address: string;
  send_after: string;
  defer_reason: string | null;
  timezone: string | null;
  source: string | null;
  created_at: string;
}

export const US_TIMEZONES: Array<{ value: string; label: string }> = [
  { value: 'America/New_York', label: 'Eastern (ET)' },
  { value: 'America/Chicago', label: 'Central (CT)' },
  { value: 'America/Denver', label: 'Mountain (MT)' },
  { value: 'America/Phoenix', label: 'Arizona (no DST)' },
  { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
  { value: 'America/Anchorage', label: 'Alaska (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (HST)' },
];

export const PREVIEW_ZONES = US_TIMEZONES.filter((z) => z.value !== 'America/Phoenix' && z.value !== 'America/Anchorage');

export async function loadQuietHours(userId: string): Promise<{ settings: QuietHoursSettings; hasProfile: boolean }> {
  const { data, error } = await supabase.from('business_profile').select('timezone, quiet_hours').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return { settings: normalizeSettings(data?.quiet_hours, data?.timezone), hasProfile: !!data };
}

export async function saveQuietHours(userId: string, s: QuietHoursSettings): Promise<boolean> {
  const { timezone, ...rest } = s;
  const { data, error } = await supabase
    .from('business_profile')
    .update({ timezone, quiet_hours: rest })
    .eq('user_id', userId)
    .select('id');
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function listDeferred(): Promise<DeferredMessage[]> {
  const { data, error } = await supabase
    .from('deferred_messages')
    .select('id, channel, purpose, to_address, send_after, defer_reason, timezone, source, created_at')
    .eq('status', 'queued')
    .order('send_after', { ascending: true })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as DeferredMessage[];
}

export async function releaseDeferred(id: string, reason: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('release_deferred_message', { p_id: id, p_reason: reason });
  if (error) throw error;
  return data === true;
}

export async function cancelDeferred(id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('cancel_deferred_message', { p_id: id });
  if (error) throw error;
  return data === true;
}

export interface ZonePreview {
  timezone: string;
  label: string;
  decision: Decision;
}

/** "If we texted a customer in each US zone right now, what would happen?" */
export function previewByZone(settings: QuietHoursSettings, now: Date = new Date()): ZonePreview[] {
  return PREVIEW_ZONES.map((z) => ({
    timezone: z.value,
    label: z.label,
    decision: decideSend({
      channel: 'sms',
      purpose: 'marketing',
      settings,
      tz: { timezone: z.value, source: 'customer' },
      now,
    }),
  }));
}

export function validateSettings(s: QuietHoursSettings): string | null {
  if (!isValidTimezone(s.timezone)) return 'Choose a valid business timezone.';
  if (s.start === s.end) return 'Quiet hours start and end must differ (or turn quiet hours off).';
  if (s.channels.length === 0) return 'Select at least one channel.';
  return null;
}
