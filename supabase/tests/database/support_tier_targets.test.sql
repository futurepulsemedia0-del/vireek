-- Support tier targets + tier overdue view (pgTAP). Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@vireek.test');
insert into public.profiles (id, plan, created_at, is_staff) values
  ('00000000-0000-0000-0000-0000000000a1', 'pro', now() - interval '60 days', false),
  ('00000000-0000-0000-0000-0000000000b1', 'starter', now() - interval '60 days', false),
  ('00000000-0000-0000-0000-0000000000c1', 'starter', now() - interval '60 days', true);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ---------- shape + seed ----------
select has_table('public', 'support_tier_targets', 'table exists');
select is((select count(*)::int from public.support_tier_targets), 5, 'five tiers seeded');
select is((select count(*)::int from public.support_tier_targets where first_response_minutes is not null or resolution_minutes is not null), 0, 'no target is set by default');

-- ---------- plan -> tier ----------
select is(public.support_tier_for_plan('pro'), 'priority', 'pro -> priority');
select is(public.support_tier_for_plan('starter'), 'standard', 'starter -> standard');
select is(public.support_tier_for_plan('business'), 'dedicated', 'business -> dedicated');
select is(public.support_tier_for_plan(null), 'community', 'NULL -> community');
select is(public.support_tier_for_plan('constructor'), 'community', 'unknown -> community');

-- ---------- tenant is locked out ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.support_tier_targets), 0, 'tenant cannot read targets');
update public.support_tier_targets set first_response_minutes = 1 where tier = 'priority';
select pg_temp.as_admin();
select is((select first_response_minutes from public.support_tier_targets where tier = 'priority'), null, 'tenant update had no effect');

-- ---------- two tickets, clocks backdated by admin ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
insert into public.support_conversations (id, visitor_id, kind, subject, priority) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'ticket', 'Priority tier ticket', 'normal');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
insert into public.support_conversations (id, visitor_id, kind, subject, priority) values
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b1', 'ticket', 'Standard tier ticket', 'normal');
select pg_temp.as_admin();
update public.support_conversations set created_at = now() - interval '3 hours'
where id in ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002');

-- ---------- staff ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select count(*)::int from public.support_tier_targets), 5, 'staff reads all targets');
select lives_ok($$update public.support_tier_targets set first_response_minutes = 60, resolution_minutes = 1440 where tier = 'priority'$$, 'staff can set targets');
select is((select updated_by from public.support_tier_targets where tier = 'priority'), '00000000-0000-0000-0000-0000000000c1'::uuid, 'updated_by is stamped server-side');
select throws_ok($$update public.support_tier_targets set tier = 'standard' where tier = 'priority'$$, '42501', null, 'tier key is immutable (column grant)');
select throws_ok($$update public.support_tier_targets set first_response_minutes = 2000, resolution_minutes = 100 where tier = 'priority'$$, '23514', null, 'first response must not exceed resolution');

select is((select count(*)::int from public.support_tier_overdue_tickets where id = '20000000-0000-0000-0000-000000000001' and overdue_kind = 'first_response'), 1, 'priority ticket is first-response overdue');
select is((select count(*)::int from public.support_tier_overdue_tickets where id = '20000000-0000-0000-0000-000000000002'), 0, 'unset target = untracked, never overdue');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.support_tier_overdue_tickets), 0, 'tenant sees no overdue rows');

-- first reply stops the first-response clock
select pg_temp.as_admin();
update public.support_conversations set first_response_at = now() where id = '20000000-0000-0000-0000-000000000001';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select count(*)::int from public.support_tier_overdue_tickets where id = '20000000-0000-0000-0000-000000000001' and overdue_kind = 'first_response'), 0, 'staff reply stops the clock');

select * from finish();
rollback;
