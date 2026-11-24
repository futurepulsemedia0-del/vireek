# API usage plans (rate limits, quotas, overage)

**Status:** implemented and **off by default**. Every number below is a **PROPOSED placeholder** (`api_usage_plans.is_proposed = true`), not a commercial commitment or a published price. Pricing, plan names and the account-plan mapping need a business decision before any customer sees them.

Migration: `supabase/migrations/20290312000000_api_usage_plans.sql` · Enforcement: `supabase/functions/api-v1/index.ts` → RPC `api_v1_admit` · Dashboard: `src/components/apiUsage/ApiPlanPanel.tsx` (on `/dashboard/api-usage`).

## 1. What already existed (kept as is)

| Capability | Where |
|---|---|
| API keys (live / test mode, scopes, IP allowlist) | `api_keys` |
| Staff-set per-key rate limit override (10–1200 / min, service-role only) | `api_keys.rate_limit_per_minute` |
| One log row per authenticated request, 30-day retention | `api_request_logs` |
| Per-key usage summary, time series, alert rules, alert events | `get_api_usage_*` RPCs, `/dashboard/api-usage` |
| Fixed-window per-minute limiter | `api_v1_rate_limit_ok` (still present; no longer called by `api-v1`) |

## 2. What this adds

- **Plans** (`api_usage_plans`): per-minute limit, monthly quota (or unlimited), overage policy, overage price per 1,000, hard cap.
- **Account assignment** (`api_plan_assignments`, staff only) and a **default mapping** from `profiles.plan` (`api_usage_plan_defaults`).
- **Counters** (`api_usage_counters`): one row per key per UTC month, written only by `api_v1_admit`.
- **One admission RPC** replacing the old limiter call: per-minute limit + quota in a single round trip.
- **Quota error** `quota_exceeded` (HTTP 429) and response headers `X-Quota-Limit`, `X-Quota-Remaining`.
- **Dashboard card**: plan, quota bar, projection, overage, counted requests per key.
- **Staff RPCs**: `assign_api_usage_plan`, `get_api_overage_report`.

## 3. Proposed plan table (PLACEHOLDERS)

| Plan | Per minute / key | Monthly quota | Over quota | Overage (per 1,000) | Hard cap |
|---|---|---|---|---|---|
| `legacy` (today's behaviour) | 120 | unlimited | – | – | – |
| `developer` | 60 | 10,000 | blocked (429) | – | quota |
| `growth` | 300 | 250,000 | metered | $0.30 | quota + 50% |
| `scale` | 600 | 2,000,000 | metered | $0.20 | quota + 50% |
| `partner` | 1,200 | 10,000,000 | metered | $0.10 | quota + 100% |

Default mapping of `profiles.plan`: `free`/`starter` → developer, `professional` → growth, `business` → scale, `enterprise` → partner. **[VERIFY]** the repo's `planCatalog` and pricing pages before using this mapping: only `starter` and `professional` appear in the profiles column comment.

To change numbers, edit rows in `api_usage_plans` (service role or a new migration). There is no editing UI.

## 4. Rules

1. **Flag off = no change.** Until `api_usage_plans` is switched on for an account (staff override ON in `feature_flag_overrides`, rollout stays 0), `api-v1` behaves exactly as before and nothing is counted.
2. **Per-minute limit** = key override (staff) > plan limit > platform default (120). The count comes from `api_request_logs` as before; 429 responses are not counted.
3. **Quota is per account**, summed over all live keys, per **UTC calendar month**. Test-mode keys are never counted.
4. `block`: requests at or over the quota get `429 quota_exceeded` with `Retry-After` = seconds to the next UTC month.
5. `meter`: requests continue past the quota until `quota × (1 + max_overage_pct/100)`, then `429 quota_exceeded`. The excess is **recorded, not billed**.
6. **What counts as a request:** every request admitted for a live key, whatever the response status. A 4xx caused by the client still counts. Requests rejected by the limiter or quota do not.
7. **Precision:** admission is not strictly atomic. Under concurrency the quota can be exceeded by at most the number of in-flight requests.
8. **Fail-open:** if `api_v1_admit` errors, the request is allowed (the same stance the old limiter had). During a database problem quotas are not enforced and requests may go uncounted.
9. **Retries after 429** do not consume quota. They are counted in the log only.

## 5. Rollout (shadow first)

1. Deploy migration, then `api-v1` (`supabase functions deploy api-v1 --no-verify-jwt`), then the web app.
2. Dashboard preview already works: accounts with the flag off see their plan as a **preview** (no counting).
3. Enable for staff/test accounts: insert an override ON for the account (same mechanism as `public_api_v2`). Verify headers and the dashboard.
4. Enable gradually. Watch 429 `quota_exceeded` and `get_api_overage_report`.
5. **Do not enable metered plans for paying customers** until invoicing exists (section 7) and terms are reviewed **[COUNSEL]**.

Assign an explicit plan (staff session):
```sql
select public.assign_api_usage_plan('<owner uuid>', 'growth', 'Signed order form 2029-04');
select public.assign_api_usage_plan('<owner uuid>', null);   -- back to the default mapping
select * from public.get_api_overage_report('2029-04');
```

## 6. Dashboards

`/dashboard/api-usage` keeps its existing per-key charts and alerts. New: **Plan & quota** card with plan and source (assigned / default), per-minute limit, used / remaining, a bar (warning at 80%), month-end projection (straight-line, only after 6 hours of data), overage count and estimated cost, and counted requests per key. If the flag is off the card says it is a preview.

Not built: quota alert emails (80% / 100%) and a staff UI for assigning plans. The existing API alert rules cover rates and errors, not quota.

## 7. Invoicing overage: NOT implemented (needs a decision)

`get_api_overage_report(period)` lists accounts over quota with an estimated amount (`ceil(overage / 1000) × cents_per_1000`). Nothing creates a Stripe invoice item. Before billing overage someone must decide: invoice timing, currency and tax, rounding, dispute process, and whether metered overage is allowed on trial or free plans **[COUNSEL]**. The report is also the reconciliation source for that future job.

## 8. Operations notes

- Counters hold one row per key per month; no pruning needed.
- Plan or mapping changes apply to the next request (no cache). `api_plan_for_owner` runs on every counted request (one indexed lookup).
- Revoked keys keep their counters (the account total includes them for the month).
- Rollback: see the header of the migration. `api_v1_rate_limit_ok` is intact, so restoring the old call in `index.ts` is enough to stop enforcement immediately.

## 9. Tests

Vitest: `src/lib/apiPlans.test.ts`, `src/i18n/apiPlansLocales.test.ts`, `supabase/functions/api-v1/contract.test.ts` (error catalog, edge-source rules, spec drift). pgTAP: `supabase/tests/database/api_usage_plans.test.sql`.
After changing `contract.ts` run `npm run openapi:generate` and commit `public/openapi.json`.
