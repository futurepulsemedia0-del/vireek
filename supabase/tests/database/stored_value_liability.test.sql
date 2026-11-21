-- Stored-value liability views (20290306000000): balances, expiry, dormancy buckets, review-period fallback,
-- ledger reconciliation, tenant isolation (RLS), settings RPC guards, state-rules defaults.
-- NOT executed by the author (no Postgres in the authoring sandbox) — run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000005a1', 'a@sv.test'),
  ('00000000-0000-0000-0000-0000000005b1', 'b@sv.test'),
  ('00000000-0000-0000-0000-0000000005c1', 'stranger@sv.test');
insert into public.profiles (id, role) values
  ('00000000-0000-0000-0000-0000000005a1', 'owner'),
  ('00000000-0000-0000-0000-0000000005b1', 'owner'),
  ('00000000-0000-0000-0000-0000000005c1', 'member')
on conflict (id) do update set role = excluded.role;

-- Tenant A: 5 gift_cards rows covering every branch
insert into public.gift_cards (id, account_owner_id, code, kind, initial_cents, balance_cents, status, expires_at, created_at) values
  ('00000000-0000-0000-0000-00000005d001', '00000000-0000-0000-0000-0000000005a1', 'SVTESTCODE01', 'gift_card',    10000, 10000, 'active', null,                          now() - interval '400 days'),
  ('00000000-0000-0000-0000-00000005d002', '00000000-0000-0000-0000-0000000005a1', 'SVTESTCODE02', 'store_credit',   5000,  4000, 'active', null,                          now() - interval '60 days'),
  ('00000000-0000-0000-0000-00000005d003', '00000000-0000-0000-0000-0000000005a1', 'SVTESTCODE03', 'gift_card',      3000,  3000, 'active', now() - interval '1 day',      now() - interval '50 days'),
  ('00000000-0000-0000-0000-00000005d004', '00000000-0000-0000-0000-0000000005a1', 'SVTESTCODE04', 'gift_card',      2500,     0, 'voided', null,                          now() - interval '90 days'),
  ('00000000-0000-0000-0000-00000005d005', '00000000-0000-0000-0000-0000000005a1', 'SVTESTCODE05', 'gift_card',      2000,  2000, 'active', null,                          now() - interval '5 days');
insert into public.gift_card_transactions (account_owner_id, gift_card_id, kind, amount_cents, balance_after_cents, created_at) values
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-00000005d001', 'issue',  10000, 10000, now() - interval '400 days'),
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-00000005d002', 'issue',   5000,  5000, now() - interval '60 days'),
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-00000005d002', 'redeem', -1000,  4000, now() - interval '10 days'),
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-00000005d003', 'issue',   3000,  3000, now() - interval '50 days'),
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-00000005d004', 'issue',   2500,  2500, now() - interval '90 days'),
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-00000005d004', 'void',   -2500,     0, now() - interval '80 days'),
  -- d005: ledger says 1500 but the card says 2000 -> must be flagged unreconciled
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-00000005d005', 'issue',   1500,  1500, now() - interval '5 days');

-- Tenant A loyalty: 5000 points at 100 points/dollar = 5000 cents
insert into public.customers (id, user_id, name) values
  ('00000000-0000-0000-0000-00000005e001', '00000000-0000-0000-0000-0000000005a1', 'Loyal Customer');
insert into public.lpts_programs (account_owner_id, enabled, redeem_points_per_dollar)
  values ('00000000-0000-0000-0000-0000000005a1', true, 100);
insert into public.lpts_accounts (id, account_owner_id, customer_id, balance_points)
  values ('00000000-0000-0000-0000-00000005f001', '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-00000005e001', 5000);
insert into public.lpts_ledger (account_owner_id, account_id, customer_id, kind, points, balance_after, created_at)
  values ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-00000005f001', '00000000-0000-0000-0000-00000005e001', 'earn', 5000, 5000, now() - interval '20 days');

-- Tenant B: one card
insert into public.gift_cards (account_owner_id, code, kind, initial_cents, balance_cents, status)
  values ('00000000-0000-0000-0000-0000000005b1', 'SVTESTCODE06', 'gift_card', 7000, 7000, 'active');
insert into public.gift_card_transactions (account_owner_id, gift_card_id, kind, amount_cents, balance_after_cents)
  select '00000000-0000-0000-0000-0000000005b1', id, 'issue', 7000, 7000 from public.gift_cards where code = 'SVTESTCODE06';

-- ---------------------------------------------------------------- views (superuser, filtered by tenant)
select is((select count(*)::int from public.stored_value_instruments_v where account_owner_id = '00000000-0000-0000-0000-0000000005a1'), 5,
  'A has 5 open instruments (voided card excluded, loyalty included)');
select is((select outstanding_cents from public.stored_value_liability_summary_v where account_owner_id = '00000000-0000-0000-0000-0000000005a1' and instrument_kind = 'gift_card'), 15000::bigint,
  'gift_card outstanding = 10000 + 3000 + 2000');
select is((select expired_cents from public.stored_value_liability_summary_v where account_owner_id = '00000000-0000-0000-0000-0000000005a1' and instrument_kind = 'gift_card'), 3000::bigint,
  'expired balance reported separately, not dropped');
select is((select unreconciled_count from public.stored_value_liability_summary_v where account_owner_id = '00000000-0000-0000-0000-0000000005a1' and instrument_kind = 'gift_card'), 1,
  'card whose ledger disagrees with its balance is flagged');
select is((select outstanding_cents from public.stored_value_liability_summary_v where account_owner_id = '00000000-0000-0000-0000-0000000005a1' and instrument_kind = 'store_credit'), 4000::bigint,
  'store_credit tracked as its own kind');
select is((select outstanding_cents from public.stored_value_liability_summary_v where account_owner_id = '00000000-0000-0000-0000-0000000005a1' and instrument_kind = 'loyalty_points'), 5000::bigint,
  'loyalty points valued at points / redeem_points_per_dollar');
select is((select count(*)::int from public.stored_value_instruments_v where instrument_id = '00000000-0000-0000-0000-00000005d004'), 0,
  'voided card never appears');
select is((select inactivity_bucket from public.stored_value_instruments_v where instrument_id = '00000000-0000-0000-0000-00000005d001'), '366_730',
  '400 days without activity lands in the 366_730 bucket');
select is((select coalesce(sum(past_review_cents), 0)::bigint from public.stored_value_liability_summary_v where account_owner_id = '00000000-0000-0000-0000-0000000005a1'), 0::bigint,
  'no review period configured -> nothing flagged');

-- tenant override: 12 months
insert into public.stored_value_settings (account_owner_id, state_code, review_period_months)
  values ('00000000-0000-0000-0000-0000000005a1', null, 12);
select is((select past_review_cents from public.stored_value_liability_summary_v where account_owner_id = '00000000-0000-0000-0000-0000000005a1' and instrument_kind = 'gift_card'), 10000::bigint,
  'tenant review period (12 months) flags only the 400-day card');

-- state rule exists but the tenant override must win
insert into public.stored_value_state_rules (state_code, instrument_kind, review_period_months) values ('CA', 'gift_card', 1);
update public.stored_value_settings set state_code = 'CA' where account_owner_id = '00000000-0000-0000-0000-0000000005a1';
select is((select past_review_cents from public.stored_value_liability_summary_v where account_owner_id = '00000000-0000-0000-0000-0000000005a1' and instrument_kind = 'gift_card'), 10000::bigint,
  'tenant override beats the state rule');

-- remove override -> state rule (1 month) applies: cards idle 400d and 50d flagged, the 5-day card is not
update public.stored_value_settings set review_period_months = null where account_owner_id = '00000000-0000-0000-0000-0000000005a1';
select is((select past_review_cents from public.stored_value_liability_summary_v where account_owner_id = '00000000-0000-0000-0000-0000000005a1' and instrument_kind = 'gift_card'), 13000::bigint,
  'state rule is the fallback when the tenant sets no period');

-- ---------------------------------------------------------------- RLS / tenant isolation
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000005a1', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000005a1","role":"authenticated"}', true);
select is((select count(*)::int from public.stored_value_liability_summary_v), 3, 'A (owner) sees only its own 3 summary rows');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000005b1', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000005b1","role":"authenticated"}', true);
select is((select coalesce(sum(outstanding_cents), 0)::bigint from public.stored_value_liability_summary_v), 7000::bigint, 'B sees only its own 7000, no cross-tenant leakage');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000005c1', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000005c1","role":"authenticated"}', true);
select is((select count(*)::int from public.stored_value_liability_summary_v), 0, 'non-manager sees nothing');
select throws_ok($$select public.set_stored_value_settings('NY', 6, false)$$, '42501', 'forbidden', 'non-manager cannot write settings');

reset role;
set local role anon;
select throws_ok($$select * from public.stored_value_instruments_v$$, '42501', null, 'anon has no access to the views');
reset role;

-- ---------------------------------------------------------------- settings RPC (as owner A)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000005a1', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000005a1","role":"authenticated"}', true);
select throws_ok($$select public.set_stored_value_settings('CAL', 6, false)$$, '22023', 'invalid_state_code', 'bad state code rejected');
select lives_ok($$select public.set_stored_value_settings(' ny ', 6, true)$$, 'owner can save settings');
reset role;
select is((select state_code from public.stored_value_settings where account_owner_id = '00000000-0000-0000-0000-0000000005a1'), 'NY', 'state code normalised to upper case');

-- ---------------------------------------------------------------- state rules defaults
select is((select marker || '/' || rule_status from public.stored_value_state_rules where state_code = 'CA' and instrument_kind = 'gift_card'), '[COUNSEL][VERIFY]/unreviewed',
  'every state rule defaults to unreviewed and carries the [COUNSEL][VERIFY] marker');
select throws_ok($$insert into public.stored_value_state_rules (state_code, instrument_kind, rule_status) values ('TX', 'gift_card', 'counsel_reviewed')$$, '23514', null,
  'a rule cannot be marked counsel_reviewed without reviewer + date');

select * from finish();
rollback;
