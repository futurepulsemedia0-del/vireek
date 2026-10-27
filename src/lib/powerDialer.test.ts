import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FORM, DISPOSITIONS, MAX_IMPORT_ROWS, contactRate, dialerErrorMessage, dispositionByHotkey,
  nextCampaignStatuses, nextContactState, parseImportText, parseWrapUp, progressPercent, secondsUntil, validateCampaignForm,
  type Disposition,
} from './powerDialer';

const camp = { max_attempts: 3, retry_minutes: 240 };

describe('disposition rules (mirror of dialer_complete_attempt in SQL)', () => {
  const cases: [Disposition, number, ReturnType<typeof nextContactState>][] = [
    ['no_answer', 0, { status: 'pending', attempts: 1, retryInMinutes: 240 }],
    ['voicemail', 1, { status: 'pending', attempts: 2, retryInMinutes: 240 }],
    ['busy', 2, { status: 'done', attempts: 3, retryInMinutes: null }],
    ['failed', 0, { status: 'pending', attempts: 0, retryInMinutes: 15 }],
    ['failed', 2, { status: 'pending', attempts: 2, retryInMinutes: 15 }],
    ['callback_requested', 1, { status: 'pending', attempts: 1, retryInMinutes: null }],
    ['booked', 0, { status: 'done', attempts: 1, retryInMinutes: null }],
    ['interested', 0, { status: 'done', attempts: 1, retryInMinutes: null }],
    ['not_interested', 0, { status: 'done', attempts: 1, retryInMinutes: null }],
    ['wrong_number', 0, { status: 'done', attempts: 1, retryInMinutes: null }],
    ['do_not_call', 0, { status: 'dnc', attempts: 1, retryInMinutes: null }],
  ];
  it.each(cases)('%s from %i attempts', (d, n, expected) => expect(nextContactState(d, n, camp)).toEqual(expected));
  it('failed retry is capped by a short retry delay', () =>
    expect(nextContactState('failed', 0, { max_attempts: 3, retry_minutes: 5 }).retryInMinutes).toBe(5));
  it('throws on unknown dispositions', () => expect(() => nextContactState('x' as Disposition, 0, camp)).toThrow());
  it('every disposition has a unique hotkey and is reachable', () => {
    const keys = DISPOSITIONS.map((d) => d.hotkey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(dispositionByHotkey('1')?.key).toBe('booked');
    expect(dispositionByHotkey('z')).toBeUndefined();
  });
  it('only callback_requested needs a time', () =>
    expect(DISPOSITIONS.filter((d) => d.needsCallback).map((d) => d.key)).toEqual(['callback_requested']));
});

describe('validateCampaignForm', () => {
  const ok = { ...DEFAULT_FORM, name: 'Spring' };
  it('accepts defaults with a name', () => expect(validateCampaignForm(ok)).toBeNull());
  it.each([
    [{ name: '  ' }, /name/i],
    [{ wrap_up_seconds: 301 }, /wrap-up/i],
    [{ preview_seconds: -1 }, /preview/i],
    [{ max_attempts: 0 }, /attempts/i],
    [{ retry_minutes: 4 }, /retry/i],
    [{ max_calls_per_hour: 601 }, /per hour/i],
    [{ script: 'x'.repeat(4001) }, /script/i],
    [{ max_attempts: 2.5 }, /attempts/i],
  ])('rejects %j', (patch, re) => expect(validateCampaignForm({ ...ok, ...patch })).toMatch(re));
});

describe('parseImportText', () => {
  it('parses comma, tab and quoted rows and skips the header', () => {
    const { rows, skipped } = parseImportText('Name,Phone,Notes\nAnn Lee,555-201-0001,"likes email, not calls"\nBob\t(555) 201-0002\nbad line\n');
    expect(rows).toEqual([
      { name: 'Ann Lee', phone: '555-201-0001', notes: 'likes email, not calls' },
      { name: 'Bob', phone: '(555) 201-0002' },
    ]);
    expect(skipped).toBe(1);
  });
  it('handles windows line endings and blank lines', () =>
    expect(parseImportText('A,5552010001\r\n\r\nB,5552010002\r\n').rows).toHaveLength(2));
  it('caps at the server limit', () => {
    const text = Array.from({ length: MAX_IMPORT_ROWS + 2 }, (_, i) => `N${i},555${String(i).padStart(7, '0')}`).join('\n');
    const r = parseImportText(text);
    expect(r.rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(r.tooMany).toBe(true);
  });
});

describe('console helpers', () => {
  it('progress and contact rate', () => {
    expect(progressPercent({ total_contacts: 200, done: 40, dnc: 10 })).toBe(25);
    expect(progressPercent({ total_contacts: 0, done: 0, dnc: 0 })).toBe(0);
    expect(contactRate({ total_attempts: 50, booked: 5, interested: 5 })).toBe(20);
    expect(contactRate({ total_attempts: 0, booked: 0, interested: 0 })).toBe(0);
  });
  it('secondsUntil never goes negative', () => {
    expect(secondsUntil(10_500, 10_000)).toBe(1);
    expect(secondsUntil(5_000, 10_000)).toBe(0);
  });
  it('campaign status transitions', () => {
    expect(nextCampaignStatuses('draft')).toContain('active');
    expect(nextCampaignStatuses('active')).toContain('paused');
    expect(nextCampaignStatuses('archived')).toEqual(['paused']);
  });
  it('error mapping', () => {
    expect(dialerErrorMessage({ message: 'hourly_cap_reached' })).toMatch(/hourly/);
    expect(dialerErrorMessage({ code: '23505', message: 'dup' })).toMatch(/already exists/);
    expect(dialerErrorMessage({ message: '???' })).toMatch(/Something went wrong/);
  });
  it('parseWrapUp reads the remaining seconds', () => {
    expect(parseWrapUp({ message: 'wrap_up_active', details: '12' })).toBe(12);
    expect(parseWrapUp({ message: 'wrap_up_active', details: null })).toBe(1);
    expect(parseWrapUp({ message: 'other' })).toBeNull();
  });
});
