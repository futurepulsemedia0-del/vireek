import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERTIME_PARAMS,
  DEFAULT_PW_PARAMS,
  LABOR_SIGNALS_DISCLAIMER,
  OVERTIME_PACKS,
  PW_PACKS,
  getOvertimePack,
  getPwPack,
  normalizeOvertimeParams,
  normalizePwParams,
  openMarkers,
  validateOvertimeParams,
  validatePwParams,
} from './rules';

describe('rule packs are honest starter data', () => {
  it('every pack is unverified and carries a [VERIFY]/[COUNSEL] marker in its citation', () => {
    for (const p of [...OVERTIME_PACKS, ...PW_PACKS]) {
      expect(p.lastReviewed).toBeNull();
      expect(/\[(VERIFY|COUNSEL)\]/.test(p.citation)).toBe(true);
      expect(p.notChecked.length).toBeGreaterThan(0);
    }
  });
  it('every pack passes its own validator', () => {
    for (const p of OVERTIME_PACKS) expect(validateOvertimeParams(p.params).ok).toBe(true);
    for (const p of PW_PACKS) expect(validatePwParams(p.params).ok).toBe(true);
  });
  it('summaries never state what the law requires', () => {
    const text = [...OVERTIME_PACKS, ...PW_PACKS].map((p) => `${p.summary} ${p.name}`).join(' ').toLowerCase();
    for (const banned of ['must', 'required', 'violat', 'illegal', 'unlawful', 'owed', 'compliant']) expect(text.includes(banned)).toBe(false);
  });
  it('the disclaimer carries both markers and denies legal conclusions', () => {
    expect(LABOR_SIGNALS_DISCLAIMER).toContain('[COUNSEL]');
    expect(LABOR_SIGNALS_DISCLAIMER).toContain('[VERIFY]');
    expect(LABOR_SIGNALS_DISCLAIMER.toLowerCase()).toContain('not legal conclusions');
  });
  it('looks packs up by code', () => {
    expect(getOvertimePack('CA')?.params.daily_ot_after_hours).toBe(8);
    expect(getOvertimePack('ZZ')).toBeNull();
    expect(getPwPack('FED')).not.toBeNull();
    expect(getPwPack('ZZ')).toBeNull();
  });
});

describe('validateOvertimeParams', () => {
  const ok = DEFAULT_OVERTIME_PARAMS;
  const bad = (o: Record<string, unknown>) => validateOvertimeParams({ ...ok, ...o });
  it('accepts defaults', () => expect(validateOvertimeParams(ok).ok).toBe(true));
  it('rejects out-of-range and wrong types', () => {
    expect(bad({ workweek_start_dow: 7 }).ok).toBe(false);
    expect(bad({ workweek_start_dow: 1.5 }).ok).toBe(false);
    expect(bad({ weekly_threshold_hours: 0 }).ok).toBe(false);
    expect(bad({ weekly_threshold_hours: 169 }).ok).toBe(false);
    expect(bad({ weekly_threshold_hours: '40' }).ok).toBe(false);
    expect(bad({ open_shift_alert_hours: 3 }).ok).toBe(false);
    expect(bad({ payroll_gap_tolerance_hours: -1 }).ok).toBe(false);
    expect(bad({ seventh_day_signal: 'yes' }).ok).toBe(false);
    expect(validateOvertimeParams(null).ok).toBe(false);
  });
  it('enforces the daily tier ordering', () => {
    expect(bad({ daily_ot_after_hours: 8, daily_dt_after_hours: 8 }).ok).toBe(false);
    expect(bad({ daily_ot_after_hours: 8, daily_dt_after_hours: 12 }).ok).toBe(true);
    expect(bad({ daily_ot_after_hours: null, daily_dt_after_hours: 12 }).ok).toBe(false);
  });
  it('needs at least one threshold', () => {
    expect(bad({ weekly_threshold_hours: null, daily_ot_after_hours: null, seventh_day_signal: false }).ok).toBe(false);
    expect(bad({ weekly_threshold_hours: null, daily_ot_after_hours: null, seventh_day_signal: true }).ok).toBe(true);
  });
  it('normalize falls back to defaults on junk', () => {
    expect(normalizeOvertimeParams({ weekly_threshold_hours: -5 })).toEqual(DEFAULT_OVERTIME_PARAMS);
    expect(normalizeOvertimeParams(undefined)).toEqual(DEFAULT_OVERTIME_PARAMS);
    expect(normalizeOvertimeParams({ weekly_threshold_hours: 44 }).weekly_threshold_hours).toBe(44);
  });
});

describe('validatePwParams', () => {
  it('requires booleans and at least one check', () => {
    expect(validatePwParams(DEFAULT_PW_PARAMS).ok).toBe(true);
    expect(validatePwParams({ check_missing_classification: false, check_rate_below_table: false }).ok).toBe(false);
    expect(validatePwParams({ check_missing_classification: 'x' }).ok).toBe(false);
    expect(normalizePwParams({ check_rate_below_table: 3 })).toEqual(DEFAULT_PW_PARAMS);
  });
});

describe('openMarkers', () => {
  it('shows COUNSEL until reviewed and VERIFY until a verification date is recorded', () => {
    expect(openMarkers({ counsel_status: 'needs_counsel', verified_on: null })).toEqual(['COUNSEL', 'VERIFY']);
    expect(openMarkers({ counsel_status: 'counsel_reviewed', verified_on: null })).toEqual(['VERIFY']);
    expect(openMarkers({ counsel_status: 'needs_counsel', verified_on: '2027-03-01' })).toEqual(['COUNSEL']);
    expect(openMarkers({ counsel_status: 'counsel_reviewed', verified_on: '2027-03-01' })).toEqual([]);
  });
});
