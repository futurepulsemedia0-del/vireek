/*
  # Plan entitlements: server-enforced seat / location / number limits + feature flags

  Source of truth: supabase/functions/_shared/billing/entitlements.ts. The JSON in plan_limit_table() below is
  compared to that file by entitlements.test.ts (CI fails on drift).

  ## What this adds
  - profiles: extra_users / extra_locations / extra_numbers / extra_concurrent (>= 0), custom_limits (enterprise
    contract overrides), plan_tier_override (pin a tier for offline-billed accounts).
  - SECURITY: profiles has an unrestricted "update_own_profile" policy, so a tenant could set plan = 'enterprise'
    or grant themselves extras from the browser. trg_protect_profile_entitlements blocks client changes to
    plan, stripe_subscription_id and every column above (service role / SQL editor keep working, same pattern as
    protect_profile_staff_flag()).
  - Triggers on team_members (seats), business_locations (locations) and phone_numbers (numbers) refuse NEW
    additions beyond the effective limit with  RAISE 'PLAN_LIMIT'  (DETAIL = JSON {code,key,limit,current,upgradeTo}).
    Advisory lock per (account, key) serialises concurrent additions.
  - GRANDFATHERING: nothing is ever removed or disabled. An account already over a limit keeps everything and is
    only refused further additions. plan_scan_grandfathered() records a 'grandfathered_over_limit' notice
    (plan_limit_events); it runs once at the end of this migration and can be re-run.
  - Feature flags: plan_feature_allowed(owner, feature). plan_enforcement_config.features_mode defaults to
    'shadow' (allow + log 'feature_shadow_denied') so existing customers keep working; switch with
      update plan_enforcement_config set features_mode = 'enforce' where id;
    after reviewing plan_limit_events. Count limits are always enforced.
  - Trial detection: profiles.plan defaults to 'starter' and the paid Starter plan also writes 'starter', so a
    'starter' account WITHOUT stripe_subscription_id is treated as 'free'. Pin offline-billed accounts with
      update profiles set plan_tier_override = 'starter' where id = '<owner>';

  ## Order / rollback
  Apply once, after 20290302000000. Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS).
  Rollback (data-safe): drop the five trg_plan_* / trg_protect_profile_entitlements triggers; the columns and
  event table can stay. Never run against production from a workstation; use the normal migration pipeline.
*/

-- ---------------------------------------------------------------- columns
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS extra_users integer NOT NULL DEFAULT 0 CHECK (extra_users >= 0),
  ADD COLUMN IF NOT EXISTS extra_locations integer NOT NULL DEFAULT 0 CHECK (extra_locations >= 0),
  ADD COLUMN IF NOT EXISTS extra_numbers integer NOT NULL DEFAULT 0 CHECK (extra_numbers >= 0),
  ADD COLUMN IF NOT EXISTS extra_concurrent integer NOT NULL DEFAULT 0 CHECK (extra_concurrent >= 0),
  ADD COLUMN IF NOT EXISTS custom_limits jsonb CHECK (custom_limits IS NULL OR jsonb_typeof(custom_limits) = 'object'),
  ADD COLUMN IF NOT EXISTS plan_tier_override text
    CHECK (plan_tier_override IS NULL OR plan_tier_override IN ('free', 'starter', 'professional', 'business', 'enterprise'));

-- ---------------------------------------------------------------- tables
CREATE TABLE IF NOT EXISTS public.plan_enforcement_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  features_mode text NOT NULL DEFAULT 'shadow' CHECK (features_mode IN ('shadow', 'enforce')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.plan_enforcement_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.plan_enforcement_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plan_enforcement_config FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.plan_enforcement_config TO service_role;

CREATE TABLE IF NOT EXISTS public.plan_limit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('grandfathered_over_limit', 'feature_shadow_denied')),
  key text NOT NULL,
  current_value integer,
  limit_value integer,
  day date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS plan_limit_events_dedupe ON public.plan_limit_events (owner_id, kind, key, day);
ALTER TABLE public.plan_limit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plan_limit_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.plan_limit_events TO service_role;

-- ---------------------------------------------------------------- client cannot forge entitlements
CREATE OR REPLACE FUNCTION public.protect_profile_entitlements()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      NEW.plan := 'starter';
      NEW.stripe_subscription_id := NULL;
      NEW.extra_users := 0; NEW.extra_locations := 0; NEW.extra_numbers := 0; NEW.extra_concurrent := 0;
      NEW.custom_limits := NULL; NEW.plan_tier_override := NULL;
    ELSIF NEW.plan IS DISTINCT FROM OLD.plan
       OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
       OR NEW.extra_users IS DISTINCT FROM OLD.extra_users
       OR NEW.extra_locations IS DISTINCT FROM OLD.extra_locations
       OR NEW.extra_numbers IS DISTINCT FROM OLD.extra_numbers
       OR NEW.extra_concurrent IS DISTINCT FROM OLD.extra_concurrent
       OR NEW.custom_limits IS DISTINCT FROM OLD.custom_limits
       OR NEW.plan_tier_override IS DISTINCT FROM OLD.plan_tier_override THEN
      RAISE EXCEPTION 'plan and entitlement fields cannot be changed from the client' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_entitlements ON public.profiles;
CREATE TRIGGER trg_protect_profile_entitlements
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_entitlements();

-- ---------------------------------------------------------------- the limit table (mirror of entitlements.ts)
CREATE OR REPLACE FUNCTION public.plan_limit_table()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT '{"limits":{"free":{"seats":1,"locations":1,"phoneNumbers":1,"concurrentCalls":1,"smsPerMonth":20,"transcriptRetentionDays":7,"recordingsEnabled":false},"starter":{"seats":2,"locations":1,"phoneNumbers":1,"concurrentCalls":2,"smsPerMonth":300,"transcriptRetentionDays":30,"recordingsEnabled":false},"professional":{"seats":5,"locations":1,"phoneNumbers":2,"concurrentCalls":5,"smsPerMonth":900,"transcriptRetentionDays":365,"recordingsEnabled":true},"business":{"seats":15,"locations":3,"phoneNumbers":3,"concurrentCalls":10,"smsPerMonth":2500,"transcriptRetentionDays":730,"recordingsEnabled":true},"enterprise":{"seats":null,"locations":null,"phoneNumbers":null,"concurrentCalls":null,"smsPerMonth":8000,"transcriptRetentionDays":null,"recordingsEnabled":true}},"features":{"emergencyDetectionSms":"free","warmTransfer":"professional","emergencyLiveDispatch":"professional","afterHoursRouting":"professional","outboundCalling":"professional","dispatchBoard":"professional","priceBook":"professional","agreements":"professional","reviewRequests":"professional","multiLocation":"business","advancedAnalytics":"business","roleBasedAccess":"business","inventory":"business","accountingSync":"business","payrollConnectors":"business","whiteLabel":"business","biExport":"business","basicWebhooks":"business","franchise":"enterprise","fullApi":"enterprise","sso":"enterprise","auditLogs":"enterprise","customVoice":"enterprise"},"fraudMaxNumbers":{"free":1,"starter":3,"professional":10,"business":50,"enterprise":200}}'::jsonb $$;

CREATE OR REPLACE FUNCTION public.plan_effective_tier(p_owner uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan text; v_sub text; v_override text;
BEGIN
  SELECT plan, stripe_subscription_id, plan_tier_override INTO v_plan, v_sub, v_override FROM profiles WHERE id = p_owner;
  IF NOT FOUND THEN RETURN 'free'; END IF;
  IF v_override IS NOT NULL THEN RETURN v_override; END IF;
  IF v_plan IS NULL OR v_plan NOT IN ('free', 'starter', 'professional', 'business', 'enterprise') THEN RETURN 'free'; END IF;
  IF v_plan = 'starter' AND btrim(coalesce(v_sub, '')) = '' THEN RETURN 'free'; END IF;
  RETURN v_plan;
END;
$$;

-- NULL result = no fixed limit. Unknown owner = 0 (fail closed).
CREATE OR REPLACE FUNCTION public.plan_effective_limit(p_owner uuid, p_key text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v profiles%ROWTYPE;
  v_tier text;
  v_base jsonb;
  v_cust jsonb;
  v_lim integer;
  v_fraud integer;
BEGIN
  SELECT * INTO v FROM profiles WHERE id = p_owner;
  IF NOT FOUND THEN RETURN 0; END IF;
  v_tier := plan_effective_tier(p_owner);
  v_base := plan_limit_table() -> 'limits' -> v_tier -> p_key;
  IF v_base IS NULL OR jsonb_typeof(v_base) = 'boolean' THEN
    RAISE EXCEPTION 'unknown plan limit key: %', p_key USING ERRCODE = '22023';
  END IF;

  IF v_tier = 'enterprise' AND v.custom_limits IS NOT NULL AND jsonb_exists(v.custom_limits, p_key)
     AND (jsonb_typeof(v.custom_limits -> p_key) = 'null'
          OR (jsonb_typeof(v.custom_limits -> p_key) = 'number' AND (v.custom_limits ->> p_key)::numeric >= 0)) THEN
    v_cust := v.custom_limits -> p_key;
    IF jsonb_typeof(v_cust) = 'null' THEN v_lim := NULL;
    ELSE v_lim := LEAST(floor((v.custom_limits ->> p_key)::numeric), 2147483647)::integer;
    END IF;
  ELSIF jsonb_typeof(v_base) = 'null' THEN
    v_lim := NULL;
  ELSE
    v_lim := (v_base #>> '{}')::integer + CASE p_key
      WHEN 'seats' THEN v.extra_users
      WHEN 'locations' THEN v.extra_locations
      WHEN 'phoneNumbers' THEN v.extra_numbers
      WHEN 'concurrentCalls' THEN v.extra_concurrent
      ELSE 0 END;
  END IF;

  IF p_key = 'phoneNumbers' THEN  -- the abuse-prevention cap (fraud/planLimits.ts maxNumbers) also applies
    v_fraud := (plan_limit_table() -> 'fraudMaxNumbers' ->> v_tier)::integer;
    v_lim := LEAST(coalesce(v_lim, v_fraud), v_fraud);
  END IF;
  RETURN v_lim;
END;
$$;

CREATE OR REPLACE FUNCTION public.plan_usage(p_owner uuid, p_key text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n integer;
BEGIN
  IF p_key = 'seats' THEN  -- the owner + every pending / active member
    SELECT 1 + count(*) INTO n FROM team_members WHERE account_owner_id = p_owner AND invite_status IN ('pending', 'active', 'accepted');
  ELSIF p_key = 'locations' THEN
    SELECT count(*) INTO n FROM business_locations WHERE user_id = p_owner AND status <> 'archived';
  ELSIF p_key = 'phoneNumbers' THEN
    SELECT count(*) INTO n FROM phone_numbers WHERE account_id = p_owner AND status <> 'released';
  ELSE
    RAISE EXCEPTION 'no usage counter for key: %', p_key USING ERRCODE = '22023';
  END IF;
  RETURN n;
END;
$$;

-- Cheapest tier above the current one whose BASE limit admits p_needed (mirror of upgradeTarget()).
CREATE OR REPLACE FUNCTION public.plan_upgrade_target(p_key text, p_needed integer, p_from text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  tiers text[] := ARRAY['free', 'starter', 'professional', 'business', 'enterprise'];
  t text; base jsonb;
BEGIN
  FOREACH t IN ARRAY tiers LOOP
    CONTINUE WHEN array_position(tiers, t) <= array_position(tiers, p_from);
    base := plan_limit_table() -> 'limits' -> t -> p_key;
    IF jsonb_typeof(base) = 'null' OR (base #>> '{}')::integer >= p_needed THEN RETURN t; END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- SQL editor / migrations / seeds (session user postgres, no end-user JWT) are never limited.
CREATE OR REPLACE FUNCTION public.plan_limits_bypass()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$ SELECT auth.uid() IS NULL AND session_user IN ('postgres', 'supabase_admin') $$;

CREATE OR REPLACE FUNCTION public.plan_enforce_limit(p_owner uuid, p_key text, p_adding integer DEFAULT 1)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer; v_current integer; v_tier text; v_to text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('plan_limit:' || p_owner::text || ':' || p_key, 0));
  v_limit := plan_effective_limit(p_owner, p_key);
  IF v_limit IS NULL THEN RETURN; END IF;
  v_current := plan_usage(p_owner, p_key);
  IF v_current + p_adding <= v_limit THEN RETURN; END IF;
  v_tier := plan_effective_tier(p_owner);
  v_to := plan_upgrade_target(p_key, v_current + p_adding, v_tier);
  RAISE EXCEPTION 'PLAN_LIMIT' USING ERRCODE = 'P0001',
    DETAIL = jsonb_build_object('code', 'PLAN_LIMIT', 'key', p_key, 'limit', v_limit, 'current', v_current, 'upgradeTo', v_to)::text,
    HINT = coalesce(v_to, 'contact_sales');
END;
$$;

-- ---------------------------------------------------------------- enforcement triggers
CREATE OR REPLACE FUNCTION public.trg_plan_limit_team_members()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF plan_limits_bypass() THEN RETURN NEW; END IF;
  IF NEW.invite_status NOT IN ('pending', 'active', 'accepted') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.invite_status IN ('pending', 'active', 'accepted') THEN RETURN NEW; END IF;  -- seat already counted
  END IF;
  PERFORM plan_enforce_limit(NEW.account_owner_id, 'seats', 1);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_plan_limit_team_members ON public.team_members;
CREATE TRIGGER trg_plan_limit_team_members
  BEFORE INSERT OR UPDATE OF invite_status ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.trg_plan_limit_team_members();

CREATE OR REPLACE FUNCTION public.trg_plan_limit_business_locations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF plan_limits_bypass() THEN RETURN NEW; END IF;
  IF NEW.status = 'archived' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'archived' THEN RETURN NEW; END IF;  -- restoring from archive counts as an addition
  END IF;
  PERFORM plan_enforce_limit(NEW.user_id, 'locations', 1);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_plan_limit_business_locations ON public.business_locations;
CREATE TRIGGER trg_plan_limit_business_locations
  BEFORE INSERT OR UPDATE OF status ON public.business_locations
  FOR EACH ROW EXECUTE FUNCTION public.trg_plan_limit_business_locations();

CREATE OR REPLACE FUNCTION public.trg_plan_limit_phone_numbers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF plan_limits_bypass() THEN RETURN NEW; END IF;
  IF NEW.status = 'released' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'released' THEN RETURN NEW; END IF;
  END IF;
  PERFORM plan_enforce_limit(NEW.account_id, 'phoneNumbers', 1);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_plan_limit_phone_numbers ON public.phone_numbers;
CREATE TRIGGER trg_plan_limit_phone_numbers
  BEFORE INSERT OR UPDATE OF status ON public.phone_numbers
  FOR EACH ROW EXECUTE FUNCTION public.trg_plan_limit_phone_numbers();

-- ---------------------------------------------------------------- feature flags
-- Edge functions call this with the SERVICE ROLE and a VERIFIED owner id (never from the request body).
-- Unknown feature => false (fail closed). In 'shadow' mode a denial is logged and the call is allowed.
CREATE OR REPLACE FUNCTION public.plan_feature_allowed(p_owner uuid, p_feature text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tiers text[] := ARRAY['free', 'starter', 'professional', 'business', 'enterprise'];
  v_min text; v_tier text; v_mode text;
BEGIN
  v_min := plan_limit_table() -> 'features' ->> p_feature;
  IF v_min IS NULL THEN RETURN false; END IF;
  v_tier := plan_effective_tier(p_owner);
  IF array_position(tiers, v_tier) >= array_position(tiers, v_min) THEN RETURN true; END IF;
  SELECT features_mode INTO v_mode FROM plan_enforcement_config WHERE id;
  IF coalesce(v_mode, 'enforce') = 'enforce' THEN RETURN false; END IF;
  INSERT INTO plan_limit_events (owner_id, kind, key) VALUES (p_owner, 'feature_shadow_denied', p_feature) ON CONFLICT DO NOTHING;
  RETURN true;
END;
$$;

-- Read-only snapshot for the dashboard (owner or team member of the account).
CREATE OR REPLACE FUNCTION public.get_plan_entitlements()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tier text; v_mode text; v_limits jsonb := '{}'::jsonb; k text; v_lim integer; v_use integer; v_over text[] := '{}';
  tiers text[] := ARRAY['free', 'starter', 'professional', 'business', 'enterprise'];
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RETURN NULL; END IF;
  v_tier := plan_effective_tier(v_owner);
  SELECT features_mode INTO v_mode FROM plan_enforcement_config WHERE id;
  FOREACH k IN ARRAY ARRAY['seats', 'locations', 'phoneNumbers'] LOOP
    v_lim := plan_effective_limit(v_owner, k);
    v_use := plan_usage(v_owner, k);
    v_limits := v_limits || jsonb_build_object(k, jsonb_build_object('limit', v_lim, 'used', v_use));
    IF v_lim IS NOT NULL AND v_use > v_lim THEN v_over := v_over || k; END IF;
  END LOOP;
  v_limits := v_limits || jsonb_build_object('concurrentCalls', jsonb_build_object('limit', plan_effective_limit(v_owner, 'concurrentCalls'), 'used', NULL))
                       || jsonb_build_object('smsPerMonth', jsonb_build_object('limit', plan_effective_limit(v_owner, 'smsPerMonth'), 'used', NULL))
                       || jsonb_build_object('transcriptRetentionDays', jsonb_build_object('limit', plan_effective_limit(v_owner, 'transcriptRetentionDays'), 'used', NULL));
  RETURN jsonb_build_object(
    'tier', v_tier,
    'featuresMode', coalesce(v_mode, 'enforce'),
    'recordingsEnabled', (plan_limit_table() -> 'limits' -> v_tier ->> 'recordingsEnabled')::boolean,
    'limits', v_limits,
    'overLimit', to_jsonb(v_over),
    'features', (SELECT jsonb_object_agg(f.key, array_position(tiers, v_tier) >= array_position(tiers, f.value))
                 FROM jsonb_each_text(plan_limit_table() -> 'features') AS f)
  );
END;
$$;

-- ---------------------------------------------------------------- grandfather notices
CREATE OR REPLACE FUNCTION public.plan_scan_grandfathered()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record; k text; v_lim integer; v_use integer; n integer := 0; ins integer;
BEGIN
  FOR r IN SELECT id FROM profiles WHERE role = 'owner' LOOP
    FOREACH k IN ARRAY ARRAY['seats', 'locations', 'phoneNumbers'] LOOP
      v_lim := plan_effective_limit(r.id, k);
      CONTINUE WHEN v_lim IS NULL;
      v_use := plan_usage(r.id, k);
      IF v_use > v_lim THEN
        INSERT INTO plan_limit_events (owner_id, kind, key, current_value, limit_value)
        VALUES (r.id, 'grandfathered_over_limit', k, v_use, v_lim) ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS ins = ROW_COUNT;
        n := n + ins;
      END IF;
    END LOOP;
  END LOOP;
  RETURN n;
END;
$$;

-- ---------------------------------------------------------------- privileges
REVOKE EXECUTE ON FUNCTION public.plan_effective_tier(uuid), public.plan_effective_limit(uuid, text), public.plan_usage(uuid, text),
  public.plan_enforce_limit(uuid, text, integer), public.plan_feature_allowed(uuid, text), public.plan_scan_grandfathered(),
  public.plan_upgrade_target(text, integer, text), public.plan_limits_bypass(), public.plan_limit_table(),
  public.trg_plan_limit_team_members(), public.trg_plan_limit_business_locations(), public.trg_plan_limit_phone_numbers(),
  public.protect_profile_entitlements() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_effective_tier(uuid), public.plan_effective_limit(uuid, text), public.plan_usage(uuid, text),
  public.plan_feature_allowed(uuid, text), public.plan_scan_grandfathered() TO service_role;
REVOKE EXECUTE ON FUNCTION public.get_plan_entitlements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_plan_entitlements() TO authenticated, service_role;

-- One-time (idempotent) grandfather notice for accounts that are already over a limit.
SELECT public.plan_scan_grandfathered();
