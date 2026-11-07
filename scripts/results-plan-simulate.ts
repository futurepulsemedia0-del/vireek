// Run: node --experimental-strip-types --no-warnings scripts/results-plan-simulate.ts '<terms-json>' [premiumTierKey]
// Example terms JSON (FAKE numbers — pass YOUR candidate prices):
//   '{"model":"hybrid","baseFeeCents":1000,"perJobCents":500,"tierPriceCents":{"install":2000},"monthlyFloorCents":0,"monthlyCapCents":null,"neverExceedFlatCents":null,"guaranteeDays":0,"guaranteeCapCents":null}'
import { simulate, SIM_DEFAULTS } from '../supabase/functions/_shared/results-plan/simulation.ts';
import { validateTerms, type PricingTerms } from '../supabase/functions/_shared/results-plan/pricing.ts';

const raw = process.argv[2];
if (!raw) { console.error('Usage: results-plan-simulate.ts <terms-json> [premiumTierKey]'); process.exit(1); }
const terms = JSON.parse(raw) as PricingTerms;
const bad = validateTerms(terms);
if (bad.length) { console.error('Invalid terms:', bad.join(', ')); process.exit(1); }
const r = simulate(terms, process.argv[3] ?? 'install', SIM_DEFAULTS);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log(`PLACEHOLDER scenario: ${SIM_DEFAULTS.accounts} accounts x ${SIM_DEFAULTS.months} months, seed ${SIM_DEFAULTS.seed}`);
console.log(`Account margin  p10=${pct(r.p10)}  p50=${pct(r.p50)}  p90=${pct(r.p90)}`);
console.log(`Loss-making accounts: ${r.lossAccounts}/${SIM_DEFAULTS.accounts}`);
console.log(`Total revenue ${(r.totalRevenueCents / 100).toFixed(0)}  cost ${(r.totalCostCents / 100).toFixed(0)}  margin ${pct(r.totalMarginPct)}`);
