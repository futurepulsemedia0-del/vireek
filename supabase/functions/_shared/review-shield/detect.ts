// supabase/functions/_shared/review-shield/detect.ts
//
// Deterministic suspicion signals for review bursts. Every output is a SIGNAL
// ("pattern consistent with"), never a verdict. No I/O, no clock reads: callers
// pass `now`, so results are reproducible and the evidence pack can re-derive them.

import { tokenize } from "./text.ts";

export interface ShieldReview {
  id: string;
  platform: string;
  reviewerName: string;
  rating: number; // 1..5
  body: string | null;
  reviewedAt: string; // ISO
}

export interface BaselineOptions {
  windowHours?: number; // the "recent" window being tested, default 72
  lookbackDays?: number; // baseline horizon, default 180
  minBaselineDays?: number; // below this the baseline is flagged low-confidence, default 30
  floorRatePerDay?: number; // protects against a zero-history baseline, default 0.05
}

export interface Baseline {
  baselineDays: number;
  baselineReviews: number;
  ratePerDay: number; // effective rate used for the test (after floor)
  rawRatePerDay: number;
  lowRatingShare: number; // share of <=2-star reviews, Beta(1,9)-smoothed
  distribution: [number, number, number, number, number]; // counts for 1..5 stars
  jobsPerDay: number | null;
  reviewToJobRatio: number | null; // reviews per completed job in baseline
  lowConfidence: boolean;
  lowConfidenceReasons: ("short_history" | "few_reviews")[];
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const t = (iso: string): number => Date.parse(iso);

export function isLowRating(r: number): boolean {
  return r <= 2;
}

/**
 * Baseline over the lookback horizon, EXCLUDING the test window itself (otherwise an attack
 * would inflate its own baseline). Only reviews with a valid date are used.
 */
export function buildBaseline(
  reviews: ShieldReview[],
  completedJobDates: string[],
  now: Date,
  opts: BaselineOptions = {},
): Baseline {
  const windowMs = (opts.windowHours ?? 72) * HOUR;
  const lookbackDays = opts.lookbackDays ?? 180;
  const minDays = opts.minBaselineDays ?? 30;
  const floor = opts.floorRatePerDay ?? 0.05;

  const end = now.getTime() - windowMs;
  const horizonStart = now.getTime() - lookbackDays * DAY;
  const dated = reviews.filter((r) => Number.isFinite(t(r.reviewedAt)) && t(r.reviewedAt) <= now.getTime());
  const inBase = dated.filter((r) => t(r.reviewedAt) >= horizonStart && t(r.reviewedAt) < end);

  // History actually observable: from the oldest review we hold (capped at the horizon) to the window start.
  const oldest = dated.length ? Math.min(...dated.map((r) => t(r.reviewedAt))) : end;
  const start = Math.max(horizonStart, Math.min(oldest, end));
  const baselineDays = Math.max(0, (end - start) / DAY);

  const distribution: Baseline["distribution"] = [0, 0, 0, 0, 0];
  let low = 0;
  for (const r of inBase) {
    const i = Math.round(r.rating) - 1;
    if (i >= 0 && i < 5) distribution[i]++;
    if (isLowRating(r.rating)) low++;
  }
  const n = inBase.length;
  const rawRate = baselineDays > 0 ? n / baselineDays : 0;

  const jobsInBase = completedJobDates.filter((d) => t(d) >= start && t(d) < end).length;
  const reasons: Baseline["lowConfidenceReasons"] = [];
  if (baselineDays < minDays) reasons.push("short_history");
  if (n < 10) reasons.push("few_reviews");

  return {
    baselineDays,
    baselineReviews: n,
    ratePerDay: Math.max(rawRate, floor),
    rawRatePerDay: rawRate,
    lowRatingShare: (low + 1) / (n + 10),
    distribution,
    jobsPerDay: baselineDays > 0 ? jobsInBase / baselineDays : null,
    reviewToJobRatio: jobsInBase > 0 ? n / jobsInBase : null,
    lowConfidence: reasons.length > 0,
    lowConfidenceReasons: reasons,
  };
}

/** P(X >= k) for X ~ Poisson(mu). Stable for the small k we use. */
export function poissonTail(k: number, mu: number): number {
  if (k <= 0) return 1;
  if (mu <= 0) return 0;
  let term = Math.exp(-mu);
  let cdf = term; // P(X <= 0)
  for (let i = 1; i < k; i++) {
    term *= mu / i;
    cdf += term;
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}

/** P(Y >= k) for Y ~ Binomial(n, p). */
export function binomialTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let sum = 0;
  let c = 1; // C(n, 0)
  for (let i = 0; i <= n; i++) {
    if (i > 0) c = (c * (n - i + 1)) / i;
    if (i >= k) sum += c * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  return Math.max(0, Math.min(1, sum));
}

// ---- repeated wording -------------------------------------------------------

const MIN_TOKENS_FOR_SIMILARITY = 6;

function shingles(text: string | null, size = 3): Set<string> {
  const toks = tokenize(text);
  const out = new Set<string>();
  if (toks.length < MIN_TOKENS_FOR_SIMILARITY) return out;
  for (let i = 0; i + size <= toks.length; i++) out.add(toks.slice(i, i + size).join(" "));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface WordingCluster {
  reviewIds: string[];
  maxSimilarity: number;
}

/** Groups reviews whose wording overlaps heavily (word 3-gram Jaccard). Short texts are ignored: "great service" repeats naturally. */
export function findRepeatedWording(reviews: ShieldReview[], threshold = 0.5): WordingCluster[] {
  const sets = reviews.map((r) => shingles(r.body));
  const parent = reviews.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const best = new Map<number, number>();
  for (let i = 0; i < reviews.length; i++) {
    for (let j = i + 1; j < reviews.length; j++) {
      const s = jaccard(sets[i], sets[j]);
      if (s >= threshold) {
        parent[find(i)] = find(j);
        best.set(i, Math.max(best.get(i) ?? 0, s));
        best.set(j, Math.max(best.get(j) ?? 0, s));
      }
    }
  }
  const groups = new Map<number, number[]>();
  reviews.forEach((_, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  });
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => ({
      reviewIds: g.map((i) => reviews[i].id),
      maxSimilarity: Math.max(...g.map((i) => best.get(i) ?? 0)),
    }));
}

// ---- burst assessment -------------------------------------------------------

export type SignalCode =
  | "burst_volume"
  | "burst_low_rating"
  | "reviews_exceed_jobs"
  | "repeated_wording";

export interface Signal {
  code: SignalCode;
  strength: "moderate" | "strong";
  /** Numbers the UI interpolates into its i18n string, e.g. {observed: 7, expected: 0.4}. */
  params: Record<string, number>;
  reviewIds: string[];
}

export interface BurstAssessment {
  windowHours: number;
  windowStart: string;
  windowEnd: string;
  reviewsInWindow: number;
  lowRatingInWindow: number;
  completedJobsInWindow: number;
  expectedInWindow: number;
  volumePValue: number;
  lowRatingPValue: number;
  baseline: Baseline;
  signals: Signal[];
  /** "none" | "watch" | "elevated" | "high" — a prompt to look, not a finding. */
  level: "none" | "watch" | "elevated" | "high";
  /** True when the baseline is too thin for the numbers to carry weight (shown to the owner). */
  lowConfidence: boolean;
}

export function assessBurst(
  reviews: ShieldReview[],
  completedJobDates: string[],
  now: Date,
  opts: BaselineOptions = {},
): BurstAssessment {
  const windowHours = opts.windowHours ?? 72;
  const winStart = now.getTime() - windowHours * HOUR;
  const baseline = buildBaseline(reviews, completedJobDates, now, opts);

  const inWin = reviews.filter((r) => {
    const x = t(r.reviewedAt);
    return Number.isFinite(x) && x >= winStart && x <= now.getTime();
  });
  const low = inWin.filter((r) => isLowRating(r.rating));
  const jobsInWin = completedJobDates.filter((d) => t(d) >= winStart && t(d) <= now.getTime()).length;

  const mu = baseline.ratePerDay * (windowHours / 24);
  const volP = poissonTail(inWin.length, mu);
  const lowP = low.length > 0 ? binomialTail(low.length, inWin.length, baseline.lowRatingShare) : 1;

  const signals: Signal[] = [];
  if (inWin.length >= 3 && volP < 0.01) {
    signals.push({
      code: "burst_volume",
      strength: inWin.length >= 4 && volP < 0.001 ? "strong" : "moderate",
      params: { observed: inWin.length, expected: Math.round(mu * 100) / 100, hours: windowHours },
      reviewIds: inWin.map((r) => r.id),
    });
  }
  if (low.length >= 3 && lowP < 0.01) {
    signals.push({
      code: "burst_low_rating",
      strength: low.length >= 4 && lowP < 0.001 ? "strong" : "moderate",
      params: { lowRated: low.length, of: inWin.length, baselineSharePct: Math.round(baseline.lowRatingShare * 100) },
      reviewIds: low.map((r) => r.id),
    });
  }
  if (low.length >= 3 && low.length > jobsInWin) {
    signals.push({
      code: "reviews_exceed_jobs",
      strength: "moderate",
      params: { lowRated: low.length, completedJobs: jobsInWin },
      reviewIds: low.map((r) => r.id),
    });
  }
  const clusters = findRepeatedWording(inWin);
  for (const c of clusters) {
    signals.push({
      code: "repeated_wording",
      strength: c.reviewIds.length >= 3 ? "strong" : "moderate",
      params: { reviews: c.reviewIds.length, similarityPct: Math.round(c.maxSimilarity * 100) },
      reviewIds: c.reviewIds,
    });
  }

  const strong = signals.filter((s) => s.strength === "strong").length;
  const kinds = new Set(signals.map((s) => s.code)).size;
  let level: BurstAssessment["level"] = "none";
  if (signals.length > 0) level = "watch";
  if (kinds >= 2 || strong >= 1) level = "elevated";
  if (kinds >= 3 || (strong >= 1 && kinds >= 2)) level = "high";
  // A thin baseline can raise a prompt to look, but never a "high" read on its own.
  if (baseline.lowConfidence && level === "high") level = "elevated";

  return {
    windowHours,
    windowStart: new Date(winStart).toISOString(),
    windowEnd: now.toISOString(),
    reviewsInWindow: inWin.length,
    lowRatingInWindow: low.length,
    completedJobsInWindow: jobsInWin,
    expectedInWindow: mu,
    volumePValue: volP,
    lowRatingPValue: lowP,
    baseline,
    signals,
    level,
    lowConfidence: baseline.lowConfidence,
  };
}

/** Review counts per bucket (for the velocity chart in the evidence pack). */
export function velocitySeries(
  reviews: ShieldReview[],
  from: Date,
  to: Date,
  bucketHours = 24,
): { start: string; total: number; lowRated: number }[] {
  const step = bucketHours * HOUR;
  const out: { start: string; total: number; lowRated: number }[] = [];
  for (let s = from.getTime(); s < to.getTime(); s += step) {
    const inB = reviews.filter((r) => {
      const x = t(r.reviewedAt);
      return x >= s && x < s + step;
    });
    out.push({ start: new Date(s).toISOString(), total: inB.length, lowRated: inB.filter((r) => isLowRating(r.rating)).length });
  }
  return out;
}
