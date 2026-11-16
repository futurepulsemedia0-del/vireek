-- docs/perf/explain-hot-paths.sql
-- RUN ON STAGING ONLY (read-only; EXPLAIN ANALYZE executes the statement, all statements here are SELECTs).
--   psql "$STAGING_DB_URL" -v tenant="'<a staging tenant uuid with realistic volume>'" -f docs/perf/explain-hot-paths.sql > explain-out.txt
-- Decision rule: add an index (new additive migration) ONLY if a plan shows a Seq Scan / Sort node dominating
-- time on > ~10k rows AND the same plan reproduces with the tenant's real volume. Attach explain-out.txt to the PR.
-- NOTE: RLS is applied for non-superusers; to measure what the app sees, run as the authenticated role:
--   begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :tenant::text, 'role','authenticated')::text, true);

\echo '== 1. dashboard: latest calls (idx_calls_user_datetime (user_id, call_datetime desc) exists)'
explain (analyze, buffers) select * from calls where user_id = :tenant order by call_datetime desc limit 2000;

\echo '== 2. dashboard: latest jobs'
explain (analyze, buffers) select * from jobs where user_id = :tenant order by created_at desc limit 2000;

\echo '== 3. dashboard: leads / insights'
explain (analyze, buffers) select * from leads where user_id = :tenant order by created_at desc limit 2000;
explain (analyze, buffers) select * from ai_insights where user_id = :tenant and is_dismissed = false order by created_at desc limit 200;

\echo '== 4. webhook ledger lookup (unique key claim)'
explain (analyze, buffers) select id, status, attempts, updated_at from voice_webhook_events where user_id = :tenant and vapi_call_id = 'k6dup-probe' and event_type = 'end-of-call-report';

\echo '== 5. fallback call upsert key'
explain (analyze, buffers) select id from calls where vapi_call_id = 'twilio:CA00000000000000000000000000000000';

\echo '== 6. reconcile: recent internal calls window'
explain (analyze, buffers) select vapi_call_id, duration_seconds from calls where user_id = :tenant and call_datetime > now() - interval '48 hours';

\echo '== 7. index inventory for the hot tables'
select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in ('calls','jobs','leads','ai_insights','voice_webhook_events','voice_fallback_calls') order by 1, 2;
