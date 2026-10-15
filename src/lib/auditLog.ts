import { supabase } from '@/lib/supabase';
import { exportToCsv, type CsvColumn } from '@/lib/csvExport';

/**
 * Owner-only audit log viewer helpers. Reads go through RLS
 * (`owner_select_audit_log`: user_id = auth.uid()); there is no client write path.
 */

export const AUDIT_PAGE_SIZE = 50;
/** Hard cap for CSV export so a huge log can't freeze the tab. */
export const AUDIT_EXPORT_CAP = 5000;
const EXPORT_BATCH = 1000;

export interface AuditLogRow {
  id: string;
  user_id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target_table: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface AuditFilters {
  /** '' = all */
  action: string;
  /** '' = all */
  targetTable: string;
  /** Case-insensitive substring of the actor email. */
  actor: string;
  /** YYYY-MM-DD, local time, inclusive. */
  from: string;
  /** YYYY-MM-DD, local time, inclusive. */
  to: string;
}

export const EMPTY_FILTERS: AuditFilters = { action: '', targetTable: '', actor: '', from: '', to: '' };

export function hasActiveFilters(f: AuditFilters): boolean {
  return Boolean(f.action || f.targetTable || f.actor.trim() || f.from || f.to);
}

const COLUMNS = 'id, user_id, actor_id, actor_email, action, target_table, target_id, metadata, created_at';

/* ------------------------------------------------------------------ */
/*  Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** Escape `%`, `_` and `\` so user input is matched literally by ILIKE. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function formatAction(action: string): string {
  const spaced = action.replace(/[_.-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : action;
}

function parseLocalDay(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Inclusive local-day range → `[gte, lt)` ISO bounds. Swaps a reversed range. */
export function dayRangeToIso(from: string, to: string): { gte?: string; lt?: string } {
  let start = parseLocalDay(from);
  let end = parseLocalDay(to);
  if (start && end && start > end) [start, end] = [end, start];
  const out: { gte?: string; lt?: string } = {};
  if (start) out.gte = start.toISOString();
  if (end) {
    const next = new Date(end);
    next.setDate(next.getDate() + 1);
    out.lt = next.toISOString();
  }
  return out;
}

const SENSITIVE_KEY = /pass(word|phrase)?|secret|token|api[_-]?key|authorization|credential|private[_-]?key/i;
export const REDACTED = '••• redacted';

/** Deep-redacts values under secret-looking keys. Depth-limited. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function formatValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

export interface DiffRow {
  field: string;
  from: string;
  to: string;
}

export type AuditDetails =
  | { kind: 'diff'; rows: DiffRow[] }
  | { kind: 'json'; json: string }
  | null;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Turns an audit row's metadata into something renderable.
 *  - `{ changes: { field: { from, to } } }`  → diff rows
 *  - `{ before: {...}, after: {...} }`       → diff rows (changed fields only)
 *  - any other non-empty object              → redacted pretty JSON
 *  - null / empty                            → null ("no change details")
 */
export function buildAuditDetails(metadata: Record<string, unknown> | null | undefined): AuditDetails {
  if (!isPlainObject(metadata) || Object.keys(metadata).length === 0) return null;
  const safe = redact(metadata) as Record<string, unknown>;

  if (isPlainObject(safe.changes)) {
    const rows: DiffRow[] = Object.entries(safe.changes).map(([field, change]) => {
      const c = isPlainObject(change) ? change : change === REDACTED ? { from: REDACTED, to: REDACTED } : {};
      return { field, from: formatValue(c.from), to: formatValue(c.to) };
    });
    if (rows.length > 0) return { kind: 'diff', rows };
  }

  if (isPlainObject(safe.before) || isPlainObject(safe.after)) {
    const before = isPlainObject(safe.before) ? safe.before : {};
    const after = isPlainObject(safe.after) ? safe.after : {};
    const fields = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
    const rows = fields
      .filter((f) => !sameValue(before[f], after[f]))
      .map((field) => ({ field, from: formatValue(before[field]), to: formatValue(after[field]) }));
    if (rows.length > 0) return { kind: 'diff', rows };
  }

  return { kind: 'json', json: JSON.stringify(safe, null, 2) };
}

/** Neutralise spreadsheet formula injection (`=`, `+`, `-`, `@`, tab, CR) in exported cells. */
export function csvSafe(value: string | null | undefined): string {
  if (!value) return '';
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function describeTarget(row: Pick<AuditLogRow, 'target_table' | 'target_id'>): string {
  if (row.target_table && row.target_id) return `${row.target_table} · ${row.target_id}`;
  return row.target_table ?? row.target_id ?? '—';
}

/* ------------------------------------------------------------------ */
/*  Queries                                                             */
/* ------------------------------------------------------------------ */

interface Filterable<T> {
  eq(column: string, value: string): T;
  ilike(column: string, pattern: string): T;
  gte(column: string, value: string): T;
  lt(column: string, value: string): T;
}

function applyFilters<T extends Filterable<T>>(query: T, f: AuditFilters): T {
  let q = query;
  if (f.action) q = q.eq('action', f.action);
  if (f.targetTable) q = q.eq('target_table', f.targetTable);
  const actor = f.actor.trim();
  if (actor) q = q.ilike('actor_email', `%${escapeLike(actor)}%`);
  const { gte, lt } = dayRangeToIso(f.from, f.to);
  if (gte) q = q.gte('created_at', gte);
  if (lt) q = q.lt('created_at', lt);
  return q;
}

export async function fetchAuditLog(opts: {
  filters: AuditFilters;
  /** Raw `created_at` of the last loaded row (keyset cursor). */
  before?: string;
  limit?: number;
}): Promise<AuditLogRow[]> {
  let q = applyFilters(supabase.from('audit_log').select(COLUMNS), opts.filters)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? AUDIT_PAGE_SIZE);
  if (opts.before) q = q.lt('created_at', opts.before);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as AuditLogRow[];
}

/** Distinct actions / target tables seen in the most recent rows, for the filter dropdowns. */
export async function fetchAuditFilterOptions(): Promise<{ actions: string[]; targetTables: string[] }> {
  const { data, error } = await supabase
    .from('audit_log')
    .select('action, target_table')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw new Error(error.message);
  const actions = new Set<string>();
  const tables = new Set<string>();
  for (const r of (data ?? []) as { action: string; target_table: string | null }[]) {
    actions.add(r.action);
    if (r.target_table) tables.add(r.target_table);
  }
  return { actions: [...actions].sort(), targetTables: [...tables].sort() };
}

const CSV_COLUMNS: CsvColumn<AuditLogRow>[] = [
  { header: 'Time (UTC)', accessor: (r) => r.created_at },
  { header: 'Action', accessor: (r) => csvSafe(r.action) },
  { header: 'Actor', accessor: (r) => csvSafe(r.actor_email) },
  { header: 'Target table', accessor: (r) => csvSafe(r.target_table) },
  { header: 'Target ID', accessor: (r) => csvSafe(r.target_id) },
  {
    header: 'Details',
    accessor: (r) => {
      const d = buildAuditDetails(r.metadata);
      if (!d) return '';
      return csvSafe(d.kind === 'diff' ? d.rows.map((x) => `${x.field}: ${x.from} -> ${x.to}`).join('; ') : d.json.replace(/\s+/g, ' '));
    },
  },
];

/** Exports every row matching the filters (up to AUDIT_EXPORT_CAP) as CSV. */
export async function exportAuditLogCsv(filters: AuditFilters): Promise<{ count: number; truncated: boolean }> {
  const rows: AuditLogRow[] = [];
  let before: string | undefined;
  while (rows.length < AUDIT_EXPORT_CAP) {
    const batch = await fetchAuditLog({ filters, before, limit: Math.min(EXPORT_BATCH, AUDIT_EXPORT_CAP - rows.length) });
    rows.push(...batch);
    if (batch.length < EXPORT_BATCH) break;
    before = batch[batch.length - 1].created_at;
  }
  const truncated = rows.length >= AUDIT_EXPORT_CAP;
  const stamp = new Date().toISOString().slice(0, 10);
  exportToCsv(rows, CSV_COLUMNS, `vireek-audit-log-${stamp}.csv`);
  return { count: rows.length, truncated };
}
