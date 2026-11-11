# Pricing overhaul — release checklist

Status of this document: written against the repository snapshot `vireek-main.zip` (no `.git`, no `node_modules`).
Nothing here was executed against Stripe, Supabase or production. Items marked **UNVERIFIED** are assumptions.

## 0. What the overhaul is (single source of truth)

`supabase/functions/_shared/billing/pricingCatalog.ts` is the only place prices and allowances are defined.
Everything else derives from it (`planCatalog.ts`, `fraud/planLimits.ts`, `value-scoreboard/engine.ts`, `src/lib/pricing.ts`),
and `npm run pricing:check` + `src/lib/pricingDrift.test.ts` fail if a copy drifts.

| Plan | Monthly | Annual | Minutes | Overage | Seats | Locations |
| --- | --- | --- | --- | --- | --- | --- |
| Trial (14 days, card required) | – | – | 60 | – | – | – |
| Starter | $99 | $990 | 200 | $0.25/min | 2 | 1 |
| Professional | $249 | $2,490 | 600 | $0.25/min | 5 | 1 |
| Business | $549 | $5,490 | 1,500 | $0.25/min | 15 | 3 |
| Enterprise | from $1,799 | custom | 6,000 committed | $0.20/min | unlimited | unlimited |

Legacy (grandfathered, never sold again): Free 50 min, Starter $79/400, Professional $199/1,500, Business $399/4,000.

## 1. BLOCKERS before any customer-visible deploy

1. **Stripe Payment Links are still the OLD ones.** `STRIPE_CHECKOUT_LINKS` in `src/lib/pricing.ts` points to old-price links.
   A fail-safe (`CHECKOUT_LINKS_MATCH_CURRENT_PRICES = false`) routes paid CTAs to `/login` until step 3 below is done.
2. **Trial/card signup flow is NOT built.** The signup page still creates accounts without a card. Marketing copy now says
   "card required"; deploy it only together with the Stripe trial flow (see rollout order).
3. **Trial state machine, rollover, overage ledger and top-ups are NOT implemented** in this snapshot (no code, no migration,
   no tests; `STRIPE_PRICE_TOPUP_100` appears nowhere). Do not claim them in release notes.

## 2. Manual Stripe steps (dashboard, test mode first)

1. Create Products/Prices (monthly + yearly): Starter 9900 / 99000, Professional 24900 / 249000, Business 54900 / 549000 (USD cents).
2. Keep the OLD prices active (existing subscribers stay on them). Do NOT archive them.
3. Create new Payment Links for each plan + cycle; on each: `trial_period_days = 14`, collect a payment method at checkout
   (`payment_method_collection = always`), set metadata `plan_id` = `starter|professional|business`. Paste the URLs into
   `STRIPE_CHECKOUT_LINKS`, then set `CHECKOUT_LINKS_MATCH_CURRENT_PRICES = true` in the same commit.
4. Top-up price (100 minutes): create the one-time price and keep its id for `STRIPE_PRICE_TOPUP_100` (**no code reads it yet**).
5. Tax: decide Stripe Tax on/off, tax behaviour (`exclusive`/`inclusive`) for each new price and the registrations you hold. **UNVERIFIED — owner decision.**
6. Webhook endpoint must still deliver `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_*`.

## 3. Environment variables (names only; set in Supabase secrets, never commit values)

- `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PROFESSIONAL`, `STRIPE_PRICE_BUSINESS` → point to the NEW monthly price ids.
- `STRIPE_PRICE_STARTER_LEGACY`, `STRIPE_PRICE_PROFESSIONAL_LEGACY`, `STRIPE_PRICE_BUSINESS_LEGACY` → the OLD price ids
  (set these BEFORE repointing the three above, so old subscriptions keep resolving as legacy).
- `STRIPE_PRICE_TOPUP_100` → reserved; not consumed by any code yet.
- Existing: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, site URL vars (unchanged).

## 4. Rollout order

1. Deploy backend only: `pricingCatalog.ts`, `planCatalog.ts`, `stripe-webhook`, `manage-subscription-plan` (no customer-visible change; fixes the grandfathering hazard).
2. Set the `*_LEGACY` secrets, then repoint `STRIPE_PRICE_*` to the new prices.
3. Create Payment Links (step 2.3), update `STRIPE_CHECKOUT_LINKS`, flip `CHECKOUT_LINKS_MATCH_CURRENT_PRICES`.
4. Build and ship the card-collecting trial signup (not in this change), then deploy the website copy (pricing page, FAQ, blog, `llms-full.txt`, JSON-LD).
5. Run `npm run knowledge:build` (needs esbuild + network) and commit the regenerated knowledge/eval artifacts; refresh non-English locales.
6. Owner decisions on legal text (Terms §plans/§trial, Refund Policy §5, SLA) and the signup/onboarding copy.

## 5. Rollback

- Backend: redeploy the previous `stripe-webhook` / `planCatalog.ts`; note the previous webhook file did not parse (duplicate `catch`), so roll back to the FIXED webhook with the old numbers rather than the original file.
- Pricing: set `CHECKOUT_LINKS_MATCH_CURRENT_PRICES = false` (instantly stops selling via Payment Links) and revert the copy commit.
- Stripe: do not delete prices; deactivate the new Payment Links. Existing legacy subscriptions are untouched throughout.
- No database migration was added, so there is nothing to roll back in Postgres.

## 6. Verification map

| Check | Evidence |
| --- | --- |
| All price/allowance copies agree | `npm run pricing:check` (drift + stale-claim scan) and `src/lib/pricingDrift.test.ts` |
| Old Starter keeps stored 400 min | `planCatalog.test.ts` › grandfathering (no write on same-plan / legacy-price events) |
| Emergency never restricted by cost guardrail | `costGuardrail.test.ts` (new) |
| Fraud guard emergency path | existing code in `fraud/guard.ts`; **no unit test exists** (needs DB harness) |
| Full lint / typecheck / vitest / e2e | **NOT RUN** (no `node_modules`, no network in the authoring environment) |

## 7. UNVERIFIED rates and assumptions

Cost-rate ceilings in `fraud/planLimits.ts` (pessimistic estimates, never reconciled with invoices):
`CALL_CENTS_PER_MIN` (domestic 12 / standard 30 / extended 60 / high_cost 300), `SMS_CENTS` (2 / 8 / 15 / 50),
`NUMBER_RENTAL_CENTS_PER_MONTH = 115`, `VOICE_CLONE_CENTS = 500`, `DISPUTE_FEE_CENTS = 1500`,
and `DEFAULT_VOICE_COST_PER_MIN = 0.12` in `src/lib/staffUsage.ts`. Calibrate against Twilio / Vapi / ElevenLabs / Stripe bills.
Margin sanity (using those unverified ceilings): 25¢ overage vs 12¢ domestic voice ceiling; Enterprise 20¢ vs 12¢; a fully used 60-min trial costs up to ~$7.20.

Assumptions made while implementing (change `pricingCatalog.ts` if wrong):
- Annual price = 10 × monthly (the site's existing "2 months free" convention).
- Seats and locations unchanged (2/5/15/unlimited seats; 1/1/3/unlimited locations). Numbers, SMS caps, retention unchanged (`PLAN_LIMITS` untouched).
- Trial minutes (60) apply to every plan; trial is a billing state, not a plan id.
- The retired `free` plan id stays valid in types/limits for existing accounts.
- Enterprise: $1,799 is a "from" price, 6,000 committed minutes, $0.20 overage.
- Partner commissions (`supabase/migrations/20261203000000_partner_portal.sql`) still compute MRR from the OLD prices (7900/19900/39900): **needs a decision** (use Stripe amount or a pricing-version marker).
- UI/staff screens show the new overage rate for grandfathered accounts; Stripe billing governs real charges. A `profiles.pricing_version` marker would fix the display mismatch. **Needs a decision.**
