-- Fairness audit: staff-only access, aggregation correctness, no PII in the payload (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'staff@vireek.test'),
  ('00000000-0000-0000-0000-0000000000f2', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000f3', 'owner@beta.test');
insert into public.profiles (id, role, is_staff) values
  ('00000000-0000-0000-0000-0000000000f1', 'owner', true),
  ('00000000-0000-0000-0000-0000000000f2', 'owner', false),
  ('00000000-0000-0000-0000-0000000000f3', 'owner', false)
on conflict (id) do update set is_staff = excluded.is_staff;

insert into public.customers (id, user_id, name, customer_type) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f2', 'Secret Name', 'commercial');

-- call 1: es, +44, commercial customer, scored 70, critical finding
-- call 2: es, +44, no customer, scored 90
-- call 3: no language, non-E.164 number, review failed (not scored)
insert into public.calls (id, user_id, caller_phone, caller_name, call_datetime, detected_language, customer_id) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f2', '+44 20 7946 0000', 'Secret Caller', now(), 'es-MX', '00000000-0000-0000-0000-0000000000d1'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f3', '+442079460001', null, now(), 'ES', null),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000f2', '5550100', null, now(), null, null);
insert into public.ai_quality_reviews (id, user_id, call_id, call_at, overall_score, ai_status) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000c1', now(), 70, 'ok'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000c2', now(), 90, 'ok'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000c3', now(), null, 'failed');
insert into public.ai_quality_findings (user_id, review_id, call_id, kind, severity, title, fingerprint) values
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'missed_booking', 'critical', 'x', 'fp1');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- 1-2. Non-staff users are refused; so is anon at the privilege level.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f2');
select throws_ok($$select public.staff_fairness_overview(30, 60)$$, '42501', 'forbidden', 'tenant owner cannot call it');
reset role;
select ok(not has_function_privilege('anon', 'public.staff_fairness_overview(integer, integer)', 'execute'), 'anon has no EXECUTE');

-- 3-9. Staff: aggregation, normalisation, and no PII.
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
create temp table _r on commit drop as select public.staff_fairness_overview(30, 60) as j;
grant select on _r to authenticated;

select is((select (j->>'days')::int from _r), 30, 'window echoed');
select is(
  (select (c->>'calls')::int from _r, jsonb_array_elements(j->'cells') c where c->>'dimension' = 'language' and c->>'group' = 'es'),
  2, 'es-MX and ES collapse to one language group');
select is(
  (select (c->>'accounts')::int from _r, jsonb_array_elements(j->'cells') c where c->>'dimension' = 'language' and c->>'group' = 'es'),
  2, 'distinct accounts are counted per group');
select is(
  (select c->>'group' from _r, jsonb_array_elements(j->'cells') c where c->>'dimension' = 'region' and c->>'group' = '442'),
  '442', 'region is only the calling-code prefix');
select is(
  (select (c->>'score_sum')::int from _r, jsonb_array_elements(j->'cells') c where c->>'dimension' = 'customer_type' and c->>'group' = 'commercial'),
  70, 'customer type joins through the call''s own tenant');
select ok(
  (select position('Secret' in j::text) = 0 and position('7946' in j::text) = 0 and position('call_id' in j::text) = 0 from _r),
  'payload contains no names, phone digits beyond the prefix, or call ids');
select is(
  (select (c->>'reviewed')::int from _r, jsonb_array_elements(j->'cells') c where c->>'dimension' = 'language' and c->>'group' = 'undetected'),
  0, 'failed reviews are counted as calls but not as reviewed');

select * from finish();
rollback;
