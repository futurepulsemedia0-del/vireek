import { supabase } from './supabase';
import type { CsvColumn } from './csvExport';

// ============================================================
// TYPES — mirror 20270410000000_inventory_cycle_counts.sql
// ============================================================

export type CountType = 'cycle' | 'full';
export type CountScope = 'all' | 'category' | 'selected' | 'top_value';
export type CountStatus = 'in_progress' | 'pending_approval' | 'approved' | 'cancelled';
export type CountEventType = 'started' | 'submitted' | 'returned' | 'approved' | 'cancelled';
export type StatusTone = 'neutral' | 'good' | 'warn' | 'bad';

export interface InventoryCount {
  id: string;
  /** Account OWNER's id (team members share the owner's counts). */
  user_id: string;
  count_number: string;
  name: string;
  count_type: CountType;
  scope: CountScope;
  scope_detail: string | null;
  location_id: string;
  location_name: string;
  status: CountStatus;
  blind: boolean;
  notes: string | null;
  created_by: string | null;
  created_by_name: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
  approved_at: string | null;
  approved_by: string | null;
  approval_note: string | null;
  return_note: string | null;
  line_count: number;
  counted_count: number;
  /** Variance totals are null while the count is in progress. */
  variance_line_count: number | null;
  net_variance_units: number | null;
  net_variance_value_cents: number | null;
  gross_variance_value_cents: number | null;
  accuracy_pct: number | null;
  created_at: string;
  updated_at: string;
}

/** Row from get_inventory_count_lines(); expected/variance/cost are null when masked server-side. */
export interface InventoryCountLine {
  line_id: string;
  part_id: string;
  part_name: string;
  part_number: string | null;
  category: string | null;
  expected_qty: number | null;
  counted_qty: number | null;
  variance_qty: number | null;
  unit_cost_cents: number | null;
  variance_value_cents: number | null;
  note: string | null;
  counted_at: string | null;
  added_during_count: boolean;
  applied_delta: number | null;
}

export interface InventoryCountEvent {
  id: string;
  count_id: string;
  event_type: CountEventType;
  actor_name: string | null;
  note: string | null;
  created_at: string;
}

export interface CountOptions {
  locations: { id: string; name: string; location_type: string }[];
  parts: { id: string; name: string; part_number: string | null; category: string | null }[];
  categories: string[];
}

export interface StartCountInput {
  locationId: string;
  name: string;
  countType: CountType;
  scope: CountScope;
  category?: string | null;
  partIds?: string[] | null;
  topN?: number | null;
  blind?: boolean;
  notes?: string | null;
}

export interface StartCountResult {
  count_id: string;
  line_count: number;
  skipped_locked: number;
}

export interface ScanResult {
  line_id: string;
  part_id: string;
  part_name: string;
  counted_qty: number;
  added: boolean;
}

export interface ApproveResult {
  adjusted_lines: number;
  net_units: number;
  net_value_cents: number;
}

// ============================================================
// LABELS
// ============================================================

export const COUNT_STATUS_LABELS: Record<CountStatus, string> = {
  in_progress: 'Counting',
  pending_approval: 'Awaiting approval',
  approved: 'Approved',
  cancelled: 'Cancelled',
};

export const COUNT_TYPE_LABELS: Record<CountType, string> = {
  cycle: 'Cycle count',
  full: 'Full stocktake',
};

export const COUNT_SCOPE_LABELS: Record<CountScope, string> = {
  all: 'Everything stocked here',
  category: 'One category',
  selected: 'Specific parts',
  top_value: 'Highest-value parts (ABC "A" items)',
};

export const COUNT_EVENT_LABELS: Record<CountEventType, string> = {
  started: 'Count started',
  submitted: 'Submitted for approval',
  returned: 'Returned for recount',
  approved: 'Approved — adjustments posted',
  cancelled: 'Cancelled',
};

export function countStatusTone(status: CountStatus): StatusTone {
  switch (status) {
    case 'approved':
      return 'good';
    case 'pending_approval':
      return 'warn';
    case 'cancelled':
      return 'bad';
    default:
      return 'neutral';
  }
}

// ============================================================
// PURE HELPERS (unit-tested in inventoryCounts.test.ts)
// ============================================================

export type VarianceKind = 'uncounted' | 'hidden' | 'match' | 'over' | 'short';

/** Classifies one line. `hidden` = counted, but expected qty is masked (blind count). */
export function classifyLine(line: Pick<InventoryCountLine, 'counted_qty' | 'expected_qty'>): VarianceKind {
  if (line.counted_qty === null) return 'uncounted';
  if (line.expected_qty === null) return 'hidden';
  const diff = line.counted_qty - line.expected_qty;
  if (diff === 0) return 'match';
  return diff > 0 ? 'over' : 'short';
}

export function lineVarianceQty(line: Pick<InventoryCountLine, 'counted_qty' | 'expected_qty'>): number | null {
  if (line.counted_qty === null || line.expected_qty === null) return null;
  return line.counted_qty - line.expected_qty;
}

export function formatSigned(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return '0';
}

/** Variance as a % of expected. Null when expected is 0 (undefined) or masked. */
export function variancePct(expected: number | null, counted: number | null): number | null {
  if (expected === null || counted === null || expected === 0) return null;
  return Math.round(((counted - expected) / Math.abs(expected)) * 1000) / 10;
}

export interface CountSummary {
  total: number;
  counted: number;
  uncounted: number;
  matched: number;
  over: number;
  short: number;
  varianceLines: number;
  netUnits: number;
  /** null when costs are masked for this user. */
  netValueCents: number | null;
  grossValueCents: number | null;
  /** % of counted lines that matched exactly; null when nothing is counted or expected is masked. */
  accuracyPct: number | null;
  progressPct: number;
}

export function summarizeLines(lines: InventoryCountLine[]): CountSummary {
  let counted = 0;
  let matched = 0;
  let over = 0;
  let short = 0;
  let hidden = 0;
  let netUnits = 0;
  let netValue = 0;
  let grossValue = 0;
  let costsVisible = true;

  for (const line of lines) {
    const kind = classifyLine(line);
    if (kind === 'uncounted') continue;
    counted += 1;
    if (kind === 'hidden') {
      hidden += 1;
      continue;
    }
    const diff = (line.counted_qty as number) - (line.expected_qty as number);
    if (kind === 'match') matched += 1;
    if (kind === 'over') over += 1;
    if (kind === 'short') short += 1;
    netUnits += diff;
    if (line.unit_cost_cents === null) {
      costsVisible = false;
    } else {
      netValue += diff * line.unit_cost_cents;
      grossValue += Math.abs(diff) * line.unit_cost_cents;
    }
  }

  const total = lines.length;
  const comparable = counted - hidden;
  return {
    total,
    counted,
    uncounted: total - counted,
    matched,
    over,
    short,
    varianceLines: over + short,
    netUnits,
    netValueCents: costsVisible && comparable > 0 ? netValue : null,
    grossValueCents: costsVisible && comparable > 0 ? grossValue : null,
    accuracyPct: comparable > 0 ? Math.round((matched / comparable) * 1000) / 10 : null,
    progressPct: total === 0 ? 0 : Math.round((counted / total) * 100),
  };
}

/** Biggest financial (then unit) impact first — the order a manager reviews variances in. */
export function sortByVarianceImpact(lines: InventoryCountLine[]): InventoryCountLine[] {
  const impact = (l: InventoryCountLine) => Math.abs(l.variance_value_cents ?? 0);
  const units = (l: InventoryCountLine) => Math.abs(lineVarianceQty(l) ?? 0);
  return [...lines].sort(
    (a, b) => impact(b) - impact(a) || units(b) - units(a) || a.part_name.localeCompare(b.part_name),
  );
}

export type LineFilterMode = 'all' | 'uncounted' | 'variances';

export function filterLines(
  lines: InventoryCountLine[],
  opts: { query?: string; mode?: LineFilterMode },
): InventoryCountLine[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  const mode = opts.mode ?? 'all';
  return lines.filter((l) => {
    if (q) {
      const hay = `${l.part_name} ${l.part_number ?? ''} ${l.category ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (mode === 'uncounted') return l.counted_qty === null;
    if (mode === 'variances') {
      const kind = classifyLine(l);
      return kind === 'over' || kind === 'short';
    }
    return true;
  });
}

export type ParsedQuantity = { ok: true; value: number | null } | { ok: false; error: string };

export const MAX_COUNT_QTY = 1_000_000;

/** Blank clears the line (uncounted). Otherwise a whole number 0…1,000,000. */
export function parseQuantityInput(raw: string): ParsedQuantity {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: 'Enter a whole number, 0 or more.' };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value > MAX_COUNT_QTY) {
    return { ok: false, error: `Quantity can't exceed ${MAX_COUNT_QTY.toLocaleString()}.` };
  }
  return { ok: true, value };
}

/** Strips CR/LF/tab/GS/other control chars that HID scanners append, trims, caps length. */
export function normalizeScanCode(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128);
}

/** Camera loops see the same code for many frames; ignore an identical code inside the window. */
export function shouldIgnoreRescan(
  last: { code: string; at: number } | null,
  code: string,
  now: number,
  windowMs = 1500,
): boolean {
  return !!last && last.code === code && now - last.at < windowMs;
}

/** "+$12.50" / "−$3" / "$0" — formatCents() can't show a sign cleanly. */
export function formatSignedCents(cents: number): string {
  const abs = Math.abs(cents);
  const body = `$${(abs / 100).toFixed(abs % 100 === 0 ? 0 : 2)}`;
  if (cents > 0) return `+${body}`;
  if (cents < 0) return `−${body}`;
  return body;
}

export function formatPct(n: number | null): string {
  return n === null ? '—' : `${n}%`;
}

// ============================================================
// CSV
// ============================================================

export function buildVarianceCsvColumns(showCosts: boolean): CsvColumn<InventoryCountLine>[] {
  const cols: CsvColumn<InventoryCountLine>[] = [
    { header: 'Part', accessor: (l) => l.part_name },
    { header: 'Part number', accessor: (l) => l.part_number },
    { header: 'Category', accessor: (l) => l.category },
    { header: 'Expected', accessor: (l) => l.expected_qty },
    { header: 'Counted', accessor: (l) => l.counted_qty },
    { header: 'Variance', accessor: (l) => lineVarianceQty(l) },
    { header: 'Variance %', accessor: (l) => variancePct(l.expected_qty, l.counted_qty) },
  ];
  if (showCosts) {
    cols.push(
      { header: 'Unit cost', accessor: (l) => (l.unit_cost_cents === null ? null : (l.unit_cost_cents / 100).toFixed(2)) },
      {
        header: 'Variance value',
        accessor: (l) => (l.variance_value_cents === null ? null : (l.variance_value_cents / 100).toFixed(2)),
      },
    );
  }
  cols.push(
    { header: 'Added during count', accessor: (l) => (l.added_during_count ? 'yes' : 'no') },
    { header: 'Adjustment posted', accessor: (l) => l.applied_delta },
    { header: 'Note', accessor: (l) => l.note },
  );
  return cols;
}

// ============================================================
// ERRORS
// ============================================================

interface DbErrorLike {
  code?: string;
  message?: string;
}

/** True when the RPC said "no part matches that code" (SQLSTATE P0002). */
export function isNoMatchError(err: unknown): boolean {
  return (err as DbErrorLike | null)?.code === 'P0002';
}

export function countErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const e = err as DbErrorLike | null;
  if (!e) return fallback;
  if (e.code === '42501') return e.message && !/not authorised/i.test(e.message) ? e.message : "You don't have permission to do that.";
  // P0002 no match / P0003 locked / P0004 wrong state, and our own validation messages, are written for humans.
  if (e.message && (e.code === 'P0001' || e.code === 'P0002' || e.code === 'P0003' || e.code === 'P0004')) return e.message;
  if (e.message && /Failed to fetch|NetworkError|network/i.test(e.message)) return "You're offline — check your connection and try again.";
  return fallback;
}

// ============================================================
// QUERIES
// ============================================================

export async function getInventoryCountOptions(): Promise<CountOptions> {
  const { data, error } = await supabase.rpc('inventory_count_options');
  if (error) throw error;
  const d = (data ?? {}) as Partial<CountOptions>;
  return { locations: d.locations ?? [], parts: d.parts ?? [], categories: d.categories ?? [] };
}

/** `accountOwnerId` is applied as an explicit filter on top of RLS (defence in depth). */
export async function listInventoryCounts(accountOwnerId: string, status?: CountStatus): Promise<InventoryCount[]> {
  let query = supabase
    .from('inventory_counts')
    .select('*')
    .eq('user_id', accountOwnerId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as InventoryCount[];
}

export async function getInventoryCount(accountOwnerId: string, countId: string): Promise<InventoryCount | null> {
  const { data, error } = await supabase
    .from('inventory_counts')
    .select('*')
    .eq('user_id', accountOwnerId)
    .eq('id', countId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as InventoryCount | null;
}

export async function getInventoryCountLines(countId: string): Promise<InventoryCountLine[]> {
  const { data, error } = await supabase.rpc('get_inventory_count_lines', { p_count_id: countId });
  if (error) throw error;
  return (data ?? []) as InventoryCountLine[];
}

export async function getInventoryCountEvents(accountOwnerId: string, countId: string): Promise<InventoryCountEvent[]> {
  const { data, error } = await supabase
    .from('inventory_count_events')
    .select('id, count_id, event_type, actor_name, note, created_at')
    .eq('user_id', accountOwnerId)
    .eq('count_id', countId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as InventoryCountEvent[];
}

// ============================================================
// MUTATIONS — every one is an atomic server-side RPC
// ============================================================

export async function startInventoryCount(input: StartCountInput): Promise<StartCountResult> {
  const { data, error } = await supabase.rpc('start_inventory_count', {
    p_location_id: input.locationId,
    p_name: input.name,
    p_count_type: input.countType,
    p_scope: input.scope,
    p_category: input.category ?? null,
    p_part_ids: input.partIds && input.partIds.length > 0 ? input.partIds : null,
    p_top_n: input.topN ?? null,
    p_blind: input.blind ?? false,
    p_notes: input.notes ?? null,
  });
  if (error) throw error;
  return data as StartCountResult;
}

/** Scan (barcode / part number) or +/- a known part. Atomic increment, floors at 0. */
export async function countInventoryPart(params: {
  countId: string;
  partId?: string;
  barcode?: string;
  increment?: number;
}): Promise<ScanResult> {
  const { data, error } = await supabase.rpc('count_inventory_part', {
    p_count_id: params.countId,
    p_part_id: params.partId ?? null,
    p_barcode: params.barcode ?? null,
    p_increment: params.increment ?? 1,
  });
  if (error) throw error;
  return data as ScanResult;
}

/** Sets an absolute counted quantity; `null` clears the line back to uncounted. */
export async function setInventoryCountLine(lineId: string, countedQty: number | null): Promise<void> {
  const { error } = await supabase.rpc('set_inventory_count_line', {
    p_line_id: lineId,
    p_counted_qty: countedQty,
  });
  if (error) throw error;
}

export async function setInventoryCountLineNote(lineId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('set_inventory_count_line_note', { p_line_id: lineId, p_note: note });
  if (error) throw error;
}

export async function submitInventoryCount(countId: string, allowUncounted = false): Promise<void> {
  const { error } = await supabase.rpc('submit_inventory_count', {
    p_count_id: countId,
    p_allow_uncounted: allowUncounted,
  });
  if (error) throw error;
}

export async function approveInventoryCount(countId: string, note?: string): Promise<ApproveResult> {
  const { data, error } = await supabase.rpc('approve_inventory_count', {
    p_count_id: countId,
    p_note: note?.trim() || null,
  });
  if (error) throw error;
  return data as ApproveResult;
}

export async function returnInventoryCountForRecount(countId: string, note: string, lineIds: string[] = []): Promise<void> {
  const { error } = await supabase.rpc('return_inventory_count_for_recount', {
    p_count_id: countId,
    p_note: note,
    p_line_ids: lineIds.length > 0 ? lineIds : null,
  });
  if (error) throw error;
}

export async function cancelInventoryCount(countId: string, note?: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_inventory_count', {
    p_count_id: countId,
    p_note: note?.trim() || null,
  });
  if (error) throw error;
}
