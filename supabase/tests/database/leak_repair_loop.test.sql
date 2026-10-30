-- Refrigerant Leak-Repair Loop: RLS, privileges, lifecycle, date math, expired-cert rejection (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');
insert into public.team_members (id, account_owner_id, member_email, member_name, role, invite_status) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'good@acme.test', 'Good Tech', 'technician', 'active'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'old@acme.test',  'Expired Tech', 'technician', 'active');
insert into public.technician_credentials (user_id, technician_id, credential_type, credential_number, expires_at, status) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'epa_608_universal', 'T-1', null, 'active'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2', 'epa_608_universal', 'T-2', current_date - 5, 'active');
insert into public.customers (id, user_id, name, phone, address) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Acme Foods', '555', '1 Main');
insert into public.equipment (id, user_id, customer_id, equipment_type, install_date, refrigerant_type, refrigerant_charge_lbs, appliance_category) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'RTU', current_date - 800, 'R-410A', 40, 'comfort_cooling'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'Mini', current_date - 800, 'R-410A', 10, 'comfort_cooling');
insert into public.jobs (id, user_id, customer_name, service_type, address, job_status, customer_id) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'Acme Foods', 'HVAC repair', '1 Main', 'in_progress', '00000000-0000-0000-0000-0000000000d1');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.add(eq uuid, lbs numeric, days_ago int) returns void language plpgsql as $$
begin
  insert into public.refrigerant_log (job_id, equipment_id, technician_id, event_type, refrigerant_type, pounds, performed_at)
  values ('00000000-0000-0000-0000-0000000000f1', eq, '00000000-0000-0000-0000-0000000000c1', 'added', 'R-410A', lbs, now() - make_interval(days => days_ago));
end $$;

-- structure
select has_table('public', 'leak_cases', 'leak_cases exists');
select has_table('public', 'leak_verification_tests', 'leak_verification_tests exists');
select has_function('public', 'leak_loop_tick', array['timestamptz'], 'cron entry point exists');
select ok((select relrowsecurity from pg_class where oid = 'public.leak_cases'::regclass), 'RLS enabled on leak_cases');

-- thresholds / coverage / auto-open
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.add('00000000-0000-0000-0000-0000000000e2', 9, 1);
select is((select count(*)::int from public.leak_cases where equipment_id = '00000000-0000-0000-0000-0000000000e2'), 0, 'a <15 lb appliance never opens a case');
select pg_temp.add('00000000-0000-0000-0000-0000000000e1', 8, 3);   -- 20% > 10% comfort
select is((select count(*)::int from public.leak_cases where equipment_id = '00000000-0000-0000-0000-0000000000e1' and status = 'open'), 1, 'exceeding the category threshold auto-opens a case');
select ok((select next_action = 'initial_verification' and next_action_due_at is not null from public.leak_cases where equipment_id = '00000000-0000-0000-0000-0000000000e1'), 'open case has a dated next action');
select ok((select repair_due_at - detected_at = interval '30 days' from public.leak_cases where equipment_id = '00000000-0000-0000-0000-0000000000e1'), 'repair due is 30 days after detection');
select pg_temp.add('00000000-0000-0000-0000-0000000000e1', 9, 1);
select is((select count(*)::int from public.leak_cases where equipment_id = '00000000-0000-0000-0000-0000000000e1'), 1, 'a second exceedance does not duplicate the live case');

-- direct writes are denied to clients
select throws_ok($$update public.leak_cases set status = 'closed'$$, '42501', null, 'clients cannot update leak_cases directly');
select throws_ok($$delete from public.leak_cases$$, '42501', null, 'clients cannot delete leak_cases');

-- lifecycle + expired certification
select set_config('t.case', (select id::text from public.leak_cases where equipment_id = '00000000-0000-0000-0000-0000000000e1'), true);
select throws_ilike($$select public.record_leak_verification_test(current_setting('t.case')::uuid,'initial','pass',now(),'00000000-0000-0000-0000-0000000000c2','bubble_solution')$$,
  '%leak_cert_required%', 'an expired certification cannot sign a test');
select throws_ilike($$select public.record_leak_verification_test(current_setting('t.case')::uuid,'followup','pass',now(),'00000000-0000-0000-0000-0000000000c1','bubble_solution')$$,
  '%leak_case_invalid_state%', 'the follow-up test cannot precede the initial test');
select lives_ok($$select public.record_leak_verification_test(current_setting('t.case')::uuid,'initial','pass',now(),'00000000-0000-0000-0000-0000000000c1','electronic_leak_detector')$$, 'certified technician signs the initial test');
select ok((select status = 'initial_verified' and followup_test_due_on = (now() at time zone 'utc')::date + 10 from public.leak_cases where id = current_setting('t.case')::uuid), 'initial pass -> initial_verified, follow-up test due in 10 days');
select lives_ok($$select public.record_leak_verification_test(current_setting('t.case')::uuid,'followup','pass',now(),'00000000-0000-0000-0000-0000000000c1','pressure_decay')$$, 'second test signed');
select ok((select status = 'followup_scheduled' and followup_cadence = 'annual' from public.leak_cases where id = current_setting('t.case')::uuid), '15-499 lb appliance gets the annual inspection cadence');
select is((select count(*)::int from public.leak_followup_inspections where case_id = current_setting('t.case')::uuid), 1, 'one annual inspection scheduled');
select lives_ok($$select public.complete_leak_inspection((select id from public.leak_followup_inspections where case_id = current_setting('t.case')::uuid),'pass','00000000-0000-0000-0000-0000000000c1')$$, 'inspection completes');
select ok((select status = 'closed' and next_action is null from public.leak_cases where id = current_setting('t.case')::uuid), 'passing the last inspection closes the case');
reset role;  -- audit_log is not client-readable; inspect as the test superuser
select ok((select count(*) >= 4 from public.audit_log where action like 'leak_case.%' and target_id = current_setting('t.case')), 'every state change is audit-logged');

-- tenant isolation
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.leak_cases), 0, 'another account cannot see these cases');

select * from finish();
rollback;
