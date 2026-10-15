import { supabase } from '@/lib/supabase';
import type {
  ChatChannel,
  ChatConnection,
  ChatDelivery,
  ChatEventType,
  ChatProvider,
  ChatRoute,
} from '@/lib/chatNotifications';

export interface ChatState {
  connections: ChatConnection[];
  routes: ChatRoute[];
  deliveries: ChatDelivery[];
}

export async function fetchChatState(): Promise<ChatState> {
  const [conns, routes, deliveries] = await Promise.all([
    supabase.from('chat_connections').select('id, provider, external_id, external_name, status, last_error'),
    supabase
      .from('chat_routes')
      .select('id, connection_id, event_type, channel_id, channel_name, enabled, actions_enabled, include_contact_details, csat_threshold'),
    supabase
      .from('chat_deliveries')
      .select('id, provider, channel_name, status, attempts, error, created_at, event:chat_events(event_type)')
      .order('created_at', { ascending: false })
      .limit(10),
  ]);
  if (conns.error) throw conns.error;
  if (routes.error) throw routes.error;
  if (deliveries.error) throw deliveries.error;
  return {
    connections: (conns.data ?? []) as ChatConnection[],
    routes: (routes.data ?? []) as ChatRoute[],
    deliveries: (deliveries.data ?? []) as unknown as ChatDelivery[],
  };
}

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T & { error?: string }>(fn, { body });
  if (error) {
    // supabase-js hides the JSON error body of non-2xx responses inside error.context
    const ctx = (error as { context?: Response }).context;
    const detail = ctx ? await ctx.json().then((j: { error?: string }) => j?.error).catch(() => undefined) : undefined;
    throw new Error(detail || error.message);
  }
  if (data && typeof data === 'object' && 'error' in data && data.error) throw new Error(String(data.error));
  return data as T;
}

export async function startChatOAuth(provider: ChatProvider): Promise<string> {
  const fn = provider === 'slack' ? 'chat-slack-oauth-start' : 'chat-teams-oauth-start';
  const { url } = await invoke<{ url: string }>(fn, {});
  if (!url) throw new Error('Could not start the connection.');
  return url;
}

export async function listChatChannels(provider: ChatProvider): Promise<ChatChannel[]> {
  const { channels } = await invoke<{ channels: ChatChannel[] }>('chat-notify-admin', { action: 'list_channels', provider });
  return channels ?? [];
}

export const refreshTeamsChannels = () => invoke<{ ok: true }>('chat-notify-admin', { action: 'refresh_channels', provider: 'teams' });
export const disconnectChat = (provider: ChatProvider) => invoke<{ ok: true }>('chat-notify-admin', { action: 'disconnect', provider });
export const sendChatTest = (provider: ChatProvider, eventType: ChatEventType) =>
  invoke<{ ok: true }>('chat-notify-admin', { action: 'send_test', provider, event_type: eventType });
export const resendChatDelivery = (deliveryId: string) => invoke<{ ok: true }>('chat-notify-admin', { action: 'resend', delivery_id: deliveryId });

export type RouteInput = Pick<
  ChatRoute,
  'connection_id' | 'event_type' | 'channel_id' | 'channel_name' | 'enabled' | 'actions_enabled' | 'include_contact_details' | 'csat_threshold'
>;

export async function saveChatRoute(route: RouteInput): Promise<void> {
  const { error } = await supabase
    .from('chat_routes')
    .upsert({ ...route, updated_at: new Date().toISOString() }, { onConflict: 'connection_id,event_type' });
  if (error) throw error;
}
