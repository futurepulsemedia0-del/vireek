-- Truck operations: restock forecast, scan-confirmed transfer orders, van audits, shrinkage detection,
-- low-stock alerts, roles and tenant isolation (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

-- ---------------------------------------------------------------- fixtures --
-- A owner, D dispatcher (office staff) of A, T technician of A (drives V), X owner of ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@trk.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'dispatch@trk.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@trk.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-trk.test');
insert into public.profiles (id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner')
on conflict (id) do nothing;
insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'dispatch@trk.test', 'Dana Dispatch', 'member',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@trk.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{}');
insert into public.inventory_locations (id, user_id, name, location_type, assigned_technician_id) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Main warehouse', 'warehouse', null),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'Van 1', 'van', '00000000-0000-0000-0000-0000000000c3'),
  ('00000000-0000-0000-0000-0000000000d9', '00000000-0000-0000-0000-0000000000b1', 'Other van', 'van', null);
insert into public.inventory_parts (id, user_id, name, part_number, barcode, unit_cost_cents) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'Capacitor', 'CAP-1', 'BC-P1', 1000),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', 'Contactor', 'CON-1', '0012345678905', 2500);
insert into public.inventory_par_levels (user_id, part_id, location_id, min_quantity, target_quantity) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d2', 2, 10);
insert into public.inventory_transactions (user_id, part_id, location_id, transaction_type, quantity_delta) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1', 'receipt', 50),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000d1', 'receipt', 20),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d2', 'receipt', 4);

-- History: five completed "AC Repair" jobs, each used 2 capacitors from the van (van now shows -6).
do $$
declare j uuid; i int;
begin
  for i in 1..5 loop
    insert into public.jobs (user_id, service_type, assigned_technician_id, job_status, completed_at)
    values ('00000000-0000-0000-0000-0000000000a1', 'AC Repair', '00000000-0000-0000-0000-0000000000c3', 'completed', now() - interval '10 days')
    returning id into j;
    insert into public.inventory_transactions (user_id, part_id, location_id, job_id, transaction_type, quantity_delta)
    values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d2', j, 'usage', -2);
  end loop;
  -- Upcoming: three jobs in 1-3 days; the first lists 3 contactors explicitly.
  for i in 1..3 loop
    insert into public.jobs (id, user_id, service_type, assigned_technician_id, job_status, scheduled_datetime)
    values (('00000000-0000-0000-0000-00000000010' || i)::uuid, '00000000-0000-0000-0000-0000000000a1', 'ac repair',
            '00000000-0000-0000-0000-0000000000c3', 'scheduled', now() + (i || ' days')::interval);
  end loop;
end $$;
insert into public.job_parts_required (user_id, job_id, part_id, quantity_required) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-0000000000f2', 3);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.act_super() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;
create or replace function pg_temp.raises(p_sql text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end $$;

-- ----------------------------------------------------------- forecast ------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.truck_restock_forecast()), 2, 'forecast: two parts need restocking on Van 1');
select is((select suggested_qty from public.truck_restock_forecast() where part_id = '00000000-0000-0000-0000-0000000000f1'), 16,
  'forecast: capacitor tops up to target 10 from -6 (job demand 8 + min 2 = 10)');
select is((select reason from public.truck_restock_forecast() where part_id = '00000000-0000-0000-0000-0000000000f1'), 'job_demand',
  'forecast: reason is job_demand when upcoming jobs outrun the truck');
select is((select forecast_demand from public.truck_restock_forecast() where part_id = '00000000-0000-0000-0000-0000000000f2'), 3,
  'forecast: explicit job part list counts as demand');
select is((select fulfillable_qty from public.truck_restock_forecast() where part_id = '00000000-0000-0000-0000-0000000000f1'), 16,
  'forecast: warehouse can cover the suggestion');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.truck_restock_forecast()), 0, 'forecast: another account sees nothing of ours');

-- --------------------------------------------------------- transfer flow ---
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select set_config('t.res', public.create_transfers_from_forecast()::text, true);
select is((current_setting('t.res')::jsonb ->> 'transfers')::int, 1, 'forecast -> one transfer order for the truck');
select is((select count(*)::int from public.stock_transfer_lines), 2, 'transfer has a line per part');
select is((public.create_transfers_from_forecast() ->> 'transfers')::int, 0, 'calling it again creates nothing (inbound already counted)');

select set_config('t.tid', (select id::text from public.stock_transfer_orders limit 1), true);
select set_config('t.l1', (select id::text from public.stock_transfer_lines where part_id = '00000000-0000-0000-0000-0000000000f1'), true);
select set_config('t.l2', (select id::text from public.stock_transfer_lines where part_id = '00000000-0000-0000-0000-0000000000f2'), true);

select is(public.ship_stock_transfer(current_setting('t.tid')::uuid) ->> 'status', 'unconfirmed_lines', 'ship: blocked until every line is confirmed');
select is(public.confirm_transfer_line(current_setting('t.l1')::uuid, 'pick', 16, '0012345678905') ->> 'status', 'wrong_part', 'pick: scanning the wrong part is rejected');
select is(public.confirm_transfer_line(current_setting('t.l1')::uuid, 'pick', 16, 'no-such-code') ->> 'status', 'unknown_code', 'pick: unknown code is rejected');
select is(public.confirm_transfer_line(current_setting('t.l1')::uuid, 'pick', 16) ->> 'status', 'scan_required', 'pick: no scan and no reason is rejected');
select is(public.confirm_transfer_line(current_setting('t.l1')::uuid, 'pick', 99, 'bc-p1') ->> 'status', 'invalid_quantity', 'pick: cannot pick more than planned');
select is(public.confirm_transfer_line(current_setting('t.l1')::uuid, 'pick', 16, 'bc-p1') ->> 'status', 'ok', 'pick: scan is case-insensitive');
select is(public.confirm_transfer_line(current_setting('t.l1')::uuid, 'pick', 16, 'CAP-1') ->> 'status', 'ok', 'pick: confirming again is harmless (set, not add)');
select is(public.confirm_transfer_line(current_setting('t.l2')::uuid, 'pick', 3, '12345678905') ->> 'status', 'ok', 'pick: UPC-A scan matches the EAN-13 stored for the part');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is(public.ship_stock_transfer(current_setting('t.tid')::uuid) ->> 'status', 'forbidden', 'ship: a technician cannot ship from the warehouse');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is(public.ship_stock_transfer(current_setting('t.tid')::uuid) ->> 'status', 'in_transit', 'ship: moves to in_transit');
select pg_temp.act_super();
select is((select quantity_on_hand from public.inventory_stock_levels where location_id = '00000000-0000-0000-0000-0000000000d1' and part_id = '00000000-0000-0000-0000-0000000000f1'), 34,
  'ship: stock left the warehouse (50 - 16)');

-- Technician receives 14 of 16 capacitors and all 3 contactors.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is(public.complete_stock_transfer(current_setting('t.tid')::uuid) ->> 'status', 'unconfirmed_lines', 'receive: cannot finish before checking every line');
select is(public.confirm_transfer_line(current_setting('t.l1')::uuid, 'receive', 14, 'BC-P1') ->> 'status', 'ok', 'receive: technician confirms a short quantity by scan');
select is(public.confirm_transfer_line(current_setting('t.l2')::uuid, 'receive', 3, '0012345678905') ->> 'status', 'ok', 'receive: technician confirms the contactors');
select is(public.complete_stock_transfer(current_setting('t.tid')::uuid) ->> 'short_lines', '1', 'receive: completes and reports one short line');
select pg_temp.act_super();
select is((select quantity_on_hand from public.inventory_stock_levels where location_id = '00000000-0000-0000-0000-0000000000d2' and part_id = '00000000-0000-0000-0000-0000000000f1'), 8,
  'receive: truck credited with what actually arrived (-6 + 14)');
select is((select severity || ':' || quantity::text || ':' || value_cents::text from public.inventory_variance_events where kind = 'transfer_shortage'), 'warning:2:2000',
  'receive: the 2 missing units become a transfer_shortage variance event');

-- ------------------------------------------------------------ permissions ---
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select ok(pg_temp.raises($q$ insert into public.stock_transfer_orders (user_id, transfer_number, from_location_id, to_location_id)
  values ('00000000-0000-0000-0000-0000000000a1', 'X', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2') $q$),
  'rls: technicians cannot write transfer orders directly');
select ok(pg_temp.raises($q$ insert into public.truck_ops_settings (user_id, audit_interval_days) values ('00000000-0000-0000-0000-0000000000a1', 3) $q$),
  'rls: technicians cannot change settings');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.stock_transfer_orders), 0, 'rls: another account sees none of our transfers');
select is(public.cancel_stock_transfer(current_setting('t.tid')::uuid) ->> 'status', 'not_found', 'rls: another account cannot cancel our transfer');

-- -------------------------------------------------- audit + alerts + scan ---
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select set_config('t.audit', public.start_van_audit()::text, true);
select is(current_setting('t.audit')::jsonb ->> 'status', 'started', 'audit: technician starts a blind audit of their own truck');
select is(public.start_van_audit() ->> 'status', 'already_open', 'audit: a second start reuses the open count');
select is((select audit_status from public.van_audit_status where location_id = '00000000-0000-0000-0000-0000000000d2'), 'in_progress', 'audit: truck shows as in progress');

select public.count_inventory_part((current_setting('t.audit')::jsonb ->> 'count_id')::uuid, null, 'BC-P1', 6);
select public.count_inventory_part((current_setting('t.audit')::jsonb ->> 'count_id')::uuid, null, '0012345678905', 3);
select public.submit_inventory_count((current_setting('t.audit')::jsonb ->> 'count_id')::uuid);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select public.approve_inventory_count((current_setting('t.audit')::jsonb ->> 'count_id')::uuid);

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is(public.run_my_truck_ops_scan() ->> 'status', 'ok', 'scan: dispatcher can run the ops scan');
select is((select value_cents from public.inventory_variance_events where kind = 'count_shortage'), 2000::bigint, 'variance: the 2 missing capacitors found by the audit are flagged');
select is(public.set_variance_event_status((select id from public.inventory_variance_events where kind = 'count_shortage'), 'acknowledged') ->> 'status', 'forbidden',
  'variance: only managers can triage shrinkage flags');

select * from finish();
rollback;
