/**
 * Live Calls — client library.
 *
 * A realtime board of calls happening right now. Data is written ONLY by the
 * vapi-webhook (live_calls / live_call_lines, service role) and streamed to
 * the dashboard through Supabase Realtime; the dashboard can read, and ask
 * the server to hand a call to a human, but can never write call data.
 *
 *   Tables:   supabase/migrations/20271010000100_live_calls.sql
 *   Feed:     supabase/functions/_shared/live-calls/runtime.ts (from vapi-webhook)
 *   Hand-off: supabase/functions/live-call-control
 *   Rules:    supabase/functions/_shared/live-calls/logic.ts (shared)
 *
 * Tenant scoping: rows are keyed by the account OWNER id (RLS uses
 * get_account_owner_id() + can_view_live_calls()), and the page filters its
 * realtime channels by accountOwnerId, so team members see the owner's calls.
 */

import { supabase } from '@/lib/supabase';
import {
  RECENT_ENDED_MS,
  type HandoffMode,
  type HandoffStatus,
  type LiveIntent,
  type LiveRole,
  type LiveSentiment,
  type LiveStatus,
} from '../../supabase/functions/_shared/live-calls/logic';

export * from '../../supabase/functions/_shared/live-calls/logic';

// ============================================================
// TYPES
// ============================================================

export interface LiveCallRow {
  [key: string]: unknown;
  id: string;
  user_id: string;
  vapi_call_id: string;
  caller_phone: string | null;
  caller_name: string | null;
  status: LiveStatus;
  started_at: string;
  ended_at: string | null;
  ended_reason: string | null;
  intent: LiveIntent | null;
  sentiment: LiveSentiment;
  sentiment_score: number;
  wants_human: boolean;
  is_emergency: boolean;
  human_transfer_requested: boolean;
  last_line_role: LiveRole | null;
  last_line_preview: string | null;
  last_line_at: string | null;
  handoff_status: HandoffStatus;
  handoff_mode: HandoffMode | null;
  handoff_by: string | null;
  handoff_at: string | null;
  handoff_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface LiveCallLine {
  [key: string]: unknown;
  id: number;
  live_call_id: string;
  user_id: string;
  role: LiveRole;
  content: string;
  created_at: string;
}

// ============================================================
// READS
// ============================================================

/** Calls in progress + calls that ended in the last RECENT_ENDED_MS. */
export async function fetchLiveCalls(): Promise<LiveCallRow[]> {
  const since = new Date(Date.now() - RECENT_ENDED_MS).toISOString();
  const { data, error } = await supabase
    .from('live_calls')
    .select('*')
    .or(`status.neq.ended,ended_at.gte.${since}`)
    .order('started_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data as LiveCallRow[]) ?? [];
}

/** Newest 400 lines of one call, returned oldest-first. */
export async function fetchLines(liveCallId: string): Promise<LiveCallLine[]> {
  const { data, error } = await supabase
    .from('live_call_lines')
    .select('*')
    .eq('live_call_id', liveCallId)
    .order('id', { ascending: false })
    .limit(400);
  if (error) throw error;
  return ((data as LiveCallLine[]) ?? []).slice().reverse();
}

// ============================================================
// HAND-OFF
// ============================================================

export class HandoffError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HandoffError';
    this.status = status;
  }
}

/** supabase.functions.invoke hides the JSON body of non-2xx replies in error.context. */
async function readFunctionError(error: unknown): Promise<HandoffError> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: string };
      if (body?.error) return new HandoffError(body.error, ctx.status);
    } catch {
      /* body was not JSON */
    }
    return new HandoffError('Could not transfer the call right now. Please try again.', ctx.status);
  }
  return new HandoffError('Could not reach the server. Check your connection and try again.');
}

export async function requestHandoff(vapiCallId: string, mode: HandoffMode): Promise<{ destinationHint: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('live-call-control', {
    body: { vapi_call_id: vapiCallId, mode },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) throw await readFunctionError(error);
  const payload = data as { ok?: boolean; destination_hint?: string; error?: string } | null;
  if (!payload?.ok) throw new HandoffError(payload?.error ?? 'The transfer did not go through.');
  return { destinationHint: payload.destination_hint ?? '' };
}
