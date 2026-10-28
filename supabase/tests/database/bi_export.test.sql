-- BI export: tenant isolation, personal-data gating and credential privacy of the bi_* views (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- A owner, M member of A (can_export_data only), N member of A (can_export_data + can_export_pii),
-- Z member of A (no export permission), X owner of ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'member@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'pii@acme.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'none@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');
insert into public.profiles (id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner')
on conflict (id) do nothing;
insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'member@acme.test', 'Mia Member', 'dispatcher',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_export_data": true}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'pii@acme.test', 'Pia Pii', 'dispatcher',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{"can_export_data": true, "can_export_pii": true}'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1', 'none@acme.test', 'Zed None', 'dispatcher',
   '00000000-0000-0000-0000-0000000000a4', 'active', '{"can_export_data": false}');
insert into public.customers (id, user_id, name, phone, email, address, created_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Ann Lee', '+15550100', 'ann@acme.test', '12 Oak St', now()),
  ('00000000-0000-0000-0000-0000000000d9', '00000000-0000-0000-0000-0000000000b1', 'Other Cust', '+15550999', 'o@other.test', '9 Elm St', now());

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- 1-2. Owner: own tenant only, personal view works
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.bi_customers), 1, 'owner sees exactly their own customers');
select is((select name from public.bi_pii_customers), 'Ann Lee', 'owner may read personal columns');

-- 3. Another account never leaks
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.bi_customers where id = '00000000-0000-0000-0000-0000000000d1'), 0, 'other account cannot see this tenant');

-- 4-5. Member with can_export_data but without can_export_pii
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.bi_customers), 1, 'member with can_export_data sees tenant rows');
select is((select count(*)::int from public.bi_pii_customers), 0, 'member without can_export_pii gets no personal rows');

-- 6. Member with can_export_pii
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from public.bi_pii_customers), 1, 'member with can_export_pii gets personal rows');

-- 7. Member without can_export_data
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from public.bi_customers), 0, 'member without can_export_data sees nothing');

-- 8. The non-personal view has no personal column
reset role;
select is(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name = 'bi_customers' and column_name in ('name', 'phone', 'email', 'address')),
  0, 'bi_customers contains no personal column');

-- 9. anon is locked out
select set_config('role', 'anon', true);
select throws_ok($$select 1 from public.bi_customers$$, '42501', null, 'anon cannot read BI views');

-- 10-11. Secrets are unreachable from clients
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$select 1 from public.bi_export_secrets$$, '42501', null, 'owner cannot read bi_export_secrets');
select throws_ok($$select public.bi_provision_reader('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'x', repeat('x', 30), false)$$, '42501', null, 'clients cannot provision logins');

select * from finish();
rollback;
