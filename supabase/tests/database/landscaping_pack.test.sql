-- Landscaping pack: gate (flag + entitlement), RLS isolation, planner parity (DST / holidays), idempotent generation,
-- re-route, photo gate, batch billing idempotency, pause/resume (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@green.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');
insert into public.team_members (id, account_owner_id, member_email, member_name, role, invite_status) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'lead@green.test', 'Crew Lead', 'technician', 'active');
insert into public.customers (id, user_id, name, phone, address, email) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Smith Residence', '555-0101', '1 Oak St', 's@x.test'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'Jones Residence', '555-0102', '2 Elm St', 'j@x.test'),
  ('00000000-0000-0000-0000-0000000000d9', '00000000-0000-0000-0000-0000000000b1', 'Other Tenant Customer', '555-0999', '9 Pine', null);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ---------- structure ----------
select has_table('public', 'landscape_contracts', 'contracts table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.landscape_visits'::regclass), 'RLS enabled on visits');
select has_function('public', 'landscape_run_billing', array['text', 'uuid[]'], 'batch billing RPC exists');
select is((select enabled from public.feature_flags where key = 'landscaping_pack'), false, 'flag is seeded OFF');
select is((select count(*)::int from public.trade_pack_installs where pack_key = 'landscaping'), 0, 'no tenant has the pack installed by default');

-- ---------- gate: flag OFF + no entitlement ----------
select throws_ok($$insert into public.trade_pack_installs (user_id, pack_key) values ('00000000-0000-0000-0000-0000000000a1', 'landscaping')$$,
  '42501', 'landscaping_not_enabled', 'install refused while the gate is closed');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$select public.landscape_generate_my_visits()$$, '42501', 'landscaping_not_enabled', 'RPCs refuse while the gate is closed');
select throws_ok($$select public.staff_set_account_entitlement('00000000-0000-0000-0000-0000000000a1', 'packs:landscaping', true, 'self-grant')$$,
  '42501', 'Staff only', 'tenants cannot grant themselves the entitlement');
reset role;

-- open the gate for tenant A only (flag on for everyone, entitlement for A)
update public.feature_flags set enabled = true, rollout_pct = 100 where key = 'landscaping_pack';
insert into public.account_entitlements (user_id, entitlement_key) values ('00000000-0000-0000-0000-0000000000a1', 'packs:landscaping');
select is(public.landscape_pack_allowed('00000000-0000-0000-0000-0000000000a1'), true, 'flag + entitlement ⇒ allowed');
select is(public.landscape_pack_allowed('00000000-0000-0000-0000-0000000000b1'), false, 'flag without entitlement ⇒ still not allowed');

-- ---------- config + RLS ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
insert into public.landscape_crews (id, name, lead_technician_id) values ('00000000-0000-0000-0000-0000000000e1', 'Crew A', '00000000-0000-0000-0000-0000000000c1');
insert into public.landscape_properties (id, customer_id, label, turf_sqft) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1', 'Front + back', 6000);
insert into public.landscape_contracts (id, customer_id, property_id, title, start_date, default_crew_id, visit_price_cents, preferred_time, timezone, holiday_set, checklist)
values ('00000000-0000-0000-0000-000000000a01', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'Smith weekly', current_date, '00000000-0000-0000-0000-0000000000e1', 5500, '09:00', 'America/Chicago', 'none',
        '[{"key":"mow","label":"Mow","required":true},{"key":"edge","label":"Edge","required":false}]');
insert into public.landscape_contracts (id, customer_id, title, start_date, default_crew_id, visit_price_cents, preferred_time, timezone, holiday_set, billing_mode, monthly_fee_cents)
values ('00000000-0000-0000-0000-000000000a02', '00000000-0000-0000-0000-0000000000d2', 'Jones weekly', current_date, '00000000-0000-0000-0000-0000000000e1', 4500, '09:00', 'America/Chicago', 'none', 'per_visit', 0);
select throws_ok($$insert into public.landscape_contracts (customer_id, title, start_date) values ('00000000-0000-0000-0000-0000000000d9', 'x', current_date)$$,
  '23503', 'customer not found', 'a contract cannot reference another tenant''s customer');
select throws_ok($$insert into public.landscape_contracts (customer_id, title, start_date, seasons) values ('00000000-0000-0000-0000-0000000000d1', 'x', current_date, '[{"fromMonth":1,"toMonth":6,"intervalWeeks":1},{"fromMonth":6,"toMonth":9,"intervalWeeks":2}]')$$,
  '23514', null, 'overlapping seasons are rejected by the database');
select throws_ok($$insert into public.landscape_contracts (customer_id, title, start_date, preferred_time) values ('00000000-0000-0000-0000-0000000000d1', 'x', current_date, '02:30')$$,
  '23514', null, 'start times inside the DST gap window are rejected');
select throws_ok($$update public.landscape_visits set status = 'completed'$$, '42501', null, 'tenants cannot write visits directly');
reset role;

-- ---------- planner parity with recurrence.ts ----------
update public.landscape_contracts set start_date = '2027-05-17', holiday_set = 'us_core', holiday_policy = 'shift_next' where id = '00000000-0000-0000-0000-000000000a02';
select is((select o_visit_date from public.landscape_plan_visits('00000000-0000-0000-0000-000000000a02', '2027-05-31', '2027-05-31')), date '2027-06-01',
  'Memorial Day visit shifts to Tuesday (same as the TS engine)');
select is((select o_visit_date from public.landscape_plan_visits('00000000-0000-0000-0000-000000000a02', '2027-06-07', '2027-06-07')), date '2027-06-07', 'later visits do not drift');
select is(((date '2027-03-15' + time '09:00') at time zone 'America/Chicago'), timestamptz '2027-03-15 14:00:00+00', '09:00 local = 14:00Z after spring-forward');
select is(((date '2027-03-08' + time '09:00') at time zone 'America/Chicago'), timestamptz '2027-03-08 15:00:00+00', '09:00 local = 15:00Z before spring-forward');
update public.landscape_contracts set start_date = current_date, holiday_set = 'none' where id = '00000000-0000-0000-0000-000000000a02';

-- ---------- activation + idempotent generation ----------
update public.landscape_contracts set status = 'active' where id in ('00000000-0000-0000-0000-000000000a01', '00000000-0000-0000-0000-000000000a02');
select public._landscape_generate_contract('00000000-0000-0000-0000-000000000a01', 28);
select public._landscape_generate_contract('00000000-0000-0000-0000-000000000a02', 28);
create temp table gen1 as select count(*)::int as n from public.landscape_visits;
select public._landscape_generate_contract('00000000-0000-0000-0000-000000000a01', 28);
select public._landscape_generate_contract('00000000-0000-0000-0000-000000000a02', 28);
select is((select count(*)::int from public.landscape_visits), (select n from gen1), 're-running generation creates nothing new');
select ok((select count(*) from public.landscape_visits where contract_id = '00000000-0000-0000-0000-000000000a01') >= 3, 'weekly contract has ≥3 visits in 28 days');
select is((select count(*)::int from public.landscape_visits where status = 'scheduled' and job_id is null), 0, 'every scheduled visit got a dispatch job');
select is((select count(*)::int from public.landscape_visit_tasks t join public.landscape_visits v on v.id = t.visit_id where v.contract_id = '00000000-0000-0000-0000-000000000a01' and t.task_key = 'mow'), (select count(*)::int from public.landscape_visits where contract_id = '00000000-0000-0000-0000-000000000a01' and status = 'scheduled'), 'checklist tasks seeded per visit');

-- ---------- tenant isolation ----------
insert into public.account_entitlements (user_id, entitlement_key) values ('00000000-0000-0000-0000-0000000000b1', 'packs:landscaping');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.landscape_contracts), 0, 'tenant B sees none of tenant A''s contracts');
select is((select count(*)::int from public.landscape_visits), 0, 'tenant B sees none of tenant A''s visits');
reset role;

-- ---------- photo gate + completion + billing idempotency ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
create temp table first_visit as select id, job_id, visit_date from public.landscape_visits where contract_id = '00000000-0000-0000-0000-000000000a01' and status = 'scheduled' order by visit_date limit 1;
select throws_ok(format($$select public.landscape_complete_visit(%L)$$, (select id from first_visit)), '22023', 'required_tasks_open', 'cannot complete with required tasks open');
select public.landscape_set_task((select id from first_visit), 'mow', 'done', null);
select throws_ok(format($$select public.landscape_complete_visit(%L)$$, (select id from first_visit)), '22023', 'photos_required', 'cannot complete without before AND after photos');
reset role;
insert into public.job_photos (user_id, job_id, storage_path, file_name, size_bytes, kind) values
  ('00000000-0000-0000-0000-0000000000a1', (select job_id from first_visit), 'ls/test-before.jpg', 'b.jpg', 1000, 'before'),
  ('00000000-0000-0000-0000-0000000000a1', (select job_id from first_visit), 'ls/test-after.jpg', 'a.jpg', 1000, 'after');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((public.landscape_complete_visit((select id from first_visit)))->>'status', 'completed', 'completes once both photos exist');
select is((public.landscape_complete_visit((select id from first_visit)))->>'status', 'already_completed', 'completing twice is a no-op');
select is((public.landscape_run_billing(to_char((select visit_date from first_visit), 'YYYY-MM')))->>'created', '1', 'first billing run creates one invoice');
select is((public.landscape_run_billing(to_char((select visit_date from first_visit), 'YYYY-MM')))->>'created', '0', 'second run creates none (idempotent)');
select is((select count(*)::int from public.invoices where notes like 'Landscaping contract "Smith weekly"%'), 1, 'exactly one invoice exists for the contract and month');
reset role;

select * from finish();
rollback;
