/**
 * Team chat — pure logic (no React, no network). Everything here is unit tested
 * in teamChat.test.ts; the Supabase access lives in teamChatApi.ts and the
 * authorisation rules live in the database (20270701000000_team_chat.sql).
 */

export type ChatChannelKind = 'job' | 'direct';
export type ChatMessageKind = 'text' | 'image' | 'voice' | 'system';
export type ChatSendStatus = 'sending' | 'failed';

export interface ChatChannel {
  id: string;
  user_id: string;
  kind: ChatChannelKind;
  job_id: string | null;
  dm_key: string | null;
  last_message_at: string | null;
  last_message_kind: ChatMessageKind | null;
  last_message_preview: string | null;
  last_message_sender_id: string | null;
  created_at: string;
  job?: { customer_name: string | null; service_type: string | null } | null;
}

export interface ChatMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  kind: ChatMessageKind;
  body: string | null;
  attachment_path: string | null;
  attachment_mime: string | null;
  attachment_bytes: number | null;
  voice_duration_ms: number | null;
  client_id: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
  /** Client-only: present while a message has not been confirmed by the server. */
  status?: ChatSendStatus;
  /** Client-only: local object URL so a photo/voice note shows instantly while uploading. */
  localUrl?: string;
}

export interface ChatMember {
  channel_id: string;
  user_id: string;
  last_read_at: string;
  muted: boolean;
}

export interface ChatPerson {
  user_id: string;
  name: string;
  role: string;
  is_self: boolean;
}

export const MAX_TEXT_LENGTH = 4000;
export const MAX_VOICE_MS = 120_000;
export const MIN_VOICE_MS = 700;
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const EDIT_WINDOW_MS = 15 * 60_000;
export const GROUP_WINDOW_MS = 5 * 60_000;

export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;
export const AUDIO_MIMES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/x-m4a'] as const;

// ---------------------------------------------------------------- composing --

export function validateText(raw: string): { ok: true; text: string } | { ok: false; error: string } {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text) return { ok: false, error: 'Type a message first.' };
  if (text.length > MAX_TEXT_LENGTH) {
    return { ok: false, error: `Messages are limited to ${MAX_TEXT_LENGTH} characters.` };
  }
  return { ok: true, text };
}

export function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // RFC4122 v4 fallback for very old WebViews.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** `audio/webm;codecs=opus` -> `audio/webm` (what the storage bucket allow-list expects). */
export function baseMime(mime: string): string {
  return mime.split(';')[0].trim().toLowerCase();
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/x-m4a': 'm4a',
};

export function extForMime(mime: string): string {
  return MIME_EXT[baseMime(mime)] ?? 'bin';
}

export function validateAttachment(
  file: { type: string; size: number },
  kind: 'image' | 'voice',
): string | null {
  const mime = baseMime(file.type || '');
  const allowed: readonly string[] = kind === 'image' ? IMAGE_MIMES : AUDIO_MIMES;
  if (!allowed.includes(mime)) {
    return kind === 'image' ? 'Only JPG, PNG, WebP or HEIC photos can be sent.' : 'This audio format is not supported.';
  }
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'That file is too large (15 MB maximum).';
  return null;
}

/** <account>/<channel>/<senderUid>_<uuid>.<ext> — the exact shape the storage policy and DB trigger require. */
export function buildStoragePath(args: {
  accountId: string;
  channelId: string;
  senderId: string;
  mime: string;
  uniqueId?: string;
}): string {
  const id = args.uniqueId ?? newClientId();
  return `${args.accountId}/${args.channelId}/${args.senderId}_${id}.${extForMime(args.mime)}`;
}

/** Longest edge for photos sent from the field (keeps uploads fast on poor signal). */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** First supported recording type, or null when MediaRecorder cannot record audio at all. */
export function pickRecorderMime(isSupported: (type: string) => boolean): string | null {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
  for (const c of candidates) {
    try {
      if (isSupported(c)) return c;
    } catch {
      /* some engines throw on unknown types */
    }
  }
  return null;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ channels --

/** The other participant's user id in a DM (`a:b` key). */
export function dmOtherUserId(dmKey: string | null, me: string): string | null {
  if (!dmKey) return null;
  const ids = dmKey.split(':');
  if (ids.length !== 2) return null;
  return ids[0] === me ? ids[1] : ids[1] === me ? ids[0] : null;
}

export function channelTitle(channel: ChatChannel, me: string, people: Map<string, ChatPerson>): string {
  if (channel.kind === 'job') {
    const name = channel.job?.customer_name?.trim();
    const service = channel.job?.service_type?.trim();
    if (name && service) return `${name} · ${service}`;
    return name || service || 'Job chat';
  }
  const other = dmOtherUserId(channel.dm_key, me);
  return (other && people.get(other)?.name) || 'Direct message';
}

export function previewText(
  kind: ChatMessageKind | null,
  body: string | null,
  senderName?: string | null,
  deleted = false,
): string {
  if (deleted) return 'Message deleted';
  let text: string;
  switch (kind) {
    case 'image':
      text = 'Photo';
      break;
    case 'voice':
      text = 'Voice note';
      break;
    case 'text':
    case 'system':
      text = (body ?? '').replace(/\s+/g, ' ').trim();
      break;
    default:
      return '';
  }
  return senderName ? `${senderName}: ${text}` : text;
}

export function sortChannels(channels: ChatChannel[]): ChatChannel[] {
  return [...channels].sort((a, b) => {
    const at = a.last_message_at ?? a.created_at;
    const bt = b.last_message_at ?? b.created_at;
    if (a.last_message_at && !b.last_message_at) return -1;
    if (!a.last_message_at && b.last_message_at) return 1;
    return bt.localeCompare(at) || a.id.localeCompare(b.id);
  });
}

export function totalUnread(counts: Map<string, number>): number {
  let sum = 0;
  counts.forEach((n) => (sum += n));
  return sum;
}

export function unreadLabel(n: number): string {
  return n > 99 ? '99+' : String(n);
}

export function titleWithUnread(base: string, unread: number): string {
  return unread > 0 ? `(${unreadLabel(unread)}) ${base}` : base;
}

export function chatDeepLink(channelId: string): string {
  return `/dashboard/team-chat?c=${encodeURIComponent(channelId)}`;
}

// ------------------------------------------------------------------ messages --

export function canEdit(message: ChatMessage, me: string, now: number = Date.now()): boolean {
  return (
    message.sender_id === me &&
    message.kind === 'text' &&
    !message.deleted_at &&
    !message.status &&
    now - new Date(message.created_at).getTime() <= EDIT_WINDOW_MS
  );
}

export function canDelete(message: ChatMessage, me: string): boolean {
  return message.sender_id === me && !message.deleted_at && !message.status && message.kind !== 'system';
}

function compareMessages(a: ChatMessage, b: ChatMessage): number {
  // Parse first: a local optimistic stamp (`…Z`) and a server stamp (`…+00:00`) must still order correctly.
  return (
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime() ||
    a.created_at.localeCompare(b.created_at) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Merges server rows into the local list. Dedupes by id AND by (sender, client_id)
 * so an optimistic message is replaced — never duplicated — when the realtime event
 * or the insert response arrives (in either order). Server rows win over local ones,
 * except a server row never resurrects a locally-known tombstone.
 */
export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  const byClient = new Map<string, string>();

  const put = (m: ChatMessage) => {
    const clientKey = m.client_id ? `${m.sender_id}:${m.client_id}` : null;
    const priorId = clientKey ? byClient.get(clientKey) : undefined;
    if (priorId && priorId !== m.id) byId.delete(priorId);

    const prior = byId.get(m.id);
    let next = m;
    if (prior && !m.status) {
      // confirmed server row: drop client-only fields; keep a tombstone if we already saw one
      next = { ...m, localUrl: undefined };
      if (prior.deleted_at && !m.deleted_at) next = prior;
    }
    byId.set(m.id, next);
    if (clientKey) byClient.set(clientKey, m.id);
  };

  existing.forEach(put);
  incoming.forEach(put);
  return [...byId.values()].sort(compareMessages);
}

export type ThreadItem =
  | { type: 'day'; key: string; label: string }
  | { type: 'message'; key: string; message: ChatMessage; showSender: boolean; startsGroup: boolean; endsGroup: boolean };

export function dayLabel(iso: string, now: Date = new Date(), locale?: string): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(locale, {
    weekday: diffDays < 7 ? 'long' : undefined,
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** Day separators + sender grouping (consecutive messages by one person within 5 min). */
export function buildThread(messages: ChatMessage[], now: Date = new Date(), locale?: string): ThreadItem[] {
  const items: ThreadItem[] = [];
  let prev: ChatMessage | null = null;

  messages.forEach((message, i) => {
    if (!prev || dayKey(prev.created_at) !== dayKey(message.created_at)) {
      items.push({ type: 'day', key: `day-${dayKey(message.created_at)}`, label: dayLabel(message.created_at, now, locale) });
      prev = null;
    }
    const next = messages[i + 1];
    const joinsPrev =
      !!prev &&
      prev.sender_id === message.sender_id &&
      prev.kind !== 'system' &&
      message.kind !== 'system' &&
      new Date(message.created_at).getTime() - new Date(prev.created_at).getTime() <= GROUP_WINDOW_MS;
    const joinsNext =
      !!next &&
      dayKey(next.created_at) === dayKey(message.created_at) &&
      next.sender_id === message.sender_id &&
      next.kind !== 'system' &&
      message.kind !== 'system' &&
      new Date(next.created_at).getTime() - new Date(message.created_at).getTime() <= GROUP_WINDOW_MS;

    items.push({
      type: 'message',
      key: message.client_id ? `${message.sender_id}:${message.client_id}` : message.id,
      message,
      showSender: !joinsPrev,
      startsGroup: !joinsPrev,
      endsGroup: !joinsNext,
    });
    prev = message;
  });

  return items;
}

export type ReceiptState = 'sending' | 'failed' | 'sent' | 'read';

export interface Receipt {
  state: ReceiptState;
  /** user ids (excluding the sender) that have read this message. */
  readBy: string[];
}

/** Derived from members' last_read_at — there is no per-message receipt table to drift. */
export function receiptFor(message: ChatMessage, members: ChatMember[]): Receipt {
  if (message.status === 'sending') return { state: 'sending', readBy: [] };
  if (message.status === 'failed') return { state: 'failed', readBy: [] };
  const sent = new Date(message.created_at).getTime();
  const readBy = members
    .filter((m) => m.user_id !== message.sender_id && new Date(m.last_read_at).getTime() >= sent)
    .map((m) => m.user_id);
  return { state: readBy.length > 0 ? 'read' : 'sent', readBy };
}

export function receiptLabel(receipt: Receipt, names: Map<string, string>, isDirect: boolean): string {
  switch (receipt.state) {
    case 'sending':
      return 'Sending…';
    case 'failed':
      return 'Not sent';
    case 'sent':
      return 'Sent';
    case 'read': {
      if (isDirect) return 'Read';
      const list = receipt.readBy.map((id) => names.get(id) ?? 'Someone');
      if (list.length <= 2) return `Read by ${list.join(' and ')}`;
      return `Read by ${list[0]} and ${list.length - 1} others`;
    }
  }
}

/** Newest message from someone else — the marker a viewer should "read up to". */
export function latestForeignCreatedAt(messages: ChatMessage[], me: string): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.sender_id !== me && !m.status) return m.created_at;
  }
  return null;
}
