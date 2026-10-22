/* ------------------------------------------------------------------ */
/*  Integer money helpers. All tax maths runs on minor units (cents)   */
/*  and integer rates — never on floating-point currency amounts.      */
/* ------------------------------------------------------------------ */

const EXPONENT_OVERRIDES: Record<string, number> = { JPY: 0, KRW: 0, HUF: 2, BHD: 3, KWD: 3 };

export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (code in EXPONENT_OVERRIDES) return EXPONENT_OVERRIDES[code];
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Decimal amount -> minor units, rounded half away from zero. */
export function toMinor(amount: number, currency: string): number {
  const factor = 10 ** currencyExponent(currency);
  const scaled = Math.abs(amount) * factor;
  // +1e-9 guards 1.005 * 100 = 100.49999999999999
  const rounded = Math.floor(scaled + 0.5 + 1e-9);
  return amount < 0 ? -rounded : rounded;
}

export function fromMinor(minor: number, currency: string): number {
  return minor / 10 ** currencyExponent(currency);
}

/** Percent -> integer thousandths of a percent (9.975 -> 9975). */
export function pctToMilli(pct: number): number {
  return Math.round(pct * 1000);
}

/** amountMinor * ratePct, rounded half away from zero, using integer arithmetic only. */
export function applyRate(amountMinor: number, ratePct: number): number {
  if (!Number.isFinite(amountMinor) || !Number.isFinite(ratePct)) throw new Error('applyRate: non-finite input');
  const sign = amountMinor < 0 ? -1 : 1;
  const numerator = Math.abs(amountMinor) * pctToMilli(ratePct);
  if (!Number.isSafeInteger(numerator)) throw new Error('applyRate: amount too large');
  const denominator = 100_000; // 100 (percent) * 1000 (milli)
  const quotient = Math.floor(numerator / denominator);
  const remainder = numerator - quotient * denominator;
  return sign * (remainder * 2 >= denominator ? quotient + 1 : quotient);
}

/**
 * Splits `total` across `weights` so the parts always sum to `total`
 * (largest-remainder method; ties resolved by position).
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + Math.abs(b), 0);
  if (weights.length === 0) return [];
  if (sum === 0) {
    const out = weights.map(() => 0);
    out[0] = total;
    return out;
  }
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = weights.map((w) => (abs * Math.abs(w)) / sum);
  const floors = raw.map(Math.floor);
  let left = abs - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors.map((n) => sign * n);
}

export function formatMinor(minor: number, currency: string, locale = 'en'): string {
  const value = fromMinor(minor, currency);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(value);
  } catch {
    return `${currency.toUpperCase()} ${value.toFixed(currencyExponent(currency))}`;
  }
}
