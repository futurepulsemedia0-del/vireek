# Overage Billing and Top-up Packs (100 minutes) — Runbook

> Run this in **Stripe Test mode only**. Do not set `paid_overage_policy` to `bill` until section 4 has fully passed.

## 1. Components
| Area | File |
|---|---|
| Migrations (usage ledger, rollover, top-ups, billing-column protection, refund reversal, plan snapshot) | `supabase/migrations/20290303000000_usage_ledger_overage_topups.sql`, `supabase/migrations/20290303000100_topup_reversal_and_plan_snapshot.sql` |
| Overage logic | `supabase/functions/_shared/billing/overage.ts` |
| Top-up logic | `supabase/functions/_shared/billing/topup.ts` |
| Rates | `planCatalog.ts` (`OVERAGE_CENTS_PER_MINUTE`) — must match `src/lib/pricing.ts` (a test enforces this) |
| Webhook | `stripe-webhook` (`invoice.created`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`) |
| Checkout | `manage-subscription-plan` (`topup_state`, `topup_checkout`) |

## 2. Setup
1. Run the migrations (both `20290303000000_*` and `20290303000100_*`): `supabase db push`.
2. In Stripe (Test mode) create a one-time **$29** Price (USD), then run:
   `supabase secrets set STRIPE_PRICE_TOPUP_100=price_xxx`
3. Add these events to the Webhook Endpoint: `invoice.created`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created` (the rest already exist).
4. Deploy: `supabase functions deploy stripe-webhook --no-verify-jwt`, then `supabase functions deploy manage-subscription-plan` and `supabase functions deploy fraud-admin`.

## 3. Top-up test (Test mode)
1. Sign in as an owner with an active subscription and open `/dashboard/usage`. The "Buy 100 minutes" button must be visible.
2. Pay with card `4242 4242 4242 4242`.
3. Check: `select bonus_minutes from profiles where id = '<user>';` → increased by 100.
4. Replay: in Stripe → Developers → Events, **Resend** the `checkout.session.completed` event **3 times**.
   Expected: `select count(*), sum(minutes) from topup_credits where stripe_session_id = 'cs_test_...';` → `1 | 100`, and `bonus_minutes` increased only once.
5. Rejections: `select * from topup_credits where status = 'rejected';` (needs manual review/refund).

## 4. Overage test (Test mode) — prerequisite for enabling `bill`
1. Create a Test Clock, attach a customer and a subscription (e.g. Starter) to it, and link that customer to the profile via `profiles.stripe_customer_id`.
2. Simulate usage: insert `calls` rows with `usage_billed_seconds` whose total exceeds `minutes_included` (e.g. 430 minutes for Starter).
3. Policy: as staff, call `fraud-admin` (`action: kill_switch`, `paid_overage_policy: "bill"`, `reason: "test-mode verification"`).
4. Advance the Test Clock past the end of the period. Stripe sends `invoice.created` (draft, `subscription_cycle`).
5. Expected results:
   - Exactly **one** invoice item on that draft: `Voice overage: 30 min x $0.20` = $6.00.
   - `select billing_status, overage_minutes, amount_cents, stripe_invoice_item_id from usage_periods order by created_at desc limit 1;` → `billed | 30 | 600 | ii_...`
   - `profiles.minutes_used_this_month` starts from zero for the new period.
6. Replay: **Resend** the same `invoice.created` 3 times → still **one** invoice item and one ledger row.
7. Zero overage → no item is created (`skipped_zero`). Policy `allow` → `skipped_policy`.
8. Only after all of the above succeed may `bill` be considered for Live, as a deliberate decision and after reviewing the risks in section 6.

## 5. Reconciliation (staff)
```sql
select * from usage_overage_reconciliation where reconciliation_state <> 'ok' order by created_at desc;
```
- `needs_action`: the ledger row is `failed`/`needs_review` (e.g. the invoice was finalized before processing). If needed, add the charge manually to the next invoice in Stripe or issue a Credit Note.
- `stuck_pending`: pending for more than 2 hours; Resend the webhook in Stripe.
- `uncollected_policy_allow`: there was overage but the policy was `allow` (expected until `bill` is enabled).
- Compare with Stripe: `stripe_invoice_item_id` and `amount_cents` must match the invoice item.

## 6. Known risks and limitations
- **Scheduled downgrade at the renewal boundary** (resolved): the closing period is priced on the higher-ranked of `profiles.usage_period_plan` and `profiles.plan`. Verify it again with a Test Clock: Professional with 1,600 minutes used and a scheduled downgrade to Starter → expect `plan_id = professional`, `included_minutes = 1500`, overage = 100 minutes × 15 cents.
- **Refund/dispute of a top-up pack** (resolved): `charge.refunded` and `charge.dispute.created` deduct from `bonus_minutes` (proportional to the amount, idempotent). If the customer already spent the minutes, the balance floors at zero and the remainder is recorded in `topup_credits.clawback_shortfall_minutes`: `select * from topup_credits where clawback_shortfall_minutes > 0;`. If you win a dispute, the minutes are not restored automatically (do it manually).
- Tax on invoice items: if Stripe Tax is enabled, verify `tax_behavior`/`tax_code` in Test mode.
- `minutes_used_this_month` was never reset before these migrations; the first rollover takes the minimum of (counter, sum of the period's calls) so customers are not overcharged.
- The top-up price ($29 / 100 minutes = $0.29/minute) is higher than the overage rate on every plan; the pricing decision is yours.
