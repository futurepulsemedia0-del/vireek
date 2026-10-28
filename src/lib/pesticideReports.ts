/**
 * Pesticide usage reports — pure helpers (no React, no Supabase).
 * The database builds the report (`pesticide_usage_report()` in
 * supabase/migrations/20280105000000_pesticide_usage_reports.sql); everything here only
 * resolves periods, normalizes the payload, flags gaps and renders CSV, so it is fully unit-tested.
 *
 * Records support, but never replace, local regulation: report formats differ per jurisdiction.
 */

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface UsageReportRow {
  id: string;
  performed_at: string;
  job_id: string | null;
  customer_id: string | null;
  site_address: string | null;
  technician_id: string | null;
  technician_name: string | null;
  credential_type: string | null;
  credential_number: string | null;
  product_id: string | null;
  product_name: string | null;
  product_epa_reg: string | null;
  product_restricted: boolean;
  reentry_until: string | null;
  notes: string | null;
  amount: number | null;
  amount_unit: string | null;
  area_sqft: number | null;
  data: Record<string, unknown>;
}

export interface UsageByProduct {
  product_id: string | null;
  product_name: string;
  product_epa_reg: string | null;
  product_restricted: boolean;
  amount_unit: string | null;
  applications: number;
  total_amount: number;
  total_area_sqft: number;
  jobs: number;
  first_at: string | null;
  last_at: string | null;
}

export interface UsageByApplicator {
  technician_id: string | null;
  technician_name: string;
  credential_type: string | null;
  credential_number: string | null;
  applications: number;
  restricted_applications: number;
  products: number;
  first_at: string | null;
  last_at: string | null;
}

export interface UsageTotals {
  restricted_applications: number;
  distinct_products: number;
  distinct_applicators: number;
  distinct_sites: number;
  missing_licence: number;
  missing_area: number;
  missing_epa_reg: number;
  ppe_not_confirmed: number;
  customer_not_notified: number;
}

export interface UsageReport {
  generated_at: string | null;
  period_from: string;
  period_to: string;
  restricted_only: boolean;
  entry_count: number;
  voided_count: number;
  truncated: boolean;
  totals: UsageTotals;
  by_product: UsageByProduct[];
  by_applicator: UsageByApplicator[];
  rows: UsageReportRow[];
}

/* ------------------------------------------------------------------ */
/* Periods                                                              */
/* ------------------------------------------------------------------ */

export type PeriodPreset = 'this_month' | 'last_month' | 'this_quarter' | 'last_quarter' | 'year_to_date' | 'last_year' | 'custom';

export const PERIOD_PRESET_LABELS: Record<PeriodPreset, string> = {
  this_month: 'This month',
  last_month: 'Last month',
  this_quarter: 'This quarter',
  last_quarter: 'Last quarter',
  year_to_date: 'Year to date',
  last_year: 'Last calendar year',
  custom: 'Custom range',
};

export interface ResolvedPeriod {
  /** Inclusive start (ISO instant, local midnight). */
  from: string;
  /** Exclusive end (ISO instant, local midnight of the day AFTER the last day). */
  to: string;
  /** Human label of the inclusive range, e.g. "2027-01-01 – 2027-03-31". */
  label: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** yyyy-mm-dd of a LOCAL date (what <input type="date"> uses). */
export function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parses yyyy-mm-dd as a LOCAL midnight; null when invalid (rejects 2027-02-31). */
export function parseDateInput(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

function build(startInclusive: Date, endInclusive: Date): ResolvedPeriod {
  const endExclusive = new Date(endInclusive.getFullYear(), endInclusive.getMonth(), endInclusive.getDate() + 1);
  return {
    from: startInclusive.toISOString(),
    to: endExclusive.toISOString(),
    label: `${toDateInput(startInclusive)} – ${toDateInput(endInclusive)}`,
  };
}

/** Resolves a preset (or a custom yyyy-mm-dd range) to a half-open [from, to) window in LOCAL time. */
export function resolvePeriod(preset: PeriodPreset, now: Date, custom?: { from: string; to: string }): ResolvedPeriod | { error: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const qStart = Math.floor(m / 3) * 3;
  switch (preset) {
    case 'this_month':
      return build(new Date(y, m, 1), new Date(y, m + 1, 0));
    case 'last_month':
      return build(new Date(y, m - 1, 1), new Date(y, m, 0));
    case 'this_quarter':
      return build(new Date(y, qStart, 1), new Date(y, qStart + 3, 0));
    case 'last_quarter':
      return build(new Date(y, qStart - 3, 1), new Date(y, qStart, 0));
    case 'year_to_date':
      return build(new Date(y, 0, 1), new Date(y, m, now.getDate()));
    case 'last_year':
      return build(new Date(y - 1, 0, 1), new Date(y - 1, 11, 31));
    case 'custom': {
      const a = parseDateInput(custom?.from ?? '');
      const b = parseDateInput(custom?.to ?? '');
      if (!a || !b) return { error: 'Enter a valid start and end date.' };
      if (b < a) return { error: 'The end date must be on or after the start date.' };
      const days = (b.getTime() - a.getTime()) / 86_400_000;
      if (days > 1095) return { error: 'A report can cover at most 3 years.' };
      return build(a, b);
    }
    default:
      return { error: 'Unknown period.' };
  }
}

/** Inclusive label for a stored [from, to) window. */
export function describeWindow(fromIso: string, toIso: string): string {
  const from = new Date(fromIso);
  const lastDay = new Date(new Date(toIso).getTime() - 1);
  if (Number.isNaN(from.getTime()) || Number.isNaN(lastDay.getTime())) return '—';
  return `${toDateInput(from)} – ${toDateInput(lastDay)}`;
}

/* ------------------------------------------------------------------ */
/* Normalization (the RPC returns jsonb; never trust its shape blindly)  */
/* ------------------------------------------------------------------ */

const asNum = (v: unknown, fallback = 0): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
};
const asNumOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = asNum(v, Number.NaN);
  return Number.isNaN(n) ? null : n;
};
const asStr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function normalizeReport(raw: unknown): UsageReport {
  const r = asObj(raw);
  const t = asObj(r.totals);
  return {
    generated_at: asStr(r.generated_at),
    period_from: asStr(r.period_from) ?? '',
    period_to: asStr(r.period_to) ?? '',
    restricted_only: r.restricted_only === true,
    entry_count: asNum(r.entry_count),
    voided_count: asNum(r.voided_count),
    truncated: r.truncated === true,
    totals: {
      restricted_applications: asNum(t.restricted_applications),
      distinct_products: asNum(t.distinct_products),
      distinct_applicators: asNum(t.distinct_applicators),
      distinct_sites: asNum(t.distinct_sites),
      missing_licence: asNum(t.missing_licence),
      missing_area: asNum(t.missing_area),
      missing_epa_reg: asNum(t.missing_epa_reg),
      ppe_not_confirmed: asNum(t.ppe_not_confirmed),
      customer_not_notified: asNum(t.customer_not_notified),
    },
    by_product: asArr(r.by_product).map((x) => {
      const p = asObj(x);
      return {
        product_id: asStr(p.product_id),
        product_name: asStr(p.product_name) ?? 'Unknown product',
        product_epa_reg: asStr(p.product_epa_reg),
        product_restricted: p.product_restricted === true,
        amount_unit: asStr(p.amount_unit),
        applications: asNum(p.applications),
        total_amount: asNum(p.total_amount),
        total_area_sqft: asNum(p.total_area_sqft),
        jobs: asNum(p.jobs),
        first_at: asStr(p.first_at),
        last_at: asStr(p.last_at),
      };
    }),
    by_applicator: asArr(r.by_applicator).map((x) => {
      const a = asObj(x);
      return {
        technician_id: asStr(a.technician_id),
        technician_name: asStr(a.technician_name) ?? 'Unknown technician',
        credential_type: asStr(a.credential_type),
        credential_number: asStr(a.credential_number),
        applications: asNum(a.applications),
        restricted_applications: asNum(a.restricted_applications),
        products: asNum(a.products),
        first_at: asStr(a.first_at),
        last_at: asStr(a.last_at),
      };
    }),
    rows: asArr(r.rows).map((x) => {
      const w = asObj(x);
      return {
        id: asStr(w.id) ?? '',
        performed_at: asStr(w.performed_at) ?? '',
        job_id: asStr(w.job_id),
        customer_id: asStr(w.customer_id),
        site_address: asStr(w.site_address),
        technician_id: asStr(w.technician_id),
        technician_name: asStr(w.technician_name),
        credential_type: asStr(w.credential_type),
        credential_number: asStr(w.credential_number),
        product_id: asStr(w.product_id),
        product_name: asStr(w.product_name),
        product_epa_reg: asStr(w.product_epa_reg),
        product_restricted: w.product_restricted === true,
        reentry_until: asStr(w.reentry_until),
        notes: asStr(w.notes),
        amount: asNumOrNull(w.amount),
        amount_unit: asStr(w.amount_unit),
        area_sqft: asNumOrNull(w.area_sqft),
        data: asObj(w.data),
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Gap flags (mirrors the counters in pesticide_usage_report())          */
/* ------------------------------------------------------------------ */

export type RowFlag = 'no_licence' | 'no_area' | 'no_epa_reg' | 'ppe_not_confirmed' | 'customer_not_notified';

export const FLAG_LABELS: Record<RowFlag, string> = {
  no_licence: 'No applicator licence on record',
  no_area: 'Treated area missing',
  no_epa_reg: 'No EPA registration number',
  ppe_not_confirmed: 'PPE not confirmed',
  customer_not_notified: 'Customer not notified',
};

export function rowFlags(row: UsageReportRow): RowFlag[] {
  const flags: RowFlag[] = [];
  if (!row.credential_number) flags.push('no_licence');
  if (row.area_sqft === null) flags.push('no_area');
  if (!row.product_epa_reg) flags.push('no_epa_reg');
  if (row.data.ppe_used === false) flags.push('ppe_not_confirmed');
  if (row.data.customer_notified === false) flags.push('customer_not_notified');
  return flags;
}

export interface ReadinessIssue {
  flag: RowFlag;
  count: number;
  label: string;
}

/** Gaps worth fixing (or explaining in the note) BEFORE sealing a report. Never blocks sealing. */
export function readinessIssues(report: UsageReport): ReadinessIssue[] {
  const t = report.totals;
  const raw: Array<[RowFlag, number]> = [
    ['no_licence', t.missing_licence],
    ['no_area', t.missing_area],
    ['no_epa_reg', t.missing_epa_reg],
    ['ppe_not_confirmed', t.ppe_not_confirmed],
    ['customer_not_notified', t.customer_not_notified],
  ];
  return raw.filter(([, n]) => n > 0).map(([flag, count]) => ({ flag, count, label: FLAG_LABELS[flag] }));
}

/* ------------------------------------------------------------------ */
/* Monthly breakdown                                                    */
/* ------------------------------------------------------------------ */

export interface MonthBucket {
  month: string; // yyyy-mm
  applications: number;
  restricted: number;
}

function monthKey(iso: string, timeZone?: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (!timeZone) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  return y && m ? `${y}-${m}` : null;
}

export function monthlyBreakdown(rows: UsageReportRow[], timeZone?: string): MonthBucket[] {
  const map = new Map<string, MonthBucket>();
  for (const r of rows) {
    const k = monthKey(r.performed_at, timeZone);
    if (!k) continue;
    const b = map.get(k) ?? { month: k, applications: 0, restricted: 0 };
    b.applications += 1;
    if (r.product_restricted) b.restricted += 1;
    map.set(k, b);
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/* ------------------------------------------------------------------ */
/* Formatting                                                           */
/* ------------------------------------------------------------------ */

export const UNIT_SHORT: Record<string, string> = { oz: 'oz', fl_oz: 'fl oz', lb: 'lb', gal: 'gal', qt: 'qt', g: 'g', kg: 'kg', ml: 'mL', l: 'L', each: 'ea' };

export const unitShort = (u: string | null): string => (u ? UNIT_SHORT[u] ?? u : '');

export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

/* ------------------------------------------------------------------ */
/* CSV                                                                  */
/* ------------------------------------------------------------------ */

type Cell = string | number | boolean | null | undefined;

/** RFC 4180 cell + spreadsheet-formula neutralization for text that starts with = + - @ (CSV injection). */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function localParts(iso: string, timeZone?: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const list = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('; ') : typeof v === 'string' ? v : '');
const bool = (v: unknown): string => (v === true ? 'Yes' : v === false ? 'No' : '');
const numOrEmpty = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One line per application — the form most agencies and auditors want. */
export function detailCsv(report: UsageReport, timeZone?: string): string {
  const header = [
    'Date', 'Time', 'Applicator', 'Licence type', 'Licence number', 'Site address', 'Product', 'EPA reg. no.', 'Restricted use',
    'Amount', 'Unit', 'Area treated (sq ft)', 'Dilution', 'Method', 'Site treated', 'Target pests', 'Wind (mph)', 'Temp (F)',
    'PPE worn', 'Customer notified', 'Re-entry until', 'Notes', 'Entry ID',
  ];
  const rows = report.rows.map((r) => {
    const t = localParts(r.performed_at, timeZone);
    const re = r.reentry_until ? localParts(r.reentry_until, timeZone) : null;
    return [
      t.date, t.time, r.technician_name, r.credential_type, r.credential_number, r.site_address, r.product_name, r.product_epa_reg,
      r.product_restricted, r.amount, unitShort(r.amount_unit), r.area_sqft, typeof r.data.dilution === 'string' ? r.data.dilution : '',
      typeof r.data.method === 'string' ? r.data.method : '', typeof r.data.application_site === 'string' ? r.data.application_site : '',
      list(r.data.target_pests), numOrEmpty(r.data.wind_mph), numOrEmpty(r.data.temp_f), bool(r.data.ppe_used), bool(r.data.customer_notified),
      re ? `${re.date} ${re.time}` : '', r.notes, r.id,
    ];
  });
  return toCsv(header, rows);
}

/** Totals per product + unit (amounts are NEVER added across different units). */
export function productSummaryCsv(report: UsageReport, timeZone?: string): string {
  const header = ['Product', 'EPA reg. no.', 'Restricted use', 'Unit', 'Applications', 'Total amount', 'Total area (sq ft)', 'Jobs', 'First use', 'Last use'];
  const rows = report.by_product.map((p) => [
    p.product_name, p.product_epa_reg, p.product_restricted, unitShort(p.amount_unit), p.applications, p.total_amount, p.total_area_sqft, p.jobs,
    p.first_at ? localParts(p.first_at, timeZone).date : '', p.last_at ? localParts(p.last_at, timeZone).date : '',
  ]);
  return toCsv(header, rows);
}

export function reportFileName(kind: 'detail' | 'products', fromIso: string, toIso: string): string {
  const last = new Date(new Date(toIso).getTime() - 1);
  const a = new Date(fromIso);
  const ok = !Number.isNaN(a.getTime()) && !Number.isNaN(last.getTime());
  return `pesticide-usage-${kind}-${ok ? `${toDateInput(a)}_to_${toDateInput(last)}` : 'report'}.csv`;
}
