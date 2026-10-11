/* ------------------------------------------------------------------ */
/*  salesTax — US sales tax for quotes & invoices                       */
/*                                                                      */
/*  Framework-free and side-effect-free on purpose: the same engine     */
/*  runs in the quote/invoice builders, the tests, and (later) an edge  */
/*  function. All money is integer cents. Every rate component is       */
/*  rounded on its own (half-up) because each one is reported to a      */
/*  different authority.                                                */
/*                                                                      */
/*  tax_percent stays the EFFECTIVE rate (tax / subtotal) so existing   */
/*  calculateQuoteTotals() callers keep producing identical cents.      */
/* ------------------------------------------------------------------ */

import type { QuoteLineItem } from '@/lib/quotes';

// ---------------------------------------------------------------- types

export type TaxLevel = 'state' | 'county' | 'city' | 'district';
export type ExemptionType = 'resale' | 'government' | 'nonprofit' | 'agricultural' | 'manufacturing' | 'religious' | 'other';
export type ExemptionStatus = 'pending' | 'verified' | 'rejected' | 'revoked';
export type TaxStatus = 'calculated' | 'no_address' | 'no_rates' | 'not_collecting';
export type LineTreatment = 'taxable' | 'class_non_taxable' | 'exempt';

export interface ServiceAddress {
  line1?: string;
  city: string;
  state: string;
  postal_code: string;
  county?: string;
}

export interface TaxRateComponent {
  id?: string;
  level: TaxLevel;
  name: string;
  ratePercent: number;
  source?: string;
  isAccountRate?: boolean;
  verifiedAt?: string | null;
  updatedAt?: string | null;
}

export interface TaxClass {
  id: string;
  code: string;
  name: string;
  defaultTaxable: boolean;
  /** state code -> taxable? (overrides defaultTaxable for that state) */
  stateRules: Record<string, boolean>;
}

export interface TaxExemption {
  id: string;
  customerId: string;
  exemptionType: ExemptionType;
  certificateNumber: string | null;
  appliesToStates: string[];
  appliesToClasses: string[];
  issuedOn: string | null;
  expiresOn: string | null;
  status: ExemptionStatus;
}

export interface TaxSettings {
  collectInStates: string[];
  rateStaleAfterDays: number;
}

export type TaxableLine = Pick<QuoteLineItem, 'quantity' | 'unit_price_cents'> & { description?: string; tax_class?: string | null };

export interface CalculateTaxInput {
  lines: TaxableLine[];
  address: Partial<ServiceAddress> | null | undefined;
  rates: TaxRateComponent[];
  classes: TaxClass[];
  exemptions: TaxExemption[];
  settings?: Partial<TaxSettings>;
  /** YYYY-MM-DD the tax is determined for (defaults to today) */
  onDate?: string;
}

export interface TaxLineDetail {
  index: number;
  amountCents: number;
  classCode: string;
  treatment: LineTreatment;
  reason: string;
}

export interface TaxBreakdownLine {
  level: TaxLevel;
  name: string;
  rate_percent: number;
  taxable_cents: number;
  tax_cents: number;
}

export interface AppliedExemption {
  id: string;
  type: ExemptionType;
  certificateNumber: string | null;
  label: string;
}

export interface TaxCalculation {
  status: TaxStatus;
  subtotalCents: number;
  taxableCents: number;
  nonTaxableCents: number;
  exemptCents: number;
  taxCents: number;
  totalCents: number;
  combinedRatePercent: number;
  /** taxCents / subtotal — what goes in the legacy tax_percent column */
  effectivePercent: number;
  breakdown: TaxBreakdownLine[];
  lines: TaxLineDetail[];
  exemption: AppliedExemption | null;
  rateSource: 'account' | 'reference' | 'mixed' | null;
  warnings: string[];
}

// -------------------------------------------------------------- states

export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const STATE_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code])
);

export const EXEMPTION_TYPE_LABELS: Record<ExemptionType, string> = {
  resale: 'Resale',
  government: 'Government',
  nonprofit: 'Nonprofit',
  agricultural: 'Agricultural',
  manufacturing: 'Manufacturing',
  religious: 'Religious',
  other: 'Other',
};

/** "tx", "Texas", " TX " -> "TX"; anything unknown -> "" */
export function normalizeState(input: string | null | undefined): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (US_STATES[upper]) return upper;
  return STATE_BY_NAME[raw.toLowerCase()] ?? '';
}

/** "78701-1234" -> "78701"; invalid -> "" */
export function normalizeZip(input: string | null | undefined): string {
  const digits = (input ?? '').replace(/\D/g, '');
  return digits.length >= 5 ? digits.slice(0, 5) : '';
}

export function isAddressComplete(address: Partial<ServiceAddress> | null | undefined): boolean {
  return Boolean(address && normalizeState(address.state) && normalizeZip(address.postal_code));
}

export function normalizeAddress(address: Partial<ServiceAddress>): ServiceAddress {
  return {
    line1: address.line1?.trim() || undefined,
    city: (address.city ?? '').trim(),
    state: normalizeState(address.state) || (address.state ?? '').trim().toUpperCase(),
    postal_code: normalizeZip(address.postal_code) || (address.postal_code ?? '').trim(),
    county: address.county?.trim() || undefined,
  };
}

/**
 * Best-effort parse of a free-text US address ("12 Main St, Austin, TX 78701").
 * Returns null when no state + ZIP can be found — never guesses.
 */
export function parseUsAddress(raw: string | null | undefined): Partial<ServiceAddress> | null {
  if (!raw) return null;
  const parts = raw.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1];

  const stateZip = last.match(/^([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/);
  if (stateZip) {
    const state = normalizeState(stateZip[1]);
    if (!state) return null;
    const city = parts.length >= 2 ? parts[parts.length - 2] : '';
    const line1 = parts.slice(0, Math.max(parts.length - 2, 0)).join(', ');
    return { line1: line1 || undefined, city, state, postal_code: stateZip[2] };
  }

  const cityStateZip = last.match(/^(.+?)\s+([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/);
  if (cityStateZip) {
    const state = normalizeState(cityStateZip[2]);
    if (!state) return null;
    const line1 = parts.slice(0, -1).join(', ');
    return { line1: line1 || undefined, city: cityStateZip[1], state, postal_code: cityStateZip[3] };
  }
  return null;
}

// ------------------------------------------------------------ rounding

/** Half-up rounding of base * rate%, in exact integer arithmetic (rate has <= 4 decimals). */
export function taxOnBase(baseCents: number, ratePercent: number): number {
  if (baseCents <= 0 || ratePercent <= 0) return 0;
  const scaled = Math.round(ratePercent * 10000); // 8.25% -> 82500
  return Math.floor((Math.round(baseCents) * scaled + 500000) / 1000000);
}

export function formatRate(ratePercent: number): string {
  return `${Number(ratePercent.toFixed(4))}%`;
}

// --------------------------------------------------------- exemptions

export interface ExemptionCheck {
  applies: boolean;
  reason: string;
}

export function evaluateExemption(
  exemption: TaxExemption,
  ctx: { state: string; classCode: string; onDate: string }
): ExemptionCheck {
  const label = exemption.certificateNumber ? `Certificate ${exemption.certificateNumber}` : 'Certificate';
  if (exemption.status !== 'verified') {
    return { applies: false, reason: `${label} is ${exemption.status === 'pending' ? 'awaiting verification' : exemption.status} — tax charged.` };
  }
  if (exemption.issuedOn && exemption.issuedOn > ctx.onDate) {
    return { applies: false, reason: `${label} is not valid until ${exemption.issuedOn} — tax charged.` };
  }
  if (exemption.expiresOn && exemption.expiresOn < ctx.onDate) {
    return { applies: false, reason: `${label} expired on ${exemption.expiresOn} — tax charged.` };
  }
  if (exemption.appliesToStates.length > 0 && !exemption.appliesToStates.includes(ctx.state)) {
    return { applies: false, reason: `${label} does not cover ${ctx.state} — tax charged.` };
  }
  if (exemption.appliesToClasses.length > 0 && !exemption.appliesToClasses.includes(ctx.classCode)) {
    return { applies: false, reason: `${label} does not cover this item type.` };
  }
  return { applies: true, reason: `${label} on file.` };
}

// --------------------------------------------------------- calculation

function emptyCalculation(status: TaxStatus, subtotalCents: number, warnings: string[], lines: TaxLineDetail[] = []): TaxCalculation {
  return {
    status,
    subtotalCents,
    taxableCents: 0,
    nonTaxableCents: subtotalCents,
    exemptCents: 0,
    taxCents: 0,
    totalCents: subtotalCents,
    combinedRatePercent: 0,
    effectivePercent: 0,
    breakdown: [],
    lines,
    exemption: null,
    rateSource: null,
    warnings,
  };
}

export function exemptionLabel(e: Pick<TaxExemption, 'exemptionType' | 'certificateNumber'>): string {
  const type = EXEMPTION_TYPE_LABELS[e.exemptionType];
  return e.certificateNumber ? `${type} #${e.certificateNumber}` : `${type} certificate`;
}

export function calculateSalesTax(input: CalculateTaxInput): TaxCalculation {
  const onDate = input.onDate ?? new Date().toISOString().slice(0, 10);
  const state = normalizeState(input.address?.state);
  const zip = normalizeZip(input.address?.postal_code);
  const warnings: string[] = [];

  const rawSubtotal = input.lines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * (Number(l.unit_price_cents) || 0), 0);
  const subtotalCents = Math.round(rawSubtotal);

  if (!state || !zip) {
    return emptyCalculation('no_address', subtotalCents, ['Enter the service address (state and ZIP) to calculate sales tax.']);
  }

  const collectIn = (input.settings?.collectInStates ?? []).map((s) => s.toUpperCase());
  if (collectIn.length > 0 && !collectIn.includes(state)) {
    return emptyCalculation('not_collecting', subtotalCents, [
      `You are not set up to collect sales tax in ${state}. Add it under Tax Center → Rates if you are registered there.`,
    ]);
  }

  const classByCode = new Map(input.classes.map((c) => [c.code, c]));
  const unknownClasses = new Set<string>();
  const exemptionNotes = new Set<string>();
  const exemptCoverage = new Map<string, number>();

  let rawTaxable = 0;
  let rawExempt = 0;
  const lineDetails: TaxLineDetail[] = input.lines.map((line, index) => {
    const amount = (Number(line.quantity) || 0) * (Number(line.unit_price_cents) || 0);
    const classCode = line.tax_class || 'general';
    const taxClass = classByCode.get(classCode);
    if (!taxClass && classCode !== 'general') unknownClasses.add(classCode);

    const classTaxable = taxClass ? (taxClass.stateRules[state] ?? taxClass.defaultTaxable) : true;
    if (!classTaxable) {
      return { index, amountCents: Math.round(amount), classCode, treatment: 'class_non_taxable', reason: `${taxClass?.name ?? classCode} is not taxable in ${state}.` };
    }

    for (const exemption of input.exemptions) {
      const check = evaluateExemption(exemption, { state, classCode, onDate });
      if (check.applies) {
        rawExempt += amount;
        exemptCoverage.set(exemption.id, (exemptCoverage.get(exemption.id) ?? 0) + amount);
        return { index, amountCents: Math.round(amount), classCode, treatment: 'exempt', reason: check.reason };
      }
      exemptionNotes.add(check.reason);
    }

    rawTaxable += amount;
    return { index, amountCents: Math.round(amount), classCode, treatment: 'taxable', reason: 'Taxable.' };
  });

  if (unknownClasses.size > 0) {
    warnings.push(`Unknown tax class "${[...unknownClasses].join('", "')}" — treated as taxable.`);
  }
  // Only surface "why wasn't my certificate used" when something was actually taxed.
  if (rawTaxable > 0) exemptionNotes.forEach((n) => warnings.push(n));

  if (rawTaxable < 0) {
    warnings.push('Discounts exceed taxable items — no tax is charged on the negative balance.');
  }
  const taxableCents = Math.max(Math.round(rawTaxable), 0);
  const exemptCents = Math.max(Math.round(rawExempt), 0);
  const nonTaxableCents = Math.max(subtotalCents - taxableCents - exemptCents, 0);

  if (input.rates.length === 0) {
    return { ...emptyCalculation('no_rates', subtotalCents, [...warnings, `No tax rate found for ${state} ${zip}. Add the rate in Tax Center → Rates.`], lineDetails), taxableCents, exemptCents, nonTaxableCents };
  }

  const breakdown: TaxBreakdownLine[] = input.rates
    .filter((r) => r.ratePercent > 0)
    .map((r) => ({
      level: r.level,
      name: r.name,
      rate_percent: r.ratePercent,
      taxable_cents: taxableCents,
      tax_cents: taxOnBase(taxableCents, r.ratePercent),
    }));
  const taxCents = breakdown.reduce((sum, b) => sum + b.tax_cents, 0);
  const combinedRatePercent = input.rates.reduce((sum, r) => sum + r.ratePercent, 0);

  const sources = new Set(input.rates.map((r) => (r.isAccountRate ? 'account' : 'reference')));
  const rateSource = sources.size === 2 ? 'mixed' : sources.has('account') ? 'account' : 'reference';

  const onlyStateLevel = input.rates.every((r) => r.level === 'state');
  if (onlyStateLevel && rateSource === 'reference' && combinedRatePercent > 0) {
    warnings.push(`Only the ${state} state rate was found. County/city/district rates are missing, so tax may be understated — add local rates in Tax Center → Rates.`);
  }
  const staleDays = input.settings?.rateStaleAfterDays ?? 180;
  const cutoff = new Date(`${onDate}T00:00:00Z`).getTime() - staleDays * 86_400_000;
  const stale = input.rates.some((r) => {
    const stamp = r.verifiedAt ?? (r.isAccountRate ? r.updatedAt : null);
    return stamp ? new Date(stamp).getTime() < cutoff : false;
  });
  if (stale) warnings.push(`Some rates were last verified more than ${staleDays} days ago — re-check them.`);

  let exemption: AppliedExemption | null = null;
  if (exemptCoverage.size > 0) {
    const [topId] = [...exemptCoverage.entries()].sort((a, b) => b[1] - a[1])[0];
    const top = input.exemptions.find((e) => e.id === topId);
    if (top) exemption = { id: top.id, type: top.exemptionType, certificateNumber: top.certificateNumber, label: exemptionLabel(top) };
    if (exemptCoverage.size > 1) warnings.push('More than one exemption certificate applied to this document.');
  }

  const effectivePercent = rawSubtotal > 0
    ? (taxCents * 100) / rawSubtotal
    : exemption ? 0 : combinedRatePercent;

  return {
    status: 'calculated',
    subtotalCents,
    taxableCents,
    nonTaxableCents,
    exemptCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
    combinedRatePercent,
    effectivePercent,
    breakdown,
    lines: lineDetails,
    exemption,
    rateSource,
    warnings,
  };
}

// -------------------------------------------------- document plumbing

export type TaxMode = 'auto' | 'manual';

export interface TaxSelection {
  mode: TaxMode;
  manualPercent: number;
  address: Partial<ServiceAddress>;
  customerId: string | null;
  calculation: TaxCalculation | null;
  /** true while rates / certificates are still loading — block saving */
  pending: boolean;
  /** tax_cents already stored on the document, to flag a changed recalculation */
  savedTaxCents: number | null;
}

export function emptyTaxSelection(): TaxSelection {
  return { mode: 'auto', manualPercent: 0, address: {}, customerId: null, calculation: null, pending: false, savedTaxCents: null };
}

export interface TaxDocumentColumns {
  customer_id: string | null;
  service_address: ServiceAddress | null;
  tax_percent: number;
  tax_breakdown: TaxBreakdownLine[];
  tax_cents: number | null;
  taxable_cents: number | null;
  nontaxable_cents: number | null;
  exempt_cents: number | null;
  tax_exempt: boolean;
  tax_exemption_id: string | null;
  tax_exemption_ref: string | null;
  tax_rate_source: string | null;
  tax_calculated_at: string | null;
}

/** The exact columns to write on a quote / invoice (always writes every key so a mode switch clears stale data). */
export function taxColumnsFromSelection(selection: TaxSelection, now: Date = new Date()): TaxDocumentColumns {
  const address = selection.address && (selection.address.state || selection.address.postal_code || selection.address.city || selection.address.line1)
    ? normalizeAddress(selection.address)
    : null;
  const base = { customer_id: selection.customerId, service_address: address };

  if (selection.mode === 'manual') {
    return {
      ...base,
      tax_percent: Math.max(Number(selection.manualPercent) || 0, 0),
      tax_breakdown: [], tax_cents: null, taxable_cents: null, nontaxable_cents: null, exempt_cents: null,
      tax_exempt: false, tax_exemption_id: null, tax_exemption_ref: null, tax_rate_source: null, tax_calculated_at: null,
    };
  }

  const calc = selection.calculation;
  if (!calc || calc.status !== 'calculated') {
    return {
      ...base,
      tax_percent: 0,
      tax_breakdown: [], tax_cents: 0, taxable_cents: calc?.taxableCents ?? 0, nontaxable_cents: calc?.nonTaxableCents ?? 0, exempt_cents: 0,
      tax_exempt: false, tax_exemption_id: null, tax_exemption_ref: null, tax_rate_source: null, tax_calculated_at: null,
    };
  }
  return {
    ...base,
    tax_percent: calc.effectivePercent,
    tax_breakdown: calc.breakdown,
    tax_cents: calc.taxCents,
    taxable_cents: calc.taxableCents,
    nontaxable_cents: calc.nonTaxableCents,
    exempt_cents: calc.exemptCents,
    tax_exempt: calc.exemptCents > 0,
    tax_exemption_id: calc.exemption?.id ?? null,
    tax_exemption_ref: calc.exemption?.label ?? null,
    tax_rate_source: calc.rateSource,
    tax_calculated_at: now.toISOString(),
  };
}

/** Rebuild a selection from a stored quote/invoice row (the panel then recalculates with live rates). */
export function selectionFromDocument(doc: {
  tax_percent: number;
  customer_id?: string | null;
  service_address?: Partial<ServiceAddress> | null;
  tax_cents?: number | null;
  tax_calculated_at?: string | null;
}): TaxSelection {
  const auto = Boolean(doc.tax_calculated_at);
  return {
    mode: auto ? 'auto' : 'manual',
    manualPercent: Number(doc.tax_percent) || 0,
    address: doc.service_address ?? {},
    customerId: doc.customer_id ?? null,
    calculation: null,
    pending: auto,
    savedTaxCents: doc.tax_cents ?? null,
  };
}

export interface DocumentTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

/** Totals for display: uses the stored tax snapshot when there is one, otherwise the legacy flat percent. */
export function getDocumentTotals(doc: {
  line_items: Pick<QuoteLineItem, 'quantity' | 'unit_price_cents'>[];
  tax_percent: number;
  tax_cents?: number | null;
}): DocumentTotals {
  const subtotalCents = doc.line_items.reduce((sum, li) => sum + li.quantity * li.unit_price_cents, 0);
  const taxCents = doc.tax_cents ?? Math.round((subtotalCents * (doc.tax_percent || 0)) / 100);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

// ------------------------------------------------------- CSV: reports

export interface TaxSummaryRow {
  state: string;
  invoice_count: number;
  gross_cents: number;
  taxable_cents: number;
  nontaxable_cents: number;
  exempt_cents: number;
  tax_cents: number;
}

export interface TaxJurisdictionRow {
  state: string;
  jurisdiction_level: string;
  jurisdiction_name: string;
  rate_percent: number;
  taxable_cents: number;
  tax_cents: number;
  invoice_count: number;
}

export interface TaxExemptSaleRow {
  invoice_id: string;
  invoice_number: string;
  customer_name: string;
  invoiced_on: string;
  exempt_cents: number;
  certificate_ref: string | null;
  exemption_type: string | null;
  expires_on: string | null;
  state: string;
}

function csvCell(value: string | number | null | undefined): string {
  let s = value == null ? '' : String(value);
  // Neutralise spreadsheet formula injection from user-entered text.
  if (/^[=+\-@\t\r]/.test(s) && typeof value === 'string') s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

export function buildTaxReportCsv(
  summary: TaxSummaryRow[],
  jurisdictions: TaxJurisdictionRow[],
  exemptSales: TaxExemptSaleRow[]
): string {
  const rows: (string | number | null)[][] = [
    ['SUMMARY BY STATE'],
    ['State', 'Invoices', 'Gross sales', 'Taxable sales', 'Non-taxable sales', 'Exempt sales', 'Tax collected'],
    ...summary.map((r) => [r.state, r.invoice_count, dollars(r.gross_cents), dollars(r.taxable_cents), dollars(r.nontaxable_cents), dollars(r.exempt_cents), dollars(r.tax_cents)]),
    [],
    ['TAX BY JURISDICTION'],
    ['State', 'Level', 'Jurisdiction', 'Rate %', 'Taxable sales', 'Tax collected', 'Invoices'],
    ...jurisdictions.map((r) => [r.state, r.jurisdiction_level, r.jurisdiction_name, r.rate_percent, dollars(r.taxable_cents), dollars(r.tax_cents), r.invoice_count]),
    [],
    ['EXEMPT SALES (AUDIT)'],
    ['Invoice', 'Customer', 'Date', 'State', 'Exempt amount', 'Certificate', 'Type', 'Certificate expires'],
    ...exemptSales.map((r) => [r.invoice_number, r.customer_name, r.invoiced_on, r.state, dollars(r.exempt_cents), r.certificate_ref, r.exemption_type, r.expires_on]),
  ];
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// -------------------------------------------------- CSV: rate import

export interface RateImportRow {
  state: string;
  jurisdiction_level: TaxLevel;
  jurisdiction_name: string;
  rate_percent: number;
  county?: string;
  city?: string;
  postal_code?: string;
  effective_from?: string;
}

export const MAX_RATE_IMPORT_ROWS = 5000;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/**
 * Header: state,jurisdiction_level,jurisdiction_name,rate_percent[,county,city,postal_code,effective_from]
 * Rates are PERCENTS ("8.25" or "8.25%"). Invalid rows are reported, never silently fixed.
 */
export function parseTaxRatesCsv(text: string): { rows: RateImportRow[]; errors: string[] } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  const errors: string[] = [];
  if (lines.length < 2) return { rows: [], errors: ['The file needs a header row and at least one rate row.'] };

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  for (const required of ['state', 'jurisdiction_level', 'jurisdiction_name', 'rate_percent']) {
    if (!header.includes(required)) errors.push(`Missing required column "${required}".`);
  }
  if (errors.length > 0) return { rows: [], errors };
  if (lines.length - 1 > MAX_RATE_IMPORT_ROWS) return { rows: [], errors: [`Import at most ${MAX_RATE_IMPORT_ROWS} rows at a time.`] };

  const idx = (name: string) => header.indexOf(name);
  const rows: RateImportRow[] = [];
  lines.slice(1).forEach((line, i) => {
    const rowNo = i + 2;
    const c = parseCsvLine(line);
    const get = (name: string) => (idx(name) >= 0 ? c[idx(name)] ?? '' : '');
    const state = normalizeState(get('state'));
    const level = get('jurisdiction_level').toLowerCase() as TaxLevel;
    const name = get('jurisdiction_name');
    const rate = Number(get('rate_percent').replace('%', ''));
    const zipRaw = get('postal_code');
    const eff = get('effective_from');

    if (!state) return void errors.push(`Row ${rowNo}: unknown state "${get('state')}".`);
    if (!['state', 'county', 'city', 'district'].includes(level)) return void errors.push(`Row ${rowNo}: level must be state, county, city or district.`);
    if (!name) return void errors.push(`Row ${rowNo}: jurisdiction_name is required.`);
    if (!Number.isFinite(rate) || rate < 0 || rate > 25) return void errors.push(`Row ${rowNo}: rate_percent must be between 0 and 25.`);
    if (zipRaw && !/^\d{5}$/.test(zipRaw)) return void errors.push(`Row ${rowNo}: postal_code must be 5 digits.`);
    if (eff && !/^\d{4}-\d{2}-\d{2}$/.test(eff)) return void errors.push(`Row ${rowNo}: effective_from must be YYYY-MM-DD.`);

    rows.push({
      state,
      jurisdiction_level: level,
      jurisdiction_name: name,
      rate_percent: rate,
      county: get('county') || undefined,
      city: get('city') || undefined,
      postal_code: zipRaw || undefined,
      effective_from: eff || undefined,
    });
  });
  return { rows, errors };
}
