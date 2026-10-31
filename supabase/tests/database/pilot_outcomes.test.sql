-- Pilot outcome measurement: schema, RLS, immutability, privileges (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

-- ---------------------------------------------------------------- fixtures --
-- A and B are separate tenants with a baseline; C has none yet.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@pilot.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'b@pilot.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'c@pilot.test');

insert into public.pilot_outcome_baselines
  (user_id, window_start, window_end, eligible_jobs_count, claims_filed_count, claims_paid_count, claims_paid_cents,
   unfiled_eligible_estimate_cents, admin_hours_per_week)
values
  ('00000000-0000-0000-0000-0000000000a1', now() - interval '6 months', now(), 10, 3, 2, 90000, 500000, 8),
  ('00000000-0000-0000-0000-0000000000b1', now() - interval '6 months', now(), 1, 0, 0, 0, 0, 2);

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
end $$;

-- ---------------------------------------------------------------- structure --
select has_table('public', 'pilot_outcome_baselines', 'baselines table');
select has_table('public', 'warranty_claim_actions', 'claim actions table');
select has_table('public', 'pilot_attributions', 'attributions table');
select has_table('public', 'pilot_outcome_settings', 'settings table');
select has_table('public', 'pilot_email_deliveries', 'deliveries table');

select ok((select relrowsecurity from pg_class where oid = 'public.pilot_outcome_baselines'::regclass), 'RLS baselines');
select ok((select relrowsecurity from pg_class where oid = 'public.warranty_claim_actions'::regclass), 'RLS actions');
select ok((select relrowsecurity from pg_class where oid = 'public.pilot_attributions'::regclass), 'RLS attributions');
select ok((select relrowsecurity from pg_class where oid = 'public.pilot_outcome_settings'::regclass), 'RLS settings');
select ok((select relrowsecurity from pg_class where oid = 'public.pilot_email_deliveries'::regclass), 'RLS deliveries');

select is((select count(*)::int from information_schema.role_table_grants
           where grantee in ('authenticated', 'anon') and table_schema = 'public'
             and table_name in ('pilot_outcome_baselines', 'warranty_claim_actions', 'pilot_attributions', 'pilot_outcome_settings', 'pilot_email_deliveries')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')), 0, 'clients have no write grants on pilot tables');

select has_function('public', 'pilot_capture_baseline', array['numeric'], 'capture RPC exists');
select ok(not has_function_privilege('anon', 'public.pilot_capture_baseline(numeric)', 'EXECUTE'), 'anon cannot capture baseline');
select ok(has_function_privilege('authenticated', 'public.log_claim_packet_export(uuid)', 'EXECUTE'), 'authenticated can log packet export');
select ok(not has_function_privilege('anon', 'public.staff_set_pilot_fee(uuid, integer)', 'EXECUTE'), 'anon cannot set fee');

-- ---------------------------------------------------------------- immutability / constraints (as superuser) --
select throws_ok($$update public.pilot_outcome_baselines set claims_paid_cents = 1 where user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  '42501', null, 'baseline cannot be updated');
select throws_ok($$delete from public.pilot_outcome_baselines where user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  '42501', null, 'baseline cannot be deleted while the account exists');

select throws_ok($$insert into public.pilot_attributions (user_id, source_type, source_id, amount_cents, action_type, action_at, recovered_at, method_version)
  values ('00000000-0000-0000-0000-0000000000a1', 'warranty_claim', gen_random_uuid(), 100, 'packet_exported', now() - interval '1 day', now(), 'v')$$,
  '23514', null, 'attribution without claim_id/invoice_id is rejected');
select throws_ok($$insert into public.pilot_attributions (user_id, source_type, source_id, claim_id, amount_cents, action_type, action_at, recovered_at, method_version)
  values ('00000000-0000-0000-0000-0000000000a1', 'warranty_claim', gen_random_uuid(), gen_random_uuid(), 100, 'packet_exported', now(), now() - interval '1 day', 'v')$$,
  '23514', null, 'action must precede the recovered money');

select lives_ok($$insert into public.pilot_attributions (user_id, source_type, source_id, claim_id, amount_cents, action_type, action_at, recovered_at, method_version)
  values ('00000000-0000-0000-0000-0000000000a1', 'warranty_claim', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000d001', 125000, 'status_change', now() - interval '2 days', now() - interval '1 day', 'pilot-attr-v1')$$,
  'valid attribution inserts');
select throws_ok($$update public.pilot_attributions set amount_cents = 1$$, '42501', null, 'attribution is append-only');

-- ---------------------------------------------------------------- tenant A --
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.pilot_outcome_baselines), 1, 'A sees only its own baseline');
select is((select count(*)::int from public.pilot_attributions), 1, 'A sees its attribution');
select throws_ok($$select public.pilot_capture_baseline(5)$$, '23505', null, 'second capture is refused');
select throws_ok($$insert into public.pilot_attributions (user_id, source_type, source_id, claim_id, amount_cents, action_type, action_at, recovered_at, method_version)
  values ('00000000-0000-0000-0000-0000000000a1', 'warranty_claim', gen_random_uuid(), gen_random_uuid(), 999, 'packet_exported', now() - interval '1 day', now(), 'v')$$,
  '42501', null, 'client cannot forge an attribution');
select throws_ok($$select public.staff_set_pilot_fee('00000000-0000-0000-0000-0000000000a1', 1000)$$, '42501', null, 'non-staff cannot set fee');
select throws_ok($$update public.pilot_outcome_baselines set admin_hours_per_week = 0$$, '42501', null, 'client cannot edit baseline');
reset role;

-- ---------------------------------------------------------------- tenant C: first capture works, validated, once --
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select lives_ok($$select public.pilot_capture_baseline(5)$$, 'C captures a baseline');
select is((select admin_hours_per_week from public.pilot_outcome_baselines)::numeric, 5::numeric, 'C baseline stores manual hours');
select throws_ok($$select public.pilot_capture_baseline(-1)$$, '22023', null, 'invalid hours rejected');
reset role;

-- ---------------------------------------------------------------- tenant B isolation --
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.pilot_outcome_baselines), 1, 'B sees only its own baseline');
select is((select count(*)::int from public.pilot_attributions), 0, 'B cannot see A attributions');
reset role;

select * from finish();
rollback;
