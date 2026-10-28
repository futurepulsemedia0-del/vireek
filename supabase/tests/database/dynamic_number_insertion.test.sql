-- Dynamic number insertion: pool leasing, dedicated numbers, classification, call resolution, isolation (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- fixtures: a1 owns the account, b1 owns ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@dni.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-dni.test');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ---------------------------------------------------------------- setup (owner) --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok(
  $$insert into public.dni_settings (account_owner_id, enabled, default_number, lease_minutes)
    values ('00000000-0000-0000-0000-0000000000a1', true, '+15551234567', 30)$$,
  'owner can enable call tracking');
select lives_ok(
  $$insert into public.dni_numbers (account_owner_id, phone_e164, kind) values
    ('00000000-0000-0000-0000-0000000000a1', '+15550000001', 'pool'),
    ('00000000-0000-0000-0000-0000000000a1', '+15550000002', 'pool')$$,
  'owner can add two pool numbers');
select lives_ok(
  $$insert into public.dni_numbers (account_owner_id, phone_e164, kind, source_key)
    values ('00000000-0000-0000-0000-0000000000a1', '+15550000009', 'source', 'google_business_profile')$$,
  'owner can add a dedicated number');
select throws_ok(
  $$insert into public.dni_numbers (account_owner_id, phone_e164, kind) values ('00000000-0000-0000-0000-0000000000a1', '+15550000001', 'pool')$$,
  '23505', null, 'the same phone number cannot be added twice');
select throws_ok(
  $$insert into public.dni_sessions (account_owner_id, visitor_token, source_key, source_label)
    values ('00000000-0000-0000-0000-0000000000a1', 'abcdefghijklmnop', 'direct', 'Direct')$$,
  '42501', null, 'the browser can never write sessions');
update public.dni_numbers set lease_until = null where phone_e164 = '+15550000001';

reset role;
select set_config('t.key', (select public_key from public.dni_settings where account_owner_id = '00000000-0000-0000-0000-0000000000a1'), false);
select ok(not exists (select 1 from public.dni_numbers where leased_to is not null), 'lease columns are not client-writable');

-- ---------------------------------------------------------- isolation (other owner) --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.dni_numbers), 0, 'another account sees none of these numbers');
select is((select count(*)::int from public.dni_settings), 0, 'another account sees none of these settings');
reset role;

-- ------------------------------------------------------------ anonymous visitors --
select set_config('role', 'anon', true);
select is(public.dni_get_assignment('dni_' || repeat('0', 32), 'acme.com', 'tok0000000000001', '{}'::jsonb) ->> 'ok', 'false', 'unknown key is rejected');

reset role;
create temp table r1 as select public.dni_get_assignment(current_setting('t.key'), 'acme.com', 'tok0000000000001',
  '{"utm_source":"google","utm_medium":"cpc","click_id_type":"gclid","click_id":"x1","landing_path":"/ac-repair"}'::jsonb) as j;
select is((select j ->> 'source_key' from r1), 'google_ads', 'a Google Ads click is classified');
select is((select j ->> 'mode' from r1), 'pool', 'a paid visitor gets a pool number');

select is(public.dni_get_assignment(current_setting('t.key'), 'acme.com', 'tok0000000000001', '{}'::jsonb) ->> 'number',
          (select j ->> 'number' from r1), 'the same visit keeps the same number on the next page');
select isnt(public.dni_get_assignment(current_setting('t.key'), 'acme.com', 'tok0000000000002', '{"utm_source":"facebook","utm_medium":"cpc"}'::jsonb) ->> 'number',
            (select j ->> 'number' from r1), 'a second visitor gets a different pool number');

select is(public.dni_get_assignment(current_setting('t.key'), 'acme.com', 'tok0000000000003', '{"click_id_type":"gclid","click_id":"x3"}'::jsonb) ->> 'exhausted',
          'true', 'an empty pool falls back and says so');
select is(public.dni_get_assignment(current_setting('t.key'), 'acme.com', 'tok0000000000003', '{}'::jsonb) ->> 'number',
          '+15551234567', 'the fallback is the normal business number');

select is(public.dni_get_assignment(current_setting('t.key'), 'acme.com', 'tok0000000000004', '{}'::jsonb) ->> 'mode',
          'default', 'direct visitors keep the normal number');
select is(public.dni_get_assignment(current_setting('t.key'), 'acme.com', 'tok0000000000005', '{"utm_campaign":"GBP-profile"}'::jsonb) ->> 'number',
          '+15550000009', 'a Business Profile visit gets its dedicated number');
reset role;

-- -------------------------------------------------------------- call resolution --
select is(public.dni_resolve_call('00000000-0000-0000-0000-0000000000a1', (select j ->> 'number' from r1), null, now()) ->> 'source_key',
          'google_ads', 'a call to a pool number is tied to the visit that held it');
select is(public.dni_resolve_call('00000000-0000-0000-0000-0000000000a1', '+15550000009', null, now()) ->> 'source_key',
          'google_business_profile', 'a call to a dedicated number gets that source');
select is(public.dni_resolve_call('00000000-0000-0000-0000-0000000000b1', '+15550000009', null, now()),
          null::jsonb, 'another account cannot resolve this number');
select is(public.dni_resolve_call('00000000-0000-0000-0000-0000000000a1', '+15559999999', null, now()),
          null::jsonb, 'an unknown number resolves to nothing');

-- -------------------------------------------------- rate limiting + health numbers --
insert into public.dni_sessions (account_owner_id, visitor_token, source_key, source_label)
  select '00000000-0000-0000-0000-0000000000a1', 'bulk' || lpad(i::text, 12, '0'), 'direct', 'Direct' from generate_series(1, 120) i;
select is(public.dni_get_assignment(current_setting('t.key'), 'acme.com', 'tok0000000000006', '{"click_id_type":"gclid","click_id":"x6"}'::jsonb) ->> 'mode',
          'default', 'a flood of new visits stops using pool numbers');
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((public.dni_performance(30) ->> 'rate_limited_events')::int, 1, 'the dashboard reports the rate limit');
select ok((public.dni_performance(30) ->> 'exhausted_events')::int >= 1, 'the dashboard reports pool exhaustion');
reset role;

select * from finish();
rollback;
