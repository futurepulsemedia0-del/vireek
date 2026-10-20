import { describe, expect, it } from 'vitest';
import {
  buildPhotoPath,
  enabledScopes,
  extractPortalToken,
  formatMoney,
  isOtp,
  scopeSummary,
  splitJobs,
  toE164,
  validatePhotoFile,
} from './format';
import type { HomeJob } from './types';

const job = (over: Partial<HomeJob>): HomeJob => ({
  id: 'j', service_type: 'AC', scheduled_datetime: null, completed_at: null, job_status: 'scheduled', reschedule_token: null, ...over,
});

describe('toE164', () => {
  it('normalises US numbers and rejects junk', () => {
    expect(toE164('(555) 123-4567')).toBe('+15551234567');
    expect(toE164('1 555 123 4567')).toBe('+15551234567');
    expect(toE164('+44 7700 900123')).toBe('+447700900123');
    expect(toE164('12345')).toBeNull();
    expect(toE164('')).toBeNull();
    expect(toE164('+0123456789')).toBeNull();
  });
});

describe('isOtp / extractPortalToken', () => {
  it('validates 6-digit codes', () => {
    expect(isOtp('123456')).toBe(true);
    expect(isOtp('12345')).toBe(false);
    expect(isOtp('12a456')).toBe(false);
  });
  it('pulls a uuid out of a link or bare token', () => {
    const t = '3f2b8c1e-9a4d-4e7b-8c55-1a2b3c4d5e6f';
    expect(extractPortalToken(`https://vireek.com/portal/${t}?x=1`)).toBe(t);
    expect(extractPortalToken(t.toUpperCase())).toBe(t);
    expect(extractPortalToken('https://vireek.com/portal/nope')).toBeNull();
  });
});

describe('splitJobs', () => {
  it('puts open jobs first by date and the rest in history', () => {
    const { upcoming, past } = splitJobs([
      job({ id: 'late', scheduled_datetime: '2030-02-01T10:00:00Z' }),
      job({ id: 'soon', scheduled_datetime: '2030-01-01T10:00:00Z' }),
      job({ id: 'done', job_status: 'completed' }),
      job({ id: 'x', job_status: 'cancelled' }),
    ]);
    expect(upcoming.map((j) => j.id)).toEqual(['soon', 'late']);
    expect(past.map((j) => j.id)).toEqual(['done', 'x']);
  });
});

describe('scopes', () => {
  it('summarises what is shared', () => {
    const none = { jobs: false, invoices: false, equipment: false, documents: false, health: false };
    expect(scopeSummary(none)).toBe('Nothing shared');
    expect(enabledScopes({ ...none, jobs: true, health: true })).toEqual(['jobs', 'health']);
  });
});

describe('photos', () => {
  it('validates type and size', () => {
    expect(validatePhotoFile({ type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(validatePhotoFile({ type: 'application/pdf', size: 1000 })).toMatch(/JPG/);
    expect(validatePhotoFile({ type: 'image/png', size: 11 * 1024 * 1024 })).toMatch(/10 MB/);
    expect(validatePhotoFile({ type: 'image/png', size: 0 })).toMatch(/empty/);
  });
  it('builds a path inside the user folder', () => {
    const p = buildPhotoPath('user-1', { type: 'image/webp' });
    expect(p).toMatch(/^user-1\/[0-9a-f-]{36}\.webp$/);
  });
});

describe('formatMoney', () => {
  it('formats cents and handles missing values', () => {
    expect(formatMoney(12345, 'USD')).toContain('123.45');
    expect(formatMoney(null)).toBe('—');
  });
});
