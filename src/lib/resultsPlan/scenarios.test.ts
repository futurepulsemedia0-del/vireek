// Margin scenarios for the two DRAFT Results Plan terms (see migration 20290303000000_results_plan_draft_pricing_terms.sql).
// Pure arithmetic on PLACEHOLDER costs (UNIT_COST_DEFAULTS is NOT changed here). Nothing is approved or published by this file.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { priceNextJob, validateTerms, type PricingTerms } from '../../../supabase/functions/_shared/results-plan/pricing';
import { UNIT_COST_DEFAULTS, directCostPerVerifiedJob, type UnitCostInputs } from '../../../supabase/functions/_shared/results-plan/unitEconomics';

/** Business rule from the task: a draft whose worst-case gross margin is below this must fail. */
const MIN_WORST_CASE_MARGIN_PCT = 35;
const COSTS: UnitCostInputs = { ...UNIT_COST_DEFAULTS, creditRate: 0.08 };

interface Draft { name: string; terms: PricingTerms; fairUseMinutes: number }

// Mirrors the migration. The drift test below fails if the SQL and these numbers disagree.
const DRAFTS: readonly Draft[] = [
  { name: 'Draft - Hybrid 99', fairUseMinutes: 300, terms: { model: 'hybrid', baseFeeCents: 9900, perJobCents: 1500, tierPriceCents: {}, monthlyFloorCents: 0, monthlyCapCents: 24900, neverExceedFlatCents: null, guaranteeDays: 30, guaranteeCapCents: 9900 } },
  { name: 'Draft - Hybrid 249', fairUseMinutes: 700, terms: { model: 'hybrid', baseFeeCents: 24900, perJobCents: 1200, tierPriceCents: {}, monthlyFloorCents: 0, monthlyCapCents: 54900, neverExceedFlatCents: null, guaranteeDays: 30, guaranteeCapCents: 24900 } },
];

// Steady-state month: well after the 30-day guarantee window and the 14-day trial, so only the monthly cap can bind.
const STARTED_AT = '2026-01-01T00:00:00.000Z';
const AT = '2026-03-15T00:00:00.000Z';

interface ScenarioResult {
  label: string; jobs: number; minutes: number; overFairUse: boolean; revenueCents: number; costCents: number;
  marginCents: number; marginPct: number; jobChargesCents: number; boundBy: string;
}

/**
 * One billing month, in cents. Assumptions (all placeholders until calibrated):
 *  - Revenue = base fee (never credited) + per-job charges after caps, minus creditRate on the job charges only.
 *  - Usage cost of a verified job = directCostPerVerifiedJob() (voice + AI + SMS + ops), as in the live cost model.
 *  - Zero-job worst case: every fair-use minute is consumed by calls that convert to nothing; no ops cost.
 *  - Payment fee = percent fee on gross billed + ONE fixed fee (one monthly Stripe invoice carries base + metered usage).
 */
function simulateMonth(d: Draft, verifiedJobs: number, opts: { fullFairUse?: boolean; label: string }): ScenarioResult {
  let charged = 0;
  let boundBy = 'none';
  for (let n = 0; n < verifiedJobs; n++) {
    const r = priceNextJob(d.terms, { chargedCents: charged, startedAt: STARTED_AT }, null, AT);
    charged += r.amountCents;
    if (r.boundBy !== 'none') boundBy = r.boundBy;
  }
  const jobMinutes = verifiedJobs * COSTS.callsPerVerifiedJob * COSTS.avgCallMinutes;
  const minutes = opts.fullFairUse ? d.fairUseMinutes : jobMinutes;

  let usageUsd: number;
  if (opts.fullFairUse && verifiedJobs === 0) {
    const calls = minutes / COSTS.avgCallMinutes;
    usageUsd = minutes * COSTS.voiceCostPerMin + calls * COSTS.aiTokenCostPerCall + calls * (COSTS.smsPerVerifiedJob / COSTS.callsPerVerifiedJob) * COSTS.smsCost;
  } else {
    usageUsd = verifiedJobs * directCostPerVerifiedJob(COSTS);
  }
  const grossBilledCents = d.terms.baseFeeCents + charged;
  const feesUsd = (grossBilledCents / 100) * COSTS.paymentPercentFee + COSTS.paymentFixedFee;
  const revenueCents = Math.round(d.terms.baseFeeCents + charged * (1 - COSTS.creditRate));
  const costCents = Math.round((usageUsd + feesUsd) * 100);
  const marginCents = revenueCents - costCents;
  return {
    label: opts.label, jobs: verifiedJobs, minutes: Math.round(minutes), overFairUse: minutes > d.fairUseMinutes,
    revenueCents, costCents, marginCents, marginPct: revenueCents > 0 ? Math.round((marginCents / revenueCents) * 10000) / 100 : 0,
    jobChargesCents: charged, boundBy,
  };
}

const SCENARIOS = [
  { label: '0 jobs, full fair-use minutes (worst case)', jobs: 0, fullFairUse: true },
  { label: '4 verified jobs', jobs: 4, fullFairUse: false },
  { label: '8 verified jobs', jobs: 8, fullFairUse: false },
  { label: '20 verified jobs', jobs: 20, fullFairUse: false },
] as const;

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const table = DRAFTS.map((d) => ({ d, rows: SCENARIOS.map((s) => simulateMonth(d, s.jobs, { fullFairUse: s.fullFairUse, label: s.label })) }));

describe('Results Plan draft terms: margin scenarios (credit rate 8%)', () => {
  it('prints the margin table', () => {
    const lines: string[] = [`credit rate ${COSTS.creditRate * 100}% | payment ${COSTS.paymentPercentFee * 100}% + $${COSTS.paymentFixedFee} per invoice`];
    for (const { d, rows } of table) {
      lines.push(`\n${d.name} (base ${usd(d.terms.baseFeeCents)}, ${usd(d.terms.perJobCents)}/job, cap ${usd(d.terms.monthlyCapCents ?? 0)}, fair-use ${d.fairUseMinutes} min)`);
      for (const r of rows) {
        lines.push(`  ${r.label.padEnd(44)} revenue ${usd(r.revenueCents).padStart(8)}  cost ${usd(r.costCents).padStart(8)}  margin ${usd(r.marginCents).padStart(8)}  ${r.marginPct.toFixed(2).padStart(6)}%  jobs-charged ${usd(r.jobChargesCents)} bound:${r.boundBy}${r.overFairUse ? '  (over fair-use)' : ''}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    expect(table).toHaveLength(2);
  });

  for (const d of DRAFTS) {
    it(`${d.name}: worst-case gross margin is at least ${MIN_WORST_CASE_MARGIN_PCT}%`, () => {
      const worst = simulateMonth(d, 0, { fullFairUse: true, label: 'worst' });
      expect(Number.isFinite(worst.marginPct)).toBe(true);
      expect(worst.marginPct).toBeGreaterThanOrEqual(MIN_WORST_CASE_MARGIN_PCT);
    });
  }

  for (const d of DRAFTS) it(`${d.name}: every scenario has finite numbers and more jobs never reduce revenue`, () => {
    const rows = SCENARIOS.map((s) => simulateMonth(d, s.jobs, { fullFairUse: s.fullFairUse, label: s.label }));
    for (const r of rows) { expect(Number.isFinite(r.marginPct)).toBe(true); expect(r.revenueCents).toBeGreaterThan(0); }
    expect(rows[1].revenueCents).toBeGreaterThanOrEqual(rows[0].revenueCents);
    expect(rows[2].revenueCents).toBeGreaterThanOrEqual(rows[1].revenueCents);
    expect(rows[3].revenueCents).toBeGreaterThanOrEqual(rows[2].revenueCents);
  });

  it('Hybrid 99: the monthly cap binds at 20 verified jobs and holds job charges at the cap', () => {
    const r = simulateMonth(DRAFTS[0], 20, { label: '20' });
    expect(r.boundBy).toBe('monthly_cap');
    expect(r.jobChargesCents).toBe(24900);
  });

  it('Hybrid 249: the monthly cap does NOT bind at 20 verified jobs (20 x $12 < $549)', () => {
    const r = simulateMonth(DRAFTS[1], 20, { label: '20' });
    expect(r.boundBy).toBe('none');
    expect(r.jobChargesCents).toBe(24000);
  });

  it('drafts satisfy the application-level terms validation (hybrid => no monthly floor)', () => {
    for (const d of DRAFTS) expect(validateTerms(d.terms)).toEqual([]);
  });
});

describe('draft migration safety (static check of the SQL text, not a database run)', () => {
  const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20290303000000_results_plan_draft_pricing_terms.sql'), 'utf8');
  // Strip block + line comments so the checks look at executable SQL only.
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');

  it('is a draft-only, non-public, unapproved insert', () => {
    expect(code).toMatch(/'draft',\s*'hybrid'/);
    expect(code).toMatch(/'rp-rules-v1',\s*false,\s*NULL::uuid,\s*NULL::timestamptz/);
    expect(code).not.toMatch(/'approved'/);
    expect(code).not.toMatch(/rp_staff_approve_terms|rp_staff_publish_rules|published_at|UPDATE\s|DELETE\s/i);
    expect(code).not.toMatch(/'per_job'/); // no per_job-only row
  });

  it('is idempotent on name and inserts exactly the two hybrid drafts', () => {
    expect(code).toMatch(/ON CONFLICT \(name\) WHERE status = 'draft' DO NOTHING/);
    expect(code).toMatch(/NOT EXISTS \(SELECT 1 FROM results_plan_pricing_terms t WHERE t\.name = v\.name\)/);
    expect((code.match(/'Draft - Hybrid (99|249)'::text/g) ?? []).length).toBe(2);
  });

  it('matches the numbers asserted in this test', () => {
    for (const d of DRAFTS) {
      const t = d.terms;
      const row = new RegExp(`'${d.name}'::text,\\s*${t.baseFeeCents}::integer,\\s*${t.perJobCents}::integer,\\s*${t.monthlyCapCents}::integer,\\s*${t.guaranteeCapCents}::integer,\\s*${d.fairUseMinutes}::integer`);
      expect(code).toMatch(row);
    }
    expect(code).toMatch(/30, v\.guarantee_cap_cents, 14, v\.fair_use_minutes/);
  });
});
