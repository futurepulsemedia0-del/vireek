import { describe, expect, it } from 'vitest';
import {
  DATA_ROOM_ITEMS,
  QUESTIONS,
  answersEqual,
  buildRecommendations,
  describeValuationError,
  emptyNumbersForm,
  estimateValue,
  formToRow,
  formatMoney,
  isValuationUnavailable,
  overallReadiness,
  parseNumber,
  readinessBand,
  sanitizeAnswers,
  scoreAssessment,
  scoreDataRoom,
  validateNumbers,
  type Answers,
  type DataRoomRow,
  type DataRoomStatus,
  type ValuationInputs,
} from './valuation';

const allAnswers = (value: 0 | 1 | 2 | 3): Answers => Object.fromEntries(QUESTIONS.map((q) => [q.key, value])) as Answers;

const rowsWith = (status: DataRoomStatus, keys = DATA_ROOM_ITEMS.map((i) => i.key)): DataRoomRow[] =>
  keys.map((item_key) => ({ item_key, status, note: null, updated_at: '2026-01-01T00:00:00Z' }));

const INPUTS: ValuationInputs = {
  annual_revenue: 2_000_000,
  owner_earnings: 400_000,
  revenue_growth_pct: 8,
  recurring_revenue_pct: 20,
  top_customer_pct: 10,
  cash_on_hand: 50_000,
  total_debt: 100_000,
  multiple_low: 2,
  multiple_high: 3.5,
};

describe('scoreAssessment', () => {
  it('is null until something is answered', () => {
    expect(scoreAssessment({}).score).toBeNull();
  });

  it('scores 100 when every answer is the best and 0 when every answer is the worst', () => {
    expect(scoreAssessment(allAnswers(3)).score).toBe(100);
    expect(scoreAssessment(allAnswers(0)).score).toBe(0);
  });

  it('counts unanswered questions as zero so a partial survey never flatters', () => {
    const half = Object.fromEntries(QUESTIONS.slice(0, 9).map((q) => [q.key, 3])) as Answers;
    const result = scoreAssessment(half);
    expect(result.answered).toBe(9);
    expect(result.score).toBeLessThan(100);
    expect(result.score).toBeGreaterThan(0);
  });

  it('ignores unknown keys and out-of-range values', () => {
    expect(sanitizeAnswers({ fin_books: 3, nope: 2, own_field: 5, gro_story: '1' })).toEqual({ fin_books: 3 });
    expect(sanitizeAnswers(null)).toEqual({});
    expect(sanitizeAnswers([1, 2])).toEqual({});
  });
});

describe('scoreDataRoom', () => {
  it('is 0 when nothing is started and 100 when everything is ready', () => {
    expect(scoreDataRoom([]).score).toBe(0);
    expect(scoreDataRoom(rowsWith('ready')).score).toBe(100);
  });

  it('gives partial credit for in-progress items', () => {
    const score = scoreDataRoom(rowsWith('in_progress')).score;
    expect(score).toBe(40);
  });

  it('excludes not-applicable items instead of penalising them', () => {
    const rows = [...rowsWith('not_applicable', ['ast_leases']), ...rowsWith('ready', DATA_ROOM_ITEMS.filter((i) => i.key !== 'ast_leases').map((i) => i.key))];
    const result = scoreDataRoom(rows);
    expect(result.score).toBe(100);
    expect(result.notApplicable).toBe(1);
  });

  it('returns 0 rather than NaN when every item is not applicable', () => {
    expect(scoreDataRoom(rowsWith('not_applicable')).score).toBe(0);
  });
});

describe('overallReadiness and bands', () => {
  it('blends 65% questionnaire and 35% data room', () => {
    const a = scoreAssessment(allAnswers(3));
    const d = scoreDataRoom([]);
    expect(overallReadiness(a, d)).toBe(65);
    expect(overallReadiness(scoreAssessment({}), d)).toBeNull();
  });

  it('maps scores to bands at the documented thresholds', () => {
    expect(readinessBand(null)).toBeNull();
    expect(readinessBand(39)).toBe('not_ready');
    expect(readinessBand(40)).toBe('early');
    expect(readinessBand(60)).toBe('nearly');
    expect(readinessBand(80)).toBe('ready');
  });
});

describe('estimateValue', () => {
  it('refuses to guess without positive owner earnings', () => {
    expect(estimateValue({ ...INPUTS, owner_earnings: null }, 50).canCompute).toBe(false);
    expect(estimateValue({ ...INPUTS, owner_earnings: 0 }, 50).canCompute).toBe(false);
    expect(estimateValue({ ...INPUTS, owner_earnings: -10 }, 50).reason).toMatch(/above zero/i);
  });

  it('keeps the multiple inside the chosen band and orders low < mid < high', () => {
    const e = estimateValue(INPUTS, 60, 18);
    expect(e.canCompute).toBe(true);
    expect(e.multipleLow).toBeGreaterThanOrEqual(2);
    expect(e.multipleHigh).toBeLessThanOrEqual(3.5);
    expect(e.valueLow).toBeLessThan(e.valueMid);
    expect(e.valueMid).toBeLessThan(e.valueHigh);
  });

  it('values a ready, recurring, diversified business higher than a fragile one', () => {
    const strong = estimateValue({ ...INPUTS, recurring_revenue_pct: 50, top_customer_pct: 5, revenue_growth_pct: 20 }, 95, 18);
    const weak = estimateValue({ ...INPUTS, recurring_revenue_pct: 0, top_customer_pct: 40, revenue_growth_pct: -10 }, 20, 18);
    expect(strong.valueMid).toBeGreaterThan(weak.valueMid);
  });

  it('shows the value of reaching the target readiness, and none once there', () => {
    expect(estimateValue(INPUTS, 40, 18).readinessUplift).toBeGreaterThan(0);
    expect(estimateValue(INPUTS, 90, 18).readinessUplift).toBe(0);
    expect(estimateValue(INPUTS, null, 0).readinessUplift).toBe(0);
  });

  it('subtracts debt, adds cash, and flags when debt exceeds the business value', () => {
    const e = estimateValue(INPUTS, 60, 18);
    expect(e.equityMid).toBe(e.valueMid + 50_000 - 100_000);
    const underwater = estimateValue({ ...INPUTS, owner_earnings: 10_000, total_debt: 500_000 }, 90, 18);
    expect(underwater.debtExceedsValue).toBe(true);
    expect(underwater.equityMid).toBe(0);
  });

  it('reports low confidence with little input and high confidence with a full picture', () => {
    expect(estimateValue({ ...INPUTS, recurring_revenue_pct: null, top_customer_pct: null, revenue_growth_pct: null }, null, 0).confidence).toBe('low');
    expect(estimateValue(INPUTS, 70, 18).confidence).toBe('high');
  });

  it('rejects an inverted multiple band', () => {
    expect(estimateValue({ ...INPUTS, multiple_low: 3, multiple_high: 2 }, 60).canCompute).toBe(false);
  });
});

describe('buildRecommendations', () => {
  it('puts the most valuable gap first and respects the limit', () => {
    const recs = buildRecommendations({ fin_books: 0, own_field: 3 }, [], 3);
    expect(recs).toHaveLength(3);
    expect(recs[0].impact).toBeGreaterThanOrEqual(recs[1].impact);
    expect(recs.some((r) => r.id === 'q:own_field')).toBe(false);
  });

  it('does not recommend items that are ready or not applicable', () => {
    const recs = buildRecommendations({}, rowsWith('ready', ['fin_pl_3y']).concat(rowsWith('not_applicable', ['fin_bs_3y'])), 50);
    expect(recs.some((r) => r.id === 'd:fin_pl_3y')).toBe(false);
    expect(recs.some((r) => r.id === 'd:fin_bs_3y')).toBe(false);
    expect(recs.some((r) => r.id === 'd:tax_returns_3y')).toBe(true);
  });

  it('returns nothing when everything is complete', () => {
    expect(buildRecommendations(allAnswers(3), rowsWith('ready'))).toEqual([]);
  });
});

describe('number parsing and validation', () => {
  it('parses money-looking text and rejects junk', () => {
    expect(parseNumber('$1,250,000.50')).toBe(1250000.5);
    expect(parseNumber('  ')).toBeNull();
    expect(Number.isNaN(parseNumber('12abc'))).toBe(true);
    expect(Number.isNaN(parseNumber('1e5'))).toBe(true);
  });

  it('validates ranges, the multiple order and the exit date', () => {
    const errors = validateNumbers(
      { ...emptyNumbersForm(), annual_revenue: 'abc', recurring_revenue_pct: '120', multiple_low: '3', multiple_high: '2', target_exit_date: '2001-01-01' },
      new Date('2026-10-26T00:00:00'),
    );
    expect(errors.annual_revenue).toMatch(/number/i);
    expect(errors.recurring_revenue_pct).toMatch(/between/i);
    expect(errors.multiple_high).toMatch(/greater/i);
    expect(errors.target_exit_date).toMatch(/past/i);
  });

  it('accepts the defaults and converts a form to database values', () => {
    expect(validateNumbers(emptyNumbersForm())).toEqual({});
    const row = formToRow({ ...emptyNumbersForm(), owner_earnings: '$400,000', top_customer_pct: '12.5' });
    expect(row.owner_earnings).toBe(400000);
    expect(row.top_customer_pct).toBe(12.5);
    expect(row.annual_revenue).toBeNull();
    expect(row.multiple_low).toBe(2);
    expect(row.target_exit_date).toBeNull();
  });
});

describe('helpers', () => {
  it('formats money and handles missing values', () => {
    expect(formatMoney(1234567)).toBe('$1,234,567');
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(Number.NaN)).toBe('—');
  });

  it('compares answers on known questions only', () => {
    expect(answersEqual({ fin_books: 2 }, { fin_books: 2 })).toBe(true);
    expect(answersEqual({ fin_books: 2 }, { fin_books: 3 })).toBe(false);
  });

  it('explains common database failures in plain words', () => {
    expect(isValuationUnavailable({ code: '42P01' })).toBe(true);
    expect(isValuationUnavailable({ message: 'relation "valuation_profiles" does not exist' })).toBe(true);
    expect(describeValuationError({ code: '42501', message: 'row-level security' })).toMatch(/owner/i);
    expect(describeValuationError({ code: '23514' })).toMatch(/out of range/i);
    expect(describeValuationError(new Error('boom'))).toBe('boom');
  });

  it('keeps catalog keys unique and every data-room weight valid', () => {
    expect(new Set(DATA_ROOM_ITEMS.map((i) => i.key)).size).toBe(DATA_ROOM_ITEMS.length);
    expect(new Set(QUESTIONS.map((q) => q.key)).size).toBe(QUESTIONS.length);
    expect(DATA_ROOM_ITEMS.every((i) => [1, 2, 3].includes(i.weight) && /^[a-z0-9_]{3,40}$/.test(i.key))).toBe(true);
  });
});
