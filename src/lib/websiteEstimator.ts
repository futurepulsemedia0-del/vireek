/**
 * Instant price estimator widget — pure domain logic (no I/O, fully unit-tested).
 *
 * The estimate maths exists in THREE places that must stay identical:
 *   1. computeEstimate()                       — this file (dashboard + tests)
 *   2. estimate()                              — public/website-widgets.js (what the visitor sees)
 *   3. public.website_widget_estimate()        — supabase/migrations/20271210000000_website_widget_estimator.sql
 *      (what is written into the lead — the visitor's browser can never change it)
 * Parity vectors live in websiteEstimator.test.ts. This module imports nothing, so websiteWidgets.ts can depend on it.
 */

export type EstimatorModel = 'flat' | 'starting_at' | 'range' | 'hourly';
export type EstimatorContact = 'email' | 'phone' | 'either';
export type EstimateKind = 'exact' | 'range' | 'from';

/** Which price-book services are published, in display order, with an optional public name. */
export interface EstimatorItemRef {
  id: string;
  /** Public name shown to visitors. Empty = use the price-book service name. */
  label: string;
}

export interface EstimatorOptions {
  items: EstimatorItemRef[];
  contact_required: EstimatorContact;
  ask_zip: boolean;
  /** true = visitor must leave contact details BEFORE seeing the price. */
  gate_price: boolean;
  show_urgency: boolean;
  /** Surcharge (%) for emergency / same-day service. Only applied when show_urgency is on. */
  urgency_pct: number;
  /** Flat-rate and hourly prices are shown as a ±N% range (0 = exact price). */
  flat_spread_pct: number;
  /** Empty = default disclaimer. */
  disclaimer: string;
}

export const ESTIMATOR_LIMITS = {
  items: 30,
  itemLabel: 60,
  urgencyMin: 0,
  urgencyMax: 100,
  spreadMin: 0,
  spreadMax: 40,
  disclaimer: 240,
  qtyMax: 20,
  priceCap: 100_000_000,
} as const;

export const DEFAULT_DISCLAIMER = 'This is an estimate based on typical jobs. The final price is confirmed after we review the details.';

export const ESTIMATOR_LEAD_SOURCE = 'website_estimator_widget';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export function buildDefaultEstimatorOptions(): EstimatorOptions {
  return {
    items: [],
    contact_required: 'either',
    ask_zip: true,
    gate_price: false,
    show_urgency: false,
    urgency_pct: 25,
    flat_spread_pct: 0,
    disclaimer: '',
  };
}

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : fallback;
};

/** Coerces untrusted / partial jsonb into a complete, in-range options object. */
export function sanitizeEstimatorOptions(raw: unknown): EstimatorOptions {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const d = buildDefaultEstimatorOptions();
  const seen = new Set<string>();
  const items: EstimatorItemRef[] = [];
  if (Array.isArray(o.items)) {
    for (const entry of o.items) {
      if (items.length >= ESTIMATOR_LIMITS.items) break;
      const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      if (!isUuid(e.id)) continue;
      const id = e.id.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, label: typeof e.label === 'string' ? e.label.trim().slice(0, ESTIMATOR_LIMITS.itemLabel) : '' });
    }
  }
  return {
    items,
    contact_required: o.contact_required === 'email' || o.contact_required === 'phone' || o.contact_required === 'either' ? o.contact_required : d.contact_required,
    ask_zip: typeof o.ask_zip === 'boolean' ? o.ask_zip : d.ask_zip,
    gate_price: typeof o.gate_price === 'boolean' ? o.gate_price : d.gate_price,
    show_urgency: typeof o.show_urgency === 'boolean' ? o.show_urgency : d.show_urgency,
    urgency_pct: clampInt(o.urgency_pct, ESTIMATOR_LIMITS.urgencyMin, ESTIMATOR_LIMITS.urgencyMax, d.urgency_pct),
    flat_spread_pct: clampInt(o.flat_spread_pct, ESTIMATOR_LIMITS.spreadMin, ESTIMATOR_LIMITS.spreadMax, d.flat_spread_pct),
    disclaimer: typeof o.disclaimer === 'string' ? o.disclaimer.trim().slice(0, ESTIMATOR_LIMITS.disclaimer) : '',
  };
}

/* ------------------------------ validation ------------------------------ */

export type EstimatorErrorKey = 'items' | 'item_label' | 'urgency_pct' | 'flat_spread_pct' | 'disclaimer';
export type EstimatorErrors = Partial<Record<EstimatorErrorKey, string>>;

export function validateEstimatorOptions(o: EstimatorOptions): EstimatorErrors {
  const e: EstimatorErrors = {};
  if (o.items.length > ESTIMATOR_LIMITS.items) e.items = `Max ${ESTIMATOR_LIMITS.items} services.`;
  else if (o.items.some((i) => i.label.length > ESTIMATOR_LIMITS.itemLabel)) e.item_label = `Public names: max ${ESTIMATOR_LIMITS.itemLabel} characters.`;
  if (!Number.isInteger(o.urgency_pct) || o.urgency_pct < ESTIMATOR_LIMITS.urgencyMin || o.urgency_pct > ESTIMATOR_LIMITS.urgencyMax) {
    e.urgency_pct = `Between ${ESTIMATOR_LIMITS.urgencyMin} and ${ESTIMATOR_LIMITS.urgencyMax}.`;
  }
  if (!Number.isInteger(o.flat_spread_pct) || o.flat_spread_pct < ESTIMATOR_LIMITS.spreadMin || o.flat_spread_pct > ESTIMATOR_LIMITS.spreadMax) {
    e.flat_spread_pct = `Between ${ESTIMATOR_LIMITS.spreadMin} and ${ESTIMATOR_LIMITS.spreadMax}.`;
  }
  if (o.disclaimer.length > ESTIMATOR_LIMITS.disclaimer) e.disclaimer = `Max ${ESTIMATOR_LIMITS.disclaimer} characters.`;
  return e;
}

/* ------------------------------- estimate ------------------------------- */

export interface PricedItem {
  pricing_model: EstimatorModel;
  price_cents: number;
  price_max_cents: number | null;
  unit_label: string | null;
}

export interface EstimateRules {
  spread_pct: number;
  urgency_pct: number;
}

export interface Estimate {
  kind: EstimateKind;
  low_cents: number;
  /** null = open-ended ("from $X"). */
  high_cents: number | null;
}

/** Visitors may pick a quantity for hourly work (= hours) and for anything priced per unit. */
export const quantityAllowed = (item: Pick<PricedItem, 'pricing_model' | 'unit_label'>): boolean =>
  item.pricing_model === 'hourly' || (typeof item.unit_label === 'string' && item.unit_label.trim() !== '');

/** Integer round-half-up of a / d (a ≥ 0). Same as SQL `(a + d/2) / d` on bigint. */
const roundDiv = (a: number, d: number): number => Math.floor((a + d / 2) / d);

const toInt = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : lo;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Price shown to the visitor.
 *  - starting_at → "from" (open-ended)         - range → low–high
 *  - flat / hourly → exact, or ±spread% range  - urgency surcharge multiplies both ends
 * All integer cents, round-half-up, so SQL / JS / TS always agree to the cent.
 */
export function computeEstimate(item: PricedItem, quantity: number, urgent: boolean, rules: EstimateRules): Estimate {
  const cap = ESTIMATOR_LIMITS.priceCap;
  const price = toInt(item.price_cents, 0, cap);
  const priceMax = toInt(item.price_max_cents ?? item.price_cents, 0, cap);
  const qty = quantityAllowed(item) ? toInt(quantity, 1, ESTIMATOR_LIMITS.qtyMax) : 1;
  const spread = toInt(rules.spread_pct, ESTIMATOR_LIMITS.spreadMin, ESTIMATOR_LIMITS.spreadMax);
  const pct = urgent ? toInt(rules.urgency_pct, ESTIMATOR_LIMITS.urgencyMin, ESTIMATOR_LIMITS.urgencyMax) : 0;

  let low: number;
  let high: number | null;
  let kind: EstimateKind;
  if (item.pricing_model === 'starting_at') {
    low = price * qty;
    high = null;
    kind = 'from';
  } else if (item.pricing_model === 'range') {
    low = price * qty;
    high = Math.max(priceMax, price) * qty;
    kind = 'range';
  } else {
    low = roundDiv(price * qty * (100 - spread), 100);
    high = roundDiv(price * qty * (100 + spread), 100);
    kind = 'range';
  }
  if (pct > 0) {
    low = roundDiv(low * (100 + pct), 100);
    if (high !== null) high = roundDiv(high * (100 + pct), 100);
  }
  if (kind !== 'from') kind = high === low ? 'exact' : 'range';
  return { kind, low_cents: low, high_cents: high };
}

/** "$450", "$450 – $520", "From $90" — whole dollars shown without decimals. */
export function formatEstimate(e: Estimate): string {
  const money = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
  if (e.kind === 'from') return `From ${money(e.low_cents)}`;
  if (e.kind === 'range' && e.high_cents !== null) return `${money(e.low_cents)} – ${money(e.high_cents)}`;
  return money(e.low_cents);
}

/* ------------------------------ readiness ------------------------------- */

/** The slice of a price-book row the estimator needs (also what the picker lists). */
export interface CatalogItem {
  id: string;
  service_name: string;
  category: string | null;
  pricing_model: EstimatorModel;
  price_cents: number;
  price_max_cents: number | null;
  unit_label: string | null;
  description: string | null;
  active: boolean;
}

/** An item is public only if it still exists, is active and has a real price (mirrors the SQL payload filter). */
export const isPublishable = (c: CatalogItem | undefined): c is CatalogItem => !!c && c.active && c.price_cents > 0;

/** Why a saved+enabled estimator might still show nothing (or less than expected). Empty list = ready. `catalog === null` = not loaded. */
export function getEstimatorIssues(o: EstimatorOptions, catalog: CatalogItem[] | null): string[] {
  const issues: string[] = [];
  if (o.items.length === 0) {
    issues.push('No services selected. Pick at least one service from your price book — the widget stays hidden until you do.');
    return issues;
  }
  if (catalog) {
    const byId = new Map(catalog.map((c) => [c.id.toLowerCase(), c]));
    const hidden = o.items.filter((i) => !isPublishable(byId.get(i.id)));
    if (hidden.length === o.items.length) {
      issues.push('None of the selected services are active with a price in your price book — the widget stays hidden.');
    } else if (hidden.length > 0) {
      issues.push(`${hidden.length} selected service${hidden.length === 1 ? ' is' : 's are'} inactive, deleted or priced at $0 in your price book, so visitors will not see ${hidden.length === 1 ? 'it' : 'them'}.`);
    }
  }
  if (o.show_urgency && o.urgency_pct === 0) issues.push('The urgent-service surcharge is 0%, so the option is hidden from visitors.');
  return issues;
}
