-- profiles privilege-escalation guard + cross-tenant isolation (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000f0a1', 'a@tenant-a.test'),
  ('00000000-0000-0000-0000-00000000f0b1', 'b@tenant-b.test');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

select is((select count(*)::int from public.profiles
           where id in ('00000000-0000-0000-0000-00000000f0a1', '00000000-0000-0000-0000-00000000f0b1')),
          2, 'fixtures: both tenants have a profile row');

-- ------------------------------------------------------------ tenant A acts --
select pg_temp.act_as('00000000-0000-0000-0000-00000000f0a1');

select lives_ok($$update public.profiles set full_name = 'Ann' where id = '00000000-0000-0000-0000-00000000f0a1'$$,
  'own harmless column (full_name) is still writable');
select is((select full_name from public.profiles where id = '00000000-0000-0000-0000-00000000f0a1'), 'Ann',
  'full_name was updated');

select throws_ok($$update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-00000000f0a1'$$,
  '42501', null, 'client cannot change role');
select throws_ok($$update public.profiles set plan = 'enterprise' where id = '00000000-0000-0000-0000-00000000f0a1'$$,
  '42501', null, 'client cannot change plan');
select throws_ok($$update public.profiles set status = 'active' where id = '00000000-0000-0000-0000-00000000f0a1' and false$$ || '',
  '42501', null, 'placeholder replaced below') where false;
select throws_ok($$update public.profiles set status = 'canceled' where id = '00000000-0000-0000-0000-00000000f0a1'$$,
  '42501', null, 'client cannot change status');
select throws_ok($$update public.profiles set minutes_included = 999999 where id = '00000000-0000-0000-0000-00000000f0a1'$$,
  '42501', null, 'client cannot change minutes_included');
select throws_ok($$update public.profiles set minutes_used_this_month = 0 where id = '00000000-0000-0000-0000-00000000f0a1'$$,
  '42501', null, 'client cannot reset minutes_used_this_month');
select throws_ok($$update public.profiles set stripe_customer_id = 'cus_forged' where id = '00000000-0000-0000-0000-00000000f0a1'$$,
  '42501', null, 'client cannot change stripe_customer_id');
select throws_ok($$update public.profiles set stripe_subscription_id = 'sub_forged' where id = '00000000-0000-0000-0000-00000000f0a1'$$,
  '42501', null, 'client cannot change stripe_subscription_id');
select throws_ok($$update public.profiles set subscription_status = 'active' where id = '00000000-0000-0000-0000-00000000f0a1'$$,
  '42501', null, 'client cannot change subscription_status');
select throws_ok($$update public.profiles set dunning_stage = 0 where id = '00000000-0000-0000-0000-00000000f0a1'$$,
  '42501', null, 'client cannot change dunning_stage');
select throws_ok($$update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-00000000f0a1'$$,
  '42501', null, 'client cannot become staff');

-- cross-tenant: A attacks B's row
select lives_ok($$update public.profiles set full_name = 'hacked' where id = '00000000-0000-0000-0000-00000000f0b1'$$,
  'cross-tenant update is silently filtered by RLS (no error)');
select is((select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-00000000f0b1'), 0,
  'tenant A cannot read tenant B profile');

-- ------------------------------------------- privileged path still works ------
reset role;
select ok((select full_name is distinct from 'hacked' from public.profiles where id = '00000000-0000-0000-0000-00000000f0b1'),
  'tenant B row was not modified by tenant A');
select lives_ok($$update public.profiles set minutes_included = 777 where id = '00000000-0000-0000-0000-00000000f0a1'$$,
  'service/postgres context can still change privileged columns');

select * from finish();
rollback;
