// supabase/functions/_shared/quote-truth/engine.ts
//
// Vireek Quote Truth Engine — deterministic core.
//
// Answers one question: "Is this quote actually reasonable — and what will it
// cost us in acceptance, margin and trust?"
//
// Design rules (same philosophy as check-margin-guardrail):
//   - Pure & deterministic: same input -> same report. No network, no Date.now(),
//     no randomness, no LLM. `input.now` is injected so results are reproducible
//     and unit-testable.
//   - Explainable: every number in the report traces back to a named anchor,
//     factor, finding or risk term. Nothing is a black box.
//   - Honest about evidence: the report carries a confidence score and a
//     data-quality block. When evidence is thin it says so instead of
//     inventing precision. It never fabricates "market data": the market side
//     is built ONLY from (a) competitor benchmarks the owner entered and (b)
//     k-anonymous network cohort stats.
//   - No imports, no Deno/DOM globals: usable from the edge function, from
//     Vitest, and (type-only) from the React app.

export const ENGINE_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TechnicianLevel = 'junior' | 'standard' | 'senior' | 'master';
export type Complexity = 'routine' | 'moderate' | 'complex' | 'emergency';
export type LineCategory = 'labor' | 'part' | 'travel' | 'fee' | 'bundle' | 'other';
export type Severity = 'info' | 'warning' | 'critical';
export type RiskLevel = 'low' | 'moderate' | 'high' | 'severe';
export type TruthVerdict =
  | 'well_priced'
  | 'fair'
  | 'high'
  | 'overpriced'
  | 'underpriced'
  | 'low_evidence';
export type ConfidenceLabel = 'low' | 'medium' | 'high';
export type AnchorKey = 'price_book' | 'history' | 'competitor' | 'cohort' | 'cost_plus';

export interface TruthLineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

export interface PriceBookEntry {
  service_name: string;
  category: string | null;
  keywords: string[];
  pricing_model: 'flat' | 'starting_at' | 'range' | 'hourly';
  price_cents: number;
  price_max_cents: number | null;
  estimated_cost_cents: number | null;
}

export interface HistoricalQuote {
  id: string;
  status: 'accepted' | 'declined' | 'expired' | 'sent' | 'draft';
  line_items: TruthLineItem[];
  created_at: string;
  customer_id: string | null;
}

export interface CustomerSignals {
  lifecycle_stage: 'lead' | 'active' | 'vip' | 'inactive' | null;
  completed_jobs: number;
  lifetime_revenue_cents: number;
  prior_accepted: number;
  prior_declined: number;
}

export interface EquipmentSignal {
  equipment_type: string;
  make: string | null;
  install_date: string | null;
  expected_lifespan_years: number;
  warranty_expires_at: string | null;
  status: 'active' | 'replaced' | 'removed';
}

export interface CompetitorBenchmark {
  service_keyword: string;
  region_label: string | null;
  low_cents: number;
  high_cents: number;
  source_label: string | null;
  observed_at: string;
}

export interface CohortSignals {
  contributor_count: number;
  ticket_p25_cents: number | null;
  ticket_p50_cents: number | null;
  ticket_p75_cents: number | null;
  acceptance_rate_p50_pct: number | null;
}

export interface TruthSettings {
  margin_floor_pct: number;
  default_cost_ratio_pct: number;
  /** Local price level vs. the reference market the network cohort represents. 1.00 = same. */
  regional_price_index: number;
  /** How far above the top of the expected range a quote may sit before it is called "overpriced". */
  max_premium_pct: number;
  region_label: string | null;
}

export interface TruthContext {
  technician_level: TechnicianLevel;
  complexity: Complexity;
  after_hours: boolean;
  travel_miles: number | null;
}

export interface TruthInput {
  /** ISO timestamp — injected for determinism. */
  now: string;
  quote: {
    line_items: TruthLineItem[];
    tax_percent: number;
    discount_type: 'percent' | 'flat' | null;
    discount_value: number | null;
    deposit_percent: number;
  };
  settings: TruthSettings;
  context: TruthContext;
  priceBook: PriceBookEntry[];
  history: HistoricalQuote[];
  customer: CustomerSignals | null;
  equipment: EquipmentSignal[];
  competitors: CompetitorBenchmark[];
  cohort: CohortSignals | null;
}

export interface Anchor {
  key: AnchorKey;
  label: string;
  low_cents: number;
  high_cents: number;
  /** Normalised blend weight (sums to 1 across anchors). */
  weight: number;
  detail: string;
}

export interface Factor {
  key: 'technician' | 'complexity' | 'after_hours' | 'travel' | 'region' | 'customer' | 'equipment' | 'warranty';
  label: string;
  applied: boolean;
  /** Approximate effect on the expected midpoint, in cents (signed). 0 for risk-side factors. */
  impact_cents: number;
  detail: string;
}

export interface Finding {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
  impact_cents: number | null;
}

export interface RiskTerm {
  label: string;
  logit_delta: number;
}

export interface PricePointEval {
  price_cents: number;
  acceptance_probability: number;
  overcharge_score: number;
  margin_pct: number | null;
  expected_profit_cents: number;
  feasible: boolean;
}

export interface CurvePoint {
  price_cents: number;
  acceptance_pct: number;
  expected_profit_cents: number | null;
  overcharge_score: number;
}

export interface TruthReport {
  engine_version: string;
  computed_at: string;
  redacted: boolean;
  verdict: TruthVerdict;
  headline: string;

  quote: {
    gross_cents: number;
    discount_cents: number;
    /** Price the customer actually pays before tax — the number everything is judged on. */
    subtotal_cents: number;
    line_count: number;
  };

  expected: {
    low_cents: number;
    high_cents: number;
    mid_cents: number;
    /** Where the quote sits vs. the expected midpoint (+0.12 = 12% above). */
    premium_pct: number;
    position: 'below_range' | 'within_range' | 'above_range' | 'far_above_range';
    confidence_score: number;
    confidence_label: ConfidenceLabel;
    anchors: Anchor[];
    factors: Factor[];
  };

  lines: {
    description: string;
    category: LineCategory;
    revenue_cents: number;
    matched_price_book: string | null;
    cost_source: 'price_book' | 'default_ratio' | null;
  }[];

  findings: Finding[];

  risk: {
    acceptance_probability: number;
    rejection_probability: number;
    rejection_band: [number, number];
    sensitivity: number;
    sensitivity_source: 'calibrated' | 'default';
    base_acceptance_rate: number;
    terms: RiskTerm[];
    overcharge_score: number;
    overcharge_level: RiskLevel;
    trust_score: number;
    overcharge_drivers: { label: string; points: number }[];
  };

  /** null when the viewer may not see cost data. */
  margin: {
    revenue_cents: number;
    estimated_cost_cents: number;
    margin_pct: number | null;
    floor_pct: number;
    headroom_cents: number;
    cost_coverage_pct: number;
  } | null;

  optimization: {
    action: 'hold' | 'raise' | 'lower';
    current: PricePointEval;
    recommended: PricePointEval;
    safe_min_cents: number;
    safe_max_cents: number;
    expected_profit_delta_cents: number | null;
    trust_drag: number;
    curve: CurvePoint[];
    note: string;
  };

  data_quality: {
    anchors_used: number;
    price_book_coverage_pct: number;
    cost_coverage_pct: number;
    similar_quotes_used: number;
    competitor_benchmarks_used: number;
    decided_quotes_for_base_rate: number;
    calibration: 'calibrated' | 'default';
    notes: string[];
  };
}

// ---------------------------------------------------------------------------
// Constants (all tunable in one place; documented so they can be audited)
// ---------------------------------------------------------------------------

const HISTORY_WINDOW_DAYS = 730;
const INFLATION_PER_YEAR = 0.03;
const MIN_SIMILARITY = 0.3;
const MIN_HISTORY_SAMPLES = 3;
const FULL_HISTORY_SAMPLES = 8;
const DEFAULT_SENSITIVITY = 3.2;
const MIN_SENSITIVITY = 1.5;
const MAX_SENSITIVITY = 8;
const BASE_RATE_PRIOR_STRENGTH = 10;
const CALIBRATION_MIN_DECIDED = 12;
const CALIBRATION_MIN_GROUP = 4;
const PARTS_MARKUP_WARN = 2.5;
const FEE_SHARE_WARN = 0.12;
const TRAVEL_BASE_ALLOWANCE_CENTS = 9500;
const TRAVEL_FREE_MILES = 20;
const TRAVEL_CENTS_PER_MILE = 150;
const TRUST_DRAG = 0.3;
const SEVERE_OVERCHARGE = 65;
const WEIGHTS: Record<AnchorKey, number> = {
  price_book: 0.5,
  history: 0.4,
  competitor: 0.3,
  cohort: 0.06,
  cost_plus: 0.1,
};

const TECH_MULT: Record<TechnicianLevel, number> = { junior: 0.94, standard: 1, senior: 1.06, master: 1.12 };
const COMPLEXITY_MULT: Record<Complexity, number> = { routine: 1, moderate: 1.05, complex: 1.12, emergency: 1.2 };
const AFTER_HOURS_MULT = 1.12;
const MAX_CONTEXT_MULT = 1.45;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'per', 'new', 'incl', 'includes', 'including', 'labor', 'labour',
  'service', 'services', 'work', 'job', 'unit', 'each', 'set', 'kit', 'inc', 'plus',
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = Math.round;
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(p / (1 - p));
const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : fallback);

export function usd(cents: number): string {
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  const s = abs >= 100 ? Math.round(abs).toLocaleString('en-US') : abs.toFixed(2);
  return `${dollars < 0 ? '-' : ''}$${s}`;
}

function daysBetween(nowMs: number, iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / 86_400_000;
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith('s') ? raw.slice(0, -1) : raw);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function weightedQuantile(items: { v: number; w: number }[], q: number): number {
  const sorted = [...items].sort((x, y) => x.v - y.v);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  if (total <= 0 || sorted.length === 0) return NaN;
  const target = q * total;
  let cum = 0;
  for (const x of sorted) {
    cum += x.w;
    if (cum >= target) return x.v;
  }
  return sorted[sorted.length - 1].v;
}

const TRAVEL_RE = /\b(trip|travel|mileage|dispatch|fuel|truck charge)\b/;
const FEE_RE = /\b(permit|disposal|haul|hauling|environmental|shop suppl\w*|supplies|misc\w*|processing|admin\w*|convenience|surcharge|fee)\b/;
const LABOR_RE = /\b(labou?r|hours?|hrs?|install\w*|repair\w*|diagnos\w*|service|tune-?up|maintenance|cleaning|inspection|troubleshoot\w*)\b/;
const PART_RE = /\b(parts?|materials?|filter|capacitor|motor|compressor|valve|pump|coil|thermostat|breaker|panel|pipe|fixture|heater|tank|refrigerant|freon|contactor|igniter|blower|board|module|fan|unit|system|furnace|condenser|equipment)\b/;
const REPLACEMENT_RE = /\b(replace\w*|swap\w*|new (unit|system|install\w*|furnace|heater|condenser|water heater))\b/;

export function classifyLine(description: string): LineCategory {
  const d = description.toLowerCase();
  if (TRAVEL_RE.test(d)) return 'travel';
  if (FEE_RE.test(d)) return 'fee';
  const labor = LABOR_RE.test(d);
  const part = PART_RE.test(d);
  if (labor && part) return 'bundle';
  if (labor) return 'labor';
  if (part) return 'part';
  return 'other';
}

interface AnalyzedLine {
  description: string;
  quantity: number;
  unit_price_cents: number;
  revenue_cents: number;
  category: LineCategory;
  cost_cents: number;
  cost_source: 'price_book' | 'default_ratio';
  match: { entry: PriceBookEntry; score: number } | null;
}

function matchPriceBook(description: string, items: PriceBookEntry[]): { entry: PriceBookEntry; score: number } | null {
  const desc = description.toLowerCase().trim();
  if (!desc) return null;
  const descTokens = tokenize(desc);
  let best: { entry: PriceBookEntry; score: number } | null = null;
  for (const entry of items) {
    const name = entry.service_name.toLowerCase().trim();
    let score = 0;
    if (name && name === desc) score = 1;
    else if (name && desc.includes(name)) score = 0.9;
    else if ((entry.keywords ?? []).some((kw) => kw.trim() && desc.includes(kw.toLowerCase().trim()))) score = 0.8;
    else score = jaccard(descTokens, tokenize(name)) * 0.8;
    if (score >= 0.5 && (!best || score > best.score)) best = { entry, score };
  }
  return best;
}

function quoteText(lines: { description: string }[]): string {
  return lines.map((l) => l.description).join(' ');
}

function lineItemsSubtotal(lines: TruthLineItem[]): number {
  return lines.reduce((s, l) => s + num(l.quantity) * num(l.unit_price_cents), 0);
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

interface RawAnchor extends Omit<Anchor, 'weight'> {
  raw_weight: number;
}

function priceBookAnchor(lines: AnalyzedLine[], gross: number): { anchor: RawAnchor | null; coverage: number } {
  let low = 0;
  let high = 0;
  let matchedRevenue = 0;
  let matchedCount = 0;
  for (const l of lines) {
    if (!l.match) {
      low += l.revenue_cents * 0.92;
      high += l.revenue_cents * 1.08;
      continue;
    }
    const e = l.match.entry;
    const q = Math.max(0, l.quantity);
    let unitLow = e.price_cents;
    let unitHigh = e.price_cents;
    switch (e.pricing_model) {
      case 'flat': unitLow = e.price_cents * 0.95; unitHigh = e.price_cents * 1.08; break;
      case 'starting_at': unitLow = e.price_cents; unitHigh = e.price_cents * 1.6; break;
      case 'range': unitLow = e.price_cents; unitHigh = Math.max(e.price_cents, e.price_max_cents ?? e.price_cents); break;
      case 'hourly': unitLow = e.price_cents * 0.9; unitHigh = e.price_cents * 1.15; break;
    }
    low += unitLow * q;
    high += unitHigh * q;
    matchedRevenue += l.revenue_cents;
    matchedCount++;
  }
  const coverage = gross > 0 ? clamp(matchedRevenue / gross, 0, 1) : 0;
  if (matchedCount === 0) return { anchor: null, coverage: 0 };
  return {
    coverage,
    anchor: {
      key: 'price_book',
      label: 'Your Price Book',
      low_cents: round(low),
      high_cents: round(high),
      raw_weight: WEIGHTS.price_book * coverage,
      detail: `${matchedCount} of ${lines.length} line items matched a Price Book entry (${round(coverage * 100)}% of quote value).`,
    },
  };
}

interface SimilarQuote {
  q: HistoricalQuote;
  subtotal: number;
  sim: number;
  ageWeight: number;
  adjusted: number;
}

function findSimilar(text: string, history: HistoricalQuote[], nowMs: number, statuses: string[]): SimilarQuote[] {
  const target = tokenize(text);
  const out: SimilarQuote[] = [];
  for (const q of history) {
    if (!statuses.includes(q.status)) continue;
    const age = daysBetween(nowMs, q.created_at);
    if (age === null || age > HISTORY_WINDOW_DAYS || age < 0) continue;
    const subtotal = lineItemsSubtotal(q.line_items ?? []);
    if (!(subtotal > 0)) continue;
    const sim = jaccard(target, tokenize(quoteText(q.line_items ?? [])));
    if (sim < MIN_SIMILARITY) continue;
    out.push({
      q,
      subtotal,
      sim,
      ageWeight: Math.pow(0.5, age / 365),
      adjusted: subtotal * (1 + INFLATION_PER_YEAR * (age / 365)),
    });
  }
  return out;
}

function historyAnchor(similarAccepted: SimilarQuote[]): RawAnchor | null {
  const n = similarAccepted.length;
  if (n < MIN_HISTORY_SAMPLES) return null;
  const pts = similarAccepted.map((s) => ({ v: s.adjusted, w: s.sim * s.ageWeight }));
  let low = weightedQuantile(pts, 0.25);
  let high = weightedQuantile(pts, 0.75);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  const widen = Math.max(0, FULL_HISTORY_SAMPLES - n) * 0.015;
  low *= 1 - widen;
  high *= 1 + widen;
  return {
    key: 'history',
    label: 'Your accepted quotes',
    low_cents: round(low),
    high_cents: round(Math.max(high, low)),
    raw_weight: WEIGHTS.history * Math.min(1, n / FULL_HISTORY_SAMPLES),
    detail: `${n} similar accepted quotes in the last 24 months (inflation-adjusted, recency-weighted).`,
  };
}

function competitorAnchor(
  competitors: CompetitorBenchmark[],
  text: string,
  regionLabel: string | null,
  nowMs: number,
): { anchor: RawAnchor | null; used: number } {
  const quoteTokens = tokenize(text);
  const region = regionLabel?.trim().toLowerCase() || null;
  const matched: { low: number; high: number; w: number; source: string | null }[] = [];
  for (const c of competitors) {
    const kw = tokenize(c.service_keyword);
    if (kw.size === 0) continue;
    let all = true;
    for (const t of kw) if (!quoteTokens.has(t)) { all = false; break; }
    if (!all) continue;
    const cRegion = c.region_label?.trim().toLowerCase() || null;
    if (cRegion && region && cRegion !== region) continue;
    const age = daysBetween(nowMs, c.observed_at);
    if (age === null || age < 0) continue;
    const fresh = Math.pow(0.5, age / 365);
    if (fresh < 0.1) continue;
    if (!(c.high_cents >= c.low_cents && c.low_cents > 0)) continue;
    matched.push({ low: c.low_cents, high: c.high_cents, w: fresh, source: c.source_label });
  }
  if (matched.length === 0) return { anchor: null, used: 0 };
  const total = matched.reduce((s, m) => s + m.w, 0);
  const low = matched.reduce((s, m) => s + m.low * m.w, 0) / total;
  const high = matched.reduce((s, m) => s + m.high * m.w, 0) / total;
  const avgFresh = total / matched.length;
  return {
    used: matched.length,
    anchor: {
      key: 'competitor',
      label: 'Competitor benchmark',
      low_cents: round(low),
      high_cents: round(high),
      raw_weight: WEIGHTS.competitor * avgFresh,
      detail: `${matched.length} benchmark${matched.length === 1 ? '' : 's'} you entered for this kind of job, freshness-weighted.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Risk model
// ---------------------------------------------------------------------------

interface RiskModelParams {
  baseLogit: number;
  sensitivity: number;
  staticTerms: RiskTerm[];
  mid: number;
  high: number;
  costCents: number;
  floorPct: number;
  staticOverchargePoints: { label: string; points: number }[];
  loyalCustomer: boolean;
}

function ticketTerm(net: number): RiskTerm | null {
  if (net >= 1_000_000) return { label: 'Very large ticket (≥ $10,000)', logit_delta: -0.5 };
  if (net >= 500_000) return { label: 'Large ticket (≥ $5,000)', logit_delta: -0.25 };
  if (net >= 200_000) return { label: 'Sizeable ticket (≥ $2,000)', logit_delta: -0.1 };
  return null;
}

function buildRiskModel(p: RiskModelParams) {
  const acceptance = (net: number): number => {
    const premium = p.mid > 0 ? (net - p.mid) / p.mid : 0;
    let z = p.baseLogit - p.sensitivity * premium;
    for (const t of p.staticTerms) z += t.logit_delta;
    const tt = ticketTerm(net);
    if (tt) z += tt.logit_delta;
    return clamp(sigmoid(z), 0.03, 0.97);
  };

  const overchargeDrivers = (net: number): { label: string; points: number }[] => {
    const out: { label: string; points: number }[] = [...p.staticOverchargePoints];
    const excess = p.high > 0 ? net / p.high - 1 : 0;
    const premium = p.mid > 0 ? (net - p.mid) / p.mid : 0;
    if (excess > 0) out.push({ label: 'Priced above the top of the expected range', points: clamp(excess * 250, 0, 45) });
    else if (premium > 0) out.push({ label: 'Priced above the expected midpoint', points: clamp(premium * 40, 0, 8) });
    if (p.loyalCustomer && premium > 0.08) {
      out.push({ label: 'Loyal customer paying a premium', points: 8 });
    }
    return out.filter((d) => d.points > 0);
  };

  const overcharge = (net: number): number =>
    clamp(round(overchargeDrivers(net).reduce((s, d) => s + d.points, 0)), 0, 100);

  const evalAt = (net: number): PricePointEval => {
    const price = Math.max(0, round(net));
    const pAcc = acceptance(price);
    const over = overcharge(price);
    const marginCents = price - p.costCents;
    const marginPct = price > 0 ? (marginCents / price) * 100 : null;
    const feasible = marginPct !== null && marginPct >= p.floorPct;
    const expectedProfit = pAcc * marginCents * (1 - TRUST_DRAG * (over / 100));
    return {
      price_cents: price,
      acceptance_probability: round(pAcc * 1000) / 1000,
      overcharge_score: over,
      margin_pct: marginPct === null ? null : round(marginPct * 10) / 10,
      expected_profit_cents: round(expectedProfit),
      feasible,
    };
  };

  return { acceptance, overchargeDrivers, overcharge, evalAt };
}

function overchargeLevel(score: number): RiskLevel {
  if (score < 20) return 'low';
  if (score < 40) return 'moderate';
  if (score < SEVERE_OVERCHARGE) return 'high';
  return 'severe';
}

function niceRound(cents: number): number {
  const step = cents >= 100_000 ? 2500 : cents >= 20_000 ? 500 : 100;
  return Math.max(step, round(cents / step) * step);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function analyzeQuote(input: TruthInput): TruthReport {
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error('Invalid "now" timestamp.');

  const rawLines = (input.quote.line_items ?? []).filter(
    (l) => l && Number.isFinite(num(l.quantity)) && Number.isFinite(num(l.unit_price_cents)),
  );
  if (rawLines.length === 0) throw new Error('Quote has no line items to analyze.');

  const settings = input.settings;
  const defaultRatio = clamp(num(settings.default_cost_ratio_pct, 55), 0, 100) / 100;
  const floorPct = clamp(num(settings.margin_floor_pct, 20), 0, 95);
  const maxPremium = clamp(num(settings.max_premium_pct, 12), 0, 100) / 100;
  const regionIndex = clamp(num(settings.regional_price_index, 1), 0.5, 2);
  const notes: string[] = [];

  // ---- 1. Analyse lines -----------------------------------------------------
  const lines: AnalyzedLine[] = rawLines.map((l) => {
    const quantity = num(l.quantity);
    const unit = num(l.unit_price_cents);
    const revenue = round(quantity * unit);
    const description = String(l.description ?? '').trim();
    const match = matchPriceBook(description, input.priceBook);
    const realCost = match?.entry.estimated_cost_cents;
    const hasReal = realCost !== null && realCost !== undefined;
    return {
      description,
      quantity,
      unit_price_cents: unit,
      revenue_cents: revenue,
      category: classifyLine(description),
      cost_cents: hasReal ? round((realCost as number) * (quantity || 1)) : round(Math.max(0, revenue) * defaultRatio),
      cost_source: hasReal ? 'price_book' : 'default_ratio',
      match,
    };
  });

  const gross = lines.reduce((s, l) => s + l.revenue_cents, 0);
  if (!(gross > 0)) throw new Error('Quote total must be greater than zero to analyze.');

  let discount = 0;
  if (input.quote.discount_type === 'percent' && num(input.quote.discount_value) > 0) {
    discount = round(gross * (clamp(num(input.quote.discount_value), 0, 100) / 100));
  } else if (input.quote.discount_type === 'flat' && num(input.quote.discount_value) > 0) {
    discount = round(num(input.quote.discount_value) * 100);
  }
  const net = Math.max(0, gross - discount);
  const totalCost = lines.reduce((s, l) => s + l.cost_cents, 0);
  const realCostRevenue = lines.filter((l) => l.cost_source === 'price_book').reduce((s, l) => s + Math.max(0, l.revenue_cents), 0);
  const costCoverage = gross > 0 ? clamp(realCostRevenue / gross, 0, 1) : 0;
  const text = quoteText(lines);
  const textTokens = tokenize(text);
  const isReplacement = REPLACEMENT_RE.test(text.toLowerCase());

  // ---- 2. Anchors -----------------------------------------------------------
  const rawAnchors: RawAnchor[] = [];

  const pb = priceBookAnchor(lines, gross);
  if (pb.anchor) rawAnchors.push(pb.anchor);

  const similarAll = findSimilar(text, input.history, nowMs, ['accepted', 'declined', 'expired']);
  const similarAccepted = similarAll.filter((s) => s.q.status === 'accepted');
  const hist = historyAnchor(similarAccepted);
  if (hist) rawAnchors.push(hist);

  const comp = competitorAnchor(input.competitors, text, settings.region_label, nowMs);
  if (comp.anchor) rawAnchors.push(comp.anchor);

  let cohortUsed = false;
  if (
    input.cohort &&
    input.cohort.ticket_p25_cents !== null &&
    input.cohort.ticket_p75_cents !== null &&
    rawAnchors.length > 0
  ) {
    cohortUsed = true;
    rawAnchors.push({
      key: 'cohort',
      label: 'Network cohort (avg ticket)',
      low_cents: round(input.cohort.ticket_p25_cents * regionIndex),
      high_cents: round(input.cohort.ticket_p75_cents * regionIndex),
      raw_weight: WEIGHTS.cohort,
      detail: `Anonymised P25–P75 average ticket across ${input.cohort.contributor_count}+ businesses, scaled by your regional index (${regionIndex.toFixed(2)}×). Context only — whole-business tickets are a weak anchor for a single job.`,
    });
  }

  const targetMargin = clamp(Math.max(floorPct + 12, 35), 0, 70) / 100;
  const costPlusMid = totalCost / (1 - targetMargin);
  rawAnchors.push({
    key: 'cost_plus',
    label: 'Cost-plus estimate',
    low_cents: round(costPlusMid * 0.85),
    high_cents: round(costPlusMid * 1.15),
    raw_weight: costCoverage >= 0.5 ? WEIGHTS.cost_plus : 0.04,
    detail: `Estimated cost ÷ (1 − ${round(targetMargin * 100)}% target margin), ±15%. ${costCoverage >= 0.5 ? 'Built mostly from real Price Book costs.' : 'Built mostly from your default cost ratio — add real costs to the Price Book to sharpen it.'}`,
  });

  const totalRaw = rawAnchors.reduce((s, a) => s + a.raw_weight, 0);
  const anchors: Anchor[] = rawAnchors.map((a) => ({
    key: a.key,
    label: a.label,
    low_cents: a.low_cents,
    high_cents: a.high_cents,
    weight: totalRaw > 0 ? Math.round((a.raw_weight / totalRaw) * 1000) / 1000 : 0,
    detail: a.detail,
  }));

  let low = rawAnchors.reduce((s, a) => s + a.low_cents * a.raw_weight, 0) / totalRaw;
  let high = rawAnchors.reduce((s, a) => s + a.high_cents * a.raw_weight, 0) / totalRaw;

  const confidenceScore = clamp(totalRaw / 0.9, 0, 1);
  const confidenceLabel: ConfidenceLabel = confidenceScore >= 0.75 ? 'high' : confidenceScore >= 0.45 ? 'medium' : 'low';

  // ---- 3. Property / context adjustment --------------------------------------
  const factors: Factor[] = [];
  const baseMid = (low + high) / 2;

  const tMult = TECH_MULT[input.context.technician_level] ?? 1;
  const cMult = COMPLEXITY_MULT[input.context.complexity] ?? 1;
  const ahMult = input.context.after_hours ? AFTER_HOURS_MULT : 1;
  const ctxMult = Math.min(MAX_CONTEXT_MULT, tMult * cMult * ahMult);
  low *= ctxMult;
  high *= ctxMult;

  factors.push({
    key: 'technician',
    label: 'Technician level',
    applied: tMult !== 1,
    impact_cents: round(baseMid * (tMult - 1)),
    detail: `${input.context.technician_level} technician (${tMult >= 1 ? '+' : ''}${round((tMult - 1) * 100)}%).`,
  });
  factors.push({
    key: 'complexity',
    label: 'Job complexity',
    applied: cMult !== 1,
    impact_cents: round(baseMid * (cMult - 1)),
    detail: `${input.context.complexity} job (${cMult >= 1 ? '+' : ''}${round((cMult - 1) * 100)}%).`,
  });
  factors.push({
    key: 'after_hours',
    label: 'After-hours / urgency',
    applied: input.context.after_hours,
    impact_cents: round(baseMid * (ahMult - 1)),
    detail: input.context.after_hours ? `After-hours premium (+${round((AFTER_HOURS_MULT - 1) * 100)}%).` : 'Standard hours.',
  });

  const miles = input.context.travel_miles !== null ? Math.max(0, num(input.context.travel_miles)) : null;
  const travelAllowance = miles !== null ? round(Math.max(0, miles - TRAVEL_FREE_MILES) * TRAVEL_CENTS_PER_MILE) : 0;
  if (travelAllowance > 0) {
    low += travelAllowance;
    high += travelAllowance;
  }
  factors.push({
    key: 'travel',
    label: 'Travel distance',
    applied: travelAllowance > 0,
    impact_cents: travelAllowance,
    detail:
      miles === null
        ? 'No travel distance provided.'
        : travelAllowance > 0
          ? `${miles} mi is beyond the ${TRAVEL_FREE_MILES} mi included radius: +${usd(travelAllowance)} allowance.`
          : `${miles} mi is inside the included radius.`,
  });

  factors.push({
    key: 'region',
    label: 'Regional price level',
    applied: cohortUsed && regionIndex !== 1,
    impact_cents: 0,
    detail: cohortUsed
      ? `Network cohort figures scaled by ${regionIndex.toFixed(2)}× for ${settings.region_label ?? 'your region'}. Your own Price Book, history and competitor data are already local.`
      : 'No network cohort data used, so the regional index had no effect.',
  });

  // customer / equipment / warranty — risk-side context
  const cust = input.customer;
  const loyalCustomer = !!cust && (cust.completed_jobs >= 3 || cust.lifecycle_stage === 'vip');
  factors.push({
    key: 'customer',
    label: 'Customer history',
    applied: !!cust,
    impact_cents: 0,
    detail: cust
      ? `${cust.completed_jobs} completed job${cust.completed_jobs === 1 ? '' : 's'}, ${usd(cust.lifetime_revenue_cents)} lifetime revenue, ${cust.prior_accepted} accepted / ${cust.prior_declined} declined earlier quotes. Affects acceptance & trust risk, not the fair price.`
      : 'Customer not linked to a customer record.',
  });

  const relevantEquipment = input.equipment.filter((e) => {
    if (e.status !== 'active') return false;
    const t = tokenize(`${e.equipment_type} ${e.make ?? ''}`);
    for (const x of t) if (textTokens.has(x)) return true;
    return false;
  });
  const primaryEq = relevantEquipment[0] ?? null;
  const eqAgeYears = primaryEq ? daysBetween(nowMs, primaryEq.install_date) : null;
  const eqLifespan = primaryEq ? Math.max(1, num(primaryEq.expected_lifespan_years, 15)) : 15;
  const eqRatio = eqAgeYears !== null ? eqAgeYears / 365.25 / eqLifespan : null;
  factors.push({
    key: 'equipment',
    label: 'Equipment age',
    applied: !!primaryEq && eqRatio !== null,
    impact_cents: 0,
    detail:
      primaryEq && eqRatio !== null
        ? `${primaryEq.equipment_type} is ~${(eqAgeYears! / 365.25).toFixed(1)} yrs old (${round(eqRatio * 100)}% of ${eqLifespan}-yr expected life). Affects how justified a replacement looks.`
        : 'No matching equipment record for this quote.',
  });

  const warrantyActive =
    !!primaryEq &&
    (() => {
      const d = daysBetween(nowMs, primaryEq.warranty_expires_at);
      return d !== null && d <= 0;
    })();
  const partRevenue = lines
    .filter((l) => l.category === 'part' || l.category === 'bundle')
    .reduce((s, l) => s + Math.max(0, l.revenue_cents) * (l.category === 'part' ? 1 : 0.5), 0);
  const warrantyConflict = warrantyActive && partRevenue > 0;
  factors.push({
    key: 'warranty',
    label: 'Warranty status',
    applied: warrantyActive,
    impact_cents: 0,
    detail: warrantyActive
      ? `${primaryEq!.equipment_type} is still under warranty until ${primaryEq!.warranty_expires_at}.`
      : 'No active warranty detected for matching equipment.',
  });

  low = Math.round(low);
  high = Math.round(Math.max(high, low));
  const mid = Math.round((low + high) / 2);

  // ---- 4. Position & findings ------------------------------------------------
  const premium = mid > 0 ? (net - mid) / mid : 0;
  const excessOverHigh = high > 0 ? net / high - 1 : 0;
  let position: TruthReport['expected']['position'];
  if (net < low * 0.97) position = 'below_range';
  else if (net <= high) position = 'within_range';
  else if (excessOverHigh <= maxPremium) position = 'above_range';
  else position = 'far_above_range';

  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  if (position === 'far_above_range' || position === 'above_range') {
    add({
      code: 'above_expected_range',
      severity: position === 'far_above_range' ? 'critical' : 'warning',
      title: `Quote is ${round(excessOverHigh * 100)}% above the top of the expected range`,
      detail: `Expected ${usd(low)}–${usd(high)} vs quoted ${usd(net)}.`,
      impact_cents: net - high,
    });
  } else if (position === 'below_range') {
    add({
      code: 'below_expected_range',
      severity: 'info',
      title: 'Quote is below the expected range',
      detail: `Expected ${usd(low)}–${usd(high)} vs quoted ${usd(net)}. You may be leaving up to ${usd(low - net)} on the table.`,
      impact_cents: low - net,
    });
  }

  const partLines = lines.filter((l) => l.category === 'part' && l.cost_source === 'price_book' && l.cost_cents > 0);
  const partRev = partLines.reduce((s, l) => s + l.revenue_cents, 0);
  const partCost = partLines.reduce((s, l) => s + l.cost_cents, 0);
  const partsMarkup = partCost > 0 ? partRev / partCost : null;
  if (partsMarkup !== null && partsMarkup > PARTS_MARKUP_WARN) {
    add({
      code: 'parts_markup_high',
      severity: partsMarkup > PARTS_MARKUP_WARN * 1.6 ? 'critical' : 'warning',
      title: `Parts are marked up ${partsMarkup.toFixed(1)}× cost`,
      detail: `Parts revenue ${usd(partRev)} on a ${usd(partCost)} cost basis. Customers who look up part prices online often react badly above ~${PARTS_MARKUP_WARN}×.`,
      impact_cents: round(partRev - partCost * PARTS_MARKUP_WARN),
    });
  }

  const travelRevenue = lines.filter((l) => l.category === 'travel').reduce((s, l) => s + l.revenue_cents, 0);
  const travelAllowed = TRAVEL_BASE_ALLOWANCE_CENTS + travelAllowance * 1.25;
  if (travelRevenue > travelAllowed) {
    add({
      code: 'travel_overcharge',
      severity: 'warning',
      title: 'Travel / trip charge looks high',
      detail: `Travel lines total ${usd(travelRevenue)} vs a justified allowance of about ${usd(round(travelAllowed))}${miles === null ? ' (no distance provided — add it for a sharper check)' : ` for ${miles} mi`}.`,
      impact_cents: round(travelRevenue - travelAllowed),
    });
  }

  const feeRevenue = lines.filter((l) => l.category === 'fee' || l.category === 'travel').reduce((s, l) => s + Math.max(0, l.revenue_cents), 0);
  const feeShare = gross > 0 ? feeRevenue / gross : 0;
  if (feeShare > FEE_SHARE_WARN && feeRevenue > 15_000) {
    add({
      code: 'fee_heavy',
      severity: 'warning',
      title: `Fees and surcharges are ${round(feeShare * 100)}% of the quote`,
      detail: 'Stacked fees are the most common trigger for "hidden charge" complaints. Consider folding them into the job price.',
      impact_cents: round(feeRevenue - gross * FEE_SHARE_WARN),
    });
  }

  if (warrantyConflict && primaryEq) {
    add({
      code: 'warranty_conflict',
      severity: 'critical',
      title: 'Charging for parts on equipment that appears to be under warranty',
      detail: `${primaryEq.equipment_type} is covered until ${primaryEq.warranty_expires_at}. Up to ${usd(round(partRevenue))} of this quote may be recoverable from the manufacturer instead of the customer.`,
      impact_cents: round(partRevenue),
    });
  }

  if (isReplacement && primaryEq && eqRatio !== null) {
    if (eqRatio < 0.5) {
      add({
        code: 'premature_replacement',
        severity: 'warning',
        title: 'Replacement quoted on relatively young equipment',
        detail: `${primaryEq.equipment_type} is only ${round(eqRatio * 100)}% through its expected life. Make sure the repair-vs-replace reasoning is documented, or offer a repair option.`,
        impact_cents: null,
      });
    } else if (eqRatio >= 0.85) {
      add({
        code: 'end_of_life_supports_replacement',
        severity: 'info',
        title: 'Equipment is near end of life — replacement is easy to justify',
        detail: `${primaryEq.equipment_type} is ${round(eqRatio * 100)}% through its expected life. Lead with age and reliability when presenting.`,
        impact_cents: null,
      });
    }
  }

  const normalized = lines.map((l) => l.description.toLowerCase().replace(/\s+/g, ' '));
  if (new Set(normalized).size < normalized.length) {
    add({
      code: 'duplicate_lines',
      severity: 'warning',
      title: 'Duplicate line items',
      detail: 'Two or more line items have identical descriptions. Duplicates are a common data-entry error and read as padding to customers.',
      impact_cents: null,
    });
  }

  const lumpSum = lines.length === 1 && gross >= 150_000;
  if (lumpSum) {
    add({
      code: 'lump_sum',
      severity: 'info',
      title: 'Large quote with a single line item',
      detail: 'High-value quotes convert better and feel fairer when the scope is itemized.',
      impact_cents: null,
    });
  }

  const inflatedDiscount = discount > 0 && discount / gross >= 0.25;
  if (inflatedDiscount) {
    add({
      code: 'inflated_discount',
      severity: 'info',
      title: 'Very large discount on the quote',
      detail: `A ${round((discount / gross) * 100)}% discount can signal an inflated starting price and erode trust. Price it honestly instead.`,
      impact_cents: discount,
    });
  }

  if (loyalCustomer && premium > 0.08) {
    add({
      code: 'loyal_customer_premium',
      severity: 'warning',
      title: 'Loyal customer is being quoted above the expected midpoint',
      detail: `${cust!.completed_jobs} completed jobs and ${usd(cust!.lifetime_revenue_cents)} lifetime revenue. Long-term customers punish perceived overcharging harder than new ones.`,
      impact_cents: round(net - mid),
    });
  }

  const marginPctNow = net > 0 ? ((net - totalCost) / net) * 100 : null;
  if (marginPctNow !== null && marginPctNow < floorPct) {
    add({
      code: 'margin_below_floor',
      severity: 'critical',
      title: `Margin ${marginPctNow.toFixed(1)}% is below your ${floorPct}% floor`,
      detail: 'This price cannot be reduced further without going below your own margin rule.',
      impact_cents: round(net - totalCost / (1 - floorPct / 100)),
    });
  }

  if (costCoverage < 0.5) {
    add({
      code: 'no_cost_data',
      severity: 'info',
      title: 'Margin is mostly estimated',
      detail: `Only ${round(costCoverage * 100)}% of quote value has a real cost in the Price Book; the rest uses your ${round(defaultRatio * 100)}% default cost ratio.`,
      impact_cents: null,
    });
  }
  if (confidenceScore < 0.45) {
    add({
      code: 'thin_evidence',
      severity: 'info',
      title: 'Thin evidence for the expected range',
      detail: 'Add Price Book entries, competitor benchmarks, or send more quotes for this service to tighten the range.',
      impact_cents: null,
    });
  }

  // ---- 5. Acceptance model ----------------------------------------------------
  const decidedInWindow = input.history.filter((h) => ['accepted', 'declined', 'expired'].includes(h.status)).filter((h) => {
    const age = daysBetween(nowMs, h.created_at);
    return age !== null && age >= 0 && age <= HISTORY_WINDOW_DAYS;
  });
  const acceptedN = decidedInWindow.filter((h) => h.status === 'accepted').length;
  const prior = input.cohort?.acceptance_rate_p50_pct != null ? clamp(input.cohort.acceptance_rate_p50_pct / 100, 0.15, 0.85) : 0.5;
  const baseRate = clamp((acceptedN + prior * BASE_RATE_PRIOR_STRENGTH) / (decidedInWindow.length + BASE_RATE_PRIOR_STRENGTH), 0.05, 0.95);

  let sensitivity = DEFAULT_SENSITIVITY;
  let calibration: 'calibrated' | 'default' = 'default';
  if (similarAll.length >= CALIBRATION_MIN_DECIDED) {
    const sortedSubs = similarAll.map((s) => s.adjusted).sort((a, b) => a - b);
    const median = sortedSubs[Math.floor(sortedSubs.length / 2)];
    if (median > 0) {
      const rel = similarAll.map((s) => ({ r: s.adjusted / median - 1, acc: s.q.status === 'accepted' }));
      const hi = rel.filter((x) => x.r > 0);
      const lo = rel.filter((x) => x.r <= 0);
      if (hi.length >= CALIBRATION_MIN_GROUP && lo.length >= CALIBRATION_MIN_GROUP) {
        const rate = (g: typeof rel) => (g.filter((x) => x.acc).length + 1) / (g.length + 2);
        const avgR = (g: typeof rel) => g.reduce((s, x) => s + x.r, 0) / g.length;
        const dr = avgR(hi) - avgR(lo);
        if (dr > 0.01) {
          const slope = (logit(rate(lo)) - logit(rate(hi))) / dr;
          if (Number.isFinite(slope)) {
            sensitivity = clamp(slope, MIN_SENSITIVITY, MAX_SENSITIVITY);
            calibration = 'calibrated';
          }
        }
      }
    }
  }

  const terms: RiskTerm[] = [];
  const addTerm = (label: string, d: number) => terms.push({ label, logit_delta: d });
  if (cust) {
    if (cust.completed_jobs >= 2) addTerm('Repeat customer', 0.35);
    if (cust.lifecycle_stage === 'vip') addTerm('VIP customer', 0.25);
    if (cust.prior_declined >= 2 && cust.prior_accepted === 0) addTerm('Declined earlier quotes, never accepted one', -0.35);
  }
  if (input.context.complexity === 'emergency') addTerm('Emergency — customers are less price-elastic', 0.6);
  if (input.context.after_hours) addTerm('After-hours request', 0.15);
  if (isReplacement && eqRatio !== null) {
    if (eqRatio >= 0.85) addTerm('Equipment at end of life', 0.4);
    else if (eqRatio < 0.5) addTerm('Replacement on young equipment', -0.35);
  }
  if (warrantyConflict) addTerm('Warranty conflict — surprise cost', -0.6);
  if (num(input.quote.deposit_percent) > 30) addTerm('High deposit requested', -0.15);

  const staticOverchargePoints: { label: string; points: number }[] = [];
  if (partsMarkup !== null && partsMarkup > PARTS_MARKUP_WARN) {
    staticOverchargePoints.push({ label: 'High parts markup', points: clamp((partsMarkup - PARTS_MARKUP_WARN) * 8, 0, 15) });
  }
  if (warrantyConflict) staticOverchargePoints.push({ label: 'Charging for warrantied parts', points: 30 });
  if (feeShare > FEE_SHARE_WARN && feeRevenue > 15_000) {
    staticOverchargePoints.push({ label: 'Fee-heavy quote', points: clamp((feeShare - FEE_SHARE_WARN) * 100, 0, 12) });
  }
  if (lumpSum) staticOverchargePoints.push({ label: 'No itemization on a large quote', points: 8 });
  if (isReplacement && eqRatio !== null && eqRatio < 0.5) {
    staticOverchargePoints.push({ label: 'Replacement on young equipment', points: 15 });
  }
  if (new Set(normalized).size < normalized.length) staticOverchargePoints.push({ label: 'Duplicate line items', points: 5 });
  if (inflatedDiscount) staticOverchargePoints.push({ label: 'Inflated-looking discount', points: 6 });
  if (travelRevenue > travelAllowed) staticOverchargePoints.push({ label: 'High travel charge', points: 6 });

  const model = buildRiskModel({
    baseLogit: logit(baseRate),
    sensitivity,
    staticTerms: terms,
    mid,
    high,
    costCents: totalCost,
    floorPct,
    staticOverchargePoints,
    loyalCustomer,
  });

  const current = model.evalAt(net);
  const pAcc = model.acceptance(net);
  const overScore = current.overcharge_score;
  const drivers = model.overchargeDrivers(net).map((d) => ({ label: d.label, points: round(d.points * 10) / 10 }));

  const halfBand = 0.05 + 0.2 * (1 - confidenceScore);
  const rejection = 1 - pAcc;
  const band: [number, number] = [clamp(rejection - halfBand, 0, 1), clamp(rejection + halfBand, 0, 1)];

  // ---- 6. Price optimisation --------------------------------------------------
  const candidates: PricePointEval[] = [];
  for (let m = 0.75; m <= 1.351; m += 0.01) candidates.push(model.evalAt(net * m));
  candidates.push(current);

  // Trust-first hard ceiling: the optimiser may never push a quote above the
  // point where the engine itself would stop calling it "fair". Profit alone
  // is not allowed to talk the owner into overcharging.
  const priceCeiling = Math.round(high * (1 + maxPremium / 2));
  const trustOk = (c: PricePointEval) => c.overcharge_score <= SEVERE_OVERCHARGE && c.price_cents <= priceCeiling;
  let pool = candidates.filter((c) => c.feasible && trustOk(c));
  let constrained = true;
  if (pool.length === 0) {
    pool = candidates.filter((c) => c.feasible);
    constrained = false;
  }
  if (pool.length === 0) pool = candidates;

  let best = pool.reduce((a, b) => (b.expected_profit_cents > a.expected_profit_cents ? b : a), pool[0]);
  const rounded = model.evalAt(niceRound(best.price_cents));
  if (rounded.feasible === best.feasible && rounded.expected_profit_cents >= best.expected_profit_cents * 0.995) best = rounded;

  const nearOptimal = current.expected_profit_cents >= best.expected_profit_cents * 0.99 || Math.abs(best.price_cents - net) / Math.max(net, 1) < 0.02;
  const recommended = nearOptimal ? current : best;
  const safe = pool.filter((c) => c.expected_profit_cents >= best.expected_profit_cents * 0.97);
  const safeMin = Math.min(...safe.map((c) => c.price_cents), recommended.price_cents);
  const safeMax = Math.max(...safe.map((c) => c.price_cents), recommended.price_cents);

  const action: 'hold' | 'raise' | 'lower' = nearOptimal ? 'hold' : recommended.price_cents > net ? 'raise' : 'lower';
  let optNote: string;
  if (action === 'hold') {
    optNote = `Your price is already at or very near the point that maximizes expected profit after acceptance and trust risk (safe band ${usd(safeMin)}–${usd(safeMax)}).`;
  } else if (action === 'lower') {
    optNote = `Lowering to about ${usd(recommended.price_cents)} raises acceptance from ${round(current.acceptance_probability * 100)}% to ${round(recommended.acceptance_probability * 100)}% and cuts overcharge risk, which more than offsets the smaller margin.`;
  } else {
    optNote = `The quote is priced below what the evidence supports. About ${usd(recommended.price_cents)} keeps acceptance at ${round(recommended.acceptance_probability * 100)}% while capturing more margin.`;
  }
  if (!constrained) optNote += ' Note: no price satisfies both your margin floor and the fair-price ceiling — review scope, costs or the Price Book.';

  const curve: CurvePoint[] = [];
  for (let i = 0; i <= 12; i++) {
    const c = model.evalAt(net * (0.8 + i * 0.05));
    curve.push({
      price_cents: c.price_cents,
      acceptance_pct: round(c.acceptance_probability * 100),
      expected_profit_cents: c.expected_profit_cents,
      overcharge_score: c.overcharge_score,
    });
  }

  // ---- 7. Verdict -------------------------------------------------------------
  const hasCritical = findings.some((f) => f.severity === 'critical');
  let verdict: TruthVerdict;
  const onlyCostPlus = anchors.length === 1 && anchors[0].key === 'cost_plus';
  if (onlyCostPlus) verdict = 'low_evidence';
  else if (position === 'below_range' && net < low * 0.88) verdict = 'underpriced';
  else if (position === 'far_above_range') verdict = 'overpriced';
  else if (position === 'above_range') verdict = excessOverHigh > maxPremium / 2 ? 'high' : 'fair';
  else verdict = hasCritical ? 'fair' : 'well_priced';

  const headline =
    `Quote ${usd(net)} vs expected ${usd(low)}–${usd(high)} ` +
    `(${premium >= 0 ? '+' : ''}${round(premium * 100)}% vs midpoint). ` +
    `Rejection risk ${round(rejection * 100)}%, overcharge-perception risk ${overchargeLevel(overScore)}.`;

  return {
    engine_version: ENGINE_VERSION,
    computed_at: input.now,
    redacted: false,
    verdict,
    headline,
    quote: { gross_cents: gross, discount_cents: discount, subtotal_cents: net, line_count: lines.length },
    expected: {
      low_cents: low,
      high_cents: high,
      mid_cents: mid,
      premium_pct: Math.round(premium * 1000) / 1000,
      position,
      confidence_score: Math.round(confidenceScore * 100) / 100,
      confidence_label: confidenceLabel,
      anchors,
      factors,
    },
    lines: lines.map((l) => ({
      description: l.description,
      category: l.category,
      revenue_cents: l.revenue_cents,
      matched_price_book: l.match?.entry.service_name ?? null,
      cost_source: l.match ? l.cost_source : null,
    })),
    findings: findings.sort((a, b) => sevRank(b.severity) - sevRank(a.severity)),
    risk: {
      acceptance_probability: Math.round(pAcc * 1000) / 1000,
      rejection_probability: Math.round(rejection * 1000) / 1000,
      rejection_band: [Math.round(band[0] * 1000) / 1000, Math.round(band[1] * 1000) / 1000],
      sensitivity: Math.round(sensitivity * 100) / 100,
      sensitivity_source: calibration,
      base_acceptance_rate: Math.round(baseRate * 1000) / 1000,
      terms,
      overcharge_score: overScore,
      overcharge_level: overchargeLevel(overScore),
      trust_score: 100 - overScore,
      overcharge_drivers: drivers,
    },
    margin: {
      revenue_cents: net,
      estimated_cost_cents: totalCost,
      margin_pct: marginPctNow === null ? null : round(marginPctNow * 10) / 10,
      floor_pct: floorPct,
      headroom_cents: round(net - totalCost / (1 - floorPct / 100)),
      cost_coverage_pct: round(costCoverage * 100),
    },
    optimization: {
      action,
      current,
      recommended,
      safe_min_cents: safeMin,
      safe_max_cents: safeMax,
      expected_profit_delta_cents: recommended.expected_profit_cents - current.expected_profit_cents,
      trust_drag: TRUST_DRAG,
      curve,
      note: optNote,
    },
    data_quality: {
      anchors_used: anchors.length,
      price_book_coverage_pct: round(pb.coverage * 100),
      cost_coverage_pct: round(costCoverage * 100),
      similar_quotes_used: similarAccepted.length,
      competitor_benchmarks_used: comp.used,
      decided_quotes_for_base_rate: decidedInWindow.length,
      calibration,
      notes: buildNotes(notes, calibration, decidedInWindow.length, similarAccepted.length, cohortUsed),
    },
  };
}

function sevRank(s: Severity): number {
  return s === 'critical' ? 2 : s === 'warning' ? 1 : 0;
}

function buildNotes(
  notes: string[],
  calibration: 'calibrated' | 'default',
  decided: number,
  similarAccepted: number,
  cohortUsed: boolean,
): string[] {
  const out = [...notes];
  out.push(
    calibration === 'calibrated'
      ? 'Price sensitivity was calibrated from your own accepted/declined quotes.'
      : 'Price sensitivity uses a conservative default until you have ~12 similar decided quotes.',
  );
  if (decided < 10) out.push('Base acceptance rate is blended with a prior because you have fewer than 10 decided quotes.');
  if (similarAccepted < MIN_HISTORY_SAMPLES) out.push('Fewer than 3 similar accepted quotes — history did not contribute to the expected range.');
  if (!cohortUsed) out.push('Network cohort data was not used for the expected range.');
  return out;
}

// ---------------------------------------------------------------------------
// Redaction — for viewers without billing / cost access
// ---------------------------------------------------------------------------

const COST_FINDING_CODES = new Set(['parts_markup_high', 'margin_below_floor', 'no_cost_data']);

export function redactCostData(report: TruthReport): TruthReport {
  const strip = (c: PricePointEval): PricePointEval => ({ ...c, margin_pct: null, expected_profit_cents: 0 });
  return {
    ...report,
    redacted: true,
    margin: null,
    findings: report.findings.filter((f) => !COST_FINDING_CODES.has(f.code)),
    lines: report.lines.map((l) => ({ ...l, cost_source: null })),
    expected: {
      ...report.expected,
      anchors: report.expected.anchors.filter((a) => a.key !== 'cost_plus'),
    },
    optimization: {
      ...report.optimization,
      current: strip(report.optimization.current),
      recommended: strip(report.optimization.recommended),
      expected_profit_delta_cents: null,
      curve: report.optimization.curve.map((c) => ({ ...c, expected_profit_cents: null })),
    },
    data_quality: { ...report.data_quality, cost_coverage_pct: 0 },
  };
}
