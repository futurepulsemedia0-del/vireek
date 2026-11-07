// supabase/functions/_shared/economics/microDollars.ts
//
// Pure, import-free cost math in INTEGER micro-dollars (1 USD = 1_000_000 micro). No floats touch money:
// rates are parsed from decimal strings into integers (USD x 1e8), quantities into integers (x 1e4),
// and the product is divided with BigInt using round-half-up. Rates are VERSIONED DATA (provider_cost_rates
// rows with effective dates); this file never holds a price.

export type RateUnit =
  | "per_minute" | "per_1m_input_tokens" | "per_1m_output_tokens" | "per_segment"
  | "per_1k_characters" | "per_gb_month" | "per_image" | "per_event";

export interface VersionedRate {
  id: string;
  component: string;
  provider: string;
  unit: RateUnit;
  /** Decimal string, e.g. "0.00250000". Strings avoid float drift (DB column is numeric(18,8)). */
  rateUsd: string;
  effectiveFrom: string; // YYYY-MM-DD, inclusive
  effectiveTo: string | null; // YYYY-MM-DD, exclusive
}

const RATE_SCALE = 8; // decimals kept in a rate
const QTY_SCALE = 4; // decimals kept in a quantity (matches cost_usage_events.quantity numeric(18,4))

const UNIT_DIVISOR: Record<RateUnit, bigint> = {
  per_minute: 1n, per_segment: 1n, per_gb_month: 1n, per_image: 1n, per_event: 1n,
  per_1k_characters: 1_000n,
  per_1m_input_tokens: 1_000_000n,
  per_1m_output_tokens: 1_000_000n,
};

/** Parses a non-negative decimal string/number into an integer scaled by 10^scale. Throws on junk, never rounds silently. */
export function parseScaled(value: string | number, scale: number): bigint {
  const s = typeof value === "number" ? numberToPlain(value) : String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new RangeError(`not a non-negative decimal: ${String(value)}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) {
    throw new RangeError(`more than ${scale} significant decimals: ${s}`);
  }
  return BigInt(whole + frac.slice(0, scale).padEnd(scale, "0"));
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`not a finite non-negative number: ${n}`);
  // toFixed avoids exponent notation; 12 decimals is above anything we store.
  return n.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

function divRoundHalfUp(num: bigint, den: bigint): bigint {
  return (num * 2n + den) / (den * 2n);
}

/**
 * cost_micro = round_half_up(quantity x rate / unitDivisor), in integer micro-USD.
 * `quantity` for token units is the RAW TOKEN COUNT (the per-1M divisor is applied here).
 */
export function costMicro(quantity: string | number, rateUsd: string | number, unit: RateUnit): number {
  const q = parseScaled(quantity, QTY_SCALE);
  const r = parseScaled(rateUsd, RATE_SCALE);
  // q*r is USD x 10^(QTY_SCALE+RATE_SCALE); micro-USD is USD x 10^6.
  const num = q * r;
  const den = 10n ** BigInt(QTY_SCALE + RATE_SCALE - 6) * UNIT_DIVISOR[unit];
  const out = divRoundHalfUp(num, den);
  if (out > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("cost exceeds safe integer micro-dollars");
  return Number(out);
}

/** Latest rate in effect on `onDate` (YYYY-MM-DD, UTC). null when none: caller records "unpriced", never $0. */
export function resolveVersionedRate(
  rates: readonly VersionedRate[], component: string, provider: string, unit: RateUnit, onDate: string,
): VersionedRate | null {
  let best: VersionedRate | null = null;
  for (const r of rates) {
    if (r.component !== component || r.provider !== provider || r.unit !== unit) continue;
    if (r.effectiveFrom > onDate) continue;
    if (r.effectiveTo !== null && onDate >= r.effectiveTo) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  return best;
}

export interface PricedEvent {
  priced: boolean;
  costMicro: number | null;
  rateId: string | null;
  /** Snapshot of the rate USED, stored on the ledger row so a later price change never rewrites history. */
  rateUsdSnapshot: string | null;
}

export function priceEvent(
  rates: readonly VersionedRate[],
  e: { component: string; provider: string; unit: RateUnit; quantity: string | number; occurredAt: string },
): PricedEvent {
  const onDate = e.occurredAt.slice(0, 10);
  const rate = resolveVersionedRate(rates, e.component, e.provider, e.unit, onDate);
  if (!rate) return { priced: false, costMicro: null, rateId: null, rateUsdSnapshot: null };
  return { priced: true, costMicro: costMicro(e.quantity, rate.rateUsd, e.unit), rateId: rate.id, rateUsdSnapshot: rate.rateUsd };
}

/** Converts a legacy float USD figure (e.g. ai_usage_logs.cost_usd numeric(12,6)) to micro-USD, half-up. */
export function usdToMicro(usd: number | string): number {
  return Number(divRoundHalfUp(parseScaled(typeof usd === "number" ? usd.toFixed(6) : usd, 6 + 6), 10n ** 6n));
}

export const microToUsd = (micro: number): number => micro / 1_000_000;

/** Unit cost with an explicit sample size and exclusions. Never divides by zero; never hides n. */
export interface UnitCost {
  costMicroTotal: number;
  units: number;
  microPerUnit: number | null;
  excluded: { unpriced: number; missingCorrelation: number };
}
export function unitCost(
  rows: readonly { costMicro: number | null; hasCorrelation: boolean }[], units: number,
): UnitCost {
  let total = 0, unpriced = 0, missing = 0;
  for (const r of rows) {
    if (r.costMicro === null) { unpriced++; continue; }
    if (!r.hasCorrelation) { missing++; continue; }
    total += r.costMicro;
  }
  return { costMicroTotal: total, units, microPerUnit: units > 0 ? Math.round(total / units) : null, excluded: { unpriced, missingCorrelation: missing } };
}
