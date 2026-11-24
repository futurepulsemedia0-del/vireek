# Revenue recognition: Vireek's own revenue streams

Migration: `supabase/migrations/20290307000000_revenue_recognition_views.sql`
Tests: `supabase/tests/database/revenue_recognition_views.test.sql` (pgTAP, fixtures inline)
Access: platform staff only (`staff_revenue_recognition(from, to)`); the views themselves have no client grant.

> **Status of this document.** Everything under "Proposed treatment" is a **proposal for finance and counsel to decide, not an adopted accounting policy and not advice.** Which revenue standard applies to Vireek (for example ASC 606 or IFRS 15), the policy choices, the presentation of refunds and credits, and any tax treatment are all **[COUNSEL]**. The views implement the proposal so that the numbers can be inspected; changing a decision means changing the migration, not reinterpreting the numbers. Nothing in this repository has been audited, and nothing here is a statement that Vireek complies with any standard.

## 1. Scope

This covers what **tenants pay Vireek**. It does **not** touch the tenant-facing `invoices` table, which holds invoices that tenants send to *their* customers; that is the tenants' revenue, not Vireek's. (The platform's payment-facilitation fee on those payments is tracked manually in `founder_cac_inputs.platform_fee_cents` and is outside these views **[COUNSEL: gross vs net presentation]**.)

## 2. Reuse (nothing here duplicates existing work)

| Existing | Used for |
|---|---|
| `billing_events` (every Stripe event the webhook accepted, full payload) | The only stored record of Vireek's own invoices. The views read `invoice.paid`, `invoice.payment_succeeded` and `charge.refunded` from it. No new ingestion, `stripe-webhook` is unchanged. |
| `subscription_facts` / `growth_mrr_movements_v` | **Not** used here. They measure run-rate MRR (see `metrics-definitions.md`), which is not recognised revenue. |
| `_growth_assert_staff`, `_growth_assert_range`, `staff_audit_log` | Staff gating and access logging, same as the other `staff_growth_*` RPCs. |
| `pricingCatalog.ts`, `overage.ts`, `topup.ts`, `results-plan-bill` | Source of truth for how each stream is billed (cited below). |

**The gap this fills:** no object turned invoice data into recognised vs deferred revenue.

## 3. Revenue streams and proposed treatment

| Stream | How it is billed today (verified in code) | Proposed treatment **[COUNSEL]** | Covered by the views |
|---|---|---|---|
| **Subscription** | Stripe subscription, monthly or annual price per plan (`CATALOG_PLANS`: Starter, Professional, Business with `annualCents`; Enterprise is quoted, no annual price). Card-required 14-day trial (`trialLifecycle.ts`); the trial converts on the first non-zero payment. | A stand-ready service delivered over time: recognise **ratably** over the service period; an annual prepayment is a contract liability (deferred revenue) released monthly. No revenue during a trial that has not been paid. | **Yes**: stream `subscription`. |
| **Usage: overage** | On renewal Stripe sends `invoice.created`; `overage.ts` adds one invoice item for the period that just closed (`metadata.vireek_overage_key`, rate per minute above the plan allowance, only when `paid_overage_policy` = `bill`). | Variable consideration that relates to usage in a closed period: recognised **when the usage is determined and billed**. Whether to **accrue unbilled usage** at month end (a contract asset) is open. | **Yes**: stream `usage_overage`, recognised in the month the invoice is **paid** (see limits). |
| **Usage: top-up packs** | One-time Stripe Checkout payment for 100 minutes (`topup.ts`, `STRIPE_PRICE_TOPUP_100`), credited as `profiles.bonus_minutes`. A refund or dispute reverses the credit. | Prepaid minutes: a contract liability, recognised **as minutes are consumed**; treatment of minutes that are never used (breakage) and any expiry terms are **[COUNSEL]**. | **No.** A Checkout payment is not an invoice, so there is no invoice line to schedule. Top-up revenue is **not available** from these views. Its refunds appear only in `refunds_unlinked_cents`. |
| **Results-based** | Results Plan (`docs/results-plan.md`): a base fee plus a price per **verified job**, with monthly cap, 30-day guarantee cap and "never more than the flat plan". `results-plan-bill` posts Stripe Billing Meter events (value = cents); the metered price appears as an invoice line. Charges can be disputed for 14 days and credited. | Variable consideration: estimate and recognise only to the extent a significant reversal is **not** probable (cap, guarantee, dispute and credit history all bear on this). Recognition point (verified job vs invoice) is open. The base fee, if any, is a subscription-type fixed fee. | **Partly.** Stream `results_based` once the price ids are registered in `revenue_price_stream_map` (section 7). Recognised in the month the invoice is **paid**, not the month the job was verified. Credits issued as credit notes are not visible (see limits). |

`docs/results-plan.md` states the Results Plan is "built, not yet run end-to-end". Until it has billed real invoices the `results_based` series will be empty; that is correct, not an error.

## 4. Proposed policy, as implemented by the views

Each item is a decision for finance and counsel **[COUNSEL]**.

1. **Revenue = net of discounts and of tax included in the price.** Line net = `amount` − all discounts − tax with `inclusive = true`. Tax added on top is never revenue.
2. **Ratable lines** (period end after start) are recognised **straight-line by elapsed time** (seconds), across UTC calendar months. Month *m* recognised = `round(net × elapsed fraction at end of m)` − the same figure at the end of *m−1*. The months therefore sum to the net amount exactly; there is no rounding drift.
3. **Point-in-time lines** (no period, or end ≤ start) are recognised in full in the month of their start.
4. **Nothing is recognised before the month of payment.** Service that has already elapsed when payment arrives is recognised in the payment month (catch-up). Reason: only paid invoices are in the stored events, so earlier months are never restated after the fact, and deferred revenue can never be negative for positive lines.
5. **Usage and results lines are billed in arrears**, so by rule 4 they fall in the payment month. They are not back-dated into the month of usage.
6. **Billed (cash-collected basis).** "Billed" in the views means *invoiced and paid in that month*, not issued.
7. **Refunds are shown, not netted** (same convention as `founder_get_payment_volume`). Presentation as contra-revenue vs reduction of deferred revenue is **[COUNSEL]**.
8. **Per currency, minor units, no conversion.** Amounts in different currencies are never added.
9. **UTC months.**

## 5. How the views work

```
billing_events ──► revenue_paid_invoices_v   one row per PAID invoice (invoice.paid + invoice.payment_succeeded collapsed)
               ──► revenue_invoice_lines_v   one row per line: net, period, stream, exclusion_reason
               ──► revenue_recognition_schedule_v   line × month: recognised, billed, deferred_end
               ──► revenue_recognition_monthly_v    month × currency × stream
               ──► revenue_refunds_monthly_v        from charge.refunded (cumulative amount → monthly delta)
               ──► revenue_data_health_v            what the data can and cannot support
```

**Roll-forward (per month, currency, stream):**

```
deferred_open + billed − recognised = deferred_close
```

`deferred_open` of a month equals `deferred_close` of the previous month (tested).

**Worked example** (from the test fixture). An annual price of 120,000 cents paid on 1 Jan 2025 for 1 Jan 2025 to 1 Jan 2026 (365 days):

| Month | Cumulative recognised | Recognised | Deferred at month end |
|---|---|---|---|
| Jan | round(120000 × 31/365) = 10,192 | 10,192 | 109,808 |
| Feb | round(120000 × 59/365) = 19,397 | 9,205 | 100,603 |
| … | … | … | … |
| Dec | 120,000 | remainder | 0 |

### Classification of a line into a stream

1. `metadata.vireek_overage_key` present → `usage_overage`.
2. Otherwise the price id is in `revenue_price_stream_map` → the mapped stream.
3. Otherwise a metered price → `metered_unmapped` (shown separately, never guessed).
4. Otherwise → `subscription`.

## 6. Edge cases

| Case | Behaviour |
|---|---|
| Same invoice delivered as `invoice.paid` **and** `invoice.payment_succeeded`, or replayed | Collapsed to one invoice (latest stored event); never double counted. |
| Draft (`invoice.created`) or any invoice whose `status` is not `paid` | Excluded. |
| Late payment | Recognised from the payment month; catch-up for elapsed service (rule 4). |
| Mid-month start | Recognised by exact elapsed time, not by whole months. |
| Proration lines (positive or negative) | Scheduled like any other ratable line; a negative line reduces recognised and deferred. Flagged `is_proration`. |
| Discount (line or invoice level) | Deducted via `discount_amounts`. |
| Tax | Inclusive tax deducted; exclusive tax ignored. |
| Trial | A $0 invoice contributes nothing; revenue starts with the first paid non-zero invoice. |
| Refund | Reported in `revenue_refunds_monthly_v` (gross, includes tax). The monthly figure is the **delta** between consecutive cumulative `amount_refunded` values of the same charge, so out-of-order delivery is safe. |
| Refund of a charge with no invoice (for example a top-up pack) | Reported in `refunds_unlinked_cents`. |
| Credit note, void, uncollectible | **Not available**: the events are not stored. `revenue_data_health_v` counts them (`credit_note_events`, `void_or_uncollectible_events`); a non-zero count means recognised revenue may be overstated. |
| Invoice with more lines than Stripe embeds (`lines.has_more`) | Counted in `invoices_lines_truncated`; the lines present are used, the invoice is excluded from the reconciliation check. |
| Line total ≠ `total_excluding_tax` | Counted in `invoices_mismatch`. A missing total is `invoices_reconciliation_unavailable`, not a pass. |
| Unusable line (no currency, no amount, period before 2000 or longer than 5 years) | `exclusion_reason` is set; it never reaches the schedule; counted in `lines_excluded`. |
| Malformed JSON anywhere in a payload | Parsed as NULL (`revenue_jint`, `revenue_jts`); the report never aborts. |

## 7. Setup and use

1. Apply the migration (idempotent). It creates one table, `revenue_price_stream_map`, and views; no source data is modified.
2. **Register the Results Plan prices** so they are not reported as `metered_unmapped`. The real ids live in secrets, not in the repository:
   `select public.staff_revenue_stream_map_set('<STRIPE_RESULTS_METERED_PRICE_ID>', 'results_based', 'Results Plan per verified job');`
   and, for the hybrid base fee, `'<STRIPE_RESULTS_BASE_PRICE_ID>'` with stream `results_based`. (Staff session required; the call is audited in `staff_audit_log`.)
3. Read the report (staff session):
   `select public.staff_revenue_recognition('2026-01-01', '2026-12-31');`
   Without a session (service role, from a trusted workstation): `select * from revenue_recognition_monthly_v order by month;`
4. **Read `data_health` first.** A non-zero `invoices_mismatch`, `invoices_lines_truncated`, `credit_note_events` or `lines_metered_unmapped` is a reason to treat the month as unreconciled.

## 8. Known limits (shown, not hidden)

1. **Paid invoices only.** Unpaid, open or uncollectible invoices are invisible, so recognised revenue is understated until payment, and a later void or write-off is not reflected.
2. **Which events are stored is [VERIFY].** The webhook header lists `invoice.payment_succeeded`; the code also handles `invoice.paid`. Confirm in the Stripe dashboard which events the production endpoint receives. Check `paid_invoice_events` in `revenue_data_health_v`. The ledger begins when events started to be stored; earlier invoices are **not available**. Backfill from Stripe is not implemented.
3. **Stripe field names are [VERIFY].** The code was written against the invoice and charge shapes of the pinned `stripe@17.4.0` library (API version of the account endpoint not verifiable from the repository). A different endpoint API version can change `lines`, `discount_amounts`, `tax_amounts` or `charge.invoice`; the reconciliation counters exist to expose that.
4. **Usage in arrears lands in the payment month** (policy 5). No accrual of unbilled usage.
5. **Top-up packs are not covered** (not invoices), and breakage is undecided.
6. **Refunds are not netted** and are gross of tax; a refund's effect on a particular line (recognised vs deferred portion) is not allocated.
7. **Results Plan:** no link to `results_plan_charges` is made. A reconciliation of posted charges to invoice lines would be a useful control; it is not built **[VERIFY]**.
8. **Credits applied from the customer balance** count as paid (Stripe marks the invoice paid). Whether that matches the policy is **[COUNSEL]**.
9. **Performance is unmeasured** at production scale. The schedule expands each line to one row per month. Run `EXPLAIN ANALYZE` on a staging copy before building a dashboard on it **[VERIFY]**.
10. **Not independently reconciled to Stripe or to a ledger.** See section 9.

## 9. Reconciliation before anyone relies on the numbers

1. On a staging copy of production data, run the migration, then compare month by month with Stripe's own revenue-recognition report for the same period **[VERIFY]**. Differences are expected from limits 1, 4 and 6; explain each one.
2. Check `sum(billed_cents)` per currency for a month against Stripe payouts or the balance-transaction report, net of tax and refunds.
3. Have counsel or the accountants review section 4 before the output is used for any external purpose **[COUNSEL]**.

## 10. Verification status

| Check | Result |
|---|---|
| Migration applies on an empty stub schema and a second time (idempotent) | Run on PostgreSQL 16 with stubs for `auth`, `profiles`, `billing_events`: **passed** |
| pgTAP `revenue_recognition_views.test.sql` | 54 of 54 passed on that stub database |
| Tests detect a deliberately broken rule (payment-month gate removed) | 5 tests failed as intended |
| Real Supabase stack (`supabase test db`), production data, Stripe reconciliation | **Not run** |

Open questions for counsel and finance: applicable standard; recognition point for results-based fees; accrual of unbilled usage; top-up breakage and expiry; contra-revenue vs deferred presentation of refunds; treatment of customer-balance credits; gross vs net for the payment-facilitation fee.
