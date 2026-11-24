-- Data cooperative ledger (20290312000000). NOT executed by the author (no Postgres in the authoring sandbox).
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000d001', 'coop-a@test.invalid'),
  ('00000000-0000-0000-0000-00000000d002', 'coop-staff@test.invalid');
insert into public.profiles (id) values
  ('00000000-0000-0000-0000-00000000d001'), ('00000000-0000-0000-0000-00000000d002')
on conflict (id) do nothing;

-- pure calculation
select is(public.coop_calc_units(2500, 4, 2, 0.5, null, 0), 7.0000::numeric, 'records/1000 x rate + cohorts x rate');
select is(public.coop_calc_units(2500, 4, null, null, null, 0), 0.0000::numeric, 'NULL rates earn nothing');
select is(public.coop_calc_units(2500, 4, 2, 0.5, 10, 6), 4.0000::numeric, 'clamped to 30-day headroom');
select is(public.coop_calc_units(2500, 4, 2, 0.5, 10, 99), 0.0000::numeric, 'never negative');

-- an active rule needs counsel ref + a rate
select throws_ok($$update public.coop_benefit_rules set active = true where domain = 'outcomes'$$, '23514', null, 'cannot activate without counsel_ref and a rate');

-- accrual: consent required, idempotent
update public.coop_benefit_rules set units_per_1000_records = 2, units_per_cohort = 0.5, counsel_ref = 'TEST-REF', active = true where domain = 'outcomes';
insert into public.sde_contribution_ledger (user_id, domain, run_date, records_contributed, cohorts_contributed)
values ('00000000-0000-0000-0000-00000000d001', 'outcomes', current_date, 2500, 4);

select is(public.coop_accrue_benefits(current_date), 0, 'no consent => no accrual');
insert into public.sde_consents (user_id, domain, status, terms_version, granted_at)
values ('00000000-0000-0000-0000-00000000d001', 'outcomes', 'granted', 'test', now());
select is(public.coop_accrue_benefits(current_date), 1, 'consented => one accrual');
select is(public.coop_accrue_benefits(current_date), 0, 're-run is a no-op');
select is((select sum(units) from public.coop_benefit_ledger where user_id = '00000000-0000-0000-0000-00000000d001'), 7.0000::numeric, 'balance = 7');

-- redemption: balance check + idempotency
select is(public.coop_record_redemption('00000000-0000-0000-0000-00000000d001', 100, 'ref-1')->>'status', 'insufficient', 'cannot overspend');
select is(public.coop_record_redemption('00000000-0000-0000-0000-00000000d001', 3, 'ref-2')->>'status', 'recorded', 'redemption recorded');
select is(public.coop_record_redemption('00000000-0000-0000-0000-00000000d001', 3, 'ref-2')->>'status', 'duplicate', 'same ref twice is a no-op');

-- append-only
select throws_ok($$update public.coop_benefit_ledger set units = 1$$, '42501', null, 'ledger rows cannot be updated');

select * from finish();
rollback;
