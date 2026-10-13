/*
  # Feature flags (/staff/feature-flags)

  Model
  - feature_flags: one row per flag. `enabled` is the master / kill switch
    (off = off for EVERY tenant, overrides ignored). `rollout_pct` is the share
    of tenants (0-100) that get the flag.
  - feature_flag_overrides: force a flag ON or OFF for one tenant. A tenant is
    the account owner's profile id (team members resolve to their owner via
    get_account_owner_id()).
  - feature_flag_audit: who changed what, filled by triggers (staff read only).

  Evaluation (single source of truth: feature_flag_is_on)
    enabled = false          -> off
    override 'off' / 'on'    -> off / on
    otherwise                -> bucket(tenant, key) < rollout_pct
  bucket = stable hash of tenant id + flag key, 0-99. It is sticky (raising the
  percentage only ADDS tenants) and independent per flag.

  Access
  - Tenants never touch these tables. The client calls get_my_feature_flags(),
    which returns only the keys that are ON for the caller's tenant (unreleased
    flag names are not exposed).
  - Staff (profiles.is_staff via is_vireek_staff()) manage everything; the
    staff_* RPCs also read tenant details that RLS hides from staff.
*/

-- =============================================================
-- TABLES
-- =============================================================

CREATE TABLE IF NOT EXISTS feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{1,62}[a-z0-9]$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  enabled boolean NOT NULL DEFAULT false,
  rollout_pct integer NOT NULL DEFAULT 0 CHECK (rollout_pct BETWEEN 0 AND 100),
  created_by uuid DEFAULT auth.uid(),
  updated_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feature_flag_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id uuid NOT NULL REFERENCES feature_flags(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('on', 'off')),
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  created_by uuid DEFAULT auth.uid(),
  updated_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flag_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_feature_flag_overrides_tenant ON feature_flag_overrides(tenant_id);

CREATE TABLE IF NOT EXISTS feature_flag_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flag_id uuid,
  flag_key text NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'update', 'delete', 'override_set', 'override_clear')),
  tenant_id uuid,
  before jsonb,
  after jsonb,
  actor uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feature_flag_audit_key ON feature_flag_audit(flag_key, created_at DESC);

-- =============================================================
-- TRIGGERS: touch columns, immutable key, audit trail
-- =============================================================

CREATE OR REPLACE FUNCTION public.feature_flags_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Nested on purpose: NEW.key does not exist on the overrides table.
  IF TG_TABLE_NAME = 'feature_flags' THEN
    IF NEW.key IS DISTINCT FROM OLD.key THEN
      RAISE EXCEPTION 'A flag key cannot be changed once created' USING ERRCODE = '22023';
    END IF;
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_feature_flags_touch ON feature_flags;
CREATE TRIGGER trg_feature_flags_touch BEFORE UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION public.feature_flags_touch();

DROP TRIGGER IF EXISTS trg_feature_flag_overrides_touch ON feature_flag_overrides;
CREATE TRIGGER trg_feature_flag_overrides_touch BEFORE UPDATE ON feature_flag_overrides
  FOR EACH ROW EXECUTE FUNCTION public.feature_flags_touch();

CREATE OR REPLACE FUNCTION public.feature_flags_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old := jsonb_build_object('name', OLD.name, 'description', OLD.description, 'enabled', OLD.enabled, 'rollout_pct', OLD.rollout_pct);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new := jsonb_build_object('name', NEW.name, 'description', NEW.description, 'enabled', NEW.enabled, 'rollout_pct', NEW.rollout_pct);
  END IF;

  IF TG_OP = 'UPDATE' AND v_old = v_new THEN
    RETURN NEW;
  END IF;

  INSERT INTO feature_flag_audit (flag_id, flag_key, action, before, after)
  VALUES (
    COALESCE(NEW.id, OLD.id),
    COALESCE(NEW.key, OLD.key),
    CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'update' ELSE 'delete' END,
    v_old, v_new
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_feature_flags_audit ON feature_flags;
CREATE TRIGGER trg_feature_flags_audit AFTER INSERT OR UPDATE OR DELETE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION public.feature_flags_audit();

CREATE OR REPLACE FUNCTION public.feature_flag_overrides_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text;
BEGIN
  SELECT key INTO v_key FROM feature_flags WHERE id = COALESCE(NEW.flag_id, OLD.flag_id);
  IF v_key IS NULL THEN
    RETURN COALESCE(NEW, OLD); -- the flag itself is being deleted (cascade); its own audit row covers it
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO feature_flag_audit (flag_id, flag_key, action, tenant_id, before)
    VALUES (OLD.flag_id, v_key, 'override_clear', OLD.tenant_id, jsonb_build_object('state', OLD.state, 'note', OLD.note));
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.state = OLD.state AND NEW.note IS NOT DISTINCT FROM OLD.note THEN
    RETURN NEW;
  END IF;

  INSERT INTO feature_flag_audit (flag_id, flag_key, action, tenant_id, before, after)
  VALUES (
    NEW.flag_id, v_key, 'override_set', NEW.tenant_id,
    CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object('state', OLD.state, 'note', OLD.note) END,
    jsonb_build_object('state', NEW.state, 'note', NEW.note)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_feature_flag_overrides_audit ON feature_flag_overrides;
CREATE TRIGGER trg_feature_flag_overrides_audit AFTER INSERT OR UPDATE OR DELETE ON feature_flag_overrides
  FOR EACH ROW EXECUTE FUNCTION public.feature_flag_overrides_audit();

-- =============================================================
-- RLS: staff only. Overrides and audit are written by RPC / trigger only.
-- =============================================================

ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flag_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flag_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON feature_flags, feature_flag_overrides, feature_flag_audit FROM anon;
REVOKE INSERT, UPDATE, DELETE ON feature_flag_overrides, feature_flag_audit FROM authenticated;

DROP POLICY IF EXISTS "staff_manage_feature_flags" ON feature_flags;
CREATE POLICY "staff_manage_feature_flags" ON feature_flags FOR ALL TO authenticated
  USING (is_vireek_staff(auth.uid())) WITH CHECK (is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "staff_read_feature_flag_overrides" ON feature_flag_overrides;
CREATE POLICY "staff_read_feature_flag_overrides" ON feature_flag_overrides FOR SELECT TO authenticated
  USING (is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "staff_read_feature_flag_audit" ON feature_flag_audit;
CREATE POLICY "staff_read_feature_flag_audit" ON feature_flag_audit FOR SELECT TO authenticated
  USING (is_vireek_staff(auth.uid()));

-- =============================================================
-- EVALUATION
-- =============================================================

CREATE OR REPLACE FUNCTION public.feature_flag_bucket(p_tenant uuid, p_key text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT ((hashtextextended(p_tenant::text || ':' || p_key, 0) & 2147483647) % 100)::integer;
$$;

CREATE OR REPLACE FUNCTION public.feature_flag_is_on(
  p_enabled boolean, p_rollout integer, p_override text, p_tenant uuid, p_key text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_enabled AND CASE p_override
    WHEN 'off' THEN false
    WHEN 'on' THEN true
    ELSE public.feature_flag_bucket(p_tenant, p_key) < p_rollout
  END;
$$;

-- Client read: only the keys that are ON for the caller's tenant.
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
   WHERE t.tenant IS NOT NULL
     AND public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, t.tenant, f.key)
   ORDER BY f.key;
$$;

-- =============================================================
-- STAFF RPCs (each re-checks is_vireek_staff)
-- =============================================================

CREATE OR REPLACE FUNCTION public.staff_list_feature_flags()
RETURNS TABLE (
  id uuid, key text, name text, description text, enabled boolean, rollout_pct integer,
  updated_at timestamptz, on_overrides integer, off_overrides integer, reach_tenants integer, total_tenants integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_total integer;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  SELECT count(*)::integer INTO v_total FROM profiles WHERE role = 'owner';

  RETURN QUERY
  SELECT f.id, f.key, f.name, f.description, f.enabled, f.rollout_pct, f.updated_at,
         (SELECT count(*)::integer FROM feature_flag_overrides o WHERE o.flag_id = f.id AND o.state = 'on'),
         (SELECT count(*)::integer FROM feature_flag_overrides o WHERE o.flag_id = f.id AND o.state = 'off'),
         (SELECT count(*)::integer
            FROM profiles p
            LEFT JOIN feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p.id
           WHERE p.role = 'owner'
             AND public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, p.id, f.key)),
         v_total
    FROM feature_flags f
   ORDER BY f.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_list_flag_overrides(p_flag_id uuid)
RETURNS TABLE (
  tenant_id uuid, state text, note text, updated_at timestamptz,
  email text, company_name text, full_name text
)
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
  RETURN QUERY
  SELECT o.tenant_id, o.state, o.note, o.updated_at, p.email, p.company_name, p.full_name
    FROM feature_flag_overrides o
    JOIN profiles p ON p.id = o.tenant_id
   WHERE o.flag_id = p_flag_id
   ORDER BY o.updated_at DESC
   LIMIT 500;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_search_tenants(p_query text)
RETURNS TABLE (id uuid, email text, company_name text, full_name text, plan text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_q text := btrim(COALESCE(p_query, ''));
  v_pat text;
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_q) < 2 THEN
    RETURN;
  END IF;
  v_pat := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  RETURN QUERY
  SELECT p.id, p.email, p.company_name, p.full_name, p.plan
    FROM profiles p
   WHERE p.role = 'owner'
     AND (p.email ILIKE v_pat OR p.company_name ILIKE v_pat OR p.full_name ILIKE v_pat)
   ORDER BY p.email
   LIMIT 8;
END;
$$;

-- p_state: 'on' | 'off' | 'inherit' (inherit removes the override)
CREATE OR REPLACE FUNCTION public.staff_set_flag_override(
  p_flag_id uuid, p_tenant_id uuid, p_state text, p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF p_state NOT IN ('on', 'off', 'inherit') THEN
    RAISE EXCEPTION 'State must be on, off or inherit' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM feature_flags WHERE id = p_flag_id) THEN
    RAISE EXCEPTION 'Flag not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_tenant_id AND role = 'owner') THEN
    RAISE EXCEPTION 'Tenant not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_state = 'inherit' THEN
    DELETE FROM feature_flag_overrides WHERE flag_id = p_flag_id AND tenant_id = p_tenant_id;
  ELSE
    INSERT INTO feature_flag_overrides (flag_id, tenant_id, state, note)
    VALUES (p_flag_id, p_tenant_id, p_state, NULLIF(btrim(p_note), ''))
    ON CONFLICT (flag_id, tenant_id)
    DO UPDATE SET state = EXCLUDED.state, note = EXCLUDED.note;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_list_flag_audit(p_flag_key text)
RETURNS TABLE (
  id bigint, action text, before jsonb, after jsonb, created_at timestamptz,
  actor_email text, tenant_email text
)
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
  RETURN QUERY
  SELECT a.id, a.action, a.before, a.after, a.created_at, ap.email, tp.email
    FROM feature_flag_audit a
    LEFT JOIN profiles ap ON ap.id = a.actor
    LEFT JOIN profiles tp ON tp.id = a.tenant_id
   WHERE a.flag_key = p_flag_key
   ORDER BY a.id DESC
   LIMIT 30;
END;
$$;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.feature_flag_bucket(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feature_flag_is_on(boolean, integer, text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_feature_flags() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_feature_flags() TO authenticated;

REVOKE ALL ON FUNCTION public.staff_list_feature_flags() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_list_flag_overrides(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_search_tenants(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_set_flag_override(uuid, uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_list_flag_audit(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_list_feature_flags() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_list_flag_overrides(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_search_tenants(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_set_flag_override(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_list_flag_audit(text) TO authenticated;
