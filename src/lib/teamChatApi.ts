import { supabase } from '@/lib/supabase';
import {
  baseMime,
  buildStoragePath,
  newClientId,
  validateAttachment,
  validateText,
  type ChatChannel,
  type ChatMember,
  type ChatMessage,
  type ChatPerson,
} from '@/lib/teamChat';

/**
 * Team chat — Supabase access. Authorisation is enforced by RLS / RPCs
 * (see 20270701000000_team_chat.sql); nothing here is trusted by the server.
 */

const BUCKET = 'chat-media';
export const PAGE_SIZE = 40;

const CHANNEL_SELECT = '*, job:jobs(customer_name, service_type)';

export class ChatError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

interface PgError {
  code?: string;
  message?: string;
}

/** Maps database errors to copy that is safe and useful to show a technician. */
export function friendlyError(error: PgError | null | undefined, fallback = 'Something went wrong. Please try again.'): ChatError {
  const code = error?.code;
  const msg = error?.message ?? '';
  if (code === '42501' || /row-level security|forbidden/i.test(msg)) {
    return new ChatError('You no longer have access to this conversation.', 'forbidden');
  }
  if (code === 'P0001' && /rate_limited/.test(msg)) {
    return new ChatError('You are sending messages too fast. Wait a few seconds.', 'rate_limited');
  }
  if (/edit_window_closed/.test(msg)) return new ChatError('Messages can only be edited for 15 minutes.', 'edit_window');
  if (code === '23514') return new ChatError('That message is not valid.', 'invalid');
  return new ChatError(fallback, code);
}

// ------------------------------------------------------------------- reads ---

export async function fetchChannels(): Promise<ChatChannel[]> {
  const { data, error } = await supabase
    .from('chat_channels')
    .select(CHANNEL_SELECT)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(300);
  if (error) throw friendlyError(error, 'Could not load conversations.');
  return (data ?? []) as unknown as ChatChannel[];
}

export async function fetchChannel(id: string): Promise<ChatChannel | null> {
  const { data, error } = await supabase.from('chat_channels').select(CHANNEL_SELECT).eq('id', id).maybeSingle();
  if (error) throw friendlyError(error, 'Could not load this conversation.');
  return (data as unknown as ChatChannel | null) ?? null;
}

export async function fetchPeople(): Promise<ChatPerson[]> {
  const { data, error } = await supabase.rpc('chat_people');
  if (error) throw friendlyError(error, 'Could not load your team.');
  return ((data ?? []) as ChatPerson[]).sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchUnreadCounts(): Promise<Map<string, number>> {
  const { data, error } = await supabase.rpc('chat_unread_counts');
  if (error) throw friendlyError(error);
  const map = new Map<string, number>();
  ((data ?? []) as { channel_id: string; unread: number | string }[]).forEach((r) => {
    const n = Number(r.unread);
    if (n > 0) map.set(r.channel_id, n);
  });
  return map;
}

export interface MessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
}

/** Newest-first page (optionally older than `before`), returned oldest-first. */
export async function fetchMessages(
  channelId: string,
  before?: Pick<ChatMessage, 'created_at' | 'id'> | null,
  limit: number = PAGE_SIZE,
): Promise<MessagePage> {
  let req = supabase
    .from('chat_messages')
    .select('*')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);
  if (before) {
    req = req.or(`created_at.lt."${before.created_at}",and(created_at.eq."${before.created_at}",id.lt."${before.id}")`);
  }
  const { data, error } = await req;
  if (error) throw friendlyError(error, 'Could not load messages.');
  const rows = (data ?? []) as ChatMessage[];
  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit).reverse(), hasMore };
}

/** Messages newer than `after` — used to catch up after a dropped connection. */
export async function fetchMessagesAfter(channelId: string, after: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('channel_id', channelId)
    .gt('created_at', after)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw friendlyError(error);
  return (data ?? []) as ChatMessage[];
}

export async function fetchMembers(channelId: string): Promise<ChatMember[]> {
  const { data, error } = await supabase
    .from('chat_members')
    .select('channel_id, user_id, last_read_at, muted')
    .eq('channel_id', channelId);
  if (error) throw friendlyError(error);
  return (data ?? []) as ChatMember[];
}

// ---------------------------------------------------------------- channels ---

export async function openJobChannel(jobId: string): Promise<string> {
  const { data, error } = await supabase.rpc('chat_open_job_channel', { p_job_id: jobId });
  if (error || !data) throw friendlyError(error, 'Could not open the job chat.');
  return data as string;
}

export async function openDirectChannel(userId: string): Promise<string> {
  const { data, error } = await supabase.rpc('chat_open_direct', { p_other: userId });
  if (error || !data) throw friendlyError(error, 'Could not start the conversation.');
  return data as string;
}

export async function markRead(channelId: string, upTo?: string | null): Promise<void> {
  const { error } = await supabase.rpc('chat_mark_read', { p_channel: channelId, p_up_to: upTo ?? null });
  if (error) throw friendlyError(error);
}

export async function setMuted(channelId: string, muted: boolean): Promise<void> {
  const { error } = await supabase.rpc('chat_set_muted', { p_channel: channelId, p_muted: muted });
  if (error) throw friendlyError(error);
}

// ---------------------------------------------------------------- sending ----

export interface SendTextArgs {
  channelId: string;
  text: string;
  clientId?: string;
}

async function insertMessage(row: Record<string, unknown>, clientId: string, channelId: string, senderId?: string): Promise<ChatMessage> {
  const { data, error } = await supabase.from('chat_messages').insert(row).select('*').single();
  if (!error && data) return data as ChatMessage;

  // Retried send whose first attempt actually landed: return the stored row instead of failing.
  if (error?.code === '23505') {
    let q = supabase.from('chat_messages').select('*').eq('channel_id', channelId).eq('client_id', clientId);
    if (senderId) q = q.eq('sender_id', senderId);
    const existing = await q.maybeSingle();
    if (existing.data) return existing.data as ChatMessage;
  }
  throw friendlyError(error, 'Message not sent.');
}

export async function sendText(args: SendTextArgs & { senderId?: string }): Promise<ChatMessage> {
  const checked = validateText(args.text);
  if (!checked.ok) throw new ChatError(checked.error, 'invalid');
  const clientId = args.clientId ?? newClientId();
  return insertMessage(
    { channel_id: args.channelId, kind: 'text', body: checked.text, client_id: clientId },
    clientId,
    args.channelId,
    args.senderId,
  );
}

export interface SendMediaArgs {
  channel: Pick<ChatChannel, 'id' | 'user_id'>;
  senderId: string;
  kind: 'image' | 'voice';
  blob: Blob;
  mime: string;
  durationMs?: number;
  clientId?: string;
  /** Stable across retries so a retry re-uses the same storage object. */
  path?: string;
}

export async function sendMedia(args: SendMediaArgs): Promise<ChatMessage> {
  const mime = baseMime(args.mime);
  const invalid = validateAttachment({ type: mime, size: args.blob.size }, args.kind);
  if (invalid) throw new ChatError(invalid, 'invalid');
  if (args.kind === 'voice' && !args.durationMs) throw new ChatError('Voice note is too short.', 'invalid');

  const clientId = args.clientId ?? newClientId();
  const path =
    args.path ??
    buildStoragePath({ accountId: args.channel.user_id, channelId: args.channel.id, senderId: args.senderId, mime, uniqueId: clientId });

  const up = await supabase.storage.from(BUCKET).upload(path, args.blob, { contentType: mime, upsert: true, cacheControl: '3600' });
  if (up.error) throw friendlyError(up.error as PgError, 'Upload failed. Check your connection and retry.');

  try {
    return await insertMessage(
      {
        channel_id: args.channel.id,
        kind: args.kind,
        attachment_path: path,
        attachment_mime: mime,
        attachment_bytes: args.blob.size,
        voice_duration_ms: args.kind === 'voice' ? Math.round(args.durationMs ?? 0) : null,
        client_id: clientId,
      },
      clientId,
      args.channel.id,
      args.senderId,
    );
  } catch (e) {
    // Keep the object when the failure is retryable (same path is re-used); remove it when access is gone.
    if (e instanceof ChatError && (e.code === 'forbidden' || e.code === 'invalid')) {
      void supabase.storage.from(BUCKET).remove([path]);
    }
    throw e;
  }
}

// ------------------------------------------------------------ edit / delete --

export async function editMessage(id: string, text: string): Promise<ChatMessage> {
  const checked = validateText(text);
  if (!checked.ok) throw new ChatError(checked.error, 'invalid');
  const { data, error } = await supabase.from('chat_messages').update({ body: checked.text }).eq('id', id).select('*').single();
  if (error || !data) throw friendlyError(error, 'Could not edit the message.');
  return data as ChatMessage;
}

export async function deleteMessage(message: Pick<ChatMessage, 'id' | 'attachment_path'>): Promise<ChatMessage> {
  if (message.attachment_path) {
    // Best effort: the DB tombstone below is what hides it; removing the file is hygiene.
    await supabase.storage.from(BUCKET).remove([message.attachment_path]).catch(() => undefined);
  }
  const { data, error } = await supabase
    .from('chat_messages')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', message.id)
    .select('*')
    .single();
  if (error || !data) throw friendlyError(error, 'Could not delete the message.');
  return data as ChatMessage;
}

// ------------------------------------------------------------ signed media ---

const SIGN_TTL_S = 3600;
const REFRESH_BEFORE_MS = 5 * 60_000;
const urlCache = new Map<string, { url: string; expiresAt: number }>();

export function clearSignedUrlCache(): void {
  urlCache.clear();
}

/** Signed URLs for private chat media (batched, cached, refreshed before expiry). */
export async function getSignedUrls(paths: string[]): Promise<Map<string, string>> {
  const now = Date.now();
  const out = new Map<string, string>();
  const missing: string[] = [];

  new Set(paths).forEach((p) => {
    const hit = urlCache.get(p);
    if (hit && hit.expiresAt - REFRESH_BEFORE_MS > now) out.set(p, hit.url);
    else missing.push(p);
  });

  if (missing.length) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(missing, SIGN_TTL_S);
    if (error) throw friendlyError(error as PgError, 'Could not load media.');
    ((data ?? []) as { path: string | null; signedUrl: string | null }[]).forEach((row) => {
      if (row.path && row.signedUrl) {
        urlCache.set(row.path, { url: row.signedUrl, expiresAt: now + SIGN_TTL_S * 1000 });
        out.set(row.path, row.signedUrl);
      }
    });
  }
  return out;
}
