import { describe, expect, it } from 'vitest';
import {
  countByKind, defaultTimezone, detectDevice, filterPasses, passStatus, phoneLooksValid, timeAgo, walletLandingUrl,
  type WalletPassRow,
} from './walletPasses';

const row = (o: Partial<WalletPassRow>): WalletPassRow => ({
  id: 'p1', kind: 'appointment', subject_id: 's1', label: 'Jane Doe — AC repair', status: 'active', version: 1, share_token: 't',
  apple_devices: 0, google_synced: false, issued_via: 'dashboard', pending_push: false,
  last_changed_at: '2026-10-24T10:00:00Z', last_pushed_at: null, created_at: '2026-10-24T09:00:00Z', voided_at: null, ...o,
});

describe('passStatus', () => {
  it('voided wins over everything', () => expect(passStatus(row({ status: 'voided', apple_devices: 2, pending_push: true })).label).toBe('Voided'));
  it('shows updating while a push is pending', () => expect(passStatus(row({ pending_push: true, apple_devices: 1 })).label).toBe('Updating…'));
  it('in wallet once a device or Google object exists', () => {
    expect(passStatus(row({ apple_devices: 1 })).label).toBe('In wallet');
    expect(passStatus(row({ google_synced: true })).label).toBe('In wallet');
  });
  it('not added yet otherwise', () => expect(passStatus(row({})).label).toBe('Not added yet'));
});

describe('filtering & counts', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b', kind: 'membership', label: 'Bob' }), row({ id: 'c', label: 'Zed', status: 'voided' })];
  it('filters by kind and case-insensitive query', () => {
    expect(filterPasses(rows, 'appointment', '').map((r) => r.id)).toEqual(['a', 'c']);
    expect(filterPasses(rows, 'appointment', ' ZED ').map((r) => r.id)).toEqual(['c']);
  });
  it('counts only active passes', () => expect(countByKind(rows)).toMatchObject({ appointment: 1, membership: 1, gift_card: 0 }));
});

describe('device detection', () => {
  it('detects iPhone, iPadOS desktop UA, Android and others', () => {
    expect(detectDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('ios');
    expect(detectDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios');
    expect(detectDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('other');
    expect(detectDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('android');
    expect(detectDevice('Mozilla/5.0 (Windows NT 10.0)')).toBe('other');
  });
});

describe('helpers', () => {
  it('validates phone shapes loosely', () => {
    expect(phoneLooksValid('(555) 123-4567')).toBe(true);
    expect(phoneLooksValid('+44 20 7946 0958')).toBe(true);
    expect(phoneLooksValid('12345')).toBe(false);
  });
  it('builds landing URLs without double slashes', () => expect(walletLandingUrl('https://vireek.com/', 'abc')).toBe('https://vireek.com/w/abc'));
  it('formats relative time', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    expect(timeAgo(null, now)).toBe('never');
    expect(timeAgo('2026-10-24T11:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-10-24T11:30:00Z', now)).toBe('30 min ago');
    expect(timeAgo('2026-10-24T09:00:00Z', now)).toBe('3 h ago');
    expect(timeAgo('2026-10-21T12:00:00Z', now)).toBe('3 d ago');
  });
  it('always returns a usable timezone', () => expect(defaultTimezone().length).toBeGreaterThan(0));
});
