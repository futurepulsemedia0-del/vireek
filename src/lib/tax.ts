/* ------------------------------------------------------------------ */
/*  tax — VAT calculation for customer invoices (EU + a few extras)    */
/*                                                                      */
/*  Reference rates only — VAT rates change; re-check them yearly, or  */
/*  switch to Stripe Tax / Avalara once volume justifies it. This      */
/*  module is deliberately simple and framework-free so it can be      */
/*  reused from the frontend AND from a Supabase edge function later.  */
/* ------------------------------------------------------------------ */

export type CountryCode = string; // ISO 3166-1 alpha-2, e.g. 'DE', 'US'

/** Standard VAT/GST rate (%) by country. Only countries we actively support. */
export const VAT_RATES: Record<CountryCode, number> = {
  // European Union
  AT: 20, BE: 21, BG: 20, HR: 25, CY: 19, CZ: 21, DK: 25, EE: 22,
  FI: 25.5, FR: 20, DE: 19, GR: 24, HU: 27, IE: 23, IT: 22, LV: 21,
  LT: 21, LU: 17, MT: 18, NL: 21, PL: 23, PT: 23, RO: 19, SK: 20,
  SI: 22, ES: 21, SE: 25,
  // Non-EU, still VAT/GST-registered destinations we sell into
  GB: 20, NO: 25, CH: 8.1, AE: 5, TR: 20, AU: 10,
};

export const EU_COUNTRIES = new Set<CountryCode>([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
]);

export function isEuCountry(country: CountryCode | null | undefined): boolean {
  return !!country && EU_COUNTRIES.has(country.toUpperCase());
}

/** Very loose format check (e.g. "DE123456789") — NOT a VIES validity check. */
export function looksLikeValidVatNumber(vat: string | null | undefined): boolean {
  if (!vat) return false;
  return /^[A-Z]{2}[A-Z0-9]{2,13}$/.test(vat.trim().toUpperCase());
}

export interface VatInput {
  /** Country your business is legally established/registered in (profiles.business_country). */
  sellerCountry: CountryCode | null | undefined;
  /** Customer's billing country (jobs.customer_country). */
  customerCountry: CountryCode | null | undefined;
  /** Customer's VAT number, if they provided one (jobs.customer_vat_number). */
  customerVatNumber?: string | null;
  /** Pre-tax amount. */
  subtotal: number;
}

export interface VatResult {
  vatRate: number;       // percent, e.g. 19 for 19%
  vatAmount: number;
  total: number;
  reverseCharge: boolean;
  /** Human-readable reason, safe to print on the invoice. */
  note: string;
}

/**
 * Calculates VAT for a single invoice line using standard EU B2B/B2C rules:
 *  - No seller/customer country on file  -> can't determine tax, 0% + note to fill in settings.
 *  - Domestic sale (same country)        -> seller's local VAT rate.
 *  - Cross-border EU, valid VAT number   -> reverse charge, 0% (customer self-accounts).
 *  - Cross-border EU, no VAT number      -> customer's country VAT rate (EU OSS rule).
 *  - Customer outside the EU             -> 0%, export / out of scope of EU VAT.
 *  - Everything else (non-EU seller)     -> 0%, flagged for manual review.
 */
export function calculateVat(input: VatInput): VatResult {
  const { subtotal } = input;
  const seller = input.sellerCountry?.toUpperCase() || null;
  const customer = input.customerCountry?.toUpperCase() || null;

  const zero = (note: string): VatResult => ({ vatRate: 0, vatAmount: 0, total: subtotal, reverseCharge: false, note });

  if (!seller) {
    return zero('Business country not set — add it in Settings → Tax & invoicing to enable VAT.');
  }
  if (!isEuCountry(seller)) {
    return zero('Seller is outside the EU VAT area — no VAT auto-calculated, review local tax rules.');
  }
  if (!customer) {
    return zero("Customer country not set on this job — VAT can't be determined.");
  }

  if (customer === seller) {
    const rate = VAT_RATES[seller] ?? 0;
    const vatAmount = round2(subtotal * (rate / 100));
    return { vatRate: rate, vatAmount, total: round2(subtotal + vatAmount), reverseCharge: false, note: `Domestic VAT (${seller}) — ${rate}%` };
  }

  if (isEuCountry(customer)) {
    if (input.customerVatNumber && looksLikeValidVatNumber(input.customerVatNumber)) {
      return {
        ...zero('Reverse charge — VAT to be accounted for by the recipient (Art. 196 EU VAT Directive).'),
        reverseCharge: true,
      };
    }
    const rate = VAT_RATES[customer] ?? 0;
    const vatAmount = round2(subtotal * (rate / 100));
    return { vatRate: rate, vatAmount, total: round2(subtotal + vatAmount), reverseCharge: false, note: `EU cross-border B2C (OSS) — customer country ${customer}, ${rate}%` };
  }

  return zero(`Customer outside the EU (${customer}) — export, VAT out of scope.`);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
