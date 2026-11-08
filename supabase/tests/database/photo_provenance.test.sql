-- Photo provenance: immutability, tamper detection, idempotency, location gates + purge, derived-hash mapping,
-- public verification privacy, cross-tenant isolation (pgTAP).   Run with:  supabase test db
-- NOT RUN by the author: no Postgres was available. Run on staging before release.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@pp.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'other@pp.test');

insert into public.jobs (id, user_id, customer_name, scheduled_datetime, job_status) values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000a1', 'Acme', now(), 'scheduled'),
  ('00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-0000000000b1', 'Other', now(), 'scheduled');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
end $$;
create or replace function pg_temp.act_as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ------------------------------------------------------------- structure ----
select has_table('public', 'evidence_photo_captures');
select has_table('public', 'evidence_photo_locations');
select has_table('public', 'evidence_photo_derivatives');
select has_table('public', 'evidence_photo_shares');
select ok((select bool_and(relrowsecurity) from pg_class where oid in (
  'public.evidence_photo_captures'::regclass, 'public.evidence_photo_locations'::regclass,
  'public.evidence_photo_derivatives'::regclass, 'public.evidence_photo_shares'::regclass, 'public.evidence_photo_policies'::regclass)),
  'RLS enabled on every photo provenance table');

-- ------------------------------------------------- record + idempotency ------
select pg_temp.act_as_admin();
create temp table r1 as
  select public.evp_record_capture(
    '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000c001',
    '00000000-0000-0000-0000-00000000d001', repeat('a', 64),
    '00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-00000000c001/photo/' || repeat('a', 64) || '.jpg',
    1000, 'image/jpeg', 'in_app_camera', now() - interval '1 minute', false, null,
    '{"lat": 52.52123, "lng": 13.40456, "accuracy_m": 8}'::jsonb,
    jsonb_build_array(jsonb_build_object('sha256', repeat('b', 64), 'path',
      '00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-00000000c001/photo/' || repeat('b', 64) || '.jpg',
      'bytes', 400, 'mime', 'image/jpeg', 'kind', 'analysis_resize', 'width', 1600, 'height', 1200, 'transform', '{}'::jsonb))) as j;

select is((select (j ->> 'duplicate')::boolean from r1), false, 'first record is not a duplicate');
select is((select count(*)::int from public.evidence_photo_captures), 1, 'one capture row');
select is(
  (public.evp_record_capture(
    '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000c001',
    '00000000-0000-0000-0000-00000000d001', repeat('a', 64), 'x/y/photo/' || repeat('a', 64) || '.jpg', 1000, 'image/jpeg',
    'in_app_camera', now(), false, null, null, null) ->> 'duplicate')::boolean,
  true, 'retry with the same client id is idempotent');
select is((select count(*)::int from public.evidence_photo_captures), 1, 'still one capture row after retry');
select is((select count(*)::int from public.evidence_photo_derivatives), 1, 'derived copy mapped to the original');
select is((select parent_sha256 from public.evidence_photo_derivatives), repeat('a', 64), 'derived copy points at the original hash');
select is((select count(*)::int from public.job_evidence_chain_entries where source_key like 'photo%'), 2, 'capture + derivative sealed in the existing chain');
select is((public.job_evidence_chain_verify('00000000-0000-0000-0000-00000000c001') ->> 'valid')::boolean, true, 'chain valid');

-- ----------------------------------------------------------- location gates --
select is((select loc_status from public.evidence_photo_captures), 'policy_off', 'coordinates discarded while the account switch is off');
select is((select count(*)::int from public.evidence_photo_locations), 0, 'no coordinates stored when discarded');

insert into public.evidence_photo_policies (user_id, capture_location) values ('00000000-0000-0000-0000-0000000000a1', true);
select is((public.evp_record_capture(
    '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000c001',
    '00000000-0000-0000-0000-00000000d002', repeat('c', 64), 'x/y/photo/' || repeat('c', 64) || '.jpg', 1000, 'image/jpeg',
    'in_app_camera', now(), false, null, '{"lat": 52.5, "lng": 13.4, "accuracy_m": 8}'::jsonb, null) ->> 'location_status'),
  'outside_job_window', 'no coordinates before the job has started');

update public.jobs set arrived_at = now() - interval '1 hour' where id = '00000000-0000-0000-0000-00000000c001';
select is((public.evp_record_capture(
    '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000c001',
    '00000000-0000-0000-0000-00000000d003', repeat('d', 64), 'x/y/photo/' || repeat('d', 64) || '.jpg', 1000, 'image/jpeg',
    'in_app_camera', now(), false, null, '{"lat": 52.51239, "lng": 13.40456, "accuracy_m": 8}'::jsonb, null) ->> 'location_status'),
  'recorded', 'coordinates recorded inside the job window');
select is((select latitude from public.evidence_photo_locations), 52.5124::numeric, 'coordinates are rounded to 4 decimals');
select is((select location_commit_ok from (select public.evp_location_commit_ok(capture_id) as location_commit_ok from public.evidence_photo_locations) s), true, 'location commitment verifies');

-- clients cannot read coordinates
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select * from public.evidence_photo_locations $$, '42501', null, 'authenticated cannot read the locations table');
select pg_temp.act_as_admin();

-- ----------------------------------------------------------- immutability ---
select throws_ok($$ update public.evidence_photo_captures set original_sha256 = repeat('e', 64) $$, 'P0001', null, 'original hash cannot be changed');
select throws_ok($$ delete from public.evidence_photo_captures $$, 'P0001', null, 'captures cannot be deleted');
select throws_ok($$ delete from public.evidence_photo_derivatives $$, 'P0001', null, 'derivatives cannot be deleted');
select throws_ok($$ truncate public.evidence_photo_captures $$, 'P0001', null, 'captures cannot be truncated');
select throws_ok($$ update public.evidence_photo_captures set loc_status = 'purged' $$, 'P0001', null, 'status change outside the purge function is blocked');

-- ----------------------------------------------------- tamper detection ------
select is((public.evp_capture_view((select id from public.evidence_photo_captures where client_capture_id = '00000000-0000-0000-0000-00000000d001'), false,
  public.job_evidence_chain_verify('00000000-0000-0000-0000-00000000c001')) ->> 'status'), 'unmodified', 'untouched in-app photo is "unmodified"');
alter table public.evidence_photo_captures disable trigger trg_evp_captures_guard;
update public.evidence_photo_captures set original_bytes = original_bytes + 1 where client_capture_id = '00000000-0000-0000-0000-00000000d001';
alter table public.evidence_photo_captures enable trigger trg_evp_captures_guard;
select is((public.evp_capture_view((select id from public.evidence_photo_captures where client_capture_id = '00000000-0000-0000-0000-00000000d001'), false,
  public.job_evidence_chain_verify('00000000-0000-0000-0000-00000000c001')) ->> 'status'), 'integrity_failed', 'a tampered row is detected');

-- ------------------------------------------------------------- purge ---------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is(public.purge_evidence_photo_location((select id from public.evidence_photo_captures where client_capture_id = '00000000-0000-0000-0000-00000000d003')), true, 'owner can purge a location');
select pg_temp.act_as_admin();
select is((select count(*)::int from public.evidence_photo_locations), 0, 'coordinates are gone after purge');
select is((public.evp_capture_view((select id from public.evidence_photo_captures where client_capture_id = '00000000-0000-0000-0000-00000000d003'), false,
  public.job_evidence_chain_verify('00000000-0000-0000-0000-00000000c001')) ->> 'status'), 'unmodified', 'a purge does not break verification');

-- ------------------------------------------------- shares + public page -----
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
create temp table sh as select public.create_evidence_photo_share(
  '00000000-0000-0000-0000-00000000c001', array[(select id from public.evidence_photo_captures where client_capture_id = '00000000-0000-0000-0000-00000000d003')], 7, 'Internal label') as j;
select is((select length(j ->> 'token') from sh), 64, 'token is 64 hex chars');
select is((select count(*)::int from public.evidence_photo_shares where token_hash = (select j ->> 'token' from sh)), 0, 'the plain token is not stored');
select pg_temp.act_as_anon();
create temp table pub as select public.verify_evidence_photo_share((select j ->> 'token' from sh)) as j;
select is((select j ->> 'state' from pub), 'active', 'anonymous visitor can verify an active link');
select ok((select j::text from pub) !~* '(latitude|longitude|Acme|Internal label)', 'public payload has no coordinates, customer name or internal label');
select is((public.verify_evidence_photo_share(repeat('0', 64)) ->> 'found')::boolean, false, 'unknown token');
select is((public.verify_evidence_photo_share('not-a-token') ->> 'found')::boolean, false, 'malformed token');
select throws_ok($$ select * from public.evidence_photo_shares $$, '42501', null, 'anon cannot read shares');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is(public.revoke_evidence_photo_share((select (j ->> 'id')::uuid from sh)), true, 'owner can revoke');
select pg_temp.act_as_anon();
select is((public.verify_evidence_photo_share((select j ->> 'token' from sh)) ->> 'state'), 'revoked', 'revoked link stops working');

-- ------------------------------------------------------ tenant isolation ----
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$ select public.create_evidence_photo_share('00000000-0000-0000-0000-00000000c001', array[gen_random_uuid()], 7, null) $$, '42501', null, 'another account cannot share this job');
select is((select count(*)::int from public.evidence_photo_captures), 0, 'another account sees none of the captures');
select pg_temp.act_as_admin();
select throws_ok($$ select public.evp_record_capture('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
  '00000000-0000-0000-0000-00000000c001', gen_random_uuid(), repeat('f', 64), 'x/y/photo/' || repeat('f', 64) || '.jpg', 10, 'image/jpeg', 'unknown', now(), false, null, null, null) $$,
  '42501', null, 'recording into another tenant''s job is refused');

select * from finish();
rollback;
