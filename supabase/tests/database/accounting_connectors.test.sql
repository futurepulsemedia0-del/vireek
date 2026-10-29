-- Accounting connectors: tenant isolation, secrets lockdown, permission gate (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'member@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'member@acme.test', 'Mia Member', 'technician',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_edit_business_profile": false, "can_view_billing": false}');

insert into public.acct_connections (id, user_id, provider, tenant_id) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'xero', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b1', 'netsuite', '1234567_SB1');
insert into public.acct_connection_secrets (connection_id, user_id, access_token_enc) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'v1.x.y');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.acct_connections), 1, 'owner sees exactly their own connection');
select is((select provider from public.acct_connections), 'xero', 'and it is the right provider');
select throws_ok($$ select * from public.acct_connection_secrets $$, '42501', null, 'owner cannot read encrypted tokens');
select throws_ok($$ insert into public.acct_connections (user_id, provider, tenant_id) values ('00000000-0000-0000-0000-0000000000a1', 'zoho_books', '10234695') $$,
  '42501', null, 'owner cannot write connections from the client');
select is(public.can_manage_accounting(), true, 'owner may manage accounting sync');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.acct_connections), 0, 'a member without billing permission sees nothing');
select is(public.can_manage_accounting(), false, 'and cannot manage accounting sync');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.acct_connections where tenant_id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'), 0, 'another account cannot see this tenant');

reset role;
select throws_ok($$ insert into public.acct_connections (user_id, provider, tenant_id) values ('00000000-0000-0000-0000-0000000000b1', 'xero', '3f2504e0-4f89-11d3-9a0c-0305e82c3301') $$,
  '23505', null, 'one Xero organisation cannot be linked to two accounts');

select * from finish();
rollback;
