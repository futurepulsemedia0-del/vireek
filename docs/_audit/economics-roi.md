# Audit: unit economics, customer ROI, pricing integrity

## Verified (read in code)
- Cost ledger, per-call cost capture, staff margin dashboard, cost guardrail (emergency never restricted), executive monthly report (idempotent per user+period, per-recipient delivery unique) already existed.
- `stripe-webhook/index.ts` in the supplied ZIP had a duplicated `} catch (err) {` (syntax error). Fixed.
- `scripts/check-pricing-drift.mjs` imported a missing `pricingInvariants.ts`. Restored.
- `check-usage-alert` dedupe matched a phrase absent from every title (duplicate insert per run) and had no auth. Fixed.
- `docs/claims-register.json` is an evidence register for risky claims, NOT a pricing register. Truth source used: `pricingCatalog.ts`.

## Changed
New: migration `20290304000000_tenant_margin_alerts_and_ai_roi.sql`, `economics/{tenantMargin,aiRoi}.ts(+tests)`, `billing/{usageCaps,pricingInvariants}.ts(+test)`, `src/lib/aiRoi.ts`, `src/components/economics/AiRoiCard.tsx`, `src/lib/pricingDrift.test.ts`, `scripts/pricing-simulator.mjs`, `supabase/tests/database/tenant_margin_ai_roi.test.sql`.
Modified: planCatalog, planLimits, value-scoreboard/engine, stripe-webhook, pricing.ts, marketing copy files, economics-sweep, check-usage-alert, executive-report (types/render/run), DashboardPage, plus test expectations (planChange, staffUsage, planLimits, valueScoreboard).

## Verification
PASSED: `pricing:check`; new + related unit tests via a local vitest SHIM; TS syntax parse.
BLOCKED: tsc, eslint, real vitest, build (no node_modules/network). NOT RUN: pgTAP, migration SQL, e2e, valueScoreboard/claims tests (alias).

## NOT done
Stripe metered overage wiring; concurrency/abuse tests (existing code only observed); PDF ROI section; staff per-tenant margin panel; AiRoiCard UI test.

## Residual risks
Revenue in margin alerts is a LIST-PRICE ESTIMATE. AI-booking attribution counts only jobs with `voice_idempotency_key` (understates). Trial detection relies on `profiles.trial_state`.

## Needs human
1. Create new Stripe prices; set `STRIPE_PRICE_*` and `*_LEGACY` secrets BEFORE deploying; replace Payment Links then set `CHECKOUT_LINKS_MATCH_CURRENT_PRICES = true`.
2. Configure card-required trial in Stripe; review RefundPolicy §5 / Terms.
3. Ensure the scheduler calls `check-usage-alert` with `Authorization: Bearer <service role>`.
4. Apply migration; run `supabase test db`, `tsc`, vitest, lint.
5. Pricing decisions: uniform 25c overage makes Starter cheaper than Business at very high usage; set real $/min from /staff/margins and rerun the simulator.
6. Unrelated: `claims:check` fails on "End-to-End Encryption" claim.
