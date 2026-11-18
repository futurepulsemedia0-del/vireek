/**
 * Sales-tax / VAT nexus tracker — pure logic (no React, no network).
 *
 * Compares Vireek's OWN subscription revenue per jurisdiction (from staff_nexus_revenue()) with the thresholds in
 * config/nexus-thresholds.json. Thresholds are [COUNSEL][VERIFY]: this module never supplies a default value, and a
 * jurisdiction without a complete threshold is reported as `not_configured`, never as `below`.
 *
 * Output is an internal early-warning aid, NOT a legal determination of nexus or a registration obligation.
 */
import { csvCell } from '@/lib/staffUsage';

export type NexusStatus = 'below' | 'approaching' | 'exceeded' | 'not_configured' | 'currency_mismatch';
export type NexusWindow = 'rolling_12m' | 'calendar_year' | 'prior_or_current_calendar_year';
export type NexusBasis = 'gross' | 'net_of_tax';
export type NexusComparison = 'gte' | 'gt';
export type WindowKey = 'rolling_12m' | 'calendar_year' | 'prior_calendar_year';

export const WINDOWS: readonly NexusWindow[] = ['rolling_12m', 'calendar_year', 'prior_or_current_calendar_year'];
export const DEFAULT_APPROACHING_RATIO = 0.8;
export const UNKNOWN_KEY = 'UNKNOWN';
export const US_UNKNOWN_KEY = 'US-UNKNOWN';

export interface WindowTotals { grossCents: number; taxCents: number; n: number }
export interface RevenueRow {
  country: string | null;
  state: string | null;
  currency: string;
  unresolved: boolean;
  windows: Record<WindowKey, WindowTotals>;
}
export interface Coverage { billingInvoicesSeen: number; ledgerInvoices: number; firstPaidAt: string | null; lastPaidAt: string | null }
export interface RevenueReport { asOf: string; generatedAt: string; rows: RevenueRow[]; coverage: Coverage }

export interface JurisdictionConfig {
  name: string;
  kind: 'us_state' | 'country';
  currency: string | null;
  revenueThresholdCents: number | null;
  transactionThreshold: number | null;
  window: NexusWindow | null;
  basis: NexusBasis | null;
  comparison: NexusComparison | null;
  effectiveFrom: string | null;
  sourceUrl: string | null;
  reviewedBy: string | null;
  reviewedOn: string | null;
}
export interface NexusConfig {
  reviewStatus: string;
  approachingRatio: number;
  jurisdictions: Record<string, JurisdictionConfig>;
}

export interface TrackerRow {
  key: string;
  name: string;
  country: string | null;
  state: string | null;
  currency: string | null;
  status: NexusStatus;
  window: NexusWindow | null;
  basis: NexusBasis | null;
  grossCents: number;
  taxCents: number;
  revenueCents: number; // under `basis` (gross when unconfigured)
  invoices: number;
  revenueThresholdCents: number | null;
  transactionThreshold: number | null;
  revenuePct: number | null;
  transactionPct: number | null;
  reviewed: boolean;
  unresolved: boolean;
  reason: string;
}

/* ---------- defensive parsing ---------- */
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
};
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const posIntOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

function totals(v: unknown): WindowTotals {
  const r = rec(v);
  return { grossCents: num(r.gross_cents), taxCents: num(r.tax_cents), n: num(r.n) };
}

export function parseRevenueReport(v: unknown): RevenueReport {
  const r = rec(v);
  const cov = rec(r.coverage);
  const rows: RevenueRow[] = arr(r.rows).map((x) => {
    const o = rec(x);
    const w = rec(o.windows);
    return {
      country: strOrNull(o.country),
      state: strOrNull(o.state),
      currency: (strOrNull(o.currency) ?? 'unknown').toLowerCase(),
      unresolved: o.unresolved === true,
      windows: { rolling_12m: totals(w.rolling_12m), calendar_year: totals(w.calendar_year), prior_calendar_year: totals(w.prior_calendar_year) },
    };
  });
  return {
    asOf: strOrNull(r.as_of) ?? '',
    generatedAt: strOrNull(r.generated_at) ?? '',
    rows,
    coverage: {
      billingInvoicesSeen: num(cov.billing_invoices_seen),
      ledgerInvoices: num(cov.ledger_invoices),
      firstPaidAt: strOrNull(cov.first_paid_at),
      lastPaidAt: strOrNull(cov.last_paid_at),
    },
  };
}

/** Jurisdiction key used by the config: "US-CA", "GB", or UNKNOWN / US-UNKNOWN for unattributable revenue. */
export function jurisdictionKey(country: string | null, state: string | null): string {
  if (!country) return UNKNOWN_KEY;
  if (country === 'US') return state ? `US-${state}` : US_UNKNOWN_KEY;
  return country;
}

/** Validates the config file's shape. Returns problems instead of throwing so the page can show them. */
export function parseNexusConfig(raw: unknown): { config: NexusConfig; problems: string[] } {
  const r = rec(raw);
  const problems: string[] = [];
  const meta = rec(r._meta);
  const ratioRaw = rec(r.alerting).approachingRatio;
  let approachingRatio = DEFAULT_APPROACHING_RATIO;
  if (typeof ratioRaw === 'number' && ratioRaw > 0 && ratioRaw < 1) approachingRatio = ratioRaw;
  else problems.push('alerting.approachingRatio must be a number between 0 and 1 (exclusive); using the default.');

  const jurisdictions: Record<string, JurisdictionConfig> = {};
  for (const [key, val] of Object.entries(rec(r.jurisdictions))) {
    if (!/^(US-[A-Z]{2}|[A-Z]{2})$/.test(key)) { problems.push(`${key}: invalid jurisdiction key (use "US-<USPS>" or an ISO 3166-1 alpha-2 code).`); continue; }
    const o = rec(val);
    const window = typeof o.window === 'string' && (WINDOWS as readonly string[]).includes(o.window) ? (o.window as NexusWindow) : null;
    const basis = o.basis === 'gross' || o.basis === 'net_of_tax' ? o.basis : null;
    const comparison = o.comparison === 'gte' || o.comparison === 'gt' ? o.comparison : null;
    const revenue = posIntOrNull(o.revenueThresholdCents);
    const tx = posIntOrNull(o.transactionThreshold);
    if (o.revenueThresholdCents != null && revenue === null) problems.push(`${key}: revenueThresholdCents must be a positive integer (minor units) or null.`);
    if (o.transactionThreshold != null && tx === null) problems.push(`${key}: transactionThreshold must be a positive integer or null.`);
    if (o.window != null && window === null) problems.push(`${key}: unknown window.`);
    const currency = typeof o.currency === 'string' && /^[a-z]{3}$/.test(o.currency) ? o.currency : null;
    if (revenue !== null && currency === null) problems.push(`${key}: a revenue threshold needs a lower-case ISO 4217 currency.`);
    jurisdictions[key] = {
      name: strOrNull(o.name) ?? key,
      kind: o.kind === 'us_state' ? 'us_state' : 'country',
      currency,
      revenueThresholdCents: revenue,
      transactionThreshold: tx,
      window,
      basis,
      comparison,
      effectiveFrom: strOrNull(o.effectiveFrom),
      sourceUrl: strOrNull(o.sourceUrl),
      reviewedBy: strOrNull(o.reviewedBy),
      reviewedOn: strOrNull(o.reviewedOn),
    };
  }
  return { config: { reviewStatus: strOrNull(meta.status) ?? 'UNREVIEWED [COUNSEL][VERIFY]', approachingRatio, jurisdictions }, problems };
}

/** A threshold is only usable when value, window and (for revenue) currency are all set. Never defaulted. */
export function isConfigured(c: JurisdictionConfig | undefined): c is JurisdictionConfig {
  if (!c || c.window === null) return false;
  return c.revenueThresholdCents !== null || c.transactionThreshold !== null;
}

export function pickWindow(rowWindows: RevenueRow['windows'], window: NexusWindow): WindowTotals {
  if (window === 'rolling_12m') return rowWindows.rolling_12m;
  if (window === 'calendar_year') return rowWindows.calendar_year;
  const a = rowWindows.calendar_year;
  const b = rowWindows.prior_calendar_year;
  const cur = { grossCents: a.grossCents, taxCents: a.taxCents, n: a.n };
  const prev = { grossCents: b.grossCents, taxCents: b.taxCents, n: b.n };
  // "prior or current calendar year": evaluate whichever year is higher (revenue first, then count).
  return prev.grossCents > cur.grossCents || (prev.grossCents === cur.grossCents && prev.n > cur.n) ? prev : cur;
}

function level(value: number, threshold: number, comparison: NexusComparison, ratio: number): 'below' | 'approaching' | 'exceeded' {
  const hit = comparison === 'gt' ? value > threshold : value >= threshold;
  if (hit) return 'exceeded';
  return value >= threshold * ratio ? 'approaching' : 'below';
}
const RANK: Record<'below' | 'approaching' | 'exceeded', number> = { below: 0, approaching: 1, exceeded: 2 };

export function evaluateRow(row: RevenueRow, cfg: JurisdictionConfig | undefined, ratio: number): TrackerRow {
  const key = jurisdictionKey(row.country, row.state);
  const name = cfg?.name ?? (key === UNKNOWN_KEY ? 'Unknown (no billing address)' : key === US_UNKNOWN_KEY ? 'United States (state unresolved)' : key);
  const base = {
    key, name, country: row.country, state: row.state, currency: row.currency,
    revenueThresholdCents: cfg?.revenueThresholdCents ?? null, transactionThreshold: cfg?.transactionThreshold ?? null,
    reviewed: Boolean(cfg?.reviewedBy && cfg?.reviewedOn && cfg?.sourceUrl), unresolved: row.unresolved,
  };
  if (!isConfigured(cfg)) {
    const w = row.windows.rolling_12m;
    return { ...base, status: 'not_configured', window: null, basis: null, grossCents: w.grossCents, taxCents: w.taxCents, revenueCents: w.grossCents,
      invoices: w.n, revenuePct: null, transactionPct: null, reason: 'No complete threshold in config/nexus-thresholds.json [COUNSEL][VERIFY].' };
  }
  const window = cfg.window as NexusWindow;
  const w = pickWindow(row.windows, window);
  const basis: NexusBasis = cfg.basis ?? 'gross';
  const revenueCents = basis === 'net_of_tax' ? Math.max(0, w.grossCents - w.taxCents) : w.grossCents;
  const common = { ...base, window, basis, grossCents: w.grossCents, taxCents: w.taxCents, revenueCents, invoices: w.n };
  const usesRevenue = cfg.revenueThresholdCents !== null;
  if (usesRevenue && row.currency !== cfg.currency) {
    return { ...common, status: 'currency_mismatch', revenuePct: null, transactionPct: null, reason: `Billed in ${row.currency.toUpperCase()} but threshold is in ${(cfg.currency ?? '?').toUpperCase()}; no FX conversion is applied.` };
  }
  const comparison = cfg.comparison ?? 'gte';
  const parts: Array<'below' | 'approaching' | 'exceeded'> = [];
  let revenuePct: number | null = null;
  let transactionPct: number | null = null;
  if (cfg.revenueThresholdCents !== null) {
    revenuePct = (revenueCents / cfg.revenueThresholdCents) * 100;
    parts.push(level(revenueCents, cfg.revenueThresholdCents, comparison, ratio));
  }
  if (cfg.transactionThreshold !== null) {
    transactionPct = (w.n / cfg.transactionThreshold) * 100;
    parts.push(level(w.n, cfg.transactionThreshold, comparison, ratio));
  }
  const status = parts.reduce((worst, p) => (RANK[p] > RANK[worst] ? p : worst), 'below' as 'below' | 'approaching' | 'exceeded');
  return { ...common, status, revenuePct, transactionPct, reason: '' };
}

/**
 * Merges revenue rows with the configured jurisdictions. Configured jurisdictions with no revenue appear as zero rows
 * (so a threshold can be tracked before the first sale). Unattributable revenue is always kept and shown.
 */
export function buildTracker(report: RevenueReport, config: NexusConfig): TrackerRow[] {
  const out: TrackerRow[] = [];
  const seen = new Set<string>();
  for (const row of report.rows) {
    const key = jurisdictionKey(row.country, row.state);
    seen.add(key);
    out.push(evaluateRow(row, config.jurisdictions[key], config.approachingRatio));
  }
  for (const [key, cfg] of Object.entries(config.jurisdictions)) {
    if (seen.has(key)) continue;
    const [country, state] = key.startsWith('US-') ? ['US', key.slice(3)] : [key, null];
    const zero: WindowTotals = { grossCents: 0, taxCents: 0, n: 0 };
    out.push(evaluateRow({ country, state, currency: cfg.currency ?? 'usd', unresolved: false, windows: { rolling_12m: zero, calendar_year: zero, prior_calendar_year: zero } }, cfg, config.approachingRatio));
  }
  return sortTracker(out);
}

const STATUS_ORDER: Record<NexusStatus, number> = { exceeded: 0, approaching: 1, currency_mismatch: 2, below: 3, not_configured: 4 };
export function sortTracker(rows: TrackerRow[]): TrackerRow[] {
  return [...rows].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.revenueCents - a.revenueCents || a.key.localeCompare(b.key) || (a.currency ?? '').localeCompare(b.currency ?? ''));
}

export interface TrackerSummary { exceeded: number; approaching: number; below: number; notConfigured: number; currencyMismatch: number; unattributedCents: Record<string, number>; configuredCount: number }
export function summarize(rows: TrackerRow[], config: NexusConfig): TrackerSummary {
  const s: TrackerSummary = { exceeded: 0, approaching: 0, below: 0, notConfigured: 0, currencyMismatch: 0, unattributedCents: {}, configuredCount: Object.values(config.jurisdictions).filter(isConfigured).length };
  for (const r of rows) {
    if (r.status === 'exceeded') s.exceeded += 1;
    else if (r.status === 'approaching') s.approaching += 1;
    else if (r.status === 'below') s.below += 1;
    else if (r.status === 'currency_mismatch') s.currencyMismatch += 1;
    else s.notConfigured += 1;
    if (r.key === UNKNOWN_KEY || r.key === US_UNKNOWN_KEY) s.unattributedCents[r.currency ?? 'unknown'] = (s.unattributedCents[r.currency ?? 'unknown'] ?? 0) + r.grossCents;
  }
  return s;
}

/** Ledger vs billing_events mismatch means the numbers may be incomplete; the page shows a warning. */
export function coverageGap(c: Coverage): number {
  return Math.max(0, c.billingInvoicesSeen - c.ledgerInvoices);
}

/* ---------- formatting + CSV ---------- */
export function formatMoney(cents: number, currency: string | null, locale = 'en-US'): string {
  const code = currency && /^[a-z]{3}$/i.test(currency) ? currency.toUpperCase() : 'USD';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}
export const formatPct = (p: number | null): string => (p === null ? '' : `${p.toFixed(1)}%`);
const major = (cents: number): string => (cents / 100).toFixed(2);

export const NEXUS_CSV_HEADER = [
  'as_of_utc', 'jurisdiction', 'name', 'country', 'state', 'currency', 'status', 'window', 'basis',
  'gross_revenue', 'tax', 'revenue_on_basis', 'invoices', 'revenue_threshold', 'revenue_pct', 'transaction_threshold', 'transaction_pct',
  'threshold_reviewed', 'config_review_status', 'note',
] as const;

export function trackerToCsv(rows: TrackerRow[], asOf: string, config: NexusConfig): string {
  const lines: string[] = [NEXUS_CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push([
      asOf, r.key, r.name, r.country ?? '', r.state ?? '', r.currency ?? '', r.status, r.window ?? '', r.basis ?? '',
      major(r.grossCents), major(r.taxCents), major(r.revenueCents), r.invoices,
      r.revenueThresholdCents === null ? '' : major(r.revenueThresholdCents), r.revenuePct === null ? '' : r.revenuePct.toFixed(1),
      r.transactionThreshold ?? '', r.transactionPct === null ? '' : r.transactionPct.toFixed(1),
      r.reviewed ? 'yes' : 'no', config.reviewStatus, r.reason,
    ].map((c) => csvCell(typeof c === 'number' ? c : String(c))).join(','));
  }
  return lines.join('\r\n');
}
