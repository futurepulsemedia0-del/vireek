// supabase/functions/_shared/live-calls/logic.ts
//
// Vireek Live Calls — pure logic (no I/O, no Deno APIs, no browser APIs).
// Shared by:
//   - supabase/functions/_shared/live-calls/runtime.ts  (vapi-webhook tracking)
//   - supabase/functions/live-call-control               (destination validation)
//   - src/lib/liveCalls.ts / LiveCallsPage               (list ordering, timers, realtime merge)
// Unit-tested from src/lib/liveCalls.test.ts.

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

export type LiveStatus = 'ringing' | 'in_progress' | 'ended';
export type LiveRole = 'caller' | 'assistant';
export type LiveSentiment = 'positive' | 'neutral' | 'negative';
export type HandoffStatus = 'none' | 'requested' | 'failed';
export type HandoffMode = 'take_over' | 'transfer';

export type LiveIntent =
  | 'emergency'
  | 'complaint'
  | 'reschedule_cancel'
  | 'price_quote'
  | 'existing_customer'
  | 'new_inquiry';

export const LIVE_INTENT_LABELS: Record<LiveIntent, string> = {
  emergency: 'Emergency',
  complaint: 'Complaint',
  reschedule_cancel: 'Reschedule / cancel',
  price_quote: 'Price & quote',
  existing_customer: 'Existing customer',
  new_inquiry: 'New inquiry',
};

/** A call still marked live after this long is treated as a missed "ended" event, not a real call. */
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
/** Ended calls stay visible on the board for this long. */
export const RECENT_ENDED_MS = 30 * 60 * 1000;
export const MAX_LINE_CHARS = 1500;
export const SIGNAL_WINDOW_CHARS = 600;
export const PREVIEW_CHARS = 140;
export const MAX_RECENT_SHOWN = 10;

export interface LiveCallFacts {
  status: LiveStatus;
  started_at: string;
  ended_at: string | null;
  is_emergency: boolean;
  wants_human: boolean;
  human_transfer_requested: boolean;
  sentiment: LiveSentiment | null;
}

// ---------------------------------------------------------------------------
// Parsing Vapi server messages
// ---------------------------------------------------------------------------

export interface LiveMessageLike {
  type?: string;
  status?: string;
  endedReason?: string;
  role?: string;
  transcriptType?: string;
  transcript?: string;
}

export type LiveEvent =
  | { kind: 'status'; status: LiveStatus; endedReason: string | null }
  | { kind: 'line'; role: LiveRole; text: string };

export function cleanLineText(input: string): string {
  return String(input ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LINE_CHARS);
}

/**
 * Only the events that change what the board shows are returned:
 *  - status-update (ringing / in-progress / ended)
 *  - end-of-call-report (call is over)
 *  - FINAL transcript segments (partials are ignored on purpose: they would
 *    multiply database writes by ~10x for no visible benefit)
 * NOTE: Vapi's `hang` event means "the assistant stopped responding", NOT
 * "the call ended", so it is deliberately not mapped.
 */
export function parseLiveEvent(message: LiveMessageLike): LiveEvent | null {
  const type = message.type ?? '';

  if (type === 'end-of-call-report') {
    return { kind: 'status', status: 'ended', endedReason: message.endedReason ?? null };
  }

  if (type === 'status-update') {
    const s = (message.status ?? '').toLowerCase();
    if (s === 'ringing' || s === 'queued') return { kind: 'status', status: 'ringing', endedReason: null };
    if (s === 'in-progress' || s === 'forwarding') return { kind: 'status', status: 'in_progress', endedReason: null };
    if (s === 'ended') return { kind: 'status', status: 'ended', endedReason: message.endedReason ?? null };
    return null;
  }

  if (type.startsWith('transcript')) {
    const isFinal = message.transcriptType === 'final' || type.includes('final');
    if (!isFinal) return null;
    const role: LiveRole | null = message.role === 'user' ? 'caller' : message.role === 'assistant' ? 'assistant' : null;
    if (!role) return null;
    const text = cleanLineText(message.transcript ?? '');
    if (!text) return null;
    return { kind: 'line', role, text };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Live signals: sentiment, intent, "wants a human"
// ---------------------------------------------------------------------------

const NEGATIVE = [
  /\b(angry|furious|upset|annoyed|frustrated|ridiculous|unacceptable|terrible|awful|horrible|worst|disgusted)\b/i,
  /\b(complain|complaint|refund|lawyer|sue|report you|bbb)\b/i,
  /\b(waste of (time|money)|rip.?off|never again|fed up|sick of)\b/i,
  /\b(still (not|isn'?t|hasn'?t)|again and again|nobody (called|came|showed))\b/i,
];
const POSITIVE = [
  /\b(thank(s| you)|appreciate|perfect|great|awesome|wonderful|excellent|fantastic|sounds good|that works)\b/i,
  /\b(helpful|amazing|love it|you'?re the best)\b/i,
];
const WANTS_HUMAN = [
  /\b(speak|talk|connect|transfer)( me)? (to|with) (a |an |the )?(real |live |actual )?(person|human|someone|manager|supervisor|owner|representative|agent)\b/i,
  /\b(real|live|actual) (person|human)\b/i,
  /\b(representative|operator|supervisor)\b/i,
  /\bnot a (robot|bot|machine)\b/i,
];

const INTENT_RULES: { intent: LiveIntent; rx: RegExp }[] = [
  { intent: 'emergency', rx: /\b(emergenc|urgent|gas (leak|smell)|smell gas|flood|burst|no (heat|cool|ac|power|water|hot water)|sparking|smoke|carbon monoxide)/i },
  { intent: 'complaint', rx: /\b(complain|angry|upset|unhappy|dissatisf|refund|dispute|bad service|not happy)/i },
  { intent: 'reschedule_cancel', rx: /\b(reschedul|cancel|move (my|the|our)|change (my|the|our) (appointment|booking|visit))/i },
  { intent: 'price_quote', rx: /\b(price|pricing|quote|estimate|cost|how much|rates?\b|fee)/i },
  { intent: 'existing_customer', rx: /\b(follow.?up|existing|returning|warranty|invoice|bill|previous (job|visit|service)|last (week|month) you)/i },
];

export function detectLiveIntent(text: string): LiveIntent | null {
  const t = text.trim();
  if (!t) return null;
  for (const rule of INTENT_RULES) if (rule.rx.test(t)) return rule.intent;
  return 'new_inquiry';
}

export function detectWantsHuman(text: string): boolean {
  return WANTS_HUMAN.some((rx) => rx.test(text));
}

/** -1 (very negative) .. +1 (very positive) for a single caller line. */
export function scoreLine(text: string): number {
  const neg = NEGATIVE.reduce((n, rx) => n + (rx.test(text) ? 1 : 0), 0);
  const pos = POSITIVE.reduce((n, rx) => n + (rx.test(text) ? 1 : 0), 0);
  if (neg === 0 && pos === 0) return 0;
  return Math.max(-1, Math.min(1, (pos - 1.5 * neg) / 2));
}

export function sentimentFromScore(score: number): LiveSentiment {
  if (score <= -0.25) return 'negative';
  if (score >= 0.25) return 'positive';
  return 'neutral';
}

export interface LiveSignals {
  sentiment_score: number;
  signal_text: string;
  intent: LiveIntent | null;
  wants_human: boolean;
}

export const EMPTY_SIGNALS: LiveSignals = { sentiment_score: 0, signal_text: '', intent: null, wants_human: false };

/**
 * Folds one more final CALLER line into the rolling signals. Sentiment is an
 * exponential moving average so one sharp word moves it but a calm follow-up
 * lets it recover; intent is re-derived from the last ~600 characters.
 */
export function applyCallerLine(prev: LiveSignals, text: string): LiveSignals {
  const clean = cleanLineText(text);
  if (!clean) return prev;
  const line = scoreLine(clean);
  const score = line === 0 ? prev.sentiment_score * 0.9 : prev.sentiment_score * 0.6 + line * 0.4;
  const signalText = `${prev.signal_text} ${clean}`.trim().slice(-SIGNAL_WINDOW_CHARS);
  return {
    sentiment_score: Math.round(score * 1000) / 1000,
    signal_text: signalText,
    intent: detectLiveIntent(signalText),
    wants_human: prev.wants_human || detectWantsHuman(clean),
  };
}

export function previewOf(text: string): string {
  const clean = cleanLineText(text);
  return clean.length > PREVIEW_CHARS ? `${clean.slice(0, PREVIEW_CHARS - 1)}…` : clean;
}

// ---------------------------------------------------------------------------
// Board ordering + staleness (UI)
// ---------------------------------------------------------------------------

export function isStale(call: Pick<LiveCallFacts, 'status' | 'started_at'>, nowMs: number): boolean {
  if (call.status === 'ended') return false;
  return nowMs - Date.parse(call.started_at) > STALE_AFTER_MS;
}

/** Higher = needs a human sooner. */
export function priorityScore(call: LiveCallFacts): number {
  return (
    (call.is_emergency ? 100 : 0) +
    (call.wants_human || call.human_transfer_requested ? 50 : 0) +
    (call.sentiment === 'negative' ? 20 : 0)
  );
}

export function partitionLiveCalls<T extends LiveCallFacts>(
  rows: T[],
  nowMs: number,
): { active: T[]; recent: T[] } {
  const active = rows
    .filter((r) => r.status !== 'ended' && !isStale(r, nowMs))
    .sort((a, b) => priorityScore(b) - priorityScore(a) || Date.parse(a.started_at) - Date.parse(b.started_at));
  const recent = rows
    .filter((r) => r.status === 'ended' && r.ended_at !== null && nowMs - Date.parse(r.ended_at) <= RECENT_ENDED_MS)
    .sort((a, b) => Date.parse(b.ended_at as string) - Date.parse(a.ended_at as string))
    .slice(0, MAX_RECENT_SHOWN);
  return { active, recent };
}

/** Insert-or-replace by id (realtime INSERT/UPDATE payloads). */
export function upsertById<T extends { id: string }>(list: T[], row: T): T[] {
  const i = list.findIndex((r) => r.id === row.id);
  if (i === -1) return [row, ...list];
  const next = list.slice();
  next[i] = row;
  return next;
}

export function removeById<T extends { id: string }>(list: T[], id: string): T[] {
  return list.filter((r) => r.id !== id);
}

/** Merge transcript lines by numeric id: de-duplicated, ascending, capped to the newest `cap`. */
export function mergeLines<T extends { id: number }>(existing: T[], incoming: T[], cap = 400): T[] {
  const byId = new Map<number, T>();
  for (const l of existing) byId.set(l.id, l);
  for (const l of incoming) byId.set(l.id, l);
  const all = Array.from(byId.values()).sort((a, b) => a.id - b.id);
  return all.length > cap ? all.slice(all.length - cap) : all;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// ---------------------------------------------------------------------------
// Handoff destination safety
// ---------------------------------------------------------------------------

export function isValidE164(value: unknown): value is string {
  return typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value);
}

export function maskNumber(value: string): string {
  return value.length <= 4 ? value : `••••${value.slice(-4)}`;
}
