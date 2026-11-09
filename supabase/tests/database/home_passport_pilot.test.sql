-- Home Service Passport pilot (pgTAP): flag gate, redaction, ranges-only predictions, snapshot immutability,
-- share consent/expiry/exhaustion/revocation/tamper, ownership-transfer consent, cross-tenant isolation,
-- abuse throttling and the verify_home_passport collision fix.
-- Run with:  supabase test db
-- Impersonation mirrors PostgREST: role = authenticated|anon + request.jwt.claim.sub.
begin;
create extension if not exists pgtap with schema extensions;
select plan(80);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@hpp-a.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@hpp-b.test');

insert into public.customers (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Ana Lee'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000b1', 'Other Customer');

insert into public.customer_sites (id, user_id, customer_id, name, address, city, state, postal_code, is_primary) values
  ('00000000-0000-0000-0000-000000000051', '00000000-0000-0000-0000-0000000000a1',
   '00000000-0000-0000-0000-0000000000c1', 'Home', '12 Main Street', 'Austin', 'TX', '78701', true);

create temp table t_snap  (r jsonb);
create temp table t_snap2 (r jsonb);
create temp table t_snap3 (r jsonb);
create temp table t_s1 (r jsonb);
create temp table t_s2 (r jsonb);
create temp table t_s3 (r jsonb);
create temp table t_s4 (r jsonb);
create temp table t_l9 (r jsonb);
create temp table t_tr  (r jsonb);
create temp table t_tr2 (r jsonb);
grant all on t_snap, t_snap2, t_snap3, t_s1, t_s2, t_s3, t_s4, t_l9, t_tr, t_tr2 to authenticated, anon;

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.act_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ------------------------------------------------------------ flag default OFF --
select is(public.home_passport_pilot_enabled('00000000-0000-0000-0000-0000000000a1'), false,
  'flag is OFF by default for every account');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.set_home_passport_pilot_settings(true, false) $$, '42501', 'HPP_DISABLED',
  'with the flag OFF every pilot write is refused');
select is((select public.get_home_passport_pilot_status() ->> 'enabled'), 'false',
  'status reports disabled while the flag is OFF');
reset role;

-- Master switch ON, 0% rollout: only accounts with an explicit override get the module (per-account entitlement).
update public.feature_flags set enabled = true, rollout_pct = 0 where key = 'home_passport_pilot';
insert into public.feature_flag_overrides (flag_id, tenant_id, state)
  select id, '00000000-0000-0000-0000-0000000000a1', 'on' from public.feature_flags where key = 'home_passport_pilot';

select is(public.home_passport_pilot_enabled('00000000-0000-0000-0000-0000000000a1'), true,
  'override ON entitles account A');
select is(public.home_passport_pilot_enabled('00000000-0000-0000-0000-0000000000b1'), false,
  'account B without an override stays OFF even with the master switch on');

-- ------------------------------------------------------- opt-in + snapshot v1 --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.create_home_passport_snapshot('00000000-0000-0000-0000-0000000000c1', 'city', null) $$,
  'P0001', 'HPP_OPT_IN_REQUIRED', 'a contractor that has not opted in cannot create a passport snapshot');
select lives_ok($$ select public.set_home_passport_pilot_settings(true, false) $$, 'manager opts in (company name hidden)');
select lives_ok($$ insert into t_snap select public.create_home_passport_snapshot('00000000-0000-0000-0000-0000000000c1', 'city', null) $$,
  'snapshot v1 is created');
select is((select (r ->> 'version')::int from t_snap), 1, 'first snapshot is version 1');
reset role;

select ok(not ((select snapshot -> 'property' from public.home_passport_snapshots where id = (select (r ->> 'snapshot_id')::uuid from t_snap)) ? 'address'),
  'city-level snapshot carries no street address');
select is((select snapshot -> 'serviced_by' from public.home_passport_snapshots where id = (select (r ->> 'snapshot_id')::uuid from t_snap)),
  'null'::jsonb, 'company name is hidden unless the contractor opted to show it');
select is(public.hpp_find_forbidden_keys((select snapshot from public.home_passport_snapshots where id = (select (r ->> 'snapshot_id')::uuid from t_snap))),
  '{}'::text[], 'no forbidden key (phone/email/price/amount/notes...) in the sealed payload');
select is(position('Ana Lee' in (select snapshot::text from public.home_passport_snapshots where id = (select (r ->> 'snapshot_id')::uuid from t_snap))), 0,
  'customer name never appears in the snapshot');

-- ----------------------------------------------------------- redaction guard --
select is(public.hpp_find_forbidden_keys('{"a":{"price":1,"x":[{"customer_email":"e"}]}}'::jsonb),
  array['customer_email', 'price'], 'forbidden-key scan finds nested keys');
select is(public.hpp_find_forbidden_keys('{"title":"price list"}'::jsonb), '{}'::text[],
  'forbidden-key scan looks at keys, not values');

-- ------------------------------------------------- ranges only, with assumptions --
select is((public.hpp_clean_ranges('{"annual":700,"annualLow":410,"annualHigh":980,"fiveYear":3500,"fiveYearLow":2100,"fiveYearHigh":5200,"suggestedMonthlyReserve":60,"confidence":"medium","assumptions":["Typical service lives"]}'::jsonb)
  -> 'annual_range' ->> 'low')::numeric, 400::numeric, 'range low is rounded down to the nearest 50');
select ok(not (public.hpp_clean_ranges('{"annual":700,"annualLow":410,"annualHigh":980,"fiveYear":3500,"fiveYearLow":2100,"fiveYearHigh":5200,"suggestedMonthlyReserve":60,"confidence":"medium","assumptions":["Typical service lives"]}'::jsonb) ? 'annual'),
  'point estimates are never exported');
select ok(public.hpp_clean_ranges('{"annual":700,"annualLow":410,"annualHigh":980,"fiveYear":3500,"fiveYearLow":2100,"fiveYearHigh":5200,"suggestedMonthlyReserve":60,"confidence":"medium","assumptions":[]}'::jsonb) is null,
  'a range without assumptions is dropped');
select ok(public.hpp_clean_ranges('{"annual":700,"annualLow":700,"annualHigh":700,"fiveYear":3500,"fiveYearLow":3500,"fiveYearHigh":3500,"suggestedMonthlyReserve":60,"confidence":"medium","assumptions":["x"]}'::jsonb) is null,
  'a zero-width "range" is dropped');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ insert into t_snap2 select public.create_home_passport_snapshot('00000000-0000-0000-0000-0000000000c1', 'city',
  '{"annual":700,"annualLow":410,"annualHigh":980,"fiveYear":3500,"fiveYearLow":2100,"fiveYearHigh":5200,"suggestedMonthlyReserve":60,"confidence":"medium","assumptions":["Typical service lives"]}'::jsonb) $$,
  'snapshot v2 with cost ranges is created');
reset role;

select ok((select snapshot -> 'cost_ranges' ->> 'disclaimer' from public.home_passport_snapshots where id = (select (r ->> 'snapshot_id')::uuid from t_snap2)) is not null,
  'ranges always ship with the disclaimer');
select is((select prev_snapshot_hash from public.home_passport_snapshots where id = (select (r ->> 'snapshot_id')::uuid from t_snap2)),
  (select r ->> 'snapshot_hash' from t_snap), 'v2 is hash-linked to v1');
select throws_ok($$ update public.home_passport_snapshots set snapshot = '{}'::jsonb $$, 'P0001',
  'HPP_IMMUTABLE: issued snapshots cannot be modified; create a new version', 'issued snapshots are immutable');

-- ------------------------------------------------------------------- shares --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.create_home_passport_share((select (r ->> 'snapshot_id')::uuid from t_snap), 'buyer', 'x', 30, 100, false, 'draft-v1') $$,
  'P0001', 'HPP_CONSENT_REQUIRED', 'sharing requires explicit owner consent');
select lives_ok($$ insert into t_s1 select public.create_home_passport_share((select (r ->> 'snapshot_id')::uuid from t_snap), 'buyer', 'Buyer link', 30, 100, true, 'draft-v1') $$,
  'share S1 created with consent');
select lives_ok($$ insert into t_s2 select public.create_home_passport_share((select (r ->> 'snapshot_id')::uuid from t_snap), 'inspector', 'One view', 30, 1, true, 'draft-v1') $$,
  'share S2 (single view) created');
reset role;

select pg_temp.act_anon();
select is((select public.verify_home_passport_share((select r ->> 'token' from t_s1)) ->> 'status'), 'valid', 'anonymous visitor can open a valid link');
select is((select public.verify_home_passport_share((select r ->> 'token' from t_s1)) -> 'snapshot' ->> 'schema'), 'vireek.home_passport.v2', 'payload is the v2 schema');
select is((select public.verify_home_passport_share((select r ->> 'token' from t_s2)) ->> 'status'), 'valid', 'single-view link opens once');
select is((select public.verify_home_passport_share((select r ->> 'token' from t_s2)) ->> 'status'), 'exhausted', 'single-view link is exhausted on the second visit');
reset role;

select is((select view_count from public.home_passport_share_links where id = (select (r ->> 'link_id')::uuid from t_s1)), 2, 'every valid view is counted');
select is((select count(*)::int from public.home_passport_pilot_audit where action = 'share_viewed' and subject_id = (select (r ->> 'link_id')::uuid from t_s1)), 1,
  'view audit rows are de-duplicated per link per hour');

-- expiry (the guard trigger forbids editing terms, so lift it only inside this test transaction)
alter table public.home_passport_share_links disable trigger trg_hpp_link_guard;
update public.home_passport_share_links set expires_at = now() - interval '1 minute' where id = (select (r ->> 'link_id')::uuid from t_s1);
alter table public.home_passport_share_links enable trigger trg_hpp_link_guard;

select pg_temp.act_anon();
select is((select public.verify_home_passport_share((select r ->> 'token' from t_s1)) ->> 'status'), 'expired', 'expired link is refused');
select ok((select public.verify_home_passport_share((select r ->> 'token' from t_s1)) -> 'snapshot') = 'null'::jsonb, 'expired link returns no data');
reset role;

-- revocation
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ select public.revoke_home_passport_share((select (r ->> 'link_id')::uuid from t_s2)) $$, 'manager revokes a link');
select lives_ok($$ select public.revoke_home_passport_share((select (r ->> 'link_id')::uuid from t_s2)) $$, 'revoking twice is harmless (idempotent)');
reset role;
select pg_temp.act_anon();
select is((select public.verify_home_passport_share((select r ->> 'token' from t_s2)) ->> 'status'), 'revoked', 'revoked link is refused');
reset role;

-- tamper detection
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ insert into t_s3 select public.create_home_passport_share((select (r ->> 'snapshot_id')::uuid from t_snap2), 'agent', 'Tamper probe', 30, 10, true, 'draft-v1') $$,
  'share S3 created on v2');
reset role;
alter table public.home_passport_snapshots disable trigger trg_hpp_snapshot_guard;
update public.home_passport_snapshots set snapshot = snapshot || '{"injected":true}'::jsonb where id = (select (r ->> 'snapshot_id')::uuid from t_snap2);
alter table public.home_passport_snapshots enable trigger trg_hpp_snapshot_guard;
select pg_temp.act_anon();
select is((select public.verify_home_passport_share((select r ->> 'token' from t_s3)) ->> 'status'), 'tampered', 'a modified snapshot fails its seal');
reset role;

-- ------------------------------------------------------ cross-tenant isolation --
insert into public.feature_flag_overrides (flag_id, tenant_id, state)
  select id, '00000000-0000-0000-0000-0000000000b1', 'on' from public.feature_flags where key = 'home_passport_pilot';

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select throws_ok($$ select public.revoke_home_passport_share((select (r ->> 'link_id')::uuid from t_s3)) $$, 'P0001', 'HPP_NOT_FOUND',
  'another account cannot revoke my link');
select is((select public.list_home_passport_shares('00000000-0000-0000-0000-0000000000c1')), '[]'::jsonb,
  'another account sees none of my shares');
select throws_ok($$ select public.create_home_passport_snapshot('00000000-0000-0000-0000-0000000000c1', 'city', null) $$, 'P0001', 'HPP_NOT_FOUND',
  'another account cannot snapshot my customer');
select is((select jsonb_array_length(public.list_home_passport_pilot_audit(100))), 0, 'another account sees none of my audit trail');
select throws_ok($$ select public.request_home_ownership_transfer('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000051', 'owner_written', 'draft-v1', 30, 'city', null) $$,
  'P0001', 'HPP_NOT_FOUND', 'another account cannot start a transfer on my property');
select throws_ok($$ select * from public.home_passport_share_links $$, '42501', null, 'share links are not readable by clients (token hashes stay server-side)');
select throws_ok($$ insert into public.home_passport_snapshots (account_owner_id, customer_id, version, schema_id, snapshot, snapshot_hash)
  values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c3', 1, 'x', '{}'::jsonb, repeat('0', 64)) $$,
  '42501', null, 'clients cannot write snapshots directly');
reset role;

-- ------------------------------------------------------ ownership transfer --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.request_home_ownership_transfer('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000051', null, 'draft-v1', 30, 'city', null) $$,
  'P0001', 'HPP_CONSENT_REQUIRED', 'a transfer without recorded owner consent is refused');
select throws_ok($$ select public.request_home_ownership_transfer('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000051', 'verbal', 'draft-v1', 30, 'city', null) $$,
  'P0001', 'HPP_CONSENT_REQUIRED', 'an unknown consent method is refused');
select lives_ok($$ insert into t_tr select public.request_home_ownership_transfer('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000051', 'owner_written', 'draft-v1', 30, 'city', null) $$,
  'a consented transfer request is created');
select throws_ok($$ select public.request_home_ownership_transfer('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000051', 'owner_written', 'draft-v1', 30, 'city', null) $$,
  'P0001', 'HPP_CONFLICT: a transfer is already pending for this property', 'only one pending transfer per property');
select is((select public.list_home_ownership_transfers('00000000-0000-0000-0000-0000000000c1') -> 0 ->> 'status'), 'pending', 'transfer is listed as pending');
select lives_ok($$ insert into t_l9 select public.create_home_passport_share((select (r ->> 'snapshot_id')::uuid from t_snap), 'buyer', 'Seller-era link', 30, 10, true, 'draft-v1') $$,
  'a seller-era link exists before closing');
reset role;

insert into public.home_ownership_periods (user_id, site_id, customer_id, started_at)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000051', '00000000-0000-0000-0000-0000000000c1', current_date - 400);

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.complete_home_ownership_transfer((select (r ->> 'transfer_id')::uuid from t_tr), current_date + 5) $$,
  'P0001', 'HPP_INVALID: closing date cannot be in the future', 'closing date cannot be in the future');
select lives_ok($$ select public.complete_home_ownership_transfer((select (r ->> 'transfer_id')::uuid from t_tr), current_date) $$,
  'the transfer completes');
reset role;

select is((select ended_at from public.home_ownership_periods where site_id = '00000000-0000-0000-0000-000000000051' and started_at = current_date - 400), current_date,
  'the seller''s ownership period is closed');
select is((select count(*)::int from public.home_ownership_periods where site_id = '00000000-0000-0000-0000-000000000051' and ended_at is null and customer_id is null and transfer_reason = 'sale'), 1,
  'the new period starts with no customer link and no name');
select ok((select revoked_at from public.home_passport_share_links where id = (select (r ->> 'link_id')::uuid from t_l9)) is not null,
  'seller-era share links are revoked at the sale');
select is((select status from public.home_passport_ownership_transfers where id = (select (r ->> 'transfer_id')::uuid from t_tr)), 'completed', 'transfer is marked completed');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.complete_home_ownership_transfer((select (r ->> 'transfer_id')::uuid from t_tr), current_date) $$,
  'P0001', 'HPP_CONFLICT: transfer is not pending', 'a completed transfer cannot be completed twice');
select lives_ok($$ insert into t_tr2 select public.request_home_ownership_transfer('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000051', 'owner_electronic', 'draft-v1', 30, 'city', null) $$,
  'a new transfer request can be created after completion');
reset role;

alter table public.home_passport_ownership_transfers disable trigger trg_hpp_transfer_guard;
update public.home_passport_ownership_transfers set expires_at = now() - interval '1 minute' where id = (select (r ->> 'transfer_id')::uuid from t_tr2);
alter table public.home_passport_ownership_transfers enable trigger trg_hpp_transfer_guard;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.complete_home_ownership_transfer((select (r ->> 'transfer_id')::uuid from t_tr2), current_date) $$,
  'P0001', 'HPP_EXPIRED', 'an expired transfer cannot be completed');
select lives_ok($$ select public.request_home_ownership_transfer('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000051', 'owner_in_person', 'draft-v1', 30, 'city', null) $$,
  'a fresh request frees the slot held by an expired one');
reset role;
select is((select status from public.home_passport_ownership_transfers where id = (select (r ->> 'transfer_id')::uuid from t_tr2)), 'cancelled',
  'the expired request was auto-cancelled');

-- ------------------------------------------------------------ pilot metrics --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select (public.get_home_passport_pilot_metrics(30) -> 'totals' ->> 'passports_created')::int), 1, 'metrics: one passport created (first version only)');
select ok((select (public.get_home_passport_pilot_metrics(30) -> 'totals' ->> 'shares_created')::int) >= 4, 'metrics: shares counted');
select is((select (public.get_home_passport_pilot_metrics(30) -> 'totals' ->> 'transfers_completed')::int), 1, 'metrics: one transfer completed');
reset role;

-- ----------------------------------------------- collision fix + public lookups --
select is((select proargnames from pg_proc where oid = 'public.verify_home_passport(text)'::regprocedure), array['p_token'],
  'sealed-link verifier is back with the p_token parameter the app calls');
select pg_temp.act_anon();
select is((select public.verify_home_passport(repeat('0', 64)) ->> 'status'), 'not_found', 'legacy verifier answers not_found for an unknown token');
select is((select public.verify_home_passport_code('ZZZZZZZZZZZZ') ->> 'found'), 'false', 'network code lookup answers found=false for an unknown code');
reset role;

-- ----------------------------------------------------------- abuse protection --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ insert into t_s4 select public.create_home_passport_share((select (r ->> 'snapshot_id')::uuid from t_snap), 'buyer', 'Throttle probe', 30, 1000, true, 'draft-v1') $$,
  'share S4 (1000 views) created');
reset role;

select pg_temp.act_anon();
select is((select count(*)::int from (select public.verify_home_passport_share((select r ->> 'token' from t_s4)) ->> 'status' as s from generate_series(1, 125)) x where s = 'rate_limited'), 5,
  'per-link view throttle trips after 120 views per hour');
reset role;
select is((select view_count from public.home_passport_share_links where id = (select (r ->> 'link_id')::uuid from t_s4)), 120,
  'throttled requests are not counted as views');

delete from public.home_passport_pilot_hits where kind = 'fail';
select pg_temp.act_anon();
select is((select count(*)::int from (select public.verify_home_passport_share('nope') ->> 'status' as s from generate_series(1, 25)) x where s = 'rate_limited'), 5,
  'failed lookups are throttled after 20 misses per 10 minutes');
reset role;

-- ------------------------------------------------ withdraw consent + disclosure --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ select public.set_home_passport_pilot_settings(false, false) $$, 'manager withdraws the contributor opt-in');
reset role;
select is((select count(*)::int from public.home_passport_share_links where account_owner_id = '00000000-0000-0000-0000-0000000000a1' and revoked_at is null), 0,
  'withdrawing the opt-in revoked every live link');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.create_home_passport_snapshot('00000000-0000-0000-0000-0000000000c1', 'city', null) $$, 'P0001', 'HPP_OPT_IN_REQUIRED',
  'no new snapshot after the opt-in is withdrawn');
select lives_ok($$ select public.set_home_passport_pilot_settings(true, true) $$, 'manager opts back in and chooses to show the company name');
reset role;
update public.profiles set company_name = 'Acme HVAC' where id = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$ insert into t_snap3 select public.create_home_passport_snapshot('00000000-0000-0000-0000-0000000000c1', 'full', null) $$, 'snapshot with explicit full address is created');
reset role;
select is((select snapshot ->> 'serviced_by' from public.home_passport_snapshots where id = (select (r ->> 'snapshot_id')::uuid from t_snap3)), 'Acme HVAC',
  'company name appears only after the contractor chose to show it');
select is((select snapshot -> 'property' ->> 'address' from public.home_passport_snapshots where id = (select (r ->> 'snapshot_id')::uuid from t_snap3)), '12 Main Street',
  'full address appears only when explicitly chosen');

select * from finish();
rollback;
