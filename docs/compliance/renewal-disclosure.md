# Own-subscription renewal disclosure — audit and gap list

Scope: Vireek's OWN subscription (Starter / Professional / Business sold to customers), not subscriptions our customers sell to their clients.
Status of this file: engineering audit of the repository snapshot. It is not legal advice and makes no claim that any flow is compliant.
Markers: **[COUNSEL]** needs a lawyer's decision. **[VERIFY]** a fact that must be confirmed outside the repo (Stripe dashboard, production data).

## 1. What was audited

| Surface | Where |
|---|---|
| In-app checkout / plan change | `src/pages/BillingPage.tsx`, `supabase/functions/create-checkout-session/index.ts` |
| Payment Links (pricing page) | `src/lib/pricing.ts` (`STRIPE_CHECKOUT_LINKS`), `docs/billing/card-required-trial.md` |
| Trial | `stripe-webhook` (`customer.subscription.trial_will_end`), `_shared/billing/trialEmail.ts` |
| Pre-renewal reminders | `send-billing-notices`, `_shared/billing/notices/*` |
| Cancellation | `src/pages/CancelSubscriptionPage.tsx`, `manage-subscription-cancellation`, `_shared/billing/cancellationLogic.ts` |
| Emails | `_shared/billing/notices/compose.ts`, `_shared/i18n/templates.ts` |

## 2. Findings and what was done

| # | Requirement area | Finding before this change | Status |
|---|---|---|---|
| 1 | Renewal terms at purchase (in-app) | Plan picker showed "$X/mo" only. No statement of auto-renewal, cadence, or how to cancel. | **Fixed (UI):** `RenewalDisclosure` under the plan cards (namespace `renewalDisclosure`, en + fa, RTL-safe). |
| 2 | Renewal terms on the Stripe payment page | `create-checkout-session` sent no custom text. | **Fixed:** `custom_text.submit.message` next to the pay button. Wording **[COUNSEL]**. |
| 3 | Renewal terms on Payment Links | Links are configured in the Stripe dashboard, not in code. | **Open [VERIFY]:** add equivalent custom text to all 6 links. Also check the pricing page itself says "renews automatically". |
| 4 | Written confirmation after purchase | None. Only a trial-ending email existed. | **Fixed:** `subscription_started` email (price, interval, auto-renewal date, trial first-charge date, cancel link), 9 languages, sent once per subscription from `checkout.session.completed`. Sufficiency **[COUNSEL]**. |
| 5 | Pre-renewal reminder | Annual plans only, once, within 30 days (`RENEWAL_NOTICE_DAYS`). Trial: one email ~3 days before the end (Stripe event), English only, not in `billing_notice_log`. No reminder for monthly plans. | **Partly fixed:** reminder now has a direct cancel link (html + text). Monthly reminders and the 30-day / 3-day timings are **[COUNSEL]** (the code comment already marks 30 days as unconfirmed). The 1-day trial notice (`trialNoticeDue`) is still not wired to a sender. |
| 6 | Cancellation as easy as sign-up | Cancel needed a mandatory reason (UI **and** server rejected a missing reason), 3 steps, and typing the phrase "cancel subscription". | **Fixed:** reason optional end to end (`parseRequest`, page, Stripe feedback), "Skip and cancel now" button, one-click confirm, save offers remain optional. Whether a save-offer step at all is acceptable **[COUNSEL]**. |
| 7 | Cancel entry point | Link on `/dashboard/billing`, owners with a Stripe customer only. Team members who are not owner cannot cancel. | Open **[COUNSEL]**: owner-only is a product rule; confirm it is disclosed. Phone/e-mail cancellation path is **[VERIFY]** (support address is `SUPPORT_EMAIL`). |
| 8 | Confirmation after cancelling | None (UI banner only). | **Fixed:** `cancellation_scheduled` email: no renewal, access until period end, undo possible. Deliberately makes no refund or "no further charges" promise. |
| 9 | Claims on the cancel page | Confirm step says "no further charges after that". Usage overage invoices (`processOverageInvoice`) can still bill for usage in the final period. | **Open [VERIFY] [COUNSEL]:** reword or confirm overage behaviour after cancellation. Not changed here because it needs a product decision. |
| 10 | "No payment is collected during a free trial" | Terms / Refund Policy / FAQ say this, while the trial is card-required (see `docs/billing/card-required-trial.md`). | **Open [COUNSEL]** (already flagged in that file). |
| 11 | Refund / proration policy | Not stated at purchase. In-app plan change uses Stripe proration (`create_prorations`). | **Open [COUNSEL]:** decide and publish a refund statement. UI text only describes proration **[VERIFY]**. |
| 12 | Price changes | `price_change_notices` exists with a 30-day minimum. | Out of scope; minimum notice **[COUNSEL]**. |
| 13 | Records | Consent/acknowledgment is not stored as a separate record. Stripe holds the session; `billing_notice_log` records that the confirmation email was sent. | Open **[COUNSEL]:** whether to retain the exact disclosure text/version shown. |
| 14 | Other languages | `renewalDisclosure` is translated to en + fa only; other UI locales fall back to English. Emails cover all 9 languages. | Open: translate after counsel approves the English text. |

## 3. Not changed on purpose

- Marketing pages and Terms / Refund Policy text (legal copy).
- Stripe dashboard settings (Payment Links, Customer Portal cancellation settings): **[VERIFY]**.
- Any claim of legal compliance. This document lists gaps; it does not close them.

## 4. Verification map

| Change | Test |
|---|---|
| Cancel without a reason | `cancellationLogic.test.ts`, `CancelSubscriptionPage.test.tsx` |
| One-click confirm, skip button | `CancelSubscriptionPage.test.tsx` |
| Email templates, 9 languages, no unfilled placeholders, HTML escaping | `notices/compose.test.ts` |
| Disclosure copy + locale parity + wired into BillingPage | `src/i18n/renewalDisclosureKeys.test.ts` |
