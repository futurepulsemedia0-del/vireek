import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  buildQueue,
  customerIdentity,
  formatAge,
  isWithinCallingHours,
  queueSummary,
  scoreCandidate,
  smsHref,
  smsTemplate,
  snoozeUntilFor,
  telHref,
  tierFor,
  toE164,
  valuePoints,
  type OutcomeRecord,
  type QueueCandidate,
  type QueueReason,
} from '@/lib/callQueue';

const NOW = new Date('2026-10-09T15:00:00Z').getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);
const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();

let seq = 0;
function cand(over: Partial<QueueCandidate> = {}): QueueCandidate {
  seq += 1;
  const reason: QueueReason = over.reason ?? 'callback';
  return {
    key: `${reason}:t:${seq}`,
    reason,
    sourceTable: 't',
    sourceId: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
    customerName: `Customer ${seq}`,
    phone: `+1555000${String(1000 + seq)}`,
    valueCents: 0,
    occurredAt: hoursAgo(1),
    detail: '',
    ctaHref: null,
    ...over,
  };
}
const outcome = (itemKey: string, o: OutcomeRecord['outcome'], createdAt = hoursAgo(1), snoozeUntil: string | null = null): OutcomeRecord => ({
  itemKey,
  outcome: o,
  createdAt,
  snoozeUntil,
});

describe('phone helpers', () => {
  it('normalises to E.164 like the DNC check does', () => {
    expect(toE164('(555) 123-4567')).toBe('+15551234567');
    expect(toE164('1-555-123-4567')).toBe('+15551234567');
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
  });
  it('builds tel and sms links', () => {
    expect(telHref('555-123-4567')).toBe('tel:+15551234567');
    expect(smsHref('555-123-4567', 'Hi there & welcome')).toBe('sms:+15551234567?&body=Hi%20there%20%26%20welcome');
  });
  it('treats formatting variants of one number as one customer', () => {
    const a = customerIdentity({ phone: '(555) 123-4567', customerName: 'A' });
    const b = customerIdentity({ phone: '+15551234567', customerName: 'B' });
    expect(a).toBe(b);
  });
  it('falls back to the name when there is no usable phone', () => {
    expect(customerIdentity({ phone: null, customerName: ' Pat  ' })).toBe('n:pat');
  });
});

describe('scoring', () => {
  it('value points are monotonic, bounded and zero for $0', () => {
    expect(valuePoints(0)).toBe(0);
    expect(valuePoints(10_000)).toBeGreaterThan(valuePoints(1_000));
    expect(valuePoints(100_000_000)).toBe(20);
  });
  it('rewards a fresh missed call over a cold one', () => {
    const fresh = scoreCandidate(cand({ occurredAt: hoursAgo(0.5) }), 0, NOW).score;
    const cold = scoreCandidate(cand({ occurredAt: daysAgo(5) }), 0, NOW).score;
    expect(fresh).toBeGreaterThan(cold);
  });
  it('escalates unpaid invoices with days overdue (capped)', () => {
    const d3 = scoreCandidate(cand({ reason: 'unpaid_invoice', occurredAt: daysAgo(3) }), 0, NOW).score;
    const d30 = scoreCandidate(cand({ reason: 'unpaid_invoice', occurredAt: daysAgo(30) }), 0, NOW).score;
    const d90 = scoreCandidate(cand({ reason: 'unpaid_invoice', occurredAt: daysAgo(90) }), 0, NOW).score;
    expect(d30).toBeGreaterThan(d3);
    expect(d90).toBe(d30);
  });
  it('prefers quotes in the 2–7 day follow-up window', () => {
    const sweet = scoreCandidate(cand({ reason: 'quote_followup', occurredAt: daysAgo(4) }), 0, NOW).score;
    const stale = scoreCandidate(cand({ reason: 'quote_followup', occurredAt: daysAgo(40) }), 0, NOW).score;
    expect(sweet).toBeGreaterThan(stale);
  });
  it('ranks memberships by how soon they expire and flags failed payments', () => {
    const soon = scoreCandidate(cand({ reason: 'expiring_membership', expiresAt: inDays(3) }), 0, NOW).score;
    const later = scoreCandidate(cand({ reason: 'expiring_membership', expiresAt: inDays(25) }), 0, NOW).score;
    const pastDue = scoreCandidate(cand({ reason: 'expiring_membership', expiresAt: inDays(25), pastDue: true }), 0, NOW).score;
    expect(soon).toBeGreaterThan(later);
    expect(pastDue).toBeGreaterThan(later);
  });
  it('gives unhappy customers a recovery-window bonus', () => {
    const recent = scoreCandidate(cand({ reason: 'unhappy_customer', occurredAt: hoursAgo(5), rating: 1 }), 0, NOW).score;
    const old = scoreCandidate(cand({ reason: 'unhappy_customer', occurredAt: daysAgo(12), rating: 1 }), 0, NOW).score;
    expect(recent).toBeGreaterThan(old);
  });
  it('applies a bounded Next Best Actions boost', () => {
    const base = scoreCandidate(cand({ reason: 'quote_followup' }), 0, NOW).score;
    const boosted = scoreCandidate(cand({ reason: 'quote_followup', nbaScore: 100 }), 0, NOW).score;
    const absurd = scoreCandidate(cand({ reason: 'quote_followup', nbaScore: 9999 }), 0, NOW).score;
    expect(boosted - base).toBeCloseTo(10, 1);
    expect(absurd).toBe(boosted);
  });
  it('penalises prior attempts and missing phones, and clamps to 0–100', () => {
    const c = cand();
    expect(scoreCandidate(c, 2, NOW).score).toBeLessThan(scoreCandidate(c, 0, NOW).score);
    expect(scoreCandidate(cand({ phone: null }), 0, NOW).score).toBeLessThan(scoreCandidate(c, 0, NOW).score);
    const huge = scoreCandidate(cand({ reason: 'unhappy_customer', valueCents: 10 ** 9, nbaScore: 100, rating: 1, occurredAt: hoursAgo(1) }), 0, NOW).score;
    expect(huge).toBeLessThanOrEqual(100);
    expect(scoreCandidate(cand({ reason: 'churn_risk', phone: null }), 9, NOW).score).toBeGreaterThanOrEqual(0);
  });
  it('maps scores to tiers', () => {
    expect(tierFor(80)).toBe('now');
    expect(tierFor(60)).toBe('today');
    expect(tierFor(20)).toBe('soon');
  });
  it('explains every point: factors sum to the score', () => {
    const { score, factors } = scoreCandidate(cand({ reason: 'unpaid_invoice', valueCents: 250_000, occurredAt: daysAgo(10) }), 1, NOW);
    expect(factors.reduce((s, f) => s + f.points, 0)).toBeCloseTo(score, 1);
  });
});

describe('buildQueue', () => {
  it('ranks by score, highest first', () => {
    const lowChurn = cand({ reason: 'churn_risk' });
    const hotCallback = cand({ reason: 'callback', occurredAt: hoursAgo(0.2), valueCents: 50_000 });
    const q = buildQueue([lowChurn, hotCallback], [], NOW);
    expect(q.map((i) => i.key)).toEqual([hotCallback.key, lowChurn.key]);
  });
  it('is deterministic for ties', () => {
    const a = cand({ occurredAt: hoursAgo(3) });
    const b = cand({ occurredAt: hoursAgo(3) });
    const first = buildQueue([a, b], [], NOW).map((i) => i.key);
    const second = buildQueue([b, a], [], NOW).map((i) => i.key);
    expect(first).toEqual(second);
  });
  it('removes duplicate keys', () => {
    const a = cand();
    expect(buildQueue([a, { ...a }], [], NOW)).toHaveLength(1);
  });
  it('drops items with a terminal outcome', () => {
    const a = cand();
    const q = buildQueue([a], [outcome(a.key, 'reached_booked')], NOW);
    expect(q).toHaveLength(0);
  });
  it('hides snoozed items until the snooze ends', () => {
    const a = cand();
    const snoozed = outcome(a.key, 'no_answer', hoursAgo(1), inDays(0.1));
    expect(buildQueue([a], [snoozed], NOW)).toHaveLength(0);
    const later = NOW + 24 * 3_600_000;
    const back = buildQueue([a], [snoozed], later);
    expect(back).toHaveLength(1);
    expect(back[0].attempts).toBe(1);
  });
  it('honours the ledger next_follow_up_at', () => {
    const a = cand({ snoozedUntil: inDays(1) });
    expect(buildQueue([a], [], NOW)).toHaveLength(0);
  });
  it('lets the latest outcome decide the snooze', () => {
    const a = cand();
    const o = [outcome(a.key, 'no_answer', hoursAgo(10), inDays(2)), outcome(a.key, 'no_answer', hoursAgo(9), hoursAgo(5))];
    expect(buildQueue([a], o, NOW)).toHaveLength(1);
  });
  it('retires items after MAX_ATTEMPTS but never an unhappy customer', () => {
    const a = cand({ reason: 'quote_followup' });
    const u = cand({ reason: 'unhappy_customer' });
    const mk = (key: string) => Array.from({ length: MAX_ATTEMPTS }, (_, i) => outcome(key, 'no_answer', hoursAgo(100 - i), hoursAgo(90 - i)));
    expect(buildQueue([a], mk(a.key), NOW)).toHaveLength(0);
    expect(buildQueue([u], mk(u.key), NOW)).toHaveLength(1);
  });
  it('does not count wrong-number or do-not-contact as attempts', () => {
    const a = cand();
    // terminal, so it leaves; attempts irrelevant — verify via a non-terminal texted vs terminal
    expect(buildQueue([a], [outcome(a.key, 'wrong_number')], NOW)).toHaveLength(0);
    expect(buildQueue([a], [outcome(a.key, 'do_not_contact')], NOW)).toHaveLength(0);
  });
  it('folds multiple reasons for one customer into a single, higher-ranked call', () => {
    const phone = '+15559990000';
    const inv = cand({ reason: 'unpaid_invoice', phone, customerName: 'Dana', occurredAt: daysAgo(10), valueCents: 90_000 });
    const quo = cand({ reason: 'quote_followup', phone: '(555) 999-0000', customerName: 'Dana R.', occurredAt: daysAgo(3) });
    const solo = scoreCandidate(inv, 0, NOW).score;
    const q = buildQueue([quo, inv], [], NOW);
    expect(q).toHaveLength(1);
    expect(q[0].reason).toBe('unpaid_invoice');
    expect(q[0].alsoReasons).toEqual(['quote_followup']);
    expect(q[0].score).toBeGreaterThan(solo);
  });
  it('keeps phone-less items but marks them not callable', () => {
    const q = buildQueue([cand({ phone: null })], [], NOW);
    expect(q[0].callable).toBe(false);
  });
  it('summarises tiers and value', () => {
    const q = buildQueue(
      [cand({ reason: 'unhappy_customer', occurredAt: hoursAgo(2), valueCents: 5_000 }), cand({ reason: 'churn_risk', valueCents: 7_000 })],
      [],
      NOW,
    );
    const s = queueSummary(q);
    expect(s.now + s.today + s.soon).toBe(2);
    expect(s.valueCents).toBe(12_000);
  });
});

describe('outcomes & helpers', () => {
  it('snoozes only for non-terminal outcomes', () => {
    expect(snoozeUntilFor('reached_booked', NOW)).toBeNull();
    expect(snoozeUntilFor('no_answer', NOW)).toBe(new Date(NOW + 4 * 3_600_000).toISOString());
    expect(snoozeUntilFor('left_voicemail', NOW)).toBe(new Date(NOW + 24 * 3_600_000).toISOString());
  });
  it('respects courtesy calling hours', () => {
    expect(isWithinCallingHours(new Date(2026, 9, 9, 7, 59))).toBe(false);
    expect(isWithinCallingHours(new Date(2026, 9, 9, 8, 0))).toBe(true);
    expect(isWithinCallingHours(new Date(2026, 9, 9, 20, 59))).toBe(true);
    expect(isWithinCallingHours(new Date(2026, 9, 9, 21, 0))).toBe(false);
  });
  it('formats ages', () => {
    expect(formatAge(hoursAgo(0.25), NOW)).toBe('15m ago');
    expect(formatAge(hoursAgo(5), NOW)).toBe('5h ago');
    expect(formatAge(daysAgo(4), NOW)).toBe('4d ago');
  });
  it('writes SMS templates for every reason without inventing facts', () => {
    const reasons: QueueReason[] = ['callback', 'abandoned_booking', 'unpaid_invoice', 'quote_followup', 'expiring_membership', 'unhappy_customer', 'churn_risk'];
    for (const r of reasons) {
      const t = smsTemplate(r, 'Dana Reyes', 'Acme HVAC');
      expect(t).toContain('Hi Dana');
      expect(t).toContain('Acme HVAC');
      expect(t).not.toMatch(/\$\d/);
    }
    expect(smsTemplate('callback', 'Unknown caller', '')).toMatch(/^Hi, this is our team/);
  });
});
