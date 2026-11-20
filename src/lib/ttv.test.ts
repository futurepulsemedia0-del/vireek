import { describe, expect, it } from 'vitest';
import {
  TTV_MILESTONES,
  humanizeSeconds,
  parseStallHours,
  parseTtvOverview,
  parseWatchDays,
  reachedPercent,
} from './ttv';

describe('humanizeSeconds', () => {
  it('returns null for missing or invalid input', () => {
    expect(humanizeSeconds(null)).toBeNull();
    expect(humanizeSeconds(undefined)).toBeNull();
    expect(humanizeSeconds(-1)).toBeNull();
    expect(humanizeSeconds(Number.NaN)).toBeNull();
  });
  it('picks minutes, hours or days', () => {
    expect(humanizeSeconds(0)).toEqual({ unit: 'minutes', value: 1 });
    expect(humanizeSeconds(5 * 60)).toEqual({ unit: 'minutes', value: 5 });
    expect(humanizeSeconds(90 * 60)).toEqual({ unit: 'hours', value: 1.5 });
    expect(humanizeSeconds(47 * 3600)).toEqual({ unit: 'hours', value: 47 });
    expect(humanizeSeconds(3 * 86400)).toEqual({ unit: 'days', value: 3 });
  });
  it('never shows "60 minutes"', () => {
    expect(humanizeSeconds(3599)?.unit).toBe('hours');
  });
});

describe('reachedPercent', () => {
  it('is null for an empty cohort', () => {
    expect(reachedPercent(0, 0)).toBeNull();
  });
  it('rounds and clamps to 0..100', () => {
    expect(reachedPercent(1, 3)).toBe(33);
    expect(reachedPercent(5, 3)).toBe(100);
    expect(reachedPercent(-2, 3)).toBe(0);
  });
});

describe('parseStallHours / parseWatchDays', () => {
  it('accepts whole numbers inside the database limits', () => {
    expect(parseStallHours(' 24 ')).toBe(24);
    expect(parseStallHours('1')).toBe(1);
    expect(parseStallHours('2160')).toBe(2160);
    expect(parseWatchDays('7')).toBe(7);
    expect(parseWatchDays('365')).toBe(365);
  });
  it('rejects empty, fractional, negative and out-of-range values', () => {
    for (const bad of ['', ' ', '0', '2161', '1.5', '-3', 'abc', '1e3', '12345']) expect(parseStallHours(bad)).toBeNull();
    for (const bad of ['', '6', '366', '7.5', '-7']) expect(parseWatchDays(bad)).toBeNull();
  });
});

describe('parseTtvOverview', () => {
  it('returns safe empty defaults for garbage input', () => {
    for (const raw of [null, undefined, 'x', 42, [], {}]) {
      const o = parseTtvOverview(raw);
      expect(o.signups).toBe(0);
      expect(o.milestones).toEqual([]);
      expect(o.config).toEqual([]);
      expect(o.alerts).toEqual([]);
      expect(o.watchDays).toBe(60);
    }
  });

  it('maps the RPC payload, sorts by position and drops unknown milestones', () => {
    const o = parseTtvOverview({
      generated_at: '2029-03-05T10:00:00Z',
      window_days: 30,
      signups: 10,
      truncated: false,
      watch_days: 45,
      stalled_now: 2,
      open_alert_count: 1,
      milestones: [
        { milestone: 'first_real_call', position: 4, label: 'First real call', reached: 3, p50_seconds: '7200', p90_seconds: null },
        { milestone: 'setup_completed', position: 1, label: 'Setup completed', reached: 9, p50_seconds: 600.5, p90_seconds: 86400 },
        { milestone: 'made_up', position: 9, label: 'Nope', reached: 1 },
      ],
      config: [{ milestone: 'setup_completed', position: 1, label: 'Setup completed', stall_hours: 24, alert_enabled: true }],
      open_alerts: [
        { id: 'a1', account_id: 'u1', company_name: null, milestone: 'number_connected', fired_at: '2029-03-04T00:00:00Z', stalled_hours: '80.5', threshold_hours: 72, acknowledged: false },
        { id: '', account_id: 'u2', milestone: 'number_connected' },
      ],
    });
    expect(o.milestones.map((m) => m.milestone)).toEqual(['setup_completed', 'first_real_call']);
    expect(o.milestones[1]).toMatchObject({ p50Seconds: 7200, p90Seconds: null });
    expect(o.config[0]).toMatchObject({ stallHours: 24, alertEnabled: true });
    expect(o.alerts).toHaveLength(1);
    expect(o.alerts[0]).toMatchObject({ id: 'a1', companyName: null, stalledHours: 80.5, thresholdHours: 72, acknowledged: false });
    expect(o.watchDays).toBe(45);
    expect(o.openAlertCount).toBe(1);
  });

  it('lists the five milestones in funnel order', () => {
    expect([...TTV_MILESTONES]).toEqual(['setup_completed', 'number_connected', 'first_test_call', 'first_real_call', 'first_job_booked']);
  });
});
