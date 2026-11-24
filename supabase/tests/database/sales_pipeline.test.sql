-- Sales pipeline + deal desk: tenant isolation, approval levels, self-approval, transitions, discount guard (pgTAP).
-- Run with:  supabase test db
-- NOTE: written against migration 20290306000100_sales_pipeline.sql. Uses no_plan() so the count cannot drift.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'manager@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'rep@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');
insert into public.profiles (id, plan, created_at, is_staff) values
  ('00000000-0000-0000-0000-0000000000a1', 'pro', now() - interval '60 days', false),
  ('00000000-0000-0000-0000-0000000000b1', 'pro', now() - interval '60 days', false)
on conflict (id) do nothing;
insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'manager@acme.test', 'Mia Manager', 'manager',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_edit_business_profile": true}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'rep@acme.test', 'Rex Rep', 'member',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{"can_edit_business_profile": false}');

insert into public.crm_deals (id, user_id, title, amount, currency, status, stage) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Acme HVAC', 1000, 'USD', 'open', 'Proposal'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a1', 'Big Plumbing', 5000, 'USD', 'open', 'Negotiation'),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000a1', 'Small Roofing', 800, 'USD', 'open', 'Qualified'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b1', 'Other Co', 700, 'USD', 'open', 'Proposal');
insert into public.crm_deal_desk_settings (user_id, enabled, auto_approve_max_pct, manager_max_pct) values
  ('00000000-0000-0000-0000-0000000000a1', true, 10, 20);

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
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ---------- structure ----------
select ok((select relrowsecurity from pg_class where oid = 'public.crm_pipeline_stages'::regclass), 'RLS on crm_pipeline_stages');
select ok((select relrowsecurity from pg_class where oid = 'public.crm_deal_desk_settings'::regclass), 'RLS on crm_deal_desk_settings');
select ok((select relrowsecurity from pg_class where oid = 'public.crm_deal_discount_requests'::regclass), 'RLS on crm_deal_discount_requests');
select has_column('public', 'crm_deals', 'discount_pct', 'crm_deals.discount_pct exists');

-- ---------- stages ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$select public.crm_seed_default_pipeline_stages()$$, '42501', null, 'a rep cannot seed stages');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is(public.crm_seed_default_pipeline_stages(), 5, 'a manager seeds 5 default stages');
select is(public.crm_seed_default_pipeline_stages(), 0, 'seeding twice adds nothing (idempotent)');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from public.crm_pipeline_stages), 5, 'a rep can read the stages');
select is((select count(*)::int from public.crm_pipeline_stages where win_probability_pct > 100), 0, 'weights are within range');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.crm_pipeline_stages), 0, 'another tenant sees no stages');
reset role;
select pg_temp.act_as_anon();
select throws_ok($$select * from public.crm_pipeline_stages$$, '42501', null, 'anon has no access to stages');
reset role;

-- ---------- requests: levels ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select lives_ok($$insert into public.crm_deal_discount_requests (deal_id, requested_pct, reason)
  values ('00000000-0000-0000-0000-0000000000d1', 5, 'Within the automatic limit for a pilot')$$, 'rep requests 5%');
select is((select status || '/' || required_level from public.crm_deal_discount_requests where requested_pct = 5), 'approved/auto', '5% is auto-approved');
select lives_ok($$insert into public.crm_deal_discount_requests (deal_id, requested_pct, reason, status, required_level)
  values ('00000000-0000-0000-0000-0000000000d1', 15, 'Competitor quote is lower, multi-site rollout', 'approved', 'auto')$$, 'client-supplied status and level are accepted but overwritten');
select is((select status || '/' || required_level from public.crm_deal_discount_requests where requested_pct = 15), 'pending/manager', '15% is pending at manager level despite the client values');
select is((select requested_by from public.crm_deal_discount_requests where requested_pct = 15), '00000000-0000-0000-0000-0000000000a3'::uuid, 'requester is the caller');
select throws_ok($$insert into public.crm_deal_discount_requests (deal_id, requested_pct, reason)
  values ('00000000-0000-0000-0000-0000000000d1', 18, 'A second open request for the same deal')$$, '23505', null, 'only one pending request per deal');
select throws_ok($$insert into public.crm_deal_discount_requests (deal_id, requested_pct, reason)
  values ('00000000-0000-0000-0000-0000000000d4', 0, 'Zero percent is meaningless here')$$, '23514', null, 'zero percent is rejected');
select throws_ok($$insert into public.crm_deal_discount_requests (deal_id, requested_pct, reason)
  values ('00000000-0000-0000-0000-0000000000d4', 15, 'too short')$$, '23514', null, 'a short reason is rejected');
select throws_ok($$insert into public.crm_deal_discount_requests (deal_id, requested_pct, reason)
  values ('00000000-0000-0000-0000-0000000000d2', 15, 'Deal belongs to another tenant here')$$, '22023', null, 'a deal of another account is not found');
select lives_ok($$insert into public.crm_deal_discount_requests (deal_id, requested_pct, reason)
  values ('00000000-0000-0000-0000-0000000000d3', 25, 'Strategic logo, owner decision needed please')$$, 'rep requests 25%');
select is((select required_level from public.crm_deal_discount_requests where requested_pct = 25), 'owner', '25% needs the owner');

-- ---------- requests: who may decide ----------
select throws_ok($$update public.crm_deal_discount_requests set status = 'approved' where requested_pct = 15$$, '42501', null, 'a rep cannot approve');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select throws_ok($$update public.crm_deal_discount_requests set status = 'approved' where requested_pct = 25$$, '42501', null, 'a manager cannot decide an owner-level request');
select lives_ok($$update public.crm_deal_discount_requests set status = 'approved', decision_note = 'ok for the rollout' where requested_pct = 15$$, 'a manager approves a manager-level request');
select is((select decided_by from public.crm_deal_discount_requests where requested_pct = 15), '00000000-0000-0000-0000-0000000000a2'::uuid, 'decided_by is the approver, set by the server');
select throws_ok($$update public.crm_deal_discount_requests set status = 'rejected', decision_note = 'late' where requested_pct = 15$$, '42501', null, 'a decided request cannot change again');
select throws_ok($$update public.crm_deal_discount_requests set requested_pct = 99 where requested_pct = 15$$, '42501', null, 'requested_pct is immutable');
select throws_ok($$delete from public.crm_deal_discount_requests$$, '42501', null, 'requests cannot be deleted');
reset role;

-- manager cannot approve a request they raised themselves
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select lives_ok($$insert into public.crm_deal_discount_requests (deal_id, requested_pct, reason)
  values ('00000000-0000-0000-0000-0000000000d4', 12, 'Manager raised this one themselves for a pilot')$$, 'manager raises 12%');
select throws_ok($$update public.crm_deal_discount_requests set status = 'approved' where requested_pct = 12$$, '42501', null, 'no self-approval at manager level');
reset role;

-- owner decisions
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$update public.crm_deal_discount_requests set status = 'rejected' where requested_pct = 25$$, '22023', null, 'rejecting needs a note');
select lives_ok($$update public.crm_deal_discount_requests set status = 'approved', decision_note = 'logo account' where requested_pct = 25$$, 'owner approves the owner-level request');
select lives_ok($$update public.crm_deal_discount_requests set status = 'rejected', decision_note = 'not this quarter' where requested_pct = 12$$, 'owner rejects with a note');
reset role;

-- withdraw
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select lives_ok($$insert into public.crm_deal_discount_requests (deal_id, requested_pct, reason)
  values ('00000000-0000-0000-0000-0000000000d4', 14, 'Will withdraw this request right away')$$, 'rep raises 14%');
select lives_ok($$update public.crm_deal_discount_requests set status = 'withdrawn' where requested_pct = 14$$, 'the requester withdraws');
select is((select status from public.crm_deal_discount_requests where requested_pct = 14), 'withdrawn', 'status is withdrawn');
reset role;

-- ---------- discount guard on crm_deals ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select lives_ok($$update public.crm_deals set discount_pct = 8 where id = '00000000-0000-0000-0000-0000000000d1'$$, 'discount within the automatic limit is allowed');
select lives_ok($$update public.crm_deals set discount_pct = 15 where id = '00000000-0000-0000-0000-0000000000d1'$$, 'discount covered by an approved request is allowed');
select throws_ok($$update public.crm_deals set discount_pct = 16 where id = '00000000-0000-0000-0000-0000000000d1'$$, '42501', null, 'discount above the approved ceiling is blocked');
select throws_ok($$update public.crm_deals set discount_pct = 11 where id = '00000000-0000-0000-0000-0000000000d4'$$, '42501', null, 'discount above the automatic limit without approval is blocked');
select lives_ok($$update public.crm_deals set discount_pct = 3 where id = '00000000-0000-0000-0000-0000000000d1'$$, 'lowering a discount is always allowed');
select lives_ok($$update public.crm_deals set stage = 'Negotiation' where id = '00000000-0000-0000-0000-0000000000d1'$$, 'other deal edits are unaffected');
reset role;

-- ---------- settings ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select lives_ok($$update public.crm_deal_desk_settings set auto_approve_max_pct = 90$$, 'a manager update is filtered by RLS without an error');
select is((select auto_approve_max_pct from public.crm_deal_desk_settings), 10::numeric, 'a manager cannot change the policy');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$update public.crm_deal_desk_settings set manager_max_pct = 5$$, '23514', null, 'manager limit below the automatic limit is rejected');
reset role;

-- ---------- tenant isolation + disabled desk ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.crm_deal_discount_requests), 0, 'another tenant sees no requests');
select is((select count(*)::int from public.crm_deal_desk_settings), 0, 'another tenant sees no policy');
select throws_ok($$insert into public.crm_deal_discount_requests (deal_id, requested_pct, reason)
  values ('00000000-0000-0000-0000-0000000000d2', 15, 'Desk is not enabled for this account')$$, '22023', null, 'requests are refused while the desk is off');
reset role;

-- ---------- service role (CRM sync) is not blocked ----------
-- clear the JWT claims left over from act_as(), so auth.uid() is null like in the service role
select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
select lives_ok($$update public.crm_deals set discount_pct = 50 where id = '00000000-0000-0000-0000-0000000000d3'$$, 'no end user (service role) bypasses the discount guard on an account with the desk enabled');
select is((select discount_pct from public.crm_deals where id = '00000000-0000-0000-0000-0000000000d3'), 50::numeric, 'the service-role update was applied');

select * from finish();
rollback;
