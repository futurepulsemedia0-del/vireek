-- Photo authenticity: write integrity, enum/consistency constraints, client privileges, tenant isolation, lifecycle (pgTAP).
-- Run with:  supabase test db
-- STATUS: the assertions below (23) were executed and passed against PostgreSQL 16 + pgTAP with this migration applied
-- on a minimal STUB schema (jobs, evidence_photo_captures, auth.uid()). They have NOT been run against the full Vireek
-- schema; this file's fixture section (evp_record_capture) is unexecuted. Run on staging before release.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@pa.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'other@pa.test');

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

-- A real sealed capture (hash 'aaaa...') created through the same function the edge function uses.
select pg_temp.act_as_admin();
select set_config('t.cap', (public.evp_record_capture(
  '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000c001',
  '00000000-0000-0000-0000-00000000d001', repeat('a', 64),
  '00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-00000000c001/photo/' || repeat('a', 64) || '.jpg',
  1000, 'image/jpeg', 'gallery_import', now() - interval '1 minute', false, null, null, null) ->> 'capture_id'), false);

-- ------------------------------------------------------------- structure ----
select has_table('public'::name, 'evidence_photo_authenticity'::name);
select ok((select relrowsecurity from pg_class where oid = 'public.evidence_photo_authenticity'::regclass), 'RLS enabled on evidence_photo_authenticity');

-- ------------------------------------------------- store (service role) ------
select pg_temp.act_as_admin();
select is((public.evp_store_authenticity(
  '00000000-0000-0000-0000-0000000000a1', current_setting('t.cap')::uuid, repeat('a', 64), 'pa-1.0.0',
  '{"c2pa":{"status":"not_present","validation":"unknown","trust":"not_evaluated"},"consistency":{"confidence":72,"level":"strong","notAVerdict":true,"reasons":[]}}'::jsonb
) ->> 'capture_id')::uuid, current_setting('t.cap')::uuid, 'report stored');
select is((select count(*)::int from public.evidence_photo_authenticity), 1, 'one report row');

select public.evp_store_authenticity(
  '00000000-0000-0000-0000-0000000000a1', current_setting('t.cap')::uuid, repeat('a', 64), 'pa-1.1.0',
  '{"c2pa":{"status":"read","validation":"invalid","trust":"not_evaluated"},"consistency":{"confidence":null,"level":"insufficient","notAVerdict":true,"reasons":[]}}'::jsonb);
select is((select count(*)::int from public.evidence_photo_authenticity), 1, 're-analysis upserts (still one row)');
select is((select analyzer_version from public.evidence_photo_authenticity), 'pa-1.1.0', 'new analyzer version replaces the old report');
select is((select c2pa_validation from public.evidence_photo_authenticity), 'invalid', 'columns follow the report');

-- ------------------------------------------------- integrity of writes -------
select throws_like($$select public.evp_store_authenticity('00000000-0000-0000-0000-0000000000b1', current_setting('t.cap')::uuid, repeat('a', 64), 'v', '{}'::jsonb)$$,
  '%PHOTO_PROVENANCE_FORBIDDEN%', 'another account cannot attach a report to this capture');
select throws_like($$select public.evp_store_authenticity('00000000-0000-0000-0000-0000000000a1', current_setting('t.cap')::uuid, repeat('f', 64), 'v', '{}'::jsonb)$$,
  '%PHOTO_PROVENANCE_INVALID%', 'bytes that differ from the sealed original are refused');
select throws_like($$select public.evp_store_authenticity('00000000-0000-0000-0000-0000000000a1', current_setting('t.cap')::uuid, repeat('a', 64), 'v',
  '{"c2pa":{"status":"bogus","validation":"valid","trust":"trusted"},"consistency":{"confidence":50,"level":"moderate"}}'::jsonb)$$,
  '%PHOTO_PROVENANCE_INVALID%', 'unknown enum values are rejected');
select throws_like($$select public.evp_store_authenticity('00000000-0000-0000-0000-0000000000a1', current_setting('t.cap')::uuid, repeat('a', 64), 'v',
  '{"c2pa":{"status":"read","validation":"valid","trust":"trusted"},"consistency":{"confidence":null,"level":"strong"}}'::jsonb)$$,
  '%PHOTO_PROVENANCE_INVALID%', 'a level without a number is rejected (no data must be "insufficient")');
select throws_like($$select public.evp_store_authenticity('00000000-0000-0000-0000-0000000000a1', current_setting('t.cap')::uuid, repeat('a', 64), 'v',
  '{"c2pa":{"status":"read","validation":"valid","trust":"trusted"},"consistency":{"confidence":40,"level":"insufficient"}}'::jsonb)$$,
  '%PHOTO_PROVENANCE_INVALID%', 'a number with level insufficient is rejected');
select throws_ok($$update public.evidence_photo_authenticity set job_id = '00000000-0000-0000-0000-00000000c0b1'$$, 'Ownership of an authenticity report cannot change');

-- ------------------------------------------------- client privileges ---------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$select public.evp_store_authenticity('00000000-0000-0000-0000-0000000000a1', current_setting('t.cap')::uuid, repeat('a', 64), 'v', '{}'::jsonb)$$, '42501', null, 'signed-in users cannot call the write function');
select throws_ok($$insert into public.evidence_photo_authenticity (capture_id, user_id, job_id, analyzed_sha256, analyzer_version, c2pa_status, c2pa_validation, c2pa_trust, consistency_level, report)
  values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000c001', repeat('a', 64), 'v', 'read', 'valid', 'trusted', 'insufficient', '{}')$$, '42501', null, 'no direct INSERT');
select throws_ok($$update public.evidence_photo_authenticity set consistency_level = 'strong'$$, '42501', null, 'no direct UPDATE');
select throws_ok($$delete from public.evidence_photo_authenticity$$, '42501', null, 'no direct DELETE');

-- ------------------------------------------------- reads + tenant isolation --
select is(jsonb_array_length(public.get_evidence_photo_authenticity('00000000-0000-0000-0000-00000000c001') -> 'items'), 1, 'owner reads the report for their job');
select is((public.get_evidence_photo_authenticity('00000000-0000-0000-0000-00000000c001') -> 'items' -> 0 -> 'report' #>> '{consistency,level}'), 'insufficient', 'report content is returned');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is(jsonb_array_length(public.get_evidence_photo_authenticity('00000000-0000-0000-0000-00000000c001') -> 'items'), 0, 'another tenant sees nothing (RLS)');
select is((select count(*)::int from public.evidence_photo_authenticity), 0, 'another tenant cannot select the table');
select pg_temp.act_as_anon();
select throws_ok($$select public.get_evidence_photo_authenticity('00000000-0000-0000-0000-00000000c001')$$, '42501', null, 'anonymous cannot read');

-- ------------------------------------------------- lifecycle ----------------
select pg_temp.act_as_admin();
delete from public.jobs where id = '00000000-0000-0000-0000-00000000c001';
select is((select count(*)::int from public.evidence_photo_authenticity), 0, 'report is removed with its job');
select * from finish();
rollback;
