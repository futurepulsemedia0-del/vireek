// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));

import {
  coiStoragePath,
  complianceErrorMessage,
  daysLeft,
  evaluateCoi,
  expiryState,
  isCoiBlocking,
  parseMoneyToCents,
  validateCoiFile,
  validateCoverageInput,
  validateLicenseInput,
  type CoverageInput,
  type LicenseInput,
} from './vendorCompliance';

const NOW = new Date(2026, 10, 24, 12, 0, 0); // 24 Nov 2026, local noon

const row = (type: 'general_liability' | 'workers_comp', expires_on: string, status: 'pending' | 'verified' | 'rejected' = 'verified', each = 200_000_000) => ({
  coverage_type: type, status, expires_on, each_occurrence_cents: each,
});

describe('expiry maths', () => {
  it('counts whole days from local today', () => {
    expect(daysLeft('2026-11-24', NOW)).toBe(0);
    expect(daysLeft('2026-11-25', NOW)).toBe(1);
    expect(daysLeft('2026-11-23', NOW)).toBe(-1);
    expect(daysLeft(null, NOW)).toBeNull();
    expect(daysLeft('garbage', NOW)).toBeNull();
  });
  it('buckets expired / expiring / valid / none', () => {
    expect(expiryState('2026-11-23', NOW)).toBe('expired');
    expect(expiryState('2026-11-24', NOW)).toBe('expiring');
    expect(expiryState('2026-12-24', NOW)).toBe('expiring'); // exactly 30 days
    expect(expiryState('2026-12-25', NOW)).toBe('valid');
    expect(expiryState(null, NOW)).toBe('none');
  });
});

describe('evaluateCoi (mirrors vendor_coi_status)', () => {
  const req = ['general_liability', 'workers_comp'] as const;

  it('is ok only when every required line is verified and unexpired', () => {
    const out = evaluateCoi([...req], [row('general_liability', '2027-06-01'), row('workers_comp', '2027-06-01')], { now: NOW });
    expect(out.map((o) => o.state)).toEqual(['ok', 'ok']);
  });
  it('flags a missing line', () => {
    const out = evaluateCoi([...req], [row('general_liability', '2027-06-01')], { now: NOW });
    expect(out[1]).toMatchObject({ coverage_type: 'workers_comp', state: 'missing' });
  });
  it('flags an expired line, and honours grace days', () => {
    const rows = [row('general_liability', '2026-11-20'), row('workers_comp', '2027-06-01')];
    expect(evaluateCoi([...req], rows, { now: NOW })[0].state).toBe('expired');
    expect(evaluateCoi([...req], rows, { now: NOW, graceDays: 4 })[0].state).toBe('ok');
    expect(evaluateCoi([...req], rows, { now: NOW, graceDays: 3 })[0].state).toBe('expired');
  });
  it('treats an unverified line as pending, never ok', () => {
    const out = evaluateCoi([...req], [row('general_liability', '2027-06-01', 'pending'), row('workers_comp', '2027-06-01')], { now: NOW });
    expect(out[0].state).toBe('pending');
  });
  it('expired beats pending (an unverified, lapsed policy is still expired)', () => {
    expect(evaluateCoi(['general_liability'], [row('general_liability', '2026-01-01', 'pending')], { now: NOW })[0].state).toBe('expired');
  });
  it('ignores rejected rows entirely', () => {
    const out = evaluateCoi(['general_liability'], [row('general_liability', '2027-06-01', 'rejected')], { now: NOW });
    expect(out[0].state).toBe('missing');
  });
  it('a renewal supersedes the older policy', () => {
    const out = evaluateCoi(['general_liability'], [row('general_liability', '2026-01-01'), row('general_liability', '2027-09-01')], { now: NOW });
    expect(out[0]).toMatchObject({ state: 'ok', expires_on: '2027-09-01' });
  });
  it('enforces a GL minimum only when one is configured', () => {
    const rows = [row('general_liability', '2027-06-01', 'verified', 50_000_000)];
    expect(evaluateCoi(['general_liability'], rows, { now: NOW })[0].state).toBe('ok');
    expect(evaluateCoi(['general_liability'], rows, { now: NOW, minGlCents: 100_000_000 })[0].state).toBe('below_minimum');
    expect(evaluateCoi(['general_liability'], rows, { now: NOW, minGlCents: 50_000_000 })[0].state).toBe('ok');
  });
  it('returns nothing to check when no coverage is required', () => {
    expect(evaluateCoi([], [], { now: NOW })).toEqual([]);
  });
});

describe('isCoiBlocking', () => {
  it('never blocks when enforcement is off', () => {
    expect(isCoiBlocking('off', false, [{ state: 'expired' }])).toBe(false);
  });
  it('blocks on any non-ok line when enforcement is on', () => {
    expect(isCoiBlocking('block', false, [{ state: 'ok' }, { state: 'pending' }])).toBe(true);
    expect(isCoiBlocking('block', false, [{ state: 'ok' }])).toBe(false);
  });
  it('an exempt vendor is never blocked', () => {
    expect(isCoiBlocking('block', true, [{ state: 'missing' }])).toBe(false);
  });
});

describe('input validation', () => {
  const cov: CoverageInput = {
    coverage_type: 'general_liability', carrier: 'Acme Mutual', policy_number: 'GL-1', effective_on: '2026-01-01',
    expires_on: '2027-01-01', each_occurrence: '1,000,000', aggregate: '', notes: '',
  };
  it('accepts a good coverage and parses money', () => {
    expect(validateCoverageInput(cov)).toBeNull();
    expect(parseMoneyToCents('1,000,000')).toBe(100_000_000);
    expect(parseMoneyToCents('$12.5')).toBe(1250);
    expect(parseMoneyToCents('')).toBeNull();
    expect(parseMoneyToCents('abc')).toBeUndefined();
    expect(parseMoneyToCents('-5')).toBeUndefined();
  });
  it('rejects malformed coverage input', () => {
    expect(validateCoverageInput({ ...cov, expires_on: '' })).toMatch(/expiry/i);
    expect(validateCoverageInput({ ...cov, effective_on: '2028-01-01' })).toMatch(/expires before/i);
    expect(validateCoverageInput({ ...cov, each_occurrence: 'lots' })).toMatch(/number/i);
    expect(validateCoverageInput({ ...cov, notes: 'x'.repeat(1001) })).toMatch(/too long/i);
  });

  const lic: LicenseInput = {
    license_number: 'CGC-123456', jurisdiction: 'US-FL', status: 'active', expires_on: '2027-08-31',
    source_url: 'https://example.gov/lookup?id=1', holder_name: '', trade: '', notes: '',
  };
  it('accepts a good licence record', () => {
    expect(validateLicenseInput(lic, NOW)).toBeNull();
  });
  it('requires evidence for an active licence, but not for an adverse one', () => {
    expect(validateLicenseInput({ ...lic, source_url: '' }, NOW)).toMatch(/link/i);
    expect(validateLicenseInput({ ...lic, status: 'revoked', source_url: '' }, NOW)).toBeNull();
  });
  it('rejects bad state, number, expiry and non-https links', () => {
    expect(validateLicenseInput({ ...lic, jurisdiction: 'US-ZZ' }, NOW)).toMatch(/state/i);
    expect(validateLicenseInput({ ...lic, jurisdiction: 'FL' }, NOW)).toMatch(/state/i);
    expect(validateLicenseInput({ ...lic, license_number: '  ' }, NOW)).toMatch(/number/i);
    expect(validateLicenseInput({ ...lic, expires_on: '2099-01-01' }, NOW)).toMatch(/far/i);
    expect(validateLicenseInput({ ...lic, expires_on: 'soon' }, NOW)).toMatch(/valid date/i);
    expect(validateLicenseInput({ ...lic, source_url: 'http://example.gov' }, NOW)).toMatch(/https/i);
    expect(validateLicenseInput({ ...lic, source_url: 'javascript:alert(1)' }, NOW)).toMatch(/https/i);
  });
});

describe('files and paths', () => {
  it('only allows PDFs / images up to 10 MB', () => {
    expect(validateCoiFile({ type: 'application/pdf', size: 1000 })).toBeNull();
    expect(validateCoiFile({ type: 'application/zip', size: 1000 })).toMatch(/PDF/);
    expect(validateCoiFile({ type: 'image/png', size: 11 * 1024 * 1024 })).toMatch(/10 MB/);
    expect(validateCoiFile({ type: 'image/png', size: 0 })).toMatch(/empty/);
  });
  it('builds the {owner}/{vendor}/{file} path the RPC and storage policy require', () => {
    expect(coiStoragePath('o1', 'v1', 'application/pdf', 'u1')).toBe('o1/v1/u1.pdf');
    expect(coiStoragePath('o1', 'v1', 'image/jpeg', 'u1')).toBe('o1/v1/u1.jpg');
  });
});

describe('complianceErrorMessage', () => {
  it('maps known RPC errors and hides raw SQL', () => {
    expect(complianceErrorMessage(new Error('FORBIDDEN'), 'x')).toMatch(/owner, admin/);
    expect(complianceErrorMessage({ message: 'new row violates check constraint "vlc_x"' }, 'x')).toMatch(/not allowed/);
    expect(complianceErrorMessage(new Error('boom: select * from secrets'), 'fallback')).toBe('fallback');
  });
});
