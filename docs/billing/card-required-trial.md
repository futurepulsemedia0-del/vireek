# Card-required 14-day trial (60-minute cap)

## State machine (profiles.trial_state)

| Event \ State | none | trialing | ended | converted |
|---|---|---|---|---|
| trialing sub created (first) | claim_trial → granted: plan = chosen, minutes_included = 60, usage = 0, state → trialing. Denied (used / email / card): subscription canceled, no entitlements | — | denied (trial_used_at set) | denied |
| trialing sub updated (plan/date change) | legacy | plan changes, minutes stay 60 | ignored | ignored |
| status past_due | legacy | cap kept; dunning flow owns `subscription_status` | ignored | legacy |
| status active / first non-zero invoice paid | legacy | → converted: plan allowance, usage = 0, dunning cleared | ignored (unless a NEW plain paid sub: → none, plan allowance) | legacy |
| $0 invoice | legacy | ignored | ignored | legacy |
| canceled / deleted / unpaid | legacy | → ended: minutes 0, suspended | ignored | legacy |
| stale event (event.created older than the last applied) | — | ignored | ignored | ignored |

Voice gate (`fraud_inbound_allowance`): trialing → allowed while `minutes_used_this_month < minutes_included (60)` and not suspended; ended → blocked; none/converted → previous behaviour. Fraud caps (`fraud_guard_context`): trialing/ended → `PLAN_LIMITS.free`.

New signups: `profiles.minutes_included` default is now 0 → inbound voice is blocked until a trial or plan exists. Existing free accounts keep their allowance (grandfathered).

## Manual Stripe dashboard steps (TEST mode first; never edit live objects until verified)

1. Products: reuse the three existing prices (Starter / Professional / Business) or create new ones. Put each price id in the Supabase secrets `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PROFESSIONAL`, `STRIPE_PRICE_BUSINESS` (names from `planCatalog.ts`).
2. For each of the 6 Payment Links (3 plans × monthly/annual): Edit → **Add a free trial** → `trial_period_days = 14`; **Collect payment method** = always (card required, even though the first invoice is $0).
3. Webhook endpoint: subscribe to `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.payment_succeeded`, `invoice.paid`.
4. Rotate the new link URLs into `STRIPE_CHECKOUT_LINKS` in `src/lib/pricing.ts`. The app appends `?client_reference_id=<user id>` (see `getPlanHref`), which is how a Payment Link purchase is tied to the signed-in account.
5. Returning customers who already used their trial must buy through the in-app checkout (`create-checkout-session`, no trial), not a Payment Link; a second trial from a link is canceled automatically.
6. Test with Stripe test clocks: start trial → advance 14 days → success card / failing card / cancel; verify the table above.

## Known gaps / decisions
- Card fingerprint dedupe works only when Stripe returns the fingerprint on the subscription's default payment method; otherwise account + normalized-email dedupe still apply.
- Trial usage is metered by `profiles.minutes_used_this_month`. No monthly reset exists in this repo snapshot; if one runs externally, a reset mid-trial would grant extra minutes.
- `bonus_minutes` does not exist in this snapshot (nothing to ignore).
- RefundPolicy §5, Terms and FAQ say "no payment is collected during a free trial": needs legal review before launch.
- Results Plan trials (`metadata.results_plan = "1"`) are intentionally excluded from the cap.
