import { describe, it, expect } from 'vitest';
import {
  effectiveIncludedMinutes, isAlertableAccount, pendingChannels, planMinutesAlerts, usagePercent, usagePeriodKey, usageThresholdsReached,
} from './core';

describe('threshold math', () => {
  it('uses integer math at the 80% boundary', () => {
    expect(usageThresholdsReached(319, 400)).toEqual([]);
    expect(usageThresholdsReached(320, 400)).toEqual(['minutes_80']);
    expect(usageThresholdsReached(399, 400)).toEqual(['minutes_80']);
  });
  it('reports both thresholds at or above 100%', () => {
    expect(usageThresholdsReached(400, 400)).toEqual(['minutes_80', 'minutes_100']);
    expect(usageThresholdsReached(900, 400)).toEqual(['minutes_80', 'minutes_100']);
  });
  it('never alerts for zero/invalid limits or negative usage', () => {
    expect(usageThresholdsReached(10, 0)).toEqual([]);
    expect(usageThresholdsReached(-5, 400)).toEqual([]);
    expect(usageThresholdsReached('abc', 400)).toEqual([]);
  });
  it('adds bonus minutes to the effective limit when the column exists', () => {
    expect(effectiveIncludedMinutes({ minutes_included: 400, bonus_minutes: 100 })).toBe(500);
    expect(effectiveIncludedMinutes({ minutes_included: 400 })).toBe(400);
    expect(usageThresholdsReached(400, effectiveIncludedMinutes({ minutes_included: 400, bonus_minutes: 100 }))).toEqual(['minutes_80']);
  });
  it('floors the displayed percent', () => {
    expect(usagePercent(399, 400)).toBe(99);
  });
});

describe('period key', () => {
  it('is the UTC calendar month and rolls exactly at the UTC boundary', () => {
    expect(usagePeriodKey(new Date('2026-11-30T23:59:59Z'))).toBe('2026-11');
    expect(usagePeriodKey(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12');
  });
});

describe('once-per-period planning', () => {
  it('sends only the highest crossed threshold', () => {
    expect(planMinutesAlerts(['minutes_80'], new Set())).toEqual({ send: ['minutes_80'], superseded: [] });
  });
  it('80 then 100 is a two-step sequence', () => {
    expect(planMinutesAlerts(['minutes_80', 'minutes_100'], new Set(['minutes_80']))).toEqual({ send: ['minutes_100'], superseded: [] });
  });
  it('a same-run jump past 80 sends 100 and supersedes 80 (no double email)', () => {
    expect(planMinutesAlerts(['minutes_80', 'minutes_100'], new Set())).toEqual({ send: ['minutes_100'], superseded: ['minutes_80'] });
  });
  it('sends nothing once everything reached is completed', () => {
    expect(planMinutesAlerts(['minutes_80', 'minutes_100'], new Set(['minutes_80', 'minutes_100']))).toEqual({ send: [], superseded: [] });
  });
});

describe('account and channel rules', () => {
  it('skips enterprise (unlimited) and suspended/canceled accounts', () => {
    expect(isAlertableAccount({ plan: 'enterprise', status: 'active' })).toBe(false);
    expect(isAlertableAccount({ plan: 'starter', status: 'suspended' })).toBe(false);
    expect(isAlertableAccount({ plan: 'starter', status: 'Canceled' })).toBe(false);
    expect(isAlertableAccount({ plan: 'starter', status: 'active' })).toBe(true);
  });
  it('retries only failed channels', () => {
    expect(pendingChannels('minutes_100', { in_app: 'sent', email: 'failed:email', push: 'sent', sms: 'skipped:no_phone' })).toEqual(['email']);
    expect(pendingChannels('minutes_80', {})).toEqual(['in_app', 'email']);
    expect(pendingChannels('minutes_80', { in_app: 'sent', email: 'sent' })).toEqual([]);
  });
});
