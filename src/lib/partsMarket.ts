/**
 * AI Parts Market — Real-Time Supplier Intelligence
 *
 * For a part need (usually a job shortage) this module answers:
 *   "Where is Part X right now, what does each source really cost us
 *    all-in, and should we BUY it, TRANSFER it, or BORROW it?"
 *
 * Sources compared (all in one ranking):
 *   own van · warehouse · vendor · local distributor · nearby contractor
 *   (+ approved substitutes of the part, when enabled)
 *
 * The decision engine (`evaluateMarket`) is PURE and deterministic — no
 * network, no randomness — so every recommendation is explainable,
 * auditable and unit-testable. Data access lives below it.
 *
 * All money is integer cents. All times are minutes.
 */

import { supabase } from './supabase';
import { formatCents } from './priceBook';
import { transferInventoryStock } from './inventory';
import type { PartsAvailabilityRow } from './inventory';
import { createPurchaseRequest } from './procurement';

// ============================================================
// TYPES
// ============================================================

export type SourceType = 'vendor' | 'distributor' | 'contractor';
export type Fulfillment = 'pickup' | 'delivery' | 'handoff';
export type OfferOrigin = 'manual' | 'rfq' | 'catalog' | 'api';
export type OptionKind = 'van' | 'warehouse' | 'vendor' | 'distributor' | 'contractor';
export type MarketAction =
  | 'use_van_stock'
  | 'transfer_stock'
  | 'buy_vendor'
  | 'buy_distributor'
  | 'borrow_contractor';
export type Verdict = 'buy' | 'borrow' | 'internal' | 'none';
export type DecisionStatus = 'recommended' | 'accepted' | 'overridden' | 'dismissed';

export interface MarketSource {
  id: string;
  user_id: string;
  name: string;
  source_type: SourceType;
  vendor_id: string | null;
  phone: string | null;
  address: string | null;
  distance_miles: number;
  typical_response_minutes: number;
  reliability_score: number;
  delivery_fee_cents: number;
  borrow_fee_pct: number;
  return_in_kind: boolean;
  notes: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Mirrors the `parts_market_live_offers` SQL view. */
export interface MarketOfferRow {
  offer_id: string;
  user_id: string;
  part_id: string;
  part_name: string;
  part_number: string | null;
  source_id: string;
  source_name: string;
  source_type: SourceType;
  vendor_id: string | null;
  source_phone: string | null;
  distance_miles: number;
  typical_response_minutes: number;
  reliability_score: number;
  delivery_fee_cents: number;
  borrow_fee_pct: number;
  return_in_kind: boolean;
  source_active: boolean;
  unit_price_cents: number;
  quantity_available: number;
  eta_minutes: number | null;
  fulfillment: Fulfillment;
  origin: OfferOrigin;
  observed_at: string;
  expires_at: string | null;
  note: string | null;
  age_minutes: number;
  is_expired: boolean;
}

export interface PriceHistoryRow {
  part_id: string;
  source_id: string;
  unit_price_cents: number;
  observed_at: string;
}

export interface MarketPart {
  id: string;
  name: string;
  part_number: string | null;
  unit_cost_cents: number;
}

export interface MarketLocation {
  id: string;
  name: string;
  location_type: string;
  assigned_technician_id: string | null;
}

export interface MarketInput {
  requestedPart: MarketPart;
  /** Requested part + its substitutes (looked up by id). */
  parts: MarketPart[];
  substituteIds: string[];
  availability: PartsAvailabilityRow[];
  locations: MarketLocation[];
  offers: MarketOfferRow[];
  priceHistory: PriceHistoryRow[];
}

export interface DecisionContext {
  quantity: number;
  /** Job appointment (or "needed by") — null when there is no hard deadline. */
  deadline: string | Date | null;
  /** Technician assigned to the job — used to recognise "their own van". */
  technicianId: string | null;
  now?: Date;
  /** Loaded technician cost. Default $65/h. */
  laborRateCentsPerHour?: number;
  /** Cost of a return trip if the part is not on site at the appointment. Default $185. */
  revisitCostCents?: number;
  /** What the customer is billed per unit (if known). */
  billableUnitPriceCents?: number | null;
  /** Used when billable price is unknown: unit cost x markup. Default 1.4. */
  defaultMarkup?: number;
  jobRevenueCents?: number | null;
  /** Offers older than this are flagged and de-rated. Default 240 min. */
  staleAfterMinutes?: number;
  warehouseTransferMinutes?: number;
  otherVanMinutes?: number;
  deadlineBufferMinutes?: number;
  allowSubstitutes?: boolean;
}

export interface MarketOption {
  key: string;
  kind: OptionKind;
  action: MarketAction;
  label: string;
  sourceId: string | null;
  locationId: string | null;
  phone: string | null;
  partId: string;
  partName: string;
  isSubstitute: boolean;
  unitPriceCents: number;
  quantityAvailable: number;
  etaMinutes: number;
  fulfillment: Fulfillment | 'internal';
  freshnessMinutes: number | null;
  stale: boolean;
  priceVs30dAvgPct: number | null;
  landedCostCents: number;
  logisticsLaborCents: number;
  onTimeProbability: number;
  expectedRevisitCostCents: number;
  expectedTotalCostCents: number;
  marginCents: number;
  marginErosionCents: number;
  meetsQuantity: boolean;
  meetsDeadline: boolean;
  flags: string[];
  rank: number | null;
}

export interface SplitLine {
  label: string;
  quantity: number;
  key: string;
}

export interface BuyVsBorrow {
  verdict: Verdict;
  bestInternal: MarketOption | null;
  bestBuy: MarketOption | null;
  bestBorrow: MarketOption | null;
  /** Positive = winning path is cheaper than the runner-up path, all-in. */
  savingsCents: number;
  etaDeltaMinutes: number;
  headline: string;
}

export interface MarketDecision {
  options: MarketOption[];
  recommended: MarketOption | null;
  runnerUp: MarketOption | null;
  buyVsBorrow: BuyVsBorrow;
  confidence: number;
  rationale: string[];
  splitPlan: SplitLine[] | null;
  excluded: { label: string; reason: string }[];
  minutesUntilDeadline: number | null;
  idealCostCents: number;
  revenueCents: number;
  quantity: number;
}

export interface MarketDecisionRow {
  id: string;
  user_id: string;
  part_id: string;
  job_id: string | null;
  quantity: number;
  recommended_action: string;
  recommended_label: string;
  chosen_action: string | null;
  chosen_label: string | null;
  expected_total_cost_cents: number;
  margin_erosion_cents: number;
  confidence: number;
  verdict: Verdict;
  rationale: string[];
  status: DecisionStatus;
  created_at: string;
  updated_at: string;
}

/** Row of `job_parts_readiness` narrowed to what the market needs. */
export interface ShortJobRow {
  requirement_id: string;
  job_id: string;
  customer_name: string;
  scheduled_datetime: string | null;
  assigned_technician_id: string | null;
  part_id: string;
  part_name: string;
  quantity_required: number;
  shortage_quantity: number;
}

// ============================================================
// LABELS
// ============================================================

export const OPTION_KIND_LABELS: Record<OptionKind, string> = {
  van: 'Van',
  warehouse: 'Warehouse',
  vendor: 'Vendor',
  distributor: 'Local distributor',
  contractor: 'Nearby contractor',
};

export const ACTION_LABELS: Record<MarketAction, string> = {
  use_van_stock: 'Use van stock',
  transfer_stock: 'Transfer stock',
  buy_vendor: 'Buy from vendor',
  buy_distributor: 'Buy from distributor',
  borrow_contractor: 'Borrow from contractor',
};

export const VERDICT_LABELS: Record<Verdict, string> = {
  buy: 'Buy',
  borrow: 'Borrow',
  internal: 'Use own stock',
  none: 'No viable source',
};

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  vendor: 'Vendor',
  distributor: 'Local distributor',
  contractor: 'Nearby contractor',
};

// ============================================================
// ENGINE CONSTANTS (documented so the model is auditable)
// ============================================================

const DEFAULTS = {
  laborRateCentsPerHour: 6500,
  revisitCostCents: 18500,
  defaultMarkup: 1.4,
  staleAfterMinutes: 240,
  warehouseTransferMinutes: 45,
  otherVanMinutes: 60,
  deadlineBufferMinutes: 15,
  /** Average urban driving speed → one-way minutes per mile. */
  minutesPerMile: 2,
  handlingMinutes: 10,
  internalReliability: 0.98,
  ownVanReliability: 0.99,
  staleReliabilityFactor: 0.85,
  /** Probability a substitute fails fit/spec and forces a revisit. */
  substituteFailureRisk: 0.06,
} as const;

// ============================================================
// FORMATTING
// ============================================================

export function formatEta(minutes: number): string {
  if (minutes <= 0) return 'On hand';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function formatAge(minutes: number | null): string {
  if (minutes === null) return 'Live';
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / (60 * 24))} d ago`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ============================================================
// ENGINE
// ============================================================

/** Probability the part is in the technician's hands before the appointment. */
export function onTimeProbability(
  reliability: number,
  etaMinutes: number,
  minutesUntilDeadline: number | null,
  bufferMinutes: number,
): number {
  if (minutesUntilDeadline === null) return clamp(reliability, 0, 1);
  const slack = minutesUntilDeadline - bufferMinutes - etaMinutes;
  if (slack < 0) return 0.05;
  if (slack >= 60) return clamp(reliability, 0, 1);
  return clamp(reliability * (0.6 + (0.4 * slack) / 60), 0, 1);
}

function meanPrice(history: PriceHistoryRow[], partId: string, sourceId: string): number | null {
  const rows = history.filter((h) => h.part_id === partId && h.source_id === sourceId);
  if (rows.length < 2) return null;
  return rows.reduce((s, r) => s + r.unit_price_cents, 0) / rows.length;
}

export function evaluateMarket(input: MarketInput, ctx: DecisionContext): MarketDecision {
  const qty = Math.max(1, Math.floor(ctx.quantity));
  const now = ctx.now ?? new Date();
  const labor = ctx.laborRateCentsPerHour ?? DEFAULTS.laborRateCentsPerHour;
  const revisit = ctx.revisitCostCents ?? DEFAULTS.revisitCostCents;
  const staleAfter = ctx.staleAfterMinutes ?? DEFAULTS.staleAfterMinutes;
  const whMinutes = ctx.warehouseTransferMinutes ?? DEFAULTS.warehouseTransferMinutes;
  const otherVan = ctx.otherVanMinutes ?? DEFAULTS.otherVanMinutes;
  const buffer = ctx.deadlineBufferMinutes ?? DEFAULTS.deadlineBufferMinutes;
  const allowSubs = ctx.allowSubstitutes ?? true;
  const markup = ctx.defaultMarkup ?? DEFAULTS.defaultMarkup;

  const deadlineDate = ctx.deadline ? new Date(ctx.deadline) : null;
  const minutesUntilDeadline =
    deadlineDate && !Number.isNaN(deadlineDate.getTime())
      ? Math.floor((deadlineDate.getTime() - now.getTime()) / 60000)
      : null;

  const partById = new Map(input.parts.map((p) => [p.id, p]));
  const locationById = new Map(input.locations.map((l) => [l.id, l]));
  const subIds = new Set(input.substituteIds);
  const requested = input.requestedPart;
  const idealCostCents = qty * requested.unit_cost_cents;
  const unitRevenue = ctx.billableUnitPriceCents ?? Math.round(requested.unit_cost_cents * markup);
  const revenueCents = qty * unitRevenue;

  const excluded: { label: string; reason: string }[] = [];
  const options: MarketOption[] = [];

  const usablePart = (partId: string): MarketPart | null => {
    if (partId !== requested.id && !(allowSubs && subIds.has(partId))) return null;
    return partById.get(partId) ?? (partId === requested.id ? requested : null);
  };

  const finalize = (
    base: Omit<
      MarketOption,
      | 'landedCostCents'
      | 'logisticsLaborCents'
      | 'onTimeProbability'
      | 'expectedRevisitCostCents'
      | 'expectedTotalCostCents'
      | 'marginCents'
      | 'marginErosionCents'
      | 'meetsQuantity'
      | 'meetsDeadline'
      | 'rank'
    > & { partCostCents: number; feesCents: number; laborMinutes: number; reliability: number },
  ): MarketOption => {
    const { partCostCents, feesCents, laborMinutes, reliability, ...rest } = base;
    const p = onTimeProbability(reliability, base.etaMinutes, minutesUntilDeadline, buffer);
    const logisticsLaborCents = Math.round((laborMinutes / 60) * labor);
    const landedCostCents = partCostCents + feesCents;
    const expectedRevisitCostCents = Math.round(
      (1 - p) * revisit + (base.isSubstitute ? DEFAULTS.substituteFailureRisk * revisit : 0),
    );
    const expectedTotalCostCents = landedCostCents + logisticsLaborCents + expectedRevisitCostCents;
    const meetsDeadline =
      minutesUntilDeadline === null || base.etaMinutes + buffer <= minutesUntilDeadline;
    const flags = [...rest.flags];
    if (!meetsDeadline) flags.push('Arrives after the appointment');
    return {
      ...rest,
      flags,
      landedCostCents,
      logisticsLaborCents,
      onTimeProbability: p,
      expectedRevisitCostCents,
      expectedTotalCostCents,
      marginCents: revenueCents - expectedTotalCostCents,
      marginErosionCents: expectedTotalCostCents - idealCostCents,
      meetsQuantity: base.quantityAvailable >= qty,
      meetsDeadline,
      rank: null,
    };
  };

  // ---- internal stock (own van / other vans / warehouses) ----
  for (const row of input.availability) {
    if (row.quantity_available <= 0) continue;
    const part = usablePart(row.part_id);
    if (!part) continue;
    const loc = locationById.get(row.location_id);
    const isVan = row.location_type === 'van';
    if (row.location_type === 'jobsite') continue;
    const ownVan =
      isVan &&
      !!ctx.technicianId &&
      !!loc?.assigned_technician_id &&
      loc.assigned_technician_id === ctx.technicianId;
    const isSub = part.id !== requested.id;
    const eta = ownVan ? 0 : isVan ? otherVan : whMinutes;
    options.push(
      finalize({
        key: `stock:${row.location_id}:${part.id}`,
        kind: isVan ? 'van' : 'warehouse',
        action: ownVan ? 'use_van_stock' : 'transfer_stock',
        label: row.location_name,
        sourceId: null,
        locationId: row.location_id,
        phone: null,
        partId: part.id,
        partName: part.name,
        isSubstitute: isSub,
        unitPriceCents: part.unit_cost_cents,
        quantityAvailable: row.quantity_available,
        etaMinutes: eta,
        fulfillment: 'internal',
        freshnessMinutes: null,
        stale: false,
        priceVs30dAvgPct: null,
        partCostCents: qty * part.unit_cost_cents,
        feesCents: 0,
        laborMinutes: ownVan ? 0 : eta,
        reliability: ownVan ? DEFAULTS.ownVanReliability : DEFAULTS.internalReliability,
        flags: isSub ? ['Substitute part — confirm compatibility'] : [],
      }),
    );
  }

  // ---- external offers (vendor / distributor / contractor) ----
  for (const o of input.offers) {
    const part = usablePart(o.part_id);
    if (!part) continue;
    if (!o.source_active) {
      excluded.push({ label: o.source_name, reason: 'Source is inactive' });
      continue;
    }
    if (o.is_expired) {
      excluded.push({ label: o.source_name, reason: 'Quote expired — refresh it' });
      continue;
    }
    if (o.quantity_available <= 0) {
      excluded.push({ label: o.source_name, reason: 'Out of stock' });
      continue;
    }
    const isContractor = o.source_type === 'contractor';
    const travelOneWay = o.distance_miles * DEFAULTS.minutesPerMile;
    const eta = o.eta_minutes ?? Math.round(o.typical_response_minutes + travelOneWay);
    const legMinutes =
      o.fulfillment === 'delivery' ? 0 : Math.round(2 * travelOneWay + DEFAULTS.handlingMinutes);
    const returnInKind = isContractor && o.return_in_kind;
    // Borrowed-and-returned parts are still consumed on the job: the true
    // cost is what it costs us to replace the part we hand back later.
    const unitCost = returnInKind ? part.unit_cost_cents : o.unit_price_cents;
    const borrowFee = isContractor
      ? Math.round((qty * o.unit_price_cents * Number(o.borrow_fee_pct)) / 100)
      : 0;
    const deliveryFee = !isContractor && o.fulfillment === 'delivery' ? o.delivery_fee_cents : 0;
    const stale = o.age_minutes > staleAfter;
    const avg = meanPrice(input.priceHistory, o.part_id, o.source_id);
    const priceVsAvg = avg && avg > 0 ? ((o.unit_price_cents - avg) / avg) * 100 : null;
    const flags: string[] = [];
    if (part.id !== requested.id) flags.push('Substitute part — confirm compatibility');
    if (stale) flags.push('Quote is stale — confirm before committing');
    if (priceVsAvg !== null && priceVsAvg >= 10) {
      flags.push(`Price ${Math.round(priceVsAvg)}% above 30-day average`);
    }
    if (returnInKind) flags.push('Return in kind required');
    if (o.quantity_available < qty) flags.push(`Only ${o.quantity_available} available`);
    const action: MarketAction = isContractor
      ? 'borrow_contractor'
      : o.source_type === 'distributor'
        ? 'buy_distributor'
        : 'buy_vendor';
    options.push(
      finalize({
        key: `offer:${o.offer_id}`,
        kind: o.source_type,
        action,
        label: o.source_name,
        sourceId: o.source_id,
        locationId: null,
        phone: o.source_phone,
        partId: part.id,
        partName: part.name,
        isSubstitute: part.id !== requested.id,
        unitPriceCents: o.unit_price_cents,
        quantityAvailable: o.quantity_available,
        etaMinutes: eta,
        fulfillment: o.fulfillment,
        freshnessMinutes: o.age_minutes,
        stale,
        priceVs30dAvgPct: priceVsAvg,
        partCostCents: qty * unitCost,
        feesCents: borrowFee + deliveryFee,
        laborMinutes: legMinutes + (returnInKind ? legMinutes : 0),
        reliability:
          Number(o.reliability_score) * (stale ? DEFAULTS.staleReliabilityFactor : 1),
        flags,
      }),
    );
  }

  // ---- rank ----
  const byCost = (a: MarketOption, b: MarketOption) =>
    a.expectedTotalCostCents - b.expectedTotalCostCents ||
    a.etaMinutes - b.etaMinutes ||
    b.onTimeProbability - a.onTimeProbability;

  const full = options.filter((o) => o.meetsQuantity).sort(byCost);
  full.forEach((o, i) => (o.rank = i + 1));
  const partial = options.filter((o) => !o.meetsQuantity).sort(byCost);
  const ordered = [...full, ...partial];

  const recommended = full[0] ?? null;
  const runnerUp = full[1] ?? null;
  const best = (kinds: OptionKind[]) => full.find((o) => kinds.includes(o.kind)) ?? null;
  const bestInternal = best(['van', 'warehouse']);
  const bestBuy = best(['vendor', 'distributor']);
  const bestBorrow = best(['contractor']);

  // ---- split fulfilment when no single source can cover the quantity ----
  let splitPlan: SplitLine[] | null = null;
  if (!recommended && partial.length > 0) {
    let remaining = qty;
    const plan: SplitLine[] = [];
    for (const o of [...partial].sort(
      (a, b) => a.expectedTotalCostCents / a.quantityAvailable - b.expectedTotalCostCents / b.quantityAvailable,
    )) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, o.quantityAvailable);
      plan.push({ label: o.label, quantity: take, key: o.key });
      remaining -= take;
    }
    splitPlan = remaining === 0 ? plan : null;
  }

  // ---- verdict ----
  const verdict: Verdict = !recommended
    ? 'none'
    : recommended.kind === 'contractor'
      ? 'borrow'
      : recommended.kind === 'vendor' || recommended.kind === 'distributor'
        ? 'buy'
        : 'internal';

  const rivalOf = (o: MarketOption | null): MarketOption | null => {
    if (!o) return null;
    if (o.kind === 'contractor') return bestBuy ?? bestInternal;
    if (o.kind === 'vendor' || o.kind === 'distributor') return bestBorrow ?? bestInternal;
    return bestBuy ?? bestBorrow;
  };
  const rival = rivalOf(recommended);
  const savingsCents = recommended && rival ? rival.expectedTotalCostCents - recommended.expectedTotalCostCents : 0;
  const etaDeltaMinutes = recommended && rival ? rival.etaMinutes - recommended.etaMinutes : 0;

  const rationale: string[] = [];
  let headline = 'No single source can cover this quantity right now.';
  if (recommended) {
    const p = Math.round(recommended.onTimeProbability * 100);
    rationale.push(
      `${recommended.label} can supply ${qty}× ${recommended.partName} in ${formatEta(recommended.etaMinutes)} — ` +
        `${p}% on-time probability, all-in expected cost ${formatCents(recommended.expectedTotalCostCents)}.`,
    );
    if (recommended.marginErosionCents > 0) {
      rationale.push(
        `Margin erosion vs. having the part on hand: ${formatCents(recommended.marginErosionCents)}.`,
      );
    } else {
      rationale.push('No margin erosion vs. having the part on hand.');
    }
    if (rival) {
      headline =
        savingsCents > 0
          ? `${VERDICT_LABELS[verdict]} — ${formatCents(savingsCents)} cheaper all-in than the next-best path` +
            (etaDeltaMinutes > 0 ? ` and ${formatEta(etaDeltaMinutes)} faster.` : '.')
          : `${VERDICT_LABELS[verdict]} — comparable cost to the next-best path.`;
      rationale.push(
        `Next-best path: ${rival.label} (${OPTION_KIND_LABELS[rival.kind]}) at ${formatCents(rival.expectedTotalCostCents)}, ${formatEta(rival.etaMinutes)}.`,
      );
    } else {
      headline = `${VERDICT_LABELS[verdict]} — the only source that can cover the full quantity.`;
    }
    if (minutesUntilDeadline !== null) {
      rationale.push(
        recommended.meetsDeadline
          ? `Arrives with ${formatEta(minutesUntilDeadline - recommended.etaMinutes)} to spare before the appointment.`
          : `Cannot beat the appointment (${formatEta(Math.max(0, minutesUntilDeadline))} left) — expected revisit risk is priced in.`,
      );
    }
    for (const f of recommended.flags) rationale.push(f);
  } else if (splitPlan) {
    headline = `Split across ${splitPlan.length} sources to cover ${qty} units.`;
    rationale.push(
      `No single source has ${qty} units. Split: ${splitPlan.map((s) => `${s.quantity}× ${s.label}`).join(', ')}.`,
    );
  } else {
    rationale.push('Add or refresh supplier quotes, or check substitutes — no combination covers this quantity.');
  }

  // ---- confidence ----
  let confidence = 0.3;
  if (recommended) {
    const gapRatio = runnerUp
      ? (runnerUp.expectedTotalCostCents - recommended.expectedTotalCostCents) /
        Math.max(recommended.expectedTotalCostCents, 1)
      : 0.25;
    confidence = clamp(
      0.55 +
        Math.min(gapRatio, 0.5) * 0.6 +
        (recommended.onTimeProbability - 0.5) * 0.3 -
        (recommended.stale ? 0.15 : 0) -
        (recommended.isSubstitute ? 0.05 : 0),
      0.2,
      0.97,
    );
  } else if (splitPlan) {
    confidence = 0.4;
  }

  return {
    options: ordered,
    recommended,
    runnerUp,
    buyVsBorrow: { verdict, bestInternal, bestBuy, bestBorrow, savingsCents, etaDeltaMinutes, headline },
    confidence: Math.round(confidence * 100) / 100,
    rationale,
    splitPlan,
    excluded,
    minutesUntilDeadline,
    idealCostCents,
    revenueCents,
    quantity: qty,
  };
}

// ============================================================
// DATA ACCESS
// ============================================================

async function currentUserId(): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  return user.id;
}

export async function fetchMarketParts(): Promise<MarketPart[]> {
  const { data, error } = await supabase
    .from('inventory_parts')
    .select('id, name, part_number, unit_cost_cents')
    .eq('active', true)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as MarketPart[];
}

export async function fetchMarketSources(): Promise<MarketSource[]> {
  const { data, error } = await supabase
    .from('parts_market_sources')
    .select('*')
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as MarketSource[];
}

export type MarketSourceInput = Pick<MarketSource, 'name' | 'source_type'> &
  Partial<
    Pick<
      MarketSource,
      | 'vendor_id'
      | 'phone'
      | 'address'
      | 'distance_miles'
      | 'typical_response_minutes'
      | 'reliability_score'
      | 'delivery_fee_cents'
      | 'borrow_fee_pct'
      | 'return_in_kind'
      | 'notes'
      | 'active'
    >
  >;

export async function createMarketSource(input: MarketSourceInput): Promise<MarketSource> {
  const user_id = await currentUserId();
  const { data, error } = await supabase
    .from('parts_market_sources')
    .insert({ ...input, user_id })
    .select()
    .single();
  if (error) throw error;
  return data as MarketSource;
}

export async function updateMarketSource(id: string, patch: Partial<MarketSourceInput>): Promise<void> {
  const { error } = await supabase.from('parts_market_sources').update(patch).eq('id', id);
  if (error) throw error;
}

export async function fetchLiveOffers(partIds: string[]): Promise<MarketOfferRow[]> {
  if (partIds.length === 0) return [];
  const { data, error } = await supabase
    .from('parts_market_live_offers')
    .select('*')
    .in('part_id', partIds);
  if (error) throw error;
  return (data ?? []) as MarketOfferRow[];
}

export interface OfferInput {
  part_id: string;
  source_id: string;
  unit_price_cents: number;
  quantity_available: number;
  eta_minutes?: number | null;
  fulfillment?: Fulfillment;
  origin?: OfferOrigin;
  expires_at?: string | null;
  note?: string | null;
}

/** One live quote per part x source — re-quoting overwrites it and refreshes observed_at. */
export async function upsertOffer(input: OfferInput): Promise<void> {
  const user_id = await currentUserId();
  const { error } = await supabase.from('parts_market_offers').upsert(
    { ...input, user_id, observed_at: new Date().toISOString() },
    { onConflict: 'part_id,source_id' },
  );
  if (error) throw error;
}

export async function fetchPriceHistory(partIds: string[], days = 30): Promise<PriceHistoryRow[]> {
  if (partIds.length === 0) return [];
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('parts_market_price_history')
    .select('part_id, source_id, unit_price_cents, observed_at')
    .in('part_id', partIds)
    .gte('observed_at', since);
  if (error) throw error;
  return (data ?? []) as PriceHistoryRow[];
}

export async function fetchSubstituteIds(partId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('inventory_part_substitutes')
    .select('substitute_part_id')
    .eq('part_id', partId);
  if (error) throw error;
  return (data ?? []).map((r: { substitute_part_id: string }) => r.substitute_part_id);
}

export async function fetchMarketLocations(): Promise<MarketLocation[]> {
  const { data, error } = await supabase
    .from('inventory_locations')
    .select('id, name, location_type, assigned_technician_id')
    .eq('active', true);
  if (error) throw error;
  return (data ?? []) as MarketLocation[];
}

/** Jobs whose required parts are short RIGHT NOW (from the existing readiness view). */
export async function fetchShortJobs(): Promise<ShortJobRow[]> {
  const { data, error } = await supabase
    .from('job_parts_readiness')
    .select(
      'requirement_id, job_id, customer_name, scheduled_datetime, assigned_technician_id, part_id, part_name, quantity_required, shortage_quantity',
    )
    .eq('readiness_status', 'short')
    .order('scheduled_datetime', { ascending: true, nullsFirst: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as ShortJobRow[];
}

/** Everything the engine needs for one part (+ substitutes) in three parallel round-trips. */
export async function gatherMarketInput(
  part: MarketPart,
  allParts: MarketPart[],
): Promise<MarketInput> {
  const substituteIds = await fetchSubstituteIds(part.id);
  const partIds = [part.id, ...substituteIds];
  const [availabilityRes, offers, priceHistory, locations] = await Promise.all([
    supabase.from('parts_availability').select('*').in('part_id', partIds),
    fetchLiveOffers(partIds),
    fetchPriceHistory(partIds),
    fetchMarketLocations(),
  ]);
  if (availabilityRes.error) throw availabilityRes.error;
  const wanted = new Set(partIds);
  return {
    requestedPart: part,
    parts: allParts.filter((p) => wanted.has(p.id)),
    substituteIds,
    availability: (availabilityRes.data ?? []) as PartsAvailabilityRow[],
    locations,
    offers,
    priceHistory,
  };
}

// ---------- decisions ----------

export async function recordDecision(params: {
  partId: string;
  jobId: string | null;
  decision: MarketDecision;
}): Promise<MarketDecisionRow | null> {
  const { decision } = params;
  if (!decision.recommended) return null;
  const user_id = await currentUserId();
  const { data, error } = await supabase
    .from('parts_market_decisions')
    .insert({
      user_id,
      part_id: params.partId,
      job_id: params.jobId,
      quantity: decision.quantity,
      recommended_action: decision.recommended.action,
      recommended_label: decision.recommended.label,
      expected_total_cost_cents: decision.recommended.expectedTotalCostCents,
      margin_erosion_cents: decision.recommended.marginErosionCents,
      confidence: decision.confidence,
      verdict: decision.buyVsBorrow.verdict,
      rationale: decision.rationale,
    })
    .select()
    .single();
  if (error) throw error;
  return data as MarketDecisionRow;
}

export async function resolveDecision(
  id: string,
  status: DecisionStatus,
  chosen?: Pick<MarketOption, 'action' | 'label'>,
): Promise<void> {
  const { error } = await supabase
    .from('parts_market_decisions')
    .update({
      status,
      chosen_action: chosen?.action ?? null,
      chosen_label: chosen?.label ?? null,
    })
    .eq('id', id);
  if (error) throw error;
}

export async function fetchRecentDecisions(limit = 15): Promise<MarketDecisionRow[]> {
  const { data, error } = await supabase
    .from('parts_market_decisions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as MarketDecisionRow[];
}

// ---------- executing a choice through the existing modules ----------

/**
 * Turns an accepted option into real work in the modules that already exist:
 *   transfer_stock      → atomic ledger transfer into the technician's van
 *   buy_vendor / buy_distributor → a purchase request (feeds RFQ / PO flow)
 *   use_van_stock / borrow_contractor → nothing to write (recorded as a decision)
 * Returns a short human message for the toast.
 */
export async function executeOption(params: {
  option: MarketOption;
  quantity: number;
  jobId: string | null;
  neededBy: string | Date | null;
  destinationLocationId: string | null;
}): Promise<string> {
  const { option, quantity, jobId, neededBy, destinationLocationId } = params;
  switch (option.action) {
    case 'transfer_stock': {
      if (!option.locationId || !destinationLocationId) {
        throw new Error('No destination van is assigned to this technician — transfer manually in Inventory.');
      }
      await transferInventoryStock({
        partId: option.partId,
        fromLocationId: option.locationId,
        toLocationId: destinationLocationId,
        quantity,
        note: 'Parts Market recommendation',
      });
      return `Transferred ${quantity}× ${option.partName} from ${option.label}`;
    }
    case 'buy_vendor':
    case 'buy_distributor': {
      const date = neededBy ? new Date(neededBy) : null;
      await createPurchaseRequest({
        part_id: option.partId,
        quantity_requested: quantity,
        reason: jobId ? 'job_shortage' : 'manual',
        job_id: jobId,
        needed_by: date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null,
        notes: `Parts Market: ${option.label} quoted ${formatCents(option.unitPriceCents)}/unit, ETA ${formatEta(option.etaMinutes)}`,
      });
      return `Purchase request created for ${option.label}`;
    }
    case 'borrow_contractor':
      return `Recorded — contact ${option.label}${option.phone ? ` at ${option.phone}` : ''} to arrange the handoff`;
    case 'use_van_stock':
    default:
      return 'Recorded — part is already on the technician’s van';
  }
}

// ---------- realtime ----------

/** Fires (debounced) whenever any offer or stock level changes. Returns an unsubscribe fn. */
export function subscribeToMarket(onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 400);
  };
  const channel = supabase
    .channel('parts-market-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'parts_market_offers' }, fire)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_stock_levels' }, fire)
    .subscribe();
  return () => {
    if (timer) clearTimeout(timer);
    void supabase.removeChannel(channel);
  };
}
