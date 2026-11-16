-- Support severity + internal SLA clocks + staff overdue view (pgTAP). Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(28);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@vireek.test');
insert into public.profiles (id, plan, created_at, is_staff) values
  ('00000000-0000-0000-0000-0000000000a1', 'pro', now() - interval '60 days', false),
  ('00000000-0000-0000-0000-0000000000b1', 'starter', now() - interval '60 days', false),
  ('00000000-0000-0000-0000-0000000000c1', 'starter', now() - interval '60 days', true);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ---------- provisional severity on insert ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
insert into public.support_conversations (id, visitor_id, kind, subject, priority) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'ticket', 'Calls not answered', 'urgent'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1', 'ticket', 'Small question', 'low'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000a1', 'ticket', 'Report looks off', 'normal');
insert into public.support_conversations (id, visitor_id, kind, subject, priority, severity) values
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000a1', 'ticket', 'Forged severity', 'high', 'S1');

select is((select severity from public.support_conversations where id = '10000000-0000-0000-0000-000000000001'), 'S2', 'urgent -> provisional S2 (never S1)');
select is((select severity from public.support_conversations where id = '10000000-0000-0000-0000-000000000002'), 'S4', 'low -> S4');
select is((select severity from public.support_conversations where id = '10000000-0000-0000-0000-000000000003'), 'S3', 'normal -> S3');
select is((select severity from public.support_conversations where id = '10000000-0000-0000-0000-000000000004'), 'S2', 'client-supplied severity on insert is ignored');
select ok((select severity_confirmed_at is null from public.support_conversations where id = '10000000-0000-0000-0000-000000000001'), 'new ticket is unconfirmed');
select ok((select internal_clock_started_at is not null from public.support_conversations where id = '10000000-0000-0000-0000-000000000001'), 'internal clock is stamped server-side');

-- ---------- tenant cannot tamper ----------
update public.support_conversations
set severity = 'S1', internal_clock_started_at = now() - interval '10 days', severity_confirmed_at = now()
where id = '10000000-0000-0000-0000-000000000003';
select is((select severity from public.support_conversations where id = '10000000-0000-0000-0000-000000000003'), 'S3', 'owner cannot change severity');
select ok((select internal_clock_started_at > now() - interval '1 minute' from public.support_conversations where id = '10000000-0000-0000-0000-000000000003'), 'owner cannot move the clock');

-- ---------- targets are staff-only ----------
select is((select count(*)::int from public.support_sla_targets), 0, 'tenant cannot read targets');
update public.support_sla_targets set first_response_minutes = 1 where severity = 'S1';

-- ---------- staff ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select first_response_minutes from public.support_sla_targets where severity = 'S1'), 30, 'tenant update of targets had no effect');
select is((select count(*)::int from public.support_sla_targets), 4, 'staff reads all 4 targets');

update public.support_conversations set severity = 'S1' where id = '10000000-0000-0000-0000-000000000003';
select is((select severity from public.support_conversations where id = '10000000-0000-0000-0000-000000000003'), 'S1', 'staff can set severity');
select is((select severity_confirmed_by from public.support_conversations where id = '10000000-0000-0000-0000-000000000003'), '00000000-0000-0000-0000-0000000000c1'::uuid, 'confirmer is stamped from auth.uid()');
select ok((select severity_confirmed_at is not null from public.support_conversations where id = '10000000-0000-0000-0000-000000000003'), 'confirmed_at is stamped');

update public.support_conversations set severity_confirmed_at = '2000-01-01' where id = '10000000-0000-0000-0000-000000000001';
select ok((select severity_confirmed_at > now() - interval '1 minute' from public.support_conversations where id = '10000000-0000-0000-0000-000000000001'), 'confirmation time is server-stamped, not client-supplied');

update public.support_conversations set internal_clock_started_at = now() - interval '9 days' where id = '10000000-0000-0000-0000-000000000002';
select ok((select internal_clock_started_at > now() - interval '1 minute' from public.support_conversations where id = '10000000-0000-0000-0000-000000000002'), 'clock is immutable even for staff');

select throws_ok($$ update public.support_conversations set severity = null where id = '10000000-0000-0000-0000-000000000003' $$, '23514', null, 'a ticket cannot lose its severity');

update public.support_sla_targets set first_response_minutes = 45 where severity = 'S1';
select is((select first_response_minutes from public.support_sla_targets where severity = 'S1'), 45, 'staff can edit a target');
select is((select updated_by from public.support_sla_targets where severity = 'S1'), '00000000-0000-0000-0000-0000000000c1'::uuid, 'updated_by is stamped');
select throws_ok($$ update public.support_sla_targets set resolution_minutes = 10 where severity = 'S1' $$, '23514', null, 'resolution target cannot be shorter than first response');
select throws_ok($$ update public.support_sla_targets set severity = 'S9' where severity = 'S1' $$, '42501', null, 'severity key column is not updatable');

-- ---------- overdue view ----------
select pg_temp.as_admin();
select set_config('vireek.support_internal', '1', true);
update public.support_conversations set internal_clock_started_at = now() - interval '2 hours' where id = '10000000-0000-0000-0000-000000000003';
select set_config('vireek.support_internal', '', true);

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select overdue_kind from public.support_overdue_tickets where id = '10000000-0000-0000-0000-000000000003'), 'first_response', 'S1 ticket with no reply after 2h is first-response overdue');
select ok((select overdue_seconds >= 4000 from public.support_overdue_tickets where id = '10000000-0000-0000-0000-000000000003'), 'overdue_seconds reflects the live 45m target');
select is((select count(*)::int from public.support_overdue_tickets where id = '10000000-0000-0000-0000-000000000002'), 0, 'fresh S4 ticket is not overdue');

select pg_temp.as_admin();
select set_config('vireek.support_internal', '1', true);
update public.support_conversations
set internal_clock_started_at = now() - interval '5 hours', first_response_at = now() - interval '4 hours'
where id = '10000000-0000-0000-0000-000000000003';
select set_config('vireek.support_internal', '', true);

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select overdue_kind from public.support_overdue_tickets where id = '10000000-0000-0000-0000-000000000003'), 'resolution', 'after a reply the resolution clock is what is overdue');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.support_overdue_tickets), 0, 'tenant sees nothing in the overdue view');

select pg_temp.as_admin();
select set_config('vireek.support_internal', '1', true);
update public.support_conversations set awaiting_customer = true where id = '10000000-0000-0000-0000-000000000003';
select set_config('vireek.support_internal', '', true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select count(*)::int from public.support_overdue_tickets where id = '10000000-0000-0000-0000-000000000003'), 0, 'waiting on customer is not overdue');

select pg_temp.as_admin();
select set_config('vireek.support_internal', '1', true);
update public.support_conversations set awaiting_customer = false, status = 'closed' where id = '10000000-0000-0000-0000-000000000003';
select set_config('vireek.support_internal', '', true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select is((select count(*)::int from public.support_overdue_tickets where id = '10000000-0000-0000-0000-000000000003'), 0, 'closed tickets are never overdue');

select * from finish();
rollback;
