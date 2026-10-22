/* ------------------------------------------------------------------ */
/*  Regional packs — reference data for US, CA, GB, EU-27 and AU.      */
/*  Rates/rules verified 2026-10-20. Tax law changes: re-check yearly  */
/*  (see DATA_VERIFIED_AT) — and treat reduced rates as "available",   */
/*  not as "applicable": which supplies qualify is a legal question.   */
/* ------------------------------------------------------------------ */
import type {
  CountryProfile, PackCode, PaymentMethodSpec, PaymentMethodType, PhoneRule, RegionalPack,
} from './packTypes';

export const DATA_VERIFIED_AT = '2026-10-20';

export const US_STATES: Readonly<Record<string, string>> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

export const CA_PROVINCES: Readonly<Record<string, string>> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island',
  QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
};

export const AU_STATES: Readonly<Record<string, string>> = {
  ACT: 'Australian Capital Territory', NSW: 'New South Wales', NT: 'Northern Territory', QLD: 'Queensland',
  SA: 'South Australia', TAS: 'Tasmania', VIC: 'Victoria', WA: 'Western Australia',
};

export const GB_NATIONS: Readonly<Record<string, string>> = {
  ENG: 'England', SCT: 'Scotland', WLS: 'Wales', NIR: 'Northern Ireland',
};

/* ------------------------------ payments ----------------------------- */

export const PAYMENT_METHODS: Readonly<Record<PaymentMethodType, PaymentMethodSpec>> = {
  card: { type: 'card', label: 'Card (incl. Apple Pay / Google Pay)', currencies: ['*'], delayed: false },
  us_bank_account: { type: 'us_bank_account', label: 'ACH Direct Debit', currencies: ['usd'], delayed: true, scheme: 'ACH' },
  acss_debit: { type: 'acss_debit', label: 'Pre-authorized Debit (PAD)', currencies: ['cad', 'usd'], delayed: true, scheme: 'PAD' },
  bacs_debit: { type: 'bacs_debit', label: 'Bacs Direct Debit', currencies: ['gbp'], delayed: true, scheme: 'BACS' },
  sepa_debit: { type: 'sepa_debit', label: 'SEPA Direct Debit', currencies: ['eur'], delayed: true, scheme: 'SEPA' },
  au_becs_debit: { type: 'au_becs_debit', label: 'BECS Direct Debit', currencies: ['aud'], delayed: true, scheme: 'BECS' },
  ideal: { type: 'ideal', label: 'iDEAL', currencies: ['eur'], delayed: false },
  bancontact: { type: 'bancontact', label: 'Bancontact', currencies: ['eur'], delayed: false },
  eps: { type: 'eps', label: 'EPS', currencies: ['eur'], delayed: false },
  blik: { type: 'blik', label: 'BLIK', currencies: ['pln'], delayed: false },
  p24: { type: 'p24', label: 'Przelewy24', currencies: ['eur', 'pln'], delayed: false },
};

/* ------------------------------ countries ---------------------------- */

const ph = (callingCode: string, minLen: number, maxLen: number, trunk: string): PhoneRule => ({ callingCode, minLen, maxLen, trunk });

const COUNTRIES: Record<string, CountryProfile> = {};
const add = (c: CountryProfile) => { COUNTRIES[c.code] = c; };

add({
  code: 'US', name: 'United States', pack: 'US', currency: 'USD', locale: 'en-US',
  phone: ph('1', 10, 10, '1'),
  postal: { regex: /^\d{5}(-\d{4})?$/, example: '78701', label: 'ZIP code' },
  subdivisions: US_STATES, subdivisionRequired: true,
  paymentMethods: ['card', 'us_bank_account'],
});
add({
  code: 'CA', name: 'Canada', pack: 'CA', currency: 'CAD', locale: 'en-CA',
  phone: ph('1', 10, 10, '1'),
  postal: { regex: /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d$/, example: 'M5V 2T6', label: 'Postal code' },
  subdivisions: CA_PROVINCES, subdivisionRequired: true,
  vat: { standard: 5, reduced: [], idPrefix: 'CA' },
  paymentMethods: ['card', 'acss_debit'],
});
add({
  code: 'GB', name: 'United Kingdom', pack: 'GB', currency: 'GBP', locale: 'en-GB',
  phone: ph('44', 9, 10, '0'),
  postal: { regex: /^(GIR ?0AA|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})$/, example: 'SW1A 1AA', label: 'Postcode' },
  subdivisions: GB_NATIONS, subdivisionRequired: false,
  vat: { standard: 20, reduced: [5], idPrefix: 'GB' },
  paymentMethods: ['card', 'bacs_debit'],
});
add({
  code: 'AU', name: 'Australia', pack: 'AU', currency: 'AUD', locale: 'en-AU',
  phone: ph('61', 9, 9, '0'),
  postal: { regex: /^\d{4}$/, example: '2000', label: 'Postcode' },
  subdivisions: AU_STATES, subdivisionRequired: true,
  vat: { standard: 10, reduced: [], idPrefix: 'AU' },
  paymentMethods: ['card', 'au_becs_debit'],
});

interface EuRow {
  c: string; n: string; cur: string; loc: string; std: number; red: number[]; idp: string;
  cc: string; min: number; max: number; trunk: string; zip: RegExp; ex: string; extra?: PaymentMethodType[];
}
const EU: EuRow[] = [
  { c: 'AT', n: 'Austria', cur: 'EUR', loc: 'de-AT', std: 20, red: [10, 13], idp: 'AT', cc: '43', min: 4, max: 13, trunk: '0', zip: /^\d{4}$/, ex: '1010', extra: ['eps'] },
  { c: 'BE', n: 'Belgium', cur: 'EUR', loc: 'nl-BE', std: 21, red: [6, 12], idp: 'BE', cc: '32', min: 8, max: 9, trunk: '0', zip: /^\d{4}$/, ex: '1000', extra: ['bancontact'] },
  { c: 'BG', n: 'Bulgaria', cur: 'EUR', loc: 'bg-BG', std: 20, red: [9], idp: 'BG', cc: '359', min: 7, max: 9, trunk: '0', zip: /^\d{4}$/, ex: '1000' },
  { c: 'HR', n: 'Croatia', cur: 'EUR', loc: 'hr-HR', std: 25, red: [5, 13], idp: 'HR', cc: '385', min: 8, max: 9, trunk: '0', zip: /^\d{5}$/, ex: '10000' },
  { c: 'CY', n: 'Cyprus', cur: 'EUR', loc: 'el-CY', std: 19, red: [5, 9], idp: 'CY', cc: '357', min: 8, max: 8, trunk: '', zip: /^\d{4}$/, ex: '1010' },
  { c: 'CZ', n: 'Czechia', cur: 'CZK', loc: 'cs-CZ', std: 21, red: [12], idp: 'CZ', cc: '420', min: 9, max: 9, trunk: '', zip: /^\d{3} ?\d{2}$/, ex: '110 00' },
  { c: 'DK', n: 'Denmark', cur: 'DKK', loc: 'da-DK', std: 25, red: [], idp: 'DK', cc: '45', min: 8, max: 8, trunk: '', zip: /^\d{4}$/, ex: '1050' },
  { c: 'EE', n: 'Estonia', cur: 'EUR', loc: 'et-EE', std: 24, red: [9, 13], idp: 'EE', cc: '372', min: 7, max: 8, trunk: '', zip: /^\d{5}$/, ex: '10111' },
  { c: 'FI', n: 'Finland', cur: 'EUR', loc: 'fi-FI', std: 25.5, red: [10, 13.5], idp: 'FI', cc: '358', min: 6, max: 11, trunk: '0', zip: /^\d{5}$/, ex: '00100' },
  { c: 'FR', n: 'France', cur: 'EUR', loc: 'fr-FR', std: 20, red: [2.1, 5.5, 10], idp: 'FR', cc: '33', min: 9, max: 9, trunk: '0', zip: /^\d{5}$/, ex: '75001' },
  { c: 'DE', n: 'Germany', cur: 'EUR', loc: 'de-DE', std: 19, red: [7], idp: 'DE', cc: '49', min: 6, max: 13, trunk: '0', zip: /^\d{5}$/, ex: '10115' },
  { c: 'GR', n: 'Greece', cur: 'EUR', loc: 'el-GR', std: 24, red: [6, 13], idp: 'EL', cc: '30', min: 10, max: 10, trunk: '', zip: /^\d{3} ?\d{2}$/, ex: '105 57' },
  { c: 'HU', n: 'Hungary', cur: 'HUF', loc: 'hu-HU', std: 27, red: [5, 18], idp: 'HU', cc: '36', min: 8, max: 9, trunk: '06', zip: /^\d{4}$/, ex: '1051' },
  { c: 'IE', n: 'Ireland', cur: 'EUR', loc: 'en-IE', std: 23, red: [4.8, 9, 13.5], idp: 'IE', cc: '353', min: 7, max: 9, trunk: '0', zip: /^(?:[AC-FHKNPRTV-Y]\d{2}|D6W) ?[0-9AC-FHKNPRTV-Y]{4}$/, ex: 'D02 X285' },
  { c: 'IT', n: 'Italy', cur: 'EUR', loc: 'it-IT', std: 22, red: [4, 5, 10], idp: 'IT', cc: '39', min: 6, max: 11, trunk: '', zip: /^\d{5}$/, ex: '00100' },
  { c: 'LV', n: 'Latvia', cur: 'EUR', loc: 'lv-LV', std: 21, red: [5, 12], idp: 'LV', cc: '371', min: 8, max: 8, trunk: '', zip: /^(LV-)?\d{4}$/, ex: 'LV-1050' },
  { c: 'LT', n: 'Lithuania', cur: 'EUR', loc: 'lt-LT', std: 21, red: [5, 9], idp: 'LT', cc: '370', min: 8, max: 8, trunk: '8', zip: /^(LT-)?\d{5}$/, ex: 'LT-01100' },
  { c: 'LU', n: 'Luxembourg', cur: 'EUR', loc: 'fr-LU', std: 17, red: [3, 8, 14], idp: 'LU', cc: '352', min: 6, max: 11, trunk: '', zip: /^\d{4}$/, ex: '1111' },
  { c: 'MT', n: 'Malta', cur: 'EUR', loc: 'mt-MT', std: 18, red: [5, 7, 12], idp: 'MT', cc: '356', min: 8, max: 8, trunk: '', zip: /^[A-Z]{3} ?\d{2,4}$/, ex: 'VLT 1117' },
  { c: 'NL', n: 'Netherlands', cur: 'EUR', loc: 'nl-NL', std: 21, red: [9], idp: 'NL', cc: '31', min: 9, max: 9, trunk: '0', zip: /^[1-9]\d{3} ?[A-Z]{2}$/, ex: '1012 AB', extra: ['ideal'] },
  { c: 'PL', n: 'Poland', cur: 'PLN', loc: 'pl-PL', std: 23, red: [5, 8], idp: 'PL', cc: '48', min: 9, max: 9, trunk: '', zip: /^\d{2}-\d{3}$/, ex: '00-001', extra: ['blik', 'p24'] },
  { c: 'PT', n: 'Portugal', cur: 'EUR', loc: 'pt-PT', std: 23, red: [6, 13], idp: 'PT', cc: '351', min: 9, max: 9, trunk: '', zip: /^\d{4}-\d{3}$/, ex: '1000-001' },
  { c: 'RO', n: 'Romania', cur: 'RON', loc: 'ro-RO', std: 21, red: [11], idp: 'RO', cc: '40', min: 9, max: 9, trunk: '0', zip: /^\d{6}$/, ex: '010011' },
  { c: 'SK', n: 'Slovakia', cur: 'EUR', loc: 'sk-SK', std: 23, red: [5, 19], idp: 'SK', cc: '421', min: 9, max: 9, trunk: '0', zip: /^\d{3} ?\d{2}$/, ex: '811 01' },
  { c: 'SI', n: 'Slovenia', cur: 'EUR', loc: 'sl-SI', std: 22, red: [5, 9.5], idp: 'SI', cc: '386', min: 8, max: 8, trunk: '0', zip: /^\d{4}$/, ex: '1000' },
  { c: 'ES', n: 'Spain', cur: 'EUR', loc: 'es-ES', std: 21, red: [4, 10], idp: 'ES', cc: '34', min: 9, max: 9, trunk: '', zip: /^(0[1-9]|[1-4]\d|5[0-2])\d{3}$/, ex: '28001' },
  { c: 'SE', n: 'Sweden', cur: 'SEK', loc: 'sv-SE', std: 25, red: [6, 12], idp: 'SE', cc: '46', min: 7, max: 10, trunk: '0', zip: /^\d{3} ?\d{2}$/, ex: '111 22' },
];
for (const r of EU) {
  add({
    code: r.c, name: r.n, pack: 'EU', currency: r.cur, locale: r.loc,
    phone: ph(r.cc, r.min, r.max, r.trunk),
    postal: { regex: r.zip, example: r.ex, label: 'Postal code' },
    vat: { standard: r.std, reduced: r.red, idPrefix: r.idp },
    paymentMethods: ['card', 'sepa_debit', ...(r.extra ?? [])],
  });
}

export const COUNTRY_PROFILES: Readonly<Record<string, CountryProfile>> = COUNTRIES;
export const EU_COUNTRY_CODES: readonly string[] = EU.map((r) => r.c);

/* -------------------------------- packs ------------------------------ */

export const PACKS: Readonly<Record<PackCode, RegionalPack>> = {
  US: {
    code: 'US', name: 'United States', flag: '🇺🇸', taxLabel: 'Sales tax', dataVerifiedAt: DATA_VERIFIED_AT,
    summary: 'USD, ACH, E.164 +1 validation, ZIP/state checks, federal holidays, CCPA/CAN-SPAM tooling. Sales tax comes from your existing Sales Tax engine.',
    countries: ['US'],
  },
  CA: {
    code: 'CA', name: 'Canada', flag: '🇨🇦', taxLabel: 'GST / HST / PST / QST', dataVerifiedAt: DATA_VERIFIED_AT,
    summary: 'CAD, Pre-authorized Debit (PAD), province-aware GST/HST/PST/QST, postal codes, CASL consent rules, PIPEDA / Quebec Law 25 request deadlines.',
    countries: ['CA'],
  },
  GB: {
    code: 'GB', name: 'United Kingdom', flag: '🇬🇧', taxLabel: 'VAT', dataVerifiedAt: DATA_VERIFIED_AT,
    summary: 'GBP, Bacs Direct Debit, UK VAT with checksum-validated VAT numbers, postcodes, bank holidays (England/Wales, Scotland, N. Ireland), UK GDPR + PECR tooling.',
    countries: ['GB'],
  },
  EU: {
    code: 'EU', name: 'European Union', flag: '🇪🇺', taxLabel: 'VAT', dataVerifiedAt: DATA_VERIFIED_AT,
    summary: 'All 27 member states: VAT incl. reverse charge, EUR/local currencies, SEPA Direct Debit, local phone + postal rules, GDPR tooling, national holidays.',
    countries: EU_COUNTRY_CODES,
  },
  AU: {
    code: 'AU', name: 'Australia', flag: '🇦🇺', taxLabel: 'GST', dataVerifiedAt: DATA_VERIFIED_AT,
    summary: 'AUD, BECS Direct Debit, GST with checksum-validated ABN, state-aware postcodes and holidays, Privacy Act + Spam Act tooling.',
    countries: ['AU'],
  },
};

export function getCountry(code: string | null | undefined): CountryProfile | null {
  if (!code) return null;
  return COUNTRIES[code.toUpperCase()] ?? null;
}

export function packForCountry(code: string | null | undefined): PackCode | null {
  return getCountry(code)?.pack ?? null;
}

export function countriesInPack(pack: PackCode): CountryProfile[] {
  return PACKS[pack].countries.map((c) => COUNTRIES[c]).filter(Boolean);
}

/** Currencies a tenant can bill in once the given packs are enabled. */
export function billingCurrencies(packs: readonly PackCode[]): string[] {
  const out = new Set<string>();
  for (const p of packs) for (const c of countriesInPack(p)) out.add(c.currency);
  return [...out].sort();
}

/** Payment methods available for a country + currency (respects per-method currency limits). */
export function paymentMethodsFor(country: string, currency: string): PaymentMethodSpec[] {
  const profile = getCountry(country);
  if (!profile) return [];
  const cur = currency.toLowerCase();
  return profile.paymentMethods
    .map((t) => PAYMENT_METHODS[t])
    .filter((m) => m.currencies.includes('*') || m.currencies.includes(cur));
}
