-- Hazard content governance (pgTAP). Run with:  supabase test db      [NOT RUN in the authoring environment: no Postgres available]
begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

select is(public.hazard_detect_domains('Check refrigerant pressures and superheat'), array['refrigerant'], 'detects refrigerant');
select is(public.hazard_detect_domains('If you smell gas leave. A CO alarm is sounding.'), array['gas','carbon_monoxide'], 'detects gas + CO in fixed order');
select is(public.hazard_detect_domains('Replace the air filter'), '{}'::text[], 'no hazard text -> empty');

select ok(public.hazard_review_is_current('Dana Reviewer', 'licensed gas fitter', now() - interval '10 days', current_date + 100), 'current review accepted');
select ok(not public.hazard_review_is_current('Dana Reviewer', 'licensed gas fitter', now() - interval '10 days', current_date - 1), 'expired review rejected');
select ok(not public.hazard_review_is_current('ab', 'licensed gas fitter', now(), current_date + 30), 'short reviewer name rejected');
select ok(not public.hazard_review_is_current('Dana Reviewer', 'licensed gas fitter', now(), current_date + 400), 'validity over 366 days rejected');

-- publishing unreviewed instructional hazard content is blocked
select throws_ok(
  $$insert into public.vertical_ontology_entries (trade, kind, key, version, title, payload, source, effective_on, jurisdiction, confidence)
    values ('hvac','symptom','zz_test_refrigerant',1,'Refrigerant leak test','{"checks":["Check refrigerant pressures"]}'::jsonb,'pgtap fixture','2029-01-01','US',0.5)$$,
  '23514', null, 'unreviewed refrigerant symptom cannot be published');

-- a safety-rule floor row is never blocked
select lives_ok(
  $$insert into public.vertical_ontology_entries (trade, kind, key, version, title, payload, source, effective_on, jurisdiction, confidence)
    values ('all','safety_rule','zz_test_floor',1,'Gas odor test','{"flag":"gas_odor","guidance":"Leave the building and call 911."}'::jsonb,'pgtap fixture','2029-01-01','US',0.5)$$,
  'safety rule floor row is allowed unreviewed');

-- non-hazard content is unaffected
select lives_ok(
  $$insert into public.vertical_ontology_entries (trade, kind, key, version, title, payload, source, effective_on, jurisdiction, confidence)
    values ('hvac','symptom','zz_test_plain',1,'Weak airflow test','{"checks":["Check the air filter"]}'::jsonb,'pgtap fixture','2029-01-01','US',0.5)$$,
  'non-hazard symptom is allowed');

-- a reviewed hazard row can be published (reviewed fields set on insert)
select lives_ok(
  $$insert into public.vertical_ontology_entries (trade, kind, key, version, title, payload, source, effective_on, jurisdiction, confidence, reviewed, reviewed_by, reviewer_qualification, reviewed_at, review_expires_on)
    values ('hvac','symptom','zz_test_reviewed',1,'Refrigerant reviewed test','{"checks":["Check refrigerant pressures"]}'::jsonb,'pgtap fixture','2029-01-01','US',0.5,true,'Dana Reviewer','EPA 608 universal',now(),current_date + 200)$$,
  'reviewed hazard symptom can be published');

select ok((select 'refrigerant' = any(hazard_domains) from public.vertical_ontology_entries where key = 'zz_test_reviewed'), 'hazard_domains auto-filled from the text (cannot under-declare)');

select ok(not has_function_privilege('authenticated', 'public.record_hazard_review(text,text,integer,text,text,date,text)', 'execute'), 'authenticated cannot record reviews');

-- audit log is append-only
select ok(public.record_hazard_review('ontology', 'hvac:symptom:zz_test_reviewed', 1, 'Dana Reviewer', 'EPA 608 universal', current_date + 100, 'pgTAP'), 'record_hazard_review logs a review');
select throws_ok($$update public.hazard_content_review_log set note = 'x'$$, '23514', null, 'review log is append-only');

select * from finish();
rollback;
