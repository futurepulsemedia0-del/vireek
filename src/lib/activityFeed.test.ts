import { describe, expect, it } from 'vitest';
import { bannerItems, csvCell, filterActivity, fromLoginEvent, fromSecurityEvent, mergeActivity, toCsv, type ActivityItem } from './activityFeed';

const NOW = Date.parse('2027-04-10T12:00:00Z');
const se = (over: Partial<Parameters<typeof fromSecurityEvent>[0]> = {}) =>
  fromSecurityEvent({ id: '1', event: 'password_changed', occurred_at: '2027-04-09T12:00:00Z', meta: null, acknowledged_at: null, ...over });

describe('mapping', () => {
  it('maps security + login rows and drops unknown events', () => {
    expect(se()?.kind).toBe('password_changed');
    expect(se({ event: 'weird' })).toBeNull();
    expect(se({ event: 'sign_in' })).toBeNull();
    expect(fromLoginEvent({ id: 'a', device_label: 'Chrome on Mac', is_new_device: true, created_at: '2027-04-09T00:00:00Z' }).kind).toBe('sign_in_new_device');
    expect(fromLoginEvent({ id: 'b', device_label: null, is_new_device: null, created_at: '2027-04-09T00:00:00Z' }).kind).toBe('sign_in');
  });
  it('keeps only whitelisted, sanitised details', () => {
    const i = se({ event: 'api_key_created', meta: { key_name: 'Zap\r\nier', secret: 'nope', factor_type: 'totp' } });
    expect(i?.details).toEqual({ key: 'Zap ier', factor: 'totp' });
    expect(JSON.stringify(i)).not.toContain('nope');
  });
});

describe('merge / filter / banner', () => {
  const a = se({ id: 'a', occurred_at: '2027-04-09T00:00:00Z' }) as ActivityItem;
  const b = fromLoginEvent({ id: 'b', device_label: 'X', is_new_device: false, created_at: '2027-04-10T00:00:00Z' });
  const old = se({ id: 'c', event: 'api_key_revoked', occurred_at: '2026-01-01T00:00:00Z' }) as ActivityItem;
  it('sorts newest first, de-duplicates and drops bad dates', () => {
    const bad: ActivityItem = { ...a, id: 'bad', at: 'garbage' };
    expect(mergeActivity([a, old], [b, a, bad]).map((i) => i.id)).toEqual(['le:b', 'se:a', 'se:c']);
  });
  it('filters by category and period', () => {
    const all = mergeActivity([a, old], [b]);
    expect(filterActivity(all, { category: 'signIn', rangeDays: 30 }, NOW).map((i) => i.id)).toEqual(['le:b']);
    expect(filterActivity(all, { category: 'all', rangeDays: 30 }, NOW)).toHaveLength(2);
    expect(filterActivity(all, { category: 'apiKeys', rangeDays: 'all' }, NOW).map((i) => i.id)).toEqual(['se:c']);
  });
  it('banner only for unacknowledged, banner-worthy, recent events', () => {
    expect(bannerItems([a], NOW)).toHaveLength(1);
    expect(bannerItems([{ ...a, acknowledged: true }], NOW)).toHaveLength(0);
    expect(bannerItems([old], NOW)).toHaveLength(0);
    expect(bannerItems([{ ...a, kind: 'mfa_enrolled' }], NOW)).toHaveLength(0);
  });
});

describe('CSV', () => {
  it('neutralises formula injection and quotes correctly', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@a')).toBe("'@a");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('plain')).toBe('plain');
  });
  it('writes header + rows with CRLF', () => {
    const csv = toCsv([se({ event: 'api_key_created', meta: { key_name: '=evil()' } }) as ActivityItem], (k) => k, { time: 'T', event: 'E', details: 'D' });
    expect(csv).toBe("T,E,D\r\n2027-04-09 12:00:00,api_key_created,'=evil()\r\n");
  });
});
