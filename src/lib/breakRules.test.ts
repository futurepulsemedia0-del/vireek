import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  evaluateShift,
  premiumMinutesFor,
  settingsToForm,
  summarize,
  validateSettingsForm,
  type BreakSettings,
  type ShiftRecord,
} from './breakCompliance';
import {
  BREAK_RULES_DISCLAIMER,
  JURISDICTION_RULES,
  effectiveJurisdiction,
  getJurisdictionRule,
  jurisdictionLabel,
  matchesJurisdiction,
  normalizeJurisdictionCode,
  premiumExplanation,
  settingsForJurisdiction,
  type JurisdictionCode,
} from './breakRules';

const M = 60_000;
const START = Date.parse('2027-12-10T08:00:00Z');
const iso = (min: number) => new Date(START + min * M).toISOString();
const NOW = START + 24 * 60 * M;

let seq = 0;
/** Wall-clock minutes from clock-in; breaks are [startMinute, endMinute]. */
const shift = (outMin: number, breaks: [number, number][] = []): ShiftRecord => {
  seq += 1;
  return {
    id: `r${seq}`,
    team_member_id: 'm1',
    work_date: '2027-12-10',
    clock_in_at: iso(0),
    clock_out_at: iso(outMin),
    breaks: breaks.map(([a, b]) => ({ started_at: iso(a), ended_at: iso(b) })),
  };
};

const cfg = (code: JurisdictionCode): BreakSettings => settingsForJurisdiction(code, DEFAULT_SETTINGS);
const codes = (s: ShiftRecord, code: JurisdictionCode) => evaluateShift(s, cfg(code), NOW).violations.map((v) => v.code);

describe('rule set data', () => {
  it('has unique codes and a citation for every rule set', () => {
    const list = JURISDICTION_RULES.map((r) => r.code);
    expect(new Set(list).size).toBe(list.length);
    for (const r of JURISDICTION_RULES) {
      expect(r.citation.length).toBeGreaterThan(3);
      expect(r.summary.length).toBeGreaterThan(10);
      expect(r.notChecked.length).toBeGreaterThan(0);
      if (r.lastReviewed !== null) expect(r.lastReviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('every rule set passes the same validation the Rules form and the database use', () => {
    for (const r of JURISDICTION_RULES) {
      const v = validateSettingsForm(settingsToForm(cfg(r.code)));
      expect(v.ok).toBe(true);
    }
  });

  it('keeps the premium model consistent with the premium minutes', () => {
    for (const r of JURISDICTION_RULES) {
      expect(r.premiumModel === 'fixed_per_type').toBe(r.rules.premium_minutes > 0);
    }
  });

  it('California equals the original defaults, so existing accounts see no change', () => {
    expect(cfg('CA')).toEqual(DEFAULT_SETTINGS);
  });

  it('carries a visible not-legal-advice flag', () => {
    expect(BREAK_RULES_DISCLAIMER.toLowerCase()).toContain('not legal advice');
  });
});

describe('applying and detecting rule sets', () => {
  it('keeps the on/off switches and reminder timing when a rule set is applied', () => {
    const current: BreakSettings = { ...DEFAULT_SETTINGS, enabled: false, prompts_enabled: false, prompt_lead_minutes: 45 };
    const next = settingsForJurisdiction('WA', current);
    expect(next.enabled).toBe(false);
    expect(next.prompts_enabled).toBe(false);
    expect(next.prompt_lead_minutes).toBe(45);
    expect(next.meal_thresholds).toEqual([301]);
  });

  it('does not share array references with the rule data', () => {
    const next = settingsForJurisdiction('OR', DEFAULT_SETTINGS);
    next.rest_thresholds.push(999);
    expect(getJurisdictionRule('OR').rules.rest_thresholds).toEqual([121, 361, 601, 841]);
  });

  it('reports Custom once the numbers no longer match the saved rule set', () => {
    expect(effectiveJurisdiction('WA', cfg('WA'))).toBe('WA');
    expect(effectiveJurisdiction('WA', { ...cfg('WA'), meal_min_minutes: 45 })).toBe('CUSTOM');
    expect(matchesJurisdiction(cfg('CO'), 'CO')).toBe(true);
    expect(matchesJurisdiction(cfg('CO'), 'OR')).toBe(false);
  });

  it('falls back to California for missing or unknown saved values', () => {
    expect(normalizeJurisdictionCode(undefined)).toBe('CA');
    expect(normalizeJurisdictionCode('ZZ')).toBe('CA');
    expect(normalizeJurisdictionCode(' wa ')).toBe('WA');
    expect(jurisdictionLabel('CUSTOM')).toBe('Custom rules');
    expect(jurisdictionLabel('OR')).toBe('Oregon');
    expect(premiumExplanation('CUSTOM')).toContain('Rules');
  });
});

describe('missed-break detection per rule set', () => {
  it('California: a 6h shift with no breaks misses both meal and rest and owes two premiums', () => {
    const sc = evaluateShift(shift(360), cfg('CA'), NOW);
    expect(sc.violations.map((v) => v.code)).toEqual(['meal_missing', 'rest_missing']);
    expect(premiumMinutesFor(sc, cfg('CA'))).toBe(120);
  });

  it('Washington: a meal is not required at exactly 5h, but is just after', () => {
    expect(codes(shift(300, [[100, 110]]), 'WA')).toEqual([]);
    expect(codes(shift(320, [[100, 110]]), 'WA')).toEqual(['meal_missing']);
  });

  it('Washington: a compliant 6.5h shift has no violations', () => {
    expect(codes(shift(390, [[100, 110], [150, 180]]), 'WA')).toEqual([]);
  });

  it('Washington: missed rest breaks are flagged but carry no fixed premium', () => {
    const sc = evaluateShift(shift(480, [[200, 230]]), cfg('WA'), NOW);
    expect(sc.violations.map((v) => v.code)).toEqual(['rest_missing']);
    expect(premiumMinutesFor(sc, cfg('WA'))).toBe(0);
  });

  it('Oregon: meal starts at 6h worked, rest needs more than 2h', () => {
    expect(codes(shift(359), 'OR')).toEqual(['rest_missing']);
    expect(codes(shift(360), 'OR')).toEqual(['meal_missing', 'rest_missing']);
    expect(codes(shift(120), 'OR')).toEqual([]);
  });

  it('Colorado: a rest break is due once a shift passes 2h', () => {
    expect(codes(shift(120), 'CO')).toEqual([]);
    expect(codes(shift(125), 'CO')).toEqual(['rest_missing']);
  });

  it('Illinois: 20-minute meals count and rest breaks are never required', () => {
    expect(codes(shift(440), 'IL')).toEqual([]);
    expect(codes(shift(460), 'IL')).toEqual(['meal_missing']);
    expect(codes(shift(480, [[200, 220]]), 'IL')).toEqual([]);
    expect(codes(shift(480, [[200, 215]]), 'IL')).toEqual(['meal_missing']);
  });

  it('Federal baseline: nothing is ever flagged', () => {
    expect(codes(shift(720), 'FED')).toEqual([]);
  });

  it('late first meal is still caught under a state rule set', () => {
    expect(codes(shift(480, [[100, 110], [250, 260], [350, 380]]), 'WA')).toEqual(['meal_late']);
  });
});

describe('manager report numbers follow the rule set', () => {
  it('summarizes the same shifts differently under different rule sets', () => {
    const shifts = [shift(480), shift(480, [[150, 180], [100, 110], [330, 340]])];
    const ca = summarize(shifts.map((s) => evaluateShift(s, cfg('CA'), NOW)), cfg('CA'));
    const fed = summarize(shifts.map((s) => evaluateShift(s, cfg('FED'), NOW)), cfg('FED'));
    expect(ca.compliantShifts).toBe(1);
    expect(ca.premiumOwedMinutes).toBe(120);
    expect(fed.compliantShifts).toBe(2);
    expect(fed.premiumOwedMinutes).toBe(0);
  });
});
