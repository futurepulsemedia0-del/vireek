-- Staff impersonation limits (pgTAP). Run: supabase test db
-- Covers: marking via the access-token hook, binding rules, refresh/expiry refusal, server-side expiry enforcement,
-- kill switch on get_account_owner_id(), export/credential/money blocks, audited close paths, sweeper, uniqueness.
begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000b0001', 'staff@imp.test',  now()),
  ('00000000-0000-0000-0000-0000000b0002', 'owner1@imp.test', now()),
  ('00000000-0000-0000-0000-0000000b0003', 'owner2@imp.test', now()),
  ('00000000-0000-0000-0000-0000000b0004', 'owner3@imp.test', now());
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-0000000b0001';
update public.profiles set role = 'owner', onboarding_completed = true
 where id in ('00000000-0000-0000-0000-0000000b0002','00000000-0000-0000-0000-0000000b0003','00000000-0000-0000-0000-0000000b0004');

insert into public.staff_impersonation_sessions (id, staff_id, target_account_id, reason, expires_at) values
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-0000000b0002', 'ticket ZD-1: customer cannot see invoices', now() + interval '30 minutes'),
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-0000000b0003', 'ticket ZD-2: customer cannot see calls',    now() + interval '30 minutes');

create or replace function pg_temp.hook_event(p_user uuid, p_session uuid, p_method text, p_exp bigint default null) returns jsonb language sql as $$
  select jsonb_build_object('user_id', p_user, 'authentication_method', p_method,
    'claims', jsonb_build_object('sub', p_user, 'session_id', p_session, 'role', 'authenticated', 'aal', 'aal1',
                                 'exp', coalesce(p_exp, floor(extract(epoch from now() + interval '1 hour'))::bigint)));
$$;

create or replace function pg_temp.act_as(p_user uuid, p_imp_sid uuid default null) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims',
    (case when p_imp_sid is null
       then json_build_object('sub', p_user, 'role', 'authenticated')
       else json_build_object('sub', p_user, 'role', 'authenticated',
              'imp', json_build_object('sid', p_imp_sid, 'staff', '00000000-0000-0000-0000-0000000b0001', 'exp', 4102444800))
     end)::text, true);
end $$;

-- ---- 1. hook: marking and binding ------------------------------------------------------------------------------
select is((public.custom_access_token_hook(pg_temp.hook_event('00000000-0000-0000-0000-0000000b0003', '00000000-0000-0000-0000-0000000e0003', 'password')) -> 'claims') ? 'imp', false,
          'a password login of the owner is NOT marked or bound while a support session is open');
select is((select auth_session_id from public.staff_impersonation_sessions where id = '00000000-0000-0000-0000-0000000d0002'), null::uuid, 'and the open session stays unbound');

select is(public.custom_access_token_hook(pg_temp.hook_event('00000000-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-0000000e0001', 'magiclink')) -> 'claims' -> 'imp' ->> 'sid',
          '00000000-0000-0000-0000-0000000d0001', 'the first magic-link token is marked with the support session id');
select is((select auth_session_id from public.staff_impersonation_sessions where id = '00000000-0000-0000-0000-0000000d0001'), '00000000-0000-0000-0000-0000000e0001'::uuid, 'the session row is bound to that auth session');
select is((select count(*)::int from public.staff_audit_log where action = 'impersonation_bound' and target_account_id = '00000000-0000-0000-0000-0000000b0002'), 1, 'binding is audited');
select cmp_ok((public.custom_access_token_hook(pg_temp.hook_event('00000000-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-0000000e0001', 'magiclink', 4102444800)) -> 'claims' ->> 'exp')::bigint,
              '<=', floor(extract(epoch from now() + interval '30 minutes'))::bigint + 2, 'the token exp is capped at the support session expiry');
select is(public.custom_access_token_hook(pg_temp.hook_event('00000000-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-0000000e0001', 'token_refresh')) -> 'claims' -> 'imp' ->> 'sid',
          '00000000-0000-0000-0000-0000000d0001', 'a refresh of the bound session keeps the marker');
select is((public.custom_access_token_hook(pg_temp.hook_event('00000000-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-0000000e0099', 'password')) -> 'claims') ? 'imp', false,
          'the real owner''s other session (different auth session id) is not marked');

-- ---- 2. refresh is refused after expiry / end -----------------------------------------------------------------
update public.staff_impersonation_sessions set expires_at = now() - interval '1 second' where id = '00000000-0000-0000-0000-0000000d0001';
select is((public.custom_access_token_hook(pg_temp.hook_event('00000000-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-0000000e0001', 'token_refresh')) -> 'error' ->> 'http_code')::int, 403,
          'refresh after expires_at is refused (403)');
update public.staff_impersonation_sessions set expires_at = now() + interval '30 minutes' where id = '00000000-0000-0000-0000-0000000d0001';

-- ---- 3. request-level enforcement ----------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000b0002', null);
select is(public.is_impersonating(), false, 'no marker => not impersonating');
select is(public.can_export_data(), true, 'normal owner can export');
select lives_ok($$select public.assert_not_impersonating('refund')$$, 'assert_not_impersonating passes for a normal owner');
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-0000000d0001');
select is(public.is_impersonating(), true, 'marker => impersonating');
select is(public.impersonation_expired(), false, 'a valid session is not expired');
select is(public.get_account_owner_id(), '00000000-0000-0000-0000-0000000b0002'::uuid, 'a valid support session resolves to the customer account');
select is(public.can_export_data(), false, 'export is blocked while impersonating');
select throws_ok($$select public.assert_not_impersonating('refund')$$, '42501', null, 'money/credential helper raises while impersonating');
reset role;

update public.staff_impersonation_sessions set expires_at = now() - interval '1 second' where id = '00000000-0000-0000-0000-0000000d0001';
select pg_temp.act_as('00000000-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-0000000d0001');
select is(public.impersonation_expired(), true, 'the SERVER treats a past expires_at as expired even though the JWT exp is far in the future');
select is(public.get_account_owner_id(), null::uuid, 'kill switch: an expired support session resolves to no account');
reset role;

-- ---- 4. credential / money policies exist -----------------------------------------------------------------------
select cmp_ok((select count(*) from pg_policies where schemaname = 'public' and policyname in ('imp_block_all','imp_block_ins','imp_block_upd','imp_block_del')), '>', 0::bigint,
              'restrictive impersonation policies are installed on credential/money tables');
select is((select count(*) from pg_policies where schemaname = 'public' and policyname like 'imp\_block\_%' and permissive <> 'RESTRICTIVE'), 0::bigint, 'every impersonation policy is RESTRICTIVE');

-- ---- 5. closing --------------------------------------------------------------------------------------------------
select is(public.impersonation_close('00000000-0000-0000-0000-0000000d0001', 'staff_ended'), true, 'staff end closes the session');
select is((select end_reason from public.staff_impersonation_sessions where id = '00000000-0000-0000-0000-0000000d0001'), 'staff_ended', 'end reason recorded');
select is(public.impersonation_close('00000000-0000-0000-0000-0000000d0001', 'staff_ended'), false, 'closing twice is a no-op');
select is((select count(*)::int from public.audit_log where user_id = '00000000-0000-0000-0000-0000000b0002' and action = 'staff_impersonation_ended'), 1, 'the customer sees the end in their own audit log');

select pg_temp.act_as('00000000-0000-0000-0000-0000000b0003', '00000000-0000-0000-0000-0000000d0002');
select is(public.impersonation_end_current(), true, 'the banner button ends the session in the caller''s own claim');
reset role;
select is((select end_reason from public.staff_impersonation_sessions where id = '00000000-0000-0000-0000-0000000d0002'), 'banner_ended', 'banner end reason recorded');
select pg_temp.act_as('00000000-0000-0000-0000-0000000b0003', null);
select is(public.impersonation_end_current(), false, 'without a marker the banner RPC does nothing');
reset role;

-- ---- 6. sweeper ----------------------------------------------------------------------------------------------------
insert into public.staff_impersonation_sessions (id, staff_id, target_account_id, reason, started_at, expires_at) values
  ('00000000-0000-0000-0000-0000000d0003', '00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-0000000b0004', 'ticket ZD-3: customer cannot see jobs', now() - interval '1 hour', now() - interval '30 minutes');
select cmp_ok(public.impersonation_sweep_expired(), '>=', 1, 'the sweeper closes expired sessions');
select is((select end_reason from public.staff_impersonation_sessions where id = '00000000-0000-0000-0000-0000000d0003'), 'expired', 'sweeper marks them expired');
select is((select count(*)::int from public.staff_audit_log where action = 'impersonation_expired' and target_account_id = '00000000-0000-0000-0000-0000000b0004'), 1, 'expiry is audited');

-- ---- 7. integrity --------------------------------------------------------------------------------------------------
insert into public.staff_impersonation_sessions (staff_id, target_account_id, reason, expires_at)
  values ('00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-0000000b0004', 'ticket ZD-4: first open session', now() + interval '10 minutes');
select throws_ok($$insert into public.staff_impersonation_sessions (staff_id, target_account_id, reason, expires_at)
  values ('00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-0000000b0004', 'ticket ZD-5: second open session', now() + interval '10 minutes')$$,
  '23505', null, 'only one open support session per customer account');
select lives_ok($$insert into public.staff_audit_log (staff_id, action, target_account_id, metadata) values ('00000000-0000-0000-0000-0000000b0001', 'impersonation_blocked', '00000000-0000-0000-0000-0000000b0004', '{"action":"issue-refund"}')$$,
  'staff_audit_log accepts impersonation_blocked');

select set_config('role', 'anon', true);
select throws_ok($$select public.custom_access_token_hook('{}'::jsonb)$$, '42501', null, 'anon cannot call the auth hook');
reset role;

select * from finish();
rollback;
