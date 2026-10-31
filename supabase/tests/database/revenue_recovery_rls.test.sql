-- revenue_recovery_events: tenant isolation, no client INSERT, one ledger row per source event (pgTAP).
-- Run with:  supabase test db
-- Impersonation mirrors PostgREST: role = authenticated + request.jwt.claim.sub.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@rre-a.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@rre-b.test');

insert into public.revenue_recovery_events (id, user_id, source_type, source_table, source_id, estimated_value_cents) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'declined_quote', 'quotes', '00000000-0000-0000-0000-0000000000a9', 120000),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b1', 'declined_quote', 'quotes', '00000000-0000-0000-0000-0000000000b9', 90000);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.revenue_recovery_events), 1, 'an account sees only its own ledger rows');
select is((select count(*)::int from public.revenue_recovery_events where user_id = '00000000-0000-0000-0000-0000000000b1'), 0, 'another account''s ledger rows are invisible');
select throws_ok($$ insert into public.revenue_recovery_events (user_id, source_type, source_table, source_id, estimated_value_cents)
  values ('00000000-0000-0000-0000-0000000000a1', 'missed_call', 'calls', gen_random_uuid(), 999999) $$,
  '42501', null, 'clients cannot insert ledger rows (agent / triggers only: no forged recovery value)');
select is((with u as (update public.revenue_recovery_events set status = 'contacted' where id = '00000000-0000-0000-0000-0000000000f1' returning 1) select count(*)::int from u), 1,
  'can triage an own row');
select is((with u as (update public.revenue_recovery_events set status = 'written_off' where id = '00000000-0000-0000-0000-0000000000f2' returning 1) select count(*)::int from u), 0,
  'cannot triage another account''s row');
select throws_ok($$ update public.revenue_recovery_events set user_id = '00000000-0000-0000-0000-0000000000b1' where id = '00000000-0000-0000-0000-0000000000f1' $$,
  '42501', null, 'cannot hand an own row over to another account');
select is((with d as (delete from public.revenue_recovery_events where id = '00000000-0000-0000-0000-0000000000f2' returning 1) select count(*)::int from d), 0,
  'cannot delete another account''s row');
select is((with d as (delete from public.revenue_recovery_events where id = '00000000-0000-0000-0000-0000000000f1' returning 1) select count(*)::int from d), 1,
  'can delete an own row');

reset role;
-- estimate-recovery-agent upserts on (source_table, source_id) with ignoreDuplicates: the constraint must exist.
select throws_ok($$ insert into public.revenue_recovery_events (user_id, source_type, source_table, source_id)
  values ('00000000-0000-0000-0000-0000000000b1', 'declined_quote', 'quotes', '00000000-0000-0000-0000-0000000000b9') $$,
  '23505', null, 'one ledger row per source event (idempotent agent upsert)');
select is((select count(*)::int from public.revenue_recovery_events where user_id = '00000000-0000-0000-0000-0000000000b1'), 1, 'the other account''s row survived every attempt');

select * from finish();
rollback;
