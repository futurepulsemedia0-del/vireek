# Sales-tax economic-nexus analysis — checklist for Vireek's own SaaS sales

> **Status: DRAFT fill-in template. Not legal or tax advice. It reaches no conclusion about nexus, taxability or registration.**
> Every threshold, rule and conclusion is a `TODO(counsel)` until counsel or the accountant records it with a source.
> Owner: `TODO(owner)` (named person) · Counsel / accountant: `TODO(counsel)` · Last full review: `TODO(owner)`

**Scope.** What Vireek charges its own customers for a Vireek subscription. Not in scope: tax on invoices that Vireek customers send to their own clients (`src/lib/tax.ts`).

**What already exists (verify, do not rebuild).**

| Need | Where |
|---|---|
| Revenue per state, from Stripe | Ledger `nexus_revenue_facts` (one row per paid Stripe invoice), migration `supabase/migrations/20290304000000_nexus_tracker.sql` |
| Live status vs thresholds (staff only) | `/staff/nexus` → `src/pages/admin/StaffNexusPage.tsx`; how it works: [nexus-tracking.md](nexus-tracking.md) |
| Threshold config (all values `null`) | [`config/nexus-thresholds.json`](../../config/nexus-thresholds.json) |
| Revenue by state **and month** (CSV/JSON) | `npm run finance:nexus-revenue` → `scripts/finance/nexus-revenue-by-month.mjs` |
| Stripe Tax setup and registrations | [tax-readiness.md](../tax-readiness.md) |

## 1. Pull the data

```bash
export SUPABASE_URL=...  SUPABASE_SERVICE_ROLE_KEY=...        # production project, read only
npm run finance:nexus-revenue                                  # last 24 complete UTC months -> reports/finance/ (git-ignored)
npm run finance:nexus-revenue -- --from 2025-01 --to 2026-10 --format csv --out reports/finance/nexus-2026-10.csv
npm run finance:nexus-revenue -- --strict                      # exit code 3 if any revenue has no usable address
# no service-role key at hand: export rows from the SQL editor as a JSON array, then
npm run finance:nexus-revenue -- --input rows.json
```

SQL for the `--input` fallback (columns must match):

```sql
select coalesce(json_agg(t), '[]') from (
  select stripe_invoice_id, country, state, currency, gross_cents, tax_cents, paid_at, address_status
  from public.nexus_revenue_facts order by paid_at, stripe_invoice_id) t;
```

Output columns: `month` (UTC, of `paid_at`), `jurisdiction`, `country`, `state`, `currency`, `invoices`, `gross_minor`, `tax_minor`, `net_of_tax_minor`. Money is integer minor units. Rows with no revenue are not emitted.

Read the numbers with these limits in mind (all `TODO(counsel)` whether they matter):

- Gross collected only. Refunds, credit notes and chargebacks are **not** netted.
- No currency conversion. A threshold in one currency is never compared with revenue in another.
- Jurisdiction = the billing address on the Stripe invoice, not ship-to, use location or place-of-supply.
- Revenue with no country is `UNKNOWN`; a US invoice whose state is not a 2-letter code is `US-UNKNOWN`. Neither is assigned to a state.
- History starts at the first stored Stripe event; earlier revenue is not in the ledger.

## 2. Data readiness (tick before trusting any number)

- [ ] Production Stripe collects a billing address on every checkout path, including the Payment Links in `STRIPE_CHECKOUT_LINKS` (`src/lib/pricing.ts`). Owner: `TODO(owner)`
- [ ] The production webhook endpoint is subscribed to `invoice.paid` or `invoice.payment_succeeded`. Owner: `TODO(owner)`
- [ ] Ledger coverage on `/staff/nexus` shows `billing_invoices_seen` equal to `ledger_invoices`. Difference explained: `TODO(owner)`
- [ ] Share of invoices in `UNKNOWN` / `US-UNKNOWN` over the range: `TODO(owner)` %. Plan to fix source addresses: `TODO(owner)`
- [ ] Which tax field the production Stripe API version fills (`tax` vs `total_taxes`) confirmed on a real invoice. Result: `TODO(owner)`
- [ ] Revenue total of the export reconciled to Stripe's own report for the same UTC period. Difference: `TODO(owner)`
- [ ] Other sales channels outside Stripe (invoiced, app store, reseller, partner): listed here, or "none" confirmed. `TODO(owner)`
- [ ] Export file stored in the finance folder (it contains revenue by state); `reports/finance/` is git-ignored.

## 3. Threshold register

Do not copy a threshold from memory or a blog. For each state Vireek has revenue in, counsel records the current official rule and its source, then it is entered in `config/nexus-thresholds.json` (fields and meaning: [nexus-tracking.md](nexus-tracking.md#thresholds-confignexus-thresholdsjson--counselverify)).

| State | Revenue threshold | Transaction threshold | Measurement period | Gross or net of exclusions | "Meets" or "exceeds" | Source URL | Reviewed by / on |
|---|---|---|---|---|---|---|---|
| `TODO(counsel)` | `TODO(counsel)` | `TODO(counsel)` | `TODO(counsel)` | `TODO(counsel)` | `TODO(counsel)` | `TODO(counsel)` | `TODO(counsel)` |

Rows to add: one per state that appears in the export with revenue, then the rest as the business grows.

## 4. Per-state worksheet

Copy one block per state when the export shows revenue there. Fill from the export (section 1) and the register (section 3).

```text
State: ____            Period analysed: ____ to ____
Gross collected (minor units, currency): ____        Tax collected: ____        Invoices: ____
Threshold (from register): ____        Share of threshold: ____ %
Is SaaS taxable in this state?                         TODO(counsel): ____
Does any revenue fall under an exclusion?              TODO(counsel): ____
Marketplace / facilitator collection applies?          TODO(counsel): ____
Physical presence (staff, contractors, equipment)?     TODO(owner): ____
Registration status (registered / not / in progress):  TODO(owner): ____
Decision:  [ ] no action  [ ] monitor  [ ] register  [ ] voluntary disclosure   Decided by: ____  Date: ____
```

## 5. Questions for counsel / accountant

Questions only. No answer is assumed here.

1. Is Vireek's subscription taxable in each state where revenue exists, and under which product category? `TODO(counsel)`
2. For each state: which sales count toward the threshold (exempt, resale, tax-exclusive amounts), and over which period? `TODO(counsel)`
3. Does the state apply the threshold at the moment it is met or from the following period, and from when must tax be collected after that? `TODO(counsel)`
4. Whether past periods need review (look-back) once a threshold was met, and by whom. `TODO(counsel)`
5. How remote employees or contractors in a state affect the analysis. `TODO(counsel)`
6. Whether the billing address on the invoice is the right location for each state's sourcing rules. `TODO(counsel)`
7. How Stripe Tax interacts with registrations (it calculates, it does not register). `TODO(counsel)`
8. Non-US jurisdictions in the export (VAT/GST/other thresholds): list the countries to analyse. `TODO(counsel)`

## 6. Cadence and triggers

- [ ] Run the export monthly, after month end: first business week. Owner: `TODO(owner)`
- [ ] Re-verify each threshold in the register on a schedule agreed with counsel: every `TODO(counsel)` months.
- [ ] Extra review when: a state reaches the "approaching" ratio on `/staff/nexus`; a new sales channel starts; a large customer signs in a new state; counsel flags a rule change.
- [ ] Each run: attach the export, note who reviewed it, record decisions in section 7.

## 7. Decision log

| Date | State / country | Period | Finding from the export | Decision | Decided by | Counsel input (ref) |
|---|---|---|---|---|---|---|
| `TODO(owner)` | | | | | | `TODO(counsel)` |

## What the owner must supply

Named owner and counsel/accountant; every threshold and rule with its source; the list of other sales channels; the cadence; the production Stripe confirmations in section 2.
