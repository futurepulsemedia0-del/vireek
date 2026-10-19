import { describe, it, expect } from 'vitest';
import {
  ATTRIBUTION_WINDOW_DAYS, MAX_SNAPSHOT_ROWS, attribute, categoryOf, computeStatement, currentWeekWindow,
  formatMoney, formatPct, isStatementDue, previousWeekWindow, weekWindowFor,
  type LedgerEvent,
} from './engine';

const DAY = 86_400_000;
const T = (iso: string) => Date.parse(iso);

function ev(over: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    id: 'e1', source_type: 'missed_call', call_id: null, customer_name: 'Pat Lee',
    occurred_at: '2026-10-06T15:00:00Z', estimated_value_cents: 50_000, status: 'recovered',
    recovery_method: 'callback', recovered_amount_cents: 40_000, follow_up_count: 1,
    last_follow_up_at: '2026-10-07T15:00:00Z', resolved_at: '2026-10-08T15:00:00Z', ...over,
  };
}

describe('attribute (conservative attribution)', () => {
  it('claims the collected amount when a follow-up preceded the recovery', () => {
    expect(attribute(ev())).toEqual({ claimed: true, creditedCents: 40_000, cappedByEstimate: false });
  });

  it('caps the credit at the estimate so upsells are never claimed', () => {
    expect(attribute(ev({ recovered_amount_cents: 90_000 }))).toEqual({ claimed: true, creditedCents: 50_000, cappedByEstimate: true });
  });

  it('credits the real amount when there was no estimate to cap against', () => {
    const r = attribute(ev({ estimated_value_cents: 0, recovered_amount_cents: 12_345 }));
    expect(r).toEqual({ claimed: true, creditedCents: 12_345, cappedByEstimate: false });
  });

  it('never claims manual, unverifiable entries', () => {
    expect(attribute(ev({ recovery_method: 'manual' }))).toEqual({ claimed: false, reason: 'owner_reported' });
  });

  it('never claims a recovery with no logged follow-up (the customer may have returned alone)', () => {
    expect(attribute(ev({ follow_up_count: 0, last_follow_up_at: null }))).toEqual({ claimed: false, reason: 'no_documented_follow_up' });
    expect(attribute(ev({ follow_up_count: 2, last_follow_up_at: null }))).toEqual({ claimed: false, reason: 'no_documented_follow_up' });
    expect(attribute(ev({ resolved_at: null }))).toEqual({ claimed: false, reason: 'no_documented_follow_up' });
  });

  it('rejects a follow-up logged after the money came in', () => {
    expect(attribute(ev({ last_follow_up_at: '2026-10-09T00:00:00Z' }))).toEqual({ claimed: false, reason: 'follow_up_after_recovery' });
  });

  it('enforces the attribution window, inclusive at the boundary', () => {
    const resolved = '2026-10-20T12:00:00Z';
    const at = (days: number) => new Date(T(resolved) - days * DAY).toISOString();
    expect(attribute(ev({ resolved_at: resolved, last_follow_up_at: at(ATTRIBUTION_WINDOW_DAYS) })).claimed).toBe(true);
    expect(attribute(ev({ resolved_at: resolved, last_follow_up_at: at(ATTRIBUTION_WINDOW_DAYS + 1) }))).toEqual({ claimed: false, reason: 'follow_up_too_old' });
  });

  it('ignores zero, negative and non-finite amounts', () => {
    for (const amount of [0, -5, null, Number.NaN]) {
      expect(attribute(ev({ recovered_amount_cents: amount as number | null }))).toEqual({ claimed: false, reason: 'no_amount' });
    }
  });

  it('treats unparseable dates as undocumented rather than throwing', () => {
    expect(attribute(ev({ last_follow_up_at: 'not-a-date' }))).toEqual({ claimed: false, reason: 'no_documented_follow_up' });
  });
});

describe('weeks (Monday–Sunday in the owner time zone)', () => {
  it('returns the last completed week with correct UTC bounds in a DST-observing zone', () => {
    const w = previousWeekWindow(new Date('2026-10-14T15:00:00Z'), 'America/Chicago');
    expect(w.start).toBe('2026-10-05');
    expect(w.end).toBe('2026-10-11');
    expect(w.startUtc).toBe('2026-10-05T05:00:00.000Z');
    expect(w.endUtc).toBe('2026-10-12T05:00:00.000Z');
    expect(w.label).toBe('Oct 5 – Oct 11, 2026');
  });

  it('switches weeks at LOCAL midnight, not UTC midnight', () => {
    // Sun 2026-10-11 23:30 Chicago (= Mon 04:30Z): still the week of Oct 5 -> previous is Sep 28.
    expect(previousWeekWindow(new Date('2026-10-12T04:30:00Z'), 'America/Chicago').start).toBe('2026-09-28');
    // Mon 2026-10-12 00:30 Chicago (= 05:30Z): week of Oct 5 just completed.
    expect(previousWeekWindow(new Date('2026-10-12T05:30:00Z'), 'America/Chicago').start).toBe('2026-10-05');
  });

  it('handles the week that contains a DST change (169 hours)', () => {
    const w = weekWindowFor('2026-10-26', 'America/New_York')!;
    expect(w.startUtc).toBe('2026-10-26T04:00:00.000Z');
    expect(w.endUtc).toBe('2026-11-02T05:00:00.000Z');
    expect((T(w.endUtc) - T(w.startUtc)) / 3_600_000).toBe(169);
  });

  it('currentWeekWindow is the week containing now', () => {
    expect(currentWeekWindow(new Date('2026-10-14T15:00:00Z'), 'UTC').start).toBe('2026-10-12');
  });

  it('labels a week that spans two years', () => {
    expect(weekWindowFor('2026-12-28', 'UTC')!.label).toBe('Dec 28, 2026 – Jan 3, 2027');
  });

  it('rejects non-Mondays, impossible dates and bad time zones', () => {
    expect(weekWindowFor('2026-10-05', 'UTC')).not.toBeNull();
    expect(weekWindowFor('2026-10-06', 'UTC')).toBeNull();
    expect(weekWindowFor('2026-02-30', 'UTC')).toBeNull();
    expect(weekWindowFor('10/05/2026', 'UTC')).toBeNull();
    expect(weekWindowFor('2026-10-05', 'Mars/Olympus')).toBeNull();
  });

  it('is due from the send hour on Monday and stays due through the week', () => {
    const s = { enabled: true, send_hour: 8, timezone: 'America/Chicago' };
    expect(isStatementDue(s, new Date('2026-10-12T12:00:00Z'))).toBe(false); // Mon 07:00 CDT
    expect(isStatementDue(s, new Date('2026-10-12T13:00:00Z'))).toBe(true); // Mon 08:00 CDT
    expect(isStatementDue(s, new Date('2026-10-15T03:00:00Z'))).toBe(true); // Wed
    expect(isStatementDue({ ...s, enabled: false }, new Date('2026-10-15T03:00:00Z'))).toBe(false);
    expect(isStatementDue({ ...s, timezone: 'Nope/Zone' }, new Date('2026-10-15T03:00:00Z'))).toBe(false);
  });
});

describe('computeStatement', () => {
  const window = weekWindowFor('2026-10-05', 'UTC')!;
  const now = new Date('2026-10-12T08:00:00Z');
  const calls = [{ id: 'c1', summary: '  Water heater   leaking, wants same-day.  ', has_recording: true }];

  const events: LedgerEvent[] = [
    ev({ id: 'e1', call_id: 'c1' }), // credited 40_000 (missed_calls)
    ev({ id: 'e2', source_type: 'declined_quote', recovered_amount_cents: 90_000, estimated_value_cents: 50_000 }), // credited, capped 50_000 (quotes)
    ev({ id: 'e3', recovery_method: 'manual', recovered_amount_cents: 20_000, occurred_at: '2026-09-20T10:00:00Z' }), // not claimed (manual)
    ev({ id: 'e4', follow_up_count: 0, last_follow_up_at: null, recovered_amount_cents: 30_000, estimated_value_cents: 30_000 }), // not claimed (no follow-up)
    ev({ id: 'e5', occurred_at: '2026-09-28T10:00:00Z', resolved_at: '2026-10-02T10:00:00Z', last_follow_up_at: '2026-10-01T10:00:00Z' }), // resolved LAST week -> excluded
    ev({ id: 'e6', status: 'open', estimated_value_cents: 15_000, recovered_amount_cents: null, resolved_at: null, last_follow_up_at: null, follow_up_count: 0 }),
    ev({ id: 'e7', status: 'contacted', estimated_value_cents: 8_000, recovered_amount_cents: null, resolved_at: null, occurred_at: '2026-09-25T10:00:00Z', last_follow_up_at: '2026-10-09T10:00:00Z' }),
    ev({ id: 'e8', occurred_at: '2026-09-22T10:00:00Z', status: 'written_off', recovered_amount_cents: null, resolved_at: '2026-10-09T10:00:00Z' }),
  ];
  const baseline = { monthly_leak_cents: 600_000, source: 'leak_report', captured_at: '2026-03-01T00:00:00Z', label: 'Leak Report, March 2026' };
  const st = computeStatement({ events: [...events, events[0]], calls, baseline, window, now });

  it('claims only evidence-backed money and never double counts duplicates', () => {
    expect(st.creditedCents).toBe(90_000);
    expect(st.creditedCount).toBe(2);
  });

  it('lists recovered-but-unclaimed money separately with reasons, never in the headline', () => {
    expect(st.notClaimedCents).toBe(50_000);
    expect(st.notClaimedCount).toBe(2);
    expect(st.notClaimedByReason).toEqual({
      owner_reported: { count: 1, cents: 20_000 },
      no_documented_follow_up: { count: 1, cents: 30_000 },
    });
  });

  it('excludes recoveries resolved outside the week and ignores written-off entries', () => {
    const ids = st.rows.map((r) => r.eventId);
    expect(ids).not.toContain('e5');
    expect(ids).not.toContain('e8');
  });

  it('reports open and contacted items as an estimate, not revenue', () => {
    expect(st.stillOpenCount).toBe(2);
    expect(st.stillOpenCents).toBe(23_000);
    expect(st.inProgressCount).toBe(1);
  });

  it('orders rows: credited (largest first), in progress, then not claimed', () => {
    expect(st.rows.map((r) => `${r.eventId}:${r.state}`)).toEqual([
      'e2:credited', 'e1:credited', 'e7:in_progress', 'e4:not_claimed', 'e3:not_claimed',
    ]);
    expect(st.rows[0].cappedByEstimate).toBe(true);
    expect(st.rows[0].creditedCents).toBe(50_000);
  });

  it('totals by category reconcile exactly to the headline', () => {
    const sum = (k: 'creditedCents' | 'notClaimedCents' | 'openCents') => st.categories.reduce((n, c) => n + c[k], 0);
    expect(sum('creditedCents')).toBe(st.creditedCents);
    expect(sum('notClaimedCents')).toBe(st.notClaimedCents);
    expect(sum('openCents')).toBe(st.stillOpenCents);
    expect(st.categories.find((c) => c.category === 'missed_calls')!.creditedCents).toBe(40_000);
    expect(st.categories.find((c) => c.category === 'quotes')!.creditedCents).toBe(50_000);
  });

  it('joins the call summary (whitespace-normalised) and exposes only a has-recording flag', () => {
    const row = st.rows.find((r) => r.eventId === 'e1')!;
    expect(row.callId).toBe('c1');
    expect(row.summary).toBe('Water heater leaking, wants same-day.');
    expect(row.hasRecording).toBe(true);
    expect(JSON.stringify(st)).not.toContain('recording_url');
  });

  it('compares with the baseline Leak Report, scaled from monthly to weekly', () => {
    const b = st.baseline!;
    expect(b.weeklyLeakCents).toBe(Math.round((600_000 * 7) / 30.4375));
    expect(b.leakedThisWeekCents).toBe(145_000); // e1 50k + e2 50k + e4 30k + e6 15k occurred this week
    expect(b.creditedCents).toBe(90_000);
    expect(b.recoveredVsBaselinePct).toBeCloseTo((90_000 / b.weeklyLeakCents) * 100, 1);
    expect(b.leakVsBaselinePct).toBeCloseTo(((145_000 - b.weeklyLeakCents) / b.weeklyLeakCents) * 100, 1);
  });

  it('omits the comparison when there is no usable baseline', () => {
    expect(computeStatement({ events, calls, baseline: null, window, now }).baseline).toBeNull();
    expect(computeStatement({ events, calls, baseline: { ...baseline, monthly_leak_cents: 0 }, window, now }).baseline).toBeNull();
  });

  it('is deterministic and falls back to safe defaults', () => {
    expect(computeStatement({ events, calls, baseline, window, now })).toEqual(computeStatement({ events, calls, baseline, window, now }));
    const empty = computeStatement({ events: [], calls: [], baseline: null, window, now });
    expect(empty.creditedCents).toBe(0);
    expect(empty.categories).toEqual([]);
    expect(empty.rows).toEqual([]);
    expect(empty.currency).toBe('USD');
    const anon = computeStatement({ events: [ev({ customer_name: null, call_id: 'ghost' })], calls: [], baseline: null, window, now });
    expect(anon.rows[0].customer).toBe('Unknown caller');
    expect(anon.rows[0].callId).toBeNull();
  });

  it('truncates long summaries', () => {
    const long = computeStatement({ events: [ev({ call_id: 'c1' })], calls: [{ id: 'c1', summary: 'x'.repeat(500), has_recording: false }], baseline: null, window, now });
    expect(long.rows[0].summary!.length).toBeLessThanOrEqual(220);
    expect(long.rows[0].summary!.endsWith('…')).toBe(true);
  });

  it('caps stored rows but keeps totals exact', () => {
    const many = Array.from({ length: MAX_SNAPSHOT_ROWS + 50 }, (_, i) => ev({ id: `m${i}` }));
    const big = computeStatement({ events: many, calls: [], baseline: null, window, now });
    expect(big.rows).toHaveLength(MAX_SNAPSHOT_ROWS);
    expect(big.rowsOmitted).toBe(50);
    expect(big.creditedCents).toBe(40_000 * many.length);
  });
});

describe('helpers', () => {
  it('maps every ledger source type to a category, with a safe fallback', () => {
    expect(categoryOf('voicemail')).toBe('missed_calls');
    expect(categoryOf('payment_failed')).toBe('payments');
    expect(categoryOf('membership_churned')).toBe('memberships');
    expect(categoryOf('something_new')).toBe('other');
  });

  it('formats money to the cent and falls back on a bad currency code', () => {
    expect(formatMoney(123_456)).toBe('$1,234.56');
    expect(formatMoney(5, 'XXXX')).toBe('$0.05');
  });

  it('formats signed percentages', () => {
    expect(formatPct(50.8)).toBe('+50.8%');
    expect(formatPct(-12)).toBe('-12%');
    expect(formatPct(null)).toBe('n/a');
  });
});
