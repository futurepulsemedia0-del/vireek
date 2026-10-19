import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  defaultDraft, draftToRow, parseDollarsToCents, parseRecipients, rowToDraft, validateDraft,
} from '@/lib/moneyRecovered';

describe('parseRecipients', () => {
  it('splits on commas, semicolons and whitespace, lower-cases and de-duplicates', () => {
    expect(parseRecipients('A@x.com, b@x.com;\nA@X.com  c@x.com')).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(parseRecipients('')).toEqual([]);
  });
});

describe('validateDraft', () => {
  it('accepts the defaults', () => {
    expect(validateDraft(defaultDraft('UTC'))).toEqual({});
  });
  it('rejects a bad hour and time zone', () => {
    const e = validateDraft({ ...defaultDraft('Nope/Zone'), send_hour: '24' });
    expect(e.send_hour).toBeTruthy();
    expect(e.timezone).toBeTruthy();
    expect(validateDraft({ ...defaultDraft('UTC'), send_hour: '' }).send_hour).toBeTruthy();
    expect(validateDraft({ ...defaultDraft('UTC'), send_hour: '7.5' }).send_hour).toBeTruthy();
  });
  it('rejects invalid and too many extra recipients', () => {
    expect(validateDraft({ ...defaultDraft('UTC'), extra_recipients: 'ok@x.com, nope' }).extra_recipients).toContain('nope');
    const many = Array.from({ length: 11 }, (_, i) => `u${i}@x.com`).join(',');
    expect(validateDraft({ ...defaultDraft('UTC'), extra_recipients: many }).extra_recipients).toBeTruthy();
  });
  it('requires at least one recipient when sending is enabled', () => {
    const d = { ...defaultDraft('UTC'), enabled: true, include_owner: false, include_co_owners: false };
    expect(validateDraft(d).extra_recipients).toBeTruthy();
    expect(validateDraft({ ...d, extra_recipients: 'cfo@x.com' })).toEqual({});
  });
});

describe('settings mapping', () => {
  it('round-trips a draft through the database row shape', () => {
    const d = { ...defaultDraft('Europe/London'), enabled: true, send_hour: '6', extra_recipients: 'a@x.com, b@x.com' };
    const row = draftToRow('u1', d);
    expect(row).toEqual({ user_id: 'u1', enabled: true, send_hour: 6, timezone: 'Europe/London', include_owner: true, include_co_owners: true, extra_recipients: ['a@x.com', 'b@x.com'] });
    expect(rowToDraft(row)).toEqual({ ...d, extra_recipients: 'a@x.com, b@x.com' });
  });
  it('keeps an hour of 0 (midnight) instead of falling back to the default', () => {
    expect(rowToDraft({ send_hour: 0 }).send_hour).toBe('0');
  });
});

describe('parseDollarsToCents', () => {
  it('parses plain, formatted and cent amounts', () => {
    expect(parseDollarsToCents('12500')).toBe(1_250_000);
    expect(parseDollarsToCents('$12,500.50')).toBe(1_250_050);
    expect(parseDollarsToCents('0.1')).toBe(10);
  });
  it('rejects zero, negatives, junk and sub-cent precision', () => {
    for (const bad of ['', '0', '-5', 'abc', '1.234', '12e3', '1,2,3x']) expect(parseDollarsToCents(bad)).toBeNull();
    expect(parseDollarsToCents('9999999999999')).toBeNull();
  });
});
