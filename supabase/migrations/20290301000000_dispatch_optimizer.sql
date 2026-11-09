/*
  # Smart Dispatch Optimizer (suggestions only, default OFF)

  ## Gating (BOTH must be true — otherwise zero behaviour change)
  1. Global/tenant feature flag `dispatch_optimizer` (feature_flags; created here, disabled, 0 %).
  2. Per-account entitlement `dispatch_optimizer_settings.entitled` (staff-only write).

  ## Objects
  - dispatch_optimizer_settings : one row per ACCOUNT OWNER (weights, overtime cap, seed, policies).
  - dispatch_optimizer_audit    : append-only log (UPDATE/DELETE blocked by trigger). Stores counts and
                                  ids only — no customer names, addresses or coordinates (minimal PII).
  - dispatch_optimizer_access() : caller-context RPC the edge function uses (owner id is derived from
                                  the JWT via get_account_owner_id(); the client never supplies it).
  - save_dispatch_optimizer_settings() : owner/manager writes weights etc. — can NOT touch `entitled`.
  - staff_set_dispatch_optimizer_entitlement() : Vireek staff only.

  Applying a suggestion needs NO new write path: it uses the existing move_job RPC + conflict check + Undo.

  ## Rollback (safe: nothing else depends on these objects)
    DROP FUNCTION IF EXISTS public.staff_set_dispatch_optimizer_entitlement(uuid, boolean);
    DROP FUNCTION IF EXISTS public.save_dispatch_optimizer_settings(jsonb);
    DROP FUNCTION IF EXISTS public.dispatch_optimizer_access();
    DROP TABLE IF EXISTS public.dispatch_optimizer_audit;
    DROP TABLE IF EXISTS public.dispatch_optimizer_settings;
    DELETE FROM public.feature_flags WHERE key = 'dispatch_optimizer';
  Runs on a fresh DB and on the current schema; every statement is idempotent.
*/

-- 1. settings -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dispatch_optimizer_settings (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,   -- ACCOUNT OWNER id
  entitled boolean NOT NULL DEFAULT false,
  weight_revenue numeric NOT NULL DEFAULT 1 CHECK (weight_revenue BETWEEN 0 AND 10),
  weight_travel numeric NOT NULL DEFAULT 1 CHECK (weight_travel BETWEEN 0 AND 10),
  weight_sla_risk numeric NOT NULL DEFAULT 1 CHECK (weight_sla_risk BETWEEN 0 AND 10),
  weight_overtime_fairness numeric NOT NULL DEFAULT 1 CHECK (weight_overtime_fairness BETWEEN 0 AND 10),
  max_overtime_min integer NOT NULL DEFAULT 0 CHECK (max_overtime_min BETWEEN 0 AND 240),
  parts_policy text NOT NULL DEFAULT 'soft' CHECK (parts_policy IN ('soft', 'hard')),
  sla_hard boolean NOT NULL DEFAULT false,
  seed integer NOT NULL DEFAULT 1 CHECK (seed BETWEEN 1 AND 2147483647),
  workday_start_hour smallint NOT NULL DEFAULT 8 CHECK (workday_start_hour BETWEEN 0 AND 23),
  workday_end_hour smallint NOT NULL DEFAULT 17 CHECK (workday_end_hour BETWEEN 1 AND 24),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (workday_end_hour > workday_start_hour)
);

ALTER TABLE public.dispatch_optimizer_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dispatch_optimizer_settings FROM anon, authenticated;
GRANT SELECT ON public.dispatch_optimizer_settings TO authenticated;

DROP POLICY IF EXISTS "dispatch_optimizer_settings_select" ON public.dispatch_optimizer_settings;
CREATE POLICY "dispatch_optimizer_settings_select" ON public.dispatch_optimizer_settings
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- No INSERT/UPDATE/DELETE policies: writes only through the SECURITY DEFINER RPCs below.

-- 2. append-only audit ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dispatch_optimizer_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,       -- ACCOUNT OWNER id
  actor_id uuid,
  action text NOT NULL CHECK (action IN ('optimize', 'what_if', 'emergency', 'settings_changed', 'entitlement_changed', 'suggestion_applied')),
  engine_version text,
  seed integer,
  job_count integer,
  tech_count integer,
  suggestion_count integer,
  duration_ms integer,
  truncated boolean,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,   -- ids and numbers only; never names/addresses
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dispatch_optimizer_audit_user ON public.dispatch_optimizer_audit (user_id, created_at DESC);

ALTER TABLE public.dispatch_optimizer_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dispatch_optimizer_audit FROM anon, authenticated;
GRANT SELECT ON public.dispatch_optimizer_audit TO authenticated;
DROP POLICY IF EXISTS "dispatch_optimizer_audit_select" ON public.dispatch_optimizer_audit;
CREATE POLICY "dispatch_optimizer_audit_select" ON public.dispatch_optimizer_audit
  FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public.dispatch_optimizer_audit_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dispatch_optimizer_audit is append-only';
END;
$$;
DROP TRIGGER IF EXISTS trg_dispatch_optimizer_audit_immutable ON public.dispatch_optimizer_audit;
CREATE TRIGGER trg_dispatch_optimizer_audit_immutable
  BEFORE UPDATE OR DELETE ON public.dispatch_optimizer_audit
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_optimizer_audit_immutable();

-- 3. feature flag (disabled, 0 %) --------------------------------------------------------
INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct)
VALUES ('dispatch_optimizer', 'Smart dispatch optimizer',
        'Suggestion-only schedule optimizer on the Dispatch Board. Needs the per-account entitlement too. Owner: dispatch. Remove flag after GA.',
        false, 0)
ON CONFLICT (key) DO NOTHING;

-- 4. caller-context access check ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_optimizer_access()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_flag boolean := false;
  v_s public.dispatch_optimizer_settings%ROWTYPE;
  v_manage boolean := false;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'not_authenticated');
  END IF;

  SELECT public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, v_owner, f.key)
    INTO v_flag
    FROM public.feature_flags f
    LEFT JOIN public.feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = v_owner
   WHERE f.key = 'dispatch_optimizer';

  SELECT * INTO v_s FROM public.dispatch_optimizer_settings WHERE user_id = v_owner;
  v_manage := (auth.uid() = v_owner) OR COALESCE(public.has_account_permission('can_view_all_jobs'), false);

  RETURN jsonb_build_object(
    'allowed', COALESCE(v_flag, false) AND COALESCE(v_s.entitled, false) AND v_manage,
    'flag_on', COALESCE(v_flag, false),
    'entitled', COALESCE(v_s.entitled, false),
    'can_manage', v_manage,
    'owner_id', v_owner,
    'is_owner', auth.uid() = v_owner,
    'settings', jsonb_build_object(
      'weights', jsonb_build_object(
        'revenue', COALESCE(v_s.weight_revenue, 1), 'travel', COALESCE(v_s.weight_travel, 1),
        'slaRisk', COALESCE(v_s.weight_sla_risk, 1), 'overtimeFairness', COALESCE(v_s.weight_overtime_fairness, 1)),
      'maxOvertimeMin', COALESCE(v_s.max_overtime_min, 0),
      'partsPolicy', COALESCE(v_s.parts_policy, 'soft'),
      'slaHard', COALESCE(v_s.sla_hard, false),
      'seed', COALESCE(v_s.seed, 1),
      'workdayStartHour', COALESCE(v_s.workday_start_hour, 8),
      'workdayEndHour', COALESCE(v_s.workday_end_hour, 17))
  );
END;
$$;
REVOKE ALL ON FUNCTION public.dispatch_optimizer_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_optimizer_access() TO authenticated;

-- 5. owner saves settings (cannot touch `entitled`) ----------------------------------------------
CREATE OR REPLACE FUNCTION public.save_dispatch_optimizer_settings(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_row public.dispatch_optimizer_settings%ROWTYPE;
  w jsonb := COALESCE(p->'weights', '{}'::jsonb);
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Only the account owner can change optimizer settings' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.dispatch_optimizer_settings WHERE user_id = v_owner;
  IF NOT FOUND OR NOT v_row.entitled THEN
    RAISE EXCEPTION 'Smart dispatch is not enabled for this account' USING ERRCODE = '42501';
  END IF;

  UPDATE public.dispatch_optimizer_settings SET
    weight_revenue = COALESCE((w->>'revenue')::numeric, weight_revenue),
    weight_travel = COALESCE((w->>'travel')::numeric, weight_travel),
    weight_sla_risk = COALESCE((w->>'slaRisk')::numeric, weight_sla_risk),
    weight_overtime_fairness = COALESCE((w->>'overtimeFairness')::numeric, weight_overtime_fairness),
    max_overtime_min = COALESCE((p->>'maxOvertimeMin')::integer, max_overtime_min),
    parts_policy = COALESCE(p->>'partsPolicy', parts_policy),
    sla_hard = COALESCE((p->>'slaHard')::boolean, sla_hard),
    seed = COALESCE((p->>'seed')::integer, seed),
    workday_start_hour = COALESCE((p->>'workdayStartHour')::smallint, workday_start_hour),
    workday_end_hour = COALESCE((p->>'workdayEndHour')::smallint, workday_end_hour),
    updated_at = now()
  WHERE user_id = v_owner;     -- CHECK constraints reject out-of-range values

  INSERT INTO public.dispatch_optimizer_audit (user_id, actor_id, action, detail)
  VALUES (v_owner, auth.uid(), 'settings_changed', jsonb_build_object('keys', (SELECT jsonb_agg(k) FROM jsonb_object_keys(p) k)));
  RETURN public.dispatch_optimizer_access();
END;
$$;
REVOKE ALL ON FUNCTION public.save_dispatch_optimizer_settings(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_dispatch_optimizer_settings(jsonb) TO authenticated;

-- 6. staff grants the entitlement ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_set_dispatch_optimizer_entitlement(p_tenant uuid, p_entitled boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_vireek_staff() THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.dispatch_optimizer_settings (user_id, entitled) VALUES (p_tenant, p_entitled)
  ON CONFLICT (user_id) DO UPDATE SET entitled = EXCLUDED.entitled, updated_at = now();
  INSERT INTO public.dispatch_optimizer_audit (user_id, actor_id, action, detail)
  VALUES (p_tenant, auth.uid(), 'entitlement_changed', jsonb_build_object('entitled', p_entitled));
END;
$$;
REVOKE ALL ON FUNCTION public.staff_set_dispatch_optimizer_entitlement(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_set_dispatch_optimizer_entitlement(uuid, boolean) TO authenticated;

-- 7. client-side audit of an applied suggestion (the move itself is audited by move_job) -------------------
CREATE OR REPLACE FUNCTION public.log_dispatch_optimizer_applied(p_job_id uuid, p_tech_id uuid, p_kind text, p_gain numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_access jsonb := public.dispatch_optimizer_access();
BEGIN
  IF COALESCE((v_access->>'allowed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Smart dispatch is not enabled' USING ERRCODE = '42501';
  END IF;
  -- the job must belong to the caller's account
  IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id AND user_id = (v_access->>'owner_id')::uuid) THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.dispatch_optimizer_audit (user_id, actor_id, action, detail)
  VALUES ((v_access->>'owner_id')::uuid, auth.uid(), 'suggestion_applied',
          jsonb_build_object('job_id', p_job_id, 'technician_id', p_tech_id, 'kind', left(p_kind, 20), 'gain', p_gain));
END;
$$;
REVOKE ALL ON FUNCTION public.log_dispatch_optimizer_applied(uuid, uuid, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_dispatch_optimizer_applied(uuid, uuid, text, numeric) TO authenticated;
