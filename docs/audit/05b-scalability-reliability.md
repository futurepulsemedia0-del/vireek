# Task 5B — Reliability, performance, scalability, privacy/enterprise readiness
Date: 2026-11-09 · Mode: read-only, static only · Inputs: 05a + uploaded ZIP snapshot (no .git; may differ from the live tree)
Tags: [VC]=VERIFIED-CODE · [A]=ASSUMPTION · [E]=ESTIMATE · [R]=RECOMMENDATION. **No query, test or load run was executed** (no Postgres, no Deno, no network): every timing statement is NOT RUN.

## 0. Readiness verdict (estimates, not measurements)
| Tier | Verdict | Limiting bottleneck | Evidence |
|---|---|---|---|
| 100 customers | **Ready with fixes** | Environment reproducibility and recovery, not load: 123 duplicate migration versions make a clean rebuild/DR restore unreliable; RTO/RPO never measured; DB tests and perf jobs are non-blocking in CI | E-023, E-024, E-031 |
| 1,000 customers | **Not ready** | Unbounded telemetry growth (GPS ≈480M rows/yr [A], retention not scheduled), per-row RLS evaluation (InitPlan rewrite not applied by any migration), all-tenant cron scans, 320 tenant tables with no leading tenant index (static), backup covers ≈17 of ≈1500 tables | E-026–E-031 |
| 10,000 customers | **Not ready** | Everything above plus ≈4.8B GPS rows/yr and ≈53 TB/yr photos [A], ≈21k concurrent realtime connections each evaluating RLS, ≈115 edge req/s at business-hour peak, LLM spend/rate limits unreviewed | E-037, E-038 |
Basis: [E]. Maturity of the capability "operate at scale": **L2** (mechanisms exist: perf schema, outbox/DLQ, drill functions, k6; none proven by execution).

## 1. Load model (assumptions are mine; replace with real data)
A1 6 users/account (4 technicians). A2 3 jobs/tech/day, 250 days. A3 3 photos/job × 0.6 MB (no client-side compression found by grep). A4 5 notifications/job. A5 2 LLM calls/job + 6 voice calls/account/day × 10 LLM turns. A6 35% of users online in business hours, 3 realtime channels each. A7 one GPS ping/min/truck, 8 h/day, 1 truck/tech. A8 20 edge invocations/job + 15/voice call. A9 10 event/audit rows/job.

| Metric | 100 | 1,000 | 10,000 |
|---|---|---|---|
| Jobs/year | 300k | 3M | 30M |
| Photos/year · storage/year | 0.9M · 527 GB | 9M · 5.3 TB | 90M · 52.7 TB |
| GPS rows/year (`vehicle_position_log`) | 48M | 480M | 4.8B |
| Event/audit rows/year | 3M | 30M | 300M |
| Notifications/day | 6k | 60k | 600k |
| Edge invocations/day (excl. cron) | 33k (~1.1/s peak) | 330k (~11.5/s) | 3.3M (~115/s) |
| LLM calls/day | 8.4k | 84k | 840k |
| Realtime connections · channels | 210 · 630 | 2.1k · 6.3k | 21k · 63k |
| Cron baseline | 83 active jobs (E-030), 44 hit edge functions; ≈6.3k invocations/day if ~10-min average [E] — constant in tenant count except all-tenant scans | same | same, but scan cost is linear in tenants |
DB connections: client traffic goes through PostgREST/pooler; only functions using `SUPABASE_DB_URL` (e.g. the restore drill) open direct connections [VC, partial]. No `[db.pooler]` or `max_rows` config in the repo (E-029) → hosted defaults apply [A]; plan limits for realtime/pooler/storage NOT VERIFIED.

## 2. Bottlenecks and findings
| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| P-01 | **High** | 123 duplicate 14-digit migration versions (up to 23 files per version) plus malformed names. The CLI records one row per version, so `db push` / fresh rebuild / DR re-creation is not reliably reproducible. CI itself defers gates "until duplicate versions are resolved". A renumber script and runbook exist but renames are not applied in this snapshot. | E-023, E-024 | Run `scripts/migrations-dedupe.mjs` plan→apply, `supabase db reset` locally, repair environments per runbook, then make DB tests blocking. | M |
| P-02 | High [E] | RLS predicate `col = get_account_owner_id()` on ≈1,030 policies is not wrapped for InitPlan. The function is made STABLE, and a dry-run-first rewrite tool exists, but nothing applies it; the ops file is manual. Whether production has it applied is UNKNOWN. | E-026 | Run `perf.rewrite_rls_initplan(false)` report, apply in batches on staging with EXPLAIN before/after, add a pgTAP/CI check for unwrapped calls. | M |
| P-03 | High | GPS breadcrumbs: retention exists only as a comment; ops purge is commented; no partitioning; one (vehicle_id, recorded_at) index. | E-027, E-038 | Time-partition by day/week + scheduled drop; schedule `perf.purge_old_rows`; alert on table size. | M |
| P-04 | Medium–High [E] | Index coverage: 320 of 1488 tenant-keyed tables lack a leading tenant/PK/unique index by static heuristic; 77 growth-prone (e.g. `siem_delivery_log`, `call_trace_events`, `rich_messages`, `marketing_event_queue`, `pbx_access_log`, `*_sync_log`, `*_events`). Heuristic ignores indexes on other leading columns; core tables (`jobs`, `customers`, `invoices`, `job_photos`) are covered. | E-028 | Run `perf.fk_unindexed`/`unused_indexes` views on a seeded DB; add (tenant, created_at) indexes where EXPLAIN shows seq scans. | M |
| P-05 | Medium | Client queries: 657 of 1929 select chains have no limit/range/single; 576 `select('*')`; worst `team_members` (49), `jobs` (20), `customers` (19). With hosted PostgREST default 1000-row cap [A] large accounts get silently truncated lists, not errors. 143 polling intervals; 8 await-in-loop N+1 hints. | E-029 | Paginate lists (keyset), column-select hot paths, replace polling with realtime/refetch-on-focus where cheap. | M |
| P-06 | Medium | 16 cron entries run all-tenant SQL (`service_twin_scan` */5, `arp_scan_all` */10, `run_replenishment_all` hourly …): linear in tenants, single worker, no per-tenant batching or statement_timeout seen [A]. | E-030 | Batch by tenant id range with a cursor, per-batch timeout, overlap guard, duration metric per job. | M |
| P-07 | **High** (1k+) | Backups: PITR not confirmed in repo; logical backup ≈17 of ≈1500 tables; drill verifies ≤3 tables × 500 rows; `rto_seconds` is verification time, not RTO. The doc itself says RTO/RPO were never measured. | E-031 | Confirm PITR on the real project, run a full restore into a branch/new project, record RTO/RPO in the doc table; extend or drop logical backup. | M |
| P-08 | Medium | CI gates: DB tests and benchmarks are non-blocking; migration rehearsal is lint-only without `REHEARSAL_DB_URL`; k6 covers api-v1 (≤100 VUs) and webhook soak, not dispatch/calendar/dashboard/search. | E-024, E-025, E-032 | Make DB tests blocking after P-01; add k6 scenarios for top reads; set `REHEARSAL_DB_URL`. | M |
| P-09 | Medium [A] | Realtime: 76 tables in the publication; each change is RLS-checked per subscriber; at ≈21k connections [A] this is a scaling cliff. Plan limits unknown. | E-037 | Narrow publication to needed tables/columns; per-tenant channels; verify plan quotas. | M |
| P-10 | Medium | Migration safety: 300 `ADD COLUMN … NOT NULL DEFAULT` (cheap on PG ≥11 for constant defaults, unverified per case), 2 `ALTER COLUMN TYPE` (table rewrite risk), index creation uses `CONCURRENTLY` in 1 of ≈2900 statements, `lock_timeout` in 5 files. On large tables plain `CREATE INDEX` blocks writes. | E-039 | Add `lock_timeout` + `CONCURRENTLY` rules to `lint-migrations.mjs` for tables > N rows. | S |
| P-11 | Low–Med | Observability: Sentry client, `slo-evaluate`, `synthetic-probe`, `voice-health-tick`, runbooks (incident, voice resilience, synthetic monitoring) exist [VC]. Alert routing and on-call actually receiving pages NOT VERIFIED. Third-party outage behavior: 67 files mention fallback/circuit terms, 115 use abort/timeouts, outbox has retry+DLQ (E-033); per-provider behavior (Stripe/Twilio/LLM down) NOT RUN. | E-033 | Fault-injection drill per provider (mock) and record outcome. | M |
Not findings: outbox/DLQ with backoff and replay exists (E-033); `get_account_owner_id` is pinned STABLE (E-026).

## 3. Top-20 hot queries — status
Static ranking only (E-029): `jobs` (92 call sites), `team_members` (62), `customers` (55), `business_profile` (36), `calls` (28), `equipment` (24), `profiles`, `job_equipment`, `invoices`, `quotes`. The specific dispatch/calendar/dashboard SQL was not extracted into an EXPLAIN list. **NOT RUN**: EXPLAIN (ANALYZE) at 100/1k/10k synthetic tiers. Needed: a local/staging Postgres with migrations applied (P-01 must be fixed first). Template: seed N accounts, then run EXPLAIN on `jobs` by (tenant, date range), `customers` search, unread notifications, calendar week. Script not yet written into `proposed-tests/` for these queries (honest gap); existing `scripts/db-audit.mjs` and `perf.*` views are the starting point.

## 4. Privacy and enterprise
REQUIRES COUNSEL for every legal conclusion; below is engineering evidence only.
| ID | Sev | Finding | Evidence |
|---|---|---|---|
| V-01 | High | Erasure coverage: DSAR/sweep erase 15 `OWNED_TABLES`; the repo's own gap list counts ≈1,200 tables with `user_id` and ≈277 with obvious cascade [claim to verify, not re-counted]. Deletion of the auth user may cascade further; unverified. Storage-file removal is a stub comment in `delete-account`. | E-034 |
| V-02 | Medium | Gap-list items E1/E2 (missing import → ReferenceError) are **stale**: the imports now exist [VC]. Provider-side erasure (`eraseProviderData`) now exists; actual effect on Vapi/Twilio/ElevenLabs/Resend NOT RUN. Treat the other gap-list items (region CHECK `us|eu|ca` only; US-area-code recording consent; 13 providers missing on the subprocessor page; manual access/correct DSAR) as **claims to verify**, not re-verified here. | E-034 |
| V-03 | Medium | Data residency: described as unenforced in the gap list; LLM chain US-only (claim). No enforcement probe run. | E-034 |
| V-04 | Medium | SSO/SAML via auth admin API and SCIM v2 exist in code; SIEM streaming (Splunk HEC/Datadog) exists with URL validation. None executed against a real IdP/sink, so "enterprise-ready" is unproven (L2). | E-035 |
| V-05 | Low–Med | PII in logs: subscriber email logged on failure; 29 console lines match PII patterns; Sentry/GA scrubbing unverified (gap list E15). | E-036 |
| V-06 | Medium | SOC2-style gaps (high level): change management weakened by non-blocking CI (E-024); recovery objectives unmeasured (E-031); vendor/subprocessor inventory incomplete per gap list; access-review and audit-log retention evidence not inspected; `compliance-evidence.yml` workflow exists but was not reviewed. | E-024, E-031, E-034 |
Call-recording consent: rule packs and `voice-consent` exist; jurisdiction coverage not verified. REQUIRES COUNSEL.

## 5. Ranked bottleneck list (what limits you first)
1. P-01 migration versions (M) — blocks reliable rebuild, DR and blocking CI.
2. P-07 restore capability unmeasured (M).
3. P-03 GPS retention/partitioning (M).
4. P-02 RLS InitPlan rewrite (M).
5. V-01 erasure coverage (M–L).
6. P-04 missing indexes on growth tables (M).
7. P-06 all-tenant cron scans (M).
8. P-05 unbounded client lists / 1000-row cap (M).
9. P-09 realtime fan-out (M).
10. P-08 CI gates and load scenarios (M).

## 6. Monitor first
`vehicle_position_log` and other `*_log/*_events` table sizes and growth; `pg_stat_statements` top queries by total time (`perf.top_queries`); cron job duration and overlap (`cron.job_run_details`); edge function error rate/p95 and outbox `dead` count; realtime concurrent connections; storage growth/day; backup age and last restore-drill result; LLM calls and cost per tenant.

## Evidence index
E-023 … E-038 (new in 5B) and E-001 … E-022 in `docs/audit/evidence-ledger.md`.

## NOT RUN / BLOCKED
- NOT RUN: all EXPLAIN/ANALYZE and synthetic-data tiers; `scripts/db-audit.mjs`; k6; pgTAP; restore drill; provider fault injection; SSO/SIEM/DSAR end-to-end.
- BLOCKED: live Supabase plan limits, PITR status, applied-migration state in staging/production, real traffic numbers, Sentry/alert routing configuration, git history (no .git).
- Not reviewed: ≈430 edge functions beyond sampled greps; LLM budget/rate-limit enforcement (10 files mention caps); storage bucket quotas; the exact dispatch/calendar/dashboard SQL.

## Questions only the founder can answer
1. Are the renumbered migrations already applied in staging/production (i.e., does `schema_migrations` hold old or new versions)?
2. Is PITR enabled on the production project, and has any full restore ever been timed?
3. Has `perf.rewrite_rls_initplan` / the telemetry purge from `supabase/ops/` ever been run in production?
4. Real numbers today: accounts, technicians per account, jobs/day, photos/job, GPS ping interval, voice calls/day.
5. Which Supabase plan/compute size, and which realtime/pooler limits apply?
6. Do you intend EU/UK/CA customers within 12 months (drives V-01..V-03 priority)?
