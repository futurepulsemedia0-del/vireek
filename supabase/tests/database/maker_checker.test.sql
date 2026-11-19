-- Maker-checker (requester != approver): shared rule, threshold, solo-owner exception, guards (pgTAP).
-- Run with:  supabase test db
-- The guard functions are exercised through TEMP tables with the same columns as the real tables, so no
-- workflow/closeout fixtures are needed. The real triggers are checked in the catalog.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@mc.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'member@mc.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'solo@mc.test');
insert into public.profiles (id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000d1', 'owner')
on conflict (id) do nothing;
insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'member@mc.test', 'Mia Member', 'admin',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{}'::jsonb);

create or replace function pg_temp.claim_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- --------------------------------------------------------------- catalog ----
select has_function('public', 'maker_checker_assert', array['uuid','text','text','bigint','uuid','uuid','boolean'], 'shared rule function exists');
select ok((select relrowsecurity from pg_class where oid = 'public.maker_checker_settings'::regclass), 'maker_checker_settings has RLS');
select ok(not has_function_privilege('authenticated', 'public.maker_checker_assert(uuid,text,text,bigint,uuid,uuid,boolean)', 'execute'),
  'clients cannot call the internal rule directly');
select ok(exists (select 1 from pg_trigger where tgrelid = 'public.workflow_approvals'::regclass and tgname = 'trg_maker_checker_guard' and not tgisinternal),
  'workflow_approvals has the guard trigger');
select ok(exists (select 1 from pg_trigger where tgrelid = 'public.compiled_workflow_approvals'::regclass and tgname = 'trg_maker_checker_guard' and not tgisinternal),
  'compiled_workflow_approvals has the guard trigger');
select ok(exists (select 1 from pg_trigger where tgrelid = 'public.closeout_steps'::regclass and tgname = 'trg_maker_checker_closeout_guard' and not tgisinternal),
  'closeout_steps has the guard trigger');
select ok(exists (select 1 from pg_trigger where tgrelid = 'public.commercial_approval_decisions'::regclass and tgname = 'trg_maker_checker_commercial_decision' and not tgisinternal),
  'commercial_approval_decisions has the guard trigger');
select has_column('public', 'workflow_approvals', 'requested_by', 'workflow_approvals.requested_by exists');
select has_column('public', 'compiled_workflow_approvals', 'requested_by', 'compiled_workflow_approvals.requested_by exists');
select has_column('public', 'closeout_steps', 'approval_requested_by', 'closeout_steps.approval_requested_by exists');

-- ------------------------------------------------- shared rule, defaults ----
select lives_ok($$ select public.maker_checker_assert('00000000-0000-0000-0000-0000000000a1', 't', '1', 100, '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1') $$,
  'different people: allowed');
select lives_ok($$ select public.maker_checker_assert('00000000-0000-0000-0000-0000000000a1', 't', '1', 100, null, '00000000-0000-0000-0000-0000000000a2') $$,
  'no human requester (automation): allowed');
select throws_ok($$ select public.maker_checker_assert('00000000-0000-0000-0000-0000000000a1', 't', '1', 100, '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a2') $$,
  '42501', null, 'team member approving their own request: refused');
select throws_ok($$ select public.maker_checker_assert('00000000-0000-0000-0000-0000000000a1', 't', '1', 100, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'owner approving own request while a team exists: refused');
select lives_ok($$ select public.maker_checker_assert('00000000-0000-0000-0000-0000000000d1', 't', '9', 100, '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1') $$,
  'solo owner (no other member): allowed');
select is((select count(*)::int from public.audit_log where user_id = '00000000-0000-0000-0000-0000000000d1' and action = 'maker_checker.solo_self_approval'), 1,
  'solo self approval is written to audit_log');

-- ------------------------------------------------ generic guard (temp) ------
create temp table t_ap (id uuid primary key default gen_random_uuid(), user_id uuid, status text, requested_by uuid, decided_by uuid, price_cents integer);
create trigger t_guard before update on t_ap for each row
  execute function public.maker_checker_guard('t.test', 'approved', 'price_cents');

insert into t_ap (id, user_id, status, requested_by, price_cents) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'pending', '00000000-0000-0000-0000-0000000000a2', 10000),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'pending', '00000000-0000-0000-0000-0000000000a2', 10000),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a1', 'pending', null, 10000),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000a1', 'pending', '00000000-0000-0000-0000-0000000000a2', 10000);

select throws_ok($$ update t_ap set status = 'approved', decided_by = '00000000-0000-0000-0000-0000000000a2' where id = '00000000-0000-0000-0000-0000000000e1' $$,
  '42501', null, 'guard: requester cannot approve their own row');
select is((select status from t_ap where id = '00000000-0000-0000-0000-0000000000e1'), 'pending', 'refused approval left the row pending');
select lives_ok($$ update t_ap set status = 'approved', decided_by = '00000000-0000-0000-0000-0000000000a1' where id = '00000000-0000-0000-0000-0000000000e2' $$,
  'guard: a different person can approve');
select lives_ok($$ update t_ap set status = 'approved', decided_by = '00000000-0000-0000-0000-0000000000a2' where id = '00000000-0000-0000-0000-0000000000e3' $$,
  'guard: automation-requested row (requested_by null) can be approved by a person');
select throws_ok($$ update t_ap set requested_by = null where id = '00000000-0000-0000-0000-0000000000e4' $$,
  '42501', null, 'guard: requested_by cannot be cleared to dodge the rule');
select lives_ok($$ update t_ap set status = 'rejected', decided_by = '00000000-0000-0000-0000-0000000000a2' where id = '00000000-0000-0000-0000-0000000000e4' $$,
  'guard: rejecting your own request is not blocked');

-- ----------------------------------------------------------- threshold ------
insert into public.maker_checker_settings (user_id, money_threshold_cents)
  values ('00000000-0000-0000-0000-0000000000a1', 50000);

select lives_ok($$ select public.maker_checker_assert('00000000-0000-0000-0000-0000000000a1', 't', '1', 49999, '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a2') $$,
  'threshold: known amount below it is exempt');
select throws_ok($$ select public.maker_checker_assert('00000000-0000-0000-0000-0000000000a1', 't', '1', 50000, '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a2') $$,
  '42501', null, 'threshold: amount equal to it is enforced');
select throws_ok($$ select public.maker_checker_assert('00000000-0000-0000-0000-0000000000a1', 't', '1', null, '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a2') $$,
  '42501', null, 'threshold: unknown amount is never exempt');
select throws_ok($$ select public.maker_checker_assert('00000000-0000-0000-0000-0000000000a1', 't', '1', 1, '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a2', true) $$,
  '42501', null, 'risky settings ignore the money threshold');
select is((select count(*)::int from public.audit_log where user_id = '00000000-0000-0000-0000-0000000000a1' and action = 'maker_checker.settings.change'), 1,
  'settings change is audited');
select throws_ok($$ insert into public.maker_checker_settings (user_id, money_threshold_cents) values ('00000000-0000-0000-0000-0000000000d1', -1) $$,
  '23514', null, 'negative threshold is rejected by the CHECK');

-- solo exception can be switched off per tenant
insert into public.maker_checker_settings (user_id, solo_owner_exception)
  values ('00000000-0000-0000-0000-0000000000d1', false);
select throws_ok($$ select public.maker_checker_assert('00000000-0000-0000-0000-0000000000d1', 't', '9', 100, '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1') $$,
  '42501', null, 'solo exception off: owner cannot approve own request');

-- ----------------------------------------- close-out guard (temp table) ------
create temp table t_co (id uuid primary key default gen_random_uuid(), user_id uuid, status text, approval_requested_by uuid, approved_by uuid, estimated_value_cents integer);
create trigger t_co_guard before update on t_co for each row
  execute function public.maker_checker_closeout_guard();
insert into t_co (id, user_id, status, estimated_value_cents) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'in_progress', 60000);  -- above tenant a1's 50000 threshold set earlier

select pg_temp.claim_as('00000000-0000-0000-0000-0000000000a2');
update t_co set status = 'ready_for_approval' where id = '00000000-0000-0000-0000-0000000000f1';
select is((select approval_requested_by from t_co where id = '00000000-0000-0000-0000-0000000000f1'), '00000000-0000-0000-0000-0000000000a2'::uuid,
  'closeout: the person who marks it ready is recorded as the requester');
select throws_ok($$ update t_co set approval_requested_by = null where id = '00000000-0000-0000-0000-0000000000f1' $$,
  '42501', null, 'closeout: requester cannot be rewritten');
select throws_ok($$ update t_co set status = 'submitted', approved_by = '00000000-0000-0000-0000-0000000000a2' where id = '00000000-0000-0000-0000-0000000000f1' $$,
  '42501', null, 'closeout: the person who prepared it cannot submit it');
select lives_ok($$ update t_co set status = 'submitted', approved_by = '00000000-0000-0000-0000-0000000000a1' where id = '00000000-0000-0000-0000-0000000000f1' $$,
  'closeout: a different person can approve and submit');
select pg_temp.claim_as(null);

select * from finish();
rollback;
