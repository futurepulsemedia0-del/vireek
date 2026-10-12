// Inbound AI auto-reply — client helpers (settings, drafts, conversation flags).
// Server side: supabase/functions/_shared/autoReply/* and auto-reply-review.

import { supabase } from '@/lib/supabase';

export type ReplyMode = 'approval' | 'auto';
export type AiChannel = 'sms' | 'email';

export interface AutoReplySettings {
  smsEnabled: boolean;
  emailEnabled: boolean;
  mode: ReplyMode;
  confidenceThreshold: number;
  escalationKeywords: string[];
  useDefaultKeywords: boolean;
  scope: 'always' | 'after_hours_only';
  timezone: string;
  shareBookingLink: boolean;
  sendEscalationAck: boolean;
  escalationAckMessage: string;
  signature: string;
  extraInstructions: string;
  maxAutoRepliesPerDay: number;
  humanTakeoverMinutes: number;
}

export const DEFAULT_AUTO_REPLY_SETTINGS: AutoReplySettings = {
  smsEnabled: false,
  emailEnabled: false,
  mode: 'approval',
  confidenceThreshold: 0.8,
  escalationKeywords: [],
  useDefaultKeywords: true,
  scope: 'always',
  timezone: 'America/New_York',
  shareBookingLink: true,
  sendEscalationAck: true,
  escalationAckMessage: '',
  signature: '',
  extraInstructions: '',
  maxAutoRepliesPerDay: 4,
  humanTakeoverMinutes: 120,
};

export interface AiDraft {
  id: string;
  channel: AiChannel;
  draftBody: string;
  confidence: number | null;
  reason: string | null;
  createdAt: string;
}

/** One keyword per line or comma separated → trimmed, de-duplicated, capped (mirrors the server rules). */
export function parseKeywordInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const kw = part.replace(/\s+/g, ' ').trim().slice(0, 60);
    const key = kw.toLowerCase();
    if (!kw || seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
    if (out.length >= 100) break;
  }
  return out;
}

export const REASON_LABELS: Record<string, string> = {
  approval_mode: 'Approval mode is on',
  below_threshold: 'Below your confidence threshold',
  guard_ungrounded_amount: 'Mentions a price not found in your knowledge base',
  guard_url_not_allowed: 'Contains a link that is not your booking link',
  guard_unauthorised_commitment: 'Appears to confirm a booking or arrival time',
  guard_claims_to_be_human: 'Claims to be a person',
  guard_output_guardrail: 'Blocked by the safety filter',
  model_requested_human: 'AI asked for a human',
  escalation_keyword: 'Escalation keyword detected',
};

export function reasonLabel(reason: string | null): string {
  return reason ? (REASON_LABELS[reason] ?? reason.replace(/_/g, ' ')) : '';
}

type Row = Record<string, unknown>;

export async function fetchAutoReplySettings(userId: string): Promise<AutoReplySettings> {
  const { data } = await supabase.from('auto_reply_settings').select('*').eq('user_id', userId).maybeSingle();
  if (!data) return DEFAULT_AUTO_REPLY_SETTINGS;
  const r = data as Row;
  const d = DEFAULT_AUTO_REPLY_SETTINGS;
  return {
    smsEnabled: r.sms_enabled === true,
    emailEnabled: r.email_enabled === true,
    mode: r.mode === 'auto' ? 'auto' : 'approval',
    confidenceThreshold: Number(r.confidence_threshold ?? d.confidenceThreshold),
    escalationKeywords: (r.escalation_keywords as string[]) ?? [],
    useDefaultKeywords: r.use_default_keywords !== false,
    scope: r.scope === 'after_hours_only' ? 'after_hours_only' : 'always',
    timezone: String(r.timezone ?? d.timezone),
    shareBookingLink: r.share_booking_link !== false,
    sendEscalationAck: r.send_escalation_ack !== false,
    escalationAckMessage: (r.escalation_ack_message as string) ?? '',
    signature: (r.signature as string) ?? '',
    extraInstructions: (r.extra_instructions as string) ?? '',
    maxAutoRepliesPerDay: Number(r.max_auto_replies_per_day ?? d.maxAutoRepliesPerDay),
    humanTakeoverMinutes: Number(r.human_takeover_minutes ?? d.humanTakeoverMinutes),
  };
}

export async function saveAutoReplySettings(userId: string, s: AutoReplySettings): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from('auto_reply_settings').upsert(
    {
      user_id: userId,
      sms_enabled: s.smsEnabled,
      email_enabled: s.emailEnabled,
      mode: s.mode,
      confidence_threshold: s.confidenceThreshold,
      escalation_keywords: parseKeywordInput(s.escalationKeywords.join('\n')),
      use_default_keywords: s.useDefaultKeywords,
      scope: s.scope,
      timezone: s.timezone,
      share_booking_link: s.shareBookingLink,
      send_escalation_ack: s.sendEscalationAck,
      escalation_ack_message: s.escalationAckMessage.trim() || null,
      signature: s.signature.trim() || null,
      extra_instructions: s.extraInstructions.trim() || null,
      max_auto_replies_per_day: s.maxAutoRepliesPerDay,
      human_takeover_minutes: s.humanTakeoverMinutes,
    },
    { onConflict: 'user_id' },
  );
  return error ? { ok: false, error: error.message } : { ok: true };
}

const CONV_TABLE: Record<AiChannel, string> = { sms: 'sms_conversations', email: 'email_conversations' };

export async function fetchConversationAiState(channel: AiChannel, conversationId: string) {
  const { data } = await supabase.from(CONV_TABLE[channel]).select('ai_paused, needs_human').eq('id', conversationId).maybeSingle();
  return { aiPaused: data?.ai_paused === true, needsHuman: data?.needs_human === true };
}

export async function setConversationFlag(
  channel: AiChannel,
  conversationId: string,
  patch: { ai_paused?: boolean; needs_human?: boolean },
): Promise<boolean> {
  const { error } = await supabase.from(CONV_TABLE[channel]).update(patch).eq('id', conversationId);
  return !error;
}

export async function fetchPendingDraft(channel: AiChannel, conversationId: string): Promise<AiDraft | null> {
  const { data } = await supabase
    .from('auto_reply_log')
    .select('id, channel, draft_body, confidence, reason, created_at')
    .eq('channel', channel)
    .eq('conversation_id', conversationId)
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    channel: data.channel as AiChannel,
    draftBody: data.draft_body ?? '',
    confidence: data.confidence === null ? null : Number(data.confidence),
    reason: data.reason,
    createdAt: data.created_at,
  };
}

export async function resolveDraft(
  action: 'approve' | 'reject',
  logId: string,
  body?: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke('auto-reply-review', { body: { action, logId, body } });
  if (error || data?.error) return { ok: false, error: data?.error ?? error?.message ?? 'Request failed' };
  return { ok: true };
}
