# Plan-selection step (`/onboarding/plan`)

Flow: sign up -> verify email (OTP) -> **`/onboarding/plan`** -> Stripe Checkout -> existing onboarding (`/dashboard` -> qualification -> onboarding).

## How it fits the existing code

| Concern | Where it lives | Notes |
|---|---|---|
| Plan data | `PRICING_PLANS` (`src/lib/pricing.ts`) | Cards, comparison and the right-size helper all derive from it. `free` (legacy no-card teaser) is not offered here. |
| Trial | `trialLifecycle.ts` (`TRIAL_DAYS`, `claim_trial`) | Unchanged. Card-required 14-day trial remains the default policy. |
| Entitlements | `stripe-webhook` -> `profiles` | Unchanged. The plan step and `create-checkout-session` (onboarding branch) never write plan / minutes / status / trial fields. |
| Intent | `plan_onboarding` (new) | plan, billing, source, step, answers, reminder consent. Written only through RPCs / the service role. |
| Policy | `plan_onboarding_config` (new, one row) | `trial_mode`, `allow_skip`, `reminder_delay_hours`, `gate_starts_at`. |
| Gate | `PlanStepGate` around `/dashboard` and `/onboarding/first-call` | Owners without a subscription, accounts created after `gate_starts_at`. Fails open. |

## Policy (config, not code)

```sql
-- trial_mode: card_required (today's behaviour) | no_card | none
update public.plan_onboarding_config set trial_mode = 'card_required', allow_skip = true, reminder_delay_hours = 24 where id;
```

* `card_required`: Checkout collects a card; first invoice is $0 (same as the Payment Links).
* `no_card`: Checkout uses `payment_method_collection: if_required` and `trial_settings.end_behavior.missing_payment_method = cancel`.
  The card-fingerprint dedupe cannot apply without a card (account + normalised e-mail dedupe still do). **[VERIFY]** with the fraud owner before enabling.
* `none`: no trial from this step; the first payment happens at checkout.
* A person who already used a trial (account or normalised e-mail) is shown, and sent to Stripe with, **no trial**.
* `allow_skip = true`: the dashboard opens, voice stays off (new accounts have `minutes_included = 0`), banner + optional reminder.
* `gate_starts_at` defaults to the time the migration first ran: older accounts are never pushed into the step.

## Setup you must do (Stripe / env)

1. Run `supabase/migrations/20290307000000_plan_onboarding.sql`.
2. Existing secrets are reused: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_STARTER|PROFESSIONAL|BUSINESS`, `SITE_URL`, optional `STRIPE_AUTOMATIC_TAX`.
3. **Annual billing from this step needs new secrets** (none exist today; the old checkout was monthly only):
   `STRIPE_PRICE_STARTER_ANNUAL`, `STRIPE_PRICE_PROFESSIONAL_ANNUAL`, `STRIPE_PRICE_BUSINESS_ANNUAL` (the annual Stripe prices behind the existing annual Payment Links).
   Without them the annual choice returns a clear "annual billing isn't available yet" message; it never charges monthly instead.
   The webhook resolves the plan of an annual subscription from `subscription_data.metadata.plan_id`, which the onboarding checkout sets.
4. Stripe webhook endpoint events (already required by the trial doc): `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_succeeded`.
5. Reminder email: `supabase functions deploy plan-resume-reminder --no-verify-jwt`, secrets `CRON_SECRET`, `RESEND_API_KEY`; schedule hourly:
   `POST https://<project>.functions.supabase.co/plan-resume-reminder` with header `X-Cron-Secret`.
6. Redeploy `create-checkout-session`.
7. **[VERIFY]** In the Stripe dashboard set the Terms of Service URL (Settings -> Public details) if you also want Stripe's own consent checkbox. This step does not enable `consent_collection`.

## Abuse / quality

* One trial per account, normalised e-mail and card fingerprint (existing `claim_trial`, enforced by the webhook) plus the same account/e-mail check before checkout so the page never promises a trial the webhook would cancel.
* Rate limit: 8 checkout attempts per user per minute (`edge_rate_limit_hit`). Promo codes are validated server-side (`^[A-Za-z0-9_-]{3,40}$`, active Stripe promotion code).
* Logs carry plan/billing/booleans only: no e-mail, name, card or user data.
* **Not implemented (gap):** phone-number and e-mail-domain based trial limits. No verified phone exists at this point of sign-up, and blocking whole e-mail domains (e.g. gmail.com) would block real customers. Domain-level limits belong in the existing fraud layer if you want them.

## Compliance wording

Every string below is plain factual text derived from what the code does. **[COUNSEL]** please review before launch:

* `terms.*` and `plans.taxNote` in `src/locales/*/planStep.json` (renewal, cancellation, tax statement, "By continuing you agree to...").
* `renewalDisclosure()` in `supabase/functions/_shared/billing/planOnboardingCheckout.ts` (text shown on Stripe's pay page).
* `reminder.*` (opt-in, unticked by default) and the e-mail in `planResumeEmail.ts`; whether a pre-ticked box would be acceptable in the markets you serve.
* Existing gap from `card-required-trial.md`: RefundPolicy §5 / Terms / FAQ still say "no payment is collected during a free trial". The plan step states the actual card-required behaviour, so those pages must be reconciled.
* **[VERIFY]** `ASSUMED_MINUTES_PER_CALL = 3` (same default as the value scoreboard) and "seats = technicians + 1" in the right-size helper are estimates, shown to the user as such.

## Rollback

See the header of the migration. Remove `PlanStepGate`, `PlanResumeBanner`, the `/onboarding/plan` route and the three one-line edits (SignupPage, PricingPage, DashboardNav); `create-checkout-session` keeps working for BillingPage because the new code is behind `source: "onboarding"`.

## Known pre-existing issue (not changed)

`create-checkout-session`'s *switch plan* path (existing subscribers from BillingPage) writes `profiles.plan` directly. The webhook would sync it anyway; consider removing that write so entitlements are webhook-only everywhere. The onboarding path never uses it.
