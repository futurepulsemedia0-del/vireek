-- Growth analytics: MRR movement classification, staff gating, privilege lockdown, attribution, experiments (pgTAP).
-- Run with:  supabase test db
-- Needs migrations 20281103000000_growth_analytics_core.sql and 20281104000000_growth_analytics_phase2.sql.
begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'u1@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'u2@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'u3@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'other@other.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@vireek.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'fresh@fresh.test');
insert into public.profiles (id, plan, created_at, is_staff) values
  ('00000000-0000-0000-0000-0000000000a1', 'pro', now() - interval '90 days', false),
  ('00000000-0000-0000-0000-0000000000a2', 'pro', now() - interval '90 days', false),
  ('00000000-0000-0000-0000-0000000000a3', 'pro', now() - interval '90 days', false),
  ('00000000-0000-0000-0000-0000000000b1', 'starter', now() - interval '90 days', false),
  ('00000000-0000-0000-0000-0000000000c1', 'starter', now() - interval '90 days', true),
  ('00000000-0000-0000-0000-0000000000d1', 'starter', now() - interval '1 day', false);

-- ---------- fixtures (FK triggers are irrelevant to the view logic; user ids exist anyway) ----------
-- u1: sub A trial -> active 10000 -> 15000 -> 12000 -> canceled; then NEW sub B 8000 (reactivation)
insert into public.subscription_facts (stripe_event_id, stripe_subscription_id, user_id, occurred_at, event_type, status, mrr_cents, currency, plan_id) values
  ('e1', 'sub_a', '00000000-0000-0000-0000-0000000000a1', '2028-01-01', 'customer.subscription.created', 'trialing', 0, 'usd', 'starter'),
  ('e2', 'sub_a', '00000000-0000-0000-0000-0000000000a1', '2028-01-15', 'customer.subscription.updated', 'active', 10000, 'usd', 'starter'),
  ('e3', 'sub_a', '00000000-0000-0000-0000-0000000000a1', '2028-02-01', 'customer.subscription.updated', 'active', 15000, 'usd', 'pro'),
  ('e4', 'sub_a', '00000000-0000-0000-0000-0000000000a1', '2028-03-01', 'customer.subscription.updated', 'active', 12000, 'usd', 'starter'),
  ('e5', 'sub_a', '00000000-0000-0000-0000-0000000000a1', '2028-04-01', 'customer.subscription.deleted', 'canceled', 0, 'usd', 'starter'),
  ('e6', 'sub_b', '00000000-0000-0000-0000-0000000000a1', '2028-05-01', 'customer.subscription.created', 'active', 8000, 'usd', 'starter');
-- u2: events inserted OUT OF ORDER (later one first); occurred_at must decide
insert into public.subscription_facts (stripe_event_id, stripe_subscription_id, user_id, occurred_at, event_type, status, mrr_cents, currency) values
  ('e8', 'sub_c', '00000000-0000-0000-0000-0000000000a2', '2028-02-10', 'customer.subscription.updated', 'canceled', 0, 'usd'),
  ('e7', 'sub_c', '00000000-0000-0000-0000-0000000000a2', '2028-02-01', 'customer.subscription.created', 'active', 5000, 'usd');
-- u3: two concurrent subscriptions: account-level movement, not per-subscription
insert into public.subscription_facts (stripe_event_id, stripe_subscription_id, user_id, occurred_at, event_type, status, mrr_cents, currency) values
  ('e9',  'sub_d', '00000000-0000-0000-0000-0000000000a3', '2028-02-01', 'customer.subscription.created', 'active', 5000, 'usd'),
  ('e10', 'sub_e', '00000000-0000-0000-0000-0000000000a3', '2028-02-05', 'customer.subscription.created', 'active', 3000, 'usd'),
  ('e11', 'sub_d', '00000000-0000-0000-0000-0000000000a3', '2028-02-20', 'customer.subscription.deleted', 'canceled', 0, 'usd');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
grant execute on function pg_temp.act_as(uuid) to public;

-- ---------- movement classification ----------
select is((select movement from growth_mrr_movements_v where stripe_event_id = 'e2'), 'new', 'trial->paid is NEW, the trial itself is not a movement');
select is((select count(*)::int from growth_mrr_movements_v where stripe_event_id = 'e1'), 0, 'trialing at 0 MRR produces no movement');
select is((select movement from growth_mrr_movements_v where stripe_event_id = 'e3'), 'expansion', 'upgrade is expansion');
select is((select delta_cents from growth_mrr_movements_v where stripe_event_id = 'e3')::int, 5000, 'expansion amount');
select is((select movement from growth_mrr_movements_v where stripe_event_id = 'e4'), 'contraction', 'downgrade is contraction');
select is((select movement from growth_mrr_movements_v where stripe_event_id = 'e5'), 'churn', 'cancel to zero is churn');
select is((select movement from growth_mrr_movements_v where stripe_event_id = 'e6'), 'reactivation', 'paying again after churn is reactivation, not new');
select is((select count(*)::int from growth_mrr_movements_v where user_id = '00000000-0000-0000-0000-0000000000a1' and movement = 'new'), 1, 'an account is NEW only once');
select is((select movement from growth_mrr_movements_v where stripe_event_id = 'e8'), 'churn', 'out-of-order events are classified by occurred_at');
select is((select movement from growth_mrr_movements_v where stripe_event_id = 'e10'), 'expansion', 'second concurrent subscription is account-level expansion');
select is((select movement from growth_mrr_movements_v where stripe_event_id = 'e11'), 'contraction', 'cancelling one of two subscriptions is contraction, not churn');
select is((select sum(delta_cents)::int from growth_mrr_movements_v where user_id = '00000000-0000-0000-0000-0000000000a3'), 3000, 'movements sum to the account closing MRR');

-- ---------- MRR rule (pure function) ----------
select is(public.growth_mrr_cents('{"price":{"unit_amount":120000,"recurring":{"interval":"year","interval_count":1}},"quantity":1}'::jsonb, 'active', null), 10000::bigint, 'yearly price is divided by 12');
select is(public.growth_mrr_cents('{"price":{"unit_amount":10000,"recurring":{"interval":"month","interval_count":1}},"quantity":1}'::jsonb, 'trialing', null), 0::bigint, 'trialing counts as 0 MRR');
select is(public.growth_mrr_cents('{"price":{"unit_amount":10000,"recurring":{"interval":"month","interval_count":1}},"quantity":1}'::jsonb, 'active', '{"coupon":{"duration":"forever","percent_off":25}}'::jsonb), 7500::bigint, 'forever percent coupon applies');
select is(public.growth_mrr_cents('{"price":{"unit_amount":10000,"recurring":{"interval":"week","interval_count":1}},"quantity":1}'::jsonb, 'active', null), 0::bigint, 'unsupported interval yields 0');

-- ---------- ingestion from billing_events is idempotent and never blocks billing ----------
update public.profiles set stripe_customer_id = 'cus_x' where id = '00000000-0000-0000-0000-0000000000b1';
select lives_ok($$ insert into public.billing_events (stripe_event_id, event_type, payload) values
  ('evt_ok', 'customer.subscription.updated',
   '{"created": 1830000000, "data": {"object": {"id": "sub_z", "customer": "cus_x", "status": "active", "currency": "usd",
     "items": {"data": [{"quantity": 1, "price": {"id": "price_1", "unit_amount": 20000, "currency": "usd", "recurring": {"interval": "month", "interval_count": 1}}}]}}}}'::jsonb) $$,
  'billing event insert succeeds');
select is((select mrr_cents from public.subscription_facts where stripe_event_id = 'evt_ok')::int, 20000, 'trigger derived the fact from the stored event');
select lives_ok($$ insert into public.billing_events (stripe_event_id, event_type, payload) values ('evt_bad', 'customer.subscription.updated', '{"data": {"object": {"id": 5}}}'::jsonb) $$, 'malformed payload cannot break the billing_events insert');
select is((select count(*)::int from public.subscription_facts where stripe_event_id = 'evt_bad'), 0, 'malformed payload produces no fact');
select is((select public.growth_backfill_subscription_facts()), 0, 'backfill is idempotent (nothing new to add)');

-- ---------- access control ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.staff_growth_mrr_bridge(current_date - 30, current_date) $$, '42501', null, 'tenant cannot read the MRR bridge');
select throws_ok($$ select * from public.subscription_facts $$, '42501', null, 'tenant cannot read subscription_facts directly');
select throws_ok($$ select public.growth_digest_snapshot() $$, '42501', null, 'tenant cannot run the service-only digest snapshot');
select throws_ok($$ select public.staff_growth_spend_upsert('google', current_date, 100, 'usd', null) $$, '42501', null, 'tenant cannot write marketing spend');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
select lives_ok($$ select public.staff_growth_mrr_bridge(current_date - 800, current_date) $$, 'staff can read the bridge');
select throws_ok($$ select public.staff_growth_mrr_bridge(current_date, current_date - 1) $$, '22023', null, 'inverted range is rejected');
select throws_ok($$ select public.staff_growth_spend_upsert('bad channel!', current_date, 100, 'usd', null) $$, '22023', null, 'channel is validated');
select lives_ok($$ select public.staff_growth_experiment_create('onb_checklist', 'Checklist', 'A shorter checklist raises activation', 'pricing', 50, 'trial_to_paid', 14, 0.05) $$, 'staff can create an experiment draft');
select throws_ok($$ select public.staff_growth_experiment_transition('onb_checklist', 'running', null, false) $$, '22023', null, 'pricing experiment cannot start without price-integrity confirmation');

select * from finish();
rollback;
