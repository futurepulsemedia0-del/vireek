// International phone handling on top of libphonenumber-js (default "min" metadata).
// The mask formats as-you-type; validation/normalization to E.164 happens in schemas.ts.

import { AsYouType, isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import type { Mask, MaskResult } from './masks';
import { cleanPasted, toLatinDigits } from './text';

/** Region from a BCP-47 tag: "en-US" -> "US", "fa" -> undefined. */
export function regionFromLocale(locale?: string | null): CountryCode | undefined {
  const region = (locale ?? '').split('-u-')[0]?.split('-').find((p) => /^[A-Za-z]{2}$/.test(p) && p === p.toUpperCase());
  return region && isSupportedCountry(region) ? (region as CountryCode) : undefined;
}

/** Account setting wins, then the browser locale region, then US. */
export function resolveDefaultCountry(opts: { accountCountry?: string | null; locale?: string | null } = {}): CountryCode {
  const account = opts.accountCountry?.toUpperCase();
  if (account && isSupportedCountry(account)) return account as CountryCode;
  return regionFromLocale(opts.locale) ?? regionFromLocale(typeof navigator === 'undefined' ? undefined : navigator.language) ?? 'US';
}

const EXAMPLES: Partial<Record<CountryCode, string>> = {
  US: '(201) 555-0123',
  CA: '(506) 234-5678',
  GB: '07400 123456',
  AU: '0412 345 678',
  DE: '01512 3456789',
  FR: '06 12 34 56 78',
  ES: '612 34 56 78',
};

export function phoneMask(country: CountryCode): Mask {
  const format = (raw: string): MaskResult => {
    const t = toLatinDigits(cleanPasted(raw)).trim();
    let plus = t.startsWith('+');
    let digits = t.replace(/\D/g, '');
    if (!plus && digits.startsWith('00')) {
      plus = true;
      digits = digits.slice(2);
    }
    digits = digits.slice(0, 15);
    if (!plus && digits === '') return { display: '', value: '' };
    const typed = new AsYouType(plus ? undefined : country);
    const display = typed.input(plus ? `+${digits}` : digits);
    const number = typed.getNumber();
    return { display, value: number?.isValid() ? number.number : plus ? `+${digits}` : digits };
  };
  return {
    inputMode: 'tel',
    example: EXAMPLES[country] ?? '+1 201 555 0123',
    maxLength: 24,
    format,
    fromValue: (v) => format(v).display,
    isSignificant: (ch) => /[0-9+]/.test(toLatinDigits(ch)),
  };
}

export interface NormalizedPhone {
  e164: string;
  country: CountryCode | undefined;
}

/** Strict parse: returns null unless the number is valid for its country. */
export function normalizePhone(value: string, defaultCountry: CountryCode): NormalizedPhone | null {
  const parsed = parsePhoneNumberFromString(toLatinDigits(value), defaultCountry);
  return parsed?.isValid() ? { e164: parsed.number, country: parsed.country } : null;
}
