#!/usr/bin/env node
// scripts/pricing-simulator.mjs
//
// Given a usage profile, prints OUR gross margin on every plan (catalog prices) - and what the customer would pay.
// Run:  node --experimental-strip-types --no-warnings scripts/pricing-simulator.mjs [options]
//   --minutes <n>        billable call minutes per month               (default: sweeps 50..8000)
//   --cost-per-min <usd> OUR blended variable cost per call minute      (default 0.12 = the code's own domestic ceiling,
//                        src/lib/staffUsage.ts DEFAULT_VOICE_COST_PER_MIN; REPLACE with your measured value from /staff/margins)
//   --fixed <usd>        fixed monthly cost per tenant (number rental etc.)  (default 1.15 = NUMBER_RENTAL_CENTS_PER_MONTH)
//   --card-pct <pct>     payment processing %                           (default 2.9  - ASSUMPTION, confirm on your Stripe account)
//   --card-fixed <usd>   payment processing fixed fee                   (default 0.30 - ASSUMPTION)
//   --json               machine-readable output
// Nothing here is measured data: every default above is labelled and overridable. Prices come from pricingCatalog.ts.

import { CATALOG_PLANS } from "../supabase/functions/_shared/billing/pricingCatalog.ts";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt; };
const flag = (name) => args.includes(`--${name}`);

const costPerMin = opt("cost-per-min", 0.12);
const fixed = opt("fixed", 1.15);
const cardPct = opt("card-pct", 2.9) / 100;
const cardFixed = opt("card-fixed", 0.3);
for (const [k, v] of Object.entries({ costPerMin, fixed, cardPct, cardFixed })) {
  if (!Number.isFinite(v) || v < 0) { console.error(`invalid --${k}`); process.exit(2); }
}
const minutesArg = args.includes("--minutes") ? opt("minutes", NaN) : null;
if (minutesArg !== null && (!Number.isFinite(minutesArg) || minutesArg < 0)) { console.error("invalid --minutes"); process.exit(2); }

const plans = CATALOG_PLANS.filter((p) => !p.quoted); // Enterprise is quoted per contract: not simulated
export function simulate(minutes) {
  return plans.map((p) => {
    const overMin = Math.max(0, Math.ceil(minutes - p.minutesIncluded));
    const revenue = p.monthlyCents / 100 + (overMin * p.overageCentsPerMin) / 100;
    const cost = minutes * costPerMin + fixed + revenue * cardPct + cardFixed;
    const margin = revenue - cost;
    // minutes at which margin hits zero on the FLAT part (no overage): (price*(1-pct) - fixed - cardFixed) / costPerMin
    const breakEvenMin = costPerMin > 0 ? Math.floor((p.monthlyCents / 100 * (1 - cardPct) - fixed - cardFixed) / costPerMin) : null;
    return { plan: p.id, minutes, included: p.minutesIncluded, overageMinutes: overMin, customerPays: +revenue.toFixed(2), ourCost: +cost.toFixed(2),
      margin: +margin.toFixed(2), marginPct: revenue > 0 ? +((margin / revenue) * 100).toFixed(1) : null, breakEvenMinutesOnBasePrice: breakEvenMin,
      verdict: margin < 0 ? "LOSS" : revenue > 0 && margin / revenue < 0.3 ? "THIN (<30%)" : "ok" };
  });
}

const profiles = minutesArg !== null ? [minutesArg] : [50, 200, 400, 600, 1000, 1500, 2500, 4000, 8000];
const rows = profiles.flatMap(simulate);

if (flag("json")) { console.log(JSON.stringify({ assumptions: { costPerMin, fixed, cardPct, cardFixed }, rows }, null, 2)); process.exit(0); }

console.log(`Assumptions: cost/min $${costPerMin} | fixed $${fixed}/tenant | card ${(cardPct * 100).toFixed(1)}% + $${cardFixed} (all overridable; none are measured here)\n`);
const pad = (v, n) => String(v).padEnd(n);
console.log(pad("minutes", 8) + pad("plan", 14) + pad("pays $", 10) + pad("our cost $", 12) + pad("margin $", 10) + pad("margin %", 9) + "verdict");
for (const r of rows) console.log(pad(r.minutes, 8) + pad(r.plan, 14) + pad(r.customerPays, 10) + pad(r.ourCost, 12) + pad(r.margin, 10) + pad(r.marginPct ?? "n/a", 9) + r.verdict);
console.log("\nBreak-even minutes on the base price (before overage): " + plans.map((p) => `${p.id}=${simulate(0).find((x) => x.plan === p.id).breakEvenMinutesOnBasePrice}`).join(", "));
const losses = rows.filter((r) => r.verdict === "LOSS");
if (losses.length) console.log(`\nWARNING: ${losses.length} profile(s) lose money - consider overage rate / allowance changes.`);
