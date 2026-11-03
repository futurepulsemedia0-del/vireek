-- State of Home Service Calls: consent, exclusion, k-masking, constraint floor, tenant isolation (pgTAP).
-- Run with:  supabase test db
-- The numbers asserted for the aggregate come from the TypeScript oracle fixture
-- (supabase/functions/_shared/state-of-calls/state-of-calls.test.ts, "known values"): 3 orgs, 100/200/300 calls,
-- 10/40/30 missed => pooled answer rate 86.67, org p25 85, p50 90.
begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@soc.test'), ('00000000-0000-0000-0000-0000000000a2', 'b@soc.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'c@soc.test'), ('00000000-0000-0000-0000-0000000000a4', 'd-no-consent@soc.test');

-- calls: January 2026
insert into public.calls (user_id, call_datetime, status)
select u, '2026-01-10 12:00+00', case when i <= m then 'missed' else 'new_lead' end
  from (values ('00000000-0000-0000-0000-0000000000a1'::uuid, 100, 10), ('00000000-0000-0000-0000-0000000000a2', 200, 40),
               ('00000000-0000-0000-0000-0000000000a3', 300, 30), ('00000000-0000-0000-0000-0000000000a4', 500, 0)) t(u, n, m),
       generate_series(1, n) i;
insert into public.calls (user_id, call_datetime, status)
select '00000000-0000-0000-0000-0000000000a1', '2026-01-11 12:00+00', 'spam' from generate_series(1, 50);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end; $$;

-- 1-3 consent: default off, owner can grant, idempotent
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((public.get_report_contribution() ->> 'status'), 'not_set', 'default is not contributing');
select is((public.set_report_contribution(true, 'v1') ->> 'changed')::boolean, true, 'owner can grant');
select is((public.set_report_contribution(true, 'v1') ->> 'changed')::boolean, false, 'granting twice is a no-op (idempotent)');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2'); select public.set_report_contribution(true, 'v1');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3'); select public.set_report_contribution(true, 'v1');
reset role;

-- 4 ledger has exactly one row per real change
select is((select count(*)::int from public.report_consent_events where account_owner_id = '00000000-0000-0000-0000-0000000000a1'), 1, 'one ledger row per change');

-- 5-6 aggregate: only consenting orgs, spam excluded, known values
select is((select n_orgs from public.report_build_raw_cells('2026', '2026-01-01', '2027-01-01', 1) where metric_key = 'answer_rate' and dim = 'national'), 3, 'non-consenting org excluded');
select ok((select abs(pooled_value - 86.6667) < 0.001 and org_p25 = 85 and org_p50 = 90 and n_events = 600
             from public.report_build_raw_cells('2026', '2026-01-01', '2027-01-01', 1) where metric_key = 'answer_rate' and dim = 'national'), 'SQL equals the TypeScript oracle');

-- 7 k-masking inside the database
select ok((select n_orgs = 0 and pooled_value is null and org_p50 is null from public.report_build_raw_cells('2026', '2026-01-01', '2027-01-01', 10) where metric_key = 'answer_rate' and dim = 'national'), 'cell below k is masked in SQL');

-- 8 revocation excludes the org from the next build
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3'); select public.set_report_contribution(false);
reset role;
select is((select n_orgs from public.report_build_raw_cells('2026', '2026-01-01', '2027-01-01', 1) where metric_key = 'answer_rate' and dim = 'national'), 2, 'revoked org excluded going forward');

-- 9 pending account deletion excludes the org
insert into public.deletion_requests (user_id, request_type) values ('00000000-0000-0000-0000-0000000000a2', 'full_account');
select is((select n_orgs from public.report_build_raw_cells('2026', '2026-01-01', '2027-01-01', 1) where metric_key = 'answer_rate' and dim = 'national'), 1, 'org with a pending deletion is excluded');

-- 10-11 database floor: a published cell under 10 orgs is impossible
insert into public.report_editions (id, slug, title, kind, period_key, period_start, period_end, as_of, method_version, cells_hash, thresholds, document)
values ('00000000-0000-0000-0000-00000000e001', 'test-2026', 'Test', 'annual', '2026', '2026-01-01', '2026-12-31', now(), 'soc-1.0.0', repeat('a', 64), '{}', '{}');
select throws_ok($$insert into public.report_cells (edition_id, metric_key, dim, dim_value, period_key, unit, suppressed, n_orgs, n_events, value)
  values ('00000000-0000-0000-0000-00000000e001', 'answer_rate', 'national', 'all', '2026', 'percent', false, 9, 500, 80)$$, '23514', null, 'published cell with 9 orgs rejected');
select throws_ok($$insert into public.report_cells (edition_id, metric_key, dim, dim_value, period_key, unit, suppressed, value)
  values ('00000000-0000-0000-0000-00000000e001', 'answer_rate', 'national', 'all', '2026', 'percent', false, 80)$$, '23514', null, 'published cell with NULL n_orgs rejected');

-- 12 finer geography is rejected
select throws_ok($$insert into public.report_cells (edition_id, metric_key, dim, dim_value, period_key, unit, suppressed, suppression_reason)
  values ('00000000-0000-0000-0000-00000000e001', 'answer_rate', 'region', 'tx', '2026', 'percent', true, 'k_anonymity')$$, '23514', null, 'state-level region rejected');

-- 13 publish requires sign-off
select throws_ok($$select public.report_publish_edition('00000000-0000-0000-0000-00000000e001', repeat('a', 64))$$, '55000', null, 'publish blocked without legal + fact-check sign-off');

-- 14-15 isolation: clients cannot read the tables or call internals
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select * from public.report_cells$$, '42501', null, 'authenticated users cannot read report_cells');
select throws_ok($$select * from public.report_build_raw_cells('2026', '2026-01-01', '2027-01-01', 1)$$, '42501', null, 'authenticated users cannot run the aggregator');

select * from finish();
rollback;
