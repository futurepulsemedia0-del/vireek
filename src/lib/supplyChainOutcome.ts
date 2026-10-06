/**
 * Supply Chain Outcome Graph
 *
 *   Manufacturer → Distributor → Regional → Local → Truck → Technician → Job → Outcome
 *
 * Price comparison answers "what does the part cost?".
 * This module answers the question that actually matters:
 *   "Which supply chain is most likely to produce a SUCCESSFUL repair?"
 *
 * cheapest part ≠ best part. A $12 capacitor that fails 1 time in 5 costs far
 * more than a $19 one that never comes back — once you price the callback.
 *
 * `buildChains` / `rankChains` / `buildInsights` are PURE and deterministic —
 * no network, no randomness — so every score is explainable and unit-testable.
 * Data access lives below them.
 *
 * All money is integer cents.
 */

import { supabase } from './supabase';
import { formatCents } from './priceBook';

// ============================================================
// TYPES
// ============================================================

export type Authenticity = 'verified' | 'unverified' | 'suspect' | 'counterfeit';
export type OutcomeClass = 'success' | 'failure' | 'pending' | 'excluded';
export type PartEventType =
  | 'doa'
  | 'early_failure'
  | 'defect'
  | 'return_to_vendor'
  | 'warranty_approved'
  | 'warranty_denied';
export type CustodyStage =
  | 'manufacturer'
  | 'distributor'
  | 'regional_inventory'
  | 'local_inventory'
  | 'truck'
  | 'technician'
  | 'job';
export type ChainTier = 'preferred' | 'approved' | 'watch' | 'avoid' | 'quarantine';
export type Confidence = 'low' | 'medium' | 'high';
export type DimensionKey =
  | 'repair'
  | 'authenticity'
  | 'defect'
  | 'callback'
  | 'delivery'
  | 'returns'
  | 'customer';

export interface ChainLot {
  id: string;
  part_id: string;
  part_name: string;
  manufacturer: string | null;
  distributor: string | null;
  supplier_name: string;
  vendor_id: string | null;
  market_source_id: string | null;
  authenticity: Authenticity;
  promised_at: string | null;
  received_at: string;
  quantity_received: number;
  unit_cost_cents: number;
  custody_stages: CustodyStage[];
}

/** One row of the `supply_chain_install_outcomes` view. */
export interface ChainInstall {
  install_id: string;
  job_id: string;
  part_id: string;
  part_name: string;
  lot_id: string | null;
  quantity: number;
  outcome_class: OutcomeClass;
  caused_callback: boolean;
  is_rework: boolean;
  customer_rating: number | null;
  defect_attributed: boolean;
  installed_at: string;
}

export interface ChainEvent {
  id: string;
  lot_id: string;
  event_type: PartEventType;
  quantity: number;
}

export interface ChainInput {
  lots: ChainLot[];
  installs: ChainInstall[];
  events: ChainEvent[];
}

export interface DimensionScore {
  key: DimensionKey;
  label: string;
  /** 0..1, higher is better. */
  score: number;
  /** Plain-language evidence behind the score. */
  detail: string;
}

export interface SupplyChain {
  key: string;
  manufacturer: string;
  supplier: string;
  partIds: string[];
  lotCount: number;
  unitsReceived: number;
  unitsInstalled: number;
  /** Jobs with a decided outcome (success or failure). */
  decidedJobs: number;
  /** 0..100 composite. */
  score: number;
  /** Predicted probability that a repair using this chain succeeds first visit. */
  successProbability: number;
  confidence: Confidence;
  tier: ChainTier;
  dimensions: DimensionScore[];
  weakestLink: DimensionScore;
  flags: string[];
  avgUnitCostCents: number;
  /** unit cost + P(failure) × cost of a failed repair. */
  expectedCostPerOutcomeCents: number;
  counterfeitUnits: number;
  suspectUnits: number;
}

export interface ChainOptions {
  /** Restrict the graph to one part. */
  partId?: string | null;
  /** Cost of one failed repair (truck roll + callback). Default $300. */
  failureCostCents?: number;
  /** Grace (minutes) before a delivery counts as late. */
  lateGraceMinutes?: number;
}

export interface PartRanking {
  ranked: SupplyChain[];
  cheapest: SupplyChain | null;
  best: SupplyChain | null;
  /** Set when cheapest ≠ best by expected cost — the whole point of this module. */
  insight: string | null;
  /** Expected saving per repair by choosing `best` over `cheapest`. */
  savingPerRepairCents: number;
}

export interface ChainInsight {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'info';
  title: string;
  detail: string;
}

export interface GraphSummary {
  chains: number;
  avgSuccessProbability: number;
  traceability: number;
  untracedInstalls: number;
  quarantined: number;
}

// ============================================================
// CONSTANTS
// ============================================================

export const DEFAULT_FAILURE_COST_CENTS = 30_000;
export const PRIOR_STRENGTH = 8;
const SMALL_PRIOR_STRENGTH = 4;
const LATE_GRACE_MINUTES = 15;

/** Composite weights — sum to 1. Repair success dominates: it is the outcome. */
export const DIMENSION_WEIGHTS: Record<DimensionKey, number> = {
  repair: 0.3,
  authenticity: 0.15,
  defect: 0.15,
  callback: 0.12,
  delivery: 0.1,
  returns: 0.08,
  customer: 0.1,
};

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  repair: 'Repair success',
  authenticity: 'Authenticity',
  defect: 'Defect-free',
  callback: 'Callback-free',
  delivery: 'Delivery reliability',
  returns: 'Return-free',
  customer: 'Customer outcome',
};

export const TIER_LABELS: Record<ChainTier, string> = {
  preferred: 'Preferred',
  approved: 'Approved',
  watch: 'Watch',
  avoid: 'Avoid',
  quarantine: 'Quarantine',
};

export const CUSTODY_STAGE_LABELS: Record<CustodyStage, string> = {
  manufacturer: 'Manufacturer',
  distributor: 'Distributor',
  regional_inventory: 'Regional inventory',
  local_inventory: 'Local inventory',
  truck: 'Truck',
  technician: 'Technician',
  job: 'Job',
};

export const PART_EVENT_LABELS: Record<PartEventType, string> = {
  doa: 'Dead on arrival',
  early_failure: 'Early failure',
  defect: 'Defect found',
  return_to_vendor: 'Returned to vendor',
  warranty_approved: 'Warranty approved',
  warranty_denied: 'Warranty denied',
};

const AUTHENTICITY_WEIGHT: Record<Authenticity, number> = {
  verified: 1,
  unverified: 0.7,
  suspect: 0.25,
  counterfeit: 0,
};

/** Stages a fully traced lot should show before it reaches a job. */
export const TRACE_STAGES: CustodyStage[] = ['manufacturer', 'distributor', 'regional_inventory', 'local_inventory', 'truck'];

const DEFECT_EVENTS: PartEventType[] = ['doa', 'early_failure', 'defect'];

// ============================================================
// HELPERS
// ============================================================

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const pct = (n: number) => `${Math.round(clamp01(n) * 100)}%`;

/** Bayesian shrinkage toward a baseline: small samples don't swing the score. */
export function shrink(successes: number, trials: number, baseline: number, strength = PRIOR_STRENGTH): number {
  return clamp01((successes + strength * baseline) / (trials + strength));
}

function norm(s: string | null | undefined, fallback: string): string {
  const t = (s ?? '').trim();
  return t.length ? t : fallback;
}

export function chainKey(manufacturer: string | null, supplier: string): string {
  return `${norm(manufacturer, 'Unknown manufacturer').toLowerCase()}›${norm(supplier, 'Unknown supplier').toLowerCase()}`;
}

export function confidenceFor(decidedJobs: number): Confidence {
  if (decidedJobs >= 20) return 'high';
  if (decidedJobs >= 5) return 'medium';
  return 'low';
}

export function tierFor(score: number, counterfeitUnits: number): ChainTier {
  if (counterfeitUnits > 0) return 'quarantine';
  if (score >= 80) return 'preferred';
  if (score >= 65) return 'approved';
  if (score >= 50) return 'watch';
  return 'avoid';
}

// ============================================================
// ENGINE
// ============================================================

interface Baselines {
  repair: number;
  callback: number;
  defect: number;
  returns: number;
  delivery: number;
  customer: number;
}

const DEFAULT_BASELINES: Baselines = {
  repair: 0.85,
  callback: 0.92,
  defect: 0.97,
  returns: 0.96,
  delivery: 0.85,
  customer: 0.75,
};

function isLate(lot: ChainLot, graceMinutes: number): boolean | null {
  if (!lot.promised_at) return null;
  const promised = Date.parse(lot.promised_at);
  const received = Date.parse(lot.received_at);
  if (Number.isNaN(promised) || Number.isNaN(received)) return null;
  return received > promised + graceMinutes * 60_000;
}

interface Bucket {
  key: string;
  manufacturer: string;
  supplier: string;
  lots: ChainLot[];
  installs: ChainInstall[];
  events: ChainEvent[];
}

function bucketize(input: ChainInput, partId: string | null | undefined): Bucket[] {
  const lotById = new Map<string, ChainLot>();
  const buckets = new Map<string, Bucket>();

  for (const lot of input.lots) {
    if (partId && lot.part_id !== partId) continue;
    lotById.set(lot.id, lot);
    const manufacturer = norm(lot.manufacturer, 'Unknown manufacturer');
    const supplier = norm(lot.supplier_name, 'Unknown supplier');
    const key = chainKey(lot.manufacturer, supplier);
    const b = buckets.get(key) ?? { key, manufacturer, supplier, lots: [], installs: [], events: [] };
    b.lots.push(lot);
    buckets.set(key, b);
  }
  for (const inst of input.installs) {
    const lot = inst.lot_id ? lotById.get(inst.lot_id) : undefined;
    if (!lot) continue;
    buckets.get(chainKey(lot.manufacturer, norm(lot.supplier_name, 'Unknown supplier')))?.installs.push(inst);
  }
  for (const ev of input.events) {
    const lot = lotById.get(ev.lot_id);
    if (!lot) continue;
    buckets.get(chainKey(lot.manufacturer, norm(lot.supplier_name, 'Unknown supplier')))?.events.push(ev);
  }
  return [...buckets.values()];
}

function portfolioBaselines(buckets: Bucket[], grace: number): Baselines {
  let ok = 0, decided = 0, cb = 0, defectEv = 0, retEv = 0, units = 0;
  let onTime = 0, timed = 0, ratingSum = 0, rated = 0;
  for (const b of buckets) {
    for (const i of b.installs) {
      if (i.outcome_class === 'success' || i.outcome_class === 'failure') {
        decided += 1;
        if (i.outcome_class === 'success') ok += 1;
        if (i.caused_callback || i.is_rework) cb += 1;
        if (i.customer_rating) { ratingSum += (i.customer_rating - 1) / 4; rated += 1; }
      }
    }
    for (const l of b.lots) {
      units += l.quantity_received;
      const late = isLate(l, grace);
      if (late !== null) { timed += 1; if (!late) onTime += 1; }
    }
    for (const e of b.events) {
      if (DEFECT_EVENTS.includes(e.event_type)) defectEv += e.quantity;
      if (e.event_type === 'return_to_vendor') retEv += e.quantity;
    }
  }
  return {
    repair: decided >= 10 ? ok / decided : DEFAULT_BASELINES.repair,
    callback: decided >= 10 ? 1 - cb / decided : DEFAULT_BASELINES.callback,
    defect: units >= 10 ? 1 - defectEv / units : DEFAULT_BASELINES.defect,
    returns: units >= 10 ? 1 - retEv / units : DEFAULT_BASELINES.returns,
    delivery: timed >= 10 ? onTime / timed : DEFAULT_BASELINES.delivery,
    customer: rated >= 10 ? ratingSum / rated : DEFAULT_BASELINES.customer,
  };
}

function scoreBucket(b: Bucket, base: Baselines, failureCost: number, grace: number): SupplyChain {
  const unitsReceived = b.lots.reduce((s, l) => s + l.quantity_received, 0);
  const unitsInstalled = b.installs.reduce((s, i) => s + i.quantity, 0);
  const counterfeitUnits = b.lots.filter((l) => l.authenticity === 'counterfeit').reduce((s, l) => s + l.quantity_received, 0);
  const suspectUnits = b.lots.filter((l) => l.authenticity === 'suspect').reduce((s, l) => s + l.quantity_received, 0);

  const decided = b.installs.filter((i) => i.outcome_class === 'success' || i.outcome_class === 'failure');
  const successes = decided.filter((i) => i.outcome_class === 'success').length;
  const callbacks = decided.filter((i) => i.caused_callback || i.is_rework).length;
  const rated = decided.filter((i) => i.customer_rating !== null);
  const ratingSum = rated.reduce((s, i) => s + ((i.customer_rating as number) - 1) / 4, 0);

  const defectUnits = b.events.filter((e) => DEFECT_EVENTS.includes(e.event_type)).reduce((s, e) => s + e.quantity, 0)
    + b.installs.filter((i) => i.defect_attributed).length;
  const returnUnits = b.events.filter((e) => e.event_type === 'return_to_vendor').reduce((s, e) => s + e.quantity, 0);

  let onTime = 0, timed = 0;
  for (const l of b.lots) {
    const late = isLate(l, grace);
    if (late !== null) { timed += 1; if (!late) onTime += 1; }
  }

  const authWeighted = unitsReceived > 0
    ? b.lots.reduce((s, l) => s + AUTHENTICITY_WEIGHT[l.authenticity] * l.quantity_received, 0) / unitsReceived
    : 0.7;

  const repair = shrink(successes, decided.length, base.repair);
  const callbackFree = shrink(decided.length - callbacks, decided.length, base.callback);
  const defectFree = shrink(Math.max(0, unitsReceived - defectUnits), unitsReceived, base.defect);
  const returnFree = shrink(Math.max(0, unitsReceived - returnUnits), unitsReceived, base.returns);
  const delivery = shrink(onTime, timed, base.delivery, SMALL_PRIOR_STRENGTH);
  const customer = shrink(ratingSum, rated.length, base.customer, SMALL_PRIOR_STRENGTH);

  const dimensions: DimensionScore[] = [
    { key: 'repair', label: DIMENSION_LABELS.repair, score: repair,
      detail: decided.length ? `${successes} of ${decided.length} repairs fixed first visit` : 'No decided repairs yet — using portfolio baseline' },
    { key: 'authenticity', label: DIMENSION_LABELS.authenticity, score: clamp01(authWeighted),
      detail: counterfeitUnits ? `${counterfeitUnits} counterfeit units received` : suspectUnits ? `${suspectUnits} suspect units received` : `${pct(authWeighted)} weighted authenticity across ${b.lots.length} lot(s)` },
    { key: 'defect', label: DIMENSION_LABELS.defect, score: defectFree,
      detail: defectUnits ? `${defectUnits} defective unit(s) of ${unitsReceived} received` : 'No defects recorded' },
    { key: 'callback', label: DIMENSION_LABELS.callback, score: callbackFree,
      detail: callbacks ? `${callbacks} callback/rework job(s)` : 'No callbacks recorded' },
    { key: 'delivery', label: DIMENSION_LABELS.delivery, score: delivery,
      detail: timed ? `${onTime} of ${timed} lots on time` : 'No promised delivery dates recorded' },
    { key: 'returns', label: DIMENSION_LABELS.returns, score: returnFree,
      detail: returnUnits ? `${returnUnits} unit(s) returned to vendor` : 'No returns recorded' },
    { key: 'customer', label: DIMENSION_LABELS.customer, score: customer,
      detail: rated.length ? `${rated.length} rated job(s)` : 'No customer ratings yet' },
  ];

  let score = dimensions.reduce((s, d) => s + DIMENSION_WEIGHTS[d.key] * d.score, 0) * 100;
  if (counterfeitUnits > 0) score = Math.min(score, 35);
  else if (suspectUnits > 0) score = Math.min(score, 60);
  score = Math.round(score);

  // Predicted P(success): outcome evidence first, supply-quality signals second.
  const successProbability = clamp01(0.6 * repair + 0.2 * callbackFree + 0.1 * defectFree + 0.1 * clamp01(authWeighted));

  const totalCostWeighted = b.lots.reduce((s, l) => s + l.unit_cost_cents * l.quantity_received, 0);
  const avgUnitCostCents = unitsReceived > 0 ? Math.round(totalCostWeighted / unitsReceived) : 0;
  const expectedCostPerOutcomeCents = Math.round(avgUnitCostCents + (1 - successProbability) * failureCost);

  const weakestLink = dimensions.reduce((w, d) => (d.score < w.score ? d : w), dimensions[0]);

  const flags: string[] = [];
  if (counterfeitUnits) flags.push(`${counterfeitUnits} counterfeit unit(s) — quarantine this chain`);
  if (suspectUnits) flags.push(`${suspectUnits} suspect unit(s) awaiting verification`);
  if (timed >= 3 && delivery < 0.7) flags.push(`Late on ${timed - onTime} of ${timed} deliveries`);
  if (decided.length >= 5 && repair < 0.7) flags.push(`Only ${pct(repair)} first-visit repair success`);
  if (defectUnits >= 2 && defectFree < 0.9) flags.push(`${defectUnits} defective units recorded`);
  if (decided.length < 5) flags.push('Not enough outcomes yet — treat score as provisional');

  return {
    key: b.key,
    manufacturer: b.manufacturer,
    supplier: b.supplier,
    partIds: [...new Set(b.lots.map((l) => l.part_id))],
    lotCount: b.lots.length,
    unitsReceived,
    unitsInstalled,
    decidedJobs: decided.length,
    score,
    successProbability,
    confidence: confidenceFor(decided.length),
    tier: tierFor(score, counterfeitUnits),
    dimensions,
    weakestLink,
    flags,
    avgUnitCostCents,
    expectedCostPerOutcomeCents,
    counterfeitUnits,
    suspectUnits,
  };
}

/** Builds and scores every supply chain, best expected outcome first. */
export function buildChains(input: ChainInput, opts: ChainOptions = {}): SupplyChain[] {
  const failureCost = Math.max(0, opts.failureCostCents ?? DEFAULT_FAILURE_COST_CENTS);
  const grace = Math.max(0, opts.lateGraceMinutes ?? LATE_GRACE_MINUTES);
  const buckets = bucketize(input, opts.partId);
  const base = portfolioBaselines(buckets, grace);
  return rankChains(buckets.map((b) => scoreBucket(b, base, failureCost, grace)));
}

/** Quarantined chains last; otherwise lowest expected cost per successful outcome first. */
export function rankChains(chains: SupplyChain[]): SupplyChain[] {
  return [...chains].sort((a, b) => {
    const qa = a.tier === 'quarantine' ? 1 : 0;
    const qb = b.tier === 'quarantine' ? 1 : 0;
    if (qa !== qb) return qa - qb;
    if (a.expectedCostPerOutcomeCents !== b.expectedCostPerOutcomeCents) {
      return a.expectedCostPerOutcomeCents - b.expectedCostPerOutcomeCents;
    }
    return b.score - a.score;
  });
}

/** "Cheapest part ≠ best part" — compares price-first vs outcome-first for one part. */
export function comparePrice(chains: SupplyChain[]): PartRanking {
  const eligible = chains.filter((c) => c.tier !== 'quarantine' && c.unitsReceived > 0);
  if (eligible.length === 0) return { ranked: rankChains(chains), cheapest: null, best: null, insight: null, savingPerRepairCents: 0 };

  const cheapest = [...eligible].sort((a, b) => a.avgUnitCostCents - b.avgUnitCostCents)[0];
  const best = rankChains(eligible)[0];
  const saving = Math.max(0, cheapest.expectedCostPerOutcomeCents - best.expectedCostPerOutcomeCents);

  let insight: string | null = null;
  if (cheapest.key !== best.key && saving > 0) {
    const extra = best.avgUnitCostCents - cheapest.avgUnitCostCents;
    insight =
      `${cheapest.manufacturer} via ${cheapest.supplier} is the cheapest part (${formatCents(cheapest.avgUnitCostCents)}) ` +
      `but only ${pct(cheapest.successProbability)} of its repairs succeed. ` +
      `${best.manufacturer} via ${best.supplier} costs ${formatCents(Math.max(0, extra))} more per part ` +
      `at ${pct(best.successProbability)} success — saving about ${formatCents(saving)} per repair.`;
  }
  return { ranked: rankChains(chains), cheapest, best, insight, savingPerRepairCents: saving };
}

export function summarize(chains: SupplyChain[], installs: ChainInstall[]): GraphSummary {
  const traced = installs.filter((i) => i.lot_id !== null).length;
  const weighted = chains.reduce((s, c) => s + c.successProbability * Math.max(1, c.decidedJobs), 0);
  const weight = chains.reduce((s, c) => s + Math.max(1, c.decidedJobs), 0);
  return {
    chains: chains.length,
    avgSuccessProbability: weight ? weighted / weight : 0,
    traceability: installs.length ? traced / installs.length : 0,
    untracedInstalls: installs.length - traced,
    quarantined: chains.filter((c) => c.tier === 'quarantine').length,
  };
}

/** Ranked, human-readable actions for the owner. */
export function buildInsights(chains: SupplyChain[], summary: GraphSummary, lots: ChainLot[]): ChainInsight[] {
  const out: ChainInsight[] = [];

  for (const c of chains.filter((x) => x.tier === 'quarantine')) {
    out.push({
      id: `quarantine:${c.key}`, severity: 'critical',
      title: `Quarantine ${c.manufacturer} via ${c.supplier}`,
      detail: `${c.counterfeitUnits} counterfeit unit(s) received. Pull remaining stock from trucks and warehouse and open a vendor claim.`,
    });
  }
  for (const c of chains.filter((x) => x.tier === 'avoid' && x.decidedJobs >= 5)) {
    out.push({
      id: `avoid:${c.key}`, severity: 'high',
      title: `Stop buying from ${c.manufacturer} via ${c.supplier}`,
      detail: `Score ${c.score}/100 over ${c.decidedJobs} repairs. Weakest link: ${c.weakestLink.label.toLowerCase()} — ${c.weakestLink.detail.toLowerCase()}.`,
    });
  }
  for (const c of chains.filter((x) => x.tier === 'watch' && x.decidedJobs >= 5)) {
    out.push({
      id: `watch:${c.key}`, severity: 'medium',
      title: `Review ${c.manufacturer} via ${c.supplier}`,
      detail: `Score ${c.score}/100. Weakest link: ${c.weakestLink.label.toLowerCase()} — ${c.weakestLink.detail.toLowerCase()}.`,
    });
  }
  if (summary.untracedInstalls > 0) {
    out.push({
      id: 'traceability', severity: summary.traceability < 0.5 ? 'high' : 'medium',
      title: `${summary.untracedInstalls} installed part(s) have no lot attached`,
      detail: `Traceability is ${pct(summary.traceability)}. Untraced parts can’t feed outcome learning — link them to a received lot.`,
    });
  }
  const unverified = lots.filter((l) => l.authenticity === 'unverified').reduce((s, l) => s + l.quantity_received, 0);
  if (unverified > 0) {
    out.push({
      id: 'unverified', severity: 'info',
      title: `${unverified} unit(s) received without authenticity verification`,
      detail: 'Verify serials or lot codes with the manufacturer for high-risk parts (compressors, boards, gas valves).',
    });
  }
  const order = { critical: 0, high: 1, medium: 2, info: 3 } as const;
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ============================================================
// DATA ACCESS
// ============================================================

const ROW_LIMIT = 5000;

interface LotRow {
  id: string;
  part_id: string;
  vendor_id: string | null;
  market_source_id: string | null;
  manufacturer: string | null;
  distributor: string | null;
  lot_code: string | null;
  authenticity: Authenticity;
  promised_at: string | null;
  received_at: string;
  quantity_received: number;
  unit_cost_cents: number;
  inventory_parts: { name: string | null } | null;
  vendors: { name: string | null } | null;
  parts_market_sources: { name: string | null } | null;
  supply_chain_custody_events: { stage: CustodyStage }[] | null;
}

export async function fetchChainLots(): Promise<ChainLot[]> {
  const { data, error } = await supabase
    .from('supply_chain_lots')
    .select(
      'id, part_id, vendor_id, market_source_id, manufacturer, distributor, lot_code, authenticity, promised_at, received_at, quantity_received, unit_cost_cents, inventory_parts(name), vendors(name), parts_market_sources(name), supply_chain_custody_events(stage)',
    )
    .order('received_at', { ascending: false })
    .limit(ROW_LIMIT);
  if (error) throw error;
  return ((data ?? []) as unknown as LotRow[]).map((r) => ({
    id: r.id,
    part_id: r.part_id,
    part_name: r.inventory_parts?.name ?? 'Part',
    manufacturer: r.manufacturer,
    distributor: r.distributor,
    supplier_name: r.vendors?.name ?? r.parts_market_sources?.name ?? (r.distributor?.trim() || 'Unknown supplier'),
    vendor_id: r.vendor_id,
    market_source_id: r.market_source_id,
    authenticity: r.authenticity,
    promised_at: r.promised_at,
    received_at: r.received_at,
    quantity_received: r.quantity_received,
    unit_cost_cents: r.unit_cost_cents,
    custody_stages: [...new Set((r.supply_chain_custody_events ?? []).map((e) => e.stage))],
  }));
}

export async function fetchChainInstalls(): Promise<ChainInstall[]> {
  const { data, error } = await supabase
    .from('supply_chain_install_outcomes')
    .select('install_id, job_id, part_id, part_name, lot_id, quantity, outcome_class, caused_callback, is_rework, customer_rating, defect_attributed, installed_at')
    .order('installed_at', { ascending: false })
    .limit(ROW_LIMIT);
  if (error) throw error;
  return (data ?? []) as ChainInstall[];
}

export async function fetchChainEvents(): Promise<ChainEvent[]> {
  const { data, error } = await supabase
    .from('supply_chain_part_events')
    .select('id, lot_id, event_type, quantity')
    .order('occurred_at', { ascending: false })
    .limit(ROW_LIMIT);
  if (error) throw error;
  return (data ?? []) as ChainEvent[];
}

export async function fetchChainInput(): Promise<ChainInput> {
  const [lots, installs, events] = await Promise.all([fetchChainLots(), fetchChainInstalls(), fetchChainEvents()]);
  return { lots, installs, events };
}

async function currentUserId(): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  return user.id;
}

export interface LotInput {
  part_id: string;
  vendor_id?: string | null;
  market_source_id?: string | null;
  manufacturer?: string | null;
  distributor?: string | null;
  lot_code?: string | null;
  authenticity: Authenticity;
  authenticity_method?: string | null;
  promised_at?: string | null;
  received_at?: string | null;
  quantity_received: number;
  unit_cost_cents: number;
  stages?: CustodyStage[];
}

/** Records a received lot (+ the custody hops already known) and returns its id. */
export async function recordLot(input: LotInput): Promise<string> {
  if (!Number.isInteger(input.quantity_received) || input.quantity_received <= 0) throw new Error('Quantity must be a positive whole number');
  if (!Number.isInteger(input.unit_cost_cents) || input.unit_cost_cents < 0) throw new Error('Unit cost is invalid');
  const userId = await currentUserId();
  const { stages, ...row } = input;
  const { data, error } = await supabase
    .from('supply_chain_lots')
    .insert({
      ...row,
      user_id: userId,
      manufacturer: row.manufacturer?.trim() || null,
      distributor: row.distributor?.trim() || null,
      lot_code: row.lot_code?.trim() || null,
      received_at: row.received_at || new Date().toISOString(),
      promised_at: row.promised_at || null,
    })
    .select('id')
    .single();
  if (error) throw error;
  const lotId = (data as { id: string }).id;
  if (stages?.length) {
    const { error: cErr } = await supabase
      .from('supply_chain_custody_events')
      .insert(stages.map((stage) => ({ user_id: userId, lot_id: lotId, stage })));
    if (cErr) throw cErr;
  }
  return lotId;
}

export async function recordCustodyEvent(lotId: string, stage: CustodyStage, locationLabel?: string): Promise<void> {
  const userId = await currentUserId();
  const { error } = await supabase
    .from('supply_chain_custody_events')
    .insert({ user_id: userId, lot_id: lotId, stage, location_label: locationLabel?.trim() || null });
  if (error) throw error;
}

export async function recordPartEvent(params: {
  lot_id: string;
  event_type: PartEventType;
  quantity?: number;
  install_id?: string | null;
  note?: string | null;
}): Promise<void> {
  const userId = await currentUserId();
  const quantity = params.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Quantity must be a positive whole number');
  const { error } = await supabase.from('supply_chain_part_events').insert({
    user_id: userId,
    lot_id: params.lot_id,
    event_type: params.event_type,
    quantity,
    install_id: params.install_id ?? null,
    note: params.note?.trim() || null,
  });
  if (error) throw error;
}

export async function updateLotAuthenticity(lotId: string, authenticity: Authenticity, method?: string): Promise<void> {
  const { error } = await supabase
    .from('supply_chain_lots')
    .update({ authenticity, authenticity_method: method?.trim() || null })
    .eq('id', lotId);
  if (error) throw error;
}

export async function linkInstallToLot(installId: string, lotId: string): Promise<void> {
  const { error } = await supabase.from('supply_chain_installs').update({ lot_id: lotId }).eq('id', installId);
  if (error) throw error;
}

/** Fires (debounced) when installs, lots or part events change. Returns an unsubscribe fn. */
export function subscribeToSupplyChain(onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 400);
  };
  const channel = supabase
    .channel('supply-chain-outcomes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'supply_chain_installs' }, fire)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'supply_chain_lots' }, fire)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'supply_chain_part_events' }, fire)
    .subscribe();
  return () => {
    if (timer) clearTimeout(timer);
    void supabase.removeChannel(channel);
  };
}
