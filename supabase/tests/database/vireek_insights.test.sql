-- Vireek Insights: consent, k-anonymity floor, immutability, tiered access, API keys (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(42);

-- ---------------------------------------------------------------- fixtures --
-- A and B are two separate business owners (profiles are created by the signup trigger).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@insights.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'b@insights.test');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ------------------------------------------------------------ pure helpers --
select is(public.insights_trade_key('HVAC & Cooling'), 'hvac', 'trade key: hvac label');
select is(public.insights_trade_key('Pest Control'), 'pest-control', 'trade key: label with a space');
select is(public.insights_trade_key('Water Heater Repair'), 'plumbing', 'trade key: water heater is plumbing');
select is(public.insights_trade_key('Space Rocket Repair'), 'other', 'trade key: unknown trade is other (never published)');
select is(public.insights_shape(150, 'percent'), 100::numeric, 'shape: percent is clamped to 100');
select is(public.insights_shape(-5, 'cents'), 0::numeric, 'shape: negatives clamp to 0');
select is((select period_end from public.insights_quarter_bounds(2027, 4)), '2027-12-31'::date, 'quarter bounds: Q4 ends Dec 31');
select is((select prior_start from public.insights_quarter_bounds(2027, 1)), '2026-10-01'::date, 'quarter bounds: prior of Q1 starts Oct 1');

-- ----------------------------------------------------------------- consent --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select contribute from public.insights_set_contribution(true)), true, 'owner can opt in');
select is((select count(*)::int from public.insights_consent_log), 1, 'opt-in is written to the consent log');
select public.insights_set_contribution(true);
select is((select count(*)::int from public.insights_consent_log), 1, 'repeating the same choice does not add a log row');
select is(public.insights_can_read(), true, 'a contributing business can read member indexes');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.insights_settings), 0, 'another business cannot see these settings');
select is(public.insights_can_read(), false, 'a non-contributing business cannot read member indexes');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select contribute from public.insights_set_contribution(false)), false, 'owner can withdraw');
select is((select count(*)::int from public.insights_consent_log), 2, 'withdrawal is written to the consent log');
reset role;

select set_config('role', 'anon', true);
select throws_ok($$ select public.insights_set_contribution(true) $$, '42501', null, 'anonymous callers cannot change consent');
reset role;

-- ----------------------------------------------- publication + cell gates --
insert into public.insights_publications (id, period_label, period_start, period_end)
values ('00000000-0000-0000-0000-0000000000d1', '2026-Q1', '2026-01-01', '2026-03-31');

select throws_ok(
  $$ insert into public.insights_index_cells (publication_id, trade, region_key, metric, unit, direction, contributor_band, p25, p50, p75)
     values ('00000000-0000-0000-0000-0000000000d1', 'hvac', 'all', 'close_rate_pct', 'percent', 'higher_is_better', '10-19', 60, 50, 70) $$,
  '23514', null, 'a cell with disordered percentiles is rejected');

insert into public.insights_index_cells (id, publication_id, trade, region_key, metric, unit, direction, contributor_band, p25, p50, p75)
values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', 'all', 'all', 'close_rate_pct', 'percent', 'higher_is_better', '20-49', 30, 40, 50),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000d1', 'all', 'tx', 'close_rate_pct', 'percent', 'higher_is_better', '10-19', 28, 38, 48),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000d1', 'hvac', 'all', 'close_rate_pct', 'percent', 'higher_is_better', '10-19', 31, 41, 51);

select throws_ok(
  $$ insert into public.insights_cell_audit (cell_id, contributor_count, distinct_values, noise_scale)
     values ('00000000-0000-0000-0000-0000000000e1', 9, 5, 0.1) $$,
  '23514', null, 'the audit table refuses fewer than 10 businesses');

insert into public.insights_cell_audit (cell_id, contributor_count, distinct_values, noise_scale) values
  ('00000000-0000-0000-0000-0000000000e1', 25, 20, 0.1),
  ('00000000-0000-0000-0000-0000000000e2', 12, 9, 0.1);

select throws_ok(
  $$ select public.insights_publish('00000000-0000-0000-0000-0000000000d1') $$,
  'P0001', null, 'publish refuses a cell that has no k-anonymity audit row');

delete from public.insights_index_cells where id = '00000000-0000-0000-0000-0000000000e3';

select is((select status from public.insights_publish('00000000-0000-0000-0000-0000000000d1')), 'published', 'a fully audited draft can be published');

select throws_ok($$ update public.insights_index_cells set p50 = 41 where id = '00000000-0000-0000-0000-0000000000e1' $$,
  'P0001', null, 'a published cell cannot be edited');
select throws_ok($$ delete from public.insights_index_cells where id = '00000000-0000-0000-0000-0000000000e1' $$,
  'P0001', null, 'a published cell cannot be deleted');
select throws_ok($$ update public.insights_publications set status = 'draft' where id = '00000000-0000-0000-0000-0000000000d1' $$,
  'P0001', null, 'a published publication cannot go back to draft');

-- ----------------------------------------------------------- tiered reads --
select set_config('role', 'anon', true);
select is((select count(*)::int from public.insights_public_indexes('2026-Q1')), 1, 'the public sees national cells only');
select is((select count(*)::int from public.insights_index_cells), 0, 'the public cannot read the cells table directly');
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select public.insights_set_contribution(true);
select is((select count(*)::int from public.insights_member_indexes('2026-Q1')), 2, 'a contributor sees national and state cells');
select throws_ok($$ select * from public.insights_api_indexes('2026-Q1') $$, '42501', null, 'authenticated users cannot call the subscriber function');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.insights_member_indexes('2026-Q1')), 0, 'a non-contributor gets nothing from member indexes');
reset role;

-- ------------------------------------------------------------- retraction --
select is((select status from public.insights_retract('00000000-0000-0000-0000-0000000000d1', 'privacy review found an issue')), 'retracted', 'a published release can be retracted');

select set_config('role', 'anon', true);
select is((select count(*)::int from public.insights_public_indexes('2026-Q1')), 0, 'retracted data disappears from the public reader');
reset role;

select throws_ok($$ select public.insights_retract('00000000-0000-0000-0000-0000000000d1', 'retract it again please') $$,
  'P0001', null, 'a retracted release cannot be retracted twice');

-- -------------------------------------------------------------- generation --
select throws_ok($$ select public.insights_generate_publication(2099, 4) $$, 'P0001', null, 'an open quarter cannot be generated');
select lives_ok($$ select public.insights_generate_publication(2025, 1) $$, 'generation runs end to end with no contributors');
select lives_ok($$ select public.insights_generate_publication(2025, 1) $$, 'a draft can be regenerated');
select throws_ok(
  $$ select public.insights_publish((select id from public.insights_publications where period_label = '2025-Q1')) $$,
  'P0001', null, 'an empty draft cannot be published');

-- ---------------------------------------------------------------- API keys --
insert into public.insights_subscribers (id, name, contact_email)
values ('00000000-0000-0000-0000-0000000000f1', 'Acme Analytics', 'data@acme.test');

select set_config('t.key', (select out_api_key from public.insights_issue_api_key('00000000-0000-0000-0000-0000000000f1', 'prod key')), true);
select like(current_setting('t.key'), 'vrk_ins_%', 'issued keys carry the vrk_ins_ prefix');
select is(
  (select count(*)::int from public.insights_api_keys where key_hash = encode(sha256(convert_to(current_setting('t.key'), 'UTF8')), 'hex')),
  1, 'only the SHA-256 of the key is stored');

select is(public.insights_api_rate_ok((select id from public.insights_api_keys limit 1), 60), true, 'a fresh key is within its rate limit');
insert into public.insights_api_request_log (key_id, status)
select (select id from public.insights_api_keys limit 1), 200 from generate_series(1, 60);
select is(public.insights_api_rate_ok((select id from public.insights_api_keys limit 1), 60), false, 'a key over its limit is refused');

select is(public.insights_revoke_api_key((select id from public.insights_api_keys limit 1)), true, 'a key can be revoked');
select is(public.insights_revoke_api_key((select id from public.insights_api_keys limit 1)), false, 'revoking twice is a no-op');

select * from finish();
rollback;
