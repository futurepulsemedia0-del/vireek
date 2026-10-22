/**
 * Procurement Network — pure domain logic (no I/O, no React).
 *
 * Mirrors the rules enforced in SQL (supabase/migrations/20271021000000_procurement_network.sql)
 * so the UI can PREVIEW prices, tier progress and savings. The database is always the source of
 * truth: pn_place_order() recomputes every price server-side, so nothing here can change a price.
 *
 * Data access lives in procurementNetworkApi.ts.
 */

/** Minimum distinct tenants before any pooled number is shown (k-anonymity). Mirrors pn_min_cohort(). */
export const MIN_COHORT = 3;

export type SupplierStatus = 'pending' | 'approved' | 'rejected' | 'suspended';
export type ProgramStatus = 'draft' | 'open' | 'closed' | 'cancelled';
export type ScheduleStatus = 'draft' | 'proposed' | 'countered' | 'active' | 'superseded';
export type NetworkOrderStatus = 'awaiting_approval' | 'placed' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';
export type RebateStatus = 'accrued' | 'paid' | 'void';
export type RebateKind = 'tier_true_up' | 'program_bonus';

export interface Tier {
  id: string;
  rank: number;
  label: string;
  min_qualifying_cents: number;
  discount_bps: number;
}

/** Cohort-masked pool view. Numeric fields are null until MIN_COHORT tenants are engaged. */
export interface PoolPublic {
  program_id: string;
  cohort_visible: boolean;
  pooled_cents: number | null;
  projected_cents: number | null;
  participants: number | null;
  gap_to_next_cents: number | null;
  min_participants_for_tier: number;
  tier_id: string | null;
  tier_rank: number | null;
  tier_label: string | null;
  tier_discount_bps: number | null;
  next_tier_rank: number | null;
  next_tier_label: string | null;
  next_tier_min_cents: number | null;
}

export interface ProgramSummary {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  status: ProgramStatus;
  starts_on: string;
  ends_on: string;
  supplier_id: string;
  supplier_name: string;
  bonus_rebate_bps: number;
  bonus_min_spend_cents: number;
  eligible: boolean;
  regions: string[];
  tiers: Tier[];
  pool: PoolPublic | null;
  my_ordered_cents: number;
  my_committed_cents: number;
}

export interface ProgramItem {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  manufacturer: string | null;
  mpn: string | null;
  unit: string;
  list_price_cents: number;
  min_order_qty: number;
  lead_time_days: number | null;
  /** tier id -> unit price in cents */
  prices: Record<string, number>;
  my_commit_qty: number | null;
  part_id: string | null;
}

export interface ProgramDetail {
  program: {
    id: string;
    title: string;
    description: string | null;
    category: string | null;
    terms: string | null;
    status: ProgramStatus;
    starts_on: string;
    ends_on: string;
    bonus_rebate_bps: number;
    bonus_min_spend_cents: number;
    min_participants_for_tier: number;
  };
  supplier: { id: string; name: string; website: string | null; description: string | null };
  tiers: Tier[];
  pool: PoolPublic | null;
  items: ProgramItem[];
  has_schedule: boolean;
}

export interface ShipTo {
  name: string;
  contact: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
}

export interface NetworkOrder {
  id: string;
  order_number: string;
  user_id: string;
  supplier_id: string;
  program_id: string;
  program_title: string | null;
  supplier_name: string | null;
  po_id: string | null;
  po_link_error: string | null;
  status: NetworkOrderStatus;
  tier_rank_at_order: number | null;
  ship_to: Partial<ShipTo>;
  buyer_company: string | null;
  notes: string | null;
  supplier_note: string | null;
  tracking: string | null;
  cancel_reason: string | null;
  subtotal_cents: number;
  placed_at: string | null;
  confirmed_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

export interface NetworkOrderLine {
  id: string;
  order_id: string;
  catalog_item_id: string;
  sku: string;
  description: string;
  qty: number;
  list_price_cents: number;
  unit_price_cents: number;
}

export interface Rebate {
  id: string;
  user_id: string;
  program_id: string;
  supplier_id: string;
  kind: RebateKind;
  amount_cents: number;
  status: RebateStatus;
  basis: { program_title?: string; supplier_name?: string; buyer_company?: string; final_tier_rank?: number; net_spend_cents?: number; bonus_bps?: number };
  paid_at: string | null;
  paid_reference: string | null;
  created_at: string;
}

export interface OrderSavingsRow {
  order_id: string;
  program_id: string;
  supplier_id: string;
  status: NetworkOrderStatus;
  ordered_at: string;
  paid_cents: number;
  baseline_cents: number;
  list_cents: number;
}

// ------------------------------------------------------------------
// Labels
// ------------------------------------------------------------------

export const ORDER_STATUS_LABELS: Record<NetworkOrderStatus, string> = {
  awaiting_approval: 'Awaiting your approval',
  placed: 'Sent to supplier',
  confirmed: 'Confirmed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export const ORDER_STATUS_TONE: Record<NetworkOrderStatus, string> = {
  awaiting_approval: 'bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-400',
  placed: 'bg-sky-100 text-sky-800 dark:bg-sky-500/10 dark:text-sky-400',
  confirmed: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/10 dark:text-indigo-400',
  shipped: 'bg-violet-100 text-violet-800 dark:bg-violet-500/10 dark:text-violet-400',
  delivered: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400',
  cancelled: 'bg-rose-100 text-rose-800 dark:bg-rose-500/10 dark:text-rose-400',
};

export const REBATE_KIND_LABELS: Record<RebateKind, string> = {
  tier_true_up: 'Volume tier true-up',
  program_bonus: 'Program bonus rebate',
};

export const SCHEDULE_STATUS_LABELS: Record<ScheduleStatus, string> = {
  draft: 'Draft',
  proposed: 'Under review',
  countered: 'Countered',
  active: 'Active',
  superseded: 'Superseded',
};

/** What a supplier may do next with an order (mirrors pn_supplier_update_order). */
export function supplierOrderActions(status: NetworkOrderStatus): Array<'confirm' | 'ship' | 'deliver' | 'cancel'> {
  switch (status) {
    case 'placed':
      return ['confirm', 'cancel'];
    case 'confirmed':
      return ['ship', 'cancel'];
    case 'shipped':
      return ['deliver'];
    default:
      return [];
  }
}

/** Buyers can cancel until the supplier confirms (mirrors pn_cancel_order). */
export function buyerCanCancel(status: NetworkOrderStatus, programStatus: ProgramStatus | undefined): boolean {
  return (status === 'awaiting_approval' || status === 'placed') && programStatus !== 'closed';
}

// ------------------------------------------------------------------
// Money
// ------------------------------------------------------------------

export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '$0.00';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function bpsToPercent(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/** "12.5", "$1,200.00", "1 200,50" -> cents; null when not a valid non-negative amount. */
export function parseMoneyToCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? Math.round(input * 100) : null;
  let s = input.trim().replace(/[$€£\s]/g, '');
  if (!s) return null;
  // "1.234,56" (EU) vs "1,234.56" (US)
  if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  return Number.isFinite(cents) && cents >= 0 && cents <= 1_000_000_000 ? cents : null;
}

// ------------------------------------------------------------------
// Tiers and pricing
// ------------------------------------------------------------------

export function sortTiers(tiers: Tier[]): Tier[] {
  return [...tiers].sort((a, b) => a.rank - b.rank);
}

/**
 * Which tier a given pooled volume unlocks. Mirrors pn_pool_state():
 * below `minParticipants` distinct ordering tenants only the lowest tier applies.
 */
export function tierForVolume(
  tiers: Tier[],
  qualifyingCents: number,
  orderingParticipants: number,
  minParticipants: number,
): Tier | null {
  const sorted = sortTiers(tiers);
  if (sorted.length === 0) return null;
  if (orderingParticipants < minParticipants) return sorted[0];
  let current = sorted[0];
  for (const t of sorted) if (t.min_qualifying_cents <= qualifyingCents) current = t;
  return current;
}

/** Fallback price when no explicit schedule line exists. Mirrors pn_unit_price(). */
export function fallbackUnitPrice(listCents: number, discountBps: number): number {
  return Math.round((listCents * (10000 - Math.max(0, discountBps))) / 10000);
}

export function unitPriceAt(item: ProgramItem, tier: Tier | null): number {
  if (!tier) return item.list_price_cents;
  const explicit = item.prices[tier.id];
  return typeof explicit === 'number' ? explicit : fallbackUnitPrice(item.list_price_cents, tier.discount_bps);
}

export interface TierProgress {
  /** 0..100, or null while the pool is hidden by the cohort rule. */
  percent: number | null;
  currentLabel: string | null;
  nextLabel: string | null;
  gapCents: number | null;
  participantsNeeded: number;
  hidden: boolean;
}

export function tierProgress(pool: PoolPublic | null, tiers: Tier[]): TierProgress {
  if (!pool) return { percent: null, currentLabel: null, nextLabel: null, gapCents: null, participantsNeeded: 0, hidden: true };
  const hidden = !pool.cohort_visible || pool.pooled_cents === null;
  const sorted = sortTiers(tiers);
  const current = sorted.find((t) => t.id === pool.tier_id) ?? null;
  const next = sorted.find((t) => t.rank === pool.next_tier_rank) ?? null;
  let percent: number | null = null;
  if (!hidden && next) {
    const floor = current?.min_qualifying_cents ?? 0;
    const span = Math.max(next.min_qualifying_cents - floor, 1);
    percent = Math.max(0, Math.min(100, Math.round((((pool.pooled_cents ?? 0) - floor) / span) * 100)));
  } else if (!hidden && !next) {
    percent = 100;
  }
  return {
    percent,
    currentLabel: pool.tier_label,
    nextLabel: pool.next_tier_label,
    gapCents: hidden ? null : pool.gap_to_next_cents,
    participantsNeeded: pool.participants === null ? MIN_COHORT : Math.max(0, pool.min_participants_for_tier - pool.participants),
    hidden,
  };
}

// ------------------------------------------------------------------
// Cart preview (what the order will cost at the CURRENT tier, and at the next)
// ------------------------------------------------------------------

export interface CartPreviewLine {
  item: ProgramItem;
  qty: number;
  unitCents: number;
  lineCents: number;
  listCents: number;
  nextTierUnitCents: number | null;
  belowMinimum: boolean;
}

export interface CartPreview {
  lines: CartPreviewLine[];
  subtotalCents: number;
  listTotalCents: number;
  savingsVsListCents: number;
  /** Extra saving if the pool reaches the next tier (paid back as a rebate at close). */
  nextTierExtraSavingCents: number | null;
  errors: string[];
}

export function previewCart(
  items: ProgramItem[],
  quantities: Record<string, number>,
  tiers: Tier[],
  currentTierId: string | null,
  nextTierRank: number | null,
): CartPreview {
  const sorted = sortTiers(tiers);
  const current = sorted.find((t) => t.id === currentTierId) ?? sorted[0] ?? null;
  const next = nextTierRank === null ? null : (sorted.find((t) => t.rank === nextTierRank) ?? null);
  const lines: CartPreviewLine[] = [];
  const errors: string[] = [];
  let subtotal = 0;
  let listTotal = 0;
  let nextTotal = 0;

  for (const item of items) {
    const qty = quantities[item.id];
    if (!qty || qty <= 0) continue;
    if (!Number.isFinite(qty) || qty > 1_000_000) {
      errors.push(`${item.sku}: invalid quantity`);
      continue;
    }
    const unit = unitPriceAt(item, current);
    const nextUnit = next ? unitPriceAt(item, next) : null;
    const belowMinimum = qty < item.min_order_qty;
    if (belowMinimum) errors.push(`${item.sku}: minimum order quantity is ${item.min_order_qty}`);
    const line = Math.round(qty * unit);
    subtotal += line;
    listTotal += Math.round(qty * item.list_price_cents);
    nextTotal += Math.round(qty * (nextUnit ?? unit));
    lines.push({ item, qty, unitCents: unit, lineCents: line, listCents: item.list_price_cents, nextTierUnitCents: nextUnit, belowMinimum });
  }

  return {
    lines,
    subtotalCents: subtotal,
    listTotalCents: listTotal,
    savingsVsListCents: listTotal - subtotal,
    nextTierExtraSavingCents: next ? Math.max(subtotal - nextTotal, 0) : null,
    errors,
  };
}

export function validateShipTo(s: Partial<ShipTo>): string[] {
  const errors: string[] = [];
  if (!s.name?.trim()) errors.push('Ship-to name is required');
  if (!s.line1?.trim()) errors.push('Street address is required');
  if (!s.city?.trim()) errors.push('City is required');
  if (!s.postal_code?.trim()) errors.push('Postal code is required');
  return errors;
}

export function isProgramOrderable(p: { status: ProgramStatus; starts_on: string; ends_on: string }, today = new Date()): boolean {
  const d = today.toISOString().slice(0, 10);
  return p.status === 'open' && p.starts_on <= d && p.ends_on >= d;
}

export function daysLeft(endsOn: string, today = new Date()): number {
  const end = Date.parse(`${endsOn}T23:59:59Z`);
  return Math.max(0, Math.ceil((end - today.getTime()) / 86_400_000));
}

// ------------------------------------------------------------------
// Savings reporting
// ------------------------------------------------------------------

export interface SavingsSummary {
  orders: number;
  paidCents: number;
  baselineCents: number;
  listCents: number;
  /** baseline - paid (negative = the network cost more than your previous price). */
  instantSavingsCents: number;
  rebatesAccruedCents: number;
  rebatesPaidCents: number;
  totalSavingsCents: number;
  savingsPercent: number | null;
  byMonth: Array<{ month: string; paidCents: number; savingsCents: number }>;
  bySupplier: Array<{ supplierId: string; paidCents: number; savingsCents: number }>;
}

const COUNTED: NetworkOrderStatus[] = ['placed', 'confirmed', 'shipped', 'delivered'];

export function summarizeSavings(rows: OrderSavingsRow[], rebates: Rebate[]): SavingsSummary {
  const counted = rows.filter((r) => COUNTED.includes(r.status));
  const months = new Map<string, { paidCents: number; savingsCents: number }>();
  const suppliers = new Map<string, { paidCents: number; savingsCents: number }>();
  let paid = 0;
  let baseline = 0;
  let list = 0;

  for (const r of counted) {
    paid += r.paid_cents;
    baseline += r.baseline_cents;
    list += r.list_cents;
    const saving = r.baseline_cents - r.paid_cents;
    const month = r.ordered_at.slice(0, 7);
    const m = months.get(month) ?? { paidCents: 0, savingsCents: 0 };
    m.paidCents += r.paid_cents;
    m.savingsCents += saving;
    months.set(month, m);
    const s = suppliers.get(r.supplier_id) ?? { paidCents: 0, savingsCents: 0 };
    s.paidCents += r.paid_cents;
    s.savingsCents += saving;
    suppliers.set(r.supplier_id, s);
  }

  const accrued = rebates.filter((r) => r.status === 'accrued').reduce((a, r) => a + r.amount_cents, 0);
  const paidRebates = rebates.filter((r) => r.status === 'paid').reduce((a, r) => a + r.amount_cents, 0);
  const instant = baseline - paid;
  const total = instant + accrued + paidRebates;

  return {
    orders: counted.length,
    paidCents: paid,
    baselineCents: baseline,
    listCents: list,
    instantSavingsCents: instant,
    rebatesAccruedCents: accrued,
    rebatesPaidCents: paidRebates,
    totalSavingsCents: total,
    savingsPercent: baseline > 0 ? Math.round((total / baseline) * 1000) / 10 : null,
    byMonth: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v })),
    bySupplier: [...suppliers.entries()].map(([supplierId, v]) => ({ supplierId, ...v })).sort((a, b) => b.savingsCents - a.savingsCents),
  };
}

// ------------------------------------------------------------------
// Supplier tooling: catalog CSV import and price-schedule validation
// ------------------------------------------------------------------

export interface CatalogImportRow {
  sku: string;
  name: string;
  list_price_cents: number;
  unit: string;
  category: string | null;
  manufacturer: string | null;
  mpn: string | null;
  description: string | null;
  min_order_qty: number;
  lead_time_days: number | null;
}

export interface CatalogImportResult {
  rows: CatalogImportRow[];
  errors: Array<{ line: number; message: string }>;
}

/** Minimal RFC-4180 style CSV/TSV parser (quotes, escaped quotes, CRLF). */
export function parseDelimited(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = first.includes('\t') ? '\t' : first.split(';').length > first.split(',').length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

const HEADER_ALIASES: Record<string, keyof CatalogImportRow> = {
  sku: 'sku',
  'item number': 'sku',
  'part number': 'sku',
  name: 'name',
  title: 'name',
  product: 'name',
  'product name': 'name',
  description: 'description',
  price: 'list_price_cents',
  'list price': 'list_price_cents',
  list_price: 'list_price_cents',
  unit: 'unit',
  uom: 'unit',
  category: 'category',
  manufacturer: 'manufacturer',
  brand: 'manufacturer',
  mpn: 'mpn',
  'min order qty': 'min_order_qty',
  moq: 'min_order_qty',
  min_order_qty: 'min_order_qty',
  'lead time': 'lead_time_days',
  lead_time_days: 'lead_time_days',
};

export const MAX_IMPORT_ROWS = 2000;

export function parseCatalogCsv(text: string): CatalogImportResult {
  const table = parseDelimited(text);
  const errors: CatalogImportResult['errors'] = [];
  if (table.length < 2) return { rows: [], errors: [{ line: 1, message: 'Add a header row and at least one item' }] };
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    return { rows: [], errors: [{ line: 1, message: `Import at most ${MAX_IMPORT_ROWS} items at a time` }] };
  }
  const header = table[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? null);
  const col = (key: keyof CatalogImportRow) => header.indexOf(key);
  for (const required of ['sku', 'name', 'list_price_cents'] as const) {
    if (col(required) === -1) {
      return { rows: [], errors: [{ line: 1, message: `Missing required column: ${required === 'list_price_cents' ? 'price' : required}` }] };
    }
  }

  const seen = new Set<string>();
  const rows: CatalogImportRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    const get = (key: keyof CatalogImportRow) => (col(key) === -1 ? '' : (cells[col(key)] ?? '').trim());
    const line = i + 1;
    const sku = get('sku');
    const name = get('name');
    const price = parseMoneyToCents(get('list_price_cents'));
    if (!sku || sku.length > 60) {
      errors.push({ line, message: 'SKU is required (max 60 characters)' });
      continue;
    }
    if (seen.has(sku.toLowerCase())) {
      errors.push({ line, message: `Duplicate SKU in file: ${sku}` });
      continue;
    }
    if (!name || name.length > 200) {
      errors.push({ line, message: `${sku}: name is required (max 200 characters)` });
      continue;
    }
    if (price === null) {
      errors.push({ line, message: `${sku}: invalid price "${get('list_price_cents')}"` });
      continue;
    }
    const moqRaw = get('min_order_qty');
    const moq = moqRaw ? Number(moqRaw) : 1;
    if (!Number.isFinite(moq) || moq <= 0) {
      errors.push({ line, message: `${sku}: invalid minimum order quantity` });
      continue;
    }
    const leadRaw = get('lead_time_days');
    const lead = leadRaw ? Number(leadRaw) : null;
    if (lead !== null && (!Number.isInteger(lead) || lead < 0 || lead > 365)) {
      errors.push({ line, message: `${sku}: lead time must be a whole number of days (0-365)` });
      continue;
    }
    seen.add(sku.toLowerCase());
    rows.push({
      sku,
      name,
      list_price_cents: price,
      unit: get('unit').slice(0, 20) || 'each',
      category: get('category').slice(0, 80) || null,
      manufacturer: get('manufacturer').slice(0, 120) || null,
      mpn: get('mpn').slice(0, 80) || null,
      description: get('description').slice(0, 2000) || null,
      min_order_qty: moq,
      lead_time_days: lead,
    });
  }
  return { rows, errors };
}

export interface ScheduleLineInput {
  catalog_item_id: string;
  tier_id: string;
  unit_price_cents: number;
}

/** Same rules as pn_supplier_submit_schedule(), so the supplier sees problems before submitting. */
export function validateScheduleDraft(
  tiers: Tier[],
  items: Array<{ id: string; sku: string; list_price_cents: number }>,
  lines: ScheduleLineInput[],
): string[] {
  const issues: string[] = [];
  const sorted = sortTiers(tiers);
  if (sorted.length === 0) return ['Add volume tiers first'];
  if (sorted[0].min_qualifying_cents !== 0) issues.push('The lowest tier must start at $0');
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].min_qualifying_cents <= sorted[i - 1].min_qualifying_cents) {
      issues.push(`Tier "${sorted[i].label}" must require more volume than "${sorted[i - 1].label}"`);
    }
  }
  if (lines.length === 0) issues.push('Add at least one price line');
  const itemById = new Map(items.map((i) => [i.id, i]));
  const byItem = new Map<string, Map<number, number>>();
  const rankByTier = new Map(sorted.map((t) => [t.id, t.rank]));
  for (const l of lines) {
    const item = itemById.get(l.catalog_item_id);
    if (!item) {
      issues.push('A price line references an unknown item');
      continue;
    }
    if (l.unit_price_cents > item.list_price_cents) issues.push(`${item.sku}: price exceeds list price`);
    const rank = rankByTier.get(l.tier_id);
    if (rank === undefined) continue;
    const m = byItem.get(item.id) ?? new Map<number, number>();
    m.set(rank, l.unit_price_cents);
    byItem.set(item.id, m);
  }
  for (const [itemId, m] of byItem) {
    const ranks = [...m.keys()].sort((a, b) => a - b);
    for (let i = 1; i < ranks.length; i++) {
      if ((m.get(ranks[i]) ?? 0) > (m.get(ranks[i - 1]) ?? 0)) {
        issues.push(`${itemById.get(itemId)?.sku}: a higher tier cannot cost more than a lower tier`);
        break;
      }
    }
  }
  return issues;
}

/** Apply a flat % off list to every item for every tier, e.g. as a starting point for negotiation. */
export function buildScheduleFromDiscounts(
  tiers: Tier[],
  items: Array<{ id: string; list_price_cents: number }>,
  discountBpsByTierId: Record<string, number>,
): ScheduleLineInput[] {
  const out: ScheduleLineInput[] = [];
  for (const t of sortTiers(tiers)) {
    const bps = discountBpsByTierId[t.id] ?? t.discount_bps;
    for (const item of items) {
      out.push({ catalog_item_id: item.id, tier_id: t.id, unit_price_cents: fallbackUnitPrice(item.list_price_cents, bps) });
    }
  }
  return out;
}
