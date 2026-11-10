/* ------------------------------------------------------------------ */
/*  regionConfig/money — currency-safe money in MINOR units             */
/*                                                                      */
/*  WHY THIS EXISTS                                                     */
/*   The repo has two minor-unit conventions that must never be mixed:  */
/*    - LEGACY (regional.ts, every *_cents column): integer = major×100 */
/*      for EVERY currency, JPY included (¥1,000 is stored as 100000).  */
/*    - EXPONENT (regionalPacks/packMoney.ts): integer = major×10^exp,  */
/*      so ¥1,000 is 1000.                                              */
/*   `Money` always uses the EXPONENT convention. The only sanctioned   */
/*   crossings are legacyCentsToMoney() / moneyToLegacyCents().         */
/*                                                                      */
/*  Pure: no React, no I/O, no Intl. All arithmetic uses BigInt so     */
/*  rounding is exact and never depends on floating point.              */
/* ------------------------------------------------------------------ */

import { allocate as allocateMinor, currencyExponent } from '../regionalPacks/packMoney';

/**
 * Rounding rules (ties = exactly half a minor unit):
 *  - half_away_from_zero : 2.5 → 3, -2.5 → -3   (default; matches packMoney.toMinor)
 *  - half_up             : 2.5 → 3, -2.5 → -2   (toward +∞)
 *  - half_even           : 2.5 → 2, 3.5 → 4     (banker's rounding)
 *  - floor / ceil        : toward -∞ / +∞
 *  - trunc               : toward zero
 */
export type RoundingMode = 'half_away_from_zero' | 'half_up' | 'half_even' | 'floor' | 'ceil' | 'trunc';
export const ROUNDING_MODES: readonly RoundingMode[] = ['half_away_from_zero', 'half_up', 'half_even', 'floor', 'ceil', 'trunc'] as const;
export const DEFAULT_ROUNDING: RoundingMode = 'half_away_from_zero';

export class MoneyError extends Error {
  constructor(public readonly code: 'INVALID_AMOUNT' | 'INVALID_CURRENCY' | 'CURRENCY_MISMATCH' | 'UNSUPPORTED_CURRENCY' | 'OVERFLOW' | 'INVALID_RATE', message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export interface Money {
  /** Integer count of minor units (exponent convention). Negative for credits/refunds. */
  readonly minor: number;
  /** ISO 4217 upper-case code. */
  readonly currency: string;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

function normCurrency(code: string): string {
  const c = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!CURRENCY_RE.test(c)) throw new MoneyError('INVALID_CURRENCY', `Invalid currency code "${String(code)}".`);
  return c;
}

/** Construct Money from an integer number of minor units. */
export function money(minor: number, currency: string): Money {
  if (!Number.isSafeInteger(minor)) throw new MoneyError('INVALID_AMOUNT', 'Money minor units must be a safe integer.');
  return Object.freeze({ minor: minor === 0 ? 0 : minor, currency: normCurrency(currency) }); // normalises -0
}

export const zero = (currency: string): Money => money(0, currency);

/* ---------------- exact integer division with rounding ---------------- */

/** n / d rounded per `mode`. d must be > 0. */
export function divRound(n: bigint, d: bigint, mode: RoundingMode = DEFAULT_ROUNDING): bigint {
  if (d <= 0n) throw new MoneyError('INVALID_AMOUNT', 'divRound: divisor must be positive.');
  const q = n / d; // truncates toward zero
  const r = n - q * d; // same sign as n
  if (r === 0n) return q;
  const neg = n < 0n;
  const twice = (r < 0n ? -r : r) * 2n;
  const away = neg ? q - 1n : q + 1n; // one step away from zero
  switch (mode) {
    case 'trunc': return q;
    case 'floor': return neg ? q - 1n : q;
    case 'ceil': return neg ? q : q + 1n;
    case 'half_away_from_zero': return twice >= d ? away : q;
    case 'half_up': return twice > d ? away : twice < d ? q : (neg ? q : q + 1n);
    case 'half_even': return twice > d ? away : twice < d ? q : (q % 2n === 0n ? q : away);
    default: throw new MoneyError('INVALID_AMOUNT', `Unknown rounding mode "${String(mode)}".`);
  }
}

function toSafeNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new MoneyError('OVERFLOW', 'Money amount exceeds the safe integer range.');
  return Number(v);
}

/* ---------------- decimal parsing (exact) ---------------- */

/** Parses "-12.345" / 12.345 into { int: -12345n, scale: 3 } without floating-point error. */
export function parseDecimal(input: number | string): { int: bigint; scale: number } {
  let s: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError('INVALID_AMOUNT', 'Amount must be finite.');
    // toFixed(12) resolves binary noise (1.005 → "1.005000000000") for any realistic price.
    s = Math.abs(input) >= 1e15 ? '' : input.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
    if (!s) throw new MoneyError('OVERFLOW', 'Amount too large for a decimal number; pass a string.');
  } else {
    s = String(input).trim();
  }
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new MoneyError('INVALID_AMOUNT', `Not a plain decimal: "${s}".`);
  const frac = m[3] ?? '';
  const int = BigInt(`${m[1]}${m[2]}${frac}`);
  return { int, scale: frac.length };
}

/** Decimal MAJOR amount → Money, rounded per `mode`. fromDecimal('1.005','USD') → 101 minor (half_away). */
export function fromDecimal(amount: number | string, currency: string, mode: RoundingMode = DEFAULT_ROUNDING): Money {
  const cur = normCurrency(currency);
  const exp = currencyExponent(cur);
  const { int, scale } = parseDecimal(amount);
  // value = int / 10^scale ; minor = value * 10^exp
  const num = exp >= scale ? int * 10n ** BigInt(exp - scale) : int;
  const den = exp >= scale ? 1n : 10n ** BigInt(scale - exp);
  return money(toSafeNumber(divRound(num, den, mode)), cur);
}

/** Money → MAJOR-unit number (display/export only — never feed back into arithmetic). */
export function toDecimalNumber(m: Money): number {
  return m.minor / 10 ** currencyExponent(m.currency);
}

/* ---------------- arithmetic ---------------- */

function assertSame(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new MoneyError('CURRENCY_MISMATCH', `Cannot combine ${a.currency} with ${b.currency} without an explicit conversion.`);
}
export const add = (a: Money, b: Money): Money => { assertSame(a, b); return money(a.minor + b.minor, a.currency); };
export const subtract = (a: Money, b: Money): Money => { assertSame(a, b); return money(a.minor - b.minor, a.currency); };
export const negate = (a: Money): Money => money(-a.minor, a.currency);
export const isZero = (a: Money): boolean => a.minor === 0;
export function compare(a: Money, b: Money): -1 | 0 | 1 { assertSame(a, b); return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0; }
export function sum(items: readonly Money[], currency: string): Money {
  return items.reduce((acc, m) => add(acc, m), zero(currency));
}

/**
 * Multiply by a PERCENT rate (up to 3 decimals, e.g. "9.975"), rounded once at the end.
 * Rates are parsed as exact decimals; more than 3 decimals is rejected so a rate can never be
 * silently truncated.
 */
export function mulPct(m: Money, ratePct: number | string, mode: RoundingMode = DEFAULT_ROUNDING): Money {
  const { int, scale } = parseDecimal(ratePct);
  if (scale > 3 && int % 10n ** BigInt(scale - 3) !== 0n) throw new MoneyError('INVALID_RATE', 'Rates support at most 3 decimal places.');
  const milli = scale > 3 ? int / 10n ** BigInt(scale - 3) : int * 10n ** BigInt(3 - scale);
  return money(toSafeNumber(divRound(BigInt(m.minor) * milli, 100_000n, mode)), m.currency);
}

/** Multiply by an exact rational (num/den), e.g. an FX rate as 1085/1000. */
export function mulRatio(m: Money, num: bigint | number, den: bigint | number, mode: RoundingMode = DEFAULT_ROUNDING): Money {
  const n = BigInt(num); const d = BigInt(den);
  return money(toSafeNumber(divRound(BigInt(m.minor) * n, d, mode)), m.currency);
}

/** Splits so parts always sum to the total (largest remainder). */
export function allocate(m: Money, weights: readonly number[]): Money[] {
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) throw new MoneyError('INVALID_AMOUNT', 'Allocation weights must be finite and non-negative.');
  return allocateMinor(m.minor, weights).map((p) => money(p, m.currency));
}

/* ---------------- legacy "cents ×100" bridge ---------------- */

/**
 * Legacy stored cents (major×100 for ALL currencies) → Money.
 * For 2-decimal currencies this is the identity. For zero-decimal currencies (JPY…) the value
 * is divided by 100 and rounded per `mode` (it should already be a multiple of 100 if it was
 * written through roundCents()). Currencies with 3 decimals are rejected: the legacy
 * convention cannot represent them.
 */
export function legacyCentsToMoney(cents: number, currency: string, mode: RoundingMode = DEFAULT_ROUNDING): Money {
  if (!Number.isFinite(cents)) throw new MoneyError('INVALID_AMOUNT', 'Legacy cents must be finite.');
  const cur = normCurrency(currency);
  const exp = currencyExponent(cur);
  if (exp > 2) throw new MoneyError('UNSUPPORTED_CURRENCY', `${cur} has ${exp} decimals; the legacy cents convention supports at most 2.`);
  const whole = Math.round(cents); // legacy columns are integers; this only absorbs float dust
  if (exp === 2) return money(whole, cur);
  return money(toSafeNumber(divRound(BigInt(whole), 100n, mode)), cur);
}

/** Money → legacy stored cents (major×100) for existing *_cents columns and regional.ts helpers. */
export function moneyToLegacyCents(m: Money): number {
  const exp = currencyExponent(m.currency);
  if (exp > 2) throw new MoneyError('UNSUPPORTED_CURRENCY', `${m.currency} cannot be stored in legacy cents.`);
  return exp === 2 ? m.minor : toSafeNumber(BigInt(m.minor) * 100n);
}

/** Stripe-style minor units are exactly the exponent convention. */
export const toStripeMinor = (m: Money): number => m.minor;
export const fromStripeMinor = (minor: number, currency: string): Money => money(minor, currency);
