import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  applyReviews,
  breakErrorMessage,
  buildViolationCsvRows,
  evaluateShift,
  filterShifts,
  minutesLabel,
  nextBreakPrompt,
  normalizeSettings,
  parseThresholds,
  premiumMinutesFor,
  rollupByMember,
  settingsToForm,
  summarize,
  validateSettingsForm,
  type PromptShift,
  type ShiftRecord,
} from './breakCompliance';

const M = 60_000;
const START = Date.parse('2027-12-10T08:00:00Z');
const iso = (minFromStart: number) => new Date(START + minFromStart * M).toISOString();

let seq = 0;
/** breaks are [startMinute, endMinute | null] measured from clock-in. */
const shift = (outMin: number | null, breaks: [number, number | null][] = [], member = 'm1'): ShiftRecord => {
  seq += 1;
  return {
    id: `s${seq}`,
    team_member_id: member,
    work_date: '2027-12-10',
    clock_in_at: iso(0),
    clock_out_at: outMin === null ? null : iso(outMin),
    breaks: breaks.map(([a, b]) => ({ started_at: iso(a), ended_at: b === null ? null : iso(b) })),
  };
};
const NOW = START + 12 * 60 * M;
const codes = (s: ShiftRecord, cfg = DEFAULT_SETTINGS) => evaluateShift(s, cfg, NOW).violations.map((v) => v.code);

describe('evaluateShift', () => {
  it('flags nothing for a short shift', () => {
    expect(codes(shift(180))).toEqual([]);
  });

  it('requires one rest break from 3.5 hours', () => {
    expect(codes(shift(240))).toEqual(['rest_missing']);
    expect(codes(shift(240, [[120, 130]]))).toEqual([]);
  });

  it('a 9-minute break does not count as a rest break', () => {
    expect(codes(shift(240, [[120, 129]]))).toEqual(['rest_missing']);
  });

  it('requires a meal break after 5 hours of work', () => {
    expect(codes(shift(330, [[100, 110], [200, 210]]))).toContain('meal_missing');
    expect(codes(shift(360, [[100, 110], [200, 235]]))).toEqual([]);
  });

  it('flags a meal that started after the deadline', () => {
    // 6h10 shift, 30 min meal after 320 worked minutes, plus 2 rests
    const s = shift(430, [[100, 110], [200, 210], [330, 360]]);
    expect(codes(s)).toEqual(['meal_late']);
  });

  it('counts worked time without earlier breaks toward the deadline', () => {
    // meal starts 305 min after clock-in but only 285 worked (20 min of rests before it)
    const s = shift(420, [[60, 70], [150, 160], [305, 340]]);
    expect(codes(s)).not.toContain('meal_late');
  });

  it('needs two meals past 10 hours and three rests', () => {
    const one = shift(700, [[100, 110], [200, 210], [280, 315], [450, 460]]);
    expect(codes(one)).toEqual(['meal_missing']);
    const full = shift(700, [[100, 110], [200, 210], [280, 315], [450, 460], [520, 555]]);
    expect(codes(full)).toEqual([]);
  });

  it('measures required breaks against worked time, not clock time', () => {
    // 5h10 on the clock but a 30 min meal leaves 280 worked: only the first rest threshold applies
    const r = evaluateShift(shift(310, [[120, 150]]), DEFAULT_SETTINGS, NOW);
    expect(r.workedMinutes).toBe(280);
    expect(r.mealsRequired).toBe(0);
    expect(r.restsRequired).toBe(1);
  });

  it('flags nothing when rules are disabled', () => {
    expect(codes(shift(600), { ...DEFAULT_SETTINGS, enabled: false })).toEqual([]);
  });

  it('evaluates an open shift up to now and ignores a break that is still running', () => {
    const open = shift(null, [[100, 110], [200, 210], [700, null]]);
    const r = evaluateShift(open, DEFAULT_SETTINGS, START + 710 * M);
    expect(r.open).toBe(true);
    expect(r.violations.map((v) => v.code)).toContain('meal_missing');
  });

  it('ignores zero-length and out-of-range breaks safely', () => {
    expect(codes(shift(240, [[50, 50], [500, 520]]))).toEqual(['rest_missing']);
  });

  it('explains the longest break taken', () => {
    const v = evaluateShift(shift(330, [[100, 120]]), DEFAULT_SETTINGS, NOW).violations.find((x) => x.code === 'meal_missing');
    expect(v?.detail).toContain('Longest break taken: 20 min');
  });
});

describe('reviews, premium and summary', () => {
  const bad = evaluateShift(shift(380, [[100, 110]]), DEFAULT_SETTINGS, NOW); // 370 min worked: meal missing + 1 of 2 rests taken
  const good = evaluateShift(shift(180), DEFAULT_SETTINGS, NOW);

  it('applies decisions only to the matching violation', () => {
    const [r] = applyReviews([bad], [{ shift_id: bad.shiftId, code: 'meal_missing', status: 'waived', note: 'ok' }]);
    expect(r.violations.find((v) => v.code === 'meal_missing')?.status).toBe('waived');
    expect(r.violations.find((v) => v.code === 'rest_missing')?.status).toBe('open');
  });

  it('charges one premium per type, only for open violations', () => {
    expect(premiumMinutesFor(bad, DEFAULT_SETTINGS)).toBe(120);
    const [waived] = applyReviews([bad], [{ shift_id: bad.shiftId, code: 'meal_missing', status: 'waived', note: null }]);
    expect(premiumMinutesFor(waived, DEFAULT_SETTINGS)).toBe(60);
  });

  it('summarises counts, rate and premium', () => {
    const s = summarize([bad, good], DEFAULT_SETTINGS);
    expect(s.shifts).toBe(2);
    expect(s.compliantShifts).toBe(1);
    expect(s.complianceRate).toBe(50);
    expect(s.openViolations).toBe(2);
    expect(s.premiumOwedMinutes).toBe(120);
  });

  it('has no rate when there are no shifts', () => {
    expect(summarize([], DEFAULT_SETTINGS).complianceRate).toBeNull();
  });

  it('treats a fully reviewed shift as compliant for the rate', () => {
    const [done] = applyReviews(
      [bad],
      [
        { shift_id: bad.shiftId, code: 'meal_missing', status: 'excused', note: null },
        { shift_id: bad.shiftId, code: 'rest_missing', status: 'premium_paid', note: null },
      ],
    );
    const s = summarize([done], DEFAULT_SETTINGS);
    expect(s.complianceRate).toBe(100);
    expect(s.premiumPaidMinutes).toBe(60);
  });

  it('filters by employee and by review state', () => {
    const a = evaluateShift(shift(330, [[100, 110]], 'a'), DEFAULT_SETTINGS, NOW);
    const b = evaluateShift(shift(330, [[100, 110]], 'b'), DEFAULT_SETTINGS, NOW);
    expect(filterShifts([a, b], 'a', 'open')).toHaveLength(1);
    expect(filterShifts([a, b, good], 'all', 'all')).toHaveLength(2);
  });

  it('ranks employees worst first', () => {
    const a = evaluateShift(shift(330, [[100, 110]], 'a'), DEFAULT_SETTINGS, NOW);
    const b = evaluateShift(shift(180, [], 'b'), DEFAULT_SETTINGS, NOW);
    const r = rollupByMember([b, a]);
    expect(r[0].memberId).toBe('a');
    expect(r[0].complianceRate).toBe(0);
    expect(r[1].complianceRate).toBe(100);
  });

  it('builds one CSV row per violation', () => {
    const rows = buildViolationCsvRows([bad, good], () => 'Sam');
    expect(rows).toHaveLength(2);
    expect(rows[0].employee).toBe('Sam');
    expect(rows[0].status).toBe('Needs review');
  });
});

describe('settings form', () => {
  const form = settingsToForm(DEFAULT_SETTINGS);

  it('round-trips the defaults', () => {
    const r = validateSettingsForm(form);
    expect(r.ok && r.value).toEqual(DEFAULT_SETTINGS);
  });

  it('rejects a rest break as long as a meal break', () => {
    const r = validateSettingsForm({ ...form, rest_min_minutes: '30' });
    expect(r.ok).toBe(false);
  });

  it('rejects out-of-range and non-numeric values', () => {
    expect(validateSettingsForm({ ...form, meal_min_minutes: '2' }).ok).toBe(false);
    expect(validateSettingsForm({ ...form, premium_minutes: '1.5' }).ok).toBe(false);
    expect(validateSettingsForm({ ...form, prompt_lead_minutes: 'abc' }).ok).toBe(false);
  });

  it('parses thresholds sorted and unique, and allows none', () => {
    expect(parseThresholds('600, 300 300', 4, 'x')).toEqual({ ok: true, value: [300, 600] });
    expect(parseThresholds('', 4, 'x')).toEqual({ ok: true, value: [] });
    expect(parseThresholds('1, 2, 3, 4, 5', 4, 'x').ok).toBe(false);
    expect(parseThresholds('0', 4, 'x').ok).toBe(false);
    expect(parseThresholds('abc', 4, 'x').ok).toBe(false);
  });

  it('normalises bad server data to safe rules', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    const n = normalizeSettings({ meal_min_minutes: 20, rest_min_minutes: 25, meal_thresholds: [600, 300, 'x'] });
    expect(n.rest_min_minutes).toBeLessThan(n.meal_min_minutes);
    expect(n.meal_thresholds).toEqual([300, 600]);
  });
});

describe('nextBreakPrompt', () => {
  const live = (breaks: PromptShift['breaks'] = []): PromptShift => ({ clockInAt: START, clockOutAt: null, breaks });
  const at = (minFromStart: number) => START + minFromStart * M;
  const b = (a: number, e: number | null) => ({ startAt: at(a), endAt: e === null ? null : at(e) });

  it('stays quiet early in the shift', () => {
    expect(nextBreakPrompt(live(), DEFAULT_SETTINGS, at(60))).toBeNull();
  });

  it('warns before the first rest break, then calls it overdue', () => {
    expect(nextBreakPrompt(live(), DEFAULT_SETTINGS, at(190))?.kind).toBe('rest_soon');
    expect(nextBreakPrompt(live(), DEFAULT_SETTINGS, at(215))?.kind).toBe('rest_overdue');
  });

  it('warns about the meal break, then marks it overdue', () => {
    const rested = live([b(100, 110), b(180, 190)]);
    expect(nextBreakPrompt(rested, DEFAULT_SETTINGS, at(295))?.kind).toBe('meal_soon');
    expect(nextBreakPrompt(rested, DEFAULT_SETTINGS, at(320))?.kind).toBe('meal_overdue');
  });

  it('is quiet once the meal and rests are taken', () => {
    const done = live([b(100, 110), b(180, 190), b(240, 275)]);
    expect(nextBreakPrompt(done, DEFAULT_SETTINGS, at(300))).toBeNull();
  });

  it('tells the technician how long a running break must last', () => {
    const p = nextBreakPrompt(live([b(215, null)]), DEFAULT_SETTINGS, at(218));
    expect(p?.kind).toBe('break_too_short');
    expect(p?.message).toContain('7 more minutes');
  });

  it('is silent for off-shift, disabled rules, disabled prompts or missing rules', () => {
    expect(nextBreakPrompt(null, DEFAULT_SETTINGS, at(300))).toBeNull();
    expect(nextBreakPrompt({ ...live(), clockOutAt: at(200) }, DEFAULT_SETTINGS, at(300))).toBeNull();
    expect(nextBreakPrompt(live(), { ...DEFAULT_SETTINGS, enabled: false }, at(300))).toBeNull();
    expect(nextBreakPrompt(live(), { ...DEFAULT_SETTINGS, prompts_enabled: false }, at(300))).toBeNull();
    expect(nextBreakPrompt(live(), null, at(300))).toBeNull();
  });

  it('gives a different key for each new prompt so a dismissal never hides the next one', () => {
    const a = nextBreakPrompt(live(), DEFAULT_SETTINGS, at(190));
    const c = nextBreakPrompt(live(), DEFAULT_SETTINGS, at(215));
    expect(a?.key).not.toBe(c?.key);
  });
});

describe('helpers', () => {
  it('formats minutes', () => {
    expect(minutesLabel(45)).toBe('45 min');
    expect(minutesLabel(125)).toBe('2h 05m');
    expect(minutesLabel(-5)).toBe('0 min');
  });

  it('maps database errors to friendly copy', () => {
    expect(breakErrorMessage({ code: '42501', message: 'Not authorised' })).toBe("You don't have permission to do that.");
    expect(breakErrorMessage({ code: 'P0001', message: 'Meal break length must be between 5 and 180 minutes' })).toContain('Meal break length');
    expect(breakErrorMessage({ message: 'Failed to fetch' })).toContain('offline');
    expect(breakErrorMessage(null)).toBe('Something went wrong. Please try again.');
  });
});
