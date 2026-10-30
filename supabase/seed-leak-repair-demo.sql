-- Refrigerant Leak-Repair Loop — demo data (DEV / STAGING ONLY — never run against production).
-- Seeds, for the demo account (a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11):
--   1. a leak case taken through the whole loop: open -> initial_verified -> followup_scheduled -> closed
--   2. an OVERDUE case (repair window already passed) so the dashboard card + overdue badge show
-- It goes through the real triggers/RPCs (impersonating the owner), so audit rows and timeline events are genuine.
-- Safe to re-run: fixed ids + "already seeded" guard. Requires the leak-repair migration.
-- Remove later: delete the 'DEMO-LEAK' equipment/cases as service role (ledger + case tables are append-only/guarded; pause triggers first).

do $$
declare
  v_user  constant uuid := 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  v_tech  constant uuid := 'a0eebc99-0000-4000-8000-00000000ee01';
  v_cust  constant uuid := 'a0eebc99-0000-4000-8000-00000000ee02';
  v_eq_ok constant uuid := 'a0eebc99-0000-4000-8000-00000000ee03';
  v_eq_od constant uuid := 'a0eebc99-0000-4000-8000-00000000ee04';
  v_job   constant uuid := 'a0eebc99-0000-4000-8000-00000000ee05';
  v_email text;
  v_case  uuid;
  v_insp  uuid;
begin
  if not exists (select 1 from profiles where id = v_user) then
    raise notice 'Demo account not found - nothing seeded.'; return;
  end if;
  if exists (select 1 from equipment where id = v_eq_ok) then
    raise notice 'Leak-repair demo already seeded.'; return;
  end if;
  select email into v_email from profiles where id = v_user;

  insert into team_members (id, account_owner_id, member_email, member_name, role, invite_status)
  values (v_tech, v_user, 'demo-leak-tech@example.invalid', 'Dana Demo (EPA 608)', 'technician', 'active')
  on conflict (id) do nothing;
  insert into technician_credentials (user_id, technician_id, credential_type, credential_number, expires_at, status)
  values (v_user, v_tech, 'epa_608_universal', 'DEMO-608-0001', null, 'active');

  insert into customers (id, user_id, name, phone, address)
  values (v_cust, v_user, 'DEMO-LEAK Fresh Market', '555-0142', '200 Harbor Rd')
  on conflict (id) do nothing;

  insert into equipment (id, user_id, customer_id, equipment_type, make, model, serial_number, install_date,
                         refrigerant_type, refrigerant_charge_lbs, appliance_category) values
    (v_eq_ok, v_user, v_cust, 'Rooftop unit', 'Trane', 'DEMO-RTU-40', 'DEMO-LEAK-1', current_date - 900, 'R-410A', 40,  'comfort_cooling'),
    (v_eq_od, v_user, v_cust, 'Walk-in cooler rack', 'Hill Phoenix', 'DEMO-RACK-100', 'DEMO-LEAK-2', current_date - 900, 'R-404A', 100, 'commercial_refrigeration');

  insert into jobs (id, user_id, customer_name, service_type, address, job_status, customer_id)
  values (v_job, v_user, 'DEMO-LEAK Fresh Market', 'HVAC repair', '200 Harbor Rd', 'in_progress', v_cust);

  -- act as the owner: refrigerant_log's trigger needs auth.uid()
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- (1) 20% > 10% comfort threshold -> case auto-opens; then walk it through the loop.
  insert into refrigerant_log (job_id, equipment_id, technician_id, event_type, refrigerant_type, pounds, performed_at)
  values (v_job, v_eq_ok, v_tech, 'added', 'R-410A', 8, now() - interval '12 days');
  select id into v_case from leak_cases where equipment_id = v_eq_ok;
  perform record_leak_verification_test(v_case, 'initial',  'pass', now() - interval '6 days', v_tech, 'electronic_leak_detector', 'Brazed joint on liquid line repaired.');
  perform record_leak_verification_test(v_case, 'followup', 'pass', now() - interval '1 day',  v_tech, 'pressure_decay',            'Held at normal operation.');
  select id into v_insp from leak_followup_inspections where case_id = v_case order by period_index limit 1;
  perform complete_leak_inspection(v_insp, 'pass', v_tech);

  -- (2) 23% > 20% commercial threshold, detected 45 days ago and never repaired -> overdue.
  insert into refrigerant_log (job_id, equipment_id, technician_id, event_type, refrigerant_type, pounds, performed_at)
  values (v_job, v_eq_od, v_tech, 'added', 'R-404A', 23, now() - interval '45 days');

  raise notice 'Leak-repair demo seeded: 1 closed case, 1 overdue case.';
end $$;
