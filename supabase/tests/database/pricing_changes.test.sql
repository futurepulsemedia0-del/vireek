-- Pricing change control: pricing_changes audit table (pgTAP). Run with:  supabase test db
-- Covers: RLS/privileges, staff-only RPCs, two-person rule, approver allow-list, counsel + notice gates,
-- append-only guard (UPDATE/DELETE/TRUNCATE), terminal states, deploy marking, reference format.
begin;
create extension if not exists pgtap with schema extensions;
select plan(43);

-- ---- fixtures ---------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@test.dev'),
  ('00000000-0000-0000-0000-0000000000b1', 'b1@test.dev'),
  ('00000000-0000-0000-0000-0000000000c1', 'c1@test.dev'),
  ('00000000-0000-0000-0000-0000000000d1', 'd1@test.dev');
insert into profiles (id, email, role, is_staff) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@test.dev', 'owner', true),
  ('00000000-0000-0000-0000-0000000000b1', 'b1@test.dev', 'owner', true),
  ('00000000-0000-0000-0000-0000000000c1', 'c1@test.dev', 'owner', true),
  ('00000000-0000-0000-0000-0000000000d1', 'd1@test.dev', 'owner', false);
-- a1 and b1 may approve; c1 is staff but not an approver; d1 is a customer.
insert into pricing_change_approvers (user_id) values
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b1');
-- (no cleanup: pricing_changes is append-only; the whole test is rolled back at the end)

-- ---- 1. RLS and privileges ----------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.pricing_changes'::regclass), 'RLS enabled on pricing_changes');
select ok((select relrowsecurity from pg_class where oid = 'public.pricing_change_approvers'::regclass), 'RLS enabled on pricing_change_approvers');
select ok(not has_table_privilege('authenticated', 'public.pricing_changes', 'select'), 'customers/staff clients cannot read the table directly');
select ok(not has_table_privilege('authenticated', 'public.pricing_changes', 'insert'), 'clients cannot insert directly');
select ok(not has_function_privilege('authenticated', 'public._pricing_assert_staff()', 'execute'), 'internal helper is not callable by clients');

-- ---- 2. propose --------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
set local role authenticated;
select throws_ok(
  $$select public.staff_pricing_change_propose('Raise starter', 'Starter price moves from 99 to 109.', current_date + 60, 'grandfathered', array['starter'], 30)$$,
  '42501', 'forbidden', 'a non-staff user cannot propose');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;
select lives_ok(
  $$select public.staff_pricing_change_propose('Raise starter', 'Starter price moves from 99 to 109.', current_date + 60, 'grandfathered', array['starter'], 30)$$,
  'staff can propose a change');
select throws_ok(
  $$select public.staff_pricing_change_propose('Back-dated', 'Trying to back-date a price change.', current_date - 1, 'immediate')$$,
  '22023', 'effective_date_in_past', 'a new change cannot be back-dated');
select throws_ok(
  $$select public.staff_pricing_change_propose('Bad rule', 'Grandfathering value is not allowed.', current_date + 5, 'whatever')$$,
  '23514', null, 'unknown grandfathering value is rejected by the database');
select throws_ok(
  $$select public.staff_pricing_change_propose('Baseline with notice', 'A baseline cannot carry a notice period.', current_date - 1, 'not_applicable', '{}', 30, 'baseline')$$,
  '22023', 'baseline_has_no_notice', 'baseline has no notice period');
reset role;

select like((select change_ref from pricing_changes where title = 'Raise starter'), 'PC-____-____', 'reference looks like PC-YYYY-NNNN');
select is((select requested_by_email from pricing_changes where title = 'Raise starter'), 'a1@test.dev', 'requester email is snapshotted');
select set_config('t.a', (select id::text from pricing_changes where title = 'Raise starter'), true);

-- ---- 3. approval gates --------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
set local role authenticated;
select throws_ok($$select public.staff_pricing_change_decide(current_setting('t.a')::uuid, 'approve')$$, '42501', 'not_an_approver', 'staff outside the approver list cannot decide');
select throws_ok($$select public.staff_pricing_change_set_counsel(current_setting('t.a')::uuid, 'completed')$$, '42501', 'forbidden', 'only approvers can record counsel review as completed');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
set local role authenticated;
select throws_ok($$select public.staff_pricing_change_decide(current_setting('t.a')::uuid, 'approve')$$, '22023', 'counsel_review_required', 'notice-requiring change cannot be approved before counsel review is completed');
select lives_ok($$select public.staff_pricing_change_set_counsel(current_setting('t.a')::uuid, 'completed')$$, 'approver records counsel review');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;
select throws_ok($$select public.staff_pricing_change_decide(current_setting('t.a')::uuid, 'approve')$$, '42501', 'two_person_rule', 'requester cannot approve their own change even as an approver');
select lives_ok(
  $$select public.staff_pricing_change_propose('Short notice', 'Effective date is inside the notice window.', current_date + 10, 'immediate', array['all'], 30)$$,
  'second change proposed (notice window too short)');
reset role;
select set_config('t.b', (select id::text from pricing_changes where title = 'Short notice'), true);
select is((select substr(change_ref, 9)::int from pricing_changes where title = 'Short notice') - (select substr(change_ref, 9)::int from pricing_changes where title = 'Raise starter'), 1, 'references are allocated sequentially');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
set local role authenticated;
select lives_ok($$select public.staff_pricing_change_set_counsel(current_setting('t.b')::uuid, 'completed')$$, 'counsel marked complete on the short-notice change');
select throws_ok($$select public.staff_pricing_change_decide(current_setting('t.b')::uuid, 'approve')$$, '22023', 'notice_period_too_short', 'effective date must be at least notice_days after approval');
select lives_ok($$select public.staff_pricing_change_decide(current_setting('t.a')::uuid, 'approve', 'ok')$$, 'a different approver approves the first change');
reset role;

select is((select status from pricing_changes where id = current_setting('t.a')::uuid), 'approved', 'status is approved');
select is((select approved_by_email from pricing_changes where id = current_setting('t.a')::uuid), 'b1@test.dev', 'approver email is recorded');

-- ---- 4. append-only guard ----------------------------------------------------
select throws_ok($$update pricing_changes set title = 'rewritten' where id = current_setting('t.a')::uuid$$, '42501', 'pricing_changes_immutable_field', 'descriptive fields cannot be edited');
select throws_ok($$update pricing_changes set effective_date = current_date + 400 where id = current_setting('t.a')::uuid$$, '42501', 'pricing_changes_immutable_field', 'effective date cannot be edited');
select throws_ok($$delete from pricing_changes where id = current_setting('t.a')::uuid$$, '42501', 'pricing_changes_append_only', 'rows cannot be deleted');
select throws_ok($$truncate public.pricing_changes$$, '42501', 'pricing_changes_append_only', 'the table cannot be truncated');
select throws_ok(
  $$insert into pricing_changes (change_ref, title, summary, grandfathering, effective_date, requested_by, approved_by, approved_at, status)
    values ('PC-2026-9999', 'Self approved', 'Requester equals approver in a direct insert.', 'immediate', current_date,
            '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', now(), 'approved')$$,
  '23514', null, 'the database itself rejects approver = requester');

-- ---- 5. withdraw, terminal states, reject -----------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;
select throws_ok($$select public.staff_pricing_change_mark_effective(current_setting('t.a')::uuid, 'abcdef1', jsonb_build_object('src/lib/pricing.ts', repeat('a', 64)))$$, '22023', 'not_yet_effective', 'cannot mark effective before the effective date');
select lives_ok($$select public.staff_pricing_change_withdraw(current_setting('t.a')::uuid, 'plan changed')$$, 'requester can withdraw an approved change');
reset role;
select throws_ok($$update pricing_changes set status = 'approved' where id = current_setting('t.a')::uuid$$, '42501', 'pricing_changes_terminal_state', 'withdrawn is terminal');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;
select lives_ok($$select public.staff_pricing_change_propose('Reject me', 'This one will be rejected by the approver.', current_date + 90, 'migrate_at_renewal')$$, 'third change proposed');
reset role;
select set_config('t.c', (select id::text from pricing_changes where title = 'Reject me'), true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
set local role authenticated;
select throws_ok($$select public.staff_pricing_change_decide(current_setting('t.c')::uuid, 'reject')$$, '22023', 'note_required', 'a rejection needs a reason');
select lives_ok($$select public.staff_pricing_change_decide(current_setting('t.c')::uuid, 'reject', 'not now')$$, 'approver rejects with a reason');
reset role;
select is((select status from pricing_changes where id = current_setting('t.c')::uuid), 'rejected', 'status is rejected');

-- ---- 6. baseline -> effective ------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;
select lives_ok($$select public.staff_pricing_change_propose('Baseline', 'Pricing files as they stood when control started.', current_date - 1, 'not_applicable', '{}', null, 'baseline')$$, 'baseline can have a past effective date');
reset role;
select set_config('t.d', (select id::text from pricing_changes where title = 'Baseline'), true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
set local role authenticated;
select lives_ok($$select public.staff_pricing_change_decide(current_setting('t.d')::uuid, 'approve')$$, 'baseline approved');
select throws_ok($$select public.staff_pricing_change_mark_effective(current_setting('t.d')::uuid, 'abcdef1', jsonb_build_object('src/lib/pricing.ts', 'not-a-hash'))$$, '22023', 'invalid_fingerprints', 'fingerprints must be sha256 hex');
select lives_ok($$select public.staff_pricing_change_mark_effective(current_setting('t.d')::uuid, 'abcdef1234', jsonb_build_object('src/lib/pricing.ts', repeat('a', 64)))$$, 'approved change can be marked effective with commit + fingerprints');
reset role;
select is((select status from pricing_changes where id = current_setting('t.d')::uuid), 'effective', 'status is effective');

-- ---- 7. list ------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
set local role authenticated;
select is((select jsonb_array_length(public.staff_pricing_changes_list(50, null)) >= 4), true, 'staff can list all changes');
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
set local role authenticated;
select throws_ok($$select public.staff_pricing_changes_list(50, null)$$, '42501', 'forbidden', 'a non-staff user cannot list');
reset role;

select * from finish();
rollback;
