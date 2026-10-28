-- Card transaction feed: matching, RLS, receipt rules (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---------------------------------------------------------------- fixtures --
-- A = owner, T = technician of A, N = another technician of A (no purchases), B = owner of ANOTHER account.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@acme.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'other-tech@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@acme.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{}'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1', 'other-tech@acme.test', 'Nina Other', 'technician',
   '00000000-0000-0000-0000-0000000000a4', 'active', '{}');

insert into public.vehicles (id, user_id, label, license_plate, status) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Truck 1', 'ABC-123', 'active');
insert into public.vehicle_assignments (user_id, vehicle_id, technician_id, technician_name, assigned_at) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c3', 'Tom Tech', '2026-01-01 00:00+00');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.act_as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ------------------------------------------------------------------- setup --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');

select isnt(public.save_company_card(null, 'Truck 1 fuel', 'fuel', 'WEX', '1111', '00000000-0000-0000-0000-0000000000d1', null, 'active', null), null, 'a fuel card is saved');
select isnt(public.save_company_card(null, 'Tom Ramp', 'expense', 'Ramp', '2222', null, '00000000-0000-0000-0000-0000000000c3', 'active', null), null, 'an expense card is saved');
select throws_ok($$ select public.save_company_card(null, 'Bad', 'expense', 'x', '12', null, null, 'active', null) $$, '22023', null, 'last 4 must be 4 digits');
select throws_ok($$ select public.save_company_card(null, 'Dup', 'fuel', 'wex', '1111', null, null, 'active', null) $$, '22023', null, 'the same provider + last 4 cannot be added twice');

select is((public.import_card_transactions('csv', 'test.csv', jsonb_build_array(
  jsonb_build_object('line', 2, 'transaction_at', '2026-10-01T10:00', 'card_last4', '1111', 'amount', 50.00, 'merchant', 'Shell', 'kind', 'fuel', 'external_id', 'x1'),
  jsonb_build_object('line', 3, 'transaction_at', '2026-10-01T11:00', 'card_last4', '2222', 'amount', 120.00, 'merchant', 'Home Depot', 'kind', 'expense', 'external_id', 'x2'),
  jsonb_build_object('line', 4, 'transaction_at', '2026-10-02T09:00', 'plate', 'abc 123', 'amount', 30.00, 'merchant', 'Wawa', 'kind', 'fuel', 'external_id', 'x3'),
  jsonb_build_object('line', 5, 'transaction_at', '2026-10-02T12:00', 'card_last4', '9999', 'amount', 15.00, 'merchant', 'Staples', 'external_id', 'x4'),
  jsonb_build_object('line', 6, 'transaction_at', '2026-10-02T13:00', 'card_last4', '1111', 'amount', -20.00, 'merchant', 'Refund', 'external_id', 'x5'),
  jsonb_build_object('line', 7, 'transaction_at', 'not a date', 'card_last4', '1111', 'amount', 5.00)
), 'UTC') ->> 'inserted')::int, 4, 'four valid purchases are inserted');

-- ---------------------------------------------------------------- matching --
select pg_temp.act_as_admin();

select is((select technician_id from public.card_transactions where external_id = 'x1'), '00000000-0000-0000-0000-0000000000c3'::uuid, 'card -> vehicle -> the technician assigned at purchase time');
select is((select vehicle_id from public.card_transactions where external_id = 'x1'), '00000000-0000-0000-0000-0000000000d1'::uuid, 'the card''s vehicle is used');
select is((select match_method from public.card_transactions where external_id = 'x1'), 'card', 'matched by card');
select is((select kind from public.card_transactions where external_id = 'x1'), 'fuel', 'the card decides the kind');
select is((select technician_id from public.card_transactions where external_id = 'x2'), '00000000-0000-0000-0000-0000000000c3'::uuid, 'the card holder is the technician');
select is((select kind from public.card_transactions where external_id = 'x2'), 'expense', 'an expense card stays an expense');
select is((select match_method from public.card_transactions where external_id = 'x3'), 'plate', 'no card -> matched by licence plate (formatting ignored)');
select is((select technician_id from public.card_transactions where external_id = 'x3'), '00000000-0000-0000-0000-0000000000c3'::uuid, 'plate -> vehicle -> technician');
select is((select technician_id from public.card_transactions where external_id = 'x4'), null, 'an unknown card stays unassigned');
select is((select flags from public.card_transactions where external_id = 'x4'), array['unregistered_card', 'no_driver'], 'and is flagged');
select is((select receipt_status from public.card_transactions where external_id = 'x1'), 'required', 'a receipt is required by default');
select ok((select receipt_due_at from public.card_transactions where external_id = 'x1') = '2026-10-08 10:00+00', 'due 7 days after the purchase');
select is((select amount_cents from public.card_transactions where external_id = 'x2'), 12000, 'money is stored in cents');

-- re-importing the same rows is a no-op
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((public.import_card_transactions('csv', 'again.csv', jsonb_build_array(
  jsonb_build_object('transaction_at', '2026-10-01T10:00', 'card_last4', '1111', 'amount', 50.00, 'external_id', 'x1')), 'UTC') ->> 'duplicates')::int, 1, 'a repeated purchase is skipped');

-- registering the missing card re-matches existing purchases
select public.save_company_card(null, 'Staples card', 'expense', 'other', '9999', null, '00000000-0000-0000-0000-0000000000c4', 'active', null);
select pg_temp.act_as_admin();
select is((select technician_id from public.card_transactions where external_id = 'x4'), '00000000-0000-0000-0000-0000000000c4'::uuid, 'adding the card re-matches the purchase');
select is((select flags from public.card_transactions where external_id = 'x4'), array[]::text[], 'and clears the flags');

-- a manual assignment survives re-matching
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is(public.cardfeed_assign(array[(select id from public.card_transactions where external_id = 'x4')], '00000000-0000-0000-0000-0000000000c3', null), 1, 'a manager can assign by hand');
select public.save_company_card(null, 'Another', 'expense', 'other2', '9999', null, null, 'active', null);
select pg_temp.act_as_admin();
select is((select technician_id from public.card_transactions where external_id = 'x4'), '00000000-0000-0000-0000-0000000000c3'::uuid, 'the manual assignment is kept');

-- --------------------------------------------------------------------- RLS --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*) from public.card_transactions)::int, 4, 'the technician sees only the purchases matched to them');
select throws_ok($$ select public.import_card_transactions('csv', 'x.csv', '[{"transaction_at":"2026-10-01T10:00","card_last4":"1111","amount":5}]'::jsonb) $$, '42501', null, 'a technician cannot import');
select throws_ok($$ select public.cardfeed_waive_receipt(array[gen_random_uuid()], 'because') $$, '42501', null, 'a technician cannot waive receipts');
select throws_ok($$ update public.card_transactions set receipt_status = 'waived' $$, '42501', null, 'direct writes are blocked');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*) from public.card_transactions)::int, 0, 'another technician sees nothing');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*) from public.card_transactions)::int, 0, 'another account sees nothing');
select is((select count(*) from public.company_cards)::int, 0, 'and no cards');

-- ----------------------------------------------------------------- receipts --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok(
  format($$ select public.cardfeed_submit_receipt(%L, '{"receipt_path":"a/b/c.jpg","amount_cents":99999,"category_id":"%s"}'::jsonb) $$,
    (select id from public.card_transactions where external_id = 'x1'), gen_random_uuid()),
  '22023', null, 'a receipt total far from the card charge is refused');
select throws_ok(
  format($$ select public.cardfeed_submit_receipt(%L, '{"amount_cents":5000}'::jsonb) $$,
    (select id from public.card_transactions where external_id = 'x1')),
  '22023', 'Attach a photo or PDF of the receipt', 'a receipt file is required');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.cardfeed_waive_receipt(array[gen_random_uuid()], 'x') $$, '22023', null, 'waiving needs a reason');
select is(public.cardfeed_waive_receipt(array[(select id from public.card_transactions where external_id = 'x2')], 'Cash-back adjustment'), 1, 'a manager can waive with a reason');
select throws_ok(
  format($$ select public.cardfeed_submit_receipt(%L, '{"receipt_path":"a/b/c.jpg"}'::jsonb) $$,
    (select id from public.card_transactions where external_id = 'x2')),
  '22023', 'A manager waived the receipt for this purchase', 'a waived purchase cannot be filed');

select * from finish();
rollback;
