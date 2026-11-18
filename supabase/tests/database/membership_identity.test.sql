-- Membership identity (pgTAP). Run: supabase test db
-- Covers: pending invite, deactivated member, email change, re-registration of a freed email,
-- direct-write guard, audited deactivate/reactivate, accept on a deactivated row, and the "no legacy
-- email-matched helper/policy is left" ratchet.
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

-- ---- fixtures -------------------------------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000a0001', 'owner@mid.test',   now()),
  ('00000000-0000-0000-0000-0000000a0002', 'admin@mid.test',   now()),   -- active admin (accepted)
  ('00000000-0000-0000-0000-0000000a0003', 'pending@mid.test', now()),   -- signed up with an invited email, never accepted
  ('00000000-0000-0000-0000-0000000a0004', 'gone@mid.test',    now()),   -- will be deactivated
  ('00000000-0000-0000-0000-0000000a0005', 'mover@mid.test',   now()),   -- will change email
  ('00000000-0000-0000-0000-0000000a0006', 'invitee@mid.test', now()),   -- invitee of a deactivated row
  ('00000000-0000-0000-0000-0000000a0007', 'outsider@mid.test', now());  -- unrelated user

update public.profiles set role = 'owner',  onboarding_completed = true where id = '00000000-0000-0000-0000-0000000a0001';
update public.profiles set role = 'member', onboarding_completed = true
 where id in ('00000000-0000-0000-0000-0000000a0002','00000000-0000-0000-0000-0000000a0004','00000000-0000-0000-0000-0000000a0005');

insert into public.team_members (id, account_owner_id, member_email, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-0000000a0001', 'admin@mid.test',  'admin', '00000000-0000-0000-0000-0000000a0002', 'active', '{}'),
  ('00000000-0000-0000-0000-0000000c0004', '00000000-0000-0000-0000-0000000a0001', 'gone@mid.test',   'admin', '00000000-0000-0000-0000-0000000a0004', 'active', '{}'),
  ('00000000-0000-0000-0000-0000000c0005', '00000000-0000-0000-0000-0000000a0001', 'mover@mid.test',  'admin', '00000000-0000-0000-0000-0000000a0005', 'active', '{}');
-- pending invite: same email as an existing, already signed-up user; user_id is NULL until accept_team_invite runs
insert into public.team_members (id, account_owner_id, member_email, role, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000c0003', '00000000-0000-0000-0000-0000000a0001', 'pending@mid.test', 'admin', 'pending', '{}');
-- invite whose row is already deactivated
insert into public.team_members (id, account_owner_id, member_email, role, invite_status, invite_token, deactivated_at, permissions) values
  ('00000000-0000-0000-0000-0000000c0006', '00000000-0000-0000-0000-0000000a0001', 'invitee@mid.test', 'admin', 'pending',
   '00000000-0000-0000-0000-0000000f0006', now(), '{}');

create or replace function pg_temp.act_as(p_user uuid, p_email text default null) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'email', p_email)::text, true);
end $$;

-- ---- 1. predicate ---------------------------------------------------------------------------------------------
select is(public.team_member_is_live('active', null), true,  'active + not deactivated is live');
select is(public.team_member_is_live('accepted', null), true, 'accepted is accepted as a synonym of active');
select is(public.team_member_is_live('pending', null), false, 'pending is not live');
select is(public.team_member_is_live('active', now()), false, 'deactivated is not live even when status is active');
select is(public.team_member_is_live(null, null), false,      'NULL status is not live');

-- ---- 2. pending invite never grants membership ----------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000a0003', 'pending@mid.test');
select is(public.get_account_owner_id(), '00000000-0000-0000-0000-0000000a0003'::uuid,
          'pending invitee resolves to their own workspace, not the inviting account');
select is((select count(*)::int from public.team_members), 1,
          'pending invitee can see only their own pending invite row, nothing else of the account');
reset role;

-- ---- 3. accepted member resolves to the owner ------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000a0002', 'admin@mid.test');
select is(public.get_account_owner_id(), '00000000-0000-0000-0000-0000000a0001'::uuid, 'accepted member resolves to the account owner');
select is(public.get_my_team_member_id(), '00000000-0000-0000-0000-0000000c0002'::uuid, 'get_my_team_member_id returns the live row');
select is(public.is_live_team_member('00000000-0000-0000-0000-0000000a0001'), true, 'is_live_team_member(owner) is true for the member');
reset role;

-- ---- 4. deactivated member -----------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000a0001', 'owner@mid.test');
select is((public.team_member_set_active('00000000-0000-0000-0000-0000000c0004', false)->>'success')::boolean, true, 'owner can deactivate a member');
reset role;
select is((select deactivated_at is not null from public.team_members where id = '00000000-0000-0000-0000-0000000c0004'), true, 'deactivated_at is set');
select is((select user_id from public.team_members where id = '00000000-0000-0000-0000-0000000c0004'), null::uuid, 'deactivation moves user_id out of the row (liveness invariant)');
select is((select former_user_id from public.team_members where id = '00000000-0000-0000-0000-0000000c0004'), '00000000-0000-0000-0000-0000000a0004'::uuid, 'former_user_id keeps the identity for reactivation');
select is((select count(*)::int from public.audit_log where user_id = '00000000-0000-0000-0000-0000000a0001' and action = 'team_member_deactivated'), 1, 'deactivation is audited');

select pg_temp.act_as('00000000-0000-0000-0000-0000000a0004', 'gone@mid.test');
select is(public.get_account_owner_id(), '00000000-0000-0000-0000-0000000a0004'::uuid, 'deactivated member no longer resolves to the former employer');
select is(public.is_live_team_member(), false, 'deactivated member is not a live team member');
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000a0001', 'owner@mid.test');
select is((public.team_member_set_active('00000000-0000-0000-0000-0000000c0004', true)->>'success')::boolean, true, 'owner can reactivate');
reset role;
select is((select user_id from public.team_members where id = '00000000-0000-0000-0000-0000000c0004'), '00000000-0000-0000-0000-0000000a0004'::uuid, 'reactivation restores user_id');

-- ---- 5. email change -----------------------------------------------------------------------------------------
update auth.users set email = 'mover.new@mid.test' where id = '00000000-0000-0000-0000-0000000a0005';
select is((select member_email from public.team_members where id = '00000000-0000-0000-0000-0000000c0005'), 'mover.new@mid.test', 'member_email follows the auth email (bookkeeping)');
select pg_temp.act_as('00000000-0000-0000-0000-0000000a0005', 'mover.new@mid.test');
select is(public.get_account_owner_id(), '00000000-0000-0000-0000-0000000a0001'::uuid, 'access survives an email change (identity is user_id)');
select is(public.can_manage_service_areas(), true, 'a rewritten helper also survives the email change');
reset role;

-- a freed email cannot be used to inherit access: user 0007 takes over the OLD address of a removed member
update public.team_members set invite_status = 'removed' where id = '00000000-0000-0000-0000-0000000c0002';
update auth.users set email = 'admin@mid.test.old' where id = '00000000-0000-0000-0000-0000000a0002';
update auth.users set email = 'admin@mid.test' where id = '00000000-0000-0000-0000-0000000a0007';
select pg_temp.act_as('00000000-0000-0000-0000-0000000a0007', 'admin@mid.test');
select is(public.get_account_owner_id(), '00000000-0000-0000-0000-0000000a0007'::uuid, 'new owner of a removed member''s old email gets no access');
select is((select count(*)::int from public.team_members where account_owner_id = '00000000-0000-0000-0000-0000000a0001'), 0, 'and cannot read the former account''s team rows');
reset role;

-- ---- 6. clients cannot assign identity or deactivation directly ------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000a0001', 'owner@mid.test');
select throws_ok($$update public.team_members set user_id = '00000000-0000-0000-0000-0000000a0007' where id = '00000000-0000-0000-0000-0000000c0003'$$,
                 '42501', null, 'owner cannot point a team row at an arbitrary user id');
select throws_ok($$insert into public.team_members (account_owner_id, member_email, user_id) values ('00000000-0000-0000-0000-0000000a0001','x@mid.test','00000000-0000-0000-0000-0000000a0007')$$,
                 '42501', null, 'owner cannot insert a row that already carries a user_id');
select throws_ok($$update public.team_members set deactivated_at = now() where id = '00000000-0000-0000-0000-0000000c0005'$$,
                 '42501', null, 'deactivation only through team_member_set_active');
select is((public.team_member_set_active('00000000-0000-0000-0000-0000000c0005', false) is not null), true, 'RPC path is allowed');
reset role;

-- ---- 7. accept_team_invite refuses a deactivated row -----------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000a0006', 'invitee@mid.test');
select is(public.accept_team_invite('00000000-0000-0000-0000-0000000f0006')->>'error', 'deactivated', 'accept_team_invite refuses a deactivated row');
reset role;

-- ---- 8. ratchet: no function or policy still matches team_members by email --------------------------------------
select is_empty($$
  select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
     and p.prosrc ~* '(member_email\s*=\s*\(\s*SELECT\s+(\w+\.)?email\s+FROM\s+auth\.users)|(lower\(\s*(\w+\.)?member_email\s*\)\s*=\s*lower\(\s*(COALESCE\(\s*)?(\(\s*SELECT\s+(\w+\.)?email\s+FROM\s+auth\.users|auth\.jwt\(\)))'
$$, 'no function still compares team_members.member_email to the caller''s auth email');
select is_empty($$
  select policyname || ' on ' || tablename from pg_policies
   where schemaname = 'public' and tablename <> 'team_members'
     and (coalesce(qual,'') || ' ' || coalesce(with_check,'')) ~* 'member_email'
     and (coalesce(qual,'') || ' ' || coalesce(with_check,'')) ~* '(auth\.users|auth\.jwt)'
$$, 'no RLS policy still compares member_email to the caller''s auth email');

select * from finish();
rollback;
