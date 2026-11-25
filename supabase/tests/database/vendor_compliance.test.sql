-- Vendor licence verification + COI enforcement (pgTAP). Run with:  supabase test db
-- Covers: tenant isolation, manager gate, append-only licence evidence, COI status maths,
-- enforcement off/block, grace + exemption, status reset on edit, file-path guard, sweep de-dup.
begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'tech@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'tech@acme.test', 'Tia Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_view_billing": false}');

-- Owners need a profile; the technician must NOT have one (an auto-created profile would make them an owner).
insert into public.profiles (id, email, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test', 'owner'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test', 'owner')
on conflict (id) do update set role = 'owner';
delete from public.profiles where id = '00000000-0000-0000-0000-0000000000a2';

insert into public.vendors (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Sunrise Roofing'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b1', 'Other Co Vendor');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ---- structure -------------------------------------------------------------------------
select has_trigger('public', 'job_board_posts', 'trg_job_board_guard_vendor_coi', 'award guard trigger exists');
select has_function('public', 'job_board_vendor_blockers_base', array['uuid', 'uuid', 'text', 'uuid'], 'original gate kept as *_base');

-- ---- owner (manager) flow ------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');

select lives_ok($$ select public.record_vendor_license_check(
  '00000000-0000-0000-0000-0000000000d1', 'CGC-123456', 'US-FL', 'active', current_date + 200,
  'https://example.gov/record/1', 'Sunrise Roofing LLC', 'Roofing', null) $$, 'manager can record a licence check');
select throws_ok($$ select public.record_vendor_license_check(
  '00000000-0000-0000-0000-0000000000d1', 'CGC-123456', 'US-FL', 'active', null, null, null, null, null) $$,
  'P0001', 'SOURCE_URL_REQUIRED', 'an active licence needs a source link');
select throws_ok($$ select public.record_vendor_license_check(
  '00000000-0000-0000-0000-0000000000d1', 'X1', 'FL', 'revoked', null, null, null, null, null) $$,
  '23514', null, 'malformed state code is rejected');
select throws_ok($$ select public.record_vendor_license_check(
  '00000000-0000-0000-0000-0000000000d2', 'X1', 'US-FL', 'revoked', null, null, null, null, null) $$,
  'P0001', 'VENDOR_NOT_FOUND', 'cannot record against another account''s vendor');
select throws_ok($$ update public.vendor_license_checks set notes = 'tamper' $$, '42501', null, 'licence evidence cannot be edited by the client');
select is((select count(*)::int from public.vendor_license_current where vendor_id = '00000000-0000-0000-0000-0000000000d1'), 1, 'one current row per licence');

select public.save_vendor_compliance_settings('{"coi_enforcement":"block","coi_grace_days":2}'::jsonb);
select is((public.get_vendor_compliance_settings() ->> 'coi_enforcement'), 'block', 'owner can switch enforcement on');

select public.save_vendor_coi_coverage('00000000-0000-0000-0000-0000000000d1', 'general_liability', current_date + 90,
  'Acme Mutual', 'GL-1', null, 100000000, null, null, null, null);
select is((select (public.get_vendor_coi_status('00000000-0000-0000-0000-0000000000d1') ->> 'blocked')::boolean), true,
  'blocked while required coverage is missing / unverified');

select throws_ok($$ select public.save_vendor_coi_coverage('00000000-0000-0000-0000-0000000000d1', 'workers_comp', current_date + 90,
  null, null, null, null, null, '00000000-0000-0000-0000-0000000000b1/00000000-0000-0000-0000-0000000000d2/x.pdf', null, null) $$,
  'P0001', 'INVALID_FILE_PATH', 'a file path outside this account/vendor is refused');

-- verify both lines
select public.set_vendor_coi_coverage_status(id, 'verified') from public.vendor_coi_coverages where vendor_id = '00000000-0000-0000-0000-0000000000d1';
select public.save_vendor_coi_coverage('00000000-0000-0000-0000-0000000000d1', 'workers_comp', current_date + 90,
  null, null, null, null, null, null, null, null);
select public.set_vendor_coi_coverage_status(id, 'verified') from public.vendor_coi_coverages
  where vendor_id = '00000000-0000-0000-0000-0000000000d1' and coverage_type = 'workers_comp';
select is((select (public.get_vendor_coi_status('00000000-0000-0000-0000-0000000000d1') ->> 'blocked')::boolean), false, 'not blocked once GL + WC are verified');

select public.save_vendor_coi_coverage('00000000-0000-0000-0000-0000000000d1', 'general_liability', current_date + 90,
  'Acme Mutual', 'GL-1', null, 500, null, null, 'edited', (select id from public.vendor_coi_coverages where coverage_type = 'general_liability'));
select is((select status from public.vendor_coi_coverages where coverage_type = 'general_liability'), 'pending', 'editing a verified coverage drops it back to pending');

select throws_ok($$ select public.set_vendor_coi_requirement('00000000-0000-0000-0000-0000000000d1', true, '  ', null) $$,
  'P0001', 'REASON_REQUIRED', 'an exemption needs a written reason');

-- ---- a technician without billing permission --------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.vendor_coi_coverages), 0, 'non-manager sees no coverage rows');
select is((select count(*)::int from public.vendor_license_checks), 0, 'non-manager sees no licence rows');
select throws_ok($$ select public.get_vendor_compliance_settings() $$, 'P0001', 'FORBIDDEN', 'non-manager cannot read settings');
select throws_ok($$ select public.save_vendor_compliance_settings('{"coi_enforcement":"off"}'::jsonb) $$, 'P0001', 'FORBIDDEN', 'non-owner cannot change settings');

-- ---- another account ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.vendor_coi_coverages), 0, 'another account sees none of these coverages');

-- ---- gate + sweep (as the table owner) -------------------------------------------------------------
reset role;
update public.vendor_coi_coverages set status = 'verified', verified_at = now() where vendor_id = '00000000-0000-0000-0000-0000000000d1';
update public.vendor_coi_coverages set expires_on = current_date - 1 where coverage_type = 'workers_comp' and vendor_id = '00000000-0000-0000-0000-0000000000d1';
select is(public.vendor_coi_blockers('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1'), array['COI']::text[],
  'expired beyond grace => COI blocker');
update public.vendor_compliance_settings set coi_enforcement = 'off' where user_id = '00000000-0000-0000-0000-0000000000a1';
select is(public.vendor_coi_blockers('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1'), '{}'::text[],
  'enforcement off => never blocks');

select ok(public.vendor_compliance_sweep() >= 1, 'sweep raises at least one alert');
select is(public.vendor_compliance_sweep(), 0, 'running the sweep again raises nothing new (de-duplicated)');

select * from finish();
rollback;
