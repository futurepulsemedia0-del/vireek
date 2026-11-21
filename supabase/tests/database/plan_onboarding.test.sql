-- Plan-selection step: owner-only, forgery resistance, tenant isolation, resume, skip policy, reminder consent (pgTAP).
-- Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@plan.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'other@plan.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'member@plan.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'paid@plan.test');
insert into public.profiles (id, email, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@plan.test', 'owner'),
  ('00000000-0000-0000-0000-0000000000b1', 'other@plan.test', 'owner'),
  ('00000000-0000-0000-0000-0000000000c1', 'member@plan.test', 'member'),
  ('00000000-0000-0000-0000-0000000000d1', 'paid@plan.test', 'owner');
update public.profiles set stripe_subscription_id = 'sub_test_1' where id = '00000000-0000-0000-0000-0000000000d1';

-- ---- owner ------------------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

select is((public.plan_onboarding_state() ->> 'can_use_step')::boolean, true, 'new owner can use the step');
select is((public.plan_onboarding_state() ->> 'should_prompt')::boolean, true, 'new owner is prompted by the gate');
select is(public.plan_onboarding_state() #>> '{policy,trial_mode}', 'card_required', 'default policy mirrors the repo (card-required trial)');

select lives_ok($$select public.save_plan_intent('professional','annual','pricing_page','plan','{"monthly_calls":120,"technicians":99999,"locations":"x","evil":1}'::jsonb,true)$$, 'owner saves a plan intent');
select is(public.plan_onboarding_state() ->> 'plan', 'professional', 'intent resumes (plan)');
select is(public.plan_onboarding_state() ->> 'billing', 'annual', 'intent resumes (billing)');
select is(public.plan_onboarding_state() -> 'size_answers', '{"monthly_calls":120,"technicians":10000}'::jsonb, 'answers are clamped and unknown/garbage keys dropped');
select is((public.plan_onboarding_state() ->> 'reminder_consent')::boolean, true, 'reminder consent stored only when given');

select throws_ok($$select public.save_plan_intent('free','monthly','x','plan')$$, '22023', 'invalid_plan', 'free is not a selectable plan');
select throws_ok($$select public.save_plan_intent('starter','weekly','x','plan')$$, '22023', 'invalid_billing', 'billing is whitelisted');
select throws_ok($$select public.save_plan_intent('starter','monthly','x','checkout')$$, '22023', 'invalid_step', 'client cannot forge the server-only checkout step');
select throws_ok($$select public.save_plan_intent('starter','monthly','x','done')$$, '22023', 'invalid_step', 'client cannot mark the step done');
select throws_ok($$select count(*) from public.plan_onboarding$$, '42501', null, 'no direct table access for clients');

select lives_ok($$select public.skip_plan_step()$$, 'skip for now is allowed by default');
select is((public.plan_onboarding_state() ->> 'show_resume')::boolean, true, 'skipped owner gets the resume banner');

-- ---- another tenant sees nothing of the owner's intent ----------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
select is(public.plan_onboarding_state() ->> 'plan', null, 'cross-tenant: other owner has no intent');

-- ---- team member and subscriber skip the step -------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
select is((public.plan_onboarding_state() ->> 'can_use_step')::boolean, false, 'non-owner cannot use the step');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
select throws_ok($$select public.save_plan_intent('starter','monthly','x','plan')$$, '42501', 'not_eligible', 'existing subscriber cannot start a second plan intent');

-- ---- policy switch: skip disabled -------------------------------------------------------------------------------
reset role;
update public.plan_onboarding_config set allow_skip = false where id;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
select throws_ok($$select public.skip_plan_step()$$, '42501', 'skip_not_allowed', 'skip honours the config');

-- ---- reminders: service role only, consent + idle delay -----------------------------------------------------------
select throws_ok($$select * from public.plan_onboarding_reminder_candidates(10)$$, '42501', null, 'clients cannot list reminder candidates');
reset role;
update public.plan_onboarding set updated_at = now() - interval '3 days' where user_id = '00000000-0000-0000-0000-0000000000a1';
select is((select count(*)::int from public.plan_onboarding_reminder_candidates(10) where user_id = '00000000-0000-0000-0000-0000000000a1'), 1, 'consenting, idle, unsubscribed owner is a candidate');

select * from finish();
rollback;
