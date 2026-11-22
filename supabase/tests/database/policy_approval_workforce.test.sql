-- Policy approval workflow + workforce completion records (pgTAP): staff gating, hash-bound approval,
-- self-approval flag, version ordering, immutability, append-only acknowledgements, data-minimising workforce
-- records, evidence summaries privileges.
-- Migration under test: 20290306000000_policy_approval_workforce_evidence.sql
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e0a1', 'staff1@vireek.test'),
  ('00000000-0000-0000-0000-00000000e0b1', 'staff2@vireek.test'),
  ('00000000-0000-0000-0000-00000000e0c1', 'tenant@acme.test');
update public.profiles set is_staff = true where id in ('00000000-0000-0000-0000-00000000e0a1', '00000000-0000-0000-0000-00000000e0b1');

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
create or replace function pg_temp.act_as_super() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
end $$;

-- ------------------------------------------------------------ structure
select ok((select relrowsecurity from pg_class where oid = 'public.compliance_policies'::regclass), 'policies: RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.compliance_policy_versions'::regclass), 'versions: RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.compliance_policy_acknowledgements'::regclass), 'acks: RLS on');
select ok((select relrowsecurity from pg_class where oid = 'public.compliance_workforce_records'::regclass), 'workforce records: RLS on');
select is((select count(*)::int from public.compliance_policies), 16, 'sixteen policies seeded');
select is((select required from public.compliance_workforce_requirements where requirement_key = 'background_check'), false, 'background check NOT required until management decides');
select ok(not has_table_privilege('authenticated', 'public.compliance_policy_versions', 'insert'), 'no client INSERT on versions');
select ok(not has_table_privilege('authenticated', 'public.compliance_workforce_records', 'insert'), 'no client INSERT on workforce records');
select ok(not has_function_privilege('anon', 'public.staff_policy_overview()', 'execute'), 'anon cannot call staff_policy_overview');
select ok(not has_function_privilege('authenticated', 'public.compliance_policy_summary()', 'execute'), 'authenticated cannot call the evidence summary');
select ok(has_function_privilege('service_role', 'public.compliance_policy_summary()', 'execute'), 'service_role can call the evidence summary');
select ok(not has_function_privilege('authenticated', 'public.compliance_sync_policy_hashes(jsonb)', 'execute'), 'authenticated cannot sync hashes');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'compliance_workforce_records' and column_name in ('result', 'notes', 'note', 'report', 'score', 'dob', 'ssn', 'user_id')),
  'workforce records have no result / notes / report / score / id-number columns and no user_id column');

-- ------------------------------------------------------------ non-staff is refused
select pg_temp.act_as('00000000-0000-0000-0000-00000000e0c1');
select throws_ok($$select public.staff_policy_overview()$$, '42501', null, 'tenant user cannot read the overview');
select throws_ok($$select public.staff_policy_submit_version('information-security', '1.0', null)$$, '42501', null, 'tenant user cannot submit');
select is((select count(*)::int from public.compliance_policies), 0, 'tenant user sees no policy rows through RLS');
select pg_temp.act_as_anon();
select throws_ok($$select public.staff_policy_overview()$$, '42501', null, 'anon cannot call the overview');

-- ------------------------------------------------------------ hash sync (service side) and submit
select pg_temp.act_as_super();
select throws_ok($$select public.staff_policy_submit_version('information-security', '1.0', null)$$, '42501', null, 'no auth.uid() => refused');
select pg_temp.act_as('00000000-0000-0000-0000-00000000e0a1');
select throws_ok($$select public.staff_policy_submit_version('information-security', '1.0', null)$$, '55000', null, 'submit refused until the repository hash is synced');

select pg_temp.act_as_super();
select is((public.compliance_sync_policy_hashes('[{"slug":"information-security","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb) ->> 'updated')::int, 1, 'hash sync updates an existing policy');
select throws_ok($$select public.compliance_sync_policy_hashes('[{"slug":"Bad Slug","sha256":"x"}]'::jsonb)$$, '22023', null, 'hash sync rejects an invalid item');

select pg_temp.act_as('00000000-0000-0000-0000-00000000e0a1');
select throws_ok($$select public.staff_policy_submit_version('information-security', 'v1', null)$$, '22023', null, 'bad version format rejected');
select lives_ok($$select public.staff_policy_submit_version('information-security', '1.0', 'initial adoption')$$, 'staff can submit 1.0');
select throws_ok($$select public.staff_policy_submit_version('information-security', '1.1', null)$$, '55000', null, 'only one version in review at a time');

-- ------------------------------------------------------------ approval
select is((public.staff_policy_approve_version((select id from public.compliance_policy_versions where policy_slug = 'information-security' and version = '1.0')) ->> 'self_approved')::boolean, true,
  'approving your own submission is recorded as self_approved');
select is((select status from public.compliance_policy_versions where policy_slug = 'information-security' and version = '1.0'), 'approved', 'version approved');
select ok((select next_review_due from public.compliance_policy_versions where policy_slug = 'information-security' and version = '1.0') = current_date + 365, 'next review = effective date + frequency');
select throws_ok($$select public.staff_policy_approve_version((select id from public.compliance_policy_versions where policy_slug = 'information-security' and version = '1.0'))$$, '55000', null, 'cannot approve twice');
select is((public.staff_policy_overview() -> 'policies' -> 5) is not null, true, 'overview returns policies');

-- ------------------------------------------------------------ immutability
select pg_temp.act_as_super();
select throws_ok($$update public.compliance_policy_versions set content_sha256 = repeat('b', 64) where policy_slug = 'information-security'$$, '42501', null, 'hash of a version cannot change');
select throws_ok($$update public.compliance_policy_versions set approver_id = '00000000-0000-0000-0000-00000000e0b1' where policy_slug = 'information-security' and version = '1.0'$$, '42501', null, 'approver cannot be rewritten');
select throws_ok($$delete from public.compliance_policy_versions where policy_slug = 'information-security'$$, '42501', null, 'versions cannot be deleted');

-- ------------------------------------------------------------ acknowledgement
select pg_temp.act_as('00000000-0000-0000-0000-00000000e0b1');
select is(public.staff_policy_acknowledge((select id from public.compliance_policy_versions where policy_slug = 'information-security' and version = '1.0')), true, 'staff2 acknowledges');
select is(public.staff_policy_acknowledge((select id from public.compliance_policy_versions where policy_slug = 'information-security' and version = '1.0')), false, 'second acknowledgement is a no-op');
select is((select count(*)::int from public.compliance_policy_acknowledgements), 1, 'exactly one acknowledgement row');
select pg_temp.act_as_super();
select throws_ok($$update public.compliance_policy_acknowledgements set acknowledged_at = now() - interval '1 year'$$, '42501', null, 'acknowledgements cannot be edited');
select throws_ok($$delete from public.compliance_policy_acknowledgements$$, '42501', null, 'acknowledgements cannot be deleted');

-- ------------------------------------------------------------ new version, hash drift, supersede
select public.compliance_sync_policy_hashes('[{"slug":"information-security","sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}]'::jsonb);
select pg_temp.act_as('00000000-0000-0000-0000-00000000e0a1');
select is((select review_state from jsonb_to_record((select p from jsonb_array_elements(public.staff_policy_overview() -> 'policies') p where p ->> 'slug' = 'information-security')) as x(review_state text)), 'content_changed',
  'repository text changed after approval => content_changed');
select throws_ok($$select public.staff_policy_submit_version('information-security', '1.0', null)$$, '22023', null, 'version must be greater than the latest');
select lives_ok($$select public.staff_policy_submit_version('information-security', '1.1', 'wording')$$, 'submit 1.1');
select pg_temp.act_as_super();
select public.compliance_sync_policy_hashes('[{"slug":"information-security","sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}]'::jsonb);
select pg_temp.act_as('00000000-0000-0000-0000-00000000e0b1');
select throws_ok($$select public.staff_policy_approve_version((select id from public.compliance_policy_versions where policy_slug = 'information-security' and version = '1.1'))$$, '55000', null, 'approval refused when the text changed after submission');
select lives_ok($$select public.staff_policy_withdraw_version((select id from public.compliance_policy_versions where policy_slug = 'information-security' and version = '1.1'))$$, 'withdraw');
select pg_temp.act_as('00000000-0000-0000-0000-00000000e0a1');
select lives_ok($$select public.staff_policy_submit_version('information-security', '1.2', null)$$, 'resubmit as 1.2');
select pg_temp.act_as('00000000-0000-0000-0000-00000000e0b1');
select is((public.staff_policy_approve_version((select id from public.compliance_policy_versions where policy_slug = 'information-security' and version = '1.2')) ->> 'self_approved')::boolean, false, 'independent approval is not flagged');
select is((select status from public.compliance_policy_versions where policy_slug = 'information-security' and version = '1.0'), 'superseded', 'previous approved version superseded');
select throws_ok($$select public.staff_policy_acknowledge((select id from public.compliance_policy_versions where policy_slug = 'information-security' and version = '1.0'))$$, '55000', null, 'superseded version cannot be acknowledged');

-- ------------------------------------------------------------ workforce records (facts only)
select pg_temp.act_as('00000000-0000-0000-0000-00000000e0a1');
select throws_ok($$select public.staff_workforce_record_add('00000000-0000-0000-0000-00000000e0c1', 'security_training', 'security_awareness_annual', 'completed', current_date)$$, '22023', null, 'subject must be staff');
select throws_ok($$select public.staff_workforce_record_add('00000000-0000-0000-0000-00000000e0b1', 'security_training', 'security_awareness_annual', 'completed', current_date + 1)$$, '22023', null, 'future completion date refused');
select throws_ok($$select public.staff_workforce_record_add('00000000-0000-0000-0000-00000000e0b1', 'security_training', 'security_awareness_annual', 'completed', current_date, null, null, 'jane.doe@example.com')$$, '23514', null, 'provider label that looks like an email is refused');
select throws_ok($$select public.staff_workforce_record_add('00000000-0000-0000-0000-00000000e0b1', 'background_check', '', 'completed', current_date, null, null, 'vendor', 'passed with notes')$$, '23514', null, 'free-text external reference refused');
select throws_ok($$select public.staff_workforce_record_add('00000000-0000-0000-0000-00000000e0b1', 'background_check', 'secure_coding', 'completed', current_date)$$, '23514', null, 'course only valid for training');
select lives_ok($$select public.staff_workforce_record_add('00000000-0000-0000-0000-00000000e0b1', 'security_training', 'security_awareness_annual', 'completed', current_date - 10, null, null, 'internal', 'ref-001')$$, 'valid training record');
select is((select state from public.compliance_workforce_matrix() where subject_email = 'staff2@vireek.test' and requirement_key = 'security_awareness_annual'), 'current', 'matrix: current') ;
select pg_temp.act_as_super();
select is((select state from public.compliance_workforce_matrix() where subject_email = 'staff1@vireek.test' and requirement_key = 'security_awareness_annual'), 'missing', 'matrix: missing for staff without a record');
select throws_ok($$update public.compliance_workforce_records set provider_label = 'other'$$, '42501', null, 'records cannot be edited');
select throws_ok($$delete from public.compliance_workforce_records$$, '42501', null, 'records cannot be deleted');
select pg_temp.act_as('00000000-0000-0000-0000-00000000e0a1');
select lives_ok($$select public.staff_workforce_record_void((select id from public.compliance_workforce_records limit 1))$$, 'a mistaken record can be voided');
select throws_ok($$select public.staff_workforce_record_void((select id from public.compliance_workforce_records limit 1))$$, 'P0002', null, 'void is one-time');
select pg_temp.act_as_super();
select is((select state from public.compliance_workforce_matrix() where subject_email = 'staff2@vireek.test' and requirement_key = 'security_awareness_annual'), 'missing', 'voided record no longer counts');

-- ------------------------------------------------------------ audit trail never carries provider labels
select ok(not exists (select 1 from public.audit_log where action = 'compliance_workforce_record_added' and metadata::text ~* 'internal|ref-001'), 'audit metadata has no provider label or reference');
select ok(exists (select 1 from public.audit_log where action = 'compliance_policy_approved'), 'approvals are audited');

-- ------------------------------------------------------------ evidence summaries
select is((public.compliance_policy_summary() ->> 'policies_total')::int, 16, 'policy summary counts all policies');
select ok((public.compliance_policy_summary() ->> 'never_approved')::int = 15, 'fifteen policies still never approved');
select ok(not (public.compliance_policy_summary()::text ~* '@vireek.test|e0a1|e0b1'), 'policy summary contains no names or ids');
select ok(not (public.compliance_workforce_summary()::text ~* '@vireek.test|e0a1|e0b1'), 'workforce summary contains no names or ids');

select * from finish();
rollback;
