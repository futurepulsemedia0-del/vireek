import { describe, expect, it } from 'vitest';
import {
  buildFollowUpPlan,
  buildTimeline,
  canConvertToJob,
  canSchedulePlan,
  depositCentsFor,
  diffSnapshots,
  followUpDueState,
  formatSignedUsd,
  formatUsd,
  headlineTotalCents,
  parseSnapshot,
  parseWorkspace,
  validityState,
  type QuoteSnapshot,
  type QuoteWorkspace,
} from './quoteWorkspace';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const DAY = 86_400_000;

function snap(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return {
    customer_name: 'Dana Whitfield',
    customer_phone: '+15550100',
    customer_email: null,
    line_items: [{ description: 'Water heater install', quantity: 1, unit_price_cents: 120_000 }],
    options: [],
    recommended_option_id: null,
    tax_percent: 0,
    deposit_percent: 0,
    valid_until: null,
    presentation_note: null,
    ...overrides,
  };
}

function option(id: string, name: string, items: [string, number, number][], recommended = false) {
  return {
    id,
    tier: 'good',
    name,
    summary: '',
    warranty_label: null,
    recommended,
    line_items: items.map(([description, quantity, unit_price_cents]) => ({ description, quantity, unit_price_cents })),
  };
}

function workspace(overrides: Partial<QuoteWorkspace['quote']> = {}, rest: Partial<QuoteWorkspace> = {}): QuoteWorkspace {
  return {
    quote: {
      id: 'q1', user_id: 'owner-1', lead_id: null, customer_name: 'Dana Whitfield', customer_phone: null,
      customer_email: null, line_items: [], options: [], recommended_option_id: null, selected_option_id: null,
      accepted_total_cents: null, presentation_note: null, deposit_percent: 0, tax_percent: 0, status: 'sent',
      quote_token: 't', valid_until: null, sent_at: '2026-10-01T12:00:00.000Z', responded_at: null,
      first_viewed_at: null, last_viewed_at: null, view_count: 0,
      created_at: '2026-09-30T12:00:00.000Z', updated_at: '2026-10-01T12:00:00.000Z',
      ...overrides,
    },
    versions: [], events: [], followups: [], job: null, lead: null, ...rest,
  };
}

describe('parseWorkspace', () => {
  it('returns null for unusable payloads', () => {
    expect(parseWorkspace(null)).toBeNull();
    expect(parseWorkspace('nope')).toBeNull();
    expect(parseWorkspace({ quote: { id: 5 } })).toBeNull();
  });

  it('survives malformed jsonb without throwing', () => {
    const ws = parseWorkspace({
      quote: { id: 'q1', user_id: 'u1', status: 'weird', line_items: 'x', options: [null, 3, { id: 'o1' }], view_count: '4' },
      versions: [{ id: 'v1', version_number: 'abc' }, { id: 'v2', version_number: 2, snapshot: 'bad', total_cents: '1500' }],
      events: [{ id: 'e1', event_type: 'hacked' }, { id: 'e2', event_type: 'viewed', metadata: null }],
      followups: [{ id: 'f1', channel: 'pigeon' }],
      job: { nope: true },
      lead: [],
    });
    expect(ws).not.toBeNull();
    expect(ws?.quote.status).toBe('draft');
    expect(ws?.quote.line_items).toEqual([]);
    expect(ws?.quote.options).toHaveLength(1);
    expect(ws?.quote.view_count).toBe(4);
    expect(ws?.versions).toHaveLength(1);
    expect(ws?.versions[0].total_cents).toBe(1500);
    expect(ws?.events).toHaveLength(1);
    expect(ws?.followups).toHaveLength(0);
    expect(ws?.job).toBeNull();
    expect(ws?.lead).toBeNull();
  });

  it('orders versions newest first', () => {
    const ws = parseWorkspace({
      quote: { id: 'q1', user_id: 'u1' },
      versions: [
        { id: 'a', version_number: 1, snapshot: {} },
        { id: 'c', version_number: 3, snapshot: {} },
        { id: 'b', version_number: 2, snapshot: {} },
      ],
    });
    expect(ws?.versions.map((v) => v.version_number)).toEqual([3, 2, 1]);
  });
});

describe('money', () => {
  it('uses the recommended option for tiered quotes and rounds tax to cents', () => {
    const s = snap({
      tax_percent: 8.25,
      options: [option('a', 'Good', [['Patch', 1, 10_000]]), option('b', 'Better', [['Replace', 1, 12_345]], true)],
      recommended_option_id: 'b',
    });
    expect(headlineTotalCents(s)).toBe(12_345 + Math.round((12_345 * 8.25) / 100));
  });

  it('falls back to the first option when the recommended id is stale', () => {
    const s = snap({ options: [option('a', 'Good', [['Patch', 2, 5_000]])], recommended_option_id: 'gone' });
    expect(headlineTotalCents(s)).toBe(10_000);
  });

  it('clamps negative quantities and prices to zero, like the database does', () => {
    const s = parseSnapshot({ line_items: [{ description: 'x', quantity: -3, unit_price_cents: 500 }] });
    expect(headlineTotalCents(s)).toBe(0);
  });

  it('formats and signs amounts', () => {
    expect(formatUsd(123_456)).toBe('$1,234.56');
    expect(formatSignedUsd(-5_000)).toBe('\u2212$50.00');
    expect(formatSignedUsd(5_000)).toBe('+$50.00');
    expect(depositCentsFor(100_000, 25)).toBe(25_000);
    expect(depositCentsFor(100_000, 0)).toBe(0);
  });
});

describe('diffSnapshots — flat quotes', () => {
  it('reports no changes for identical snapshots', () => {
    const d = diffSnapshots(snap(), snap());
    expect(d.hasChanges).toBe(false);
    expect(d.totalDeltaCents).toBe(0);
  });

  it('detects a price change, an added item and a removed item with correct deltas', () => {
    const before = snap({
      line_items: [
        { description: 'Water heater install', quantity: 1, unit_price_cents: 120_000 },
        { description: 'Disposal fee', quantity: 1, unit_price_cents: 5_000 },
      ],
    });
    const after = snap({
      line_items: [
        { description: 'water heater  INSTALL', quantity: 1, unit_price_cents: 130_000 },
        { description: 'Permit', quantity: 1, unit_price_cents: 9_000 },
      ],
    });
    const d = diffSnapshots(before, after);
    const kinds = d.changes.map((c) => `${c.kind}:${c.label}`);
    expect(kinds).toContain('changed:water heater  INSTALL');
    expect(kinds).toContain('added:Permit');
    expect(kinds).toContain('removed:Disposal fee');
    expect(d.totalBeforeCents).toBe(125_000);
    expect(d.totalAfterCents).toBe(139_000);
    expect(d.totalDeltaCents).toBe(14_000);
    expect(d.changes.find((c) => c.kind === 'changed')?.deltaCents).toBe(10_000);
  });

  it('keeps duplicate descriptions apart instead of merging them', () => {
    const line = { description: 'Labour hour', quantity: 1, unit_price_cents: 9_000 };
    const d = diffSnapshots(snap({ line_items: [line] }), snap({ line_items: [line, line] }));
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0].kind).toBe('added');
  });

  it('reports term changes', () => {
    const d = diffSnapshots(snap({ tax_percent: 0 }), snap({ tax_percent: 7, valid_until: '2026-11-01' }));
    const labels = d.changes.map((c) => c.label);
    expect(labels).toContain('Tax rate');
    expect(labels).toContain('Valid until');
  });
});

describe('diffSnapshots — tiered quotes', () => {
  const good = option('a', 'Essential fix', [['Patch', 1, 20_000]]);
  const better = option('b', 'Full repair', [['Repair', 1, 50_000]], true);

  it('detects an edit inside one option and does not double-count mirrored flat items', () => {
    const before = snap({ options: [good, better], recommended_option_id: 'b', line_items: better.line_items });
    const edited = { ...better, line_items: [{ description: 'Repair', quantity: 1, unit_price_cents: 55_000 }] };
    const after = snap({ options: [good, edited], recommended_option_id: 'b', line_items: edited.line_items });
    const d = diffSnapshots(before, after);
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0].scope).toBe('Full repair');
    expect(d.totalDeltaCents).toBe(5_000);
  });

  it('detects options added, removed and a moved recommendation', () => {
    const best = option('c', 'Replacement', [['New unit', 1, 90_000]]);
    const before = snap({ options: [good, better], recommended_option_id: 'b' });
    const after = snap({ options: [better, best], recommended_option_id: 'c' });
    const labels = diffSnapshots(before, after).changes.map((c) => `${c.kind}:${c.label}`);
    expect(labels).toContain('added:Option added');
    expect(labels).toContain('removed:Option removed');
    expect(labels).toContain('changed:Recommended option');
  });

  it('flags a switch between single price and options', () => {
    const d = diffSnapshots(snap(), snap({ options: [good, better] }));
    expect(d.changes.some((c) => c.label === 'Estimate format')).toBe(true);
  });
});

describe('buildFollowUpPlan', () => {
  const base = { customerName: 'Dana Whitfield', validUntil: null as string | null, now: NOW };

  it('spaces touches 1, 3, 7 and 14 days after the send date', () => {
    const sentAt = new Date(NOW.getTime() - 0).toISOString();
    const plan = buildFollowUpPlan({ ...base, sentAt, viewCount: 0 });
    expect(plan.map((s) => s.channel)).toEqual(['sms', 'call', 'sms', 'call']);
    expect(plan.map((s) => Date.parse(s.due_at) - NOW.getTime())).toEqual([1 * DAY, 3 * DAY, 7 * DAY, 14 * DAY]);
  });

  it('adapts wording to whether the customer opened the estimate', () => {
    const sentAt = NOW.toISOString();
    const unopened = buildFollowUpPlan({ ...base, sentAt, viewCount: 0 })[0].message;
    const opened = buildFollowUpPlan({ ...base, sentAt, viewCount: 3 })[0].message;
    expect(unopened).toContain('reached you');
    expect(opened).toContain('questions');
    expect(opened).toContain('Dana');
  });

  it('compresses overdue steps to one per day instead of dumping them all on today', () => {
    const sentAt = new Date(NOW.getTime() - 10 * DAY).toISOString();
    const due = buildFollowUpPlan({ ...base, sentAt, viewCount: 1 }).map((s) => Date.parse(s.due_at));
    expect(due[0]).toBe(NOW.getTime());
    expect(due[1]).toBe(NOW.getTime() + DAY);
    expect(due[2]).toBe(NOW.getTime() + 2 * DAY);
    for (let i = 1; i < due.length; i++) expect(due[i]).toBeGreaterThan(due[i - 1]);
  });

  it('never schedules past the valid-until date', () => {
    const sentAt = NOW.toISOString();
    const plan = buildFollowUpPlan({ ...base, sentAt, viewCount: 0, validUntil: '2026-10-12' });
    expect(plan).toHaveLength(2);
  });

  it('returns nothing once the quote is past its valid-until date', () => {
    expect(buildFollowUpPlan({ ...base, sentAt: NOW.toISOString(), viewCount: 0, validUntil: '2026-10-01' })).toEqual([]);
  });

  it('copes with a missing send date', () => {
    expect(buildFollowUpPlan({ ...base, sentAt: null, viewCount: 0 })).toHaveLength(4);
  });
});

describe('followUpDueState', () => {
  it('classifies pending and closed steps', () => {
    expect(followUpDueState({ status: 'done', due_at: NOW.toISOString() }, NOW)).toBe('done');
    expect(followUpDueState({ status: 'pending', due_at: new Date(NOW.getTime() - 2 * DAY).toISOString() }, NOW)).toBe('overdue');
    expect(followUpDueState({ status: 'pending', due_at: new Date(NOW.getTime() + 2 * DAY).toISOString() }, NOW)).toBe('upcoming');
    expect(followUpDueState({ status: 'pending', due_at: NOW.toISOString() }, NOW)).toBe('today');
  });
});

describe('buildTimeline', () => {
  it('orders newest first, hides v1, and adds the answer for quotes that pre-date the event trail', () => {
    const ws = workspace(
      { status: 'accepted', responded_at: '2026-10-03T12:00:00.000Z' },
      {
        versions: [
          { id: 'v2', version_number: 2, snapshot: snap(), total_cents: 150_000, created_at: '2026-10-01T09:00:00.000Z' },
          { id: 'v1', version_number: 1, snapshot: snap(), total_cents: 120_000, created_at: '2026-09-30T12:00:00.000Z' },
        ],
        events: [{ id: 'e1', event_type: 'viewed', option_id: null, metadata: { first_view: true }, created_at: '2026-10-02T08:00:00.000Z' }],
      },
    );
    const items = buildTimeline(ws);
    expect(items.map((i) => i.id)).toEqual(['responded', 'e:e1', 'sent', 'v:v2', 'created']);
    expect(items[0].title).toBe('Customer accepted');
    expect(items.find((i) => i.id === 'e:e1')?.title).toBe('Customer opened the estimate');
  });

  it('does not duplicate the answer when an accept event exists, and names the chosen option', () => {
    const ws = workspace(
      { status: 'accepted', responded_at: '2026-10-03T12:00:00.000Z', options: [option('a', 'Full repair', [['Repair', 1, 50_000]])] },
      { events: [{ id: 'e9', event_type: 'accepted', option_id: 'a', metadata: { total_cents: 50_000 }, created_at: '2026-10-03T12:00:00.000Z' }] },
    );
    const answers = buildTimeline(ws).filter((i) => i.kind === 'accepted');
    expect(answers).toHaveLength(1);
    expect(answers[0].detail).toBe('Full repair \u00b7 $500.00');
  });

  it('includes completed follow-ups and the converted job', () => {
    const ws = workspace(
      { status: 'accepted' },
      {
        followups: [{ id: 'f1', step_number: 1, channel: 'call', due_at: '2026-10-02T00:00:00.000Z', status: 'done', suggested_message: null, outcome: 'Left voicemail', completed_at: '2026-10-02T10:00:00.000Z' }],
        job: { id: 'j1', job_status: 'scheduled', scheduled_datetime: null, created_at: '2026-10-04T10:00:00.000Z' },
      },
    );
    const titles = buildTimeline(ws).map((i) => i.title);
    expect(titles).toContain('Call follow-up done');
    expect(titles).toContain('Converted to a job');
  });
});

describe('state helpers', () => {
  it('only allows converting an accepted quote that has no job yet', () => {
    const job = { id: 'j', job_status: 'scheduled', scheduled_datetime: null, created_at: '' };
    expect(canConvertToJob({ status: 'accepted' }, null)).toBe(true);
    expect(canConvertToJob({ status: 'accepted' }, job)).toBe(false);
    expect(canConvertToJob({ status: 'sent' }, null)).toBe(false);
    expect(canConvertToJob({ status: 'declined' }, null)).toBe(false);
  });

  it('only schedules plans for sent quotes', () => {
    expect(canSchedulePlan({ status: 'sent' })).toBe(true);
    expect(canSchedulePlan({ status: 'draft' })).toBe(false);
    expect(canSchedulePlan({ status: 'accepted' })).toBe(false);
  });

  it('classifies validity', () => {
    expect(validityState(null, NOW)).toBe('none');
    expect(validityState('2026-10-01', NOW)).toBe('expired');
    expect(validityState('2026-10-09', NOW)).toBe('expiring_soon');
    expect(validityState('2026-12-01', NOW)).toBe('valid');
  });
});
