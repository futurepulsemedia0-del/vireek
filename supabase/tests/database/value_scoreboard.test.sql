-- Value Scoreboard: RLS, append-only ledger, dedupe, triggers, staff gate (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

-- ---------------------------------------------------------------- fixtures --
-- A = owner, M = team member of A WITH can_view_billing, N = team member of A WITHOUT it,
-- B = owner of ANOTHER account, S = Vireek staff.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'billing@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test'),
  ('00000000-0000-0000-0000-0000000000f1', 'staff@vireek.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'billing@acme.test', 'Bea Billing', 'admin',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_view_billing": true}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@acme.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{}');

update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-0000000000f1';

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.act_as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ------------------------------------------------------------ the ledger --
select ok(public.value_emit_event('00000000-0000-0000-0000-0000000000a1', 'after_hours_answering', 'recovered_revenue', 50000, 'cents', 'USD',
  'measured', 'paid invoice', 'jobs:11111111-1111-4111-8111-111111111111', '2026-10-10 12:00+00'),
  'a measured event is written');
select is(public.value_emit_event('00000000-0000-0000-0000-0000000000a1', 'after_hours_answering', 'recovered_revenue', 99999, 'cents', 'USD',
  'measured', 'duplicate', 'jobs:11111111-1111-4111-8111-111111111111', '2026-10-11 12:00+00'),
  false, 'the same (type, evidence_ref) is a silent no-op');
select is((select count(*) from public.value_events where user_id = '00000000-0000-0000-0000-0000000000a1')::int, 1, 'dedupe kept exactly one row');
select is((select amount from public.value_events where user_id = '00000000-0000-0000-0000-0000000000a1'), 50000::bigint, 'and the first amount wins');

select public.value_emit_event('00000000-0000-0000-0000-0000000000a1', 'call_handling', 'saved_hours', 3, 'minutes', null,
  'estimated', 'handled call', 'calls:22222222-2222-4222-8222-222222222222', '2026-10-10 12:00+00');
select public.value_emit_event('00000000-0000-0000-0000-0000000000b1', 'after_hours_answering', 'recovered_revenue', 70000, 'cents', 'USD',
  'measured', 'other tenant', 'jobs:33333333-3333-4333-8333-333333333333', '2026-10-10 12:00+00');

select throws_ok($$ update public.value_events set amount = 1 $$, '42501', null, 'UPDATE is blocked, even for the table owner');
select throws_ok($$ delete from public.value_events $$, '42501', null, 'DELETE is blocked, even for the table owner');
select throws_ok($$ truncate public.value_events $$, '42501', null, 'TRUNCATE is blocked, even for the table owner');
select throws_ok($$ select public.value_emit_event('00000000-0000-0000-0000-0000000000a1', 'x_feature', 'recovered_revenue', 5, 'cents', null,
  'measured', 'n', 'jobs:aaa', now()) $$, '23514', null, 'money without a currency is rejected');
select throws_ok($$ select public.value_emit_event('00000000-0000-0000-0000-0000000000a1', 'x_feature', 'saved_hours', 5, 'minutes', 'USD',
  'estimated', 'n', 'calls:aaa', now()) $$, '23514', null, 'minutes carrying a currency are rejected');
select is(public.value_emit_event('00000000-0000-0000-0000-0000000000a1', 'x_feature', 'recovered_revenue', 0, 'cents', 'USD',
  'measured', 'n', 'jobs:zero', now()), false, 'a zero amount is never written');

-- ------------------------------------------------------------------- RLS --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*) from public.value_events)::int, 2, 'owner A sees only A''s two events');
select throws_ok($$ insert into public.value_events (user_id, source_feature, type, amount, unit, currency, confidence, method_note, evidence_ref, occurred_at)
  values ('00000000-0000-0000-0000-0000000000a1', 'forged_feature', 'recovered_revenue', 1, 'cents', 'USD', 'measured', 'n', 'jobs:forged', now()) $$,
  '42501', null, 'a client cannot insert events');
select throws_ok($$ update public.value_events set amount = 999999 $$, '42501', null, 'a client cannot update events');
select throws_ok($$ select public.value_emit_event('00000000-0000-0000-0000-0000000000a1', 'forged_feature', 'recovered_revenue', 1, 'cents', 'USD',
  'measured', 'n', 'jobs:forged2', now()) $$, '42501', null, 'a client cannot call the emit function');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*) from public.value_events)::int, 1, 'owner B sees only B''s event');
select is((select count(*) from public.value_events where user_id = '00000000-0000-0000-0000-0000000000a1')::int, 0, 'and nothing from A');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*) from public.value_events)::int, 2, 'a team member with can_view_billing sees the account''s events');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*) from public.value_events)::int, 0, 'a team member without billing access sees none');

-- ----------------------------------------------------------- owner reviews --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ insert into public.value_event_reviews (user_id, value_event_id, decision, note)
  select user_id, id, 'not_due_to_vireek', 'repeat customer' from public.value_events where evidence_ref like 'jobs:1111%' $$,
  'the owner can mark an event "not due to Vireek"');
select throws_ok($$ insert into public.value_event_reviews (user_id, value_event_id, decision)
  select '00000000-0000-0000-0000-0000000000a1', id, 'not_due_to_vireek' from public.value_events e
  where e.evidence_ref like 'jobs:3333%' $$, '42501', null, 'the owner cannot review another account''s event (invisible, so the insert has no row)') ;

-- ----------------------------------------------------------------- settings --
select lives_ok($$ insert into public.value_settings (user_id, avg_ticket_cents, case_study_consent, case_study_consent_at)
  values ('00000000-0000-0000-0000-0000000000a1', 40000, true, '2001-01-01') $$, 'the owner can save settings');
select ok((select case_study_consent_at > now() - interval '1 minute' from public.value_settings), 'consent time is server-controlled (client value ignored)');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*) from public.value_settings)::int, 1, 'a billing team member can read settings');
update public.value_settings set avg_ticket_cents = 1;
select is((select avg_ticket_cents from public.value_settings), 40000, 'but cannot change them');

-- -------------------------------------------------------------- staff gate --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select * from public.value_staff_aggregates('2026-10') $$, '42501', null, 'non-staff cannot read aggregates');
select throws_ok($$ select * from public.value_staff_case_studies('2026-10') $$, '42501', null, 'non-staff cannot read case studies');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select is((select count(*) from public.value_staff_aggregates('2026-10'))::int, 0, 'groups with fewer than 5 accounts are hidden');
select is((select count(*) from public.value_staff_case_studies('2026-10') where account_id = '00000000-0000-0000-0000-0000000000a1')::int, 1,
  'a consenting account appears in case studies');

select * from finish();
rollback;
