# Sales-tax / VAT nexus tracker (staff only)

Internal early-warning aid that shows **Vireek's own subscription revenue** per US state and per country next to the
thresholds finance/counsel configure. It is **not** a legal determination of nexus, a registration obligation or tax advice.
**[COUNSEL]** Every legal interpretation below must be confirmed by counsel before anyone acts on it.

| Item | Where |
|---|---|
| Page (staff only) | `/staff/nexus` → `src/pages/admin/StaffNexusPage.tsx` (behind `StaffRoute`) |
| Thresholds (config) | `config/nexus-thresholds.json` — **all values are currently `null`** |
| Logic (pure, tested) | `src/lib/nexus/nexusTracker.ts`, tests in `nexusTracker.test.ts` |
| Data access | `src/lib/nexus/nexusApi.ts` |
| Migration | `supabase/migrations/20290304000000_nexus_tracker.sql` |
| DB tests | `supabase/tests/database/nexus_tracker.test.sql` (pgTAP) |

## Where the revenue comes from
`stripe-webhook` already stores every Stripe event in `billing_events.payload`. A trigger copies each **paid invoice**
(`invoice.paid` / `invoice.payment_succeeded`) into the append-only ledger `nexus_revenue_facts`:

- one row per Stripe invoice id (the two event types for one invoice count **once**);
- live-mode only (`livemode = false` ignored); `amount_paid > 0` only;
- jurisdiction = `invoice.customer_address` (country, and state for the US);
- time = `status_transitions.paid_at`, else the event's `created`, all in UTC;
- gross = `amount_paid`; tax = `invoice.tax`, else the sum of `invoice.total_taxes[].amount`, else 0.

The trigger can never fail the webhook insert (errors become warnings). Existing history is replayed once by the migration;
`SELECT public.nexus_backfill();` (service role) can be re-run at any time and is idempotent.

**[VERIFY]** before relying on the numbers: (1) the production Stripe account collects/stores a billing address on invoices
(otherwise revenue lands in `UNKNOWN`); (2) the webhook endpoint is subscribed to `invoice.paid` or `invoice.payment_succeeded`;
(3) which tax field your Stripe API version populates (`tax` vs `total_taxes`).

## Attribution is never guessed
| Case | Result |
|---|---|
| No / invalid country | `UNKNOWN` row ("no billing address") |
| US customer, state not a 2-letter code (e.g. `California`) | `US-UNKNOWN` row ("state unresolved") |
| Non-US customer | country row (`GB`, `DE`, …); state is not stored |

Unattributed revenue is always shown, and the "Revenue with no usable address" tile totals it. Fix the source data (Stripe
customer addresses); do not assign it to a state by assumption.

## Thresholds (`config/nexus-thresholds.json`) — [COUNSEL][VERIFY]
No threshold value is shipped. The file lists the 50 states + DC (`US-<USPS>`) and a few countries as empty entries. To track
another country add a key with its ISO 3166-1 alpha-2 code.

| Field | Meaning |
|---|---|
| `revenueThresholdCents` | integer, minor units of `currency` (e.g. `10000000` = 100,000.00). `null` = not set |
| `transactionThreshold` | integer invoice count. `null` = not set. Either or both may be set; the **worst** status wins |
| `currency` | lower-case ISO 4217. Required with a revenue threshold. **No FX conversion** is ever applied |
| `window` | `rolling_12m` \| `calendar_year` \| `prior_or_current_calendar_year` (higher of the two years) |
| `basis` | `gross` (default) \| `net_of_tax` — whether collected tax counts toward the threshold |
| `comparison` | `gte` ("meets or exceeds", default and conservative) \| `gt` ("exceeds") |
| `effectiveFrom`, `sourceUrl`, `reviewedBy`, `reviewedOn` | provenance. A row without `sourceUrl`+`reviewedBy`+`reviewedOn` is flagged "Threshold not reviewed" |
| `alerting.approachingRatio` | internal early-warning fraction (default `0.8`); **not** a legal value |

Do not fill a value unless it has been checked against the jurisdiction's current official rule and recorded with its source.
Rules change; re-verify on a schedule agreed with counsel.

## Statuses
- **below** — under `approachingRatio` × threshold.
- **approaching** — at or above that fraction, not yet at the threshold.
- **exceeded** — at/above (`gte`) or above (`gt`) the threshold.
- **not configured** — no complete threshold (value + window). **Never shown as "below".**
- **currency mismatch** — billed in a currency other than the threshold's; not compared.

## CSV export
"Export CSV" downloads the **currently filtered** rows (UTF-8 BOM, RFC 4180, spreadsheet-formula neutralised). Money is in
major units. Columns: see `NEXUS_CSV_HEADER`. Each export is recorded in `staff_audit_log` (`action = 'explorer_list'`,
`metadata.view = 'nexus_export'`); each page read as `nexus_tracker`.

## Security model
`nexus_revenue_facts` has RLS enabled with **no policies** and all privileges revoked from `anon`/`authenticated`. Reads go
through `staff_nexus_revenue(date)` (`SECURITY DEFINER`, verifies `is_vireek_staff(auth.uid())` inside the function). Tenants
cannot read it; the page is also behind `StaffRoute`.

## Known limitations (all [COUNSEL])
- Refunds, credit notes and chargebacks are **not** netted; gross collected only.
- Whether Vireek's SaaS is taxable in a given jurisdiction, marketplace/Stripe Tax collection, and what counts toward a threshold
  (e.g. exempt sales) are legal questions this tool does not answer.
- Status uses the invoice's billing address, not ship-to/use location or place-of-supply rules.
- Revenue before the first stored event is not in the ledger (the page shows the covered date range).
- A mismatch between invoices seen in `billing_events` and the ledger raises a warning on the page.

## Operations
- Apply: `supabase db push` (or the project's normal migration flow), then `supabase test db`.
- Rebuild the derived ledger: `SELECT public.nexus_backfill();` as service role.
- Rollback: see the comment block at the top of the migration (ledger is derived data and can be rebuilt).
