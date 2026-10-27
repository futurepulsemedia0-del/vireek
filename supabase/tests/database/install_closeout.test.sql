-- Install Closeout: state machine, human approval, missing documents, pre-approval gating,
-- missed deadlines + escalation, tenant isolation, office-only access (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@co.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@co.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-co.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@co.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{"can_view_all_jobs": false}');

insert into public.jobs (id, user_id, customer_name, job_status) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'Acme Install', 'scheduled'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'Gated Install', 'scheduled'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Other Tenant Job', 'scheduled');

-- programs (created as postgres, bypassing RLS)
insert into public.closeout_programs (id, user_id, step_key, name, anchor, deadline_days, required_evidence, source_url, last_verified_on, is_active, auto_attach, requires_pre_approval, estimated_value_cents) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'warranty', 'DEMO Warranty', 'install_date', 30,
   array['serial_number'], 'https://example.org/warranty', current_date, true, true, false, 25000),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'rebate', 'DEMO Utility Rebate', 'install_date', 60,
   array['invoice'], 'https://example.org/rebate', current_date, true, true, true, 90000);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ------------------------------------------------------- rules are data --
select throws_ok(
  $$ insert into public.closeout_programs (user_id, step_key, name, is_active)
     values ('00000000-0000-0000-0000-0000000000a1', 'permit', 'No source', true) $$,
  '23514', null, 'an ACTIVE program must have a source URL and verified date');

select lives_ok(
  $$ insert into public.closeout_programs (user_id, step_key, name, is_active)
     values ('00000000-0000-0000-0000-0000000000a1', 'permit', 'Draft rule', false) $$,
  'an inactive draft program is allowed without a source');

select is((public.closeout_transition_allowed('pending', 'in_progress')), true, 'state machine: pending -> in_progress allowed');
select is((public.closeout_transition_allowed('pending', 'submitted')), false, 'state machine: pending -> submitted rejected');
select is((public.closeout_transition_allowed('completed', 'in_progress')), false, 'state machine: completed is terminal');
select is((public.closeout_transition_allowed('in_progress', 'missed')), false, 'state machine: only the engine sets missed');

-- ---------------------------------------------------------- open a case --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.case', (public.closeout_open_case('00000000-0000-0000-0000-0000000000e1', current_date - 40) ->> 'id'), true);

select is((select count(*)::int from public.closeout_steps where case_id = current_setting('t.case')::uuid), 5,
  'case opens with all five steps');
select is((select deadline_on from public.closeout_steps where case_id = current_setting('t.case')::uuid and step_key = 'warranty'),
  (current_date - 40 + 30), 'deadline = install date + program days (data, not hardcoded)');
select is((public.closeout_open_case('00000000-0000-0000-0000-0000000000e1') ->> 'id'), current_setting('t.case'),
  'opening a case twice is idempotent');

select set_config('t.warranty', (select id::text from public.closeout_steps where case_id = current_setting('t.case')::uuid and step_key = 'warranty'), true);

-- ----------------------------------------------------- transitions + evidence --
select lives_ok($$ select public.closeout_transition_step(current_setting('t.warranty')::uuid, 'in_progress') $$,
  'pending -> in_progress');
select throws_ok($$ select public.closeout_transition_step(current_setting('t.warranty')::uuid, 'completed') $$,
  '22023', null, 'in_progress -> completed is an invalid transition');
select throws_like($$ select public.closeout_transition_step(current_setting('t.warranty')::uuid, 'ready_for_approval') $$,
  'CLOSEOUT_MISSING_EVIDENCE: serial_number%', 'cannot be ready while a required document is missing');

select lives_ok($$ select public.closeout_add_evidence(current_setting('t.warranty')::uuid, 'serial_number', null, 'SN-12345') $$,
  'serial number attached');
select lives_ok($$ select public.closeout_transition_step(current_setting('t.warranty')::uuid, 'ready_for_approval') $$,
  'ready for approval once evidence is complete');

select throws_like($$ select public.closeout_transition_step(current_setting('t.warranty')::uuid, 'submitted', null, 'REF-1', false) $$,
  'CLOSEOUT_HUMAN_APPROVAL_REQUIRED%', 'submitting requires explicit human approval');
select lives_ok($$ select public.closeout_transition_step(current_setting('t.warranty')::uuid, 'submitted', null, 'REF-1', true) $$,
  'human-approved submission is recorded');
select isnt((select approved_by from public.closeout_steps where id = current_setting('t.warranty')::uuid), null,
  'approver is stored');
select throws_ok($$ select public.closeout_add_evidence(current_setting('t.warranty')::uuid, 'other', null, 'late add') $$,
  '22023', null, 'evidence is locked after submission');
select lives_ok($$ select public.closeout_transition_step(current_setting('t.warranty')::uuid, 'completed') $$,
  'submitted -> completed');

-- ------------------------------------------------- pre-approval gating on job start --
select set_config('t.case2', (public.closeout_open_case('00000000-0000-0000-0000-0000000000e2', current_date) ->> 'id'), true);
select set_config('t.rebate', (select id::text from public.closeout_steps where case_id = current_setting('t.case2')::uuid and step_key = 'rebate'), true);

select throws_like(
  $$ update public.jobs set job_status = 'in_progress' where id = '00000000-0000-0000-0000-0000000000e2' $$,
  'CLOSEOUT_PRE_APPROVAL_REQUIRED:%', 'job start is blocked until pre-approval is recorded');
select throws_ok($$ select public.closeout_set_pre_approval(current_setting('t.rebate')::uuid, 'approved') $$,
  '22023', null, 'approval needs the confirmation number');
select lives_ok($$ select public.closeout_set_pre_approval(current_setting('t.rebate')::uuid, 'approved', 'APR-77') $$,
  'pre-approval recorded by a person');
select lives_ok($$ update public.jobs set job_status = 'in_progress' where id = '00000000-0000-0000-0000-0000000000e2' $$,
  'job can start after pre-approval');

-- --------------------------------------------------------- missed deadlines --
reset role;
update public.closeout_steps set deadline_on = current_date - 3, status = 'in_progress', deadline_manual = true
 where id = current_setting('t.rebate')::uuid;

select is((public.closeout_engine_tick() ->> 'missed')::int >= 1, true, 'engine marks overdue open steps as missed');
select is((select status from public.closeout_steps where id = current_setting('t.rebate')::uuid), 'missed', 'step is missed');
select is((select count(*)::int from public.closeout_escalations where step_id = current_setting('t.rebate')::uuid and tier = 3), 1,
  'overdue step escalates to the owner');
select is((public.closeout_engine_tick() ->> 'escalations')::int, 0, 'engine is idempotent (no duplicate escalations)');
select is((select count(*)::int from public.closeout_events where step_id = current_setting('t.rebate')::uuid and event_type = 'step_missed'), 1,
  'missed deadline is in the audit log');

-- --------------------------------------------------- tenant isolation + roles --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.closeout_steps), 0, 'other tenant sees no steps');
select throws_ok($$ select public.closeout_open_case('00000000-0000-0000-0000-0000000000e1') $$,
  'P0002', null, 'other tenant cannot open a case on a foreign job');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from public.closeout_steps), 0, 'technicians cannot read closeout data (office/owner only)');
select throws_ok($$ select public.closeout_transition_step(current_setting('t.rebate')::uuid, 'in_progress') $$,
  '42501', null, 'technicians cannot change closeout steps');

select * from finish();
rollback;
