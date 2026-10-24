// Server-side regional helpers (voice agent, emails, reports).
// Mirrors src/lib/regional.ts on purpose: edge functions can't import from src/.
// Stored money = "cents" (major x 100) for every currency, same as the frontend.

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XOF", "XAF"]);
const COUNTRY_PRESET: Record<string, { currency: string; locale: string; unitSystem: "metric" | "imperial"; taxLabel: string; includesTax: boolean; rate: number }> = {
  US: { currency: "USD", locale: "en-US", unitSystem: "imperial", taxLabel: "sales tax", includesTax: false, rate: 0 },
  CA: { currency: "CAD", locale: "en-CA", unitSystem: "metric", taxLabel: "GST/HST", includesTax: false, rate: 5 },
  GB: { currency: "GBP", locale: "en-GB", unitSystem: "imperial", taxLabel: "VAT", includesTax: true, rate: 20 },
  DE: { currency: "EUR", locale: "de-DE", unitSystem: "metric", taxLabel: "VAT", includesTax: true, rate: 19 },
  FR: { currency: "EUR", locale: "fr-FR", unitSystem: "metric", taxLabel: "VAT", includesTax: true, rate: 20 },
  ES: { currency: "EUR", locale: "es-ES", unitSystem: "metric", taxLabel: "VAT", includesTax: true, rate: 21 },
  AU: { currency: "AUD", locale: "en-AU", unitSystem: "metric", taxLabel: "GST", includesTax: true, rate: 10 },
  AE: { currency: "AED", locale: "en-AE", unitSystem: "metric", taxLabel: "VAT", includesTax: false, rate: 5 },
  TR: { currency: "TRY", locale: "tr-TR", unitSystem: "metric", taxLabel: "VAT", includesTax: true, rate: 20 },
};

export interface Regional {
  country: string;
  currency: string;
  reportingCurrency: string;
  locale: string;
  taxLabel: string;
  pricesIncludeTax: boolean;
  defaultTaxRate: number;
  unitSystem: "metric" | "imperial";
  isDefault: boolean;
}

export const DEFAULT_REGIONAL: Regional = {
  country: "US", currency: "USD", reportingCurrency: "USD", locale: "en-US",
  taxLabel: "sales tax", pricesIncludeTax: false, defaultTaxRate: 0, unitSystem: "imperial", isDefault: true,
};

const validLocale = (t: unknown): t is string => {
  try { return typeof t === "string" && Intl.NumberFormat.supportedLocalesOf([t]).length > 0; } catch { return false; }
};

export function normalizeRegional(row: Record<string, unknown> | null | undefined, fallback?: { currency?: string | null; country?: string | null }): Regional {
  const r = row ?? {};
  const countryRaw = String(r.country ?? fallback?.country ?? "US").toUpperCase();
  const country = /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : "US";
  const p = COUNTRY_PRESET[country] ?? COUNTRY_PRESET.US;
  const curRaw = String(r.currency ?? fallback?.currency ?? p.currency).toUpperCase();
  const currency = /^[A-Z]{3}$/.test(curRaw) ? curRaw : p.currency;
  const repRaw = String(r.reporting_currency ?? currency).toUpperCase();
  const out: Regional = {
    country, currency,
    reportingCurrency: /^[A-Z]{3}$/.test(repRaw) ? repRaw : currency,
    locale: validLocale(r.locale) ? r.locale : p.locale,
    taxLabel: String(r.tax_label ?? p.taxLabel).slice(0, 30) || p.taxLabel,
    pricesIncludeTax: typeof r.prices_include_tax === "boolean" ? r.prices_include_tax : p.includesTax,
    defaultTaxRate: Number.isFinite(Number(r.default_tax_rate ?? p.rate)) ? Number(r.default_tax_rate ?? p.rate) : 0,
    unitSystem: r.unit_system === "metric" || r.unit_system === "imperial" ? r.unit_system : p.unitSystem,
    isDefault: false,
  };
  out.isDefault = out.currency === "USD" && out.unitSystem === "imperial" && !out.pricesIncludeTax && validLocale(out.locale) && out.locale.startsWith("en");
  return out;
}

// Minimal structural type so this file never depends on a supabase-js version.
// deno-lint-ignore no-explicit-any
type Admin = { from: (t: string) => any };

/** Never throws: any failure returns the US defaults (today's behaviour). */
export async function loadRegional(admin: Admin, userId: string): Promise<Regional> {
  try {
    const { data } = await admin.from("business_regional_settings").select("*").eq("user_id", userId).maybeSingle();
    if (data) return normalizeRegional(data);
    const { data: prof } = await admin.from("profiles").select("invoice_currency, business_country").eq("id", userId).maybeSingle();
    return prof ? normalizeRegional(null, { currency: prof.invoice_currency, country: prof.business_country }) : DEFAULT_REGIONAL;
  } catch {
    return DEFAULT_REGIONAL;
  }
}

const decimals = (c: string) => (ZERO_DECIMAL.has(c.toUpperCase()) ? 0 : 2);

/** `cents` = stored integer (major x 100). */
export function formatCents(cents: number, currency = "USD", locale = "en-US"): string {
  if (!Number.isFinite(cents)) return "";
  const code = /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : "USD";
  const loc = validLocale(locale) ? locale : "en-US";
  const d = decimals(code);
  try {
    return new Intl.NumberFormat(loc, { style: "currency", currency: code, minimumFractionDigits: d, maximumFractionDigits: d }).format(cents / 100);
  } catch {
    return `${code} ${(cents / 100).toFixed(d)}`;
  }
}

/** Text-to-speech friendly: "49.50 euros" instead of "€49.50". */
export function spokenMoney(cents: number, currency = "USD", locale = "en-US"): string {
  if (!Number.isFinite(cents)) return "";
  const code = /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : "USD";
  const d = decimals(code);
  const major = cents / 100;
  const whole = Math.abs(major - Math.round(major)) < 1e-9;
  const fd = d === 0 || whole ? 0 : 2;
  try {
    return new Intl.NumberFormat(validLocale(locale) ? locale : "en-US", { style: "currency", currency: code, currencyDisplay: "name", minimumFractionDigits: fd, maximumFractionDigits: d }).format(major);
  } catch {
    return `${major.toFixed(fd)} ${code}`;
  }
}

export const milesToKm = (mi: number) => mi * 1.609344;
export const lbToKg = (lb: number) => lb * 0.45359237;

/**
 * Extra instructions for the voice agent. Returns "" for default US businesses so
 * their prompt is byte-for-byte unchanged (zero regression).
 */
export function buildRegionalVoiceContext(r: Regional): string {
  if (r.isDefault) return "";
  const example = spokenMoney(4950, r.currency, r.locale);
  const parts = [
    `REGIONAL SETTINGS: this business operates in ${r.country} and works in ${r.currency}.`,
    `Always state prices in ${r.currency} exactly as configured (for example "${example}") and never say or assume dollars unless the currency is USD. Never convert currencies yourself.`,
  ];
  if (r.defaultTaxRate > 0 || r.taxLabel.toLowerCase() !== "sales tax") {
    parts.push(
      r.pricesIncludeTax
        ? `Quoted prices already include ${r.taxLabel}${r.defaultTaxRate > 0 ? ` (${r.defaultTaxRate}%)` : ""}; say so if asked.`
        : `Quoted prices do not include ${r.taxLabel}; mention that ${r.taxLabel} is added when asked about the total.`,
    );
  }
  parts.push(r.unitSystem === "metric"
    ? "Use metric units when speaking: kilometers, kilograms, degrees Celsius."
    : "Use imperial units when speaking: miles, pounds, degrees Fahrenheit.");
  return parts.join(" ");
}
