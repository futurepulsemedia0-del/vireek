-- Run (needs the Vireek schema applied, incl. 20281103000000_sensitive_read_access_log.sql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/database/sensitive_read_log.test.sql
-- Everything runs in one transaction and is rolled back. Prints "PASS: ..." per check.
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

-- fixtures -------------------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','ownerA@a.test'),
 ('bbbbbbbb-0000-0000-0000-000000000001','ownerB@b.test'),
 ('aaaaaaaa-0000-0000-0000-000000000002','mgrA@a.test'),
 ('aaaaaaaa-0000-0000-0000-000000000003','techA@a.test'),
 ('aaaaaaaa-0000-0000-0000-000000000004','viewerA@a.test'),
 ('aaaaaaaa-0000-0000-0000-000000000005','formerA@a.test'),
 ('cccccccc-0000-0000-0000-000000000001','staff@vireek.test');
-- Real schemas auto-create a profile per auth user (handle_new_user); only the two owners may keep one.
INSERT INTO profiles (id,email) VALUES ('aaaaaaaa-0000-0000-0000-000000000001','ownerA@a.test'),('bbbbbbbb-0000-0000-0000-000000000001','ownerB@b.test') ON CONFLICT (id) DO NOTHING;
DELETE FROM profiles WHERE id NOT IN ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001');
INSERT INTO team_members (account_owner_id, member_email, permissions) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','mgrA@a.test','{"can_manage_team":true,"can_view_all_jobs":true,"can_export_data":true}'),
 ('aaaaaaaa-0000-0000-0000-000000000001','techA@a.test','{}'),
 ('aaaaaaaa-0000-0000-0000-000000000001','viewerA@a.test','{"can_view_all_jobs":true}');
INSERT INTO calls (id,user_id,recording_url,transcript) VALUES
 ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','https://rec.test/SECRET-REC.mp3','Caller John Smith 555-0100 said SECRET-TRANSCRIPT');

-- 1. clients have no direct table access --------------------------------------
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
SELECT pg_temp.fails_with($$SELECT * FROM public.sensitive_read_log$$, '42501', 'owner cannot SELECT log table directly');
SELECT pg_temp.fails_with($$INSERT INTO public.sensitive_read_log(account_id,actor_kind,asset_class,action,channel) VALUES (gen_random_uuid(),'user','transcript','view','rpc')$$, '42501', 'client cannot INSERT (forge) log rows');
SELECT pg_temp.fails_with($$SELECT public.log_sensitive_read(gen_random_uuid(),'user',NULL,NULL,'transcript','view','rpc')$$, '42501', 'client cannot call trusted writer');
SELECT pg_temp.fails_with($$SELECT public.detect_sensitive_read_anomalies()$$, '42501', 'client cannot run detection');
RESET ROLE;

-- 2. read path logs, no content, coalescing ---------------------------------------
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
SELECT pg_temp.ok((SELECT transcript LIKE '%SECRET-TRANSCRIPT%' AND recording_url LIKE '%SECRET-REC%' FROM public.read_call_sensitive('11111111-1111-1111-1111-111111111111')), 'owner gets recording + transcript');
SELECT * FROM public.read_call_sensitive('11111111-1111-1111-1111-111111111111');  -- repeat (coalesced)
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) FROM sensitive_read_log WHERE asset_class IN ('call_recording','transcript')) = 2, 'one row per asset class; repeat view within 5 min coalesced');
SELECT pg_temp.ok((SELECT count(*) FROM sensitive_read_log l WHERE row_to_json(l)::text ~* 'SECRET|John|555-0100|rec.test') = 0, 'no content / PII in log rows');
SELECT pg_temp.fails_with($$INSERT INTO sensitive_read_log(account_id,actor_kind,asset_class,action,channel,target_id) VALUES (gen_random_uuid(),'user','transcript','view','rpc','+49 170 1234567')$$, '23514', 'target_id must be a UUID (phone/email rejected)');

-- 3. permissions + cross-tenant -------------------------------------------------------
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000003');
SELECT pg_temp.fails_with($$SELECT * FROM public.read_call_sensitive('11111111-1111-1111-1111-111111111111')$$, '42501', 'team member without view permission denied');
RESET ROLE;
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000004');
SELECT pg_temp.ok((SELECT count(*) FROM public.read_call_sensitive('11111111-1111-1111-1111-111111111111')) = 1, 'team member with can_view_all_jobs allowed');
RESET ROLE;
SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000001');
SELECT pg_temp.ok((SELECT count(*) FROM public.read_call_sensitive('11111111-1111-1111-1111-111111111111')) = 0, 'other tenant gets nothing for tenant A call');
SELECT pg_temp.ok((SELECT count(*) FROM public.list_sensitive_access_history('calls','11111111-1111-1111-1111-111111111111')) = 0, 'other tenant sees no access history of tenant A');
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) FROM sensitive_read_log WHERE account_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0, 'cross-tenant attempt logged nothing in tenant B');

-- 4. visibility ---------------------------------------------------------------------------
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
SELECT pg_temp.ok((SELECT count(*) FROM public.list_sensitive_access_history('calls','11111111-1111-1111-1111-111111111111')) >= 3, 'owner sees access history');
RESET ROLE;
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000004');
SELECT pg_temp.fails_with($$SELECT * FROM public.list_sensitive_access_history('calls','11111111-1111-1111-1111-111111111111')$$, '42501', 'plain viewer cannot see history by default');
RESET ROLE;
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.set_sensitive_read_viewer_visibility(true);
RESET ROLE;
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000004');
SELECT pg_temp.ok((SELECT count(*) FROM public.list_sensitive_access_history('calls','11111111-1111-1111-1111-111111111111')) >= 3, 'viewer sees history after owner enables "who viewed"');
RESET ROLE;
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000003');
SELECT pg_temp.fails_with($$SELECT * FROM public.set_sensitive_read_viewer_visibility(false)$$, '42501', 'non-owner cannot change visibility');
RESET ROLE;
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
SELECT pg_temp.ok((SELECT show_viewers_to_team FROM public.sensitive_read_settings) IS TRUE, 'owner can read own visibility setting');
RESET ROLE;
SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000001');
SELECT pg_temp.ok((SELECT count(*) FROM public.sensitive_read_settings) = 0, 'RLS: tenant B cannot read tenant A settings');
RESET ROLE;

-- 5. staff access trail -----------------------------------------------------------------------
INSERT INTO staff_impersonation_sessions (staff_id,target_account_id,expires_at) VALUES ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001', now()+interval '30 min');
INSERT INTO staff_audit_log (staff_id,action,target_account_id) VALUES ('cccccccc-0000-0000-0000-000000000001','impersonation_start','aaaaaaaa-0000-0000-0000-000000000001');
-- owner session is what impersonation produces; view a different call so it is not coalesced
INSERT INTO calls (id,user_id,recording_url) VALUES ('22222222-2222-2222-2222-222222222222','aaaaaaaa-0000-0000-0000-000000000001','https://rec.test/2.mp3');
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
SELECT * FROM public.read_call_sensitive('22222222-2222-2222-2222-222222222222');
SELECT pg_temp.ok((SELECT count(*) FROM public.list_staff_access_trail()) >= 2, 'staff trail shows impersonation start + read');
SELECT pg_temp.ok((SELECT bool_and(viewer_kind = 'vireek_support' AND viewer_email IS NULL) FROM public.list_sensitive_access_history('calls','22222222-2222-2222-2222-222222222222')), 'staff-session reads shown as Vireek Support, identity not exposed');
RESET ROLE;
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000002');
SELECT pg_temp.fails_with($$SELECT * FROM public.list_staff_access_trail()$$, '42501', 'staff trail is owner-only');
RESET ROLE;

-- 6. immutability -----------------------------------------------------------------------------------
SELECT pg_temp.fails_with($$UPDATE sensitive_read_log SET record_count = 5$$, '42501', 'UPDATE blocked (append-only)');
SELECT pg_temp.fails_with($$DELETE FROM sensitive_read_log$$, '42501', 'DELETE blocked (append-only)');

-- 7. rate limit -----------------------------------------------------------------------------------------
INSERT INTO sensitive_read_log (account_id,actor_kind,actor_id,asset_class,action,channel,record_count)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','user','aaaaaaaa-0000-0000-0000-000000000004','customer_pii','list','rpc',300);
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000004');
SELECT pg_temp.fails_with($$SELECT * FROM public.read_call_sensitive('22222222-2222-2222-2222-222222222222')$$, 'SR429', 'bulk read limit enforced per actor');
RESET ROLE;

-- 8. export gate / step-up ---------------------------------------------------------------------------------
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
SELECT pg_temp.fails_with($$SELECT public.begin_sensitive_export_action('export_download','33333333-3333-3333-3333-333333333333',10)$$, 'SR401', 'download without recent re-auth requires step-up');
RESET ROLE;
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001', jsonb_build_object('aal','aal1','amr', jsonb_build_array(jsonb_build_object('method','password','timestamp', extract(epoch from now())::bigint))));
SELECT pg_temp.ok((public.begin_sensitive_export_action('export_download','33333333-3333-3333-3333-333333333333',10)->>'ok')::boolean, 'download allowed after recent sign-in (no MFA enrolled)');
RESET ROLE;
INSERT INTO auth.mfa_factors (user_id,status) VALUES ('aaaaaaaa-0000-0000-0000-000000000001','verified');
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001', jsonb_build_object('aal','aal1','amr', jsonb_build_array(jsonb_build_object('method','password','timestamp', extract(epoch from now())::bigint))));
SELECT pg_temp.fails_with($$SELECT public.begin_sensitive_export_action('export_download','33333333-3333-3333-3333-333333333334',10)$$, 'SR401', 'MFA-enrolled user needs aal2');
RESET ROLE;
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001', jsonb_build_object('aal','aal2','amr', jsonb_build_array(jsonb_build_object('method','totp','timestamp', extract(epoch from now())::bigint - 3600))));
SELECT pg_temp.fails_with($$SELECT public.begin_sensitive_export_action('export_download','33333333-3333-3333-3333-333333333335',10)$$, 'SR401', 'stale aal2 (older than window) rejected');
RESET ROLE;
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000003');
SELECT pg_temp.fails_with($$SELECT public.begin_sensitive_export_action('export_create','33333333-3333-3333-3333-333333333336',10)$$, '42501', 'export gate requires can_export_data');
RESET ROLE;
SELECT pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
SELECT pg_temp.fails_with($$SELECT public.begin_sensitive_export_action('export_create','33333333-3333-3333-3333-333333333337',5000)$$, 'SR401', 'large export create requires step-up');
RESET ROLE;

-- 9. detection fixtures ----------------------------------------------------------------------------------------
TRUNCATE sensitive_read_alerts;
-- bulk scraping: 250 records in 10 min by one actor
INSERT INTO sensitive_read_log (occurred_at,account_id,actor_kind,actor_id,asset_class,action,channel,record_count)
VALUES (now()-interval '2 minutes','aaaaaaaa-0000-0000-0000-000000000001','user','aaaaaaaa-0000-0000-0000-000000000002','transcript','list','rpc',250);
SELECT public.detect_sensitive_read_anomalies();
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM sensitive_read_alerts WHERE rule='bulk_scraping' AND actor_id='aaaaaaaa-0000-0000-0000-000000000002'), 'rule bulk_scraping fires');
SELECT pg_temp.ok(public.detect_sensitive_read_anomalies() = 0, 'detection is idempotent (dedupe_key)');
-- former employee: actor not in team_members and not owner
INSERT INTO sensitive_read_log (occurred_at,account_id,actor_kind,actor_id,asset_class,action,channel)
VALUES (now()-interval '5 minutes','aaaaaaaa-0000-0000-0000-000000000001','user','aaaaaaaa-0000-0000-0000-000000000005','call_recording','view','rpc');
SELECT public.detect_sensitive_read_anomalies();
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM sensitive_read_alerts WHERE rule='former_employee_access' AND severity='critical' AND actor_id='aaaaaaaa-0000-0000-0000-000000000005'), 'rule former_employee_access fires');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM sensitive_read_alerts WHERE rule='former_employee_access' AND actor_id IN ('aaaaaaaa-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000002')), 'current team members are not flagged as former employees');
-- export volume: >5000 records today
INSERT INTO sensitive_read_log (account_id,actor_kind,actor_id,asset_class,action,channel,record_count)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','user','aaaaaaaa-0000-0000-0000-000000000002','export','export_create','export',9000);
SELECT public.detect_sensitive_read_anomalies();
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM sensitive_read_alerts WHERE rule='export_volume'), 'rule export_volume fires');
-- off-hours spike: run detection "at 03:00 UTC yesterday" with reads at 02:40 UTC (independent of the real clock)
INSERT INTO sensitive_read_log (occurred_at,account_id,actor_kind,actor_id,asset_class,action,channel,record_count)
VALUES (date_trunc('day', now()) - interval '21 hours 20 minutes','bbbbbbbb-0000-0000-0000-000000000001','user','bbbbbbbb-0000-0000-0000-000000000001','customer_pii','list','rpc',40);
SELECT public.detect_sensitive_read_anomalies(date_trunc('day', now()) - interval '21 hours');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM sensitive_read_alerts WHERE rule='off_hours_spike' AND account_id='bbbbbbbb-0000-0000-0000-000000000001'), 'rule off_hours_spike fires');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM sensitive_read_alerts WHERE rule='off_hours_spike' AND account_id='aaaaaaaa-0000-0000-0000-000000000001' AND window_end = date_trunc('day', now()) - interval '21 hours'), 'no false off-hours alert for tenant A in the replayed window');
SELECT pg_temp.ok((SELECT count(*) FROM audit_log WHERE action='sensitive_read_alert') >= 4, 'alerts mirrored into audit_log for SIEM streaming');
SELECT pg_temp.ok((SELECT count(*) FROM sensitive_read_alerts a WHERE a.account_id='bbbbbbbb-0000-0000-0000-000000000001' AND a.rule IN ('bulk_scraping','former_employee_access','export_volume')) = 0, 'alerts are tenant-scoped');
SELECT pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000001');
SELECT pg_temp.ok((SELECT count(*) FROM public.sensitive_read_alerts WHERE account_id <> 'bbbbbbbb-0000-0000-0000-000000000001') = 0, 'RLS: tenant B cannot read tenant A alerts');
RESET ROLE;

-- 10. retention + erasure -----------------------------------------------------------------------------------------
CREATE TABLE public.sensitive_read_log_200001 PARTITION OF public.sensitive_read_log FOR VALUES FROM ('2000-01-01') TO ('2000-02-01');
SELECT public.drop_expired_sensitive_read_partitions();
SELECT pg_temp.ok(to_regclass('public.sensitive_read_log_200001') IS NULL AND to_regclass('public.sensitive_read_log_' || to_char(now(),'YYYYMM')) IS NOT NULL, 'expired partition dropped by retention job; current month kept');
SELECT public.erase_sensitive_read_log_for_account('aaaaaaaa-0000-0000-0000-000000000001');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM sensitive_read_log WHERE account_id='aaaaaaaa-0000-0000-0000-000000000001'), 'erasure removes that tenant rows');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM sensitive_read_log WHERE account_id='bbbbbbbb-0000-0000-0000-000000000001'), 'other tenant rows untouched by erasure');
SELECT pg_temp.fails_with($$DELETE FROM sensitive_read_log$$, '42501', 'append-only restored after erasure');
ROLLBACK;
