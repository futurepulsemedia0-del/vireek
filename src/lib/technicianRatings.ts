/**
 * Technician Ratings — pure helpers (no network).
 *
 * The customer rates the TECHNICIAN after a job (1-5 + tags + comment) on the
 * same token-gated /review/:token page that already collects the overall
 * review. Data lives on `review_requests` (technician_* columns) and feeds:
 *   - technician_scorecards (tech_rating_* columns, via technicianPerformance.ts)
 *   - rule-based coaching notes (ratingCoachingNotes)
 *   - dispatch ranking (dispatchRatingBonus — small, bounded, shrunk toward a prior)
 *   - owner alerts (SQL trigger notify_low_technician_rating)
 *
 * Keep tag keys in sync with public.technician_rating_tags() in
 * supabase/migrations/20271101000000_technician_ratings.sql.
 */

export const POSITIVE_TAGS = [
  'on_time',
  'professional',
  'clear_communication',
  'clean_work',
  'knowledgeable',
  'friendly',
  'fair_price',
] as const;

export const NEGATIVE_TAGS = [
  'late',
  'rude',
  'messy',
  'poor_communication',
  'rushed',
  'upsold',
  'didnt_fix',
] as const;

export type TechnicianRatingTag = (typeof POSITIVE_TAGS)[number] | (typeof NEGATIVE_TAGS)[number];

export const TAG_LABELS: Record<TechnicianRatingTag, string> = {
  on_time: 'On time',
  professional: 'Professional',
  clear_communication: 'Clear communication',
  clean_work: 'Clean work',
  knowledgeable: 'Knowledgeable',
  friendly: 'Friendly',
  fair_price: 'Fair price',
  late: 'Arrived late',
  rude: 'Rude or dismissive',
  messy: 'Left a mess',
  poor_communication: 'Poor communication',
  rushed: 'Felt rushed',
  upsold: 'Pushy upselling',
  didnt_fix: "Didn't fix the problem",
};

export const MAX_TAGS = 6;
export const MAX_COMMENT_LENGTH = 500;
export const LOW_RATING_MAX = 2; // 1-2 stars trigger an owner alert (mirrors SQL)

const POSITIVE_SET = new Set<string>(POSITIVE_TAGS);
const NEGATIVE_SET = new Set<string>(NEGATIVE_TAGS);

export function isTechnicianRatingTag(value: string): value is TechnicianRatingTag {
  return POSITIVE_SET.has(value) || NEGATIVE_SET.has(value);
}

export function isNegativeTag(tag: string): boolean {
  return NEGATIVE_SET.has(tag);
}

export function tagLabel(tag: string): string {
  return isTechnicianRatingTag(tag) ? TAG_LABELS[tag] : tag.replace(/_/g, ' ');
}

/** 4-5 stars: positive tags; 1-2: negative tags; 3: both (mixed experience). */
export function tagsForRating(rating: number): TechnicianRatingTag[] {
  if (rating >= 4) return [...POSITIVE_TAGS];
  if (rating >= 1 && rating <= 2) return [...NEGATIVE_TAGS];
  if (rating === 3) return [...POSITIVE_TAGS, ...NEGATIVE_TAGS];
  return [];
}

/** Drops unknown/duplicate tags and tags not offered for the rating; caps at MAX_TAGS. */
export function sanitizeTags(tags: string[], rating: number): TechnicianRatingTag[] {
  const allowed = new Set<string>(tagsForRating(rating));
  const out: TechnicianRatingTag[] = [];
  for (const t of tags) {
    if (allowed.has(t) && !out.includes(t as TechnicianRatingTag)) out.push(t as TechnicianRatingTag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export interface TechnicianRatingValue {
  rating: number; // 0 = not rated
  tags: TechnicianRatingTag[];
  comment: string;
}

export const emptyTechnicianRating: TechnicianRatingValue = { rating: 0, tags: [], comment: '' };

export interface TagCount {
  tag: string;
  count: number;
}

export interface TechnicianRatingSummary {
  technician_id: string;
  responses: number;
  avg_rating: number;
  low_count: number;
  recent_avg: number | null;
  tags: TagCount[];
}

export interface RatedReview {
  technician_id?: string | null;
  technician_rating?: number | null;
  technician_tags?: string[] | null;
  technician_rated_at?: string | null;
}

export interface TechnicianRatingStats {
  responses: number;
  avg: number | null;
  lowCount: number;
  topTags: TagCount[];
}

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function countTags(tagLists: Array<string[] | null | undefined>): TagCount[] {
  const counts = new Map<string, number>();
  for (const list of tagLists) for (const t of list ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Aggregates one technician's rated reviews inside a window (scorecards). */
export function summarizeTechnicianRatings(
  reviews: RatedReview[],
  technicianId: string,
  inRange: (iso: string | null) => boolean = () => true,
): TechnicianRatingStats {
  const mine = reviews.filter(
    (r) =>
      r.technician_id === technicianId &&
      typeof r.technician_rating === 'number' &&
      r.technician_rating >= 1 &&
      inRange(r.technician_rated_at ?? null),
  );
  if (mine.length === 0) return { responses: 0, avg: null, lowCount: 0, topTags: [] };
  const sum = mine.reduce((s, r) => s + (r.technician_rating as number), 0);
  return {
    responses: mine.length,
    avg: round(sum / mine.length),
    lowCount: mine.filter((r) => (r.technician_rating as number) <= LOW_RATING_MAX).length,
    topTags: countTags(mine.map((r) => r.technician_tags)).slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Coaching (rule-based, same spirit as technicianPerformance.generateCoachingNotes)
// ---------------------------------------------------------------------------

const MIN_RESPONSES_FOR_COACHING = 3;
const COACHING_AVG_THRESHOLD = 4.2;
const STRENGTH_AVG_THRESHOLD = 4.7;
const STRENGTH_MIN_RESPONSES = 5;

const TAG_COACHING: Partial<Record<TechnicianRatingTag, string>> = {
  late: 'Send an ETA update as soon as a visit is running behind, and review route/time buffers with dispatch.',
  rude: 'Schedule a short customer-conduct coaching conversation; ride-alongs help pinpoint tone issues.',
  messy: 'Reinforce the leave-it-cleaner-than-you-found-it standard: drop cloths, shoe covers and a final walkthrough.',
  poor_communication: 'Walk the customer through findings and options before starting work, and again before leaving.',
  rushed: 'Check whether this technician is overbooked; allow time to explain the work instead of compressing visits.',
  upsold: 'Coach on presenting options neutrally (good / better / best) rather than pushing add-ons.',
  didnt_fix: 'Review these jobs for root-cause misses and pair with a senior technician on the affected service types.',
};

export function ratingCoachingNotes(stats: TechnicianRatingStats): Array<{ tip: string; basis: string }> {
  const notes: Array<{ tip: string; basis: string }> = [];
  if (stats.responses < 1 || stats.avg === null) return notes;

  if (stats.responses >= MIN_RESPONSES_FOR_COACHING && stats.avg < COACHING_AVG_THRESHOLD) {
    const worst = stats.topTags.find((t) => NEGATIVE_SET.has(t.tag) && t.count >= 2);
    if (worst) {
      notes.push({
        tip: TAG_COACHING[worst.tag as TechnicianRatingTag] ?? 'Review recent low-rated jobs with this technician.',
        basis: `"${tagLabel(worst.tag)}" was flagged ${worst.count} times; technician rating averages ${stats.avg}/5`,
      });
    } else {
      notes.push({
        tip: 'Review recent customer comments with this technician to find the common thread.',
        basis: `Technician rating averages ${stats.avg}/5 across ${stats.responses} responses, below ${COACHING_AVG_THRESHOLD}/5`,
      });
    }
  }

  if (stats.lowCount > 0) {
    notes.push({
      tip: 'Follow up on each 1-2 star rating within a few days — a recovery call often saves the customer and surfaces the root cause.',
      basis: `${stats.lowCount} rating${stats.lowCount === 1 ? '' : 's'} of 1-2 stars this period`,
    });
  }

  if (stats.responses >= STRENGTH_MIN_RESPONSES && stats.avg >= STRENGTH_AVG_THRESHOLD) {
    const best = stats.topTags.find((t) => POSITIVE_SET.has(t.tag));
    notes.push({
      tip: 'Strong customer feedback — consider this technician as a peer mentor or ride-along lead.',
      basis: `${stats.avg}/5 across ${stats.responses} responses${best ? `, most praised for "${tagLabel(best.tag)}"` : ''}`,
    });
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Dispatch preference
// ---------------------------------------------------------------------------

const PRIOR_MEAN = 4.4; // typical home-service average; ratings above it earn a bonus
const PRIOR_WEIGHT = 8; // pseudo-responses: a handful of ratings can't swing dispatch
const MAX_BONUS = 6;
const MAX_PENALTY = 8;

/** Effective rating: recent (30d) blended in, then shrunk toward the prior by sample size. */
export function effectiveRating(s: TechnicianRatingSummary): number {
  const blended = s.recent_avg !== null ? 0.6 * s.avg_rating + 0.4 * s.recent_avg : s.avg_rating;
  return (blended * s.responses + PRIOR_MEAN * PRIOR_WEIGHT) / (s.responses + PRIOR_WEIGHT);
}

/** Bounded score delta for suggestTechnicians (skill match is +10, so ratings refine rather than override). */
export function dispatchRatingBonus(s: TechnicianRatingSummary | undefined): number {
  if (!s || s.responses < 1) return 0;
  const raw = (effectiveRating(s) - PRIOR_MEAN) * 10;
  return Math.round(Math.max(-MAX_PENALTY, Math.min(MAX_BONUS, raw)));
}

export function dispatchRatingReason(s: TechnicianRatingSummary | undefined): string | null {
  if (!s || s.responses < 1) return null;
  const recent = s.recent_avg !== null ? `, last 30d ${s.recent_avg}` : '';
  return `Customer rating ${s.avg_rating}/5 (${s.responses} ${s.responses === 1 ? 'rating' : 'ratings'}${s.responses < 5 ? ', provisional' : ''}${recent})`;
}

export function buildRatingSummaryMap(rows: TechnicianRatingSummary[]): Record<string, TechnicianRatingSummary> {
  const map: Record<string, TechnicianRatingSummary> = {};
  for (const r of rows) map[r.technician_id] = r;
  return map;
}
