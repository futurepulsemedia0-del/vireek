/* ------------------------------------------------------------------ */
/*  Regional packs — shared types (pure, no imports, no side effects)  */
/* ------------------------------------------------------------------ */

export type PackCode = 'US' | 'CA' | 'GB' | 'EU' | 'AU';
export const PACK_CODES: readonly PackCode[] = ['US', 'CA', 'GB', 'EU', 'AU'] as const;

export type RateCategory = 'standard' | 'reduced' | 'zero' | 'exempt';

/** Tax schemes a seller can be registered under (one registration number each). */
export type TaxScheme = 'VAT' | 'GST_HST' | 'QST' | 'PST_BC' | 'PST_SK' | 'RST_MB' | 'AU_GST' | 'US_SALES_TAX';

export type TaxComponentCode = 'VAT' | 'GST' | 'HST' | 'PST' | 'RST' | 'QST' | 'SALES_TAX';

export interface TaxComponentRate {
  code: TaxComponentCode;
  label: string;
  /** Percent, up to 3 decimals (e.g. 9.975). */
  ratePct: number;
  /** Which registration the seller needs to charge this component. */
  scheme: TaxScheme;
}

export type PaymentMethodType =
  | 'card' | 'us_bank_account' | 'acss_debit' | 'bacs_debit' | 'sepa_debit' | 'au_becs_debit'
  | 'ideal' | 'bancontact' | 'eps' | 'blik' | 'p24';

export interface PaymentMethodSpec {
  type: PaymentMethodType;
  label: string;
  /** Lower-case ISO currencies the method can settle in (Stripe constraint). */
  currencies: readonly string[];
  /** Direct-debit style: funds confirm days later, a mandate is required. */
  delayed: boolean;
  scheme?: 'ACH' | 'PAD' | 'BACS' | 'SEPA' | 'BECS';
}

export interface PhoneRule {
  callingCode: string;
  /** National significant number length (digits, trunk prefix excluded). */
  minLen: number;
  maxLen: number;
  trunk: string;
}

export interface PostalRule {
  regex: RegExp;
  example: string;
  label: string;
}

export interface CountryProfile {
  code: string; // ISO 3166-1 alpha-2
  name: string;
  pack: PackCode;
  currency: string; // ISO 4217
  locale: string;
  phone: PhoneRule;
  postal: PostalRule;
  /** Subdivision code -> name, when the pack validates one (states, provinces). */
  subdivisions?: Readonly<Record<string, string>>;
  subdivisionRequired?: boolean;
  /** VAT/GST details; absent for US (sales tax is jurisdiction-based). */
  vat?: { standard: number; reduced: readonly number[]; idPrefix: string };
  paymentMethods: readonly PaymentMethodType[];
}

export interface RegionalPack {
  code: PackCode;
  name: string;
  flag: string;
  summary: string;
  countries: readonly string[];
  taxLabel: string;
  /** ISO date the bundled tax/holiday/retention data was last checked by Vireek. */
  dataVerifiedAt: string;
}

export interface Warning {
  code: string;
  message: string;
}

export type TaxStatus = 'ok' | 'no_registration' | 'needs_rate' | 'needs_review' | 'out_of_scope';

export interface TaxRegistration {
  scheme: TaxScheme;
  number: string;
  country: string;
  subdivision?: string | null;
  /** ISO date (inclusive). */
  validFrom?: string | null;
  validTo?: string | null;
  status?: 'active' | 'pending' | 'deregistered';
}

export interface TaxLineInput {
  id: string;
  /** Pre-tax amount in minor units (cents/pence). Negative for credit notes. */
  netMinor: number;
  category?: RateCategory;
  /** Index into the country's reduced rates (default 0). */
  reducedIndex?: number;
}

export interface TaxContext {
  currency: string;
  sellerCountry: string;
  sellerSubdivision?: string | null;
  /** Where the work is performed. Services on real property are taxed where the property is. */
  siteCountry: string;
  siteSubdivision?: string | null;
  customerIsBusiness?: boolean;
  customerTaxId?: string | null;
  registrations: readonly TaxRegistration[];
  /** ISO date of supply (tax point). Defaults to today (UTC). */
  supplyDate?: string;
  /** Set by the user when a domestic reverse charge applies (e.g. UK CIS construction, DE §13b). Needs customerTaxId. */
  domesticReverseCharge?: boolean;
  /** Preview/quote mode: behave as if registered for every scheme. */
  assumeRegistered?: boolean;
  /** US only: components resolved by the existing sales-tax engine (salesTaxApi.lookupTaxRates). */
  externalComponents?: readonly TaxComponentRate[];
  rounding?: 'per_rate_total' | 'per_line';
}

export interface TaxLineResult {
  id: string;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  category: RateCategory;
  components: { code: TaxComponentCode; ratePct: number; taxMinor: number }[];
}

export interface TaxBreakdownRow {
  code: TaxComponentCode;
  label: string;
  ratePct: number;
  netMinor: number;
  taxMinor: number;
}

export interface TaxResult {
  status: TaxStatus;
  currency: string;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  lines: TaxLineResult[];
  breakdown: TaxBreakdownRow[];
  reverseCharge: boolean;
  placeOfSupply: { country: string; subdivision: string | null };
  notes: string[];
  warnings: Warning[];
}
