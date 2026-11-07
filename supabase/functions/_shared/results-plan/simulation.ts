// Results Plan — 12-month synthetic simulation of margin distribution (pure, deterministic).
import { UNIT_COST_DEFAULTS, directCostPerVerifiedJob, type UnitCostInputs } from './unitEconomics.ts';
import { monthlyTotalCents, priceNextJob, type PricingTerms } from './pricing.ts';

export interface SimConfig {
  accounts: number;
  months: number;
  seed: number;
  /** Mean verified jobs per account per month and its spread (lognormal sigma). */
  meanJobsPerMonth: number;
  jobsSigma: number;
  /** Share of jobs that get disputed and credited. */
  creditRate: number;
  /** Share of accounts that "game" by not marking completion (lost billable jobs). */
  gamingShare: number;
  gamingLoss: number;
  /** Fraction of job volume that are higher-priced types. */
  premiumShare: number;
  costs: UnitCostInputs;
}

/** PLACEHOLDER scenario — replace with real data. */
export const SIM_DEFAULTS: SimConfig = {
  accounts: 500, months: 12, seed: 42, meanJobsPerMonth: 18, jobsSigma: 0.8, creditRate: 0.08,
  gamingShare: 0.1, gamingLoss: 0.4, premiumShare: 0.2, costs: UNIT_COST_DEFAULTS,
};

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(r: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

export interface SimResult {
  accountMargins: number[];
  p10: number; p50: number; p90: number;
  lossAccounts: number; // accounts with negative total margin
  totalRevenueCents: number; totalCostCents: number; totalMarginPct: number;
}

const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

export function simulate(terms: PricingTerms, premiumType: string, cfg: SimConfig = SIM_DEFAULTS, baseFeeCostCents = 0): SimResult {
  const r = mulberry32(cfg.seed);
  const directCents = directCostPerVerifiedJob(cfg.costs) * 100;
  const accountMargins: number[] = [];
  let totalRev = 0, totalCost = 0, lossAccounts = 0;
  for (let a = 0; a < cfg.accounts; a++) {
    const scale = Math.exp(cfg.jobsSigma * normal(r) - (cfg.jobsSigma ** 2) / 2);
    const gamer = r() < cfg.gamingShare;
    let rev = 0, cost = 0;
    for (let m = 0; m < cfg.months; m++) {
      const lam = Math.min(cfg.meanJobsPerMonth * scale, 60);
      const L = Math.exp(-lam); let k = 0, p = 1;
      do { k++; p *= r(); } while (p > L && k < 400);
      const jobs = k - 1;
      let charged = 0, credited = 0;
      for (let j = 0; j < jobs; j++) {
        cost += directCents;
        if (gamer && r() < cfg.gamingLoss) continue;
        const type = r() < cfg.premiumShare ? premiumType : null;
        const d = priceNextJob(terms, { chargedCents: charged, startedAt: '2026-01-01T00:00:00Z' }, type, '2026-06-01T00:00:00Z');
        charged += d.amountCents;
        cost += d.amountCents * cfg.costs.paymentPercentFee + cfg.costs.paymentFixedFee * 100;
        if (r() < cfg.creditRate) credited += d.amountCents;
      }
      rev += monthlyTotalCents(terms, charged) - credited;
      cost += baseFeeCostCents;
    }
    accountMargins.push(rev > 0 ? (rev - cost) / rev : -1);
    totalRev += rev; totalCost += cost;
    if (rev - cost < 0) lossAccounts++;
  }
  const sorted = [...accountMargins].sort((x, y) => x - y);
  return {
    accountMargins, p10: pct(sorted, 0.1), p50: pct(sorted, 0.5), p90: pct(sorted, 0.9), lossAccounts,
    totalRevenueCents: Math.round(totalRev), totalCostCents: Math.round(totalCost),
    totalMarginPct: totalRev > 0 ? (totalRev - totalCost) / totalRev : 0,
  };
}
