-- revenue_recovery_events: tenant isolation (RLS) tests (pgTAP).
-- Run with:  supabase test db
-- Impersonation mirrors PostgREST: role = authenticated + request.jwt.claim.sub.
-- Policies under test: select/update/delete_own_revenue_recovery_events (user_id = get_account_owner_id()); NO client INSERT policy by design
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- ---------------------------------------------------------------- fixtures --
-- A, B   = owners of two DIFFERENT tenants
-- AM     = active admin team member of A         (a2)
-- AT     = active technician team member of A    (a3)
-- AP     = PENDING (not yet accepted) invitee of A (a4)
-- S      = signed-in stranger with no profile and no team row (c1)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@a.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@b.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin@a.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@a.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'pending@a.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'stranger@x.test');
insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@a.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@b.test')
  on conflict (id) do nothing;
insert into public.team_members (account_owner_id, member_email, role, invite_status, user_id) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@a.test',   'admin',      'active',  '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000a1', 'tech@a.test',    'technician', 'active',  '00000000-0000-0000-0000-0000000000a3'),
  ('00000000-0000-0000-0000-0000000000a1', 'pending@a.test', 'technician', 'pending', '00000000-0000-0000-0000-0000000000a4');

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
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
end $$;

insert into public.revenue_recovery_events (id, user_id, source_type, source_table, source_id, customer_name) values
  ('30000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'missed_call', 'calls', '31000000-0000-0000-0000-00000000000a', 'Lead of A'),
  ('30000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'missed_call', 'calls', '31000000-0000-0000-0000-00000000000b', 'Lead of B');

select ok((select relrowsecurity from pg_class where oid = 'public.revenue_recovery_events'::regclass), 'RLS is enabled on revenue_recovery_events');

-- The six ledger rows estimate-recovery-agent writes must satisfy the LIVE check constraints (service role bypasses RLS, not constraints).
select lives_ok($$ insert into public.revenue_recovery_events (user_id, source_type, source_table, source_id) values
  ('00000000-0000-0000-0000-0000000000a1', 'quote_financing_stalled', 'quotes',           '32000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-0000000000a1', 'quote_accepted_unbooked', 'quotes',           '32000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-0000000000a1', 'job_completed_unbilled',  'jobs',             '32000000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-0000000000a1', 'invoice_overdue',         'payment_requests', '32000000-0000-0000-0000-000000000004'),
  ('00000000-0000-0000-0000-0000000000a1', 'job_parts_unbilled',      'jobs',             '32000000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-0000000000a1', 'payment_failed',          'payment_requests', '32000000-0000-0000-0000-000000000006') $$,
  'every source_type/source_table pair written by estimate-recovery-agent is accepted by the table constraints');
select throws_ok($$ insert into public.revenue_recovery_events (user_id, source_type, source_table, source_id) values ('00000000-0000-0000-0000-0000000000a1', 'quote_financing_stalled', 'quotes', '32000000-0000-0000-0000-000000000001') $$, '23505', null, 'the (source_table, source_id) unique key the agent upserts on rejects duplicates');
select throws_ok($$ insert into public.revenue_recovery_events (user_id, source_type, source_table, source_id) values ('00000000-0000-0000-0000-0000000000a1', 'not_a_real_type', 'quotes', '32000000-0000-0000-0000-000000000099') $$, '23514', null, 'an unknown source_type is rejected');
delete from public.revenue_recovery_events where source_id::text like '32000000-%';

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*) from public.revenue_recovery_events)::int, 1, 'owner A sees exactly one ledger row');
select is((select customer_name from public.revenue_recovery_events), 'Lead of A', 'and it is A''s own');
select is((select count(*) from public.revenue_recovery_events where id = '30000000-0000-0000-0000-00000000000b')::int, 0, 'A cannot read B''s ledger row even by primary key');
select lives_ok($$ update public.revenue_recovery_events set status = 'written_off' where id = '30000000-0000-0000-0000-00000000000b' $$, 'updating B''s row does not error (RLS filters it)');
select lives_ok($$ delete from public.revenue_recovery_events where id = '30000000-0000-0000-0000-00000000000b' $$, 'deleting B''s row does not error (RLS filters it)');
select throws_ok($$ insert into public.revenue_recovery_events (user_id, source_type, source_table, source_id) values ('00000000-0000-0000-0000-0000000000b1', 'missed_call', 'calls', '33000000-0000-0000-0000-000000000001') $$, '42501', null, 'A cannot insert a ledger row for B');
select throws_ok($$ insert into public.revenue_recovery_events (user_id, source_type, source_table, source_id) values ('00000000-0000-0000-0000-0000000000a1', 'missed_call', 'calls', '33000000-0000-0000-0000-000000000002') $$, '42501', null, 'A cannot insert even for itself: ledger rows are created only by triggers / service-role functions');
select lives_ok($$ update public.revenue_recovery_events set status = 'contacted' where id = '30000000-0000-0000-0000-00000000000a' $$, 'A can update its own row');
select is((select status from public.revenue_recovery_events where id = '30000000-0000-0000-0000-00000000000a'), 'contacted', 'and the update took effect');
select throws_ok($$ update public.revenue_recovery_events set user_id = '00000000-0000-0000-0000-0000000000b1' where id = '30000000-0000-0000-0000-00000000000a' $$, '42501', null, 'A cannot hand its own row to B (WITH CHECK)');

reset role;
select is((select status from public.revenue_recovery_events where id = '30000000-0000-0000-0000-00000000000b'), 'open', 'B''s row was not modified by A');
select is((select count(*) from public.revenue_recovery_events where user_id = '00000000-0000-0000-0000-0000000000b1')::int, 1, 'B still has exactly its one row');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*) from public.revenue_recovery_events)::int, 1, 'owner B sees exactly one ledger row');
select is((select count(*) from public.revenue_recovery_events where user_id = '00000000-0000-0000-0000-0000000000a1')::int, 0, 'B sees none of A''s rows');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*) from public.revenue_recovery_events)::int, 1, 'an active team member of A sees A''s row (and none of B''s)');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select count(*) from public.revenue_recovery_events)::int, 0, 'a signed-in user with no profile and no team sees nothing');
select pg_temp.act_as_anon();
select is((select count(*) from public.revenue_recovery_events)::int, 0, 'anon sees nothing');
select throws_ok($$ insert into public.revenue_recovery_events (user_id, source_type, source_table, source_id) values ('00000000-0000-0000-0000-0000000000a1', 'missed_call', 'calls', '33000000-0000-0000-0000-000000000003') $$, '42501', null, 'anon cannot insert');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select todo_start('PENDING invitees should not see tenant data: get_account_owner_id() resolves team_members by user_id without checking invite_status');
select is((select count(*) from public.revenue_recovery_events)::int, 0, 'a pending (not yet accepted) invitee of A sees none of A''s ledger rows');
select todo_end();

reset role;
select set_config('role', 'service_role', true);
select is((select count(*) from public.revenue_recovery_events where source_id::text like '31000000-%')::int, 2, 'service_role sees every tenant — edge functions using it must scope by user_id themselves');

select * from finish();
rollback;
