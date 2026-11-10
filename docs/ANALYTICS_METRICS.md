# Analytics layer and founder KPIs

Single source of truth for every number. Code: `supabase/functions/_shared/analytics/customerKpis.ts` (Part A) and
`founderKpis.ts` (Part B). A unit test fails if a metric id is missing from this file. Bump a metric's `version` in code
when its rule changes, and add a line to the changelog at the bottom.

Conventions: money = integer USD cents. Rates = integer basis points (10000 = 100%). "No data" = `null`, never 0.
A ratio is always `sum(numerator) / sum(denominator)` over the same rows, never an average of daily ratios.
All dates are UTC.

## Part A - customer metrics (flag `analytics_layer`, default OFF)

Enable for one account: `/staff/feature-flags` -> `analytics_layer` -> tenant override ON (that override is the
per-account entitlement). With the flag OFF the dashboard route shows a "not enabled" state, the edge function answers
403, RLS returns no rows and the nightly refresh skips the account.

| id | Definition (v1) | Source |
| --- | --- | --- |
| `first_time_fix_rate` | 100% minus the share of completed jobs that were later reworked (some job has `rework_of_job_id` = this job). Same rule as the technician leaderboard. | `jobs` |
| `callback_rate` | Completed jobs with `is_rework = true` / completed jobs, on the rework job's own completion day. | `jobs` |
| `revenue_per_technician` | `invoice_amount` of completed billed jobs that have a technician / distinct technicians with at least one completed job in range. Unassigned jobs are excluded from both sides. | `jobs` |
| `job_profitability` | (revenue - recorded cost) / revenue over completed billed jobs that have at least one `job_cost_entries` row. Jobs without cost entries are left out (cost unknown, not zero). Loss-making jobs are included, so the value can be negative. | `jobs`, `job_cost_entries` |
| `utilization` | Scheduled minutes of completed jobs with a technician / capacity. Capacity = per technician, days in range that fall on a working day x `hours_per_day` (setting, default 8) x 60. Not capped at 100%. | `jobs.duration_minutes`, `technician_availability` |
| `quote_conversion` | Accepted quotes / quotes sent, attributed to the day the quote was sent. Recent days are immature. Null when a team filter is active (quotes have no technician). | `quotes` |
| `ar_aging` | Open invoices (status `sent`/`viewed`), balance = `invoice_total_cents` - payments, bucketed by days past `due_date`: current, 1-30, 31-60, 61-90, 90+. A snapshot "as of" a day. | `invoices`, `invoice_payments` |

Attribution day for jobs: `completed_at`, else `scheduled_datetime`, else `created_at` (identical to `data-platform/metrics.ts`).

Known limitations (documented, not hidden)
- A technician is a team member who has been assigned at least one job; idle technicians never assigned a job are not in capacity.
- Vireek stores working days but not hours, so utilization depends on the `hours_per_day` setting.
- Refunds are not netted from AR balances.
- Rework later creates a job that changes an earlier day's `first_time_fix_rate`; rollups rebuild the trailing 90 days nightly, older days are frozen.

### Rollups and refresh
`analytics_daily_rollups` stores additive components per (account, day, technician). `analytics_refresh_rollups` rebuilds a range
atomically under a per-account advisory lock. `analytics_refresh_all(90)` runs nightly at 02:30 UTC through pg_cron (if pg_cron is
absent, call it from any scheduler). On the first dashboard view the edge function backfills 90 days if the account has no rollups.
Why tables and not materialized views: a materialized view cannot carry per-tenant RLS, and refreshing one rebuilds every tenant at once.

### Digest, alerts, CSV, events
- Weekly/monthly digest: opt-in (`digest_enabled`, default false), sent to the account owner's email, claimed atomically so a duplicate cron run cannot send twice. Provider sits behind `DigestMailer` (Resend adapter + mock). REQUIRES COUNSEL: confirm sender identification and unsubscribe wording for your jurisdictions.
- Anomaly alerts (opt-in): last completed week vs the previous 8 weeks; needs >= 4 history weeks and >= 10 jobs (or quotes) in the week; flag when |z| >= 3 and the absolute change >= 500 bp. Critical at |z| >= 4 or flat history. One alert per account + metric + week (idempotent).
- CSV: RFC 4180 quoting, formula-injection neutralised (`=`, `+`, `-`, `@`, tab, CR prefixed with `'` for text cells), header carries each metric version.
- Events: allow-list in `ANALYTICS_EVENTS`; only enums, bounded integers and booleans are stored. No names, emails, phones, free text or ids of people. The table also constrains the event names and caps the payload at 512 bytes.

## Part B - founder KPIs (platform staff only)

Access: `profiles.is_staff` through `is_vireek_staff(auth.uid())`, enforced inside every RPC and again in the edge function and `StaffRoute`.
Vireek has no subscription history table, so a ledger (`subscription_mrr_events`) is derived from the Stripe event payloads in `billing_events`.

MRR of a subscription: statuses `active` and `past_due` count, everything else is 0; list price x quantity, normalised to a month; metered prices count 0; coupons are not netted; `customer.subscription.deleted` = 0.
Snapshot rule: `snapshot(T)` = state after all ledger points strictly before T; period = [start, end).

| id | Definition |
| --- | --- |
| `gross_dollar_retention` | sum over the starting cohort of min(end MRR, start MRR) / sum of start MRR. Excludes expansion. Range 0..100%. |
| `net_revenue_retention` | sum of end MRR of the starting cohort / sum of start MRR. Includes expansion, contraction and churn; excludes new logos and reactivations. |
| `activation` | Signups in the window that completed their first job within N days (default 14) / MATURE signups (signup + N days already elapsed). |
| `module_attach` | Distinct paying accounts that created at least one row of a module's anchor table in the last 30 days / paying accounts. Modules: jobs, quotes, invoices, job_costing, timesheets. |
| `payment_take_rate` | Platform fee revenue (manual monthly entry) / gross card payment volume from `invoice_payments` (method `card`). |
| `cac_payback` | CAC = manual S&M spend / new logos; payback months = CAC / (average new-customer MRR x manual gross margin). Null if any divisor is 0. |
| `cohort` | Cohort month = month of an account's first positive MRR. Initial MRR = snapshot at the end of the cohort month. Cell k = snapshot at the end of month + k, null until that month has fully elapsed. Net and logo retention shown. |

Edge cases (each has a fixture test): upgrade, downgrade, churn inside the month (account never enters the cohort or new MRR), upgrade then downgrade back in the same month (net zero), reactivation (counted as new MRR), event exactly on the period boundary (belongs to the period, never counted twice), expansion above 100% (GRR stays <= 100%), empty cohort (null).

Manual inputs (`founder_cac_inputs`) are staff-entered, validated, and audited append-only in `founder_cac_audit`.
UNVERIFIED: which Stripe event types the production webhook is subscribed to. The dashboard shows received created/updated/deleted counts (`founder_get_data_health`). If `created` is 0, new-logo timing falls back to the first `updated` event.

## Index plan
| Query | Index | Where |
| --- | --- | --- |
| Rollup read by account + day range | primary key `(user_id, day, technician_key)` | `analytics_daily_rollups` |
| Refresh: one account's completed jobs in a date range | `idx_jobs_analytics_completed (user_id, COALESCE(completed_at, scheduled_datetime, created_at)) WHERE job_status='completed'` | `jobs` |
| Refresh: rework existence | `idx_jobs_rework_of_job_id` (already exists) | `jobs` |
| Refresh: costs per job | `idx_job_cost_entries_job (job_id)` | `job_cost_entries` |
| Refresh: quotes by sent day | `idx_quotes_analytics_sent (user_id, sent_at)` | `quotes` |
| AR: open invoices + payments | `idx_invoices_analytics_open`, `idx_invoice_payments_invoice` | `invoices`, `invoice_payments` |
| Alerts list | `idx_analytics_alerts_user (user_id, created_at DESC)` | `analytics_alerts` |
| Ledger read in time order | `idx_subscription_mrr_events_order (event_at, ord, id)` | ledger |
| Module usage (staff, cross-tenant, 30 days) | none new; sequential scans of `created_at` windows. Add `created_at` indexes only if the staff query exceeds its budget. | `jobs`, `quotes`, `invoices`, `timesheets` |

## Benchmark protocol (NOT YET MEASURED - no database was available when this was written)
Targets: dashboard read (<= 366 daily rows x technicians) p95 < 150 ms; refresh of 90 days for an account with 50k jobs < 5 s; AR aging < 200 ms for 10k open invoices; founder ledger read < 500 ms for 100k events.
Run on a staging copy:
```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM analytics_daily_rollups WHERE user_id = '<owner>' AND day BETWEEN '2028-01-01' AND '2028-03-31';
EXPLAIN (ANALYZE, BUFFERS) SELECT analytics_refresh_rollups('<owner>', current_date - 90, current_date);
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM analytics_ar_open_invoices('<owner>');
```
Record the results in this file under "Measured" and compare with the targets before enabling the flag for customers.

## Changelog
- v1 (initial): all metrics above at version 1.

## Operations
Deploy order: (1) migration `20290301000000_analytics_layer.sql`, (2) `20290301000100_founder_kpis.sql`, (3) `supabase functions deploy analytics-query analytics-run founder-kpis`, (4) frontend, (5) schedule `analytics-run` (snippet at the top of `analytics-run/index.ts`), (6) enable the flag for one pilot account in `/staff/feature-flags`.
Environment variables (no secrets in code): `CRON_SECRET` (existing), `SITE_URL`, `ANALYTICS_DIGEST_MODE` (`live` to really send; default is a mock that sends nothing), `RESEND_API_KEY`, `RESEND_FROM_EMAIL`.
Routes: `/dashboard/business-kpis` (customers, flag `analytics_layer`) and `/staff/founder-kpis` (platform staff). No nav link is added on purpose: the nav has no flag gating, and a link visible to everyone would change behavior for accounts that have the flag OFF. Link it from the nav once the flag is rolled out.
Smoke test after enabling: sign in as a pilot owner and open the dashboard (the first view backfills 90 days); sign in as a non-pilot owner and confirm a 403 `not_enabled`; sign in as a non-staff user and call `founder-kpis` (expect 403); run `select public.founder_get_data_health()` as staff and check that `created_events` > 0.
