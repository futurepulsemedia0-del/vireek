import { describe, it, expect } from 'vitest';
import {
  buildCustomerPayload,
  buildDraftQuotePayload,
  buildScoreBreakdown,
  buildTimeline,
  formatDuration,
  getConversionState,
  isUuid,
  quoteTotalCents,
  resolveSource,
  type CallLike,
  type LeadLike,
  type QuoteLike,
  type TouchLike,
} from './leadDetail';

const lead: LeadLike = {
  id: '3f0c7e0e-6a55-4c0e-9d1b-0c2f6f6f0a11',
  name: '  Dana Whitfield ',
  phone: '+15551230000',
  email: '',
  service_interested: 'AC repair',
  notes: null,
  stage: 'new',
  customer_id: null,
  quote_amount: null,
  quote_sent_at: null,
  follow_up_count: 0,
  last_follow_up_at: null,
  created_at: '2026-10-01T10:00:00Z',
};

const call: CallLike = {
  id: 'c1',
  caller_name: 'Dana',
  call_datetime: '2026-10-01T09:55:00Z',
  duration_seconds: 125,
  summary: 'AC not cooling.',
  status: 'new_lead',
  is_voicemail: false,
  is_emergency: false,
  sentiment: 'neutral',
  lead_source: null,
  source_label: null,
};

const touch = (over: Partial<TouchLike>): TouchLike => ({
  id: 't1',
  source: 'google',
  medium: 'cpc',
  campaign: null,
  landing_page: null,
  referrer: null,
  is_first_touch: true,
  occurred_at: '2026-09-30T08:00:00Z',
  ...over,
});

const quote = (over: Partial<QuoteLike>): QuoteLike => ({
  id: 'q1',
  status: 'draft',
  line_items: [{ description: 'Repair', quantity: 2, unit_price_cents: 5000 }],
  tax_percent: 10,
  sent_at: null,
  responded_at: null,
  last_viewed_at: null,
  view_count: 0,
  created_at: '2026-10-02T10:00:00Z',
  ...over,
});

describe('isUuid', () => {
  it('accepts uuids and rejects junk / undefined', () => {
    expect(isUuid(lead.id)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe('buildScoreBreakdown', () => {
  it('explains known factors, sorts by points, and ignores non-numeric values', () => {
    const rows = buildScoreBreakdown({ recency: 15, stage_bonus: 25, bogus: 'x', calls: 20 });
    expect(rows.map((r) => r.key)).toEqual(['stage_bonus', 'calls', 'recency']);
    expect(rows[0].explanation).toContain('quote');
    expect(rows[1].explanation).toContain('2');
  });

  it('degrades gracefully for unknown and negative factors', () => {
    const [row] = buildScoreBreakdown({ engagement_penalty: -10 });
    expect(row.label).toBe('Engagement penalty');
    expect(row.explanation).toContain('Removes 10');
  });

  it('returns [] for null, arrays and primitives', () => {
    expect(buildScoreBreakdown(null)).toEqual([]);
    expect(buildScoreBreakdown([1, 2])).toEqual([]);
    expect(buildScoreBreakdown('x')).toEqual([]);
  });
});

describe('resolveSource', () => {
  it('prefers the owner-tagged channel and keeps the other evidence', () => {
    const r = resolveSource({ ...call, lead_source: 'referral' }, [touch({})]);
    expect(r.label).toBe('Referral');
    expect(r.provenance).toBe('owner_tagged');
    expect(r.evidence).toHaveLength(2);
  });

  it('falls back to the first marketing touch, then the call label, then unattributed', () => {
    expect(resolveSource(call, [touch({})]).label).toBe('google / cpc');
    expect(resolveSource({ ...call, source_label: 'Truck wrap' }, []).provenance).toBe('call_label');
    expect(resolveSource(null, [])).toEqual({ label: 'Unattributed', provenance: 'unknown', evidence: [] });
  });

  it('adds a last-touch entry only when it differs from the first', () => {
    const r = resolveSource(null, [touch({}), touch({ id: 't2', source: 'facebook', medium: 'social', is_first_touch: false, occurred_at: '2026-10-01T08:00:00Z' })]);
    expect(r.evidence.map((e) => e.kind)).toEqual(['first_touch', 'last_touch']);
  });
});

describe('buildTimeline', () => {
  it('merges sources newest-first and skips ledger events that already have a row', () => {
    const items = buildTimeline({
      lead: { ...lead, last_follow_up_at: '2026-10-03T10:00:00Z', follow_up_count: 2 },
      calls: [call],
      quotes: [quote({ status: 'accepted', sent_at: '2026-10-02T11:00:00Z', responded_at: '2026-10-02T12:00:00Z' })],
      jobs: [],
      history: [
        { id: 1, event_type: 'lead.created', occurred_at: lead.created_at, actor_type: 'system' },
        { id: 2, event_type: 'payment.received', occurred_at: '2026-10-05T10:00:00Z', actor_type: 'system' },
      ],
    });
    expect(items[0].title).toBe('Payment received');
    expect(items.filter((i) => i.title === 'Lead created')).toHaveLength(1);
    expect(items.some((i) => i.title === 'Quote accepted' && i.tone === 'positive')).toBe(true);
    const times = items.map((i) => new Date(i.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('marks missed calls negative and drops items with invalid dates', () => {
    const items = buildTimeline({
      lead,
      calls: [{ ...call, status: 'missed' }, { ...call, id: 'c2', call_datetime: 'garbage' }],
      quotes: [],
      jobs: [],
      history: [],
    });
    expect(items.find((i) => i.title === 'Missed call')?.tone).toBe('negative');
    expect(items.some((i) => i.id === 'call-c2')).toBe(false);
  });

  it('shows the legacy quote on the lead row only when no quote record was sent', () => {
    const legacy = { ...lead, quote_sent_at: '2026-10-02T10:00:00Z', quote_amount: 450 };
    const a = buildTimeline({ lead: legacy, calls: [], quotes: [], jobs: [], history: [] });
    expect(a.find((i) => i.id === 'lead-quote-sent')?.detail).toBe('$450.00');
    const b = buildTimeline({ lead: legacy, calls: [], quotes: [quote({ sent_at: '2026-10-02T10:00:00Z' })], jobs: [], history: [] });
    expect(b.some((i) => i.id === 'lead-quote-sent')).toBe(false);
  });
});

describe('conversion helpers', () => {
  it('builds trimmed, null-safe payloads scoped to the account owner', () => {
    const c = buildCustomerPayload(lead, 'owner-1');
    expect(c).toMatchObject({ user_id: 'owner-1', name: 'Dana Whitfield', email: null, source: 'lead' });
    const q = buildDraftQuotePayload(lead, 'owner-1');
    expect(q).toMatchObject({ user_id: 'owner-1', lead_id: lead.id, status: 'draft', customer_email: null });
    expect(q.line_items).toEqual([{ description: 'AC repair', quantity: 1, unit_price_cents: 0 }]);
    expect(buildDraftQuotePayload({ ...lead, service_interested: null }, 'o').line_items).toEqual([]);
  });

  it('computes quote totals with tax and reports conversion state', () => {
    expect(quoteTotalCents(quote({}))).toBe(11000);
    expect(getConversionState(lead, [], []).complete).toBe(false);
    const s = getConversionState({ ...lead, customer_id: 'cust' }, [quote({})], []);
    expect(s).toMatchObject({ customerLinked: true, hasDraftQuote: true, hasOpenQuote: true, complete: true });
  });

  it('formats durations', () => {
    expect(formatDuration(125)).toBe('2m 05s');
    expect(formatDuration(0)).toBeNull();
  });
});
