# Pay by Bank

ACH debit for invoice pay links, membership sign-ups and payment plans — with bank verification, lower-fee routing suggestions,
failure/return handling and reconciliation into the books. Provider: **Stripe** (Connect, destination charges).
RTP and FedNow are modelled in the provider-capability registry but **Stripe does not offer them**, so they are off until a provider adapter exists.

## Architecture

| Piece | Where |
|---|---|
| Schema, state machine, accounting, RPCs | `supabase/migrations/20271115000000_pay_by_bank.sql` |
| Pure logic (eligibility, routing, fees, failure/return classification, settlement dates) | `supabase/functions/_shared/bankPayments/logic.ts` |
| Event handler (injected deps, unit-tested) | `.../bankPayments/handler.ts` |
| Runtime wiring (`processBankStripeEvent`) | `.../bankPayments/runtime.ts` |
| Reconcile cron | `supabase/functions/pay-by-bank-reconcile` |
| Capability check / enable (owner-facing) | `supabase/functions/pay-by-bank-actions` |
| Dashboard | `/dashboard/pay-by-bank` (`src/pages/PayByBankPage.tsx`, `src/lib/payByBank.ts`) |

### Lifecycle
`verification_required → processing → succeeded` or `→ failed`; after success a bank return/dispute moves it to `returned` / `disputed`.
Events are idempotent by Stripe event id and monotonic (an old event never moves a payment backwards).

- **Pay link / invoice:** Stripe Payment Element offers "US bank account" (instant verification via Financial Connections, micro-deposit fallback).
  While in transit the request has `settlement_status = 'processing'`, reminders are suppressed, and the invoice is finalized only on `succeeded`.
- **Payment plans:** deposit by bank is supported; a plan can be switched to bank rail for installments. A debit in flight marks the
  installment `pending_settlement` (never re-charged); `insufficient_funds` is the only failure retried, others notify the customer.
- **Memberships:** first payment and pay-link renewals by bank work (optional provisional access up to a limit while settling).
  **Automatic off-session renewal by bank is intentionally not supported** — renewals stay on the saved card.
- **Accounting:** success posts Dr `1050 Bank payments clearing` / Cr `1100 Accounts receivable`; a return/dispute posts the reversal.
  No matching invoice → `unlinked`; link it from the dashboard. Categorize Stripe payouts against `1050` to clear it.
- **Lower-fee routing:** `routing_mode = prefer` shows bank first; the page lists customers whose recent card payments would have been cheaper by bank.
  Fees are **estimates** (card 2.9% + 30¢; ACH 0.8% capped at $5) — edit `FEE_SCHEDULE` in `logic.ts` and `bank_fee_estimate()` together if your Stripe pricing differs.

## Credentials / environment (Supabase function secrets)

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | existing platform key |
| `STRIPE_ACH_DEBIT_ENABLED=true` | **master switch**; unset = nothing changes for anyone |
| `STRIPE_PAYMENT_WEBHOOK_SECRET`, `STRIPE_PLAN_WEBHOOK_SECRET`, `STRIPE_DISPUTE_WEBHOOK_SECRET` | existing webhook signing secrets |
| `PAY_BY_BANK_CRON_SECRET` | random string; cron sends it as header `X-Cron-Secret` |
| `SITE_URL` | existing; used in customer links |

## Stripe setup

1. Dashboard → Settings → Payment methods → enable **ACH Direct Debit** (platform and Connect defaults).
2. Each connected account needs capability `us_bank_account_ach_payments` — contractors click **Enable bank debits** on the Pay by Bank page.
3. Add these events to **each** existing webhook endpoint (payment, plan, dispute):
   `payment_intent.processing`, `payment_intent.requires_action`, `payment_intent.payment_failed`, `payment_intent.succeeded`,
   `payment_intent.canceled`, `payment_method.automatically_updated`, `charge.dispute.created`, `charge.dispute.funds_withdrawn`.

## Cron

Schedule `pay-by-bank-reconcile` every 30 minutes (SQL example in the migration header). It polls payments stuck in flight > 7 days
and retries ledger posting that failed. Header: `X-Cron-Secret: $PAY_BY_BANK_CRON_SECRET`.

## Limitations

- ACH: 1–4 business days; **full refunds only**; returns arrive as disputes up to 60 days.
- Membership auto-renew by bank is not supported (card only).
- RTP / FedNow / Instant Bank Payments via Stripe are unavailable; only the adapter slots exist.
- Processor fees are not posted to the ledger (estimates are shown for guidance only).
- Debit authorization relies on Stripe's mandate collected in the Payment Element plus existing plan reminders.

## Testing

- Unit: `vitest run` (`logic.test.ts`, `handler.test.ts`, `src/lib/payByBank.test.ts`). DB: `supabase test db` (`pay_by_bank.test.sql`).
- Stripe test mode bank: use the test institution in Financial Connections; micro-deposit amounts `32` and `45` verify, descriptor `SM11AA` verifies instantly,
  and test routing/account numbers per the Stripe ACH docs simulate `insufficient_funds`, `account_closed` and disputes.

## Adding another provider (RTP/FedNow)

Add a capabilities entry in `logic.ts` (`selectable: true`), implement the same event → `bank_attempt_apply` mapping in a new handler
(rail `rtp` / `fednow`, `provider` column), and add its fee row in `FEE_SCHEDULE` and `bank_fee_estimate()`. The state machine and ledger are provider-neutral.
