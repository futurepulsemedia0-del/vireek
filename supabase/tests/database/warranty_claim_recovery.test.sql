-- Warranty Claim Recovery: detector (coverage rules, skip+log, idempotency), human approval gate,
-- state machine, guard against direct writes, reconcile -> revenue_recovery_events, audit log,
-- expiry sweep, tenant isolation, office-only access (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(62);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@co.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@co.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-co.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@co.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{"can_view_all_jobs": false}');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- Fixture rows are inserted with triggers off (replica) so unrelated automations cannot interfere;
-- the code under test (guard, audit, detector) always runs with triggers ON.
set local session_replication_role = replica;

insert into public.customers (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Cust A'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b1', 'Cust B');

-- A made-up manufacturer so seeded OEM data can never interfere: 12 months base, 120 months if registered within 90 days.
insert into public.oem_manufacturers (id, slug, name) values
  ('00000000-0000-0000-0000-0000000000d1', 'zzwarranty-test', 'Zzwarranty Test');
insert into public.oem_warranty_terms (manufacturer_id, component, months, registered_months, registration_window_days) values
  ('00000000-0000-0000-0000-0000000000d1', 'parts', 12, 120, 90);

insert into public.equipment (id, user_id, customer_id, equipment_type, make, model, serial_number, install_date, warranty_expires_at) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'furnace', 'Zzwarranty Test', 'M1', 'S1', current_date - 200, null),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'furnace', 'Zzwarranty Test', 'M2', 'S2', current_date - 800, null),
  ('00000000-0000-0000-0000-00000000e003', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'furnace', 'Zzwarranty Test', 'M3', 'S3', null, null),
  ('00000000-0000-0000-0000-00000000e004', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'furnace', 'Unknown Brand', 'X', 'S4', current_date - 100, current_date + 100),
  ('00000000-0000-0000-0000-00000000e005', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'furnace', 'Zzwarranty Test', 'M5', 'S5', current_date - 200, null),
  ('00000000-0000-0000-0000-00000000e006', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'furnace', 'Zzwarranty Test', 'M6', 'S6', current_date - 500, null),
  ('00000000-0000-0000-0000-00000000e007', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'furnace', 'Zzwarranty Test', 'M7', 'S7', current_date - 500, null);

insert into public.jobs (id, user_id, customer_name, job_status, completed_at) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000a1', 'Cust A', 'completed', now() - interval '5 days'),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000000a1', 'Cust A', 'completed', now() - interval '5 days'),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-0000000000a1', 'Cust A', 'completed', now() - interval '5 days'),
  ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-0000000000a1', 'Cust A', 'completed', now() - interval '5 days'),
  ('00000000-0000-0000-0000-00000000f005', '00000000-0000-0000-0000-0000000000a1', 'Cust A', 'completed', now() - interval '5 days'),
  ('00000000-0000-0000-0000-00000000f006', '00000000-0000-0000-0000-0000000000a1', 'Cust A', 'completed', now() - interval '5 days'),
  ('00000000-0000-0000-0000-00000000f007', '00000000-0000-0000-0000-0000000000a1', 'Cust A', 'completed', now() - interval '5 days');

insert into public.job_equipment (job_id, equipment_id) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000e001'),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000e002'),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-00000000e003'),
  ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-00000000e004'),
  ('00000000-0000-0000-0000-00000000f005', '00000000-0000-0000-0000-00000000e005'),
  ('00000000-0000-0000-0000-00000000f006', '00000000-0000-0000-0000-00000000e006'),
  ('00000000-0000-0000-0000-00000000f007', '00000000-0000-0000-0000-00000000e007');

-- E6: owner registered on time (inside the 90-day window) -> registered_months applies.
-- E7: owner registered late (today) -> window missed -> base months only -> out of warranty.
insert into public.equipment_passports (id, public_code, equipment_type, status) values
  ('00000000-0000-0000-0000-00000000a006', 'ABCDEFGH2345', 'furnace', 'active'),
  ('00000000-0000-0000-0000-00000000a007', 'ABCDEFGH2346', 'furnace', 'active');
insert into public.equipment_passport_links (passport_id, user_id, equipment_id, verified, verified_via, status) values
  ('00000000-0000-0000-0000-00000000a006', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000e006', true, 'code', 'active'),
  ('00000000-0000-0000-0000-00000000a007', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000e007', true, 'code', 'active');
insert into public.warranty_registrations (confirmation_code, passport_id, owner_name, owner_email, equipment_type, make, model, serial_number, purchase_date, terms_accepted, created_at) values
  ('WR-TEST-0006', '00000000-0000-0000-0000-00000000a006', 'Owner Six', 'six@home.test', 'furnace', 'Zzwarranty Test', 'M6', 'S6-SERIAL', current_date - 500, true, (current_date - 450)::timestamptz),
  ('WR-TEST-0007', '00000000-0000-0000-0000-00000000a007', 'Owner Seven', 'seven@home.test', 'furnace', 'Zzwarranty Test', 'M7', 'S7-SERIAL', current_date - 500, true, now());

set local session_replication_role = origin;

-- E5 already has a claim (manual): the detector must leave it alone and never duplicate it.
insert into public.warranty_claims (id, user_id, job_id, equipment_id, customer_name, status) values
  ('00000000-0000-0000-0000-0000000005c5', '00000000-0000-0000-0000-0000000000a1',
   '00000000-0000-0000-0000-00000000f005', '00000000-0000-0000-0000-00000000e005', 'Manual Co', 'needs_review');

-- ------------------------------------------------------------ detector run 1 --
select set_config('t.run1', public.warranty_recovery_detect('00000000-0000-0000-0000-0000000000a1')::text, true);

select is((current_setting('t.run1')::jsonb ->> 'scanned')::int, 6, 'detector scans the 6 unclaimed completed jobs (the already-claimed one is excluded)');
select is((current_setting('t.run1')::jsonb ->> 'created')::int, 3, 'detector creates 3 claims: OEM terms, owner registration, equipment expiry fallback');
select is((current_setting('t.run1')::jsonb ->> 'skipped_logged')::int, 1, 'exactly one job is skipped for missing data');
select is((select count(*)::int from public.warranty_claims where user_id = '00000000-0000-0000-0000-0000000000a1' and detection_source = 'auto'), 3, 'three auto claims exist');

select is((select status || '|' || detection_source || '|' || manufacturer || '|' || serial_number
           from public.warranty_claims where equipment_id = '00000000-0000-0000-0000-00000000e001'),
  'needs_review|auto|Zzwarranty Test|S1', 'auto claim is needs_review with unit facts copied from the equipment record');
select is((select detection_basis ->> 'source' from public.warranty_claims where equipment_id = '00000000-0000-0000-0000-00000000e001'),
  'oem_warranty_terms', 'coverage basis is recorded (OEM terms)');
select is((select claim_deadline from public.warranty_claims where equipment_id = '00000000-0000-0000-0000-00000000e001'),
  null::date, 'no filing window configured -> deadline is NOT guessed');
select is((select (detection_basis ->> 'used_registered_months')::boolean from public.warranty_claims where equipment_id = '00000000-0000-0000-0000-00000000e006'),
  true, 'on-time owner registration extends coverage (registered_months used)');
select is((select detection_basis ->> 'source' from public.warranty_claims where equipment_id = '00000000-0000-0000-0000-00000000e004'),
  'equipment_warranty_expires_at', 'no OEM match -> falls back to the equipment warranty_expires_at');
select is((select count(*)::int from public.warranty_claims where equipment_id in ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-00000000e007')),
  0, 'out-of-warranty units (and a late registration) produce no claim');
select is((select reason from public.warranty_recovery_detection_log where equipment_id = '00000000-0000-0000-0000-00000000e003' and outcome = 'skipped'),
  'missing_install_date', 'missing install date is skipped and logged, never guessed');
select is((select count(*)::int from public.warranty_recovery_detection_log where equipment_id = '00000000-0000-0000-0000-00000000e002'),
  0, 'a definitively out-of-warranty unit is not logged as a data problem');
select is((select count(*)::int from public.warranty_claims where job_id = '00000000-0000-0000-0000-00000000f005'),
  1, 'a job that already has a claim is not duplicated');
select is((select count(*)::int from public.audit_log where action = 'warranty_claim.auto_detected' and user_id = '00000000-0000-0000-0000-0000000000a1'),
  3, 'each auto-detected claim is audit-logged');

-- --------------------------------------------------------------- idempotency --
select set_config('t.run2', public.warranty_recovery_detect('00000000-0000-0000-0000-0000000000a1')::text, true);
select is((current_setting('t.run2')::jsonb ->> 'created')::int, 0, 'second run creates nothing');
select is((select count(*)::int from public.warranty_claims where user_id = '00000000-0000-0000-0000-0000000000a1' and detection_source = 'auto'), 3, 'still exactly three auto claims after a rerun');
select is((select run_count from public.warranty_recovery_detection_log where equipment_id = '00000000-0000-0000-0000-00000000e003'),
  2, 'the skip log row is updated in place, not duplicated');

-- A claim a human deleted is never resurrected.
delete from public.warranty_claims where equipment_id = '00000000-0000-0000-0000-00000000e001';
select set_config('t.run3', public.warranty_recovery_detect('00000000-0000-0000-0000-0000000000a1')::text, true);
select is((select count(*)::int from public.warranty_claims where equipment_id = '00000000-0000-0000-0000-00000000e001'),
  0, 'a deleted claim is not recreated by the next run');

-- ---------------------------------------- tenant filing window + other tenant --
update public.profiles set warranty_claim_window_days = 60 where id = '00000000-0000-0000-0000-0000000000a1';

set local session_replication_role = replica;
insert into public.equipment (id, user_id, customer_id, equipment_type, make, model, serial_number, install_date) values
  ('00000000-0000-0000-0000-00000000e009', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'furnace', 'Zzwarranty Test', 'M9', 'S9', current_date - 100),
  ('00000000-0000-0000-0000-00000000e0b1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c2', 'furnace', 'Zzwarranty Test', 'MB', 'SB', current_date - 100);
insert into public.jobs (id, user_id, customer_name, job_status, completed_at) values
  ('00000000-0000-0000-0000-00000000f009', '00000000-0000-0000-0000-0000000000a1', 'Cust A', 'completed', now() - interval '3 days'),
  ('00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-0000000000b1', 'Cust B', 'completed', now() - interval '3 days');
insert into public.job_equipment (job_id, equipment_id) values
  ('00000000-0000-0000-0000-00000000f009', '00000000-0000-0000-0000-00000000e009'),
  ('00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-00000000e0b1');
set local session_replication_role = origin;

select set_config('t.run4', public.warranty_recovery_detect()::text, true);   -- all tenants
select is((current_setting('t.run4')::jsonb ->> 'created')::int, 2, 'a global run creates one claim per tenant');
select is((select claim_deadline from public.warranty_claims where equipment_id = '00000000-0000-0000-0000-00000000e009'),
  ((now() - interval '3 days')::date + 60), 'deadline = completed date + the tenant''s own filing window');

-- ------------------------------------------------------------ tenant isolation --
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.warranty_claims), 1, 'tenant B sees only its own claim');
select is((select count(*)::int from public.warranty_recovery_detection_log), 1, 'tenant B sees only its own detection log');
select throws_ok($$ select public.warranty_claim_packet('00000000-0000-0000-0000-0000000005c5') $$,
  'P0002', null, 'tenant B cannot build a packet for tenant A''s claim');

reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.warranty_claims where user_id = '00000000-0000-0000-0000-0000000000b1'), 0, 'tenant A cannot see tenant B''s claims');
select throws_ok($$ select public.warranty_recovery_detect() $$, '42501', null, 'detector is service-role only (not callable by a signed-in user)');

reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from public.warranty_recovery_detection_log), 0, 'technicians cannot read the detection log');
select throws_ok($$ select public.warranty_claim_transition('00000000-0000-0000-0000-0000000005c5', 'ready', null, null, true) $$,
  '42501', null, 'technicians cannot move claims through the workflow');

-- ---------------------------------- guard: no direct writes around the gate --
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.c4', (select id::text from public.warranty_claims where equipment_id = '00000000-0000-0000-0000-00000000e004'), true);
select set_config('t.c6', (select id::text from public.warranty_claims where equipment_id = '00000000-0000-0000-0000-00000000e006'), true);

select throws_ok($$ update public.warranty_claims set status = 'ready' where id = current_setting('t.c4')::uuid $$,
  '42501', null, 'status cannot be changed by a direct table update');
select throws_ok($$ insert into public.warranty_claims (user_id, customer_name, status) values ('00000000-0000-0000-0000-0000000000a1', 'X', 'credit_received') $$,
  '42501', null, 'a claim cannot be inserted already paid');
select throws_ok($$ update public.warranty_claims set credit_received_cents = 99999 where id = current_setting('t.c4')::uuid $$,
  '42501', null, 'recovered money cannot be edited around the reconcile RPC');
select lives_ok($$ update public.warranty_claims set notes = 'call distributor' where id = current_setting('t.c4')::uuid $$,
  'ordinary fields stay editable');

-- ------------------------------------------- state machine + approval gate --
select is(public.warranty_claim_transition_allowed('needs_review', 'submitted'), false, 'cannot skip from needs_review straight to submitted');
select is(public.warranty_claim_transition_allowed('ready', 'submitted'), true, 'ready -> submitted is allowed');

select throws_ok($$ select public.warranty_claim_transition(current_setting('t.c4')::uuid, 'ready') $$,
  '22023', null, 'approval needs the explicit human confirmation');
select throws_like($$ select public.warranty_claim_transition(current_setting('t.c4')::uuid, 'ready', null, null, true) $$,
  'WARRANTY_PACKET_INCOMPLETE%', 'cannot be approved while required facts are missing');
select ok((public.warranty_claim_packet(current_setting('t.c4')::uuid) -> 'blocking_missing') @> '"failure_notes"'::jsonb,
  'the packet flags missing failure notes instead of inventing them');
select is((public.warranty_claim_packet(current_setting('t.c4')::uuid) -> 'unit' ->> 'serial_number'), 'S4',
  'packet facts come from the equipment record');

select lives_ok($$ update public.warranty_claims set failure_description = 'Compressor failed', claim_deadline = current_date + 30 where id = current_setting('t.c4')::uuid $$,
  'a human fills in the missing facts');
select is((public.warranty_claim_packet(current_setting('t.c4')::uuid) ->> 'complete')::boolean, true, 'packet is complete once required facts exist');

select throws_like($$ select public.warranty_claim_transition(current_setting('t.c6')::uuid, 'submitted', 'REF', null, true) $$,
  'WARRANTY_INVALID_TRANSITION%', 'needs_review cannot be submitted directly');
select lives_ok($$ select public.warranty_claim_transition(current_setting('t.c4')::uuid, 'ready', null, null, true) $$, 'approved for submission');
select is((select status || '|' || (ready_approved_at is not null)::text from public.warranty_claims where id = current_setting('t.c4')::uuid),
  'ready|true', 'approval is recorded with a timestamp');

select throws_like($$ select public.warranty_claim_transition(current_setting('t.c4')::uuid, 'submitted', null, null, true) $$,
  'WARRANTY_REF_REQUIRED%', 'submitted needs the reference number the user got from the manufacturer');
select lives_ok($$ select public.warranty_claim_transition(current_setting('t.c4')::uuid, 'submitted', 'MFR-REF-1', null, true) $$, 'marked submitted (manually)');
select is((select status || '|' || claim_number from public.warranty_claims where id = current_setting('t.c4')::uuid),
  'submitted|MFR-REF-1', 'status and manual reference stored');
select throws_like($$ select public.warranty_claim_transition(current_setting('t.c4')::uuid, 'credit_received', null, null, true) $$,
  'WARRANTY_USE_RECORD_PAYMENT%', 'payment status only via the reconcile RPC');

-- -------------------------------------------------------------- reconcile --
select throws_like($$ select public.warranty_claim_record_payment(current_setting('t.c4')::uuid, 0) $$,
  'WARRANTY_AMOUNT_INVALID%', 'zero amount rejected');
select throws_like($$ select public.warranty_claim_record_payment(current_setting('t.c6')::uuid, 5000) $$,
  'WARRANTY_INVALID_TRANSITION%', 'cannot record payment on a claim that was never submitted');
select lives_ok($$ select public.warranty_claim_record_payment(current_setting('t.c4')::uuid, 12345, current_date, 'check') $$, 'payment recorded');
select is((select status || ':' || recovered_amount_cents::text || ':' || source_type
           from public.revenue_recovery_events where source_table = 'warranty_claims' and source_id = current_setting('t.c4')::uuid),
  'recovered:12345:warranty_claim_recovered', 'recovered $ is written to revenue_recovery_events');
select lives_ok($$ select public.warranty_claim_record_payment(current_setting('t.c4')::uuid, 15000, current_date, 'check') $$, 'amount can be corrected');
select is((select count(*)::int || ':' || max(recovered_amount_cents)::text from public.revenue_recovery_events
           where source_table = 'warranty_claims' and source_id = current_setting('t.c4')::uuid),
  '1:15000', 'correction updates the same ledger row (idempotent, no double count)');
select is((select status || ':' || credit_received_cents::text from public.warranty_claims where id = current_setting('t.c4')::uuid),
  'credit_received:15000', 'claim shows Paid with the recorded amount');

-- cross-tenant attempts against a real claim id
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_like($$ select public.warranty_claim_record_payment(current_setting('t.c4')::uuid, 100) $$,
  'WARRANTY_CLAIM_NOT_FOUND%', 'tenant B cannot record a payment on tenant A''s claim');
select throws_like($$ select public.warranty_claim_transition(current_setting('t.c4')::uuid, 'closed') $$,
  'WARRANTY_CLAIM_NOT_FOUND%', 'tenant B cannot transition tenant A''s claim');

-- ------------------------------------------------------------------- audit --
reset role;
select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
select is((select count(*)::int from public.audit_log where action = 'warranty_claim.status_changed' and target_id = current_setting('t.c4')),
  3, 'every status change is audit-logged (needs_review>ready>submitted>paid)');
select is((select count(*)::int from public.audit_log where action = 'warranty_claim.payment_recorded' and target_id = current_setting('t.c4')),
  2, 'each payment record/correction is audit-logged');

-- ------------------------------------------------------------ expiry sweep --
update public.warranty_claims set claim_deadline = current_date - 10 where id in (current_setting('t.c6')::uuid, current_setting('t.c4')::uuid);
select set_config('t.run6', public.warranty_recovery_detect('00000000-0000-0000-0000-0000000000a1')::text, true);
select is((select status from public.warranty_claims where id = current_setting('t.c6')::uuid), 'expired', 'an unsubmitted claim 7+ days past its deadline expires');
select is((select status from public.warranty_claims where id = current_setting('t.c4')::uuid), 'credit_received', 'a paid claim is never expired');
select is((select count(*)::int from public.audit_log where action = 'warranty_claim.status_changed' and target_id = current_setting('t.c6')),
  1, 'the automatic expiry is audit-logged');

-- ------------------------------------------------------------ ledger rules --
select lives_ok($$ insert into public.revenue_recovery_events (user_id, source_type, source_table, source_id, customer_name, occurred_at, estimated_value_cents, status)
    values ('00000000-0000-0000-0000-0000000000a1', 'job_parts_unbilled', 'jobs', '00000000-0000-0000-0000-00000000f001', 'Regression', now(), 100, 'open') $$,
  'existing ledger sources still work (no regression)');
select throws_ok($$ insert into public.revenue_recovery_events (user_id, source_type, source_table, source_id, customer_name, occurred_at, estimated_value_cents, status)
    values ('00000000-0000-0000-0000-0000000000a1', 'bogus_source', 'jobs', '00000000-0000-0000-0000-00000000f002', 'Bad', now(), 100, 'open') $$,
  '23514', null, 'unknown ledger sources are still rejected');

select * from finish();
rollback;
