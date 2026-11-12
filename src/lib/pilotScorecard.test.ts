import { describe, it, expect } from 'vitest';
import { buildScorecard, scrubPii, weekStartUtc, type RawScorecard, type RawWeek } from './pilotScorecard';

const W = (o: Partial<RawWeek> = {}): RawWeek => ({ total: 0, missed: 0, answered: 0, booked: 0, not_booked: 0, escalated: 0, answer_ms_avg: null, answer_ms_n: 0, rating_avg: null, rating_n: 0, wrong_reports: 0, ...o });
const R = (c: Partial<RawWeek>, p: Partial<RawWeek> = {}): RawScorecard => ({ week_start: '2026-11-09', week_end: '2026-11-16', current: W(c), previous: W(p), errors_measured: false });

describe('buildScorecard', () => {
  it('computes rates and deltas from real counts', () => {
    const s = buildScorecard(R({ total: 20, answered: 18, missed: 2, booked: 6, not_booked: 4, escalated: 2 }, { total: 10, answered: 6, missed: 4, booked: 2, not_booked: 2, escalated: 1 }));
    expect(s.bookingRate.value).toBe(0.6);
    expect(s.bookingRate.delta).toBe(0.1);
    expect(s.escalationRate.value).toBe(0.1);
    expect(s.missedCalls.delta).toBe(-2);
    expect(s.hasData).toBe(true);
  });
  it('returns null, never 0, when there is no denominator or no data', () => {
    const s = buildScorecard(R({ total: 5, answered: 5 }));
    expect(s.bookingRate.value).toBeNull();
    expect(s.answerSeconds.value).toBeNull();
    expect(s.satisfaction.value).toBeNull();
    expect(s.errorsMeasured).toBe(false);
  });
  it('flags low-confidence satisfaction and converts answer time to seconds', () => {
    const s = buildScorecard(R({ total: 3, answer_ms_avg: 2500, answer_ms_n: 3, rating_avg: 4.5, rating_n: 2 }));
    expect(s.satisfactionLowConfidence).toBe(true);
    expect(s.answerSeconds.value).toBe(2.5);
  });
  it('treats an empty or malformed payload as no data', () => {
    expect(buildScorecard({ ...R({}), current: undefined as never, previous: undefined as never }).hasData).toBe(false);
  });
});

describe('weekStartUtc', () => {
  it('returns the Monday of the week (UTC)', () => {
    expect(weekStartUtc(new Date('2026-11-12T10:00:00Z'))).toBe('2026-11-09');
    expect(weekStartUtc(new Date('2026-11-15T23:59:00Z'))).toBe('2026-11-09');
    expect(weekStartUtc(new Date('2026-11-16T00:00:00Z'))).toBe('2026-11-16');
  });
});

describe('scrubPii', () => {
  it('masks email, phone, card, ssn and street address', () => {
    const out = scrubPii('mail bob@x.com call 512-555-0142 card 4111 1111 1111 1111 ssn 123-45-6789 at 500 Congress Ave')!;
    expect(out).not.toMatch(/bob@x\.com|555-0142|4111|123-45-6789|Congress/);
    expect(out).toMatch(/\[email\].*\[phone\].*\[card\].*\[ssn\].*\[address\]/);
  });
  it('returns null for empty input and bounds length', () => {
    expect(scrubPii('')).toBeNull();
    expect(scrubPii(null)).toBeNull();
    expect(scrubPii('a'.repeat(5000))!.length).toBe(2000);
  });
});
