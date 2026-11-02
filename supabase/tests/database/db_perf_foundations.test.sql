-- DB perf foundations: volatility, perf schema lockdown, auth-call wrapping, batched purge guards (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

select has_view('perf', 'duplicate_indexes', 'duplicate_indexes view exists');
select has_view('perf', 'unused_indexes', 'unused_indexes view exists');
select has_view('perf', 'missing_fk_indexes', 'missing_fk_indexes view exists');
select has_view('perf', 'table_health', 'table_health view exists');

select is(perf.wrap_auth_calls('(auth.uid() = user_id)'),
          '(( SELECT auth.uid() AS uid) = user_id)', 'wraps auth.uid()');
select is(perf.wrap_auth_calls('(( SELECT auth.uid() AS uid) = user_id)'),
          '(( SELECT auth.uid() AS uid) = user_id)', 'already wrapped stays unchanged');
select is(perf.wrap_auth_calls('(user_id = public.get_account_owner_id())'),
          '(user_id = ( SELECT get_account_owner_id() AS get_account_owner_id))', 'wraps qualified get_account_owner_id()');
select is(perf.wrap_auth_calls('((auth.jwt() ->> ''role''::text) = ''x''::text)'),
          '((( SELECT auth.jwt() AS jwt) ->> ''role''::text) = ''x''::text)', 'wraps auth.jwt()');

select is((select provolatile::text from pg_proc where oid = 'public.get_account_owner_id()'::regprocedure),
          's', 'get_account_owner_id() is STABLE');

select is(has_schema_privilege('anon', 'perf', 'USAGE'), false, 'anon has no access to perf');
select is(has_schema_privilege('authenticated', 'perf', 'USAGE'), false, 'authenticated has no access to perf');

select throws_ok($$call perf.purge_old_rows('profiles', interval '30 days')$$,
                 'P0001', 'table profiles is not allowed', 'purge rejects non-allowlisted tables');
select throws_ok($$call perf.purge_old_rows('vehicle_position_log', interval '1 day')$$,
                 'P0001', 'keep interval must be at least 7 days', 'purge rejects keep < 7 days');

create table public.zz_perf_t (id int primary key, user_id uuid not null);
alter table public.zz_perf_t enable row level security;
create policy zz_perf_sel on public.zz_perf_t for select to authenticated using (user_id = auth.uid());

select is((select count(*)::int from perf.rewrite_rls_initplan(false, 10, 'zz_perf_t')), 1, 'dry-run finds the unwrapped policy');
select is((select status from perf.rewrite_rls_initplan(true, 10, 'zz_perf_t')), 'rewritten', 'apply rewrites it');
select ok((select qual from pg_policies where tablename = 'zz_perf_t') like '%SELECT auth.uid()%', 'policy now uses InitPlan form');
select is((select count(*)::int from perf.rewrite_rls_initplan(false, 10, 'zz_perf_t')), 0, 'second run is a no-op (idempotent)');

select * from finish();
rollback;
