-- Tenant margin alerts + AI ROI inputs (pgTAP).
-- Run with:  supabase test db        (NOT RUN by the author: no Postgres available in the authoring environment)
-- Requires migration 20290304000000 (and everything before it). Impersonation mirrors PostgREST.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'tenant-a@test'),
  ('00000000-0000-0000-0000-0000000000b1', 'tenant-b@test'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@test');
insert into public.profiles (id, is_staff) values ('00000000-0000-0000-0000-0000000000c1', true)
  on conflict (id) do update set is_staff = true;

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user)::text, true);
  set local role authenticated;
end $$;

-- 1-2: alert kind constraint accepts the new kind and still rejects unknown ones
select lives_ok($$insert into public.economics_alerts (kind, severity, dedupe_key) values ('tenant_negative_margin','warning','tnm:test:1')$$, 'new alert kind accepted');
select throws_ok($$insert into public.economics_alerts (kind, severity, dedupe_key) values ('bogus_kind','warning','tnm:test:2')$$, '23514', null, 'unknown alert kind rejected');

-- 3-4: service-only cores are not callable by tenants
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$select * from public.economics_tenant_margin_core(now() - interval '1 day', now())$$, '42501', null, 'tenant cannot call margin core');
select throws_ok($$select public.ai_roi_inputs_core('00000000-0000-0000-0000-0000000000a1', now() - interval '1 day', now())$$, '42501', null, 'tenant cannot call ROI core for another tenant');

-- 5: staff-only wrapper
select throws_ok($$select public.staff_tenant_margin(now() - interval '1 day', now())$$, '42501', null, 'tenant cannot call staff_tenant_margin');
reset role;

-- 6: staff can
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select lives_ok($$select public.staff_tenant_margin(now() - interval '30 days', now())$$, 'staff can call staff_tenant_margin');
reset role;

-- 7-8: tenant ROI is isolated: A's AI-created job is invisible to B
insert into public.jobs (user_id, customer_name, voice_idempotency_key, job_status)
  values ('00000000-0000-0000-0000-0000000000a1', 'Cust A', 'vapi-call-1:tool-1', 'scheduled');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is(jsonb_array_length(public.tenant_ai_roi_inputs(now() - interval '30 days', now()) -> 'ai_jobs'), 0, 'tenant B sees none of tenant A''s AI jobs');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is(jsonb_array_length(public.tenant_ai_roi_inputs(now() - interval '30 days', now()) -> 'ai_jobs'), 1, 'tenant A sees its own AI job');

-- 9: window validation
select throws_ok($$select public.tenant_ai_roi_inputs(now(), now() - interval '1 day')$$, '22023', null, 'invalid window rejected');
select throws_ok($$select public.tenant_ai_roi_inputs(now() - interval '500 days', now())$$, '22023', null, 'window > 400 days rejected');
reset role;

-- 11: anonymous cannot call the customer RPC
set local role anon;
select throws_ok($$select public.tenant_ai_roi_inputs(now() - interval '1 day', now())$$, '42501', null, 'anon cannot call tenant_ai_roi_inputs');
reset role;

select * from finish();
rollback;
