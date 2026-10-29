-- Supplier PunchOut: connections, session start, cart receive, review view, order creation, isolation (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

-- ---------------------------------------------------------------- fixtures --
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
   '00000000-0000-0000-0000-0000000000a3', 'active', '{}');
insert into public.jobs (id, user_id, customer_name, assigned_technician_id) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'Ann Lee', '00000000-0000-0000-0000-0000000000c3');
insert into public.inventory_locations (id, user_id, name, location_type) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Main warehouse', 'warehouse');
insert into public.inventory_vendors (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'Ferguson'),
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000b1', 'Other Co Vendor');
insert into public.supplier_punchout_connections (id, user_id, vendor_id, setup_url, buyer_identity, sender_identity, supplier_identity, secret_set) values
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1',
   'https://punchout.example.com/cxml', 'acme', 'acme', 'ferguson', true);
insert into public.supplier_punchout_secrets (connection_id, user_id, encrypted) values
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000a1', 'v1:x:y');

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
create or replace function pg_temp.h(p text) returns text language sql as $$ select encode(extensions.digest(p, 'sha256'), 'hex') $$;

-- ------------------------------------------------------------ begin session --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$ select public.punchout_begin_session('00000000-0000-0000-0000-0000000000aa', pg_temp.h('c1')) $$, '42501', null, 'technicians cannot start a PunchOut session');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$ select public.punchout_begin_session('00000000-0000-0000-0000-0000000000aa', pg_temp.h('c1')) $$, 'P0001', null, 'another account cannot use this connection');
select is((select count(*)::int from public.supplier_punchout_connections), 0, 'another account cannot read the connection');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.punchout_begin_session('00000000-0000-0000-0000-0000000000aa', 'not-a-hash') $$, 'P0001', null, 'a malformed session token is rejected');
select throws_ok($$ select public.punchout_begin_session('00000000-0000-0000-0000-0000000000aa', pg_temp.h('c1'), '00000000-0000-0000-0000-0000000000ee') $$, 'P0001', null, 'an unknown job is rejected');
select set_config('t.s1', public.punchout_begin_session('00000000-0000-0000-0000-0000000000aa', pg_temp.h('c1'), '00000000-0000-0000-0000-0000000000e1')::text, true);
select is((select status from public.supplier_punchout_sessions where id = current_setting('t.s1')::uuid), 'pending', 'session starts pending');
select throws_ok($$ insert into public.supplier_punchout_sessions (user_id, connection_id, vendor_id, buyer_cookie_hash) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000f1', repeat('a', 64)) $$, '42501', null, 'browsers cannot insert sessions directly');
select throws_ok($$ select * from public.supplier_punchout_secrets $$, '42501', null, 'browsers cannot read shared secrets');

-- ------------------------------------------------------------- receive cart --
select throws_ok($$ select public.punchout_receive_cart(pg_temp.h('c1'), '[]'::jsonb, 0, 'USD', pg_temp.h('p1')) $$, '42501', null, 'browsers cannot call the cart receiver');

select pg_temp.act_service();
select is(public.punchout_receive_cart(pg_temp.h('nope'), '[{"line_no":1,"sku":"A","name":"A","quantity":1,"unit_price_cents":100}]'::jsonb, 100, 'USD', pg_temp.h('p0')), null::uuid, 'unknown cookie is ignored');
select throws_ok($$ select public.punchout_receive_cart(pg_temp.h('c1'), '[]'::jsonb, 0, 'USD', pg_temp.h('p1')) $$, 'P0001', null, 'empty cart is rejected');
select throws_ok($$ select public.punchout_receive_cart(pg_temp.h('c1'), '[{"line_no":1,"sku":"A","name":"A","quantity":1.5,"unit_price_cents":100}]'::jsonb, 100, 'USD', pg_temp.h('p2')) $$, 'P0001', null, 'fractional quantity is rejected');
select throws_ok($$ select public.punchout_receive_cart(pg_temp.h('c1'), '[{"line_no":1,"sku":"A","name":"A","quantity":1,"unit_price_cents":-5}]'::jsonb, 100, 'USD', pg_temp.h('p3')) $$, 'P0001', null, 'negative price is rejected');
select is(public.punchout_receive_cart(pg_temp.h('c1'),
  '[{"line_no":1,"sku":"CAP-45","name":"45/5 capacitor","manufacturer":"Acme","uom":"each","quantity":2,"unit_price_cents":1250,"lead_time_days":2},
    {"line_no":2,"sku":"CON-30","name":"Contactor 30A","quantity":1,"unit_price_cents":2400}]'::jsonb, 4900, 'USD', pg_temp.h('p4')),
  current_setting('t.s1')::uuid, 'cart is stored against the session');
select is((select status from public.supplier_punchout_sessions where id = current_setting('t.s1')::uuid), 'returned', 'session becomes returned');
select is((select line_count from public.supplier_punchout_sessions where id = current_setting('t.s1')::uuid), 2, 'line count recorded');
select is(public.punchout_receive_cart(pg_temp.h('c1'),
  '[{"line_no":1,"sku":"CAP-45","name":"45/5 capacitor","manufacturer":"Acme","uom":"each","quantity":2,"unit_price_cents":1250,"lead_time_days":2},
    {"line_no":2,"sku":"CON-30","name":"Contactor 30A","quantity":1,"unit_price_cents":2400}]'::jsonb, 4900, 'USD', pg_temp.h('p4')),
  current_setting('t.s1')::uuid, 'the same cart sent twice is harmless');
select is((select count(*)::int from public.supplier_punchout_lines where session_id = current_setting('t.s1')::uuid), 2, 'resend did not duplicate lines');

-- ------------------------------------------------------------------- review --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.supplier_punchout_line_review where session_id = current_setting('t.s1')::uuid and catalog_item_id is null), 2, 'new parts have no catalog match');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.supplier_punchout_lines), 0, 'another account cannot read cart lines');

-- ------------------------------------------------------------- create order --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$ select public.punchout_create_order(current_setting('t.s1')::uuid) $$, '42501', null, 'technicians cannot create orders');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$ select public.punchout_create_order(current_setting('t.s1')::uuid) $$, 'P0001', null, 'another account cannot order this cart');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.o1', public.punchout_create_order(current_setting('t.s1')::uuid, true, 'rush')::text, true);
select is(current_setting('t.o1')::jsonb ->> 'status', 'draft', 'a small cart becomes a draft PO');
select is((current_setting('t.o1')::jsonb ->> 'total_cents')::int, 4900, 'PO total is the sum of supplier line prices');
select is((select count(*)::int from public.purchase_order_lines where purchase_order_id = (current_setting('t.o1')::jsonb ->> 'po_id')::uuid), 2, 'PO has one line per part');
select is((select punchout_session_id from public.purchase_orders where id = (current_setting('t.o1')::jsonb ->> 'po_id')::uuid), current_setting('t.s1')::uuid, 'PO links back to the cart');
select is((select count(*)::int from public.purchase_order_line_jobs where job_id = '00000000-0000-0000-0000-0000000000e1'), 2, 'lines are allocated to the job');
select is((select unit_cost_cents from public.supplier_catalog_items where sku = 'CAP-45'), 1250, 'catalog now holds the supplier price');
select is((select status from public.supplier_punchout_sessions where id = current_setting('t.s1')::uuid), 'ordered', 'session is marked ordered');
select is((select job_status from public.jobs where id = '00000000-0000-0000-0000-0000000000e1'), 'waiting_on_parts', 'job is held until the parts arrive');
select throws_ok($$ select public.punchout_create_order(current_setting('t.s1')::uuid) $$, 'P0001', null, 'a cart cannot be ordered twice');

-- ------------------------------------------- price change + approval limit --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.s2', public.punchout_begin_session('00000000-0000-0000-0000-0000000000aa', pg_temp.h('c2'))::text, true);
select pg_temp.act_service();
select public.punchout_receive_cart(pg_temp.h('c2'), '[{"line_no":1,"sku":"cap-45","name":"45/5 capacitor","quantity":100,"unit_price_cents":1400}]'::jsonb, 140000, 'USD', pg_temp.h('p5'));
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select catalog_cost_cents from public.supplier_punchout_line_review where session_id = current_setting('t.s2')::uuid), 1250, 'review shows the current catalog price (case-insensitive SKU match)');
select is(public.punchout_create_order(current_setting('t.s2')::uuid) ->> 'status', 'pending_approval', 'a cart above the approval limit waits for approval');
select is((select count(*)::int from public.supplier_price_history where new_cost_cents = 1400 and old_cost_cents = 1250), 1, 'the price change is recorded in price history');

-- ------------------------------------------------- cancel, expiry, currency --
select set_config('t.s3', public.punchout_begin_session('00000000-0000-0000-0000-0000000000aa', pg_temp.h('c3'))::text, true);
select lives_ok($$ select public.punchout_cancel_session(current_setting('t.s3')::uuid) $$, 'an open cart can be cancelled');
select pg_temp.act_service();
select is(public.punchout_receive_cart(pg_temp.h('c3'), '[{"line_no":1,"sku":"Z","name":"Z","quantity":1,"unit_price_cents":1}]'::jsonb, 1, 'USD', pg_temp.h('p6')), null::uuid, 'a cancelled session no longer accepts carts');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.s4', public.punchout_begin_session('00000000-0000-0000-0000-0000000000aa', pg_temp.h('c4'))::text, true);
select pg_temp.act_service();
update public.supplier_punchout_sessions set expires_at = now() - interval '1 minute' where id = current_setting('t.s4')::uuid;
select is(public.punchout_receive_cart(pg_temp.h('c4'), '[{"line_no":1,"sku":"Z","name":"Z","quantity":1,"unit_price_cents":1}]'::jsonb, 1, 'USD', pg_temp.h('p7')), null::uuid, 'an expired session no longer accepts carts');

select * from finish();
rollback;
