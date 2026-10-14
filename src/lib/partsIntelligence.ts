/**
 * Parts Intelligence — pure engine (no network, no randomness).
 *
 * Extends AI Parts Market. It owns NO data: every input comes from tables/views that already
 * exist (Inventory, Parts Market, OEM Intelligence, Failure Genome, Supply Chain Outcomes).
 * Everything here is deterministic and explainable so each number can be audited and unit-tested.
 *
 * Server counterpart: supabase/migrations/20270601000000_parts_intelligence.sql
 * All money is integer cents. All times are days unless the name says otherwise.
 */

import type { MarketOfferRow, PriceHistoryRow } from '@/lib/partsMarket';

// ============================================================
// TYPES
// ============================================================

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type RiskTier = 'critical' | 'high' | 'watch' | 'healthy';
export type StockRisk = 'critical' | 'high' | 'watch' | 'ok';
export type DemandPattern = 'none' | 'insufficient' | 'smooth' | 'erratic' | 'intermittent' | 'lumpy';
export type PriceSignal = 'no_data' | 'buy_window' | 'fair' | 'elevated' | 'spiking';

export interface PiOverviewRow {
  part_id: string;
  name: string;
  part_number: string | null;
  category: string | null;
  unit_cost_cents: number;
  reorder_point: number;
  reorder_quantity: number;
  on_hand: number;
  available: number;
  /** 13 weekly buckets, oldest → newest. */
  weekly_usage: number[];
  scheduled_30d: number;
  oem_matched: boolean;
  compatible_units: number;
  issue_count: number;
  recall_count: number;
  bulletin_count: number;
  max_severity: Severity | null;
}

export interface PiRecall {
  recall_number: string;
  title: string;
  severity: Severity;
  issued_date: string | null;
  remedy?: string | null;
  source_url: string | null;
  model_number?: string | null;
}

export interface PiBulletin {
  bulletin_number: string;
  title: string;
  issued_date: string | null;
  source_url: string | null;
  model_number?: string | null;
}

export interface PiIssue {
  issue_id: string;
  title: string;
  severity: Severity;
  symptom: string | null;
  recommended_repair: string | null;
  quantity: number;
  is_required: boolean;
  manufacturer: string;
  source_url: string | null;
  recall: PiRecall | null;
  bulletin: PiBulletin | null;
}

export interface PiOemPart {
  oem_part_id: string;
  part_number: string;
  part_name: string;
  avg_price_cents: number | null;
  manufacturer: string;
  model_id: string | null;
  model_number: string | null;
  equipment_type: string | null;
}

export interface PiModel {
  model_id: string;
  manufacturer: string;
  model_number: string;
  equipment_type: string | null;
  my_units: number;
}

export interface PiUnit {
  equipment_id: string;
  make: string | null;
  model: string | null;
  equipment_type: string | null;
  install_date: string | null;
  customer_name: string | null;
}

export interface PiSubstitute {
  part_id: string;
  name: string;
  part_number: string | null;
  note: string | null;
  unit_cost_cents: number;
  available?: number;
  best_offer_cents?: number | null;
}

export interface PiDetail {
  found: boolean;
  part: { id: string; name: string; part_number: string | null; category: string | null; unit_cost_cents: number } | null;
  has_part_number: boolean;
  oem_parts: PiOemPart[];
  models: PiModel[];
  units: PiUnit[];
  issues: PiIssue[];
  model_recalls: PiRecall[];
  model_bulletins: PiBulletin[];
  substitutes: PiSubstitute[];
  substitute_for: PiSubstitute[];
}

export interface PartFailureEvent {
  id: string;
  equipment_id: string;
  occurred_on: string;
  age_months: number | null;
  failure_component: string;
  failure_mode: string | null;
  repair_action: string | null;
  parts_replaced: string[];
  outcome: string;
  repair_cost: number | null;
  make: string | null;
  model: string | null;
}

export interface InstallOutcomeRow {
  install_id: string;
  supplier_name: string;
  quantity: number;
  installed_at: string;
  outcome_class: 'success' | 'failure' | 'pending' | 'excluded';
  defect_attributed: boolean;
}

/** Minimal shape of a Failure Genome population pattern (see failureGenome.FailurePattern). */
export interface PatternLite {
  failure_component: string;
  model_key: string;
  status: 'emerging' | 'elevated' | 'stable' | 'declining';
  lift: number | null;
  top_parts: { tag: string; share: number | null }[];
  recent_events: number;
  contributor_count: number;
}

// ============================================================
// SMALL HELPERS
// ============================================================

const DAY_MS = 86_400_000;
const Z_80 = 1.2816;
const Z_95 = 1.645;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const round1 = (n: number) => Math.round(n * 10) / 10;
const sev = (v: unknown): Severity =>
  v === 'critical' || v === 'high' || v === 'medium' || v === 'low' ? v : 'medium';

/** Must match failureGenome.slugify() / SQL fg_slug(). */
export function slug(input: string | null | undefined): string | null {
  const s = (input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 60)
    .replace(/^_+|_+$/g, '');
  return s || null;
}

export const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

// ============================================================
// NORMALIZERS (a missing field can never crash the UI)
// ============================================================

export function normalizeOverview(raw: unknown): PiOverviewRow[] {
  return arr(raw).map((r) => {
    const o = rec(r);
    const weekly = arr<number>(o.weekly_usage).map((n) => Math.max(0, num(n)));
    return {
      part_id: String(o.part_id ?? ''),
      name: String(o.name ?? 'Unnamed part'),
      part_number: str(o.part_number),
      category: str(o.category),
      unit_cost_cents: num(o.unit_cost_cents),
      reorder_point: num(o.reorder_point),
      reorder_quantity: num(o.reorder_quantity),
      on_hand: num(o.on_hand),
      available: num(o.available),
      weekly_usage: weekly,
      scheduled_30d: num(o.scheduled_30d),
      oem_matched: o.oem_matched === true,
      compatible_units: num(o.compatible_units),
      issue_count: num(o.issue_count),
      recall_count: num(o.recall_count),
      bulletin_count: num(o.bulletin_count),
      max_severity: o.max_severity ? sev(o.max_severity) : null,
    };
  }).filter((r) => r.part_id);
}

function normRecall(v: unknown): PiRecall | null {
  const o = rec(v);
  if (!o.recall_number && !o.title) return null;
  return {
    recall_number: String(o.recall_number ?? ''),
    title: String(o.title ?? 'Recall'),
    severity: sev(o.severity),
    issued_date: str(o.issued_date),
    remedy: str(o.remedy),
    source_url: str(o.source_url),
    model_number: str(o.model_number),
  };
}

function normBulletin(v: unknown): PiBulletin | null {
  const o = rec(v);
  if (!o.bulletin_number && !o.title) return null;
  return {
    bulletin_number: String(o.bulletin_number ?? ''),
    title: String(o.title ?? 'Service bulletin'),
    issued_date: str(o.issued_date),
    source_url: str(o.source_url),
    model_number: str(o.model_number),
  };
}

const normSub = (v: unknown): PiSubstitute => {
  const o = rec(v);
  return {
    part_id: String(o.part_id ?? ''),
    name: String(o.name ?? 'Unnamed part'),
    part_number: str(o.part_number),
    note: str(o.note),
    unit_cost_cents: num(o.unit_cost_cents),
    available: o.available === undefined ? undefined : num(o.available),
    best_offer_cents: o.best_offer_cents == null ? null : num(o.best_offer_cents),
  };
};

export function normalizeDetail(raw: unknown): PiDetail {
  const o = rec(raw);
  if (o.found !== true) {
    return { found: false, part: null, has_part_number: false, oem_parts: [], models: [], units: [], issues: [],
      model_recalls: [], model_bulletins: [], substitutes: [], substitute_for: [] };
  }
  const p = rec(o.part);
  return {
    found: true,
    part: {
      id: String(p.id ?? ''),
      name: String(p.name ?? ''),
      part_number: str(p.part_number),
      category: str(p.category),
      unit_cost_cents: num(p.unit_cost_cents),
    },
    has_part_number: o.has_part_number === true,
    oem_parts: arr(o.oem_parts).map((x) => {
      const r = rec(x);
      return {
        oem_part_id: String(r.oem_part_id ?? ''),
        part_number: String(r.part_number ?? ''),
        part_name: String(r.part_name ?? ''),
        avg_price_cents: r.avg_price_cents == null ? null : num(r.avg_price_cents),
        manufacturer: String(r.manufacturer ?? ''),
        model_id: str(r.model_id),
        model_number: str(r.model_number),
        equipment_type: str(r.equipment_type),
      };
    }),
    models: arr(o.models).map((x) => {
      const r = rec(x);
      return {
        model_id: String(r.model_id ?? ''),
        manufacturer: String(r.manufacturer ?? ''),
        model_number: String(r.model_number ?? ''),
        equipment_type: str(r.equipment_type),
        my_units: num(r.my_units),
      };
    }),
    units: arr(o.units).map((x) => {
      const r = rec(x);
      return {
        equipment_id: String(r.equipment_id ?? ''),
        make: str(r.make),
        model: str(r.model),
        equipment_type: str(r.equipment_type),
        install_date: str(r.install_date),
        customer_name: str(r.customer_name),
      };
    }),
    issues: arr(o.issues).map((x) => {
      const r = rec(x);
      return {
        issue_id: String(r.issue_id ?? ''),
        title: String(r.title ?? 'Known issue'),
        severity: sev(r.severity),
        symptom: str(r.symptom),
        recommended_repair: str(r.recommended_repair),
        quantity: num(r.quantity, 1),
        is_required: r.is_required !== false,
        manufacturer: String(r.manufacturer ?? ''),
        source_url: str(r.source_url),
        recall: normRecall(r.recall),
        bulletin: normBulletin(r.bulletin),
      };
    }),
    model_recalls: arr(o.model_recalls).map(normRecall).filter((x): x is PiRecall => !!x),
    model_bulletins: arr(o.model_bulletins).map(normBulletin).filter((x): x is PiBulletin => !!x),
    substitutes: arr(o.substitutes).map(normSub),
    substitute_for: arr(o.substitute_for).map(normSub),
  };
}

// ============================================================
// DEMAND FORECAST
// ============================================================

export interface DemandInput {
  /** Weekly usage, oldest → newest. */
  weekly: number[];
  /** Units already required by jobs scheduled in the next 30 days. */
  scheduled30d: number;
  available: number;
  reorderPoint: number;
  reorderQuantity: number;
  /** Supplier lead time used for safety stock / stockout tiering. Default 5 days. */
  leadTimeDays?: number;
  now?: Date;
}

export interface DemandForecast {
  pattern: DemandPattern;
  weeklyLevel: number;
  trendPerWeek: number;
  next4Weeks: number[];
  expected30d: number;
  low30d: number;
  high30d: number;
  scheduled30d: number;
  dailyRate: number;
  daysOfCover: number | null;
  stockoutDate: string | null;
  safetyStock: number;
  dynamicReorderPoint: number;
  suggestedOrderQty: number;
  stockRisk: StockRisk;
  /** 0..1 — how much history supports this forecast. */
  confidence: number;
  notes: string[];
}

/**
 * Syntetos–Boylan classification of demand patterns.
 * ADI = average inter-demand interval, CV² = squared coefficient of variation of non-zero demand.
 */
export function classifyDemand(weekly: number[]): DemandPattern {
  const n = weekly.length;
  const nz = weekly.filter((x) => x > 0);
  if (nz.length === 0) return 'none';
  if (n < 4 || nz.length < 2) return 'insufficient';
  const adi = n / nz.length;
  const mean = nz.reduce((a, b) => a + b, 0) / nz.length;
  const variance = nz.reduce((a, b) => a + (b - mean) ** 2, 0) / nz.length;
  const cv2 = mean > 0 ? variance / (mean * mean) : 0;
  if (adi < 1.32) return cv2 < 0.49 ? 'smooth' : 'erratic';
  return cv2 < 0.49 ? 'intermittent' : 'lumpy';
}

/** Ordinary least squares slope of y against 0..n-1. */
function slope(y: number[]): number {
  const n = y.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = y.reduce((a, b) => a + b, 0) / n;
  let nume = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    nume += (i - xm) * (y[i] - ym);
    den += (i - xm) ** 2;
  }
  return den === 0 ? 0 : nume / den;
}

export function forecastDemand(input: DemandInput): DemandForecast {
  const now = input.now ?? new Date();
  const lead = Math.max(1, input.leadTimeDays ?? 5);
  const w = input.weekly.map((x) => Math.max(0, x));
  const n = w.length;
  const available = Math.max(0, input.available);
  const scheduled = Math.max(0, input.scheduled30d);
  const pattern = classifyDemand(w);
  const nonZero = w.filter((x) => x > 0).length;
  const notes: string[] = [];

  // Exponentially weighted level (recent weeks weigh more).
  let wsum = 0;
  let lsum = 0;
  w.forEach((x, i) => {
    const wt = 0.85 ** (n - 1 - i);
    wsum += wt;
    lsum += wt * x;
  });
  const level = wsum > 0 ? lsum / wsum : 0;

  // Damped, clamped trend — only trusted with enough history.
  const rawTrend = n >= 8 ? slope(w) : 0;
  const trend = clamp(rawTrend * 0.5, -level * 0.25, level * 0.25);

  const next4 = [1, 2, 3, 4].map((k) => Math.max(0, round1(level + trend * k)));
  const stat30 = (next4.reduce((a, b) => a + b, 0) * 30) / 28;

  // Scheduled jobs are part of "real" demand — take the larger signal, never add (no double counting).
  const expected30d = Math.max(stat30, scheduled);
  if (scheduled > stat30 && scheduled > 0) notes.push('Scheduled jobs already need more than the statistical forecast.');

  const mean = n > 0 ? w.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n >= 4 ? Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : Math.sqrt(Math.max(level, 0));
  const widen = pattern === 'lumpy' || pattern === 'intermittent' ? 1.25 : 1;
  const sd30 = sd * Math.sqrt(30 / 7) * widen;
  const low30d = Math.max(scheduled, Math.max(0, expected30d - Z_80 * sd30));
  const high30d = expected30d + Z_80 * sd30;

  const dailyRate = expected30d / 30;
  const daysOfCover = dailyRate > 0 ? available / dailyRate : null;
  const stockoutDate =
    daysOfCover !== null && daysOfCover < 90
      ? new Date(now.getTime() + daysOfCover * DAY_MS).toISOString().slice(0, 10)
      : null;

  const safetyStock = Math.ceil(Z_95 * sd * widen * Math.sqrt(lead / 7));
  const dynamicReorderPoint = Math.ceil(dailyRate * lead) + (dailyRate > 0 ? safetyStock : 0);

  let suggestedOrderQty = 0;
  // Order whenever stock is at/below the reorder point OR will run out within one lead time + a week —
  // this keeps "high"/"critical" risk and the order suggestion always consistent.
  const needsOrder =
    dailyRate > 0 &&
    (available <= Math.max(dynamicReorderPoint, input.reorderPoint) || (daysOfCover !== null && daysOfCover < lead + 7));
  if (needsOrder) {
    const target = Math.ceil(expected30d + safetyStock);
    suggestedOrderQty = Math.max(0, target - available);
    if (input.reorderQuantity > 0 && suggestedOrderQty > 0) {
      suggestedOrderQty = Math.ceil(suggestedOrderQty / input.reorderQuantity) * input.reorderQuantity;
    }
  }

  let stockRisk: StockRisk = 'ok';
  if (dailyRate > 0) {
    if (available <= 0 || (daysOfCover !== null && daysOfCover < lead)) stockRisk = 'critical';
    else if ((daysOfCover !== null && daysOfCover < lead + 7) || available <= dynamicReorderPoint) stockRisk = 'high';
    else if ((daysOfCover !== null && daysOfCover < 30) || available <= input.reorderPoint) stockRisk = 'watch';
  } else if (input.reorderPoint > 0 && available <= input.reorderPoint) {
    stockRisk = 'watch';
  }

  const base = Math.min(1, nonZero / 8);
  const penalty = { none: 0, insufficient: 0.4, smooth: 1, erratic: 0.85, intermittent: 0.7, lumpy: 0.5 }[pattern];
  const confidence = pattern === 'none' ? 0 : Math.round(clamp(base * penalty, 0.1, 0.95) * 100) / 100;

  if (pattern === 'none') notes.push('No usage in the last 13 weeks — forecast is based only on scheduled jobs.');
  if (pattern === 'insufficient') notes.push('Very little usage history — treat the forecast as a rough guide.');
  if (pattern === 'lumpy' || pattern === 'intermittent') notes.push('Demand is sporadic; the range is wider than usual.');
  if (rawTrend > 0.4 && n >= 8) notes.push('Usage is trending up.');
  if (rawTrend < -0.4 && n >= 8) notes.push('Usage is trending down.');

  return {
    pattern,
    weeklyLevel: round1(level),
    trendPerWeek: round1(trend),
    next4Weeks: next4,
    expected30d: round1(expected30d),
    low30d: round1(low30d),
    high30d: round1(high30d),
    scheduled30d: scheduled,
    dailyRate: Math.round(dailyRate * 100) / 100,
    daysOfCover: daysOfCover === null ? null : round1(daysOfCover),
    stockoutDate,
    safetyStock,
    dynamicReorderPoint,
    suggestedOrderQty,
    stockRisk,
    confidence,
    notes,
  };
}

// ============================================================
// PRICING INTELLIGENCE
// ============================================================

export interface PricingIntel {
  signal: PriceSignal;
  freshOffers: number;
  staleOffers: number;
  bestCents: number | null;
  medianCents: number | null;
  highCents: number | null;
  spreadPct: number | null;
  median30dCents: number | null;
  vs30dPct: number | null;
  volatilityPct: number | null;
  /** Change between first and second half of the 30-day history, %. */
  driftPct: number | null;
  vsOemPct: number | null;
  vsOwnCostPct: number | null;
  notes: string[];
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const pct = (a: number, b: number) => (b > 0 ? round1(((a - b) / b) * 100) : null);

export function analyzePricing(params: {
  offers: MarketOfferRow[];
  history: PriceHistoryRow[];
  ownUnitCostCents: number;
  oemAvgPriceCents: number | null;
  staleAfterMinutes?: number;
}): PricingIntel {
  const stale = params.staleAfterMinutes ?? 240;
  const usable = params.offers.filter((o) => o.source_active && !o.is_expired && o.quantity_available > 0);
  const fresh = usable.filter((o) => o.age_minutes <= stale);
  const staleCount = usable.length - fresh.length;
  const prices = fresh.map((o) => o.unit_price_cents);
  const best = prices.length ? Math.min(...prices) : null;
  const med = median(prices);
  const high = prices.length ? Math.max(...prices) : null;

  const hist = [...params.history].sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const hp = hist.map((h) => h.unit_price_cents);
  const med30 = median(hp);
  const mean = hp.length ? hp.reduce((a, b) => a + b, 0) / hp.length : 0;
  const sd = hp.length > 1 ? Math.sqrt(hp.reduce((a, b) => a + (b - mean) ** 2, 0) / hp.length) : 0;
  const volatility = mean > 0 && hp.length >= 4 ? round1((sd / mean) * 100) : null;

  let drift: number | null = null;
  if (hp.length >= 6) {
    const half = Math.floor(hp.length / 2);
    const a = hp.slice(0, half);
    const b = hp.slice(half);
    const ma = a.reduce((x, y) => x + y, 0) / a.length;
    const mb = b.reduce((x, y) => x + y, 0) / b.length;
    drift = pct(mb, ma);
  }

  const vs30 = best !== null && med30 !== null ? pct(best, med30) : null;
  const notes: string[] = [];
  let signal: PriceSignal = 'no_data';
  if (best !== null) {
    if (vs30 === null) signal = 'fair';
    else if (vs30 <= -5) signal = 'buy_window';
    else if (vs30 <= 7) signal = 'fair';
    else if (vs30 <= 20) signal = 'elevated';
    else signal = 'spiking';
  }
  if (staleCount > 0) notes.push(`${staleCount} quote${staleCount > 1 ? 's are' : ' is'} older than ${Math.round(stale / 60)} h — re-quote before buying.`);
  if (hp.length < 4) notes.push('Less than 4 price observations — 30-day comparison is weak.');
  if (volatility !== null && volatility > 15) notes.push('Prices for this part swing a lot; lock a price when you find a good one.');
  if (drift !== null && drift > 8) notes.push('Prices drifted up over the last 30 days.');
  if (drift !== null && drift < -8) notes.push('Prices drifted down over the last 30 days.');

  return {
    signal,
    freshOffers: fresh.length,
    staleOffers: staleCount,
    bestCents: best,
    medianCents: med,
    highCents: high,
    spreadPct: best !== null && high !== null ? pct(high, best) : null,
    median30dCents: med30,
    vs30dPct: vs30,
    volatilityPct: volatility,
    driftPct: drift,
    vsOemPct: best !== null && params.oemAvgPriceCents ? pct(best, params.oemAvgPriceCents) : null,
    vsOwnCostPct: best !== null && params.ownUnitCostCents > 0 ? pct(best, params.ownUnitCostCents) : null,
    notes,
  };
}

// ============================================================
// SUPPLIER RELIABILITY (for THIS part, from real install outcomes)
// ============================================================

export interface SupplierReliability {
  supplier: string;
  installs: number;
  successes: number;
  failures: number;
  pending: number;
  defectAttributed: number;
  successRatePct: number | null;
  /** 95% Wilson lower bound — what we can safely claim given the sample size. */
  confidentRatePct: number | null;
}

export function wilsonLower(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

export function summarizeSuppliers(rows: InstallOutcomeRow[]): SupplierReliability[] {
  const by = new Map<string, SupplierReliability>();
  for (const r of rows) {
    if (r.outcome_class === 'excluded') continue;
    const cur = by.get(r.supplier_name) ?? {
      supplier: r.supplier_name, installs: 0, successes: 0, failures: 0, pending: 0,
      defectAttributed: 0, successRatePct: null, confidentRatePct: null,
    };
    cur.installs += 1;
    if (r.outcome_class === 'success') cur.successes += 1;
    else if (r.outcome_class === 'failure') cur.failures += 1;
    else cur.pending += 1;
    if (r.defect_attributed) cur.defectAttributed += 1;
    by.set(r.supplier_name, cur);
  }
  return [...by.values()]
    .map((s) => {
      const decided = s.successes + s.failures;
      return {
        ...s,
        successRatePct: decided > 0 ? round1((s.successes / decided) * 100) : null,
        confidentRatePct: decided > 0 ? round1(wilsonLower(s.successes, decided) * 100) : null,
      };
    })
    .sort((a, b) => (b.confidentRatePct ?? -1) - (a.confidentRatePct ?? -1) || b.installs - a.installs);
}

// ============================================================
// FAILURE HISTORY
// ============================================================

/** Does a free-text failure tag (e.g. "run_capacitor") refer to this inventory part? Deliberately conservative. */
export function partMatchesTag(part: { name: string; part_number: string | null }, tag: string): boolean {
  const t = slug(tag);
  if (!t) return false;
  const name = slug(part.name);
  const pn = slug(part.part_number);
  if (pn && (t === pn || (pn.length >= 5 && t.includes(pn)))) return true;
  if (!name) return false;
  if (t === name) return true;
  // Whole-token containment, at least 4 chars, so "cap" never matches "capacity".
  if (t.length >= 4) {
    const nameTokens = name.split('_');
    const tagTokens = t.split('_');
    if (tagTokens.every((tk) => nameTokens.includes(tk))) return true;
  }
  return false;
}

export interface FailureHistorySummary {
  total: number;
  last12m: number;
  prior12m: number;
  trend: 'up' | 'down' | 'flat';
  repeatRatePct: number | null;
  avgAgeMonths: number | null;
  avgRepairCost: number | null;
  topComponents: { component: string; count: number }[];
  topModels: { model: string; count: number }[];
}

export function summarizeFailureHistory(events: PartFailureEvent[], now: Date = new Date()): FailureHistorySummary {
  const t12 = now.getTime() - 365 * DAY_MS;
  const t24 = now.getTime() - 730 * DAY_MS;
  let last12 = 0;
  let prior12 = 0;
  let repeats = 0;
  const ages: number[] = [];
  const costs: number[] = [];
  const comp = new Map<string, number>();
  const mdl = new Map<string, number>();
  for (const e of events) {
    const t = new Date(e.occurred_on).getTime();
    if (t >= t12) last12 += 1;
    else if (t >= t24) prior12 += 1;
    if (e.outcome === 'recurred' || e.outcome === 'callback') repeats += 1;
    if (e.age_months !== null) ages.push(e.age_months);
    if (e.repair_cost !== null) costs.push(e.repair_cost);
    comp.set(e.failure_component, (comp.get(e.failure_component) ?? 0) + 1);
    const m = [e.make, e.model].filter(Boolean).join(' ').trim();
    if (m) mdl.set(m, (mdl.get(m) ?? 0) + 1);
  }
  const topN = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const trend = last12 > prior12 * 1.25 + 0.5 ? 'up' : prior12 > last12 * 1.25 + 0.5 ? 'down' : 'flat';
  return {
    total: events.length,
    last12m: last12,
    prior12m: prior12,
    trend,
    repeatRatePct: events.length ? round1((repeats / events.length) * 100) : null,
    avgAgeMonths: ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null,
    avgRepairCost: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) / costs.length) : null,
    topComponents: topN(comp).map(([component, count]) => ({ component, count })),
    topModels: topN(mdl).map(([model, count]) => ({ model, count })),
  };
}

/**
 * One-time index of failure events by replaced-part tag, so matching 2000 parts against 600 events
 * costs (unique tags × parts) tag checks instead of (events × parts).
 */
export function buildFailureIndex(events: PartFailureEvent[]) {
  const byTag = new Map<string, PartFailureEvent[]>();
  for (const e of events) {
    for (const t of new Set(e.parts_replaced)) {
      const list = byTag.get(t);
      if (list) list.push(e);
      else byTag.set(t, [e]);
    }
  }
  const tags = [...byTag.keys()];
  return (part: { name: string; part_number: string | null }): PartFailureEvent[] => {
    const seen = new Set<string>();
    const out: PartFailureEvent[] = [];
    for (const t of tags) {
      if (!partMatchesTag(part, t)) continue;
      for (const e of byTag.get(t) ?? []) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          out.push(e);
        }
      }
    }
    return out.sort((a, b) => b.occurred_on.localeCompare(a.occurred_on));
  };
}

/** Population patterns (Failure Genome) whose top replaced parts refer to this part. */
export function patternsForPart<T extends PatternLite>(
  part: { name: string; part_number: string | null },
  patterns: T[],
): T[] {
  return patterns
    .filter((p) => p.top_parts.some((t) => partMatchesTag(part, t.tag)))
    .sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0));
}

// ============================================================
// SUBSTITUTES
// ============================================================

export interface RankedSubstitute extends PiSubstitute {
  effectiveCents: number;
  savingsCents: number | null;
  inStock: boolean;
}

/** In-stock first, then cheapest all-in price (live offer if any, else own cost). */
export function rankSubstitutes(subs: PiSubstitute[], referenceCents: number | null): RankedSubstitute[] {
  return subs
    .map((s) => {
      const effective = s.best_offer_cents != null ? Math.min(s.best_offer_cents, s.unit_cost_cents || s.best_offer_cents) : s.unit_cost_cents;
      return {
        ...s,
        effectiveCents: effective,
        savingsCents: referenceCents !== null && referenceCents > 0 ? referenceCents - effective : null,
        inStock: (s.available ?? 0) > 0,
      };
    })
    .sort((a, b) => Number(b.inStock) - Number(a.inStock) || a.effectiveCents - b.effectiveCents);
}

// ============================================================
// RECALL SIGNAL
// ============================================================

export interface RecallSignal {
  level: 'none' | Severity;
  partLinkedRecalls: number;
  partLinkedBulletins: number;
  modelLevelRecalls: number;
  affectedUnits: number;
  headline: string;
}

export function recallSignal(d: PiDetail | null): RecallSignal {
  if (!d || !d.found) {
    return { level: 'none', partLinkedRecalls: 0, partLinkedBulletins: 0, modelLevelRecalls: 0, affectedUnits: 0, headline: 'No OEM data' };
  }
  const recalls = d.issues.filter((i) => i.recall).length;
  const bulletins = d.issues.filter((i) => i.bulletin).length;
  let top = 0;
  for (const i of d.issues) top = Math.max(top, SEVERITY_RANK[i.recall?.severity ?? i.severity]);
  const level = (['none', 'low', 'medium', 'high', 'critical'] as const)[top];
  const units = d.units.length;
  let headline = 'No recall or bulletin is linked to this part';
  if (recalls > 0) headline = `${recalls} recall${recalls > 1 ? 's' : ''} linked to this part${units ? ` · fits ${units} of your units` : ''}`;
  else if (bulletins > 0) headline = `${bulletins} service bulletin${bulletins > 1 ? 's' : ''} linked to this part`;
  else if (d.issues.length > 0) headline = `${d.issues.length} known issue${d.issues.length > 1 ? 's' : ''} require this part`;
  else if (d.model_recalls.length > 0) headline = `${d.model_recalls.length} recall${d.model_recalls.length > 1 ? 's' : ''} exist on models this part fits (not part-specific)`;
  return { level, partLinkedRecalls: recalls, partLinkedBulletins: bulletins, modelLevelRecalls: d.model_recalls.length, affectedUnits: units, headline };
}

// ============================================================
// RISK SCORE (explainable: every point has a reason)
// ============================================================

export interface RiskFactor {
  key: 'recall' | 'stock' | 'failures' | 'price' | 'supplier' | 'cover';
  label: string;
  points: number;
  detail: string;
}

export interface RiskScore {
  score: number;
  tier: RiskTier;
  factors: RiskFactor[];
}

export function scoreRisk(p: {
  maxRecallSeverity: Severity | null;
  hasRecall: boolean;
  stockRisk: StockRisk;
  daysOfCover: number | null;
  hasInStockSubstitute: boolean;
  hasSubstitutes: boolean;
  emergingPatterns: number;
  elevatedPatterns: number;
  failureTrend: 'up' | 'down' | 'flat' | null;
  priceSignal: PriceSignal | null;
  worstSupplierConfidentPct: number | null;
  supplierSampleSize: number;
}): RiskScore {
  const f: RiskFactor[] = [];
  const add = (x: RiskFactor) => x.points !== 0 && f.push(x);

  if (p.maxRecallSeverity) {
    const pts = { critical: 40, high: 30, medium: 15, low: 5 }[p.maxRecallSeverity] * (p.hasRecall ? 1 : 0.5);
    add({ key: 'recall', label: p.hasRecall ? 'Recall linked' : 'Known OEM issue', points: Math.round(pts), detail: `Highest severity: ${p.maxRecallSeverity}` });
  }
  const stockPts = { critical: 30, high: 20, watch: 10, ok: 0 }[p.stockRisk];
  add({ key: 'stock', label: 'Stock-out risk', points: stockPts, detail: p.daysOfCover !== null ? `About ${Math.round(p.daysOfCover)} days of cover left` : 'Below reorder point' });
  if (p.stockRisk !== 'ok') {
    if (p.hasInStockSubstitute) add({ key: 'cover', label: 'In-stock substitute', points: -5, detail: 'An approved substitute is on hand' });
    else if (!p.hasSubstitutes) add({ key: 'cover', label: 'No approved substitute', points: 5, detail: 'Nothing can stand in if this runs out' });
  }
  if (p.emergingPatterns > 0) add({ key: 'failures', label: 'Emerging failure pattern', points: 15, detail: `${p.emergingPatterns} network pattern(s) involve this part` });
  else if (p.elevatedPatterns > 0) add({ key: 'failures', label: 'Elevated failure pattern', points: 10, detail: `${p.elevatedPatterns} network pattern(s) involve this part` });
  if (p.failureTrend === 'up') add({ key: 'failures', label: 'Your failures are rising', points: 5, detail: 'More part-related failures in the last 12 months than the 12 before' });
  if (p.priceSignal === 'spiking') add({ key: 'price', label: 'Price spike', points: 10, detail: 'Best quote is >20% above its 30-day median' });
  else if (p.priceSignal === 'elevated') add({ key: 'price', label: 'Price elevated', points: 5, detail: 'Best quote is 7–20% above its 30-day median' });
  if (p.worstSupplierConfidentPct !== null && p.supplierSampleSize >= 5 && p.worstSupplierConfidentPct < 70) {
    add({ key: 'supplier', label: 'Weak supplier record', points: 10, detail: `Confident success rate ${Math.round(p.worstSupplierConfidentPct)}%` });
  }

  const score = clamp(f.reduce((a, x) => a + x.points, 0), 0, 100);
  const tier: RiskTier = score >= 60 ? 'critical' : score >= 35 ? 'high' : score >= 15 ? 'watch' : 'healthy';
  return { score, tier, factors: f.sort((a, b) => b.points - a.points) };
}

/** Light version for the portfolio list — uses only what the overview RPC returns. */
export function scoreOverviewRow(row: PiOverviewRow, now: Date = new Date()): { forecast: DemandForecast; risk: RiskScore } {
  const forecast = forecastDemand({
    weekly: row.weekly_usage,
    scheduled30d: row.scheduled_30d,
    available: row.available,
    reorderPoint: row.reorder_point,
    reorderQuantity: row.reorder_quantity,
    now,
  });
  const risk = scoreRisk({
    maxRecallSeverity: row.max_severity,
    hasRecall: row.recall_count > 0,
    stockRisk: forecast.stockRisk,
    daysOfCover: forecast.daysOfCover,
    hasInStockSubstitute: false,
    hasSubstitutes: true, // unknown at list level — never penalise on missing info
    emergingPatterns: 0,
    elevatedPatterns: 0,
    failureTrend: null,
    priceSignal: null,
    worstSupplierConfidentPct: null,
    supplierSampleSize: 0,
  });
  return { forecast, risk };
}

export const TIER_ORDER: Record<RiskTier, number> = { critical: 0, high: 1, watch: 2, healthy: 3 };
