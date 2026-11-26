-- Transparency report + public AI incident log: RLS, grants, compile correctness, approval gates, redaction lint (pgTAP).
-- Run with:  supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'staff@tr.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@tr.test');
insert into public.profiles (id, role, is_staff) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner', true),
  ('00000000-0000-0000-0000-0000000000b1', 'owner', false)
on conflict (id) do update set is_staff = excluded.is_staff;

create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
end $$;
create or replace function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;

-- Source rows inside 2025-H1 (a closed period).
insert into public.ai_incidents (title, summary, incident_type, severity, detected_at)
values ('Seed A', 'Seed incident number one for counts.', 'wrong_diagnosis', 'low', '2025-02-10T10:00:00Z'),
       ('Seed B', 'Seed incident number two for counts.', 'pii_leak_on_call', 'critical', '2025-03-01T10:00:00Z'),
       ('Seed C', 'Outside the period, must not be counted.', 'other', 'low', '2025-07-01T00:00:00Z');
insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary, data_categories, accounts_affected, outcome, closed_on, counsel_reviewed_on)
values ('subpoena', 'US', 'Seed court', '2025-04-01', 'Seed scope', array['call_metadata','billing_records'], 2, 'complied_in_part', '2025-04-20', '2025-04-10'),
       ('court_order', 'DE', 'Seed court 2', '2025-06-30', 'Seed scope', '{}', 0, 'objected', '2025-07-02', null);
insert into public.status_incidents (title, impact, status, component_id, summary, started_at, resolved_at)
values ('Seed outage', 'major', 'resolved', 'voice-ai', 'Seed', '2025-05-01T10:00:00Z', '2025-05-01T10:30:00Z'),
       ('Seed blip', 'minor', 'investigating', 'api', 'Seed', '2025-05-02T10:00:00Z', null);

-- ---------------------------------------------------------------- structure & grants
select has_table('public', 'transparency_reports', 'transparency_reports exists');
select has_table('public', 'ai_incident_public_entries', 'ai_incident_public_entries exists');
select ok((select relrowsecurity from pg_class where oid = 'public.transparency_reports'::regclass), 'RLS on reports');
select ok((select relrowsecurity from pg_class where oid = 'public.ai_incident_public_entries'::regclass), 'RLS on public entries');
select ok(not has_table_privilege('anon', 'public.transparency_reports', 'SELECT'), 'anon cannot read reports directly');
select ok(not has_table_privilege('anon', 'public.ai_incident_public_entries', 'SELECT'), 'anon cannot read entries directly');
select ok(not has_table_privilege('authenticated', 'public.transparency_reports', 'DELETE'), 'no DELETE on reports');
select ok(not has_table_privilege('authenticated', 'public.transparency_reports', 'INSERT'), 'no direct INSERT on reports');
select ok(not has_column_privilege('authenticated', 'public.transparency_reports', 'metrics', 'UPDATE'), 'clients cannot write metrics');
select ok(not has_function_privilege('authenticated', 'public.transparency_compile_metrics(date,date)', 'EXECUTE'), 'compile is not client-callable');
select ok(has_function_privilege('anon', 'public.get_public_transparency_reports()', 'EXECUTE'), 'anon may call the public reports RPC');

-- ---------------------------------------------------------------- compile correctness (exact, real tables)
create or replace function pg_temp.m(p_section text, p_metric text, p_dim text, p_key text) returns bigint language sql as $$
  select (e->>'count')::bigint from jsonb_array_elements(public.transparency_compile_metrics('2025-01-01','2025-06-30')) e
   where e->>'section'=p_section and e->>'metric'=p_metric and e->>'dimension'=p_dim and e->>'key'=p_key $$;
select is(pg_temp.m('ai_incidents','received','',''), 2::bigint, 'AI incidents: only those detected in the period');
select is(pg_temp.m('ai_incidents','received','severity','critical'), 1::bigint, 'AI incidents by severity');
select is(pg_temp.m('legal_requests','received','',''), 2::bigint, 'legal requests: both received in period (30 June inclusive)');
select is(pg_temp.m('legal_requests','disclosed','',''), 1::bigint, 'legal requests: one disclosing outcome');
select is(pg_temp.m('legal_requests','accounts_affected','',''), 2::bigint, 'accounts affected counts disclosures only');
select is(pg_temp.m('legal_requests','disclosed','data_category','billing_records'), 1::bigint, 'data categories counted');
select is(pg_temp.m('outages','resolved_minutes','impact','major'), 30::bigint, 'major outage minutes');
select is(pg_temp.m('outages','open_at_period_end','',''), 1::bigint, 'unresolved incident counted as open');
select is(
  (with m as (
     select e->>'section' s, e->>'metric' mt, e->>'dimension' d, (e->>'count')::bigint n
       from jsonb_array_elements(public.transparency_compile_metrics('2025-01-01','2025-06-30')) e),
   sums as (
     select s, mt, d, sum(n) tot from m
      where d in ('incident_type','severity','notice_type','request_type','outcome','request_kind') group by 1,2,3)
   select count(*)::int from sums
    where tot <> (select n from m where m.s = sums.s and m.mt = sums.mt and m.d = '' limit 1)),
  0, 'exhaustive dimensions add up to their totals');

-- ---------------------------------------------------------------- suppression
select is(
  (select public.transparency_apply_rules('[{"section":"a","metric":"m","dimension":"","key":"","count":2},{"section":"a","metric":"m","dimension":"","key":"z","count":0},{"section":"a","metric":"m","dimension":"","key":"y","count":9}]'::jsonb, 5)),
  '[{"section":"a","metric":"m","dimension":"","key":"","count":null,"suppressed":true},{"section":"a","metric":"m","dimension":"","key":"z","count":0},{"section":"a","metric":"m","dimension":"","key":"y","count":9}]'::jsonb,
  'counts 1..k-1 are suppressed, zero and large counts are kept');

-- ---------------------------------------------------------------- report lifecycle as staff
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
create temp table t_ids (rid uuid, eid uuid);
grant all on t_ids to authenticated;
insert into t_ids (rid) select public.transparency_report_create('2025-H1', 5);
select is((select count(*)::int from public.transparency_reports), 1, 'staff created a draft through the RPC');
select throws_ok($$update public.transparency_reports set status = 'approved'$$, '23514', null, 'cannot approve without a counsel date or text');
update public.transparency_reports set intro_text = 'Intro text.', reporting_rules_text = 'Counts below 5 are suppressed.', counsel_approved_on = '2025-08-01', status = 'approved';
select is((select status from public.transparency_reports), 'approved', 'approved with text and counsel date');
select public.transparency_report_refresh((select rid from t_ids));
select is((select status from public.transparency_reports), 'approved', 'recompiling unchanged figures keeps the approval');
insert into public.legal_requests (request_type, jurisdiction_country, requesting_authority, received_on, scope_summary, outcome, closed_on)
values ('other', 'FR', 'Late seed', '2025-05-05', 'Seed scope', 'no_data_found', '2025-05-06');
select public.transparency_report_refresh((select rid from t_ids));
select is((select status from public.transparency_reports), 'draft', 'changed figures send an approved report back to draft');
update public.transparency_reports set counsel_approved_on = '2025-08-02', status = 'approved';
update public.transparency_reports set status = 'published';
select ok((select bool_or(e ->> 'suppressed' = 'true') from public.transparency_reports, jsonb_array_elements(public_metrics) e), 'published snapshot has suppression applied');
select throws_ok($$update public.transparency_reports set intro_text = 'changed'$$, '42501', null, 'published content is frozen');

-- ---------------------------------------------------------------- incident entry gates and redaction
insert into public.ai_incident_public_entries (incident_type, severity, occurred_on, title, what_happened, impact, what_we_did)
values ('wrong_diagnosis', 'low', '2025-02-10', 'Wrong diagnosis suggested', 'The assistant suggested a wrong cause during a call.', 'One caller was misinformed.', 'We corrected the prompt and added a test.');
update t_ids set eid = (select id from public.ai_incident_public_entries);
select throws_ok($$insert into public.ai_incident_public_entries (incident_type, severity, occurred_on, title, what_happened, impact, what_we_did)
  values ('other','low','2025-02-10','Leaky entry','Contact the caller at jane@example.com about this.','Impact text here.','Action text here.')$$, '22023', null, 'e-mail address is rejected');
select throws_ok($$update public.ai_incident_public_entries set status = 'approved'$$, '23514', null, 'cannot approve without both checks');
update public.ai_incident_public_entries set redaction_checked_on = '2025-03-01', counsel_approved_on = '2025-03-02', status = 'approved';
update public.ai_incident_public_entries set status = 'published';
select is((select status from public.ai_incident_public_entries), 'published', 'entry published after both checks');
select throws_ok($$update public.ai_incident_public_entries set title = 'Edited after publishing'$$, '42501', null, 'published entry text is frozen');
select pg_temp.reset_role();
select pg_temp.act_as_anon();
select is(jsonb_array_length(public.get_public_ai_incident_log()), 1, 'anon sees the published entry');
select ok(not (public.get_public_ai_incident_log() -> 0 ? 'incident_id'), 'public log never exposes the internal incident id');
select is(jsonb_array_length(public.get_public_transparency_reports()), 1, 'anon sees the published report');
select ok(not exists (select 1 from jsonb_array_elements(public.get_public_transparency_reports() -> 0 -> 'metrics') e
                       where e ->> 'section' = 'ai_incidents' and e ->> 'metric' = 'received' and e ->> 'dimension' = '' and e ->> 'count' is not null),
          'public snapshot hides the exact small count');

select * from finish();
rollback;
