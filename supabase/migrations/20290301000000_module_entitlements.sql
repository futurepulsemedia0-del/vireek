/*
  # Module entitlements (per-account paid / gated modules)

  Layering (read this before adding a module)
  - feature_flags (existing)   = PLATFORM switch: is the code released at all / for what % of tenants.
  - account_module_entitlements = ACCOUNT switch: did THIS account get the module (off / trial / on).
  A new capability ships behind BOTH: a flag (kill switch, rollout) and an entitlement (who may use it).
  Default is DENY: no row, an 'off' row, or an expired row all mean "not entitled".

  Tenant = the account owner's profile id; team members resolve to it through get_account_owner_id().

  Modules: core, pay, ai, supply, finance, passport, intelligence, connect, packs:<slug>.
  To add a module id later, only is_valid_module_id() below needs CREATE OR REPLACE.

  Sources: manual (staff grant), plan (set by billing/plan sync), override (staff override that a plan
  sync must NOT overwrite - the future plan-sync job has to skip rows with source = 'override').

  Reads
  - Client: get_my_entitlements()  one query per session/refresh (no per-module lookups).
  - SQL / RLS of future modules: has_module('pay').
  - Edge functions (service role): entitlement_check(tenant, module).
  Writes: only staff_set_entitlement() (staff + mandatory reason). Every change is audited by trigger
  into module_entitlement_audit, which is append-only (UPDATE / DELETE / TRUNCATE are blocked).

  Seed: every existing account owner gets core = ON (source plan). Everything else stays off (no row).
  A trigger gives every NEW owner core = ON, so default-deny never locks anyone out of core.
*/
-- rollback: DROP TRIGGER trg_profiles_seed_core_entitlement ON profiles; then drop functions has_module,
-- entitlement_check, get_my_entitlements, staff_set_entitlement, staff_list_account_entitlements,
-- staff_list_entitlement_audit, entitlements_seed_core, entitlement_is_active, is_valid_module_id and
-- tables module_entitlement_audit, account_module_entitlements (DESTROYS the audit history: export it first).
-- Nothing else depends on these objects until a module starts calling has_module()/useEntitlement().

-- =============================================================
-- MODULE ID VALIDATION (single place to extend)
-- =============================================================
CREATE OR REPLACE FUNCTION public.is_valid_module_id(p_module text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    p_module ~ '^(core|pay|ai|supply|finance|passport|intelligence|connect|packs:[a-z0-9][a-z0-9_-]{0,39})$',
    false
  );
$$;

-- =============================================================
-- TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS public.account_module_entitlements (
  tenant_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  module_id text NOT NULL CHECK (public.is_valid_module_id(module_id)),
  state text NOT NULL CHECK (state IN ('off', 'trial', 'on')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'plan', 'override')),
  expires_at timestamptz,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 300),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_id),
  CONSTRAINT module_trial_needs_expiry CHECK (state <> 'trial' OR expires_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.module_entitlement_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,           -- no FK on purpose: history must outlive the account
  module_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('grant', 'change', 'revoke', 'remove')),
  before jsonb,
  after jsonb,
  reason text,
  actor uuid,                        -- NULL = migration / system / service role
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_entitlement_audit_tenant
  ON public.module_entitlement_audit (tenant_id, id DESC);

-- =============================================================
-- TRIGGERS
-- =============================================================
CREATE OR REPLACE FUNCTION public.module_entitlements_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.module_id IS DISTINCT FROM OLD.module_id) THEN
    RAISE EXCEPTION 'tenant_id and module_id cannot be changed' USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_module_entitlements_touch ON public.account_module_entitlements;
CREATE TRIGGER trg_module_entitlements_touch BEFORE INSERT OR UPDATE ON public.account_module_entitlements
  FOR EACH ROW EXECUTE FUNCTION public.module_entitlements_touch();

CREATE OR REPLACE FUNCTION public.module_entitlements_audit()
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
    v_old := jsonb_build_object('state', OLD.state, 'source', OLD.source, 'expires_at', OLD.expires_at);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new := jsonb_build_object('state', NEW.state, 'source', NEW.source, 'expires_at', NEW.expires_at);
  END IF;
  IF TG_OP = 'UPDATE' AND v_old = v_new THEN
    RETURN NEW;
  END IF;

  INSERT INTO module_entitlement_audit (tenant_id, module_id, action, before, after, reason, actor)
  VALUES (
    COALESCE(NEW.tenant_id, OLD.tenant_id),
    COALESCE(NEW.module_id, OLD.module_id),
    CASE
      WHEN TG_OP = 'DELETE' THEN 'remove'
      WHEN NEW.state = 'off' THEN 'revoke'
      WHEN TG_OP = 'INSERT' THEN 'grant'
      ELSE 'change'
    END,
    v_old, v_new,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.reason ELSE NEW.reason END,
    auth.uid()
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_module_entitlements_audit ON public.account_module_entitlements;
CREATE TRIGGER trg_module_entitlements_audit AFTER INSERT OR UPDATE OR DELETE ON public.account_module_entitlements
  FOR EACH ROW EXECUTE FUNCTION public.module_entitlements_audit();

-- Append-only audit log: no UPDATE, DELETE or TRUNCATE for anyone (the trigger also stops the table owner).
CREATE OR REPLACE FUNCTION public.module_entitlement_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'module_entitlement_audit is append-only' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_module_entitlement_audit_row ON public.module_entitlement_audit;
CREATE TRIGGER trg_module_entitlement_audit_row BEFORE UPDATE OR DELETE ON public.module_entitlement_audit
  FOR EACH ROW EXECUTE FUNCTION public.module_entitlement_audit_immutable();

DROP TRIGGER IF EXISTS trg_module_entitlement_audit_truncate ON public.module_entitlement_audit;
CREATE TRIGGER trg_module_entitlement_audit_truncate BEFORE TRUNCATE ON public.module_entitlement_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.module_entitlement_audit_immutable();

-- =============================================================
-- RLS: tenants may read their OWN rows; only staff RPCs write. Audit is staff-read only.
-- =============================================================
ALTER TABLE public.account_module_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_entitlement_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.account_module_entitlements, public.module_entitlement_audit FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.account_module_entitlements, public.module_entitlement_audit FROM authenticated;

DROP POLICY IF EXISTS "tenant_read_own_entitlements" ON public.account_module_entitlements;
CREATE POLICY "tenant_read_own_entitlements" ON public.account_module_entitlements FOR SELECT TO authenticated
  USING (tenant_id = (SELECT public.get_account_owner_id()) OR public.is_vireek_staff(auth.uid()));

DROP POLICY IF EXISTS "staff_read_entitlement_audit" ON public.module_entitlement_audit;
CREATE POLICY "staff_read_entitlement_audit" ON public.module_entitlement_audit FOR SELECT TO authenticated
  USING (public.is_vireek_staff(auth.uid()));

-- =============================================================
-- EVALUATION (default deny)
-- =============================================================
CREATE OR REPLACE FUNCTION public.entitlement_is_active(p_state text, p_expires_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(p_state IN ('on', 'trial') AND (p_expires_at IS NULL OR p_expires_at > now()), false);
$$;

-- Client read: ALL of the caller's tenant rows in ONE query. `active` is computed with the server clock.
CREATE OR REPLACE FUNCTION public.get_my_entitlements()
RETURNS TABLE (module_id text, state text, source text, expires_at timestamptz, active boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.module_id, e.state, e.source, e.expires_at, public.entitlement_is_active(e.state, e.expires_at)
    FROM account_module_entitlements e
   WHERE e.tenant_id = (SELECT public.get_account_owner_id())
   ORDER BY e.module_id;
$$;

-- For RLS policies and SQL functions of future modules: has_module('pay').
CREATE OR REPLACE FUNCTION public.has_module(p_module text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT public.entitlement_is_active(e.state, e.expires_at)
      FROM account_module_entitlements e
     WHERE e.tenant_id = (SELECT public.get_account_owner_id())
       AND e.module_id = p_module
  ), false);
$$;

-- For edge functions / API routes using the service-role client. The tenant must come from the VERIFIED
-- caller (never from the request body). Not callable by tenants: they could probe other accounts.
CREATE OR REPLACE FUNCTION public.entitlement_check(p_tenant uuid, p_module text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT public.entitlement_is_active(e.state, e.expires_at)
      FROM account_module_entitlements e
     WHERE e.tenant_id = p_tenant AND e.module_id = p_module
  ), false);
$$;

-- =============================================================
-- STAFF RPCs (each re-checks is_vireek_staff)
-- =============================================================
CREATE OR REPLACE FUNCTION public.staff_list_account_entitlements(p_tenant uuid)
RETURNS TABLE (
  module_id text, state text, source text, expires_at timestamptz, active boolean,
  reason text, updated_at timestamptz, updated_by_email text
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
  SELECT e.module_id, e.state, e.source, e.expires_at, public.entitlement_is_active(e.state, e.expires_at),
         e.reason, e.updated_at, p.email
    FROM account_module_entitlements e
    LEFT JOIN profiles p ON p.id = e.updated_by
   WHERE e.tenant_id = p_tenant
   ORDER BY e.module_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_set_entitlement(
  p_tenant uuid, p_module text, p_state text, p_source text, p_expires_at timestamptz, p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_reason text := NULLIF(btrim(p_reason), '');
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 5 OR char_length(v_reason) > 300 THEN
    RAISE EXCEPTION 'A reason of 5 to 300 characters is required' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_valid_module_id(p_module) THEN
    RAISE EXCEPTION 'Unknown module' USING ERRCODE = '22023';
  END IF;
  IF p_state NOT IN ('off', 'trial', 'on') THEN
    RAISE EXCEPTION 'State must be off, trial or on' USING ERRCODE = '22023';
  END IF;
  IF p_source NOT IN ('manual', 'plan', 'override') THEN
    RAISE EXCEPTION 'Source must be manual, plan or override' USING ERRCODE = '22023';
  END IF;
  IF p_state = 'trial' AND p_expires_at IS NULL THEN
    RAISE EXCEPTION 'A trial needs an expiry date' USING ERRCODE = '22023';
  END IF;
  IF p_state <> 'off' AND p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'The expiry must be in the future' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_tenant AND role = 'owner') THEN
    RAISE EXCEPTION 'Tenant not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO account_module_entitlements (tenant_id, module_id, state, source, expires_at, reason)
  VALUES (p_tenant, p_module, p_state, p_source, CASE WHEN p_state = 'off' THEN NULL ELSE p_expires_at END, v_reason)
  ON CONFLICT (tenant_id, module_id) DO UPDATE
    SET state = EXCLUDED.state, source = EXCLUDED.source,
        expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_list_entitlement_audit(p_tenant uuid, p_limit integer DEFAULT 50)
RETURNS TABLE (
  id bigint, module_id text, action text, before jsonb, after jsonb,
  reason text, created_at timestamptz, actor_email text
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
  SELECT a.id, a.module_id, a.action, a.before, a.after, a.reason, a.created_at, ap.email
    FROM module_entitlement_audit a
    LEFT JOIN profiles ap ON ap.id = a.actor
   WHERE a.tenant_id = p_tenant
   ORDER BY a.id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END;
$$;

-- =============================================================
-- SEED: existing owners -> core ON; new owners get it by trigger
-- =============================================================
CREATE OR REPLACE FUNCTION public.entitlements_seed_core()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role = 'owner' THEN
    INSERT INTO account_module_entitlements (tenant_id, module_id, state, source, reason)
    VALUES (NEW.id, 'core', 'on', 'plan', 'Default: every account includes core')
    ON CONFLICT (tenant_id, module_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_seed_core_entitlement ON public.profiles;
CREATE TRIGGER trg_profiles_seed_core_entitlement AFTER INSERT OR UPDATE OF role ON public.profiles
  FOR EACH ROW WHEN (NEW.role = 'owner') EXECUTE FUNCTION public.entitlements_seed_core();

INSERT INTO public.account_module_entitlements (tenant_id, module_id, state, source, reason)
SELECT p.id, 'core', 'on', 'plan', 'Seed: existing account'
  FROM public.profiles p
 WHERE p.role = 'owner'
ON CONFLICT (tenant_id, module_id) DO NOTHING;

-- =============================================================
-- GRANTS
-- =============================================================
REVOKE ALL ON FUNCTION public.entitlement_is_active(text, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_entitlements() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_module(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.entitlement_check(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.entitlements_seed_core() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_list_account_entitlements(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_set_entitlement(uuid, text, text, text, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_list_entitlement_audit(uuid, integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.entitlement_is_active(text, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_entitlements() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_module(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.entitlement_check(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.staff_list_account_entitlements(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_set_entitlement(uuid, text, text, text, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_list_entitlement_audit(uuid, integer) TO authenticated;
