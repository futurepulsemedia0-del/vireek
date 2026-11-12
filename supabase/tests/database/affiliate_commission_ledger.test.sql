-- Affiliate commission ledger (20290303000100): earn base, term cap, idempotency, refund/dispute clawback,
-- reinstatement, immutability, payout gate. NOT executed by the author (no Postgres in the authoring sandbox).
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000c001', 'partner@acl.test'),
  ('00000000-0000-0000-0000-00000000c002', 'referred@acl.test'),
  ('00000000-0000-0000-0000-00000000c003', 'staff@acl.test');
insert into public.profiles (id) values
  ('00000000-0000-0000-0000-00000000c002'),
  ('00000000-0000-0000-0000-00000000c003')
on conflict (id) do nothing;
update public.profiles set stripe_customer_id = 'cus_acl_1' where id = '00000000-0000-0000-0000-00000000c002';
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-00000000c003';

insert into public.partners (id, user_id, company_name, contact_name, contact_email, referral_code, status, commission_rate, commission_months)
values ('00000000-0000-0000-0000-00000000c010', '00000000-0000-0000-0000-00000000c001', 'ACL', 'A', 'a@acl.test', 'ACLTEST1', 'approved', 20, 2);
insert into public.partner_referrals (id, partner_id, referred_user_id, status)
values ('00000000-0000-0000-0000-00000000c020', '00000000-0000-0000-0000-00000000c010', '00000000-0000-0000-0000-00000000c002', 'converted');

-- earn: base = paid - tax = 7900, 20% = 1580
select is((public.record_partner_commission_for_invoice('cus_acl_1', 'in_1', 9480, 1580, 'usd', now() - interval '40 days')->>'amount_cents')::int,
  1580, 'earn = round((paid - tax) x rate)');
select is(public.record_partner_commission_for_invoice('cus_acl_1', 'in_1', 9480, 1580, 'usd')->>'status', 'duplicate', 'same invoice twice is a no-op');
select is((select commission_cents from public.partner_referrals where id = '00000000-0000-0000-0000-00000000c020'), 1580, 'rollup mirrors the ledger');
select is(public.record_partner_commission_for_invoice('cus_acl_1', 'in_2', 7900, 0, 'usd')->>'status', 'earned', 'second month earns');
select is(public.record_partner_commission_for_invoice('cus_acl_1', 'in_3', 7900, 0, 'usd')->>'reason', 'term_exhausted', 'term cap (2 months) enforced');
select is(public.record_partner_commission_for_invoice('cus_acl_1', 'in_4', 7900, 0, 'eur')->>'reason', 'non_usd', 'non-USD invoices are skipped, never converted');

-- refund: 50% of in_1 -> half of 1580; replay is a no-op; full refund tops up to 1580 total
select is((public.record_partner_commission_clawback('evt_r1', 'in_1', 'refund', 'ch_1', 4740, 9480)->>'amount_cents')::int, 790, 'partial refund claws back pro-rata');
select is(public.record_partner_commission_clawback('evt_r1', 'in_1', 'refund', 'ch_1', 4740, 9480)->>'status', 'duplicate', 'refund event replay is a no-op');
select is((public.record_partner_commission_clawback('evt_r2', 'in_1', 'refund', 'ch_1', 9480, 9480)->>'amount_cents')::int, 790, 'cumulative refund claws back only the remainder');

-- dispute on in_2: full clawback, then reinstated when won
select is((public.record_partner_commission_clawback('evt_d1', 'in_2', 'dispute', 'dp_1', 0, 0)->>'amount_cents')::int, 1580, 'dispute claws back the full commission');
select is((public.record_partner_commission_reinstatement('evt_d2', 'in_2', 'dp_1')->>'amount_cents')::int, 1580, 'dispute won reinstates it');

-- ledger is append-only
select throws_ok($$update public.partner_commission_ledger set amount_cents = 99999 where entry_type = 'earn'$$, '42501', null, 'amounts are immutable');

-- payout gate: non-staff blocked, staff blocked below the minimum
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000c001', 'role', 'authenticated')::text, true);
set local role authenticated;
select throws_ok($$select public.pay_partner_approved_commissions('00000000-0000-0000-0000-00000000c010')$$, '42501', null, 'non-staff cannot pay');
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c003', true);
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000c003', 'role', 'authenticated')::text, true);
set local role authenticated;
select throws_ok($$select public.pay_partner_approved_commissions('00000000-0000-0000-0000-00000000c010')$$, '23514', null, 'staff cannot pay below the minimum payout');
reset role;

select * from finish();
rollback;
