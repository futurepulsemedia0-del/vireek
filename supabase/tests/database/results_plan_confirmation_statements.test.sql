-- Results Plan: customer arrival confirmation + monthly statements (pgTAP). Run with:  supabase test db
-- Migration under test: 20290307000000_results_plan_confirmation_statements.sql
-- STATUS: written without access to Postgres, NOT RUN. Assumes results_plan_rule_versions('rp-rules-v1') exists (seeded by 20280402000000).
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000c0f01', 'owner@rpcs.test'),
  ('00000000-0000-0000-0000-0000000c0f02', 'other@rpcs.test');
insert into public.results_plan_accounts (user_id, status, opted_in_at) values
  ('00000000-0000-0000-0000-0000000c0f01', 'active', now()),
  ('00000000-0000-0000-0000-0000000c0f02', 'active', now());

-- ------------------------------------------------------------ structure / privileges
select ok((select relrowsecurity from pg_class where oid = 'public.results_plan_confirmations'::regclass), 'confirmations: RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.results_plan_statements'::regclass), 'statements: RLS on');
select ok(not has_table_privilege('authenticated', 'public.results_plan_confirmations', 'insert'), 'authenticated cannot insert confirmations');
select ok(not has_table_privilege('authenticated', 'public.results_plan_statements', 'update'), 'authenticated cannot update statements');
select ok(not has_function_privilege('authenticated', 'public.rp_record_confirmation_reply(uuid,text,text)', 'execute'), 'reply RPC is service_role only');
select ok(not has_function_privilege('authenticated', 'public.rp_statement_claim_email(uuid)', 'execute'), 'email claim is service_role only');
select ok(has_function_privilege('service_role', 'public.rp_record_confirmation_reply(uuid,text,text)', 'execute'), 'service_role may record replies');
select is((select customer_confirmation_enabled from public.results_plan_accounts where user_id = '00000000-0000-0000-0000-0000000c0f01'), false, 'confirmation SMS is OFF by default (owner must opt in)');

-- ------------------------------------------------------------ idempotent enrolment
insert into public.results_plan_confirmations (user_id, job_id, customer_phone, status, sent_at)
values ('00000000-0000-0000-0000-0000000c0f01', '00000000-0000-0000-0000-0000000000a1', '+15550000001', 'sent', now());
select throws_ok($$insert into public.results_plan_confirmations (user_id, job_id, customer_phone) values ('00000000-0000-0000-0000-0000000c0f01', '00000000-0000-0000-0000-0000000000a1', '+15550000001')$$,
  '23505', null, 'one confirmation per job (UNIQUE user_id, job_id)');
select throws_ok($$insert into public.results_plan_confirmations (user_id, job_id, customer_phone) values ('00000000-0000-0000-0000-0000000c0f01', '00000000-0000-0000-0000-0000000000a9', '5550000001')$$,
  '23514', null, 'phone must be E.164');

-- ------------------------------------------------------------ YES
select is((public.rp_record_confirmation_reply('00000000-0000-0000-0000-0000000c0f01', '+15550000001', 'yes'))->>'outcome', 'confirmed', 'YES confirms');
select is((select status from public.results_plan_confirmations where job_id = '00000000-0000-0000-0000-0000000000a1'), 'confirmed', 'row is confirmed');
select is((select count(*)::int from public.proof_ledger where user_id = '00000000-0000-0000-0000-0000000c0f01' and event_type = 'customer_confirmed'), 1, 'ledger has one customer_confirmed');
select is((public.rp_record_confirmation_reply('00000000-0000-0000-0000-0000000c0f01', '+15550000001', 'yes'))->>'outcome', 'already_recorded', 'repeated YES is a no-op');
select is((select count(*)::int from public.proof_ledger where user_id = '00000000-0000-0000-0000-0000000c0f01' and event_type = 'customer_confirmed'), 1, 'still one ledger row');

-- ------------------------------------------------------------ tenant isolation
insert into public.results_plan_confirmations (user_id, job_id, customer_phone, status, sent_at)
values ('00000000-0000-0000-0000-0000000c0f01', '00000000-0000-0000-0000-0000000000a2', '+15550000002', 'sent', now());
select is((public.rp_record_confirmation_reply('00000000-0000-0000-0000-0000000c0f02', '+15550000002', 'no'))->>'handled', 'false', 'another tenant cannot answer this tenant''s question');
select is((select status from public.results_plan_confirmations where job_id = '00000000-0000-0000-0000-0000000000a2'), 'sent', 'row untouched');

-- ------------------------------------------------------------ NO => review + flag + hold marker
select is((public.rp_record_confirmation_reply('00000000-0000-0000-0000-0000000c0f01', '+15550000002', 'no'))->>'outcome', 'denied', 'NO is recorded as denied');
select is((select review_status from public.results_plan_confirmations where job_id = '00000000-0000-0000-0000-0000000000a2'), 'open', 'denial opens a review');
select is((select count(*)::int from public.results_plan_flags where user_id = '00000000-0000-0000-0000-0000000c0f01' and code = 'customer_denied_arrival'), 1, 'a staff flag was raised');

-- ------------------------------------------------------------ STOP closes open questions and leaves the opt-out flow to the caller
insert into public.results_plan_confirmations (user_id, job_id, customer_phone, status)
values ('00000000-0000-0000-0000-0000000c0f01', '00000000-0000-0000-0000-0000000000a3', '+15550000003', 'queued');
select is((public.rp_record_confirmation_reply('00000000-0000-0000-0000-0000000c0f01', '+15550000003', 'stop'))->>'handled', 'false', 'STOP is not swallowed');
select is((select skip_reason from public.results_plan_confirmations where job_id = '00000000-0000-0000-0000-0000000000a3'), 'opted_out', 'queued question is skipped as opted_out');
select throws_ok($$select public.rp_record_confirmation_reply('00000000-0000-0000-0000-0000000c0f01', '+15550000003', 'maybe')$$, 'P0001', 'invalid answer', 'only yes/no/stop are accepted');

-- ------------------------------------------------------------ staff gate
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0f01', true);
select throws_ok($$select public.rp_staff_resolve_confirmation((select id from public.results_plan_confirmations where job_id = '00000000-0000-0000-0000-0000000000a2'), true)$$,
  'P0001', 'FORBIDDEN', 'a non-staff user cannot resolve a denial');
reset role;

-- ------------------------------------------------------------ statements
insert into public.results_plan_statements (user_id, month, currency, snapshot, snapshot_sha256, line_count)
values ('00000000-0000-0000-0000-0000000c0f01', '2026-04', 'USD', '{"version":1}'::jsonb, repeat('a', 64), 0);
select throws_ok($$insert into public.results_plan_statements (user_id, month, currency, snapshot, snapshot_sha256, line_count) values ('00000000-0000-0000-0000-0000000c0f01', '2026-04', 'USD', '{}'::jsonb, repeat('b', 64), 0)$$,
  '23505', null, 'one statement per account per month (idempotent generation)');
select throws_ok($$update public.results_plan_statements set snapshot = '{"version":2}'::jsonb where month = '2026-04'$$, '42501', null, 'a generated statement is immutable');
select lives_ok($$update public.results_plan_statements set email_status = 'skipped' where month = '2026-04'$$, 'delivery columns remain writable');
update public.results_plan_statements set email_status = 'pending' where month = '2026-04';
select is(public.rp_statement_claim_email((select id from public.results_plan_statements where month = '2026-04')), true, 'first claim wins');
select is(public.rp_statement_claim_email((select id from public.results_plan_statements where month = '2026-04')), false, 'second concurrent claim loses');

select * from finish();
rollback;
