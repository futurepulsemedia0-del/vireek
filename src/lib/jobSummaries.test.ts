import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  canEditContent,
  describeSummaryError,
  describeWarnings,
  draftChanged,
  draftWarnings,
  normalizeDraft,
  scheduledCountdown,
  summaryLink,
  validateDraft,
  validateSettings,
  type SummaryDraft,
} from './jobSummaries';

const draft = (over: Partial<SummaryDraft> = {}): SummaryDraft => ({
  headline: 'Your AC Repair is complete',
  intro: 'Thanks!',
  work_summary: '',
  work_items: ['Replaced capacitor'],
  parts: [],
  warranty: [],
  photos: [],
  maintenance_tips: [],
  next_service_date: null,
  next_service_note: null,
  channel: 'both',
  ...over,
});

describe('normalizeDraft', () => {
  it('trims, drops blanks and fixes quantities', () => {
    const n = normalizeDraft(
      draft({
        headline: '  Hello   world ',
        work_items: ['  a  ', '', '   ', 'b'],
        parts: [{ name: ' Filter ', quantity: 0 }, { name: '', quantity: 2 }],
        next_service_date: 'not-a-date',
      }),
    );
    expect(n.headline).toBe('Hello world');
    expect(n.work_items).toEqual(['a', 'b']);
    expect(n.parts).toEqual([{ name: 'Filter', quantity: 1 }]);
    expect(n.next_service_date).toBeNull();
  });
});

describe('validateDraft', () => {
  it('accepts a good draft', () => {
    expect(validateDraft(draft())).toEqual({});
  });
  it('requires a headline and some content', () => {
    const e = validateDraft(draft({ headline: '  ', work_items: ['  '], work_summary: ' ' }));
    expect(e.headline).toBeTruthy();
    expect(e.content).toBeTruthy();
  });
  it('rejects an impossible date and over-long items', () => {
    expect(validateDraft(draft({ next_service_date: '2027-02-30' })).next_service_date).toBeTruthy();
    expect(validateDraft(draft({ work_items: ['x'.repeat(301)] })).work_items).toBeTruthy();
  });
});

describe('draftChanged', () => {
  it('ignores whitespace-only differences', () => {
    expect(draftChanged(draft(), draft({ headline: '  Your AC Repair is complete  ' }))).toBe(false);
    expect(draftChanged(draft(), draft({ intro: 'Changed' }))).toBe(true);
  });
});

describe('draftWarnings', () => {
  it('clears NO_WORK_NOTES once notes are added and keeps sticky flags', () => {
    const empty = draftWarnings(draft({ work_items: [], work_summary: '' }), ['QUALITY_FAILED']);
    expect(empty).toContain('NO_WORK_NOTES');
    expect(empty).toContain('QUALITY_FAILED');
    const filled = draftWarnings(draft(), ['QUALITY_FAILED']);
    expect(filled).not.toContain('NO_WORK_NOTES');
    expect(filled).toContain('QUALITY_FAILED');
  });
  it('maps codes to readable messages and ignores unknown codes', () => {
    expect(describeWarnings(['NO_PHOTOS', 'WHAT'])).toHaveLength(1);
  });
});

describe('scheduledCountdown', () => {
  const now = Date.parse('2027-03-04T12:00:00Z');
  it('formats minutes, hours, days and due', () => {
    expect(scheduledCountdown('2027-03-04T12:42:00Z', now)).toBe('Sends in 42 min');
    expect(scheduledCountdown('2027-03-04T15:00:00Z', now)).toBe('Sends in 3 h');
    expect(scheduledCountdown('2027-03-07T12:00:00Z', now)).toBe('Sends in 3 days');
    expect(scheduledCountdown('2027-03-04T11:00:00Z', now)).toBe('Due now');
    expect(scheduledCountdown(null, now)).toBe('');
  });
});

describe('validateSettings', () => {
  it('accepts defaults', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual({});
  });
  it('requires {{link}} and known variables in the SMS', () => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, sms_body: 'Your summary is ready, see our site' }).sms_body).toContain('{{link}}');
    expect(validateSettings({ ...DEFAULT_SETTINGS, sms_body: 'Hi {{oops}} see {{link}}' }).sms_body).toContain('oops');
  });
  it('bounds numeric fields', () => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, review_window_minutes: 99999 }).review_window_minutes).toBeTruthy();
    expect(validateSettings({ ...DEFAULT_SETTINGS, labor_warranty_days: 0 }).labor_warranty_days).toBeTruthy();
    expect(validateSettings({ ...DEFAULT_SETTINGS, labor_warranty_days: 90 })).toEqual({});
  });
});

describe('misc', () => {
  it('builds the public link without double slashes', () => {
    expect(summaryLink('abc', 'https://app.vireek.com/')).toBe('https://app.vireek.com/summary/abc');
  });
  it('blocks editing only mid-send', () => {
    expect(canEditContent({ status: 'sending' })).toBe(false);
    expect(canEditContent({ status: 'sent' })).toBe(true);
  });
  it('explains permission and photo errors', () => {
    expect(describeSummaryError({ code: '42501' })).toContain('permission');
    expect(describeSummaryError({ message: 'JOB_SUMMARY_INVALID_PHOTO' })).toContain('photo');
  });
});
