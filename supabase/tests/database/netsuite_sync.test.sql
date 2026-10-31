-- NetSuite sync: tenant isolation, secrets lockdown, ledger functions (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'member@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'member@acme.test', 'Mia Member', 'technician',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_edit_business_profile": false, "can_view_billing": false}');

insert into public.ns_connections (id, user_id, account_id) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '1234567_SB1'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b1', '7654321');
insert into public.ns_connection_secrets (connection_id, user_id, credentials_enc) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'v1.x.y');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.ns_connections), 1, 'owner sees exactly their own connection');
select is((select account_id from public.ns_connections), '1234567_SB1', 'and it is the right account');
select throws_ok($$ select * from public.ns_connection_secrets $$, '42501', null, 'owner cannot read encrypted credentials');
select throws_ok($$ insert into public.ns_connections (user_id, account_id) values ('00000000-0000-0000-0000-0000000000a1', '9999999') $$,
  '42501', null, 'owner cannot write connections from the client');
select is((with u as (update public.ns_connections set status = 'error' returning 1) select count(*)::int from u), 0,
  'owner cannot update connections from the client');
select throws_ok($$ select public.ns_create_ar_invoice('00000000-0000-0000-0000-0000000000a1', null, current_date, current_date, 0, '[]'::jsonb) $$,
  '42501', null, 'owner cannot call the service-only ledger functions');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.ns_connections), 0, 'a team member without billing + profile permissions sees nothing');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.ns_connections), 1, 'another account sees only its own connection');
select is((select count(*)::int from public.ns_record_links), 0, 'and no foreign links');

reset role;

select ok(not has_function_privilege('authenticated', 'public.ns_record_ar_payment(uuid,uuid,integer,text,date,uuid)', 'execute'), 'authenticated cannot execute ns_record_ar_payment');
select ok(has_function_privilege('service_role', 'public.ns_record_ar_payment(uuid,uuid,integer,text,date,uuid)', 'execute'), 'service_role can execute ns_record_ar_payment');
select throws_ok($$ insert into public.ns_connections (user_id, account_id) values ('00000000-0000-0000-0000-0000000000b1', '1234567_SB1') $$,
  '23505', null, 'one live connection per NetSuite account');
select throws_ok($$ insert into public.ns_connections (user_id, account_id) values (gen_random_uuid(), 'bad id') $$,
  '23514', null, 'account ids are validated by a CHECK constraint');

select is((select count(*)::int from pg_policies where tablename = 'ns_connection_secrets'), 0, 'secrets table has no policies at all');

select * from finish();
rollback;
