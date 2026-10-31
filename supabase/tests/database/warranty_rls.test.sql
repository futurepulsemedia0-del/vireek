-- Warranty claims + warranty registrations: tenant isolation and write lockdown (pgTAP).
-- Run with:  supabase test db
-- Impersonation mirrors PostgREST: role = authenticated + request.jwt.claim.sub.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@warranty-a.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@warranty-b.test');

insert into public.warranty_claims (id, user_id, customer_name, status) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Claim A', 'eligible'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b1', 'Claim B', 'eligible');

insert into public.equipment_passports (id, public_code, equipment_type) values
  ('00000000-0000-0000-0000-0000000000e1', 'AAAAAAAAAAAA', 'furnace'),
  ('00000000-0000-0000-0000-0000000000e2', 'BBBBBBBBBBBB', 'furnace');
insert into public.equipment_passport_links (passport_id, user_id, verified, verified_via, status) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', true, 'issuer', 'active'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000b1', true, 'issuer', 'active');
insert into public.warranty_registrations (confirmation_code, passport_id, owner_name, owner_email, equipment_type, make, serial_number, purchase_date, terms_accepted) values
  ('WR-A1',   '00000000-0000-0000-0000-0000000000e1', 'Owner One', 'one@example.test',   'furnace', 'Acme', 'SER-0001', date '2026-01-10', true),
  ('WR-B1',   '00000000-0000-0000-0000-0000000000e2', 'Owner Two', 'two@example.test',   'furnace', 'Acme', 'SER-0002', date '2026-01-10', true),
  ('WR-NONE', null,                                   'Owner Tri', 'three@example.test', 'furnace', 'Acme', 'SER-0003', date '2026-01-10', true);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ------------------------------------------------------------ warranty_claims --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.warranty_claims), 1, 'claims: an account sees only its own claim');
select is((select count(*)::int from public.warranty_claims where user_id = '00000000-0000-0000-0000-0000000000b1'), 0, 'claims: another account''s claim is invisible');
select throws_ok($$ insert into public.warranty_claims (user_id, customer_name) values ('00000000-0000-0000-0000-0000000000b1', 'Forged') $$,
  '42501', null, 'claims: cannot insert a claim into another account');
select is((with u as (update public.warranty_claims set status = 'closed' where id = '00000000-0000-0000-0000-0000000000c2' returning 1) select count(*)::int from u), 0,
  'claims: cannot update another account''s claim');
select is((with d as (delete from public.warranty_claims where id = '00000000-0000-0000-0000-0000000000c2' returning 1) select count(*)::int from d), 0,
  'claims: cannot delete another account''s claim');
select lives_ok($$ insert into public.warranty_claims (customer_name) values ('Own new claim') $$, 'claims: can insert a claim for its own account (user_id defaults to the caller)');
select throws_ok($$ update public.warranty_claims set user_id = '00000000-0000-0000-0000-0000000000b1' where id = '00000000-0000-0000-0000-0000000000c1' $$,
  '42501', null, 'claims: cannot hand an own claim over to another account');

-- ------------------------------------------------------ warranty_registrations --
select is((select count(*)::int from public.warranty_registrations), 1, 'registrations: only registrations linked to the account''s own verified passports are visible');
select is((select confirmation_code from public.warranty_registrations), 'WR-A1', 'registrations: and it is the right one');
select is((select count(*)::int from public.warranty_registrations where confirmation_code = 'WR-NONE'), 0, 'registrations: an unlinked registration is invisible to every contractor');
select is((select count(*)::int from public.warranty_registrations where confirmation_code = 'WR-B1'), 0, 'registrations: another account''s registration is invisible');
select throws_ok($$ insert into public.warranty_registrations (confirmation_code, owner_name, owner_email, equipment_type, make, serial_number, purchase_date, terms_accepted)
  values ('WR-FORGED', 'Mallory', 'm@example.test', 'furnace', 'Acme', 'SER-9999', date '2026-01-01', true) $$,
  '42501', null, 'registrations: clients cannot insert (service role only)');
select throws_ok($$ update public.warranty_registrations set email_status = 'sent' $$, '42501', null, 'registrations: clients cannot update');
select throws_ok($$ delete from public.warranty_registrations $$, '42501', null, 'registrations: clients cannot delete');

reset role;
select set_config('role', 'anon', true);
select throws_ok($$ select * from public.warranty_registrations $$, '42501', null, 'registrations: anonymous visitors cannot read the table');
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select string_agg(confirmation_code, ',') from public.warranty_registrations), 'WR-B1', 'registrations: the other account sees exactly its own');

select * from finish();
rollback;
