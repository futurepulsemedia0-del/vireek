-- AI incident register: staff-only RLS, grants, guard trigger, lifecycle rules (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(38);

-- ---------------------------------------------------------------- fixtures --
-- S = Vireek staff, O = tenant owner (the account an incident is ABOUT), X = owner of another tenant.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'staff@aiinc.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@aiinc.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'other@aiinc.test');

insert into public.profiles (id, role, is_staff) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner', true),
  ('00000000-0000-0000-0000-0000000000b1', 'owner', false),
  ('00000000-0000-0000-0000-0000000000c1', 'owner', false)
on conflict (id) do update set role = excluded.role, is_staff = excluded.is_staff;

-- One incident about tenant O, created by the service (superuser) side.
insert into public.ai_incidents (title, summary, incident_type, severity, tenant_id)
values ('Seed: agent leaked an address', 'Seed row about tenant O used to prove tenants cannot read it.', 'pii_leak_on_call', 'critical',
        '00000000-0000-0000-0000-0000000000b1');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
end $$;

-- ---------------------------------------------------------------- structure --
select has_table('public', 'ai_incidents', 'ai_incidents table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.ai_incidents'::regclass), 'RLS is enabled');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'ai_incidents'), 3, 'exactly three policies (select, insert, update)');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'ai_incidents' and cmd in ('DELETE', 'ALL')), 0, 'no DELETE or ALL policy');
select ok(not has_table_privilege('anon', 'public.ai_incidents', 'SELECT'), 'anon has no SELECT grant');
select ok(not has_table_privilege('authenticated', 'public.ai_incidents', 'DELETE'), 'authenticated has no DELETE grant');
select ok(not has_table_privilege('authenticated', 'public.ai_incidents', 'TRUNCATE'), 'authenticated has no TRUNCATE grant');
select ok(has_table_privilege('authenticated', 'public.ai_incidents', 'SELECT'), 'authenticated has a SELECT grant (RLS filters to staff)');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.ai_incidents'::regclass and contype = 'f' and confrelid = 'public.profiles'::regclass),
          'n', 'tenant link is ON DELETE SET NULL (incident survives account erasure)');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.ai_incidents'::regclass and contype = 'f' and confrelid = 'public.ai_security_events'::regclass),
          'n', 'security-event link is ON DELETE SET NULL');

-- ------------------------------------------------------ staff: allowed paths --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$insert into public.ai_incidents (title, summary, incident_type, severity, owner_role)
  values ('Agent quoted wrong price', 'The agent quoted 99 instead of 199 on one call.', 'wrong_price_commitment', 'medium', 'support_lead')$$,
  'staff can create an incident');
select matches((select ref from public.ai_incidents where title = 'Agent quoted wrong price'), '^AI-[0-9]{4}-[0-9]{5}$', 'ref is generated in the AI-YYYY-NNNNN format');
select is((select reported_by from public.ai_incidents where title = 'Agent quoted wrong price'), '00000000-0000-0000-0000-0000000000a1'::uuid, 'reported_by is always the caller');
select is((select count(*)::int from public.ai_incidents), 2, 'staff see every incident, including one about a tenant');

-- A client cannot supply server-controlled lifecycle columns.
select lives_ok($$insert into public.ai_incidents (title, summary, incident_type, severity, contained_at, resolved_at, reported_by)
  values ('Spoof attempt', 'Tries to pre-fill lifecycle columns on insert.', 'other', 'low', now(), now(), '00000000-0000-0000-0000-0000000000c1')$$,
  'insert with spoofed lifecycle columns is accepted but neutralised');
select is((select contained_at from public.ai_incidents where title = 'Spoof attempt'), null, 'contained_at from the client is ignored on insert');
select is((select reported_by from public.ai_incidents where title = 'Spoof attempt'), '00000000-0000-0000-0000-0000000000a1'::uuid, 'reported_by from the client is ignored');

-- ------------------------------------------------------ validation (staff) --
select throws_ok($$insert into public.ai_incidents (title, summary, incident_type, severity)
  values ('Leak', 'Caller jane.doe@example.com heard another address.', 'pii_leak_on_call', 'critical')$$,
  '22023', null, 'e-mail address in free text is rejected');
select throws_ok($$insert into public.ai_incidents (title, summary, incident_type, severity, detected_at)
  values ('Future', 'Detected tomorrow, which cannot be true.', 'other', 'low', now() + interval '1 day')$$,
  '22023', null, 'detected_at in the future is rejected');
select throws_ok($$insert into public.ai_incidents (title, summary, incident_type, severity)
  values ('Bad type', 'Unknown incident type must be refused.', 'made_up', 'low')$$,
  '23514', null, 'unknown incident_type is rejected');
select throws_ok($$insert into public.ai_incidents (title, summary, incident_type, severity)
  values ('Bad severity', 'Unknown severity must be refused.', 'other', 'catastrophic')$$,
  '23514', null, 'unknown severity is rejected');
select throws_ok($$insert into public.ai_incidents (title, summary, incident_type, severity)
  values ('ab', 'Title is too short to be valid.', 'other', 'low')$$,
  '23514', null, 'too-short title is rejected');

-- ------------------------------------------------------------- immutability --
select throws_ok($$update public.ai_incidents set ref = 'AI-1999-00001' where title = 'Agent quoted wrong price'$$, '42501', null, 'ref is immutable');
select throws_ok($$update public.ai_incidents set reported_by = '00000000-0000-0000-0000-0000000000c1' where title = 'Agent quoted wrong price'$$, '42501', null, 'reported_by is immutable');
select throws_ok($$delete from public.ai_incidents where title = 'Agent quoted wrong price'$$, '42501', null, 'staff cannot delete incidents (evidence)');

-- --------------------------------------------------------------- lifecycle --
update public.ai_incidents set status = 'contained' where title = 'Agent quoted wrong price';
select ok((select contained_at is not null and resolved_at is null from public.ai_incidents where title = 'Agent quoted wrong price'), 'contained sets contained_at only');
update public.ai_incidents set status = 'resolved' where title = 'Agent quoted wrong price';
select ok((select resolved_at is not null from public.ai_incidents where title = 'Agent quoted wrong price'), 'resolved sets resolved_at');
update public.ai_incidents set status = 'investigating' where title = 'Agent quoted wrong price';
select ok((select contained_at is null and resolved_at is null from public.ai_incidents where title = 'Agent quoted wrong price'), 're-opening clears contained_at and resolved_at');
select lives_ok($$update public.ai_incidents set status = 'closed' where title = 'Agent quoted wrong price'$$, 'a medium incident can be closed without a postmortem');

select throws_ok($$update public.ai_incidents set status = 'closed' where title = 'Seed: agent leaked an address'$$,
  '23514', null, 'a critical incident cannot be closed without a postmortem reference');
select lives_ok($$update public.ai_incidents set status = 'closed', postmortem_ref = 'docs/postmortems/AI-seed.md' where title = 'Seed: agent leaked an address'$$,
  'a critical incident can be closed once a postmortem reference exists');
select is((select status from public.ai_incidents where title = 'Seed: agent leaked an address'), 'closed', 'the critical incident is closed');

-- ------------------------------------------------ tenants and anon: no access --
-- O is the owner of the very account the seed incident is about, and still sees nothing.
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.ai_incidents), 0, 'a tenant owner sees no incidents, not even ones about their own account');
select throws_ok($$insert into public.ai_incidents (title, summary, incident_type, severity)
  values ('Tenant write', 'A tenant must not be able to create incidents.', 'other', 'low')$$,
  '42501', null, 'a tenant cannot insert');
select lives_ok($$update public.ai_incidents set status = 'open'$$, 'a tenant update is a silent no-op (RLS hides every row)');

select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select count(*)::int from public.ai_incidents), 0, 'an owner of another tenant sees no incidents');

select pg_temp.reset_role();
select pg_temp.act_as_anon();
select throws_ok($$select count(*) from public.ai_incidents$$, '42501', null, 'anon cannot read the register');

-- Back as staff: the tenant's blanket UPDATE must not have re-opened anything (only the spoof-attempt row is open).
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.ai_incidents where status = 'open'), 1, 'the tenant update changed nothing');

select pg_temp.reset_role();
select * from finish();
rollback;
