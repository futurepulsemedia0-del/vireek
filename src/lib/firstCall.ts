/**
 * First Call — client library. Rules live in supabase/functions/_shared/first-call/logic.ts (shared with the
 * edge function). The browser never rings anything itself: it asks first-call-start, which validates, rate-limits
 * and dials server-side. Progress arrives by Realtime on first_call_sessions, with polling as a safety net.
 */
import { supabase } from '@/lib/supabase';
import { trackEvent } from '@/lib/analytics';
import { secondsBetween, ttfcBucket, type FailureCode, type FirstCallSession } from '../../supabase/functions/_shared/first-call/logic';

export * from '../../supabase/functions/_shared/first-call/logic';

const COLS =
  'id,channel,status,failure_code,phone_calling_code,phone_last4,notify_when_ready,signup_at,requested_at,ringing_at,answered_at,first_transcript_at,booking_at,completed_at,call_id,job_id';

export class FirstCallError extends Error {
  constructor(public code: FailureCode | 'network' | 'not_authenticated' | 'server_error', public hint?: string, public retryAfterSeconds?: number) {
    super(code);
  }
}

async function invoke(body: Record<string, unknown>): Promise<{ session: FirstCallSession | null; reused?: boolean }> {
  const { data: s } = await supabase.auth.getSession();
  const token = s.session?.access_token;
  const { data, error } = await supabase.functions.invoke('first-call-start', { body, headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    const j = ctx ? await ctx.json().catch(() => null) : null;
    if (j?.error) throw new FirstCallError(j.error, j.hint, j.retry_after_seconds);
    throw new FirstCallError('network');
  }
  return data as { session: FirstCallSession | null; reused?: boolean };
}

export const startFirstCall = (opts: { channel: 'phone' | 'browser'; phone?: string; notifyWhenReady?: boolean }) =>
  invoke({ action: 'start', channel: opts.channel, phone: opts.phone, notify_when_ready: opts.notifyWhenReady === true });
export const cancelFirstCall = (sessionId: string) => invoke({ action: 'cancel', session_id: sessionId });

export async function fetchSession(id: string): Promise<FirstCallSession | null> {
  const { data, error } = await supabase.from('first_call_sessions').select(COLS).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as FirstCallSession | null) ?? null;
}

export interface TranscriptLine { id: number; role: 'caller' | 'assistant'; content: string }
/** Final utterances of the call, in order. Needs can_view_live_calls (owners have it). */
export async function fetchTranscript(vapiCallId: string): Promise<TranscriptLine[]> {
  const live = await supabase.from('live_calls').select('id').eq('vapi_call_id', vapiCallId).maybeSingle();
  if (live.error || !live.data) return [];
  const { data } = await supabase.from('live_call_lines').select('id,role,content').eq('live_call_id', live.data.id).order('id', { ascending: true }).limit(200);
  return (data ?? []) as TranscriptLine[];
}

export interface BookingSummary { id: string; customer_name: string | null; service_type: string | null; scheduled_datetime: string | null; address: string | null }
export async function fetchBooking(jobId: string): Promise<BookingSummary | null> {
  const { data } = await supabase.from('jobs').select('id,customer_name,service_type,scheduled_datetime,address').eq('id', jobId).maybeSingle();
  return (data as BookingSummary | null) ?? null;
}

/** Fast-path setup: ONLY business name, trade and hours. Does not mark the full onboarding wizard complete. */
export async function saveQuickSetup(userId: string, input: { companyName: string; industry: string; hours: Record<string, { open: string; close: string }> }): Promise<void> {
  const a = await supabase.from('profiles').update({ company_name: input.companyName.trim() }).eq('id', userId);
  if (a.error) throw a.error;
  const b = await supabase.from('business_profile').upsert({ user_id: userId, primary_industry: input.industry, business_hours: input.hours }, { onConflict: 'user_id' });
  if (b.error) throw b.error;
}

export const HOURS_PRESETS: { id: string; label: string; hours: Record<string, { open: string; close: string }> }[] = (() => {
  const mk = (days: string[], open: string, close: string) => Object.fromEntries(days.map((d) => [d, { open, close }]));
  const wk = ['mon', 'tue', 'wed', 'thu', 'fri'];
  const all = [...wk, 'sat', 'sun'];
  return [
    { id: 'weekdays', label: 'Mon–Fri, 8 am – 5 pm', hours: mk(wk, '08:00', '17:00') },
    { id: 'six', label: 'Mon–Sat, 8 am – 5 pm', hours: mk([...wk, 'sat'], '08:00', '17:00') },
    { id: 'every', label: 'Every day, 7 am – 7 pm', hours: mk(all, '07:00', '19:00') },
    { id: 'always', label: 'Open 24/7', hours: mk(all, '00:00', '23:59') },
  ];
})();

const sentKey = (id: string) => `vk_fc_tracked:${id}`;
/**
 * Consent-gated GA event (trackEvent is a no-op without analytics consent). Sent once per session, with a coarse
 * time bucket, never a phone number. The KPI itself comes from the database timestamps, not from this event.
 */
export function trackFirstCallOnce(s: FirstCallSession): void {
  if (!s.answered_at) return;
  try {
    if (sessionStorage.getItem(sentKey(s.id))) return;
    sessionStorage.setItem(sentKey(s.id), '1');
  } catch {
    /* storage blocked: at worst the event is sent twice */
  }
  trackEvent('first_call_answered', {
    channel: s.channel,
    international: !!s.phone_calling_code && s.phone_calling_code !== '+1',
    ttfc_bucket: ttfcBucket(secondsBetween(s.signup_at, s.answered_at)),
  });
}
