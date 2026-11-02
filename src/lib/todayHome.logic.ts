/**
 * Today Home — pure logic (no React, no Supabase, no DOM). Unit-tested in todayHome.logic.test.ts.
 *
 * HONESTY RULES (enforced here, not in the UI):
 *  1. The hero number is whatever the money-recovered engine credits for the owner's local day. This file never
 *     computes revenue itself and never adds estimates to it.
 *  2. Practice/test calls (first-call sessions) are excluded from every count.
 *  3. Every count returns the ids it was built from, so the UI can link to the underlying rows.
 */

// ------------------------------------------------------------------ owner-local day window

export interface DayWindow {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  startUtc: string;
  endUtc: string;
  timezone: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function localParts(ms: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(ms));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour') % 24, mi: g('minute'), s: g('second') };
}

/** The UTC instant at which the wall clock in `tz` reads y-mo-d 00:00 (two-pass, DST safe). */
function zonedMidnightUtc(y: number, mo: number, d: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d);
  const offsetAt = (ms: number) => {
    const p = localParts(ms, tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - ms;
  };
  const first = guess - offsetAt(guess);
  const second = guess - offsetAt(first);
  return second;
}

/** Midnight → next midnight (so DST days are 23 or 25 hours long, never silently 24). */
export function dayWindow(now: Date, tz: string): DayWindow {
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const p = localParts(now.getTime(), zone);
  const next = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
  return {
    date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`,
    startUtc: new Date(zonedMidnightUtc(p.y, p.mo, p.d, zone)).toISOString(),
    endUtc: new Date(zonedMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), zone)).toISOString(),
    timezone: zone,
  };
}

const inWindow = (iso: string | null | undefined, w: { startUtc: string; endUtc: string }) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t >= Date.parse(w.startUtc) && t < Date.parse(w.endUtc);
};

// ------------------------------------------------------------------ tiles

export interface CallLite {
  id: string;
  vapi_call_id: string | null;
  call_datetime: string;
  status: string;
  is_emergency: boolean;
  is_voicemail: boolean;
  escalated_at: string | null;
  voicemail_listened_at: string | null;
  caller_name: string | null;
  summary: string | null;
}
export interface JobLite {
  id: string;
  call_id: string | null;
  job_status: string;
  created_at: string;
}

export interface Tiles {
  callsHandled: number;
  emergencies: number;
  jobsBooked: number;
  /** Rows deliberately left out because they were the owner's own practice call. */
  practiceExcluded: number;
  ids: { calls: string[]; emergencies: string[]; jobs: string[] };
}

/** "Handled by Sarah" = answered and real: not missed, not spam, not a voicemail drop, not a practice call. */
export const isHandled = (c: Pick<CallLite, 'status' | 'is_voicemail'>) => c.status !== 'missed' && c.status !== 'spam' && !c.is_voicemail;

export function computeTiles(input: {
  calls: CallLite[];
  jobs: JobLite[];
  window: DayWindow;
  practiceCallIds: ReadonlySet<string>;
}): Tiles {
  const { window: w, practiceCallIds } = input;
  const today = [...new Map(input.calls.map((c) => [c.id, c])).values()].filter((c) => inWindow(c.call_datetime, w));
  const practiceExcluded = today.filter((c) => practiceCallIds.has(c.id)).length;
  const handled = today.filter((c) => !practiceCallIds.has(c.id) && isHandled(c));
  const emergencies = handled.filter((c) => c.is_emergency);
  const jobs = [...new Map(input.jobs.map((j) => [j.id, j])).values()].filter(
    (j) => inWindow(j.created_at, w) && j.job_status !== 'cancelled' && j.call_id !== null && !practiceCallIds.has(j.call_id),
  );
  return {
    callsHandled: handled.length,
    emergencies: emergencies.length,
    jobsBooked: jobs.length,
    practiceExcluded,
    ids: { calls: handled.map((c) => c.id), emergencies: emergencies.map((c) => c.id), jobs: jobs.map((j) => j.id) },
  };
}

// ------------------------------------------------------------------ attention list

export interface LiveLite {
  id: string;
  vapi_call_id: string;
  status: string;
  caller_name: string | null;
  wants_human: boolean;
  handoff_status: string;
  updated_at: string;
}
export interface EventLite {
  id: string;
  call_id: string | null;
  customer_name: string | null;
  status: string;
  estimated_value_cents: number;
  occurred_at: string;
}

export type AttentionKind =
  | 'emergency_unescalated'
  | 'handoff_failed'
  | 'wants_human'
  | 'callback_requested'
  | 'voicemail_unheard'
  | 'open_recovery';

export interface AttentionItem {
  /** Stable key: one row per underlying call/event. */
  key: string;
  kind: AttentionKind;
  severity: 'critical' | 'high' | 'normal';
  title: string;
  detail: string;
  at: string;
  href: string;
  estimatedCents?: number;
}

export const MAX_ATTENTION = 5;
const TIER: Record<AttentionKind, number> = {
  emergency_unescalated: 1000,
  handoff_failed: 950,
  wants_human: 800,
  callback_requested: 600,
  voicemail_unheard: 550,
  open_recovery: 300,
};
const SEVERITY: Record<AttentionKind, AttentionItem['severity']> = {
  emergency_unescalated: 'critical',
  handoff_failed: 'critical',
  wants_human: 'high',
  callback_requested: 'high',
  voicemail_unheard: 'normal',
  open_recovery: 'normal',
};
const HOUR = 3_600_000;

const who = (name: string | null | undefined) => (name?.trim() ? name.trim().slice(0, 60) : 'An unknown caller');
const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

export function rankAttention(input: {
  calls: CallLite[];
  live: LiveLite[];
  events: EventLite[];
  practiceCallIds: ReadonlySet<string>;
  now: Date;
  max?: number;
  formatMoney: (cents: number) => string;
}): { items: AttentionItem[]; total: number } {
  const now = input.now.getTime();
  const age = (iso: string) => Math.max(0, now - Date.parse(iso));
  const callByVapi = new Map(input.calls.filter((c) => c.vapi_call_id).map((c) => [c.vapi_call_id as string, c]));
  const practice = (callId: string | null) => callId !== null && input.practiceCallIds.has(callId);

  const cands: { item: AttentionItem; score: number }[] = [];
  const add = (kind: AttentionKind, key: string, at: string, title: string, detail: string, href: string, extra: Partial<AttentionItem> = {}) => {
    const recency = 50 * Math.exp(-age(at) / (6 * HOUR));
    const value = extra.estimatedCents ? Math.min(40, Math.log10(1 + extra.estimatedCents / 100) * 10) : 0;
    cands.push({ item: { key, kind, severity: SEVERITY[kind], title, detail, at, href, ...extra }, score: TIER[kind] + recency + value });
  };

  for (const c of input.calls) {
    if (practice(c.id) || !Number.isFinite(Date.parse(c.call_datetime))) continue;
    const key = `call:${c.id}`;
    const href = `/dashboard/calls/${c.id}`;
    if (c.is_emergency && !c.escalated_at && age(c.call_datetime) <= 24 * HOUR) {
      add('emergency_unescalated', key, c.call_datetime, `Emergency call from ${who(c.caller_name)}`, 'No escalation was recorded. Check that someone has been told.', href);
    } else if (c.status === 'callback_requested' && age(c.call_datetime) <= 48 * HOUR) {
      add('callback_requested', key, c.call_datetime, `${who(c.caller_name)} asked for a call back`, clip(c.summary, 110) || 'Open the call for details.', href);
    } else if (c.is_voicemail && !c.voicemail_listened_at && age(c.call_datetime) <= 48 * HOUR) {
      add('voicemail_unheard', key, c.call_datetime, `Unheard voicemail from ${who(c.caller_name)}`, clip(c.summary, 110) || 'Listen to the recording.', href);
    }
  }

  for (const l of input.live) {
    const mapped = callByVapi.get(l.vapi_call_id);
    if (mapped && practice(mapped.id)) continue;
    const key = mapped ? `call:${mapped.id}` : `live:${l.vapi_call_id}`;
    if (age(l.updated_at) > 24 * HOUR) continue;
    if (l.handoff_status === 'failed') {
      add('handoff_failed', key, l.updated_at, `Hand-off failed for ${who(l.caller_name)}`, 'Sarah could not transfer this call to your team.', '/dashboard/live-calls');
    } else if (l.wants_human && l.handoff_status === 'none' && age(l.updated_at) <= 6 * HOUR) {
      add('wants_human', key, l.updated_at, `${who(l.caller_name)} asked for a person`, 'The caller wanted to speak to your team.', '/dashboard/live-calls');
    }
  }

  const open = input.events
    .filter((e) => (e.status === 'open' || e.status === 'contacted') && e.estimated_value_cents > 0 && !practice(e.call_id))
    .sort((a, b) => b.estimated_value_cents - a.estimated_value_cents || a.id.localeCompare(b.id))
    .slice(0, 2);
  for (const e of open) {
    add(
      'open_recovery',
      `event:${e.id}`,
      e.occurred_at,
      `Follow up with ${who(e.customer_name)}`,
      `Estimated ${input.formatMoney(e.estimated_value_cents)}. An estimate only; it is not counted as recovered.`,
      e.call_id ? `/dashboard/calls/${e.call_id}` : '/dashboard/calls',
      { estimatedCents: e.estimated_value_cents },
    );
  }

  // One row per underlying call/event: keep its highest-scoring reason.
  const best = new Map<string, { item: AttentionItem; score: number }>();
  for (const c of cands) {
    const cur = best.get(c.item.key);
    if (!cur || c.score > cur.score) best.set(c.item.key, c);
  }
  const sorted = [...best.values()].sort((a, b) => b.score - a.score || a.item.key.localeCompare(b.item.key));
  const max = Math.max(1, Math.min(input.max ?? MAX_ATTENTION, MAX_ATTENTION));
  return { items: sorted.slice(0, max).map((x) => x.item), total: sorted.length };
}

// ------------------------------------------------------------------ hero (definition + view model)

export interface StatementLite {
  currency: string;
  creditedCents: number;
  creditedCount: number;
  notClaimedCents: number;
  notClaimedCount: number;
  stillOpenCents: number;
  stillOpenCount: number;
  windowDays: number;
}

export interface HeroView {
  valueCents: number;
  creditedCount: number;
  currency: string;
  notClaimedCents: number;
  notClaimedCount: number;
  stillOpenCents: number;
  stillOpenCount: number;
  definition: string[];
}

export function buildHero(s: StatementLite, timezone: string, fmt: (cents: number, currency: string) => string): HeroView {
  const notCounted: string[] = [];
  if (s.notClaimedCount > 0) notCounted.push(`${fmt(s.notClaimedCents, s.currency)} recovered but not claimed (${s.notClaimedCount}), such as manual entries or no logged follow-up`);
  if (s.stillOpenCount > 0) notCounted.push(`${fmt(s.stillOpenCents, s.currency)} still open (${s.stillOpenCount}), which is an estimate`);
  return {
    valueCents: Math.max(0, Math.trunc(s.creditedCents)),
    creditedCount: s.creditedCount,
    currency: s.currency,
    notClaimedCents: s.notClaimedCents,
    notClaimedCount: s.notClaimedCount,
    stillOpenCents: s.stillOpenCents,
    stillOpenCount: s.stillOpenCount,
    definition: [
      `Money collected today (midnight to now, ${timezone}) from opportunities Sarah followed up on. Payments actually received, never estimates.`,
      `Counted only when a follow-up was logged before the payment, no more than ${s.windowDays} days earlier. Capped at the value estimated when the opportunity was lost, so upsells are never counted.`,
      notCounted.length ? `Not counted: ${notCounted.join('; ')}.` : 'Nothing is being left out of this number right now.',
    ],
  };
}

export function heroAnnouncement(h: HeroView, fmt: (cents: number, currency: string) => string): string {
  return h.valueCents > 0 ? `Sarah has recovered ${fmt(h.valueCents, h.currency)} today.` : 'Nothing recovered yet today.';
}

// ------------------------------------------------------------------ live counter

/** Ease-out cubic. Returns EXACTLY `to` at progress ≥ 1, so the animation can never leave a wrong number on screen. */
export function counterValue(from: number, to: number, progress: number): number {
  if (!Number.isFinite(progress) || progress >= 1) return to;
  if (progress <= 0) return from;
  const e = 1 - Math.pow(1 - progress, 3);
  return Math.round(from + (to - from) * e);
}

/** Animate only genuine changes after first paint; the first value is shown as-is (no count-up theatre from $0). */
export const shouldAnimateCounter = (prev: number | null, next: number, reduced: boolean) => !reduced && prev !== null && prev !== next;

// ------------------------------------------------------------------ freshness + empty state

export const STALE_AFTER_MS = 150_000;
export const REFRESH_EVERY_MS = 60_000;
export const isStale = (lastOkAt: number | null, now: number) => lastOkAt === null || now - lastOkAt > STALE_AFTER_MS;

export type EmptyKind = 'no_number_yet' | 'no_calls_yet' | null;
/** New-account calm state. Only when there is genuinely nothing real to show. */
export function emptyKind(input: { realCallsEver: number; hasLiveNumber: boolean }): EmptyKind {
  if (input.realCallsEver > 0) return null;
  return input.hasLiveNumber ? 'no_calls_yet' : 'no_number_yet';
}
