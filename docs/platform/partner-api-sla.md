# Partner API service levels — PROPOSED

**Status: DRAFT / PROPOSED. This is not a contract, an offer, or a promise.** Every target below is a proposal derived from nothing more than the load-test thresholds in `load/k6/api-v1.load.js` and common practice. **No production measurements were available when this was written.** Anything marked **[VERIFY]** is an assumption to confirm with data. Anything marked **[COUNSEL]** needs legal review before a customer sees it. Do not quote these numbers externally until both are resolved.

Applies to: the public read-only API `api-v1` (`/calls`, `/leads`, `/jobs`), see `docs/PUBLIC_API_V2.md` and `/openapi.json`. Plans and limits: `docs/platform/api-usage-plans.md`.

## 1. What is measured, and from where

Existing source: `api_request_logs` (one row per **authenticated** request: status, latency, key, time). Retention: **30 days**.

| SLI | Definition | Source |
|---|---|---|
| Availability | `1 − server_errors / counted_requests` per calendar month (UTC). `server_errors` = HTTP 500–599. `counted_requests` = requests with status ≠ 429, any 4xx counted as successful service. | `api_request_logs` |
| Latency | p95 and p99 of `latency_ms` for requests with status < 400, per month | `api_request_logs` |
| Throttling | share of requests answered `429` (informational, not an SLI) | `api_request_logs` |

Per-account figures are available today from the existing usage summary RPCs. A platform-wide figure needs a service-role query across all keys.

### Known measurement gaps (**[VERIFY]** before any target is promised)

- If the function is unreachable (platform outage, DNS, TLS, cold-start timeouts) **no log row is written**, so a log-based availability figure **over-states** real availability. A real availability SLI needs an **external synthetic probe** against `api-v1` from outside the platform, which does not exist yet.
- Requests that fail authentication (401) are not attributed to a key and not logged.
- Logs are written best-effort after the response (`waitUntil`); a crash can lose a row.
- Latency is measured inside the function, not at the caller. It excludes network time.
- Retention is 30 days, so a monthly report must be produced and stored before the 30-day window moves on.

## 2. PROPOSED targets

| Target | Standard (developer / growth) | Partner |
|---|---|---|
| Monthly availability | 99.5% | 99.9% |
| p95 latency (reads, status < 400) | ≤ 800 ms | ≤ 800 ms |
| p99 latency | ≤ 1,500 ms | ≤ 1,500 ms |
| 5xx rate (excluding 429) | < 0.5% of requests | < 0.1% |

Basis: the latency and error thresholds equal the thresholds already asserted by the load test (`p(95)<800`, `p(99)<1500`, server errors `<0.005`). **Those are test thresholds against a test environment, not production results.** The availability figures are conventional tiers (about 3.6 h and 43 min of allowed downtime per 30-day month) chosen for discussion, not derived from Vireek data.

Rate limits and quotas are part of the service description, not outages: a `429` caused by exceeding the plan is **not** counted as unavailability.

## 3. Support and incident response (PROPOSED)

| Severity | Example | First response | Updates |
|---|---|---|---|
| 1 | API down or returning 5xx for most requests | 1 hour | every 60 min until mitigated |
| 2 | Elevated errors or latency, one resource affected | 4 business hours | every 4 hours |
| 3 | Question, non-urgent defect | 2 business days | on change |

**[VERIFY]** staffing: today there is no on-call rota or support desk evidenced in the repository for these windows. Do not offer them to partners until someone owns them. A public status page **[VERIFY]** (references to one exist in internal docs, none was confirmed as live). Post-incident summary within 5 business days for severity 1.

## 4. Change management

- **Versioning:** the API version header (`X-Vireek-Api-Version`) and the OpenAPI spec are the source of truth; the contract test blocks breaking changes without a major version bump.
- **Deprecation:** deprecated resources are announced with the `Deprecation` and `Sunset` headers (RFC 9745 / RFC 8594). PROPOSED minimum notice before removal: **90 days** for stable resources, 30 days for beta. **[COUNSEL]** if promised in a contract.
- **Maintenance:** PROPOSED: announced at least 72 hours ahead, outside US business hours where possible, excluded from availability up to 4 hours per month.

## 5. Exclusions (PROPOSED)

Not counted against the targets: planned maintenance within the allowance; failures of the customer's network, keys, IP allowlist or code; requests rejected for rate limit, quota, scope or validation (4xx); test-mode keys (`vrk_test_`); force majeure and failures of upstream providers outside Vireek's control **[COUNSEL]**; beta resources.

## 6. Remedies

Service credits, termination rights and liability limits **[COUNSEL]**. Nothing is defined here and nothing in the system calculates or applies credits. If credits are ever offered, the log-based availability figure in section 1 must not be the only evidence (see the measurement gaps).

## 7. Prerequisites before this can be offered

1. An external synthetic probe for `api-v1` and a stored monthly SLI report (owner needed).
2. Production data for latency and 5xx rate over at least one full month, then adjust section 2.
3. A named on-call owner and a status-page process for section 3.
4. Legal review of sections 4–6 **[COUNSEL]**.
5. A decision on pricing and overage (`docs/platform/api-usage-plans.md`, section 7).

## 8. Reference queries (per account, owner session)

The dashboard already exposes requests, errors, 429s and latency per key (`get_api_usage_summary`). A monthly availability figure for one account, as a service-role query:

```sql
select
  count(*) filter (where status <> 429)                                   as counted_requests,
  count(*) filter (where status between 500 and 599)                      as server_errors,
  round(100.0 * (1 - count(*) filter (where status between 500 and 599)::numeric
        / nullif(count(*) filter (where status <> 429), 0)), 3)           as availability_pct,
  percentile_cont(0.95) within group (order by latency_ms)
        filter (where status < 400)                                       as p95_ms
from public.api_request_logs
where user_id = '<owner uuid>'
  and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
  and created_at <  (date_trunc('month', now() at time zone 'utc') + interval '1 month') at time zone 'utc';
```
(Executed here: **NOT RUN**, no database was available.)
