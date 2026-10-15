import { supabase } from '@/lib/supabase';
import { formatMoney, type CurrencyCode } from '@/lib/currency';

// ============================================================
// Saved report builder — engine + data access
//
// Everything that decides what a report MEANS is pure and lives here
// (catalog, validation, filtering, grouping, aggregation, export table),
// so it is unit-tested without React or Supabase. Only the last section
// (data access) touches the network, and every query in it is scoped to
// the ACCOUNT OWNER id — a team member's reports/rows resolve to the
// owner's account exactly like the rest of the dashboard.
// ============================================================

export type ReportEntity = 'calls' | 'leads' | 'jobs' | 'customers';
export type FieldType = 'string' | 'number' | 'date' | 'boolean' | 'enum';
export type FieldFormat = 'currency' | 'duration_seconds' | 'duration_minutes' | 'score';

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: readonly FieldOption[];
  format?: FieldFormat;
}

export interface EntityDef {
  key: ReportEntity;
  label: string;
  singular: string;
  table: ReportEntity;
  /** Column used for the date-range filter and as the default sort. */
  dateField: string;
  fields: readonly FieldDef[];
  defaultColumns: readonly string[];
}

const opts = (...values: string[]): FieldOption[] =>
  values.map((value) => ({ value, label: value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) }));

// Explicit whitelist per entity: only these columns are ever selected, so
// large/private columns (transcripts, recordings, signatures, photos…) can
// never leak into a report or an export.
export const ENTITIES: Record<ReportEntity, EntityDef> = {
  calls: {
    key: 'calls',
    label: 'Calls',
    singular: 'call',
    table: 'calls',
    dateField: 'call_datetime',
    defaultColumns: ['call_datetime', 'caller_name', 'status', 'duration_seconds'],
    fields: [
      { key: 'call_datetime', label: 'Call time', type: 'date' },
      { key: 'caller_name', label: 'Caller', type: 'string' },
      { key: 'caller_phone', label: 'Phone', type: 'string' },
      { key: 'status', label: 'Status', type: 'enum', options: opts('new_lead', 'booked', 'missed', 'callback_requested', 'spam') },
      { key: 'sentiment', label: 'Sentiment', type: 'enum', options: opts('positive', 'neutral', 'negative') },
      { key: 'is_emergency', label: 'Emergency', type: 'boolean' },
      { key: 'is_voicemail', label: 'Voicemail', type: 'boolean' },
      { key: 'duration_seconds', label: 'Duration', type: 'number', format: 'duration_seconds' },
      { key: 'call_score', label: 'Call score', type: 'number', format: 'score' },
      { key: 'lead_score', label: 'Lead score', type: 'number', format: 'score' },
      { key: 'lead_source', label: 'Lead source', type: 'string' },
      { key: 'source_label', label: 'Source label', type: 'string' },
      { key: 'intent', label: 'Intent', type: 'string' },
      { key: 'booking_outcome', label: 'Booking outcome', type: 'enum', options: opts('booked', 'not_booked', 'already_scheduled', 'not_applicable') },
    ],
  },
  leads: {
    key: 'leads',
    label: 'Leads',
    singular: 'lead',
    table: 'leads',
    dateField: 'created_at',
    defaultColumns: ['created_at', 'name', 'service_interested', 'stage', 'quote_amount'],
    fields: [
      { key: 'created_at', label: 'Created', type: 'date' },
      { key: 'name', label: 'Name', type: 'string' },
      { key: 'phone', label: 'Phone', type: 'string' },
      { key: 'email', label: 'Email', type: 'string' },
      { key: 'service_interested', label: 'Service', type: 'string' },
      { key: 'stage', label: 'Stage', type: 'enum', options: opts('new', 'contacted', 'quoted', 'won', 'lost') },
      { key: 'quote_amount', label: 'Quote amount', type: 'number', format: 'currency' },
      { key: 'follow_up_count', label: 'Follow-ups', type: 'number' },
      { key: 'quote_sent_at', label: 'Quote sent', type: 'date' },
    ],
  },
  jobs: {
    key: 'jobs',
    label: 'Jobs',
    singular: 'job',
    table: 'jobs',
    dateField: 'scheduled_datetime',
    defaultColumns: ['scheduled_datetime', 'customer_name', 'service_type', 'job_status', 'invoice_amount'],
    fields: [
      { key: 'scheduled_datetime', label: 'Scheduled', type: 'date' },
      { key: 'customer_name', label: 'Customer', type: 'string' },
      { key: 'service_type', label: 'Service type', type: 'string' },
      { key: 'address', label: 'Address', type: 'string' },
      {
        key: 'job_status',
        label: 'Job status',
        type: 'enum',
        options: opts('scheduled', 'en_route', 'in_progress', 'completed', 'cancelled', 'no_show'),
      },
      { key: 'invoice_amount', label: 'Invoice amount', type: 'number', format: 'currency' },
      { key: 'invoice_status', label: 'Invoice status', type: 'enum', options: opts('not_sent', 'sent', 'paid') },
      { key: 'duration_minutes', label: 'Duration', type: 'number', format: 'duration_minutes' },
      { key: 'customer_type', label: 'Customer type', type: 'enum', options: opts('residential', 'commercial') },
      { key: 'is_rework', label: 'Rework', type: 'boolean' },
      { key: 'completed_at', label: 'Completed', type: 'date' },
    ],
  },
  customers: {
    key: 'customers',
    label: 'Customers',
    singular: 'customer',
    table: 'customers',
    dateField: 'created_at',
    defaultColumns: ['created_at', 'name', 'customer_type', 'lifecycle_stage'],
    fields: [
      { key: 'created_at', label: 'Created', type: 'date' },
      { key: 'name', label: 'Name', type: 'string' },
      { key: 'phone', label: 'Phone', type: 'string' },
      { key: 'email', label: 'Email', type: 'string' },
      { key: 'address', label: 'Address', type: 'string' },
      { key: 'customer_type', label: 'Type', type: 'enum', options: opts('residential', 'commercial') },
      { key: 'lifecycle_stage', label: 'Lifecycle', type: 'enum', options: opts('lead', 'active', 'vip', 'inactive') },
      { key: 'source', label: 'Source', type: 'enum', options: opts('manual', 'call', 'lead', 'job', 'import') },
      { key: 'last_contacted_at', label: 'Last contacted', type: 'date' },
    ],
  },
};

export const ENTITY_KEYS = Object.keys(ENTITIES) as ReportEntity[];

export function getField(entity: ReportEntity, key: string): FieldDef | undefined {
  return ENTITIES[entity].fields.find((f) => f.key === key);
}

// ============================================================
// Definition
// ============================================================

export type FilterOp = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'before' | 'after';
export type RangePreset = '7d' | '30d' | '90d' | '12m' | 'all';
export type DateBucket = 'day' | 'week' | 'month';
export type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max';
export type ChartType = 'none' | 'bar' | 'line' | 'donut';
export type SortMode = 'value_desc' | 'value_asc' | 'label_asc';

export interface ReportFilter {
  field: string;
  op: FilterOp;
  /** Always stored as a string; parsed per field type at evaluation time. */
  value: string;
}

export interface ReportDefinition {
  version: 1;
  entity: ReportEntity;
  columns: string[];
  filters: ReportFilter[];
  range: RangePreset;
  groupBy: string | null;
  dateBucket: DateBucket;
  metric: { fn: AggFn; field: string | null };
  sort: SortMode;
  limit: number;
  chart: ChartType;
}

export const MAX_FILTERS = 10;
export const MAX_COLUMNS = 12;
export const MAX_ROWS = 5000;
export const PAGE_SIZE = 1000;
export const GROUP_LIMITS = [10, 25, 50, 100] as const;

export const RANGE_LABELS: Record<RangePreset, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '12m': 'Last 12 months',
  all: 'All time',
};

export const OPS_BY_TYPE: Record<FieldType, readonly FilterOp[]> = {
  string: ['contains', 'eq', 'neq'],
  enum: ['eq', 'neq'],
  boolean: ['eq'],
  number: ['eq', 'gt', 'gte', 'lt', 'lte'],
  date: ['after', 'before'],
};

export const OP_LABELS: Record<FilterOp, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  gt: 'greater than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  after: 'on or after',
  before: 'on or before',
};

export const AGG_LABELS: Record<AggFn, string> = {
  count: 'Count',
  sum: 'Sum',
  avg: 'Average',
  min: 'Minimum',
  max: 'Maximum',
};

export function defaultDefinition(entity: ReportEntity, range: RangePreset = '30d'): ReportDefinition {
  return {
    version: 1,
    entity,
    columns: [...ENTITIES[entity].defaultColumns],
    filters: [],
    range,
    groupBy: null,
    dateBucket: 'month',
    metric: { fn: 'count', field: null },
    sort: 'value_desc',
    limit: 25,
    chart: 'none',
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/**
 * Coerces ANY input (a jsonb blob from the database, an old version of the
 * schema, a hand-edited row) into a definition that is guaranteed safe to
 * run. Unknown fields are dropped, invalid parts fall back to defaults —
 * it never throws.
 */
export function sanitizeDefinition(input: unknown, entity: ReportEntity): ReportDefinition {
  const base = defaultDefinition(entity);
  if (!isRecord(input)) return base;
  const def = ENTITIES[entity];
  const fieldKeys = new Set(def.fields.map((f) => f.key));

  const columns = Array.isArray(input.columns)
    ? Array.from(new Set(input.columns.filter((c): c is string => typeof c === 'string' && fieldKeys.has(c)))).slice(0, MAX_COLUMNS)
    : base.columns;

  const filters: ReportFilter[] = [];
  if (Array.isArray(input.filters)) {
    for (const raw of input.filters) {
      if (!isRecord(raw) || typeof raw.field !== 'string' || typeof raw.op !== 'string') continue;
      const field = getField(entity, raw.field);
      if (!field || !(OPS_BY_TYPE[field.type] as readonly string[]).includes(raw.op)) continue;
      const value = typeof raw.value === 'string' ? raw.value.slice(0, 200) : typeof raw.value === 'number' ? String(raw.value) : '';
      filters.push({ field: field.key, op: raw.op as FilterOp, value });
      if (filters.length >= MAX_FILTERS) break;
    }
  }

  const groupField = typeof input.groupBy === 'string' ? getField(entity, input.groupBy) : undefined;
  const groupBy = groupField && groupField.type !== 'number' ? groupField.key : null;

  let metric: ReportDefinition['metric'] = { fn: 'count', field: null };
  if (isRecord(input.metric)) {
    const fn = oneOf<AggFn>(input.metric.fn, ['count', 'sum', 'avg', 'min', 'max'], 'count');
    const mField = typeof input.metric.field === 'string' ? getField(entity, input.metric.field) : undefined;
    if (fn !== 'count' && mField && mField.type === 'number') metric = { fn, field: mField.key };
  }

  const limitRaw = typeof input.limit === 'number' ? input.limit : base.limit;
  const limit = (GROUP_LIMITS as readonly number[]).includes(limitRaw) ? limitRaw : base.limit;

  return {
    version: 1,
    entity,
    columns,
    filters,
    range: oneOf<RangePreset>(input.range, ['7d', '30d', '90d', '12m', 'all'], base.range),
    groupBy,
    dateBucket: oneOf<DateBucket>(input.dateBucket, ['day', 'week', 'month'], base.dateBucket),
    metric,
    sort: oneOf<SortMode>(input.sort, ['value_desc', 'value_asc', 'label_asc'], base.sort),
    limit,
    chart: groupBy ? oneOf<ChartType>(input.chart, ['none', 'bar', 'line', 'donut'], 'none') : 'none',
  };
}

/** Returns a human-readable problem, or null when the definition can be saved. */
export function validateDefinition(def: ReportDefinition): string | null {
  if (!def.groupBy && def.columns.length === 0) return 'Pick at least one column, or group the report.';
  if (def.metric.fn !== 'count' && !def.metric.field) return 'Pick a numeric field for the metric.';
  if (def.chart !== 'none' && !def.groupBy) return 'Charts need a grouping.';
  return null;
}

// ============================================================
// Value access + filtering
// ============================================================

export type ReportRow = Record<string, unknown>;

export function numberValue(row: ReportRow, key: string): number | null {
  const v = row[key];
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function dateValue(row: ReportRow, key: string): number | null {
  const v = row[key];
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const ms = typeof v === 'number' ? v : Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

function stringValue(row: ReportRow, key: string): string | null {
  const v = row[key];
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function parseLocalDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A filter that is still being typed (empty value) is ignored, not applied. */
export function isFilterComplete(f: ReportFilter, entity: ReportEntity): boolean {
  const field = getField(entity, f.field);
  if (!field) return false;
  const v = f.value.trim();
  if (v === '') return false;
  if (field.type === 'number') return Number.isFinite(Number(v));
  if (field.type === 'date') return parseLocalDate(v) !== null;
  if (field.type === 'boolean') return v === 'true' || v === 'false';
  return true;
}

export function matchesFilter(row: ReportRow, f: ReportFilter, entity: ReportEntity): boolean {
  const field = getField(entity, f.field);
  if (!field || !isFilterComplete(f, entity)) return true;
  const target = f.value.trim();

  switch (field.type) {
    case 'string':
    case 'enum': {
      const v = stringValue(row, field.key);
      if (f.op === 'contains') return v !== null && v.toLowerCase().includes(target.toLowerCase());
      if (f.op === 'eq') return v !== null && v.toLowerCase() === target.toLowerCase();
      if (f.op === 'neq') return v === null || v.toLowerCase() !== target.toLowerCase();
      return true;
    }
    case 'boolean': {
      const v = row[field.key] === true;
      return v === (target === 'true');
    }
    case 'number': {
      const v = numberValue(row, field.key);
      if (v === null) return false;
      const t = Number(target);
      switch (f.op) {
        case 'eq':
          return v === t;
        case 'gt':
          return v > t;
        case 'gte':
          return v >= t;
        case 'lt':
          return v < t;
        case 'lte':
          return v <= t;
        default:
          return true;
      }
    }
    case 'date': {
      const v = dateValue(row, field.key);
      const day = parseLocalDate(target);
      if (v === null || !day) return false;
      if (f.op === 'after') return v >= day.getTime();
      const endOfDay = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime() - 1;
      return v <= endOfDay;
    }
  }
}

export function applyFilters(rows: ReportRow[], def: ReportDefinition): ReportRow[] {
  const active = def.filters.filter((f) => isFilterComplete(f, def.entity));
  if (active.length === 0) return rows;
  return rows.filter((r) => active.every((f) => matchesFilter(r, f, def.entity)));
}

// ============================================================
// Date ranges + bucketing (local time, Monday-start weeks)
// ============================================================

export function rangeStart(preset: RangePreset, now: Date = new Date()): Date | null {
  if (preset === 'all') return null;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (preset === '12m') d.setMonth(d.getMonth() - 12);
  else d.setDate(d.getDate() - { '7d': 7, '30d': 30, '90d': 90 }[preset]);
  return d;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function bucketKey(ms: number, bucket: DateBucket): string {
  const d = new Date(ms);
  if (bucket === 'month') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  if (bucket === 'week') {
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    return dayKey(monday);
  }
  return dayKey(d);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function bucketLabel(key: string, bucket: DateBucket): string {
  const [y, m, d] = key.split('-').map(Number);
  if (bucket === 'month') return `${MONTHS[m - 1]} ${y}`;
  const label = `${MONTHS[m - 1]} ${d}`;
  return bucket === 'week' ? `Week of ${label}` : `${label}, ${y}`;
}

// ============================================================
// Formatting
// ============================================================

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function formatCell(field: FieldDef, value: unknown, currency: CurrencyCode): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (field.type) {
    case 'boolean':
      return value === true ? 'Yes' : 'No';
    case 'enum': {
      const o = field.options?.find((x) => x.value === value);
      return o ? o.label : String(value);
    }
    case 'date': {
      const ms = typeof value === 'string' ? Date.parse(value) : NaN;
      if (Number.isNaN(ms)) return '—';
      const d = new Date(ms);
      return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return '—';
      return formatMetricNumber(n, field.format, currency);
    }
    default:
      return String(value);
  }
}

export function formatMetricNumber(n: number, format: FieldFormat | undefined, currency: CurrencyCode): string {
  switch (format) {
    case 'currency':
      return formatMoney(n, currency);
    case 'duration_seconds':
      return formatDuration(n);
    case 'duration_minutes':
      return formatDuration(n * 60);
    case 'score':
      return n.toFixed(1);
    default:
      return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
}

// ============================================================
// Run: rows -> table | grouped result
// ============================================================

export interface GroupResult {
  key: string;
  label: string;
  sortKey: string;
  count: number;
  /** Metric value; null when no row in the group had a numeric value (avg/min/max). */
  value: number | null;
}

export interface ReportResult {
  kind: 'rows' | 'grouped';
  /** Rows that matched all filters (full set — the UI paginates the display). */
  rows: ReportRow[];
  matched: number;
  groups: GroupResult[];
  hiddenGroups: number;
  metricLabel: string;
}

export function metricLabel(def: ReportDefinition): string {
  if (def.metric.fn === 'count' || !def.metric.field) return 'Rows';
  const f = getField(def.entity, def.metric.field);
  return `${AGG_LABELS[def.metric.fn]} of ${f?.label ?? def.metric.field}`;
}

export function groupLabel(def: ReportDefinition): string {
  const f = def.groupBy ? getField(def.entity, def.groupBy) : undefined;
  if (!f) return 'Group';
  return f.type === 'date' ? `${f.label} (by ${def.dateBucket})` : f.label;
}

interface Acc {
  label: string;
  sortKey: string;
  count: number;
  sum: number;
  n: number;
  min: number;
  max: number;
}

export function runReport(rows: ReportRow[], def: ReportDefinition): ReportResult {
  const filtered = applyFilters(rows, def);
  const label = metricLabel(def);
  const groupField = def.groupBy ? getField(def.entity, def.groupBy) : undefined;
  if (!groupField) {
    return { kind: 'rows', rows: filtered, matched: filtered.length, groups: [], hiddenGroups: 0, metricLabel: label };
  }

  const metricField = def.metric.fn !== 'count' ? def.metric.field : null;
  const accs = new Map<string, Acc>();

  for (const row of filtered) {
    let key: string;
    let groupText: string;
    let sortKey: string;
    switch (groupField.type) {
      case 'date': {
        const ms = dateValue(row, groupField.key);
        if (ms === null) {
          key = '__none__';
          groupText = 'No date';
          sortKey = '\uffff';
        } else {
          key = bucketKey(ms, def.dateBucket);
          groupText = bucketLabel(key, def.dateBucket);
          sortKey = key;
        }
        break;
      }
      case 'boolean':
        key = row[groupField.key] === true ? 'true' : 'false';
        groupText = key === 'true' ? 'Yes' : 'No';
        sortKey = groupText;
        break;
      case 'enum': {
        const v = stringValue(row, groupField.key);
        key = v ?? '__none__';
        groupText = v ? formatCell(groupField, v, 'USD') : 'Unknown';
        sortKey = groupText;
        break;
      }
      default: {
        const v = stringValue(row, groupField.key);
        key = v ? v.toLowerCase() : '__none__';
        groupText = v ? (v.length > 60 ? `${v.slice(0, 57)}…` : v) : 'Unknown';
        sortKey = groupText.toLowerCase();
      }
    }

    let acc = accs.get(key);
    if (!acc) {
      acc = { label: groupText, sortKey, count: 0, sum: 0, n: 0, min: Infinity, max: -Infinity };
      accs.set(key, acc);
    }
    acc.count += 1;
    if (metricField) {
      const v = numberValue(row, metricField);
      if (v !== null) {
        acc.sum += v;
        acc.n += 1;
        if (v < acc.min) acc.min = v;
        if (v > acc.max) acc.max = v;
      }
    }
  }

  const all: GroupResult[] = [];
  for (const [key, a] of accs) {
    let value: number | null;
    switch (def.metric.fn) {
      case 'count':
        value = a.count;
        break;
      case 'sum':
        value = a.sum;
        break;
      case 'avg':
        value = a.n > 0 ? a.sum / a.n : null;
        break;
      case 'min':
        value = a.n > 0 ? a.min : null;
        break;
      default:
        value = a.n > 0 ? a.max : null;
    }
    all.push({ key, label: a.label, sortKey: a.sortKey, count: a.count, value });
  }

  const v = (g: GroupResult) => g.value ?? Number.NEGATIVE_INFINITY;
  all.sort((a, b) => {
    if (def.sort === 'label_asc') return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
    const diff = def.sort === 'value_desc' ? v(b) - v(a) : v(a) - v(b);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
    return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
  });

  const groups = all.slice(0, def.limit);
  return { kind: 'grouped', rows: filtered, matched: filtered.length, groups, hiddenGroups: all.length - groups.length, metricLabel: label };
}

// ============================================================
// Export (CSV-safe table)
// ============================================================

export type ExportCell = string | number | null;

export interface ExportTable {
  headers: string[];
  rows: ExportCell[][];
}

/**
 * Spreadsheet apps execute cells that start with = + - @ (formula injection).
 * Caller names / transcripts come from the public phone line, so any string
 * cell that could be read as a formula is neutralised with a leading quote.
 */
export function safeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function exportCell(field: FieldDef, value: unknown, currency: CurrencyCode): ExportCell {
  if (value === null || value === undefined || value === '') return null;
  if (field.type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (field.type === 'date') {
    const ms = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isNaN(ms)) return null;
    const d = new Date(ms);
    return `${dayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return safeCell(formatCell(field, value, currency));
}

export function toExportTable(result: ReportResult, def: ReportDefinition, currency: CurrencyCode): ExportTable {
  if (result.kind === 'grouped') {
    const mField = def.metric.field ? getField(def.entity, def.metric.field) : undefined;
    const showMetric = def.metric.fn !== 'count';
    const headers = [groupLabel(def), 'Rows', ...(showMetric ? [result.metricLabel] : [])];
    const rows = result.groups.map<ExportCell[]>((g) => [
      safeCell(g.label),
      g.count,
      ...(showMetric ? [g.value === null ? null : mField?.format === 'currency' ? Math.round(g.value * 100) / 100 : g.value] : []),
    ]);
    return { headers, rows };
  }
  const fields = def.columns.map((k) => getField(def.entity, k)).filter((f): f is FieldDef => !!f);
  return {
    headers: fields.map((f) => f.label),
    rows: result.rows.map((r) => fields.map((f) => exportCell(f, r[f.key], currency))),
  };
}

// ============================================================
// Data access — every query scoped to the ACCOUNT OWNER
// ============================================================

export interface SavedReport {
  id: string;
  user_id: string;
  created_by: string;
  name: string;
  description: string | null;
  entity: ReportEntity;
  definition: ReportDefinition;
  created_at: string;
  updated_at: string;
}

interface SavedReportRow extends Omit<SavedReport, 'definition' | 'entity'> {
  entity: string;
  definition: unknown;
}

function toSavedReport(row: SavedReportRow): SavedReport | null {
  if (!(ENTITY_KEYS as string[]).includes(row.entity)) return null;
  const entity = row.entity as ReportEntity;
  return { ...row, entity, definition: sanitizeDefinition(row.definition, entity) };
}

export function toReportError(err: unknown, fallback: string): Error {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code === '23505') return new Error('A report with this name already exists.');
  if (e?.code === '42501') return new Error('You do not have permission to manage reports.');
  return new Error(e?.message || fallback);
}

export async function listReports(accountOwnerId: string): Promise<SavedReport[]> {
  const { data, error } = await supabase
    .from('saved_reports')
    .select('*')
    .eq('user_id', accountOwnerId)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) throw toReportError(error, 'Could not load reports.');
  return ((data ?? []) as unknown as SavedReportRow[]).map(toSavedReport).filter((r): r is SavedReport => r !== null);
}

export interface ReportInput {
  name: string;
  description: string;
  definition: ReportDefinition;
}

export async function createReport(accountOwnerId: string, input: ReportInput): Promise<SavedReport> {
  const { data, error } = await supabase
    .from('saved_reports')
    .insert({
      user_id: accountOwnerId,
      name: input.name.trim(),
      description: input.description.trim() || null,
      entity: input.definition.entity,
      definition: input.definition,
    })
    .select('*')
    .single();
  if (error) throw toReportError(error, 'Could not save the report.');
  const saved = toSavedReport(data as unknown as SavedReportRow);
  if (!saved) throw new Error('Could not save the report.');
  return saved;
}

export async function updateReport(accountOwnerId: string, id: string, input: ReportInput): Promise<SavedReport> {
  const { data, error } = await supabase
    .from('saved_reports')
    .update({
      name: input.name.trim(),
      description: input.description.trim() || null,
      entity: input.definition.entity,
      definition: input.definition,
    })
    .eq('id', id)
    .eq('user_id', accountOwnerId)
    .select('*')
    .single();
  if (error) throw toReportError(error, 'Could not update the report.');
  const saved = toSavedReport(data as unknown as SavedReportRow);
  if (!saved) throw new Error('Could not update the report.');
  return saved;
}

export async function deleteReport(accountOwnerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('saved_reports').delete().eq('id', id).eq('user_id', accountOwnerId);
  if (error) throw toReportError(error, 'Could not delete the report.');
}

export interface FetchedRows {
  rows: ReportRow[];
  /** True when more than MAX_ROWS matched — narrow the date range for complete numbers. */
  truncated: boolean;
}

/**
 * Loads rows for one entity + date range. Selects ONLY whitelisted columns,
 * always scoped to the account owner (defence in depth on top of table RLS),
 * pages through PostgREST's 1000-row cap, and fetches MAX_ROWS + 1 so a
 * truncation is detected exactly rather than guessed.
 */
export async function fetchReportRows(entity: ReportEntity, accountOwnerId: string, range: RangePreset): Promise<FetchedRows> {
  const def = ENTITIES[entity];
  const columns = ['id', ...def.fields.map((f) => f.key)].filter((c, i, a) => a.indexOf(c) === i).join(',');
  const since = rangeStart(range);
  const out: ReportRow[] = [];

  for (let from = 0; from <= MAX_ROWS; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE - 1, MAX_ROWS);
    let q = supabase.from(def.table).select(columns).eq('user_id', accountOwnerId);
    if (since) q = q.gte(def.dateField, since.toISOString());
    const { data, error } = await q.order(def.dateField, { ascending: false }).order('id', { ascending: true }).range(from, to);
    if (error) throw toReportError(error, 'Could not load report data.');
    const page = (data ?? []) as unknown as ReportRow[];
    out.push(...page);
    if (page.length < to - from + 1) break;
  }

  const truncated = out.length > MAX_ROWS;
  return { rows: truncated ? out.slice(0, MAX_ROWS) : out, truncated };
}
