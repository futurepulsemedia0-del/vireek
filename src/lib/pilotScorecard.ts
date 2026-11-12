// src/lib/pilotScorecard.ts
//
// Weekly tenant scorecard — pure logic (no I/O). Input is the jsonb returned by get_weekly_scorecard().
// Honesty rules: a metric without a denominator or without data is null ("no data"), never 0; a rating average
// below MIN_RATING_SAMPLE is flagged low-confidence; errors are reported as "not measured".

export const MIN_RATING_SAMPLE = 5;

export interface RawWeek {
  total: number; missed: number; answered: number; booked: number; not_booked: number; escalated: number;
  answer_ms_avg: number | null; answer_ms_n: number; rating_avg: number | null; rating_n: number; wrong_reports: number;
}
export interface RawScorecard { week_start: string; week_end: string; current: RawWeek; previous: RawWeek; errors_measured: boolean }

export interface Metric { value: number | null; previous: number | null; delta: number | null }
export interface Scorecard {
  weekStart: string; weekEnd: string;
  totalCalls: number; answeredCalls: Metric; missedCalls: Metric; bookings: Metric;
  bookingRate: Metric; escalationRate: Metric; answerSeconds: Metric; satisfaction: Metric;
  ratingSample: number; satisfactionLowConfidence: boolean; answerSpeedSample: number;
  wrongReports: number; errorsMeasured: boolean; hasData: boolean;
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : Number(x) || 0);
const nul = (x: unknown): number | null => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const round = (x: number | null, d = 2): number | null => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

function metric(value: number | null, previous: number | null, digits = 2): Metric {
  const v = round(value, digits);
  const p = round(previous, digits);
  return { value: v, previous: p, delta: v !== null && p !== null ? round(v - p, digits) : null };
}

function norm(w: Partial<RawWeek> | null | undefined): RawWeek {
  const x = w ?? {};
  return {
    total: num(x.total), missed: num(x.missed), answered: num(x.answered), booked: num(x.booked), not_booked: num(x.not_booked),
    escalated: num(x.escalated), answer_ms_avg: nul(x.answer_ms_avg), answer_ms_n: num(x.answer_ms_n),
    rating_avg: nul(x.rating_avg), rating_n: num(x.rating_n), wrong_reports: num(x.wrong_reports),
  };
}

export function buildScorecard(raw: RawScorecard): Scorecard {
  const c = norm(raw.current);
  const p = norm(raw.previous);
  const sec = (w: RawWeek) => (w.answer_ms_avg !== null && w.answer_ms_n > 0 ? w.answer_ms_avg / 1000 : null);
  return {
    weekStart: raw.week_start, weekEnd: raw.week_end, totalCalls: c.total,
    answeredCalls: metric(c.answered, p.answered, 0), missedCalls: metric(c.missed, p.missed, 0), bookings: metric(c.booked, p.booked, 0),
    bookingRate: metric(ratio(c.booked, c.booked + c.not_booked), ratio(p.booked, p.booked + p.not_booked), 3),
    escalationRate: metric(ratio(c.escalated, c.total), ratio(p.escalated, p.total), 3),
    answerSeconds: metric(sec(c), sec(p), 1),
    satisfaction: metric(c.rating_n > 0 ? c.rating_avg : null, p.rating_n > 0 ? p.rating_avg : null, 2),
    ratingSample: c.rating_n, satisfactionLowConfidence: c.rating_n > 0 && c.rating_n < MIN_RATING_SAMPLE,
    answerSpeedSample: c.answer_ms_n, wrongReports: c.wrong_reports, errorsMeasured: raw.errors_measured === true, hasData: c.total > 0,
  };
}

/** Monday (UTC) of the week containing `d`, as YYYY-MM-DD — matches date_trunc('week') in the RPC. */
export function weekStartUtc(d: Date): string {
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
}

// ---- PII scrub (mirror of public.scrub_pii; keep patterns in sync) -----------------------------------------------
export function scrubPii(text: string | null | undefined): string | null {
  const out = (text ?? '').slice(0, 2000)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[card]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]')
    .replace(/(?:\+?\d{1,2}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}/g, '[phone]')
    .replace(/\b\d{1,6}\s+(?:[A-Za-z0-9.]+\s+){1,3}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|place|pl)\b\.?/gi, '[address]');
  return out === '' ? null : out;
}
