import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), auth: { getUser: vi.fn() } } }));

import {
  DELETION_GRACE_DAYS,
  buildTimeline,
  daysFromNow,
  parseCase,
  parseOverview,
  pct,
  validateSettings,
  type OffboardingCase,
} from './offboarding';

const NOW = new Date('2029-03-10T12:00:00.000Z');

const base: OffboardingCase = {
  id: 'c1',
  status: 'scheduled',
  reason: 'too_expensive',
  accessEndsAt: '2029-03-31T00:00:00.000Z',
  exportStartedAt: null,
  winbackAvailable: true,
  winbackOptedIn: false,
  winbackMessages: [],
  deletion: null,
};

describe('parseCase', () => {
  it('returns null for junk or an unknown status', () => {
    expect(parseCase(null)).toBeNull();
    expect(parseCase({})).toBeNull();
    expect(parseCase({ id: 'x', status: 'weird' })).toBeNull();
  });
  it('parses a full payload and drops invalid nested rows', () => {
    const c = parseCase({
      id: 'c1',
      status: 'ended',
      reason: 'switching',
      access_ends_at: '2029-03-31T00:00:00Z',
      export_started_at: 'not a date',
      winback_available: true,
      winback_opted_in: true,
      winback_messages: [{ seq: 1, status: 'sent', scheduled_for: '2029-04-07T00:00:00Z' }, { seq: 3, status: 'x' }],
      deletion: { id: 'd1', status: 'grace_period', scheduled_for: '2029-04-14T00:00:00Z' },
    });
    expect(c?.status).toBe('ended');
    expect(c?.exportStartedAt).toBeNull();
    expect(c?.winbackMessages).toHaveLength(1);
    expect(c?.deletion).toEqual({ id: 'd1', status: 'grace_period', scheduledFor: '2029-04-14T00:00:00Z' });
  });
  it('ignores a deletion block with an unknown status', () => {
    expect(parseCase({ id: 'c1', status: 'scheduled', deletion: { id: 'd', status: 'cancelled' } })?.deletion).toBeNull();
  });
});

describe('buildTimeline', () => {
  it('before access ends: access is the current step, export is to do, deletion is "none"', () => {
    const s = buildTimeline(base, NOW);
    expect(s.map((x) => x.key)).toEqual(['cancellation', 'accessEnd', 'export', 'deletion']);
    expect(s[1]).toMatchObject({ state: 'current', variant: 'upcoming' });
    expect(s[2]).toMatchObject({ state: 'current', variant: 'todo' });
    expect(s[3]).toMatchObject({ state: 'upcoming', variant: 'none', date: null });
  });
  it('after access ends without an export: export needs attention', () => {
    const s = buildTimeline({ ...base, status: 'ended' }, NOW);
    expect(s[1]).toMatchObject({ state: 'done', variant: 'ended' });
    expect(s[2]).toMatchObject({ state: 'attention', variant: 'todo' });
  });
  it('a started export is done', () => {
    expect(buildTimeline({ ...base, exportStartedAt: '2029-03-11T00:00:00Z' }, NOW)[2]).toMatchObject({ state: 'done', variant: 'started' });
  });
  it('treats a passed access date as ended even before the hourly reconcile ran', () => {
    expect(buildTimeline({ ...base, accessEndsAt: '2029-03-01T00:00:00Z' }, NOW)[1].variant).toBe('ended');
  });
  it('maps every deletion status honestly (never invents a purge date)', () => {
    const d = (status: 'grace_period' | 'processing' | 'blocked_legal_hold' | 'completed') =>
      buildTimeline({ ...base, deletion: { id: 'd', status, scheduledFor: '2029-04-14T00:00:00Z' } }, NOW)[3];
    expect(d('grace_period')).toMatchObject({ state: 'current', variant: 'grace', date: '2029-04-14T00:00:00Z' });
    expect(d('processing')).toMatchObject({ state: 'current', variant: 'processing', date: null });
    expect(d('blocked_legal_hold')).toMatchObject({ state: 'attention', variant: 'blocked' });
    expect(d('completed')).toMatchObject({ state: 'done', variant: 'completed' });
  });
});

describe('helpers', () => {
  it('daysFromNow rounds up and tolerates bad input', () => {
    expect(daysFromNow('2029-03-31T00:00:00Z', NOW)).toBe(21);
    expect(daysFromNow(null, NOW)).toBeNull();
    expect(daysFromNow('garbage', NOW)).toBeNull();
  });
  it('mirrors the database grace period', () => {
    expect(DELETION_GRACE_DAYS).toBe(14);
  });
  it('pct never returns NaN', () => {
    expect(pct(1, 0)).toBe(0);
    expect(pct(1, 3)).toBe(33);
  });
});

describe('staff overview', () => {
  it('parses a sparse payload with safe defaults', () => {
    const o = parseOverview({ funnel: { cases: '5', opted_in: 2 }, reasons: [{ reason: 'other', cases: 3 }], settings: {} });
    expect(o.funnel.cases).toBe(5);
    expect(o.funnel.optedIn).toBe(2);
    expect(o.funnel.sent1).toBe(0);
    expect(o.settings).toEqual({ winbackEnabled: false, firstMessageDelayDays: 7, secondMessageGapDays: 30, attributionDays: 30 });
    expect(o.reasons[0]).toMatchObject({ reason: 'other', cases: 3, reactivated: 0 });
  });
  it('validates settings against the database ranges', () => {
    const ok = { winbackEnabled: true, firstMessageDelayDays: 7, secondMessageGapDays: 30, attributionDays: 30 };
    expect(validateSettings(ok)).toBeNull();
    expect(validateSettings({ ...ok, firstMessageDelayDays: 0 })).toBe('firstDelay');
    expect(validateSettings({ ...ok, secondMessageGapDays: 3 })).toBe('gap');
    expect(validateSettings({ ...ok, attributionDays: 91 })).toBe('attribution');
    expect(validateSettings({ ...ok, attributionDays: 1.5 })).toBe('attribution');
  });
});
