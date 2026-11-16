-- MFA enforcement state (pgTAP). Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e0a1', 'owner@mfa.test'),
  ('00000000-0000-0000-0000-00000000e0a2', 'admin@mfa.test'),
  ('00000000-0000-0000-0000-00000000e0a3', 'tech@mfa.test'),
  ('00000000-0000-0000-0000-00000000e0a4', 'staff@mfa.test');
insert into public.team_members (id, account_owner_id, member_email, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-00000000e0c2', '00000000-0000-0000-0000-00000000e0a1', 'admin@mfa.test', 'admin',
   '00000000-0000-0000-0000-00000000e0a2', 'active', '{}'),
  ('00000000-0000-0000-0000-00000000e0c3', '00000000-0000-0000-0000-00000000e0a1', 'tech@mfa.test', 'technician',
   '00000000-0000-0000-0000-00000000e0a3', 'active', '{}');
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-00000000e0a4';

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- anon cannot call it
select set_config('role', 'anon', true);
select throws_ok($$select public.mfa_enforcement_state()$$, '42501', null, 'anon cannot execute mfa_enforcement_state');
reset role;

-- policy OFF (default): nothing is enforced
select pg_temp.act_as('00000000-0000-0000-0000-00000000e0a1');
select is((public.mfa_enforcement_state()->>'policy_active'), 'false', 'policy is off by default');
select is((public.mfa_enforcement_state()->>'enforced'), 'false', 'nothing enforced while the policy is off');
reset role;

-- policy ON, grace already over
update public.mfa_enforcement_policy set enforce_from = now() - interval '30 days', grace_days = 14, staff_grace_days = 0;

select pg_temp.act_as('00000000-0000-0000-0000-00000000e0a1');
select is((public.mfa_enforcement_state()->>'required'), 'true', 'owner is required to use MFA');
select is((public.mfa_enforcement_state()->>'enforced'), 'true', 'owner without a factor is enforced after grace');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000e0a2');
select is((public.mfa_enforcement_state()->>'required'), 'true', 'admin member is required to use MFA');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000e0a3');
select is((public.mfa_enforcement_state()->>'required'), 'false', 'technician stays opt-in');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000e0a4');
select is((public.mfa_enforcement_state()->>'enforced'), 'true', 'staff has no grace and is enforced');
reset role;

-- inside grace window
update public.mfa_enforcement_policy set enforce_from = now(), grace_days = 14;
select pg_temp.act_as('00000000-0000-0000-0000-00000000e0a1');
select is((public.mfa_enforcement_state()->>'enforced'), 'false', 'owner inside grace is not blocked');
select is((public.mfa_enforcement_state()->>'days_left')::int, 14, 'grace shows 14 days left');
reset role;

-- enrolled owner is never enforced
insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), '00000000-0000-0000-0000-00000000e0a1', 'totp', 'verified', now(), now());
update public.mfa_enforcement_policy set enforce_from = now() - interval '30 days';
select pg_temp.act_as('00000000-0000-0000-0000-00000000e0a1');
select is((public.mfa_enforcement_state()->>'enrolled'), 'true', 'verified factor is detected');

select * from finish();
rollback;
