import { describe, expect, it } from 'vitest';
import {
  EMPTY_DSAR_FORM,
  formatDueDate,
  outcomeCopy,
  validateDsarForm,
  type DsarFormValues,
} from '@/lib/dsar';

const valid: DsarFormValues = {
  kind: 'access',
  email: 'jane@example.com',
  fullName: 'Jane Doe',
  relationship: 'account_holder',
  region: 'eu_uk',
  details: '',
  confirmed: true,
};

describe('validateDsarForm', () => {
  it('accepts a complete form', () => {
    expect(validateDsarForm(valid)).toEqual({});
  });

  it('flags every required field on an empty form', () => {
    expect(Object.keys(validateDsarForm(EMPTY_DSAR_FORM)).sort()).toEqual(
      ['confirmed', 'email', 'fullName', 'kind', 'relationship'],
    );
  });

  it('rejects malformed emails', () => {
    expect(validateDsarForm({ ...valid, email: 'jane@' }).email).toBeTruthy();
    expect(validateDsarForm({ ...valid, email: 'jane @example.com' }).email).toBeTruthy();
  });

  it('only requires details for corrections', () => {
    expect(validateDsarForm({ ...valid, kind: 'delete', details: '' }).details).toBeUndefined();
    expect(validateDsarForm({ ...valid, kind: 'correct', details: 'bad' }).details).toBeTruthy();
    expect(validateDsarForm({ ...valid, kind: 'correct', details: 'Wrong phone, should be 555-0100' }).details).toBeUndefined();
  });

  it('caps details length', () => {
    expect(validateDsarForm({ ...valid, details: 'x'.repeat(2001) }).details).toBeTruthy();
  });

  it('requires the ownership confirmation', () => {
    expect(validateDsarForm({ ...valid, confirmed: false }).confirmed).toBeTruthy();
  });
});

describe('display helpers', () => {
  it('formats due dates in UTC so the day never shifts by timezone', () => {
    expect(formatDueDate('2027-01-31T00:00:00.000Z')).toBe('January 31, 2027');
    expect(formatDueDate('not-a-date')).toBe('');
  });

  it('explains each outcome', () => {
    expect(outcomeCopy('deletion_scheduled', 'delete').body).toContain('14-day grace period');
    expect(outcomeCopy('deletion_blocked', 'delete').title).toMatch(/manual/i);
    expect(outcomeCopy('queued', 'access').body).toContain('data copy');
  });
});
