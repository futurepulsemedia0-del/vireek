/**
 * Revenue Causality Graph — pure model (no I/O, fully unit-tested).
 *
 * The database (compute_revenue_causality_graph RPC) only AGGREGATES this
 * account's own history into latency buckets: how many inbound opportunities
 * / quotes landed in each speed bucket and how many converted. Everything
 * economic — exposure, ranges, scenarios — is derived here from those
 * counts with a documented, deterministic method:
 *
 *  1. Per-bucket win rate is shrunk toward the account-wide rate
 *     (empirical-Bayes, K = SHRINK_K) so a bucket with 3 samples can't
 *     produce a wild number.
 *  2. The REFERENCE rate is the pooled rate of the fastest buckets that hold
 *     at least MIN_REF_N samples.
 *  3. Exposure of a slower bucket = n x max(0, reference - bucketRate).
 *     Low / high use +/- 1 standard error of the reference rate.
 *  4. wins x average job value = revenue; wins x value x (LTV multiplier - 1)
 *     = lost lifetime value (only when enough LTV profiles exist).
 *
 * This is an OBSERVATIONAL estimate (fast responders may also be the easier
 * leads), so every output carries a confidence level and the UI labels it
 * "estimated exposure" — never a guaranteed outcome.
 */

export type Confidence = 'low' | 'medium' | 'high';

// ---------- raw RPC payload ----------
export interface RawBucket { key: string; n: number; wins: number }
export interface RawQuoteBucket extends RawBucket { accepted_value: number; value_all: number }
export interface DeclineReason { reason: string; count: number; value: number }

export interface RcgData {
  window_days: number;
  computed_at: string | null;
  avg_job_value: number | null;
  ltv_multiplier: number | null;
  response: { buckets: RawBucket[]; missed_total: number; missed_unrecovered: number };
  quotes: {
    buckets: RawQuoteBucket[];
    accepted: number;
    declined: number;
    expired: number;
    lost_value: number;
    avg_value: number | null;
    median_response_hours: number | null;
    top_decline_reasons: DeclineReason[];
  };
  lost_leads: number;
}

// ---------- bucket definitions (single source of truth) ----------
export interface BucketDef { key: string; label: string; lo: number; hi: number }
export interface Bucket extends BucketDef { n: number; wins: number }

export const RESPONSE_BUCKETS: BucketDef[] = [
  { key: 'lt_30m', label: '< 30 min', lo: 0, hi: 0.5 },
  { key: '30m_1h', label: '30 min – 1 h', lo: 0.5, hi: 1 },
  { key: '1h_4h', label: '1 – 4 h', lo: 1, hi: 4 },
  { key: '4h_24h', label: '4 – 24 h', lo: 4, hi: 24 },
  { key: 'gte_24h', label: '24 h +', lo: 24, hi: Infinity },
];

export const QUOTE_BUCKETS: BucketDef[] = [
  { key: 'lt_4h', label: '< 4 h', lo: 0, hi: 4 },
  { key: '4h_24h', label: '4 – 24 h', lo: 4, hi: 24 },
  { key: '24h_72h', label: '1 – 3 days', lo: 24, hi: 72 },
  { key: 'gte_72h', label: '3 days +', lo: 72, hi: Infinity },
];

/** Targets we allow in scenarios = real bucket edges, so we never extrapolate past the evidence. */
export const RESPONSE_TARGETS = [
  { hours: 0.5, label: '30 minutes' },
  { hours: 1, label: '1 hour' },
  { hours: 4, label: '4 hours' },
  { hours: 24, label: '24 hours' },
];
export const QUOTE_TARGETS = [
  { hours: 4, label: '4 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
];

export const SHRINK_K = 5;
export const MIN_REF_N = 8;
const EPS = 1e-9;

// ---------- helpers ----------
const num = (v: unknown, d = 0): number => {
  const x = typeof v === 'string' ? Number(v) : (v as number);
  return typeof x === 'number' && Number.isFinite(x) ? x : d;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = typeof v === 'string' ? Number(v) : (v as number);
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
};

export function confidenceFromN(n: number): Confidence {
  if (n >= 60) return 'high';
  if (n >= 20) return 'medium';
  return 'low';
}
const weakest = (a: Confidence, b: Confidence): Confidence => {
  const order: Confidence[] = ['low', 'medium', 'high'];
  return order[Math.min(order.indexOf(a), order.indexOf(b))];
};

export function shrunkRate(wins: number, n: number, prior: number): number {
  return (wins + SHRINK_K * prior) / (n + SHRINK_K);
}

export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
}

// ---------- normalisation (never trust the wire) ----------
function fillBuckets(defs: BucketDef[], raw: RawBucket[] | undefined): Bucket[] {
  const byKey = new Map((raw ?? []).map((b) => [b.key, b]));
  return defs.map((d) => {
    const r = byKey.get(d.key);
    const n = Math.max(0, num(r?.n));
    return { ...d, n, wins: Math.min(n, Math.max(0, num(r?.wins))) };
  });
}

export function normalizeRcgData(raw: unknown): RcgData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const resp = r.response ?? {};
  const q = r.quotes ?? {};
  return {
    window_days: num(r.window_days, 180),
    computed_at: typeof r.computed_at === 'string' ? r.computed_at : null,
    avg_job_value: numOrNull(r.avg_job_value),
    ltv_multiplier: numOrNull(r.ltv_multiplier),
    response: {
      buckets: Array.isArray(resp.buckets) ? resp.buckets : [],
      missed_total: num(resp.missed_total),
      missed_unrecovered: num(resp.missed_unrecovered),
    },
    quotes: {
      buckets: Array.isArray(q.buckets) ? q.buckets : [],
      accepted: num(q.accepted),
      declined: num(q.declined),
      expired: num(q.expired),
      lost_value: num(q.lost_value),
      avg_value: numOrNull(q.avg_value),
      median_response_hours: numOrNull(q.median_response_hours),
      top_decline_reasons: Array.isArray(q.top_decline_reasons) ? q.top_decline_reasons : [],
    },
    lost_leads: num(r.lost_leads),
  };
}

// ---------- core simulation ----------
export interface Reference { rate: number; n: number; fallback: boolean; upToHours: number }
export interface Simulation {
  targetHours: number;
  reference: Reference | null;
  affectedN: number;
  wins: { expected: number; low: number; high: number };
  confidence: Confidence;
}

const EMPTY_SIM = (targetHours: number): Simulation => ({
  targetHours, reference: null, affectedN: 0, wins: { expected: 0, low: 0, high: 0 }, confidence: 'low',
});

/**
 * "If every opportunity were handled within `targetHours`, how many extra
 * wins would we expect?" `reach` (0..1) = share of opportunities where the
 * target is realistically achievable.
 */
export function simulateTarget(buckets: Bucket[], targetHours: number, reach = 1): Simulation {
  const totalN = buckets.reduce((s, b) => s + b.n, 0);
  const totalW = buckets.reduce((s, b) => s + b.wins, 0);
  if (totalN === 0) return EMPTY_SIM(targetHours);
  const prior = totalW / totalN;
  const sorted = [...buckets].sort((a, b) => a.lo - b.lo);

  let used = sorted.filter((b) => b.hi <= targetHours + EPS);
  let n = used.reduce((s, b) => s + b.n, 0);
  let fallback = false;
  if (n < MIN_REF_N) {
    // Only an explicit, too-thin target counts as a weak "fallback"; target 0 = "best evidenced speed" by design.
    fallback = targetHours > EPS;
    used = [];
    n = 0;
    for (const b of sorted) {
      used.push(b);
      n += b.n;
      if (n >= MIN_REF_N) break;
    }
    if (n < MIN_REF_N) return EMPTY_SIM(targetHours);
  }
  const upTo = Math.max(...used.map((b) => b.hi));
  const w = used.reduce((s, b) => s + b.wins, 0);
  const ref = shrunkRate(w, n, prior);
  const se = Math.sqrt((ref * (1 - ref)) / n);
  const refLow = Math.max(0, ref - se);
  const refHigh = Math.min(1, ref + se);

  const r = Math.min(1, Math.max(0, reach));
  let expected = 0, low = 0, high = 0, affectedN = 0;
  for (const b of sorted) {
    if (b.lo < upTo - EPS || b.n === 0) continue;
    const rate = shrunkRate(b.wins, b.n, prior);
    affectedN += b.n;
    expected += b.n * Math.max(0, ref - rate);
    low += b.n * Math.max(0, refLow - rate);
    high += b.n * Math.max(0, refHigh - rate);
  }
  const conf = weakest(confidenceFromN(n), confidenceFromN(affectedN));
  return {
    targetHours,
    reference: { rate: ref, n, fallback, upToHours: upTo },
    affectedN,
    wins: { expected: expected * r, low: low * r, high: high * r },
    confidence: fallback ? weakest(conf, 'low') : conf,
  };
}

/** Historical exposure = simulate against the best evidenced speed, at full reach. */
export const estimateExposure = (buckets: Bucket[]): Simulation => simulateTarget(buckets, 0, 1);

/** Opportunities that never got any follow-up vs. the touched baseline. */
export function simulateUnanswered(timed: Bucket[], neverN: number, neverWins: number): Simulation {
  const touchedN = timed.reduce((s, b) => s + b.n, 0);
  const touchedW = timed.reduce((s, b) => s + b.wins, 0);
  if (touchedN < MIN_REF_N || neverN === 0) return EMPTY_SIM(0);
  const base = touchedW / touchedN;
  const se = Math.sqrt((base * (1 - base)) / touchedN);
  const never = shrunkRate(neverWins, neverN, base);
  const gap = (ref: number) => neverN * Math.max(0, ref - never);
  return {
    targetHours: 0,
    reference: { rate: base, n: touchedN, fallback: false, upToHours: Infinity },
    affectedN: neverN,
    wins: { expected: gap(base), low: gap(Math.max(0, base - se)), high: gap(Math.min(1, base + se)) },
    confidence: weakest(confidenceFromN(touchedN), confidenceFromN(neverN)),
  };
}

// ---------- money ----------
export interface Money { expected: number; low: number; high: number }
const toMoney = (wins: Money, perWin: number | null): Money | null =>
  perWin && perWin > 0 ? { expected: wins.expected * perWin, low: wins.low * perWin, high: wins.high * perWin } : null;
const ltvOnly = (m: Money | null, mult: number | null): Money | null =>
  m && mult && mult > 1
    ? { expected: m.expected * (mult - 1), low: m.low * (mult - 1), high: m.high * (mult - 1) }
    : null;

// ---------- graph ----------
export type NodeId = 'missed_call' | 'delayed_response' | 'quote_delay' | 'hesitation' | 'lost_job' | 'lost_ltv';
export type EdgeKind = 'estimated' | 'realized' | 'derived';

export interface GraphNode { id: NodeId; label: string; headline: string; detail: string }
export interface GraphEdge {
  from: NodeId; to: NodeId; kind: EdgeKind; label: string;
  usd: Money | null; wins: number; sampleSize: number; confidence: Confidence | null;
}
export interface RevenueCausalityGraph {
  ready: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  totals: { revenue: Money; ltv: Money | null; wins: number } | null;
  narrative: string[];
  responseBuckets: Bucket[];
  quoteBuckets: Bucket[];
  neverBucket: { n: number; wins: number };
  notes: string[];
}

export function buildQuoteBuckets(d: RcgData): Bucket[] {
  return fillBuckets(QUOTE_BUCKETS, d.quotes.buckets);
}

export function buildRevenueCausalityGraph(d: RcgData): RevenueCausalityGraph {
  const notes: string[] = [];
  const rawResp = new Map(d.response.buckets.map((b) => [b.key, b]));
  const responseBuckets = fillBuckets(RESPONSE_BUCKETS, d.response.buckets);
  const never = { n: Math.max(0, num(rawResp.get('never')?.n)), wins: Math.max(0, num(rawResp.get('never')?.wins)) };
  const quoteBuckets = buildQuoteBuckets(d);

  const perWin = d.avg_job_value && d.avg_job_value > 0 ? d.avg_job_value : null;
  const quoteWin = d.quotes.avg_value && d.quotes.avg_value > 0 ? d.quotes.avg_value : perWin;
  if (!perWin) notes.push('Dollar impact needs completed jobs with invoice amounts in this window.');
  if (!d.ltv_multiplier) notes.push('Lifetime-value impact needs at least 10 customer LTV profiles.');

  const simMissed = simulateUnanswered(responseBuckets, never.n, never.wins);
  const simResp = estimateExposure(responseBuckets);
  const simQuote = estimateExposure(quoteBuckets);

  const mMissed = toMoney(simMissed.wins, perWin);
  const mResp = toMoney(simResp.wins, perWin);
  const mQuote = toMoney(simQuote.wins, quoteWin);

  const totalWins = simMissed.wins.expected + simResp.wins.expected + simQuote.wins.expected;
  const parts = [mMissed, mResp, mQuote].filter((m): m is Money => m !== null);
  const revenue: Money = parts.reduce(
    (a, m) => ({ expected: a.expected + m.expected, low: a.low + m.low, high: a.high + m.high }),
    { expected: 0, low: 0, high: 0 },
  );
  const ltv = perWin ? ltvOnly({ expected: totalWins * perWin, low: 0, high: 0 }, d.ltv_multiplier) : null;
  const ltvRange = ltv
    ? {
        expected: ltv.expected,
        low: (simMissed.wins.low + simResp.wins.low + simQuote.wins.low) * perWin! * ((d.ltv_multiplier ?? 1) - 1),
        high: (simMissed.wins.high + simResp.wins.high + simQuote.wins.high) * perWin! * ((d.ltv_multiplier ?? 1) - 1),
      }
    : null;

  const decided = d.quotes.accepted + d.quotes.declined + d.quotes.expired;
  const respN = responseBuckets.reduce((s, b) => s + b.n, 0) + never.n;
  const ready = respN >= MIN_REF_N || decided >= MIN_REF_N;
  if (!ready) notes.push('Not enough history yet — the graph appears once there are ~8+ resolved opportunities or quotes.');
  notes.push('Stages overlap, so the total is an upper-bound estimate, not a sum of guarantees.');

  const lostQuotes = d.quotes.declined + d.quotes.expired;
  const topReason = d.quotes.top_decline_reasons[0];

  const nodes: GraphNode[] = [
    {
      id: 'missed_call', label: 'Missed Call',
      headline: `${d.response.missed_total} missed`,
      detail: `${d.response.missed_unrecovered} never got a follow-up within 14 days.`,
    },
    {
      id: 'delayed_response', label: 'Delayed Response',
      headline: typicalBucketLabel(responseBuckets),
      detail: 'Typical time from inbound call to first recorded follow-up.',
    },
    {
      id: 'quote_delay', label: 'Quote Delay',
      headline: typicalBucketLabel(quoteBuckets),
      detail: 'Typical time from lead to quote sent.',
    },
    {
      id: 'hesitation', label: 'Customer Hesitation',
      headline: `${lostQuotes} quotes not accepted`,
      detail: topReason
        ? `Top reason: ${topReason.reason} (${topReason.count}).`
        : d.quotes.median_response_hours !== null
          ? `Customers take ~${d.quotes.median_response_hours.toFixed(0)} h to decide.`
          : 'No decline reasons recorded yet.',
    },
    {
      id: 'lost_job', label: 'Lost Job',
      headline: `${formatUsd(d.quotes.lost_value)} lost quotes`,
      detail: `${d.lost_leads} leads marked lost in the last ${d.window_days} days.`,
    },
    {
      id: 'lost_ltv', label: 'Lost LTV',
      headline: ltvRange ? formatUsd(ltvRange.expected) : '—',
      detail: ltvRange ? 'Repeat / lifetime value tied to the attributable lost jobs.' : 'Needs LTV profiles.',
    },
  ];

  const edges: GraphEdge[] = [
    {
      from: 'missed_call', to: 'delayed_response', kind: 'estimated', label: 'Unanswered calls',
      usd: mMissed, wins: simMissed.wins.expected, sampleSize: simMissed.affectedN, confidence: mMissed ? simMissed.confidence : null,
    },
    {
      from: 'delayed_response', to: 'quote_delay', kind: 'estimated', label: 'Response latency',
      usd: mResp, wins: simResp.wins.expected, sampleSize: simResp.affectedN, confidence: mResp ? simResp.confidence : null,
    },
    {
      from: 'quote_delay', to: 'hesitation', kind: 'estimated', label: 'Quote delay',
      usd: mQuote, wins: simQuote.wins.expected, sampleSize: simQuote.affectedN, confidence: mQuote ? simQuote.confidence : null,
    },
    {
      from: 'hesitation', to: 'lost_job', kind: 'realized', label: 'Quotes lost',
      usd: d.quotes.lost_value > 0 ? { expected: d.quotes.lost_value, low: d.quotes.lost_value, high: d.quotes.lost_value } : null,
      wins: lostQuotes, sampleSize: decided, confidence: decided ? confidenceFromN(decided) : null,
    },
    {
      from: 'lost_job', to: 'lost_ltv', kind: 'derived', label: 'Lost repeat value',
      usd: ltvRange, wins: totalWins, sampleSize: Math.round(totalWins), confidence: ltvRange ? 'low' : null,
    },
  ];

  const narrative = edges
    .filter((e) => e.kind === 'estimated' && e.usd && e.usd.expected > 0 && e.confidence)
    .map(
      (e) =>
        `${e.label} generated ${formatUsd(e.usd!.expected)} in estimated revenue exposure ` +
        `(range ${formatUsd(e.usd!.low)} – ${formatUsd(e.usd!.high)}, ${e.confidence} confidence).`,
    );

  return {
    ready, nodes, edges, narrative, responseBuckets, quoteBuckets, neverBucket: never, notes,
    totals: ready && parts.length ? { revenue, ltv: ltvRange, wins: totalWins } : null,
  };
}

function typicalBucketLabel(buckets: Bucket[]): string {
  const total = buckets.reduce((s, b) => s + b.n, 0);
  if (total === 0) return 'No data';
  let acc = 0;
  for (const b of [...buckets].sort((a, c) => a.lo - c.lo)) {
    acc += b.n;
    if (acc >= total / 2) return b.label;
  }
  return buckets[buckets.length - 1].label;
}

// ---------- scenario ("what if we respond in 30 min?") ----------
export interface ScenarioResult {
  sim: Simulation;
  revenue: Money | null;
  ltv: Money | null;
  currentTypical: string;
  evidence: string;
}

export function runScenario(
  buckets: Bucket[], targetHours: number, reach: number, perWin: number | null, ltvMultiplier: number | null,
): ScenarioResult {
  const sim = simulateTarget(buckets, targetHours, reach);
  const revenue = toMoney(sim.wins, perWin);
  const ltvAdd = revenue && ltvMultiplier && ltvMultiplier > 1 ? ltvOnly(revenue, ltvMultiplier) : null;
  const evidence = sim.reference
    ? `Based on ${sim.reference.n} opportunities handled ${
        sim.reference.fallback ? 'fastest' : `within ${formatHours(sim.reference.upToHours)}`
      } (${(sim.reference.rate * 100).toFixed(0)}% win rate) versus ${sim.affectedN} handled slower.`
    : 'Not enough fast-handled history to estimate this target yet.';
  return { sim, revenue, ltv: ltvAdd, currentTypical: typicalBucketLabel(buckets), evidence };
}

export function formatHours(h: number): string {
  if (!Number.isFinite(h)) return '∞';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}
