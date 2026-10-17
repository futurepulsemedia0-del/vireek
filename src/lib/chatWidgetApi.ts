/**
 * Website Chat Widget — API layer. Every query is scoped by account_owner_id (and RLS enforces it again server-side).
 */

import { supabase } from '@/lib/supabase';
import { normalizeSettings, type ChatWidgetRow, type ChatWidgetSettings } from '@/lib/chatWidget';

export interface AssigneeOption {
  id: string;
  name: string;
}

export interface WidgetActivity {
  last7Days: number;
  total: number;
  latestAt: string | null;
}

const SETTINGS_COLUMNS =
  'account_owner_id, public_key, enabled, brand_color, position, theme, title, greeting, offline_message, hours_mode, timezone, schedule, routing_mode, assigned_team_member_id, offline_behavior, contact_field, allowed_domains, last_seen_at, last_seen_host, updated_at';

/** Returns null when the account has not configured the widget yet. */
export async function fetchChatWidget(accountOwnerId: string): Promise<ChatWidgetRow | null> {
  const { data, error } = await supabase
    .from('chat_widget_settings')
    .select(SETTINGS_COLUMNS)
    .eq('account_owner_id', accountOwnerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { ...(data as ChatWidgetRow), ...normalizeSettings(data as Partial<ChatWidgetSettings>) };
}

/** Insert-or-update. public_key / last_seen_* are managed by the database and cannot be written from the client. */
export async function saveChatWidget(accountOwnerId: string, settings: ChatWidgetSettings): Promise<ChatWidgetRow> {
  const payload = {
    account_owner_id: accountOwnerId,
    enabled: settings.enabled,
    brand_color: settings.brand_color,
    position: settings.position,
    theme: settings.theme,
    title: settings.title.trim(),
    greeting: settings.greeting.trim(),
    offline_message: settings.offline_message.trim(),
    hours_mode: settings.hours_mode,
    timezone: settings.timezone,
    schedule: settings.schedule,
    routing_mode: settings.routing_mode,
    assigned_team_member_id: settings.routing_mode === 'assigned_member' ? settings.assigned_team_member_id : null,
    offline_behavior: settings.offline_behavior,
    contact_field: settings.contact_field,
    allowed_domains: settings.allowed_domains,
  };
  const { data, error } = await supabase
    .from('chat_widget_settings')
    .upsert(payload, { onConflict: 'account_owner_id' })
    .select(SETTINGS_COLUMNS)
    .single();
  if (error) throw error;
  return { ...(data as ChatWidgetRow), ...normalizeSettings(data as Partial<ChatWidgetSettings>) };
}

export async function rotateChatWidgetKey(): Promise<string> {
  const { data, error } = await supabase.rpc('rotate_chat_widget_key');
  if (error) throw error;
  return data as string;
}

export async function fetchAssigneeOptions(accountOwnerId: string): Promise<AssigneeOption[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, member_name, member_email')
    .eq('account_owner_id', accountOwnerId)
    .eq('invite_status', 'active')
    .order('member_name', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as { id: string; member_name: string | null; member_email: string }[]).map((m) => ({
    id: m.id,
    name: m.member_name?.trim() || m.member_email,
  }));
}

export async function fetchWidgetActivity(accountOwnerId: string): Promise<WidgetActivity> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [recent, total, latest] = await Promise.all([
    supabase.from('chat_widget_messages').select('id', { count: 'exact', head: true }).eq('account_owner_id', accountOwnerId).gte('created_at', since),
    supabase.from('chat_widget_messages').select('id', { count: 'exact', head: true }).eq('account_owner_id', accountOwnerId),
    supabase.from('chat_widget_messages').select('created_at').eq('account_owner_id', accountOwnerId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (recent.error) throw recent.error;
  return {
    last7Days: recent.count ?? 0,
    total: total.count ?? 0,
    latestAt: (latest.data as { created_at: string } | null)?.created_at ?? null,
  };
}
