/*
  # API usage plans (rate limits, monthly quotas, overage) for api-v1

  Builds on 20260915000000_api_keys.sql, 20270502000000_api_usage_monitoring.sql (request log, per-key usage RPCs,
  alerts) and 20290301000000_api_key_rate_limit.sql (staff-set per-key override). Nothing is dropped.

  ## Behaviour is UNCHANGED until the flag is switched on for an account
  Flag `api_usage_plans` (default: nobody; enable per tenant with a staff override ON, same mechanism as `public_api_v2`).
  Flag OFF for an account  => api-v1 behaves exactly as before (per-key override or the platform default 120/min, no quota,
                              no counting).
  Flag ON                  => the account's plan applies: per-minute limit, monthly quota, overage policy; live requests are counted.

  ## Rules
  - Effective per-minute limit = key override (staff-set) > plan limit > platform default.
  - Quota is per ACCOUNT (all live keys together), UTC calendar month. Test-mode keys are never counted.
  - overage_policy 'block' : requests beyond the quota get 429 quota_exceeded.
    overage_policy 'meter' : requests continue up to quota * (1 + max_overage_pct/100) and the excess is recorded;
                             beyond that hard cap they get 429 quota_exceeded.
  - Admission is NOT strictly atomic: under concurrency the quota can be exceeded by at most the number of in-flight requests.
  - Fail-open: if the admission RPC errors, api-v1 lets the request through (same stance as the old limiter).
  - Overage is METERED ONLY. Nothing here creates a Stripe invoice item. Invoicing needs a human decision (docs/platform/api-usage-plans.md).
  - Every number seeded below is a PROPOSED placeholder (is_proposed = true), not a commercial commitment.

  ## Rollback
    DROP FUNCTION IF EXISTS public.get_api_overage_report(text);
    DROP FUNCTION IF EXISTS public.assign_api_usage_plan(uuid, text, text);
    DROP FUNCTION IF EXISTS public.get_api_plan_usage(uuid, text);
    DROP FUNCTION IF EXISTS public.api_v1_admit(uuid, integer);
    DROP FUNCTION IF EXISTS public.api_plan_for_owner(uuid);
    DROP FUNCTION IF EXISTS public.api_usage_plans_enabled(uuid);
    DROP FUNCTION IF EXISTS public.api_overage_cost_cents(bigint, integer);
    DELETE FROM public.feature_flags WHERE key = 'api_usage_plans';
    -- and restore the old call in api-v1/index.ts (api_v1_rate_limit_ok is untouched and still exists).
    -- Tables (api_usage_counters, api_plan_assignments, api_usage_plan_defaults, api_usage_plans) can be dropped last.
*/

-- 1) Plan catalog ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.api_usage_plans (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9_]{1,31}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  rate_limit_per_minute integer NOT NULL CHECK (rate_limit_per_minute BETWEEN 10 AND 1200),
  monthly_quota bigint CHECK (monthly_quota IS NULL OR monthly_quota > 0),          -- NULL = unlimited
  overage_policy text NOT NULL DEFAULT 'block' CHECK (overage_policy IN ('block', 'meter')),
  overage_cents_per_1000 integer NOT NULL DEFAULT 0 CHECK (overage_cents_per_1000 BETWEEN 0 AND 100000),
  max_overage_pct integer NOT NULL DEFAULT 0 CHECK (max_overage_pct BETWEEN 0 AND 1000),
  is_proposed boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_usage_plans_meter_needs_quota CHECK (overage_policy <> 'meter' OR monthly_quota IS NOT NULL)
);
ALTER TABLE public.api_usage_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "aup_select_all" ON public.api_usage_plans;
CREATE POLICY "aup_select_all" ON public.api_usage_plans FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON public.api_usage_plans FROM anon, authenticated;

INSERT INTO public.api_usage_plans (slug, name, rate_limit_per_minute, monthly_quota, overage_policy, overage_cents_per_1000, max_overage_pct, is_proposed, sort_order) VALUES
  ('legacy',    'Current behaviour', 120,  NULL,     'block', 0,  0,   false, 5),
  ('developer', 'Developer',         60,   10000,    'block', 0,  0,   true,  10),
  ('growth',    'Growth',            300,  250000,   'meter', 30, 50,  true,  20),
  ('scale',     'Scale',             600,  2000000,  'meter', 20, 50,  true,  30),
  ('partner',   'Partner',           1200, 10000000, 'meter', 10, 100, true,  40)
ON CONFLICT (slug) DO NOTHING;

-- 2) Default plan per account plan (profiles.plan) ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.api_usage_plan_defaults (
  account_plan text PRIMARY KEY,
  plan_slug text NOT NULL REFERENCES public.api_usage_plans(slug)
);
ALTER TABLE public.api_usage_plan_defaults ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "aupd_select_all" ON public.api_usage_plan_defaults;
CREATE POLICY "aupd_select_all" ON public.api_usage_plan_defaults FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON public.api_usage_plan_defaults FROM anon, authenticated;

INSERT INTO public.api_usage_plan_defaults (account_plan, plan_slug) VALUES
  ('free', 'developer'), ('starter', 'developer'), ('professional', 'growth'), ('business', 'scale'), ('enterprise', 'partner')
ON CONFLICT (account_plan) DO NOTHING;

-- 3) Explicit per-account assignment (staff only) ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.api_plan_assignments (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  plan_slug text NOT NULL REFERENCES public.api_usage_plans(slug),
  note text CHECK (note IS NULL OR length(note) <= 500),
  assigned_by uuid,
  assigned_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.api_plan_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "apa_select_own_or_staff" ON public.api_plan_assignments;
CREATE POLICY "apa_select_own_or_staff" ON public.api_plan_assignments FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_vireek_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.api_plan_assignments FROM anon, authenticated;

-- 4) Feature flag (default OFF for everyone) --------------------------------------------------------------
INSERT INTO public.feature_flags (key, name, description, enabled, rollout_pct)
VALUES ('api_usage_plans', 'API usage plans (quotas, overage)',
        'Applies the account API plan (rate limit, monthly quota, overage policy) in api-v1. OFF = legacy behaviour, nothing counted.', true, 0)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.api_usage_plans_enabled(p_owner uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((
    SELECT public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, p_owner, f.key)
      FROM public.feature_flags f
      LEFT JOIN public.feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p_owner
     WHERE f.key = 'api_usage_plans'
  ), false);
$$;
REVOKE ALL ON FUNCTION public.api_usage_plans_enabled(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_usage_plans_enabled(uuid) TO service_role;

-- 5) Plan resolution ----------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_plan_for_owner(p_owner uuid)
RETURNS public.api_usage_plans
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.* FROM public.api_usage_plans p
   WHERE p.slug = COALESCE(
     (SELECT a.plan_slug FROM public.api_plan_assignments a WHERE a.user_id = p_owner),
     (SELECT d.plan_slug FROM public.api_usage_plan_defaults d JOIN public.profiles pr ON pr.plan = d.account_plan WHERE pr.id = p_owner),
     'developer');
$$;
REVOKE ALL ON FUNCTION public.api_plan_for_owner(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_plan_for_owner(uuid) TO service_role;

-- Pure cost helper: each started block of 1,000 requests is charged. Mirrored by overageCostCents() in src/lib/apiPlans.ts.
CREATE OR REPLACE FUNCTION public.api_overage_cost_cents(p_overage bigint, p_cents_per_1000 integer)
RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN COALESCE(p_overage, 0) <= 0 OR COALESCE(p_cents_per_1000, 0) <= 0 THEN 0::bigint
              ELSE ceil(p_overage / 1000.0)::bigint * p_cents_per_1000 END;
$$;

-- 6) Counters (written only by api_v1_admit) -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.api_usage_counters (
  api_key_id uuid NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  requests bigint NOT NULL DEFAULT 0 CHECK (requests >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, period)
);
CREATE INDEX IF NOT EXISTS idx_auc_user_period ON public.api_usage_counters (user_id, period);
ALTER TABLE public.api_usage_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auc_select_own" ON public.api_usage_counters;
CREATE POLICY "auc_select_own" ON public.api_usage_counters FOR SELECT TO authenticated USING (user_id = auth.uid());
REVOKE INSERT, UPDATE, DELETE ON public.api_usage_counters FROM anon, authenticated;

-- 7) Admission: per-minute limiter + quota, one round trip (service role, called by api-v1) ----------------------
CREATE OR REPLACE FUNCTION public.api_v1_admit(p_key_id uuid, p_default_limit integer DEFAULT 120)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  k record;
  v_on boolean;
  v_plan public.api_usage_plans;
  v_limit integer;
  v_recent bigint;
  v_period text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_used bigint := 0;
  v_hard bigint;
  v_retry integer;
  v_counted boolean := false;
BEGIN
  SELECT id, user_id, mode, rate_limit_per_minute INTO k FROM public.api_keys WHERE id = p_key_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed', false, 'reason', 'unknown_key'); END IF;

  v_on := public.api_usage_plans_enabled(k.user_id);
  IF v_on THEN v_plan := public.api_plan_for_owner(k.user_id); END IF;

  v_limit := GREATEST(1, COALESCE(k.rate_limit_per_minute, CASE WHEN v_on THEN v_plan.rate_limit_per_minute END, p_default_limit, 120));

  SELECT count(*) INTO v_recent FROM public.api_request_logs
   WHERE api_key_id = p_key_id AND created_at > now() - interval '60 seconds' AND status <> 429;
  IF v_recent >= v_limit THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'rate_limited', 'rate_limit', v_limit, 'retry_after', 60);
  END IF;

  IF v_on AND v_plan.slug IS NOT NULL AND k.mode = 'live' THEN
    IF v_plan.monthly_quota IS NOT NULL THEN
      SELECT COALESCE(sum(requests), 0) INTO v_used FROM public.api_usage_counters WHERE user_id = k.user_id AND period = v_period;
      v_hard := v_plan.monthly_quota + CASE WHEN v_plan.overage_policy = 'meter' THEN (v_plan.monthly_quota * v_plan.max_overage_pct) / 100 ELSE 0 END;
      IF v_used >= v_hard THEN
        v_retry := LEAST(2678400, GREATEST(1, ceil(extract(epoch FROM
                     (((date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC') - now())))::integer));
        RETURN jsonb_build_object('allowed', false, 'reason', 'quota_exceeded', 'plan', v_plan.slug, 'quota', v_plan.monthly_quota,
                                  'used', v_used, 'retry_after', v_retry, 'rate_limit', v_limit);
      END IF;
    END IF;
    INSERT INTO public.api_usage_counters (api_key_id, period, user_id, requests)
    VALUES (p_key_id, v_period, k.user_id, 1)
    ON CONFLICT (api_key_id, period) DO UPDATE SET requests = public.api_usage_counters.requests + 1, updated_at = now();
    v_used := v_used + 1;
    v_counted := true;
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'rate_limit', v_limit,
    'plan', CASE WHEN v_on THEN v_plan.slug END,
    'quota', CASE WHEN v_counted THEN v_plan.monthly_quota END,
    'used', CASE WHEN v_counted AND v_plan.monthly_quota IS NOT NULL THEN v_used END,
    'remaining', CASE WHEN v_counted AND v_plan.monthly_quota IS NOT NULL THEN GREATEST(v_plan.monthly_quota - v_used, 0) END
  );
END;
$$;
REVOKE ALL ON FUNCTION public.api_v1_admit(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_v1_admit(uuid, integer) TO service_role;

-- 8) Owner dashboard read (explicit owner check: this function is SECURITY DEFINER) ------------------------------
CREATE OR REPLACE FUNCTION public.get_api_plan_usage(p_owner uuid, p_period text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE AS $$
DECLARE
  v_period text := COALESCE(p_period, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'));
  v_plan public.api_usage_plans;
  v_keys jsonb;
  v_total bigint;
  v_over bigint := 0;
  v_start date;
BEGIN
  IF p_owner IS NULL OR NOT (p_owner = auth.uid() OR coalesce(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'API_USAGE_FORBIDDEN';
  END IF;
  IF v_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'Invalid period.'; END IF;
  v_start := to_date(v_period || '-01', 'YYYY-MM-DD');
  v_plan := public.api_plan_for_owner(p_owner);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('key_id', c.api_key_id, 'requests', c.requests) ORDER BY c.requests DESC), '[]'::jsonb),
         COALESCE(sum(c.requests), 0)
    INTO v_keys, v_total
  FROM public.api_usage_counters c WHERE c.user_id = p_owner AND c.period = v_period;

  IF v_plan.monthly_quota IS NOT NULL THEN v_over := GREATEST(v_total - v_plan.monthly_quota, 0); END IF;

  RETURN jsonb_build_object(
    'enabled', public.api_usage_plans_enabled(p_owner),
    'assigned', EXISTS (SELECT 1 FROM public.api_plan_assignments a WHERE a.user_id = p_owner),
    'plan', CASE WHEN v_plan.slug IS NULL THEN NULL ELSE jsonb_build_object(
       'slug', v_plan.slug, 'name', v_plan.name, 'rate_limit_per_minute', v_plan.rate_limit_per_minute,
       'monthly_quota', v_plan.monthly_quota, 'overage_policy', v_plan.overage_policy,
       'overage_cents_per_1000', v_plan.overage_cents_per_1000, 'max_overage_pct', v_plan.max_overage_pct,
       'is_proposed', v_plan.is_proposed) END,
    'period', v_period,
    'period_start', v_start,
    'period_end', (v_start + interval '1 month')::date,
    'total_requests', v_total,
    'keys', v_keys,
    'overage_requests', v_over,
    'estimated_overage_cents', CASE WHEN v_plan.overage_policy = 'meter' THEN public.api_overage_cost_cents(v_over, v_plan.overage_cents_per_1000) ELSE 0 END
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_api_plan_usage(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_api_plan_usage(uuid, text) TO authenticated, service_role;

-- 9) Staff: assign / clear a plan, and the overage report -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_api_usage_plan(p_owner uuid, p_plan_slug text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_owner) THEN RAISE EXCEPTION 'Account not found.'; END IF;
  IF p_plan_slug IS NULL THEN
    DELETE FROM public.api_plan_assignments WHERE user_id = p_owner;   -- back to the default mapping
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.api_usage_plans WHERE slug = p_plan_slug) THEN RAISE EXCEPTION 'Unknown plan.'; END IF;
  INSERT INTO public.api_plan_assignments (user_id, plan_slug, note, assigned_by)
  VALUES (p_owner, p_plan_slug, NULLIF(btrim(COALESCE(p_note, '')), ''), auth.uid())
  ON CONFLICT (user_id) DO UPDATE SET plan_slug = EXCLUDED.plan_slug, note = EXCLUDED.note, assigned_by = EXCLUDED.assigned_by, assigned_at = now();
END;
$$;
REVOKE ALL ON FUNCTION public.assign_api_usage_plan(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_api_usage_plan(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_api_overage_report(p_period text)
RETURNS TABLE (user_id uuid, plan_slug text, requests bigint, quota bigint, overage_requests bigint, estimated_cents bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN RAISE EXCEPTION 'Staff only.'; END IF;
  IF p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'Invalid period.'; END IF;
  RETURN QUERY
  SELECT c.uid, p.slug, c.r, p.monthly_quota, c.r - p.monthly_quota,
         CASE WHEN p.overage_policy = 'meter' THEN public.api_overage_cost_cents(c.r - p.monthly_quota, p.overage_cents_per_1000) ELSE 0::bigint END
  FROM (SELECT cc.user_id AS uid, sum(cc.requests)::bigint AS r FROM public.api_usage_counters cc WHERE cc.period = p_period GROUP BY cc.user_id) c
  CROSS JOIN LATERAL public.api_plan_for_owner(c.uid) p
  WHERE p.monthly_quota IS NOT NULL AND c.r > p.monthly_quota
  ORDER BY (c.r - p.monthly_quota) DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.get_api_overage_report(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_api_overage_report(text) TO authenticated;
