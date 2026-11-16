-- Churn-save offers: caps, cooldowns, targeting, kill switch, release-on-failure,
-- append-only trail and staff-only admin RPCs (pgTAP). Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

-- ---- fixtures ---------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@test.dev'),
  ('00000000-0000-0000-0000-0000000000a2', 'a2@test.dev'),
  ('00000000-0000-0000-0000-0000000000a3', 'a3@test.dev'),
  ('00000000-0000-0000-0000-0000000000a4', 'a4@test.dev'),
  ('00000000-0000-0000-0000-0000000000b1', 'staff@test.dev');
insert into profiles (id, email, role, is_staff) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@test.dev', 'owner', false),
  ('00000000-0000-0000-0000-0000000000a2', 'a2@test.dev', 'owner', false),
  ('00000000-0000-0000-0000-0000000000a3', 'a3@test.dev', 'owner', false),
  ('00000000-0000-0000-0000-0000000000a4', 'a4@test.dev', 'owner', false),
  ('00000000-0000-0000-0000-0000000000b1', 'staff@test.dev', 'owner', true);

delete from churn_save_events;
delete from churn_save_redemptions;  -- tables are empty on a fresh db; keeps the test re-runnable
-- (offers are never deleted in production; here they are created inside this rolled-back transaction)

insert into churn_save_offers (id, kind, name, enabled, discount_percent, discount_months, max_per_account, cooldown_days, cap_total, cap_window_days)
values ('10000000-0000-0000-0000-000000000001', 'discount', 'T 20% x 3', true, 20, 3, 1, 180, 2, 30);
insert into churn_save_offers (id, kind, name, enabled, pause_months, target_bands, max_per_account, cooldown_days)
values ('10000000-0000-0000-0000-000000000002', 'pause', 'T pause 2m (at-risk only)', true, 2, array['at_risk','critical'], 1, 180);
insert into churn_save_offers (id, kind, name, enabled, downgrade_plan, target_reasons)
values ('10000000-0000-0000-0000-000000000003', 'downgrade', 'T downgrade starter (price only)', true, 'starter', array['too_expensive']);

-- ---- 1. constraints ---------------------------------------------------------
select throws_ok(
  $$insert into churn_save_offers (kind, name, discount_percent, discount_months) values ('discount', 'too generous', 60, 3)$$,
  '23514', null, 'discount above the 50% ceiling is rejected by the database');
select throws_ok(
  $$insert into churn_save_offers (kind, name, discount_percent, discount_months) values ('discount', 'too long', 20, 12)$$,
  '23514', null, 'discount longer than 6 months is rejected');
select throws_ok(
  $$insert into churn_save_offers (kind, name, pause_months) values ('pause', 'too long pause', 6)$$,
  '23514', null, 'pause longer than 3 months is rejected');
select throws_ok(
  $$insert into churn_save_offers (kind, name, pause_months, discount_percent, discount_months) values ('pause', 'mixed terms', 1, 10, 1)$$,
  '23514', null, 'terms of another kind are rejected');

-- ---- 2. per-account cap -----------------------------------------------------
select is((public.churn_save_claim('00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'too_expensive', 'at_risk', 40, 'sub_1')) ->> 'ok', 'true', 'first claim succeeds');
select is(
  (select count(*)::int from churn_save_redemptions where user_id = '00000000-0000-0000-0000-0000000000a1' and status = 'claimed'), 1, 'a claimed row is recorded');
select is((public.churn_save_claim('00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'too_expensive', 'at_risk', 40, 'sub_1')) ->> 'code', 'account_cap', 'second claim on the same offer hits the per-account cap');

-- ---- 3. release on failure --------------------------------------------------
select public.churn_save_finalize((select id from churn_save_redemptions where user_id = '00000000-0000-0000-0000-0000000000a1'), false, 'stripe exploded');
select is((select status from churn_save_redemptions where user_id = '00000000-0000-0000-0000-0000000000a1'), 'failed', 'failed finalize marks the claim failed');
select is((public.churn_save_claim('00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'too_expensive', 'at_risk', 40, 'sub_1')) ->> 'ok', 'true', 'a failed claim releases the allowance');
select public.churn_save_finalize((select id from churn_save_redemptions where user_id = '00000000-0000-0000-0000-0000000000a1' and status = 'claimed'), true, null);
select is((select count(*)::int from churn_save_events where user_id = '00000000-0000-0000-0000-0000000000a1' and event = 'accepted'), 1, 'success writes exactly one accepted event');

-- ---- 4. global cooldown across offers --------------------------------------
select is((public.churn_save_claim('00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000002', 'too_expensive', 'at_risk', 40, 'sub_1')) ->> 'code', 'cooldown', 'a different offer is blocked by the global cooldown');

-- ---- 5. total cap across accounts (cap_total = 2) --------------------------
select is((public.churn_save_claim('00000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-000000000001', 'too_expensive', 'at_risk', 40, 'sub_2')) ->> 'ok', 'true', 'second account takes the 2nd slot of the total cap');
select is((public.churn_save_claim('00000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-000000000001', 'too_expensive', 'at_risk', 40, 'sub_3')) ->> 'code', 'total_cap', 'third account is refused: total cap reached');
select ok(
  not exists (select 1 from public.churn_save_eligible_offers('00000000-0000-0000-0000-0000000000a3', 'too_expensive', 'at_risk') where id = '10000000-0000-0000-0000-000000000001'),
  'an exhausted offer disappears from the eligible list');
select is(
  (select count(*)::int from churn_save_redemptions where offer_id = '10000000-0000-0000-0000-000000000001' and status in ('claimed','applied')), 2, 'cap never exceeded');

-- ---- 6. targeting -----------------------------------------------------------
select is((public.churn_save_claim('00000000-0000-0000-0000-0000000000a4', '10000000-0000-0000-0000-000000000002', 'too_expensive', 'healthy', 90, 'sub_4')) ->> 'code', 'not_targeted', 'band targeting: healthy account cannot take an at-risk-only offer');
select is((public.churn_save_claim('00000000-0000-0000-0000-0000000000a4', '10000000-0000-0000-0000-000000000002', 'too_expensive', null, null, 'sub_4')) ->> 'code', 'not_targeted', 'unknown band never matches a targeted offer');
select is((public.churn_save_claim('00000000-0000-0000-0000-0000000000a4', '10000000-0000-0000-0000-000000000003', 'not_using', 'at_risk', 30, 'sub_4')) ->> 'code', 'not_targeted', 'reason targeting: wrong reason is refused');
select is((public.churn_save_claim('00000000-0000-0000-0000-0000000000a4', '10000000-0000-0000-0000-000000000002', 'not_using', 'critical', 10, 'sub_4')) ->> 'ok', 'true', 'matching band is accepted');

-- ---- 7. window + kill switch ------------------------------------------------
update churn_save_offers set ends_at = now() - interval '1 minute', starts_at = now() - interval '1 day' where id = '10000000-0000-0000-0000-000000000003';
select is((public.churn_save_claim('00000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-000000000003', 'too_expensive', 'at_risk', 30, 'sub_3')) ->> 'code', 'ended', 'an offer past its end date is refused');
select ok(public.churn_save_is_active(), 'system is active while an offer is enabled');
update churn_save_settings set enabled = false;
select ok(not public.churn_save_is_active(), 'kill switch turns the whole system off');
select is((public.churn_save_claim('00000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-000000000001', 'too_expensive', 'at_risk', 40, 'sub_3')) ->> 'code', 'disabled', 'claims are refused while the kill switch is off');
update churn_save_settings set enabled = true;

-- ---- 8. append-only + privileges -------------------------------------------
select throws_ok($$update churn_save_events set reason = 'x'$$, '42501', null, 'churn_save_events cannot be updated');
select throws_ok($$delete from churn_save_events$$, '42501', null, 'churn_save_events cannot be deleted');
select ok(not has_function_privilege('authenticated', 'public.churn_save_claim(uuid,uuid,text,text,integer,text)', 'execute'), 'customers cannot call churn_save_claim');
select ok(not has_function_privilege('anon', 'public.staff_churn_save_overview(integer)', 'execute'), 'anon cannot call the staff overview');

-- ---- 9. staff-only admin RPCs + audit --------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;
select throws_ok($$select public.staff_churn_save_overview(30)$$, '42501', 'forbidden', 'a non-staff user cannot read the overview');
select throws_ok($$select public.staff_churn_save_upsert_offer('{"kind":"pause","name":"hack","pause_months":1}'::jsonb)$$, '42501', 'forbidden', 'a non-staff user cannot create offers');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
set local role authenticated;
select throws_ok($$select public.staff_churn_save_upsert_offer('{"kind":"discount","name":"too generous","discount_percent":75,"discount_months":2}'::jsonb)$$, '22023', 'invalid_offer', 'staff cannot exceed the discount ceiling');
select lives_ok($$select public.staff_churn_save_upsert_offer('{"kind":"pause","name":"Staff pause 1m","pause_months":1,"enabled":true}'::jsonb)$$, 'staff can create an offer');
reset role;
select is((select count(*)::int from churn_save_audit where action = 'offer_created'), 1, 'creation is audited');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
set local role authenticated;
select is(
  (public.staff_churn_save_overview(30) -> 'offers') is not null, true, 'staff can read the overview');
reset role;

select * from finish();
rollback;
