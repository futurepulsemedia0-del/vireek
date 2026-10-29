// Unified Communications Inbox — normalizes four separate channel tables
// (dm_conversations/dm_messages for WhatsApp+Instagram, sms_conversations/
// sms_messages, email_conversations/email_messages, and
// support_conversations/support_messages for site chat) into one shape so
// UnifiedInboxPage.tsx can render/react to all of them the same way.
// See supabase/migrations/20261206000000_unified_communications_inbox.sql
// for the schema and supabase/functions/{sms,email}-{webhook,send} for
// how messages get in and out.

import { supabase } from '@/lib/supabase';
import { sendDmReply } from '@/lib/dmChannels';
import { normalizeEmail, normalizePhone } from '@/lib/customerContacts';

export type Channel = 'whatsapp' | 'instagram' | 'sms' | 'email' | 'chat' | 'rcs' | 'amb''telegram' | 'messenger';

/** Delivery state of an outbound RCS / Apple Messages message (rich_messages.status). */
export type RichStatus = 'queued' | 'deferred' | 'sent' | 'delivered' | 'read' | 'failed' | 'fallback_sent' | 'cancelled' | 'received';

export interface UnifiedCardAction {
  type: 'reply' | 'url' | 'call';
  label: string;
  value: string;
}

export interface UnifiedCard {
  title: string;
  description?: string;
  imageUrl?: string;
  actions: UnifiedCardAction[];
}

export function isRichChannel(channel: Channel): channel is 'rcs' | 'amb' {
  return channel === 'rcs' || channel === 'amb';
}

export interface UnifiedConversation {
  id: string;
  channel: Channel;
  customerLabel: string; // name if known, else phone/email/handle
  customerContact: string; // phone / email / external id, for display + linking to a Customer
  subject: string | null; // email only
  unread: boolean;
  lastMessageAt: string;
  /** RCS / Apple Messages only: customer sent STOP, replies are blocked server-side. */
  optedOut?: boolean;
  /** Apple Messages only: the customer deleted the conversation, the business cannot message. */
  closedByCustomer?: boolean;
  /** Messenger: when the customer last wrote (24h reply window). */
  lastInboundAt?: string | null;
}

export interface UnifiedMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  createdAt: string;
  sentBy?: string;
  /** RCS / Apple Messages only. */
  status?: RichStatus;
  card?: UnifiedCard;
}

export function formatMessageTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export async function fetchConversations(): Promise<UnifiedConversation[]> {
  const [dm, sms, email, chat, rich] = await Promise.all([
    supabase.from('dm_conversations').select('*').order('last_message_at', { ascending: false }),
    supabase.from('sms_conversations').select('*').order('last_message_at', { ascending: false }),
    supabase.from('email_conversations').select('*').order('last_message_at', { ascending: false }),
    supabase.from('support_conversations').select('*').neq('status', 'closed').order('last_message_at', { ascending: false }),
    supabase.from('rich_conversations').select('*').order('last_message_at', { ascending: false }),
  ]);

  // If every channel query failed (offline / auth), surface an error instead of a silently empty inbox.
  const failed = [dm, sms, email, chat, rich].filter((r) => r.error);
  if (failed.length === 5) throw new Error(failed[0].error?.message ?? 'Could not load conversations');
  const out: UnifiedConversation[] = [];

  for (const row of dm.data ?? []) {
    out.push({
      id: row.id,
      channel: row.channel as Channel,
      customerLabel: row.customer_name || row.customer_external_id,
      customerContact: row.customer_external_id,
      lastInboundAt: row.last_inbound_at ?? null,
      optedOut: !!row.opted_out_at,
      subject: null,
      unread: row.unread ?? false,
      lastMessageAt: row.last_message_at,
    });
  }
  for (const row of sms.data ?? []) {
    out.push({
      id: row.id,
      channel: 'sms',
      customerLabel: row.customer_name || row.customer_phone,
      customerContact: row.customer_phone,
      subject: null,
      unread: row.unread ?? false,
      lastMessageAt: row.last_message_at,
    });
  }
  for (const row of email.data ?? []) {
    out.push({
      id: row.id,
      channel: 'email',
      customerLabel: row.customer_name || row.customer_email,
      customerContact: row.customer_email,
      subject: row.subject,
      unread: row.unread ?? false,
      lastMessageAt: row.last_message_at,
    });
  }
  for (const row of chat.data ?? []) {
    out.push({
      id: row.id,
      channel: 'chat',
      customerLabel: row.visitor_name || row.visitor_email || 'Anonymous visitor',
      customerContact: row.visitor_email || '',
      subject: null,
      unread: row.status === 'open',
      lastMessageAt: row.last_message_at,
    });
  }

  for (const row of rich.data ?? []) {
    out.push({
      id: row.id,
      channel: row.channel as Channel, // 'rcs' | 'amb'
      customerLabel: row.customer_name || row.customer_phone || 'Apple Messages customer',
      customerContact: row.customer_phone || '',
      subject: null,
      unread: row.unread ?? false,
      lastMessageAt: row.last_message_at,
      optedOut: !!row.opted_out_at,
      closedByCustomer: !!row.customer_closed_at,
    });
  }

  return out.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
}

const TABLE_BY_CHANNEL: Record<Channel, { conversations: string; messages: string }> = {
  whatsapp: { conversations: 'dm_conversations', messages: 'dm_messages' },
  instagram: { conversations: 'dm_conversations', messages: 'dm_messages' },
  telegram: { conversations: 'dm_conversations', messages: 'dm_messages' },
  messenger: { conversations: 'dm_conversations', messages: 'dm_messages' },
  sms: { conversations: 'sms_conversations', messages: 'sms_messages' },
  email: { conversations: 'email_conversations', messages: 'email_messages' },
  chat: { conversations: 'support_conversations', messages: 'support_messages' },
  rcs: { conversations: 'rich_conversations', messages: 'rich_messages' },
  amb: { conversations: 'rich_conversations', messages: 'rich_messages' },
};

export function messagesTableFor(channel: Channel): string {
  return TABLE_BY_CHANNEL[channel].messages;
}

export async function fetchMessages(channel: Channel, conversationId: string): Promise<UnifiedMessage[]> {
  const { conversations, messages } = TABLE_BY_CHANNEL[channel];
  await supabase.from(conversations).update({ unread: false }).eq('id', conversationId);

  const { data } = await supabase.from(messages).select('*').eq('conversation_id', conversationId).order('created_at', { ascending: true });

  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    direction: (row.direction as string) === 'staff' || (row.direction as string) === 'outbound' || row.sender_type === 'staff' ? 'outbound' : 'inbound',
    body: (row.body ?? row.body_text) as string,
    createdAt: row.created_at as string,
    sentBy: row.sent_by as string | undefined,
    status: row.status as RichStatus | undefined,
    card: richCardOf(row.content),
  }));
}

/** Extracts the card payload of an outbound rich message (rich_messages.content), or undefined. */
export function richCardOf(content: unknown): UnifiedCard | undefined {
  const c = content as { kind?: string; card?: UnifiedCard } | null;
  return c && c.kind === 'card' && c.card && typeof c.card.title === 'string' ? c.card : undefined;
}

/** Human-readable delivery label for an outbound rich message. */
export function richStatusLabel(status: RichStatus | undefined): string | null {
  switch (status) {
    case 'queued': return 'Sending…';
    case 'deferred': return 'Scheduled (quiet hours)';
    case 'sent': return 'Sent';
    case 'delivered': return 'Delivered';
    case 'read': return 'Read';
    case 'failed': return 'Failed';
    case 'fallback_sent': return 'Sent as SMS';
    case 'cancelled': return 'Cancelled';
    default: return null;
  }
}

/** Looks up an existing Customer record by phone or email for a "View customer" link. Best-effort — returns null on no match. */
export async function findLinkedCustomerId(contact: string): Promise<string | null> {
  if (!contact) return null;
  const { data } = await supabase
    .from('customers')
    .select('id')
    .or(`phone.eq.${contact},email.eq.${contact}`)
    .limit(1)
    .maybeSingle();
  if (data?.id) return data.id;

  // Not the customer's own phone/email: it may belong to one of their contacts (tenant, site, billing…).
  if (contact.includes('@')) {
    const email = normalizeEmail(contact);
    if (!email) return null;
    const { data: byEmail } = await supabase.from('customer_contacts').select('customer_id').eq('email', email).limit(1).maybeSingle();
    return byEmail?.customer_id ?? null;
  }
  const phone = normalizePhone(contact);
  if (!phone) return null;
  const { data: byPhone } = await supabase.from('customer_contacts').select('customer_id').eq('phone_e164', phone).limit(1).maybeSingle();
  return byPhone?.customer_id ?? null;
}

export async function sendReply(channel: Channel, conversationId: string, body: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: 'Empty message' };

  if (channel === 'sms') {
    const { data, error } = await supabase.functions.invoke('sms-send', { body: { conversationId, body: trimmed } });
    if (error || data?.error) return { ok: false, error: data?.error ?? error?.message };
    return { ok: true };
  }

  if (channel === 'email') {
    const { data, error } = await supabase.functions.invoke('email-send', { body: { conversationId, body: trimmed } });
    if (error || data?.error) return { ok: false, error: data?.error ?? error?.message };
    return { ok: true };
  }

  if (channel === 'chat') {
    await supabase.from('support_conversations').update({ status: 'active', assigned_staff_id: userId }).eq('id', conversationId);
    const { error } = await supabase.from('support_messages').insert({ conversation_id: conversationId, sender_type: 'staff', sender_id: userId, body: trimmed });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  if (channel === 'telegram' || channel === 'messenger') {
    return sendDmReply(conversationId, trimmed);
  }
  if (channel === 'rcs' || channel === 'amb') {
    const { data, error } = await supabase.functions.invoke('rich-send', { body: { conversationId, text: trimmed } });
    if (error || data?.error) return { ok: false, error: data?.detail ?? data?.error ?? error?.message };
    return { ok: true };
  }
  
  // whatsapp / instagram — Phase 1 receives + auto-replies from the
  // Knowledge Base (see supabase/functions/whatsapp-webhook); a human
  // reply-send path is a follow-up phase, same note as that function's
  // own header.
  return { ok: false, error: 'Replying to WhatsApp/Instagram from the inbox is not wired up yet — see whatsapp-webhook/index.ts.' };
}
