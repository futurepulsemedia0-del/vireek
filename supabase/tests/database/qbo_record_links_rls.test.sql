-- qbo_record_links: tenant isolation, read-only for clients, uniqueness + entity check (pgTAP).
-- Run with:  supabase test db
-- Impersonation mirrors PostgREST: role = authenticated + request.jwt.claim.sub.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@qrl-a.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@qrl-b.test');
insert into public.qbo_connections (id, user_id, realm_id) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '923145820001'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b1', '923145820002');
insert into public.qbo_record_links (id, user_id, connection_id, entity, vireek_id, external_id) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'customer', '00000000-0000-0000-0000-0000000000e1', 'QB-1'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d2', 'customer', '00000000-0000-0000-0000-0000000000e2', 'QB-2');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.qbo_record_links), 1, 'an account sees only its own links');
select is((select external_id from public.qbo_record_links), 'QB-1', 'and it is the right link');
select throws_ok($$ insert into public.qbo_record_links (user_id, connection_id, entity, vireek_id, external_id)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'customer', gen_random_uuid(), 'QB-FORGED') $$,
  '42501', null, 'clients cannot create links (service role only)');
select is((with u as (update public.qbo_record_links set sync_token = '99' returning 1) select count(*)::int from u), 0, 'clients cannot update links');
select is((with d as (delete from public.qbo_record_links returning 1) select count(*)::int from d), 0, 'clients cannot delete links');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select external_id from public.qbo_record_links), 'QB-2', 'the other account sees exactly its own link');

reset role;
select is((select count(*)::int from public.qbo_record_links where external_id in ('QB-1', 'QB-2', 'QB-FORGED')), 2, 'no link was created, changed or removed by a client');
select throws_ok($$ insert into public.qbo_record_links (user_id, connection_id, entity, vireek_id, external_id)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'customer', '00000000-0000-0000-0000-0000000000e1', 'QB-OTHER') $$,
  '23505', null, 'a Vireek record links to at most one QuickBooks record per connection');
select throws_ok($$ insert into public.qbo_record_links (user_id, connection_id, entity, vireek_id, external_id)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'estimate', gen_random_uuid(), 'QB-3') $$,
  '23514', null, 'only the five synced entities are allowed');

select * from finish();
rollback;
