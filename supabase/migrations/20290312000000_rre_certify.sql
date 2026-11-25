/*
  # RRE risk-control layer ("rrCertify") — shadow-first, additive

  Adds: per-account settings (mode defaults to 'off'), immutable calibration snapshots, a "would-have-decided"
  log, a drift state row, and the RPCs the edge functions use. It does NOT touch remote_resolution_* tables,
  rr_apply_turn, the safety screen or any existing policy. Nothing changes for an account until BOTH the
  feature flag `rre_certify` is on for it AND its mode is set to 'shadow' or 'enforce' by the owner.

  Case outcomes are derived from existing data:
    - false resolution = status reopened (reopened_at) or a later job with rework_of_job_id = case.job_id,
      inside W days after resolved_at (see src/lib/rrCertify/outcomes.ts, which mirrors this).

  ROLLBACK (manual, in this order; no data in other tables is affected):
    DROP FUNCTION IF EXISTS public.rr_certify_ack_drift();
    DROP FUNCTION IF EXISTS public.rr_certify_set_drift(uuid, text, integer, integer, numeric, numeric);
    DROP FUNCTION IF EXISTS public.rr_certify_store_snapshot(uuid, jsonb, text);
    DROP FUNCTION IF EXISTS public.rr_certify_log_decision(uuid, smallint, smallint, text, text, text, text, smallint, text, uuid, smallint, text);
    DROP FUNCTION IF EXISTS public.rr_certify_case_outcomes(uuid);
    DROP FUNCTION IF EXISTS public.rr_certify_save_settings(text, numeric, numeric, integer, integer, integer);
    DROP FUNCTION IF EXISTS public.rr_certify_get_settings();
    DROP TABLE IF EXISTS public.rr_certify_decisions, public.rr_certify_drift, public.rr_certify_snapshots, public.rr_certify_settings;
  (Run the rollback only after setting the flag off. The drops are intentionally NOT in this file.)

  Tenancy: every row carries user_id = get_account_owner_id(); RLS lets the owner and team read their own
  account only. Writes go through SECURITY DEFINER RPCs (owner-only for settings, service role for the rest).
  NOT EXECUTED: this file was written without a Postgres instance available. Apply it to a branch database first.
*/

-- =============================================================
-- 1. SETTINGS
-- =============================================================
CREATE TABLE IF NOT EXISTS public.rr_certify_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id(),
  mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'shadow', 'enforce')),
  alpha numeric(5, 4) NOT NULL DEFAULT 0.05 CHECK (alpha BETWEEN 0.005 AND 0.25),
  delta numeric(5, 4) NOT NULL DEFAULT 0.10 CHECK (delta BETWEEN 0.01 AND 0.20),
  window_days smallint NOT NULL DEFAULT 30 CHECK (window_days BETWEEN 7 AND 90),
  min_segment_n integer NOT NULL DEFAULT 150 CHECK (min_segment_n BETWEEN 30 AND 5000),
  min_pooled_n integer NOT NULL DEFAULT 100 CHECK (min_pooled_n BETWEEN 60 AND 20000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.rr_certify_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rr_certify_settings_select" ON public.rr_certify_settings;
CREATE POLICY "rr_certify_settings_select" ON public.rr_certify_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.rr_certify_get_settings()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'mode', coalesce(s.mode, 'off'), 'alpha', coalesce(s.alpha, 0.05), 'delta', coalesce(s.delta, 0.10),
    'windowDays', coalesce(s.window_days, 30), 'minSegmentN', coalesce(s.min_segment_n, 150), 'minPooledN', coalesce(s.min_pooled_n, 100))
  FROM (SELECT public.get_account_owner_id() AS uid) o LEFT JOIN public.rr_certify_settings s ON s.user_id = o.uid
  WHERE o.uid IS NOT NULL;
$$;

-- Owner only. 'enforce' additionally requires the owner to have at least one stored snapshot.
CREATE OR REPLACE FUNCTION public.rr_certify_save_settings(
  p_mode text, p_alpha numeric, p_delta numeric, p_window_days integer, p_min_segment_n integer, p_min_pooled_n integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'RRC_FORBIDDEN: only the account owner can change these settings' USING ERRCODE = 'P0001';
  END IF;
  IF p_mode NOT IN ('off', 'shadow', 'enforce') THEN RAISE EXCEPTION 'RRC_INVALID: mode' USING ERRCODE = 'P0001'; END IF;
  IF p_mode = 'enforce' AND NOT EXISTS (SELECT 1 FROM public.rr_certify_snapshots WHERE user_id = v_owner) THEN
    RAISE EXCEPTION 'RRC_INVALID: enforce needs at least one calibration snapshot' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.rr_certify_settings (user_id, mode, alpha, delta, window_days, min_segment_n, min_pooled_n, updated_at)
  VALUES (v_owner, p_mode, p_alpha, p_delta, p_window_days, p_min_segment_n, p_min_pooled_n, now())
  ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode, alpha = EXCLUDED.alpha, delta = EXCLUDED.delta,
    window_days = EXCLUDED.window_days, min_segment_n = EXCLUDED.min_segment_n, min_pooled_n = EXCLUDED.min_pooled_n, updated_at = now();
  RETURN public.rr_certify_get_settings();
END;
$$;

-- =============================================================
-- 2. SNAPSHOTS (versioned, immutable)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.rr_certify_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  created_at timestamptz NOT NULL DEFAULT now(),
  model_version smallint NOT NULL,
  fingerprint text NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_rr_certify_snapshots_user ON public.rr_certify_snapshots (user_id, created_at DESC);
ALTER TABLE public.rr_certify_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rr_certify_snapshots_select" ON public.rr_certify_snapshots;
CREATE POLICY "rr_certify_snapshots_select" ON public.rr_certify_snapshots FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.rr_certify_snapshots_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'RRC_IMMUTABLE: calibration snapshots cannot be changed or deleted' USING ERRCODE = 'P0001';
END;
$$;
DROP TRIGGER IF EXISTS trg_rr_certify_snapshots_immutable ON public.rr_certify_snapshots;
CREATE TRIGGER trg_rr_certify_snapshots_immutable BEFORE UPDATE OR DELETE ON public.rr_certify_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.rr_certify_snapshots_immutable();

-- =============================================================
-- 3. SHADOW LOG ("would-have-decided")
-- =============================================================
CREATE TABLE IF NOT EXISTS public.rr_certify_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  case_id uuid NOT NULL REFERENCES public.remote_resolution_cases(id) ON DELETE CASCADE,
  turn smallint NOT NULL,
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  category text NOT NULL,
  existing_action text NOT NULL CHECK (existing_action IN ('ask', 'troubleshoot', 'dispatch')),
  would_decide text NOT NULL CHECK (would_decide IN ('allow_remote', 'dispatch')),
  gate_reason text NOT NULL,
  lambda smallint,
  segment_status text,
  snapshot_id uuid REFERENCES public.rr_certify_snapshots(id),
  threshold_at_decision smallint NOT NULL CHECK (threshold_at_decision BETWEEN 0 AND 100),
  mode text NOT NULL CHECK (mode IN ('shadow', 'enforce')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, turn)
);
CREATE INDEX IF NOT EXISTS idx_rr_certify_decisions_user ON public.rr_certify_decisions (user_id, created_at DESC);
ALTER TABLE public.rr_certify_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rr_certify_decisions_select" ON public.rr_certify_decisions;
CREATE POLICY "rr_certify_decisions_select" ON public.rr_certify_decisions FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 4. DRIFT STATE (one row per account)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.rr_certify_drift (
  user_id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'insufficient' CHECK (status IN ('ok', 'alarm', 'insufficient')),
  m integer NOT NULL DEFAULT 0,
  k integer NOT NULL DEFAULT 0,
  reference_rate numeric(6, 5),
  p_value numeric,
  alarmed_at timestamptz,
  acked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.rr_certify_drift ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rr_certify_drift_select" ON public.rr_certify_drift;
CREATE POLICY "rr_certify_drift_select" ON public.rr_certify_drift FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

-- =============================================================
-- 5. SERVICE-ROLE RPCs (edge functions)
-- =============================================================

-- One row per attempted case (attempt_probability set), newest first, capped. Mirrors outcomes.ts.
CREATE OR REPLACE FUNCTION public.rr_certify_case_outcomes(p_user_id uuid)
RETURNS TABLE (case_id uuid, category text, score smallint, threshold smallint, threshold_source text, status text,
               resolved_at timestamptz, reopened_at timestamptz, repeat_job_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.category, c.attempt_probability,
         d.threshold_at_decision,
         CASE WHEN d.threshold_at_decision IS NULL THEN 'assumed_current' ELSE 'logged' END,
         c.status, c.resolved_at, c.reopened_at,
         (SELECT min(j2.created_at) FROM public.jobs j2 WHERE j2.rework_of_job_id = c.job_id AND j2.user_id = c.user_id)
  FROM public.remote_resolution_cases c
  LEFT JOIN LATERAL (
    SELECT x.threshold_at_decision FROM public.rr_certify_decisions x
    WHERE x.case_id = c.id AND x.existing_action = 'troubleshoot' ORDER BY x.turn LIMIT 1
  ) d ON true
  WHERE c.user_id = p_user_id AND c.attempt_probability IS NOT NULL
  ORDER BY c.created_at DESC
  LIMIT 20000;
$$;

CREATE OR REPLACE FUNCTION public.rr_certify_log_decision(
  p_case_id uuid, p_turn smallint, p_score smallint, p_category text, p_existing text, p_would text, p_reason text,
  p_lambda smallint, p_segment_status text, p_snapshot_id uuid, p_threshold smallint, p_mode text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid;
BEGIN
  SELECT user_id INTO v_user FROM public.remote_resolution_cases WHERE id = p_case_id;
  IF v_user IS NULL THEN RETURN; END IF;
  INSERT INTO public.rr_certify_decisions (user_id, case_id, turn, score, category, existing_action, would_decide, gate_reason,
    lambda, segment_status, snapshot_id, threshold_at_decision, mode)
  VALUES (v_user, p_case_id, p_turn, p_score, left(p_category, 40), p_existing, p_would, left(p_reason, 40),
    p_lambda, p_segment_status, p_snapshot_id, p_threshold, p_mode)
  ON CONFLICT (case_id, turn) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.rr_certify_store_snapshot(p_user_id uuid, p_snapshot jsonb, p_fingerprint text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.rr_certify_snapshots (user_id, model_version, fingerprint, snapshot)
  VALUES (p_user_id, coalesce((p_snapshot->>'modelVersion')::smallint, 1), left(p_fingerprint, 80), p_snapshot)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Records drift. Moving INTO 'alarm' notifies the owner once; leaving 'alarm' needs rr_certify_ack_drift().
CREATE OR REPLACE FUNCTION public.rr_certify_set_drift(
  p_user_id uuid, p_status text, p_m integer, p_k integer, p_reference numeric, p_p_value numeric)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old text;
BEGIN
  IF p_status NOT IN ('ok', 'alarm', 'insufficient') THEN RAISE EXCEPTION 'RRC_INVALID: status' USING ERRCODE = 'P0001'; END IF;
  SELECT status INTO v_old FROM public.rr_certify_drift WHERE user_id = p_user_id FOR UPDATE;
  IF v_old = 'alarm' AND p_status <> 'alarm' THEN
    -- sticky: stay in alarm until the owner acknowledges
    UPDATE public.rr_certify_drift SET m = p_m, k = p_k, reference_rate = p_reference, p_value = p_p_value, updated_at = now() WHERE user_id = p_user_id;
    RETURN 'alarm';
  END IF;
  INSERT INTO public.rr_certify_drift (user_id, status, m, k, reference_rate, p_value, alarmed_at, updated_at)
  VALUES (p_user_id, p_status, p_m, p_k, p_reference, p_p_value, CASE WHEN p_status = 'alarm' THEN now() END, now())
  ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status, m = EXCLUDED.m, k = EXCLUDED.k, reference_rate = EXCLUDED.reference_rate,
    p_value = EXCLUDED.p_value, alarmed_at = CASE WHEN EXCLUDED.status = 'alarm' THEN now() ELSE public.rr_certify_drift.alarmed_at END,
    updated_at = now();
  IF p_status = 'alarm' AND v_old IS DISTINCT FROM 'alarm' THEN
    BEGIN
      INSERT INTO public.notifications (user_id, type, title, message, action_url)
      VALUES (p_user_id, 'job_update', 'Remote resolution safety check paused',
        'Failed remote fixes rose above the calibrated level, so every remote attempt now goes to a technician until you review it.', '/dashboard/remote-resolution');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN p_status;
END;
$$;

-- Owner acknowledges an alarm; the edge function re-evaluates on the next decision.
CREATE OR REPLACE FUNCTION public.rr_certify_ack_drift()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'RRC_FORBIDDEN: only the account owner can acknowledge' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.rr_certify_drift SET status = 'insufficient', acked_at = now(), updated_at = now() WHERE user_id = v_owner AND status = 'alarm';
END;
$$;

-- Privileges: service-role RPCs are not callable by clients.
REVOKE ALL ON FUNCTION public.rr_certify_case_outcomes(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rr_certify_log_decision(uuid, smallint, smallint, text, text, text, text, smallint, text, uuid, smallint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rr_certify_store_snapshot(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rr_certify_set_drift(uuid, text, integer, integer, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rr_certify_case_outcomes(uuid), public.rr_certify_store_snapshot(uuid, jsonb, text),
  public.rr_certify_set_drift(uuid, text, integer, integer, numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.rr_certify_log_decision(uuid, smallint, smallint, text, text, text, text, smallint, text, uuid, smallint, text) TO service_role;
REVOKE ALL ON FUNCTION public.rr_certify_get_settings() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rr_certify_save_settings(text, numeric, numeric, integer, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rr_certify_ack_drift() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rr_certify_get_settings(), public.rr_certify_ack_drift() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rr_certify_save_settings(text, numeric, numeric, integer, integer, integer) TO authenticated;

-- Flag row (master switch / kill switch). Off for everyone until staff turn it on.
INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct)
SELECT 'rre_certify', 'RRE risk control', 'Risk-control gate around remote resolution (shadow first). Master kill switch.', false, 0
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE key = 'rre_certify');
