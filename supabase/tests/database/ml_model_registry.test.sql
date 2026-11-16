-- ML model registry (20290305000000): staff-only access, one active version, promote / rollback
-- lifecycle, append-only audit, engine link stamping (pgTAP).
-- NOT executed by the author (no Postgres in the authoring sandbox). Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(38);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e001', 'staff@mr.test'),
  ('00000000-0000-0000-0000-00000000e002', 'tenant@mr.test');
insert into public.profiles (id) values
  ('00000000-0000-0000-0000-00000000e001'),
  ('00000000-0000-0000-0000-00000000e002')
on conflict (id) do nothing;
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-00000000e001';

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- Structure ---------------------------------------------------------------------------------
select has_table('public', 'model_registry', 'model_registry exists');
select has_function('public', 'promote_model_version', array['text','text','text','jsonb'], 'promote_model_version exists');
select has_column('public', 'ftf_predictions', 'model_registry_id', 'ftf_predictions is linked');
select has_column('public', 'rpe_assessments', 'model_registry_id', 'rpe_assessments is linked');
select has_column('public', 'remote_resolution_cases', 'model_registry_id', 'remote_resolution_cases is linked');
select is((select version from public.model_registry where name = 'first_time_fix' and status = 'active'), 'v1',
  'baseline first_time_fix v1 is active');
select is(has_function_privilege('anon', 'public.promote_model_version(text,text,text,jsonb)', 'EXECUTE'), false,
  'anon cannot execute promote');
select is(has_table_privilege('anon', 'public.model_registry', 'SELECT'), false, 'anon cannot read the registry');

-- Non-staff tenant ----------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000e002');
select is((select count(*)::int from public.model_registry), 0, 'tenant owner sees no registry rows');
select throws_ok($$ select public.promote_model_version('first_time_fix', 'v1', 'tenant tries to promote', null) $$,
  '42501', null, 'tenant cannot promote');
select throws_ok($$ select public.register_model_version('rg_test_model', 'v9') $$,
  '42501', null, 'tenant cannot register');
select is(public.model_registry_active_version('first_time_fix'), 'v1', 'engines can read the active version label');

-- Staff lifecycle ---------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000e001');
select ok((select count(*) from public.model_registry) >= 3, 'staff can read the registry');
select throws_ok($$ insert into public.model_registry (name, version) values ('rg_direct', 'v1') $$,
  '42501', null, 'staff cannot write the table directly');

select isnt(public.register_model_version('rg_test_model', 'v1', '{"n": 120}'::jsonb, '{"data": "unit-test"}'::jsonb), null,
  'register v1 returns an id');
select isnt(public.register_model_version('rg_test_model', 'v2', '{}'::jsonb, '{}'::jsonb, 'v1'), null,
  'register v2 with parent v1 returns an id');
select throws_ok($$ select public.register_model_version('rg_test_model', 'v1') $$,
  '23505', null, 'duplicate (name, version) is rejected');
select throws_ok($$ select public.register_model_version('rg_test_model', 'v3', '{}'::jsonb, '{}'::jsonb, 'nope') $$,
  '22023', null, 'unknown parent version is rejected');

select throws_ok($$ select public.promote_model_version('rg_test_model', 'v2', 'promote with no metrics at all', null) $$,
  '22023', null, 'promotion needs a non-empty metrics snapshot');
select throws_ok($$ select public.promote_model_version('rg_test_model', 'v1', 'short', null) $$,
  '22023', null, 'promotion needs a real reason');

select is(public.promote_model_version('rg_test_model', 'v1', 'first release after offline eval', null) ->> 'promoted', 'v1',
  'v1 promoted from its own metrics snapshot');
select is(public.promote_model_version('rg_test_model', 'v2', 'better calibration on holdout', '{"ece": 0.04, "n": 300}'::jsonb) ->> 'demoted', 'v1',
  'promoting v2 demotes v1');

select is((select count(*)::int from public.model_registry where name = 'rg_test_model' and status = 'active'), 1,
  'exactly one active version');
select is(public.model_registry_active_version('rg_test_model'), 'v2', 'v2 is the active version');
select is((select promoted_by from public.model_registry where name = 'rg_test_model' and version = 'v2'),
  '00000000-0000-0000-0000-00000000e001'::uuid, 'promoted_by records the staff actor');
select is((select parent_id from public.model_registry where name = 'rg_test_model' and version = 'v2'),
  (select id from public.model_registry where name = 'rg_test_model' and version = 'v1'), 'lineage parent link is kept');
select throws_ok($$ select public.promote_model_version('rg_test_model', 'v2', 'promote the active one again', null) $$,
  '55000', null, 'an active version cannot be promoted again');

select is(public.rollback_model_version('rg_test_model', 'v2 regressed in production') ->> 'active', 'v1',
  'rollback restores v1');
select is((select status from public.model_registry where name = 'rg_test_model' and version = 'v2'), 'rolled_back',
  'v2 is marked rolled_back');
select throws_ok($$ select public.rollback_model_version('rg_test_model', 'nothing left to restore') $$,
  '55000', null, 'rollback with no previous version fails');
select throws_ok($$ select public.promote_model_version('rg_test_model', 'v2', 'try to revive a rolled back build', null) $$,
  '55000', null, 'a rolled-back version cannot be re-promoted');

select is((select count(*)::int from public.model_registry_events where name = 'rg_test_model'), 5,
  'register x2, promote x2, rollback x1 are all audited');

-- Integrity (superuser) -------------------------------------------------------------------------
reset role;
select throws_ok($$ update public.model_registry_events set reason = 'tampered with the trail' where name = 'rg_test_model' $$,
  'P0001', 'model_registry_events is append-only', 'the audit trail is append-only');
select throws_ok($$ insert into public.model_registry (name, version, status, promoted_at) values ('rg_test_model', 'v77', 'active', now()) $$,
  '23505', null, 'a second active version is impossible');

-- Engine link stamping (temp tables, no tenant fixtures needed) ---------------------------------------
create temp table pg_stamp_v (id int generated always as identity, model_version smallint, model_registry_id uuid);
create trigger trg_model_registry_stamp before insert or update on pg_stamp_v
  for each row execute function public.model_registry_stamp('first_time_fix', 'model_version', 'v');
create temp table pg_stamp_u (id int generated always as identity, model_registry_id uuid);
create trigger trg_model_registry_stamp before insert or update on pg_stamp_u
  for each row execute function public.model_registry_stamp('remote_resolution', '', '');

insert into pg_stamp_v (model_version) values (1);
select is((select model_registry_id from pg_stamp_v where model_version = 1),
  (select id from public.model_registry where name = 'first_time_fix' and version = 'v1'),
  'a row declaring model_version 1 links to first_time_fix v1');

insert into pg_stamp_v (model_version) values (99);
select is((select model_registry_id from pg_stamp_v where model_version = 99),
  (select id from public.model_registry where name = 'first_time_fix' and status = 'active'),
  'an unregistered version falls back to the active version');

insert into pg_stamp_v (model_version, model_registry_id) values (1, gen_random_uuid());
select is((select count(*)::int from pg_stamp_v
            where model_registry_id = (select id from public.model_registry where name = 'first_time_fix' and version = 'v1')), 2,
  'a client-supplied registry id is ignored');

insert into pg_stamp_u default values;
update pg_stamp_u set model_registry_id = gen_random_uuid();
select is((select model_registry_id from pg_stamp_u),
  (select id from public.model_registry where name = 'remote_resolution' and status = 'active'),
  'unversioned rows keep the link made at insert and cannot be re-pointed');

select * from finish();
rollback;
