import { describe, it, expect } from 'vitest';
import type { Job, TeamMember } from '@/lib/supabase';
import { suggestTechnicians } from './dispatch';
import {
  buildRatingSummaryMap,
  dispatchRatingBonus,
  dispatchRatingReason,
  ratingCoachingNotes,
  sanitizeTags,
  summarizeTechnicianRatings,
  tagsForRating,
  type TechnicianRatingSummary,
} from './technicianRatings';

function summary(o: Partial<TechnicianRatingSummary> = {}): TechnicianRatingSummary {
  return { technician_id: 't1', responses: 10, avg_rating: 4.4, low_count: 0, recent_avg: null, tags: [], ...o };
}

describe('tags', () => {
  it('offers positive tags for 4-5, negative for 1-2, both for 3, none for 0', () => {
    expect(tagsForRating(5)).toContain('on_time');
    expect(tagsForRating(5)).not.toContain('late');
    expect(tagsForRating(2)).toContain('late');
    expect(tagsForRating(2)).not.toContain('on_time');
    expect(tagsForRating(3)).toEqual(expect.arrayContaining(['on_time', 'late']));
    expect(tagsForRating(0)).toEqual([]);
  });

  it('sanitizeTags drops unknown, duplicate and not-offered tags and caps at 6', () => {
    expect(sanitizeTags(['on_time', 'on_time', 'late', 'bogus'], 5)).toEqual(['on_time']);
    expect(sanitizeTags(['on_time', 'late'], 2)).toEqual(['late']);
    expect(sanitizeTags(['on_time'], 0)).toEqual([]);
    const all = tagsForRating(3);
    expect(sanitizeTags(all, 3)).toHaveLength(6);
  });
});

describe('summarizeTechnicianRatings', () => {
  const reviews = [
    { technician_id: 'a', technician_rating: 5, technician_tags: ['on_time', 'friendly'], technician_rated_at: '2026-10-01T00:00:00Z' },
    { technician_id: 'a', technician_rating: 1, technician_tags: ['late'], technician_rated_at: '2026-10-02T00:00:00Z' },
    { technician_id: 'a', technician_rating: 4, technician_tags: ['on_time'], technician_rated_at: '2026-08-01T00:00:00Z' },
    { technician_id: 'b', technician_rating: 3, technician_tags: [], technician_rated_at: '2026-10-02T00:00:00Z' },
    { technician_id: 'a', technician_rating: null, technician_tags: [], technician_rated_at: null },
  ];

  it('averages, counts low ratings and ranks tags for one technician', () => {
    const s = summarizeTechnicianRatings(reviews, 'a');
    expect(s.responses).toBe(3);
    expect(s.avg).toBe(3.33);
    expect(s.lowCount).toBe(1);
    expect(s.topTags[0]).toEqual({ tag: 'on_time', count: 2 });
  });

  it('respects the period window and returns empty stats when there are no ratings', () => {
    const inOct = (iso: string | null) => !!iso && iso >= '2026-10-01';
    expect(summarizeTechnicianRatings(reviews, 'a', inOct).responses).toBe(2);
    expect(summarizeTechnicianRatings(reviews, 'zzz')).toEqual({ responses: 0, avg: null, lowCount: 0, topTags: [] });
  });
});

describe('ratingCoachingNotes', () => {
  it('coaches on the most repeated negative tag when the average is low', () => {
    const notes = ratingCoachingNotes({ responses: 5, avg: 3.6, lowCount: 2, topTags: [{ tag: 'late', count: 3 }] });
    expect(notes[0].tip).toMatch(/ETA/);
    expect(notes[0].basis).toMatch(/Arrived late/);
    expect(notes.some((n) => /1-2 star/.test(n.tip))).toBe(true);
  });

  it('does not coach on tiny samples, and celebrates strong sustained ratings', () => {
    expect(ratingCoachingNotes({ responses: 2, avg: 3.0, lowCount: 0, topTags: [] })).toEqual([]);
    const strong = ratingCoachingNotes({ responses: 6, avg: 4.9, lowCount: 0, topTags: [{ tag: 'friendly', count: 4 }] });
    expect(strong).toHaveLength(1);
    expect(strong[0].basis).toMatch(/Friendly/);
    expect(ratingCoachingNotes({ responses: 0, avg: null, lowCount: 0, topTags: [] })).toEqual([]);
  });
});

describe('dispatchRatingBonus', () => {
  it('is neutral with no data and for a typical rating', () => {
    expect(dispatchRatingBonus(undefined)).toBe(0);
    expect(dispatchRatingBonus(summary({ responses: 0 }))).toBe(0);
    expect(dispatchRatingBonus(summary({ avg_rating: 4.4 }))).toBe(0);
  });

  it('shrinks small samples toward the prior and stays bounded', () => {
    const oneStar = dispatchRatingBonus(summary({ responses: 1, avg_rating: 1 }));
    const manyLow = dispatchRatingBonus(summary({ responses: 40, avg_rating: 3 }));
    expect(oneStar).toBeLessThan(0);
    expect(oneStar).toBeGreaterThan(manyLow);
    expect(manyLow).toBe(-8);
    expect(dispatchRatingBonus(summary({ responses: 80, avg_rating: 5, recent_avg: 5 }))).toBeLessThanOrEqual(6);
    expect(dispatchRatingBonus(summary({ responses: 80, avg_rating: 5, recent_avg: 5 }))).toBeGreaterThan(0);
  });

  it('describes the rating and flags provisional samples', () => {
    expect(dispatchRatingReason(undefined)).toBeNull();
    expect(dispatchRatingReason(summary({ responses: 3, avg_rating: 4.2, recent_avg: 4.5 }))).toBe(
      'Customer rating 4.2/5 (3 ratings, provisional, last 30d 4.5)',
    );
  });

  it('builds a lookup map by technician id', () => {
    expect(buildRatingSummaryMap([summary({ technician_id: 'x' })]).x.responses).toBe(10);
  });
});

describe('suggestTechnicians with ratings', () => {
  const job = { id: 'j1', service_type: 'plumbing', address: '1 Main St', scheduled_datetime: '2026-10-20T14:00:00Z' } as unknown as Job;
  const tech = (id: string, extra: Partial<TeamMember> = {}) =>
    ({ id, role: 'technician', dispatch_enabled: true, skills: ['plumbing'], max_jobs_per_day: 6, service_area: null, member_name: id, ...extra }) as unknown as TeamMember;

  it('prefers the better-rated technician when everything else is equal', () => {
    const ratings = {
      good: summary({ technician_id: 'good', responses: 40, avg_rating: 4.9, recent_avg: 4.9 }),
      bad: summary({ technician_id: 'bad', responses: 40, avg_rating: 3.2, recent_avg: 3.2 }),
    };
    const out = suggestTechnicians(job, [tech('bad'), tech('good')], {}, {}, {}, null, ratings);
    expect(out[0].technician.id).toBe('good');
    expect(out[0].reasons.some((r) => r.startsWith('Customer rating'))).toBe(true);
  });

  it('never hides a technician because of a poor rating (score floors at 0)', () => {
    const t = tech('only', { skills: [], max_jobs_per_day: 1 });
    const ratings = { only: summary({ technician_id: 'only', responses: 40, avg_rating: 2, recent_avg: 2 }) };
    const out = suggestTechnicians(job, [t], {}, {}, {}, null, ratings);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(0);
  });

  it('is unchanged without ratings', () => {
    const a = suggestTechnicians(job, [tech('a')], {});
    const b = suggestTechnicians(job, [tech('a')], {}, {}, {}, null, {});
    expect(a[0].score).toBe(b[0].score);
  });
});
