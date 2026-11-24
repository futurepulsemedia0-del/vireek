-- =============================================================
-- Insider risk: alerts on privileged Vireek-staff actions + quarterly access review report
--
-- What already exists (reused, not duplicated):
--   * staff_audit_log (append-only)            20270504000000_staff_account_explorer.sql
--   * staff_impersonation_sessions             20270504000000_staff_account_explorer.sql
--   * sensitive_read_log / sensitive_read_policy (off-hours window)  20281103000000_sensitive_read_access_log.sql
--   * compliance_access_summary()              20280402000000_soc2_control_program.sql
--   sensitive_read_alerts watches CUSTOMER-side actors per tenant. Nothing watched Vireek STAFF.
--   This migration fills exactly that gap.
--
-- Design:
--   * Counts and ids only. No customer content, no reasons text, no PII beyond the staff e-mail.
--   * Detection runs as service_role (pg_cron). Clients have NO table privileges; staff use RPCs.
--   * Separation of duties: nobody can acknowledge/dismiss an alert about themselves; a note
--     (10..500 chars) and a recent step-up are required.
--   * alerts are append-only: DELETE blocked; UPDATE allowed only for the open -> resolved transition.
--   * Idempotent: dedupe_key UNIQUE + advisory lock, so overlapping cron runs cannot double-alert.
--   * Rollback: see the bottom of this file.
-- Depends on: profiles, is_vireek_staff(), staff_audit_log, staff_impersonation_sessions,
--   sensitive_read_log, sensitive_read_policy, sensitive_read_stepup_ok(), compliance_access_summary(),
--   auth.users, auth.mfa_factors.
-- =============================================================

-- 1. POLICY (singleton, thresholds) -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_insider_policy (
  id                              boolean PRIMARY KEY DEFAULT true CHECK (id),
  imp_starts_per_day              integer NOT NULL DEFAULT 6   CHECK (imp_starts_per_day > 0),
  imp_distinct_accounts_per_day   integer NOT NULL DEFAULT 4   CHECK (imp_distinct_accounts_per_day > 0),
  imp_denied_per_hour             integer NOT NULL DEFAULT 3   CHECK (imp_denied_per_hour > 0),
  imp_no_ticket_per_week          integer NOT NULL DEFAULT 3   CHECK (imp_no_ticket_per_week > 0),
  account_views_per_hour          integer NOT NULL DEFAULT 25  CHECK (account_views_per_hour > 0),
  staff_bulk_records_10min        integer NOT NULL DEFAULT 100 CHECK (staff_bulk_records_10min > 0)
);
INSERT INTO public.staff_insider_policy (id) VALUES (true) ON CONFLICT DO NOTHING;
ALTER TABLE public.staff_insider_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_insider_policy FROM PUBLIC, anon, authenticated;

-- 2. ALERTS ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_insider_alerts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule               text NOT NULL CHECK (rule IN (
                       'impersonation_volume','impersonation_breadth','impersonation_denied',
                       'impersonation_no_ticket','impersonation_off_hours',
                       'account_enumeration','staff_bulk_read','staff_export')),
  severity           text NOT NULL CHECK (severity IN ('medium','high','critical')),
  staff_id           uuid NOT NULL,
  staff_email        text,
  target_account_id  uuid,
  window_start       timestamptz NOT NULL,
  window_end         timestamptz NOT NULL,
  observed           integer NOT NULL CHECK (observed >= 0),
  threshold          integer NOT NULL CHECK (threshold >= 0),
  runbook_key        text NOT NULL CHECK (runbook_key ~ '^[a-z][a-z0-9-]{2,60}$'),
  dedupe_key         text NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','dismissed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  resolved_by        uuid,
  review_note        text CHECK (review_note IS NULL OR char_length(review_note) BETWEEN 10 AND 500),
  CONSTRAINT staff_insider_alerts_resolution_ck CHECK (
    (status = 'open'  AND resolved_at IS NULL AND resolved_by IS NULL AND review_note IS NULL) OR
    (status <> 'open' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND review_note IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_sia_status_created ON public.staff_insider_alerts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sia_staff_created  ON public.staff_insider_alerts (staff_id, created_at DESC);

ALTER TABLE public.staff_insider_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_insider_alerts FROM PUBLIC, anon, authenticated;
-- No client policies on purpose: staff read and review through the RPCs below.

CREATE OR REPLACE FUNCTION public.staff_insider_alerts_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'staff_insider_alerts is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- UPDATE: only the one-way transition open -> acknowledged/dismissed; evidence columns are frozen.
  IF OLD.status <> 'open'
     OR NEW.status = 'open'
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.rule IS DISTINCT FROM OLD.rule
     OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.staff_id IS DISTINCT FROM OLD.staff_id
     OR NEW.staff_email IS DISTINCT FROM OLD.staff_email
     OR NEW.target_account_id IS DISTINCT FROM OLD.target_account_id
     OR NEW.window_start IS DISTINCT FROM OLD.window_start
     OR NEW.window_end IS DISTINCT FROM OLD.window_end
     OR NEW.observed IS DISTINCT FROM OLD.observed
     OR NEW.threshold IS DISTINCT FROM OLD.threshold
     OR NEW.runbook_key IS DISTINCT FROM OLD.runbook_key
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'staff_insider_alerts: only open -> acknowledged/dismissed is allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sia_guard ON public.staff_insider_alerts;
CREATE TRIGGER trg_sia_guard BEFORE UPDATE OR DELETE ON public.staff_insider_alerts
  FOR EACH ROW EXECUTE FUNCTION public.staff_insider_alerts_guard();

-- 3. HELPERS ----------------------------------------------------------------------------------
-- Off-hours test on the UTC hour. Same semantics as detect_sensitive_read_anomalies (start > end wraps midnight;
-- start = end means "no off-hours window").
CREATE OR REPLACE FUNCTION public.sir_is_offhours(p_ts timestamptz, p_start integer, p_end integer)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN p_start > p_end THEN extract(hour FROM p_ts AT TIME ZONE 'UTC') >= p_start OR extract(hour FROM p_ts AT TIME ZONE 'UTC') < p_end
           WHEN p_start < p_end THEN extract(hour FROM p_ts AT TIME ZONE 'UTC') >= p_start AND extract(hour FROM p_ts AT TIME ZONE 'UTC') < p_end
           ELSE false
         END;
$$;

-- Sensitive reads attributed to a Vireek staff member: either logged as actor_kind 'staff'
-- (actor_id = staff id), or performed inside an impersonation session (staff id from the session row).
-- Rows that cannot be attributed (no staff id) are skipped, never guessed.
CREATE OR REPLACE FUNCTION public.sir_staff_read_events(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (occurred_at timestamptz, staff_id uuid, account_id uuid, asset_class text, action text, record_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.occurred_at,
         COALESCE(CASE WHEN l.actor_kind = 'staff' THEN l.actor_id END, s.staff_id) AS staff_id,
         l.account_id, l.asset_class, l.action, l.record_count
    FROM sensitive_read_log l
    LEFT JOIN staff_impersonation_sessions s ON s.id = l.impersonation_session_id
   WHERE l.occurred_at >= p_from AND l.occurred_at < p_to
     AND (l.actor_kind = 'staff' OR l.impersonation_session_id IS NOT NULL)
     AND COALESCE(CASE WHEN l.actor_kind = 'staff' THEN l.actor_id END, s.staff_id) IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.sir_staff_read_events(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sir_staff_read_events(timestamptz, timestamptz) TO service_role;

-- Inserts one alert; returns its id, or NULL when the dedupe key already exists.
CREATE OR REPLACE FUNCTION public.sir_raise(
  p_rule text, p_severity text, p_staff uuid, p_target uuid,
  p_from timestamptz, p_to timestamptz, p_observed integer, p_threshold integer,
  p_runbook text, p_dedupe text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO staff_insider_alerts (rule, severity, staff_id, staff_email, target_account_id, window_start, window_end,
                                    observed, threshold, runbook_key, dedupe_key)
  VALUES (p_rule, p_severity, p_staff, (SELECT u.email::text FROM auth.users u WHERE u.id = p_staff), p_target,
          p_from, p_to, p_observed, p_threshold, p_runbook, p_dedupe)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.sir_raise(text,text,uuid,uuid,timestamptz,timestamptz,integer,integer,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sir_raise(text,text,uuid,uuid,timestamptz,timestamptz,integer,integer,text,text) TO service_role;

-- 4. DETECTION (service_role / pg_cron) -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.detect_staff_insider_risk(p_now timestamptz DEFAULT now())
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  pol staff_insider_policy%ROWTYPE;
  srp sensitive_read_policy%ROWTYPE;
  r record; made integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('detect_staff_insider_risk')) THEN
    RETURN 0; -- another run is in progress
  END IF;
  SELECT * INTO pol FROM staff_insider_policy WHERE id;
  SELECT * INTO srp FROM sensitive_read_policy WHERE id;

  -- R1 impersonation_volume: many impersonation sessions started by one staff member in 24 h
  FOR r IN
    SELECT staff_id, count(*)::int AS n FROM staff_audit_log
     WHERE action = 'impersonation_start' AND staff_id IS NOT NULL
       AND created_at > p_now - interval '24 hours' AND created_at <= p_now
     GROUP BY staff_id HAVING count(*) >= pol.imp_starts_per_day
  LOOP
    IF public.sir_raise('impersonation_volume', 'high', r.staff_id, NULL, p_now - interval '24 hours', p_now, r.n,
         pol.imp_starts_per_day, 'impersonation-volume', 'impvol:' || r.staff_id || ':' || to_char(p_now AT TIME ZONE 'UTC', 'YYYYMMDD')) IS NOT NULL
    THEN made := made + 1; END IF;
  END LOOP;

  -- R2 impersonation_breadth: impersonating many DIFFERENT customer accounts in 24 h
  FOR r IN
    SELECT staff_id, count(DISTINCT target_account_id)::int AS n FROM staff_audit_log
     WHERE action = 'impersonation_start' AND staff_id IS NOT NULL AND target_account_id IS NOT NULL
       AND created_at > p_now - interval '24 hours' AND created_at <= p_now
     GROUP BY staff_id HAVING count(DISTINCT target_account_id) >= pol.imp_distinct_accounts_per_day
  LOOP
    IF public.sir_raise('impersonation_breadth', 'high', r.staff_id, NULL, p_now - interval '24 hours', p_now, r.n,
         pol.imp_distinct_accounts_per_day, 'impersonation-breadth', 'impbr:' || r.staff_id || ':' || to_char(p_now AT TIME ZONE 'UTC', 'YYYYMMDD')) IS NOT NULL
    THEN made := made + 1; END IF;
  END LOOP;

  -- R3 impersonation_denied: repeated refused attempts (probing; includes non-staff callers the function logged)
  FOR r IN
    SELECT staff_id, count(*)::int AS n FROM staff_audit_log
     WHERE action = 'impersonation_denied' AND staff_id IS NOT NULL
       AND created_at > p_now - interval '1 hour' AND created_at <= p_now
     GROUP BY staff_id HAVING count(*) >= pol.imp_denied_per_hour
  LOOP
    IF public.sir_raise('impersonation_denied', 'high', r.staff_id, NULL, p_now - interval '1 hour', p_now, r.n,
         pol.imp_denied_per_hour, 'impersonation-denied', 'impden:' || r.staff_id || ':' || to_char(p_now AT TIME ZONE 'UTC', 'YYYYMMDDHH24')) IS NOT NULL
    THEN made := made + 1; END IF;
  END LOOP;

  -- R4 impersonation_no_ticket: sessions without a ticket reference, 7 days (the reason is mandatory, the ticket is optional)
  FOR r IN
    SELECT staff_id, count(*)::int AS n FROM staff_impersonation_sessions
     WHERE ticket_ref IS NULL AND started_at > p_now - interval '7 days' AND started_at <= p_now
     GROUP BY staff_id HAVING count(*) >= pol.imp_no_ticket_per_week
  LOOP
    IF public.sir_raise('impersonation_no_ticket', 'medium', r.staff_id, NULL, p_now - interval '7 days', p_now, r.n,
         pol.imp_no_ticket_per_week, 'impersonation-no-ticket', 'impnt:' || r.staff_id || ':' || to_char(p_now AT TIME ZONE 'UTC', 'IYYYIW')) IS NOT NULL
    THEN made := made + 1; END IF;
  END LOOP;

  -- R5 impersonation_off_hours: a session started inside the off-hours window (UTC, from sensitive_read_policy)
  FOR r IN
    SELECT staff_id, count(*)::int AS n FROM staff_audit_log
     WHERE action = 'impersonation_start' AND staff_id IS NOT NULL
       AND created_at > p_now - interval '1 hour' AND created_at <= p_now
       AND public.sir_is_offhours(created_at, srp.offhours_start_utc, srp.offhours_end_utc)
     GROUP BY staff_id
  LOOP
    IF public.sir_raise('impersonation_off_hours', 'medium', r.staff_id, NULL, p_now - interval '1 hour', p_now, r.n,
         1, 'impersonation-off-hours', 'impoff:' || r.staff_id || ':' || to_char(p_now AT TIME ZONE 'UTC', 'YYYYMMDDHH24')) IS NOT NULL
    THEN made := made + 1; END IF;
  END LOOP;

  -- R6 account_enumeration: opening many different customer accounts in the staff explorer in 1 h
  FOR r IN
    SELECT staff_id, count(DISTINCT target_account_id)::int AS n FROM staff_audit_log
     WHERE action = 'account_view' AND staff_id IS NOT NULL AND target_account_id IS NOT NULL
       AND created_at > p_now - interval '1 hour' AND created_at <= p_now
     GROUP BY staff_id HAVING count(DISTINCT target_account_id) >= pol.account_views_per_hour
  LOOP
    IF public.sir_raise('account_enumeration', 'high', r.staff_id, NULL, p_now - interval '1 hour', p_now, r.n,
         pol.account_views_per_hour, 'account-enumeration', 'enum:' || r.staff_id || ':' || to_char(p_now AT TIME ZONE 'UTC', 'YYYYMMDDHH24')) IS NOT NULL
    THEN made := made + 1; END IF;
  END LOOP;

  -- R7 staff_bulk_read: many records read by one staff member (directly or inside an impersonation session) in 10 min
  FOR r IN
    SELECT e.staff_id, sum(e.record_count)::int AS n,
           CASE WHEN count(DISTINCT e.account_id) = 1 THEN (array_agg(e.account_id))[1] END AS acct
      FROM public.sir_staff_read_events(p_now - interval '10 minutes', p_now + interval '1 microsecond') e
     WHERE e.action IN ('view','list','download','api_read','signed_url')
     GROUP BY e.staff_id HAVING sum(e.record_count) >= pol.staff_bulk_records_10min
  LOOP
    IF public.sir_raise('staff_bulk_read', 'high', r.staff_id, r.acct, p_now - interval '10 minutes', p_now, r.n,
         pol.staff_bulk_records_10min, 'staff-bulk-read', 'sbulk:' || r.staff_id || ':' || to_char(p_now AT TIME ZONE 'UTC', 'YYYYMMDDHH24')) IS NOT NULL
    THEN made := made + 1; END IF;
  END LOOP;

  -- R8 staff_export: ANY export of customer data by staff (support has no business exporting tenant data)
  FOR r IN
    SELECT e.staff_id, count(*)::int AS n,
           CASE WHEN count(DISTINCT e.account_id) = 1 THEN (array_agg(e.account_id))[1] END AS acct
      FROM public.sir_staff_read_events(p_now - interval '1 hour', p_now + interval '1 microsecond') e
     WHERE e.asset_class = 'export' OR e.action IN ('export_create','export_download')
     GROUP BY e.staff_id
  LOOP
    IF public.sir_raise('staff_export', 'critical', r.staff_id, r.acct, p_now - interval '1 hour', p_now, r.n,
         1, 'staff-export', 'sexp:' || r.staff_id || ':' || to_char(p_now AT TIME ZONE 'UTC', 'YYYYMMDDHH24')) IS NOT NULL
    THEN made := made + 1; END IF;
  END LOOP;

  RETURN made;
END;
$$;
REVOKE ALL ON FUNCTION public.detect_staff_insider_risk(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_staff_insider_risk(timestamptz) TO service_role;

-- 5. REVIEW RPCs (Vireek staff) -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_staff_insider_alerts(p_status text DEFAULT 'open', p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid, rule text, severity text, staff_id uuid, staff_email text, target_account_id uuid,
               window_start timestamptz, window_end timestamptz, observed integer, threshold integer,
               runbook_key text, status text, created_at timestamptz, resolved_at timestamptz, is_about_you boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('open','acknowledged','dismissed','all') THEN
    RAISE EXCEPTION 'bad status' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT a.id, a.rule, a.severity, a.staff_id, a.staff_email, a.target_account_id, a.window_start, a.window_end,
         a.observed, a.threshold, a.runbook_key, a.status, a.created_at, a.resolved_at, (a.staff_id = auth.uid())
    FROM staff_insider_alerts a
   WHERE p_status = 'all' OR a.status = p_status
   ORDER BY a.created_at DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 200);
END;
$$;
REVOKE ALL ON FUNCTION public.list_staff_insider_alerts(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_staff_insider_alerts(text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_staff_insider_alert_status(p_alert_id uuid, p_status text, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_subject uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('acknowledged','dismissed') THEN
    RAISE EXCEPTION 'bad status' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NULL OR char_length(btrim(p_note)) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'note must be 10..500 characters' USING ERRCODE = '22023';
  END IF;
  IF NOT public.sensitive_read_stepup_ok() THEN
    RAISE EXCEPTION 'step_up_required' USING ERRCODE = 'SR401';
  END IF;
  SELECT staff_id INTO v_subject FROM staff_insider_alerts WHERE id = p_alert_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE = '42501'; END IF;
  IF v_subject = auth.uid() THEN
    RAISE EXCEPTION 'cannot review an alert about yourself' USING ERRCODE = '42501';
  END IF;
  UPDATE staff_insider_alerts
     SET status = p_status, resolved_at = now(), resolved_by = auth.uid(), review_note = btrim(p_note)
   WHERE id = p_alert_id AND status = 'open';
  IF NOT FOUND THEN RAISE EXCEPTION 'already resolved' USING ERRCODE = '42501'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_staff_insider_alert_status(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_staff_insider_alert_status(uuid, text, text) TO authenticated;

-- 6. QUARTERLY ACCESS REVIEW REPORT -----------------------------------------------------------
-- Facts only (no verdicts); scripts/compliance/access-review-report.mjs adds the flags and the sign-off block.
-- Callable by service_role / SQL editor, or by Vireek staff with a recent step-up.
CREATE OR REPLACE FUNCTION public.staff_access_review_report(p_year integer, p_quarter integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_from timestamptz; v_to timestamptz; v_staff jsonb; v_alerts jsonb; v_open_older integer;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
    IF NOT public.sensitive_read_stepup_ok() THEN RAISE EXCEPTION 'step_up_required' USING ERRCODE = 'SR401'; END IF;
  END IF;
  IF p_year NOT BETWEEN 2020 AND 2100 OR p_quarter NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'bad period' USING ERRCODE = '22023';
  END IF;
  v_from := make_timestamptz(p_year, (p_quarter - 1) * 3 + 1, 1, 0, 0, 0, 'UTC');
  v_to   := v_from + interval '3 months';

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'email'), '[]'::jsonb) INTO v_staff FROM (
    SELECT jsonb_build_object(
      'id', p.id, 'email', p.email, 'role', p.role, 'status', p.status, 'created_at', p.created_at,
      'last_sign_in_at', u.last_sign_in_at,
      'mfa_verified_factors', (SELECT count(*) FROM auth.mfa_factors f WHERE f.user_id = p.id AND f.status = 'verified'),
      'impersonation_sessions', (SELECT count(*) FROM staff_impersonation_sessions s WHERE s.staff_id = p.id AND s.started_at >= v_from AND s.started_at < v_to),
      'impersonated_accounts',  (SELECT count(DISTINCT s.target_account_id) FROM staff_impersonation_sessions s WHERE s.staff_id = p.id AND s.started_at >= v_from AND s.started_at < v_to),
      'sessions_without_ticket',(SELECT count(*) FROM staff_impersonation_sessions s WHERE s.staff_id = p.id AND s.ticket_ref IS NULL AND s.started_at >= v_from AND s.started_at < v_to),
      'staff_audit_actions', coalesce((SELECT jsonb_object_agg(a.action, a.n) FROM (
          SELECT l.action, count(*) AS n FROM staff_audit_log l WHERE l.staff_id = p.id AND l.created_at >= v_from AND l.created_at < v_to GROUP BY l.action) a), '{}'::jsonb),
      'sensitive_read_records', coalesce((SELECT sum(e.record_count) FROM public.sir_staff_read_events(v_from, v_to) e WHERE e.staff_id = p.id), 0),
      'sensitive_export_events', (SELECT count(*) FROM public.sir_staff_read_events(v_from, v_to) e WHERE e.staff_id = p.id AND (e.asset_class = 'export' OR e.action IN ('export_create','export_download'))),
      'alerts_in_period', (SELECT count(*) FROM staff_insider_alerts a WHERE a.staff_id = p.id AND a.created_at >= v_from AND a.created_at < v_to),
      'alerts_open', (SELECT count(*) FROM staff_insider_alerts a WHERE a.staff_id = p.id AND a.status = 'open')
    ) AS x
    FROM profiles p LEFT JOIN auth.users u ON u.id = p.id
    WHERE p.is_staff
  ) s;

  SELECT coalesce(jsonb_agg(jsonb_build_object('rule', t.rule, 'severity', t.severity, 'status', t.status, 'count', t.n)
                            ORDER BY t.rule, t.severity, t.status), '[]'::jsonb) INTO v_alerts FROM (
    SELECT rule, severity, status, count(*) AS n FROM staff_insider_alerts
     WHERE created_at >= v_from AND created_at < v_to GROUP BY rule, severity, status) t;

  SELECT count(*) INTO v_open_older FROM staff_insider_alerts WHERE status = 'open' AND created_at < v_from;

  RETURN jsonb_build_object(
    'schema', 'vireek.access-review/v1',
    'generated_at', now(),
    'period', jsonb_build_object('year', p_year, 'quarter', p_quarter, 'from', v_from, 'to', v_to),
    'staff', v_staff,
    'alerts_by_rule', v_alerts,
    'open_alerts_from_earlier_periods', v_open_older,
    'platform_access', public.compliance_access_summary()
  );
END;
$$;
REVOKE ALL ON FUNCTION public.staff_access_review_report(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_access_review_report(integer, integer) TO authenticated, service_role;

-- Scheduler (run once in the SQL editor; pg_cron enabled). Not created here so a migration never silently schedules work:
--   select cron.schedule('staff-insider-detect', '*/5 * * * *', $$select public.detect_staff_insider_risk()$$);
--
-- Rollback (destroys the alert history; export it first):
--   drop function if exists public.staff_access_review_report(integer, integer), public.set_staff_insider_alert_status(uuid, text, text),
--     public.list_staff_insider_alerts(text, integer), public.detect_staff_insider_risk(timestamptz),
--     public.sir_raise(text,text,uuid,uuid,timestamptz,timestamptz,integer,integer,text,text),
--     public.sir_staff_read_events(timestamptz, timestamptz), public.sir_is_offhours(timestamptz, integer, integer);
--   drop table if exists public.staff_insider_alerts, public.staff_insider_policy cascade;
--   drop function if exists public.staff_insider_alerts_guard();
