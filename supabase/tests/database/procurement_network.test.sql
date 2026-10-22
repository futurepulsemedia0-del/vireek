-- Procurement Network: tenant isolation, cohort privacy, order routing, settlement (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

-- ---------------------------------------------------------------- fixtures --
-- t1..t3: three tenants (owners). t4: owner who NEVER joins. s1: supplier admin. x: outsider.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 't1@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 't2@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 't3@acme.test'),
  ('00000000-0000-0000-0000-0000000000a4', 't4@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 's1@supply.test'),
  ('00000000-0000-0000-0000-0000000000f1', 'x@outsider.test');
insert into public.profiles (id, email)
  select id, email from auth.users where id::text like '00000000-0000-0000-0000-0000000000%' on conflict (id) do nothing;

insert into public.pn_suppliers (id, name, contact_email, status, w9_verified, insurance_verified) values
  ('10000000-0000-0000-0000-000000000001', 'CoolParts Wholesale', 'sales@coolparts.test', 'approved', true, true);
insert into public.pn_supplier_users (supplier_id, user_id, role) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', 'admin');
insert into public.pn_catalog_items (id, supplier_id, sku, name, list_price_cents) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'CAP-45-5', 'Capacitor 45/5', 10000);
insert into public.pn_programs (id, supplier_id, title, status, starts_on, ends_on) values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Fall HVAC parts', 'open', current_date - 1, current_date + 30);
insert into public.pn_volume_tiers (id, program_id, rank, label, min_qualifying_cents, discount_bps) values
  ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 1, 'Base', 0, 0),
  ('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 2, 'Silver', 1000000, 500);
insert into public.pn_price_schedules (id, program_id, status, valid_from) values
  ('50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'active', current_date - 1);
insert into public.pn_price_schedule_lines (schedule_id, catalog_item_id, tier_id, unit_price_cents) values
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 9500),
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', 9000);
insert into public.pn_memberships (user_id, status, share_volume_consent, consented_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'active', true, now()),
  ('00000000-0000-0000-0000-0000000000a2', 'active', true, now()),
  ('00000000-0000-0000-0000-0000000000a3', 'active', true, now());

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;

create or replace function pg_temp.order_for(p_user uuid, p_qty numeric) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform pg_temp.act_as(p_user);
  r := public.pn_place_order(
    '30000000-0000-0000-0000-000000000001',
    jsonb_build_array(jsonb_build_object('catalog_item_id', '20000000-0000-0000-0000-000000000001', 'qty', p_qty)),
    '{"name":"Shop","line1":"1 Main St","city":"Austin","postal_code":"78701"}'::jsonb);
  perform pg_temp.reset_role();
  return r;
end $$;

-- ------------------------------------------------------ opt-in + order routing --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$ select public.pn_place_order('30000000-0000-0000-0000-000000000001', '[]'::jsonb, '{}'::jsonb) $$,
  null, 'Join the Procurement Network first', 'a tenant that has not opted in cannot order');
select throws_ok($$ select public.pn_join_network('TX', '{}', false) $$,
  null, null, 'joining requires explicit volume-sharing consent');
select pg_temp.reset_role();

select pg_temp.order_for('00000000-0000-0000-0000-0000000000a1', 40);
select pg_temp.order_for('00000000-0000-0000-0000-0000000000a2', 40);
select pg_temp.order_for('00000000-0000-0000-0000-0000000000a3', 40);

select is((select count(*)::int from public.pn_orders where status = 'awaiting_approval'), 3,
  'each order is created and waits for the buyer approval');
select is((select count(*)::int from public.pn_order_lines where unit_price_cents = 9500 and qty = 40), 3,
  'prices are computed server-side at the base tier');

-- ------------------------------------------------------------ tenant isolation --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.pn_orders), 1, 'tenant sees only their own network order');
select is((select count(*)::int from public.pn_line_baselines), 1, 'tenant sees only their own baselines');
select is((select count(*)::int from public.pn_suppliers), 0, 'tenant cannot read supplier records directly');
select is((select count(*)::int from public.pn_programs), 0, 'tenant cannot read programs directly (RPC only)');
select throws_ok($$ insert into public.pn_orders (order_number, user_id, supplier_id, program_id) values ('HACK-1', '00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'clients cannot forge network orders');
select throws_ok($$ select public.pn_pool_state('30000000-0000-0000-0000-000000000001') $$,
  '42501', null, 'raw pool state is not callable by clients');
select pg_temp.reset_role();

-- orders are invisible to the supplier until the buyer approves the PO
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.pn_orders), 0, 'supplier cannot see orders awaiting buyer approval');
select pg_temp.reset_role();

-- the buyer approval (PO approval or pn_approve_order) releases the order to the supplier
update public.pn_orders set status = 'placed', placed_at = now() where status = 'awaiting_approval';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.pn_orders where status = 'placed'), 3, 'approved orders are released to the supplier');
select is((select count(*)::int from public.pn_line_baselines), 0, 'supplier can never read buyer baseline prices');
select pg_temp.reset_role();

-- ------------------------------------------------------------- cohort privacy --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select (p -> 'pool' ->> 'cohort_visible') from jsonb_array_elements(public.pn_list_programs()) p limit 1), 'true',
  'with 3 businesses engaged the pool becomes visible (aggregates only)');
select pg_temp.reset_role();

-- ------------------------------------------------------------------ settlement --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select throws_ok($$ select public.pn_supplier_set_program_status('30000000-0000-0000-0000-000000000001', 'closed') $$,
  null, 'Not allowed', 'an outsider cannot close a supplier program');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select public.pn_supplier_set_program_status('30000000-0000-0000-0000-000000000001', 'closed');
select pg_temp.reset_role();
select is((select amount_cents::int from public.pn_rebates where user_id = '00000000-0000-0000-0000-0000000000a1' and kind = 'tier_true_up'), 20000,
  'closing trues every order up to the final pooled tier (40 x $5 = $200)');

select * from finish();
rollback;
