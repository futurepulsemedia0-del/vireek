import { supabase } from '@/lib/supabase';
import type { MicrosoftCalendarConnection, MicrosoftCalendarScope } from '@/lib/microsoftCalendar';

/** supabase.functions.invoke hides the JSON body of non-2xx responses inside error.context. */
async function invoke<T>(fn: string, body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T & { error?: string }>(fn, { body });
  if (error) {
    let message = '';
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === 'function') message = (await ctx.json())?.error ?? '';
    } catch {
      /* fall through to the generic message */
    }
    throw new Error(message || fallback);
  }
  if (data && typeof data === 'object' && 'error' in data && data.error) throw new Error(String(data.error));
  return data as T;
}

export async function listMicrosoftCalendarConnections(): Promise<MicrosoftCalendarConnection[]> {
  const { data, error } = await supabase
    .from('microsoft_calendar_connections')
    .select(
      'id, scope, team_member_id, user_id, ms_email, status, last_synced_at, last_error_code, last_error_message, consecutive_failures, connected_at, team_member:team_members(member_name, member_email)',
    )
    .neq('status', 'disconnected');
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as MicrosoftCalendarConnection[];
}

export async function startMicrosoftCalendarConnect(scope: MicrosoftCalendarScope): Promise<void> {
  const data = await invoke<{ url?: string }>('microsoft-calendar-oauth-start', { scope }, 'Could not connect Microsoft 365.');
  if (!data?.url) throw new Error('Could not connect Microsoft 365.');
  window.location.href = data.url;
}

export interface MicrosoftSyncResult {
  connection_id: string;
  status: 'ok' | 'partial' | 'busy' | 'needs_reconnect' | 'error';
  created: number;
  updated: number;
  deleted: number;
  blocks: number;
  reschedules: number;
  failed: number;
}

export async function syncMicrosoftCalendarNow(connectionId?: string): Promise<MicrosoftSyncResult[]> {
  const data = await invoke<{ results: MicrosoftSyncResult[] }>(
    'microsoft-calendar-sync',
    connectionId ? { connection_id: connectionId } : {},
    'Could not sync Microsoft 365.',
  );
  return data?.results ?? [];
}

export async function disconnectMicrosoftCalendar(connectionId: string, deleteEvents: boolean): Promise<void> {
  await invoke('microsoft-calendar-disconnect', { connection_id: connectionId, delete_events: deleteEvents }, 'Could not disconnect Microsoft 365.');
}
