/**
 * Job parts ordering — pure domain logic (no network, no React).
 *
 * Mirrors supabase/migrations/20271020000000_job_parts_ordering.sql. The database stays the
 * authority (it re-validates every import row and re-rounds every quantity); everything here exists
 * to give instant feedback, map CSV columns, and turn raw rows into display state. Network access
 * lives in partsOrderingApi.ts.
 */

// ============================================================
// TYPES
// ============================================================

export const STOCK_STATUSES = ['in_stock', 'low_stock', 'backorder', 'discontinued', 'unknown'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

export const SHIPMENT_STATUSES = ['not_shipped', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'delayed', 'exception'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export type OrderStatus = 'draft' | 'pending_approval' | 'sent' | 'partially_received' | 'received' | 'cancelled';

export interface CatalogHit {
  id: string;
  vendor_id: string;
  vendor_name: string;
  sku: string;
  name: string;
  brand: string | null;
  category: string | null;
  mpn: string | null;
  uom: string;
  unit_cost_cents: number;
  list_price_cents: number | null;
  min_order_qty: number;
  pack_size: number;
  lead_time_days: number | null;
  stock_status: StockStatus;
  part_id: string | null;
  on_hand: number;
  is_best_price: boolean;
  prev_cost_cents: number | null;
  price_changed_at: string | null;
}

export interface CartLine {
  id: string;
  job_id: string | null;
  destination_location_id: string | null;
  catalog_item_id: string;
  quantity: number;
  item: Pick<CatalogHit, 'vendor_id' | 'sku' | 'name' | 'unit_cost_cents' | 'stock_status' | 'min_order_qty' | 'pack_size'> & {
    active: boolean;
    inventory_vendors: { name: string } | null;
  } | null;
}

export interface JobPartOrder {
  job_id: string;
  purchase_order_id: string;
  po_number: string;
  po_status: OrderStatus;
  shipment_status: ShipmentStatus;
  expected_at: string | null;
  original_expected_at: string | null;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  vendor_name: string | null;
  po_line_id: string;
  part_id: string;
  part_name: string;
  part_number: string | null;
  job_quantity: number;
  quantity_ordered: number;
  quantity_received: number;
  unit_cost_cents: number;
}

export interface ImportItem {
  sku: string;
  name?: string;
  description?: string;
  brand?: string;
  category?: string;
  mpn?: string;
  uom?: string;
  unit_cost?: string;
  list_price?: string;
  min_order_qty?: string;
  pack_size?: string;
  lead_time_days?: string;
  stock_status?: StockStatus;
}

export interface ImportResult {
  import_id: string | null;
  status: 'completed' | 'completed_with_errors' | 'failed';
  dry_run: boolean;
  total: number;
  inserted: number;
  updated: number;
  unchanged: number;
  errors: number;
  price_up: number;
  price_down: number;
  error_rows: { row: number; sku: string; message: string }[];
}

export interface CreateOrdersResult {
  orders: {
    po_id: string;
    po_number: string;
    vendor_id: string;
    vendor_name: string;
    status: OrderStatus;
    total_cents: number;
    expected_at: string;
    line_count: number;
  }[];
  jobs: { job_id: string; hold: string; reason?: string | null }[];
  skipped: { cart_id: string; sku: string; reason: string }[];
}

// ============================================================
// MONEY / FORMATTING
// ============================================================

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((Number.isFinite(cents) ? cents : 0) / 100);
}

/**
 * Parses a price cell ("$1,234.50", "12.5", " 7 ") into a plain decimal string the database accepts
 * (digits with an optional fraction), or null when it is not a clean non-negative amount.
 * European "1.234,50" style is deliberately rejected rather than guessed.
 */
export function parsePriceCell(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = String(raw).trim().replace(/^[$€£]\s*/, '').replace(/\s*(usd|eur|gbp)$/i, '').replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^\d{1,10}(\.\d{1,6})?$/.test(cleaned)) return null;
  return cleaned;
}

export function priceDelta(current: number, previous: number | null): { direction: 'up' | 'down' | 'same'; percent: number } | null {
  if (previous == null || previous <= 0) return null;
  if (current === previous) return { direction: 'same', percent: 0 };
  return { direction: current > previous ? 'up' : 'down', percent: Math.round((Math.abs(current - previous) / previous) * 1000) / 10 };
}

// ============================================================
// QUANTITIES
// ============================================================

/** Same rule as the database (_order_quantity): at least the MOQ, rounded up to a whole pack. */
export function roundOrderQty(requested: number, moq: number, pack: number): number {
  const r = Number.isFinite(requested) ? Math.floor(requested) : 1;
  const p = Math.max(1, Math.floor(pack) || 1);
  const m = Math.max(1, Math.floor(moq) || 1);
  return Math.min(100000, Math.ceil(Math.max(r, m, 1) / p) * p);
}

export function clampQty(raw: string | number): number {
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(100000, Math.floor(n));
}

// ============================================================
// CSV / API IMPORT MAPPING
// ============================================================

export const IMPORT_FIELDS = [
  { key: 'sku', label: 'SKU / item number', required: true },
  { key: 'name', label: 'Name', required: false },
  { key: 'unit_cost', label: 'Your price', required: true },
  { key: 'description', label: 'Description', required: false },
  { key: 'brand', label: 'Brand', required: false },
  { key: 'category', label: 'Category', required: false },
  { key: 'mpn', label: 'Manufacturer part #', required: false },
  { key: 'uom', label: 'Unit of measure', required: false },
  { key: 'list_price', label: 'List price', required: false },
  { key: 'min_order_qty', label: 'Min order qty', required: false },
  { key: 'pack_size', label: 'Pack size', required: false },
  { key: 'lead_time_days', label: 'Lead time (days)', required: false },
  { key: 'stock_status', label: 'Stock status', required: false },
] as const;
export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key'];
export type ColumnMapping = Partial<Record<ImportFieldKey, number>>;

const HEADER_HINTS: Record<ImportFieldKey, RegExp[]> = {
  sku: [/^sku$/, /^item ?(no|number|#|id)?$/, /^part ?(no|number|#)?$/, /^product ?(code|id|number)$/, /^catalog ?(no|number)$/, /^vendor ?(sku|part)/],
  name: [/^(item |product |part )?(name|title)$/, /^description$/, /^desc$/],
  unit_cost: [/^(your |net |unit |contract |cost )?(price|cost)$/, /^net$/, /^unit ?(price|cost)$/, /^price ?\(?(usd|\$)?\)?$/, /^cost$/],
  description: [/^(long |full )?description$/, /^details?$/],
  brand: [/^brand$/, /^manufacturer$/, /^mfr$/, /^make$/],
  category: [/^category$/, /^group$/, /^department$/, /^type$/],
  mpn: [/^mpn$/, /^mfr ?(part|pn|#)/, /^manufacturer ?(part|pn|#)/, /^model( ?(no|number|#))?$/],
  uom: [/^uom$/, /^unit( of measure)?$/, /^um$/],
  list_price: [/^(list|msrp|retail)( ?price)?$/],
  min_order_qty: [/^(min|minimum)( order)?( ?qty| ?quantity)?$/, /^moq$/],
  pack_size: [/^(pack|case)( ?size| ?qty| ?quantity)?$/, /^qty ?per ?(pack|case)$/],
  lead_time_days: [/^lead ?time( ?\(?days\)?)?$/, /^days ?to ?ship$/, /^lead ?days$/],
  stock_status: [/^(stock|availability|inventory)( ?status)?$/, /^in ?stock$/],
};

/** Best-effort column auto-detection; never maps one column to two fields. */
export function autoMapColumns(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  const norm = headers.map((h) => h.trim().toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' '));
  // 'description' hints exist for both name and description; resolve name first, then description.
  for (const field of IMPORT_FIELDS) {
    const hints = HEADER_HINTS[field.key];
    for (let i = 0; i < norm.length; i++) {
      if (used.has(i)) continue;
      if (hints.some((re) => re.test(norm[i]))) {
        mapping[field.key] = i;
        used.add(i);
        break;
      }
    }
  }
  return mapping;
}

export function normalizeStockStatus(raw: string | null | undefined): StockStatus | undefined {
  const v = (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!v) return undefined;
  if (['in_stock', 'instock', 'available', 'yes', 'y', 'true', 'in'].includes(v)) return 'in_stock';
  if (['low_stock', 'low', 'limited', 'few', 'low_inventory'].includes(v)) return 'low_stock';
  if (['backorder', 'back_order', 'backordered', 'on_backorder', 'out_of_stock', 'oos', 'no', 'n', 'false', 'out'].includes(v)) return 'backorder';
  if (['discontinued', 'obsolete', 'eol', 'end_of_life'].includes(v)) return 'discontinued';
  if (['unknown', 'n/a', 'na'].includes(v)) return 'unknown';
  return undefined;
}

export interface BuildItemsResult {
  items: ImportItem[];
  /** Rows rejected before sending (the database re-checks everything it receives). */
  issues: { row: number; message: string }[];
}

function intCell(raw: string | undefined): string | undefined {
  const v = (raw ?? '').trim();
  return /^\d{1,6}$/.test(v) ? v : undefined;
}

/** Turns table rows into API items. `row` numbers are 1-based data rows (header excluded). */
export function buildImportItems(rows: string[][], mapping: ColumnMapping, opts: { priceOnly?: boolean } = {}): BuildItemsResult {
  const items: ImportItem[] = [];
  const issues: { row: number; message: string }[] = [];
  const cell = (r: string[], k: ImportFieldKey) => (mapping[k] === undefined ? undefined : (r[mapping[k] as number] ?? '').trim());
  rows.forEach((r, idx) => {
    const row = idx + 1;
    if (r.every((c) => !String(c ?? '').trim())) return;
    const sku = cell(r, 'sku') ?? '';
    if (!sku) return void issues.push({ row, message: 'Missing SKU' });
    if (sku.length > 80) return void issues.push({ row, message: 'SKU is longer than 80 characters' });
    const priceRaw = cell(r, 'unit_cost');
    const price = priceRaw ? parsePriceCell(priceRaw) : null;
    if (priceRaw && price === null) return void issues.push({ row, message: `Invalid price "${priceRaw.slice(0, 20)}"` });
    const name = cell(r, 'name');
    const item: ImportItem = { sku };
    if (price !== null) item.unit_cost = price;
    if (name) item.name = name.slice(0, 300);
    if (!opts.priceOnly) {
      for (const k of ['description', 'brand', 'category', 'mpn', 'uom'] as const) {
        const v = cell(r, k);
        if (v) item[k] = v;
      }
      const list = parsePriceCell(cell(r, 'list_price'));
      if (list !== null) item.list_price = list;
      for (const k of ['min_order_qty', 'pack_size', 'lead_time_days'] as const) {
        const v = intCell(cell(r, k));
        if (v !== undefined) item[k] = v;
      }
      const stock = normalizeStockStatus(cell(r, 'stock_status'));
      if (stock) item.stock_status = stock;
    }
    items.push(item);
  });
  return { items, issues };
}

export const MAX_ITEMS_PER_CALL = 5000;

export function chunkItems<T>(items: T[], size = MAX_ITEMS_PER_CALL): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function mergeImportResults(parts: ImportResult[]): ImportResult {
  const base: ImportResult = {
    import_id: parts[0]?.import_id ?? null, status: 'completed', dry_run: parts[0]?.dry_run ?? false,
    total: 0, inserted: 0, updated: 0, unchanged: 0, errors: 0, price_up: 0, price_down: 0, error_rows: [],
  };
  let offset = 0;
  for (const p of parts) {
    base.total += p.total; base.inserted += p.inserted; base.updated += p.updated; base.unchanged += p.unchanged;
    base.errors += p.errors; base.price_up += p.price_up; base.price_down += p.price_down;
    base.error_rows.push(...p.error_rows.map((e) => ({ ...e, row: e.row + offset })));
    offset += p.total;
  }
  base.status = base.errors === 0 ? 'completed' : base.inserted + base.updated + base.unchanged > 0 ? 'completed_with_errors' : 'failed';
  return base;
}

// ============================================================
// SUPPLIER FEED KEYS (hashed in the browser; the raw key is shown once)
// ============================================================

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function generateFeedKey(): Promise<{ raw: string; prefix: string; hash: string }> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  const raw = `vsf_live_${body}`;
  return { raw, prefix: raw.slice(0, 13), hash: await sha256Hex(raw) };
}

// ============================================================
// DELIVERY STATE
// ============================================================

export const SHIPMENT_LABEL: Record<ShipmentStatus, string> = {
  not_shipped: 'Not shipped',
  shipped: 'Shipped',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  delayed: 'Delayed',
  exception: 'Problem with delivery',
};

export type DeliveryTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface DeliveryState {
  label: string;
  tone: DeliveryTone;
  /** What the team should do next, or null when nothing is needed. */
  action: 'approve_send' | 'receive' | 'track' | null;
  isLate: boolean;
  daysLate: number;
}

const DAY_MS = 86_400_000;

/** Calendar-day difference using the local calendar (ETAs are dates, not instants). */
export function daysBetween(isoDate: string, now: Date): number {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return 0;
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - Date.UTC(y, m - 1, d)) / DAY_MS);
}

export function formatEta(isoDate: string | null, now: Date = new Date()): string {
  if (!isoDate) return 'No ETA';
  const diff = daysBetween(isoDate, now);
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const text = new Date(y, (m ?? 1) - 1, d ?? 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (diff === 0) return `Today · ${text}`;
  if (diff === -1) return `Tomorrow · ${text}`;
  if (diff > 0) return `${text} · ${diff} day${diff === 1 ? '' : 's'} late`;
  return text;
}

export function deliveryState(
  o: Pick<JobPartOrder, 'po_status' | 'shipment_status' | 'expected_at' | 'quantity_ordered' | 'quantity_received'>,
  now: Date = new Date(),
): DeliveryState {
  const fully = o.quantity_received >= o.quantity_ordered;
  const late = !!o.expected_at && daysBetween(o.expected_at, now) > 0;
  const daysLate = late && o.expected_at ? daysBetween(o.expected_at, now) : 0;
  if (o.po_status === 'cancelled') return { label: 'Cancelled', tone: 'neutral', action: null, isLate: false, daysLate: 0 };
  if (fully || o.po_status === 'received') return { label: 'Received', tone: 'success', action: null, isLate: false, daysLate: 0 };
  if (o.po_status === 'draft' || o.po_status === 'pending_approval') {
    return { label: o.po_status === 'draft' ? 'Draft — not sent yet' : 'Needs approval', tone: 'warning', action: 'approve_send', isLate: false, daysLate: 0 };
  }
  if (o.shipment_status === 'delivered') return { label: 'Delivered — receive it', tone: 'info', action: 'receive', isLate: false, daysLate: 0 };
  if (o.shipment_status === 'exception') return { label: SHIPMENT_LABEL.exception, tone: 'danger', action: 'track', isLate: late, daysLate };
  if (late || o.shipment_status === 'delayed') return { label: late ? `Late · ${daysLate} day${daysLate === 1 ? '' : 's'}` : 'Delayed', tone: 'danger', action: 'track', isLate: late, daysLate };
  if (o.po_status === 'partially_received') return { label: 'Partly received', tone: 'info', action: 'receive', isLate: false, daysLate: 0 };
  return { label: o.shipment_status === 'not_shipped' ? 'Ordered' : SHIPMENT_LABEL[o.shipment_status], tone: 'info', action: 'track', isLate: false, daysLate: 0 };
}

/** Only http(s) links are ever rendered as hrefs (defence in depth; the database checks too). */
export function safeTrackingUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

// ============================================================
// CART / ORDER SUMMARIES
// ============================================================

export interface CartGroup {
  vendorId: string;
  vendorName: string;
  lines: CartLine[];
  totalCents: number;
  unavailable: number;
}

export function lineIsOrderable(l: CartLine): boolean {
  return !!l.item && l.item.active && l.item.stock_status !== 'discontinued';
}

export function groupCartByVendor(lines: CartLine[]): CartGroup[] {
  const map = new Map<string, CartGroup>();
  for (const l of lines) {
    if (!l.item) continue;
    const g = map.get(l.item.vendor_id) ?? {
      vendorId: l.item.vendor_id, vendorName: l.item.inventory_vendors?.name ?? 'Supplier', lines: [], totalCents: 0, unavailable: 0,
    };
    g.lines.push(l);
    if (lineIsOrderable(l)) g.totalCents += l.quantity * l.item.unit_cost_cents;
    else g.unavailable += 1;
    map.set(l.item.vendor_id, g);
  }
  return [...map.values()].sort((a, b) => a.vendorName.localeCompare(b.vendorName));
}

export function stockBadge(status: StockStatus): { label: string; tone: DeliveryTone } {
  switch (status) {
    case 'in_stock': return { label: 'In stock', tone: 'success' };
    case 'low_stock': return { label: 'Low stock', tone: 'warning' };
    case 'backorder': return { label: 'Backorder', tone: 'danger' };
    case 'discontinued': return { label: 'Discontinued', tone: 'neutral' };
    default: return { label: 'Stock unknown', tone: 'neutral' };
  }
}

/** Latest open ETA across a job's orders, for the "Parts expected" headline. */
export function jobPartsHeadline(orders: JobPartOrder[], now: Date = new Date()): { open: number; eta: string | null; allReceived: boolean } {
  const open = orders.filter((o) => o.po_status !== 'cancelled' && o.quantity_received < o.quantity_ordered);
  const etas = open.map((o) => o.expected_at).filter((d): d is string => !!d).sort();
  void now;
  return { open: open.length, eta: etas.length ? etas[etas.length - 1] : null, allReceived: orders.length > 0 && open.length === 0 };
}

/** Human message for the RPC hold outcome after ordering. */
export function holdMessage(result: CreateOrdersResult): string | null {
  const held = result.jobs.filter((j) => j.hold === 'ok').length;
  if (held > 0) return `${held} job${held === 1 ? '' : 's'} moved to "Waiting on parts". It resumes automatically when the parts are received.`;
  const waiting = result.jobs.some((j) => j.hold === 'already_waiting');
  if (waiting) return 'The job is already waiting on parts; its ETA was updated.';
  const skipped = result.jobs.some((j) => j.hold === 'skipped_status');
  if (skipped) return 'The job is on hold for another reason, so its status was left as is.';
  return null;
}
