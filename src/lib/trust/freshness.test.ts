import { describe, expect, it } from 'vitest';
import { evaluateFreshness, relativeAge, shouldRefreshOnFocus, STALE_AFTER_MS, POLL_MS } from './freshness';

const base = { now: 1_000_000, online: true, visible: true } as const;

describe('evaluateFreshness', () => {
  it('live realtime is never stale by age and needs no refresh', () => {
    const d = evaluateFreshness({ ...base, lastUpdatedAt: base.now - 3_600_000, realtime: 'live' });
    expect(d).toMatchObject({ stale: false, action: 'none', reason: null });
  });
  it('disconnected realtime goes stale after 1 min and polls', () => {
    const d = evaluateFreshness({ ...base, lastUpdatedAt: base.now - 61_000, realtime: 'reconnecting' });
    expect(d).toMatchObject({ stale: true, reason: 'disconnected', action: 'refresh' });
    expect(evaluateFreshness({ ...base, lastUpdatedAt: base.now - (POLL_MS - 1), realtime: 'reconnecting' }).action).toBe('none');
  });
  it('no realtime: stale + refresh after 5 min', () => {
    expect(evaluateFreshness({ ...base, lastUpdatedAt: base.now - STALE_AFTER_MS - 1, realtime: 'none' })).toMatchObject({ stale: true, reason: 'old', action: 'refresh' });
    expect(evaluateFreshness({ ...base, lastUpdatedAt: base.now - 1000, realtime: 'none' }).stale).toBe(false);
  });
  it('offline is stale but never tries to refresh', () => {
    expect(evaluateFreshness({ ...base, online: false, lastUpdatedAt: base.now, realtime: 'live' })).toMatchObject({ stale: true, reason: 'offline', action: 'none' });
  });
  it('hidden tab never refreshes', () => {
    expect(evaluateFreshness({ ...base, visible: false, lastUpdatedAt: null, realtime: 'none' }).action).toBe('none');
  });
  it('never loaded => refresh', () => {
    expect(evaluateFreshness({ ...base, lastUpdatedAt: null, realtime: 'live' }).action).toBe('refresh');
  });
  it('clock skew (future timestamp) is not stale', () => {
    expect(evaluateFreshness({ ...base, lastUpdatedAt: base.now + 5000, realtime: 'none' }).stale).toBe(false);
  });
});

describe('focus + relative age', () => {
  it('refreshes on focus only without live realtime and after 30 s', () => {
    expect(shouldRefreshOnFocus(0, 31_000, 'none')).toBe(true);
    expect(shouldRefreshOnFocus(0, 29_000, 'none')).toBe(false);
    expect(shouldRefreshOnFocus(0, 999_999, 'live')).toBe(false);
  });
  it('formats ages', () => {
    const n = 10_000_000;
    expect(relativeAge(n - 3000, n).justNow).toBe(true);
    expect(relativeAge(n - 45_000, n)).toMatchObject({ value: -45, unit: 'second' });
    expect(relativeAge(n - 120_000, n)).toMatchObject({ value: -2, unit: 'minute' });
    expect(relativeAge(n - 3 * 3_600_000, n)).toMatchObject({ value: -3, unit: 'hour' });
    expect(relativeAge(n - 50 * 3_600_000, n)).toMatchObject({ value: -2, unit: 'day' });
  });
});
