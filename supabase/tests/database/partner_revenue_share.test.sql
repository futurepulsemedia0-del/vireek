-- Partner revenue share (20290306000100): agreements, monthly statements, payout workflow, rounding, clawbacks, RLS.
-- NOT EXECUTED by the author (no Postgres in the authoring sandbox). Run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(58);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000d001', 'partner@rvs.test'),
  ('00000000-0000-0000-0000-00000000d002', 'referred@rvs.test'),
  ('00000000-0000-0000-0000-00000000d003', 'staff@rvs.test'),
  ('00000000-0000-0000-0000-00000000d004', 'stranger@rvs.test'),
  ('00000000-0000-0000-0000-00000000d005', 'partner2@rvs.test'),
  ('00000000-0000-0000-0000-00000000d006', 'referred2@rvs.test');
insert into public.profiles (id) values
  ('00000000-0000-0000-0000-00000000d002'),
  ('00000000-0000-0000-0000-00000000d003'),
  ('00000000-0000-0000-0000-00000000d004'),
  ('00000000-0000-0000-0000-00000000d006')
on conflict (id) do nothing;
update public.profiles set stripe_customer_id = 'cus_rvs_1' where id = '00000000-0000-0000-0000-00000000d002';
update public.profiles set stripe_customer_id = 'cus_rvs_2' where id = '00000000-0000-0000-0000-00000000d006';
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-00000000d003';

-- 12.5 % so that half-cent boundaries actually occur (the 20 % cap can never produce x.5)
insert into public.partners (id, user_id, company_name, contact_name, contact_email, referral_code, status, commission_rate, commission_months, channel)
values ('00000000-0000-0000-0000-00000000d010', '00000000-0000-0000-0000-00000000d001', 'RVS Co', 'A', 'a@rvs.test', 'RVSTEST1', 'approved', 12.5, 12, 'youtube');
insert into public.partner_referrals (id, partner_id, referred_user_id, status)
values ('00000000-0000-0000-0000-00000000d020', '00000000-0000-0000-0000-00000000d010', '00000000-0000-0000-0000-00000000d002', 'converted');

-- rounding on EARN: round half away from zero, once per invoice
select is((public.record_partner_commission_for_invoice('cus_rvs_1', 'in_a', 7900, 0, 'usd', '2026-01-05')->>'amount_cents')::int,
  988, 'earn: 12.5 % of 7900 = 987.5 rounds up to 988');
select is((public.record_partner_commission_for_invoice('cus_rvs_1', 'in_b', 3333, 0, 'usd', '2026-01-20')->>'amount_cents')::int,
  417, 'earn: 12.5 % of 3333 = 416.625 rounds to 417');
select is((public.record_partner_commission_for_invoice('cus_rvs_1', 'in_c', 5000, 0, 'usd', '2026-02-10')->>'amount_cents')::int,
  625, 'earn: exact value stays exact (625)');

-- the current month is never calculable
select throws_ok($$select public.calculate_partner_payouts(date_trunc('month', now())::date, '00000000-0000-0000-0000-00000000d010')$$,
  '23514', null, 'an open month cannot be calculated');

-- Feb 2026 as service role (auth.uid() is null): in_a and in_b are past the 30-day hold at 2026-03-01, in_c is not
select is((public.calculate_partner_payouts('2026-02-15', '00000000-0000-0000-0000-00000000d010')->>'created')::int, 1,
  'monthly calculation creates one statement');
select is((select net_cents from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-02-01'),
  1405::bigint, 'net = 988 + 417 (in_c still held)');
select is((select (statement->>'held_cents')::int from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-02-01'),
  625, 'the held entry is reported, not paid');
select is((select (statement->>'rounding_mismatches')::int from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-02-01'),
  0, 'every earn line still equals round(base x rate)');
select is((select status || ':' || carry_reason from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-02-01'),
  'carried_forward:below_minimum', 'below the global minimum payout (5000) with no agreement -> carried forward');
select is((public.calculate_partner_payouts('2026-02-15', '00000000-0000-0000-0000-00000000d010')->>'created')::int, 0,
  'recalculating is idempotent (updates, never duplicates)');
select is((select count(*)::int from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-02-01'), 1,
  'still exactly one live statement for the month');

-- act as staff
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d003', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000d003', 'role', 'authenticated')::text, true);
set local role authenticated;

select throws_ok($$select public.approve_partner_payout((select id from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-02-01'))$$,
  '23514', null, 'a carried-forward statement cannot be approved');

select lives_ok($$select public.create_partner_agreement_draft('00000000-0000-0000-0000-00000000d010', 12.5, 12, 1000, '2026-01-01', 'DOC-RVS-1', 'test')$$,
  'staff can draft an agreement');
select throws_ok($$select public.activate_partner_agreement((select id from public.partner_agreements where partner_id = '00000000-0000-0000-0000-00000000d010' and version = 1), 'signed and reviewed', false)$$,
  '23514', null, 'activation without the legal-review confirmation is refused [COUNSEL]');
select throws_ok($$select public.activate_partner_agreement((select id from public.partner_agreements where partner_id = '00000000-0000-0000-0000-00000000d010' and version = 1), 'short', true)$$,
  '23514', null, 'activation needs a reason of at least 10 characters');
select is((public.activate_partner_agreement((select id from public.partner_agreements where partner_id = '00000000-0000-0000-0000-00000000d010' and version = 1), 'signed and reviewed', true)).status,
  'active', 'activation with confirmation succeeds');

select lives_ok($$select public.create_partner_agreement_draft('00000000-0000-0000-0000-00000000d010', 12.5, 12, 1000, '2026-06-01', 'DOC-RVS-2', null)$$,
  'a second draft (next version) can be created');
select is((public.activate_partner_agreement((select id from public.partner_agreements where partner_id = '00000000-0000-0000-0000-00000000d010' and version = 2), 'renewal signed and reviewed', true)).status,
  'active', 'v2 activates');
select is((select status || ':' || effective_to::text from public.partner_agreements where partner_id = '00000000-0000-0000-0000-00000000d010' and version = 1),
  'superseded:2026-06-01', 'activating v2 supersedes v1 and closes it on the new start date');
select is((select count(*)::int from public.partner_agreements where partner_id = '00000000-0000-0000-0000-00000000d010' and status = 'active'), 1,
  'never more than one active agreement per partner');

-- recalculate with the agreement (min payout 1000) -> payable
select is((public.calculate_partner_payouts('2026-02-01', '00000000-0000-0000-0000-00000000d010')->>'updated')::int, 1,
  'recalculation picks up the new agreement');
select is((select status || ':' || agreement_version::text from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-02-01'),
  'calculated:1', 'now payable and tied to agreement v1');

select lives_ok($$select public.approve_partner_payout((select id from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-02-01'))$$,
  'staff approves the statement');
select throws_ok($$select public.mark_partner_payout_paid((select id from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-02-01'), 'bank_transfer', '')$$,
  '23514', null, 'marking paid needs a payment reference');
select is((public.mark_partner_payout_paid((select id from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-02-01'), 'bank_transfer', 'WIRE-0001')).status,
  'paid', 'marking paid succeeds');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);

select cmp_ok((select count(*)::int from public.audit_log where action = 'partner_agreement_activated' and user_id = '00000000-0000-0000-0000-00000000d001'), '>=', 1,
  'agreement activation is written to the audit log (readable here as table owner; audit_log RLS is owner-only)');
select throws_ok($$update public.partner_agreements set revenue_share_pct = 5 where partner_id = '00000000-0000-0000-0000-00000000d010' and version = 1$$,
  '42501', null, 'activated agreement terms are immutable (trigger)');
select is((select count(*)::int from public.partner_commission_ledger where stripe_invoice_id in ('in_a', 'in_b') and status = 'paid'), 2,
  'exactly the statement entries became paid in the ledger');
select is((select status from public.partner_commission_ledger where stripe_invoice_id = 'in_c'), 'pending', 'the held entry stays unpaid');
select is((public.calculate_partner_payouts('2026-02-01', '00000000-0000-0000-0000-00000000d010')->>'locked')::int, 1,
  'a paid statement is locked against recalculation');
select throws_ok($$update public.partner_payouts set net_cents = 1 where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-02-01'$$,
  '42501', null, 'a paid payout is immutable');
select throws_ok($$delete from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010'$$,
  '42501', null, 'payouts can never be deleted');

-- CLAWBACK AFTER PAYOUT: a refund of in_a booked in March, then a dispute on in_b; both are negative entries
insert into public.partner_commission_ledger (partner_id, referral_id, entry_type, amount_cents, stripe_invoice_id, stripe_event_id, source_kind, source_ref, reason, earned_at)
values
  ('00000000-0000-0000-0000-00000000d010', '00000000-0000-0000-0000-00000000d020', 'clawback', -494, 'in_a', 'evt_rvs_cb1', 'refund', 'ch_rvs_1', 'refund', '2026-03-10'),
  ('00000000-0000-0000-0000-00000000d010', '00000000-0000-0000-0000-00000000d020', 'clawback', -800, 'in_b', 'evt_rvs_cb2', 'dispute', 'dp_rvs_1', 'dispute', '2026-03-20');
-- March (as of Apr 1): in_c is past its hold (Feb 10 + 30d = Mar 12); both negative entries are earlier than Apr 1
select is((public.calculate_partner_payouts('2026-03-01', '00000000-0000-0000-0000-00000000d010')->>'created')::int, 1, 'March statement created');
select is((select net_cents from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-03-01'),
  (625 - 494 - 800)::bigint, 'clawbacks after a payout are netted against the next statement (625 - 494 - 800)');
select is((select status || ':' || carry_reason from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-03-01'),
  'carried_forward:negative_balance', 'clawbacks larger than the balance carry forward as a negative balance; nothing is paid');
select is((select (statement->>'carried_in_cents')::int from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-03-01'),
  625, 'carried-in shows entries earned before the month');

-- April: a new earn lifts the running balance over the minimum; the older negatives are netted into it
select is((public.record_partner_commission_for_invoice('cus_rvs_1', 'in_d', 20000, 0, 'usd', '2026-03-25')->>'amount_cents')::int, 2500,
  'new earn 12.5 % of 20000 = 2500');
select is((public.calculate_partner_payouts('2026-04-01', '00000000-0000-0000-0000-00000000d010')->>'created')::int, 1, 'April statement created');
select is((select gross_cents::text || '/' || clawback_cents::text || '/' || net_cents::text from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-04-01'),
  '3125/-1294/1831', 'April: gross 625+2500, clawbacks -494-800, net 1831');
select is((select status from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-04-01'),
  'calculated', 'April clears the agreement minimum');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d003', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000d003', 'role', 'authenticated')::text, true);
set local role authenticated;
select lives_ok($$select public.approve_partner_payout((select id from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-04-01'))$$, 'April approved');
select lives_ok($$select public.mark_partner_payout_paid((select id from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d010' and period_start = '2026-04-01'), 'bank_transfer', 'WIRE-0002')$$, 'April paid');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
select is((select count(*)::int from public.partner_commission_ledger where entry_type = 'clawback' and status = 'paid' and stripe_event_id in ('evt_rvs_cb1', 'evt_rvs_cb2')), 2,
  'the clawbacks are settled by the payout that netted them');
select is((public.calculate_partner_payouts('2026-03-01', '00000000-0000-0000-0000-00000000d010')->>'locked')::int, 1,
  'March (older than the paid April statement) is frozen');

-- pro-rata clawback rounding through the real function: in_c = 625, refunds in thirds of 10000
select is((public.record_partner_commission_clawback('evt_rvs_r1', 'in_c', 'refund', 'ch_rvs_2', 3333, 10000)->>'amount_cents')::int, 208,
  'refund 33.33 %: 625 x 0.3333 = 208.31 -> 208');
select is((public.record_partner_commission_clawback('evt_rvs_r2', 'in_c', 'refund', 'ch_rvs_2', 6667, 10000)->>'amount_cents')::int, 209,
  'cumulative 66.67 %: target 417, only the remainder (209) is clawed back');
select is((public.record_partner_commission_clawback('evt_rvs_r3', 'in_c', 'refund', 'ch_rvs_2', 10000, 10000)->>'amount_cents')::int, 208,
  'full refund tops up to exactly the original commission');
select is((public.record_partner_commission_clawback('evt_rvs_r4', 'in_c', 'refund', 'ch_rvs_2', 12000, 10000)->>'status'), 'noop',
  'an over-refund can never claw back more than was earned');
select is((select -sum(amount_cents)::int from public.partner_commission_ledger where stripe_invoice_id = 'in_c' and entry_type = 'clawback'), 625,
  'total clawed back equals the commission exactly (no rounding drift)');

-- ad-hoc payout button leaves a payout record (second partner, 20 % of 30000 = 6000 >= 5000 minimum)
insert into public.partners (id, user_id, company_name, contact_name, contact_email, referral_code, status, commission_rate, commission_months)
values ('00000000-0000-0000-0000-00000000d011', '00000000-0000-0000-0000-00000000d005', 'RVS Two', 'B', 'b@rvs.test', 'RVSTEST2', 'approved', 20, 12);
insert into public.partner_referrals (id, partner_id, referred_user_id, status)
values ('00000000-0000-0000-0000-00000000d021', '00000000-0000-0000-0000-00000000d011', '00000000-0000-0000-0000-00000000d006', 'converted');
select is(public.record_partner_commission_for_invoice('cus_rvs_2', 'in_x', 30000, 0, 'usd', now() - interval '40 days')->>'status', 'earned', 'second partner earns 6000 (20 % of 30000)');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d003', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000d003', 'role', 'authenticated')::text, true);
set local role authenticated;
select is((public.pay_partner_approved_commissions('00000000-0000-0000-0000-00000000d011')->>'paid_cents')::int, 6000, 'ad-hoc payout still pays the payable balance');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
select is((select source || ':' || status || ':' || net_cents::text from public.partner_payouts where partner_id = '00000000-0000-0000-0000-00000000d011'),
  'adhoc:paid:6000', 'and is now recorded as an ad-hoc payout row');

-- admin-only: RLS and function gates
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d001', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000d001', 'role', 'authenticated')::text, true);
set local role authenticated;
select is((select count(*)::int from public.partner_payouts), 0, 'a partner cannot read payouts, not even their own (RLS)');
select is((select count(*)::int from public.partner_agreements), 0, 'a partner cannot read agreements (RLS)');
select throws_ok($$insert into public.partner_payouts (partner_id, source, period_start, period_end) values ('00000000-0000-0000-0000-00000000d010', 'monthly', '2025-01-01', '2025-01-31')$$,
  '42501', null, 'authenticated users cannot insert payouts directly');
select throws_ok($$select public.calculate_partner_payouts('2026-02-01')$$, '42501', null, 'non-staff cannot run the calculation');
select throws_ok($$select public.staff_partner_statement(gen_random_uuid())$$, '42501', null, 'non-staff cannot read a statement');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
set local role anon;
select throws_ok($$select count(*) from public.partner_payouts$$, '42501', null, 'anon has no access to payouts');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);

select * from finish();
rollback;
