/**
 * Supplier Intelligence — pure analysis engine
 *
 * Turns the data Vireek already holds (vendors, purchase orders, goods
 * receipts, evaluations, RFQs/quotes, inventory catalog + forecast, and the
 * AI Parts Market offers/price history) into:
 *
 *   1. a scored, risk-rated PROFILE per supplier,
 *   2. a per-part SOURCING comparison (who should we buy this part from?),
 *   3. a forward-looking SUPPLY OUTLOOK (what runs out, when, what to order),
 *   4. a ranked list of ACTIONABLE RECOMMENDATIONS with evidence.
 *
 * Design rules (same as partsMarket.ts):
 *   - PURE and deterministic: no network, no randomness, `now` is injected.
 *     Every number is explainable, auditable and unit-testable.
 *   - Small samples are shrunk toward a neutral prior, so a vendor with one
 *     lucky delivery never outranks a vendor with 40 solid ones; the
 *     `confidence` field tells the UI how much to trust each score.
 *   - Missing data is NEVER invented. A dimension without evidence is `null`
 *     and drops out of the composite (weights are renormalised).
 *   - All money is integer cents. All durations are days unless noted.
 *
 * Data access lives in supplierIntelligenceApi.ts.
 */

import type {
  GoodsReceipt,
  GoodsReceiptItem,
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseRequest,
  RfqVendor,
  Vendor,
  VendorEvaluation,
  VendorQuote,
} from './procurement';
import type {
  InventoryForecastRow,
  InventoryPart,
  InventoryVendor,
  PartVendorCatalogEntry,
} from './inventory';
import type { MarketOfferRow, MarketSource, PriceHistoryRow } from './partsMarket';

// ============================================================
// CONSTANTS (exported so the UI can show the assumptions)
// ============================================================

const DAY_MS = 86_400_000;

/** Lead time assumed when a part has no usable lead-time evidence at all. */
export const DEFAULT_LEAD_DAYS = 7;
/** Buffer added on top of lead time before stock must be re-ordered. */
export const SAFETY_DAYS = 2;
/** After a re-order we want to be covered for this many extra days. */
export const COVERAGE_CYCLE_DAYS = 30;

/** Expected extra cost of unreliability, as a share of landed cost. */
export const RISK_PREMIUM = { latePerMissedRate: 0.15, shortPerMissedRate: 0.25 } as const;

export const THRESHOLDS = {
  renegotiatePriceIndex: 1.08,
  renegotiateMinPricedParts: 3,
  renegotiateMinSpend90dCents: 50_000,
  lowOnTimeRate: 0.75,
  lowFillRate: 0.9,
  minObservationsForReliabilityFlag: 5,
  concentrationShare: 0.5,
  singleSourceMinParts: 3,
  priceSpikePct30: 8,
  dormantDays: 180,
  switchPreferredMinSavingsPct: 0.05,
  switchPreferredMinAnnualSavingsCents: 5_000,
} as const;

export type SourcingPriority = 'balanced' | 'cost' | 'speed' | 'reliability';

export const PRIORITY_LABELS: Record<SourcingPriority, string> = {
  balanced: 'Balanced',
  cost: 'Lowest cost',
  speed: 'Fastest delivery',
  reliability: 'Most reliable',
};

type Dimension = 'reliability' | 'quality' | 'price' | 'leadTime' | 'responsiveness';

const PRIORITY_WEIGHTS: Record<SourcingPriority, Record<Dimension, number>> = {
  balanced: { reliability: 0.3, quality: 0.2, price: 0.25, leadTime: 0.15, responsiveness: 0.1 },
  cost: { reliability: 0.2, quality: 0.15, price: 0.45, leadTime: 0.1, responsiveness: 0.1 },
  speed: { reliability: 0.3, quality: 0.1, price: 0.1, leadTime: 0.4, responsiveness: 0.1 },
  reliability: { reliability: 0.45, quality: 0.3, price: 0.1, leadTime: 0.1, responsiveness: 0.05 },
};

/** Neutral score used for ranking inside one part when a dimension is unknown. */
const UNKNOWN_DIMENSION_SCORE = 55;

// ============================================================
// TYPES
// ============================================================

export type RiskLevel = 'low' | 'moderate' | 'high' | 'critical';
export type Confidence = 'none' | 'low' | 'medium' | 'high';
export type SupplierOrigin = 'procurement' | 'inventory' | 'market';
export type PriceBasis = 'po' | 'offer' | 'history' | 'catalog';
export type LeadBasis = 'live_offer' | 'catalog' | 'observed' | 'quoted' | 'default';

export interface PurchaseOrderWithItems extends PurchaseOrder {
  items: PurchaseOrderItem[];
}
export interface GoodsReceiptWithItems extends GoodsReceipt {
  items: GoodsReceiptItem[];
}

export type PartInfo = Pick<
  InventoryPart,
  'id' | 'name' | 'part_number' | 'category' | 'unit_cost_cents' | 'reorder_point' | 'reorder_quantity'
>;

export interface SupplierInput {
  now: Date;
  vendors: Vendor[];
  inventoryVendors: InventoryVendor[];
  evaluations: VendorEvaluation[];
  purchaseOrders: PurchaseOrderWithItems[];
  receipts: GoodsReceiptWithItems[];
  rfqVendors: RfqVendor[];
  quotes: Pick<
    VendorQuote,
    'id' | 'rfq_id' | 'vendor_id' | 'status' | 'lead_time_days' | 'submitted_at' | 'created_at'
  >[];
  purchaseRequests: PurchaseRequest[];
  catalog: PartVendorCatalogEntry[];
  parts: PartInfo[];
  marketSources: MarketSource[];
  offers: MarketOfferRow[];
  priceHistory: PriceHistoryRow[];
  forecast: InventoryForecastRow[];
}

export interface RiskFactor {
  key: 'delivery' | 'concentration' | 'single_source' | 'price' | 'overdue' | 'unknown';
  label: string;
  /** 0 (no risk) – 100 (maximum risk). */
  score: number;
  weight: number;
  detail: string;
}

export interface SupplierScores {
  reliability: number | null;
  quality: number | null;
  price: number | null;
  leadTime: number | null;
  responsiveness: number | null;
}

export interface SupplierProfile {
  key: string;
  name: string;
  origin: SupplierOrigin;
  vendorId: string | null;
  category: string | null;
  active: boolean;
  email: string | null;
  phone: string | null;
  linkedInventoryVendorIds: string[];
  linkedSourceIds: string[];

  // activity
  orders: number;
  spend12mCents: number;
  spend90dCents: number;
  spendShare: number;
  lastOrderAt: string | null;
  daysSinceLastOrder: number | null;

  // delivery
  onTimeRate: number | null;
  onTimeSource: 'receipts' | 'evaluations' | null;
  onTimeSample: number;
  avgDelayDays: number | null;
  overdueOpenOrders: number;
  fillRate: number | null;
  damageRate: number | null;
  leadTime: {
    medianDays: number | null;
    p80Days: number | null;
    cv: number | null;
    basis: 'observed' | 'quoted' | 'catalog' | null;
    sample: number;
  };

  // price
  priceIndex: number | null;
  pricedParts: number;
  priceTrend30dPct: number | null;
  priceVolatility: number | null;
  shippingRate: number;

  // responsiveness
  rfqInvites: number;
  rfqResponseRate: number | null;
  avgQuoteTurnaroundDays: number | null;
  communicationScore: number | null;

  // coverage
  partsSupplied: number;
  singleSourcePartIds: string[];

  scores: SupplierScores;
  evidence: number;
  confidence: Confidence;
  risk: { score: number; level: RiskLevel; factors: RiskFactor[] };
}

export interface ScoredSupplier extends SupplierProfile {
  composite: number | null;
  /** Share of the priority's weight that had data (0-1). */
  coverage: number;
  rank: number | null;
}

export interface PartSupplierCandidate {
  key: string;
  name: string;
  origin: SupplierOrigin;
  unitPriceCents: number;
  priceBasis: PriceBasis;
  priceAgeDays: number | null;
  priceStale: boolean;
  vsBestPct: number;
  availableQty: number | null;
  coversQuantity: boolean | null;
  leadTimeDays: number | null;
  leadBasis: LeadBasis;
  landedCostCents: number;
  riskAdjustedCostCents: number;
  reliability: number | null;
  quality: number | null;
  riskScore: number;
  riskLevel: RiskLevel;
  confidence: Confidence;
  isPreferred: boolean;
  partScore: number;
  rank: number;
}

export interface PartSourcingResult {
  partId: string;
  partName: string;
  quantity: number;
  candidates: PartSupplierCandidate[];
  primary: PartSupplierCandidate | null;
  backup: PartSupplierCandidate | null;
  preferred: PartSupplierCandidate | null;
  savingsVsPreferredCents: number | null;
  singleSource: boolean;
  priceTrend30dPct: number | null;
  rationale: string[];
}

export type OutlookStatus = 'order_now' | 'watch' | 'ok' | 'request_open' | 'no_demand';

export interface SupplyOutlookRow {
  partId: string;
  partName: string;
  partNumber: string | null;
  available: number;
  dailyUsage: number;
  demandTrend: 'rising' | 'falling' | 'flat';
  daysOfStock: number | null;
  inboundQty: number;
  inboundLate: boolean;
  coverageDays: number | null;
  leadTimeDays: number;
  slackDays: number | null;
  reorderByDate: string | null;
  stockoutDate: string | null;
  status: OutlookStatus;
  recommendedQty: number;
  primary: PartSupplierCandidate | null;
  estimatedCostCents: number | null;
  priceOutlookPct30: number | null;
  supplyRiskScore: number | null;
  singleSource: boolean;
  noSupplier: boolean;
  openRequestQty: number;
  sourcing: PartSourcingResult | null;
}

export type RecommendationKind =
  | 'reorder_now'
  | 'source_part'
  | 'renegotiate'
  | 'switch_preferred'
  | 'diversify'
  | 'review_supplier'
  | 'price_alert'
  | 'dormant'
  | 'data_gap';

export type RecommendationSeverity = 'critical' | 'high' | 'medium' | 'low';

export type RecommendationAction =
  | {
      type: 'create_purchase_request';
      partId: string;
      quantity: number;
      neededBy: string | null;
      note: string;
    }
  | { type: 'navigate'; label: string; href: string };

export interface SupplierRecommendation {
  id: string;
  kind: RecommendationKind;
  severity: RecommendationSeverity;
  title: string;
  detail: string;
  evidence: string[];
  /** Estimated annualised saving, or cost exposure avoided. Null when unknowable. */
  impactCents: number | null;
  confidence: Confidence;
  supplierKey?: string;
  partId?: string;
  action: RecommendationAction;
}

export interface SupplierSummary {
  activeSuppliers: number;
  totalSpend12mCents: number;
  topSupplierShare: number;
  hhi: number;
  concentrationLevel: RiskLevel;
  weightedOnTimeRate: number | null;
  atRiskSuppliers: number;
  singleSourceParts: number;
  partsToOrderNow: number;
  savingsOpportunityCents: number;
  overdueOpenOrders: number;
  /** Share of active suppliers with at least medium confidence (0-1). */
  dataCoverage: number;
}

export interface SupplierIntelligenceResult {
  priority: SourcingPriority;
  generatedAt: string;
  profiles: ScoredSupplier[];
  summary: SupplierSummary;
  outlook: SupplyOutlookRow[];
  recommendations: SupplierRecommendation[];
}

interface PricePoint {
  price: number;
  at: number | null;
  basis: PriceBasis;
  qty: number | null;
  etaDays: number | null;
  leadDays: number | null;
  feeCents: number;
  preferred: boolean;
}

interface PartPrice {
  price: number;
  ageDays: number | null;
  basis: PriceBasis;
  stale: boolean;
  qty: number | null;
  etaDays: number | null;
  leadDays: number | null;
  feeCents: number;
  preferred: boolean;
}

interface ForecastAgg {
  partName: string;
  partNumber: string | null;
  available: number;
  dailyUsage: number;
  trend: 'rising' | 'falling' | 'flat';
}

export interface SupplierContext {
  now: Date;
  profiles: SupplierProfile[];
  byKey: Map<string, SupplierProfile>;
  parts: Map<string, PartInfo>;
  partPrices: Map<string, Map<string, PartPrice>>;
  partTrend: Map<string, number | null>;
  partSuppliers: Map<string, string[]>;
  preferredKey: Map<string, string>;
  forecast: Map<string, ForecastAgg>;
  inbound: Map<string, { qty: number; earliestEtaMs: number | null }>;
  openRequests: Map<string, number>;
  totalSpend12mCents: number;
}

// ============================================================
// SMALL HELPERS
// ============================================================

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
const round = (v: number, d = 1) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

const median = (xs: number[]) => percentile(xs, 0.5);

function stdev(xs: number[]): number | null {
  const m = mean(xs);
  if (m === null || xs.length < 2) return null;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

/** Bayesian-style shrinkage: n observations pull `value` away from `prior`. */
const shrink = (value: number, n: number, prior: number, k: number) =>
  (value * n + prior * k) / (n + k);

const toMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** `expected_delivery_date` is a date: the promise holds until end of that day. */
const endOfDayMs = (d: string | null | undefined): number | null => {
  if (!d) return null;
  return toMs(d.length <= 10 ? `${d}T23:59:59Z` : d);
};

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function fmtMoney(cents: number, decimals = 0): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

const LEGAL_SUFFIXES = new Set([
  'inc', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'limited', 'lp', 'llp', 'plc', 'gmbh',
]);

/** "ACME Supply, Inc." and "Acme Supply" resolve to the same supplier. */
export function normalizeName(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

export function riskLevelFor(score: number): RiskLevel {
  if (score < 25) return 'low';
  if (score < 45) return 'moderate';
  if (score < 65) return 'high';
  return 'critical';
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, moderate: 1, high: 2, critical: 3 };

export function confidenceFor(evidence: number): Confidence {
  if (evidence <= 0) return 'none';
  if (evidence < 4) return 'low';
  if (evidence < 12) return 'medium';
  return 'high';
}

/** Least-squares price drift, expressed as % change per 30 days. Null if too thin. */
function trendPct30(points: { at: number; price: number }[]): number | null {
  if (points.length < 3) return null;
  const t0 = Math.min(...points.map((p) => p.at));
  const xs = points.map((p) => (p.at - t0) / DAY_MS);
  const span = Math.max(...xs);
  if (span < 14) return null;
  const ys = points.map((p) => p.price);
  const mx = mean(xs) as number;
  const my = mean(ys) as number;
  if (my <= 0) return null;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (sxx === 0) return null;
  const sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  return clamp(((sxy / sxx) * 30 * 100) / my, -100, 100);
}

export function compositeScore(
  scores: SupplierScores,
  priority: SourcingPriority,
): { composite: number | null; coverage: number } {
  const w = PRIORITY_WEIGHTS[priority];
  let sum = 0;
  let weight = 0;
  (Object.keys(w) as Dimension[]).forEach((d) => {
    const v = scores[d];
    if (v !== null) {
      sum += v * w[d];
      weight += w[d];
    }
  });
  return weight === 0
    ? { composite: null, coverage: 0 }
    : { composite: round(sum / weight), coverage: round(weight, 2) };
}

function weightedAvg(parts: [number, number][], scale: number): number | null {
  if (!parts.length) return null;
  const w = parts.reduce((a, [, wt]) => a + wt, 0);
  return (parts.reduce((a, [v, wt]) => a + v * wt, 0) / w) * scale;
}

// ============================================================
// CONTEXT BUILDER — resolves entities and derives every profile
// ============================================================

interface EntityDraft {
  key: string;
  name: string;
  origin: SupplierOrigin;
  vendorId: string | null;
  category: string | null;
  active: boolean;
  email: string | null;
  phone: string | null;
  invIds: string[];
  sourceIds: string[];
  defaultLeadDays: number | null;
}

interface PoStats {
  orders: number;
  spend12m: number;
  spend90d: number;
  lastOrderMs: number | null;
  onTime: number;
  late: number;
  delays: number[];
  overdueOpen: number;
  leadDays: number[];
  quotedLeadDays: number[];
  filledQty: number;
  orderedQty: number;
  fillPOs: number;
  damagedLines: number;
  receiptLines: number;
  shipping: number;
  subtotal: number;
}

const newPoStats = (): PoStats => ({
  orders: 0, spend12m: 0, spend90d: 0, lastOrderMs: null, onTime: 0, late: 0, delays: [],
  overdueOpen: 0, leadDays: [], quotedLeadDays: [], filledQty: 0, orderedQty: 0, fillPOs: 0,
  damagedLines: 0, receiptLines: 0, shipping: 0, subtotal: 0,
});

const QUALIFYING_PO = new Set(['approved', 'sent', 'partially_received', 'received', 'closed']);
const OPEN_PO = new Set(['approved', 'sent', 'partially_received']);
const OPEN_REQUEST = new Set(['draft', 'rfq_sent', 'quotes_received', 'approved']);

function latestPrice(points: PricePoint[], nowMs: number): PartPrice | null {
  const dated = points
    .filter((p): p is PricePoint & { at: number } => p.at !== null)
    .sort((a, b) => b.at - a.at);
  const fresh = dated.find((p) => nowMs - p.at <= 365 * DAY_MS);
  const catalog = points.find((p) => p.basis === 'catalog');
  const chosen = fresh ?? catalog ?? dated[0];
  if (!chosen) return null;
  // Real-time facts (stock, ETA, delivery fee) come from the newest live offer, never from an old PO.
  const liveOffer = dated.find((p) => p.basis === 'offer');
  const leadSource = catalog ?? chosen;
  return {
    price: chosen.price,
    ageDays: chosen.at === null ? null : Math.max(0, Math.round((nowMs - chosen.at) / DAY_MS)),
    basis: chosen.basis,
    stale: chosen.at !== null && !fresh,
    qty: liveOffer ? liveOffer.qty : null,
    etaDays: liveOffer ? liveOffer.etaDays : null,
    leadDays: leadSource.leadDays,
    feeCents: liveOffer ? liveOffer.feeCents : 0,
    preferred: points.some((p) => p.preferred),
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildSupplierContext(input: SupplierInput): SupplierContext {
  const nowMs = input.now.getTime();

  // ---------- 1. entity resolution ----------
  const entities = new Map<string, EntityDraft>();
  const nameIndex = new Map<string, string>();

  for (const v of input.vendors) {
    const key = `vendor:${v.id}`;
    entities.set(key, {
      key, name: v.name, origin: 'procurement', vendorId: v.id, category: v.category,
      active: v.active, email: v.email, phone: v.phone, invIds: [], sourceIds: [], defaultLeadDays: null,
    });
    const nk = normalizeName(v.name);
    if (nk && !nameIndex.has(nk)) nameIndex.set(nk, key);
  }

  const invToKey = new Map<string, string>();
  for (const iv of input.inventoryVendors) {
    const nk = normalizeName(iv.name);
    let key = nk ? nameIndex.get(nk) : undefined;
    if (!key) {
      key = `inv:${iv.id}`;
      entities.set(key, {
        key, name: iv.name, origin: 'inventory', vendorId: null, category: null, active: iv.active,
        email: iv.email, phone: iv.phone, invIds: [], sourceIds: [], defaultLeadDays: null,
      });
      if (nk) nameIndex.set(nk, key);
    }
    const e = entities.get(key) as EntityDraft;
    e.invIds.push(iv.id);
    if (iv.default_lead_time_days > 0) e.defaultLeadDays = iv.default_lead_time_days;
    invToKey.set(iv.id, key);
  }

  const sourceToKey = new Map<string, string>();
  for (const s of input.marketSources) {
    if (s.source_type === 'contractor') continue; // borrowing is the Parts Market's domain
    const nk = normalizeName(s.name);
    let key: string | undefined =
      s.vendor_id && entities.has(`vendor:${s.vendor_id}`) ? `vendor:${s.vendor_id}` : undefined;
    if (!key && nk) key = nameIndex.get(nk);
    if (!key) {
      key = `src:${s.id}`;
      entities.set(key, {
        key, name: s.name, origin: 'market', vendorId: null, category: s.source_type,
        active: s.active, email: null, phone: s.phone, invIds: [], sourceIds: [], defaultLeadDays: null,
      });
      if (nk) nameIndex.set(nk, key);
    }
    (entities.get(key) as EntityDraft).sourceIds.push(s.id);
    sourceToKey.set(s.id, key);
  }

  // ---------- 2. purchase-order derived stats + price points ----------
  const stats = new Map<string, PoStats>();
  const statsFor = (key: string) => {
    let s = stats.get(key);
    if (!s) stats.set(key, (s = newPoStats()));
    return s;
  };
  const receiptsByPo = new Map<string, GoodsReceiptWithItems[]>();
  for (const r of input.receipts) push(receiptsByPo, r.po_id, r);

  const points = new Map<string, Map<string, PricePoint[]>>(); // part -> supplier -> points
  const addPoint = (partId: string, key: string, p: PricePoint) => {
    if (!(p.price > 0)) return;
    let bySupplier = points.get(partId);
    if (!bySupplier) points.set(partId, (bySupplier = new Map()));
    push(bySupplier, key, p);
  };

  const inbound = new Map<string, { qty: number; earliestEtaMs: number | null }>();

  for (const po of input.purchaseOrders) {
    const key = `vendor:${po.vendor_id}`;
    if (!entities.has(key) || !QUALIFYING_PO.has(po.status)) continue;
    const s = statsFor(key);
    const createdMs = toMs(po.created_at) ?? nowMs;
    const ageDays = (nowMs - createdMs) / DAY_MS;
    s.orders += 1;
    if (ageDays <= 365) s.spend12m += po.total_cents;
    if (ageDays <= 90) s.spend90d += po.total_cents;
    s.lastOrderMs = Math.max(s.lastOrderMs ?? 0, createdMs);
    s.shipping += po.shipping_cents;
    s.subtotal += po.subtotal_cents;

    const items = po.items ?? [];
    const receipts = receiptsByPo.get(po.id) ?? [];
    const receiptTimes = receipts.map((r) => toMs(r.received_at)).filter((t): t is number => t !== null);
    const firstReceipt = receiptTimes.length ? Math.min(...receiptTimes) : null;
    const lastReceipt = receiptTimes.length ? Math.max(...receiptTimes) : null;
    const done = po.status === 'received' || po.status === 'closed';

    // on-time / delay (observed from the promise vs actual receipt)
    const promised = endOfDayMs(po.expected_delivery_date);
    if (promised !== null) {
      if (done && lastReceipt !== null) {
        if (lastReceipt <= promised) s.onTime += 1;
        else {
          s.late += 1;
          s.delays.push(Math.ceil((lastReceipt - promised) / DAY_MS));
        }
      } else if (OPEN_PO.has(po.status) && promised < nowMs) {
        s.late += 1;
        s.overdueOpen += 1;
        s.delays.push(Math.ceil((nowMs - promised) / DAY_MS));
      }
    }

    // observed lead time: start of the order -> first goods receipt
    if (firstReceipt !== null) {
      const startMs = toMs(po.sent_at) ?? toMs(po.approved_at) ?? createdMs;
      const lead = (firstReceipt - startMs) / DAY_MS;
      if (lead >= 0 && lead <= 180) s.leadDays.push(lead);
    }

    // fill rate (only orders that are finished, or partial for > 14 days)
    if (done || (po.status === 'partially_received' && ageDays > 14)) {
      const ordered = items.reduce((a, i) => a + i.quantity_ordered, 0);
      const got = items.reduce((a, i) => a + Math.min(i.quantity_received, i.quantity_ordered), 0);
      if (ordered > 0) {
        s.orderedQty += ordered;
        s.filledQty += got;
        s.fillPOs += 1;
      }
    }

    // receipt condition
    for (const r of receipts) {
      for (const li of r.items ?? []) {
        s.receiptLines += 1;
        if (li.condition === 'damaged') s.damagedLines += 1;
      }
    }

    // price points
    const priceAt = toMs(po.sent_at) ?? createdMs;
    for (const it of items) {
      if (it.part_id) {
        addPoint(it.part_id, key, {
          price: it.unit_price_cents, at: priceAt, basis: 'po', qty: null, etaDays: null,
          leadDays: null, feeCents: 0, preferred: false,
        });
      }
    }

    // inbound supply (open orders still owed to us)
    if (OPEN_PO.has(po.status)) {
      const etaMs = endOfDayMs(po.expected_delivery_date);
      for (const it of items) {
        const owed = Math.max(0, it.quantity_ordered - it.quantity_received);
        if (!it.part_id || owed === 0) continue;
        const cur = inbound.get(it.part_id) ?? { qty: 0, earliestEtaMs: null };
        cur.qty += owed;
        if (etaMs !== null) cur.earliestEtaMs = Math.min(cur.earliestEtaMs ?? etaMs, etaMs);
        inbound.set(it.part_id, cur);
      }
    }
  }

  // quotes -> quoted lead time + RFQ responsiveness
  const quoteByRfqVendor = new Map<string, (typeof input.quotes)[number]>();
  for (const q of input.quotes) {
    quoteByRfqVendor.set(`${q.rfq_id}:${q.vendor_id}`, q);
    const key = `vendor:${q.vendor_id}`;
    if (
      entities.has(key) &&
      (q.status === 'submitted' || q.status === 'selected') &&
      q.lead_time_days !== null &&
      q.lead_time_days >= 0
    ) {
      statsFor(key).quotedLeadDays.push(q.lead_time_days);
    }
  }
  const rfq = new Map<string, { invites: number; responded: number; turnarounds: number[] }>();
  for (const rv of input.rfqVendors) {
    const key = `vendor:${rv.vendor_id}`;
    if (!entities.has(key) || rv.status === 'declined') continue;
    const r = rfq.get(key) ?? { invites: 0, responded: 0, turnarounds: [] };
    r.invites += 1;
    const q = quoteByRfqVendor.get(`${rv.rfq_id}:${rv.vendor_id}`);
    const answered = rv.status === 'responded' || q?.status === 'submitted' || q?.status === 'selected';
    if (answered) {
      r.responded += 1;
      const sent = toMs(rv.sent_at);
      const back = toMs(q?.submitted_at);
      if (sent !== null && back !== null && back >= sent) r.turnarounds.push((back - sent) / DAY_MS);
    }
    rfq.set(key, r);
  }

  // evaluations
  const evals = new Map<string, { q: number[]; p: number[]; c: number[]; onTime: number; late: number }>();
  for (const ev of input.evaluations) {
    const key = `vendor:${ev.vendor_id}`;
    if (!entities.has(key)) continue;
    const e = evals.get(key) ?? { q: [], p: [], c: [], onTime: 0, late: 0 };
    if (ev.quality_score !== null) e.q.push(ev.quality_score);
    if (ev.price_score !== null) e.p.push(ev.price_score);
    if (ev.communication_score !== null) e.c.push(ev.communication_score);
    if (ev.on_time === true) e.onTime += 1;
    if (ev.on_time === false) e.late += 1;
    evals.set(key, e);
  }

  // ---------- 3. catalog / market price points ----------
  for (const c of input.catalog) {
    const key = invToKey.get(c.vendor_id);
    if (!key) continue;
    addPoint(c.part_id, key, {
      price: c.unit_cost_cents, at: null, basis: 'catalog', qty: null, etaDays: null,
      leadDays: c.lead_time_days, feeCents: 0, preferred: c.is_preferred,
    });
  }
  for (const o of input.offers) {
    if (o.is_expired || !o.source_active || o.source_type === 'contractor') continue;
    const key = sourceToKey.get(o.source_id);
    if (!key) continue;
    addPoint(o.part_id, key, {
      price: o.unit_price_cents, at: toMs(o.observed_at), basis: 'offer', qty: o.quantity_available,
      etaDays: o.eta_minutes !== null ? o.eta_minutes / 1440 : null, leadDays: null,
      feeCents: o.delivery_fee_cents, preferred: false,
    });
  }
  for (const h of input.priceHistory) {
    const key = sourceToKey.get(h.source_id);
    if (!key) continue;
    addPoint(h.part_id, key, {
      price: h.unit_price_cents, at: toMs(h.observed_at), basis: 'history', qty: null, etaDays: null,
      leadDays: null, feeCents: 0, preferred: false,
    });
  }

  // ---------- 4. per-part price tables, trends, supplier sets ----------
  const partPrices = new Map<string, Map<string, PartPrice>>();
  const partTrend = new Map<string, number | null>();
  const partSuppliers = new Map<string, string[]>();
  const preferredKey = new Map<string, string>();
  const supplierTrends = new Map<string, number[]>();
  const supplierVol = new Map<string, number[]>();
  const priceRatios = new Map<string, number[]>();
  const partsSupplied = new Map<string, Set<string>>();

  for (const [partId, bySupplier] of points) {
    const latest = new Map<string, PartPrice>();
    const trends: number[] = [];
    for (const [key, list] of bySupplier) {
      const lp = latestPrice(list, nowMs);
      if (!lp) continue;
      latest.set(key, lp);
      let set = partsSupplied.get(key);
      if (!set) partsSupplied.set(key, (set = new Set()));
      set.add(partId);
      if (lp.preferred) preferredKey.set(partId, key);

      const recent = list
        .filter((p): p is PricePoint & { at: number } => p.at !== null && nowMs - p.at <= 120 * DAY_MS)
        .map((p) => ({ at: p.at, price: p.price }));
      const t = trendPct30(recent);
      if (t !== null) {
        trends.push(t);
        push(supplierTrends, key, t);
      }
      if (recent.length >= 3) {
        const m = mean(recent.map((r) => r.price)) as number;
        const sd = stdev(recent.map((r) => r.price));
        if (sd !== null && m > 0) push(supplierVol, key, sd / m);
      }
    }
    partPrices.set(partId, latest);
    partTrend.set(partId, median(trends));
    partSuppliers.set(partId, [...latest.keys()].filter((k) => entities.get(k)?.active));

    if (latest.size >= 2) {
      const ref = median([...latest.values()].map((p) => p.price)) as number;
      for (const [key, p] of latest) push(priceRatios, key, p.price / ref);
    }
  }

  // ---------- 5. forecast + open requests ----------
  const forecast = new Map<string, ForecastAgg>();
  const trendUsage = new Map<string, Record<'rising' | 'falling' | 'flat', number>>();
  for (const f of input.forecast) {
    const usage = 0.6 * f.avg_daily_usage_30d + 0.4 * f.avg_daily_usage_90d;
    const agg: ForecastAgg = forecast.get(f.part_id) ?? {
      partName: f.part_name, partNumber: f.part_number, available: 0, dailyUsage: 0, trend: 'flat',
    };
    agg.available += Math.max(0, f.quantity_available);
    agg.dailyUsage += usage;
    forecast.set(f.part_id, agg);
    const tu = trendUsage.get(f.part_id) ?? { rising: 0, falling: 0, flat: 0 };
    tu[f.demand_trend] += usage;
    trendUsage.set(f.part_id, tu);
  }
  for (const [partId, agg] of forecast) {
    const tu = trendUsage.get(partId);
    if (tu) agg.trend = Object.entries(tu).sort((a, b) => b[1] - a[1])[0][0] as ForecastAgg['trend'];
  }
  const openRequests = new Map<string, number>();
  for (const pr of input.purchaseRequests) {
    if (pr.part_id && OPEN_REQUEST.has(pr.status)) {
      openRequests.set(pr.part_id, (openRequests.get(pr.part_id) ?? 0) + pr.quantity_requested);
    }
  }

  // ---------- 6. profiles ----------
  const totalSpend12m = [...stats.values()].reduce((a, s) => a + s.spend12m, 0);
  const profiles: SupplierProfile[] = [];

  for (const e of entities.values()) {
    const s = stats.get(e.key) ?? newPoStats();
    const ev = evals.get(e.key);
    const rf = rfq.get(e.key);
    const supplied = partsSupplied.get(e.key) ?? new Set<string>();
    const singleSourcePartIds = [...supplied].filter((p) => {
      const set = partSuppliers.get(p) ?? [];
      return set.length === 1 && set[0] === e.key;
    });

    // --- on-time: prefer the source with more observations ---
    const obsN = s.onTime + s.late;
    const evalN = ev ? ev.onTime + ev.late : 0;
    let onTimeRate: number | null = null;
    let onTimeSource: SupplierProfile['onTimeSource'] = null;
    let onTimeSample = 0;
    if (obsN > 0 && obsN >= evalN) {
      onTimeRate = s.onTime / obsN;
      onTimeSource = 'receipts';
      onTimeSample = obsN;
    } else if (evalN > 0 && ev) {
      onTimeRate = ev.onTime / evalN;
      onTimeSource = 'evaluations';
      onTimeSample = evalN;
    }
    const fillRate = s.orderedQty > 0 ? s.filledQty / s.orderedQty : null;
    const damageRate = s.receiptLines > 0 ? s.damagedLines / s.receiptLines : null;

    // --- lead time ---
    let lead: SupplierProfile['leadTime'];
    const catalogLeads = [...points.values()]
      .flatMap((m) => m.get(e.key) ?? [])
      .map((p) => p.leadDays)
      .filter((d): d is number => d !== null && d >= 0);
    if (s.leadDays.length > 0) {
      const sd = stdev(s.leadDays);
      const m = mean(s.leadDays) as number;
      lead = {
        medianDays: round(median(s.leadDays) as number),
        p80Days: round(percentile(s.leadDays, 0.8) as number),
        cv: s.leadDays.length >= 3 && sd !== null && m > 0 ? round(sd / m, 2) : null,
        basis: 'observed', sample: s.leadDays.length,
      };
    } else if (s.quotedLeadDays.length > 0) {
      lead = {
        medianDays: round(median(s.quotedLeadDays) as number),
        p80Days: round(percentile(s.quotedLeadDays, 0.8) as number),
        cv: null, basis: 'quoted', sample: s.quotedLeadDays.length,
      };
    } else if (catalogLeads.length > 0 || e.defaultLeadDays) {
      const base = catalogLeads.length ? (median(catalogLeads) as number) : (e.defaultLeadDays as number);
      lead = { medianDays: round(base), p80Days: round(base), cv: null, basis: 'catalog', sample: Math.max(1, catalogLeads.length) };
    } else {
      lead = { medianDays: null, p80Days: null, cv: null, basis: null, sample: 0 };
    }

    // --- price ---
    const ratios = priceRatios.get(e.key) ?? [];
    const priceIndex = ratios.length ? round(median(ratios) as number, 3) : null;
    const trends = supplierTrends.get(e.key) ?? [];
    const vols = supplierVol.get(e.key) ?? [];

    // --- scores ---
    const reliabilityParts: [number, number][] = [];
    if (onTimeRate !== null) reliabilityParts.push([shrink(onTimeRate, onTimeSample, 0.85, 4), 0.55]);
    if (fillRate !== null) reliabilityParts.push([shrink(fillRate, s.fillPOs, 0.95, 4), 0.3]);
    if (lead.cv !== null) reliabilityParts.push([1 - clamp(lead.cv, 0, 1), 0.15]);
    const reliability = weightedAvg(reliabilityParts, 100);

    const evalQ = ev && ev.q.length ? shrink(((mean(ev.q) as number) - 1) / 4, ev.q.length, 0.7, 3) : null;
    const damageScore =
      damageRate !== null
        ? 1 - clamp(((damageRate * s.receiptLines + 0.03 * 10) / (s.receiptLines + 10)) / 0.15, 0, 1)
        : null;
    const qualityParts: [number, number][] = [];
    if (evalQ !== null) qualityParts.push([evalQ, 0.7]);
    if (damageScore !== null) qualityParts.push([damageScore, 0.3]);
    const quality = weightedAvg(qualityParts, 100);

    const priceFromIndex =
      priceIndex !== null ? shrink(clamp(100 - (priceIndex - 0.9) * 250), ratios.length, 60, 3) : null;
    const evalP = ev && ev.p.length ? ((mean(ev.p) as number) - 1) * 25 : null;
    const price =
      priceFromIndex !== null && evalP !== null ? priceFromIndex * 0.7 + evalP * 0.3 : priceFromIndex ?? evalP;

    const leadScore =
      lead.p80Days !== null
        ? shrink(clamp(100 - (lead.p80Days - 1) * (100 / 14)), lead.basis === 'observed' ? lead.sample : 1, 60, 2)
        : null;

    const rfqRate = rf && rf.invites > 0 ? shrink(rf.responded / rf.invites, rf.invites, 0.8, 3) : null;
    const turnaround = rf && rf.turnarounds.length ? (mean(rf.turnarounds) as number) : null;
    const commScore = ev && ev.c.length ? mean(ev.c) : null;
    const rfqScore =
      rfqRate !== null
        ? 100 * (turnaround !== null ? rfqRate * 0.6 + (1 - clamp((turnaround - 1) / 6, 0, 1)) * 0.4 : rfqRate)
        : null;
    const commPct = commScore !== null ? (commScore - 1) * 25 : null;
    const responsiveness =
      rfqScore !== null && commPct !== null ? (rfqScore + commPct) / 2 : rfqScore ?? commPct;

    const scores: SupplierScores = {
      reliability: reliability === null ? null : round(reliability),
      quality: quality === null ? null : round(quality),
      price: price === null ? null : round(price),
      leadTime: leadScore === null ? null : round(leadScore),
      responsiveness: responsiveness === null ? null : round(responsiveness),
    };

    const evalCount = ev ? Math.max(ev.q.length, ev.p.length, ev.c.length, evalN) : 0;
    const evidence = s.orders + evalCount + (rf?.invites ?? 0);
    const confidence = confidenceFor(evidence);
    const share = totalSpend12m > 0 ? s.spend12m / totalSpend12m : 0;
    const lastOrderAt = s.lastOrderMs ? new Date(s.lastOrderMs).toISOString() : null;

    const profile: SupplierProfile = {
      key: e.key, name: e.name, origin: e.origin, vendorId: e.vendorId, category: e.category,
      active: e.active, email: e.email, phone: e.phone,
      linkedInventoryVendorIds: e.invIds, linkedSourceIds: e.sourceIds,
      orders: s.orders, spend12mCents: s.spend12m, spend90dCents: s.spend90d, spendShare: round(share, 4),
      lastOrderAt,
      daysSinceLastOrder: s.lastOrderMs ? Math.floor((nowMs - s.lastOrderMs) / DAY_MS) : null,
      onTimeRate: onTimeRate === null ? null : round(onTimeRate, 3),
      onTimeSource, onTimeSample,
      avgDelayDays: s.delays.length ? round(mean(s.delays) as number) : null,
      overdueOpenOrders: s.overdueOpen,
      fillRate: fillRate === null ? null : round(fillRate, 3),
      damageRate: damageRate === null ? null : round(damageRate, 3),
      leadTime: lead,
      priceIndex, pricedParts: ratios.length,
      priceTrend30dPct: trends.length ? round(median(trends) as number) : null,
      priceVolatility: vols.length ? round(median(vols) as number, 3) : null,
      shippingRate: s.subtotal > 0 ? round(clamp(s.shipping / s.subtotal, 0, 0.3), 3) : 0,
      rfqInvites: rf?.invites ?? 0,
      rfqResponseRate: rf && rf.invites > 0 ? round(rf.responded / rf.invites, 3) : null,
      avgQuoteTurnaroundDays: turnaround === null ? null : round(turnaround),
      communicationScore: commScore === null ? null : round(commScore, 2),
      partsSupplied: supplied.size, singleSourcePartIds,
      scores, evidence, confidence,
      risk: { score: 0, level: 'low', factors: [] },
    };
    profile.risk = assessRisk(profile);
    profiles.push(profile);
  }

  // parts universe
  const parts = new Map<string, PartInfo>();
  for (const p of input.parts) parts.set(p.id, p);

  return {
    now: input.now, profiles, byKey: new Map(profiles.map((p) => [p.key, p])), parts, partPrices,
    partTrend, partSuppliers, preferredKey, forecast, inbound, openRequests, totalSpend12mCents: totalSpend12m,
  };
}

// ============================================================
// RISK
// ============================================================

function assessRisk(p: SupplierProfile): SupplierProfile['risk'] {
  const factors: RiskFactor[] = [];

  const delivery = p.scores.reliability === null ? 50 : 100 - p.scores.reliability;
  factors.push({
    key: 'delivery', label: 'Delivery reliability', score: round(delivery), weight: 0.3,
    detail:
      p.scores.reliability === null
        ? 'No delivery history recorded yet — treated as an unknown.'
        : `On-time ${p.onTimeRate === null ? 'n/a' : pct(p.onTimeRate)}, fill rate ${p.fillRate === null ? 'n/a' : pct(p.fillRate)}.`,
  });

  const conc = clamp(((p.spendShare - 0.15) / 0.45) * 100);
  factors.push({
    key: 'concentration', label: 'Spend concentration', score: round(conc), weight: 0.2,
    detail: `${pct(p.spendShare)} of the last 12 months of spend.`,
  });

  const ss = p.partsSupplied > 0 ? (p.singleSourcePartIds.length / p.partsSupplied) * 100 : 0;
  factors.push({
    key: 'single_source', label: 'Sole-source exposure', score: round(ss), weight: 0.2,
    detail: `${p.singleSourcePartIds.length} of ${p.partsSupplied} parts have no other active supplier.`,
  });

  const vol = p.priceVolatility ?? 0;
  const drift = Math.max(0, p.priceTrend30dPct ?? 0);
  const priceRisk = clamp((vol / 0.15) * 60 + (drift / 15) * 40);
  factors.push({
    key: 'price', label: 'Price volatility', score: round(priceRisk), weight: 0.1,
    detail:
      p.priceVolatility === null && p.priceTrend30dPct === null
        ? 'Not enough price history to measure.'
        : `Volatility ${p.priceVolatility === null ? 'n/a' : pct(p.priceVolatility)}, 30-day drift ${p.priceTrend30dPct === null ? 'n/a' : `${p.priceTrend30dPct > 0 ? '+' : ''}${p.priceTrend30dPct}%`}.`,
  });

  const overdue = clamp((p.overdueOpenOrders / 3) * 100);
  factors.push({
    key: 'overdue', label: 'Overdue open orders', score: round(overdue), weight: 0.1,
    detail:
      p.overdueOpenOrders === 0
        ? 'No open order is past its promised date.'
        : `${p.overdueOpenOrders} open order(s) are past the promised date.`,
  });

  const unknown = { high: 0, medium: 30, low: 60, none: 80 }[p.confidence];
  factors.push({
    key: 'unknown', label: 'Data confidence', score: unknown, weight: 0.1,
    detail: `Based on ${p.evidence} recorded order, evaluation and RFQ observation(s).`,
  });

  const score = round(factors.reduce((a, f) => a + f.score * f.weight, 0));
  return { score, level: riskLevelFor(score), factors };
}

// ============================================================
// PART SOURCING COMPARISON
// ============================================================

export function comparePartSuppliers(
  ctx: SupplierContext,
  partId: string,
  quantity: number,
  priority: SourcingPriority = 'balanced',
): PartSourcingResult {
  const qty = Math.max(1, Math.round(quantity));
  const partName = ctx.parts.get(partId)?.name ?? ctx.forecast.get(partId)?.partName ?? 'Part';
  const prices = ctx.partPrices.get(partId) ?? new Map<string, PartPrice>();
  const w = PRIORITY_WEIGHTS[priority];

  const rows = [...prices.entries()]
    .map(([key, pp]) => ({ key, pp, profile: ctx.byKey.get(key) }))
    .filter((r): r is { key: string; pp: PartPrice; profile: SupplierProfile } => !!r.profile && r.profile.active);

  const best = rows.length ? Math.min(...rows.map((r) => r.pp.price)) : 0;

  const candidates: PartSupplierCandidate[] = rows.map(({ key, pp, profile }) => {
    let leadTimeDays: number | null;
    let leadBasis: LeadBasis;
    if (pp.etaDays !== null) {
      leadTimeDays = pp.etaDays;
      leadBasis = 'live_offer';
    } else if (pp.leadDays !== null) {
      leadTimeDays = pp.leadDays;
      leadBasis = 'catalog';
    } else if (profile.leadTime.p80Days !== null) {
      leadTimeDays = profile.leadTime.p80Days;
      leadBasis =
        profile.leadTime.basis === 'quoted' ? 'quoted' : profile.leadTime.basis === 'catalog' ? 'catalog' : 'observed';
    } else {
      leadTimeDays = null;
      leadBasis = 'default';
    }

    const goods = pp.price * qty;
    const shipping = pp.feeCents > 0 ? pp.feeCents : Math.round(goods * profile.shippingRate);
    const landed = goods + shipping;
    const onTime = profile.onTimeRate ?? 0.85;
    const fill = profile.fillRate ?? 0.95;
    const riskAdjusted = Math.round(
      landed * (1 + (1 - onTime) * RISK_PREMIUM.latePerMissedRate + (1 - fill) * RISK_PREMIUM.shortPerMissedRate),
    );

    const coversQuantity = pp.qty === null ? null : pp.qty >= qty;
    const priceScore = clamp(100 - (pp.price / best - 1) * 200);
    const leadScore = leadTimeDays === null ? UNKNOWN_DIMENSION_SCORE : clamp(100 - (leadTimeDays - 1) * (100 / 14));
    const dim = (v: number | null) => (v === null ? UNKNOWN_DIMENSION_SCORE : v);
    let partScore =
      dim(profile.scores.reliability) * w.reliability +
      dim(profile.scores.quality) * w.quality +
      priceScore * w.price +
      leadScore * w.leadTime +
      dim(profile.scores.responsiveness) * w.responsiveness;
    if (coversQuantity === false) partScore -= 15;

    return {
      key, name: profile.name, origin: profile.origin, unitPriceCents: pp.price, priceBasis: pp.basis,
      priceAgeDays: pp.ageDays, priceStale: pp.stale,
      vsBestPct: best > 0 ? round((pp.price / best - 1) * 100) : 0,
      availableQty: pp.qty, coversQuantity,
      leadTimeDays: leadTimeDays === null ? null : round(leadTimeDays), leadBasis,
      landedCostCents: landed, riskAdjustedCostCents: riskAdjusted,
      reliability: profile.scores.reliability, quality: profile.scores.quality,
      riskScore: profile.risk.score, riskLevel: profile.risk.level, confidence: profile.confidence,
      isPreferred: pp.preferred, partScore: round(partScore), rank: 0,
    };
  });

  candidates.sort(
    (a, b) => b.partScore - a.partScore || a.riskAdjustedCostCents - b.riskAdjustedCostCents || a.name.localeCompare(b.name),
  );
  candidates.forEach((c, i) => (c.rank = i + 1));

  const primary = candidates[0] ?? null;
  const backup = candidates[1] ?? null;
  const preferred = candidates.find((c) => c.isPreferred) ?? null;
  const savings =
    primary && preferred && primary.key !== preferred.key
      ? preferred.riskAdjustedCostCents - primary.riskAdjustedCostCents
      : null;

  const rationale: string[] = [];
  if (!primary) {
    rationale.push('No active supplier has a price on record for this part.');
  } else {
    const cheapest = [...candidates].sort((a, b) => a.unitPriceCents - b.unitPriceCents)[0];
    rationale.push(
      `${primary.name} ranks first for “${PRIORITY_LABELS[priority]}” (score ${primary.partScore}) at ${fmtMoney(primary.unitPriceCents, 2)}/unit` +
        (primary.leadTimeDays !== null ? ` with ~${primary.leadTimeDays}d lead time.` : '.'),
    );
    if (cheapest.key !== primary.key) {
      rationale.push(
        `${cheapest.name} is cheaper (${fmtMoney(cheapest.unitPriceCents, 2)}/unit) but scores lower once reliability, quality and lead time are weighed.`,
      );
    }
    if (preferred && preferred.key !== primary.key) {
      rationale.push(
        savings !== null && savings > 0
          ? `Beats the catalog-preferred supplier (${preferred.name}) by ${fmtMoney(savings)} on risk-adjusted cost for ${qty} units.`
          : `Differs from the catalog-preferred supplier (${preferred.name}); it wins on overall score, not on cost.`,
      );
    }
    if (primary.coversQuantity === false) {
      rationale.push(`${primary.name} reports only ${primary.availableQty} in stock — split the order or use the backup.`);
    }
    if (primary.priceStale) rationale.push('Price is older than 12 months — confirm with a fresh quote before ordering.');
    if (primary.confidence === 'low' || primary.confidence === 'none') {
      rationale.push(`Limited history for ${primary.name}; treat the ranking as indicative.`);
    }
    if (candidates.length === 1) rationale.push('Single active supplier: no fallback if they fail to deliver.');
  }

  return {
    partId, partName, quantity: qty, candidates, primary, backup, preferred,
    savingsVsPreferredCents: savings, singleSource: candidates.length === 1,
    priceTrend30dPct: ctx.partTrend.get(partId) ?? null, rationale,
  };
}

// ============================================================
// SUPPLY OUTLOOK (future supply conditions)
// ============================================================

const TREND_MULTIPLIER = { rising: 1.15, falling: 0.9, flat: 1 } as const;

export function buildSupplyOutlook(ctx: SupplierContext, priority: SourcingPriority = 'balanced'): SupplyOutlookRow[] {
  const nowMs = ctx.now.getTime();
  const rows: SupplyOutlookRow[] = [];

  for (const [partId, f] of ctx.forecast) {
    const info = ctx.parts.get(partId);
    const usage = f.dailyUsage * TREND_MULTIPLIER[f.trend];
    const inb = ctx.inbound.get(partId) ?? { qty: 0, earliestEtaMs: null };
    const openReq = ctx.openRequests.get(partId) ?? 0;

    const pre = comparePartSuppliers(ctx, partId, Math.max(1, info?.reorder_quantity ?? 1), priority);
    const leadTimeDays = pre.primary?.leadTimeDays ?? DEFAULT_LEAD_DAYS;
    const need = leadTimeDays + SAFETY_DAYS;

    const daysOfStock = usage > 0 ? f.available / usage : null;
    const inboundDays = inb.earliestEtaMs !== null ? Math.max(0, (inb.earliestEtaMs - nowMs) / DAY_MS) : null;
    const inboundLate = inb.qty > 0 && daysOfStock !== null && inboundDays !== null && inboundDays > daysOfStock;
    const coverageDays = usage > 0 ? (inboundLate ? daysOfStock : (f.available + inb.qty) / usage) : null;
    const slackDays = coverageDays === null ? null : coverageDays - need;

    let status: OutlookStatus;
    if (usage <= 0) status = 'no_demand';
    else if (openReq > 0) status = 'request_open';
    else if ((slackDays as number) <= 0) status = 'order_now';
    else if ((slackDays as number) <= 7) status = 'watch';
    else status = 'ok';

    let recommendedQty = 0;
    if (usage > 0 && (status === 'order_now' || status === 'watch' || status === 'request_open')) {
      recommendedQty = Math.max(0, Math.ceil(usage * (need + COVERAGE_CYCLE_DAYS) - f.available - inb.qty - openReq));
      if (recommendedQty > 0 && info && info.reorder_quantity > 0) {
        recommendedQty = Math.max(recommendedQty, info.reorder_quantity);
      }
    }

    const sourcing = recommendedQty > 0 ? comparePartSuppliers(ctx, partId, recommendedQty, priority) : pre;
    const primary = sourcing.primary;
    const trend = ctx.partTrend.get(partId) ?? null;
    const supplyRisk = primary ? clamp(primary.riskScore + (sourcing.singleSource ? 15 : 0)) : null;

    rows.push({
      partId, partName: info?.name ?? f.partName, partNumber: info?.part_number ?? f.partNumber,
      available: f.available, dailyUsage: round(usage, 2), demandTrend: f.trend,
      daysOfStock: daysOfStock === null ? null : round(daysOfStock),
      inboundQty: inb.qty, inboundLate,
      coverageDays: coverageDays === null ? null : round(coverageDays),
      leadTimeDays: round(leadTimeDays),
      slackDays: slackDays === null ? null : round(slackDays),
      reorderByDate: slackDays === null ? null : isoDate(nowMs + Math.max(0, slackDays) * DAY_MS),
      stockoutDate: daysOfStock === null ? null : isoDate(nowMs + daysOfStock * DAY_MS),
      status, recommendedQty, primary,
      estimatedCostCents: primary && recommendedQty > 0 ? primary.landedCostCents : null,
      priceOutlookPct30: trend === null ? null : round(trend),
      supplyRiskScore: supplyRisk === null ? null : round(supplyRisk),
      singleSource: sourcing.singleSource, noSupplier: sourcing.candidates.length === 0,
      openRequestQty: openReq, sourcing,
    });
  }

  const ORDER: Record<OutlookStatus, number> = { order_now: 0, watch: 1, request_open: 2, ok: 3, no_demand: 4 };
  return rows.sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      (a.slackDays ?? Infinity) - (b.slackDays ?? Infinity) ||
      a.partName.localeCompare(b.partName),
  );
}

// ============================================================
// RECOMMENDATIONS
// ============================================================

const SEVERITY_ORDER: Record<RecommendationSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function buildRecommendations(
  ctx: SupplierContext,
  profiles: ScoredSupplier[],
  outlook: SupplyOutlookRow[],
): SupplierRecommendation[] {
  const recs: SupplierRecommendation[] = [];
  const T = THRESHOLDS;
  const active = profiles.filter((p) => p.active);

  // --- reorder / source (from the outlook) ---
  for (const row of outlook) {
    if (row.status === 'order_now') {
      const lead = row.leadTimeDays;
      const stock = row.daysOfStock ?? 0;
      const critical = stock < lead;
      if (row.noSupplier || !row.primary) {
        recs.push({
          id: `source_part:${row.partId}`, kind: 'source_part', severity: critical ? 'critical' : 'high',
          title: `Find a supplier for ${row.partName}`,
          detail: `${row.partName} runs out in ~${Math.round(stock)} day(s) and no active supplier has a price on record.`,
          evidence: [`${row.available} on hand, ~${row.dailyUsage}/day demand`],
          impactCents: null, confidence: 'high', partId: row.partId,
          action: { type: 'navigate', label: 'Open Procurement (RFQ)', href: '/dashboard/procurement' },
        });
        continue;
      }
      const p = row.primary;
      recs.push({
        id: `reorder_now:${row.partId}`, kind: 'reorder_now', severity: critical ? 'critical' : 'high',
        title: `Order ${row.recommendedQty} × ${row.partName} from ${p.name}`,
        detail: critical
          ? `Stock lasts ~${Math.round(stock)} day(s) but lead time is ~${lead} day(s): a stock-out is already likely.`
          : `Stock lasts ~${Math.round(stock)} day(s) against a ~${lead}-day lead time plus ${SAFETY_DAYS}-day buffer — order today.`,
        evidence: [
          `${row.available} available, ~${row.dailyUsage}/day demand (${row.demandTrend})`,
          row.inboundQty > 0
            ? `${row.inboundQty} already inbound${row.inboundLate ? ' but arriving after stock-out' : ''}`
            : 'Nothing inbound',
          `${p.name}: ${fmtMoney(p.unitPriceCents, 2)}/unit, score ${p.partScore}, risk ${p.riskLevel}`,
          ...(row.sourcing?.backup ? [`Backup: ${row.sourcing.backup.name}`] : []),
        ],
        impactCents: row.estimatedCostCents, confidence: p.confidence === 'none' ? 'low' : p.confidence,
        supplierKey: p.key, partId: row.partId,
        action: {
          type: 'create_purchase_request', partId: row.partId, quantity: row.recommendedQty,
          neededBy: row.stockoutDate,
          note: `Supplier Intelligence: recommended supplier ${p.name} (${fmtMoney(p.unitPriceCents, 2)}/unit, ~${lead}d lead time).`,
        },
      });
    }

    // switch preferred supplier
    const s = row.sourcing;
    if (s?.primary && s.preferred && s.primary.key !== s.preferred.key && row.dailyUsage > 0) {
      const saving = (s.preferred.unitPriceCents - s.primary.unitPriceCents) * row.dailyUsage * 365;
      const pctSaving = s.preferred.unitPriceCents > 0 ? 1 - s.primary.unitPriceCents / s.preferred.unitPriceCents : 0;
      if (
        pctSaving >= T.switchPreferredMinSavingsPct &&
        saving >= T.switchPreferredMinAnnualSavingsCents &&
        s.primary.partScore >= s.preferred.partScore
      ) {
        recs.push({
          id: `switch_preferred:${row.partId}`, kind: 'switch_preferred', severity: 'medium',
          title: `Switch preferred supplier for ${row.partName} to ${s.primary.name}`,
          detail: `${s.primary.name} is ${Math.round(pctSaving * 100)}% cheaper than the catalog-preferred ${s.preferred.name} and scores at least as well.`,
          evidence: [
            `${fmtMoney(s.primary.unitPriceCents, 2)} vs ${fmtMoney(s.preferred.unitPriceCents, 2)} per unit`,
            `Annual demand ≈ ${Math.round(row.dailyUsage * 365)} units`,
            `Scores: ${s.primary.partScore} vs ${s.preferred.partScore}`,
          ],
          impactCents: Math.round(saving), confidence: s.primary.confidence === 'none' ? 'low' : s.primary.confidence,
          supplierKey: s.primary.key, partId: row.partId,
          action: { type: 'navigate', label: 'Update in Parts & Inventory', href: '/dashboard/inventory' },
        });
      }
    }

    // price alert
    if (row.priceOutlookPct30 !== null && row.priceOutlookPct30 >= T.priceSpikePct30 && row.dailyUsage > 0 && row.primary) {
      const exposure = Math.round(row.dailyUsage * 30 * row.primary.unitPriceCents * (row.priceOutlookPct30 / 100));
      recs.push({
        id: `price_alert:${row.partId}`, kind: 'price_alert', severity: 'medium',
        title: `${row.partName} price is rising ~${Math.round(row.priceOutlookPct30)}% per month`,
        detail: 'Buying ahead of the next increase protects margin on upcoming jobs.',
        evidence: [
          `Trend across ${ctx.partSuppliers.get(row.partId)?.length ?? 0} supplier(s)`,
          `~${Math.round(row.dailyUsage * 30)} units used in the next 30 days`,
        ],
        impactCents: exposure, confidence: 'medium', partId: row.partId,
        action: { type: 'navigate', label: 'Compare suppliers', href: '/dashboard/parts-market' },
      });
    }
  }

  // --- supplier-level ---
  for (const p of active) {
    // renegotiate
    if (
      p.priceIndex !== null && p.priceIndex >= T.renegotiatePriceIndex &&
      p.pricedParts >= T.renegotiateMinPricedParts && p.spend90dCents >= T.renegotiateMinSpend90dCents
    ) {
      const saving = Math.round(p.spend90dCents * (365 / 90) * (1 - 1 / p.priceIndex));
      recs.push({
        id: `renegotiate:${p.key}`, kind: 'renegotiate', severity: saving >= 500_000 ? 'high' : 'medium',
        title: `Renegotiate pricing with ${p.name}`,
        detail: `Prices run ~${Math.round((p.priceIndex - 1) * 100)}% above the market median across ${p.pricedParts} parts you buy.`,
        evidence: [
          `${fmtMoney(p.spend90dCents)} spent in the last 90 days`,
          `Price index ${p.priceIndex.toFixed(2)} (1.00 = market median)`,
        ],
        impactCents: saving, confidence: p.pricedParts >= 8 ? 'high' : 'medium', supplierKey: p.key,
        action: { type: 'navigate', label: 'Request competing quotes', href: '/dashboard/procurement' },
      });
    }

    // reliability review
    const lowOnTime =
      p.onTimeRate !== null && p.onTimeSample >= T.minObservationsForReliabilityFlag && p.onTimeRate < T.lowOnTimeRate;
    const lowFill = p.fillRate !== null && p.fillRate < T.lowFillRate && p.orders >= T.minObservationsForReliabilityFlag;
    if (lowOnTime || lowFill || p.overdueOpenOrders >= 2) {
      const ev: string[] = [];
      if (lowOnTime) ev.push(`On-time rate ${pct(p.onTimeRate as number)} over ${p.onTimeSample} deliveries`);
      if (lowFill) ev.push(`Fill rate ${pct(p.fillRate as number)}`);
      if (p.overdueOpenOrders > 0) ev.push(`${p.overdueOpenOrders} open order(s) overdue`);
      if (p.avgDelayDays !== null) ev.push(`Average delay ${p.avgDelayDays} day(s)`);
      recs.push({
        id: `review_supplier:${p.key}`, kind: 'review_supplier',
        severity: p.overdueOpenOrders >= 2 || (p.onTimeRate !== null && p.onTimeRate < 0.6) ? 'high' : 'medium',
        title: `Review ${p.name}: delivery performance is slipping`,
        detail: 'Escalate with the supplier or shift volume to a better-scoring alternative.',
        evidence: ev, impactCents: null, confidence: p.confidence === 'none' ? 'low' : p.confidence, supplierKey: p.key,
        action: { type: 'navigate', label: 'Open Vendor & Procurement', href: '/dashboard/procurement' },
      });
    }

    // concentration / sole-source
    const ssCount = p.singleSourcePartIds.length;
    if (p.spendShare >= T.concentrationShare || ssCount >= T.singleSourceMinParts) {
      const names = p.singleSourcePartIds
        .slice(0, 5)
        .map((id) => ctx.parts.get(id)?.name ?? ctx.forecast.get(id)?.partName ?? 'Part');
      const riskHigh = RISK_ORDER[p.risk.level] >= RISK_ORDER.high;
      recs.push({
        id: `diversify:${p.key}`, kind: 'diversify', severity: riskHigh ? 'high' : 'medium',
        title: `Reduce dependence on ${p.name}`,
        detail:
          p.spendShare >= T.concentrationShare
            ? `${pct(p.spendShare)} of spend sits with one supplier${ssCount ? ` and ${ssCount} part(s) have no alternative` : ''}.`
            : `${ssCount} parts have no other active supplier.`,
        evidence: [
          ...(p.spendShare >= T.concentrationShare ? [`${pct(p.spendShare)} of 12-month spend`] : []),
          ...(ssCount
            ? [`Sole-sourced: ${names.join(', ')}${ssCount > names.length ? `, +${ssCount - names.length} more` : ''}`]
            : []),
          `Supplier risk: ${p.risk.level} (${p.risk.score})`,
        ],
        impactCents: null, confidence: p.confidence === 'none' ? 'low' : p.confidence, supplierKey: p.key,
        action: { type: 'navigate', label: 'Onboard a backup supplier', href: '/dashboard/procurement' },
      });
    }
  }

  // dormant (one aggregated card)
  const dormant = active.filter(
    (p) =>
      p.origin === 'procurement' &&
      p.daysSinceLastOrder !== null &&
      p.daysSinceLastOrder >= T.dormantDays &&
      p.spend12mCents === 0,
  );
  if (dormant.length > 0) {
    recs.push({
      id: 'dormant:all', kind: 'dormant', severity: 'low',
      title: `${dormant.length} active supplier(s) with no orders in ${T.dormantDays}+ days`,
      detail: 'Archive them to keep sourcing lists clean, or put them back into rotation as backups.',
      evidence: dormant.slice(0, 6).map((p) => p.name), impactCents: null, confidence: 'high',
      action: { type: 'navigate', label: 'Open Vendor & Procurement', href: '/dashboard/procurement' },
    });
  }

  // data gap (aggregated)
  const thin = active.filter((p) => p.spendShare >= 0.1 && (p.confidence === 'low' || p.confidence === 'none'));
  if (thin.length > 0) {
    recs.push({
      id: 'data_gap:all', kind: 'data_gap', severity: 'low',
      title: 'Record receipts and evaluations for your biggest suppliers',
      detail:
        'Scores for these suppliers rest on very few observations. Receiving goods against POs and rating deliveries sharpens every recommendation here.',
      evidence: thin.map((p) => `${p.name}: ${p.evidence} observation(s)`), impactCents: null, confidence: 'high',
      action: { type: 'navigate', label: 'Open Vendor & Procurement', href: '/dashboard/procurement' },
    });
  }

  return recs.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (b.impactCents ?? 0) - (a.impactCents ?? 0) ||
      a.title.localeCompare(b.title),
  );
}

// ============================================================
// TOP-LEVEL ANALYSIS
// ============================================================

export function analyzeSuppliers(
  ctx: SupplierContext,
  priority: SourcingPriority = 'balanced',
): SupplierIntelligenceResult {
  const scored: ScoredSupplier[] = ctx.profiles.map((p) => ({
    ...p, ...compositeScore(p.scores, priority), rank: null,
  }));
  scored
    .filter((p) => p.active && p.composite !== null)
    .sort(
      (a, b) =>
        (b.composite as number) - (a.composite as number) || b.spend12mCents - a.spend12mCents || a.name.localeCompare(b.name),
    )
    .forEach((p, i) => (p.rank = i + 1));
  scored.sort(
    (a, b) =>
      (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.spend12mCents - a.spend12mCents || a.name.localeCompare(b.name),
  );

  const outlook = buildSupplyOutlook(ctx, priority);
  const recommendations = buildRecommendations(ctx, scored, outlook);

  const active = scored.filter((p) => p.active);
  const shares = scored.map((p) => p.spendShare);
  const hhi = Math.round(shares.reduce((a, s) => a + (s * 100) ** 2, 0));
  const topShare = shares.length ? Math.max(...shares) : 0;
  const hasSpend = ctx.totalSpend12mCents > 0;
  const concentrationLevel: RiskLevel = !hasSpend
    ? 'low'
    : hhi < 1500 ? 'low' : hhi < 2500 ? 'moderate' : hhi < 4000 ? 'high' : 'critical';

  const otw = active.filter((p) => p.onTimeRate !== null && p.onTimeSample > 0);
  const otwWeight = otw.reduce((a, p) => a + p.onTimeSample, 0);

  const singleSourceParts = [...ctx.partSuppliers.values()].filter((s) => s.length === 1).length;
  const savings = recommendations
    .filter((r) => r.kind === 'renegotiate' || r.kind === 'switch_preferred')
    .reduce((a, r) => a + (r.impactCents ?? 0), 0);

  const summary: SupplierSummary = {
    activeSuppliers: active.length,
    totalSpend12mCents: ctx.totalSpend12mCents,
    topSupplierShare: round(topShare, 4),
    hhi, concentrationLevel,
    weightedOnTimeRate:
      otwWeight > 0
        ? round(otw.reduce((a, p) => a + (p.onTimeRate as number) * p.onTimeSample, 0) / otwWeight, 3)
        : null,
    atRiskSuppliers: active.filter((p) => RISK_ORDER[p.risk.level] >= RISK_ORDER.high).length,
    singleSourceParts,
    partsToOrderNow: outlook.filter((r) => r.status === 'order_now').length,
    savingsOpportunityCents: savings,
    overdueOpenOrders: active.reduce((a, p) => a + p.overdueOpenOrders, 0),
    dataCoverage: active.length
      ? round(active.filter((p) => p.confidence === 'medium' || p.confidence === 'high').length / active.length, 2)
      : 0,
  };

  return { priority, generatedAt: ctx.now.toISOString(), profiles: scored, summary, outlook, recommendations };
}
