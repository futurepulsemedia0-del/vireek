-- Customer outcome proof kit (pgTAP): RLS, tenant isolation, immutability, consent, hash parity with the TypeScript method, staff gate.
-- Migration under test: 20290309000000_outcome_proof_kit.sql   Run with:  supabase test db
-- The expected hash below was produced by computeSnapshotHash() in src/lib/outcomeProof/method.ts for the same fixture.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---------------------------------------------------------------- fixtures --
-- A = owner, M = team member of A WITH can_view_billing, N = team member of A WITHOUT it, B = another account's owner, S = Vireek staff.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'billing@acme.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'tech@acme.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@other.test'),
  ('00000000-0000-0000-0000-0000000000f1', 'staff@vireek.test');
insert into public.team_members (id, account_owner_id, member_email, member_name, role, user_id, invite_status, permissions) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'billing@acme.test', 'Bea Billing', 'admin',
   '00000000-0000-0000-0000-0000000000a2', 'active', '{"can_view_billing": true}'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'tech@acme.test', 'Tom Tech', 'technician',
   '00000000-0000-0000-0000-0000000000a3', 'active', '{}');
update public.profiles set is_staff = true where id = '00000000-0000-0000-0000-0000000000f1';

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

-- Ledger fixture (written directly; the ledger is append-only but INSERT is allowed for the table owner).
-- e1 is measured and supersedes the estimate e2. 2026-10-10 12:00:00Z = 1791633600000 ms.
insert into public.value_events (id, user_id, source_feature, type, amount, unit, currency, confidence, method_note, evidence_ref, supersedes_ref, occurred_at) values
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'after_hours_answering', 'recovered_revenue', 50000, 'cents', 'USD', 'measured', 'paid invoice', 'jobs:a|b%c', 'est:1', '2026-10-10 12:00:00+00'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'after_hours_answering', 'recovered_revenue', 20000, 'cents', 'USD', 'estimated', 'assumption', 'est:1', null, '2026-10-10 12:00:01+00');

-- ------------------------------------------------------------ structure/RLS --
select ok((select relrowsecurity from pg_class where oid = 'public.outcome_cases'::regclass), 'outcome_cases has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.outcome_case_sources'::regclass), 'outcome_case_sources has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.outcome_case_consents'::regclass), 'outcome_case_consents has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.outcome_case_audit'::regclass), 'outcome_case_audit has RLS');
select is(has_table_privilege('authenticated', 'public.outcome_cases', 'INSERT'), false, 'no client INSERT on cases');
select is(has_table_privilege('authenticated', 'public.outcome_case_consents', 'INSERT'), false, 'no client INSERT on consents');
select is(has_table_privilege('authenticated', 'public.outcome_case_audit', 'UPDATE'), false, 'no client UPDATE on audit');
select is(has_function_privilege('anon', 'public.outcome_case_create(text,date,date,text,bigint)', 'EXECUTE'), false, 'anon cannot create');
select is(has_function_privilege('authenticated', 'public.outcome_case_canonical(uuid)', 'EXECUTE'), false, 'canonical helper is internal');

-- ------------------------------------------------------------------ create --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
create temp table t_case as
  select public.outcome_case_create('October results', '2026-10-01', '2026-10-31', 'USD', 29900) as id;
grant all on t_case to public;

select is((select count(*)::int from public.outcome_case_sources where case_id = (select id from t_case)), 2, 'both ledger events are in the snapshot');
select is((select included from public.outcome_case_sources where value_event_id = '00000000-0000-4000-8000-0000000000e1'), true, 'the measured event is included');
select is((select exclusion from public.outcome_case_sources where value_event_id = '00000000-0000-4000-8000-0000000000e2'), 'superseded_by_measured', 'the superseded estimate is excluded, not dropped');
select is((select cost_basis from public.outcome_cases where id = (select id from t_case)), 'owner_entered', 'cost basis recorded');
select is((select verification_level from public.outcome_cases where id = (select id from t_case)), 'not_independently_audited', 'default verification level is "not independently audited"');
select is((select snapshot_sha256 from public.outcome_cases where id = (select id from t_case)),
          'b9cd02c58dc1be18e48add21f0834ae5c1d92c625da0fcd9414f7b8e35e6ce76', 'SQL hash equals the TypeScript hash for the same fixture');
select is((select count(*)::int from public.outcome_case_audit where case_id = (select id from t_case) and action = 'created'), 1, 'creation is audited');

-- Input validation
select throws_ok($$ select public.outcome_case_create('x', '2026-10-01', '2026-10-31', 'USD', null) $$, '22023', null, 'title too short is refused');
select throws_ok($$ select public.outcome_case_create('October', '2026-10-01', '2026-10-31', 'usd', null) $$, '22023', null, 'bad currency is refused');
select throws_ok($$ select public.outcome_case_create('October', '2026-10-31', '2026-10-01', 'USD', null) $$, '22023', null, 'reversed period is refused');
select throws_ok($$ select public.outcome_case_create('October', '2025-01-01', '2026-10-01', 'USD', null) $$, '22023', null, 'period over 366 days is refused');
select throws_ok($$ select public.outcome_case_create('October', '2026-10-01', to_char(now() at time zone 'utc', 'YYYY-MM-DD')::date, 'USD', null) $$, '22023', null, 'a period that includes today is refused');
select throws_ok($$ select public.outcome_case_create('October', '2026-10-01', '2026-10-31', 'USD', 0) $$, '22023', null, 'zero cost is refused');

-- ---------------------------------------------------------------- isolation --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.outcome_cases), 0, 'another account sees no cases');
select is((select count(*)::int from public.outcome_case_sources), 0, 'another account sees no sources');
select throws_ok(format($$ select public.outcome_case_set_consent(%L, 'granted', false, false, false, null, 'Eve Other', null, 'draft-0', %L) $$, (select id from t_case), repeat('a', 64)),
                 '42501', null, 'another account cannot consent for this case');
select throws_ok(format($$ select public.outcome_case_log_export(%L, 'pdf') $$, (select id from t_case)), '42501', null, 'another account cannot log an export for this case');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from public.outcome_cases), 0, 'a team member without can_view_billing sees nothing');
select throws_ok($$ select public.outcome_case_create('October results', '2026-10-01', '2026-10-31', 'USD', null) $$, '42501', null, 'and cannot create a case');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.outcome_cases), 1, 'a team member with can_view_billing can read the case');
select throws_ok(format($$ select public.outcome_case_set_consent(%L, 'granted', true, false, false, null, 'Bea Billing', null, 'draft-0', %L) $$, (select id from t_case), repeat('a', 64)),
                 '42501', null, 'but only the owner can consent');
select lives_ok(format($$ select public.outcome_case_log_export(%L, 'markdown') $$, (select id from t_case)), 'a permitted member can log an export');

-- ------------------------------------------------------------------ consent --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok(format($$ select public.outcome_case_set_consent(%L, 'granted', true, false, true, 'Great service', 'Maria Ramirez', 'Owner', 'draft-0', %L) $$, (select id from t_case), repeat('a', 64)),
                'the owner can grant consent');
select is((select case_sha256 from public.outcome_case_consents where case_id = (select id from t_case) and decision = 'granted'),
          (select snapshot_sha256 from public.outcome_cases where id = (select id from t_case)), 'consent is bound to the snapshot hash');
select throws_ok(format($$ select public.outcome_case_set_consent(%L, 'granted', true, false, false, 'Quote without flag', 'Maria Ramirez', null, 'draft-0', %L) $$, (select id from t_case), repeat('a', 64)),
                 '22023', null, 'a quote without allow_quote is refused');
select throws_ok(format($$ select public.outcome_case_set_consent(%L, 'granted', true, false, false, null, ' ', null, 'draft-0', %L) $$, (select id from t_case), repeat('a', 64)),
                 '22023', null, 'a blank signer is refused');
select throws_ok(format($$ select public.outcome_case_set_consent(%L, 'granted', true, false, false, null, 'Maria Ramirez', null, 'draft-0', 'nothex') $$, (select id from t_case)),
                 '22023', null, 'a malformed consent text hash is refused');
select lives_ok(format($$ select public.outcome_case_set_consent(%L, 'revoked', true, true, true, 'ignored', 'Maria Ramirez', 'Owner', 'draft-0', %L) $$, (select id from t_case), repeat('a', 64)),
                'the owner can revoke');
select is((select allow_business_name or allow_person_name or allow_quote or quote_text is not null
             from public.outcome_case_consents where case_id = (select id from t_case) and decision = 'revoked'), false, 'a revoke row grants nothing, whatever was passed');
select is((select count(*)::int from public.outcome_case_consents where case_id = (select id from t_case)), 2, 'history is kept: grant and revoke are both rows');
select is((select count(*)::int from public.outcome_case_audit where case_id = (select id from t_case) and action in ('consent_granted', 'consent_revoked')), 2, 'both decisions are audited');

-- --------------------------------------------------------------- immutability --
select throws_ok($$ insert into public.outcome_cases (user_id, title, period_start, period_end, currency, source_count, snapshot_sha256)
                    values ('00000000-0000-0000-0000-0000000000a1', 'forged', '2026-10-01', '2026-10-31', 'USD', 0, repeat('a', 64)) $$,
                 '42501', null, 'the client cannot insert a case directly');
select throws_ok($$ update public.outcome_case_consents set allow_quote = true $$, '42501', null, 'consents cannot be updated by the client');
select pg_temp.act_as_admin();
select throws_ok($$ update public.outcome_case_consents set decision = 'granted' $$, '42501', null, 'consents cannot be updated, even by the table owner');
select throws_ok($$ delete from public.outcome_case_consents $$, '42501', null, 'consents cannot be deleted');
select throws_ok($$ truncate public.outcome_case_consents $$, '42501', null, 'consents cannot be truncated');
select throws_ok($$ update public.outcome_case_sources set amount = 1 $$, '42501', null, 'sources cannot be updated');
select throws_ok($$ delete from public.outcome_case_audit $$, '42501', null, 'the audit trail cannot be deleted');
select throws_ok($$ update public.outcome_cases set title = 'edited' $$, '42501', null, 'a case snapshot field cannot be edited');
select throws_ok($$ update public.outcome_cases set snapshot_sha256 = repeat('b', 64) $$, '42501', null, 'the snapshot hash cannot be rewritten');
select throws_ok($$ delete from public.outcome_cases $$, '42501', null, 'a case cannot be deleted directly');

-- ---------------------------------------------------------------- verification --
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok(format($$ select public.outcome_case_record_verification(%L, 'Acme Audit LLP', 'https://example.com/report', null) $$, (select id from t_case)),
                 '42501', null, 'the customer (non-staff) cannot record a verification');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000f1');
select throws_ok(format($$ select public.outcome_case_record_verification(%L, 'Acme Audit LLP', 'http://example.com/report', null) $$, (select id from t_case)),
                 '22023', null, 'verification needs an https evidence link');
select throws_ok(format($$ select public.outcome_case_record_verification(%L, '', 'https://example.com/report', null) $$, (select id from t_case)),
                 '22023', null, 'verification needs a named verifier');
select lives_ok(format($$ select public.outcome_case_record_verification(%L, 'Acme Audit LLP', 'https://example.com/report', 'engagement 2026-11') $$, (select id from t_case)),
                'staff can record a verification with a verifier and evidence');
select throws_ok(format($$ select public.outcome_case_record_verification(%L, 'Other', 'https://example.com/other', null) $$, (select id from t_case)),
                 '23505', null, 'a recorded verification cannot be replaced');
select pg_temp.act_as_admin();
select is((select verification_level from public.outcome_cases where id = (select id from t_case)), 'independently_verified', 'level is now independently_verified');
select throws_ok(format($$ update public.outcome_cases set verification_level = 'not_independently_audited', verifier_name = null,
                         verification_evidence_url = null, verified_at = null, verified_by = null where id = %L $$, (select id from t_case)),
                 '42501', null, 'a recorded verification cannot be undone');
select is((select count(*)::int from public.outcome_case_audit where case_id = (select id from t_case) and action = 'verification_recorded'), 1, 'verification is audited');

select * from finish();
rollback;
