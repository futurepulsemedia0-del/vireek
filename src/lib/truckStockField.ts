// src/lib/truckStockField.ts
// Technician-side truck stock: scan-to-use, low-stock requests and returns.
//
// Local-first: the last good snapshot of the van is kept on the device and every action is
// applied to the screen immediately, queued, and replayed to the server when there is signal.
// Each action carries a client-generated operation id; the server (tech_* RPCs in
// 20270410000000_tech_truck_stock.sql) is idempotent on it, so a retry after a dead zone can
// never record the same usage twice.
//
// Everything below the "Server" banner touches the network; everything above is pure and tested.

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES — mirror get_my_truck_stock() in 20270410000000_tech_truck_stock.sql
// ============================================================

export interface TruckItem {
  part_id: string;
  name: string;
  part_number: string | null;
  barcode: string | null;
  category: string | null;
  unit_label: string | null;
  on_hand: number;
  reserved: number;
  min_quantity: number | null;
  target_quantity: number | null;
  /** Quantity already requested from the warehouse (open restock tasks). */
  requested_qty: number;
}

export interface TruckJob {
  id: string;
  customer_name: string;
  service_type: string | null;
  scheduled_datetime: string | null;
  job_status: string;
}

export interface TruckVendor {
  id: string;
  name: string;
}

export interface CatalogPart {
  id: string;
  name: string;
  part_number: string | null;
  barcode: string | null;
}

export interface TruckSnapshot {
  technician_id: string;
  location: { id: string; name: string };
  items: TruckItem[];
  jobs: TruckJob[];
  vendors: TruckVendor[];
  catalog: CatalogPart[];
  /** ISO timestamp from the server. */
  generated_at: string;
}

export type SnapshotBlock = 'not_a_technician' | 'no_truck';
export type SnapshotResult =
  | { ok: true; snapshot: TruckSnapshot }
  | { ok: false; reason: SnapshotBlock | 'network' | 'error'; message: string };

export type ReturnKind = 'unused' | 'to_warehouse' | 'core';
export type OpKind = 'use' | 'request' | 'return';
export type OpState = 'pending' | 'failed';

export interface QueuedOp {
  id: string;
  kind: OpKind;
  part_id: string;
  part_name: string;
  quantity: number;
  job_id: string | null;
  note: string | null;
  return_kind: ReturnKind | null;
  vendor_id: string | null;
  created_at: number;
  state: OpState;
  attempts: number;
  last_error: string | null;
}

export type NewOp = Pick<QueuedOp, 'kind' | 'part_id' | 'part_name' | 'quantity'> &
  Partial<Pick<QueuedOp, 'job_id' | 'note' | 'return_kind' | 'vendor_id'>>;

export type StockLevel = 'ok' | 'low' | 'empty';

// ============================================================
// PURE HELPERS
// ============================================================

export const MAX_QUANTITY = 999;

/** What the technician can actually grab: on hand minus anything reserved for jobs. */
export const availableQty = (item: Pick<TruckItem, 'on_hand' | 'reserved'>): number => item.on_hand - item.reserved;

/** Same rule as the truck_stock_status SQL view: empty at 0, low at/below the par minimum. */
export function stockLevel(item: TruckItem): StockLevel {
  const avail = availableQty(item);
  if (avail <= 0) return 'empty';
  if (item.min_quantity !== null && avail <= item.min_quantity) return 'low';
  return 'ok';
}

/** Units needed to get back to the par target (0 when there is no target). */
export function refillQty(item: TruckItem): number {
  if (item.target_quantity === null) return 0;
  return Math.max(item.target_quantity - availableQty(item), 0);
}

/** A sensible default for "how many should I ask for": top up to target, else at least one. */
export function suggestedRequestQty(item: TruckItem): number {
  const gap = refillQty(item) - item.requested_qty;
  return Math.min(Math.max(gap, 1), MAX_QUANTITY);
}

const LEVEL_RANK: Record<StockLevel, number> = { empty: 0, low: 1, ok: 2 };

/** Empty first, then low, then the rest; alphabetical inside each group. */
export function sortItems(items: TruckItem[]): TruckItem[] {
  return [...items].sort(
    (a, b) => LEVEL_RANK[stockLevel(a)] - LEVEL_RANK[stockLevel(b)] || a.name.localeCompare(b.name),
  );
}

export type ItemFilter = 'all' | 'restock' | 'requested';

export function filterItems(items: TruckItem[], query: string, filter: ItemFilter): TruckItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((i) => {
    if (filter === 'restock' && stockLevel(i) === 'ok') return false;
    if (filter === 'requested' && i.requested_qty <= 0) return false;
    if (!q) return true;
    return [i.name, i.part_number, i.barcode, i.category].some((v) => v?.toLowerCase().includes(q));
  });
}

// ------------------------------------------------------------
// Barcode matching
// ------------------------------------------------------------

/** Scanners (and keyboard-wedge devices) append CR/LF and sometimes stray whitespace. */
export function cleanScan(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

/**
 * Comparison key. Alphanumerics only, case-insensitive, and for all-digit codes the leading zeros are
 * ignored — so a UPC-A (012345678905) printed on the box matches the EAN-13 (0012345678905) a scanner
 * reports for the same product, and "CAP-45/5" matches "cap 45 5".
 */
export function codeKey(raw: string): string {
  const alnum = cleanScan(raw).replace(/[^0-9a-z]/gi, '').toUpperCase();
  return /^\d+$/.test(alnum) ? alnum.replace(/^0+(?=\d)/, '') : alnum;
}

export type ScanMatch =
  | { kind: 'on_truck'; item: TruckItem }
  | { kind: 'catalog'; part: CatalogPart }
  | { kind: 'unknown'; code: string };

/** Barcode beats part number; the van's own stock beats the wider catalog. */
export function findPartByCode(snapshot: Pick<TruckSnapshot, 'items' | 'catalog'>, raw: string): ScanMatch {
  const code = cleanScan(raw);
  const key = codeKey(code);
  if (!key) return { kind: 'unknown', code };

  const byBarcode = <T extends { barcode: string | null }>(rows: T[]) => rows.find((r) => r.barcode && codeKey(r.barcode) === key);
  const byNumber = <T extends { part_number: string | null }>(rows: T[]) =>
    rows.find((r) => r.part_number && codeKey(r.part_number) === key);

  const onTruck = byBarcode(snapshot.items) ?? byNumber(snapshot.items);
  if (onTruck) return { kind: 'on_truck', item: onTruck };
  const inCatalog = byBarcode(snapshot.catalog) ?? byNumber(snapshot.catalog);
  if (inCatalog) {
    // The part exists in the catalog; if the van already carries it, prefer the van row.
    const onVan = snapshot.items.find((i) => i.part_id === inCatalog.id);
    return onVan ? { kind: 'on_truck', item: onVan } : { kind: 'catalog', part: inCatalog };
  }
  return { kind: 'unknown', code };
}

// ------------------------------------------------------------
// Optimistic view of the van = last server snapshot + operations not yet delivered
// ------------------------------------------------------------

/** Pure: never mutates the input. Failed operations are NOT applied (the server rejected them). */
export function applyOps(snapshot: TruckSnapshot, ops: QueuedOp[]): TruckSnapshot {
  const items = new Map(snapshot.items.map((i) => [i.part_id, { ...i }]));
  const catalog = new Map(snapshot.catalog.map((c) => [c.id, c]));

  const ensure = (op: QueuedOp): TruckItem => {
    let item = items.get(op.part_id);
    if (!item) {
      const c = catalog.get(op.part_id);
      item = {
        part_id: op.part_id,
        name: c?.name ?? op.part_name,
        part_number: c?.part_number ?? null,
        barcode: c?.barcode ?? null,
        category: null,
        unit_label: null,
        on_hand: 0,
        reserved: 0,
        min_quantity: null,
        target_quantity: null,
        requested_qty: 0,
      };
      items.set(op.part_id, item);
    }
    return item;
  };

  for (const op of ops) {
    if (op.state !== 'pending') continue;
    const item = ensure(op);
    if (op.kind === 'use') item.on_hand -= op.quantity;
    else if (op.kind === 'request') item.requested_qty = Math.max(item.requested_qty, op.quantity);
    else if (op.return_kind === 'unused') item.on_hand += op.quantity;
    else if (op.return_kind === 'to_warehouse') item.on_hand -= op.quantity;
    // 'core': the old unit leaves, van stock is unchanged.
  }
  return { ...snapshot, items: [...items.values()] };
}

/** A catalog part the van does not carry yet, shaped like a van row (zero stock, no par level). */
export function itemFromCatalog(part: CatalogPart): TruckItem {
  return {
    part_id: part.id,
    name: part.name,
    part_number: part.part_number,
    barcode: part.barcode,
    category: null,
    unit_label: null,
    on_hand: 0,
    reserved: 0,
    min_quantity: null,
    target_quantity: null,
    requested_qty: 0,
  };
}

export function describeOp(op: QueuedOp): string {
  const n = op.quantity;
  if (op.kind === 'use') return `Used ${n} × ${op.part_name}`;
  if (op.kind === 'request') return `Restock request: ${n} × ${op.part_name}`;
  if (op.return_kind === 'to_warehouse') return `Return to warehouse: ${n} × ${op.part_name}`;
  if (op.return_kind === 'core') return `Core return to vendor: ${n} × ${op.part_name}`;
  return `Put back on truck: ${n} × ${op.part_name}`;
}

// ------------------------------------------------------------
// Server result handling
// ------------------------------------------------------------

const STATUS_MESSAGES: Record<string, string> = {
  not_a_technician: 'Only technicians can record truck stock.',
  no_truck: 'No truck is assigned to you yet. Ask the office to assign one.',
  invalid_quantity: 'That quantity is not valid.',
  invalid_kind: 'That return type is not valid.',
  part_not_found: 'That part is no longer in the catalog.',
  job_not_found: 'That job is not assigned to you.',
  no_source: 'The office has no warehouse set up to restock from.',
  no_warehouse: 'The office has no warehouse set up to return to.',
  insufficient_stock: 'The truck shows less than that — fix the count with the office first.',
  vendor_required: 'Pick the vendor this core goes back to.',
};

export function describeStatus(status: string): string {
  return STATUS_MESSAGES[status] ?? 'The server could not record this.';
}

export function isNetworkError(message: string): boolean {
  return /failed to fetch|networkerror|network request|load failed|timed? ?out|offline|fetch|abort/i.test(message);
}

/** Auth problems are not the technician's fault and not final: keep the op and wait for sign-in. */
export function isAuthError(message: string, code?: string): boolean {
  return code === 'PGRST301' || code === '401' || /jwt|not authenticated|invalid claim|expired/i.test(message);
}

export const MAX_ATTEMPTS = 5;

export interface OpOutcome {
  type: 'applied' | 'rejected' | 'retry' | 'offline';
  status?: string;
  message?: string;
  detail?: Record<string, unknown>;
}

/** Pure: map an RPC response to what the queue should do with the operation. */
export function interpretResponse(
  data: unknown,
  error: { message: string; code?: string } | null,
  attempts: number,
): OpOutcome {
  if (error) {
    if (isNetworkError(error.message) || isAuthError(error.message, error.code)) {
      return { type: 'offline', message: error.message };
    }
    // Server-side/programming error (e.g. migration not applied yet): retry a few times, then park it.
    return attempts + 1 >= MAX_ATTEMPTS
      ? { type: 'rejected', status: 'error', message: error.message }
      : { type: 'retry', message: error.message };
  }
  const result = (data ?? {}) as { status?: string } & Record<string, unknown>;
  if (result.status === 'applied') return { type: 'applied', status: 'applied', detail: result };
  const status = typeof result.status === 'string' ? result.status : 'error';
  return { type: 'rejected', status, message: describeStatus(status), detail: result };
}

// ------------------------------------------------------------
// Parsing: server data is untrusted until normalized
// ------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];

export function parseSnapshot(raw: unknown): TruckSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const loc = r.location as Record<string, unknown> | undefined;
  const technicianId = str(r.technician_id);
  const locId = str(loc?.id);
  if (!technicianId || !locId) return null;

  const items: TruckItem[] = [];
  for (const i of arr(r.items)) {
    const id = str(i.part_id);
    const name = str(i.name);
    if (!id || !name) continue;
    items.push({
      part_id: id,
      name,
      part_number: str(i.part_number),
      barcode: str(i.barcode),
      category: str(i.category),
      unit_label: str(i.unit_label),
      on_hand: num(i.on_hand),
      reserved: Math.max(num(i.reserved), 0),
      min_quantity: numOrNull(i.min_quantity),
      target_quantity: numOrNull(i.target_quantity),
      requested_qty: Math.max(num(i.requested_qty), 0),
    });
  }

  const jobs: TruckJob[] = arr(r.jobs).flatMap((j) => {
    const id = str(j.id);
    const customer = str(j.customer_name);
    return id && customer
      ? [{ id, customer_name: customer, service_type: str(j.service_type), scheduled_datetime: str(j.scheduled_datetime), job_status: str(j.job_status) ?? 'scheduled' }]
      : [];
  });
  const vendors: TruckVendor[] = arr(r.vendors).flatMap((v) => {
    const id = str(v.id);
    const name = str(v.name);
    return id && name ? [{ id, name }] : [];
  });
  const catalog: CatalogPart[] = arr(r.catalog).flatMap((c) => {
    const id = str(c.id);
    const name = str(c.name);
    return id && name ? [{ id, name, part_number: str(c.part_number), barcode: str(c.barcode) }] : [];
  });

  return {
    technician_id: technicianId,
    location: { id: locId, name: str(loc?.name) ?? 'My truck' },
    items,
    jobs,
    vendors,
    catalog,
    generated_at: str(r.generated_at) ?? new Date().toISOString(),
  };
}

// ============================================================
// DEVICE STORAGE (snapshot + queue), scoped per signed-in user
// ============================================================

const KEY = (userId: string, what: 'snapshot' | 'queue') => `vk:truck-stock:v1:${userId}:${what}`;

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // storage full / blocked: the app keeps working from memory
  }
}

export const loadCachedSnapshot = (userId: string): TruckSnapshot | null => parseSnapshot(readJson(KEY(userId, 'snapshot')));
export const saveCachedSnapshot = (userId: string, s: TruckSnapshot): boolean => writeJson(KEY(userId, 'snapshot'), s);

function parseOp(raw: unknown): QueuedOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== 'use' && kind !== 'request' && kind !== 'return') return null;
  const id = str(o.id);
  const partId = str(o.part_id);
  const quantity = num(o.quantity);
  if (!id || !partId || quantity <= 0) return null;
  const rk = o.return_kind;
  return {
    id,
    kind,
    part_id: partId,
    part_name: str(o.part_name) ?? 'Part',
    quantity,
    job_id: str(o.job_id),
    note: str(o.note),
    return_kind: rk === 'unused' || rk === 'to_warehouse' || rk === 'core' ? rk : null,
    vendor_id: str(o.vendor_id),
    created_at: num(o.created_at, Date.now()),
    state: o.state === 'failed' ? 'failed' : 'pending',
    attempts: Math.max(num(o.attempts), 0),
    last_error: str(o.last_error),
  };
}

export function loadQueue(userId: string): QueuedOp[] {
  const raw = readJson(KEY(userId, 'queue'));
  if (!Array.isArray(raw)) return [];
  return raw.map(parseOp).filter((o): o is QueuedOp => o !== null).sort((a, b) => a.created_at - b.created_at);
}

const queueListeners = new Set<() => void>();
export const subscribeQueue = (cb: () => void): (() => void) => {
  queueListeners.add(cb);
  return () => queueListeners.delete(cb);
};

/** Synchronous read-modify-write: atomic within a tab, so concurrent enqueue/flush never lose an op. */
export function mutateQueue(userId: string, fn: (ops: QueuedOp[]) => QueuedOp[]): QueuedOp[] {
  const next = fn(loadQueue(userId));
  writeJson(KEY(userId, 'queue'), next);
  queueListeners.forEach((l) => l());
  return next;
}

export function newOpId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  // RFC 4122 v4 fallback for very old WebViews.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Validates, stamps and stores a new action. Returns the stored op. */
export function enqueueOp(userId: string, input: NewOp, now = Date.now()): QueuedOp {
  const quantity = Math.trunc(input.quantity);
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > MAX_QUANTITY) throw new Error('Enter a quantity between 1 and 999.');
  if (input.kind === 'return' && !input.return_kind) throw new Error('Choose what kind of return this is.');
  const op: QueuedOp = {
    id: newOpId(),
    kind: input.kind,
    part_id: input.part_id,
    part_name: input.part_name,
    quantity,
    job_id: input.job_id ?? null,
    note: input.note?.trim() ? input.note.trim().slice(0, 500) : null,
    return_kind: input.kind === 'return' ? (input.return_kind ?? null) : null,
    vendor_id: input.return_kind === 'core' ? (input.vendor_id ?? null) : null,
    created_at: now,
    state: 'pending',
    attempts: 0,
    last_error: null,
  };
  mutateQueue(userId, (ops) => [...ops, op]);
  return op;
}

export const discardOp = (userId: string, id: string): void => void mutateQueue(userId, (ops) => ops.filter((o) => o.id !== id));
export const retryOp = (userId: string, id: string): void =>
  void mutateQueue(userId, (ops) => ops.map((o) => (o.id === id ? { ...o, state: 'pending', attempts: 0, last_error: null } : o)));

// ============================================================
// Server — network calls
// ============================================================

export async function fetchTruckSnapshot(): Promise<SnapshotResult> {
  try {
    const { data, error } = await supabase.rpc('get_my_truck_stock');
    if (error) {
      return { ok: false, reason: isNetworkError(error.message) ? 'network' : 'error', message: error.message };
    }
    const blocked = (data as { error?: string } | null)?.error;
    if (blocked === 'not_a_technician' || blocked === 'no_truck') {
      return { ok: false, reason: blocked, message: describeStatus(blocked) };
    }
    const snapshot = parseSnapshot(data);
    if (!snapshot) return { ok: false, reason: 'error', message: 'The server sent stock data this app could not read.' };
    return { ok: true, snapshot };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not load truck stock.';
    return { ok: false, reason: isNetworkError(message) ? 'network' : 'error', message };
  }
}

async function sendOp(op: QueuedOp): Promise<OpOutcome> {
  try {
    const common = { p_op_id: op.id, p_part_id: op.part_id, p_quantity: op.quantity, p_job_id: op.job_id };
    const { data, error } =
      op.kind === 'use'
        ? await supabase.rpc('tech_use_part', { ...common, p_note: op.note })
        : op.kind === 'request'
          ? await supabase.rpc('tech_request_restock', { ...common, p_note: op.note })
          : await supabase.rpc('tech_return_part', { ...common, p_kind: op.return_kind, p_reason: op.note, p_vendor_id: op.vendor_id });
    return interpretResponse(data, error, op.attempts);
  } catch (e) {
    return { type: 'offline', message: e instanceof Error ? e.message : 'offline' };
  }
}

export interface FlushSummary {
  applied: QueuedOp[];
  failed: number;
  remaining: number;
  offline: boolean;
}

let flushing = false;

/**
 * Replays pending operations in the order they happened (a "use" then an "undo" must not swap).
 * Stops at the first network/auth failure; keeps retryable errors for next time; parks rejected ones
 * as 'failed' so the technician sees them instead of silently losing field data.
 */
export async function flushQueue(userId: string): Promise<FlushSummary> {
  const empty: FlushSummary = { applied: [], failed: 0, remaining: 0, offline: false };
  if (flushing || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return { ...empty, remaining: loadQueue(userId).filter((o) => o.state === 'pending').length, offline: navigator.onLine === false };
  }
  flushing = true;
  try {
    const run = async (): Promise<FlushSummary> => {
      const summary = { ...empty, applied: [] as QueuedOp[] };
      for (const op of loadQueue(userId).filter((o) => o.state === 'pending')) {
        const outcome = await sendOp(op);
        if (outcome.type === 'offline') {
          summary.offline = true;
          break;
        }
        if (outcome.type === 'applied') {
          summary.applied.push(op);
          mutateQueue(userId, (ops) => ops.filter((o) => o.id !== op.id));
        } else if (outcome.type === 'rejected') {
          summary.failed += 1;
          mutateQueue(userId, (ops) =>
            ops.map((o) => (o.id === op.id ? { ...o, state: 'failed', attempts: o.attempts + 1, last_error: outcome.message ?? 'Rejected' } : o)),
          );
        } else {
          mutateQueue(userId, (ops) =>
            ops.map((o) => (o.id === op.id ? { ...o, attempts: o.attempts + 1, last_error: outcome.message ?? null } : o)),
          );
        }
      }
      summary.remaining = loadQueue(userId).filter((o) => o.state === 'pending').length;
      return summary;
    };
    // One flusher across all open tabs (they share the same queue in storage).
    if (typeof navigator !== 'undefined' && navigator.locks) {
      let result: FlushSummary = empty;
      await navigator.locks.request('vireek-truck-stock-flush', { ifAvailable: true }, async (lock) => {
        if (lock) result = await run();
      });
      return result;
    }
    return await run();
  } finally {
    flushing = false;
  }
}

// ============================================================
// Display helpers
// ============================================================

export function formatAgo(from: number | null, now = Date.now()): string {
  if (from === null) return 'never';
  const s = Math.max(Math.round((now - from) / 1000), 0);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
