/*
  # Release flags: role + region targeting (server-side, audited)

  targeting = {"plans": [...], "roles": [...], "regions": [...]}      (all keys optional)
  - plans    unchanged (profiles.plan).
  - roles    owner | admin | technician | member. Resolved SERVER-SIDE per user: the account owner is 'owner'; anyone else
             from an ACTIVE team_members row of that tenant (invite_status = 'active', the value the invite-accept flow
             writes). A role is never taken from the client, the JWT or a request parameter.
  - regions  ISO 3166-1 alpha-2 country codes, matched against profiles.business_country (the only verified tenant
             location column; it is free text, so only values that normalise to two letters can match).
             State/province targeting is NOT supported: no verified source column exists.
  Semantics: AND across keys, OR within a key. A missing key, JSON null or an empty array = no restriction.
  FAIL CLOSED: a restricted dimension whose attribute is unknown (no user supplied, not a member, country unset/invalid)
  excludes the caller. A non-array value for a restricted key also excludes.

  Precedence (single source of truth: feature_flag_decision):
    1 master `enabled` = false            -> OFF   (also beats an ON override)
    2 tenant override 'off'               -> OFF
    3 tenant override 'on'                -> ON    (bypasses rollout %, plan, role and region — unchanged behaviour)
    4 plan, role, region targeting        -> OFF if any excludes
    5 sticky rollout bucket < rollout_pct -> ON, else OFF
  Kill switches (kill_switches) are a separate, stronger layer checked by edge code; targeting never overrides them.

  Additive and backward compatible: flag_evaluate(text, uuid) and get_my_feature_flags() keep their signatures and, for
  flags that only use `plans`, return exactly what they returned before. New: flag_evaluate_for_user(text, uuid, uuid).
  Tenant-level evaluation (no user) of a flag that restricts roles is OFF (fail closed).

  Audit: every targeting change is already captured by feature_flag_audit (before/after contain `targeting`). This
  migration adds (a) strict validation of what may be written, (b) a mandatory-reason RPC whose reason is stored in the
  audit row's `after.change_reason`, (c) a staff explain function for support/verification.

  High/critical-risk flags keep the existing guard: changing targeting of an ENABLED high/critical flag needs the
  two-person flow (lower exposure to OFF first, edit targeting, then request exposure).

  Requires: 20270411000100_feature_flags.sql, 20280501000000_release_safety_core.sql, 20280501000100_release_rollouts_ai_versions.sql.
*/
-- rollback: restore flag_evaluate(text, uuid), get_my_feature_flags(), feature_flags_audit() and staff_flag_impact(text, boolean, integer)
-- from 20280501000000_release_safety_core.sql / 20280501000100_release_rollouts_ai_versions.sql; DROP TRIGGER trg_feature_flags_validate_targeting ON feature_flags;
-- DROP FUNCTION the new feature_flag_* helpers, flag_evaluate_for_user, staff_set_flag_targeting, staff_flag_explain. Stored targeting JSON needs no change.

-- =============================================================
-- 1. Validation + normalisation (pure)
-- =============================================================
CREATE OR REPLACE FUNCTION public.feature_flag_targeting_error(p_targeting jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  k text;
  v jsonb;
  el jsonb;
BEGIN
  IF p_targeting IS NULL OR jsonb_typeof(p_targeting) <> 'object' THEN
    RETURN 'targeting must be a JSON object';
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(p_targeting) LOOP
    IF k NOT IN ('plans', 'roles', 'regions') THEN
      RETURN 'unknown targeting key "' || k || '" (allowed: plans, roles, regions)';
    END IF;
    IF jsonb_typeof(v) <> 'array' THEN
      RETURN k || ' must be an array';
    END IF;
    IF jsonb_array_length(v) > 60 THEN
      RETURN k || ' may list at most 60 values';
    END IF;
    FOR el IN SELECT value FROM jsonb_array_elements(v) LOOP
      IF jsonb_typeof(el) <> 'string' THEN
        RETURN k || ' must contain only strings';
      END IF;
      IF k = 'roles' AND (el #>> '{}') NOT IN ('owner', 'admin', 'technician', 'member') THEN
        RETURN 'invalid role "' || left(el #>> '{}', 40) || '" (allowed: owner, admin, technician, member)';
      END IF;
      IF k = 'regions' AND (el #>> '{}') !~ '^[A-Z]{2}$' THEN
        RETURN 'invalid region "' || left(el #>> '{}', 40) || '" (use an upper-case ISO 3166-1 alpha-2 country code)';
      END IF;
      IF k = 'plans' AND char_length(el #>> '{}') NOT BETWEEN 1 AND 40 THEN
        RETURN 'plan names must be 1-40 characters';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

-- Trims, upper/lower-cases, de-duplicates and sorts the three lists; drops empty lists. Invalid shapes pass through
-- unchanged so feature_flag_targeting_error still rejects them.
CREATE OR REPLACE FUNCTION public.feature_flag_targeting_normalize(p_targeting jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  r jsonb := '{}'::jsonb;
  k text;
  v jsonb;
  arr jsonb;
BEGIN
  IF p_targeting IS NULL OR jsonb_typeof(p_targeting) <> 'object' THEN
    RETURN p_targeting;
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(p_targeting) LOOP
    IF k IN ('plans', 'roles', 'regions') AND jsonb_typeof(v) = 'array'
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v) AS e(x) WHERE jsonb_typeof(e.x) <> 'string') THEN
      SELECT COALESCE(jsonb_agg(s.val ORDER BY s.val), '[]'::jsonb) INTO arr
        FROM (
          SELECT DISTINCT CASE k WHEN 'roles' THEN lower(btrim(t.x)) WHEN 'regions' THEN upper(btrim(t.x)) ELSE btrim(t.x) END AS val
            FROM jsonb_array_elements_text(v) AS t(x)
        ) s;
      IF jsonb_array_length(arr) > 0 THEN
        r := r || jsonb_build_object(k, arr);
      END IF;
    ELSE
      r := r || jsonb_build_object(k, v);
    END IF;
  END LOOP;
  RETURN r;
END;
$$;

-- Applies only to NEW writes of `targeting` (legacy rows are never re-validated). Direct writers must send canonical values.
CREATE OR REPLACE FUNCTION public.feature_flags_validate_targeting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_err text;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.targeting IS DISTINCT FROM OLD.targeting THEN
    v_err := public.feature_flag_targeting_error(NEW.targeting);
    IF v_err IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid flag targeting: %', v_err USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_feature_flags_validate_targeting ON public.feature_flags;
CREATE TRIGGER trg_feature_flags_validate_targeting
  BEFORE INSERT OR UPDATE ON public.feature_flags
  FOR EACH ROW EXECUTE FUNCTION public.feature_flags_validate_targeting();

-- =============================================================
-- 2. Matching + decision (pure, IMMUTABLE => unit-testable without fixtures)
-- =============================================================
CREATE OR REPLACE FUNCTION public.feature_flag_list_match(p_targeting jsonb, p_key text, p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_targeting IS NULL OR (p_targeting -> p_key) IS NULL OR jsonb_typeof(p_targeting -> p_key) = 'null' THEN true
    WHEN jsonb_typeof(p_targeting -> p_key) <> 'array' THEN false
    WHEN jsonb_array_length(p_targeting -> p_key) = 0 THEN true
    ELSE p_value IS NOT NULL
         AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_targeting -> p_key) AS e(x) WHERE e.x = p_value)
  END;
$$;

CREATE OR REPLACE FUNCTION public.feature_flag_role_match(p_targeting jsonb, p_role text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT public.feature_flag_list_match(p_targeting, 'roles', lower(p_role)); $$;

CREATE OR REPLACE FUNCTION public.feature_flag_region_match(p_targeting jsonb, p_country text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT public.feature_flag_list_match(p_targeting, 'regions', upper(p_country)); $$;

-- Returns the reason code; ON means reason IN ('override_on', 'on').
CREATE OR REPLACE FUNCTION public.feature_flag_decision(
  p_enabled boolean, p_rollout integer, p_override text, p_tenant uuid, p_key text,
  p_targeting jsonb, p_plan text, p_role text, p_country text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NOT COALESCE(p_enabled, false) THEN 'disabled'
    WHEN p_override = 'off' THEN 'override_off'
    WHEN p_override = 'on' THEN 'override_on'
    WHEN NOT public.feature_flag_plan_match(p_targeting, p_plan) THEN 'plan_excluded'
    WHEN NOT public.feature_flag_role_match(p_targeting, p_role) THEN 'role_excluded'
    WHEN NOT public.feature_flag_region_match(p_targeting, p_country) THEN 'region_excluded'
    WHEN public.feature_flag_bucket(p_tenant, p_key) >= COALESCE(p_rollout, 0) THEN 'rollout_excluded'
    ELSE 'on'
  END;
$$;

-- =============================================================
-- 3. Server-side attribute resolvers (never trust client-supplied role/region)
-- =============================================================
CREATE OR REPLACE FUNCTION public.feature_flag_user_role(p_tenant uuid, p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_tenant IS NULL OR p_user IS NULL THEN NULL
    WHEN p_user = p_tenant THEN (SELECT 'owner'::text FROM profiles WHERE id = p_tenant)
    ELSE (
      SELECT tm.role
        FROM team_members tm
       WHERE tm.account_owner_id = p_tenant
         AND tm.user_id = p_user
         AND tm.invite_status = 'active'
         AND tm.role IN ('owner', 'admin', 'technician', 'member')
       ORDER BY tm.created_at, tm.id
       LIMIT 1
    )
  END;
$$;

CREATE OR REPLACE FUNCTION public.feature_flag_tenant_country(p_tenant uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN upper(btrim(p.business_country)) ~ '^[A-Z]{2}$' THEN upper(btrim(p.business_country)) END
    FROM profiles p
   WHERE p.id = p_tenant;
$$;

-- Impact previews: does this tenant have at least one active user who could match the role list?
CREATE OR REPLACE FUNCTION public.feature_flag_tenant_role_reachable(p_tenant uuid, p_targeting jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_targeting IS NULL OR (p_targeting -> 'roles') IS NULL OR jsonb_typeof(p_targeting -> 'roles') = 'null' THEN true
    WHEN jsonb_typeof(p_targeting -> 'roles') <> 'array' THEN false
    WHEN jsonb_array_length(p_targeting -> 'roles') = 0 THEN true
    ELSE EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(p_targeting -> 'roles') AS r(x)
       WHERE r.x = 'owner'
          OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.account_owner_id = p_tenant AND tm.invite_status = 'active' AND tm.role = r.x)
    )
  END;
$$;

-- =============================================================
-- 4. Evaluation entry points
-- =============================================================
-- Tenant-level (no user): plan + region apply; a role-restricted flag is OFF unless an ON override exists.
CREATE OR REPLACE FUNCTION public.flag_evaluate(p_key text, p_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT public.feature_flag_decision(f.enabled, f.rollout_pct, o.state, p_tenant, f.key, f.targeting, p.plan,
                                        NULL, public.feature_flag_tenant_country(p_tenant)) IN ('override_on', 'on')
      FROM feature_flags f
      LEFT JOIN feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p_tenant
      LEFT JOIN profiles p ON p.id = p_tenant
     WHERE f.key = p_key
  ), false);
$$;

-- Per-user: the role is resolved from the database for (tenant, user). A user who is not the owner or an active member of
-- the tenant has no role, so role-restricted flags are OFF for them.
CREATE OR REPLACE FUNCTION public.flag_evaluate_for_user(p_key text, p_tenant uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT public.feature_flag_decision(f.enabled, f.rollout_pct, o.state, p_tenant, f.key, f.targeting, p.plan,
                                        public.feature_flag_user_role(p_tenant, p_user),
                                        public.feature_flag_tenant_country(p_tenant)) IN ('override_on', 'on')
      FROM feature_flags f
      LEFT JOIN feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p_tenant
      LEFT JOIN profiles p ON p.id = p_tenant
     WHERE f.key = p_key
  ), false);
$$;

-- Client read (same signature): keys that are ON for the caller, with the caller's own server-resolved role.
CREATE OR REPLACE FUNCTION public.get_my_feature_flags()
RETURNS TABLE (flag_key text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT f.key
    FROM feature_flags f
   CROSS JOIN LATERAL (SELECT public.get_account_owner_id() AS tenant) t
    LEFT JOIN feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = t.tenant
    LEFT JOIN profiles p ON p.id = t.tenant
   CROSS JOIN LATERAL (
     SELECT public.feature_flag_user_role(t.tenant, auth.uid()) AS role_v,
            public.feature_flag_tenant_country(t.tenant) AS country_v
   ) a
   WHERE t.tenant IS NOT NULL
     AND public.feature_flag_decision(f.enabled, f.rollout_pct, o.state, t.tenant, f.key, f.targeting, p.plan,
                                      a.role_v, a.country_v) IN ('override_on', 'on')
   ORDER BY f.key;
$$;

REVOKE ALL ON FUNCTION public.feature_flag_user_role(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feature_flag_tenant_country(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feature_flag_tenant_role_reachable(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.flag_evaluate_for_user(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.flag_evaluate(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feature_flag_user_role(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.feature_flag_tenant_country(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.feature_flag_tenant_role_reachable(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.flag_evaluate_for_user(text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.flag_evaluate(text, uuid) TO service_role;

-- =============================================================
-- 5. Audit: carry the change reason into feature_flag_audit.after
--    (same function as 20280501000000, plus `change_reason` from the transaction-local setting app.flag_change_reason)
-- =============================================================
CREATE OR REPLACE FUNCTION public.feature_flags_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_after jsonb;
  v_reason text := NULLIF(btrim(COALESCE(current_setting('app.flag_change_reason', true), '')), '');
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old := jsonb_build_object('name', OLD.name, 'description', OLD.description, 'enabled', OLD.enabled, 'rollout_pct', OLD.rollout_pct,
      'owner', OLD.owner, 'kind', OLD.kind, 'risk', OLD.risk, 'expires_at', OLD.expires_at, 'targeting', OLD.targeting);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new := jsonb_build_object('name', NEW.name, 'description', NEW.description, 'enabled', NEW.enabled, 'rollout_pct', NEW.rollout_pct,
      'owner', NEW.owner, 'kind', NEW.kind, 'risk', NEW.risk, 'expires_at', NEW.expires_at, 'targeting', NEW.targeting);
  END IF;

  IF TG_OP = 'UPDATE' AND v_old = v_new THEN
    RETURN NEW;
  END IF;

  v_after := CASE WHEN v_new IS NOT NULL AND v_reason IS NOT NULL THEN v_new || jsonb_build_object('change_reason', v_reason) ELSE v_new END;

  INSERT INTO feature_flag_audit (flag_id, flag_key, action, before, after)
  VALUES (
    COALESCE(NEW.id, OLD.id),
    COALESCE(NEW.key, OLD.key),
    CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'update' ELSE 'delete' END,
    v_old, v_after
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- =============================================================
-- 6. Staff RPCs
-- =============================================================
-- Sets targeting with a mandatory reason. Normalises and validates. High/critical enabled flags are stopped by the existing guard.
CREATE OR REPLACE FUNCTION public.staff_set_flag_targeting(p_flag_key text, p_targeting jsonb, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_norm jsonb := public.feature_flag_targeting_normalize(p_targeting);
  v_err text;
  v_rows integer;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 3 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Reason must be 3-500 characters' USING ERRCODE = '22023';
  END IF;
  v_err := public.feature_flag_targeting_error(v_norm);
  IF v_err IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid flag targeting: %', v_err USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.flag_change_reason', v_reason, true);
  UPDATE feature_flags SET targeting = v_norm WHERE feature_flags.key = p_flag_key;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('app.flag_change_reason', '', true);

  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Flag not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_norm;
END;
$$;

-- Support / verification: why is this flag ON or OFF for this tenant (and user)?
CREATE OR REPLACE FUNCTION public.staff_flag_explain(p_flag_key text, p_tenant uuid, p_user uuid DEFAULT NULL)
RETURNS TABLE (
  is_on boolean, reason text, resolved_role text, resolved_country text, plan text,
  override_state text, bucket integer, rollout_pct integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  f feature_flags%ROWTYPE;
  v_override text;
  v_plan text;
  v_role text;
  v_country text;
  v_reason text;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO f FROM feature_flags x WHERE x.key = p_flag_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flag not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT o.state INTO v_override FROM feature_flag_overrides o WHERE o.flag_id = f.id AND o.tenant_id = p_tenant;
  SELECT pr.plan INTO v_plan FROM profiles pr WHERE pr.id = p_tenant;
  v_role := public.feature_flag_user_role(p_tenant, p_user);
  v_country := public.feature_flag_tenant_country(p_tenant);
  v_reason := public.feature_flag_decision(f.enabled, f.rollout_pct, v_override, p_tenant, f.key, f.targeting, v_plan, v_role, v_country);
  RETURN QUERY SELECT v_reason IN ('override_on', 'on'), v_reason, v_role, v_country, v_plan, v_override,
                      public.feature_flag_bucket(p_tenant, f.key), f.rollout_pct;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_set_flag_targeting(text, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_flag_explain(text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_set_flag_targeting(text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_flag_explain(text, uuid, uuid) TO authenticated;

-- Impact preview (same signature/columns): now also honours region, and counts a tenant for role targeting only when it
-- has at least one active user who could match (owner always can). Counts are accounts, not individual users.
CREATE OR REPLACE FUNCTION public.staff_flag_impact(p_flag_key text, p_enabled boolean, p_rollout_pct integer)
RETURNS TABLE (current_tenants integer, next_tenants integer, newly_exposed integer, total_tenants integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF p_rollout_pct IS NULL OR p_rollout_pct < 0 OR p_rollout_pct > 100 OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'Invalid change' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT (count(*) FILTER (WHERE x.cur))::integer,
         (count(*) FILTER (WHERE x.nxt))::integer,
         (count(*) FILTER (WHERE x.nxt AND NOT x.cur))::integer,
         count(*)::integer
    FROM (
      SELECT public.feature_flag_decision(f.enabled, f.rollout_pct, o.state, p.id, f.key, f.targeting - 'roles', p.plan, NULL,
                                          public.feature_flag_tenant_country(p.id)) IN ('override_on', 'on')
               AND (o.state = 'on' OR public.feature_flag_tenant_role_reachable(p.id, f.targeting)) AS cur,
             public.feature_flag_decision(p_enabled, p_rollout_pct, o.state, p.id, f.key, f.targeting - 'roles', p.plan, NULL,
                                          public.feature_flag_tenant_country(p.id)) IN ('override_on', 'on')
               AND (o.state = 'on' OR public.feature_flag_tenant_role_reachable(p.id, f.targeting)) AS nxt
        FROM profiles p
       CROSS JOIN feature_flags f
        LEFT JOIN feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p.id
       WHERE p.role = 'owner' AND f.key = p_flag_key
    ) x;
END;
$$;
