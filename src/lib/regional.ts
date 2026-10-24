/* ------------------------------------------------------------------ */
/*  regional — multi-currency & regional operations (single source)    */
/*                                                                      */
/*  CONVENTIONS                                                         */
/*   - Stored money is "cents": integer = major amount x 100, for EVERY */
/*     currency (JPY included). This matches all existing *_cents       */
/*     columns, so no data migration is needed. Rounding to the         */
/*     currency's real decimals (JPY = 0) happens at the edges.         */
/*   - Distances/weights/temperatures are stored in imperial (miles,    */
/*     lb, °F) like today and only CONVERTED for display/input.         */
/*   - No React / i18n imports: pure + unit-testable. The active region */
/*     is a module-level store (same pattern as getActiveLocale), set   */
/*     by RegionalProvider.                                             */
/* ------------------------------------------------------------------ */

export type TaxRegime = 'sales_tax' | 'vat' | 'gst' | 'none';
export type UnitSystem = 'imperial' | 'metric';

export interface RegionalSettings {
  country: string;
  currency: string;
  reportingCurrency: string;
  /** BCP-47, e.g. 'en-GB', 'de-DE'. Business-level formatting locale. */
  locale: string;
  taxRegime: TaxRegime;
  taxLabel: string;
  taxIdLabel: string;
  taxId: string | null;
  pricesIncludeTax: boolean;
  defaultTaxRate: number;
  unitSystem: UnitSystem;
  weekStart: 0 | 1 | 6;
}

/* ---------------- Currencies ---------------- */

/** Zero-decimal currencies. 3-decimal ones (KWD, BHD…) are intentionally unsupported. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XOF', 'XAF']);

export const SUPPORTED_CURRENCIES: Record<string, string> = {
  USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound', CAD: 'Canadian Dollar',
  AUD: 'Australian Dollar', NZD: 'New Zealand Dollar', CHF: 'Swiss Franc',
  SEK: 'Swedish Krona', NOK: 'Norwegian Krone', DKK: 'Danish Krone',
  PLN: 'Polish Złoty', CZK: 'Czech Koruna', HUF: 'Hungarian Forint',
  AED: 'UAE Dirham', SAR: 'Saudi Riyal', QAR: 'Qatari Riyal', TRY: 'Turkish Lira',
  ILS: 'Israeli Shekel', EGP: 'Egyptian Pound', ZAR: 'South African Rand',
  INR: 'Indian Rupee', SGD: 'Singapore Dollar', HKD: 'Hong Kong Dollar',
  JPY: 'Japanese Yen', KRW: 'South Korean Won', MXN: 'Mexican Peso', BRL: 'Brazilian Real',
};

export const isSupportedCurrency = (code: unknown): code is string =>
  typeof code === 'string' && code in SUPPORTED_CURRENCIES;

export const currencyDecimals = (code: string): 0 | 2 => (ZERO_DECIMAL.has(code.toUpperCase()) ? 0 : 2);

/** Round stored cents to what the currency can really express (JPY → whole units). */
export function roundCents(cents: number, currency: string): number {
  if (!Number.isFinite(cents)) return 0;
  const step = currencyDecimals(currency) === 0 ? 100 : 1;
  return Math.round(cents / step) * step;
}

/** Stored cents → minor units for Stripe (JPY: 1 unit = 1 minor unit). */
export function centsToStripeMinor(cents: number, currency: string): number {
  return currencyDecimals(currency) === 0 ? Math.round(cents / 100) : Math.round(cents);
}
export function stripeMinorToCents(minor: number, currency: string): number {
  return currencyDecimals(currency) === 0 ? Math.round(minor) * 100 : Math.round(minor);
}

/* ---------------- Region presets ---------------- */

interface Preset {
  currency: string; locale: string; taxRegime: TaxRegime; taxLabel: string; taxIdLabel: string;
  pricesIncludeTax: boolean; defaultTaxRate: number; unitSystem: UnitSystem; weekStart: 0 | 1 | 6;
}
const vat = (currency: string, locale: string, rate: number, over: Partial<Preset> = {}): Preset => ({
  currency, locale, taxRegime: 'vat', taxLabel: 'VAT', taxIdLabel: 'VAT number',
  pricesIncludeTax: true, defaultTaxRate: rate, unitSystem: 'metric', weekStart: 1, ...over,
});

/** Reference defaults only — the owner confirms every value in Settings. Rates change; re-check yearly. */
export const REGION_PRESETS: Record<string, Preset> = {
  US: { currency: 'USD', locale: 'en-US', taxRegime: 'sales_tax', taxLabel: 'Sales tax', taxIdLabel: 'EIN', pricesIncludeTax: false, defaultTaxRate: 0, unitSystem: 'imperial', weekStart: 0 },
  CA: { currency: 'CAD', locale: 'en-CA', taxRegime: 'gst', taxLabel: 'GST/HST', taxIdLabel: 'GST/HST number', pricesIncludeTax: false, defaultTaxRate: 5, unitSystem: 'metric', weekStart: 0 },
  MX: vat('MXN', 'es-MX', 16, { pricesIncludeTax: false, weekStart: 0 }),
  GB: vat('GBP', 'en-GB', 20, { unitSystem: 'imperial' }),
  IE: vat('EUR', 'en-IE', 23),
  DE: vat('EUR', 'de-DE', 19), FR: vat('EUR', 'fr-FR', 20), ES: vat('EUR', 'es-ES', 21),
  IT: vat('EUR', 'it-IT', 22), NL: vat('EUR', 'nl-NL', 21), AT: vat('EUR', 'de-AT', 20),
  BE: vat('EUR', 'fr-BE', 21), PT: vat('EUR', 'pt-PT', 23),
  PL: vat('PLN', 'pl-PL', 23), SE: vat('SEK', 'sv-SE', 25), DK: vat('DKK', 'da-DK', 25),
  NO: vat('NOK', 'nb-NO', 25), CH: vat('CHF', 'de-CH', 8.1),
  AE: vat('AED', 'en-AE', 5, { pricesIncludeTax: false, taxIdLabel: 'TRN', weekStart: 6 }),
  SA: vat('SAR', 'ar-SA', 15, { taxIdLabel: 'VAT number', weekStart: 0 }),
  TR: vat('TRY', 'tr-TR', 20),
  AU: { currency: 'AUD', locale: 'en-AU', taxRegime: 'gst', taxLabel: 'GST', taxIdLabel: 'ABN', pricesIncludeTax: true, defaultTaxRate: 10, unitSystem: 'metric', weekStart: 1 },
  NZ: { currency: 'NZD', locale: 'en-NZ', taxRegime: 'gst', taxLabel: 'GST', taxIdLabel: 'NZBN', pricesIncludeTax: true, defaultTaxRate: 15, unitSystem: 'metric', weekStart: 1 },
  IN: { currency: 'INR', locale: 'en-IN', taxRegime: 'gst', taxLabel: 'GST', taxIdLabel: 'GSTIN', pricesIncludeTax: false, defaultTaxRate: 18, unitSystem: 'metric', weekStart: 0 },
  SG: { currency: 'SGD', locale: 'en-SG', taxRegime: 'gst', taxLabel: 'GST', taxIdLabel: 'GST reg. no.', pricesIncludeTax: false, defaultTaxRate: 9, unitSystem: 'metric', weekStart: 1 },
  ZA: vat('ZAR', 'en-ZA', 15, { weekStart: 1 }),
  JP: { currency: 'JPY', locale: 'ja-JP', taxRegime: 'vat', taxLabel: 'Consumption tax', taxIdLabel: 'Invoice no.', pricesIncludeTax: true, defaultTaxRate: 10, unitSystem: 'metric', weekStart: 0 },
};

export function presetForCountry(country: string | null | undefined): (Preset & { country: string }) | null {
  const c = (country ?? '').trim().toUpperCase();
  const p = REGION_PRESETS[c];
  return p ? { ...p, country: c } : null;
}

/* ---------------- Settings normalisation + active store ---------------- */

export const DEFAULT_REGIONAL: RegionalSettings = {
  country: 'US', currency: 'USD', reportingCurrency: 'USD', locale: 'en-US',
  taxRegime: 'sales_tax', taxLabel: 'Sales tax', taxIdLabel: 'Tax ID', taxId: null,
  pricesIncludeTax: false, defaultTaxRate: 0, unitSystem: 'imperial', weekStart: 0,
};

export function isValidLocale(tag: unknown): tag is string {
  if (typeof tag !== 'string' || !tag) return false;
  try { return Intl.NumberFormat.supportedLocalesOf([tag]).length > 0; } catch { return false; }
}

const clampRate = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(30, Math.max(0, Math.round(v * 1000) / 1000)) : 0;
};

/** Accepts DB rows (snake_case) OR partial camelCase; always returns a complete valid object. */
export function normalizeRegional(
  raw: Record<string, unknown> | null | undefined,
  fallback?: { currency?: string | null; country?: string | null },
): RegionalSettings {
  const r = raw ?? {};
  const pick = (camel: string, snake: string) => r[camel] ?? r[snake];
  const country = String(pick('country', 'country') ?? fallback?.country ?? DEFAULT_REGIONAL.country).toUpperCase();
  const preset = presetForCountry(country);
  const base = preset ?? DEFAULT_REGIONAL;
  const cur = String(pick('currency', 'currency') ?? fallback?.currency ?? base.currency).toUpperCase();
  const currency = isSupportedCurrency(cur) ? cur : base.currency;
  const repRaw = String(pick('reportingCurrency', 'reporting_currency') ?? currency).toUpperCase();
  const loc = pick('locale', 'locale');
  const regime = pick('taxRegime', 'tax_regime');
  const units = pick('unitSystem', 'unit_system');
  const week = Number(pick('weekStart', 'week_start'));
  return {
    country: /^[A-Z]{2}$/.test(country) ? country : DEFAULT_REGIONAL.country,
    currency,
    reportingCurrency: isSupportedCurrency(repRaw) ? repRaw : currency,
    locale: isValidLocale(loc) ? loc : base.locale,
    taxRegime: regime === 'vat' || regime === 'gst' || regime === 'sales_tax' || regime === 'none' ? regime : base.taxRegime,
    taxLabel: String(pick('taxLabel', 'tax_label') ?? base.taxLabel).slice(0, 30) || base.taxLabel,
    taxIdLabel: String(pick('taxIdLabel', 'tax_id_label') ?? base.taxIdLabel).slice(0, 30) || base.taxIdLabel,
    taxId: ((pick('taxId', 'tax_id') as string | null | undefined) ?? null)?.toString().trim().slice(0, 40) || null,
    pricesIncludeTax: Boolean(pick('pricesIncludeTax', 'prices_include_tax') ?? base.pricesIncludeTax),
    defaultTaxRate: clampRate(pick('defaultTaxRate', 'default_tax_rate') ?? base.defaultTaxRate),
    unitSystem: units === 'metric' || units === 'imperial' ? units : base.unitSystem,
    weekStart: week === 0 || week === 1 || week === 6 ? week : base.weekStart,
  };
}

let activeRegional: RegionalSettings = DEFAULT_REGIONAL;
export const getActiveRegional = (): RegionalSettings => activeRegional;
export function setActiveRegional(next: RegionalSettings): void { activeRegional = next; }

/* ---------------- Money formatting ---------------- */

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = nfCache.get(key);
  if (!f) { f = new Intl.NumberFormat(locale, options); nfCache.set(key, f); }
  return f;
}

export interface MoneyOptions {
  locale?: string;
  /** 'symbol' (default) | 'code' (unambiguous for multi-currency tables) | 'narrowSymbol' */
  display?: 'symbol' | 'code' | 'narrowSymbol';
  /** Hide ".00" on whole amounts (marketing-style). */
  trimZeros?: boolean;
}

/** `amount` is a MAJOR-unit number already in `currency`. */
export function formatMoney(amount: number | null | undefined, currency?: string | null, opts: MoneyOptions = {}): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  const reg = activeRegional;
  const code = (currency && isSupportedCurrency(currency.toUpperCase()) ? currency.toUpperCase() : reg.currency);
  const locale = isValidLocale(opts.locale) ? opts.locale : reg.locale;
  const d = currencyDecimals(code);
  const whole = Math.abs(amount - Math.round(amount)) < 1e-9;
  const min = d === 0 || (opts.trimZeros && whole) ? 0 : d;
  try {
    return nf(locale, { style: 'currency', currency: code, currencyDisplay: opts.display ?? 'symbol', minimumFractionDigits: min, maximumFractionDigits: d }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(d)}`;
  }
}

/** `cents` = stored integer (major x 100). Drop-in for the old `$${(c/100).toFixed(2)}`. */
export function formatCentsIn(cents: number | null | undefined, currency?: string | null, opts: MoneyOptions = {}): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  return formatMoney(cents / 100, currency, opts);
}

/** Parses what a person typed ("1.234,56" in de-DE, "1,234.56" in en-US) into a number, or null. */
export function parseLocalizedNumber(input: string, locale?: string): number | null {
  const s = input.trim().replace(/[\s\u00a0\u202f'’]/g, '');
  if (!s) return null;
  const parts = new Intl.NumberFormat(isValidLocale(locale) ? locale : activeRegional.locale).formatToParts(12345.6);
  const group = parts.find((p) => p.type === 'group')?.value ?? ',';
  const dec = parts.find((p) => p.type === 'decimal')?.value ?? '.';
  const cleaned = s.replace(/[^\d.,-]/g, '').split(group === '.' ? /\./ : /,/).join('').replace(dec, '.');
  if (!/^-?\d*\.?\d+$|^-?\d+\.$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/* ---------------- Tax ---------------- */

export interface TaxSplit { netCents: number; taxCents: number; grossCents: number }

/**
 * Splits/adds tax on an amount in stored cents.
 * inclusive=true  → `amountCents` is the GROSS (VAT/GST-style shelf price).
 * inclusive=false → `amountCents` is the NET (US sales-tax style).
 * Result is rounded to what the currency can express; gross = net + tax always.
 */
export function splitTax(amountCents: number, ratePercent: number, inclusive: boolean, currency: string): TaxSplit {
  const rate = Math.max(0, Number.isFinite(ratePercent) ? ratePercent : 0) / 100;
  const amt = roundCents(amountCents, currency);
  if (inclusive) {
    const net = roundCents(amt / (1 + rate), currency);
    return { netCents: net, taxCents: amt - net, grossCents: amt };
  }
  const tax = roundCents(amt * rate, currency);
  return { netCents: amt, taxCents: tax, grossCents: amt + tax };
}

/* ---------------- Exchange rates ---------------- */

export interface FxTable {
  /** Currency the rates are quoted against (1 base = rates[quote]). */
  base: string;
  /** ISO date the rates were published. */
  asOf: string;
  rates: Record<string, number>;
}

/** Rate such that 1 `from` = rate `to`. null when either currency is unknown. */
export function rateBetween(from: string, to: string, fx: FxTable | null | undefined): number | null {
  const f = from.toUpperCase(); const t = to.toUpperCase();
  if (f === t) return 1;
  if (!fx) return null;
  const rf = f === fx.base ? 1 : fx.rates[f];
  const rt = t === fx.base ? 1 : fx.rates[t];
  if (!rf || !rt || !(rf > 0) || !(rt > 0)) return null;
  return rt / rf;
}

export function convertCents(cents: number, from: string, to: string, fx: FxTable | null | undefined, lockedRate?: number | null): number | null {
  const rate = lockedRate && lockedRate > 0 ? lockedRate : rateBetween(from, to, fx);
  return rate === null ? null : roundCents(cents * rate, to);
}

export function isFxStale(asOf: string | null | undefined, now: Date = new Date(), maxAgeDays = 4): boolean {
  if (!asOf) return true;
  const t = Date.parse(`${asOf}T00:00:00Z`);
  return !Number.isFinite(t) || (now.getTime() - t) / 86_400_000 > maxAgeDays;
}

export interface ReportingTotal { totalCents: number; missing: string[]; converted: boolean }

/**
 * Sums mixed-currency amounts into the reporting currency. Rows with a locked
 * rate (stored on the document at issue time) use it, so historic reports never
 * drift when today's rates move. Currencies with no rate are listed in `missing`
 * and EXCLUDED — never silently treated as 1:1.
 */
export function sumInReportingCurrency(
  rows: { cents: number; currency: string; lockedRate?: number | null }[],
  reporting: string,
  fx: FxTable | null | undefined,
): ReportingTotal {
  let total = 0; let converted = false; const missing = new Set<string>();
  for (const r of rows) {
    const cur = (r.currency || reporting).toUpperCase();
    const v = convertCents(r.cents, cur, reporting, fx, r.lockedRate ?? null);
    if (v === null) { missing.add(cur); continue; }
    if (cur !== reporting.toUpperCase()) converted = true;
    total += v;
  }
  return { totalCents: total, missing: [...missing].sort(), converted };
}

/* ---------------- Units (canonical storage = imperial) ---------------- */

const MI_TO_KM = 1.609344; const LB_TO_KG = 0.45359237; const SQFT_TO_M2 = 0.09290304;
export const milesToKm = (mi: number) => mi * MI_TO_KM;
export const kmToMiles = (km: number) => km / MI_TO_KM;
export const lbToKg = (lb: number) => lb * LB_TO_KG;
export const kgToLb = (kg: number) => kg / LB_TO_KG;
export const fToC = (f: number) => ((f - 32) * 5) / 9;
export const cToF = (c: number) => (c * 9) / 5 + 32;
export const sqftToM2 = (v: number) => v * SQFT_TO_M2;
export const m2ToSqft = (v: number) => v / SQFT_TO_M2;

function unitFmt(value: number, unit: string, digits: number, locale?: string): string {
  const loc = isValidLocale(locale) ? locale : activeRegional.locale;
  try {
    return nf(loc, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: digits }).format(value);
  } catch { return `${Number(value.toFixed(digits))} ${unit}`; }
}

type Sys = UnitSystem | undefined;
export function formatDistance(miles: number | null | undefined, system?: Sys, locale?: string): string {
  if (miles === null || miles === undefined || !Number.isFinite(miles)) return '—';
  return (system ?? activeRegional.unitSystem) === 'metric' ? unitFmt(milesToKm(miles), 'kilometer', 1, locale) : unitFmt(miles, 'mile', 1, locale);
}
export function formatWeight(lb: number | null | undefined, system?: Sys, locale?: string): string {
  if (lb === null || lb === undefined || !Number.isFinite(lb)) return '—';
  return (system ?? activeRegional.unitSystem) === 'metric' ? unitFmt(lbToKg(lb), 'kilogram', 2, locale) : unitFmt(lb, 'pound', 2, locale);
}
export function formatTemperature(f: number | null | undefined, system?: Sys, locale?: string): string {
  if (f === null || f === undefined || !Number.isFinite(f)) return '—';
  return (system ?? activeRegional.unitSystem) === 'metric' ? unitFmt(fToC(f), 'celsius', 0, locale) : unitFmt(f, 'fahrenheit', 0, locale);
}
export function formatArea(sqft: number | null | undefined, system?: Sys, locale?: string): string {
  if (sqft === null || sqft === undefined || !Number.isFinite(sqft)) return '—';
  const loc = isValidLocale(locale) ? locale : activeRegional.locale;
  return (system ?? activeRegional.unitSystem) === 'metric'
    ? `${nf(loc, { maximumFractionDigits: 1 }).format(sqftToM2(sqft))} m²`
    : `${nf(loc, { maximumFractionDigits: 0 }).format(sqft)} sq ft`;
}
export const distanceUnitLabel = (system?: Sys) => ((system ?? activeRegional.unitSystem) === 'metric' ? 'km' : 'mi');
