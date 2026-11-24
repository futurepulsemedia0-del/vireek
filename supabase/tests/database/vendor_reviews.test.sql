-- Vendor review register: staff-only RLS, no delete, seed from code, evidence rules, next-due maths, audit trail,
-- reminder evaluator (open / supersede / clear / retire, idempotent) and the atomic notification claim (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(122);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'staff@vireek.test'),
  ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test');
insert into public.profiles (id, plan, created_at, is_staff) values
  ('00000000-0000-0000-0000-0000000000c1', 'starter', now() - interval '60 days', true),
  ('00000000-0000-0000-0000-0000000000a1', 'pro', now() - interval '60 days', false);

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ---------- structure (as the test superuser) ----------
select ok((select relrowsecurity from pg_class where oid = 'public.vendor_reviews'::regclass), 'RLS is enabled on vendor_reviews');
select ok((select relrowsecurity from pg_class where oid = 'public.vendor_review_reminders'::regclass), 'RLS is enabled on vendor_review_reminders');
select policies_are('public', 'vendor_reviews',
  array['vendor_reviews_staff_select', 'vendor_reviews_staff_insert', 'vendor_reviews_staff_update'],
  'vendor_reviews has exactly three staff policies and no delete policy');
select policies_are('public', 'vendor_review_reminders', array['vendor_review_reminders_staff_select'],
  'reminders have a staff select policy only');
select ok(not has_table_privilege('authenticated', 'public.vendor_reviews', 'DELETE'), 'authenticated has no DELETE on vendor_reviews');
select ok(not has_table_privilege('authenticated', 'public.vendor_reviews', 'TRUNCATE'), 'authenticated has no TRUNCATE on vendor_reviews');
select ok(not has_table_privilege('authenticated', 'public.vendor_review_reminders', 'INSERT'), 'authenticated cannot write reminders');
select ok(not has_table_privilege('anon', 'public.vendor_reviews', 'SELECT'), 'anon has no SELECT on vendor_reviews');
select ok(not has_table_privilege('anon', 'public.vendor_review_reminders', 'SELECT'), 'anon has no SELECT on reminders');
select ok(not has_table_privilege('anon', 'public.vendor_review_status_v', 'SELECT'), 'anon has no SELECT on the status view');
select ok((select coalesce(reloptions @> array['security_invoker=true'], false) from pg_class where oid = 'public.vendor_review_status_v'::regclass),
  'the status view runs with the caller''s rights (security_invoker)');
select ok(not has_function_privilege('authenticated', 'public.vendor_review_evaluate_reminders(integer)', 'EXECUTE'), 'authenticated cannot run the evaluator');
select ok(not has_function_privilege('authenticated', 'public.vendor_review_claim_notifications(integer, integer)', 'EXECUTE'), 'authenticated cannot claim notifications');
select ok(has_function_privilege('service_role', 'public.vendor_review_evaluate_reminders(integer)', 'EXECUTE'), 'service_role can run the evaluator');

-- ---------- seed from code ----------
select is((select criticality from public.vendor_reviews where vendor_key = 'stripe'), 'critical', 'stripe is seeded critical (vendor-exit tier 1)');
select is((select is_subprocessor from public.vendor_reviews where vendor_key = 'stripe'), true, 'stripe is flagged as a published sub-processor');
select is((select criticality_source from public.vendor_reviews where vendor_key = 'sentry'), 'proposed', 'a vendor without a tier is a proposal');
select is((select criticality from public.vendor_reviews where vendor_key = 'zapier'), 'low', 'a tenant-chosen connector is seeded low');
select is((select count(*)::int from public.vendor_reviews where last_reviewed_on is not null or last_review_outcome is not null or evidence_links <> '[]'::jsonb), 0,
  'the seed claims no review and no evidence');
select ok((select count(*) from public.vendor_reviews) >= 49, 'every vendor found in code is seeded');

-- ---------- review state maths ----------
select is(public.vendor_review_state('active', null, null, 30, date '2025-06-01'), 'never_reviewed', 'no review and no schedule is never_reviewed');
select is(public.vendor_review_state('active', date '2024-01-01', date '2025-01-01', 30, date '2025-06-01'), 'overdue', 'a past due date is overdue');
select is(public.vendor_review_state('active', date '2024-07-01', date '2025-06-20', 30, date '2025-06-01'), 'due_soon', 'due inside the lead window is due_soon');
select is(public.vendor_review_state('active', date '2024-07-01', date '2025-07-01', 30, date '2025-06-01'), 'due_soon', 'due exactly at the end of the window is due_soon');
select is(public.vendor_review_state('active', date '2024-07-01', date '2025-07-02', 30, date '2025-06-01'), 'current', 'due one day after the window is current');
select is(public.vendor_review_state('active', null, date '2025-06-10', 30, date '2025-06-01'), 'due_soon', 'a scheduled first review inside the window is due_soon');
select is(public.vendor_review_state('active', null, date '2026-01-01', 30, date '2025-06-01'), 'current', 'a first review scheduled far ahead is not nagged');
select is(public.vendor_review_state('retired', null, null, 30, date '2025-06-01'), 'retired', 'a retired vendor is retired');
select is(public.vendor_review_state('retired', date '2024-01-01', date '2025-01-01', 30, date '2025-06-01'), 'retired', 'a retired vendor is never overdue');

-- ---------- evidence validation ----------
select ok(public.vendor_review_evidence_valid('[]'::jsonb), 'an empty list is valid');
select ok(public.vendor_review_evidence_valid('[{"label":"A","url":"https://example.test/x"}]'::jsonb), 'an https link is valid');
select ok(public.vendor_review_evidence_valid('[{"label":"A","url":"docs/vendor-exit/stripe.md"}]'::jsonb), 'a docs/ path is valid');
select ok(not public.vendor_review_evidence_valid('[{"label":"A","url":"http://example.test/x"}]'::jsonb), 'plain http is rejected');
select ok(not public.vendor_review_evidence_valid('[{"label":"A","url":"https://user:pw@example.test/x"}]'::jsonb), 'credentials in a URL are rejected');
select ok(not public.vendor_review_evidence_valid('[{"label":"A","url":"docs/../etc/passwd"}]'::jsonb), 'path traversal is rejected');
select ok(not public.vendor_review_evidence_valid('[{"label":"A","url":"https://example.test/x","extra":1}]'::jsonb), 'extra keys are rejected');
select ok(not public.vendor_review_evidence_valid('[{"label":"","url":"https://example.test/x"}]'::jsonb), 'an empty label is rejected');
select ok(not public.vendor_review_evidence_valid('[{"label":"A","url":"https://example.test/a b"}]'::jsonb), 'whitespace in a URL is rejected');
select ok(not public.vendor_review_evidence_valid('{"label":"A"}'::jsonb), 'an object instead of a list is rejected');
select ok(not public.vendor_review_evidence_valid('["x"]'::jsonb), 'a non-object element is rejected');
select ok(not public.vendor_review_evidence_valid(null), 'null is rejected');
select ok(not public.vendor_review_evidence_valid((select jsonb_agg(jsonb_build_object('label', 'x' || i, 'url', 'https://example.test/' || i)) from generate_series(1, 21) i)),
  'more than 20 links are rejected');

-- ---------- staff: recording a review ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');

select lives_ok($$ update public.vendor_reviews set last_reviewed_on = date '2025-06-30', last_review_outcome = 'satisfactory',
    evidence_links = '[{"label":"Test evidence","url":"https://example.test/review"},{"label":"Exit plan","url":"docs/vendor-exit/stripe.md"}]'::jsonb,
    notes = '  SECRETNOTE reviewed in test  '
  where vendor_key = 'stripe' $$, 'staff can record a review with evidence');
select is((select next_due_on from public.vendor_reviews where vendor_key = 'stripe'), date '2026-06-30', 'next_due_on is last review + 12 months');
select is((select notes from public.vendor_reviews where vendor_key = 'stripe'), 'SECRETNOTE reviewed in test', 'notes are trimmed');
select is((select evidence_count from public.vendor_review_status_v where vendor_key = 'stripe'), 2, 'the status view counts the evidence links');
select is((select updated_by from public.vendor_reviews where vendor_key = 'stripe'), '00000000-0000-0000-0000-0000000000c1'::uuid, 'updated_by is stamped');

select lives_ok($$ update public.vendor_reviews set review_interval_months = 24 where vendor_key = 'stripe' $$, 'staff can change the interval');
select is((select next_due_on from public.vendor_reviews where vendor_key = 'stripe'), date '2027-06-30', 'changing the interval recomputes next_due_on');
select lives_ok($$ update public.vendor_reviews set next_due_on = date '2026-12-01' where vendor_key = 'stripe' $$, 'staff can set next_due_on explicitly');
select is((select next_due_on from public.vendor_reviews where vendor_key = 'stripe'), date '2026-12-01', 'an explicit next_due_on is kept');

select lives_ok($$ update public.vendor_reviews set criticality = 'high' where vendor_key = 'stripe' $$, 'staff can change criticality');
select is((select criticality_source from public.vendor_reviews where vendor_key = 'stripe'), 'manual', 'a criticality edit is recorded as manual');

select lives_ok($$ update public.vendor_reviews set created_by = '00000000-0000-0000-0000-0000000000a1', created_at = '2000-01-01' where vendor_key = 'stripe' $$,
  'created_* edits are tolerated but ignored');
select ok((select created_at > '2020-01-01'::timestamptz and created_by is distinct from '00000000-0000-0000-0000-0000000000a1'::uuid from public.vendor_reviews where vendor_key = 'stripe'),
  'created_at and created_by are immutable');

-- ---------- staff: integrity constraints ----------
select throws_ok($$ update public.vendor_reviews set last_reviewed_on = date '2025-06-30', last_review_outcome = 'satisfactory' where vendor_key = 'groq' $$,
  '23514', null, 'a review without evidence is rejected');
select throws_ok($$ update public.vendor_reviews set last_review_outcome = 'satisfactory' where vendor_key = 'groq' $$,
  '23514', null, 'an outcome without a review date is rejected');
select throws_ok($$ update public.vendor_reviews set last_reviewed_on = date '2025-06-30',
    evidence_links = '[{"label":"e","url":"docs/vendor-exit/groq.md"}]'::jsonb where vendor_key = 'groq' $$,
  '23514', null, 'a review date without an outcome is rejected');
select throws_ok($$ update public.vendor_reviews set last_reviewed_on = date '2025-06-30', last_review_outcome = 'satisfactory',
    evidence_links = '[{"label":"e","url":"http://insecure.example.test/x"}]'::jsonb where vendor_key = 'groq' $$,
  '23514', null, 'insecure evidence links are rejected');
select throws_ok($$ update public.vendor_reviews set last_reviewed_on = date '2025-06-30', last_review_outcome = 'satisfactory',
    evidence_links = '[{"label":"e","url":"https://user:pw@example.test/x"}]'::jsonb where vendor_key = 'groq' $$,
  '23514', null, 'credentials inside an evidence URL are rejected');
select throws_ok($$ update public.vendor_reviews set last_reviewed_on = current_date + 30, last_review_outcome = 'satisfactory',
    evidence_links = '[{"label":"e","url":"docs/vendor-exit/groq.md"}]'::jsonb where vendor_key = 'groq' $$,
  '22023', null, 'a review date in the future is rejected');
select throws_ok($$ update public.vendor_reviews set next_due_on = date '2024-01-01' where vendor_key = 'stripe' $$,
  '23514', null, 'a due date before the last review is rejected');
select throws_ok($$ update public.vendor_reviews set criticality = 'urgent' where vendor_key = 'groq' $$, '23514', null, 'an unknown criticality is rejected');
select throws_ok($$ update public.vendor_reviews set review_interval_months = 0 where vendor_key = 'groq' $$, '23514', null, 'a zero interval is rejected');
select throws_ok($$ update public.vendor_reviews set review_interval_months = 37 where vendor_key = 'groq' $$, '23514', null, 'an interval above 36 months is rejected');
select throws_ok($$ insert into public.vendor_reviews (vendor_key, vendor_name, vendor_kind, criticality) values ('STRIPE', 'Dup', 'supplier', 'low') $$,
  '23505', null, 'a duplicate vendor key is rejected case-insensitively');
select throws_ok($$ insert into public.vendor_reviews (vendor_key, vendor_name, vendor_kind, criticality) values ('bad key', 'Bad', 'supplier', 'low') $$,
  '23514', null, 'a vendor key with a space is rejected');
select throws_ok($$ insert into public.vendor_reviews (vendor_key, vendor_name, vendor_kind, criticality) values ('x1', 'X', 'wizard', 'low') $$,
  '23514', null, 'an unknown vendor kind is rejected');
select throws_ok($$ insert into public.vendor_reviews (vendor_key, vendor_name, vendor_kind, criticality, created_by)
  values ('forged', 'Forged', 'supplier', 'low', '00000000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'a row cannot be attributed to another user');

-- ---------- staff: adding, retiring, reactivating ----------
select lives_ok($$ insert into public.vendor_reviews (vendor_key, vendor_name, vendor_kind, criticality, owner_role)
  values ('  New-Vendor ', '  New Vendor  ', 'supplier', 'low', '  Head of Engineering ') $$, 'staff can add a vendor');
select is((select vendor_name from public.vendor_reviews where vendor_key = 'new-vendor'), 'New Vendor', 'name is trimmed and key is lower-cased');
select is((select owner_role from public.vendor_reviews where vendor_key = 'new-vendor'), 'Head of Engineering', 'owner_role is trimmed');
select is((select created_by from public.vendor_reviews where vendor_key = 'new-vendor'), '00000000-0000-0000-0000-0000000000c1'::uuid, 'created_by defaults to the caller');
select is((select review_state from public.vendor_review_status_v where vendor_key = 'new-vendor'), 'never_reviewed', 'a new vendor is never_reviewed');
select lives_ok($$ update public.vendor_reviews set status = 'retired' where vendor_key = 'new-vendor' $$, 'staff can retire a vendor');
select is((select retired_on from public.vendor_reviews where vendor_key = 'new-vendor'), current_date, 'retiring stamps retired_on');
select is((select review_state from public.vendor_review_status_v where vendor_key = 'new-vendor'), 'retired', 'a retired vendor reports retired');
select lives_ok($$ update public.vendor_reviews set status = 'active' where vendor_key = 'new-vendor' $$, 'staff can reactivate a vendor');
select is((select retired_on from public.vendor_reviews where vendor_key = 'new-vendor'), null::date, 'reactivating clears retired_on');

-- ---------- staff: no delete, no reminder writes, no evaluator ----------
select throws_ok($$ delete from public.vendor_reviews where vendor_key = 'new-vendor' $$, '42501', null, 'even staff cannot delete a vendor');
select throws_ok($$ insert into public.vendor_review_reminders (vendor_id, kind) select id, 'overdue' from public.vendor_reviews limit 1 $$,
  '42501', null, 'staff cannot write reminders directly');
select throws_ok($$ select public.vendor_review_evaluate_reminders() $$, '42501', null, 'staff cannot call the evaluator from a client');
select lives_ok($$ select count(*) from public.vendor_review_reminders $$, 'staff can read reminders');
select ok((select count(*) from public.vendor_review_status_v) >= 49, 'staff can read the status view');

-- ---------- audit trail (read as superuser) ----------
reset role;
select is((select count(*)::int from public.staff_audit_log where metadata ->> 'view' = 'vendor_review_change'), 8, 'every successful staff write wrote one audit row (5 updates + 1 insert + retire + reactivate)');
select ok(not exists (select 1 from public.staff_audit_log where metadata::text ilike '%SECRETNOTE%'), 'audit rows never contain notes');
select ok(not exists (select 1 from public.staff_audit_log where metadata::text ilike '%example.test%'), 'audit rows never contain evidence links');

-- ---------- non-staff authenticated user (a customer account owner) ----------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.vendor_reviews), 0, 'a customer owner sees no vendors');
select is((select count(*)::int from public.vendor_review_status_v), 0, 'a customer owner sees an empty status view');
select is((select count(*)::int from public.vendor_review_reminders), 0, 'a customer owner sees no reminders');
select throws_ok($$ insert into public.vendor_reviews (vendor_key, vendor_name, vendor_kind, criticality) values ('forged2', 'Forged', 'supplier', 'low') $$,
  '42501', null, 'a customer owner cannot insert');
select lives_ok($$ update public.vendor_reviews set notes = 'hacked' $$, 'a customer owner update is filtered to zero rows (checked below)');
select throws_ok($$ select public.vendor_review_claim_notifications() $$, '42501', null, 'a customer owner cannot claim notifications');

-- ---------- anon ----------
reset role;
select pg_temp.act_as_anon();
select throws_ok($$ select count(*) from public.vendor_reviews $$, '42501', null, 'anon cannot read the register');
select throws_ok($$ select count(*) from public.vendor_review_reminders $$, '42501', null, 'anon cannot read reminders');

-- ---------- evaluator and claim (superuser; every seeded vendor is retired first so the scenario is deterministic) ----------
reset role;
select is((select count(*)::int from public.vendor_reviews where notes = 'hacked'), 0, 'the denied update left no trace');
update public.vendor_reviews set status = 'retired' where status = 'active';
insert into public.vendor_reviews (vendor_key, vendor_name, vendor_kind, criticality, last_reviewed_on, last_review_outcome, evidence_links, next_due_on) values
  ('t-overdue', 'T Overdue', 'supplier', 'high', current_date - 400, 'satisfactory', '[{"label":"e","url":"docs/vendor-exit/stripe.md"}]', current_date - 5),
  ('t-soon', 'T Soon', 'supplier', 'high', current_date - 340, 'satisfactory', '[{"label":"e","url":"docs/vendor-exit/stripe.md"}]', current_date + 10),
  ('t-current', 'T Current', 'supplier', 'low', current_date - 10, 'satisfactory', '[{"label":"e","url":"docs/vendor-exit/stripe.md"}]', null),
  ('t-never', 'T Never', 'supplier', 'medium', null, null, '[]', null);

select is((public.vendor_review_evaluate_reminders() ->> 'opened'), '3', 'the first run opens three reminders (overdue, due soon, never reviewed)');
select results_eq(
  $$ select v.vendor_key, r.kind from public.vendor_review_reminders r join public.vendor_reviews v on v.id = r.vendor_id
      where r.resolved_at is null order by v.vendor_key $$,
  $$ values ('t-never'::text, 'initial_review'::text), ('t-overdue', 'overdue'), ('t-soon', 'due_soon') $$,
  'each vendor gets the right reminder kind');
select is((select count(*)::int from public.vendor_review_reminders r join public.vendor_reviews v on v.id = r.vendor_id
            where v.vendor_key = 't-current' or v.status = 'retired'), 0, 'current and retired vendors get no reminder');
select results_eq($$ select (x ->> 'opened'), (x ->> 'resolved') from (select public.vendor_review_evaluate_reminders() as x) s $$,
  $$ values ('0'::text, '0'::text) $$, 'a second run changes nothing (idempotent)');

update public.vendor_reviews set next_due_on = current_date - 1 where vendor_key = 't-soon';
select results_eq($$ select (x ->> 'opened'), (x ->> 'resolved') from (select public.vendor_review_evaluate_reminders() as x) s $$,
  $$ values ('1'::text, '1'::text) $$, 'when due_soon becomes overdue the old reminder is superseded and a new one opens');
select is((select r.resolution from public.vendor_review_reminders r join public.vendor_reviews v on v.id = r.vendor_id
            where v.vendor_key = 't-soon' and r.kind = 'due_soon'), 'superseded', 'the due_soon reminder is superseded');
select is((select r.kind from public.vendor_review_reminders r join public.vendor_reviews v on v.id = r.vendor_id
            where v.vendor_key = 't-soon' and r.resolved_at is null), 'overdue', 'one open overdue reminder remains for the vendor');

update public.vendor_reviews set last_reviewed_on = current_date - 1, last_review_outcome = 'satisfactory',
  evidence_links = '[{"label":"e","url":"docs/vendor-exit/stripe.md"}]' where vendor_key = 't-never';
select lives_ok($$ select public.vendor_review_evaluate_reminders() $$, 'the evaluator runs after a review is recorded');
select is((select r.resolution from public.vendor_review_reminders r join public.vendor_reviews v on v.id = r.vendor_id
            where v.vendor_key = 't-never'), 'cleared', 'recording a review clears the reminder');

update public.vendor_reviews set status = 'retired' where vendor_key = 't-overdue';
select lives_ok($$ select public.vendor_review_evaluate_reminders() $$, 'the evaluator runs after a vendor is retired');
select is((select r.resolution from public.vendor_review_reminders r join public.vendor_reviews v on v.id = r.vendor_id
            where v.vendor_key = 't-overdue'), 'retired', 'retiring a vendor closes its reminder');
select is((select count(*)::int from public.vendor_review_reminders where resolved_at is null), 1, 'exactly one reminder is still open');

select results_eq($$ select jsonb_array_length(c), c -> 0 ->> 'vendor_key', c -> 0 ->> 'kind', c -> 0 ->> 'renotified'
                       from (select public.vendor_review_claim_notifications() as c) s $$,
  $$ values (1, 't-soon'::text, 'overdue'::text, 'false'::text) $$, 'the first claim returns the pending reminder');
select is(jsonb_array_length(public.vendor_review_claim_notifications()), 0, 'a second claim returns nothing (already notified)');
select is((select notification_count from public.vendor_review_reminders where resolved_at is null), 1, 'the claim counted one notification');

select lives_ok($$ update public.vendor_review_reminders set notified_at = now() - interval '8 days' where resolved_at is null $$, 'age the notification');
select results_eq($$ select jsonb_array_length(c), c -> 0 ->> 'renotified' from (select public.vendor_review_claim_notifications() as c) s $$,
  $$ values (1, 'true'::text) $$, 'an overdue reminder repeats after the re-notify window');
select is(jsonb_array_length(public.vendor_review_claim_notifications()), 0, 'and not again straight away');

select is(public.vendor_review_release_notifications(array(select id from public.vendor_review_reminders where resolved_at is null)), 1,
  'a failed send can release the claim');
select is((select notified_at is null from public.vendor_review_reminders where resolved_at is null), true, 'the released reminder is pending again');
select is((select notification_count from public.vendor_review_reminders where resolved_at is null), 1, 'the released claim is not counted');
select is(public.vendor_review_release_notifications(array(select id from public.vendor_review_reminders where resolved_at is not null limit 1)), 0,
  'releasing a closed reminder does nothing');
select is(public.vendor_review_release_notifications(null), 0, 'releasing null does nothing');

select throws_ok($$ select public.vendor_review_claim_notifications(0) $$, '22023', null, 'a zero claim limit is rejected');
select throws_ok($$ select public.vendor_review_claim_notifications(10, 0) $$, '22023', null, 'a zero re-notify window is rejected');
select throws_ok($$ select public.vendor_review_evaluate_reminders(-1) $$, '22023', null, 'a negative lead time is rejected');

select * from finish();
rollback;
