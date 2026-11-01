-- security_events: capture triggers, RLS, step-up enforcement (pgTAP).  Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into auth.users (id, email, encrypted_password) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@sec.test', 'hash-a'),
  ('00000000-0000-0000-0000-0000000000b1', 'b@sec.test', 'hash-b');

-- ---------------------------------------------------------------- capture --
update auth.users set encrypted_password = 'hash-a2' where id = '00000000-0000-0000-0000-0000000000a1';
select is((select count(*)::int from public.security_events where user_id = '00000000-0000-0000-0000-0000000000a1' and event = 'password_changed'),
  1, 'password change is recorded');

update auth.users set encrypted_password = 'hash-a3' where id = '00000000-0000-0000-0000-0000000000a1';
select is((select count(*)::int from public.security_events where user_id = '00000000-0000-0000-0000-0000000000a1' and event = 'password_changed'),
  1, 'a second change inside the same minute is de-duplicated');

update auth.users set email = 'new-a@sec.test' where id = '00000000-0000-0000-0000-0000000000a1';
select is((select count(*)::int from public.security_events where user_id = '00000000-0000-0000-0000-0000000000a1' and event = 'email_changed'),
  1, 'email change is recorded');
select is((select meta ->> 'new_email_masked' from public.security_events where event = 'email_changed' and user_id = '00000000-0000-0000-0000-0000000000a1'),
  'n***@sec.test', 'only a masked new address is stored');
select ok(not exists (select 1 from public.security_events where meta::text like '%new-a@sec.test%' or meta::text like '%a@sec.test%'),
  'no full email address is ever stored in meta');

update auth.users set last_sign_in_at = now() where id = '00000000-0000-0000-0000-0000000000a1';
select is((select count(*)::int from public.security_events where user_id = '00000000-0000-0000-0000-0000000000a1'), 2,
  'unrelated auth.users updates do not create events');

insert into public.api_keys (id, user_id, name, key_prefix, key_hash, scopes) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Zapier', 'vrk_live_a1b2c', 'hash-key-1', '{calls:read}');
select is((select meta ->> 'key_name' from public.security_events where event = 'api_key_created' and user_id = '00000000-0000-0000-0000-0000000000a1'),
  'Zapier', 'API key creation is recorded with its display name');
update public.api_keys set revoked_at = now() where id = '00000000-0000-0000-0000-0000000000c1';
select is((select count(*)::int from public.security_events where event = 'api_key_revoked' and user_id = '00000000-0000-0000-0000-0000000000a1'),
  1, 'API key revocation is recorded');
select ok(not exists (select 1 from public.security_events where meta::text like '%hash-key-1%'), 'key hash never reaches meta');

-- --------------------------------------------------------------- RLS / grants --
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
select is((select count(*)::int from public.security_events), 0, 'user B cannot see user A''s events');
select throws_ok($$insert into public.security_events (user_id, event) values ('00000000-0000-0000-0000-0000000000b1', 'password_changed')$$,
  '42501', null, 'clients cannot forge security events');

-- ------------------------------------------------------------- step-up (amr) --
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000b1', 'role', 'authenticated',
                    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch from now())::bigint - 7200)))::text, true);
select is(public.has_recent_auth(600), false, 'stale authentication is not recent');
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000b1', 'role', 'authenticated',
                    'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint - 30)))::text, true);
select is(public.has_recent_auth(600), true, 'fresh authentication is recent');

select * from finish();
rollback;
