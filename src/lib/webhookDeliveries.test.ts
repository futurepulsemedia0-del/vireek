import { describe, it, expect } from 'vitest';
import { applyFilter, canReplay, formatWhen, friendlyReplayError, statusLabel, summarize, toDelivery, toDeliveries, DELIVERY_COLUMNS } from './webhookDeliveries';

const row = (o: Record<string, unknown> = {}) => ({
  id: 'o1', endpoint_id: 'e1', delivery_id: 'd1', event_type: 'lead.created', status: 'dead', attempts: 8,
  next_attempt_at: null, last_status_code: 500, last_error: 'http_500', replay_count: 0,
  created_at: '2026-11-09T10:00:00Z', delivered_at: null, ...o,
});

describe('toDelivery', () => {
  it('maps a valid row', () => {
    expect(toDelivery(row())).toMatchObject({ id: 'o1', status: 'dead', attempts: 8, lastStatusCode: 500, replayCount: 0 });
  });
  it('rejects malformed rows without throwing', () => {
    expect(toDelivery(null)).toBeNull();
    expect(toDelivery('x')).toBeNull();
    expect(toDelivery(row({ status: 'weird' }))).toBeNull();
    expect(toDelivery(row({ id: '' }))).toBeNull();
    expect(toDeliveries(undefined)).toEqual([]);
    expect(toDeliveries([row(), { nope: 1 }])).toHaveLength(1);
  });
  it('never carries a payload field', () => {
    expect(Object.keys(toDelivery(row({ payload: { email: 'a@b.c' } }))!)).not.toContain('payload');
    expect(DELIVERY_COLUMNS).not.toMatch(/payload/);
  });
});

describe('replay rules', () => {
  it('only dead or delivered rows can be replayed', () => {
    expect(canReplay({ status: 'dead' })).toBe(true);
    expect(canReplay({ status: 'delivered' })).toBe(true);
    expect(canReplay({ status: 'pending' })).toBe(false);
    expect(canReplay({ status: 'delivering' })).toBe(false);
  });
  it('maps server errors to safe messages', () => {
    expect(friendlyReplayError(new Error('Not authorized'))).toMatch(/owners and security admins/);
    expect(friendlyReplayError({ message: 'Delivery not found or still in flight' })).toMatch(/no longer replayable/);
    expect(friendlyReplayError({ message: 'SELECT secret FROM x' })).toBe('Could not replay the delivery. Try again.');
  });
});

describe('list helpers', () => {
  const rows = toDeliveries([row({ id: 'a', status: 'dead' }), row({ id: 'b', status: 'pending' }), row({ id: 'c', status: 'delivering' }), row({ id: 'd', status: 'delivered' })]);
  it('summarises and filters', () => {
    expect(summarize(rows)).toEqual({ pending: 1, delivering: 1, delivered: 1, dead: 1 });
    expect(applyFilter(rows, 'all')).toHaveLength(4);
    expect(applyFilter(rows, 'dead').map((d) => d.id)).toEqual(['a']);
    expect(applyFilter(rows, 'pending').map((d) => d.id)).toEqual(['b', 'c']);
  });
  it('labels and formats', () => {
    expect(statusLabel('dead')).toBe('Dead letter');
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(formatWhen('2026-11-09T11:59:30Z', now)).toBe('just now');
    expect(formatWhen('2026-11-09T11:00:00Z', now)).toBe('1 h ago');
    expect(formatWhen(null, now)).toBe('—');
    expect(formatWhen('garbage', now)).toBe('—');
  });
});
