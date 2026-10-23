-- Project Scheduler: constraints, RPC authorization and the public progress view (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');
insert into public.team_members (id, account_owner_id, member_email, member_name, role, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@acme.test', 'Tom Tech', 'technician', 'active', '{}'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000b1', 'tech@other.test', 'Olga Other', 'technician', 'active', '{}');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.proj', (select id::text from (insert into public.install_projects (name, customer_name) values ('Re-pipe', 'Ada') returning id) x), true);
insert into public.install_project_phases (project_id, name) values (current_setting('t.proj')::uuid, 'A'), (current_setting('t.proj')::uuid, 'B'), (current_setting('t.proj')::uuid, 'C');
select set_config('t.a', (select id::text from public.install_project_phases where name = 'A' and project_id = current_setting('t.proj')::uuid), true);
select set_config('t.b', (select id::text from public.install_project_phases where name = 'B' and project_id = current_setting('t.proj')::uuid), true);
select set_config('t.c', (select id::text from public.install_project_phases where name = 'C' and project_id = current_setting('t.proj')::uuid), true);

select lives_ok($$ insert into public.install_phase_dependencies (project_id, predecessor_id, successor_id) values (current_setting('t.proj')::uuid, current_setting('t.a')::uuid, current_setting('t.b')::uuid) $$, 'a link between two phases is accepted');
select lives_ok($$ insert into public.install_phase_dependencies (project_id, predecessor_id, successor_id) values (current_setting('t.proj')::uuid, current_setting('t.b')::uuid, current_setting('t.c')::uuid) $$, 'a chain is accepted');
select throws_ok($$ insert into public.install_phase_dependencies (project_id, predecessor_id, successor_id) values (current_setting('t.proj')::uuid, current_setting('t.c')::uuid, current_setting('t.a')::uuid) $$, 'P0001', 'dependency_cycle', 'a link that closes a loop is rejected');
select throws_ok($$ insert into public.install_phase_dependencies (project_id, predecessor_id, successor_id) values (current_setting('t.proj')::uuid, current_setting('t.a')::uuid, current_setting('t.a')::uuid) $$, 'P0001', 'dependency_self', 'a phase cannot depend on itself');

select lives_ok($$ insert into public.install_phase_crews (project_id, phase_id, technician_id) values (current_setting('t.proj')::uuid, current_setting('t.a')::uuid, '00000000-0000-0000-0000-0000000000c3') $$, 'own team member can be assigned');
select throws_ok($$ insert into public.install_phase_crews (project_id, phase_id, technician_id) values (current_setting('t.proj')::uuid, current_setting('t.b')::uuid, '00000000-0000-0000-0000-0000000000d3') $$, 'P0001', 'invalid_technician', 'a member of another account cannot be assigned');

select is(public.reschedule_install_phases(current_setting('t.proj')::uuid, jsonb_build_array(jsonb_build_object('id', current_setting('t.a'), 'planned_start', '2027-03-01', 'planned_end', '2027-03-03'))), 1, 'reschedule applies a valid batch');
select throws_ok($$ select public.reschedule_install_phases(current_setting('t.proj')::uuid, jsonb_build_array(jsonb_build_object('id', current_setting('t.a'), 'planned_start', '2027-03-05', 'planned_end', '2027-03-03'))) $$, 'P0001', 'invalid_range', 'an inverted range is rejected');
select throws_ok($$ select public.reschedule_install_phases(current_setting('t.proj')::uuid, jsonb_build_array(jsonb_build_object('id', current_setting('t.a'), 'planned_start', '2027-03-08', 'planned_end', '2027-03-09', 'expected_updated_at', '2000-01-01T00:00:00Z'))) $$, 'P0001', 'stale_schedule', 'a stale edit is rejected');

select set_config('t.tok', (public.set_project_sharing(current_setting('t.proj')::uuid, true) ->> 'token'), true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$ select public.set_project_sharing(current_setting('t.proj')::uuid, true) $$, 'P0001', 'sharing_not_found', 'another account cannot share this project');

reset role;
select is((public.get_project_progress(current_setting('t.tok')::uuid) -> 'project' ->> 'name'), 'Re-pipe', 'the public view returns the project for a valid token');
select is(public.get_project_progress('99999999-9999-9999-9999-999999999999'::uuid), null, 'an unknown token returns nothing');

select * from finish();
rollback;
