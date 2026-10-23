import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  buildCurlSnippet,
  defaultDisclosure,
  disclosureGaps,
  formatMs,
  formatPhone,
  generateToken,
  humanReasonLabel,
  parseDelays,
  sha256Hex,
  slaPercent,
  toUsE164,
  validateSettings,
} from './speedToLead';

describe('validateSettings', () => {
  it('accepts the defaults', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
  });
  it('rejects windows outside 8 AM-9 PM or inverted', () => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, call_window_start: '07:00' })[0]).toMatch(/8:00 AM and 9:00 PM/);
    expect(validateSettings({ ...DEFAULT_SETTINGS, call_window_end: '21:30' })[0]).toMatch(/8:00 AM and 9:00 PM/);
    expect(validateSettings({ ...DEFAULT_SETTINGS, call_window_start: '15:00', call_window_end: '10:00' }).join()).toMatch(/start before/);
  });
  it('caps attempts, delays, SLA and freshness', () => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, max_attempts: 4 }).join()).toMatch(/1 to 3/);
    expect(validateSettings({ ...DEFAULT_SETTINGS, retry_delays_minutes: [5, 10, 20] }).join()).toMatch(/two whole numbers/);
    expect(validateSettings({ ...DEFAULT_SETTINGS, retry_delays_minutes: [0] }).join()).toMatch(/two whole numbers/);
    expect(validateSettings({ ...DEFAULT_SETTINGS, sla_seconds: 5 }).join()).toMatch(/15 to 300/);
    expect(validateSettings({ ...DEFAULT_SETTINGS, lead_ttl_hours: 500 }).join()).toMatch(/1 to 168/);
  });
});

describe('disclosure', () => {
  it('the generated default disclosure passes every check', () => {
    expect(disclosureGaps(defaultDisclosure('Acme HVAC'))).toEqual([]);
  });
  it('flags missing elements', () => {
    const gaps = disclosureGaps('I agree to be contacted.');
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    expect(gaps.join()).toMatch(/AI/);
    expect(gaps.join()).toMatch(/condition of purchase/);
  });
});

describe('phone + formatting', () => {
  it('normalizes US numbers and rejects bad ones', () => {
    expect(toUsE164('(415) 555-2671')).toBe('+14155552671');
    expect(toUsE164('1-415-555-2671')).toBe('+14155552671');
    expect(toUsE164('123-456-7890')).toBeNull();
    expect(toUsE164('555')).toBeNull();
    expect(formatPhone('+14155552671')).toBe('(415) 555-2671');
    expect(formatPhone('+442079460958')).toBe('+442079460958');
  });
  it('formats durations and SLA percentage', () => {
    expect(formatMs(null)).toBe('-');
    expect(formatMs(420)).toBe('420 ms');
    expect(formatMs(8200)).toBe('8.2 s');
    expect(formatMs(42000)).toBe('42 s');
    expect(formatMs(125000)).toBe('2 min 5 s');
    expect(slaPercent({ dialed: 0, within_sla: 0 })).toBeNull();
    expect(slaPercent({ dialed: 8, within_sla: 7 })).toBe(88);
  });
  it('parses retry delays and labels reasons', () => {
    expect(parseDelays('5, 60')).toEqual([5, 60]);
    expect(parseDelays('')).toEqual([]);
    expect(humanReasonLabel('qualified_lead')).toMatch(/Qualified/);
    expect(humanReasonLabel('something_new')).toBe('Needs follow-up');
    expect(humanReasonLabel(null)).toBe('');
  });
});

describe('tokens', () => {
  it('generates 64-hex tokens that are unique, and hashes deterministically', async () => {
    const a = generateToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateToken()).not.toBe(a);
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('builds a curl snippet containing the version and token header', () => {
    const s = buildCurlSnippet('https://x.supabase.co/functions/v1/speed-to-lead-intake', 'tok', 4);
    expect(s).toContain("X-Vireek-Token: tok");
    expect(s).toContain('"disclosure_version": 4');
  });
});
