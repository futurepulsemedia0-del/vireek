/* ------------------------------------------------------------------ */
/*  currency — Multi-currency display for pricing                      */
/*                                                                      */
/*  All prices in `pricing.ts` are stored in USD. This module converts */
/*  a USD amount into another currency for DISPLAY purposes only.      */
/*  Actual Stripe checkout still charges in USD unless "Adaptive       */
/*  Pricing" is enabled in the Stripe Dashboard, or separate per-      */
/*  currency Payment Links are configured in `pricing.ts`.             */
/* ------------------------------------------------------------------ */

export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AUD' | 'AED' | 'TRY';

export interface Currency {
  code: CurrencyCode;
  symbol: string;
  name: string;
  /** 1 USD = `rate` units of this currency. Update periodically — these are approximate. */
  rate: number;
}

export const CURRENCIES: Record<CurrencyCode, Currency> = {
  USD: { code: 'USD', symbol: '$', name: 'US Dollar', rate: 1 },
  EUR: { code: 'EUR', symbol: '€', name: 'Euro', rate: 0.92 },
  GBP: { code: 'GBP', symbol: '£', name: 'British Pound', rate: 0.78 },
  CAD: { code: 'CAD', symbol: 'CA$', name: 'Canadian Dollar', rate: 1.36 },
  AUD: { code: 'AUD', symbol: 'A$', name: 'Australian Dollar', rate: 1.52 },
  AED: { code: 'AED', symbol: 'AED\u00a0', name: 'UAE Dirham', rate: 3.67 },
  TRY: { code: 'TRY', symbol: '₺', name: 'Turkish Lira', rate: 34 },
};

export const DEFAULT_CURRENCY: CurrencyCode = 'USD';

/** Rough country -> currency map, used only to pick a sensible default. */
const COUNTRY_TO_CURRENCY: Record<string, CurrencyCode> = {
  US: 'USD',
  GB: 'GBP',
  CA: 'CAD',
  AU: 'AUD',
  DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR',
  IE: 'EUR', PT: 'EUR', AT: 'EUR', FI: 'EUR', GR: 'EUR',
  AE: 'AED',
  TR: 'TRY',
};

/**
 * Guesses a currency from `navigator.language` (e.g. "de-DE" -> EUR).
 * Falls back to `fallback` (default: USD) when there's no region match —
 * safe to call on the server/during SSR since it checks for `navigator`.
 */
export function detectCurrencyFromLocale(fallback: CurrencyCode = DEFAULT_CURRENCY): CurrencyCode {
  if (typeof navigator === 'undefined') return fallback;
  const raw = navigator.language || (navigator.languages && navigator.languages[0]) || '';
  const region = raw.split('-')[1]?.toUpperCase();
  return (region && COUNTRY_TO_CURRENCY[region]) || fallback;
}

/** Converts a USD amount into `currency`, unrounded. */
export function convert(usdAmount: number, currency: CurrencyCode): number {
  const c = CURRENCIES[currency] ?? CURRENCIES[DEFAULT_CURRENCY];
  return usdAmount * c.rate;
}

/**
 * Converts a USD amount into `currency` and formats it as a clean, rounded
 * price string (e.g. 199 USD -> "€183", not "€183.24") so it reads like a
 * real price tag instead of a live FX ticker.
 */
export function formatPrice(usdAmount: number, currency: CurrencyCode): string {
  const c = CURRENCIES[currency] ?? CURRENCIES[DEFAULT_CURRENCY];
  const rounded = Math.round(convert(usdAmount, currency));
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: c.code,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(rounded);
  } catch {
    return `${c.symbol}${rounded}`;
  }
}
