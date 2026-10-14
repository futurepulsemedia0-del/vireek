// supabase/functions/_shared/exports/engine.ts
//
// Vireek Data Exports: pure, deterministic, NO I/O, NO dependencies.
//
//   dataset registry  -> request validation -> query filters
//   rows              -> CSV | XLSX | PDF bytes
//
// This single file is imported by BOTH the `export-run` edge function (Deno)
// and the React client (labels / formats) and the unit tests, so it must stay
// self-contained (no relative imports, no Deno or DOM APIs).
//
// Integrity rules:
//   1. Only datasets registered in EXPORT_DATASETS can be exported. A client
//      can never name a table or a column.
//   2. Every column an export can contain is declared here. Large/sensitive
//      free-text blobs (e.g. call transcripts) are deliberately NOT exported.
//   3. CSV cells that could be interpreted as spreadsheet formulas are
//      neutralised (CSV-injection hardening). XLSX uses inline strings, which
//      Excel never evaluates.
//   4. Row caps are enforced per format so one request cannot exhaust an edge
//      function's memory; truncation is always reported, never silent.

// ============================================================
// TYPES & CONSTANTS
// ============================================================

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';
export type ExportDatasetId = 'calls' | 'leads' | 'customers' | 'jobs' | 'invoices';
export type ExportColumnType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'bool' | 'list';
export type ExportCell = string | number | null;

export const EXPORT_FORMATS: ExportFormat[] = ['csv', 'xlsx', 'pdf'];

export const FORMAT_LABEL: Record<ExportFormat, string> = {
  csv: 'CSV',
  xlsx: 'Excel (XLSX)',
  pdf: 'PDF',
};

export const FORMAT_MIME: Record<ExportFormat, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

/** Max rows per export, by format (memory safety inside an edge function). */
export const FORMAT_ROW_CAP: Record<ExportFormat, number> = {
  csv: 50_000,
  xlsx: 25_000,
  pdf: 2_000,
};

export const EXPORT_PAGE_SIZE = 1_000;
export const FILE_RETENTION_DAYS = 7;
export const SIGNED_URL_TTL_SECONDS = 600; // 10 minutes
export const STALE_PROCESSING_MINUTES = 15;
export const MAX_SEARCH_LENGTH = 100;

export interface ExportFilters {
  /** YYYY-MM-DD, inclusive (UTC). */
  dateFrom?: string;
  /** YYYY-MM-DD, inclusive (UTC). */
  dateTo?: string;
  /** Exact value of the dataset's status column. */
  status?: string;
  /** Free-text search over the dataset's searchable columns. */
  search?: string;
}

export interface ExportRequest {
  dataset: ExportDatasetId;
  format: ExportFormat;
  filters: ExportFilters;
}

export interface ExportColumn {
  key: string;
  header: string;
  type: ExportColumnType;
  /** Relative width weight (PDF column sizing, XLSX char width). */
  width: number;
  /** Computed column; receives the raw DB row. */
  get?: (row: Record<string, unknown>) => unknown;
}

export interface ExportDatasetDef {
  id: ExportDatasetId;
  label: string;
  description: string;
  table: string;
  /** Explicit column list for the PostgREST select (never `*`). */
  select: string;
  /** Timestamptz column used for the date range + ordering. */
  dateColumn: string;
  dateLabel: string;
  statusColumn: string;
  statusValues: string[];
  searchColumns: string[];
  columns: ExportColumn[];
}

// ============================================================
// DATASET REGISTRY  (add a table here = it becomes exportable)
// ============================================================

interface LineItem {
  quantity?: unknown;
  unit_price_cents?: unknown;
}

function invoiceTotals(row: Record<string, unknown>) {
  const items = Array.isArray(row.line_items) ? (row.line_items as LineItem[]) : [];
  const subtotalCents = items.reduce(
    (sum, li) => sum + (Number(li?.quantity) || 0) * (Number(li?.unit_price_cents) || 0),
    0,
  );
  const taxCents = Math.round((subtotalCents * (Number(row.tax_percent) || 0)) / 100);
  return { subtotal: subtotalCents / 100, tax: taxCents / 100, total: (subtotalCents + taxCents) / 100 };
}

export const EXPORT_DATASETS: Record<ExportDatasetId, ExportDatasetDef> = {
  calls: {
    id: 'calls',
    label: 'Call history',
    description: 'Every call handled by your AI receptionist, with outcome and scoring.',
    table: 'calls',
    select:
      'id, call_datetime, caller_name, caller_phone, status, duration_seconds, sentiment, is_emergency, lead_source, intent, call_score, lead_score, booking_outcome, summary, tags',
    dateColumn: 'call_datetime',
    dateLabel: 'Call date',
    statusColumn: 'status',
    statusValues: ['new_lead', 'booked', 'missed', 'callback_requested', 'spam'],
    searchColumns: ['caller_name', 'caller_phone', 'summary'],
    columns: [
      { key: 'call_datetime', header: 'Call time', type: 'datetime', width: 14 },
      { key: 'caller_name', header: 'Caller', type: 'text', width: 14 },
      { key: 'caller_phone', header: 'Phone', type: 'text', width: 13 },
      { key: 'status', header: 'Status', type: 'text', width: 12 },
      { key: 'duration_seconds', header: 'Duration (s)', type: 'number', width: 8 },
      { key: 'sentiment', header: 'Sentiment', type: 'text', width: 9 },
      { key: 'is_emergency', header: 'Emergency', type: 'bool', width: 8 },
      { key: 'lead_source', header: 'Source', type: 'text', width: 11 },
      { key: 'intent', header: 'Intent', type: 'text', width: 12 },
      { key: 'call_score', header: 'Call score', type: 'number', width: 7 },
      { key: 'lead_score', header: 'Lead score', type: 'number', width: 7 },
      { key: 'booking_outcome', header: 'Booking outcome', type: 'text', width: 12 },
      { key: 'summary', header: 'Summary', type: 'text', width: 34 },
      { key: 'tags', header: 'Tags', type: 'list', width: 12 },
    ],
  },
  leads: {
    id: 'leads',
    label: 'Leads',
    description: 'Leads captured from calls and channels, with pipeline stage and quotes.',
    table: 'leads',
    select:
      'id, name, phone, email, service_interested, stage, quote_amount, follow_up_count, tags, notes, created_at',
    dateColumn: 'created_at',
    dateLabel: 'Created',
    statusColumn: 'stage',
    statusValues: ['new', 'contacted', 'quoted', 'won', 'lost'],
    searchColumns: ['name', 'phone', 'email', 'service_interested'],
    columns: [
      { key: 'created_at', header: 'Created', type: 'datetime', width: 14 },
      { key: 'name', header: 'Name', type: 'text', width: 16 },
      { key: 'phone', header: 'Phone', type: 'text', width: 13 },
      { key: 'email', header: 'Email', type: 'text', width: 20 },
      { key: 'service_interested', header: 'Service', type: 'text', width: 16 },
      { key: 'stage', header: 'Stage', type: 'text', width: 9 },
      { key: 'quote_amount', header: 'Quote amount', type: 'money', width: 10 },
      { key: 'follow_up_count', header: 'Follow-ups', type: 'number', width: 8 },
      { key: 'tags', header: 'Tags', type: 'list', width: 12 },
      { key: 'notes', header: 'Notes', type: 'text', width: 28 },
    ],
  },
  customers: {
    id: 'customers',
    label: 'Customers',
    description: 'Your customer book: contact details, lifecycle stage and tags.',
    table: 'customers',
    select:
      'id, name, phone, email, address, customer_type, lifecycle_stage, source, tags, last_contacted_at, notes, created_at',
    dateColumn: 'created_at',
    dateLabel: 'Created',
    statusColumn: 'lifecycle_stage',
    statusValues: ['lead', 'active', 'vip', 'inactive'],
    searchColumns: ['name', 'phone', 'email', 'address'],
    columns: [
      { key: 'created_at', header: 'Created', type: 'datetime', width: 14 },
      { key: 'name', header: 'Name', type: 'text', width: 16 },
      { key: 'phone', header: 'Phone', type: 'text', width: 13 },
      { key: 'email', header: 'Email', type: 'text', width: 20 },
      { key: 'address', header: 'Address', type: 'text', width: 24 },
      { key: 'customer_type', header: 'Type', type: 'text', width: 10 },
      { key: 'lifecycle_stage', header: 'Lifecycle', type: 'text', width: 10 },
      { key: 'source', header: 'Source', type: 'text', width: 9 },
      { key: 'last_contacted_at', header: 'Last contacted', type: 'datetime', width: 14 },
      { key: 'tags', header: 'Tags', type: 'list', width: 12 },
      { key: 'notes', header: 'Notes', type: 'text', width: 26 },
    ],
  },
  jobs: {
    id: 'jobs',
    label: 'Jobs',
    description: 'Scheduled and completed jobs with status and invoice state.',
    table: 'jobs',
    select:
      'id, customer_name, customer_phone, service_type, address, scheduled_datetime, duration_minutes, job_status, invoice_amount, invoice_status, tags, created_at',
    dateColumn: 'created_at',
    dateLabel: 'Created',
    statusColumn: 'job_status',
    statusValues: ['scheduled', 'en_route', 'in_progress', 'completed', 'cancelled', 'no_show'],
    searchColumns: ['customer_name', 'customer_phone', 'service_type', 'address'],
    columns: [
      { key: 'scheduled_datetime', header: 'Scheduled', type: 'datetime', width: 14 },
      { key: 'customer_name', header: 'Customer', type: 'text', width: 16 },
      { key: 'customer_phone', header: 'Phone', type: 'text', width: 13 },
      { key: 'service_type', header: 'Service', type: 'text', width: 16 },
      { key: 'address', header: 'Address', type: 'text', width: 24 },
      { key: 'job_status', header: 'Status', type: 'text', width: 10 },
      { key: 'duration_minutes', header: 'Duration (min)', type: 'number', width: 9 },
      { key: 'invoice_amount', header: 'Invoice amount', type: 'money', width: 10 },
      { key: 'invoice_status', header: 'Invoice status', type: 'text', width: 10 },
      { key: 'tags', header: 'Tags', type: 'list', width: 12 },
      { key: 'created_at', header: 'Created', type: 'datetime', width: 14 },
    ],
  },
  invoices: {
    id: 'invoices',
    label: 'Invoices',
    description: 'Invoices with computed subtotal, tax and total, plus payment status.',
    table: 'invoices',
    select:
      'id, invoice_number, customer_name, customer_email, status, due_date, sent_at, paid_at, payment_method, line_items, tax_percent, created_at',
    dateColumn: 'created_at',
    dateLabel: 'Created',
    statusColumn: 'status',
    statusValues: ['draft', 'sent', 'viewed', 'paid', 'void'],
    searchColumns: ['customer_name', 'invoice_number', 'customer_email'],
    columns: [
      { key: 'invoice_number', header: 'Invoice #', type: 'text', width: 11 },
      { key: 'created_at', header: 'Created', type: 'datetime', width: 14 },
      { key: 'customer_name', header: 'Customer', type: 'text', width: 18 },
      { key: 'customer_email', header: 'Email', type: 'text', width: 20 },
      { key: 'status', header: 'Status', type: 'text', width: 8 },
      { key: 'due_date', header: 'Due date', type: 'date', width: 11 },
      { key: 'subtotal', header: 'Subtotal', type: 'money', width: 10, get: (r) => invoiceTotals(r).subtotal },
      { key: 'tax', header: 'Tax', type: 'money', width: 8, get: (r) => invoiceTotals(r).tax },
      { key: 'total', header: 'Total', type: 'money', width: 10, get: (r) => invoiceTotals(r).total },
      { key: 'sent_at', header: 'Sent', type: 'datetime', width: 14 },
      { key: 'paid_at', header: 'Paid', type: 'datetime', width: 14 },
      { key: 'payment_method', header: 'Payment method', type: 'text', width: 14 },
    ],
  },
};

export const EXPORT_DATASET_LIST: ExportDatasetDef[] = Object.values(EXPORT_DATASETS);

export function isExportDatasetId(v: unknown): v is ExportDatasetId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(EXPORT_DATASETS, v);
}

export function isExportFormat(v: unknown): v is ExportFormat {
  return v === 'csv' || v === 'xlsx' || v === 'pdf';
}

// ============================================================
// REQUEST VALIDATION
// ============================================================

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function isValidYmd(s: string): boolean {
  if (!YMD.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Strip characters that could break a PostgREST `or(...)` filter string. */
export function sanitizeSearch(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[,()*%\\"':;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEARCH_LENGTH);
}

export type ValidationResult =
  | { ok: true; value: ExportRequest }
  | { ok: false; error: string };

export function validateExportRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Request body must be a JSON object.' };
  const b = body as Record<string, unknown>;

  if (!isExportDatasetId(b.dataset)) return { ok: false, error: 'Unknown dataset.' };
  if (!isExportFormat(b.format)) return { ok: false, error: 'Format must be csv, xlsx or pdf.' };

  const def = EXPORT_DATASETS[b.dataset];
  const f = (b.filters && typeof b.filters === 'object' ? b.filters : {}) as Record<string, unknown>;
  const filters: ExportFilters = {};

  if (f.dateFrom !== undefined && f.dateFrom !== null && f.dateFrom !== '') {
    if (typeof f.dateFrom !== 'string' || !isValidYmd(f.dateFrom)) {
      return { ok: false, error: '“From” date must be a valid YYYY-MM-DD date.' };
    }
    filters.dateFrom = f.dateFrom;
  }
  if (f.dateTo !== undefined && f.dateTo !== null && f.dateTo !== '') {
    if (typeof f.dateTo !== 'string' || !isValidYmd(f.dateTo)) {
      return { ok: false, error: '“To” date must be a valid YYYY-MM-DD date.' };
    }
    filters.dateTo = f.dateTo;
  }
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    return { ok: false, error: '“From” date must be on or before the “To” date.' };
  }

  if (f.status !== undefined && f.status !== null && f.status !== '' && f.status !== 'all') {
    if (typeof f.status !== 'string' || !def.statusValues.includes(f.status)) {
      return { ok: false, error: `Invalid status for ${def.label.toLowerCase()}.` };
    }
    filters.status = f.status;
  }

  if (typeof f.search === 'string') {
    const s = sanitizeSearch(f.search);
    if (s) filters.search = s;
  }

  return { ok: true, value: { dataset: b.dataset, format: b.format, filters } };
}

// ============================================================
// QUERY FILTERS  (structural, so it is testable without supabase-js)
// ============================================================

export interface FilterableQuery {
  eq(column: string, value: unknown): FilterableQuery;
  gte(column: string, value: unknown): FilterableQuery;
  lte(column: string, value: unknown): FilterableQuery;
  or(filters: string): FilterableQuery;
}

/**
 * Applies tenant scope + user filters. `ownerId` is the ACCOUNT OWNER id and
 * is always applied explicitly, on top of RLS (defence in depth).
 */
export function applyExportFilters(
  query: FilterableQuery,
  def: ExportDatasetDef,
  filters: ExportFilters,
  ownerId: string,
): FilterableQuery {
  let q = query.eq('user_id', ownerId);
  if (filters.dateFrom) q = q.gte(def.dateColumn, `${filters.dateFrom}T00:00:00.000Z`);
  if (filters.dateTo) q = q.lte(def.dateColumn, `${filters.dateTo}T23:59:59.999Z`);
  if (filters.status) q = q.eq(def.statusColumn, filters.status);
  if (filters.search) {
    const term = `%${filters.search}%`;
    q = q.or(def.searchColumns.map((c) => `${c}.ilike.${term}`).join(','));
  }
  return q;
}

export function describeFilters(def: ExportDatasetDef, f: ExportFilters): string {
  const parts: string[] = [];
  if (f.dateFrom || f.dateTo) parts.push(`${def.dateLabel}: ${f.dateFrom ?? '…'} to ${f.dateTo ?? '…'}`);
  if (f.status) parts.push(`Status: ${f.status}`);
  if (f.search) parts.push(`Search: "${f.search}"`);
  return parts.length ? parts.join('  |  ') : 'No filters (all records)';
}

// ============================================================
// CELL FORMATTING
// ============================================================

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function parseDateMs(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'string' && YMD.test(raw)) {
    const ms = Date.parse(`${raw}T00:00:00.000Z`);
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isNaN(ms) ? null : ms;
}

function formatDateText(raw: unknown, type: 'date' | 'datetime'): string {
  const ms = parseDateMs(raw);
  if (ms === null) return raw === null || raw === undefined ? '' : String(raw);
  const d = new Date(ms);
  const ymd = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  return type === 'date' ? ymd : `${ymd} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function getRaw(col: ExportColumn, row: Record<string, unknown>): unknown {
  return col.get ? col.get(row) : row[col.key];
}

/** Typed, display-ready cell: number for number/money, string for the rest. */
export function cellValue(col: ExportColumn, row: Record<string, unknown>): ExportCell {
  const raw = getRaw(col, row);
  if (raw === null || raw === undefined) return null;
  switch (col.type) {
    case 'number':
    case 'money': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'bool':
      return raw ? 'Yes' : 'No';
    case 'list':
      return Array.isArray(raw) ? raw.map((v) => String(v)).join('; ') : String(raw);
    case 'date':
    case 'datetime':
      return formatDateText(raw, col.type);
    default:
      return String(raw);
  }
}

/** Header text; datetime columns are labelled UTC so nobody guesses a timezone. */
export function headerLabel(col: ExportColumn): string {
  return col.type === 'datetime' ? `${col.header} (UTC)` : col.header;
}

/** Display string (PDF + CSV text). */
function cellText(col: ExportColumn, row: Record<string, unknown>, forPdf: boolean): string {
  const v = cellValue(col, row);
  if (v === null) return '';
  if (typeof v === 'number') {
    if (col.type === 'money') return forPdf ? fmtNumber(v, 2) : v.toFixed(2);
    return forPdf ? fmtNumber(v, Number.isInteger(v) ? 0 : 2) : String(v);
  }
  return v;
}

function fmtNumber(n: number, decimals: number): string {
  const [int, frac] = Math.abs(n).toFixed(decimals).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

// ============================================================
// CSV
// ============================================================

/**
 * Neutralise spreadsheet-formula injection: text that starts with = + - @
 * (or tab / CR) is prefixed with an apostrophe. Phone-like / numeric-looking
 * strings are left alone so "+1 555 0100" stays readable.
 */
export function neutralizeFormula(s: string): string {
  if (!s) return s;
  if (!/^[=+\-@\t\r]/.test(s)) return s;
  if (/^[+-]?[\d\s().-]+$/.test(s)) return s;
  return `'${s}`;
}

export function escapeCsvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(def: ExportDatasetDef, rows: Record<string, unknown>[]): Uint8Array {
  const cols = def.columns;
  const lines: string[] = [cols.map((c) => escapeCsvCell(headerLabel(c))).join(',')];
  for (const row of rows) {
    lines.push(
      cols
        .map((c) => {
          const text = cellText(c, row, false);
          const isNumeric = c.type === 'number' || c.type === 'money';
          return escapeCsvCell(isNumeric ? text : neutralizeFormula(text));
        })
        .join(','),
    );
  }
  // UTF-8 BOM so Excel renders Arabic / Farsi / CJK / Hindi correctly.
  return new TextEncoder().encode('\uFEFF' + lines.join('\r\n') + '\r\n');
}

// ============================================================
// XLSX  (hand-rolled OOXML + store-only ZIP; zero dependencies)
// ============================================================

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** Minimal ZIP writer (method 0 / store). Valid for Excel, Numbers, LibreOffice. */
export function buildZip(entries: ZipEntry[], when: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const year = Math.max(1980, when.getUTCFullYear());
  const dosTime = (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1);
  const dosDate = ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();

  const prepared = entries.map((e) => ({
    nameBytes: enc.encode(e.name),
    data: e.data,
    crc: crc32(e.data),
  }));

  let localSize = 0;
  let centralSize = 0;
  for (const p of prepared) {
    localSize += 30 + p.nameBytes.length + p.data.length;
    centralSize += 46 + p.nameBytes.length;
  }
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let off = 0;
  const offsets: number[] = [];

  for (const p of prepared) {
    offsets.push(off);
    view.setUint32(off, 0x04034b50, true);
    view.setUint16(off + 4, 20, true);
    view.setUint16(off + 6, 0x0800, true); // UTF-8 names
    view.setUint16(off + 8, 0, true); // store
    view.setUint16(off + 10, dosTime, true);
    view.setUint16(off + 12, dosDate, true);
    view.setUint32(off + 14, p.crc, true);
    view.setUint32(off + 18, p.data.length, true);
    view.setUint32(off + 22, p.data.length, true);
    view.setUint16(off + 26, p.nameBytes.length, true);
    view.setUint16(off + 28, 0, true);
    out.set(p.nameBytes, off + 30);
    out.set(p.data, off + 30 + p.nameBytes.length);
    off += 30 + p.nameBytes.length + p.data.length;
  }

  const centralStart = off;
  prepared.forEach((p, i) => {
    view.setUint32(off, 0x02014b50, true);
    view.setUint16(off + 4, 20, true);
    view.setUint16(off + 6, 20, true);
    view.setUint16(off + 8, 0x0800, true);
    view.setUint16(off + 10, 0, true);
    view.setUint16(off + 12, dosTime, true);
    view.setUint16(off + 14, dosDate, true);
    view.setUint32(off + 16, p.crc, true);
    view.setUint32(off + 20, p.data.length, true);
    view.setUint32(off + 24, p.data.length, true);
    view.setUint16(off + 28, p.nameBytes.length, true);
    view.setUint16(off + 30, 0, true);
    view.setUint16(off + 32, 0, true);
    view.setUint16(off + 34, 0, true);
    view.setUint16(off + 36, 0, true);
    view.setUint32(off + 38, 0, true);
    view.setUint32(off + 42, offsets[i], true);
    out.set(p.nameBytes, off + 46);
    off += 46 + p.nameBytes.length;
  });

  view.setUint32(off, 0x06054b50, true);
  view.setUint16(off + 4, 0, true);
  view.setUint16(off + 6, 0, true);
  view.setUint16(off + 8, prepared.length, true);
  view.setUint16(off + 10, prepared.length, true);
  view.setUint32(off + 12, off - centralStart, true);
  view.setUint32(off + 16, centralStart, true);
  view.setUint16(off + 20, 0, true);
  return out;
}

export function xmlEscape(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function colLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function excelSerial(ms: number): number {
  return ms / 86_400_000 + 25_569;
}

// style ids in styles.xml below
const S_HEADER = 1;
const S_DATETIME = 2;
const S_DATE = 3;
const S_MONEY = 4;

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF1F2937"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\][:*?/\\]/g, ' ').trim().slice(0, 31);
  return cleaned || 'Export';
}

export function buildXlsx(def: ExportDatasetDef, rows: Record<string, unknown>[], when: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const cols = def.columns;
  const lastCol = colLetter(cols.length - 1);
  const lastRow = rows.length + 1;

  const sheet: string[] = [];
  sheet.push(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<dimension ref="A1:${lastCol}${lastRow}"/>` +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>',
  );
  sheet.push(
    '<cols>' +
      cols
        .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(10, c.width + 4))}" customWidth="1"/>`)
        .join('') +
      '</cols>',
  );
  sheet.push('<sheetData>');
  sheet.push(
    '<row r="1" ht="22" customHeight="1">' +
      cols
        .map(
          (c, i) =>
            `<c r="${colLetter(i)}1" s="${S_HEADER}" t="inlineStr"><is><t>${xmlEscape(headerLabel(c))}</t></is></c>`,
        )
        .join('') +
      '</row>',
  );

  rows.forEach((row, ri) => {
    const r = ri + 2;
    const cells: string[] = [];
    cols.forEach((c, ci) => {
      const ref = `${colLetter(ci)}${r}`;
      if (c.type === 'date' || c.type === 'datetime') {
        const raw = getRaw(c, row);
        const ms = parseDateMs(raw);
        if (ms !== null) {
          cells.push(`<c r="${ref}" s="${c.type === 'date' ? S_DATE : S_DATETIME}"><v>${excelSerial(ms)}</v></c>`);
        } else if (raw !== null && raw !== undefined && raw !== '') {
          cells.push(`<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(String(raw))}</t></is></c>`);
        }
        return;
      }
      const v = cellValue(c, row);
      if (v === null || v === '') return;
      if (typeof v === 'number') {
        cells.push(`<c r="${ref}"${c.type === 'money' ? ` s="${S_MONEY}"` : ''}><v>${v}</v></c>`);
      } else {
        cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`);
      }
    });
    sheet.push(`<row r="${r}">${cells.join('')}</row>`);
  });

  sheet.push('</sheetData>');
  sheet.push(`<autoFilter ref="A1:${lastCol}${lastRow}"/>`);
  sheet.push('</worksheet>');

  const files: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          '</Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          `<sheets><sheet name="${xmlEscape(sanitizeSheetName(def.label))}" sheetId="1" r:id="rId1"/></sheets>` +
          '</workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
          '</Relationships>',
      ),
    },
    { name: 'xl/styles.xml', data: enc.encode(STYLES_XML) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheet.join('')) },
  ];
  return buildZip(files, when);
}

// ============================================================
// PDF  (hand-rolled PDF 1.4, Helvetica / WinAnsi, landscape A4)
// ============================================================
// Standard PDF fonts cover Latin scripts only. Characters outside WinAnsi
// (Arabic, Farsi, CJK, Devanagari …) render as "?" in the PDF; the CSV and
// XLSX exports keep full Unicode. This is surfaced in the UI.

const PAGE_W = 842;
const PAGE_H = 595;
const MARGIN = 28;
const ROW_H = 15;
const HEADER_H = 20;
const FONT_SIZE = 7.5;
const FOOTER_H = 22;
const TITLE_BLOCK_H = 58;

// Helvetica advance widths (1/1000 em) for ASCII 32..126.
const HELV_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const CP1252_SPECIAL: Record<number, number> = {
  8364: 0x80, 8218: 0x82, 402: 0x83, 8222: 0x84, 8230: 0x85, 8224: 0x86, 8225: 0x87,
  710: 0x88, 8240: 0x89, 352: 0x8a, 8249: 0x8b, 338: 0x8c, 381: 0x8e, 8216: 0x91,
  8217: 0x92, 8220: 0x93, 8221: 0x94, 8226: 0x95, 8211: 0x96, 8212: 0x97, 732: 0x98,
  8482: 0x99, 353: 0x9a, 8250: 0x9b, 339: 0x9c, 382: 0x9e, 376: 0x9f,
};

/** Maps a JS string to a latin1 string of WinAnsi codes (unsupported -> "?"). */
export function toWinAnsi(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 63;
    if (cp < 32 || cp === 127) out += ' ';
    else if (cp <= 126) out += ch;
    else if (cp >= 0xa0 && cp <= 0xff) out += String.fromCharCode(cp);
    else if (CP1252_SPECIAL[cp] !== undefined) out += String.fromCharCode(CP1252_SPECIAL[cp]);
    else out += '?';
  }
  return out;
}

function glyphWidth(code: number): number {
  return code >= 32 && code <= 126 ? HELV_WIDTHS[code - 32] : 556;
}

function textWidth(winAnsi: string, size: number, bold: boolean): number {
  let w = 0;
  for (let i = 0; i < winAnsi.length; i++) w += glyphWidth(winAnsi.charCodeAt(i));
  return (w / 1000) * size * (bold ? 1.06 : 1);
}

function fitText(winAnsi: string, maxWidth: number, size: number, bold: boolean): string {
  if (textWidth(winAnsi, size, bold) <= maxWidth) return winAnsi;
  const ell = '...';
  let lo = 0;
  let hi = winAnsi.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(winAnsi.slice(0, mid) + ell, size, bold) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo <= 0 ? '' : winAnsi.slice(0, lo) + ell;
}

function pdfEscape(winAnsi: string): string {
  return winAnsi.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function pdfText(font: 'F1' | 'F2', size: number, x: number, y: number, winAnsi: string, rgb: string): string {
  return `BT /${font} ${size} Tf ${rgb} rg ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfEscape(winAnsi)}) Tj ET\n`;
}

function pdfRect(x: number, y: number, w: number, h: number, rgb: string): string {
  return `${rgb} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`;
}

export interface PdfMeta {
  title: string;
  subtitle: string;
  generatedAt: Date;
  note?: string;
}

const INK = '0.09 0.11 0.15';
const MUTED = '0.42 0.45 0.50';
const HEAD_BG = '0.12 0.16 0.22';
const ZEBRA = '0.96 0.97 0.98';
const WHITE = '1 1 1';

export function buildPdf(def: ExportDatasetDef, rows: Record<string, unknown>[], meta: PdfMeta): Uint8Array {
  const cols = def.columns;
  const usable = PAGE_W - MARGIN * 2;
  const totalWeight = cols.reduce((s, c) => s + c.width, 0);
  const colW = cols.map((c) => (usable * c.width) / totalWeight);
  const PAD = 3;

  const bodyHeight = (first: boolean) =>
    PAGE_H - MARGIN * 2 - FOOTER_H - HEADER_H - (first ? TITLE_BLOCK_H : 0);
  const rowsPerPage = (first: boolean) => Math.max(1, Math.floor(bodyHeight(first) / ROW_H));

  // Paginate
  const pages: Record<string, unknown>[][] = [];
  let idx = 0;
  do {
    const take = rowsPerPage(pages.length === 0);
    pages.push(rows.slice(idx, idx + take));
    idx += take;
  } while (idx < rows.length);

  const generated = `${formatDateText(meta.generatedAt.toISOString(), 'datetime')} UTC`;
  const streams: string[] = pages.map((pageRows, pi) => {
    const first = pi === 0;
    let s = '';
    let y = PAGE_H - MARGIN;

    if (first) {
      s += pdfText('F2', 15, MARGIN, y - 14, toWinAnsi(meta.title), INK);
      s += pdfText('F1', 8, MARGIN, y - 28, toWinAnsi(meta.subtitle), MUTED);
      s += pdfText(
        'F1',
        8,
        MARGIN,
        y - 40,
        toWinAnsi(`Generated ${generated}  |  ${rows.length.toLocaleString('en-US')} row${rows.length === 1 ? '' : 's'}${meta.note ? `  |  ${meta.note}` : ''}`),
        MUTED,
      );
      y -= TITLE_BLOCK_H;
    }

    // Table header
    s += pdfRect(MARGIN, y - HEADER_H, usable, HEADER_H, HEAD_BG);
    let x = MARGIN;
    cols.forEach((c, ci) => {
      const label = fitText(toWinAnsi(headerLabel(c)), colW[ci] - PAD * 2, FONT_SIZE, true);
      const numeric = c.type === 'number' || c.type === 'money';
      const tx = numeric ? x + colW[ci] - PAD - textWidth(label, FONT_SIZE, true) : x + PAD;
      s += pdfText('F2', FONT_SIZE, tx, y - HEADER_H + 7, label, WHITE);
      x += colW[ci];
    });
    y -= HEADER_H;

    if (rows.length === 0) {
      s += pdfText('F1', 9, MARGIN + PAD, y - 22, 'No rows matched these filters.', MUTED);
    }

    pageRows.forEach((row, ri) => {
      if (ri % 2 === 1) s += pdfRect(MARGIN, y - ROW_H, usable, ROW_H, ZEBRA);
      let cx = MARGIN;
      cols.forEach((c, ci) => {
        const raw = toWinAnsi(cellText(c, row, true));
        if (raw) {
          const txt = fitText(raw, colW[ci] - PAD * 2, FONT_SIZE, false);
          const numeric = c.type === 'number' || c.type === 'money';
          const tx = numeric ? cx + colW[ci] - PAD - textWidth(txt, FONT_SIZE, false) : cx + PAD;
          s += pdfText('F1', FONT_SIZE, tx, y - ROW_H + 5, txt, INK);
        }
        cx += colW[ci];
      });
      y -= ROW_H;
    });

    // Footer
    const footLeft = toWinAnsi(`Vireek  |  ${meta.title}`);
    const footRight = `Page ${pi + 1} of ${pages.length}`;
    s += pdfText('F1', 7, MARGIN, MARGIN - 6, footLeft, MUTED);
    s += pdfText('F1', 7, PAGE_W - MARGIN - textWidth(footRight, 7, false), MARGIN - 6, footRight, MUTED);
    return s;
  });

  // Assemble objects. 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then (content, page) pairs.
  const objects: string[] = [];
  const pageObjNums: number[] = [];
  const firstPageObj = 6;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[5] = `<< /Title (${pdfEscape(toWinAnsi(meta.title))}) /Producer (Vireek) /Creator (Vireek Exports) >>`;
  streams.forEach((content, i) => {
    const pageNum = firstPageObj + i * 2;
    const contentNum = pageNum + 1;
    pageObjNums.push(pageNum);
    objects[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>`;
    objects[contentNum] = `<< /Length ${content.length} >>\nstream\n${content}endstream`;
  });
  objects[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageObjNums.length} >>`;

  let pdf = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = pdf.length;
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) {
    pdf += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

// ============================================================
// DISPATCH + NAMING + EXPIRY
// ============================================================

export function buildExportFile(
  req: ExportRequest,
  rows: Record<string, unknown>[],
  opts: { generatedAt?: Date; truncated?: boolean } = {},
): Uint8Array {
  const def = EXPORT_DATASETS[req.dataset];
  const generatedAt = opts.generatedAt ?? new Date();
  switch (req.format) {
    case 'csv':
      return buildCsv(def, rows);
    case 'xlsx':
      return buildXlsx(def, rows, generatedAt);
    case 'pdf':
      return buildPdf(def, rows, {
        title: `${def.label} export`,
        subtitle: describeFilters(def, req.filters),
        generatedAt,
        note: opts.truncated ? `Limited to the first ${FORMAT_ROW_CAP.pdf.toLocaleString('en-US')} rows (use CSV/XLSX for everything)` : undefined,
      });
  }
}

export function exportFileName(dataset: ExportDatasetId, format: ExportFormat, at: Date = new Date()): string {
  const stamp = `${at.getUTCFullYear()}${pad2(at.getUTCMonth() + 1)}${pad2(at.getUTCDate())}-${pad2(at.getUTCHours())}${pad2(at.getUTCMinutes())}`;
  return `vireek-${dataset}-${stamp}.${format}`;
}

export function exportStoragePath(ownerId: string, jobId: string, format: ExportFormat): string {
  return `${ownerId}/${jobId}.${format}`;
}

export function isExportExpired(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return !Number.isNaN(t) && t <= now;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
