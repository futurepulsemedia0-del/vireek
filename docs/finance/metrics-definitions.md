# SaaS metrics definitions: MRR, ARR, NRR, GRR, logo churn, CAC payback

Migration: `supabase/migrations/20290307000100_saas_metrics_views.sql`
Tests: `supabase/tests/database/saas_metrics_views.test.sql` (pgTAP, fixtures inline)
Access: platform staff only (`staff_metrics_saas(from, to)`); the views have no client grant.

**Rule for missing data:** a figure is computed from a registered source or it is **not available**. In SQL that is `NULL` plus an `availability` reason code, never `0`. A measured zero stays `0`. Nothing is estimated, interpolated or back-filled.

## 1. One ledger, one definition

Vireek already has two MRR ledgers built from `billing_events`:

| Ledger | Used here? |
|---|---|
| `subscription_facts` + `growth_mrr_movements_v` (`20281103000000_growth_analytics_core.sql`) | **Yes, the only source.** Carries user id, currency, trial dates, discount flag. |
| `subscription_mrr_events` (`20290301000100_founder_kpis.sql`, TypeScript in `_shared/analytics/founderKpis.ts`) | No. |

The two differ: the founder ledger uses list price and never nets a coupon; the growth ledger applies a `forever` percent-off coupon and flags every other discount as `discount_unresolved`. **The founder dashboard and these views can therefore show different MRR for the same month.** This is a known inconsistency in the repository, not something these views fix **[VERIFY which one the board should see]**. These views follow the growth ledger because it is the one `board-pack.mjs` and `staff_growth_mrr_bridge` already use; a test asserts that month-end MRR and cohort figures equal `growth_period_summary()`.

Also reused, not duplicated: `growth_marketing_spend` (manual spend), `founder_cac_inputs.gross_margin_bp` (manual margin), `growth_period_summary()` (one arbitrary period, kept as is).

**The gap this fills:** monthly time series as views, ARR, 12-month retention alongside 1-month, and a CAC payback view with explicit not-available reasons.

## 2. MRR rules inherited from the ledger (not redefined)

- Status `active` and `past_due` count; `trialing`, `canceled`, `unpaid`, `incomplete`, `paused` are 0.
- List price × quantity, yearly ÷ 12, `interval_count` honoured; only month and year intervals; metered prices count 0.
- `forever` percent-off coupons applied; any other discount is **not** applied (MRR may be overstated; the number of such subscriptions is reported).
- Refunds never change MRR.
- Month-end snapshot = state after all ledger rows strictly before the first instant of the next UTC month. Months are UTC.
- Per currency, no conversion. A row with no currency is shown as `unknown`.

## 3. Definitions

| Metric | Formula | View / column | Unit |
|---|---|---|---|
| **MRR** | Σ over subscriptions of month-end MRR | `metrics_mrr_monthly_v.mrr_cents` | minor units |
| **ARR** | MRR × 12. A run-rate, not contracted or invoiced annual revenue. | `arr_cents` | minor units |
| **Paying accounts** | accounts with MRR > 0 at month end | `paying_accounts` | count |
| **Cohort (retention)** | accounts with MRR > 0 at the **start** of the window. New logos and reactivations inside the window are not in it. | `cohort_accounts` | count |
| **NRR** | Σ closing MRR of cohort ÷ Σ opening MRR of cohort. Includes expansion, contraction, churn. May exceed 100%. | `metrics_retention_monthly_v.nrr_bp` | basis points (10,000 = 100%) |
| **GRR** | Σ min(closing, opening) ÷ Σ opening. Excludes expansion. Never above 100%. | `grr_bp` | basis points |
| **Logo churn** | cohort accounts whose MRR is 0 at the window end ÷ cohort accounts | `logo_churn_bp` | basis points |
| **New logo** | an account's first month with MRR > 0 (`growth_mrr_movements_v`, movement `new`) | `metrics_cac_payback_monthly_v.new_logos` | count |
| **CAC** | spend entered for the month and currency ÷ new logos | `cac_cents` | minor units |
| **CAC payback** | spend × 10,000 ÷ (new-logo MRR × gross margin bp) = CAC ÷ (average new-logo MRR × gross margin) | `payback_months` | months, 2 decimals |

**Windows.** Retention is published for `window_months` = 1 and 12, ending at the end of `month`. The opening snapshot is the end of month − window. Each window is a single period, **never annualised**. A 1-month figure is not a yearly retention rate.

## 4. Edge cases (each has a fixture test)

| Case | Treatment |
|---|---|
| **Trial** | MRR 0 while `trialing`. A trial that converts becomes a **new logo in the month it first pays**. A trial that is canceled never was a logo and never enters a cohort. |
| **Upgrade** | Expansion: raises NRR, not GRR. GRR stays ≤ 100%. |
| **Downgrade** | Contraction: lowers NRR and GRR; not a logo churn while MRR stays above 0. |
| **Refund** | No effect on MRR, NRR, GRR or logo churn (a stored refund event adds no subscription fact; tested). Refunds belong to revenue, see `revenue-recognition.md`. |
| **Cancellation** | MRR to 0 = churn: the account counts as churned in every window whose cohort it was in. |
| **Reactivation** (new subscription or recovery from `unpaid`) | Not a new logo (no CAC row) and not retention: the account was not in the opening cohort. It reappears in later cohorts. |
| **past_due** | Still counts as MRR. `unpaid` is 0 and shows as churn. |
| **Concurrent subscriptions** | MRR is summed per account; retention and churn are per account. |
| **Active at 0 MRR** (100% coupon, metered-only price) | MRR 0, so the account is not a paying logo. **[VERIFY]** whether any such account exists. |
| **Unresolved discount** | MRR counted at undiscounted price; reported in `subscriptions_with_unresolved_discount`. NRR/GRR are unaffected unless the discount changes. |
| **Multiple currencies** | Separate rows. Never summed. |
| **Current month** | `is_partial = true`: month-end means "as of now". |
| **Ledger start** | Months before the first event are absent, not 0. |
| **Empty cohort** | NRR, GRR and churn are NULL, `not_available_no_cohort`. |

## 5. Not-available reason codes

| Code | Meaning |
|---|---|
| `not_available_history_too_short` | The window starts before the first ledger event, so accounts that were already paying are invisible. |
| `not_available_no_cohort` | Nobody was paying at the start of the window. |
| `not_available_no_spend` | No spend row for that month and currency. A missing row is **not** a free month. |
| `not_available_no_new_logos` | Spend exists but no account converted: CAC would divide by zero. |
| `not_available_no_new_mrr` | New logos exist but their MRR is 0. |
| `not_available_no_gross_margin` | No `founder_cac_inputs` row, or `gross_margin_bp` ≤ 0. Zero is "not entered", not a margin. CAC itself is still shown. |
| `ok` | Value computed. |

An **entered** spend of 0 is a measured zero: CAC = 0 and payback = 0.00 (tested).

## 6. CAC payback caveats

1. **Spend is what staff entered** in `growth_marketing_spend`. It is "S&M" only if staff also enter sales cost (for example as a channel `sales`). Nothing here knows whether it is complete **[VERIFY]**.
2. **Gross margin is manual** (`founder_cac_inputs`). The realised COGS views (`cogs-assumptions.md`) are variable-usage cost only and are deliberately not used, because they would overstate margin.
3. **No lag.** Spend in a month is divided by logos that converted in the same month, though a trial takes 14 days to convert. Read adjacent months together; a single month can mislead.
4. **Payback is on new-logo MRR at conversion**, ignoring later expansion, churn or discounts.
5. **Attribution is not used.** All new logos count, attributed or not.

## 7. Known limits

- **The ledger starts when events started to be stored.** Whether the production webhook sends `customer.subscription.created` is **[VERIFY]**; see `created_events` in `metrics_data_health_v`. If it is 0, the first paid event of a subscription is an `updated` event and "new" is still derived from the MRR change.
- Accounts that never matched a profile (`stripe_customer_id` and `metadata.supabase_user_id` both missing) are not in `subscription_facts` and so are not in any metric; `staff_growth_data_quality()` reports them.
- **Performance is unmeasured.** The month grid is subscriptions × months, one indexed lookup each. Run `EXPLAIN ANALYZE` on a staging copy **[VERIFY]**.
- Nothing here is audited or reconciled to Stripe. Treat the figures as management information until reconciled.
- **No UI** was added. Staff read the data through `staff_metrics_saas`, `board-pack.mjs` or SQL.

## 8. Use

```sql
-- staff session
select public.staff_metrics_saas('2025-01-01', '2025-12-31');

-- service role / trusted workstation
select month, currency, window_months, nrr_bp, grr_bp, logo_churn_bp, availability
from metrics_retention_monthly_v order by month, window_months;
```

Check `metrics_data_health_v` first (`history_start`, `spend_rows`, `gross_margin_months`, unresolved discounts).

## 9. Verification status

| Check | Result |
|---|---|
| Migration applies on a fresh stub database after the growth and founder migrations, and a second time | **Passed** (PostgreSQL 16, stubs for `auth`, `profiles`, `billing_events`, `staff_audit_log`) |
| pgTAP `saas_metrics_views.test.sql` | 54 of 54 passed |
| Existing `growth_analytics.test.sql` on the same database | 30 of 30 passed (no regression) |
| Tests detect deliberately broken rules (GRR without floor; reactivation counted as new logo) | 3 and 1 tests failed as intended |
| Real Supabase stack (`supabase test db`), production data, production-scale performance | **Not run** |
