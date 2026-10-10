import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  NOTE_EVENT_TYPE,
  NOTE_MAX_LENGTH,
  PHOTO_MAX_BYTES,
  buildActivityFeed,
  buildStatusTimeline,
  formatDuration,
  invoiceTotals,
  jobRevenueCents,
  nextStatus,
  primaryInvoice,
  relativeTime,
  resolveJobAccess,
  resolvePhotoUrl,
  summarizeCosts,
  summarizeRequiredParts,
  summarizeUsedParts,
  telHref,
  validateNote,
  validatePhotoFile,
} from './jobDetail';
import type { RequiredPartRow, UsedPartRow } from './jobDetail';
import type { ActivityEvent } from './activityLedger';

// ---------- access ----------

const perms = (over: Partial<{ can_view_all_jobs: boolean; can_view_billing: boolean }> = {}) => ({
  can_view_all_jobs: false,
  can_view_billing: false,
  ...over,
});

describe('resolveJobAccess', () => {
  const job = { assigned_technician_id: 'tech-1' };

  it('gives owners everything', () => {
    expect(resolveJobAccess({ isOwner: true, permissions: perms(), teamMemberId: null, job })).toEqual({
      canView: true,
      canEdit: true,
      canManage: true,
      canSeeBilling: true,
    });
  });

  it('lets an assigned technician work the job but not manage it or see billing', () => {
    expect(resolveJobAccess({ isOwner: false, permissions: perms(), teamMemberId: 'tech-1', job })).toEqual({
      canView: true,
      canEdit: true,
      canManage: false,
      canSeeBilling: false,
    });
  });

  it('blocks a technician from a job assigned to someone else', () => {
    const a = resolveJobAccess({ isOwner: false, permissions: perms({ can_view_billing: true }), teamMemberId: 'tech-2', job });
    expect(a.canView).toBe(false);
    expect(a.canEdit).toBe(false);
    // billing permission alone never opens a job the member cannot view
    expect(a.canSeeBilling).toBe(false);
  });

  it('treats can_view_all_jobs as dispatcher-level, and billing as a separate gate', () => {
    const dispatcher = resolveJobAccess({ isOwner: false, permissions: perms({ can_view_all_jobs: true }), teamMemberId: 'x', job });
    expect(dispatcher.canView && dispatcher.canManage).toBe(true);
    expect(dispatcher.canSeeBilling).toBe(false);
    const billing = resolveJobAccess({ isOwner: false, permissions: perms({ can_view_all_jobs: true, can_view_billing: true }), teamMemberId: 'x', job });
    expect(billing.canSeeBilling).toBe(true);
  });

  it('never grants access to an unassigned job to a member with no id', () => {
    expect(resolveJobAccess({ isOwner: false, permissions: perms(), teamMemberId: null, job: { assigned_technician_id: null } }).canView).toBe(false);
  });
});

// ---------- status ----------

describe('nextStatus / buildStatusTimeline', () => {
  it('walks the happy path and stops at the end', () => {
    expect(nextStatus('scheduled')).toBe('en_route');
    expect(nextStatus('en_route')).toBe('in_progress');
    expect(nextStatus('in_progress')).toBe('completed');
    expect(nextStatus('completed')).toBeNull();
    expect(nextStatus('cancelled')).toBeNull();
    expect(nextStatus('no_show')).toBeNull();
  });

  const base = { created_at: '2026-10-01T09:00:00Z', eta_set_at: '2026-10-02T08:00:00Z', completed_at: '2026-10-02T12:00:00Z' };

  it('marks earlier steps done and the current one current', () => {
    const t = buildStatusTimeline({ ...base, job_status: 'in_progress' });
    expect(t.terminal).toBeNull();
    expect(t.steps.map((s) => s.state)).toEqual(['done', 'done', 'current', 'upcoming']);
    expect(t.steps[0].at).toBe(base.created_at);
    expect(t.steps[1].at).toBe(base.eta_set_at);
    expect(t.steps[3].at).toBeNull();
  });

  it('shows a completed job as fully done with its completion time', () => {
    const t = buildStatusTimeline({ ...base, job_status: 'completed' });
    expect(t.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(t.steps[3].at).toBe(base.completed_at);
  });

  it('does not invent timestamps for steps the schema does not record', () => {
    const t = buildStatusTimeline({ ...base, job_status: 'scheduled' });
    expect(t.steps.map((s) => s.state)).toEqual(['current', 'upcoming', 'upcoming', 'upcoming']);
    expect(t.steps[1].at).toBeNull();
    expect(t.steps[2].at).toBeNull();
  });

  it('handles cancelled / no-show as terminal without progress', () => {
    const c = buildStatusTimeline({ ...base, job_status: 'cancelled' });
    expect(c.terminal).toBe('cancelled');
    expect(c.steps.map((s) => s.state)).toEqual(['done', 'upcoming', 'upcoming', 'upcoming']);
    expect(c.steps[3].at).toBeNull();
    expect(buildStatusTimeline({ ...base, job_status: 'no_show' }).terminal).toBe('no_show');
  });
});

// ---------- activity feed ----------

let nextId = 1;
function ev(over: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: nextId++,
    user_id: 'owner',
    aggregate_type: 'job',
    aggregate_id: 'job-1',
    aggregate_version: 1,
    event_type: 'job.created',
    event_data: {},
    actor_id: null,
    actor_type: 'system',
    correlation_id: null,
    causation_id: null,
    metadata: {},
    occurred_at: '2026-10-01T09:00:00Z',
    ...over,
  };
}

const feedJob = {
  created_at: '2026-10-01T09:00:00Z',
  completed_at: null,
  rescheduled_by_customer_at: null,
  eta_set_at: null,
  eta_minutes: null,
  customer_signature_at: null,
  customer_signature_name: null,
};

describe('buildActivityFeed', () => {
  it('falls back to job facts when the ledger has nothing', () => {
    const feed = buildActivityFeed({ job: { ...feedJob, completed_at: '2026-10-02T12:00:00Z' }, invoices: [], events: [] });
    expect(feed.map((f) => f.id)).toEqual(['job:completed', 'job:created']);
  });

  it('lets ledger events replace the equivalent derived entries (no duplicates)', () => {
    const feed = buildActivityFeed({
      job: { ...feedJob, completed_at: '2026-10-02T12:00:00Z' },
      invoices: [],
      events: [
        ev({ event_type: 'job.created', occurred_at: '2026-10-01T09:00:01Z' }),
        ev({ event_type: 'job.completed', occurred_at: '2026-10-02T12:00:01Z' }),
      ],
    });
    expect(feed).toHaveLength(2);
    expect(feed.every((f) => f.id.startsWith('ev:'))).toBe(true);
    expect(feed[0].title).toBe('Job completed');
  });

  it('shows notes with their author and skips empty ones', () => {
    const feed = buildActivityFeed({
      job: feedJob,
      invoices: [],
      events: [
        ev({ event_type: NOTE_EVENT_TYPE, event_data: { text: '  Gate code 4411  ', author: 'Sam' }, actor_type: 'user', occurred_at: '2026-10-01T10:00:00Z' }),
        ev({ event_type: NOTE_EVENT_TYPE, event_data: { text: '   ' }, occurred_at: '2026-10-01T11:00:00Z' }),
        ev({ event_type: NOTE_EVENT_TYPE, event_data: { author: 'Sam' }, occurred_at: '2026-10-01T12:00:00Z' }),
      ],
    });
    const notes = feed.filter((f) => f.kind === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ detail: 'Gate code 4411', actor: 'Sam' });
  });

  it('adds invoice milestones and customer actions', () => {
    const feed = buildActivityFeed({
      job: { ...feedJob, customer_signature_at: '2026-10-02T13:00:00Z', customer_signature_name: 'Dana', eta_set_at: '2026-10-02T07:00:00Z', eta_minutes: 25 },
      invoices: [
        { id: 'i1', invoice_number: 'INV-0007', sent_at: '2026-10-03T09:00:00Z', viewed_at: '2026-10-03T10:00:00Z', paid_at: '2026-10-04T10:00:00Z', payment_method: 'card' },
      ],
      events: [],
    });
    expect(feed.map((f) => f.kind)).toEqual(['invoice_paid', 'invoice_viewed', 'invoice_sent', 'signed', 'eta', 'created']);
    expect(feed[0]).toMatchObject({ title: 'INV-0007 paid', detail: 'via card' });
    expect(feed.find((f) => f.kind === 'eta')?.detail).toBe('Arriving in about 25 min');
  });

  it('collapses duplicate event ids and ignores invalid timestamps', () => {
    const e = ev({ event_type: NOTE_EVENT_TYPE, event_data: { text: 'hi' }, occurred_at: '2026-10-01T10:00:00Z' });
    const feed = buildActivityFeed({
      job: feedJob,
      invoices: [{ id: 'i', invoice_number: null, sent_at: 'not a date', viewed_at: null, paid_at: null, payment_method: null }],
      events: [e, e],
    });
    expect(feed.filter((f) => f.kind === 'note')).toHaveLength(1);
    expect(feed.some((f) => f.kind === 'invoice_sent')).toBe(false);
  });

  it('sorts newest first and is stable for identical timestamps', () => {
    const t = '2026-10-05T10:00:00Z';
    const a = ev({ event_type: NOTE_EVENT_TYPE, event_data: { text: 'a' }, occurred_at: t });
    const b = ev({ event_type: NOTE_EVENT_TYPE, event_data: { text: 'b' }, occurred_at: t });
    const first = buildActivityFeed({ job: feedJob, invoices: [], events: [a, b] });
    const second = buildActivityFeed({ job: feedJob, invoices: [], events: [b, a] });
    expect(first.map((f) => f.id)).toEqual(second.map((f) => f.id));
    expect(first[first.length - 1].id).toBe('job:created');
  });
});

describe('validateNote', () => {
  it('rejects blank and oversized notes', () => {
    expect(validateNote('   ')).not.toBeNull();
    expect(validateNote('x'.repeat(NOTE_MAX_LENGTH + 1))).not.toBeNull();
    expect(validateNote('x'.repeat(NOTE_MAX_LENGTH))).toBeNull();
    expect(validateNote('Left key with neighbour')).toBeNull();
  });
});

// ---------- money ----------

const inv = (over: Record<string, unknown> = {}) => ({
  status: 'sent' as const,
  created_at: '2026-10-01T00:00:00Z',
  tax_percent: 10,
  line_items: [{ description: 'Labor', quantity: 2, unit_price_cents: 10000 }],
  ...over,
});

describe('jobRevenueCents / invoiceTotals / primaryInvoice', () => {
  it('computes invoice totals with tax', () => {
    expect(invoiceTotals(inv())).toEqual({ subtotalCents: 20000, taxCents: 2000, totalCents: 22000 });
  });

  it('uses live invoices, ignores void ones, sums multiple', () => {
    const j = { invoice_amount: 999 };
    expect(jobRevenueCents(j, [inv(), inv({ status: 'void' }), inv({ line_items: [{ description: 'x', quantity: 1, unit_price_cents: 5000 }], tax_percent: 0 })])).toBe(27000);
  });

  it('falls back to the quick invoice amount when there is no live invoice', () => {
    expect(jobRevenueCents({ invoice_amount: 123.45 }, [])).toBe(12345);
    expect(jobRevenueCents({ invoice_amount: 50 }, [inv({ status: 'void' })])).toBe(5000);
    expect(jobRevenueCents({ invoice_amount: null }, [])).toBe(0);
    expect(jobRevenueCents({ invoice_amount: -5 }, [])).toBe(0);
  });

  it('features the newest live invoice, else the newest overall', () => {
    const old = inv({ created_at: '2026-09-01T00:00:00Z' });
    const newer = inv({ created_at: '2026-10-05T00:00:00Z' });
    const voidNewest = inv({ created_at: '2026-10-09T00:00:00Z', status: 'void' });
    expect(primaryInvoice([old, voidNewest, newer])).toBe(newer);
    expect(primaryInvoice([voidNewest])).toBe(voidNewest);
    expect(primaryInvoice([])).toBeNull();
  });
});

describe('summarizeCosts', () => {
  const entries = [
    { category: 'labor' as const, total_cost_cents: 30000 },
    { category: 'material' as const, total_cost_cents: 15000 },
    { category: 'labor' as const, total_cost_cents: 5000 },
  ];

  it('groups by category, largest first, with shares', () => {
    const s = summarizeCosts(entries, 100000);
    expect(s.rows.map((r) => [r.category, r.totalCents, r.count])).toEqual([
      ['labor', 35000, 2],
      ['material', 15000, 1],
    ]);
    expect(s.rows[0].share).toBeCloseTo(0.7, 5);
    expect(s.totalCostCents).toBe(50000);
  });

  it('computes profit and margin', () => {
    const s = summarizeCosts(entries, 100000);
    expect(s.grossProfitCents).toBe(50000);
    expect(s.marginPct).toBeCloseTo(50, 5);
  });

  it('reports a loss as a negative margin and unknown margin without revenue', () => {
    expect(summarizeCosts(entries, 25000).marginPct).toBeCloseTo(-100, 5);
    const none = summarizeCosts(entries, 0);
    expect(none.marginPct).toBeNull();
    expect(none.grossProfitCents).toBe(-50000);
  });

  it('copes with no entries and bad numbers', () => {
    const empty = summarizeCosts([], 1000);
    expect(empty.rows).toEqual([]);
    expect(empty.marginPct).toBeCloseTo(100, 5);
    expect(summarizeCosts([{ category: 'other', total_cost_cents: Number.NaN }], 0).totalCostCents).toBe(0);
  });
});

// ---------- parts ----------

const req = (over: Partial<RequiredPartRow>): RequiredPartRow => ({
  requirement_id: 'r',
  part_id: 'p',
  part_name: 'Capacitor',
  quantity_required: 1,
  status: 'needed',
  readiness_status: 'ready',
  source_location_name: 'Van 3',
  shortage_quantity: 0,
  ...over,
});

describe('summarizeRequiredParts', () => {
  it('counts installed, backordered and at-risk parts', () => {
    const s = summarizeRequiredParts([
      req({ status: 'installed', readiness_status: 'short' }), // already installed: not at risk
      req({ readiness_status: 'ready' }),
      req({ readiness_status: 'short', shortage_quantity: 2 }),
      req({ readiness_status: 'no_location' }),
      req({ status: 'backordered', readiness_status: 'ready' }),
    ]);
    expect(s).toEqual({ total: 5, installed: 1, backordered: 1, atRisk: 3 });
  });

  it('handles an empty list', () => {
    expect(summarizeRequiredParts([])).toEqual({ total: 0, installed: 0, backordered: 0, atRisk: 0 });
  });
});

const used = (over: Partial<UsedPartRow>): UsedPartRow => ({
  id: 'u',
  part_id: 'p1',
  part_name: 'Contactor',
  part_number: 'C-24',
  transaction_type: 'usage',
  quantity_delta: -1,
  unit_cost_cents: 2000,
  location_name: 'Van 3',
  created_at: '2026-10-02T10:00:00Z',
  ...over,
});

describe('summarizeUsedParts', () => {
  it('nets usage against returns per part and drops fully-returned parts', () => {
    const out = summarizeUsedParts([
      used({ quantity_delta: -3 }),
      used({ transaction_type: 'return', quantity_delta: 1 }),
      used({ part_id: 'p2', part_name: 'Fuse', quantity_delta: -2, unit_cost_cents: null }),
      used({ part_id: 'p3', part_name: 'Relay', quantity_delta: -1 }),
      used({ part_id: 'p3', part_name: 'Relay', transaction_type: 'return', quantity_delta: 1 }),
    ]);
    expect(out.map((p) => [p.part_name, p.quantity, p.costCents])).toEqual([
      ['Contactor', 2, 4000],
      ['Fuse', 2, 0],
    ]);
  });
});

// ---------- photos ----------

describe('photos', () => {
  it('validates type and size against the bucket rules', () => {
    expect(validatePhotoFile({ type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(validatePhotoFile({ type: 'image/heic', size: PHOTO_MAX_BYTES })).toBeNull();
    expect(validatePhotoFile({ type: 'application/pdf', size: 1000 })).not.toBeNull();
    expect(validatePhotoFile({ type: 'image/png', size: PHOTO_MAX_BYTES + 1 })).not.toBeNull();
    expect(validatePhotoFile({ type: 'image/png', size: 0 })).not.toBeNull();
  });

  it('resolves bucket paths but leaves absolute URLs alone', () => {
    const publicUrlFor = (p: string) => `https://cdn.test/job-room-photos/${p}`;
    expect(resolvePhotoUrl('u1/a.jpg', publicUrlFor)).toBe('https://cdn.test/job-room-photos/u1/a.jpg');
    expect(resolvePhotoUrl('https://x.test/a.jpg', publicUrlFor)).toBe('https://x.test/a.jpg');
  });
});

// ---------- formatters ----------

describe('formatters', () => {
  it('formats durations', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(120)).toBe('2 h');
    expect(formatDuration(135)).toBe('2 h 15 min');
  });

  it('formats relative times', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    expect(relativeTime('2026-10-10T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-10-10T11:30:00Z', now)).toBe('30 min ago');
    expect(relativeTime('2026-10-10T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-10-08T12:00:00Z', now)).toBe('2 d ago');
    expect(relativeTime('garbage', now)).toBe('');
  });

  it('builds safe tel links', () => {
    expect(telHref('+1 (555) 010-2030')).toBe('tel:+15550102030');
  });
});
