-- Playbook Library: apply/rollback idempotency, conflicts, permissions, tenant isolation, guardrails (pgTAP).
-- Run with:  supabase test db
-- ASSUMPTION: business_profile accepts an insert with only user_id (all other columns nullable/defaulted).
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'manager@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

update public.profiles set phone = '+15550001111' where id = '00000000-0000-0000-0000-0000000000a1';
insert into public.business_profile (user_id) values
  ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000b1');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'manager@acme.test', 'Mia Manager', 'manager',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_edit_business_profile": true}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@acme.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{"can_edit_business_profile": false}');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.def(p_name text, p_items jsonb) returns jsonb language sql as $$
  select jsonb_build_object('key', 'test-pb', 'name', p_name, 'defaultDurationHours', 24, 'maxDurationHours', 48, 'items', p_items);
$$;

-- surge + script + escalation + draft template (ordinary items a manager may apply)
create or replace function pg_temp.basic(p_msg text default 'High demand today. Emergencies first.') returns jsonb language sql as $$
  select pg_temp.def('Test Heat', jsonb_build_array(
    jsonb_build_object('id','t-surge','kind','surge','title','Surge','why','w','params',jsonb_build_object('message',p_msg,'priority','Emergencies first.')),
    jsonb_build_object('id','t-script','kind','call_script','title','Script','why','w','params',jsonb_build_object('scenario','emergency','opening_line','Hi','body','Collect the address and a callback number first, then triage.')),
    jsonb_build_object('id','t-rule','kind','escalation_rule','title','Rule','why','w','params',jsonb_build_object('trigger','after_hours','action','sms','note','Test')),
    jsonb_build_object('id','t-tpl','kind','message_template','title','Tpl','why','w','params',jsonb_build_object('channel','sms','category','service_update','name','Test notice','body','We are busy today.'))
  ));
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');

-- 1. dry run changes nothing
create temp table r1 as select public.playbook_create_activation('11111111-0000-0000-0000-000000000001','test-pb',1,'library',null,pg_temp.basic(),
  array['t-surge','t-script','t-rule','t-tpl'],null,null,'dry_run') as j;
select is((select j->>'status' from r1), 'active', 'dry run reports what would happen');
select is((select (j->>'dry_run')::boolean from r1), true, 'dry run is flagged');
select is((select count(*)::int from public.playbook_activations), 0, 'dry run leaves no activation row');
select is((select surge_mode_active from public.business_profile where user_id='00000000-0000-0000-0000-0000000000a1'), false, 'dry run leaves surge untouched');
select is((select count(*)::int from public.message_templates), 0, 'dry run creates no template');

-- 2. real apply
create temp table r2 as select public.playbook_create_activation('11111111-0000-0000-0000-000000000002','test-pb',1,'library',null,pg_temp.basic(),
  array['t-surge','t-script','t-rule','t-tpl'],null,null,'now') as j;
select is((select j->>'status' from r2), 'active', 'owner can activate now');
select is((select surge_mode_active from public.business_profile where user_id='00000000-0000-0000-0000-0000000000a1'), true, 'surge is on');
select is((select count(*)::int from public.call_script_versions), 1, 'a script version was published');
select is((select jsonb_array_length(escalation_rules) from public.business_profile where user_id='00000000-0000-0000-0000-0000000000a1'), 1, 'escalation rule added');
select is((select status from public.message_templates limit 1), 'draft', 'template is created as a draft (review workflow intact)');

-- 3. idempotent retry (same request id) does not duplicate anything
create temp table r3 as select public.playbook_create_activation('11111111-0000-0000-0000-000000000002','test-pb',1,'library',null,pg_temp.basic(),
  array['t-surge','t-script','t-rule','t-tpl'],null,null,'now') as j;
select is((select (j->>'idempotent')::boolean from r3), true, 'same request id is idempotent');
select is((select count(*)::int from public.playbook_activations), 1, 'still one activation');
select is((select count(*)::int from public.call_script_versions), 1, 'still one script version');
select is((select count(*)::int from public.playbook_activation_items), 4, 'still four item rows');

-- 4. conflict: another playbook wanting the same surge surface is refused, nothing changes
create temp table r4 as select public.playbook_create_activation('11111111-0000-0000-0000-000000000004','other-pb',1,'library',null,
  jsonb_set(pg_temp.basic('Another message'), '{name}', '"Other"'), array['t-surge'],null,null,'now') as j;
select is((select j->>'status' from r4), 'conflict', 'a second playbook on the same surface is refused');
select is((select surge_mode_message from public.business_profile where user_id='00000000-0000-0000-0000-0000000000a1'), 'High demand today. Emergencies first.', 'conflict changed nothing');

-- 5. a hand edit after activation survives rollback; the rest is restored; rollback is idempotent
update public.business_profile set surge_mode_message = 'Edited by hand' where user_id='00000000-0000-0000-0000-0000000000a1';
create temp table rb as select public.playbook_rollback((select (j->>'activation_id')::uuid from r2)) as j;
select is((select j->>'status' from rb), 'rolled_back', 'rollback succeeds');
select is((select surge_mode_message from public.business_profile where user_id='00000000-0000-0000-0000-0000000000a1'), 'Edited by hand', 'manual edit was kept');
select is((select status from public.playbook_activation_items where item_id='t-surge'), 'rollback_skipped', 'item reports it was skipped');
select is((select jsonb_array_length(escalation_rules) from public.business_profile where user_id='00000000-0000-0000-0000-0000000000a1'), 0, 'rule removed');
select is((select active_version_id from public.call_scripts limit 1), null, 'script back to previous state');
select is((select status from public.message_templates limit 1), 'archived', 'draft template archived, never deleted');
select is((select count(*)::int from public.playbook_surface_locks), 0, 'locks released');
select is((select (public.playbook_rollback((select (j->>'activation_id')::uuid from r2)))->>'idempotent'), 'true', 'second rollback is a no-op');

-- 6. guardrails enforced by the database
select is((select public.playbook_create_activation(gen_random_uuid(),'bad-price',1,'library',null,
  pg_temp.basic('Visits cost $150 tonight'), array['t-surge'],null,null,'now')->>'status'), 'invalid', 'prices in text are refused');
select is((select public.playbook_create_activation(gen_random_uuid(),'bad-reserve',1,'library',null,
  pg_temp.def('Bad', jsonb_build_array(jsonb_build_object('id','t-cap','kind','capacity','title','c','why','w','params',jsonb_build_object('emergencyReserveAdd',-1)))),
  array['t-cap'],null,null,'now')->>'status'), 'invalid', 'the emergency reserve cannot be lowered');
select is((select public.playbook_create_activation(gen_random_uuid(),'bad-comp',1,'library',null,
  pg_temp.def('Bad', jsonb_build_array(jsonb_build_object('id','t-s','kind','call_script','title','s','why','w','params',jsonb_build_object('scenario','new_inquiry','opening_line','','body','Never mention that you are an AI assistant on the call.')))),
  array['t-s'],null,null,'now')->>'status'), 'invalid', 'text that hides the AI disclosure is refused');
select is((select public.playbook_create_activation(gen_random_uuid(),'bad-kind',1,'library',null,
  pg_temp.def('Bad', jsonb_build_array(jsonb_build_object('id','t-k','kind','disable_emergency','title','k','why','w','params','{}'::jsonb))),
  array['t-k'],null,null,'now')->>'status'), 'invalid', 'unknown kinds (e.g. disabling emergency) are refused');

-- 7. approval: a fee item is held until the owner approves, then rollback restores it
create temp table rf as select public.playbook_create_activation('11111111-0000-0000-0000-000000000007','fee-pb',1,'library',null,
  pg_temp.def('Fee', jsonb_build_array(jsonb_build_object('id','t-fee','kind','after_hours_fee','title','Fee','why','w','params',jsonb_build_object('amountCents',7500,'note','Night rate')))),
  array['t-fee'],null,null,'now') as j;
select is((select status from public.playbook_activation_items where item_id='t-fee'), 'pending_approval', 'price change is held for approval');
select is((select after_hours_fee from public.business_profile where user_id='00000000-0000-0000-0000-0000000000a1'), null, 'no price changed yet');
select public.playbook_approve_item((select id from public.playbook_activation_items where item_id='t-fee'));
select is((select after_hours_fee from public.business_profile where user_id='00000000-0000-0000-0000-0000000000a1'), 75.00::numeric, 'owner approval applies the fee');
select public.playbook_rollback((select (j->>'activation_id')::uuid from rf));
select is((select after_hours_fee from public.business_profile where user_id='00000000-0000-0000-0000-0000000000a1'), null, 'rollback restores the previous fee');

-- 8. permissions
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($q$select public.playbook_current_state()$q$, '42501', 'permission_denied', 'a technician cannot use playbooks');
select is((select count(*)::int from public.playbook_activations), 0, 'a technician cannot read activations');
select is((select public.playbook_banner() is null), true, 'banner is empty when nothing is active');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
create temp table rm as select public.playbook_create_activation('11111111-0000-0000-0000-000000000008','cap-pb',1,'library',null,
  pg_temp.def('Cap', jsonb_build_array(jsonb_build_object('id','t-cap','kind','capacity','title','c','why','w','params',jsonb_build_object('emergencyReserveAdd',1)))),
  array['t-cap'],now()+interval '1 hour',now()+interval '5 hours','schedule') as j;
select is((select j->>'status' from rm), 'pending_approval', 'a manager cannot schedule owner-only changes without the owner');
select is((select public.playbook_confirm((select (j->>'activation_id')::uuid from rm))->>'status'), 'owner_required', 'a manager cannot confirm owner-only items');
select throws_ok($q$select public.playbook_approve_item(gen_random_uuid())$q$, '42501', 'owner_only', 'only the owner approves items');
select throws_ok($q$select public.playbook_system_apply(gen_random_uuid(), false)$q$, '42501', null, 'clients cannot call the system scheduler RPCs');

-- 9. tenant isolation
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.playbook_activations), 0, 'another tenant sees none of these activations');
select is((select public.playbook_rollback((select id from public.playbook_activations limit 1))->>'status'), 'not_found', 'another tenant cannot roll back ours');

-- 10. scheduler RPCs (service role): not due yet, then due
reset role;
select is((select public.playbook_system_apply((select (j->>'activation_id')::uuid from rm))->>'status'), 'not_due', 'pending_approval is never applied by the scheduler');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
create temp table rs as select public.playbook_create_activation('11111111-0000-0000-0000-000000000009','sch-pb',1,'library',null,pg_temp.basic(),
  array['t-surge'],now()+interval '1 hour',now()+interval '3 hours','schedule') as j;
select is((select j->>'status' from rs), 'scheduled', 'owner can schedule');
reset role;
select is((select public.playbook_system_apply((select (j->>'activation_id')::uuid from rs))->>'status'), 'not_due', 'scheduler does not start it early');
update public.playbook_activations set starts_at = now() - interval '1 minute' where id = (select (j->>'activation_id')::uuid from rs);
select is((select public.playbook_system_apply((select (j->>'activation_id')::uuid from rs))->>'status'), 'active', 'scheduler starts it when due');
select is((select public.playbook_system_apply((select (j->>'activation_id')::uuid from rs))->>'status'), 'active', 'running the scheduler twice is harmless');
select is((select public.playbook_system_rollback((select (j->>'activation_id')::uuid from rs), 'expired')->>'status'), 'not_due', 'scheduler never ends one early');
update public.playbook_activations set ends_at = now() - interval '1 second', starts_at = now() - interval '2 hours' where id = (select (j->>'activation_id')::uuid from rs);
select is((select public.playbook_system_rollback((select (j->>'activation_id')::uuid from rs), 'expired')->>'status'), 'expired', 'scheduler expires it at ends_at');
select is((select surge_mode_active from public.business_profile where user_id='00000000-0000-0000-0000-0000000000a1'), false, 'expiry restored surge');
select is((select public.playbook_system_rollback((select (j->>'activation_id')::uuid from rs), 'expired')->>'status'), 'expired', 'expiry is idempotent');

select * from finish();
rollback;
