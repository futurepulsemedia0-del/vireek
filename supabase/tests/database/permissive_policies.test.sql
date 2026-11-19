-- Permissive-policy review: runtime proof (pgTAP). Run with:  supabase test db
-- Covers migration 20290304000000_permissive_policy_review.sql and docs/security/permissive-policies.md.
--   * anon cannot write anywhere except the reviewed, bounded public INSERT forms
--   * unauthenticated reads exist only on the public tables (roadmap_items, subprocessor_notices, data_regions)
--   * a tenant "admin" (profiles.role = 'admin') can no longer read/modify Vireek leads; Vireek staff can
--   * column-level SELECT hides internals while the UI columns stay readable
--   * chat visitors (anonymous-auth => role authenticated) keep their own conversation, nothing else
-- Written without a Postgres instance available: NOT RUN when this file was authored.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'tenant-admin@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'staff@vireek.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'visitor1@anon.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'visitor2@anon.test');
insert into public.profiles (id, email, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'tenant-admin@acme.test', 'admin')
  on conflict (id) do update set role = excluded.role;
insert into public.profiles (id, email, is_staff) values
  ('00000000-0000-0000-0000-0000000000b1', 'staff@vireek.test', true)
  on conflict (id) do update set is_staff = excluded.is_staff;

insert into public.demo_bookings (full_name, work_email, company_name, slot_start, slot_end)
  values ('Seed Lead', 'lead@seed.test', 'Seed Co', now() + interval '40 days', now() + interval '40 days 30 minutes');
insert into public.onboarding_bookings (full_name, work_email, company_name, slot_start, slot_end)
  values ('Seed Lead', 'lead@seed.test', 'Seed Co', now() + interval '41 days', now() + interval '41 days 30 minutes');
insert into public.status_subscribers (email) values ('subscriber@seed.test');
insert into public.support_conversations (visitor_id) values
  ('00000000-0000-0000-0000-0000000000c1'), ('00000000-0000-0000-0000-0000000000c2');

-- Runs ONE statement as a given role/user, mimicking PostgREST, and reports 'denied' (42501: no privilege OR RLS
-- violation) or 'ok:<rows affected / returned>'. Always restores the superuser role.
create or replace function pg_temp.probe(p_sql text, p_role text, p_sub uuid default null) returns text
language plpgsql as $f$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('sub', p_sub, 'role', p_role)::text end, true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    reset role;
    return 'ok:' || n;
  exception when insufficient_privilege then
    reset role;
    return 'denied';
  end;
end $f$;

-- ---------------------------------------- 1. anon writes: only bounded INSERT forms --
select is(pg_temp.probe($$ insert into public.demo_bookings (full_name, work_email, company_name, slot_start, slot_end)
  values ('Ann', 'ann@x.test', 'X', now() + interval '50 days', now() + interval '50 days 30 minutes') $$, 'anon'),
  'ok:1', 'anon can submit a valid demo booking');
select is(pg_temp.probe($$ insert into public.demo_bookings (full_name, work_email, company_name, slot_start, slot_end, status)
  values ('Ann', 'ann@x.test', 'X', now() + interval '51 days', now() + interval '51 days 30 minutes', 'completed') $$, 'anon'),
  'denied', 'anon cannot choose the booking status');
select is(pg_temp.probe($$ insert into public.demo_bookings (full_name, work_email, company_name, slot_start, slot_end)
  values ('Ann', 'not-an-email', 'X', now() + interval '52 days', now() + interval '52 days 30 minutes') $$, 'anon'),
  'denied', 'anon cannot insert a malformed email');
select is(pg_temp.probe($$ insert into public.demo_bookings (full_name, work_email, company_name, slot_start, slot_end)
  values ('Ann', 'ann@x.test', 'X', now() + interval '53 days', now() + interval '52 days') $$, 'anon'),
  'denied', 'anon cannot insert slot_end <= slot_start');
select is(pg_temp.probe($$ insert into public.onboarding_bookings (full_name, work_email, company_name, slot_start, slot_end, status)
  values ('Ann', 'ann@x.test', 'X', now() + interval '54 days', now() + interval '54 days 30 minutes', 'no_show') $$, 'anon'),
  'denied', 'anon cannot choose the onboarding booking status');
select is(pg_temp.probe($$ insert into public.newsletter_subscribers (email, source) values ('n@x.test', 'footer') $$, 'anon'),
  'ok:1', 'anon can subscribe to the newsletter');
select is(pg_temp.probe($$ insert into public.newsletter_subscribers (email, source) values ('n2@x.test', repeat('s', 65)) $$, 'anon'),
  'denied', 'anon cannot send an oversized newsletter source');
select is(pg_temp.probe($$ insert into public.status_subscribers (email, phone) values ('s@x.test', repeat('9', 40)) $$, 'anon'),
  'denied', 'anon cannot send an oversized status-subscriber phone');
select is(pg_temp.probe($$ insert into public.status_subscribers (email) values ('s@x.test') $$, 'anon'),
  'ok:1', 'anon can subscribe to status updates');

select ok(pg_temp.probe($$ update public.demo_bookings set status = 'canceled' $$, 'anon') in ('denied', 'ok:0'), 'anon cannot UPDATE demo_bookings');
select ok(pg_temp.probe($$ delete from public.demo_bookings $$, 'anon') in ('denied', 'ok:0'), 'anon cannot DELETE demo_bookings');
select ok(pg_temp.probe($$ delete from public.status_subscribers $$, 'anon') in ('denied', 'ok:0'), 'anon cannot DELETE status_subscribers');
select is(pg_temp.probe($$ insert into public.support_conversations (visitor_id) values ('00000000-0000-0000-0000-0000000000c1') $$, 'anon'),
  'denied', 'anon role cannot create a support conversation');
select ok(pg_temp.probe($$ update public.support_conversations set status = 'closed' $$, 'anon') in ('denied', 'ok:0'), 'anon role cannot UPDATE support_conversations');
select is(pg_temp.probe($$ insert into public.support_messages (conversation_id, sender_type, sender_id, body)
  select id, 'visitor', visitor_id, 'hi' from public.support_conversations limit 1 $$, 'anon'),
  'denied', 'anon role cannot post a support message');

-- ---------------------------------------- 2. unauthenticated reads: only the public tables --
select ok(pg_temp.probe($$ select 1 from public.demo_bookings $$, 'anon') in ('denied', 'ok:0'), 'anon reads no demo_bookings');
select ok(pg_temp.probe($$ select 1 from public.onboarding_bookings $$, 'anon') in ('denied', 'ok:0'), 'anon reads no onboarding_bookings');
select ok(pg_temp.probe($$ select 1 from public.status_subscribers $$, 'anon') in ('denied', 'ok:0'), 'anon reads no status_subscribers');
select ok(pg_temp.probe($$ select 1 from public.newsletter_subscribers $$, 'anon') in ('denied', 'ok:0'), 'anon reads no newsletter_subscribers');
select ok(pg_temp.probe($$ select 1 from public.docs_feedback $$, 'anon') in ('denied', 'ok:0'), 'anon reads no docs_feedback');
select ok(pg_temp.probe($$ select 1 from public.security_report_requests $$, 'anon') in ('denied', 'ok:0'), 'anon reads no security_report_requests');
select ok(pg_temp.probe($$ select 1 from public.support_conversations $$, 'anon') in ('denied', 'ok:0'), 'anon role reads no support_conversations');
select ok(pg_temp.probe($$ select 1 from public.oem_parts $$, 'anon') in ('denied', 'ok:0'), 'anon reads no authenticated-only catalog (oem_parts)');
select ok(pg_temp.probe($$ select 1 from public.jobs $$, 'anon') in ('denied', 'ok:0'), 'anon reads no tenant data (jobs)');
select isnt(pg_temp.probe($$ select 1 from public.roadmap_items $$, 'anon'), 'denied', 'anon may read the public roadmap');
select isnt(pg_temp.probe($$ select 1 from public.subprocessor_notices $$, 'anon'), 'denied', 'anon may read public sub-processor notices');
select isnt(pg_temp.probe($$ select 1 from public.data_regions $$, 'anon'), 'denied', 'anon may read the public data-region list');

-- ---------------------------------------- 3. tenant admin is NOT Vireek staff --
select is(pg_temp.probe($$ select 1 from public.demo_bookings $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1'),
  'ok:0', 'tenant admin cannot read demo_bookings');
select is(pg_temp.probe($$ select 1 from public.onboarding_bookings $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1'),
  'ok:0', 'tenant admin cannot read onboarding_bookings');
select is(pg_temp.probe($$ select 1 from public.status_subscribers $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1'),
  'ok:0', 'tenant admin cannot read status_subscribers');
select ok(pg_temp.probe($$ update public.demo_bookings set status = 'canceled' $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1') in ('denied', 'ok:0'),
  'tenant admin cannot update demo_bookings');
select ok(pg_temp.probe($$ delete from public.demo_bookings $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1') in ('denied', 'ok:0'),
  'tenant admin cannot delete demo_bookings');
select ok(pg_temp.probe($$ delete from public.status_subscribers $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1') in ('denied', 'ok:0'),
  'tenant admin cannot delete status_subscribers');

select ok(pg_temp.probe($$ select 1 from public.demo_bookings $$, 'authenticated', '00000000-0000-0000-0000-0000000000b1') not in ('denied', 'ok:0'),
  'Vireek staff can read demo_bookings');
select ok(pg_temp.probe($$ select 1 from public.onboarding_bookings $$, 'authenticated', '00000000-0000-0000-0000-0000000000b1') not in ('denied', 'ok:0'),
  'Vireek staff can read onboarding_bookings');
select ok(pg_temp.probe($$ select 1 from public.status_subscribers $$, 'authenticated', '00000000-0000-0000-0000-0000000000b1') not in ('denied', 'ok:0'),
  'Vireek staff can read status_subscribers');

-- ---------------------------------------- 4. chat visitors (anonymous auth => role authenticated) --
select is(pg_temp.probe($$ select 1 from public.support_conversations where visitor_id = '00000000-0000-0000-0000-0000000000c1' $$,
  'authenticated', '00000000-0000-0000-0000-0000000000c1'), 'ok:1', 'visitor reads their own conversation');
select is(pg_temp.probe($$ select 1 from public.support_conversations where visitor_id <> '00000000-0000-0000-0000-0000000000c1' $$,
  'authenticated', '00000000-0000-0000-0000-0000000000c1'), 'ok:0', 'visitor cannot read another visitor''s conversation');
select is(pg_temp.probe($$ update public.support_conversations set status = 'closed' $$,
  'authenticated', '00000000-0000-0000-0000-0000000000c1'), 'ok:1', 'visitor can update only their own conversation (1 row)');

-- ---------------------------------------- 5. column-level SELECT --
select is(pg_temp.probe($$ select storage_path from public.platform_backup_runs $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1'),
  'denied', 'clients cannot read platform_backup_runs.storage_path');
select is(pg_temp.probe($$ select table_row_counts from public.platform_backup_runs $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1'),
  'denied', 'clients cannot read platform_backup_runs.table_row_counts');
select is(pg_temp.probe($$ select * from public.platform_backup_runs $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1'),
  'denied', 'select * on platform_backup_runs is denied (client must name its columns)');
select isnt(pg_temp.probe($$ select id, started_at, completed_at, status, size_bytes from public.platform_backup_runs $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1'),
  'denied', 'clients can read the DR status columns the UI uses');
select is(pg_temp.probe($$ select row_count_mismatches from public.platform_restore_drills $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1'),
  'denied', 'clients cannot read platform_restore_drills.row_count_mismatches');
select isnt(pg_temp.probe($$ select id, backup_run_id, started_at, completed_at, status, rto_seconds, notes from public.platform_restore_drills $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1'),
  'denied', 'clients can read the drill columns the UI uses');
select is(pg_temp.probe($$ select artifacts from public.pack_versions $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1'),
  'denied', 'clients cannot read pack_versions.artifacts');
select isnt(pg_temp.probe($$ select pack_id, version from public.pack_versions $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1'),
  'denied', 'clients can list pack_id, version');
select is(pg_temp.probe($$ select config from public.verification_sources $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1'),
  'denied', 'clients cannot read verification_sources.config');
select isnt(pg_temp.probe($$ select id, source_key, label, jurisdiction, kind, active from public.verification_sources $$, 'authenticated', '00000000-0000-0000-0000-0000000000a1'),
  'denied', 'clients can read the verification source columns the UI uses');

-- ---------------------------------------- 6. catalog: no unauthenticated-reachable write other than INSERT --
-- polcmd: a=INSERT w=UPDATE d=DELETE *=ALL. polroles holds 0 for PUBLIC. Policies tied to auth.uid()/staff
-- helpers deny a real anon caller (auth.uid() is NULL) and are excluded, like scripts/security/permissive-allowlist.test.mjs.
select is_empty(
  $$ select c.relname || '.' || p.polname
     from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and p.polcmd in ('w', 'd', '*')
       and (0 = any (p.polroles) or (select oid from pg_roles where rolname = 'anon') = any (p.polroles))
       and coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
           !~* 'uid\(\)|jwt\(\)|role\(\)|is_vireek_staff|get_account_owner_id'
     order by 1 $$,
  'no UPDATE/DELETE/ALL policy is reachable by an unauthenticated caller');

select * from finish();
rollback;
