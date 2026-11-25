import { describe, expect, it } from 'vitest';
import {
  UNCONFIGURED_SETTINGS,
  buildPublicStatLine,
  classifyPolicyPromise,
  formatWindow,
  mapPublicStat,
  mapSettingsRow,
  mapStatsRow,
  parseOptionalCases,
  parseOptionalMinutes,
  parseWindowInput,
  summarizeStats,
  validateSettings,
  type CallbackPromiseSettings,
} from '@/lib/callbackPromise';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const iso = (minutesFromNow: number) => new Date(NOW + minutesFromNow * 60_000).toISOString();

describe('unconfigured account', () => {
  it('has no invented limit: off and without a window', () => {
    expect(UNCONFIGURED_SETTINGS).toEqual({
      enabled: false,
      windowMinutes: null,
      escalateAfterMinutes: null,
      publicStatOptIn: false,
      publicStatMinCases: null,
    });
    expect(validateSettings(UNCONFIGURED_SETTINGS)).toEqual([]);
  });
  it('maps a missing or malformed settings row to the unconfigured state', () => {
    expect(mapSettingsRow(null)).toEqual(UNCONFIGURED_SETTINGS);
    expect(mapSettingsRow('nope')).toEqual(UNCONFIGURED_SETTINGS);
    expect(mapSettingsRow([])).toEqual(UNCONFIGURED_SETTINGS);
  });
});

describe('formatWindow (mirrors callback_promise_fmt_minutes)', () => {
  it('formats minutes and whole hours', () => {
    expect(formatWindow(5)).toBe('5 min');
    expect(formatWindow(45)).toBe('45 min');
    expect(formatWindow(60)).toBe('1 h');
    expect(formatWindow(90)).toBe('90 min');
    expect(formatWindow(1440)).toBe('24 h');
    expect(formatWindow(null)).toBe('-');
    expect(formatWindow(Number.NaN)).toBe('-');
  });
});

describe('parseWindowInput', () => {
  it('accepts minutes and hours', () => {
    expect(parseWindowInput('30')).toBe(30);
    expect(parseWindowInput(' 45m ')).toBe(45);
    expect(parseWindowInput('45 min')).toBe(45);
    expect(parseWindowInput('2h')).toBe(120);
    expect(parseWindowInput('2 hours')).toBe(120);
    expect(parseWindowInput('7d')).toBeNull();
    expect(parseWindowInput('168h')).toBe(10_080);
  });
  it('rejects bounds, decimals and junk', () => {
    expect(parseWindowInput('')).toBeNull();
    expect(parseWindowInput('4')).toBeNull();
    expect(parseWindowInput('169h')).toBeNull();
    expect(parseWindowInput('1.5h')).toBeNull();
    expect(parseWindowInput('-30')).toBeNull();
    expect(parseWindowInput('30; drop table')).toBeNull();
    expect(parseWindowInput('0')).toBeNull();
  });
});

describe('optional fields', () => {
  it('empty means not set, invalid means undefined', () => {
    expect(parseOptionalMinutes('')).toBeNull();
    expect(parseOptionalMinutes('  ')).toBeNull();
    expect(parseOptionalMinutes('2h')).toBe(120);
    expect(parseOptionalMinutes('abc')).toBeUndefined();
    expect(parseOptionalCases('')).toBeNull();
    expect(parseOptionalCases('50')).toBe(50);
    expect(parseOptionalCases('0')).toBeUndefined();
    expect(parseOptionalCases('1e3')).toBeUndefined();
    expect(parseOptionalCases('100001')).toBeUndefined();
  });
});

describe('validateSettings', () => {
  const base: CallbackPromiseSettings = { ...UNCONFIGURED_SETTINGS };
  it('requires a window before the rule can be on', () => {
    expect(validateSettings({ ...base, enabled: true })).toHaveLength(1);
    expect(validateSettings({ ...base, enabled: true, windowMinutes: 30 })).toEqual([]);
  });
  it('requires a minimum sample before a public stat can be allowed', () => {
    expect(validateSettings({ ...base, publicStatOptIn: true })).toHaveLength(1);
    expect(validateSettings({ ...base, publicStatOptIn: true, publicStatMinCases: 20 })).toEqual([]);
  });
  it('enforces the same bounds as the database', () => {
    expect(validateSettings({ ...base, windowMinutes: 4 })).toHaveLength(1);
    expect(validateSettings({ ...base, windowMinutes: 10_081 })).toHaveLength(1);
    expect(validateSettings({ ...base, escalateAfterMinutes: 4 })).toHaveLength(1);
    expect(validateSettings({ ...base, windowMinutes: 5, escalateAfterMinutes: 10_080 })).toEqual([]);
    expect(validateSettings({ ...base, publicStatMinCases: 0 })).toHaveLength(1);
    expect(validateSettings({ ...base, windowMinutes: 30.5 })).toHaveLength(1);
  });
});

describe('stats shaping', () => {
  it('maps the database object and survives bad input', () => {
    const s = mapStatsRow({ decided: 10, kept_system: '6', kept_manual: 1, late: 2, broken: 0, open_overdue: 1, median_minutes_to_callback: 12.5, window_min: 30, window_max: 30 });
    expect(s).toEqual({ decided: 10, keptSystem: 6, keptManual: 1, late: 2, broken: 0, openOverdue: 1, medianMinutesToCallback: 12.5, windowMin: 30, windowMax: 30 });
    const empty = mapStatsRow(null);
    expect(empty.decided).toBe(0);
    expect(empty.medianMinutesToCallback).toBeNull();
    expect(mapStatsRow({ decided: -3, kept_system: 'x' }).decided).toBe(0);
  });
  it('computes rates from real counts only', () => {
    const s = mapStatsRow({ decided: 8, kept_system: 5, kept_manual: 2, late: 1, open_overdue: 0 });
    const sum = summarizeStats(s);
    expect(sum.verifiedRatePct).toBe(62.5);
    expect(sum.ownerRatePct).toBe(87.5);
    expect(sum.windowChanged).toBe(false);
  });
  it('shows no rate when nothing is decided (never 0% or 100% from empty data)', () => {
    const sum = summarizeStats(mapStatsRow({}));
    expect(sum.verifiedRatePct).toBeNull();
    expect(sum.ownerRatePct).toBeNull();
  });
  it('flags a window that changed inside the period', () => {
    expect(summarizeStats(mapStatsRow({ decided: 3, window_min: 30, window_max: 60 })).windowChanged).toBe(true);
  });
});

describe('public stat', () => {
  const good = { publishable: true, window_minutes: 30, period_days: 30, cases: 40, kept_on_time: 34, rate_pct: 85, basis: 'system_evidence_only', as_of: '2026-11-23T12:00:00Z' };
  it('builds one sentence from a vouched result', () => {
    const stat = mapPublicStat(good);
    expect(stat).toMatchObject({ publishable: true, cases: 40, keptOnTime: 34 });
    expect(buildPublicStatLine(stat)).toBe('34 of 40 missed-call callbacks were made within 30 min (last 30 days).');
  });
  it('never builds a line from null, unpublishable or inconsistent data', () => {
    expect(buildPublicStatLine(null)).toBeNull();
    expect(mapPublicStat(null)).toBeNull();
    expect(mapPublicStat('x')).toBeNull();
    expect(buildPublicStatLine(mapPublicStat({ publishable: false, reason: 'insufficient_sample' }))).toBeNull();
    expect(mapPublicStat({ publishable: false, reason: 'insufficient_sample' })).toEqual({ publishable: false, reason: 'insufficient_sample' });
    expect(buildPublicStatLine(mapPublicStat({ ...good, kept_on_time: 41 }))).toBeNull();
    expect(buildPublicStatLine(mapPublicStat({ ...good, cases: 0 }))).toBeNull();
    expect(buildPublicStatLine(mapPublicStat({ ...good, window_minutes: null }))).toBeNull();
    expect(buildPublicStatLine(mapPublicStat({ ...good, as_of: undefined }))).toBeNull();
    expect(buildPublicStatLine(mapPublicStat({ ...good, publishable: 'true' }))).toBeNull();
  });
});

describe('classifyPolicyPromise', () => {
  it('on time: resolved at or before the deadline', () => {
    expect(classifyPolicyPromise({ status: 'fulfilled', due_at: iso(-10), resolved_at: iso(-10) }, NOW)).toBe('on_time');
    expect(classifyPolicyPromise({ status: 'fulfilled', due_at: iso(-10), resolved_at: iso(-20) }, NOW)).toBe('on_time');
  });
  it('late: resolved after the deadline', () => {
    expect(classifyPolicyPromise({ status: 'fulfilled', due_at: iso(-10), resolved_at: iso(-9) }, NOW)).toBe('late');
  });
  it('fulfilled without usable timestamps is treated as late, never as on time', () => {
    expect(classifyPolicyPromise({ status: 'fulfilled', due_at: null, resolved_at: iso(0) }, NOW)).toBe('late');
    expect(classifyPolicyPromise({ status: 'fulfilled', due_at: iso(0), resolved_at: null }, NOW)).toBe('late');
  });
  it('pending: open before the deadline, overdue after, and a human decides broken', () => {
    expect(classifyPolicyPromise({ status: 'pending', due_at: iso(5), resolved_at: null }, NOW)).toBe('open');
    expect(classifyPolicyPromise({ status: 'pending', due_at: iso(0), resolved_at: null }, NOW)).toBe('overdue');
    expect(classifyPolicyPromise({ status: 'pending', due_at: iso(-1), resolved_at: null }, NOW)).toBe('overdue');
    expect(classifyPolicyPromise({ status: 'pending', due_at: null, resolved_at: null }, NOW)).toBe('open');
    expect(classifyPolicyPromise({ status: 'broken', due_at: iso(-1), resolved_at: iso(0) }, NOW)).toBe('broken');
    expect(classifyPolicyPromise({ status: 'cancelled', due_at: iso(-1), resolved_at: iso(0) }, NOW)).toBe('cancelled');
  });
});
