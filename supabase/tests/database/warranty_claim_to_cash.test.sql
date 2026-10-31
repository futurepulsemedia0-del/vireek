-- Warranty claim-to-cash: detector, idempotency, state machine, variance, audit, recovery ledger, RLS (pgTAP).
-- Run: supabase test db     (NOT executed by the author: no Postgres in the authoring sandbox.)
-- If equipment / customers / inventory_parts / oem_manufacturers have extra NOT NULL columns, add them below.
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@wcc-a.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@wcc-b.test');

insert into public.customers (id, user_id, name, phone) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Pat Customer', '+15550177001');

insert into public.oem_manufacturers (id, slug, name) values
  ('00000000-0000-0000-0000-00000000f001', 'carrier-wcc', 'Carrier WCC');
insert into public.oem_warranty_terms (manufacturer_id, component, months, claim_window_days) values
  ('00000000-0000-0000-0000-00000000f001', 'parts', 120, 90);

insert into public.equipment (id, user_id, customer_id, equipment_type, make, model, serial_number, install_date, warranty_expires_at) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'Furnace', 'Carrier WCC', '59TP6', 'SN-WCC-0001', current_date - 365, null),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'Furnace', 'Carrier WCC', '59TP6', 'SN-WCC-0002', current_date - 4000, date '2020-01-01'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'Furnace', 'Carrier WCC', '59TP6', 'NA', current_date - 365, null),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'Furnace', 'Zzzco', 'Z1', 'SN-WCC-0004', current_date - 365, null);

insert into public.jobs (id, user_id, customer_name, job_status, completed_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Pat Customer', 'completed', now()),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'Pat Customer', 'completed', now()),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a1', 'Pat Customer', 'completed', now()),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000a1', 'Pat Customer', 'completed', now());
insert into public.job_equipment (job_id, equipment_id) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000e2'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000e3'),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000e4');

insert into public.inventory_parts (id, user_id, part_number, name, unit_cost_cents) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'IGN-1', 'Igniter', 7500);
insert into public.job_parts_required (user_id, job_id, part_id, quantity_required, status) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 2, 'installed');

create temp table ctx (k text primary key, v text);
grant all on ctx to public;

-- Detector ---------------------------------------------------------------------------------------
insert into ctx select 'run1', public.wcc_detect_claims('00000000-0000-0000-0000-0000000000a1')::text;
select is((select (v::jsonb ->> 'created')::int from ctx where k = 'run1'), 1, 'detector creates exactly the one eligible claim');
select is((select (v::jsonb ->> 'skipped_expired')::int from ctx where k = 'run1'), 1, 'expired warranty is skipped');
select is((select (v::jsonb ->> 'skipped_missing_serial')::int from ctx where k = 'run1'), 1, 'missing serial is skipped');
select is((select (v::jsonb ->> 'skipped_unknown_terms')::int from ctx where k = 'run1'), 1, 'unknown warranty terms are skipped (never guessed)');

insert into ctx select 'claim', id::text from public.warranty_claims where job_id = '00000000-0000-0000-0000-0000000000d1';
select is((select status from public.warranty_claims where id = (select v::uuid from ctx where k = 'claim')), 'needs_review', 'new claim starts at needs_review');
select is((select estimated_recovery_cents from public.warranty_claims where id = (select v::uuid from ctx where k = 'claim')), 15000, 'estimate = installed parts cost (2 x 7500); labor unknown so not guessed');
select is((select claim_deadline from public.warranty_claims where id = (select v::uuid from ctx where k = 'claim')),
          (select completed_at::date + 90 from public.jobs where id = '00000000-0000-0000-0000-0000000000d1'), 'deadline = completion + claim_window_days');

-- Idempotency --------------------------------------------------------------------------------------
select is((public.wcc_detect_claims('00000000-0000-0000-0000-0000000000a1') ->> 'created')::int, 0, 'second detector run creates nothing');
select is((select count(*)::int from public.warranty_claims where user_id = '00000000-0000-0000-0000-0000000000a1'), 1, 'still exactly one claim');
select is((select count(*)::int from public.warranty_claim_events where claim_id = (select v::uuid from ctx where k = 'claim')), 1, 'creation is audited once');

-- State machine ---------------------------------------------------------------------------------------
select throws_ok($$update public.warranty_claims set status = 'submitted' where id = (select v::uuid from ctx where k = 'claim')$$,
  '23514', 'invalid_claim_transition: needs_review -> submitted', 'cannot skip needs_review -> submitted');
select throws_ok($$update public.warranty_claims set status = 'ready' where id = (select v::uuid from ctx where k = 'claim')$$,
  '23514', 'claim_packet_incomplete', 'ready requires failure description');
select lives_ok($$update public.warranty_claims set failure_description = 'Igniter failed', status = 'ready' where id = (select v::uuid from ctx where k = 'claim')$$, 'ready once packet basics exist');
select throws_ok($$update public.warranty_claims set status = 'submitted' where id = (select v::uuid from ctx where k = 'claim')$$,
  '23514', 'manufacturer_reference_required', 'submitted needs manufacturer ref');
select lives_ok($$update public.warranty_claims set status = 'submitted', claim_number = 'RMA-1001' where id = (select v::uuid from ctx where k = 'claim')$$, 'submitted with ref');
select throws_ok($$update public.warranty_claims set status = 'paid', credit_received_cents = 100 where id = (select v::uuid from ctx where k = 'claim')$$,
  '23514', 'invalid_claim_transition: submitted -> paid', 'cannot pay before approval');
select throws_ok($$update public.warranty_claims set status = 'approved' where id = (select v::uuid from ctx where k = 'claim')$$,
  '23514', 'approved_amount_required', 'approval needs an amount');
select lives_ok($$update public.warranty_claims set status = 'approved', approved_amount_cents = 12000 where id = (select v::uuid from ctx where k = 'claim')$$, 'approved');
select throws_ok($$update public.warranty_claims set status = 'paid' where id = (select v::uuid from ctx where k = 'claim')$$,
  '23514', 'paid_amount_required', 'paid needs the amount received');
select lives_ok($$update public.warranty_claims set status = 'paid', credit_received_cents = 10000 where id = (select v::uuid from ctx where k = 'claim')$$, 'paid (short-pay)');

-- Recovery ledger, variance, audit, lock ---------------------------------------------------------------
select is((select recovered_amount_cents from public.revenue_recovery_events
           where source_table = 'warranty_claims' and source_id = (select v::uuid from ctx where k = 'claim') and source_type = 'warranty_claim_paid' and status = 'recovered'),
          10000, 'recovered cents appear in revenue_recovery_events');
select results_eq($$select variance_vs_estimate_cents, variance_vs_approved_cents, short_paid from public.warranty_claim_reconciliation where claim_id = (select v::uuid from ctx where k = 'claim')$$,
  $$values (-5000, -2000, true)$$, 'variance math and short-pay flag');
select is((select count(*)::int from public.warranty_claim_events where claim_id = (select v::uuid from ctx where k = 'claim')), 5, 'every transition is audited');
select throws_ok($$update public.warranty_claims set credit_received_cents = 99999 where id = (select v::uuid from ctx where k = 'claim')$$,
  '23514', 'claim_paid_locked', 'paid amounts are locked');

-- Legacy status mapping ---------------------------------------------------------------------------------
insert into public.warranty_claims (user_id, customer_name, status, claim_type)
  values ('00000000-0000-0000-0000-0000000000a1', 'Legacy Insert', 'eligible', 'manufacturer');
select is((select status from public.warranty_claims where customer_name = 'Legacy Insert'), 'needs_review', 'legacy eligible insert is stored as needs_review');

-- Packet ---------------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
set local role authenticated;
select is((public.wcc_packet((select v::uuid from ctx where k = 'claim')) -> 'parts' -> 0 ->> 'quantity')::int, 2, 'packet lists installed parts');
select ok((public.wcc_packet((select v::uuid from ctx where k = 'claim')) -> 'missing') ? 'labor_hours', 'packet flags missing labor hours');
reset role;

-- RLS / tenant isolation / privileges --------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
set local role authenticated;
select is((select count(*)::int from public.warranty_claims) + (select count(*)::int from public.warranty_claim_events)
        + (select count(*)::int from public.warranty_claim_reconciliation), 0, 'other tenant sees no claims, audit rows or reconciliation rows');
select throws_ok($$select public.wcc_packet((select v::uuid from ctx where k = 'claim'))$$, 'P0002', 'claim_not_found', 'other tenant cannot build a packet');
select throws_ok($$insert into public.warranty_claim_events (user_id, claim_id, to_status) values ('00000000-0000-0000-0000-0000000000b1', (select v::uuid from ctx where k = 'claim'), 'paid')$$,
  '42501', null, 'clients cannot forge audit rows');
reset role;
select ok(not has_function_privilege('authenticated', 'public.wcc_detect_claims(uuid,integer)', 'EXECUTE'), 'clients cannot run the detector');

select * from finish();
rollback;
