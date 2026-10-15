import { describe, expect, it } from 'vitest';
import {
  MIN_SAMPLE, buildCommentFeed, buildGroups, buildTrend, classify, dimensionKey, npsDelta, pickGranularity, scoreSentiment,
  splitPeriods, summarize, zoneOf, type FeedbackRecord, type Period,
} from '@/lib/feedbackAnalytics';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 5, 1); // Mon 2026-06-01
const period: Period = { from: T0, to: T0 + 28 * DAY };

let seq = 0;
const rec = (over: Partial<FeedbackRecord> & { rating: number }, dayOffset = 1): FeedbackRecord => ({
  source: 'review', feedback_id: `f${++seq}`, comment: null, responded_at: new Date(T0 + dayOffset * DAY).toISOString(),
  job_id: `j${seq}`, call_id: null, customer_name: 'Ana', technician_id: 't1', technician_name: 'Sam', service_type: 'AC repair',
  address: '1 Main St, Austin, TX 73301', postal_code: null, scheduled_datetime: null, lead_source: 'google_ads', ...over,
});

describe('classification and summary', () => {
  it('uses the 5-point NPS adaptation (5 promoter, 4 passive, 1-3 detractor)', () => {
    expect([5, 4, 3, 2, 1].map(classify)).toEqual(['promoter', 'passive', 'detractor', 'detractor', 'detractor']);
  });

  it('computes NPS, CSAT and average; empty input yields nulls, not NaN', () => {
    const s = summarize([5, 5, 4, 2].map((rating) => ({ rating })));
    expect(s).toMatchObject({ n: 4, promoters: 2, passives: 1, detractors: 1, nps: 25, csat: 75, avg: 4 });
    expect(summarize([])).toMatchObject({ n: 0, nps: null, csat: null, avg: null });
    expect(summarize([{ rating: 0 }, { rating: 9 }])).toMatchObject({ n: 0 }); // out-of-range ratings are ignored
  });
});

describe('dimensions', () => {
  it('derives the zone from the site ZIP, else the last 5-digit group of the address', () => {
    expect(zoneOf({ postal_code: '78701-1234', address: null })).toBe('78701');
    expect(zoneOf({ postal_code: null, address: '12345 Main St, Austin, TX 73301' })).toBe('73301');
    expect(zoneOf({ postal_code: null, address: '5 Elm St' })).toBeNull();
  });

  it('labels sources and groups missing values explicitly', () => {
    expect(dimensionKey(rec({ rating: 5, lead_source: 'google_ads' }), 'source').label).toBe('Google Ads');
    expect(dimensionKey(rec({ rating: 5, lead_source: null }), 'source').label).toBe('Unknown source');
    expect(dimensionKey(rec({ rating: 5, technician_id: null }), 'technician').label).toBe('Unassigned / no job');
    expect(dimensionKey(rec({ rating: 5, service_type: ' HVAC Tune-up ' }), 'service')).toEqual({ key: 'hvac tune-up', label: 'HVAC Tune-up' });
  });
});

describe('periods, deltas and trends', () => {
  const prevRecords = [5, 5, 5, 4, 1, 1].map((rating) => rec({ rating }, -10)); // previous 28 days → NPS 17
  const curRecords = [5, 5, 5, 5, 4, 1].map((rating) => rec({ rating }, 5)); // NPS 50

  it('splits the current and the equally long previous window and ignores older data', () => {
    const old = rec({ rating: 1 }, -100);
    const { current, previous } = splitPeriods([...curRecords, ...prevRecords, old], period);
    expect(current).toHaveLength(6);
    expect(previous).toHaveLength(6);
  });

  it('only reports a delta when both periods have enough responses', () => {
    const cur = summarize(curRecords), prev = summarize(prevRecords);
    expect(npsDelta(cur, prev)).toBe(33); // 50 − 17
    expect(npsDelta(summarize(curRecords.slice(0, MIN_SAMPLE - 1)), prev)).toBeNull();
  });

  it('builds a continuous weekly series with honest gaps', () => {
    expect(pickGranularity(period)).toBe('week');
    const trend = buildTrend([rec({ rating: 5 }, 1), rec({ rating: 1 }, 2), rec({ rating: 5 }, 22)], period);
    expect(trend).toHaveLength(4);
    expect(trend[0].summary).toMatchObject({ n: 2, nps: 0 });
    expect(trend[1].summary.nps).toBeNull();
    expect(trend[3].summary).toMatchObject({ n: 1, nps: 100 });
    expect(pickGranularity({ from: T0, to: T0 + 365 * DAY })).toBe('month');
  });
});

describe('buildGroups', () => {
  const records = [
    ...[5, 5, 5, 5, 4].map((rating) => rec({ rating, technician_id: 'a', technician_name: 'Alex' }, 3)),
    ...[1, 2, 3, 5, 1, 2].map((rating) => rec({ rating, technician_id: 'b', technician_name: 'Bo' }, 4)),
    rec({ rating: 5, technician_id: 'c', technician_name: 'Cy' }, 5), // single response: must never top a leaderboard
    ...[4, 4, 5, 5, 5, 3].map((rating) => rec({ rating, technician_id: 'a', technician_name: 'Alex' }, -5)),
  ];

  it('groups by technician with delta, low-sample flag and per-group trend', () => {
    const groups = buildGroups(records, 'technician', period);
    const alex = groups.find((g) => g.key === 'a')!;
    expect(alex.summary).toMatchObject({ n: 5, nps: 80 });
    expect(alex.previous.n).toBe(6);
    expect(alex.delta).toBe(47); // 80 − 33
    expect(alex.trend.length).toBe(4);
    expect(groups.find((g) => g.key === 'c')!.lowSample).toBe(true);
  });

  it('ranks reliable groups first when sorting by NPS', () => {
    const best = buildGroups(records, 'technician', period, 'nps_high');
    expect(best[0].key).toBe('a');
    expect(best[best.length - 1].key).toBe('c'); // 100 NPS but one response → last
    expect(buildGroups(records, 'technician', period, 'nps_low')[0].key).toBe('b');
  });
});

describe('sentiment', () => {
  it('reads plain positive and negative comments', () => {
    expect(scoreSentiment('Very professional and friendly, fixed it fast!', 5).label).toBe('positive');
    expect(scoreSentiment('Arrived late, rude, and overcharged us.', 1).label).toBe('negative');
  });

  it('handles negation', () => {
    expect(scoreSentiment('not happy with the work', 3).label).toBe('negative');
    expect(scoreSentiment('it was not bad at all', 4).label).toBe('positive');
  });

  it('falls back to the rating when the words are unknown, and to neutral for a middling 3', () => {
    expect(scoreSentiment('xyz qwerty', 1).label).toBe('negative');
    expect(scoreSentiment('xyz qwerty', 5).label).toBe('positive');
    expect(scoreSentiment('it was okay', 3).label).toBe('neutral');
    expect(scoreSentiment(null, 5).label).toBe('positive');
  });

  it('returns the matched words so the label is explainable', () => {
    expect(scoreSentiment('Great and professional', 5).signals).toEqual(['great', 'professional']);
  });
});

describe('buildCommentFeed', () => {
  const records = [
    rec({ rating: 5, comment: 'Amazing service, very professional' }, 1),
    rec({ rating: 1, comment: 'Late and rude, never again', customer_name: 'Zed' }, 3),
    rec({ rating: 4, comment: '   ' }, 2),
    rec({ rating: 3, comment: 'Fine I guess' }, 2),
  ];

  it('keeps only real comments, newest first, with sentiment', () => {
    const feed = buildCommentFeed(records);
    expect(feed.map((i) => i.record.comment)).toEqual(['Late and rude, never again', 'Fine I guess', 'Amazing service, very professional']);
    expect(feed[0]).toMatchObject({ npsClass: 'detractor' });
    expect(feed[0].sentiment.label).toBe('negative');
  });

  it('filters by sentiment, class and free-text (including customer name)', () => {
    expect(buildCommentFeed(records, { sentiment: 'positive' })).toHaveLength(1);
    expect(buildCommentFeed(records, { npsClass: 'detractor' }).map((i) => i.record.rating)).toEqual([1, 3]);
    expect(buildCommentFeed(records, { search: 'zed' })).toHaveLength(1);
  });
});
