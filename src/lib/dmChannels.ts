// Telegram + Facebook Messenger inbox channels: client data layer.
// Schema: supabase/migrations/20280101000000_telegram_messenger_channels.sql
// Server: supabase/functions/{telegram-webhook,messenger-webhook,dm-connect,dm-send}.
// The limits / window below mirror supabase/functions/_shared/dmChannels/protocol.ts (the server is
// authoritative; these only drive the UI).

import { supabase } from '@/lib/supabase';

export type DmChannelKey = 'telegram' | 'messenger';
export type ConnectionStatus = 'connected' | 'error' | 'disconnected';

export const DM_MAX_CHARS: Record<DmChannelKey, number> = { telegram: 4096, messenger: 2000 };
export const MESSENGER_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DmConnection {
  id: string;
  channel: DmChannelKey;
  externalAccountId: string;
  displayName: string | null;
  status: ConnectionStatus;
  lastError: string | null;
}

export function isTelegramToken(s: string): boolean {
  return /^\d{5,16}:[A-Za-z0-9_-]{30,60}$/.test(s.trim());
}
export function isFacebookPageId(s: string): boolean {
  return /^\d{5,20}$/.test(s.trim());
}
export function isPageAccessToken(s: string): boolean {
  const t = s.trim();
  return t.length >= 20 && t.length <= 1000 && !/\s/.test(t);
}

/** Messenger only allows free-form replies within 24h of the customer's last message; Telegram has no window. */
export function replyWindow(channel: string, lastInboundAt?: string | null, now: number = Date.now()): { open: boolean } {
  if (channel !== 'messenger') return { open: true };
  const t = lastInboundAt ? Date.parse(lastInboundAt) : NaN;
  return { open: Number.isFinite(t) && now - t < MESSENGER_WINDOW_MS };
}

export function mapConnectionRow(r: Record<string, unknown>): DmConnection {
  return {
    id: r.id as string,
    channel: r.channel as DmChannelKey,
    externalAccountId: r.external_account_id as string,
    displayName: (r.display_name as string | null) ?? null,
    status: (r.status as ConnectionStatus) ?? 'disconnected',
    lastError: (r.last_error as string | null) ?? null,
  };
}

/** Lists the tenant's Telegram / Messenger connections. Tokens are never selectable from the browser. */
export async function fetchDmConnections(): Promise<DmConnection[]> {
  const { data, error } = await supabase
    .from('dm_channel_connections')
    .select('id, channel, external_account_id, display_name, status, last_error')
    .in('channel', ['telegram', 'messenger']);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => mapConnectionRow(r as Record<string, unknown>));
}

interface InvokeResult { ok?: boolean; message?: string; code?: string; error?: string }

async function invokeDm(fn: 'dm-connect' | 'dm-send', body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) return { ok: false, error: error.message || 'Request failed' };
  const res = (data ?? {}) as InvokeResult;
  if (res.ok) return { ok: true };
  return { ok: false, error: res.message ?? res.error ?? 'Request failed' };
}

export function connectTelegram(botToken: string) {
  return invokeDm('dm-connect', { action: 'connect', channel: 'telegram', botToken: botToken.trim() });
}
export function connectMessenger(pageId: string, pageToken: string) {
  return invokeDm('dm-connect', { action: 'connect', channel: 'messenger', pageId: pageId.trim(), pageToken: pageToken.trim() });
}
export function disconnectChannel(channel: DmChannelKey) {
  return invokeDm('dm-connect', { action: 'disconnect', channel });
}
export function sendDmReply(conversationId: string, body: string) {
  return invokeDm('dm-send', { conversationId, body });
}

export interface SuggestResult { ok: boolean; draft?: string; grounded?: boolean; error?: string }

/** Asks the assistant for a DRAFT reply (never sent). `grounded` = answer came from the Knowledge Base. */
export async function suggestDmReply(conversationId: string): Promise<SuggestResult> {
  const { data, error } = await supabase.functions.invoke('dm-suggest', { body: { conversationId } });
  if (error) return { ok: false, error: error.message || 'Request failed' };
  const res = (data ?? {}) as { ok?: boolean; draft?: string; grounded?: boolean; message?: string };
  if (res.ok && res.draft) return { ok: true, draft: res.draft, grounded: res.grounded === true };
  return { ok: false, error: res.message ?? 'Could not draft a reply.' };
}
