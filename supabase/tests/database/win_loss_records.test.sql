-- Win/loss analysis: staff-only RLS, write-time normalisation, integrity constraints and the aggregate view (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(55);

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
select ok((select relrowsecurity from pg_class where oid = 'public.win_loss_records'::regclass), 'RLS is enabled on win_loss_records');
select policies_are('public', 'win_loss_records',
  array['win_loss_records_staff_select', 'win_loss_records_staff_insert', 'win_loss_records_staff_update', 'win_loss_records_staff_delete'],
  'exactly the four staff policies exist');
select ok(not has_table_privilege('anon', 'public.win_loss_records', 'SELECT'), 'anon has no SELECT on the table');
select ok(not has_table_privilege('anon', 'public.win_loss_records', 'INSERT'), 'anon has no INSERT on the table');
select ok(not has_table_privilege('anon', 'public.win_loss_summary', 'SELECT'), 'anon has no SELECT on the summary view');
select ok((select coalesce(reloptions @> array['security_invoker=true'], false) from pg_class where oid = 'public.win_loss_summary'::regclass),
  'the summary view runs with the caller''s rights (security_invoker)');

-- ---------- staff: inserts and write-time normalisation ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');

select lives_ok($$ insert into public.win_loss_records (deal_name, outcome, competitor, reasons, notes, closed_on, deal_value_cents)
  values ('  Acme HVAC  ', 'lost', '  ServiceTitan ', array['price', 'price', 'features'], '  too expensive  ', '2024-02-10', 1200000) $$, 'staff can insert a lost deal');
select lives_ok($$ insert into public.win_loss_records (deal_name, outcome, competitor, reasons, closed_on, deal_value_cents)
  values ('Bolt Plumbing', 'lost', 'servicetitan', array['price'], '2024-02-20', 800000) $$, 'staff can insert a second lost deal');
select lives_ok($$ insert into public.win_loss_records (deal_name, outcome, competitor, reasons, closed_on, deal_value_cents)
  values ('Cedar Electric', 'won', 'Jobber', array['voice_quality', 'integrations'], '2024-05-20', 500000) $$, 'staff can insert a won deal');
select lives_ok($$ insert into public.win_loss_records (deal_name, outcome, closed_on)
  values ('Dune Roofing', 'no_decision', '2024-05-25') $$, 'staff can insert a no-decision deal without reasons or competitor');
select lives_ok($$ insert into public.win_loss_records (deal_name, outcome, reasons, closed_on, deal_value_cents)
  values ('Elm HVAC', 'won', array['voice_quality'], '2024-05-30', 700000) $$, 'staff can insert a won deal without a named competitor');

select is((select count(*)::int from public.win_loss_records where deal_name = 'Acme HVAC'), 1, 'deal_name is trimmed');
select is((select competitor from public.win_loss_records where deal_name = 'Acme HVAC'), 'ServiceTitan', 'competitor is trimmed');
select is((select competitor_norm from public.win_loss_records where deal_name = 'Acme HVAC'), 'servicetitan', 'competitor_norm is lower-cased');
select is((select reasons from public.win_loss_records where deal_name = 'Acme HVAC'), array['features', 'price'], 'reasons are de-duplicated and sorted');
select is((select notes from public.win_loss_records where deal_name = 'Acme HVAC'), 'too expensive', 'notes are trimmed');
select is((select created_by from public.win_loss_records where deal_name = 'Acme HVAC'), '00000000-0000-0000-0000-0000000000c1'::uuid, 'created_by defaults to the caller');
select is((select interview_status from public.win_loss_records where deal_name = 'Acme HVAC'), 'not_requested', 'interview_status defaults to not_requested');

-- ---------- staff: integrity constraints ----------
select throws_ok($$ insert into public.win_loss_records (deal_name, outcome, reasons) values ('X1', 'lost', array['price']) $$,
  '23514', null, 'a lost deal must name a competitor');
select throws_ok($$ insert into public.win_loss_records (deal_name, outcome) values ('X2', 'won') $$,
  '23514', null, 'a won deal needs at least one reason');
select throws_ok($$ insert into public.win_loss_records (deal_name, outcome, competitor, reasons) values ('X3', 'lost', 'Jobber', array['cheap']) $$,
  '23514', null, 'a reason outside the vocabulary is rejected');
select throws_ok($$ insert into public.win_loss_records (deal_name, outcome, competitor, reasons)
  values ('X4', 'lost', 'Jobber', array['price', 'features', 'voice_quality', 'integrations', 'trust_compliance', 'support']) $$,
  '23514', null, 'more than five reasons are rejected');
select throws_ok($$ insert into public.win_loss_records (deal_name, outcome) values ('X5', 'maybe') $$,
  '23514', null, 'an unknown outcome is rejected');
select throws_ok($$ insert into public.win_loss_records (deal_name, outcome) values ('   ', 'no_decision') $$,
  '23514', null, 'a blank deal name is rejected');
select throws_ok($$ insert into public.win_loss_records (deal_name, outcome, deal_value_cents) values ('X7', 'no_decision', -1) $$,
  '23514', null, 'a negative deal value is rejected');
select throws_ok($$ insert into public.win_loss_records (deal_name, outcome, closed_on) values ('X8', 'no_decision', current_date + 30) $$,
  '22023', null, 'a close date in the future is rejected');
select throws_ok($$ insert into public.win_loss_records (deal_name, outcome, closed_on) values ('X9', 'no_decision', '2019-12-31') $$,
  '23514', null, 'a close date before 2020 is rejected');
select throws_ok($$ insert into public.win_loss_records (deal_name, outcome, created_by)
  values ('X10', 'no_decision', '00000000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'a row cannot be attributed to another user');
select is((select count(*)::int from public.win_loss_records), 5, 'no rejected insert left a row behind');

-- ---------- staff: aggregate view ----------
select results_eq(
  $$ select wins, losses, no_decisions, decided, win_rate_pct, won_value_cents, lost_value_cents
       from public.win_loss_summary where dimension = 'overall' $$,
  $$ values (2, 2, 1, 4, 50.0::numeric, 1200000::bigint, 2000000::bigint) $$,
  'overall: 2 won, 2 lost, 1 no decision, 50% win rate, value split');
select results_eq(
  $$ select wins, losses, decided, win_rate_pct, lost_value_cents from public.win_loss_summary where dimension = 'competitor' and bucket = 'servicetitan' $$,
  $$ values (0, 2, 2, 0.0::numeric, 2000000::bigint) $$,
  'competitor names are grouped case-insensitively');
select results_eq(
  $$ select wins, losses, decided, win_rate_pct from public.win_loss_summary where dimension = 'competitor' and bucket = 'jobber' $$,
  $$ values (1, 0, 1, 100.0::numeric) $$,
  'competitor row for a win');
select results_eq(
  $$ select wins, no_decisions, decided, win_rate_pct from public.win_loss_summary where dimension = 'competitor' and bucket = '(none)' $$,
  $$ values (1, 1, 1, 100.0::numeric) $$,
  'deals without a competitor are grouped under (none)');
select results_eq(
  $$ select wins, losses, decided from public.win_loss_summary where dimension = 'reason' and bucket = 'price' $$,
  $$ values (0, 2, 2) $$,
  'a duplicated reason is counted once per deal');
select results_eq(
  $$ select wins, losses, win_rate_pct from public.win_loss_summary where dimension = 'reason' and bucket = 'voice_quality' $$,
  $$ values (2, 0, 100.0::numeric) $$,
  'reason rows count each deal under each of its reasons');
select results_eq(
  $$ select wins, losses, no_decisions from public.win_loss_summary where dimension = 'quarter' and bucket = '2024-Q2' $$,
  $$ values (2, 0, 1) $$,
  'quarter rows use the close date');
select is((select win_rate_pct from public.win_loss_summary where dimension = 'reason' and bucket = 'integrations'), 100.0::numeric,
  'win rate is wins / (wins + losses)');

-- ---------- staff: update and delete ----------
select lives_ok($$ insert into public.win_loss_records (deal_name, outcome, closed_on) values ('Fir Heating', 'no_decision', '2024-06-01') $$,
  'staff can insert a row to update');
select lives_ok($$ update public.win_loss_records set notes = '  followed up  ', created_by = '00000000-0000-0000-0000-0000000000a1',
  created_at = '2000-01-01' where deal_name = 'Fir Heating' $$, 'staff can update a record');
select is((select notes from public.win_loss_records where deal_name = 'Fir Heating'), 'followed up', 'notes are trimmed on update');
select is((select created_by from public.win_loss_records where deal_name = 'Fir Heating'), '00000000-0000-0000-0000-0000000000c1'::uuid,
  'created_by is immutable');
select ok((select created_at > '2020-01-01'::timestamptz from public.win_loss_records where deal_name = 'Fir Heating'), 'created_at is immutable');
select is((select updated_by from public.win_loss_records where deal_name = 'Fir Heating'), '00000000-0000-0000-0000-0000000000c1'::uuid,
  'updated_by is stamped on update');
select lives_ok($$ delete from public.win_loss_records where deal_name = 'Fir Heating' $$, 'staff can delete a record');
select is((select count(*)::int from public.win_loss_records where deal_name = 'Fir Heating'), 0, 'the record is gone');

-- ---------- non-staff authenticated user (a customer account owner) ----------
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.win_loss_records), 0, 'a customer owner sees no win/loss records');
select is((select count(*)::int from public.win_loss_summary), 0, 'a customer owner sees an empty summary');
select throws_ok($$ insert into public.win_loss_records (deal_name, outcome) values ('Forged', 'no_decision') $$,
  '42501', null, 'a customer owner cannot insert');
select lives_ok($$ update public.win_loss_records set notes = 'hacked' $$, 'a customer owner update is filtered to zero rows (checked below)');
select lives_ok($$ delete from public.win_loss_records $$, 'a customer owner delete is filtered to zero rows (checked below)');

-- ---------- anon ----------
reset role;
select pg_temp.act_as_anon();
select throws_ok($$ select count(*) from public.win_loss_records $$, '42501', null, 'anon cannot read the table');
select throws_ok($$ select count(*) from public.win_loss_summary $$, '42501', null, 'anon cannot read the summary view');
select throws_ok($$ insert into public.win_loss_records (deal_name, outcome) values ('Anon', 'no_decision') $$, '42501', null, 'anon cannot insert');

-- ---------- data untouched by the denied attempts ----------
reset role;
select is((select count(*)::int from public.win_loss_records), 5, 'denied writes changed nothing');
select is((select count(*)::int from public.win_loss_records where notes = 'hacked'), 0, 'the denied update left no trace');

select * from finish();
rollback;
