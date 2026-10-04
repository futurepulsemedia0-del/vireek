// src/lib/askVireek.ts
//
// Client-side contract + data access for Ask Vireek (the "Business Brain").
// Types mirror supabase/functions/_shared/business-brain/types.ts (BrainAnswer).
// All network/data access lives here so the page stays presentational.

import { supabase } from '@/lib/supabase';

export type Verdict = 'yes' | 'no' | 'conditional' | 'info';
export type Urgency = 'now' | 'today' | 'this_week' | 'this_month';
export type ActionOwner = 'owner' | 'dispatcher' | 'technician' | 'office' | 'finance';

export interface AnswerFinding {
  title: string;
  detail: string;
  impact_usd: number | null;
  evidence: string[];
}

export interface AnswerAction {
  action: string;
  owner: ActionOwner;
  urgency: Urgency;
  expected_impact_usd: number | null;
}

export interface EvidenceRef {
  ref: string;
  value: string | number | boolean | null;
}

export interface BrainAnswer {
  headline: string;
  answer: string;
  verdict: Verdict | null;
  findings: AnswerFinding[];
  actions: AnswerAction[];
  confidence: { level: 'low' | 'medium' | 'high'; reason: string };
  assumptions: string[];
  data_gaps: string[];
  follow_ups: string[];
  evidence: EvidenceRef[];
  topics: string[];
  source: 'ai' | 'engine';
  grounding: { checked: number; matched: number; ratio: number };
  as_of: string;
  timezone: string;
  coverage: {
    jobs_in_window: number;
    completed_jobs: number;
    costed_jobs_pct: number | null;
    has_cost_data: boolean;
    technicians: number;
    history_days: number;
  };
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  answer?: BrainAnswer;
  feedback?: 'helpful' | 'not_helpful' | null;
  error?: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updated_at: string;
}

export const SUGGESTED_QUESTIONS: { label: string; question: string }[] = [
  { label: 'Why did profit change yesterday?', question: 'Why did profit fall yesterday?' },
  { label: 'Where am I losing money?', question: 'Where am I losing money?' },
  { label: 'Who should I contact today?', question: 'Which customers should we contact today?' },
  { label: 'Which technician for the next job?', question: 'Which technician should handle this job?' },
  { label: 'Can we take 20 more HVAC jobs?', question: 'Can we accept 20 more HVAC jobs this week?' },
  { label: 'What should I change?', question: 'What should I change?' },
  { label: 'What if I hire a technician?', question: 'What happens if I hire another technician?' },
];

export class AskVireekError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'AskVireekError';
    this.status = status;
  }
}

/** supabase.functions.invoke hides the JSON body of non-2xx replies in error.context. */
async function readFunctionError(error: unknown): Promise<AskVireekError> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: string };
      if (body?.error) return new AskVireekError(body.error, ctx.status);
    } catch {
      /* body was not JSON */
    }
    return new AskVireekError('Ask Vireek could not answer right now. Please try again.', ctx.status);
  }
  return new AskVireekError('Could not reach Ask Vireek. Check your connection and try again.');
}

export async function askVireek(
  question: string,
  conversationId: string | null,
): Promise<{ conversationId: string | null; messageId: string | null; answer: BrainAnswer }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('ask-vireek', {
    body: { question, conversation_id: conversationId },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) throw await readFunctionError(error);
  const payload = data as { conversation_id?: string | null; message_id?: string | null; answer?: BrainAnswer; error?: string } | null;
  if (!payload?.answer) throw new AskVireekError(payload?.error ?? 'Ask Vireek returned an empty answer.');
  return {
    conversationId: payload.conversation_id ?? conversationId,
    messageId: payload.message_id ?? null,
    answer: payload.answer,
  };
}

export async function listConversations(limit = 25): Promise<ConversationSummary[]> {
  const { data, error } = await supabase
    .from('ask_vireek_conversations')
    .select('id, title, updated_at')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ConversationSummary[];
}

export async function loadConversation(conversationId: string): Promise<ChatTurn[]> {
  const { data, error } = await supabase
    .from('ask_vireek_messages')
    .select('id, role, content, response, feedback, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    response: BrainAnswer | null;
    feedback: 'helpful' | 'not_helpful' | null;
  }[]).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    answer: m.response ?? undefined,
    feedback: m.feedback,
  }));
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const { error } = await supabase.from('ask_vireek_conversations').delete().eq('id', conversationId);
  if (error) throw error;
}

export async function sendFeedback(messageId: string, feedback: 'helpful' | 'not_helpful'): Promise<void> {
  const { error } = await supabase.from('ask_vireek_messages').update({ feedback }).eq('id', messageId);
  if (error) throw error;
}

// ---------------------------------------------------------------
// Presentation helpers (pure)
// ---------------------------------------------------------------

export function formatUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
}

export const URGENCY_LABEL: Record<Urgency, string> = {
  now: 'Now',
  today: 'Today',
  this_week: 'This week',
  this_month: 'This month',
};

export const OWNER_LABEL: Record<ActionOwner, string> = {
  owner: 'Owner',
  dispatcher: 'Dispatcher',
  technician: 'Technician',
  office: 'Office',
  finance: 'Finance',
};

/** 'facts.profit_drivers.drivers.volume_effect' -> 'Profit drivers · volume effect' */
export function prettyEvidenceRef(ref: string): string {
  const parts = ref
    .replace(/^facts\./, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .map((p) => (/^\d+$/.test(p) ? `#${Number(p) + 1}` : p.replace(/_/g, ' ')));
  if (!parts.length) return ref;
  const [first, ...rest] = parts;
  return rest.length ? `${first.charAt(0).toUpperCase()}${first.slice(1)} · ${rest.join(' › ')}` : first;
}

export function formatEvidenceValue(v: EvidenceRef['value']): string {
  if (v === null) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(1);
  return String(v);
}
