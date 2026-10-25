-- Customer Home Inventory: token gate, validation, tenant isolation, equipment linking, reminders (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@hi.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-hi.test');

insert into public.business_profile (user_id, allow_customer_portal) values
  ('00000000-0000-0000-0000-0000000000a1', true),
  ('00000000-0000-0000-0000-0000000000b1', false);

insert into public.customers (id, user_id, name, portal_token) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Ana Lee',  '10000000-0000-4000-8000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'Bo Chen',  '10000000-0000-4000-8000-0000000000c2'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000b1', 'Off Portal', '10000000-0000-4000-8000-0000000000c3');

-- Business equipment on file for Ana (one for each customer, to prove isolation).
insert into public.equipment (id, user_id, customer_id, equipment_type, make, model, serial_number, install_date, last_service_date, service_interval_months) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'water_heater', 'Rheem', 'XE40', 'RH-LN 12345', '2024-01-10', '2025-01-10', 12),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2', 'furnace', 'Trane', 'S9V2', 'TR987654', '2024-01-10', null, 12);

-- ------------------------------------------------------------------- gate --
select ok(public.get_portal_home_inventory('10000000-0000-4000-8000-0000000000ff') is null, 'unknown token -> NULL');
select ok(public.get_portal_home_inventory('10000000-0000-4000-8000-0000000000c3') is null, 'portal disabled -> NULL (same as unknown)');
select ok(public.get_portal_home_inventory(null) is null, 'null token -> NULL');
select ok(public.portal_inventory_save_item('10000000-0000-4000-8000-0000000000ff', null, '{"name":"x"}'::jsonb, null) is null, 'save with unknown token -> NULL, nothing written');
select is((select count(*)::int from public.home_inventory_items), 0, 'nothing was created for a bad token');

-- ------------------------------------------------------------------- save --
select lives_ok($$ select public.portal_inventory_save_item('10000000-0000-4000-8000-0000000000c1', null,
  '{"name":"  Garage water heater ","category":"water_heating","brand":"Rheem","serial_number":"rhln12345","purchase_date":"2024-03-14","warranty_months":24,"maintenance_interval_months":12}'::jsonb, null) $$,
  'a valid item is saved');
select is((select name from public.home_inventory_items where customer_id = '00000000-0000-0000-0000-0000000000c1'), 'Garage water heater', 'name is trimmed');
select is((select warranty_expires_at from public.home_inventory_items where customer_id = '00000000-0000-0000-0000-0000000000c1'), date '2026-03-14', 'warranty end is derived from purchase date + months');
select is((select equipment_id from public.home_inventory_items where customer_id = '00000000-0000-0000-0000-0000000000c1'), '00000000-0000-0000-0000-0000000000e1'::uuid, 'a matching serial links the business equipment automatically (case/spacing ignored)');
select is((select count(*)::int from public.home_inventory_reminders where customer_id = '00000000-0000-0000-0000-0000000000c1' and kind = 'maintenance'), 1, 'a maintenance reminder was created');

select throws_ok($$ select public.portal_inventory_save_item('10000000-0000-4000-8000-0000000000c1', null, '{"name":"   "}'::jsonb, null) $$, 'HI_INVALID_NAME', 'blank name is refused');
select throws_ok($$ select public.portal_inventory_save_item('10000000-0000-4000-8000-0000000000c1', null, '{"name":"TV","purchase_date":"2999-01-01"}'::jsonb, null) $$, 'HI_INVALID_DATE', 'future purchase date is refused');
select throws_ok($$ select public.portal_inventory_save_item('10000000-0000-4000-8000-0000000000c1', null, '{"name":"TV","purchase_date":"2024-02-31"}'::jsonb, null) $$, 'HI_INVALID_FIELD', 'impossible date is refused cleanly');
select throws_ok($$ select public.portal_inventory_save_item('10000000-0000-4000-8000-0000000000c1', null, '{"name":"TV","purchase_price_cents":"abc"}'::jsonb, null) $$, 'HI_INVALID_FIELD', 'non-numeric price is refused cleanly');

-- Another customer's equipment can never be linked.
select throws_ok($$ select public.portal_inventory_save_item('10000000-0000-4000-8000-0000000000c1', null,
  '{"name":"Sneaky","equipment_id":"00000000-0000-0000-0000-0000000000e2"}'::jsonb, null) $$, 'HI_EQUIPMENT_NOT_FOUND', 'cannot link another customer''s equipment');

-- ------------------------------------------------------------- isolation --
select throws_ok($$ select public.portal_inventory_save_item('10000000-0000-4000-8000-0000000000c2',
  (select id from public.home_inventory_items where customer_id = '00000000-0000-0000-0000-0000000000c1' limit 1), '{"name":"Hijack"}'::jsonb, null) $$,
  'HI_NOT_FOUND', 'another customer cannot edit this item');
select is((select name from public.home_inventory_items where customer_id = '00000000-0000-0000-0000-0000000000c1'), 'Garage water heater', 'unchanged');

-- ----------------------------------------------------------------- read --
select is((public.get_portal_home_inventory('10000000-0000-4000-8000-0000000000c1')->'summary'->>'item_count')::int, 1, 'summary counts only this customer''s items');
select is(jsonb_array_length(public.get_portal_home_inventory('10000000-0000-4000-8000-0000000000c2')->'items'), 0, 'another customer sees none of them');
select is(jsonb_array_length(public.get_portal_home_inventory('10000000-0000-4000-8000-0000000000c1')->'equipment_options'), 1, 'link picker lists only this customer''s equipment');

-- ------------------------------------------------------------- reminders --
select is((public.portal_inventory_reminder_action('10000000-0000-4000-8000-0000000000c1',
  (select id from public.home_inventory_reminders where kind = 'maintenance' limit 1), 'done', null)->>'status'), 'active', 'completing a recurring reminder keeps it active');
select ok((select due_date from public.home_inventory_reminders where kind = 'maintenance' limit 1) > current_date + 300, 'and rolls the due date about a year ahead');

select * from finish();
rollback;
