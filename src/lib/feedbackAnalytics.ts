// src/lib/feedbackAnalytics.ts
//
// NPS / CSAT analytics — pure logic (no I/O), fully unit-tested.
//
// Scale note: both feedback sources (review_requests, call_feedback) collect a
// 1–5 rating, not the classic 0–10 NPS question. We use the standard 5-point
// adaptation: 5 = promoter, 4 = passive, 1–3 = detractor
// (NPS = %promoters − %detractors, range −100…100). CSAT = % of 4–5 ratings.
// The UI states this so nobody compares the number to a 0–10 benchmark blindly.

export type FeedbackSource = 'review' | 'call';
export type NpsClass = 'promoter' | 'passive' | 'detractor';
export type Dimension = 'technician' | 'service' | 'zone' | 'source';
export type Sentiment = 'positive' | 'neutral' | 'negative';

/** Below this many responses a score is shown but flagged as unreliable. */
export const MIN_SAMPLE = 5;

export interface FeedbackRecord {
  source: FeedbackSource;
  feedback_id: string;
  rating: number;
  comment: string | null;
  responded_at: string;
  job_id: string | null;
  call_id: string | null;
  customer_name: string | null;
  technician_id: string | null;
  technician_name: string | null;
  service_type: string | null;
  address: string | null;
  postal_code: string | null;
  scheduled_datetime: string | null;
  lead_source: string | null;
}

export const classify = (rating: number): NpsClass => (rating >= 5 ? 'promoter' : rating === 4 ? 'passive' : 'detractor');

// ------------------------------------------------------------------ summary

export interface Summary {
  n: number;
  promoters: number;
  passives: number;
  detractors: number;
  /** −100…100, null when there are no responses */
  nps: number | null;
  /** % of 4–5 ratings, 0…100 */
  csat: number | null;
  avg: number | null;
}

export function summarize(records: Pick<FeedbackRecord, 'rating'>[]): Summary {
  let promoters = 0, passives = 0, detractors = 0, total = 0, satisfied = 0;
  for (const r of records) {
    if (!(r.rating >= 1 && r.rating <= 5)) continue;
    total += r.rating;
    if (r.rating >= 4) satisfied++;
    const c = classify(r.rating);
    if (c === 'promoter') promoters++; else if (c === 'passive') passives++; else detractors++;
  }
  const n = promoters + passives + detractors;
  if (n === 0) return { n: 0, promoters, passives, detractors, nps: null, csat: null, avg: null };
  return {
    n, promoters, passives, detractors,
    nps: Math.round(((promoters - detractors) / n) * 100),
    csat: Math.round((satisfied / n) * 100),
    avg: Math.round((total / n) * 100) / 100,
  };
}

// --------------------------------------------------------------- dimensions

export const DIMENSION_LABELS: Record<Dimension, string> = { technician: 'Technician', service: 'Service', zone: 'Zone (ZIP)', source: 'Lead source' };

const SOURCE_LABELS: Record<string, string> = {
  google_ads: 'Google Ads', facebook_ads: 'Facebook Ads', referral: 'Referral', organic: 'Organic', direct: 'Direct', other: 'Other',
};

const titleCase = (s: string) => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** ZIP from the site's postal code, else the LAST 5-digit group in the address ("12345 Main St, Austin TX 73301" → 73301). */
export function zoneOf(r: Pick<FeedbackRecord, 'postal_code' | 'address'>): string | null {
  const direct = r.postal_code?.match(/\d{5}/)?.[0];
  if (direct) return direct;
  const all = [...(r.address ?? '').matchAll(/(?<!\d)(\d{5})(?:-\d{4})?(?!\d)/g)];
  return all.length ? all[all.length - 1][1] : null;
}

export function dimensionKey(r: FeedbackRecord, dim: Dimension): { key: string; label: string } {
  switch (dim) {
    case 'technician':
      return r.technician_id ? { key: r.technician_id, label: r.technician_name?.trim() || 'Unnamed technician' } : { key: '__none', label: 'Unassigned / no job' };
    case 'service': {
      const s = r.service_type?.trim();
      return s ? { key: s.toLowerCase(), label: s } : { key: '__none', label: 'Unknown service' };
    }
    case 'zone': {
      const z = zoneOf(r);
      return z ? { key: z, label: z } : { key: '__none', label: 'Unknown zone' };
    }
    case 'source': {
      const s = r.lead_source?.trim().toLowerCase();
      return s ? { key: s, label: SOURCE_LABELS[s] ?? titleCase(s) } : { key: '__none', label: 'Unknown source' };
    }
  }
}

// ------------------------------------------------------------------ periods

export interface Period { from: number; to: number } // epoch ms, [from, to)

export function splitPeriods(records: FeedbackRecord[], period: Period): { current: FeedbackRecord[]; previous: FeedbackRecord[] } {
  const span = period.to - period.from;
  const current: FeedbackRecord[] = [];
  const previous: FeedbackRecord[] = [];
  for (const r of records) {
    const t = Date.parse(r.responded_at);
    if (Number.isNaN(t)) continue;
    if (t >= period.from && t < period.to) current.push(r);
    else if (t >= period.from - span && t < period.from) previous.push(r);
  }
  return { current, previous };
}

/** NPS change vs the previous period; null unless BOTH periods have enough responses to mean something. */
export function npsDelta(current: Summary, previous: Summary): number | null {
  if (current.n < MIN_SAMPLE || previous.n < MIN_SAMPLE || current.nps === null || previous.nps === null) return null;
  return current.nps - previous.nps;
}

// ------------------------------------------------------------------ trends

export interface TrendPoint { start: number; label: string; summary: Summary }
export type Granularity = 'week' | 'month';

export const pickGranularity = (period: Period): Granularity => ((period.to - period.from) / 86_400_000 > 120 ? 'month' : 'week');

function bucketStart(ms: number, g: Granularity): number {
  const d = new Date(ms);
  if (g === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

function nextBucket(start: number, g: Granularity): number {
  const d = new Date(start);
  return g === 'month' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) : start + 7 * 86_400_000;
}

const bucketLabel = (start: number, g: Granularity) =>
  new Date(start).toLocaleDateString(undefined, g === 'month' ? { month: 'short', year: '2-digit', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Continuous series (empty buckets included, with nps = null) so charts show gaps honestly. */
export function buildTrend(records: FeedbackRecord[], period: Period, g: Granularity = pickGranularity(period)): TrendPoint[] {
  const buckets = new Map<number, FeedbackRecord[]>();
  for (let s = bucketStart(period.from, g); s < period.to; s = nextBucket(s, g)) buckets.set(s, []);
  for (const r of records) {
    const t = Date.parse(r.responded_at);
    if (Number.isNaN(t) || t < period.from || t >= period.to) continue;
    buckets.get(bucketStart(t, g))?.push(r);
  }
  return [...buckets.entries()].map(([start, rs]) => ({ start, label: bucketLabel(start, g), summary: summarize(rs) }));
}

// ------------------------------------------------------------------- groups

export interface GroupStat {
  key: string;
  label: string;
  summary: Summary;
  previous: Summary;
  delta: number | null;
  lowSample: boolean;
  trend: TrendPoint[];
}

export type GroupSort = 'responses' | 'nps_low' | 'nps_high';

export function buildGroups(records: FeedbackRecord[], dim: Dimension, period: Period, sort: GroupSort = 'responses', limit = 12): GroupStat[] {
  const { current, previous } = splitPeriods(records, period);
  const labels = new Map<string, string>();
  const cur = new Map<string, FeedbackRecord[]>();
  const prev = new Map<string, FeedbackRecord[]>();
  const add = (map: Map<string, FeedbackRecord[]>, r: FeedbackRecord) => {
    const { key, label } = dimensionKey(r, dim);
    labels.set(key, label);
    (map.get(key) ?? map.set(key, []).get(key)!).push(r);
  };
  current.forEach((r) => add(cur, r));
  previous.forEach((r) => add(prev, r));

  const g = pickGranularity(period);
  const stats: GroupStat[] = [...cur.entries()].map(([key, rs]) => {
    const summary = summarize(rs);
    const previousSummary = summarize(prev.get(key) ?? []);
    return {
      key, label: labels.get(key) ?? key, summary, previous: previousSummary,
      delta: npsDelta(summary, previousSummary), lowSample: summary.n < MIN_SAMPLE, trend: buildTrend(rs, period, g),
    };
  });

  const nps = (s: GroupStat) => s.summary.nps ?? 0;
  stats.sort((a, b) => {
    if (sort === 'responses') return b.summary.n - a.summary.n || a.label.localeCompare(b.label);
    // reliable groups first, so a 1-response "100" never tops the leaderboard
    if (a.lowSample !== b.lowSample) return a.lowSample ? 1 : -1;
    return (sort === 'nps_low' ? nps(a) - nps(b) : nps(b) - nps(a)) || b.summary.n - a.summary.n;
  });
  return stats.slice(0, limit);
}

// ---------------------------------------------------------------- sentiment

const POSITIVE = new Set(['great', 'excellent', 'amazing', 'awesome', 'fantastic', 'wonderful', 'perfect', 'professional', 'friendly', 'courteous', 'polite', 'helpful', 'knowledgeable', 'honest', 'fair', 'fast', 'quick', 'prompt', 'punctual', 'clean', 'tidy', 'thorough', 'reliable', 'trustworthy', 'recommend', 'love', 'loved', 'thank', 'thanks', 'happy', 'pleased', 'satisfied', 'impressed', 'best', 'efficient', 'solved', 'fixed', 'responsive', 'kind', 'careful', 'respectful']);
const NEGATIVE = new Set(['late', 'rude', 'unprofessional', 'terrible', 'horrible', 'awful', 'worst', 'bad', 'poor', 'disappointed', 'disappointing', 'angry', 'upset', 'frustrated', 'frustrating', 'expensive', 'overpriced', 'overcharged', 'scam', 'dirty', 'messy', 'broken', 'damaged', 'damage', 'ignored', 'waited', 'waiting', 'delay', 'delayed', 'slow', 'unreliable', 'refund', 'complaint', 'unhappy', 'wrong', 'mistake', 'incomplete', 'sloppy', 'careless', 'never', 'noshow']);
const NEGATORS = new Set(['not', 'no', 'never', "isn't", "wasn't", "don't", "didn't", "won't", "wouldn't", "couldn't", "can't", 'without', 'hardly']);
const INTENSIFIERS = new Set(['very', 'extremely', 'really', 'so', 'incredibly', 'absolutely', 'super']);

export interface SentimentResult { label: Sentiment; score: number; signals: string[] }

/**
 * Transparent lexicon + rating-prior sentiment. Deliberately simple and
 * explainable (the matched words are returned): it handles negation ("not
 * happy") and intensifiers, and blends in the star rating so a 1-star comment
 * with no recognizable words still reads as negative. Estimated, not exact.
 */
export function scoreSentiment(text: string | null, rating: number | null): SentimentResult {
  const prior = rating ? (rating - 3) / 2 : 0; // −1…1
  const words = (text ?? '').toLowerCase().replace(/[’]/g, "'").match(/[a-z']+/g) ?? [];
  let lex = 0;
  const signals: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] === 'no' && words[i + 1] === 'show' ? 'noshow' : words[i];
    let weight = POSITIVE.has(w) ? 1 : NEGATIVE.has(w) ? -1 : 0;
    if (!weight) continue;
    const before = words.slice(Math.max(0, i - 3), i);
    if (before.some((b) => INTENSIFIERS.has(b))) weight *= 1.5;
    const negated = before.some((b) => NEGATORS.has(b)) && w !== 'never';
    if (negated) weight *= -0.8;
    lex += weight;
    if (signals.length < 4) signals.push(negated ? `not ${w}` : w);
  }
  const lexNorm = Math.tanh(lex / 2); // −1…1, saturates
  const score = words.length === 0 ? prior : Math.max(-1, Math.min(1, lexNorm * 0.65 + prior * 0.35));
  return { label: score >= 0.2 ? 'positive' : score <= -0.2 ? 'negative' : 'neutral', score: Math.round(score * 100) / 100, signals };
}

// ------------------------------------------------------------------- feed

export interface FeedItem { record: FeedbackRecord; npsClass: NpsClass; sentiment: SentimentResult }

export interface FeedFilter { sentiment?: Sentiment | 'all'; npsClass?: NpsClass | 'all'; search?: string }

export function buildCommentFeed(records: FeedbackRecord[], filter: FeedFilter = {}, limit = 100): FeedItem[] {
  const q = filter.search?.trim().toLowerCase();
  return records
    .filter((r) => r.comment && r.comment.trim() !== '')
    .map((r) => ({ record: r, npsClass: classify(r.rating), sentiment: scoreSentiment(r.comment, r.rating) }))
    .filter((i) => (!filter.sentiment || filter.sentiment === 'all' || i.sentiment.label === filter.sentiment))
    .filter((i) => (!filter.npsClass || filter.npsClass === 'all' || i.npsClass === filter.npsClass))
    .filter((i) => !q || `${i.record.comment} ${i.record.customer_name ?? ''} ${i.record.technician_name ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => Date.parse(b.record.responded_at) - Date.parse(a.record.responded_at))
    .slice(0, limit);
}
