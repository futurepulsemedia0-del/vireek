import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  commonTimeZones, defaultDraft, draftToRow, formatMoney, formatPct, parseRecipients, rowToDraft, validateDraft,
} from './executiveReport';

describe('parseRecipients', () => {
  it('splits on commas, spaces, semicolons and newlines, dedupes and lowercases', () => {
    const r = parseRecipients('A@x.com, b@x.com;a@x.com\nnot-an-email');
    expect(r.valid).toEqual(['a@x.com', 'b@x.com']);
    expect(r.invalid).toEqual(['not-an-email']);
  });
  it('returns empty lists for blank input', () => {
    expect(parseRecipients('  ')).toEqual({ valid: [], invalid: [] });
  });
});

describe('validateDraft', () => {
  it('accepts the defaults', () => {
    expect(validateDraft(defaultDraft())).toEqual({});
  });
  it('flags out-of-range schedule values and bad goals', () => {
    const e = validateDraft({ ...defaultDraft(), send_day: '31', send_hour: '24', close_rate_goal_pct: '140', jobs_goal: '2.5', revenue_goal: '-5' });
    expect(Object.keys(e).sort()).toEqual(['close_rate_goal_pct', 'jobs_goal', 'revenue_goal', 'send_day', 'send_hour']);
  });
  it('flags invalid and excessive extra recipients', () => {
    expect(validateDraft({ ...defaultDraft(), extra_recipients: 'oops' }).extra_recipients).toMatch(/Invalid email/);
    const many = Array.from({ length: 11 }, (_, i) => `u${i}@x.com`).join(',');
    expect(validateDraft({ ...defaultDraft(), extra_recipients: many }).extra_recipients).toMatch(/Up to 10/);
  });
  it('requires at least one recipient source', () => {
    const e = validateDraft({ ...defaultDraft(), include_owner: false, include_co_owners: false });
    expect(e.extra_recipients).toMatch(/at least one/);
  });
});

describe('draft <-> row mapping', () => {
  it('converts blanks to null and strings to numbers', () => {
    const row = draftToRow('u1', { ...defaultDraft(), revenue_goal: '50000', jobs_goal: '', extra_recipients: 'CFO@x.com' });
    expect(row.revenue_goal).toBe(50000);
    expect(row.jobs_goal).toBeNull();
    expect(row.extra_recipients).toEqual(['cfo@x.com']);
    expect(row.send_day).toBe(1);
  });
  it('round-trips through rowToDraft', () => {
    const d = { ...defaultDraft(), revenue_goal: '50000', margin_goal_pct: '35.5', extra_recipients: 'a@x.com, b@x.com' };
    expect(rowToDraft(draftToRow('u1', d))).toEqual(d);
  });
});

describe('formatters', () => {
  it('formats money and percentages with n/a fallbacks', () => {
    expect(formatMoney(48230.4)).toBe('$48,230');
    expect(formatMoney(null)).toBe('n/a');
    expect(formatPct(12.4)).toBe('12.4%');
    expect(formatPct(undefined)).toBe('n/a');
  });
  it('puts the browser zone first when it is not in the common list', () => {
    expect(commonTimeZones('Asia/Yerevan')[0]).toBe('Asia/Yerevan');
    expect(commonTimeZones('UTC').filter((z) => z === 'UTC')).toHaveLength(1);
  });
});
