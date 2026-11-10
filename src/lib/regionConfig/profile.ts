/* ------------------------------------------------------------------ */
/*  regionConfig/profile — the per-account REGION PROFILE               */
/*                                                                      */
/*  Extends (never replaces) regional.ts `RegionalSettings`, which is   */
/*  the persisted per-account record (business_regional_settings).      */
/*  This module DERIVES the display conventions the settings imply:     */
/*  date order, number separators, phone and address layout.            */
/*                                                                      */
/*  Pure. Uses Intl directly, so it is allow-listed in                  */
/*  scripts/check-raw-locale.mjs next to format.ts / regional.ts.       */
/* ------------------------------------------------------------------ */

import { DEFAULT_REGIONAL, isValidLocale, type RegionalSettings, type UnitSystem } from '../regional';
import { COUNTRY_PROFILES } from '../regionalPacks/packData';
import { parsePhone, type AddressInput } from '../regionalPacks/packValidation';

export type DateOrder = 'MDY' | 'DMY' | 'YMD';
export type AddressStyle = 'us' | 'ca' | 'au' | 'gb' | 'postal_city';

export interface RegionFormats {
  date: { order: DateOrder; example: string };
  number: { decimal: string; group: string; example: string };
  phone: { callingCode: string | null; minLen: number | null; maxLen: number | null; trunk: string | null };
  address: { style: AddressStyle; postalLabel: string; subdivisionLabel: string | null; subdivisionRequired: boolean };
}

export interface RegionProfile {
  country: string;
  currency: string;
  reportingCurrency: string;
  locale: string;
  timeZone: string | null;
  unitSystem: UnitSystem;
  weekStart: 0 | 1 | 6;
  hourCycle: 'auto' | '12h' | '24h';
  taxRegime: RegionalSettings['taxRegime'];
  pricesIncludeTax: boolean;
  /** true when a regional pack covers this country (phone/postal/subdivision rules are real, not generic). */
  packCovered: boolean;
  formats: RegionFormats;
}

const SAMPLE = new Date(Date.UTC(2031, 0, 2, 12, 0, 0)); // 2 Jan 2031 — day/month are distinguishable
const SAMPLE_NUMBER = 1234567.89;

function dateOrderFor(locale: string): { order: DateOrder; example: string } {
  const fmt = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  const order = fmt.formatToParts(SAMPLE).filter((p) => p.type === 'day' || p.type === 'month' || p.type === 'year').map((p) => p.type[0].toUpperCase()).join('');
  const known: DateOrder = order === 'DMY' || order === 'YMD' || order === 'MDY' ? order : 'MDY';
  return { order: known, example: fmt.format(SAMPLE) };
}

function numberSeparators(locale: string): RegionFormats['number'] {
  const fmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const parts = fmt.formatToParts(SAMPLE_NUMBER);
  return {
    decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
    group: parts.find((p) => p.type === 'group')?.value ?? ',',
    example: fmt.format(SAMPLE_NUMBER),
  };
}

function addressStyleFor(country: string): AddressStyle {
  if (country === 'US') return 'us';
  if (country === 'CA') return 'ca';
  if (country === 'AU') return 'au';
  if (country === 'GB') return 'gb';
  return 'postal_city'; // EU and every other pack: "postal code, city"
}

const POSTAL_LABEL: Record<string, string> = { US: 'ZIP code', CA: 'Postal code', AU: 'Postcode', GB: 'Postcode' };
const SUBDIVISION_LABEL: Record<string, string> = { US: 'State', CA: 'Province', AU: 'State/Territory', GB: 'Nation' };

/** Build the full profile for a (normalised) RegionalSettings. Never throws. */
export function buildRegionProfile(settings: RegionalSettings = DEFAULT_REGIONAL): RegionProfile {
  const locale = isValidLocale(settings.locale) ? settings.locale : DEFAULT_REGIONAL.locale;
  const cp = COUNTRY_PROFILES[settings.country] ?? null;
  return {
    country: settings.country,
    currency: settings.currency,
    reportingCurrency: settings.reportingCurrency,
    locale,
    timeZone: settings.timeZone,
    unitSystem: settings.unitSystem,
    weekStart: settings.weekStart,
    hourCycle: settings.hourCycle,
    taxRegime: settings.taxRegime,
    pricesIncludeTax: settings.pricesIncludeTax,
    packCovered: cp !== null,
    formats: {
      date: dateOrderFor(locale),
      number: numberSeparators(locale),
      phone: cp
        ? { callingCode: cp.phone.callingCode, minLen: cp.phone.minLen, maxLen: cp.phone.maxLen, trunk: cp.phone.trunk }
        : { callingCode: null, minLen: null, maxLen: null, trunk: null },
      address: {
        style: addressStyleFor(settings.country),
        postalLabel: POSTAL_LABEL[settings.country] ?? 'Postal code',
        subdivisionLabel: SUBDIVISION_LABEL[settings.country] ?? null,
        subdivisionRequired: cp?.subdivisionRequired ?? false,
      },
    },
  };
}

const clean = (v: string | undefined) => (v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Lays an address out the way the destination country writes it. Returns lines (no empty ones).
 * Output is for DISPLAY / documents; validation lives in packValidation.validateAddress.
 */
export function formatAddressLines(a: AddressInput, style: AddressStyle): string[] {
  const l1 = clean(a.line1); const l2 = clean(a.line2); const city = clean(a.city);
  const sub = clean(a.subdivision); const pc = clean(a.postalCode);
  const join = (...p: string[]) => p.filter(Boolean).join(' ');
  let last: string;
  switch (style) {
    case 'us': last = [city, join(sub, pc)].filter(Boolean).join(', '); break; // Austin, TX 78701
    case 'ca': last = join(city, sub, pc); break; // Toronto ON M5V 2T6
    case 'au': last = join(city, sub, pc); break; // Sydney NSW 2000
    case 'gb': return [l1, l2, city, pc].filter(Boolean); // Town on its own line, postcode last
    default: last = join(pc, city); break; // 10115 Berlin
  }
  return [l1, l2, last].filter(Boolean);
}

export function formatAddress(a: AddressInput, country: string, separator = '\n'): string {
  return formatAddressLines(a, addressStyleFor(country.toUpperCase())).join(separator);
}

/**
 * Display a phone number for the region: national format when the number belongs to the
 * account's country, international otherwise. Falls back to the cleaned input.
 */
export function formatPhoneForRegion(raw: string, country: string): string {
  const r = parsePhone(raw, country);
  if (!r.ok) return clean(raw);
  return (r.country === country.toUpperCase() ? r.national : r.international) ?? clean(raw);
}
