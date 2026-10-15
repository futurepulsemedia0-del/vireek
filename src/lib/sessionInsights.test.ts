import { describe, it, expect } from 'vitest';
import {
  eventFlags,
  formatExpiry,
  formatRelativeTime,
  lastActiveIso,
  otherSessions,
  pendingAlerts,
  sortSessions,
  type LoginEventLike,
  type SessionLike,
} from './sessionInsights';

const NOW = new Date('2026-10-08T12:00:00Z').getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function session(id: string, over: Partial<SessionLike> = {}): SessionLike {
  return { id, created_at: ago(DAY), updated_at: ago(DAY), refreshed_at: null, not_after: null, user_agent: null, ip: null, ...over };
}

function event(id: string, over: Partial<LoginEventLike> = {}): LoginEventLike {
  return { id, device_label: 'Chrome on Mac', ip: null, is_new_device: false, is_new_ip: false, alerted: false, acknowledged_at: null, created_at: ago(HOUR), ...over };
}

describe('formatRelativeTime', () => {
  it('buckets elapsed time', () => {
    expect(formatRelativeTime(ago(10_000), NOW)).toBe('just now');
    expect(formatRelativeTime(ago(5 * MIN), NOW)).toBe('5 min ago');
    expect(formatRelativeTime(ago(3 * HOUR), NOW)).toBe('3 h ago');
    expect(formatRelativeTime(ago(2 * DAY), NOW)).toBe('2 d ago');
  });
  it('handles missing, invalid and future input without throwing', () => {
    expect(formatRelativeTime(null, NOW)).toBe('never');
    expect(formatRelativeTime('nonsense', NOW)).toBe('unknown');
    expect(formatRelativeTime(new Date(NOW + HOUR).toISOString(), NOW)).toBe('just now');
  });
  it('falls back to a calendar date after 30 days', () => {
    expect(formatRelativeTime(ago(45 * DAY), NOW)).toMatch(/\d{4}/);
  });
});

describe('formatExpiry', () => {
  it('describes remaining time', () => {
    expect(formatExpiry(new Date(NOW + 12 * DAY + HOUR).toISOString(), NOW)).toBe('Expires in 12 days');
    expect(formatExpiry(new Date(NOW + DAY + HOUR).toISOString(), NOW)).toBe('Expires in 1 day');
    expect(formatExpiry(new Date(NOW + 2 * HOUR).toISOString(), NOW)).toBe('Expires today');
    expect(formatExpiry(ago(HOUR), NOW)).toBe('Expired');
    expect(formatExpiry(null, NOW)).toBe('No expiry');
  });
});

describe('session ordering', () => {
  const a = session('a', { refreshed_at: ago(2 * HOUR) });
  const b = session('b', { refreshed_at: ago(5 * MIN) });
  const c = session('c', { updated_at: ago(3 * DAY) });

  it('puts the current session first, then most recently active', () => {
    expect(sortSessions([a, b, c], 'c').map((s) => s.id)).toEqual(['c', 'b', 'a']);
    expect(sortSessions([c, a, b], null).map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });
  it('does not mutate its input', () => {
    const input = [a, b, c];
    sortSessions(input, 'a');
    expect(input.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
  it('prefers refreshed_at for last activity', () => {
    expect(lastActiveIso(a)).toBe(a.refreshed_at);
    expect(lastActiveIso(c)).toBe(c.updated_at);
  });
  it('lists every session except the current one', () => {
    expect(otherSessions([a, b, c], 'b').map((s) => s.id)).toEqual(['a', 'c']);
    expect(otherSessions([a], 'a')).toHaveLength(0);
  });
});

describe('login alerts', () => {
  it('returns only unacknowledged alerts, newest first', () => {
    const events = [
      event('old', { alerted: true, created_at: ago(5 * HOUR) }),
      event('new', { alerted: true, created_at: ago(HOUR) }),
      event('done', { alerted: true, acknowledged_at: ago(MIN) }),
      event('quiet', { is_new_device: true, alerted: false }),
    ];
    expect(pendingAlerts(events).map((e) => e.id)).toEqual(['new', 'old']);
  });
  it('labels history rows', () => {
    expect(eventFlags({ is_new_device: true, is_new_ip: true })).toEqual(['New device', 'New network']);
    expect(eventFlags({ is_new_device: false, is_new_ip: true })).toEqual(['New network']);
    expect(eventFlags({ is_new_device: false, is_new_ip: false })).toEqual([]);
  });
});
