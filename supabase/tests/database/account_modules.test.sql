-- account_modules entitlement gate (pgTAP). Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

insert into auth.users (id, instance_id, aud, role, email)
values ('aaaaaaaa-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mod-a@test.local');

select is(public.has_module_for('aaaaaaaa-0000-0000-0000-00000000000a', 'supply_orders'), false, 'no row => disabled (default OFF)');

insert into public.account_modules (owner_id, module_key, enabled, source) values ('aaaaaaaa-0000-0000-0000-00000000000a', 'supply_orders', true, 'override');
select is(public.has_module_for('aaaaaaaa-0000-0000-0000-00000000000a', 'supply_orders'), true, 'enabled row => enabled');

update public.account_modules set expires_at = now() - interval '1 minute' where module_key = 'supply_orders';
select is(public.has_module_for('aaaaaaaa-0000-0000-0000-00000000000a', 'supply_orders'), false, 'expired row => disabled');

update public.account_modules set expires_at = null, enabled = false where module_key = 'supply_orders';
select is(public.has_module_for('aaaaaaaa-0000-0000-0000-00000000000a', 'supply_orders'), false, 'enabled=false => disabled');

select is((select count(*)::int from public.account_module_events where owner_id = 'aaaaaaaa-0000-0000-0000-00000000000a'), 3, 'insert + 2 updates are audited');

select throws_ok(
  $$insert into public.account_modules (owner_id, module_key) values ('aaaaaaaa-0000-0000-0000-00000000000a', 'Bad Key')$$,
  '23514', null, 'malformed module_key is rejected');

select ok(not has_table_privilege('authenticated', 'public.account_modules', 'insert'), 'authenticated cannot insert');
select ok(not has_function_privilege('authenticated', 'public.has_module_for(uuid,text)', 'execute'), 'authenticated cannot call has_module_for');

select * from finish();
rollback;
