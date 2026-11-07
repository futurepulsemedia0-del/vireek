// Minimal cost-per-verified-job model so a Results Plan price is never set blind.
// EVERY default is a PLACEHOLDER until approved. Pure, no I/O.

export interface UnitCostInputs {
  /** Blended voice cost per minute (telephony + STT/TTS + platform). Reuse staffUsage DEFAULT_VOICE_COST_PER_MIN. */
  voiceCostPerMin: number;
  avgCallMinutes: number;
  /** Handled calls needed per verified job (1 / call-to-verified-job rate). */
  callsPerVerifiedJob: number;
  smsPerVerifiedJob: number;
  smsCost: number;
  aiTokenCostPerCall: number;
  /** Review/dispute/support labour per verified job. */
  opsCostPerJob: number;
  /** Expected share of billed jobs that end up credited/disputed (0..1). */
  creditRate: number;
  paymentPercentFee: number;
  paymentFixedFee: number;
}

/** PLACEHOLDERS — calibrate from real data. */
export const UNIT_COST_DEFAULTS: UnitCostInputs = {
  voiceCostPerMin: 0.12,
  avgCallMinutes: 3.5,
  callsPerVerifiedJob: 4.9,
  smsPerVerifiedJob: 4,
  smsCost: 0.01,
  aiTokenCostPerCall: 0.05,
  opsCostPerJob: 0.5,
  creditRate: 0.1,
  paymentPercentFee: 0.036, // card 2.9% + Stripe Billing 0.7%
  paymentFixedFee: 0.3,
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Direct cost of one verified job, excluding payment fees (those depend on the price). */
export function directCostPerVerifiedJob(i: UnitCostInputs): number {
  const calls = i.callsPerVerifiedJob * (i.avgCallMinutes * i.voiceCostPerMin + i.aiTokenCostPerCall);
  return calls + i.smsPerVerifiedJob * i.smsCost + i.opsCostPerJob;
}

export interface MarginRow {
  priceCents: number;
  revenuePerJobCents: number; // after expected credits
  costPerJobCents: number; // direct + payment fees
  marginCents: number;
  marginPct: number;
}

/** Margin at a candidate price per verified job. Never throws; marginPct is 0 when revenue is 0. */
export function marginAtPrice(priceCents: number, i: UnitCostInputs = UNIT_COST_DEFAULTS): MarginRow {
  const price = priceCents / 100;
  const revenue = price * (1 - i.creditRate);
  const fees = price * i.paymentPercentFee + i.paymentFixedFee;
  const cost = directCostPerVerifiedJob(i) + fees;
  const margin = revenue - cost;
  return {
    priceCents,
    revenuePerJobCents: Math.round(revenue * 100),
    costPerJobCents: Math.round(cost * 100),
    marginCents: Math.round(margin * 100),
    marginPct: revenue > 0 ? round2((margin / revenue) * 100) : 0,
  };
}

/** Smallest price (cents) that reaches targetMarginPct (0..95). Closed form, no search. */
export function priceFloorCents(targetMarginPct: number, i: UnitCostInputs = UNIT_COST_DEFAULTS): number {
  const t = Math.min(95, Math.max(0, targetMarginPct)) / 100;
  // margin = P(1-c) - (D + P*f + F) ; marginPct = margin / (P(1-c)) >= t
  // => P(1-c)(1-t) - P*f >= D + F  => P >= (D+F) / ((1-c)(1-t) - f)
  const denom = (1 - i.creditRate) * (1 - t) - i.paymentPercentFee;
  if (denom <= 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(((directCostPerVerifiedJob(i) + i.paymentFixedFee) / denom) * 100);
}

export function marginTable(pricesCents: readonly number[], i: UnitCostInputs = UNIT_COST_DEFAULTS): MarginRow[] {
  return pricesCents.map((p) => marginAtPrice(p, i));
}
