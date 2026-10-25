// supabase/functions/_shared/pay/money.ts — integer-cent helpers. No floats ever reach a ledger.

export const isSafeCents = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Coerces untrusted numeric input to non-negative integer cents (NaN/negative/∞ → 0). */
export function toCents(n: unknown): number {
  const v = typeof n === "string" ? Number(n) : (n as number);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export interface FeeSchedule {
  feeBps: number;
  minFeeCents: number;
  maxFeeCents: number;
}

/** fee = clamp(round(amount × bps / 10 000), min, max). Pure and deterministic. */
export function computeFeeCents(amountCents: number, s: FeeSchedule): number {
  if (!isSafeCents(amountCents) || amountCents === 0) return 0;
  const pct = Math.round((amountCents * Math.max(0, s.feeBps)) / 10_000);
  const lo = Math.max(0, s.minFeeCents);
  const hi = Math.max(lo, s.maxFeeCents);
  return Math.min(Math.max(pct, lo), hi);
}

export const formatUsd = (cents: number): string =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
