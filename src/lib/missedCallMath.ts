// Recreated: verify against original intent (recovered verbatim from homepage-redesign.patch)
/**
 * Pure math for the homepage "cost of missed calls" calculator.
 * Kept separate from the component so the formula shown to visitors is the formula that is tested.
 *
 *   missed calls / month = calls per week × (missed %) × 52 / 12
 *   revenue at stake     = missed calls / month × (% that would have booked) × average job value
 *
 * This is an ESTIMATE from the visitor's own inputs — not a forecast of what Vireek will recover.
 */
export interface MissedCallInputs {
  callsPerWeek: number;
  missedPercent: number; // 0–100
  bookRatePercent: number; // 0–100
  jobValue: number; // currency units
}

export interface MissedCallResult {
  missedPerMonth: number;
  bookedJobsPerMonth: number;
  monthlyRevenueAtStake: number;
  annualRevenueAtStake: number;
}

export const WEEKS_PER_MONTH = 52 / 12;

export const CALCULATOR_DEFAULTS: MissedCallInputs = {
  callsPerWeek: 50,
  missedPercent: 20,
  bookRatePercent: 30,
  jobValue: 350,
};

const clamp = (n: number, min: number, max: number) =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;

export function calculateMissedCallCost(input: MissedCallInputs): MissedCallResult {
  const calls = clamp(input.callsPerWeek, 0, 10_000);
  const missedPct = clamp(input.missedPercent, 0, 100);
  const bookPct = clamp(input.bookRatePercent, 0, 100);
  const jobValue = clamp(input.jobValue, 0, 1_000_000);

  const missedPerMonth = calls * (missedPct / 100) * WEEKS_PER_MONTH;
  const bookedJobsPerMonth = missedPerMonth * (bookPct / 100);
  const monthlyRevenueAtStake = bookedJobsPerMonth * jobValue;

  return {
    missedPerMonth,
    bookedJobsPerMonth,
    monthlyRevenueAtStake,
    annualRevenueAtStake: monthlyRevenueAtStake * 12,
  };
}
