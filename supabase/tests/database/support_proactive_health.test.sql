-- staff_customer_health / proactive_alert_candidates / customer_alert_log (pgTAP). Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sph-owner@test.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sph-staff@test.local')
on conflict (id) do nothing;

insert into public.profiles (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'sph-owner@test.local'),
  ('aaaaaaaa-0000-0000-0000-0000000000b1', 'sph-staff@test.local')
on conflict (id) do nothing;
update public.profiles set role = 'owner', is_staff = false, subscription_status = 'past_due' where id = 'aaaaaaaa-0000-0000-0000-0000000000a1';
update public.profiles set role = 'owner', is_staff = true  where id = 'aaaaaaaa-0000-0000-0000-0000000000b1';
insert into public.calls (user_id, call_datetime) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', now()), ('aaaaaaaa-0000-0000-0000-0000000000a1', now() - interval '1 day');

select ok(not has_table_privilege('authenticated', 'public.customer_alert_log', 'select'), 'authenticated cannot read customer_alert_log');
select ok(not has_function_privilege('authenticated', 'public.proactive_alert_candidates()', 'execute'), 'authenticated cannot call proactive_alert_candidates');
select ok(not has_function_privilege('anon', 'public.staff_customer_health(integer)', 'execute'), 'anon cannot call staff_customer_health');

select is((select count(*)::int from public.proactive_alert_candidates() where account_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and kind = 'payment_failed'), 1, 'past_due owner gets payment_failed candidate');
select is((select count(*)::int from public.proactive_alert_candidates() where account_id = 'aaaaaaaa-0000-0000-0000-0000000000b1'), 0, 'staff accounts get no customer alerts');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-0000000000a1', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select * from public.staff_customer_health(10)$$, '42501', 'staff only', 'non-staff is rejected');
reset role;

select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-0000000000b1', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select calls_7d from public.staff_customer_health(500) where account_id = 'aaaaaaaa-0000-0000-0000-0000000000a1'), 2, 'staff sees owner call counts');
select is((select count(*)::int from public.staff_customer_health(500) where account_id = 'aaaaaaaa-0000-0000-0000-0000000000b1'), 0, 'staff rows are excluded');
reset role;

select * from finish();
rollback;
