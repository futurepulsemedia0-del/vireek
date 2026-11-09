// Parts sourcing — pure logic (no React, no network). All money is integer minor units (cents).
// Data access lives in partsSourcingApi.ts. Facts come from the parts_sourcing_offers RPC;
// pricing, margin, ranking and delivery-vs-appointment decisions are made here so they are unit-tested.

import { roundOrderQty } from './partsOrdering';

export type Cents = number;

export const MAX_CENTS = 1_000_000_000;

export function isCents(n: unknown): n is Cents {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_CENTS;
}

export function assertCents(n: unknown, label = 'amount'): Cents {
  if (!isCents(n)) throw new RangeError(`${label} must be a whole number of cents between 0 and ${MAX_CENTS}`);
  return n;
}

/** Parses "12.34" / "12" / "$1,234.5" into cents without floating-point maths. Returns null when invalid. */
export function parseMoneyToCents(raw: string | null | undefined): Cents | null {
  if (raw == null) return null;
  const cleaned = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return isCents(cents) ? cents : null;
}

// ---------------------------------------------------------------------------
// Margin rules
// ---------------------------------------------------------------------------

export type RuleScope = 'default' | 'category' | 'brand' | 'part';

export interface MarginRule {
  id: string;
  scope: RuleScope;
  scope_value: string | null;
  /** Markup over cost in basis points (2500 = +25%). */
  markup_bps: number;
  /** Minimum margin on the SELL price in basis points (3000 = 30% margin). */
  min_margin_bps: number;
  /** Round the sell price UP to a multiple of this many cents (1 = no rounding, 100 = whole currency unit). */
  round_to_cents: number;
  priority: number;
  active: boolean;
}

export interface RuleContext {
  partId?: string | null;
  category?: string | null;
  brand?: string | null;
}

const SCOPE_RANK: Record<RuleScope, number> = { part: 3, brand: 2, category: 1, default: 0 };

function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

/** Most specific active rule wins (part > brand > category > default); then higher priority; then lowest id. */
export function selectMarginRule(rules: MarginRule[], ctx: RuleContext): MarginRule | null {
  const matches = rules.filter((r) => {
    if (!r.active) return false;
    switch (r.scope) {
      case 'default':
        return true;
      case 'part':
        return !!ctx.partId && norm(r.scope_value) === norm(ctx.partId);
      case 'brand':
        return !!ctx.brand && norm(r.scope_value) === norm(ctx.brand);
      case 'category':
        return !!ctx.category && norm(r.scope_value) === norm(ctx.category);
      default:
        return false;
    }
  });
  if (matches.length === 0) return null;
  return [...matches].sort(
    (a, b) => SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope] || b.priority - a.priority || a.id.localeCompare(b.id),
  )[0];
}

export interface PriceResult {
  costCents: Cents;
  sellCents: Cents;
  marginCents: number;
  /** Margin on the sell price, basis points, rounded half up. 0 when sell is 0. */
  marginBps: number;
  ruleId: string | null;
  /** True when the minimum-margin floor raised the price above the plain markup. */
  floorApplied: boolean;
}

function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

export function marginBpsOf(costCents: Cents, sellCents: Cents): number {
  if (sellCents <= 0) return 0;
  return Math.floor(((sellCents - costCents) * 10000 * 2 + sellCents) / (2 * sellCents));
}

/**
 * Sell price from cost with integer maths only:
 *   markup price  = round_half_up(cost * (10000 + markup_bps) / 10000)
 *   margin floor  = ceil(cost * 10000 / (10000 - min_margin_bps))
 *   sell          = ceil_to_multiple(max(markup price, floor), round_to_cents)
 * With no rule the sell price equals cost (0% margin) and ruleId is null.
 */
export function computeSellPrice(costCents: Cents, rule: MarginRule | null): PriceResult {
  assertCents(costCents, 'cost');
  if (!rule) {
    return { costCents, sellCents: costCents, marginCents: 0, marginBps: 0, ruleId: null, floorApplied: false };
  }
  if (!Number.isInteger(rule.markup_bps) || rule.markup_bps < 0 || rule.markup_bps > 100000) {
    throw new RangeError('markup_bps out of range');
  }
  if (!Number.isInteger(rule.min_margin_bps) || rule.min_margin_bps < 0 || rule.min_margin_bps > 9500) {
    throw new RangeError('min_margin_bps out of range');
  }
  const step = Number.isInteger(rule.round_to_cents) && rule.round_to_cents >= 1 ? rule.round_to_cents : 1;

  const markupPrice = Math.floor((costCents * (10000 + rule.markup_bps) + 5000) / 10000);
  const floorPrice = ceilDiv(costCents * 10000, 10000 - rule.min_margin_bps);
  const base = Math.max(markupPrice, floorPrice);
  const sellCents = ceilDiv(base, step) * step;
  return {
    costCents,
    sellCents,
    marginCents: sellCents - costCents,
    marginBps: marginBpsOf(costCents, sellCents),
    ruleId: rule.id,
    floorApplied: floorPrice > markupPrice,
  };
}

// ---------------------------------------------------------------------------
// Dates (UTC calendar days; matches the DB, which stores ETAs as `date`)
// ---------------------------------------------------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function utcDay(input: string | Date): string {
  if (input instanceof Date) return input.toISOString().slice(0, 10);
  if (ISO_DAY.test(input)) return input;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new RangeError('Invalid date');
  return d.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${utcDay(day)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diffDays(later: string, earlier: string): number {
  const a = Date.parse(`${utcDay(later)}T00:00:00Z`);
  const b = Date.parse(`${utcDay(earlier)}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Delivery vs appointment
// ---------------------------------------------------------------------------

export type EtaStatus = 'ready' | 'ok' | 'tight' | 'conflict' | 'no_eta' | 'no_appointment';

export interface EtaCheck {
  status: EtaStatus;
  /** Positive = parts arrive after the appointment day (after the buffer). */
  daysLate: number;
}

/**
 * ready          every part is on hand (truck/branch) and nothing is still on order
 * ok             ETA + buffer lands before the appointment day
 * tight          ETA + buffer lands ON the appointment day
 * conflict       ETA + buffer lands after the appointment day
 * no_eta         parts are missing and no open order has an ETA (not ordered / no date)
 * no_appointment the job has no schedule to compare against
 */
export function etaConflict(input: {
  eta: string | null;
  scheduled: string | null;
  bufferDays?: number;
  partsReady: boolean;
}): EtaCheck {
  if (input.partsReady) return { status: 'ready', daysLate: 0 };
  if (!input.scheduled) return { status: 'no_appointment', daysLate: 0 };
  if (!input.eta) return { status: 'no_eta', daysLate: 0 };
  const buffer = Math.max(0, Math.min(30, Math.trunc(input.bufferDays ?? 0)));
  const late = diffDays(addDays(utcDay(input.eta), buffer), utcDay(input.scheduled));
  if (late > 0) return { status: 'conflict', daysLate: late };
  if (late === 0) return { status: 'tight', daysLate: 0 };
  return { status: 'ok', daysLate: late };
}

export function isEtaWarning(status: EtaStatus): boolean {
  return status === 'conflict' || status === 'tight' || status === 'no_eta';
}

// ---------------------------------------------------------------------------
// Source ranking: truck vs branch vs supplier
// ---------------------------------------------------------------------------

export type StockStatus = 'in_stock' | 'low_stock' | 'backorder' | 'discontinued' | 'unknown';

export interface SupplierOffer {
  catalog_item_id: string;
  vendor_id: string;
  vendor_name: string;
  sku: string;
  name: string;
  brand: string | null;
  category: string | null;
  mpn: string | null;
  unit_cost_cents: Cents;
  list_price_cents: Cents | null;
  min_order_qty: number;
  pack_size: number;
  lead_time_days: number | null;
  stock_status: StockStatus;
  part_id: string | null;
  relation: 'exact' | 'equivalent' | 'alternate' | 'superseded_by' | string;
}

export interface SourcingSettings {
  truck_first: boolean;
  eta_buffer_days: number;
  approval_threshold_cents: Cents | null;
}

export type SourceKind = 'truck' | 'branch' | 'supplier';

export interface SourceOption {
  key: string;
  kind: SourceKind;
  label: string;
  /** Units that would be fulfilled from this source (for suppliers: the pack/MOQ-rounded order quantity). */
  quantity: number;
  covers: boolean;
  unitCostCents: Cents;
  totalCostCents: Cents;
  etaDay: string | null;
  leadDays: number | null;
  meetsAppointment: boolean | null;
  stockStatus: StockStatus | null;
  relation: string | null;
  sellUnitCents: Cents | null;
  marginBps: number | null;
  catalogItemId: string | null;
  vendorId: string | null;
  tier: number;
}

export interface RankInput {
  qty: number;
  today: string | Date;
  /** Appointment (ISO) of the job; null when sourcing without a job. */
  scheduled: string | null;
  stock: { truck: number; branch: number };
  internalUnitCostCents: Cents;
  offers: SupplierOffer[];
  settings: SourcingSettings;
  rules: MarginRule[];
  partId?: string | null;
  partCategory?: string | null;
}

export function rankSources(input: RankInput): SourceOption[] {
  const qty = Math.max(1, Math.trunc(input.qty));
  const today = utcDay(input.today);
  const buffer = Math.max(0, Math.min(30, Math.trunc(input.settings.eta_buffer_days || 0)));
  const apptDay = input.scheduled ? utcDay(input.scheduled) : null;

  const meets = (eta: string | null): boolean | null => {
    if (!apptDay) return null;
    if (!eta) return false;
    return diffDays(addDays(eta, buffer), apptDay) <= 0;
  };

  const out: SourceOption[] = [];

  const internal = (kind: 'truck' | 'branch', available: number): void => {
    if (available <= 0) return;
    const covers = available >= qty;
    const q = Math.min(available, qty);
    const m = meets(today);
    const tierBase = kind === 'truck' ? 0 : 1;
    out.push({
      key: kind,
      kind,
      label: kind === 'truck' ? 'Truck stock' : 'Branch stock',
      quantity: q,
      covers,
      unitCostCents: input.internalUnitCostCents,
      totalCostCents: input.internalUnitCostCents * q,
      etaDay: today,
      leadDays: 0,
      meetsAppointment: m,
      stockStatus: null,
      relation: 'exact',
      sellUnitCents: null,
      marginBps: null,
      catalogItemId: null,
      vendorId: null,
      tier: !covers ? 4 : input.settings.truck_first ? tierBase : 2,
    });
  };
  internal('truck', input.stock.truck);
  internal('branch', input.stock.branch);

  for (const o of input.offers) {
    if (o.stock_status === 'discontinued') continue;
    const orderQty = roundOrderQty(qty, o.min_order_qty, o.pack_size);
    const blocked = o.stock_status === 'backorder';
    const lead = o.lead_time_days;
    const etaDay = blocked || lead == null ? null : addDays(today, lead);
    const covers = !blocked;
    const m = meets(etaDay);
    const rule = selectMarginRule(input.rules, { partId: o.part_id ?? input.partId, category: o.category ?? input.partCategory, brand: o.brand });
    const price = rule ? computeSellPrice(o.unit_cost_cents, rule) : null;
    out.push({
      key: `supplier:${o.catalog_item_id}`,
      kind: 'supplier',
      label: o.vendor_name,
      quantity: orderQty,
      covers,
      unitCostCents: o.unit_cost_cents,
      totalCostCents: o.unit_cost_cents * orderQty,
      etaDay,
      leadDays: lead,
      meetsAppointment: m,
      stockStatus: o.stock_status,
      relation: o.relation,
      sellUnitCents: price ? price.sellCents : null,
      marginBps: price ? price.marginBps : null,
      catalogItemId: o.catalog_item_id,
      vendorId: o.vendor_id,
      tier: !covers ? 4 : m === false ? 3 : 2,
    });
  }

  return out.sort(
    (a, b) =>
      a.tier - b.tier ||
      (a.etaDay ?? '9999-12-31').localeCompare(b.etaDay ?? '9999-12-31') ||
      a.totalCostCents - b.totalCostCents ||
      a.key.localeCompare(b.key),
  );
}

export function sourcingHeadline(options: SourceOption[], hasAppointment: boolean): { best: SourceOption | null; warning: string | null } {
  const best = options.find((o) => o.covers) ?? null;
  if (!best) return { best: null, warning: 'No source can cover this quantity right now.' };
  if (hasAppointment && best.meetsAppointment === false) {
    return { best, warning: 'No source arrives before the appointment — reschedule the job or expedite.' };
  }
  return { best, warning: null };
}

// ---------------------------------------------------------------------------
// Approvals, idempotency keys, spend
// ---------------------------------------------------------------------------

/** Mirrors the DB rule used by create_parts_orders_from_cart: strictly greater than the threshold needs approval. */
export function needsApproval(totalCents: Cents, thresholdCents: Cents | null): boolean {
  return thresholdCents != null && totalCents > thresholdCents;
}

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,80}$/;

export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_RE.test(key);
}

export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `po_${c.randomUUID().replace(/-/g, '')}`;
  throw new Error('Secure random generator is not available in this environment');
}

export interface VendorSpendRow {
  vendor_id: string | null;
  vendor_name: string;
  po_count: number;
  committed_cents: number;
  received_cents: number;
  received_pos: number;
  on_time_pos: number;
}

export interface VendorSpendView extends VendorSpendRow {
  openCents: number;
  shareBps: number;
  onTimeBps: number | null;
}

export function viewVendorSpend(rows: VendorSpendRow[]): VendorSpendView[] {
  const total = rows.reduce((s, r) => s + r.committed_cents, 0);
  return rows.map((r) => ({
    ...r,
    openCents: Math.max(0, r.committed_cents - r.received_cents),
    shareBps: total > 0 ? Math.floor((r.committed_cents * 10000) / total) : 0,
    onTimeBps: r.received_pos > 0 ? Math.floor((r.on_time_pos * 10000) / r.received_pos) : null,
  }));
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
}

/** "25" -> 2500, "12.5" -> 1250, "0.05" -> 5. Null when not a clean non-negative percentage with ≤2 decimals. */
export function parsePercentToBps(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const m = /^(\d{1,4})(?:\.(\d{1,2}))?%?$/.exec(raw.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}

/** Spreadsheet-safe CSV cell: quotes when needed and defuses formula injection (= + - @ at the start). */
export function csvCell(value: string | number | null | undefined): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function centsToDecimal(cents: Cents): string {
  const c = assertCents(cents);
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}
