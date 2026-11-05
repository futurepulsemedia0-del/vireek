-- Mass Incident Mode: clustering commit, tenant isolation, permissions and directory/signal integrity (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

-- ---------------------------------------------------------------- fixtures --
-- O owner, M manager (can_manage_numbers), T technician (no dispatch permissions), X owner of ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'manager@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

delete from public.profiles where id in ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'manager@acme.test', 'Mia Manager', 'admin',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_manage_numbers": true}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@acme.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{}');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.mk_plan(p_ref text, p_action text, p_incident_id uuid default null, p_candidates jsonb default '[]',
                                        p_emergency boolean default false) returns jsonb language sql as $$
  select jsonb_build_object(
    'action', p_action,
    'incident_id', p_incident_id,
    'candidate_ids', p_candidates,
    'contact', jsonb_build_object(
      'source', 'call', 'source_ref', p_ref, 'contact_at', now(), 'postal_code', '78701', 'lat', 30.2672, 'lng', -97.7431,
      'geo_precision', 'postal', 'symptom_class', 'no_water', 'symptom_text', 'no water', 'is_emergency', p_emergency,
      'hazards', case when p_emergency then '["gas"]'::jsonb else '[]'::jsonb end),
    'incident', jsonb_build_object('title', 'Possible water supply issue — 78701', 'status', 'active', 'symptom_class', 'no_water',
      'confidence', 0.62, 'suspected_cause', 'water_supply_issue', 'cause_status', 'suspected', 'cause_confidence', 0.5))
$$;

-- ------------------------------------------------------------ permissions --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok(
  $$select public.mass_incident_save_settings(true, 120, 3, 3, true)$$, '42501', 'not authorized',
  'a technician cannot change Mass Incident settings');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select lives_ok($$select public.mass_incident_save_settings(true, 120, 3, 3, true)$$,
  'a manager with can_manage_numbers can enable it (writes the OWNER account)');

reset role;
select is((select enabled from public.mass_incident_settings where user_id = '00000000-0000-0000-0000-0000000000a1'), true,
  'settings are keyed by the account owner, not the manager');

select ok(not has_function_privilege('authenticated', 'public.mass_incident_commit(uuid,bigint,jsonb)', 'execute'),
  'authenticated cannot execute the commit RPC');
select ok(has_function_privilege('service_role', 'public.mass_incident_commit(uuid,bigint,jsonb)', 'execute'),
  'service_role can execute the commit RPC');

-- --------------------------------------------------------------- clustering --
select is((public.mass_incident_commit('00000000-0000-0000-0000-0000000000a1', 0, pg_temp.mk_plan('call-1', 'none')) ->> 'status'), 'ok',
  'first contact is stored as a loose contact');
select is((public.mass_incident_commit('00000000-0000-0000-0000-0000000000a1', 1, pg_temp.mk_plan('call-2', 'none')) ->> 'status'), 'ok',
  'second contact is stored as a loose contact');
select is((select count(*)::int from public.mass_incidents where user_id = '00000000-0000-0000-0000-0000000000a1'), 0,
  'no incident exists before the threshold');

select is((public.mass_incident_commit('00000000-0000-0000-0000-0000000000a1', 1, pg_temp.mk_plan('call-x', 'none')) ->> 'status'), 'conflict',
  'a stale version is rejected so two simultaneous contacts cannot create duplicates');

select is((public.mass_incident_commit('00000000-0000-0000-0000-0000000000a1', 2,
  pg_temp.mk_plan('call-3', 'create', null,
    (select jsonb_agg(id) from public.mass_incident_contacts where user_id = '00000000-0000-0000-0000-0000000000a1' and source_ref in ('call-1','call-2')))
  ) ->> 'created'), 'true', 'the third linked contact creates ONE incident');

select is((select member_count from public.mass_incidents where user_id = '00000000-0000-0000-0000-0000000000a1'), 3,
  'the incident links all three contacts');
select is((select count(*)::int from public.mass_incident_contacts where user_id = '00000000-0000-0000-0000-0000000000a1'), 3,
  'no contact was dropped');

select is((public.mass_incident_commit('00000000-0000-0000-0000-0000000000a1', 3, pg_temp.mk_plan('call-3', 'none')) ->> 'status'), 'ok',
  're-sending the same source_ref is idempotent');
select is((select count(*)::int from public.mass_incident_contacts where user_id = '00000000-0000-0000-0000-0000000000a1'), 3,
  'idempotent: still three contacts');

select public.mass_incident_commit('00000000-0000-0000-0000-0000000000a1', 4,
  pg_temp.mk_plan('call-e', 'attach', (select id from public.mass_incidents where user_id = '00000000-0000-0000-0000-0000000000a1'), '[]', true));
select is((select emergency_count from public.mass_incidents where user_id = '00000000-0000-0000-0000-0000000000a1'), 1,
  'an emergency contact is recorded for visibility and counted separately');

-- ------------------------------------------------------------- phase 2 --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$select public.mass_incident_set_auto_reply(true)$$, '42501', 'not authorized',
  'a technician cannot enable the SMS auto-reply');
reset role;

update public.mass_incident_contacts set address_text = '1 Main St Austin TX'
 where user_id = '00000000-0000-0000-0000-0000000000a1' and source_ref = 'call-2';
select public.mass_incident_set_geo('00000000-0000-0000-0000-0000000000a1',
  (select id from public.mass_incident_contacts where user_id = '00000000-0000-0000-0000-0000000000a1' and source_ref = 'call-2'), 30.1, -97.7);
select is((select address_text from public.mass_incident_contacts where user_id = '00000000-0000-0000-0000-0000000000a1' and source_ref = 'call-2'), null,
  'the street address is erased once it has been geocoded');
select is((select geo_precision from public.mass_incident_contacts where user_id = '00000000-0000-0000-0000-0000000000a1' and source_ref = 'call-2'), 'address',
  'the contact is upgraded to address precision');

select public.mass_incident_link_job('00000000-0000-0000-0000-0000000000a1', 'call', 'call-2', gen_random_uuid());
select is((select job_id from public.mass_incident_contacts where user_id = '00000000-0000-0000-0000-0000000000a1' and source_ref = 'call-2'), null,
  'a job that does not belong to this account is never linked');

-- ---------------------------------------------------------- tenant isolation --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.mass_incidents), 0, 'another account sees none of these incidents');
select is((select count(*)::int from public.mass_incident_contacts), 0, 'another account sees none of these contacts');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from public.mass_incidents), 0, 'a technician without dispatch permissions sees no incidents');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.mass_incidents), 1, 'the owner sees the incident');

-- ------------------------------------------------------ owner decisions stick --
select lives_ok(
  $$select public.mass_incident_detach_contact((select id from public.mass_incident_contacts where source_ref = 'call-1'))$$,
  'owner can detach a mis-grouped contact');
select is((select member_count from public.mass_incidents), 3, 'member count is recomputed after detach (4 members, call-1 removed)');

-- --------------------------------------------------- directory + signals rules --
select throws_ok(
  $$select public.mass_incident_directory_upsert(null, 'US', 'TX', null, 'water', 'City Water', '+15125550100', null, 'http://insecure.example', now(), 'owner', null)$$,
  '23514', null, 'a directory entry needs an https source URL');
select throws_ok(
  $$select public.mass_incident_add_notice('municipal_notice', 'Water main repair', null, array['78701'], null, array['water_supply_issue'], null)$$,
  'P0001', 'an https source URL of the official notice is required', 'verified evidence needs an https source URL');

select * from finish();
rollback;
