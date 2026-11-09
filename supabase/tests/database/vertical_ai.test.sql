-- Vertical AI: ontology / outcome events / tenant isolation (pgTAP).
-- Run with:  supabase test db
-- STATUS: written against the migration 20281120000000_vertical_ai_ontology_outcomes.sql; NOT RUN in the authoring
-- environment (no Postgres available there). Run it before release.
begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test');

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- ------------------------------------------------------------ ontology (global, read-only) --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select ok((select count(*) from public.vertical_ontology_entries) >= 40, 'tenant can read the seeded ontology');
select is((select count(*) from public.vertical_ontology_entries where kind = 'safety_rule' and trade = 'all')::int, 12, 'all 12 safety rules are seeded');
select is((select count(*) from public.vertical_ontology_entries where reviewed)::int, 0, 'no entry claims a licensed review that did not happen');
select is((select count(*) from public.vertical_ontology_entries where payload::text ~ '\$[0-9]')::int, 0, 'the ontology contains no dollar amounts (prices come only from the tenant price book)');
select throws_ok($$ insert into public.vertical_ontology_entries (trade, kind, key, title, payload, source, effective_on, confidence)
                    values ('hvac','symptom','x_test','t','{}'::jsonb,'s','2026-01-01',0.5) $$, '42501', null, 'a tenant cannot insert ontology rows');
select throws_ok($$ update public.vertical_ontology_entries set confidence = 1 $$, '42501', null, 'a tenant cannot update ontology rows');
select throws_ok($$ delete from public.vertical_ontology_entries $$, '42501', null, 'a tenant cannot delete ontology rows');
select set_config('role', 'anon', true);
select throws_ok($$ select * from public.vertical_ontology_entries $$, '42501', null, 'anon cannot read the ontology');
reset role;

-- check constraints
select throws_ok($$ insert into public.vertical_ontology_entries (trade, kind, key, title, payload, source, effective_on, confidence, reviewed)
                    values ('hvac','symptom','bad_review','t','{}'::jsonb,'s','2026-01-01',0.5,true) $$, '23514', null, 'reviewed=true requires reviewer and timestamp');
select throws_ok($$ insert into public.vertical_ontology_entries (trade, kind, key, title, payload, source, effective_on, confidence)
                    values ('hvac','symptom','bad_conf','t','{}'::jsonb,'s','2026-01-01',1.5) $$, '23514', null, 'confidence is bounded to 0..1');

-- ------------------------------------------------------------ outcome events (per tenant) --
select is(public.record_vertical_prediction('00000000-0000-0000-0000-0000000000a1','diagnosis','job','job-1',
  '{"cause_keys":["failed_capacitor"],"symptom_key":"no_cooling"}'::jsonb, array['onto:hvac:symptom:no_cooling@v1']) is not null, true, 'service role can record a prediction');
select is(public.record_vertical_prediction('00000000-0000-0000-0000-0000000000a1','diagnosis','job','job-1',
  '{"cause_keys":["dirty_filter"],"symptom_key":"no_cooling"}'::jsonb, '{}') is not null, true, 'a repeated prediction is an idempotent upsert, not a duplicate');
select is((select count(*) from public.vertical_outcome_events where user_id = '00000000-0000-0000-0000-0000000000a1')::int, 1, 'still exactly one row for the subject');
select is(public.record_vertical_confirmation('00000000-0000-0000-0000-0000000000a1','diagnosis','job','job-1','{"cause_key":"dirty_filter"}'::jsonb), true, 'first confirmation is recorded');
select is(public.record_vertical_confirmation('00000000-0000-0000-0000-0000000000a1','diagnosis','job','job-1','{"cause_key":"other"}'::jsonb), false, 'a second confirmation is a no-op (ground truth is immutable)');
select is(public.record_vertical_prediction('00000000-0000-0000-0000-0000000000a1','diagnosis','job','job-1','{"cause_keys":["x"]}'::jsonb, '{}'), null, 'a confirmed record cannot be overwritten by a late prediction');
select throws_ok($$ select public.record_vertical_prediction('00000000-0000-0000-0000-0000000000a1','nonsense','job','j2','{}'::jsonb,'{}') $$, '23514', null, 'unknown kind rejected');

-- ------------------------------------------------------------ tenant isolation --
select public.record_vertical_prediction('00000000-0000-0000-0000-0000000000b1','price','quote','q-9','{"quoted_cents":10000}'::jsonb,'{}');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*) from public.vertical_outcome_events)::int, 1, 'tenant A sees only its own outcome events');
select is((select count(*) from public.vertical_outcome_events where user_id = '00000000-0000-0000-0000-0000000000b1')::int, 0, 'tenant A cannot see tenant B events');
select throws_ok($$ insert into public.vertical_outcome_events (user_id, kind, subject_type, subject_id) values ('00000000-0000-0000-0000-0000000000a1','price','quote','q1') $$, '42501', null, 'a tenant cannot write events directly');
select throws_ok($$ select public.record_vertical_prediction('00000000-0000-0000-0000-0000000000a1','price','quote','q1','{}'::jsonb,'{}') $$, '42501', null, 'a tenant cannot call the writer RPCs');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*) from public.vertical_outcome_events)::int, 1, 'tenant B sees only its own event');
select is((select count(*) from public.vertical_outcome_accuracy(90) where kind = 'diagnosis')::int, 0, 'accuracy rollup is scoped to the caller (B has no diagnosis rows)');

select * from finish();
rollback;
