-- Tool crib: vehicle link + double check-out (pgTAP). Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner@crib.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'tech@crib.test'),
  ('00000000-0000-0000-0000-0000000000c3', 'other@crib.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, invite_status, user_id)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1',
        'tech@crib.test', 'Tech One', 'technician', 'active', '00000000-0000-0000-0000-0000000000c2');

insert into public.vehicles (id, user_id, label, license_plate, status, assigned_technician_id) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'Truck 7', 'ABC123', 'active', '00000000-0000-0000-0000-0000000000d1'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1', 'Old van', null, 'retired', null),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000c3', 'Foreign truck', null, 'active', null);

insert into public.tool_crib_items (id, user_id, tool_number, name) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c1', 'T-1', 'Drill'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000c1', 'T-2', 'Meter');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');

-- check-out with a vehicle
select lives_ok(
  $q$ select public.check_out_crib_tool('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1', 24, 'good', null, '00000000-0000-0000-0000-0000000000e1') $q$,
  'check-out with a vehicle works');
select is((select status from public.tool_crib_items where id = '00000000-0000-0000-0000-0000000000f1'), 'checked_out', 'tool is now checked out');
select is((select vehicle_id from public.tool_crib_loans where tool_id = '00000000-0000-0000-0000-0000000000f1' and status = 'out'),
          '00000000-0000-0000-0000-0000000000e1'::uuid, 'loan stores the vehicle');
select is((select vehicle_label from public.tool_crib_loans where tool_id = '00000000-0000-0000-0000-0000000000f1' and status = 'out'),
          'Truck 7 (ABC123)', 'loan stores a vehicle label snapshot');

-- double check-out is blocked
select throws_ok(
  $q$ select public.check_out_crib_tool('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1', 24, 'good', null, null) $q$,
  'P0004', 'This tool is already checked out', 'a second check-out of the same tool is blocked');
select is((select count(*)::int from public.tool_crib_loans where tool_id = '00000000-0000-0000-0000-0000000000f1' and status = 'out'),
          1, 'still exactly one open loan');

-- vehicle validation
select throws_ok(
  $q$ select public.check_out_crib_tool('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000d1', 24, 'good', null, '00000000-0000-0000-0000-0000000000e2') $q$,
  'P0001', 'Choose an active vehicle from your fleet', 'a retired vehicle is rejected');
select throws_ok(
  $q$ select public.check_out_crib_tool('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000d1', 24, 'good', null, '00000000-0000-0000-0000-0000000000e3') $q$,
  'P0001', 'Choose an active vehicle from your fleet', 'another account''s vehicle is rejected');
select is((select status from public.tool_crib_items where id = '00000000-0000-0000-0000-0000000000f2'), 'available', 'failed check-outs leave the tool available');

-- the unique index is the backstop even if the RPC were bypassed
reset role;
select throws_ok(
  $q$ insert into public.tool_crib_loans (user_id, tool_id, tool_name, tool_number, technician_name, due_at)
      values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', 'Drill', 'T-1', 'Tech One', now() + interval '1 day') $q$,
  '23505', null, 'the database itself refuses a second open loan');

-- options expose only the account's non-retired vehicles
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is(jsonb_array_length(public.tool_crib_options() -> 'vehicles'), 1, 'options list only active vehicles of this account');

-- return then check out again
select lives_ok(
  $q$ select public.check_in_crib_tool((select id from public.tool_crib_loans where tool_id = '00000000-0000-0000-0000-0000000000f1' and status = 'out'), 'good', null) $q$,
  'check-in works');
select is((select status from public.tool_crib_items where id = '00000000-0000-0000-0000-0000000000f1'), 'available', 'tool is available again');
select lives_ok(
  $q$ select public.check_out_crib_tool('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1', 24, 'good', null, null) $q$,
  'the tool can be checked out again after return');

-- no stale overload, no anonymous access
reset role;
select is((select count(*)::int from pg_proc where proname = 'check_out_crib_tool' and pronamespace = 'public'::regnamespace),
          1, 'only one check_out_crib_tool signature exists');
select is(has_function_privilege('anon', 'public.check_out_crib_tool(uuid,uuid,integer,text,text,uuid)', 'execute'),
          false, 'anon cannot execute check_out_crib_tool');

select * from finish();
rollback;
