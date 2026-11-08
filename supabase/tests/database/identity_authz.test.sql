-- Identity & authorization foundation: RLS / RPC tests (pgTAP).
-- Run with:  supabase test db
-- STATUS: written but NOT executed when authored (no Postgres available). Treat first run as the real review.
begin;
create extension if not exists pgtap with schema extensions;
select plan(62);

-- ---------------------------------------------------------------- fixtures --
-- O owner, M manager (admin, no billing perm), T tech (requester), U another tech,
-- X = owner of ANOTHER account, S = vireek staff, G = external guest.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'manager@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@acme.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'tech2@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'staff@vireek.test'),
  ('00000000-0000-0000-0000-0000000000e1', 'gc@example.com');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'manager@acme.test', 'Mia Manager', 'admin',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_manage_security": true, "can_view_audit_log": true}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@acme.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{}'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1', 'tech2@acme.test', 'Tina Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a4', 'active', '{}');

update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-0000000000d1';

create or replace function pg_temp.act_as(p_user uuid, p_email text default null, p_aal text default 'aal1', p_fresh boolean default false) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_user, 'role', 'authenticated', 'email', p_email, 'aal', p_aal,
    'amr', json_build_array(json_build_object('method', 'password',
      'timestamp', (extract(epoch from now())::bigint - case when p_fresh then 10 else 86400 end))))::text, true);
end $$;

-- ------------------------------------------------------------ approvals ----
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$
  insert into public.authz_approval_policies (tenant_id, name, subject_type, steps, require_reason)
  values ('00000000-0000-0000-0000-0000000000a1', 'Refunds', 'refund',
    '[{"id":"s1","label":"Manager","mode":"any","approvers":["00000000-0000-0000-0000-0000000000a2","00000000-0000-0000-0000-0000000000a3"]}]'::jsonb, false)
$$, 'owner can create an approval policy');
select throws_ok($$
  insert into public.authz_approval_policies (tenant_id, name, subject_type, steps)
  values ('00000000-0000-0000-0000-0000000000a1', 'Bad', 'refund', '[{"id":"s1","mode":"all","approvers":[]}]'::jsonb)
$$, '23514', null, 'a policy with an empty approver list is rejected');
select lives_ok($$
  insert into public.authz_approval_policies (tenant_id, name, subject_type, steps)
  values ('00000000-0000-0000-0000-0000000000a1', 'Discounts', 'discount',
    '[{"id":"s1","label":"Manager","mode":"any","approvers":["00000000-0000-0000-0000-0000000000a2"]}]'::jsonb)
$$, 'owner can create a second policy');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$
  insert into public.authz_approval_policies (tenant_id, name, subject_type, steps)
  values ('00000000-0000-0000-0000-0000000000a1', 'Sneaky', 'refund',
    '[{"id":"s1","mode":"any","approvers":["00000000-0000-0000-0000-0000000000a3"]}]'::jsonb)
$$, '42501', null, 'a technician cannot write approval policies');
select set_config('t.req', public.authz_create_approval('refund', 'r-1', 20000, 'low')::text, true);
select ok(current_setting('t.req')::uuid is not null, 'a member can create a request that matches a policy');
select throws_ok($$ select public.authz_decide_approval(current_setting('t.req')::uuid, 'approve') $$, '42501', 'authz: self_approval_forbidden',
  'the requester cannot approve, even though listed as an approver');
select throws_ok($$ select public.authz_create_approval('nonexistent', 'x', 1, 'low') $$, 'P0002', 'authz: no_policy', 'no matching policy raises no_policy');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$ select public.authz_decide_approval(current_setting('t.req')::uuid, 'approve') $$, '42501', 'authz: not_an_approver',
  'a non-approver cannot decide');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$ select public.authz_decide_approval(current_setting('t.req')::uuid, 'approve') $$, 'P0002', 'authz: not_found',
  'another tenant gets not_found (no existence oracle)');
select is((select count(*) from public.authz_approval_requests)::int, 0, 'another tenant sees no requests');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is(public.authz_decide_approval(current_setting('t.req')::uuid, 'approve'), 'approved', 'the manager approves a single-step any-chain');
select throws_ok($$ select public.authz_decide_approval(current_setting('t.req')::uuid, 'approve') $$, '55000', 'authz: not_pending',
  'a completed request cannot be decided again');
select throws_ok($$ insert into public.authz_approval_requests (tenant_id, subject_type, subject_id, risk, requester_id, require_reason, require_signature, steps)
  values ('00000000-0000-0000-0000-0000000000a1', 'refund', 'x', 'low', '00000000-0000-0000-0000-0000000000a2', false, false,
  '[{"id":"s1","mode":"any","approvers":["00000000-0000-0000-0000-0000000000a2"]}]'::jsonb) $$, '42501', null,
  'requests cannot be inserted directly, only through the function');

-- delegation: manager delegates to U; U approves a discount request made by T
select throws_ok($$ select public.authz_create_delegation('00000000-0000-0000-0000-0000000000b1', now(), now() + interval '1 hour') $$, '42501', null,
  'cannot delegate to someone outside the account');
select lives_ok($$ select public.authz_create_delegation('00000000-0000-0000-0000-0000000000a4', now() - interval '1 minute', now() + interval '1 hour') $$,
  'manager can delegate while out of office');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select set_config('t.req2', public.authz_create_approval('discount', 'd-1', 500, 'low')::text, true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select is(public.authz_decide_approval(current_setting('t.req2')::uuid, 'approve'), 'approved', 'the delegate approves on the delegator slot');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select on_behalf_of from public.authz_approval_decisions where request_id = current_setting('t.req2')::uuid),
  '00000000-0000-0000-0000-0000000000a2', 'the decision records who the delegate acted for');

-- audit log is append-only even for privileged roles
reset role;
select throws_ok($$ update public.authz_events set event = 'tampered' $$, '42501', 'authz_events is append-only', 'audit events cannot be updated');
select throws_ok($$ delete from public.authz_events $$, '42501', 'authz_events is append-only', 'audit events cannot be deleted');

-- --------------------------------------------------------------- JIT -------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is(public.authz_has_active_grant('can_view_billing'), false, 'no elevated access before any grant');
select set_config('t.grant', public.authz_request_access(array['can_view_billing'], 'Quarter-end invoice reconciliation', 60)::text, true);
select throws_ok($$ select public.authz_request_access(array['can_view_billing'], 'short', 60) $$, '23514', null, 'a short reason is rejected');
select throws_ok($$ select public.authz_decide_access_grant(current_setting('t.grant')::uuid, true) $$, '42501', 'authz: self_approval_forbidden',
  'requester cannot approve their own grant');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select throws_ok($$ select public.authz_decide_access_grant(current_setting('t.grant')::uuid, true) $$, '42501', 'authz: approver_lacks_permission',
  'an approver cannot grant a permission they do not hold');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ select public.authz_decide_access_grant(current_setting('t.grant')::uuid, true) $$, 'the owner approves');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is(public.authz_has_active_grant('can_view_billing'), true, 'the grant is active after approval');
select is(public.authz_has_active_grant('can_issue_refunds'), false, 'only the granted permission is elevated');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ select public.authz_revoke_access_grant(current_setting('t.grant')::uuid) $$, 'the owner can revoke');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is(public.authz_has_active_grant('can_view_billing'), false, 'revocation takes effect immediately');

-- staff support access is customer-approved and tenant-scoped
select throws_ok($$ select public.authz_request_staff_access('00000000-0000-0000-0000-0000000000a1', 'Investigating a reported bug', 60) $$, '42501', 'authz: staff only',
  'non-staff cannot request staff access');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
select set_config('t.staff', public.authz_request_staff_access('00000000-0000-0000-0000-0000000000a1', 'Investigating a reported bug', 60)::text, true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select throws_ok($$ select public.authz_decide_access_grant(current_setting('t.staff')::uuid, true) $$, '42501', 'authz: approver_not_owner',
  'only an owner can approve staff access to the tenant');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ select public.authz_decide_access_grant(current_setting('t.staff')::uuid, true) $$, 'the customer owner approves staff access');
reset role;
select isnt(public.authz_staff_grant_active('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1'), null, 'an active staff grant is found');
select is(public.authz_staff_grant_active('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b1'), null, 'a grant for one tenant does not open another');

-- --------------------------------------------------------------- guests ----
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.invite', public.authz_create_guest_invite('GC@Example.com', 'GC', encode(sha256(convert_to('tok-123', 'utf8')), 'hex'),
  now() + interval '7 days', '[{"resource":"jobs","recordId":"11111111-1111-4111-8111-111111111111","actions":["view"]}]'::jsonb)::text, true);
select throws_ok($$ select public.authz_create_guest_invite('a@b.co', '', encode(sha256('x'::bytea), 'hex'), now() + interval '91 days',
  '[{"resource":"jobs","recordId":"11111111-1111-4111-8111-111111111111","actions":["view"]}]'::jsonb) $$, '22023', null, 'expiry beyond 90 days is rejected');
select throws_ok($$ select public.authz_create_guest_invite('a@b.co', '', encode(sha256('y'::bytea), 'hex'), now() + interval '1 day',
  '[{"resource":"*","recordId":"11111111-1111-4111-8111-111111111111","actions":["view"]}]'::jsonb) $$, '23514', null, 'wildcard resources are rejected');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1', 'gc@example.com', 'aal1');
select throws_ok($$ select public.authz_guest_redeem('tok-123') $$, '42501', 'authz: invalid_invite', 'redeem without MFA fails');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1', 'gc@example.com', 'aal2');
select throws_ok($$ select public.authz_guest_redeem('no-such-token') $$, '42501', 'authz: invalid_invite', 'an unknown token fails with the same generic error');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4', 'tech2@acme.test', 'aal2');
select throws_ok($$ select public.authz_guest_redeem('tok-123') $$, '42501', 'authz: invalid_invite', 'a different email cannot redeem a forwarded token');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1', 'gc@example.com', 'aal2');
select ok(not (public.authz_guest_redeem('tok-123') ? 'tenant_id'), 'redeem succeeds and reveals no tenant information');
select is(public.authz_guest_can('jobs', '11111111-1111-4111-8111-111111111111', 'view'), true, 'the guest can view the scoped record');
select is(public.authz_guest_can('jobs', '22222222-2222-4222-8222-222222222222', 'view'), false, 'the guest cannot view another record');
select is(public.authz_guest_can('jobs', '11111111-1111-4111-8111-111111111111', 'upload'), false, 'the guest cannot do unscoped actions');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1', 'gc@example.com', 'aal1');
select is(public.authz_guest_can('jobs', '11111111-1111-4111-8111-111111111111', 'view'), false, 'a guest session without MFA loses access');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1', 'gc@example.com', 'aal2');
select throws_ok($$ select token_hash from public.authz_guest_invites $$, '42501', null, 'token hashes are not readable by clients');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ select public.authz_revoke_guest_invite(current_setting('t.invite')::uuid) $$, 'the owner revokes the invite');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e1', 'gc@example.com', 'aal2');
select is(public.authz_guest_can('jobs', '11111111-1111-4111-8111-111111111111', 'view'), false, 'revocation removes guest access immediately');

-- ---------------------------------------------------------------- ABAC -----
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
insert into public.authz_principal_attrs (tenant_id, user_id, location_ids) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a3', array['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1']::uuid[]);
insert into public.authz_abac_policies (tenant_id, resource, actions, require_location_match) values
  ('00000000-0000-0000-0000-0000000000a1', 'jobs', array['select'], true);
insert into public.authz_field_masks (tenant_id, resource, field, strategy) values
  ('00000000-0000-0000-0000-0000000000a1', 'jobs', 'cost_cents', 'redact');
select is(public.authz_record_decision('jobs', '33333333-3333-4333-8333-333333333333', 'select', null, null, null, '{}'), 'owner', 'owners always pass');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is(public.authz_record_decision('jobs', '33333333-3333-4333-8333-333333333333', 'select', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', null, null, '{}'), 'pass', 'matching location passes');
select is(public.authz_record_decision('jobs', '33333333-3333-4333-8333-333333333333', 'select', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', null, null, '{}'), 'policy_location', 'other location is denied');
select is(public.authz_record_decision('jobs', '33333333-3333-4333-8333-333333333333', 'select', null, null, null, '{}'), 'policy_location', 'a restricted principal fails closed on a record with no location');
select is(public.authz_mask_numeric('jobs', 'cost_cents', 12345), 0::numeric, 'non-owners see masked cost');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is(public.authz_mask_numeric('jobs', 'cost_cents', 12345), 12345::numeric, 'owners see real cost');
insert into public.authz_record_acl (tenant_id, resource, record_id, principal_user_id, effect, actions) values
  ('00000000-0000-0000-0000-0000000000a1', 'jobs', '33333333-3333-4333-8333-333333333333', '00000000-0000-0000-0000-0000000000a3', 'deny', array['select']);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is(public.authz_record_decision('jobs', '33333333-3333-4333-8333-333333333333', 'select', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', null, null, '{}'), 'acl_deny', 'an explicit ACL deny beats a passing policy');
select throws_ok($$ insert into public.authz_record_acl (tenant_id, resource, record_id, principal_user_id, effect, actions)
  values ('00000000-0000-0000-0000-0000000000a1', 'jobs', '44444444-4444-4444-8444-444444444444', '00000000-0000-0000-0000-0000000000a3', 'allow', array['select']) $$,
  '42501', null, 'a technician cannot grant themselves record access');

-- ------------------------------------------------------------- ownership ---
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3', null, 'aal1', true);
select throws_ok($$ select public.authz_request_ownership_transfer('00000000-0000-0000-0000-0000000000a2') $$, '42501', 'authz: not_owner', 'a non-owner cannot start a transfer');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', null, 'aal1', false);
select throws_ok($$ select public.authz_request_ownership_transfer('00000000-0000-0000-0000-0000000000a2') $$, '42501', 'authz: reauth_required', 'a stale session cannot start a transfer');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', null, 'aal1', true);
select throws_ok($$ select public.authz_request_ownership_transfer('00000000-0000-0000-0000-0000000000a1') $$, '22023', 'authz: self_transfer', 'cannot transfer to yourself');
select throws_ok($$ select public.authz_request_ownership_transfer('00000000-0000-0000-0000-0000000000b1') $$, '22023', 'authz: target_not_eligible', 'the target must be an active member');
select set_config('t.xfer', public.authz_request_ownership_transfer('00000000-0000-0000-0000-0000000000a2')::text, true);
select ok(current_setting('t.xfer')::uuid is not null, 'a fresh-session owner can request a transfer');
select throws_ok($$ select public.authz_request_ownership_transfer('00000000-0000-0000-0000-0000000000a4') $$, '23505', null, 'only one live transfer at a time');
select lives_ok($$ select public.authz_cancel_ownership_transfer(current_setting('t.xfer')::uuid) $$, 'the owner can cancel before it is ready');
select lives_ok($$ select public.authz_request_org_deletion() $$, 'an owner with a fresh session can start the deletion hold');

select * from finish();
rollback;
