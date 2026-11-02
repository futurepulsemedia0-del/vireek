/**
 * Today Home — data layer. Every query is scoped by the ACCOUNT OWNER id (team members see the owner's account;
 * RLS enforces the same). The hero money comes from the same engine as the emailed Money Recovered statement.
 */
import { supabase } from '@/lib/supabase';
import {
  computeStatement,
  formatMoney,
  type LedgerEvent,
  type Window as StatementWindow,
} from '../../supabase/functions/_shared/money-recovered/engine';
import {
  buildHero,
  computeTiles,
  dayWindow,
  emptyKind,
  isValidTimeZone,
  rankAttention,
  type AttentionItem,
  type CallLite,
  type DayWindow,
  type EmptyKind,
  type EventLite,
  type HeroView,
  type JobLite,
  type LiveLite,
  type Tiles,
} from './todayHome.logic';

export interface TodayData {
  window: DayWindow;
  currency: string;
  hero: HeroView;
  tiles: Tiles;
  attention: { items: AttentionItem[]; total: number };
  /** True when a query hit its row cap, so counts may be low. The UI must say so. */
  truncated: boolean;
  /** Live-call data needs a permission some team members lack; hero and tiles still work without it. */
  liveUnavailable: boolean;
  empty: EmptyKind;
  loadedAt: number;
}

const CALL_COLS = 'id,vapi_call_id,call_datetime,status,is_emergency,is_voicemail,escalated_at,voicemail_listened_at,caller_name,summary';
const EVENT_COLS =
  'id,source_type,call_id,customer_name,occurred_at,estimated_value_cents,status,recovery_method,recovered_amount_cents,follow_up_count,last_follow_up_at,resolved_at';
const ROW_CAP = 1000;
const HOUR = 3_600_000;

export const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
};

async function soft<T>(p: PromiseLike<{ data: T | null; error: unknown }>, fallback: T): Promise<{ data: T; failed: boolean }> {
  try {
    const r = await p;
    return r.error ? { data: fallback, failed: true } : { data: (r.data ?? fallback) as T, failed: false };
  } catch {
    return { data: fallback, failed: true };
  }
}

export const formatCents = (cents: number, currency: string) => formatMoney(cents, currency);

export async function loadToday(ownerId: string, currency = 'USD', now: Date = new Date()): Promise<TodayData> {
  // Time zone: the owner's Money Recovered setting if present (same zone as the emailed statement), else the browser's.
  const tzRow = await soft(supabase.from('money_recovered_settings').select('timezone').eq('user_id', ownerId).maybeSingle(), null as { timezone: string } | null);
  const tz = isValidTimeZone(tzRow.data?.timezone) ? (tzRow.data!.timezone as string) : browserTimeZone();
  const w = dayWindow(now, tz);
  const since48h = new Date(now.getTime() - 48 * HOUR).toISOString();
  const since24h = new Date(now.getTime() - 24 * HOUR).toISOString();

  // Practice calls (the owner's own First Call test) must never count as business. Soft-fail: the table may not exist yet.
  const practice = await soft(supabase.from('first_call_sessions').select('vapi_call_id').eq('user_id', ownerId).not('vapi_call_id', 'is', null).limit(200), [] as { vapi_call_id: string }[]);
  const practiceVapi = practice.data.map((r) => r.vapi_call_id);
  const practiceCalls = practiceVapi.length
    ? await soft(supabase.from('calls').select('id').eq('user_id', ownerId).in('vapi_call_id', practiceVapi).limit(200), [] as { id: string }[])
    : { data: [] as { id: string }[], failed: false };
  const practiceCallIds = new Set(practiceCalls.data.map((r) => r.id));

  const [todayCalls, attnCalls, todayJobs, resolved, active, live, everCalls, bp] = await Promise.all([
    supabase.from('calls').select(CALL_COLS).eq('user_id', ownerId).gte('call_datetime', w.startUtc).lt('call_datetime', w.endUtc).limit(ROW_CAP),
    supabase
      .from('calls')
      .select(CALL_COLS)
      .eq('user_id', ownerId)
      .gte('call_datetime', since48h)
      .or('is_emergency.eq.true,status.eq.callback_requested,and(is_voicemail.eq.true,voicemail_listened_at.is.null)')
      .limit(200),
    supabase.from('jobs').select('id,call_id,job_status,created_at').eq('user_id', ownerId).gte('created_at', w.startUtc).lt('created_at', w.endUtc).limit(ROW_CAP),
    supabase.from('revenue_recovery_events').select(EVENT_COLS).eq('user_id', ownerId).eq('status', 'recovered').gte('resolved_at', w.startUtc).lt('resolved_at', w.endUtc).limit(ROW_CAP),
    supabase.from('revenue_recovery_events').select(EVENT_COLS).eq('user_id', ownerId).in('status', ['open', 'contacted']).limit(2000),
    soft(
      supabase
        .from('live_calls')
        .select('id,vapi_call_id,status,caller_name,wants_human,handoff_status,updated_at')
        .eq('user_id', ownerId)
        .gte('updated_at', since24h)
        .or('wants_human.eq.true,handoff_status.eq.failed')
        .limit(100),
      [] as LiveLite[],
    ),
    supabase.from('calls').select('id', { count: 'exact', head: true }).eq('user_id', ownerId),
    soft(supabase.from('business_profile').select('vapi_phone_number_id,vapi_assistant_id').eq('user_id', ownerId).maybeSingle(), null as { vapi_phone_number_id: string | null; vapi_assistant_id: string | null } | null),
  ]);
  // Core queries must succeed or the whole load fails loudly (the UI shows its error state; it never shows a fake zero).
  for (const r of [todayCalls, attnCalls, todayJobs, resolved, active, everCalls]) if (r.error) throw r.error;

  const calls = [...new Map([...((todayCalls.data ?? []) as CallLite[]), ...((attnCalls.data ?? []) as CallLite[])].map((c) => [c.id, c])).values()];
  const jobs = (todayJobs.data ?? []) as JobLite[];
  const events = [...new Map([...((resolved.data ?? []) as LedgerEvent[]), ...((active.data ?? []) as LedgerEvent[])].map((e) => [e.id, e])).values()];

  const stmtWindow: StatementWindow = { start: w.date, end: w.date, label: w.date, startUtc: w.startUtc, endUtc: w.endUtc, timezone: w.timezone };
  const statement = computeStatement({ events, calls: [], baseline: null, window: stmtWindow, now, currency });

  const tiles = computeTiles({ calls, jobs, window: w, practiceCallIds });
  const attention = rankAttention({
    calls,
    live: live.data,
    events: events as EventLite[],
    practiceCallIds,
    now,
    formatMoney: (c) => formatMoney(c, currency),
  });
  const realCallsEver = Math.max(0, (everCalls.count ?? 0) - practiceCallIds.size);

  return {
    window: w,
    currency,
    hero: buildHero(statement, w.timezone, formatMoney),
    tiles,
    attention,
    truncated: (todayCalls.data?.length ?? 0) >= ROW_CAP || (todayJobs.data?.length ?? 0) >= ROW_CAP || (resolved.data?.length ?? 0) >= ROW_CAP,
    liveUnavailable: live.failed,
    empty: emptyKind({ realCallsEver, hasLiveNumber: !!bp.data?.vapi_phone_number_id && !!bp.data?.vapi_assistant_id }),
    loadedAt: now.getTime(),
  };
}
