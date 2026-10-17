/* ------------------------------------------------------------------ */
/*  taxCenter — jurisdiction sales-tax engine (pure, framework-free)   */
/*                                                                      */
/*  Separate from lib/tax.ts (EU VAT). All money is integer cents.     */
/*  Flow: address -> jurisdiction stack -> per-line class treatment    */
/*  -> exemption check -> expected tax vs. tax actually collected      */
/*  -> filing-ready report grouped by jurisdiction.                    */
/*  Rates are reference data the owner maintains (or TaxJar syncs);    */
/*  the report is a worksheet to file from, not legal advice.          */
/* ------------------------------------------------------------------ */

import type { QuoteLineItem } from '@/lib/quotes';

export type JurisdictionLevel = 'state' | 'county' | 'city' | 'district';
export type TaxTreatment = 'taxable' | 'reduced' | 'exempt';
export type TaxProviderId = 'manual' | 'taxjar';
export type FilingFrequency = 'monthly' | 'quarterly' | 'annually';
export type ExemptionReason = 'resale' | 'nonprofit' | 'government' | 'agricultural' | 'manufacturing' | 'other';

export interface TaxJurisdiction {
  id: string;
  name: string;
  level: JurisdictionLevel;
  state: string | null;
  postal_codes: string[];
  rate_percent: number;
  effective_from: string | null;
  effective_to: string | null;
  source: 'manual' | 'taxjar';
  active: boolean;
}

export interface TaxClass {
  id: string;
  name: string;
  treatment: TaxTreatment;
  reduced_percent: number;
  description: string | null;
}

export interface TaxExemption {
  id: string;
  customer_id: string | null;
  customer_name: string;
  reason: ExemptionReason;
  certificate_number: string | null;
  states: string[];
  issued_on: string | null;
  expires_on: string | null;
  status: 'active' | 'revoked';
  notes: string | null;
}

export interface TaxSettings {
  provider: TaxProviderId;
  default_tax_class_id: string | null;
  filing_frequency: FilingFrequency;
  taxjar_connected: boolean;
  taxjar_last_synced_at: string | null;
}

export const DEFAULT_TAX_SETTINGS: TaxSettings = {
  provider: 'manual',
  default_tax_class_id: null,
  filing_frequency: 'quarterly',
  taxjar_connected: false,
  taxjar_last_synced_at: null,
};

export const LEVEL_LABELS: Record<JurisdictionLevel, string> = {
  state: 'State',
  county: 'County',
  city: 'City',
  district: 'Special district',
};
const LEVEL_ORDER: Record<JurisdictionLevel, number> = { state: 0, county: 1, city: 2, district: 3 };

export const TREATMENT_LABELS: Record<TaxTreatment, string> = {
  taxable: 'Taxable',
  reduced: 'Reduced rate',
  exempt: 'Exempt / non-taxable',
};

export const EXEMPTION_REASON_LABELS: Record<ExemptionReason, string> = {
  resale: 'Resale',
  nonprofit: 'Nonprofit',
  government: 'Government',
  agricultural: 'Agricultural',
  manufacturing: 'Manufacturing',
  other: 'Other',
};

export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
  'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR',
  'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;
const STATE_SET = new Set<string>(US_STATES);

/* ----------------------------- helpers ----------------------------- */

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(4))}%`;
}

/** Rounds a percentage-of-cents amount half-up, safe for the values we handle. */
function pct(cents: number, ratePercent: number): number {
  return Math.round((cents * ratePercent) / 100);
}

export function extractPostalCode(address: string | null | undefined): string | null {
  if (!address) return null;
  const all = address.match(/\b\d{5}(?:-\d{4})?\b/g);
  if (!all) return null;
  return all[all.length - 1].slice(0, 5); // ZIP sits at the end of a US address
}

export function extractState(address: string | null | undefined): string | null {
  if (!address) return null;
  const upper = address.toUpperCase();
  // Prefer the "ST 12345" form, then a standalone ", ST" segment.
  const withZip = upper.match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/);
  if (withZip && STATE_SET.has(withZip[1])) return withZip[1];
  const segments = upper.split(/[,\s]+/).filter(Boolean).reverse();
  for (const seg of segments) if (STATE_SET.has(seg)) return seg;
  return null;
}

export function normalizePostalEntry(raw: string): string | null {
  const v = raw.trim();
  if (/^\d{5}$/.test(v)) return v;
  if (/^\d{1,4}\*$/.test(v)) return v;
  return null;
}

export function parsePostalList(input: string): { codes: string[]; invalid: string[] } {
  const codes: string[] = [];
  const invalid: string[] = [];
  for (const part of input.split(/[\s,;]+/).filter(Boolean)) {
    const n = normalizePostalEntry(part);
    if (n) {
      if (!codes.includes(n)) codes.push(n);
    } else invalid.push(part);
  }
  return { codes, invalid };
}

function postalMatches(codes: string[], zip: string): boolean {
  return codes.some((c) => (c.endsWith('*') ? zip.startsWith(c.slice(0, -1)) : c === zip));
}

function inWindow(j: Pick<TaxJurisdiction, 'effective_from' | 'effective_to'>, onDate: string): boolean {
  if (j.effective_from && onDate < j.effective_from) return false;
  if (j.effective_to && onDate > j.effective_to) return false;
  return true;
}

/* ------------------------- jurisdiction match ----------------------- */

export interface JurisdictionMatch {
  jurisdictions: TaxJurisdiction[];
  combinedRate: number;
  zip: string | null;
  state: string | null;
}

/**
 * State-wide rows (no postal codes) apply when the address state matches.
 * Local rows (county/city/district) apply only on a postal-code match.
 * `onDate` is YYYY-MM-DD so rate changes apply to the invoice date.
 */
export function matchJurisdictions(
  address: string | null | undefined,
  all: TaxJurisdiction[],
  onDate: string,
): JurisdictionMatch {
  const zip = extractPostalCode(address);
  const state = extractState(address);
  const matched = all.filter((j) => {
    if (!j.active || !inWindow(j, onDate)) return false;
    if (j.postal_codes.length > 0) {
      if (!zip || !postalMatches(j.postal_codes, zip)) return false;
      return !j.state || !state || j.state === state;
    }
    return j.level === 'state' && !!state && j.state === state;
  });
  matched.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.name.localeCompare(b.name));
  const combinedRate = Number(matched.reduce((s, j) => s + j.rate_percent, 0).toFixed(4));
  return { jurisdictions: matched, combinedRate, zip, state };
}

/* ------------------------- class + exemption ------------------------ */

export function effectiveRate(rate: number, cls: Pick<TaxClass, 'treatment' | 'reduced_percent'> | null): number {
  if (!cls || cls.treatment === 'taxable') return rate;
  if (cls.treatment === 'exempt') return 0;
  return Number(((rate * cls.reduced_percent) / 100).toFixed(4));
}

export function findExemption(
  exemptions: TaxExemption[],
  customerId: string | null,
  customerName: string,
  state: string | null,
  onDate: string,
): TaxExemption | null {
  const name = customerName.trim().toLowerCase();
  return (
    exemptions.find((e) => {
      if (e.status !== 'active') return false;
      if (e.expires_on && e.expires_on < onDate) return false;
      if (e.issued_on && e.issued_on > onDate) return false;
      if (e.states.length > 0 && (!state || !e.states.includes(state))) return false;
      if (customerId && e.customer_id === customerId) return true;
      return !e.customer_id && e.customer_name.trim().toLowerCase() === name;
    }) ?? null
  );
}

/** Maps invoice line descriptions to a class via the price book (exact, then contains). */
export function resolveLineClass(
  description: string,
  serviceClassByName: Map<string, string | null>,
  classes: Map<string, TaxClass>,
  defaultClassId: string | null,
): TaxClass | null {
  const d = description.trim().toLowerCase();
  let classId: string | null | undefined = serviceClassByName.get(d);
  if (classId === undefined && d) {
    for (const [name, id] of serviceClassByName) {
      if (name && (d.includes(name) || name.includes(d))) {
        classId = id;
        break;
      }
    }
  }
  const id = classId ?? defaultClassId;
  return id ? (classes.get(id) ?? null) : null;
}

/* ----------------------------- per invoice -------------------------- */

export interface ReportInvoiceRow {
  id: string;
  invoice_number: string;
  customer_name: string;
  status: string;
  line_items: QuoteLineItem[] | null;
  tax_percent: number;
  billed_at: string;
  customer_id: string | null;
  address: string | null;
}

export interface TaxContext {
  jurisdictions: TaxJurisdiction[];
  classes: TaxClass[];
  exemptions: TaxExemption[];
  /** lower-cased price-book service_name -> tax_class_id */
  serviceClassByName: Map<string, string | null>;
  defaultClassId: string | null;
}

export type InvoiceFlag = 'no_jurisdiction' | 'no_address' | 'under_collected' | 'over_collected' | 'exempt_customer' | 'tax_on_exempt';

export interface JurisdictionShare {
  jurisdictionId: string;
  name: string;
  level: JurisdictionLevel;
  state: string | null;
  rate: number;
  taxableCents: number;
  expectedCents: number;
  collectedCents: number;
}

export interface InvoiceTaxResult {
  id: string;
  invoice_number: string;
  customer_name: string;
  billedOn: string;
  subtotalCents: number;
  taxableCents: number;
  exemptCents: number;
  expectedTaxCents: number;
  collectedTaxCents: number;
  varianceCents: number; // collected - expected (negative = under-collected)
  combinedRate: number;
  exemptionId: string | null;
  shares: JurisdictionShare[];
  flags: InvoiceFlag[];
}

/** Splits `total` across weights using largest-remainder so the parts sum exactly. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0) return [];
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let left = total - floors.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r);
  for (let k = 0; left > 0 && k < order.length; k++, left--) floors[order[k].i] += 1;
  return floors;
}

export function computeInvoiceTax(inv: ReportInvoiceRow, ctx: TaxContext): InvoiceTaxResult {
  const billedOn = inv.billed_at.slice(0, 10);
  const lines = Array.isArray(inv.line_items) ? inv.line_items : [];
  const classMap = new Map(ctx.classes.map((c) => [c.id, c]));
  const match = matchJurisdictions(inv.address, ctx.jurisdictions, billedOn);
  const exemption = findExemption(ctx.exemptions, inv.customer_id, inv.customer_name, match.state, billedOn);

  const flags: InvoiceFlag[] = [];
  if (!inv.address) flags.push('no_address');
  else if (match.jurisdictions.length === 0) flags.push('no_jurisdiction');
  if (exemption) flags.push('exempt_customer');

  let subtotal = 0;
  let taxable = 0;
  let expected = 0;
  for (const li of lines) {
    const amount = Math.round((li.quantity || 0) * (li.unit_price_cents || 0));
    subtotal += amount;
    if (exemption) continue;
    const cls = resolveLineClass(li.description ?? '', ctx.serviceClassByName, classMap, ctx.defaultClassId);
    const rate = effectiveRate(match.combinedRate, cls);
    if (rate > 0) {
      taxable += amount;
      expected += pct(amount, rate);
    }
  }
  const exemptCents = subtotal - taxable;
  const collected = pct(subtotal, inv.tax_percent || 0);
  const variance = collected - expected;
  if (match.jurisdictions.length > 0) {
    if (variance <= -2) flags.push('under_collected');
    if (variance >= 2) flags.push('over_collected');
  }
  if (exemption && collected > 0) flags.push('tax_on_exempt');

  const weights = match.jurisdictions.map((j) => j.rate_percent);
  const expShares = allocate(expected, weights);
  const colShares = allocate(collected, weights);
  const shares: JurisdictionShare[] = match.jurisdictions.map((j, i) => ({
    jurisdictionId: j.id,
    name: j.name,
    level: j.level,
    state: j.state,
    rate: j.rate_percent,
    taxableCents: taxable,
    expectedCents: expShares[i],
    collectedCents: colShares[i],
  }));

  return {
    id: inv.id,
    invoice_number: inv.invoice_number,
    customer_name: inv.customer_name,
    billedOn,
    subtotalCents: subtotal,
    taxableCents: taxable,
    exemptCents,
    expectedTaxCents: expected,
    collectedTaxCents: collected,
    varianceCents: variance,
    combinedRate: match.combinedRate,
    exemptionId: exemption?.id ?? null,
    shares,
    flags,
  };
}

/* ------------------------------ report ------------------------------ */

export interface FilingLine {
  jurisdictionId: string;
  name: string;
  level: JurisdictionLevel;
  state: string | null;
  rate: number;
  grossSalesCents: number;
  taxableSalesCents: number;
  exemptSalesCents: number;
  taxDueCents: number;
  taxCollectedCents: number;
  varianceCents: number;
  invoiceCount: number;
}

export interface TaxReport {
  from: string;
  to: string;
  invoices: InvoiceTaxResult[];
  lines: FilingLine[];
  totals: {
    grossSalesCents: number;
    taxableSalesCents: number;
    exemptSalesCents: number;
    expectedTaxCents: number;
    collectedTaxCents: number;
    varianceCents: number;
    invoiceCount: number;
  };
  /** Sales that matched no jurisdiction — cannot be filed until fixed. */
  unmatchedCount: number;
  unmatchedSalesCents: number;
}

export function buildTaxReport(rows: ReportInvoiceRow[], ctx: TaxContext, from: string, to: string): TaxReport {
  const invoices = rows.map((r) => computeInvoiceTax(r, ctx));
  const map = new Map<string, FilingLine>();
  let unmatchedCount = 0;
  let unmatchedSales = 0;

  for (const inv of invoices) {
    if (inv.flags.includes('no_jurisdiction') || inv.flags.includes('no_address')) {
      unmatchedCount += 1;
      unmatchedSales += inv.subtotalCents;
    }
    for (const s of inv.shares) {
      const line =
        map.get(s.jurisdictionId) ??
        ({
          jurisdictionId: s.jurisdictionId,
          name: s.name,
          level: s.level,
          state: s.state,
          rate: s.rate,
          grossSalesCents: 0,
          taxableSalesCents: 0,
          exemptSalesCents: 0,
          taxDueCents: 0,
          taxCollectedCents: 0,
          varianceCents: 0,
          invoiceCount: 0,
        } satisfies FilingLine);
      line.grossSalesCents += inv.subtotalCents;
      line.taxableSalesCents += s.taxableCents;
      line.exemptSalesCents += inv.subtotalCents - s.taxableCents;
      line.taxDueCents += s.expectedCents;
      line.taxCollectedCents += s.collectedCents;
      line.invoiceCount += 1;
      map.set(s.jurisdictionId, line);
    }
  }

  const lines = [...map.values()]
    .map((l) => ({ ...l, varianceCents: l.taxCollectedCents - l.taxDueCents }))
    .sort((a, b) => (a.state ?? '').localeCompare(b.state ?? '') || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.name.localeCompare(b.name));

  const totals = invoices.reduce(
    (t, i) => ({
      grossSalesCents: t.grossSalesCents + i.subtotalCents,
      taxableSalesCents: t.taxableSalesCents + i.taxableCents,
      exemptSalesCents: t.exemptSalesCents + i.exemptCents,
      expectedTaxCents: t.expectedTaxCents + i.expectedTaxCents,
      collectedTaxCents: t.collectedTaxCents + i.collectedTaxCents,
      varianceCents: t.varianceCents + i.varianceCents,
      invoiceCount: t.invoiceCount + 1,
    }),
    { grossSalesCents: 0, taxableSalesCents: 0, exemptSalesCents: 0, expectedTaxCents: 0, collectedTaxCents: 0, varianceCents: 0, invoiceCount: 0 },
  );

  return { from, to, invoices, lines, totals, unmatchedCount, unmatchedSalesCents: unmatchedSales };
}

/* ------------------------------ periods ----------------------------- */

function iso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Period containing `now`, or the previous one when `previous` is true. */
export function filingPeriod(freq: FilingFrequency, now: Date, previous = false): { from: string; to: string; label: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const size = freq === 'monthly' ? 1 : freq === 'quarterly' ? 3 : 12;
  let startMonth = freq === 'annually' ? 0 : Math.floor(m / size) * size;
  let year = y;
  if (previous) {
    startMonth -= size;
    if (startMonth < 0) {
      startMonth += 12;
      year -= 1;
    }
  }
  const from = new Date(Date.UTC(year, startMonth, 1));
  const to = new Date(Date.UTC(year, startMonth + size, 0));
  const label =
    freq === 'monthly'
      ? from.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      : freq === 'quarterly'
        ? `Q${Math.floor(startMonth / 3) + 1} ${year}`
        : String(year);
  return { from: iso(from), to: iso(to), label };
}

/* ------------------------------- CSV -------------------------------- */

function cell(v: string | number): string {
  const s = String(v);
  // Neutralise spreadsheet formula injection from customer-supplied text.
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === 'string' ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
const dollars = (c: number) => (c / 100).toFixed(2);

/** Filing worksheet: one row per jurisdiction, plus totals. */
export function filingCsv(report: TaxReport): string {
  const head = ['Jurisdiction', 'Level', 'State', 'Rate %', 'Gross sales', 'Taxable sales', 'Exempt sales', 'Tax due', 'Tax collected', 'Variance', 'Invoices'];
  const rows = report.lines.map((l) => [
    l.name, LEVEL_LABELS[l.level], l.state ?? '', l.rate, dollars(l.grossSalesCents), dollars(l.taxableSalesCents),
    dollars(l.exemptSalesCents), dollars(l.taxDueCents), dollars(l.taxCollectedCents), dollars(l.varianceCents), l.invoiceCount,
  ]);
  rows.push([
    'TOTAL', '', '', '', dollars(report.totals.grossSalesCents), dollars(report.totals.taxableSalesCents),
    dollars(report.totals.exemptSalesCents), dollars(report.totals.expectedTaxCents), dollars(report.totals.collectedTaxCents),
    dollars(report.totals.varianceCents), report.totals.invoiceCount,
  ]);
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

/** Invoice-level audit trail behind the filing numbers. */
export function invoiceDetailCsv(report: TaxReport): string {
  const head = ['Invoice', 'Date', 'Customer', 'Subtotal', 'Taxable', 'Exempt', 'Combined rate %', 'Expected tax', 'Collected tax', 'Variance', 'Flags'];
  const rows = report.invoices.map((i) => [
    i.invoice_number, i.billedOn, i.customer_name, dollars(i.subtotalCents), dollars(i.taxableCents), dollars(i.exemptCents),
    i.combinedRate, dollars(i.expectedTaxCents), dollars(i.collectedTaxCents), dollars(i.varianceCents), i.flags.join(' | '),
  ]);
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

export function downloadCsv(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
