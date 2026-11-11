#!/usr/bin/env node
// scripts/check-pricing-drift.mjs
//
//   npm run pricing:check
//
// 1. Imports every module that carries a price / allowance and runs collectPricingDrift()
//    (needs Node >= 22.6: it strips TypeScript types natively; no install, no network).
// 2. Greps customer-facing sources for stale pre-overhaul claims (STALE_CLAIM_PATTERNS).
//    Hits are only allowed in ALLOWLIST below, each with a reason. Anything else fails the run.
//
// Exit code 1 on any drift or un-allowlisted stale claim.

import { register } from 'node:module';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// src/ files import siblings without a ".ts" extension (Vite style); Node needs it. Tiny resolver hook.
register(
  'data:text/javascript,' +
    encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(spec, ctx, next) {
  if ((spec.startsWith('.') || spec.startsWith('/')) && !/\\.[a-z]+$/i.test(spec) && ctx.parentURL) {
    const base = new URL(spec, ctx.parentURL);
    for (const ext of ['.ts', '/index.ts']) {
      const u = new URL(base.href + ext);
      if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
    }
  }
  return next(spec, ctx);
}`),
  pathToFileURL(ROOT + '/'),
);

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const problems = [];

// ---------- 1. drift ----------
const [{ collectPricingDrift, STALE_CLAIM_PATTERNS }, planCatalog, planLimits, scoreboard, pricing] = await Promise.all([
  imp('supabase/functions/_shared/billing/pricingInvariants.ts'),
  imp('supabase/functions/_shared/billing/planCatalog.ts'),
  imp('supabase/functions/_shared/fraud/planLimits.ts'),
  imp('supabase/functions/_shared/value-scoreboard/engine.ts'),
  imp('src/lib/pricing.ts'),
]);
const drift = collectPricingDrift({
  purchasable: planCatalog.PURCHASABLE_PLANS,
  freeMinutes: planCatalog.FREE_MINUTES_INCLUDED,
  trialMinutes: planCatalog.TRIAL_MINUTES,
  fraudFreeMinutes: planLimits.FREE_MINUTES,
  planPriceCents: planLimits.PLAN_PRICE_CENTS,
  scoreboardMonthlyCents: scoreboard.PLAN_MONTHLY_CENTS,
  displayPlans: pricing.PRICING_PLANS,
});
for (const d of drift) problems.push(`DRIFT  ${d}`);
console.log(drift.length === 0 ? 'drift check: PASSED (all copies agree with pricingCatalog.ts)' : `drift check: FAILED (${drift.length})`);

// ---------- 2. stale customer-facing claims ----------
const SCAN = ['src', 'public', 'supabase/functions/_shared/ai-core', 'e2e', 'index.html', 'knowledge', 'eval'];
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'android', 'ios']);
const EXT = /\.(ts|tsx|mjs|md|txt|html|json)$/;
/** path (prefix) -> why a stale-looking string is allowed to stay. "DECISION" = needs the owner. */
const ALLOWLIST = [
  [/\.test\.(ts|tsx)$/, 'tests that format arbitrary invoice/membership amounts, not plan prices'],
  [/^src\/lib\/(conversationIntel|homeCapitalUnderwriting|lifetimeServicePlan|propertyIntelligence|directMail)/, 'unrelated data ($199/yr upsell fixtures, year 1990)'],
  [/^src\/components\/directmail\//, 'unrelated sample offer copy'],
  [/^eval\/vertical-ai\//, 'unrelated job-price eval fixtures (drain cleaning quote), not plan prices'],
  [/^src\/components\/sections\/(TermsContent|RefundPolicyContent|SlaContent)\.tsx$/, 'DECISION: legal text; changing a contract needs owner/lawyer sign-off and a notice to existing customers'],
  [/^src\/pages\/(SignupPage|OnboardingGuidePage)\.tsx$/, 'DECISION: describes the signup flow, which still creates accounts without a card until the Stripe trial flow ships'],
  [/^src\/lib\/locations\.ts$/, 'DECISION: SEO template copy mentioning a trial; review wording'],
  [/^(knowledge\/(site-chunks|coverage)\.generated|eval\/site-assistant\.generated|supabase\/functions\/_shared\/ai-core\/coreFacts\.generated)/, 'GENERATED: regenerate with `npm run knowledge:build` (needs esbuild + network)'],
  [/^src\/locales\/(?!en\/)/, 'NON-ENGLISH locales: translations still carry the old trial wording; refresh via the i18n pipeline (`npm run i18n:freshness`)'],
];

function* walk(p) {
  const abs = path.join(ROOT, p);
  if (!existsSync(abs)) return;
  const st = statSync(abs);
  if (st.isFile()) { yield p; return; }
  for (const name of readdirSync(abs)) {
    if (SKIP_DIR.has(name)) continue;
    yield* walk(path.join(p, name));
  }
}

let allowed = 0;
const allowedBy = new Map();
for (const root of SCAN) {
  for (const rel of walk(root)) {
    if (!EXT.test(rel) || /package-lock|translation-state/.test(rel)) continue;
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      for (const { re, why } of STALE_CLAIM_PATTERNS) {
        if (!re.test(line)) continue;
        const rule = ALLOWLIST.find(([pat]) => pat.test(rel));
        if (rule) { allowed++; allowedBy.set(rel, (allowedBy.get(rel) ?? 0) + 1); continue; }
        problems.push(`STALE  ${rel}:${idx + 1}  [${why}]  ${line.trim().slice(0, 110)}`);
      }
    });
  }
}
console.log(`stale-claim scan: ${problems.filter((p) => p.startsWith('STALE')).length} un-allowlisted hit(s), ${allowed} allowlisted`);

if (process.argv.includes('--verbose')) for (const [f, n] of [...allowedBy].sort()) console.log(`  allowlisted ${n}x  ${f}`);
if (problems.length) {
  console.error('\n' + problems.join('\n'));
  process.exit(1);
}
console.log('pricing:check PASSED');
