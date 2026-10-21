-- Job parts ordering: catalog import, search, cart, PO creation, delivery tracking, job auto-resume (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

-- ---------------------------------------------------------------- fixtures --
-- A owner, T technician of A, X owner of ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');
insert into public.profiles (id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner')
on conflict (id) do nothing;
insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@acme.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{"can_view_all_jobs": false}');
insert into public.jobs (id, user_id, customer_name, assigned_technician_id) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'Ann Lee', '00000000-0000-0000-0000-0000000000c3');
insert into public.inventory_locations (id, user_id, name, location_type, assigned_technician_id) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Main warehouse', 'warehouse', null),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'Van 1', 'van', '00000000-0000-0000-0000-0000000000c3');
insert into public.inventory_vendors (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'Acme Supply'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', 'Budget Parts'),
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000b1', 'Other Co Vendor');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.act_service() returns void language plpgsql as $$
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- ------------------------------------------------------------ price import --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.imp', public.import_supplier_prices('00000000-0000-0000-0000-0000000000f1', jsonb_build_array(
  jsonb_build_object('sku', 'CAP-45', 'name', '45/5 MFD capacitor', 'mpn', 'C45', 'unit_cost', '12.50', 'stock_status', 'in_stock', 'lead_time_days', 2, 'pack_size', 2),
  jsonb_build_object('sku', 'CON-30', 'name', 'Contactor 30A', 'unit_cost_cents', '2400'),
  jsonb_build_object('sku', 'BAD-1', 'name', 'Broken', 'unit_cost', 'abc'),
  jsonb_build_object('sku', 'cap-45', 'name', 'dup', 'unit_cost', '1')
), 'acme.csv')::text, true);
select is((current_setting('t.imp')::jsonb ->> 'inserted')::int, 2, 'import inserts valid rows');
select is((current_setting('t.imp')::jsonb ->> 'errors')::int, 2, 'invalid price and duplicate SKU are reported, not imported');
select is(current_setting('t.imp')::jsonb ->> 'status', 'completed_with_errors', 'import status reflects partial success');

select is((public.import_supplier_prices('00000000-0000-0000-0000-0000000000f1',
  '[{"sku":"CAP-45","unit_cost":"13.00"}]'::jsonb, 'p.csv', true) ->> 'updated')::int, 1, 'dry run previews an update');
select is((select unit_cost_cents from public.supplier_catalog_items where sku = 'CAP-45'), 1250, 'dry run wrote nothing');

select is((public.import_supplier_prices('00000000-0000-0000-0000-0000000000f1',
  '[{"sku":"CAP-45","unit_cost":"13.00"}]'::jsonb, 'p.csv') ->> 'price_up')::int, 1, 'price-only row updates an existing SKU and counts the increase');
select is((select count(*)::int from public.supplier_price_history where new_cost_cents = 1300 and old_cost_cents = 1250), 1, 'price change recorded in history');

select public.import_supplier_prices('00000000-0000-0000-0000-0000000000f2',
  '[{"sku":"B-CAP","name":"Capacitor 45/5","mpn":"C-45","unit_cost":"10.00","stock_status":"in_stock"}]'::jsonb, 'b.csv');
select throws_ok($$ select public.import_supplier_prices('00000000-0000-0000-0000-0000000000f9', '[{"sku":"X","name":"x","unit_cost":"1"}]'::jsonb) $$,
  'P0001', null, 'cannot import into another account''s supplier');

-- ------------------------------------------------------------------ search --
select is((select count(*)::int from public.search_supplier_catalog('capacitor')), 2, 'search finds items across suppliers');
select is((select sku from public.search_supplier_catalog('c-45') where is_best_price), 'B-CAP', 'cheapest supplier for the same MPN is flagged best price');
select is((select count(*)::int from public.search_supplier_catalog('c')), 0, 'one-character queries return nothing');

-- -------------------------------------------------------------------- cart --
select set_config('t.cap', (select id::text from public.supplier_catalog_items where sku = 'CAP-45'), true);
select set_config('t.cart', public.add_to_parts_cart(current_setting('t.cap')::uuid, 3, '00000000-0000-0000-0000-0000000000e1', null, true)::text, true);
select is((select quantity from public.parts_order_cart where id = current_setting('t.cart')::uuid), 4, 'quantity rounds up to the supplier pack size');
select is((select quantity_required from public.job_parts_required where job_id = '00000000-0000-0000-0000-0000000000e1'), 3, 'add-to-job records the requirement');
select is(public.add_to_parts_cart(current_setting('t.cap')::uuid, 2, '00000000-0000-0000-0000-0000000000e1', null, false), current_setting('t.cart')::uuid, 'same line merges instead of duplicating');
select is((select quantity from public.parts_order_cart where id = current_setting('t.cart')::uuid), 6, 'merged quantity adds up');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$ select public.create_parts_orders_from_cart(null, '00000000-0000-0000-0000-0000000000e1', true) $$, '42501', null, 'technicians cannot create purchase orders');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$ select public.add_to_parts_cart(current_setting('t.cap')::uuid, 1) $$, 'P0001', null, 'another account cannot use this catalog item');

-- ------------------------------------------------------------ order + hold --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.order', public.create_parts_orders_from_cart(null, '00000000-0000-0000-0000-0000000000e1', true)::text, true);
select is(jsonb_array_length(current_setting('t.order')::jsonb -> 'orders'), 1, 'one purchase order per supplier');
select is((select job_status from public.jobs where id = '00000000-0000-0000-0000-0000000000e1'), 'waiting_on_parts', 'job moves to waiting on parts');
select is((select count(*)::int from public.parts_order_cart), 0, 'ordered cart lines are consumed');
select set_config('t.po', (current_setting('t.order')::jsonb -> 'orders' -> 0 ->> 'po_id'), true);
select is((select status from public.purchase_orders where id = current_setting('t.po')::uuid), 'draft', 'small orders start as drafts');
select is((select quantity from public.purchase_order_line_jobs limit 1), 6, 'the line is allocated to the job');

-- ----------------------------------------------------------- delivery track --
select is(public.update_po_shipment(current_setting('t.po')::uuid, 'UPS', '1Z999', 'https://ups.example/1Z999', 'shipped', current_date + 3) ->> 'status',
  'invalid_state', 'tracking is refused until the order is sent');
update public.purchase_orders set status = 'sent', sent_at = now() where id = current_setting('t.po')::uuid;
select is(public.update_po_shipment(current_setting('t.po')::uuid, 'UPS', '1Z999', 'javascript:alert(1)', 'shipped', null) ->> 'status',
  'invalid', 'non-http tracking links are rejected');
select is(public.update_po_shipment(current_setting('t.po')::uuid, 'UPS', '1Z999', 'https://ups.example/1Z999', 'in_transit', current_date + 5) ->> 'status',
  'ok', 'shipment update accepted');
select ok((select count(*) from public.purchase_order_events where purchase_order_id = current_setting('t.po')::uuid and event_type = 'eta_changed') >= 1, 'ETA change is on the timeline');

-- ----------------------------------------------------------------- receiving --
select is(public.receive_purchase_order(current_setting('t.po')::uuid) ->> 'status', 'received', 'existing receive flow still works');
select is((select job_status from public.jobs where id = '00000000-0000-0000-0000-0000000000e1'), 'scheduled', 'receiving the parts auto-resumes the waiting job');
select ok(exists (select 1 from public.purchase_order_events where purchase_order_id = current_setting('t.po')::uuid and event_type = 'job_auto_resumed'), 'auto-resume is on the timeline');
select ok(exists (select 1 from public.notifications where type = 'parts_arrived'), 'owner is notified');

-- -------------------------------------------------------- supplier feed + sweep --
select pg_temp.act_service();
select is(public._supplier_feed_touch('00000000-0000-0000-0000-000000000000'::uuid, 60), false, 'unknown feed key is never allowed through');
select is(public.sweep_late_po_deliveries(), 0, 'sweep ignores received orders');

select * from finish();
rollback;
