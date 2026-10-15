/**
 * Priority Call Queue — pure domain logic (no I/O, fully unit-tested).
 *
 * Turns raw "someone should contact this customer" signals into ONE ranked
 * list for the CSR/owner. Scoring is deterministic and explainable: every
 * point has a named factor, shown in the UI as "why this is next". The
 * next-best-actions engine contributes a bounded boost (it never creates or
 * reorders items on its own authority) — see `nbaScore`.
 */

export type QueueReason =
  | 'callback'
  | 'abandoned_booking'
  | 'unpaid_invoice'
  | 'quote_followup'
  | 'expiring_membership'
  | 'unhappy_customer'
  | 'churn_risk';

export type QueueOutcome =
  | 'reached_booked'
  | 'reached_resolved'
  | 'reached_follow_up'
  | 'no_answer'
  | 'left_voicemail'
  | 'texted'
  | 'not_interested'
  | 'wrong_number'
  | 'do_not_contact';

export type QueueTier = 'now' | 'today' | 'soon';

export interface QueueCandidate {
  /** Stable identity of the underlying event: `${reason}:${table}:${id}`. */
  key: string;
  reason: QueueReason;
  sourceTable: string;
  sourceId: string;
  customerName: string;
  phone: string | null;
  valueCents: number;
  /** When the underlying event happened (missed call time, invoice due date, …). */
  occurredAt: string;
  /** Membership only: when the period ends (ISO). */
  expiresAt?: string | null;
  /** Membership only: payment failed and is in grace period. */
  pastDue?: boolean;
  /** Unhappy customer only: 1–5 rating when known. */
  rating?: number | null;
  detail: string;
  ctaHref: string | null;
  /** Hidden until this ISO time (ledger next_follow_up_at). */
  snoozedUntil?: string | null;
  /** Today's next-best-actions priority (0–100) when the engine flagged this item. */
  nbaScore?: number | null;
}

export interface OutcomeRecord {
  itemKey: string;
  outcome: QueueOutcome;
  snoozeUntil: string | null;
  createdAt: string;
}

export interface ScoreFactor {
  label: string;
  points: number;
}

export interface QueueItem extends QueueCandidate {
  score: number;
  tier: QueueTier;
  factors: ScoreFactor[];
  attempts: number;
  lastAttemptAt: string | null;
  /** Other open reasons for the same customer, folded into this one call. */
  alsoReasons: QueueReason[];
  callable: boolean;
}

export const REASON_META: Record<QueueReason, { label: string; className: string; base: number }> = {
  unhappy_customer: { label: 'Unhappy customer', className: 'bg-danger-500/10 text-danger-500', base: 75 },
  callback: { label: 'Callback', className: 'bg-accent/10 text-accent', base: 70 },
  abandoned_booking: { label: 'Abandoned booking', className: 'bg-warning-500/10 text-warning-500', base: 60 },
  unpaid_invoice: { label: 'Unpaid invoice', className: 'bg-danger-500/10 text-danger-500', base: 55 },
  quote_followup: { label: 'Quote follow-up', className: 'bg-warning-500/10 text-warning-500', base: 50 },
  expiring_membership: { label: 'Membership', className: 'bg-accent/10 text-accent', base: 45 },
  churn_risk: { label: 'Win-back', className: 'bg-bg-tertiary text-text-secondary', base: 35 },
};

export const OUTCOME_META: Record<QueueOutcome, { label: string; terminal: boolean; attempt: boolean; snoozeHours: number }> = {
  reached_booked: { label: 'Reached — booked', terminal: true, attempt: true, snoozeHours: 0 },
  reached_resolved: { label: 'Reached — resolved', terminal: true, attempt: true, snoozeHours: 0 },
  reached_follow_up: { label: 'Reached — call back later', terminal: false, attempt: true, snoozeHours: 72 },
  no_answer: { label: 'No answer', terminal: false, attempt: true, snoozeHours: 4 },
  left_voicemail: { label: 'Left voicemail', terminal: false, attempt: true, snoozeHours: 24 },
  texted: { label: 'Sent a text', terminal: false, attempt: true, snoozeHours: 24 },
  not_interested: { label: 'Not interested', terminal: true, attempt: true, snoozeHours: 0 },
  wrong_number: { label: 'Wrong number', terminal: true, attempt: false, snoozeHours: 0 },
  do_not_contact: { label: 'Do not contact', terminal: true, attempt: false, snoozeHours: 0 },
};

/** Attempts after which a non-urgent item leaves the queue instead of nagging. */
export const MAX_ATTEMPTS = 4;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ----------------------------- phone helpers ----------------------------- */

export function phoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

/** Matches normalizePhone() in supabase/functions/_shared/compliance/dncCheck.ts. */
export function toE164(phone: string): string {
  const d = phoneDigits(phone);
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return `+${d}`;
}

/** Last-10-digit identity so "(555) 123-4567" and "+15551234567" are one customer. */
export function customerIdentity(c: Pick<QueueCandidate, 'phone' | 'customerName'>): string {
  const d = phoneDigits(c.phone);
  return d.length >= 7 ? `p:${d.slice(-10)}` : `n:${c.customerName.trim().toLowerCase()}`;
}

export function telHref(phone: string): string {
  return `tel:${toE164(phone)}`;
}

export function smsHref(phone: string, body: string): string {
  return `sms:${toE164(phone)}?&body=${encodeURIComponent(body)}`;
}

/* ------------------------------ time helpers ----------------------------- */

function ageHours(iso: string, now: number): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.max(0, (now - t) / HOUR) : 0;
}

/** Courtesy window (local time): outside it we steer to text, never block. */
export function isWithinCallingHours(now: Date, startHour = 8, endHour = 21): boolean {
  const h = now.getHours();
  return h >= startHour && h < endHour;
}

export function formatAge(iso: string, now: number = Date.now()): string {
  const h = ageHours(iso, now);
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* -------------------------------- scoring -------------------------------- */

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 0–20 points on a log scale: $0 → 0, $100 → ~10, $5,000+ → 20. */
export function valuePoints(valueCents: number): number {
  const dollars = Math.max(0, valueCents) / 100;
  return round(20 * Math.min(1, Math.log10(1 + dollars) / Math.log10(1 + 5000)));
}

function urgencyFactors(c: QueueCandidate, now: number): ScoreFactor[] {
  const hrs = ageHours(c.occurredAt, now);
  const out: ScoreFactor[] = [];

  switch (c.reason) {
    case 'callback':
    case 'abandoned_booking':
      // Speed-to-lead: the first hours matter most, then interest decays.
      if (hrs <= 2) out.push({ label: 'Fresh lead (< 2h)', points: 12 });
      else if (hrs <= 24) out.push({ label: 'Same-day lead', points: 6 });
      else if (hrs > 72) out.push({ label: 'Going cold (> 3 days)', points: -8 });
      break;
    case 'unpaid_invoice': {
      const days = hrs / 24;
      const pts = Math.min(15, Math.round(days * 1.5));
      if (pts > 0) out.push({ label: `${Math.floor(days)}d overdue`, points: pts });
      break;
    }
    case 'quote_followup': {
      const days = hrs / 24;
      if (days >= 2 && days <= 7) out.push({ label: 'Follow-up sweet spot (2–7d)', points: 10 });
      else if (days > 7 && days <= 21) out.push({ label: 'Aging quote', points: 4 });
      else if (days > 21) out.push({ label: 'Stale quote', points: -6 });
      break;
    }
    case 'expiring_membership': {
      if (c.pastDue) out.push({ label: 'Payment failed', points: 15 });
      if (c.expiresAt) {
        const daysLeft = (new Date(c.expiresAt).getTime() - now) / DAY;
        if (daysLeft <= 7) out.push({ label: 'Expires within 7 days', points: 15 });
        else if (daysLeft <= 14) out.push({ label: 'Expires within 14 days', points: 10 });
        else if (daysLeft <= 30) out.push({ label: 'Expires within 30 days', points: 5 });
      }
      break;
    }
    case 'unhappy_customer':
      if (hrs <= 48) out.push({ label: 'Recovery window (< 48h)', points: 10 });
      else if (hrs > 24 * 10) out.push({ label: 'Old complaint', points: -6 });
      if (c.rating != null && c.rating <= 1) out.push({ label: '1-star rating', points: 5 });
      break;
    case 'churn_risk':
      break;
  }
  return out;
}

export function scoreCandidate(c: QueueCandidate, attempts: number, now: number = Date.now()): { score: number; factors: ScoreFactor[] } {
  const factors: ScoreFactor[] = [{ label: REASON_META[c.reason].label, points: REASON_META[c.reason].base }];

  const vp = valuePoints(c.valueCents);
  if (vp > 0) factors.push({ label: 'Revenue at stake', points: vp });

  factors.push(...urgencyFactors(c, now));

  if (c.nbaScore != null && c.nbaScore > 0) {
    factors.push({ label: 'Flagged by Next Best Actions', points: round((Math.min(100, c.nbaScore) / 100) * 10) });
  }
  if (attempts > 0) factors.push({ label: `${attempts} prior attempt${attempts > 1 ? 's' : ''}`, points: -Math.min(24, attempts * 8) });
  if (!c.phone) factors.push({ label: 'No phone number', points: -30 });

  const total = factors.reduce((s, f) => s + f.points, 0);
  return { score: Math.max(0, Math.min(100, round(total))), factors };
}

export function tierFor(score: number): QueueTier {
  return score >= 75 ? 'now' : score >= 55 ? 'today' : 'soon';
}

/* --------------------------- outcome application -------------------------- */

export function snoozeUntilFor(outcome: QueueOutcome, now: number = Date.now()): string | null {
  const h = OUTCOME_META[outcome].snoozeHours;
  return h > 0 ? new Date(now + h * HOUR).toISOString() : null;
}

interface ItemState {
  resolved: boolean;
  attempts: number;
  snoozedUntil: number;
  lastAttemptAt: string | null;
}

function foldOutcomes(outcomes: OutcomeRecord[]): Map<string, ItemState> {
  const byKey = new Map<string, OutcomeRecord[]>();
  for (const o of outcomes) {
    const list = byKey.get(o.itemKey) ?? [];
    list.push(o);
    byKey.set(o.itemKey, list);
  }
  const out = new Map<string, ItemState>();
  for (const [key, list] of byKey) {
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const state: ItemState = { resolved: false, attempts: 0, snoozedUntil: 0, lastAttemptAt: null };
    for (const o of list) {
      const meta = OUTCOME_META[o.outcome];
      if (!meta) continue;
      if (meta.attempt) {
        state.attempts += 1;
        state.lastAttemptAt = o.createdAt;
      }
      if (meta.terminal) state.resolved = true;
      // The latest outcome decides the current snooze.
      state.snoozedUntil = o.snoozeUntil ? new Date(o.snoozeUntil).getTime() : 0;
    }
    out.set(key, state);
  }
  return out;
}

/* --------------------------------- ranking -------------------------------- */

/**
 * Candidates + outcome history → ranked queue.
 *  - drops resolved, snoozed and exhausted (≥ MAX_ATTEMPTS) items,
 *  - folds multiple reasons for one customer into a single call,
 *  - sorts by score, then value, then age (oldest first) for stability.
 */
export function buildQueue(candidates: QueueCandidate[], outcomes: OutcomeRecord[], now: number = Date.now()): QueueItem[] {
  const state = foldOutcomes(outcomes);

  const seen = new Set<string>();
  const scored: QueueItem[] = [];

  for (const c of candidates) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);

    const st = state.get(c.key);
    if (st?.resolved) continue;
    if (st && st.snoozedUntil > now) continue;
    if (c.snoozedUntil && new Date(c.snoozedUntil).getTime() > now) continue;
    const attempts = st?.attempts ?? 0;
    if (attempts >= MAX_ATTEMPTS && c.reason !== 'unhappy_customer') continue;

    const { score, factors } = scoreCandidate(c, attempts, now);
    scored.push({
      ...c,
      score,
      tier: tierFor(score),
      factors,
      attempts,
      lastAttemptAt: st?.lastAttemptAt ?? null,
      alsoReasons: [],
      callable: Boolean(c.phone && phoneDigits(c.phone).length >= 7),
    });
  }

  const compare = (a: QueueItem, b: QueueItem) =>
    b.score - a.score ||
    b.valueCents - a.valueCents ||
    new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime() ||
    a.key.localeCompare(b.key);

  scored.sort(compare);

  // One call per customer: the strongest reason leads, the rest ride along.
  const primaries = new Map<string, QueueItem>();
  for (const item of scored) {
    const id = customerIdentity(item);
    const lead = primaries.get(id);
    if (!lead) {
      primaries.set(id, item);
    } else if (!lead.alsoReasons.includes(item.reason) && item.reason !== lead.reason) {
      lead.alsoReasons.push(item.reason);
    }
  }

  const merged = [...primaries.values()].map((item) => {
    if (item.alsoReasons.length === 0) return item;
    const bonus = Math.min(10, item.alsoReasons.length * 5);
    const score = Math.min(100, round(item.score + bonus));
    return {
      ...item,
      score,
      tier: tierFor(score),
      factors: [...item.factors, { label: `${item.alsoReasons.length} more open reason(s)`, points: bonus }],
    };
  });

  return merged.sort(compare);
}

export function queueSummary(items: QueueItem[]): { now: number; today: number; soon: number; valueCents: number } {
  return {
    now: items.filter((i) => i.tier === 'now').length,
    today: items.filter((i) => i.tier === 'today').length,
    soon: items.filter((i) => i.tier === 'soon').length,
    valueCents: items.reduce((s, i) => s + i.valueCents, 0),
  };
}

/* ------------------------------ SMS templates ----------------------------- */

export function firstName(name: string): string {
  const n = name.trim().split(/\s+/)[0] ?? '';
  return /^(unknown|caller|customer)/i.test(n) ? '' : n;
}

/** Short, human, opt-out-friendly first-touch text. Never states amounts or invents facts. */
export function smsTemplate(reason: QueueReason, customerName: string, businessName: string): string {
  const hi = firstName(customerName) ? `Hi ${firstName(customerName)}` : 'Hi';
  const who = businessName.trim() || 'our team';
  switch (reason) {
    case 'callback':
      return `${hi}, this is ${who}. Sorry we missed your call! How can we help? Reply here or call us back anytime.`;
    case 'abandoned_booking':
      return `${hi}, this is ${who}. Looks like we didn't get your appointment locked in. Want me to find a time that works?`;
    case 'unpaid_invoice':
      return `${hi}, this is ${who}. A quick reminder that your invoice is still open. Let us know if you have any questions or need a hand with it.`;
    case 'quote_followup':
      return `${hi}, this is ${who}. Just checking in on the estimate we sent. Happy to answer any questions or adjust it.`;
    case 'expiring_membership':
      return `${hi}, this is ${who}. Your service plan is coming up for renewal. Want us to take care of it so your benefits keep going?`;
    case 'unhappy_customer':
      return `${hi}, this is ${who}. We want to make things right. Could we chat about your recent experience?`;
    case 'churn_risk':
      return `${hi}, this is ${who}. It's been a while, so we're checking in. Need a tune-up or anything else this season?`;
  }
}
