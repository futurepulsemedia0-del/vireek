-- Bank provider resilience (pgTAP): privileges/RLS on health, rates, metering and consent tables,
-- tenant isolation of consent records, append-only guard, idempotent consent, rollback-safe revocation.
-- Migration under test: 20290306000000_bank_provider_resilience.sql
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000b0a01', 'a@bankres.test'),
  ('00000000-0000-0000-0000-0000000b0b01', 'b@bankres.test');

-- bank_connections exists in two historical variants in this repo (provider_item_id vs item_id); support both.
do $$
declare v_col text;
begin
  select column_name into v_col from information_schema.columns
   where table_schema = 'public' and table_name = 'bank_connections' and column_name in ('provider_item_id', 'item_id')
   order by column_name desc limit 1;
  execute format($f$insert into public.bank_connections (id, user_id, provider, %I) values
    ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-0000000b0a01', 'plaid', 'item-a'),
    ('00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-0000000b0b01', 'plaid', 'item-b')$f$, v_col);
end $$;

create or replace function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ------------------------------------------------------------ structure / RLS --
select ok((select relrowsecurity from pg_class where oid = 'public.bank_provider_health'::regclass), 'health: RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.bank_provider_rates'::regclass), 'rates: RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.bank_pull_usage'::regclass), 'usage: RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.bank_data_consents'::regclass), 'consents: RLS on');
select is((select count(*)::int from public.bank_provider_rates), 0, 'rate card ships EMPTY (no invented vendor prices)');

select ok(not has_table_privilege('authenticated', 'public.bank_provider_health', 'select'), 'authenticated cannot read provider health table');
select ok(not has_table_privilege('authenticated', 'public.bank_pull_usage', 'select'), 'authenticated cannot read metering');
select ok(not has_table_privilege('authenticated', 'public.bank_provider_rates', 'select'), 'authenticated cannot read rate card');
select ok(not has_table_privilege('anon', 'public.bank_data_consents', 'select'), 'anon cannot read consents');
select ok(not has_table_privilege('authenticated', 'public.bank_data_consents', 'insert'), 'authenticated cannot insert consents');
select ok(not has_table_privilege('authenticated', 'public.bank_data_consents', 'update'), 'authenticated cannot update consents');
select ok(not has_table_privilege('authenticated', 'public.bank_data_consents', 'delete'), 'authenticated cannot delete consents');
select ok(not has_table_privilege('authenticated', 'public.bank_pull_usage_daily', 'select'), 'authenticated cannot read usage view');

select ok(not has_function_privilege('authenticated', 'public.bank_record_consent(uuid,uuid,text,uuid,text[],text,text,boolean)', 'execute'), 'authenticated cannot record consent for arbitrary tenants');
select ok(not has_function_privilege('anon', 'public.bank_has_active_consent(uuid)', 'execute'), 'anon cannot probe consent');
select ok(not has_function_privilege('authenticated', 'public.bank_record_pull(uuid,uuid,text,text,integer,text,text,integer,bigint)', 'execute'), 'authenticated cannot write metering');
select ok(not has_function_privilege('authenticated', 'public.bank_provider_save_health(text,text,integer,timestamptz,timestamptz,text,timestamptz)', 'execute'), 'authenticated cannot tamper with circuit state');
select ok(has_function_privilege('service_role', 'public.bank_record_consent(uuid,uuid,text,uuid,text[],text,text,boolean)', 'execute'), 'service_role can record consent');

-- ------------------------------------------------------------------ consent --
select isnt(public.bank_record_consent('00000000-0000-0000-0000-0000000b0a01', '00000000-0000-0000-0000-00000000c0a1', 'plaid',
  '00000000-0000-0000-0000-0000000b0a01', array['accounts','transactions'], 'link_flow', 'v-test', true), null, 'consent recorded');
select is(public.bank_record_consent('00000000-0000-0000-0000-0000000b0a01', '00000000-0000-0000-0000-00000000c0a1', 'plaid',
  '00000000-0000-0000-0000-0000000b0a01', array['accounts','transactions'], 'link_flow', 'v-test', true), null, 're-link is idempotent (no duplicate active consent)');
select is((select count(*)::int from public.bank_data_consents where connection_id = '00000000-0000-0000-0000-00000000c0a1' and revoked_at is null), 1, 'exactly one active consent per connection');
select is((select evidence from public.bank_data_consents where connection_id = '00000000-0000-0000-0000-00000000c0a1'), 'link_completed', 'link flow is recorded as link_completed evidence');
select ok(public.bank_has_active_consent('00000000-0000-0000-0000-00000000c0a1'), 'active consent detected');
select ok(not public.bank_has_active_consent('00000000-0000-0000-0000-00000000c0b1'), 'a connection without a record has no consent');

select throws_ok($$ select public.bank_record_consent('00000000-0000-0000-0000-0000000b0a01', '00000000-0000-0000-0000-00000000c0b1', 'plaid', null, array['accounts'], 'link_flow', null, false) $$,
  '42501', null, 'cannot record consent for another tenant''s connection');
select throws_ok($$ select public.bank_record_consent('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000c0b1', 'plaid', null, array['payments'], 'link_flow', null, false) $$,
  '23514', null, 'unknown scope is rejected by the CHECK');

-- tenant isolation (RLS): A sees A's consent only
select pg_temp.as_user('00000000-0000-0000-0000-0000000b0a01');
select is((select count(*)::int from public.bank_data_consents), 1, 'owner A sees only their own consent');
select is((select count(*)::int from public.bank_data_consents where user_id = '00000000-0000-0000-0000-0000000b0b01'), 0, 'owner A cannot see tenant B consent');
select throws_ok($$ update public.bank_data_consents set revoked_at = now() $$, '42501', null, 'client cannot revoke/alter consent directly');
reset role;

-- append-only guard (as the privileged role): only revocation may change a row
select throws_ok($$ update public.bank_data_consents set scopes = array['balances'] where connection_id = '00000000-0000-0000-0000-00000000c0a1' $$,
  '42501', null, 'scopes cannot be rewritten after the fact');
select throws_ok($$ update public.bank_data_consents set granted_at = now() - interval '1 year' where connection_id = '00000000-0000-0000-0000-00000000c0a1' $$,
  '42501', null, 'granted_at cannot be back-dated');
select is(public.bank_revoke_consents('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-0000000b0a01', 'test'), 1, 'revocation touches the active row');
select ok(not public.bank_has_active_consent('00000000-0000-0000-0000-00000000c0a1'), 'revoked consent no longer active');
select throws_ok($$ update public.bank_data_consents set revoke_reason = 'edited' where connection_id = '00000000-0000-0000-0000-00000000c0a1' $$,
  '42501', null, 'a revoked record is immutable');
select is(public.bank_revoke_consents('00000000-0000-0000-0000-00000000c0a1', null, 'again'), 0, 'revoking twice is a no-op');
select isnt(public.bank_record_consent('00000000-0000-0000-0000-0000000b0a01', '00000000-0000-0000-0000-00000000c0a1', 'plaid', null, array['accounts'], 'link_flow', null, false), null, 're-consent after revocation creates a new record');
select is((select count(*)::int from public.bank_data_consents where connection_id = '00000000-0000-0000-0000-00000000c0a1'), 2, 'history preserved (revoked + new)');

-- purging the connection must not be blocked by the guard (FK ON DELETE SET NULL) and keeps the evidence
select lives_ok($$ delete from public.bank_connections where id = '00000000-0000-0000-0000-00000000c0a1' $$, 'connection can be deleted');
select is((select count(*)::int from public.bank_data_consents where user_id = '00000000-0000-0000-0000-0000000b0a01' and connection_id is null), 2, 'consent history survives connection deletion');

-- ------------------------------------------------------- health + metering --
select lives_ok($$ select public.bank_provider_save_health('plaid', 'down', 5, now() - interval '1 hour', now(), 'provider_unavailable', now() + interval '1 minute') $$, 'health saved');
select is((select state from public.bank_provider_health where provider = 'plaid'), 'down', 'state persisted');
select lives_ok($$ select public.bank_provider_save_health('plaid', 'healthy', 0, now(), null, null, null) $$, 'health recovers');
select is((select last_failure_at is not null from public.bank_provider_health where provider = 'plaid'), true, 'last_failure_at kept for diagnosis after recovery');
select throws_ok($$ select public.bank_provider_save_health('plaid', 'exploded', 0, null, null, null, null) $$, '23514', null, 'invalid state rejected');

select lives_ok($$ select public.bank_record_pull('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000dead', 'plaid', 'accounts', 1, 'ok', null, 12, null) $$, 'a dangling connection id does not break metering');
select is((select cost_micros is null from public.bank_pull_usage order by created_at desc limit 1), true, 'unknown cost stays NULL');
select is((select connection_id is null from public.bank_pull_usage order by created_at desc limit 1), true, 'dangling connection id stored as NULL');
select throws_ok($$ select public.bank_record_pull(null, null, 'plaid', 'drain_account', 1, 'ok', null, 1, null) $$, '23514', null, 'unknown operation rejected');
select throws_ok($$ select public.bank_prune_pull_usage(5) $$, 'P0001', null, 'prune refuses a retention shorter than 30 days');

select * from finish();
rollback;
