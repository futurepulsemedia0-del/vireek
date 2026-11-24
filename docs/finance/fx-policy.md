# Foreign-exchange (FX) policy — PLACEHOLDER

> **Status: placeholder. Not approved. Not a policy in force.** This page lists the decisions the company has to make about currency, the realistic options for each, and what the repository can and cannot support today. Every decision below is open until a named owner records it in the [decision log](#decision-log). It contains **no hedging advice**: whether to hedge, with what instrument, in what size, is out of scope and belongs to qualified finance, treasury and legal advisers **[COUNSEL]**.

## What the data shows today

Read the exposure report (staff only, or service role) from migration `20290307000000_currency_exposure_views.sql`:

```sql
-- as a signed-in Vireek staff user (RPC re-checks is_vireek_staff)
select public.staff_fx_exposure();          -- last 12 months of detail
select public.staff_fx_exposure(24);        -- 1 to 36 months

-- service role / SQL editor only
select * from public.fx_exposure_summary_v order by currency;
```

| Object | What it holds | Source |
|---|---|---|
| `fx_revenue_run_rate_v` | Recurring revenue run-rate (MRR, minor units), subscriptions and accounts per currency | `subscription_facts`, latest fact per Stripe subscription (same source as the MRR bridge) |
| `fx_collected_by_currency_month_v` | Stripe invoices paid per month and currency, one row per invoice | `billing_events` payloads of `invoice.paid` / `invoice.payment_succeeded`, de-duplicated by invoice id |
| `fx_cost_by_currency_month_v` | Cost per month, with a `source` column | `cost_ledger` (USD) and `provider_invoices` (USD, **reconciliation reference only**) |
| `fx_exposure_summary_v` | One row per currency over the last three completed UTC months | The three views above |

How to read `exposure_state` in the summary (descriptive, not a recommendation):

| `exposure_state` | Meaning |
|---|---|
| `revenue_and_cost_recorded` | The database holds both revenue and cost in this currency. |
| `revenue_only_no_recorded_cost` | Revenue exists in this currency and **no cost is recorded in it**. This is a statement about the data, not proof that no cost exists. |
| `cost_only` | Cost is recorded in this currency and no revenue. |

Rules the views follow: currencies are **never converted, added together or averaged**; there is no FX rate anywhere in them. Unrecorded cost is `NULL`, never `0`. `provider_invoices` is never added to `cost_ledger` (it invoices the same usage, so adding both double counts). `collected_minor` is Stripe's `amount_paid` and **includes tax**; `tax_minor` is filled only when the payload carries a `tax` field **[VERIFY against the Stripe API version in use]**.

## Findings from inspecting the multi-currency code

Verified by reading the repository (no execution):

1. **Revenue is multi-currency, cost is USD only.** Subscription facts carry a `currency` per subscription. `cost_ledger.cost_micro` is micro-USD and `provider_invoices.invoiced_usd` is USD, so no cost the company pays in another currency (payroll, hosting, contractors, taxes) is recorded in the database **[VERIFY: where those costs are booked]**.
2. **Display rates are static and approximate.** `src/lib/currency.ts` holds hand-typed rates (its own comment says "update periodically — these are approximate") used for **price display only**. They must never feed accounting, reporting or this policy.
3. **Some money flows skip non-USD on purpose.** Affiliate commission accrual returns `skipped` for non-USD invoices; overage/top-up billing records `skipped_currency` for non-USD; `pay_*` Vireek Pay tables constrain `currency = 'usd'`; instant payouts are USD.
4. **Tenant charge currency is not uniform [VERIFY, not changed by this task].** `jobs.invoice_currency` and `profiles.invoice_currency` exist, and `public-payment` passes the job's currency through `normalizeChargeCurrency`. Several other Stripe creation sites hard-code `currency: "usd"` (`create-payment-request`, `mcp-server`, `_shared/recurring-jobs/invoice.ts`, `_shared/membershipRenewal/stripeCharger.ts`, `terminal-payments`). If a tenant invoice is in a non-USD currency, those paths would charge the same number in USD. Confirm intended behaviour with the owner of payments before relying on any multi-currency claim; this change does not touch those files.
5. **The board pack never converts** and prints one table per currency ([board pack](board-pack-template.md)); the [resilience model](resilience.md) takes one currency per input file.
6. **Special-case currencies.** Zero-decimal and three-decimal currencies use a different minor unit; the views return raw minor units and consumers must format with the ISO 4217 exponent **[VERIFY Stripe's special cases]**.

## Decisions to make

No option is recommended here. Each lists what it would mean in this codebase.

### 1. Reporting (functional) currency

- **A. USD.** Matches every cost table and all current conversions to cents. The board pack and exposure views already treat USD as the unit of cost.
- **B. Another currency** (for example the currency of the legal entity that holds the bank accounts). Cost tables would need a conversion or a second cost basis; board pack and COGS views would need a design change.
- **Open facts:** which legal entity bills customers, which currency its bank accounts and statutory accounts use **[VERIFY]** **[COUNSEL]**.

### 2. Currencies the company bills in

- **A. USD only**, with other currencies shown for display only (today's `CurrencySwitcher`).
- **B. USD plus a named list** of currencies charged natively (Stripe prices per currency).
- **C. Processor-side conversion** (Stripe adaptive pricing or similar): the customer sees a local price while the company settles in another currency. What gets recorded in `subscription_facts` under this option **[VERIFY]**.
- Consequence for each: where the exposure appears (settlement vs. billing currency) and what this report would show.

### 3. Rate source for management reporting (only if any conversion is wanted)

- **A. None.** Keep reporting per currency, as now.
- **B. A named published daily reference rate**, stored with its date and source.
- **C. The processor's settlement rate** per payout.
- **D. A month-end rate table set by finance** and approved with the close.
- Whichever is chosen must be stored as data with date and source, not typed into code. `src/lib/currency.ts` must not become the source.

### 4. Rate-date convention (if option B, C or D above)

Transaction date · month end · month average. Pick one per report type and write it in the report footer.

### 5. Recording costs paid in other currencies

- **A. Manual monthly entry** into a new staff-only table (`month`, `currency`, `amount_minor`, `label`, `source_ref`, `entered_by`), append-only. Needs a schema decision and an owner.
- **B. Feed from the company's accounting system**, if the company's own books are in a system the repository can read **[VERIFY: not present today]**.
- **C. No recording.** The report keeps showing `revenue_only_no_recorded_cost`, which must then be read as "unknown".

### 6. Review cadence and thresholds

Who reviews the exposure report, how often (monthly with the board pack, quarterly, on demand), and which figures trigger a discussion. Thresholds are a finance decision; the model in [resilience.md](resilience.md) uses configurable defaults that are **not** a standard.

### 7. Bank and processor accounts by currency

Which currencies the company holds balances in and which processor settles to which account. Needed to interpret the `processor` dimension in the resilience model.

### 8. Customer-facing disclosure

How the price currency, the charge currency and any conversion are shown at checkout and on invoices. Wording **[COUNSEL]**; the existing "prices exclude VAT/sales tax" i18n strings cover tax only, not currency.

### 9. Ownership and approval

Named owner, approver, review date, and where the approved version lives. This file stays a placeholder until then.

## Decision log

| # | Decision | Chosen option | Owner | Approved by | Date | Notes |
|---|---|---|---|---|---|---|
| 1 | Reporting currency | _open_ | | | | |
| 2 | Billing currencies | _open_ | | | | |
| 3 | Rate source | _open_ | | | | |
| 4 | Rate date | _open_ | | | | |
| 5 | Non-USD cost recording | _open_ | | | | |
| 6 | Review cadence / thresholds | _open_ | | | | |
| 7 | Accounts by currency | _open_ | | | | |
| 8 | Customer disclosure | _open_ | | | | |
| 9 | Ownership | _open_ | | | | |

## Known limits of the exposure views

1. Cost is USD only, and only what is in `cost_ledger`; payroll, hosting, tax and other costs are absent.
2. Revenue run-rate is subscription MRR; usage-based, one-off and marketplace revenue are not in these views.
3. Collected cash comes from webhook payloads; if a payload was not stored or lacks `amount_paid`, it is counted in `invoices_without_amount` and adds nothing.
4. `billing_events` has no index on `event_type`; run `EXPLAIN` on staging with production-scale data before using it for large ranges, and add an index in a separate `CONCURRENTLY` migration if needed **[VERIFY]**.
5. The migration and its pgTAP test were **not executed** by the author (no Postgres available). Run `supabase test db` on staging first.
6. No UI was added. Staff read the report through the RPC or SQL.

## Related

- [Financial resilience model](resilience.md)
- [Monthly board pack](board-pack-template.md)
- [COGS and gross-margin assumptions](cogs-assumptions.md)
- [Analytics layer and founder KPIs](../ANALYTICS_METRICS.md)
