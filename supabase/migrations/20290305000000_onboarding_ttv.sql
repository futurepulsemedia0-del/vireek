/*
  # Onboarding time-to-value (TTV)

  Definitions live in docs/customer-success/ttv.md. This migration is purely additive and idempotent.

  ## What this adds
  1. `account_milestone_events`  the two milestone timestamps that did NOT exist anywhere:
       - `setup_completed`   profiles.onboarding_completed flipped to true (the column had no timestamp)
       - `number_connected`  business_profile got BOTH vapi_phone_number_id and vapi_assistant_id
                             (nothing in the repo stamped when this happened; it is set by hand / staff SQL today)
     Written only by the two triggers below. One row per (account, milestone): re-runs are no-ops.
     The remaining milestones are NOT re-emitted: they are derived from rows that already carry a timestamp
     (first_call_sessions.answered_at, calls.call_datetime, jobs.created_at), using the SAME definitions as
     staff_growth_activation() (>= 20 s, not the guided test call).
  2. `ttv_milestone_config`      ordered milestones + configurable stall threshold (hours) + alert switch.
  3. `ttv_settings`              watch window (days since signup that an account is monitored).
  4. VIEW `account_ttv_v`        one row per owner account: when each milestone happened + seconds from signup.
     VIEW `account_ttv_stalled_v`  accounts whose next milestone is overdue (single definition for alerts and card).
  5. `ttv_stall_alerts`          one ACTIVE alert per (account, stalled milestone); auto-resolved when reached.
  6. `ttv_evaluate_stalls()`     idempotent evaluator (service role / pg_cron, hourly when pg_cron is enabled).
  7. Staff RPCs                  staff_ttv_overview, staff_ttv_alert_ack, staff_ttv_config_set, staff_ttv_settings_set.

  ## Security
  - Every new table and view: RLS on (tables), NO client policies, all privileges revoked from anon/authenticated.
  - Staff RPCs are SECURITY DEFINER, check is_vireek_staff() via _growth_assert_staff() (which also writes the
    staff_audit_log row; reads are audited at most once a minute per view), and set search_path.
  - No emails, phone numbers or transcripts are stored or returned. The card shows company_name only.
  - Triggers are SECURITY DEFINER and swallow their own errors: measuring must never block a profile or
    business_profile write.
  - Accounts created before this migration have no timestamp for the two emitted milestones. The view still
    reports them as reached (from the current column state) with a NULL time, and they are excluded from the
    duration percentiles. Nothing is back-filled with a guessed time.

  ## Requires
  is_vireek_staff(uuid), _growth_assert_staff(text,text) (20281104000000_growth_analytics_phase2), profiles
  (role, onboarding_completed, status, subscription_status), business_profile, calls, jobs, first_call_sessions,
  staff_audit_log.

  ## Rollback (manual, destructive; run only on purpose, in this order)
    SELECT cron.unschedule('vireek-ttv-stalls');   -- only if pg_cron is installed
    DROP FUNCTION IF EXISTS public.staff_ttv_settings_set(integer), public.staff_ttv_config_set(text, integer, boolean),
      public.staff_ttv_alert_ack(uuid), public.staff_ttv_overview(integer), public.ttv_evaluate_stalls();
    DROP VIEW IF EXISTS public.account_ttv_stalled_v, public.account_ttv_v;
    DROP TRIGGER IF EXISTS trg_ttv_business_profile ON public.business_profile;
    DROP TRIGGER IF EXISTS trg_ttv_profile_setup ON public.profiles;
    DROP FUNCTION IF EXISTS public.ttv_on_business_profile(), public.ttv_on_profile_setup();
    DROP TABLE IF EXISTS public.ttv_stall_alerts, public.ttv_settings, public.ttv_milestone_config,
      public.account_milestone_events;
*/

-- rollback: see the commented block above (cron.unschedule, drop 4 staff functions + evaluator, drop 2 views, drop 2 triggers + 2 trigger functions, then drop the 4 tables). Safe while no one depends on the card; data is internal and not customer-facing.

DO $$
BEGIN
  IF to_regprocedure('public.is_vireek_staff(uuid)') IS NULL
     OR to_regprocedure('public._growth_assert_staff(text,text)') IS NULL
     OR to_regclass('public.staff_audit_log') IS NULL
     OR to_regclass('public.profiles') IS NULL
     OR to_regclass('public.business_profile') IS NULL
     OR to_regclass('public.calls') IS NULL
     OR to_regclass('public.jobs') IS NULL
     OR to_regclass('public.first_call_sessions') IS NULL THEN
    RAISE EXCEPTION 'onboarding_ttv: prerequisites missing (staff helpers, profiles, business_profile, calls, jobs, first_call_sessions)';
  END IF;
END $$;

-- =====================================================================
-- 1. Emitted milestone events
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.account_milestone_events (
  account_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  milestone text NOT NULL CHECK (milestone IN ('setup_completed', 'number_connected')),
  reached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, milestone)
);
ALTER TABLE public.account_milestone_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_milestone_events FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.account_milestone_events IS 'First time an owner account reached an onboarding milestone that has no timestamp elsewhere. Trigger-written; staff read via staff_ttv_overview().';

CREATE OR REPLACE FUNCTION public.ttv_on_profile_setup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.onboarding_completed IS TRUE AND NEW.role = 'owner' THEN
    INSERT INTO account_milestone_events (account_id, milestone) VALUES (NEW.id, 'setup_completed')
    ON CONFLICT (account_id, milestone) DO NOTHING;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ttv_on_profile_setup: %', SQLERRM;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ttv_on_profile_setup() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ttv_profile_setup ON public.profiles;
CREATE TRIGGER trg_ttv_profile_setup AFTER INSERT OR UPDATE OF onboarding_completed ON public.profiles
  FOR EACH ROW WHEN (NEW.onboarding_completed IS TRUE)
  EXECUTE FUNCTION public.ttv_on_profile_setup();

CREATE OR REPLACE FUNCTION public.ttv_on_business_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.vapi_phone_number_id IS NOT NULL AND NEW.vapi_assistant_id IS NOT NULL THEN
    INSERT INTO account_milestone_events (account_id, milestone)
    SELECT p.id, 'number_connected' FROM profiles p WHERE p.id = NEW.user_id AND p.role = 'owner'
    ON CONFLICT (account_id, milestone) DO NOTHING;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ttv_on_business_profile: %', SQLERRM;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ttv_on_business_profile() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ttv_business_profile ON public.business_profile;
CREATE TRIGGER trg_ttv_business_profile AFTER INSERT OR UPDATE OF vapi_phone_number_id, vapi_assistant_id ON public.business_profile
  FOR EACH ROW WHEN (NEW.vapi_phone_number_id IS NOT NULL AND NEW.vapi_assistant_id IS NOT NULL)
  EXECUTE FUNCTION public.ttv_on_business_profile();

-- Indexes for the per-account lookups are NOT created here (CREATE INDEX on existing tables blocks writes).
-- Optional, off-peak: supabase/ops/20290305_onboarding_ttv_indexes.sql (CONCURRENTLY). The view works without them.

-- =====================================================================
-- 2. Configuration (order + stall thresholds)  [POLICY defaults, see docs]
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.ttv_milestone_config (
  milestone text PRIMARY KEY CHECK (milestone IN ('setup_completed', 'number_connected', 'first_test_call', 'first_real_call', 'first_job_booked')),
  position smallint NOT NULL UNIQUE CHECK (position BETWEEN 1 AND 5),
  label text NOT NULL,
  stall_hours integer NOT NULL CHECK (stall_hours BETWEEN 1 AND 2160),
  alert_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
ALTER TABLE public.ttv_milestone_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ttv_milestone_config FROM PUBLIC, anon, authenticated;

INSERT INTO public.ttv_milestone_config (milestone, position, label, stall_hours) VALUES
  ('setup_completed',  1, 'Setup completed',     24),
  ('number_connected', 2, 'Number connected',    72),
  ('first_test_call',  3, 'First test call',     48),
  ('first_real_call',  4, 'First real call',    168),
  ('first_job_booked', 5, 'First job booked',   336)
ON CONFLICT (milestone) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ttv_settings (
  key text PRIMARY KEY CHECK (key IN ('watch_days')),
  int_value integer NOT NULL CHECK (int_value BETWEEN 7 AND 365),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
ALTER TABLE public.ttv_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ttv_settings FROM PUBLIC, anon, authenticated;
INSERT INTO public.ttv_settings (key, int_value) VALUES ('watch_days', 60) ON CONFLICT (key) DO NOTHING;

-- =====================================================================
-- 3. Per-account time-to-milestone view (service role / SECURITY DEFINER callers only)
--    Real-call and booking rules mirror staff_growth_activation(): >= 20 s, not the guided test call.
-- =====================================================================
CREATE OR REPLACE VIEW public.account_ttv_v AS
WITH base AS (
  SELECT o.id AS account_id, o.created_at AS signup_at, o.status AS account_status, o.subscription_status,
         (e1.account_id IS NOT NULL OR o.onboarding_completed) AS setup_reached,
         e1.reached_at AS setup_completed_at,
         (e2.account_id IS NOT NULL OR (bp.vapi_phone_number_id IS NOT NULL AND bp.vapi_assistant_id IS NOT NULL)) AS number_reached,
         e2.reached_at AS number_connected_at,
         tc.t AS first_test_call_at,
         rc.t AS first_real_call_at,
         jb.t AS first_job_booked_at
    FROM public.profiles o
    LEFT JOIN public.account_milestone_events e1 ON e1.account_id = o.id AND e1.milestone = 'setup_completed'
    LEFT JOIN public.account_milestone_events e2 ON e2.account_id = o.id AND e2.milestone = 'number_connected'
    LEFT JOIN public.business_profile bp ON bp.user_id = o.id
    LEFT JOIN LATERAL (
      SELECT min(f.answered_at) AS t FROM public.first_call_sessions f
       WHERE f.user_id = o.id AND f.answered_at IS NOT NULL
    ) tc ON true
    LEFT JOIN LATERAL (
      SELECT min(c.call_datetime) AS t FROM public.calls c
       WHERE c.user_id = o.id AND coalesce(c.duration_seconds, 0) >= 20
         AND NOT EXISTS (SELECT 1 FROM public.first_call_sessions f WHERE f.call_id = c.id)
    ) rc ON true
    LEFT JOIN LATERAL (
      SELECT min(j.created_at) AS t FROM public.jobs j
       WHERE j.user_id = o.id AND j.call_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.first_call_sessions f WHERE f.call_id = j.call_id)
    ) jb ON true
   WHERE o.role = 'owner'
), pos AS (
  SELECT b.*,
         greatest(
           CASE WHEN b.setup_reached THEN 1 ELSE 0 END,
           CASE WHEN b.number_reached THEN 2 ELSE 0 END,
           CASE WHEN b.first_test_call_at IS NOT NULL THEN 3 ELSE 0 END,
           CASE WHEN b.first_real_call_at IS NOT NULL THEN 4 ELSE 0 END,
           CASE WHEN b.first_job_booked_at IS NOT NULL THEN 5 ELSE 0 END
         ) AS furthest_position
    FROM base b
)
SELECT p.account_id, p.signup_at, p.account_status, p.subscription_status,
       p.setup_reached, p.setup_completed_at,
       p.number_reached, p.number_connected_at,
       p.first_test_call_at, p.first_real_call_at, p.first_job_booked_at,
       CASE WHEN p.setup_completed_at IS NULL THEN NULL ELSE greatest(extract(epoch FROM p.setup_completed_at - p.signup_at), 0) END AS seconds_to_setup_completed,
       CASE WHEN p.number_connected_at IS NULL THEN NULL ELSE greatest(extract(epoch FROM p.number_connected_at - p.signup_at), 0) END AS seconds_to_number_connected,
       CASE WHEN p.first_test_call_at IS NULL THEN NULL ELSE greatest(extract(epoch FROM p.first_test_call_at - p.signup_at), 0) END AS seconds_to_first_test_call,
       CASE WHEN p.first_real_call_at IS NULL THEN NULL ELSE greatest(extract(epoch FROM p.first_real_call_at - p.signup_at), 0) END AS seconds_to_first_real_call,
       CASE WHEN p.first_job_booked_at IS NULL THEN NULL ELSE greatest(extract(epoch FROM p.first_job_booked_at - p.signup_at), 0) END AS seconds_to_first_job_booked,
       p.furthest_position::smallint AS furthest_position,
       CASE WHEN p.furthest_position >= 5 THEN NULL ELSE (p.furthest_position + 1)::smallint END AS next_position,
       greatest(p.signup_at, p.setup_completed_at, p.number_connected_at, p.first_test_call_at, p.first_real_call_at, p.first_job_booked_at) AS last_progress_at
  FROM pos p;
REVOKE ALL ON public.account_ttv_v FROM PUBLIC, anon, authenticated;
COMMENT ON VIEW public.account_ttv_v IS 'Per-owner-account onboarding milestones and seconds from signup. NULL time + reached=true means reached before event capture existed. Service role / SECURITY DEFINER only.';

-- Overdue accounts: next milestone not reached, alerting on for it, last progress older than its threshold.
CREATE OR REPLACE VIEW public.account_ttv_stalled_v AS
SELECT v.account_id, v.signup_at, c.milestone, c.position, c.label, c.stall_hours,
       round((extract(epoch FROM now() - v.last_progress_at) / 3600)::numeric, 1) AS stalled_hours,
       v.last_progress_at
  FROM public.account_ttv_v v
  JOIN public.ttv_milestone_config c ON c.position = v.next_position AND c.alert_enabled
 WHERE v.account_status = 'active'
   AND v.subscription_status IS DISTINCT FROM 'canceled'
   AND v.signup_at > now() - make_interval(days => coalesce((SELECT s.int_value FROM public.ttv_settings s WHERE s.key = 'watch_days'), 60))
   AND now() - v.last_progress_at > make_interval(hours => c.stall_hours);
REVOKE ALL ON public.account_ttv_stalled_v FROM PUBLIC, anon, authenticated;

-- =====================================================================
-- 4. Stall alerts
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.ttv_stall_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  milestone text NOT NULL REFERENCES public.ttv_milestone_config(milestone),
  fired_at timestamptz NOT NULL DEFAULT now(),
  stalled_hours numeric(10, 1) NOT NULL,
  threshold_hours integer NOT NULL,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolution text CHECK (resolution IN ('milestone_reached', 'out_of_scope')),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ttv_stall_active ON public.ttv_stall_alerts (account_id, milestone) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ttv_stall_open ON public.ttv_stall_alerts (fired_at DESC) WHERE resolved_at IS NULL;
ALTER TABLE public.ttv_stall_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ttv_stall_alerts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ttv_evaluate_stalls() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_opened integer := 0; v_resolved integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('ttv_evaluate_stalls')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'already_running');
  END IF;

  -- Resolve first: milestone reached (or passed), or the account left the watched set.
  WITH r AS (
    SELECT a.id,
           CASE WHEN v.account_id IS NOT NULL AND v.furthest_position >= c.position THEN 'milestone_reached' ELSE 'out_of_scope' END AS resolution
      FROM ttv_stall_alerts a
      JOIN ttv_milestone_config c ON c.milestone = a.milestone
      LEFT JOIN account_ttv_v v ON v.account_id = a.account_id
     WHERE a.resolved_at IS NULL
       AND (
         v.account_id IS NULL
         OR v.furthest_position >= c.position
         OR v.account_status <> 'active'
         OR v.subscription_status IS NOT DISTINCT FROM 'canceled'
         OR v.signup_at <= now() - make_interval(days => coalesce((SELECT s.int_value FROM ttv_settings s WHERE s.key = 'watch_days'), 60))
       )
  )
  UPDATE ttv_stall_alerts t SET resolved_at = now(), resolution = r.resolution FROM r WHERE t.id = r.id;
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  INSERT INTO ttv_stall_alerts (account_id, milestone, stalled_hours, threshold_hours)
  SELECT s.account_id, s.milestone, s.stalled_hours, s.stall_hours FROM account_ttv_stalled_v s
  ON CONFLICT (account_id, milestone) WHERE resolved_at IS NULL DO NOTHING;
  GET DIAGNOSTICS v_opened = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'opened', v_opened, 'resolved', v_resolved);
END $$;
REVOKE ALL ON FUNCTION public.ttv_evaluate_stalls() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ttv_evaluate_stalls() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('vireek-ttv-stalls', '17 * * * *', 'select public.ttv_evaluate_stalls()');
  ELSE
    RAISE NOTICE 'pg_cron not enabled: call public.ttv_evaluate_stalls() hourly from an external scheduler (service role).';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'ttv: could not schedule vireek-ttv-stalls (%). Schedule ttv_evaluate_stalls() externally.', SQLERRM;
END $$;

-- =====================================================================
-- 5. Staff RPCs
-- =====================================================================
CREATE OR REPLACE FUNCTION public.staff_ttv_overview(p_days integer DEFAULT 30) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM public._growth_assert_staff('ttv_overview');
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RAISE EXCEPTION 'invalid_days' USING ERRCODE = '22023';
  END IF;

  WITH cohort AS (
    SELECT * FROM account_ttv_v WHERE signup_at >= now() - make_interval(days => p_days)
     ORDER BY signup_at DESC LIMIT 5000
  ), m AS (
    SELECT c.milestone, c.position, c.label,
      count(*) FILTER (WHERE k.account_id IS NOT NULL AND ((c.position = 1 AND k.setup_reached) OR (c.position = 2 AND k.number_reached)
                         OR (c.position = 3 AND k.first_test_call_at IS NOT NULL) OR (c.position = 4 AND k.first_real_call_at IS NOT NULL)
                         OR (c.position = 5 AND k.first_job_booked_at IS NOT NULL))) AS reached,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE c.position WHEN 1 THEN k.seconds_to_setup_completed WHEN 2 THEN k.seconds_to_number_connected
        WHEN 3 THEN k.seconds_to_first_test_call WHEN 4 THEN k.seconds_to_first_real_call ELSE k.seconds_to_first_job_booked END) AS p50,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY CASE c.position WHEN 1 THEN k.seconds_to_setup_completed WHEN 2 THEN k.seconds_to_number_connected
        WHEN 3 THEN k.seconds_to_first_test_call WHEN 4 THEN k.seconds_to_first_real_call ELSE k.seconds_to_first_job_booked END) AS p90
    FROM ttv_milestone_config c LEFT JOIN cohort k ON true GROUP BY c.milestone, c.position, c.label
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'window_days', p_days,
    'signups', (SELECT count(*) FROM cohort),
    'truncated', (SELECT count(*) >= 5000 FROM cohort),
    'watch_days', coalesce((SELECT int_value FROM ttv_settings WHERE key = 'watch_days'), 60),
    'stalled_now', (SELECT count(*) FROM account_ttv_stalled_v),
    'milestones', coalesce((SELECT jsonb_agg(jsonb_build_object('milestone', m.milestone, 'position', m.position, 'label', m.label,
        'reached', m.reached, 'p50_seconds', m.p50, 'p90_seconds', m.p90) ORDER BY m.position) FROM m), '[]'::jsonb),
    'config', coalesce((SELECT jsonb_agg(jsonb_build_object('milestone', c.milestone, 'position', c.position, 'label', c.label,
        'stall_hours', c.stall_hours, 'alert_enabled', c.alert_enabled) ORDER BY c.position) FROM ttv_milestone_config c), '[]'::jsonb),
    'open_alerts', coalesce((SELECT jsonb_agg(jsonb_build_object('id', q.id, 'account_id', q.account_id, 'company_name', q.company_name,
        'milestone', q.milestone, 'fired_at', q.fired_at, 'stalled_hours', q.stalled_hours, 'threshold_hours', q.threshold_hours,
        'acknowledged', q.acknowledged_at IS NOT NULL) ORDER BY q.fired_at DESC)
      FROM (SELECT a.*, p.company_name FROM ttv_stall_alerts a JOIN profiles p ON p.id = a.account_id
             WHERE a.resolved_at IS NULL ORDER BY a.fired_at DESC LIMIT 50) q), '[]'::jsonb),
    'open_alert_count', (SELECT count(*) FROM ttv_stall_alerts WHERE resolved_at IS NULL)
  ) INTO v_result;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.staff_ttv_alert_ack(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._growth_assert_staff('ttv_alerts', 'write');
  UPDATE ttv_stall_alerts SET acknowledged_at = now(), acknowledged_by = auth.uid()
   WHERE id = p_id AND acknowledged_at IS NULL AND resolved_at IS NULL;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.staff_ttv_config_set(p_milestone text, p_stall_hours integer, p_alert_enabled boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._growth_assert_staff('ttv_config', 'write');
  IF p_stall_hours IS NULL OR p_stall_hours < 1 OR p_stall_hours > 2160 THEN
    RAISE EXCEPTION 'invalid_stall_hours' USING ERRCODE = '22023';
  END IF;
  UPDATE ttv_milestone_config
     SET stall_hours = p_stall_hours, alert_enabled = coalesce(p_alert_enabled, alert_enabled), updated_at = now(), updated_by = auth.uid()
   WHERE milestone = p_milestone;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.staff_ttv_settings_set(p_watch_days integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._growth_assert_staff('ttv_config', 'write');
  IF p_watch_days IS NULL OR p_watch_days < 7 OR p_watch_days > 365 THEN
    RAISE EXCEPTION 'invalid_watch_days' USING ERRCODE = '22023';
  END IF;
  INSERT INTO ttv_settings (key, int_value, updated_by) VALUES ('watch_days', p_watch_days, auth.uid())
  ON CONFLICT (key) DO UPDATE SET int_value = EXCLUDED.int_value, updated_at = now(), updated_by = auth.uid();
  RETURN true;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.staff_ttv_overview(integer)',
    'public.staff_ttv_alert_ack(uuid)',
    'public.staff_ttv_config_set(text,integer,boolean)',
    'public.staff_ttv_settings_set(integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;
