-- Run (needs the Vireek schema applied, incl. 20281103000000_sensitive_read_access_log.sql and
-- 20290307000000_staff_insider_risk.sql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/database/staff_insider_risk.test.sql
-- Everything runs in one transaction and is rolled back. Prints "PASS: ..." per check; any failure aborts.
BEGIN;

CREATE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; END IF; RAISE NOTICE 'PASS: %', label; END; $$;

CREATE FUNCTION pg_temp.fails_with(stmt text, code text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE stmt; EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = code THEN RAISE NOTICE 'PASS: %', label; RETURN; END IF;
    RAISE EXCEPTION 'FAIL: % (got % / %)', label, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL: % (no error raised)', label;
END; $$;

CREATE FUNCTION pg_temp.as_user(uid uuid, claims jsonb DEFAULT '{}') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', (jsonb_build_object('sub', uid) || claims)::text, true);
  SET LOCAL ROLE authenticated;
END; $$;

-- staff n -> dddddddd-0000-0000-0000-<n>, customer account n -> aaaaaaaa-0000-0000-0000-<n>
CREATE FUNCTION pg_temp.sid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('dddddddd-0000-0000-0000-' || lpad(to_hex(n), 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.acc(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('aaaaaaaa-0000-0000-0000-' || lpad(to_hex(n), 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.stepup() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('aal', 'aal1', 'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)));
$$;
CREATE FUNCTION pg_temp.alert_id(p_rule text, p_staff uuid) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.staff_insider_alerts WHERE rule = p_rule AND staff_id = p_staff;
$$;

-- fixtures -------------------------------------------------------------------
-- staff 10..22, non-staff user 30
INSERT INTO auth.users (id, email)
SELECT pg_temp.sid(n), 'staff' || n || '@vireek.test' FROM generate_series(10, 22) n
UNION ALL SELECT pg_temp.sid(30), 'notstaff@vireek.test';
INSERT INTO profiles (id, email, is_staff)
SELECT pg_temp.sid(n), 'staff' || n || '@vireek.test', true FROM generate_series(10, 22) n
ON CONFLICT (id) DO UPDATE SET is_staff = true;
INSERT INTO profiles (id, email, is_staff) VALUES (pg_temp.sid(30), 'notstaff@vireek.test', false)
ON CONFLICT (id) DO UPDATE SET is_staff = false;

-- Fixed clock: 2030-01-15 12:00 UTC is outside the default off-hours window (22:00-06:00 UTC).
SELECT set_config('test.t1', '2030-01-15 12:00:00+00', true);
SELECT set_config('test.t2', '2030-01-15 23:30:00+00', true);

-- 0. pure helper: off-hours window semantics ----------------------------------------
SELECT pg_temp.ok(public.sir_is_offhours('2030-01-15 23:00+00', 22, 6),  'off-hours: 23:00 inside wrapping window 22-06');
SELECT pg_temp.ok(public.sir_is_offhours('2030-01-15 05:59+00', 22, 6),  'off-hours: 05:59 inside wrapping window');
SELECT pg_temp.ok(NOT public.sir_is_offhours('2030-01-15 06:00+00', 22, 6), 'off-hours: 06:00 is the first working hour');
SELECT pg_temp.ok(NOT public.sir_is_offhours('2030-01-15 12:00+00', 22, 6), 'off-hours: midday outside');
SELECT pg_temp.ok(public.sir_is_offhours('2030-01-15 02:00+00', 1, 5) AND NOT public.sir_is_offhours('2030-01-15 05:00+00', 1, 5), 'off-hours: non-wrapping window 01-05 (end exclusive)');
SELECT pg_temp.ok(NOT public.sir_is_offhours('2030-01-15 03:00+00', 3, 3), 'off-hours: start = end means no window');

-- 1. clients have no table access and cannot run detection ---------------------------------
SELECT pg_temp.as_user(pg_temp.sid(11));
SELECT pg_temp.fails_with($$SELECT * FROM public.staff_insider_alerts$$, '42501', 'staff cannot SELECT alerts table directly');
SELECT pg_temp.fails_with($$SELECT * FROM public.staff_insider_policy$$, '42501', 'staff cannot read policy table directly');
SELECT pg_temp.fails_with($$INSERT INTO public.staff_insider_alerts(rule,severity,staff_id,window_start,window_end,observed,threshold,runbook_key,dedupe_key) VALUES ('staff_export','critical',gen_random_uuid(),now(),now(),1,1,'staff-export','forged')$$, '42501', 'client cannot forge an alert');
SELECT pg_temp.fails_with($$SELECT public.detect_staff_insider_risk()$$, '42501', 'client cannot run detection');
SELECT pg_temp.fails_with($$SELECT * FROM public.sir_staff_read_events(now() - interval '1 day', now())$$, '42501', 'client cannot call the attribution helper');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.fails_with($$SELECT public.list_staff_insider_alerts()$$, '42501', 'anon cannot list alerts');
RESET ROLE;

-- 2. event fixtures (all relative to t1) --------------------------------------------------------
-- R1 volume: staff 10 starts 6 sessions on 2 accounts. Staff 11 starts 5 on 3 accounts (below both thresholds).
INSERT INTO staff_audit_log (staff_id, staff_email, action, target_account_id, created_at)
SELECT pg_temp.sid(10), 'staff10@vireek.test', 'impersonation_start', pg_temp.acc(1 + (i % 2)), current_setting('test.t1')::timestamptz - make_interval(hours => i) FROM generate_series(1, 6) i;
INSERT INTO staff_audit_log (staff_id, staff_email, action, target_account_id, created_at)
SELECT pg_temp.sid(11), 'staff11@vireek.test', 'impersonation_start', pg_temp.acc(1 + (i % 3)), current_setting('test.t1')::timestamptz - make_interval(hours => i) FROM generate_series(1, 5) i;
-- R2 breadth: staff 12 starts 4 sessions on 4 DIFFERENT accounts (4 starts < 6, so volume must not fire).
INSERT INTO staff_audit_log (staff_id, staff_email, action, target_account_id, created_at)
SELECT pg_temp.sid(12), 'staff12@vireek.test', 'impersonation_start', pg_temp.acc(10 + i), current_setting('test.t1')::timestamptz - make_interval(hours => i) FROM generate_series(1, 4) i;
-- R3 denied: staff 13, three denials in the last hour.
INSERT INTO staff_audit_log (staff_id, staff_email, action, target_account_id, created_at)
SELECT pg_temp.sid(13), 'staff13@vireek.test', 'impersonation_denied', pg_temp.acc(20), current_setting('test.t1')::timestamptz - make_interval(mins => i * 10) FROM generate_series(1, 3) i;
-- R4 no ticket: staff 14 three sessions without ticket; staff 15 three sessions WITH tickets; staff 19 has one session (for the impersonation-attributed read below).
INSERT INTO staff_impersonation_sessions (staff_id, target_account_id, reason, ticket_ref, started_at, expires_at)
SELECT pg_temp.sid(14), pg_temp.acc(30 + i), 'fixture: customer asked for help with billing setup', NULL,
       current_setting('test.t1')::timestamptz - interval '2 days' + make_interval(mins => i), current_setting('test.t1')::timestamptz - interval '2 days' + make_interval(mins => i + 30) FROM generate_series(1, 3) i;
INSERT INTO staff_impersonation_sessions (staff_id, target_account_id, reason, ticket_ref, started_at, expires_at)
SELECT pg_temp.sid(15), pg_temp.acc(40 + i), 'fixture: customer asked for help with billing setup', 'ZD-100' || i,
       current_setting('test.t1')::timestamptz - interval '2 days' + make_interval(mins => i), current_setting('test.t1')::timestamptz - interval '2 days' + make_interval(mins => i + 30) FROM generate_series(1, 3) i;
INSERT INTO staff_impersonation_sessions (id, staff_id, target_account_id, reason, ticket_ref, started_at, expires_at)
VALUES ('eeeeeeee-0000-0000-0000-000000000019', pg_temp.sid(19), pg_temp.acc(2), 'fixture: reproducing a reported booking problem', 'ZD-9',
        current_setting('test.t1')::timestamptz - interval '20 minutes', current_setting('test.t1')::timestamptz + interval '10 minutes');
-- R6 enumeration: staff 16 opens 25 distinct accounts in the last hour; staff 17 opens 24.
INSERT INTO staff_audit_log (staff_id, staff_email, action, target_account_id, created_at)
SELECT pg_temp.sid(16), 'staff16@vireek.test', 'account_view', gen_random_uuid(), current_setting('test.t1')::timestamptz - interval '30 minutes' FROM generate_series(1, 25);
INSERT INTO staff_audit_log (staff_id, staff_email, action, target_account_id, created_at)
SELECT pg_temp.sid(17), 'staff17@vireek.test', 'account_view', gen_random_uuid(), current_setting('test.t1')::timestamptz - interval '30 minutes' FROM generate_series(1, 24);
-- R7 bulk read: staff 18 reads exactly 100 records as actor_kind 'staff'; staff 20 reads 99; staff 19 reads 120 INSIDE an impersonation session
-- (actor is the customer owner, staff is resolved from the session). A customer user reading 500 records is NOT a staff alert.
INSERT INTO sensitive_read_log (occurred_at, account_id, actor_kind, actor_id, impersonation_session_id, asset_class, action, channel, record_count) VALUES
 (current_setting('test.t1')::timestamptz - interval '5 minutes', pg_temp.acc(1), 'staff', pg_temp.sid(18), NULL, 'customer_pii', 'list', 'staff', 100),
 (current_setting('test.t1')::timestamptz - interval '5 minutes', pg_temp.acc(1), 'staff', pg_temp.sid(20), NULL, 'customer_pii', 'list', 'staff', 99),
 (current_setting('test.t1')::timestamptz - interval '5 minutes', pg_temp.acc(2), 'user',  pg_temp.acc(2),  'eeeeeeee-0000-0000-0000-000000000019', 'call_recording', 'view', 'rpc', 120),
 (current_setting('test.t1')::timestamptz - interval '5 minutes', pg_temp.acc(3), 'user',  pg_temp.acc(3),  NULL, 'customer_pii', 'list', 'ui', 500);
-- R8 export: staff 21 creates an export. A customer exporting their own data is not a staff alert.
INSERT INTO sensitive_read_log (occurred_at, account_id, actor_kind, actor_id, asset_class, action, channel, record_count) VALUES
 (current_setting('test.t1')::timestamptz - interval '20 minutes', pg_temp.acc(1), 'staff', pg_temp.sid(21), 'export', 'export_create', 'staff', 5),
 (current_setting('test.t1')::timestamptz - interval '20 minutes', pg_temp.acc(3), 'user',  pg_temp.acc(3),  'export', 'export_create', 'export', 5000);
-- unattributable staff row (no actor id, no session) must be skipped, not guessed
INSERT INTO sensitive_read_log (occurred_at, account_id, actor_kind, actor_id, asset_class, action, channel, record_count) VALUES
 (current_setting('test.t1')::timestamptz - interval '5 minutes', pg_temp.acc(1), 'staff', NULL, 'customer_pii', 'list', 'staff', 5000);

-- 3. detection at t1 ---------------------------------------------------------------------------------
SELECT pg_temp.ok(public.detect_staff_insider_risk(current_setting('test.t1')::timestamptz) = 8, 'first run raises exactly 8 alerts');
SELECT pg_temp.ok((SELECT count(*) FROM staff_insider_alerts WHERE rule = 'impersonation_volume')  = 1 AND pg_temp.alert_id('impersonation_volume',  pg_temp.sid(10)) IS NOT NULL, 'volume: 6 sessions in 24h alerts staff 10 only (5 does not)');
SELECT pg_temp.ok((SELECT count(*) FROM staff_insider_alerts WHERE rule = 'impersonation_breadth') = 1 AND pg_temp.alert_id('impersonation_breadth', pg_temp.sid(12)) IS NOT NULL, 'breadth: 4 distinct accounts alerts staff 12 only');
SELECT pg_temp.ok((SELECT count(*) FROM staff_insider_alerts WHERE rule = 'impersonation_denied')  = 1 AND pg_temp.alert_id('impersonation_denied',  pg_temp.sid(13)) IS NOT NULL, 'denied: 3 denials in 1h alerts staff 13');
SELECT pg_temp.ok((SELECT count(*) FROM staff_insider_alerts WHERE rule = 'impersonation_no_ticket') = 1 AND pg_temp.alert_id('impersonation_no_ticket', pg_temp.sid(14)) IS NOT NULL, 'no-ticket: 3 sessions without ticket alerts staff 14; ticketed sessions (staff 15) do not');
SELECT pg_temp.ok((SELECT count(*) FROM staff_insider_alerts WHERE rule = 'account_enumeration') = 1 AND pg_temp.alert_id('account_enumeration', pg_temp.sid(16)) IS NOT NULL, 'enumeration: 25 distinct accounts alerts staff 16; 24 does not');
SELECT pg_temp.ok((SELECT count(*) FROM staff_insider_alerts WHERE rule = 'staff_bulk_read') = 2
                  AND pg_temp.alert_id('staff_bulk_read', pg_temp.sid(18)) IS NOT NULL AND pg_temp.alert_id('staff_bulk_read', pg_temp.sid(19)) IS NOT NULL,
                  'bulk read: 100 direct staff records and 120 inside an impersonation session alert; 99 does not; customer bulk read and unattributable row are ignored');
SELECT pg_temp.ok((SELECT target_account_id FROM staff_insider_alerts WHERE rule = 'staff_bulk_read' AND staff_id = pg_temp.sid(18)) = pg_temp.acc(1), 'bulk read: single-account reads carry the account id');
SELECT pg_temp.ok((SELECT severity FROM staff_insider_alerts WHERE rule = 'staff_export' AND staff_id = pg_temp.sid(21)) = 'critical'
                  AND (SELECT count(*) FROM staff_insider_alerts WHERE rule = 'staff_export') = 1, 'export: any staff export is critical; customer self-export is not a staff alert');
SELECT pg_temp.ok((SELECT count(*) FROM staff_insider_alerts WHERE rule = 'impersonation_off_hours') = 0, 'off-hours: midday start does not alert');
SELECT pg_temp.ok((SELECT staff_email FROM staff_insider_alerts WHERE rule = 'staff_export') = 'staff21@vireek.test', 'alert carries the staff e-mail resolved from auth.users');
SELECT pg_temp.ok((SELECT count(*) FROM staff_insider_alerts a WHERE row_to_json(a)::text ~* 'fixture:|billing setup|ZD-') = 0, 'no reason text or ticket reference is copied into alerts');

-- 4. idempotency and off-hours --------------------------------------------------------------------------
SELECT pg_temp.ok(public.detect_staff_insider_risk(current_setting('test.t1')::timestamptz) = 0, 'second run at the same clock raises nothing (dedupe)');
INSERT INTO staff_audit_log (staff_id, staff_email, action, target_account_id, created_at)
VALUES (pg_temp.sid(22), 'staff22@vireek.test', 'impersonation_start', pg_temp.acc(50), '2030-01-15 23:10:00+00');
SELECT pg_temp.ok(public.detect_staff_insider_risk(current_setting('test.t2')::timestamptz) = 1, 'run at 23:30 UTC raises only the new off-hours alert (earlier alerts deduped)');
SELECT pg_temp.ok(pg_temp.alert_id('impersonation_off_hours', pg_temp.sid(22)) IS NOT NULL, 'off-hours: session started at 23:10 UTC alerts staff 22');

-- 5. alert rows are append-only ---------------------------------------------------------------------------
SELECT pg_temp.fails_with($$DELETE FROM public.staff_insider_alerts$$, '42501', 'alerts cannot be deleted');
SELECT pg_temp.fails_with($$UPDATE public.staff_insider_alerts SET observed = 0 WHERE rule = 'staff_export'$$, '42501', 'evidence columns are frozen');
SELECT pg_temp.fails_with($$UPDATE public.staff_insider_alerts SET status = 'dismissed' WHERE rule = 'staff_export'$$, '23514', 'closing without reviewer + note violates the resolution constraint');

-- 6. review RPCs: separation of duties, step-up, note ---------------------------------------------------------
SELECT set_config('test.alert_vol',  pg_temp.alert_id('impersonation_volume', pg_temp.sid(10))::text, true);
SELECT set_config('test.alert_exp',  pg_temp.alert_id('staff_export', pg_temp.sid(21))::text, true);

SELECT pg_temp.as_user(pg_temp.sid(30), pg_temp.stepup());
SELECT pg_temp.fails_with($$SELECT * FROM public.list_staff_insider_alerts()$$, '42501', 'non-staff cannot list alerts');
SELECT pg_temp.fails_with($$SELECT public.set_staff_insider_alert_status(current_setting('test.alert_vol')::uuid, 'dismissed', 'attempt by a non staff user')$$, '42501', 'non-staff cannot review');
SELECT pg_temp.fails_with($$SELECT public.staff_access_review_report(2030, 1)$$, '42501', 'non-staff cannot read the access review report');
RESET ROLE;

SELECT pg_temp.as_user(pg_temp.sid(11));  -- staff, no step-up claims
SELECT pg_temp.fails_with($$SELECT public.set_staff_insider_alert_status(current_setting('test.alert_vol')::uuid, 'acknowledged', 'looked at the sessions, all ticketed')$$, 'SR401', 'review needs a recent step-up');
SELECT pg_temp.fails_with($$SELECT public.staff_access_review_report(2030, 1)$$, 'SR401', 'access review report needs a recent step-up');
RESET ROLE;

SELECT pg_temp.as_user(pg_temp.sid(11), pg_temp.stepup());
SELECT pg_temp.fails_with($$SELECT public.set_staff_insider_alert_status(current_setting('test.alert_vol')::uuid, 'acknowledged', 'short')$$, '22023', 'note shorter than 10 characters rejected');
SELECT pg_temp.fails_with($$SELECT public.set_staff_insider_alert_status(current_setting('test.alert_vol')::uuid, 'open', 'reopening is not allowed here')$$, '22023', 'only acknowledged/dismissed are accepted');
SELECT pg_temp.ok((SELECT count(*) FROM public.list_staff_insider_alerts('open')) = 9, 'staff reviewer sees all 9 open alerts');
SELECT pg_temp.ok((SELECT count(*) FROM public.list_staff_insider_alerts('all') WHERE is_about_you) = 0, 'is_about_you is false for others alerts');
SELECT public.set_staff_insider_alert_status(current_setting('test.alert_vol')::uuid, 'acknowledged', 'Reviewed with support lead: all six sessions match open tickets.');
SELECT pg_temp.fails_with($$SELECT public.set_staff_insider_alert_status(current_setting('test.alert_vol')::uuid, 'dismissed', 'second attempt on a closed alert')$$, '42501', 'a resolved alert cannot be resolved again');
RESET ROLE;

SELECT pg_temp.as_user(pg_temp.sid(21), pg_temp.stepup());  -- the subject of the export alert
SELECT pg_temp.ok((SELECT count(*) FROM public.list_staff_insider_alerts('all') WHERE is_about_you) = 1, 'subject can see that an alert exists about them (transparency)');
SELECT pg_temp.fails_with($$SELECT public.set_staff_insider_alert_status(current_setting('test.alert_exp')::uuid, 'dismissed', 'dismissing my own export alert')$$, '42501', 'nobody can review an alert about themselves');
RESET ROLE;

SELECT pg_temp.ok((SELECT resolved_by FROM staff_insider_alerts WHERE id = current_setting('test.alert_vol')::uuid) = pg_temp.sid(11)
                  AND (SELECT status FROM staff_insider_alerts WHERE id = current_setting('test.alert_vol')::uuid) = 'acknowledged'
                  AND (SELECT review_note FROM staff_insider_alerts WHERE id = current_setting('test.alert_vol')::uuid) IS NOT NULL, 'resolution recorded reviewer, status and note');
SELECT pg_temp.fails_with($$UPDATE public.staff_insider_alerts SET status = 'open', resolved_at = NULL, resolved_by = NULL, review_note = NULL WHERE rule = 'impersonation_volume'$$, '42501', 'a resolved alert cannot be reopened');

-- 7. quarterly access review report ---------------------------------------------------------------------------------
SELECT pg_temp.fails_with($$SELECT public.staff_access_review_report(2030, 5)$$, '22023', 'report rejects quarter 5');
SELECT pg_temp.fails_with($$SELECT public.staff_access_review_report(1999, 1)$$, '22023', 'report rejects year 1999');
SELECT pg_temp.ok((public.staff_access_review_report(2030, 1) #>> '{period,from}')::timestamptz = '2030-01-01 00:00:00+00'
              AND (public.staff_access_review_report(2030, 1) #>> '{period,to}')::timestamptz   = '2030-04-01 00:00:00+00', 'Q1 spans 1 Jan to 1 Apr (UTC)');
SELECT pg_temp.ok((public.staff_access_review_report(2030, 4) #>> '{period,from}')::timestamptz = '2030-10-01 00:00:00+00', 'Q4 starts 1 Oct');
SELECT pg_temp.ok(public.staff_access_review_report(2030, 1) ->> 'schema' = 'vireek.access-review/v1', 'report carries its schema id');

CREATE TEMP TABLE _rep AS SELECT public.staff_access_review_report(2030, 1) AS j;
SELECT pg_temp.ok((SELECT jsonb_array_length(j -> 'staff') FROM _rep) >= 13
                  AND NOT EXISTS (SELECT 1 FROM _rep, jsonb_array_elements(j -> 'staff') e WHERE e ->> 'id' = pg_temp.sid(30)::text), 'report lists the 13 fixture staff profiles and not the non-staff user');
SELECT pg_temp.ok((SELECT (e ->> 'impersonation_sessions')::int = 3 AND (e ->> 'sessions_without_ticket')::int = 3 AND (e ->> 'impersonated_accounts')::int = 3
                     FROM _rep, jsonb_array_elements(j -> 'staff') e WHERE e ->> 'id' = pg_temp.sid(14)::text), 'report counts staff 14 sessions, missing tickets and distinct accounts');
SELECT pg_temp.ok((SELECT (e -> 'staff_audit_actions' ->> 'impersonation_start')::int = 6
                     FROM _rep, jsonb_array_elements(j -> 'staff') e WHERE e ->> 'id' = pg_temp.sid(10)::text), 'report counts staff audit actions per action');
SELECT pg_temp.ok((SELECT (e ->> 'sensitive_read_records')::int = 120 FROM _rep, jsonb_array_elements(j -> 'staff') e WHERE e ->> 'id' = pg_temp.sid(19)::text), 'report attributes impersonated reads to the staff member');
SELECT pg_temp.ok((SELECT (e ->> 'sensitive_export_events')::int = 1 AND (e ->> 'alerts_open')::int = 1 FROM _rep, jsonb_array_elements(j -> 'staff') e WHERE e ->> 'id' = pg_temp.sid(21)::text), 'report shows the export event and the open alert');
SELECT pg_temp.ok((SELECT (e ->> 'alerts_open')::int = 0 FROM _rep, jsonb_array_elements(j -> 'staff') e WHERE e ->> 'id' = pg_temp.sid(10)::text), 'acknowledged alert no longer counts as open');
SELECT pg_temp.ok((SELECT j -> 'platform_access' ? 'scim' FROM _rep), 'report embeds the existing compliance_access_summary()');
SELECT pg_temp.ok((SELECT j::text !~* 'fixture:|billing setup|ZD-' FROM _rep), 'report contains no reason text or ticket references');

SELECT pg_temp.as_user(pg_temp.sid(11), pg_temp.stepup());
SELECT pg_temp.ok(public.staff_access_review_report(2030, 1) ->> 'schema' = 'vireek.access-review/v1', 'staff with step-up can run the report');
RESET ROLE;

ROLLBACK;
