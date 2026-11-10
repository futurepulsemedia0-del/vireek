# Evidence ledger — Task 5A (2026-11-09)
Snapshot: `vireek-main__1_.zip` unpacked read-only; no .git, so it is NOT proven to equal the current working tree. Tools: python3 regex scans (heuristic), grep, sed. No DB, no Deno, no network.

| ID | Claim | Location | Command / result |
|---|---|---|---|
| E-001 | 730 .sql migrations (+ `split/` dir, 6 files) | supabase/migrations | `ls \| wc -l` → 731 entries; parser read 730 |
| E-002 | Static parse: 1841 tables, 1698 with RLS enabled in plain DDL, 143 without | migrations | work/mig.py (regex) |
| E-003 | 142 of those 143 enable RLS via `FOREACH … EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY')`; remaining 1 (`sensitive_read_log_default`) is a partition of `sensitive_read_log` | e.g. 20271110000000_business_phone_system.sql:409, 20280501000000_voice_security_controls.sql:167, 20281103000000_sensitive_read_access_log.sql:61 | grep + parse. Policy predicates inside loops are NOT statically resolvable |
| E-004 | 2607 policies parsed; 47 `USING (true)` SELECT, 6 `WITH CHECK (true)` INSERT, 4 UPDATE/ALL w/o explicit WITH CHECK (PG reuses USING, so not a gap) | migrations | mig.py |
| E-005 | 79 views, 25 without `security_invoker`; bi_* use `security_barrier` + `bi_tenant_id()` filter; two checked views REVOKEd from anon/authenticated | 20280120000000_bi_export.sql:277-290; 20290102…:635; 20281103…growth:215 | grep |
| E-006 | 3245 SECURITY DEFINER functions; parser found 0 lacking `SET search_path` | migrations | mig.py (header regex) |
| E-007 | 903 definer functions have no static `REVOKE … FROM PUBLIC/anon` (274 triggers, 410 contain an auth-guard keyword, 219 neither). Voice (`FOREACH f … REVOKE`) and service-graph (`EXECUTE format('REVOKE ALL…')`) are covered by dynamic loops → count overstated | 20280501000000_voice_security_controls.sql:472-481; 20261231000100_service_graph*.sql:1142 | work/unrev.json, unguarded.json |
| E-008 | `activate_weather_surge(p_user_id …)` SECURITY DEFINER, no caller check, only `GRANT … TO service_role`, zero REVOKE mentions anywhere | 20260929000000_weather_surge_intelligence.sql:152-211 | `grep -iE revoke *.sql \| grep -c name` → 0 |
| E-009 | Same pattern, zero REVOKE: `claim_agent_task`, `create_agent_task`, `compute_market_intelligence`, `enqueue_marketplace_event`, `record_weather_alert` | 20261203000000_agent_company_tasks.sql:140; others | same grep → 0 each |
| E-010 | 59 unguarded-by-keyword definer RPCs explicitly granted to `anon` (token-based portal/booking/landing RPCs), incl. `get_dashboard_snapshot(text)`, `get_job_room`, `get_project_progress` | migrations | rows.json |
| E-011 | 54 functions `verify_jwt=false` in config.toml | supabase/config.toml | regex |
| E-012 | Fail-closed signature/secret checks read in: messenger-webhook (Meta HMAC), telegram-webhook (per-connection secret), rich-webhook (Sinch), talent-background-webhook (Checkr HMAC), pbx-voice & voice-front-door (Twilio sig), bank-webhook (Plaid), stripe-webhook (constructEventAsync), release-guard-tick / agent-caller-sweep / closeout-deadline-engine / invoice-followup-ladder (cron secret, timing-safe), ovb-run (cron secret or staff JWT) | functions/*/index.ts | read |
| E-013 | `whatsapp-webhook` POST has no signature check (only GET verify-token); uses service role; looks up tenant by client-supplied `phone_number_id`; writes `dm_messages`; sends reply via tenant access token | functions/whatsapp-webhook/index.ts:23-60 | read; grep for x-hub-signature/app_secret/sha256 → none |
| E-014 | stripe-webhook inserts event id (dedupe) BEFORE side effects; on handler error logs and returns 200 → retries hit dedupe and are dropped | functions/stripe-webhook/index.ts:190-215, 356-367 | read |
| E-015 | email-webhook auth = shared secret in URL query string; header says "NOT LIVE-VERIFIED" | functions/email-webhook/index.ts:1-12, 30 | read |
| E-016 | Secret-shaped scan: hits are test fixtures and `sk_live_…`/`whsec_…` placeholders in comments; no live secret found (values redacted) | repo | grep -I |
| E-017 | 3 `dangerouslySetInnerHTML`, 2 in PodcastPage on static literals | src/pages/PodcastPage.tsx:232-233 | read |
| E-018 | 328 functions send `Access-Control-Allow-Origin: *` | functions | grep |
| E-019 | Malformed/ambiguous migration names: `<timestamp>_daily_briefing.sql`, `20260915_phone_numbers.sql`, `20260916_job_cost_entries.sql`; 3 files dated 2029 | supabase/migrations | `ls \| grep -vE '^[0-9]{14}_'` |
| E-020 | Existing DB tests: 72 files in supabase/tests/database incl. `rls_catalog.test.sql`; 65 test files use role/JWT impersonation | supabase/tests | ls/grep (NOT RUN) |
| E-021 | `.env` shipped in zip: anon-role JWT (decoded role=`anon`), Sentry DSN, VAPID public key; `.gitignore` lists `.env` | .env, .gitignore:16 | decode role only |
| E-022 | Authenticated edge-function pattern: caller-scoped client → `auth.getUser()` → `rpc('get_account_owner_id')` → `rpc('can_manage_*')` (ns-connect, intacct-connect) | functions/ns-connect/index.ts:36-45 | read |

## Task 5B additions (2026-11-09)
| ID | Claim | Location | Command / result |
|---|---|---|---|
| E-023 | 123 duplicate 14-digit migration versions (max 23 files share `20270402000000`); CI comment and a runbook acknowledge it; renumber script exists but renames are NOT applied in this snapshot | supabase/migrations; .github/workflows/db-perf.yml:35; docs/runbooks/migration-version-repair.md | `ls \| cut -c1-14 \| sort \| uniq -d \| wc -l` → 123 |
| E-024 | `database-tests` and DB benchmark jobs are `continue-on-error: true` | .github/workflows/database-tests.yml:29; db-perf.yml:35 | read |
| E-025 | migration-rehearsal does only a lint unless `REHEARSAL_DB_URL` is set | .github/workflows/migration-rehearsal.yml:31-45 | read |
| E-026 | Dominant RLS predicate `col = public.get_account_owner_id()` (892 + 140 policies) is not InitPlan-wrapped; the perf migration only makes the function STABLE and ships a dry-run rewrite tool: "Nothing here is scheduled or applied automatically" | 20280402000000_db_perf_foundations.sql:1-15; supabase/ops/20261102_db_perf_ops.sql:25-34 | mig.py predicate histogram; read |
| E-027 | `vehicle_position_log` retention exists only inside a comment block; `perf.purge_old_rows` scheduling is also commented in ops | 20270215000000_real_telematics_os.sql:130, 409-414; supabase/ops/20261102_db_perf_ops.sql:34 | read |
| E-028 | Static index heuristic: 1488 tenant-keyed tables, 320 without leading tenant/PK/unique index, 77 growth-prone (log/event/history/queue names) | migrations | python regex (false positives possible: joins via job_id etc.) |
| E-029 | Client query scan of src/: 1929 select chains, 657 without limit/range/single, 576 `select('*')`; hottest tables jobs 92, team_members 62, customers 55; 143 `refetchInterval/setInterval`; 8 await-in-loop N+1 hints; no `max_rows`/pooler config in supabase/config.toml | src/**/*.ts(x); supabase/config.toml | python regex + grep |
| E-030 | 117 `cron.schedule(` calls; catalog: 83 active, 13 commented, 27 unschedules; 44 cron entries use `net.http_post`; 16 call all-tenant `*_all/scan/sweep` SQL functions (e.g. `service_twin_scan` */5, `arp_scan_all` */10) | docs/generated/CRON_CATALOG.md:7; migrations | grep |
| E-031 | RTO/RPO never measured; PITR not confirmed in repo; logical backup ≈17 of ≈1500 tables; drill restores ≤3 tables × 500 rows | docs/DB_BACKUP_RESTORE.md:3,9-11; functions/dr-restore-drill/index.ts:120-158 | read |
| E-032 | k6 covers api-v1 (≤100 VUs) and webhook soak only; no dispatch/calendar/dashboard scenario | load/k6/*.js; .github/workflows/k6-load.yml | read |
| E-033 | webhook-outbox-worker: backoff+jitter, DLQ ('dead') and replay | functions/webhook-outbox-worker/index.ts:5-6 | read |
| E-034 | Privacy functions exist (dsar-request, delete-account, data-retention-sweep, tenant-export, voice-consent, scim-v2, admin-sso, siem-stream, subprocessor-notice-dispatch). Gap list E1/E2 are STALE: `eraseTrustPackData` and `eraseProviderData` are now imported | functions/delete-account/index.ts:16-18,77; data-retention-sweep/index.ts:19-21,130; docs/compliance/gap-list.md:10-15 | read |
| E-035 | `admin-sso` registers SAML via the auth admin API; `siem-stream` targets Splunk HEC / Datadog with URL validation | functions/admin-sso/index.ts:53-59; siem-stream/index.ts:3,42 | read (not executed) |
| E-036 | PII (subscriber email) written to function logs on send failure; 29 console.* lines match phone/email/transcript patterns | functions/notify-status-subscribers/index.ts:167,171 | grep |
| E-037 | 76 `ALTER PUBLICATION supabase_realtime ADD TABLE`; 12 `.channel(` and 14 `postgres_changes` in src | migrations; src | grep |
| E-038 | Load model arithmetic | script run in session | python3, assumptions A1–A9 in 05b §1 |
| E-039 | Migration safety counts: 300 `ADD COLUMN … NOT NULL DEFAULT`, 2 `ALTER COLUMN … TYPE`, 2901 CREATE INDEX statements of which 1 uses CONCURRENTLY, `lock_timeout` in 5 files | supabase/migrations | grep -ihE counts, session 2026-11-09 |
