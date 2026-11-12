# Tax readiness for Vireek subscriptions (Stripe Tax)

> **Rates, thresholds and registration requirements must be confirmed with an accountant. They were not researched here.**
> This repository contains no tax rate, threshold or registration rule. Stripe Tax decides all of it.
> Work in **Stripe test mode** until an accountant has signed off.

## Scope

In scope: what Vireek charges its own customers for a Vireek subscription.

Out of scope: tax on invoices that Vireek customers send to their own clients (`tax-taxjar`, `src/lib/tax.ts`). That is a separate feature and was not changed.

## How it works in code

One switch: the Supabase secret `STRIPE_AUTOMATIC_TAX`.

| Value | Behaviour |
| --- | --- |
| unset, or anything except the exact string `true` | Identical to before this change. |
| `true` | Checkout asks Stripe to calculate tax, requires a billing address, lets business customers enter a tax ID, and saves both to the Stripe customer. |

```bash
supabase secrets set STRIPE_AUTOMATIC_TAX=true   # test mode project first
supabase secrets unset STRIPE_AUTOMATIC_TAX      # instant rollback
```

Shared logic lives in `supabase/functions/_shared/billing/stripeTax.ts` (unit tested). With the switch on, each site below also refuses a plan price whose Stripe `tax_behavior` is `inclusive`, because Vireek prices are tax-exclusive.

| Site | Creates | What changed |
| --- | --- | --- |
| `create-checkout-session` | Customer, Checkout Session | Tax params + price guard. Customer creation unchanged (address is collected in Checkout and saved with `customer_update`). |
| `manage-subscription-plan` (`checkout`) | Customer, Checkout Session | Same as above. |
| `manage-subscription-plan` (downgrade) | Subscription Schedule | Each phase keeps `automatic_tax` when the **subscription** has it (not env-gated, so a taxed subscription never silently loses tax). |
| `results-plan-enroll` (`start_checkout`) | Checkout Session | Existing `automatic_tax` line replaced by the shared helper (still sends `enabled:false` when off) + price guard. |
| `create-billing-portal-session` | Billing Portal Session | No code change: the portal has no tax parameters. Configure it in the Dashboard (below). |
| Payment Links (`STRIPE_CHECKOUT_LINKS` in `src/lib/pricing.ts`) | Subscriptions | Not controlled by code. Dashboard only (below). |

## Stripe Dashboard checklist (manual, test mode first)

- [ ] **Enable Stripe Tax** (Dashboard → Tax).
- [ ] **Set the origin / head-office address** in Tax settings.
- [ ] **Add registrations** only in the places where the owner is actually registered. (Ask the accountant.)
- [ ] **Product tax codes:** set a tax code on every Vireek plan Product. (Ask the accountant which code fits.)
- [ ] **Price tax behaviour:** set every plan Price to **Exclusive** (or set Exclusive as the default tax behaviour in Tax settings). The code blocks `inclusive` and only warns on `unspecified`.
- [ ] **Payment Links:** for each of the six links in `STRIPE_CHECKOUT_LINKS`, turn on *Collect tax automatically*, *Allow customers to add a tax ID*, and require the billing address. If an option cannot be changed on an existing link, create a replacement link and update the URL in `src/lib/pricing.ts`.
- [ ] **Customer portal:** allow customers to update their billing address and tax IDs.
- [ ] **Invoice settings:** show the account tax IDs and the customer tax IDs on invoices and receipts.
- [ ] Set `STRIPE_AUTOMATIC_TAX=true` (test mode project).

## Verify in test mode

- [ ] Checkout from `/dashboard/billing` and `/dashboard/billing/plans`: address is required, the tax-ID checkbox appears, tax is shown where a registration exists.
- [ ] A business with a valid EU VAT ID: tax is 0 and the invoice shows reverse charge.
- [ ] A scheduled downgrade: the next invoice still carries tax.
- [ ] `/dashboard/billing/invoices` shows the subtotal, each tax line, the reverse-charge notice and the customer tax ID.
- [ ] `supabase secrets unset STRIPE_AUTOMATIC_TAX` restores the previous checkout behaviour.

## Known limits

- Existing subscriptions are **not** migrated to automatic tax. Turning it on for a subscription needs a valid customer address and an owner decision. Stripe documents the procedure under "update existing subscriptions".
- Invoices issued before Stripe Tax was switched on carry no tax data and show no tax lines.
