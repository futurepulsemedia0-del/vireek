-- =============================================================
-- Sensitive READ access log (server-side, immutable, partitioned)
--
-- audit_log records writes. This adds reads of: call recordings,
-- transcripts, customer PII, payment data, documents, exports.
--
--  * No content is ever stored: fixed columns only, target_id must be a UUID.
--  * Written only by SECURITY DEFINER functions / service role. Clients have
--    NO table privileges. UPDATE/DELETE are blocked by trigger; retention is
--    done by DROPping whole monthly partitions.
--  * Single-record "view" repeats by the same actor within 5 minutes are
--    coalesced (policy.coalesce_seconds). Bulk reads/exports are never
--    coalesced: one row with record_count.
--  * Rollback: see the bottom of this file.
-- Depends on: profiles, team_members, audit_log, get_account_owner_id(),
--   is_vireek_staff(), can_export_data(), staff_impersonation_sessions, calls.
-- =============================================================

-- 1. POLICY (singleton) ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sensitive_read_policy (
  id                         boolean PRIMARY KEY DEFAULT true CHECK (id),
  retention_days             integer NOT NULL DEFAULT 400  CHECK (retention_days >= 90),
  coalesce_seconds           integer NOT NULL DEFAULT 300  CHECK (coalesce_seconds BETWEEN 0 AND 3600),
  bulk_records_per_10min     integer NOT NULL DEFAULT 300  CHECK (bulk_records_per_10min > 0),
  export_creates_per_day     integer NOT NULL DEFAULT 20   CHECK (export_creates_per_day > 0),
  export_downloads_per_hour  integer NOT NULL DEFAULT 30   CHECK (export_downloads_per_hour > 0),
  stepup_max_age_seconds     integer NOT NULL DEFAULT 600  CHECK (stepup_max_age_seconds BETWEEN 60 AND 3600),
  stepup_export_min_records  integer NOT NULL DEFAULT 1000 CHECK (stepup_export_min_records > 0),
  scrape_records_10min       integer NOT NULL DEFAULT 200  CHECK (scrape_records_10min > 0),
  offhours_start_utc         integer NOT NULL DEFAULT 22   CHECK (offhours_start_utc BETWEEN 0 AND 23),
  offhours_end_utc           integer NOT NULL DEFAULT 6    CHECK (offhours_end_utc BETWEEN 0 AND 23),
  offhours_records_per_hour  integer NOT NULL DEFAULT 30   CHECK (offhours_records_per_hour > 0),
  export_min_daily_records   integer NOT NULL DEFAULT 5000 CHECK (export_min_daily_records > 0),
  export_spike_multiplier    integer NOT NULL DEFAULT 3    CHECK (export_spike_multiplier >= 2)
);
INSERT INTO public.sensitive_read_policy (id) VALUES (true) ON CONFLICT DO NOTHING;
ALTER TABLE public.sensitive_read_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sensitive_read_policy FROM PUBLIC, anon, authenticated;

-- 2. LOG (partitioned, append-only) --------------------------------------------
CREATE TABLE IF NOT EXISTS public.sensitive_read_log (
  id                        uuid        NOT NULL DEFAULT gen_random_uuid(),
  occurred_at               timestamptz NOT NULL DEFAULT now(),
  account_id                uuid        NOT NULL,
  actor_kind                text        NOT NULL CHECK (actor_kind IN ('user','staff','api_key','system','public_link')),
  actor_id                  uuid,
  api_key_id                uuid,
  impersonation_session_id  uuid,
  asset_class               text        NOT NULL CHECK (asset_class IN ('call_recording','transcript','customer_pii','payment_data','document','export')),
  action                    text        NOT NULL CHECK (action IN ('view','list','download','export_create','export_download','signed_url','api_read')),
  channel                   text        NOT NULL CHECK (channel IN ('ui','rpc','edge','api','export','staff')),
  target_table              text        CHECK (target_table IS NULL OR target_table ~ '^[a-z_]{1,63}$'),
  target_id                 text        CHECK (target_id IS NULL OR target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  record_count              integer     NOT NULL DEFAULT 1 CHECK (record_count BETWEEN 1 AND 10000000),
  purpose                   text        NOT NULL DEFAULT 'service_delivery'
                            CHECK (purpose IN ('service_delivery','support_ticket','security_review','legal_hold','customer_export','integration')),
  request_id                text        CHECK (request_id IS NULL OR request_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  PRIMARY KEY (occurred_at, id)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS public.sensitive_read_log_default PARTITION OF public.sensitive_read_log DEFAULT;

CREATE INDEX IF NOT EXISTS idx_srl_account_time ON public.sensitive_read_log (account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_srl_target       ON public.sensitive_read_log (account_id, target_id, occurred_at DESC) WHERE target_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_srl_actor        ON public.sensitive_read_log (account_id, actor_id, occurred_at DESC) WHERE actor_id IS NOT NULL;

ALTER TABLE public.sensitive_read_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sensitive_read_log FROM PUBLIC, anon, authenticated;
-- No client policies on purpose: reads go through the RPCs below.

CREATE OR REPLACE FUNCTION public.sensitive_read_log_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.sensitive_log_erasure', true) = 'on' AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'sensitive_read_log is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS trg_srl_immutable ON public.sensitive_read_log;
CREATE TRIGGER trg_srl_immutable BEFORE UPDATE OR DELETE ON public.sensitive_read_log
  FOR EACH ROW EXECUTE FUNCTION public.sensitive_read_log_immutable();

-- 3. PARTITION MAINTENANCE ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_sensitive_read_partitions(p_months_ahead integer DEFAULT 3)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m date; made integer := 0; nm text;
BEGIN
  FOR i IN -1 .. GREATEST(p_months_ahead, 1) LOOP
    m := (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i))::date;
    nm := 'sensitive_read_log_' || to_char(m, 'YYYYMM');
    IF to_regclass('public.' || nm) IS NULL THEN
      BEGIN
        EXECUTE format('CREATE TABLE public.%I PARTITION OF public.sensitive_read_log FOR VALUES FROM (%L) TO (%L)',
                       nm, m::timestamptz, (m + interval '1 month')::timestamptz);
        made := made + 1;
      EXCEPTION WHEN invalid_object_definition THEN
        NULL; -- rows for that month already sit in the default partition; leave as is
      END;
    END IF;
  END LOOP;
  RETURN made;
END;
$$;

CREATE OR REPLACE FUNCTION public.drop_expired_sensitive_read_partitions()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; dropped integer := 0; keep_days integer; month_end date;
BEGIN
  SELECT retention_days INTO keep_days FROM sensitive_read_policy WHERE id;
  FOR r IN
    SELECT c.relname FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.sensitive_read_log'::regclass AND c.relname ~ '^sensitive_read_log_[0-9]{6}$'
  LOOP
    month_end := (to_date(substr(r.relname, 20, 6), 'YYYYMM') + interval '1 month')::date;
    IF month_end < (now() - make_interval(days => keep_days))::date THEN
      EXECUTE format('DROP TABLE public.%I', r.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END;
$$;
REVOKE ALL ON FUNCTION public.ensure_sensitive_read_partitions(integer), public.drop_expired_sensitive_read_partitions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_sensitive_read_partitions(integer), public.drop_expired_sensitive_read_partitions() TO service_role;
SELECT public.ensure_sensitive_read_partitions(3);

-- 4. SETTINGS (who may see viewer names) -------------------------------------------
CREATE TABLE IF NOT EXISTS public.sensitive_read_settings (
  account_id          uuid PRIMARY KEY,
  show_viewers_to_team boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sensitive_read_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_select_sensitive_read_settings" ON public.sensitive_read_settings;
CREATE POLICY "owner_select_sensitive_read_settings" ON public.sensitive_read_settings FOR SELECT TO authenticated
  USING (account_id = auth.uid());
REVOKE ALL ON public.sensitive_read_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sensitive_read_settings TO authenticated;  -- writes only via set_sensitive_read_viewer_visibility()

-- 5. HELPERS -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sr_caller_can(p_perms text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.account_owner_id = public.get_account_owner_id()
        AND lower(tm.member_email) = lower((SELECT email FROM auth.users WHERE id = auth.uid()))
        AND EXISTS (SELECT 1 FROM unnest(p_perms) p WHERE (tm.permissions ->> p) = 'true')
    )
  );
$$;
REVOKE ALL ON FUNCTION public.sr_caller_can(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sr_caller_can(text[]) TO authenticated;

-- Step-up: caller authenticated recently (any method); if the user has a verified
-- MFA factor, the session must also be aal2.
CREATE OR REPLACE FUNCTION public.sensitive_read_stepup_ok()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE age integer; recent boolean; has_mfa boolean; aal text := auth.jwt() ->> 'aal';
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  SELECT stepup_max_age_seconds INTO age FROM sensitive_read_policy WHERE id;
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(auth.jwt() -> 'amr', '[]'::jsonb)) e
    WHERE jsonb_typeof(e) = 'object' AND (e ->> 'timestamp') ~ '^[0-9]+$'
      AND to_timestamp((e ->> 'timestamp')::bigint) >= now() - make_interval(secs => age)
  ) INTO recent;
  SELECT EXISTS (SELECT 1 FROM auth.mfa_factors WHERE user_id = auth.uid() AND status = 'verified') INTO has_mfa;
  RETURN recent AND (NOT has_mfa OR aal = 'aal2');
END;
$$;
REVOKE ALL ON FUNCTION public.sensitive_read_stepup_ok() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sensitive_read_stepup_ok() TO authenticated;

-- 6. TRUSTED WRITER (service role / other SECURITY DEFINER functions only) -----------
CREATE OR REPLACE FUNCTION public.log_sensitive_read(
  p_account_id uuid, p_actor_kind text, p_actor_id uuid, p_api_key_id uuid,
  p_asset_class text, p_action text, p_channel text,
  p_target_table text DEFAULT NULL, p_target_id text DEFAULT NULL,
  p_record_count integer DEFAULT 1, p_purpose text DEFAULT 'service_delivery',
  p_request_id text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid := gen_random_uuid(); v_coalesce integer; v_imp uuid;
BEGIN
  SELECT coalesce_seconds INTO v_coalesce FROM sensitive_read_policy WHERE id;

  IF p_action = 'view' AND p_record_count = 1 AND p_target_id IS NOT NULL AND v_coalesce > 0 AND EXISTS (
    SELECT 1 FROM sensitive_read_log l
    WHERE l.account_id = p_account_id AND l.actor_kind = p_actor_kind
      AND l.actor_id IS NOT DISTINCT FROM p_actor_id AND l.api_key_id IS NOT DISTINCT FROM p_api_key_id
      AND l.target_id = p_target_id AND l.asset_class = p_asset_class AND l.action = 'view'
      AND l.occurred_at > now() - make_interval(secs => v_coalesce)
  ) THEN
    RETURN NULL; -- coalesced
  END IF;

  IF p_actor_kind = 'user' AND p_actor_id IS NOT NULL AND p_actor_id = p_account_id THEN
    SELECT s.id INTO v_imp FROM staff_impersonation_sessions s
    WHERE s.target_account_id = p_account_id AND s.ended_at IS NULL AND s.expires_at > now()
    ORDER BY s.started_at DESC LIMIT 1;
  END IF;

  INSERT INTO sensitive_read_log (id, account_id, actor_kind, actor_id, api_key_id, impersonation_session_id,
    asset_class, action, channel, target_table, target_id, record_count, purpose, request_id)
  VALUES (v_id, p_account_id, p_actor_kind, p_actor_id, p_api_key_id, v_imp,
    p_asset_class, p_action, p_channel, p_target_table, p_target_id, GREATEST(p_record_count, 1), p_purpose, p_request_id);
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.log_sensitive_read(uuid,text,uuid,uuid,text,text,text,text,text,integer,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_sensitive_read(uuid,text,uuid,uuid,text,text,text,text,text,integer,text,text) TO service_role;

-- Per-actor rate limit over the log itself (records in the last 10 minutes).
CREATE OR REPLACE FUNCTION public.sr_enforce_bulk_limit(p_account uuid, p_actor uuid, p_requested integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE lim integer; used bigint;
BEGIN
  SELECT bulk_records_per_10min INTO lim FROM sensitive_read_policy WHERE id;
  SELECT COALESCE(sum(record_count), 0) INTO used FROM sensitive_read_log
   WHERE account_id = p_account AND actor_id = p_actor AND occurred_at > now() - interval '10 minutes';
  IF used + p_requested > lim THEN
    RAISE EXCEPTION 'sensitive_read_rate_limited' USING ERRCODE = 'SR429';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.sr_enforce_bulk_limit(uuid,uuid,integer) FROM PUBLIC, anon, authenticated;

-- 7. PROTECTED READ: call recording + transcript ----------------------------------------
CREATE OR REPLACE FUNCTION public.read_call_sensitive(p_call_id uuid)
RETURNS TABLE (recording_url text, transcript text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_acc uuid; v_rec text; v_tr text; v_found boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  v_acc := public.get_account_owner_id();
  IF v_acc IS NULL OR NOT public.sr_caller_can(ARRAY['can_view_billing','can_view_all_jobs']) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  PERFORM public.sr_enforce_bulk_limit(v_acc, v_uid, 1);

  SELECT true, c.recording_url, c.transcript INTO v_found, v_rec, v_tr
  FROM calls c WHERE c.id = p_call_id AND c.user_id = v_acc;
  IF NOT COALESCE(v_found, false) THEN RETURN; END IF;

  IF v_rec IS NOT NULL THEN
    PERFORM public.log_sensitive_read(v_acc, 'user', v_uid, NULL, 'call_recording', 'view', 'rpc', 'calls', p_call_id::text);
  END IF;
  IF v_tr IS NOT NULL THEN
    PERFORM public.log_sensitive_read(v_acc, 'user', v_uid, NULL, 'transcript', 'view', 'rpc', 'calls', p_call_id::text);
  END IF;
  recording_url := v_rec; transcript := v_tr; RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.read_call_sensitive(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.read_call_sensitive(uuid) TO authenticated;

-- 8. EXPORT GATE (called by export-run before create / before minting a signed URL) --
CREATE OR REPLACE FUNCTION public.begin_sensitive_export_action(p_action text, p_target_id text, p_record_count integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_acc uuid; pol sensitive_read_policy%ROWTYPE; n bigint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  IF p_action NOT IN ('export_create','export_download') THEN RAISE EXCEPTION 'bad action' USING ERRCODE = '22023'; END IF;
  v_acc := public.get_account_owner_id();
  IF v_acc IS NULL OR NOT public.can_export_data() THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  SELECT * INTO pol FROM sensitive_read_policy WHERE id;

  IF p_action = 'export_download' OR p_record_count >= pol.stepup_export_min_records THEN
    IF NOT public.sensitive_read_stepup_ok() THEN RAISE EXCEPTION 'step_up_required' USING ERRCODE = 'SR401'; END IF;
  END IF;

  IF p_action = 'export_create' THEN
    SELECT count(*) INTO n FROM sensitive_read_log WHERE account_id = v_acc AND actor_id = v_uid
      AND action = 'export_create' AND occurred_at > now() - interval '1 day';
    IF n >= pol.export_creates_per_day THEN RAISE EXCEPTION 'sensitive_read_rate_limited' USING ERRCODE = 'SR429'; END IF;
  ELSE
    SELECT count(*) INTO n FROM sensitive_read_log WHERE account_id = v_acc AND actor_id = v_uid
      AND action = 'export_download' AND occurred_at > now() - interval '1 hour';
    IF n >= pol.export_downloads_per_hour THEN RAISE EXCEPTION 'sensitive_read_rate_limited' USING ERRCODE = 'SR429'; END IF;
  END IF;

  PERFORM public.log_sensitive_read(v_acc, 'user', v_uid, NULL, 'export', p_action, 'export', 'export_jobs',
                                    p_target_id, GREATEST(p_record_count, 1), 'customer_export');
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.begin_sensitive_export_action(text,text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.begin_sensitive_export_action(text,text,integer) TO authenticated;

-- 9. VISIBILITY ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_sensitive_read_viewer_visibility(p_show boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()) THEN
    RAISE EXCEPTION 'owner only' USING ERRCODE = '42501';
  END IF;
  INSERT INTO sensitive_read_settings (account_id, show_viewers_to_team, updated_at)
  VALUES (auth.uid(), p_show, now())
  ON CONFLICT (account_id) DO UPDATE SET show_viewers_to_team = EXCLUDED.show_viewers_to_team, updated_at = now();
  PERFORM public.log_audit_event(auth.uid(), 'changed_access_history_visibility', 'sensitive_read_settings', auth.uid()::text,
                                 jsonb_build_object('changes', jsonb_build_object('show_viewers_to_team', jsonb_build_object('to', p_show))));
END;
$$;
REVOKE ALL ON FUNCTION public.set_sensitive_read_viewer_visibility(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_sensitive_read_viewer_visibility(boolean) TO authenticated;

-- Per-record access history. Owners / team managers always; other members only when the owner enabled it.
-- Vireek staff are NEVER named to the customer: shown as kind 'vireek_support'.
CREATE OR REPLACE FUNCTION public.list_sensitive_access_history(
  p_target_table text, p_target_id uuid, p_limit integer DEFAULT 50, p_before timestamptz DEFAULT NULL)
RETURNS TABLE (occurred_at timestamptz, viewer_kind text, viewer_email text, asset_class text, action text, channel text, record_count integer, is_you boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_acc uuid := public.get_account_owner_id(); v_show boolean;
BEGIN
  IF auth.uid() IS NULL OR v_acc IS NULL THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE((SELECT show_viewers_to_team FROM sensitive_read_settings WHERE account_id = v_acc), false) INTO v_show;
  IF NOT (public.sr_caller_can(ARRAY['can_manage_team']) OR (v_show AND public.sr_caller_can(ARRAY['can_view_billing','can_view_all_jobs']))) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT l.occurred_at,
         CASE WHEN l.actor_kind = 'staff' OR l.impersonation_session_id IS NOT NULL THEN 'vireek_support' ELSE l.actor_kind END,
         CASE WHEN l.actor_kind = 'user' AND l.impersonation_session_id IS NULL THEN (SELECT u.email::text FROM auth.users u WHERE u.id = l.actor_id) END,
         l.asset_class, l.action, l.channel, l.record_count, (l.actor_id = auth.uid())
  FROM sensitive_read_log l
  WHERE l.account_id = v_acc AND l.target_table = p_target_table AND l.target_id = p_target_id::text
    AND (p_before IS NULL OR l.occurred_at < p_before)
  ORDER BY l.occurred_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 200);
END;
$$;
REVOKE ALL ON FUNCTION public.list_sensitive_access_history(text,uuid,integer,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_sensitive_access_history(text,uuid,integer,timestamptz) TO authenticated;

-- Staff-access trail visible to the customer (owner only).
CREATE OR REPLACE FUNCTION public.list_staff_access_trail(p_limit integer DEFAULT 100, p_before timestamptz DEFAULT NULL)
RETURNS TABLE (occurred_at timestamptz, event text, asset_class text, record_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()) THEN
    RAISE EXCEPTION 'owner only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT t.occurred_at, t.event, t.asset_class, t.record_count FROM (
    SELECT l.occurred_at, l.action AS event, l.asset_class, l.record_count
      FROM sensitive_read_log l
     WHERE l.account_id = auth.uid() AND (l.actor_kind = 'staff' OR l.impersonation_session_id IS NOT NULL)
    UNION ALL
    SELECT s.created_at, s.action, NULL::text, NULL::integer
      FROM staff_audit_log s
     WHERE s.target_account_id = auth.uid() AND s.action IN ('account_view','impersonation_start','impersonation_end')
  ) t
  WHERE p_before IS NULL OR t.occurred_at < p_before
  ORDER BY t.occurred_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 200);
END;
$$;
REVOKE ALL ON FUNCTION public.list_staff_access_trail(integer,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_staff_access_trail(integer,timestamptz) TO authenticated;

-- 10. DETECTION ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sensitive_read_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL,
  rule          text NOT NULL CHECK (rule IN ('bulk_scraping','off_hours_spike','former_employee_access','export_volume')),
  severity      text NOT NULL CHECK (severity IN ('medium','high','critical')),
  actor_id      uuid,
  window_start  timestamptz NOT NULL,
  window_end    timestamptz NOT NULL,
  observed      integer NOT NULL,
  threshold     integer NOT NULL,
  runbook_key   text NOT NULL,
  dedupe_key    text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','dismissed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   uuid
);
CREATE INDEX IF NOT EXISTS idx_sra_account_status ON public.sensitive_read_alerts (account_id, status, created_at DESC);
ALTER TABLE public.sensitive_read_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_select_sensitive_read_alerts" ON public.sensitive_read_alerts;
CREATE POLICY "owner_select_sensitive_read_alerts" ON public.sensitive_read_alerts FOR SELECT TO authenticated
  USING (account_id = auth.uid());
REVOKE ALL ON public.sensitive_read_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sensitive_read_alerts TO authenticated;

CREATE OR REPLACE FUNCTION public.set_sensitive_read_alert_status(p_alert_id uuid, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('acknowledged','dismissed') THEN RAISE EXCEPTION 'bad status' USING ERRCODE = '22023'; END IF;
  UPDATE sensitive_read_alerts SET status = p_status, resolved_at = now(), resolved_by = auth.uid()
   WHERE id = p_alert_id AND account_id = auth.uid() AND status = 'open';
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE = '42501'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_sensitive_read_alert_status(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_sensitive_read_alert_status(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.detect_sensitive_read_anomalies(p_now timestamptz DEFAULT now())
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE pol sensitive_read_policy%ROWTYPE; r record; made integer := 0; ins integer;
BEGIN
  SELECT * INTO pol FROM sensitive_read_policy WHERE id;

  -- Rule 1: bulk scraping (records read by one actor in 10 minutes)
  FOR r IN
    SELECT account_id, actor_id, sum(record_count)::int AS n FROM sensitive_read_log
     WHERE occurred_at > p_now - interval '10 minutes' AND occurred_at <= p_now
       AND actor_id IS NOT NULL AND action IN ('view','list','download','api_read','signed_url')
     GROUP BY account_id, actor_id HAVING sum(record_count) >= pol.scrape_records_10min
  LOOP
    INSERT INTO sensitive_read_alerts (account_id, rule, severity, actor_id, window_start, window_end, observed, threshold, runbook_key, dedupe_key)
    VALUES (r.account_id, 'bulk_scraping', 'high', r.actor_id, p_now - interval '10 minutes', p_now, r.n, pol.scrape_records_10min,
            'bulk-scraping', 'bulk:' || r.account_id || ':' || r.actor_id || ':' || to_char(date_trunc('hour', p_now), 'YYYYMMDDHH24'))
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS ins = ROW_COUNT; made := made + ins;
  END LOOP;

  -- Rule 2: off-hours spike (UTC window from policy; actor has little off-hours history)
  FOR r IN
    SELECT account_id, actor_id, sum(record_count)::int AS n FROM sensitive_read_log
     WHERE occurred_at > p_now - interval '1 hour' AND occurred_at <= p_now AND actor_id IS NOT NULL
       AND (CASE WHEN pol.offhours_start_utc > pol.offhours_end_utc
                 THEN extract(hour FROM occurred_at AT TIME ZONE 'UTC') >= pol.offhours_start_utc OR extract(hour FROM occurred_at AT TIME ZONE 'UTC') < pol.offhours_end_utc
                 ELSE extract(hour FROM occurred_at AT TIME ZONE 'UTC') >= pol.offhours_start_utc AND extract(hour FROM occurred_at AT TIME ZONE 'UTC') < pol.offhours_end_utc END)
     GROUP BY account_id, actor_id HAVING sum(record_count) >= pol.offhours_records_per_hour
  LOOP
    IF (SELECT COALESCE(sum(l.record_count), 0) FROM sensitive_read_log l
         WHERE l.account_id = r.account_id AND l.actor_id = r.actor_id
           AND l.occurred_at BETWEEN p_now - interval '14 days' AND p_now - interval '1 hour'
           AND (CASE WHEN pol.offhours_start_utc > pol.offhours_end_utc
                 THEN extract(hour FROM l.occurred_at AT TIME ZONE 'UTC') >= pol.offhours_start_utc OR extract(hour FROM l.occurred_at AT TIME ZONE 'UTC') < pol.offhours_end_utc
                 ELSE extract(hour FROM l.occurred_at AT TIME ZONE 'UTC') >= pol.offhours_start_utc AND extract(hour FROM l.occurred_at AT TIME ZONE 'UTC') < pol.offhours_end_utc END)) < 10 THEN
      INSERT INTO sensitive_read_alerts (account_id, rule, severity, actor_id, window_start, window_end, observed, threshold, runbook_key, dedupe_key)
      VALUES (r.account_id, 'off_hours_spike', 'medium', r.actor_id, p_now - interval '1 hour', p_now, r.n, pol.offhours_records_per_hour,
              'off-hours-spike', 'off:' || r.account_id || ':' || r.actor_id || ':' || to_char(p_now, 'YYYYMMDD'))
      ON CONFLICT (dedupe_key) DO NOTHING;
      GET DIAGNOSTICS ins = ROW_COUNT; made := made + ins;
    END IF;
  END LOOP;

  -- Rule 3: former-employee access (actor is neither the owner nor a current team member)
  FOR r IN
    SELECT l.account_id, l.actor_id, sum(l.record_count)::int AS n FROM sensitive_read_log l
     WHERE l.occurred_at > p_now - interval '1 hour' AND l.occurred_at <= p_now
       AND l.actor_kind = 'user' AND l.actor_id IS NOT NULL AND l.actor_id <> l.account_id
       AND NOT EXISTS (SELECT 1 FROM team_members tm JOIN auth.users u ON lower(u.email) = lower(tm.member_email)
                        WHERE tm.account_owner_id = l.account_id AND u.id = l.actor_id)
     GROUP BY l.account_id, l.actor_id
  LOOP
    INSERT INTO sensitive_read_alerts (account_id, rule, severity, actor_id, window_start, window_end, observed, threshold, runbook_key, dedupe_key)
    VALUES (r.account_id, 'former_employee_access', 'critical', r.actor_id, p_now - interval '1 hour', p_now, r.n, 1,
            'former-employee-access', 'former:' || r.account_id || ':' || r.actor_id || ':' || to_char(p_now, 'YYYYMMDDHH24'))
    ON CONFLICT (dedupe_key) DO NOTHING;
    GET DIAGNOSTICS ins = ROW_COUNT; made := made + ins;
  END LOOP;

  -- Rule 4: unusual export volume today vs trailing 14-day daily average
  FOR r IN
    SELECT t.account_id, t.n, GREATEST(pol.export_min_daily_records,
             pol.export_spike_multiplier * COALESCE((SELECT sum(h.record_count) / 14.0 FROM sensitive_read_log h
                WHERE h.account_id = t.account_id AND h.action IN ('export_create','export_download')
                  AND h.occurred_at >= date_trunc('day', p_now) - interval '14 days' AND h.occurred_at < date_trunc('day', p_now)), 0))::int AS thr
    FROM (SELECT account_id, sum(record_count)::int AS n FROM sensitive_read_log
           WHERE action IN ('export_create','export_download') AND occurred_at >= date_trunc('day', p_now) AND occurred_at <= p_now
           GROUP BY account_id) t
  LOOP
    IF r.n >= r.thr THEN
      INSERT INTO sensitive_read_alerts (account_id, rule, severity, window_start, window_end, observed, threshold, runbook_key, dedupe_key)
      VALUES (r.account_id, 'export_volume', 'high', date_trunc('day', p_now), p_now, r.n, r.thr,
              'export-volume', 'export:' || r.account_id || ':' || to_char(p_now, 'YYYYMMDD'))
      ON CONFLICT (dedupe_key) DO NOTHING;
      GET DIAGNOSTICS ins = ROW_COUNT; made := made + ins;
    END IF;
  END LOOP;

  -- Push new alerts to the existing audit_log so SIEM streaming picks them up (counts only, no content).
  INSERT INTO audit_log (user_id, actor_id, action, target_table, target_id, metadata)
  SELECT a.account_id, NULL, 'sensitive_read_alert', 'sensitive_read_alerts', a.id::text,
         jsonb_build_object('rule', a.rule, 'severity', a.severity, 'observed', a.observed, 'threshold', a.threshold)
    FROM sensitive_read_alerts a
   WHERE a.created_at >= p_now - interval '1 minute'
     AND NOT EXISTS (SELECT 1 FROM audit_log x WHERE x.action = 'sensitive_read_alert' AND x.target_id = a.id::text);

  RETURN made;
END;
$$;
REVOKE ALL ON FUNCTION public.detect_sensitive_read_anomalies(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_sensitive_read_anomalies(timestamptz) TO service_role;

-- 11. ERASURE (GDPR / delete-account): service role only, bypasses the append-only trigger via a local flag
CREATE OR REPLACE FUNCTION public.erase_sensitive_read_log_for_account(p_account_id uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('app.sensitive_log_erasure', 'on', true);
  DELETE FROM sensitive_read_log WHERE account_id = p_account_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM sensitive_read_alerts WHERE account_id = p_account_id;
  DELETE FROM sensitive_read_settings WHERE account_id = p_account_id;
  PERFORM set_config('app.sensitive_log_erasure', 'off', true);
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.erase_sensitive_read_log_for_account(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erase_sensitive_read_log_for_account(uuid) TO service_role;

-- Scheduler (run once in the SQL editor; pg_cron enabled):
--   select cron.schedule('sensitive-read-detect', '*/5 * * * *', $$select public.detect_sensitive_read_anomalies()$$);
--   select cron.schedule('sensitive-read-partitions', '0 3 1 * *', $$select public.ensure_sensitive_read_partitions(3); select public.drop_expired_sensitive_read_partitions();$$);
--
-- Rollback (destroys the log):
--   drop table public.sensitive_read_alerts, public.sensitive_read_settings, public.sensitive_read_log, public.sensitive_read_policy cascade;
--   then drop the functions: sr_caller_can, sensitive_read_stepup_ok, log_sensitive_read, sr_enforce_bulk_limit, read_call_sensitive,
--   begin_sensitive_export_action, set_sensitive_read_viewer_visibility, list_sensitive_access_history, list_staff_access_trail,
--   set_sensitive_read_alert_status, detect_sensitive_read_anomalies, erase_sensitive_read_log_for_account,
--   ensure_sensitive_read_partitions, drop_expired_sensitive_read_partitions, sensitive_read_log_immutable
