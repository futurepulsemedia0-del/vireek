-- purchase_orders: tenant isolation (pgTAP). Final schema = truck-stock purchase orders
-- (20261110000000_truck_stock_replenishment.sql): policies purchase_orders_manager_all, account-scoped.
-- Run with:  supabase test db
-- Impersonation mirrors PostgREST: role = authenticated + request.jwt.claim.sub.
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@po-a.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@po-b.test');
-- Managers (owners) – profiles are normally created by the signup trigger.
insert into public.profiles (id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner')
on conflict (id) do update set role = 'owner';

insert into public.purchase_orders (id, user_id, po_number) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'PO-A'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b1', 'PO-B');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.purchase_orders), 1, 'an account sees only its own purchase orders');
select is((select count(*)::int from public.purchase_orders where po_number = 'PO-B'), 0, 'another account''s purchase order is invisible');
select is((with u as (update public.purchase_orders set notes = 'tampered' where id = '00000000-0000-0000-0000-0000000000f2' returning 1) select count(*)::int from u), 0,
  'cannot update another account''s purchase order');
select is((with d as (delete from public.purchase_orders where id = '00000000-0000-0000-0000-0000000000f2' returning 1) select count(*)::int from d), 0,
  'cannot delete another account''s purchase order');
-- A forged insert must never land in the other account (it may be rejected or re-stamped to the caller).
do $$ begin
  insert into public.purchase_orders (user_id, po_number) values ('00000000-0000-0000-0000-0000000000b1', 'PO-FORGED');
exception when others then null;
end $$;

reset role;
select is((select count(*)::int from public.purchase_orders where user_id = '00000000-0000-0000-0000-0000000000b1' and po_number = 'PO-FORGED'), 0,
  'a forged insert never creates a purchase order inside another account');
select is((select count(*)::int from public.purchase_orders where user_id = '00000000-0000-0000-0000-0000000000b1' and po_number = 'PO-B' and notes is null), 1,
  'the other account''s purchase order is untouched');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select string_agg(po_number, ',') from public.purchase_orders where po_number in ('PO-A', 'PO-B')), 'PO-B', 'the other account sees exactly its own purchase order');

select * from finish();
rollback;
