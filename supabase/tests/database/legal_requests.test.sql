-- Legal request log: staff-only RLS, no delete, write-time normalisation, integrity constraints, audit trail
-- and the counts view (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(50);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'staff@vireek.test'),
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test');
insert into public.profiles (id, plan, created_at, is_staff) values
  ('00000000-0000-0000-0000-0000000000c1', 'starter', now() - interval '60 days', true),
  ('00000000-0000-0000-0000-0000000000a1', 'pro', now() - interval '60 days', false);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ---------- structure (as the test superuser) ----------
select ok((select relrowsecurity from pg_class where oid = 'public.legal_requests'::regclass), 'RLS is enabled on legal_requests');
select policies_are('public', 'legal_requests',
  array['legal_requests_staff_select', 'legal_requests_staff_insert', 'legal_requests_staff_update'],
  'exactly three staff policies exist and there is no delete policy');
select ok(not has_table_privilege('authenticated', 'public.legal_requests', 'DELETE'), 'authenticated has no DELETE privilege');
select ok(not has_table_privilege('authenticated', 'public.legal_requests', 'TRUNCATE'), 'authenticated has no TRUNCATE privilege');
select ok(not has_table_privilege('anon', 'public.legal_requests', 'SELECT'), 'anon has no SELECT on the table');
select ok(not has_table_privilege('anon', 'public.legal_requests_counts', 'SELECT'), 'anon has no SELECT on the counts view');
select ok((select coalesce(reloptions @> array['security_invoker=true'], false) from pg_class where oid = 'public.legal_requests_counts'::regclass),
  'the counts view runs with the caller''s rights (security_invoker)');

-- ---------- staff: inserts and normalisation ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');

select lives_ok($$ insert into public.legal_requests (reference, request_type, jurisdiction_country, jurisdiction_region, requesting_authority, received_on, due_on,
    scope_summary, data_categories, accounts_affected, nondisclosure_order, outcome, closed_on, counsel_reviewed_on)
  values ('  LR-2024-001 ', 'subpoena', ' us ', ' California ', '  Example Court ', '2024-02-10', '2024-03-10',
    '  Subscriber info for one account  ', array['subscriber_info', 'subscriber_info', 'call_metadata'], 1, true, 'complied_in_part', '2024-03-01', '2024-02-20') $$,
  'staff can log a request');
select lives_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary, outcome, closed_on)
  values ('court_order', 'DE', 'Example Regional Court', '2024-03-05', 'Order about one account', 'objected', '2024-04-01') $$,
  'staff can log an objected request');
select lives_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, due_on, scope_summary)
  values ('subpoena', 'US', 'Example Agency', '2024-08-01', '2024-09-01', 'Records request, scope under review') $$,
  'staff can log a pending request');
select lives_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary, accounts_affected, outcome, closed_on)
  values ('emergency_disclosure', 'US', 'Example Police Dept', '2024-08-15', 'Emergency request', 2, 'complied_in_full', '2024-08-16') $$,
  'an emergency disclosure may be logged without a prior counsel review date');
select lives_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary, outcome, closed_on)
  values ('subpoena', 'US', 'Example Agency', '2024-02-25', 'Request for call metadata', 'no_data_found', '2024-03-02') $$,
  'staff can log a no-data-found request');

select is((select reference from public.legal_requests where requesting_authority = 'Example Court'), 'LR-2024-001', 'reference is trimmed');
select is((select jurisdiction_country from public.legal_requests where requesting_authority = 'Example Court'), 'US', 'country code is upper-cased');
select is((select jurisdiction_region from public.legal_requests where requesting_authority = 'Example Court'), 'California', 'region is trimmed');
select is((select scope_summary from public.legal_requests where requesting_authority = 'Example Court'), 'Subscriber info for one account', 'scope summary is trimmed');
select is((select data_categories from public.legal_requests where requesting_authority = 'Example Court'), array['call_metadata', 'subscriber_info'], 'categories are de-duplicated and sorted');
select is((select created_by from public.legal_requests where requesting_authority = 'Example Court'), '00000000-0000-0000-0000-0000000000c1'::uuid, 'created_by defaults to the caller');
select is((select customer_notice from public.legal_requests where requesting_authority = 'Example Court'), 'pending_counsel', 'customer notice defaults to pending_counsel');

-- ---------- staff: integrity constraints ----------
select throws_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary, outcome, closed_on)
  values ('subpoena', 'US', 'A', '2024-05-01', 's', 'complied_in_full', '2024-05-02') $$,
  '23514', null, 'disclosure without a counsel review date is rejected');
select throws_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary, closed_on)
  values ('subpoena', 'US', 'A', '2024-05-01', 's', '2024-05-02') $$,
  '23514', null, 'a pending request cannot have a close date');
select throws_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary, outcome)
  values ('subpoena', 'US', 'A', '2024-05-01', 's', 'objected') $$,
  '23514', null, 'a closed outcome needs a close date');
select throws_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary)
  values ('subpoena', 'USA', 'A', '2024-05-01', 's') $$,
  '23514', null, 'a country must be a two-letter code');
select throws_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, due_on, scope_summary)
  values ('subpoena', 'US', 'A', '2024-05-10', '2024-05-01', 's') $$,
  '23514', null, 'a due date before the received date is rejected');
select throws_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary, data_categories)
  values ('subpoena', 'US', 'A', '2024-05-01', 's', array['everything']) $$,
  '23514', null, 'a data category outside the vocabulary is rejected');
select throws_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary, accounts_affected, outcome, closed_on)
  values ('subpoena', 'US', 'A', '2024-05-01', 's', 3, 'objected', '2024-05-02') $$,
  '23514', null, 'accounts affected need a disclosing outcome');
select throws_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary, accounts_affected)
  values ('subpoena', 'US', 'A', '2024-05-01', 's', -1) $$,
  '23514', null, 'a negative account count is rejected');
select throws_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary)
  values ('subpoena', 'US', 'A', '2024-05-01', '   ') $$,
  '23514', null, 'a blank scope summary is rejected');
select throws_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary)
  values ('subpoena', 'US', 'A', current_date + 30, 's') $$,
  '22023', null, 'a received date in the future is rejected');
select throws_ok($$ insert into public.legal_requests (reference, request_type, jurisdiction_country, requesting_authority, received_on, scope_summary)
  values ('lr-2024-001', 'subpoena', 'US', 'A', '2024-05-01', 's') $$,
  '23505', null, 'a duplicate reference is rejected case-insensitively');
select throws_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary, created_by)
  values ('subpoena', 'US', 'A', '2024-05-01', 's', '00000000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'a row cannot be attributed to another user');
select is((select count(*)::int from public.legal_requests), 5, 'no rejected insert left a row behind');

-- ---------- staff: counts view ----------
select results_eq(
  $$ select period, request_type, jurisdiction_country, outcome, requests, accounts_affected, nondisclosure_orders
       from public.legal_requests_counts order by period, request_type, jurisdiction_country, outcome $$,
  $$ values
    ('2024-H1'::text, 'court_order'::text, 'DE'::text, 'objected'::text, 1, 0::bigint, 0),
    ('2024-H1', 'subpoena', 'US', 'complied_in_part', 1, 1::bigint, 1),
    ('2024-H1', 'subpoena', 'US', 'no_data_found', 1, 0::bigint, 0),
    ('2024-H2', 'emergency_disclosure', 'US', 'complied_in_full', 1, 2::bigint, 0),
    ('2024-H2', 'subpoena', 'US', 'pending', 1, 0::bigint, 0) $$,
  'counts are grouped by half-year, type, country and outcome');
select is((select sum(requests)::int from public.legal_requests_counts), 5, 'the counts add up to the number of requests');

-- ---------- staff: update, no delete ----------
select lives_ok($$ update public.legal_requests set outcome = 'rejected_invalid', closed_on = '2024-08-20',
  created_by = '00000000-0000-0000-0000-0000000000a1', created_at = '2000-01-01'
  where requesting_authority = 'Example Agency' and received_on = '2024-08-01' $$, 'staff can close a pending request');
select is((select created_by from public.legal_requests where received_on = '2024-08-01'), '00000000-0000-0000-0000-0000000000c1'::uuid, 'created_by is immutable');
select ok((select created_at > '2020-01-01'::timestamptz from public.legal_requests where received_on = '2024-08-01'), 'created_at is immutable');
select is((select updated_by from public.legal_requests where received_on = '2024-08-01'), '00000000-0000-0000-0000-0000000000c1'::uuid, 'updated_by is stamped');
select throws_ok($$ delete from public.legal_requests $$, '42501', null, 'even staff cannot delete a legal request');

-- ---------- audit trail (read as superuser) ----------
reset role;
select is((select count(*)::int from public.staff_audit_log where metadata ->> 'view' = 'legal_request_change'), 6,
  'every insert and update wrote an audit row (5 inserts + 1 update)');
select ok(not exists (select 1 from public.staff_audit_log where metadata::text ilike '%Subscriber%'), 'audit rows never contain scope text');

-- ---------- non-staff authenticated user (a customer account owner) ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.legal_requests), 0, 'a customer owner sees no legal requests');
select is((select count(*)::int from public.legal_requests_counts), 0, 'a customer owner sees empty counts');
select throws_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary)
  values ('subpoena', 'US', 'Forged', '2024-05-01', 's') $$, '42501', null, 'a customer owner cannot insert');
select lives_ok($$ update public.legal_requests set scope_summary = 'hacked' $$, 'a customer owner update is filtered to zero rows (checked below)');

-- ---------- anon ----------
reset role;
select pg_temp.act_as_anon();
select throws_ok($$ select count(*) from public.legal_requests $$, '42501', null, 'anon cannot read the table');
select throws_ok($$ select count(*) from public.legal_requests_counts $$, '42501', null, 'anon cannot read the counts view');
select throws_ok($$ insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary)
  values ('subpoena', 'US', 'Anon', '2024-05-01', 's') $$, '42501', null, 'anon cannot insert');

-- ---------- data untouched by the denied attempts ----------
reset role;
select is((select count(*)::int from public.legal_requests), 5, 'denied writes changed nothing');
select is((select count(*)::int from public.legal_requests where scope_summary = 'hacked'), 0, 'the denied update left no trace');

select * from finish();
rollback;
