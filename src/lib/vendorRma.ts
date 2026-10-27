/**
 * Vendor Returns (RMA) — domain types and pure logic.
 *
 * Everything that computes credit, stock impact, allowed actions, validation or
 * summaries lives here as a PURE function (no I/O, `now` injectable) so it is fully
 * unit-tested in vendorRma.test.ts. The SQL functions in
 * 20271210000000_vendor_returns_rma.sql enforce the same rules authoritatively;
 * this module mirrors them so the UI can explain problems before a round trip.
 *
 * Money is always integer cents.
 */

import type { CsvColumn } from './csvExport';

// ============================================================
// TYPES
// ============================================================

export const RMA_STATUSES = [
  'draft', 'authorized', 'shipped', 'received_by_vendor', 'resolved', 'closed', 'rejected', 'cancelled',
] as const;
export type RmaStatus = (typeof RMA_STATUSES)[number];

export const RMA_SHIP_STATUSES = ['not_shipped', 'shipped', 'in_transit', 'delivered', 'exception'] as const;
export type RmaShipStatus = (typeof RMA_SHIP_STATUSES)[number];

export const RMA_REASONS = [
  'defective', 'dead_on_arrival', 'damaged_in_transit', 'wrong_item', 'over_shipped', 'warranty_failure', 'not_needed', 'other',
] as const;
export type RmaReason = (typeof RMA_REASONS)[number];

export const RMA_RESOLUTIONS = ['credit', 'refund', 'replacement'] as const;
export type RmaResolution = (typeof RMA_RESOLUTIONS)[number];

export type RmaLineSource = 'stock' | 'installed';
export const CREDIT_KINDS = ['credit_memo', 'refund', 'other'] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];

export interface RmaLine {
  id: string;
  rma_id: string;
  line_no: number;
  part_id: string;
  source: RmaLineSource;
  location_id: string | null;
  quantity: number;
  unit_credit_cents: number;
  unit_cost_cents: number;
  purchase_order_line_id: string | null;
  usage_transaction_id: string | null;
  job_id: string | null;
  serial_number: string | null;
  note: string | null;
  ship_transaction_id: string | null;
  inbound_transaction_id: string | null;
  quantity_replaced: number;
  part?: { name: string; part_number: string | null } | null;
  location?: { name: string } | null;
}

export interface Rma {
  id: string;
  rma_number: string;
  vendor_rma_number: string | null;
  vendor_id: string;
  purchase_order_id: string | null;
  status: RmaStatus;
  reason_code: RmaReason;
  reason_notes: string | null;
  resolution: RmaResolution;
  ship_status: RmaShipStatus;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  restocking_fee_cents: number;
  return_freight_cents: number;
  credit_expected_cents: number;
  credit_received_cents: number;
  authorized_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  vendor?: { name: string } | null;
  purchase_order?: { po_number: string } | null;
  lines: RmaLine[];
}

export interface RmaCredit {
  id: string;
  rma_id: string;
  amount_cents: number;
  kind: CreditKind;
  reference: string | null;
  received_on: string;
  note: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
}

export interface RmaEvent {
  id: string;
  rma_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  message: string | null;
  amount_cents: number | null;
  created_at: string;
}

export interface StockLevel {
  part_id: string;
  location_id: string;
  quantity_on_hand: number;
  quantity_reserved: number;
}

/** One row of list_vendor_returnable_lines(). */
export interface ReturnablePoLine {
  po_line_id: string;
  po_id: string;
  po_number: string;
  part_id: string;
  part_name: string;
  part_number: string | null;
  quantity_received: number;
  quantity_committed: number;
  unit_cost_cents: number;
  received_at: string;
}

/** One row of list_vendor_returnable_usage(). */
export interface ReturnableUsage {
  usage_transaction_id: string;
  part_id: string;
  part_name: string;
  part_number: string | null;
  job_id: string | null;
  job_label: string | null;
  quantity_used: number;
  quantity_committed: number;
  unit_cost_cents: number;
  used_at: string;
}

// ============================================================
// LABELS & PRESENTATION
// ============================================================

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

export const STATUS_LABELS: Record<RmaStatus, string> = {
  draft: 'Draft',
  authorized: 'Authorized',
  shipped: 'Shipped',
  received_by_vendor: 'Received by vendor',
  resolved: 'Resolved',
  closed: 'Closed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export const STATUS_TONES: Record<RmaStatus, Tone> = {
  draft: 'neutral',
  authorized: 'info',
  shipped: 'info',
  received_by_vendor: 'warning',
  resolved: 'success',
  closed: 'neutral',
  rejected: 'danger',
  cancelled: 'neutral',
};

export const SHIP_STATUS_LABELS: Record<RmaShipStatus, string> = {
  not_shipped: 'Not shipped',
  shipped: 'Shipped',
  in_transit: 'In transit',
  delivered: 'Delivered',
  exception: 'Delivery problem',
};

export const REASON_LABELS: Record<RmaReason, string> = {
  defective: 'Defective',
  dead_on_arrival: 'Dead on arrival',
  damaged_in_transit: 'Damaged in transit',
  wrong_item: 'Wrong item sent',
  over_shipped: 'Over-shipped',
  warranty_failure: 'Warranty failure',
  not_needed: 'Not needed (restock return)',
  other: 'Other',
};

export const RESOLUTION_LABELS: Record<RmaResolution, string> = {
  credit: 'Credit memo',
  refund: 'Refund',
  replacement: 'Replacement',
};

export const CREDIT_KIND_LABELS: Record<CreditKind, string> = {
  credit_memo: 'Credit memo',
  refund: 'Refund',
  other: 'Other',
};

export function humanize(value: string): string {
  const s = value.replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ============================================================
// MONEY
// ============================================================

/** "12", "12.5", "$1,234.50" -> cents. Returns null for anything that is not a non-negative amount with at most 2 decimals. */
export function parseMoneyToCents(raw: string): number | null {
  const s = raw.trim().replace(/^[$€£]/, '').replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function centsToInput(cents: number): string {
  const safe = Math.max(0, Math.trunc(cents));
  return (safe / 100).toFixed(2);
}

const wholeNonNegative = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);

// ============================================================
// CREDIT MATH
// ============================================================

export function lineCreditCents(line: { quantity: number; unit_credit_cents: number }): number {
  return wholeNonNegative(line.quantity) * wholeNonNegative(line.unit_credit_cents);
}

export function grossCreditCents(lines: ReadonlyArray<{ quantity: number; unit_credit_cents: number }>): number {
  return lines.reduce((sum, l) => sum + lineCreditCents(l), 0);
}

/**
 * Credit the vendor owes: sum(quantity x credit per unit) minus the restocking fee, never below zero.
 * A replacement return expects goods, not money, so its expected credit is 0.
 */
export function expectedCreditCents(
  lines: ReadonlyArray<{ quantity: number; unit_credit_cents: number }>,
  restockingFeeCents: number,
  resolution: RmaResolution,
): number {
  if (resolution === 'replacement') return 0;
  return Math.max(0, grossCreditCents(lines) - wholeNonNegative(restockingFeeCents));
}

/** Sum of credits that are not voided. */
export function receivedCreditCents(credits: ReadonlyArray<Pick<RmaCredit, 'amount_cents' | 'voided_at'>>): number {
  return credits.reduce((sum, c) => (c.voided_at ? sum : sum + wholeNonNegative(c.amount_cents)), 0);
}

export type CreditState = 'not_applicable' | 'none' | 'partial' | 'full' | 'over';

export interface CreditSummary {
  expected: number;
  received: number;
  outstanding: number;
  overpaid: number;
  percent: number | null;
  state: CreditState;
}

export function summarizeCredit(expected: number, received: number, resolution: RmaResolution): CreditSummary {
  const exp = wholeNonNegative(expected);
  const rec = wholeNonNegative(received);
  if (resolution === 'replacement') {
    return { expected: 0, received: rec, outstanding: 0, overpaid: 0, percent: null, state: 'not_applicable' };
  }
  if (exp === 0) {
    return { expected: 0, received: rec, outstanding: 0, overpaid: rec, percent: null, state: rec > 0 ? 'over' : 'not_applicable' };
  }
  const outstanding = Math.max(0, exp - rec);
  const overpaid = Math.max(0, rec - exp);
  const percent = Math.min(100, Math.round((rec / exp) * 100));
  const state: CreditState = rec === 0 ? 'none' : rec < exp ? 'partial' : rec === exp ? 'full' : 'over';
  return { expected: exp, received: rec, outstanding, overpaid, percent, state };
}

/** What the return really recovered: credit received minus the freight we paid to send it back. */
export function netRecoveryCents(receivedCents: number, returnFreightCents: number): number {
  return wholeNonNegative(receivedCents) - wholeNonNegative(returnFreightCents);
}

/** Cost value (at purchase/average cost) of everything on the return. */
export function returnCostValueCents(lines: ReadonlyArray<{ quantity: number; unit_cost_cents: number }>): number {
  return lines.reduce((sum, l) => sum + wholeNonNegative(l.quantity) * wholeNonNegative(l.unit_cost_cents), 0);
}

// ============================================================
// RETURNABLE QUANTITY
// ============================================================

/** Units of a PO line / usage row that can still be put on a return. */
export function remainingReturnable(total: number, committed: number): number {
  return Math.max(0, wholeNonNegative(total) - wholeNonNegative(committed));
}

// ============================================================
// STOCK MATH
// ============================================================

export const stockKey = (partId: string, locationId: string): string => `${partId}|${locationId}`;

/** Stock that can actually be shipped out: on hand minus what is reserved for jobs (never negative). */
export function availableQty(onHand: number, reserved: number): number {
  return Math.max(0, Math.trunc(onHand) - Math.trunc(reserved));
}

type StockLine = Pick<RmaLine, 'part_id' | 'location_id' | 'quantity' | 'source'>;

export interface StockRequirement {
  part_id: string;
  location_id: string;
  needed: number;
}

/** Units that must come out of stock to ship the return, grouped per part + location. */
export function requiredStock(lines: ReadonlyArray<StockLine>): StockRequirement[] {
  const map = new Map<string, StockRequirement>();
  for (const l of lines) {
    if (l.source !== 'stock' || !l.location_id) continue;
    const k = stockKey(l.part_id, l.location_id);
    const cur = map.get(k);
    if (cur) cur.needed += wholeNonNegative(l.quantity);
    else map.set(k, { part_id: l.part_id, location_id: l.location_id, needed: wholeNonNegative(l.quantity) });
  }
  return [...map.values()].sort((a, b) => stockKey(a.part_id, a.location_id).localeCompare(stockKey(b.part_id, b.location_id)));
}

export interface StockShortage extends StockRequirement {
  available: number;
}

/** Same check the database runs before shipping: needed > available is a shortage. */
export function findStockShortages(lines: ReadonlyArray<StockLine>, levels: ReadonlyArray<StockLevel>): StockShortage[] {
  const byKey = new Map(levels.map((s) => [stockKey(s.part_id, s.location_id), s]));
  const out: StockShortage[] = [];
  for (const req of requiredStock(lines)) {
    const s = byKey.get(stockKey(req.part_id, req.location_id));
    const available = s ? availableQty(s.quantity_on_hand, s.quantity_reserved) : 0;
    if (available < req.needed) out.push({ ...req, available });
  }
  return out;
}

export type StockMovement = 'ship' | 'restock_on_reject' | 'receive_replacement';

export interface StockDelta {
  part_id: string;
  location_id: string;
  delta: number;
}

type DeltaLine = Pick<
  RmaLine,
  'part_id' | 'location_id' | 'quantity' | 'source' | 'ship_transaction_id' | 'inbound_transaction_id' | 'quantity_replaced'
>;

/**
 * The ledger movement each action posts, grouped per part + location (zero rows dropped):
 *  - ship: stock lines go out (negative). Installed parts never touch stock.
 *  - restock_on_reject: stock lines that already shipped come back (positive).
 *  - receive_replacement: the still-open replacement quantity goes in (positive).
 */
export function stockDeltas(lines: ReadonlyArray<DeltaLine>, movement: StockMovement): StockDelta[] {
  const map = new Map<string, StockDelta>();
  const add = (l: DeltaLine, delta: number) => {
    if (!l.location_id || delta === 0) return;
    const k = stockKey(l.part_id, l.location_id);
    const cur = map.get(k);
    if (cur) cur.delta += delta;
    else map.set(k, { part_id: l.part_id, location_id: l.location_id, delta });
  };
  for (const l of lines) {
    const qty = wholeNonNegative(l.quantity);
    if (movement === 'ship') {
      if (l.source === 'stock' && !l.ship_transaction_id) add(l, -qty);
    } else if (movement === 'restock_on_reject') {
      if (l.source === 'stock' && l.ship_transaction_id && !l.inbound_transaction_id) add(l, qty);
    } else {
      add(l, Math.max(0, qty - wholeNonNegative(l.quantity_replaced)));
    }
  }
  return [...map.values()]
    .filter((d) => d.delta !== 0)
    .sort((a, b) => stockKey(a.part_id, a.location_id).localeCompare(stockKey(b.part_id, b.location_id)));
}

/** Applies deltas to stock levels without mutating the input. Missing rows start at zero. */
export function applyStockDeltas(levels: ReadonlyArray<StockLevel>, deltas: ReadonlyArray<StockDelta>): StockLevel[] {
  const map = new Map(levels.map((s) => [stockKey(s.part_id, s.location_id), { ...s }]));
  for (const d of deltas) {
    const k = stockKey(d.part_id, d.location_id);
    const cur = map.get(k);
    if (cur) cur.quantity_on_hand += d.delta;
    else map.set(k, { part_id: d.part_id, location_id: d.location_id, quantity_on_hand: d.delta, quantity_reserved: 0 });
  }
  return [...map.values()];
}

/** Replacement units still owed by the vendor. */
export function openReplacementUnits(lines: ReadonlyArray<Pick<RmaLine, 'quantity' | 'quantity_replaced'>>): number {
  return lines.reduce((sum, l) => sum + Math.max(0, wholeNonNegative(l.quantity) - wholeNonNegative(l.quantity_replaced)), 0);
}

export function totalUnits(lines: ReadonlyArray<Pick<RmaLine, 'quantity'>>): number {
  return lines.reduce((sum, l) => sum + wholeNonNegative(l.quantity), 0);
}

// ============================================================
// WORKFLOW (mirrors the SQL state machine)
// ============================================================

export type RmaAction =
  | 'edit'
  | 'authorize'
  | 'ship'
  | 'update_shipment'
  | 'record_credit'
  | 'void_credit'
  | 'receive_replacement'
  | 'reject'
  | 'cancel'
  | 'close';

type ActionInput = Pick<Rma, 'status' | 'resolution' | 'credit_received_cents' | 'lines'>;

export function allowedActions(rma: ActionInput): RmaAction[] {
  const s = rma.status;
  const out: RmaAction[] = [];
  if (s === 'draft' || s === 'authorized') out.push('edit', 'ship', 'cancel');
  if (s === 'draft') out.push('authorize');
  if (s === 'shipped' || s === 'received_by_vendor') out.push('update_shipment');
  if (s === 'shipped' || s === 'received_by_vendor' || s === 'resolved') out.push('record_credit');
  if ((s === 'shipped' || s === 'received_by_vendor' || s === 'resolved') && rma.credit_received_cents > 0) out.push('void_credit');
  if (rma.resolution === 'replacement' && (s === 'shipped' || s === 'received_by_vendor') && openReplacementUnits(rma.lines) > 0) {
    out.push('receive_replacement');
  }
  const replaced = rma.lines.some((l) => l.quantity_replaced > 0);
  if ((s === 'draft' || s === 'authorized' || s === 'shipped' || s === 'received_by_vendor') && rma.credit_received_cents === 0 && !replaced) {
    out.push('reject');
  }
  if (s === 'resolved' || s === 'rejected' || s === 'received_by_vendor') out.push('close');
  return out;
}

/** Closing a return the vendor has not fully resolved must be an explicit decision. */
export function closeNeedsShortfallAccept(status: RmaStatus): boolean {
  return status === 'received_by_vendor';
}

export const isTerminal = (status: RmaStatus): boolean => status === 'closed' || status === 'cancelled';

export function isActive(status: RmaStatus): boolean {
  return status === 'draft' || status === 'authorized' || status === 'shipped' || status === 'received_by_vendor';
}

// ============================================================
// AGING & SUMMARY
// ============================================================

const DAY_MS = 86_400_000;

export function daysBetween(fromIso: string, now: Date): number | null {
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/** Days the vendor has had the goods (since delivery, else since shipping). */
export function creditAgeDays(rma: Pick<Rma, 'delivered_at' | 'shipped_at'>, now: Date): number | null {
  const ref = rma.delivered_at ?? rma.shipped_at;
  return ref ? daysBetween(ref, now) : null;
}

export function awaitingCredit(rma: Pick<Rma, 'status' | 'resolution' | 'credit_expected_cents' | 'credit_received_cents'>): boolean {
  return (
    (rma.status === 'shipped' || rma.status === 'received_by_vendor') &&
    rma.resolution !== 'replacement' &&
    rma.credit_expected_cents > rma.credit_received_cents
  );
}

export interface RmaSummary {
  active: number;
  drafts: number;
  inTransit: number;
  awaitingCredit: number;
  outstandingCents: number;
  receivedCents: number;
  overdue: number;
}

export function summarizeRmas(rmas: ReadonlyArray<Rma>, now: Date = new Date(), overdueDays = 30): RmaSummary {
  const out: RmaSummary = { active: 0, drafts: 0, inTransit: 0, awaitingCredit: 0, outstandingCents: 0, receivedCents: 0, overdue: 0 };
  for (const r of rmas) {
    if (r.status === 'cancelled') continue;
    out.receivedCents += r.credit_received_cents;
    if (isActive(r.status)) out.active += 1;
    if (r.status === 'draft') out.drafts += 1;
    if (r.status === 'shipped') out.inTransit += 1;
    if (awaitingCredit(r)) {
      out.awaitingCredit += 1;
      out.outstandingCents += r.credit_expected_cents - r.credit_received_cents;
      const age = creditAgeDays(r, now);
      if (age != null && age > overdueDays) out.overdue += 1;
    }
  }
  return out;
}

export type RmaStatusFilter = 'all' | 'active' | RmaStatus;

export interface RmaFilters {
  status: RmaStatusFilter;
  vendorId: string;
  query: string;
}

export function filterRmas(rmas: ReadonlyArray<Rma>, f: RmaFilters): Rma[] {
  const q = f.query.trim().toLowerCase();
  return rmas.filter((r) => {
    if (f.status === 'active' ? !isActive(r.status) : f.status !== 'all' && r.status !== f.status) return false;
    if (f.vendorId && r.vendor_id !== f.vendorId) return false;
    if (!q) return true;
    const haystack = [
      r.rma_number, r.vendor_rma_number, r.vendor?.name, r.tracking_number, r.purchase_order?.po_number,
      ...r.lines.flatMap((l) => [l.part?.name, l.part?.part_number, l.serial_number]),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

export const RMA_CSV_COLUMNS: CsvColumn<Rma>[] = [
  { header: 'RMA', accessor: (r) => r.rma_number },
  { header: 'Vendor RMA', accessor: (r) => r.vendor_rma_number },
  { header: 'Vendor', accessor: (r) => r.vendor?.name },
  { header: 'Status', accessor: (r) => STATUS_LABELS[r.status] },
  { header: 'Ship status', accessor: (r) => SHIP_STATUS_LABELS[r.ship_status] },
  { header: 'Reason', accessor: (r) => REASON_LABELS[r.reason_code] },
  { header: 'Resolution', accessor: (r) => RESOLUTION_LABELS[r.resolution] },
  { header: 'Units', accessor: (r) => totalUnits(r.lines) },
  { header: 'Credit expected', accessor: (r) => (r.credit_expected_cents / 100).toFixed(2) },
  { header: 'Credit received', accessor: (r) => (r.credit_received_cents / 100).toFixed(2) },
  { header: 'Return freight', accessor: (r) => (r.return_freight_cents / 100).toFixed(2) },
  { header: 'Tracking', accessor: (r) => r.tracking_number },
  { header: 'Created', accessor: (r) => r.created_at.slice(0, 10) },
];

// ============================================================
// FORM -> RPC PAYLOAD
// ============================================================

export interface RmaLineForm {
  key: string;
  part_id: string;
  source: RmaLineSource;
  location_id: string;
  quantity: string;
  /** Credit per unit as typed ("12.50"). Empty = let the server default to the unit cost. */
  unit_credit: string;
  /** Unit cost known when the line was picked; only used to preview the expected credit. */
  cost_hint_cents: number;
  purchase_order_line_id: string;
  usage_transaction_id: string;
  job_id: string;
  serial_number: string;
  note: string;
  /** Most units this line may carry (remaining on its PO line / usage). null = no client-side cap. */
  max_quantity: number | null;
}

export interface RmaFormValues {
  vendor_id: string;
  purchase_order_id: string;
  reason_code: string;
  reason_notes: string;
  resolution: string;
  restocking_fee: string;
  vendor_rma_number: string;
  lines: RmaLineForm[];
}

export interface SaveRmaLinePayload {
  part_id: string;
  source: RmaLineSource;
  location_id: string | null;
  quantity: number;
  unit_credit_cents: number | null;
  purchase_order_line_id: string | null;
  usage_transaction_id: string | null;
  job_id: string | null;
  serial_number: string | null;
  note: string | null;
}

export interface SaveRmaPayload {
  vendor_id: string;
  purchase_order_id: string | null;
  reason_code: RmaReason;
  reason_notes: string | null;
  resolution: RmaResolution;
  restocking_fee_cents: number;
  vendor_rma_number: string | null;
  lines: SaveRmaLinePayload[];
}

export type FieldErrors = Record<string, string>;
export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

export const EMPTY_LINE = (key: string): RmaLineForm => ({
  key,
  part_id: '',
  source: 'stock',
  location_id: '',
  quantity: '1',
  unit_credit: '',
  cost_hint_cents: 0,
  purchase_order_line_id: '',
  usage_transaction_id: '',
  job_id: '',
  serial_number: '',
  note: '',
  max_quantity: null,
});

export const EMPTY_RMA_FORM: RmaFormValues = {
  vendor_id: '',
  purchase_order_id: '',
  reason_code: 'defective',
  reason_notes: '',
  resolution: 'credit',
  restocking_fee: '',
  vendor_rma_number: '',
  lines: [],
};

const MAX_LINES = 100;
const MAX_QTY = 100_000;
const MAX_UNIT_CREDIT_CENTS = 10_000_000;
const MAX_FEE_CENTS = 100_000_000;

const oneOf = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);
const orNull = (s: string): string | null => (s.trim() === '' ? null : s.trim());

export const lineErrorKey = (index: number, field: string): string => `line.${index}.${field}`;

export function parseRmaForm(form: RmaFormValues): ParseResult<SaveRmaPayload> {
  const errors: FieldErrors = {};

  if (!form.vendor_id) errors.vendor_id = 'Choose a vendor.';
  if (!oneOf(RMA_REASONS, form.reason_code)) errors.reason_code = 'Choose a reason.';
  if (!oneOf(RMA_RESOLUTIONS, form.resolution)) errors.resolution = 'Choose what you expect from the vendor.';

  let fee = 0;
  if (form.restocking_fee.trim() !== '') {
    const parsed = parseMoneyToCents(form.restocking_fee);
    if (parsed == null || parsed > MAX_FEE_CENTS) errors.restocking_fee = 'Enter an amount like 12.50.';
    else fee = parsed;
  }

  const vnum = orNull(form.vendor_rma_number);
  if (vnum && vnum.length > 80) errors.vendor_rma_number = 'Too long (80 characters max).';
  const notes = orNull(form.reason_notes);
  if (notes && notes.length > 2000) errors.reason_notes = 'Too long (2000 characters max).';

  if (form.lines.length === 0) errors.lines = 'Add at least one part to return.';
  else if (form.lines.length > MAX_LINES) errors.lines = `A return can have at most ${MAX_LINES} lines.`;

  const replacement = form.resolution === 'replacement';
  const lines: SaveRmaLinePayload[] = [];

  form.lines.forEach((l, i) => {
    if (!l.part_id) errors[lineErrorKey(i, 'part_id')] = 'Choose a part.';

    const qtyText = l.quantity.trim();
    const qty = /^\d{1,6}$/.test(qtyText) ? Number(qtyText) : NaN;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      errors[lineErrorKey(i, 'quantity')] = `Enter a whole number from 1 to ${MAX_QTY.toLocaleString('en-US')}.`;
    } else if (l.max_quantity != null && qty > l.max_quantity) {
      errors[lineErrorKey(i, 'quantity')] = l.max_quantity === 0 ? 'Nothing left to return on this line.' : `Only ${l.max_quantity} can still be returned.`;
    }

    if (l.source === 'stock' && !l.location_id) errors[lineErrorKey(i, 'location_id')] = 'Choose where it comes from.';
    else if (replacement && !l.location_id) errors[lineErrorKey(i, 'location_id')] = 'Choose where the replacement goes.';
    if (l.usage_transaction_id && l.source !== 'installed') errors[lineErrorKey(i, 'source')] = 'A part used on a job is an installed part.';

    let credit: number | null = null;
    if (l.unit_credit.trim() !== '') {
      const c = parseMoneyToCents(l.unit_credit);
      if (c == null || c > MAX_UNIT_CREDIT_CENTS) errors[lineErrorKey(i, 'unit_credit')] = 'Enter an amount like 12.50.';
      else credit = c;
    }
    if (l.serial_number.trim().length > 120) errors[lineErrorKey(i, 'serial_number')] = 'Too long (120 characters max).';
    if (l.note.trim().length > 500) errors[lineErrorKey(i, 'note')] = 'Too long (500 characters max).';

    lines.push({
      part_id: l.part_id,
      source: l.source,
      location_id: orNull(l.location_id),
      quantity: Number.isInteger(qty) ? qty : 0,
      unit_credit_cents: credit,
      purchase_order_line_id: orNull(l.purchase_order_line_id),
      usage_transaction_id: orNull(l.usage_transaction_id),
      job_id: orNull(l.job_id),
      serial_number: orNull(l.serial_number),
      note: orNull(l.note),
    });
  });

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      vendor_id: form.vendor_id,
      purchase_order_id: orNull(form.purchase_order_id),
      reason_code: form.reason_code as RmaReason,
      reason_notes: notes,
      resolution: form.resolution as RmaResolution,
      restocking_fee_cents: fee,
      vendor_rma_number: vnum,
      lines,
    },
  };
}

/** Live preview of the expected credit while the form is being filled in (invalid rows count as zero). */
export function previewExpectedCredit(form: RmaFormValues): number {
  const resolution: RmaResolution = oneOf(RMA_RESOLUTIONS, form.resolution) ? form.resolution : 'credit';
  const fee = form.restocking_fee.trim() === '' ? 0 : (parseMoneyToCents(form.restocking_fee) ?? 0);
  const lines = form.lines.map((l) => {
    const qty = /^\d{1,6}$/.test(l.quantity.trim()) ? Number(l.quantity.trim()) : 0;
    const typed = l.unit_credit.trim() === '' ? null : parseMoneyToCents(l.unit_credit);
    return { quantity: qty, unit_credit_cents: typed ?? l.cost_hint_cents };
  });
  return expectedCreditCents(lines, fee, resolution);
}

/** Rebuilds the form from a saved RMA so a draft/authorized return can be edited. */
export function rmaToForm(rma: Rma): RmaFormValues {
  return {
    vendor_id: rma.vendor_id,
    purchase_order_id: rma.purchase_order_id ?? '',
    reason_code: rma.reason_code,
    reason_notes: rma.reason_notes ?? '',
    resolution: rma.resolution,
    restocking_fee: rma.restocking_fee_cents > 0 ? centsToInput(rma.restocking_fee_cents) : '',
    vendor_rma_number: rma.vendor_rma_number ?? '',
    lines: rma.lines
      .slice()
      .sort((a, b) => a.line_no - b.line_no)
      .map((l) => ({
        key: l.id,
        part_id: l.part_id,
        source: l.source,
        location_id: l.location_id ?? '',
        quantity: String(l.quantity),
        unit_credit: centsToInput(l.unit_credit_cents),
        cost_hint_cents: l.unit_cost_cents,
        purchase_order_line_id: l.purchase_order_line_id ?? '',
        usage_transaction_id: l.usage_transaction_id ?? '',
        job_id: l.job_id ?? '',
        serial_number: l.serial_number ?? '',
        note: l.note ?? '',
        max_quantity: null,
      })),
  };
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim()) && value.trim().length <= 500;
}
