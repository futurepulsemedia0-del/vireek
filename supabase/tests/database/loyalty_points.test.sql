-- Loyalty points: earn on paid invoice, append-only ledger, redeem on invoice, idempotency,
-- no negative balance, tenant isolation (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@loyal.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other-loyal.test');

insert into public.customers (id, user_id, name, email) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Cora Customer', 'cora@loyal.test');

insert into public.invoices (id, user_id, customer_name, customer_email, line_items, tax_percent, status) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Cora Customer', 'cora@loyal.test',
   '[{"description":"Service","quantity":1,"unit_price_cents":10000}]', 0, 'sent'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'Cora Customer', 'cora@loyal.test',
   '[{"description":"Repair","quantity":1,"unit_price_cents":2000}]', 0, 'sent');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end;
$$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');

select public.save_loyalty_program(true, 100, 100, 100, 12, 1, true);
select public.save_loyalty_rule(null, 'invoice_paid', '1 point per dollar', 1, 0, null, 0, true);

-- ------------------------------------------------------------------- earn --
update public.invoices set status = 'paid' where id = '00000000-0000-0000-0000-0000000000d1';
select is((select balance_points from public.loyalty_accounts), 100, 'earn: paid $100 invoice awards 100 points');

-- ------------------------------------------------------------ append-only --
select throws_like($$update public.loyalty_ledger set points = 999$$, '%append-only%', 'ledger: update is rejected');
select throws_like($$delete from public.loyalty_ledger where kind = 'earn'$$, '%append-only%', 'ledger: delete is rejected');

-- ----------------------------------------------------------------- adjust --
select is((public.adjust_loyalty_points('00000000-0000-0000-0000-0000000000c1', 500, 'welcome bonus', 'adj-1') ->> 'balance_points')::int,
  600, 'adjust: +500 gives 600');

-- ----------------------------------------------------------------- redeem --
select throws_like($$select public.redeem_loyalty_points('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2', 3000, 'k-big')$$,
  'Not enough points%', 'redeem: more than the balance is blocked');

select is((public.redeem_loyalty_points('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2', 600, 'k-1') ->> 'applied_cents')::int,
  600, 'redeem: 600 points = $6.00 applied');

select is((public.redeem_loyalty_points('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2', 600, 'k-1') ->> 'duplicate')::boolean,
  true, 'redeem: replaying the same key is a no-op');

select is((select balance_points from public.loyalty_accounts), 0, 'redeem: balance charged exactly once');

select throws_like($$select public.redeem_loyalty_points('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2', 100, 'k-2')$$,
  'Not enough points%', 'redeem: a second redemption with an empty balance is blocked');

select is((select sum(amount_cents)::int from public.invoice_payments where invoice_id = '00000000-0000-0000-0000-0000000000d2'),
  600, 'redeem: recorded once as an invoice payment');

select throws_like($$select public.adjust_loyalty_points('00000000-0000-0000-0000-0000000000c1', -1, 'oops')$$,
  'Balance cannot go below zero', 'adjust: cannot push the balance negative');

do $$ begin perform public.adjust_loyalty_points('00000000-0000-0000-0000-0000000000c1', 1400, 'top up'); end $$;
do $$ begin perform public.redeem_loyalty_points('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2', 1400, 'k-3'); end $$;
select is((select status from public.invoices where id = '00000000-0000-0000-0000-0000000000d2'), 'paid', 'redeem: covering the balance marks the invoice paid');

select throws_like($$select public.redeem_loyalty_points('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d2', 100, 'k-4')$$,
  'This invoice is already paid%', 'redeem: a paid invoice cannot be redeemed again');

-- -------------------------------------------------------------- invariants --
select is((select sum(points)::int from public.loyalty_ledger), (select balance_points from public.loyalty_accounts),
  'ledger: sum of entries equals the balance');
select is((select count(*)::int from public.loyalty_accounts where balance_points < 0), 0, 'no account is ever negative');

-- --------------------------------------------------------------- isolation --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.loyalty_ledger), 0, 'rls: another account sees no ledger rows');

select * from finish();
rollback;
