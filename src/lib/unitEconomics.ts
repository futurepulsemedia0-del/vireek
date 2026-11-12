/**
 * Unit economics — pure domain logic (no I/O). Data: 20281101000000_unit_economics_foundation.sql.
 * Rule: every amount carries a basis. 'estimated' (rate x usage) is never mixed silently with
 * 'provider_reported' (webhook) or 'invoiced' (reconciled). A missing rate is "unpriced", never $0.
 */
export type CostComponent =
  | 'carrier_inbound' | 'carrier_outbound' | 'carrier_unclassified' | 'asr' | 'llm' | 'tts'
  | 'voice_platform' | 'sms_segment' | 'recording_storage' | 'transcription' | 'embeddings'
| 'vision' | 'provider_other' | 'provider_total_unbroken' | 'phone_number' | 'platform_fixed';

export type CostBasis = 'estimated' | 'provider_reported' | 'invoiced';

export interface CostRate {
  component: CostComponent;
  provider: string;
  unit: string; // e.g. per_minute, per_1m_input_tokens — llm input/output are separate rates
  rateUsd: number;
  source: string;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null; // exclusive
  /** official | secondary_source | unverified | assumption; null/undefined = entered by a human (no badge). */
  status?: string | null;
}

export interface CostLine { component: CostComponent; amountUsd: number; basis: CostBasis }

const BASIS_RANK: Record<CostBasis, number> = { estimated: 0, provider_reported: 1, invoiced: 2 };

/** Latest rate in effect on `onDate`; null when none exists (caller must show "unpriced"). */
export function resolveRate(rates: CostRate[], component: CostComponent, provider: string, unit: string, onDate: string): CostRate | null {
  let best: CostRate | null = null;
  for (const r of rates) {
    if (r.component !== component || r.provider !== provider || r.unit !== unit) continue;
    if (r.effectiveFrom > onDate) continue;
    if (r.effectiveTo !== null && onDate >= r.effectiveTo) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  return best;
}

export function estimateCost(rate: CostRate | null, quantity: number): { costUsd: number | null; unpriced: boolean } {
  if (!Number.isFinite(quantity) || quantity < 0) throw new RangeError('quantity must be a finite number >= 0');
  if (!rate) return { costUsd: null, unpriced: true };
  return { costUsd: quantity * rate.rateUsd, unpriced: false };
}

export interface CostSummary {
  totalUsd: number;
  byBasisUsd: Record<CostBasis, number>;
  byComponentUsd: Partial<Record<CostComponent, number>>;
}

/** Per component only the highest-ranked basis counts (invoiced > provider_reported > estimated): no double counting. */
export function summarizeCosts(lines: CostLine[]): CostSummary {
  const chosen = new Map<CostComponent, { basis: CostBasis; amountUsd: number }>();
  for (const l of lines) {
    if (!Number.isFinite(l.amountUsd) || l.amountUsd < 0) continue;
    const cur = chosen.get(l.component);
    if (!cur || BASIS_RANK[l.basis] > BASIS_RANK[cur.basis]) chosen.set(l.component, { basis: l.basis, amountUsd: l.amountUsd });
    else if (BASIS_RANK[l.basis] === BASIS_RANK[cur.basis]) cur.amountUsd += l.amountUsd;
  }
  const out: CostSummary = { totalUsd: 0, byBasisUsd: { estimated: 0, provider_reported: 0, invoiced: 0 }, byComponentUsd: {} };
  for (const [component, v] of chosen) {
    out.totalUsd += v.amountUsd;
    out.byBasisUsd[v.basis] += v.amountUsd;
    out.byComponentUsd[component] = v.amountUsd;
  }
  return out;
}

export function grossMargin(revenueUsd: number, costUsd: number): { marginUsd: number; marginPct: number | null } {
  const marginUsd = revenueUsd - costUsd;
  return { marginUsd, marginPct: revenueUsd > 0 ? (marginUsd / revenueUsd) * 100 : null };
}

/** Linear-interpolation percentile, p in [0,100]; null for empty input. */
export function percentile(values: number[], p: number): number | null {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (v.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return v[lo] + (v[hi] - v[lo]) * (rank - lo);
}

/** Minutes of use per month at which cost equals revenue. null when cost/min is not > 0 (unbounded). */
export function maxProfitableMinutes(priceUsd: number, fixedCostUsd: number, costPerMinuteUsd: number): number | null {
  if (!(costPerMinuteUsd > 0)) return null;
  return Math.max(0, (priceUsd - fixedCostUsd) / costPerMinuteUsd);
}
