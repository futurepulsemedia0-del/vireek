/*
  # Solar pack (Trade Pack #3) — OFF by default

  ## Why
  Solar installers run a permit-to-PTO pipeline, track panel / inverter / battery serials with warranty
  terms, and later file warranty claims. The Trade Pack framework (20271201000000_trade_packs.sql) already
  covers fields, forms/checklists, recurring plans, pricing and the append-only compliance ledger; this
  migration adds ONLY what it cannot express: pipeline stages, an equipment/warranty registry, a warranty-claim
  workflow and tenant-configured jurisdiction profiles.

  ## Default-OFF gate (zero behaviour change for existing tenants)
  - feature flag `trade_pack_solar` (enabled=false, rollout 0)  AND
  - per-account entitlement `packs:solar` in account_module_entitlements (granted by Vireek staff only)
  Both must be true (solar_module_active) before the pack can be installed (trigger on trade_pack_installs)
  or any solar_* row can be written (RLS). Nothing existing is altered except ONE new trigger on
  trade_pack_installs that only acts on pack_key = 'solar'.

  ## Safety model
  - Every table: RLS on, tenant column user_id = get_account_owner_id(), NO delete policies (archive instead).
  - Stage / claim status moves are only possible through the SECURITY DEFINER RPCs solar_set_stage_status /
    solar_set_claim_status (UPDATE of `status` is not granted to clients); BEFORE triggers re-validate every
    transition (defence in depth). Every move is written to the append-only solar_workflow_events log.
  - Cross-tenant references (customer, install project, team member, jurisdiction, unit, recovery claim) are
    checked in guards, so a forged id from another tenant is rejected.
  - Serial numbers are unique per tenant among active units (advisory-locked check).
  - Jurisdiction rules are tenant CONFIGURATION. They are never asserted as compliant: a profile shows
    "REQUIRES COUNSEL / AHJ VERIFICATION" until the tenant records a reviewer note, and any later change to the
    rules clears that verification.
  - Warranty end = anniversary − 1 day (inclusive); a manufacturer-certificate override always wins.
    ASSUMPTION — confirm per manufacturer terms.

  ## Depends on
  20271201000000_trade_packs.sql (trade_packs, trade_log_types, trade_pack_installs, can_manage_trade_packs),
  20270411000100_feature_flags.sql (feature_flags, feature_flag_is_on, is_vireek_staff),
  20260927000001 (equipment), 20261121000000 (warranty_claims), 20271008000000 (install_projects),
  20260821101104 (profiles, team_members, get_account_owner_id), 20260831090000 (log_audit_event).

  ## Rollback (nothing here is destructive; prefer the soft steps)
  Soft (instant, keeps every record):
    UPDATE feature_flags SET enabled = false WHERE key = 'trade_pack_solar';
    SELECT public.staff_set_module_entitlement('<tenant uuid>', 'packs:solar', false, 'rollback');
    -- per tenant, owner/admin: SELECT public.update_trade_pack('solar', false, NULL, NULL);
  Hard (ONLY on a database with no solar data you need; run in reverse order):
    DROP TRIGGER IF EXISTS trg_solar_install_gate ON trade_pack_installs;
    DROP TABLE IF EXISTS solar_workflow_events, solar_warranty_claims, solar_equipment_units,
                         solar_pipeline_stages, solar_projects, solar_jurisdiction_profiles CASCADE;
    DROP FUNCTION IF EXISTS public.solar_set_stage_status(uuid, text, text, text), public.solar_set_claim_status(uuid, text, text, text, text),
      public.solar_expiring_warranties(integer), public.get_solar_module_state(), public.solar_module_active(uuid),
      public.solar_flag_on(uuid), public.staff_set_module_entitlement(uuid, text, boolean, text), public.module_entitled(uuid, text),
      public.can_manage_solar(), public.solar_warranty_end(date, integer), public.solar_install_gate();
    DELETE FROM trade_log_entries WHERE pack_key = 'solar';   -- append-only ledger: needs a superuser / disabled trigger
    DELETE FROM trade_pack_installs WHERE pack_key = 'solar';
    DELETE FROM trade_log_types WHERE pack_key = 'solar';  DELETE FROM trade_packs WHERE pack_key = 'solar';
    DELETE FROM feature_flags WHERE key = 'trade_pack_solar';  DROP TABLE IF EXISTS account_module_entitlements;
  Re-running this migration is safe (IF NOT EXISTS / OR REPLACE / ON CONFLICT everywhere).
*/

-- =============================================================
-- 1. FLAG + ENTITLEMENT (default OFF)
-- =============================================================

INSERT INTO feature_flags (key, name, description, enabled, rollout_pct)
VALUES ('trade_pack_solar', 'Trade Pack: Solar',
        'Solar pack: permit-to-PTO pipeline, equipment + warranty registry, warranty claims. Also needs the packs:solar entitlement.',
        false, 0)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS account_module_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  module_key text NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$'),
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  UNIQUE (user_id, module_key)
);

ALTER TABLE account_module_entitlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_account_module_entitlements" ON account_module_entitlements;
CREATE POLICY "select_account_module_entitlements" ON account_module_entitlements FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));
-- Writes: staff_set_module_entitlement() only (no INSERT / UPDATE / DELETE policies).

CREATE OR REPLACE FUNCTION public.module_entitled(p_tenant uuid, p_module text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM account_module_entitlements e
    WHERE e.user_id = p_tenant AND e.module_key = p_module AND e.revoked_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.solar_flag_on(p_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, p_tenant, f.key)
    FROM feature_flags f
    LEFT JOIN feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p_tenant
    WHERE f.key = 'trade_pack_solar'
  ), false);
$$;

-- Flag AND entitlement. A signed-in caller can only ask about their own account (staff may ask about any).
CREATE OR REPLACE FUNCTION public.solar_module_active(p_tenant uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_tenant IS NULL THEN RETURN false; END IF;
  IF auth.uid() IS NOT NULL
     AND p_tenant IS DISTINCT FROM public.get_account_owner_id()
     AND NOT public.is_vireek_staff(auth.uid()) THEN
    RETURN false;
  END IF;
  RETURN public.solar_flag_on(p_tenant) AND public.module_entitled(p_tenant, 'packs:solar');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_solar_module_state()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_flag boolean;
  v_ent boolean;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  v_owner := public.get_account_owner_id();
  IF v_owner IS NULL THEN RETURN NULL; END IF;
  v_flag := public.solar_flag_on(v_owner);
  v_ent := public.module_entitled(v_owner, 'packs:solar');
  RETURN jsonb_build_object('flag_on', v_flag, 'entitled', v_ent, 'active', v_flag AND v_ent);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_set_module_entitlement(p_tenant uuid, p_module text, p_granted boolean, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  IF p_module IS NULL OR p_module !~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'invalid_module' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_tenant AND role = 'owner') THEN
    RAISE EXCEPTION 'Tenant not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_granted THEN
    INSERT INTO account_module_entitlements (user_id, module_key, granted_by, note)
    VALUES (p_tenant, p_module, auth.uid(), left(p_note, 300))
    ON CONFLICT (user_id, module_key) DO UPDATE
      SET revoked_at = NULL, granted_by = auth.uid(), granted_at = now(), note = COALESCE(left(p_note, 300), account_module_entitlements.note);
  ELSE
    UPDATE account_module_entitlements
    SET revoked_at = COALESCE(revoked_at, now()), note = COALESCE(left(p_note, 300), note)
    WHERE user_id = p_tenant AND module_key = p_module;
  END IF;

  PERFORM public.log_audit_event(p_tenant, CASE WHEN p_granted THEN 'module_entitlement.grant' ELSE 'module_entitlement.revoke' END, 'account_module_entitlements', p_module);
END;
$$;

REVOKE ALL ON FUNCTION public.module_entitled(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.solar_flag_on(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.solar_module_active(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_solar_module_state() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_set_module_entitlement(uuid, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.module_entitled(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.solar_flag_on(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.solar_module_active(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_solar_module_state() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_set_module_entitlement(uuid, text, boolean, text) TO authenticated;

-- Permission alias: today the same people who manage trade packs manage solar workflow decisions.
CREATE OR REPLACE FUNCTION public.can_manage_solar()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.can_manage_trade_packs();
$$;
GRANT EXECUTE ON FUNCTION public.can_manage_solar() TO authenticated;

-- =============================================================
-- 2. PACK REGISTRATION (generated from src/lib/tradePacks/solar.ts — kept in sync by solar.test.ts)
-- =============================================================

INSERT INTO trade_packs (pack_key, name, industry_slug) VALUES ('solar', 'Solar', 'solar')
  ON CONFLICT (pack_key) DO UPDATE SET name = EXCLUDED.name, industry_slug = EXCLUDED.industry_slug;

INSERT INTO trade_log_types (pack_key, entry_type, label, requires_job, requires_technician, requires_equipment, uses_product, required_credentials, restricted_credentials, retention_years, spec)
VALUES ('solar', 'commissioning_record', 'Commissioning record', true, true, false, false, ARRAY[]::text[], ARRAY[]::text[], 10,
  '{"fields":[{"key":"system_size_kw_dc","type":"number","required":true,"min":0.1,"max":10000},{"key":"array_voc_v","type":"number","required":false,"min":0,"max":1500},{"key":"array_isc_a","type":"number","required":false,"min":0,"max":100},{"key":"ac_voltage_v","type":"number","required":false,"min":0,"max":1000},{"key":"insulation_resistance_mohm","type":"number","required":false,"min":0,"max":10000},{"key":"ground_continuity_ohm","type":"number","required":false,"min":0,"max":100},{"key":"firmware_version","type":"text","required":false},{"key":"monitoring_connected","type":"boolean","required":true},{"key":"rapid_shutdown_tested","type":"boolean","required":true},{"key":"labels_placed","type":"boolean","required":true},{"key":"customer_walkthrough","type":"boolean","required":false},{"key":"result","type":"select","required":true,"options":["Completed — no open items","Completed — open items","Not commissioned"]},{"key":"open_items","type":"textarea","required":false}],"at_least_one_of":[]}'::jsonb)
ON CONFLICT (pack_key, entry_type) DO UPDATE SET label = EXCLUDED.label, requires_job = EXCLUDED.requires_job, requires_technician = EXCLUDED.requires_technician, requires_equipment = EXCLUDED.requires_equipment, uses_product = EXCLUDED.uses_product, required_credentials = EXCLUDED.required_credentials, restricted_credentials = EXCLUDED.restricted_credentials, retention_years = EXCLUDED.retention_years, spec = EXCLUDED.spec;

INSERT INTO trade_log_types (pack_key, entry_type, label, requires_job, requires_technician, requires_equipment, uses_product, required_credentials, restricted_credentials, retention_years, spec)
VALUES ('solar', 'om_visit', 'O&M visit', true, true, false, false, ARRAY[]::text[], ARRAY[]::text[], 7,
  '{"fields":[{"key":"visit_type","type":"select","required":true,"options":["Annual inspection","Panel cleaning","Troubleshooting","Inverter service","Battery service","Warranty visit"]},{"key":"system_status","type":"select","required":true,"options":["Producing normally","Producing below expected","Partially offline","Not producing"]},{"key":"fault_codes","type":"text","required":false},{"key":"visual_damage","type":"boolean","required":true},{"key":"panels_cleaned","type":"boolean","required":false},{"key":"monitoring_ok","type":"boolean","required":false},{"key":"findings","type":"textarea","required":false},{"key":"recommendations","type":"textarea","required":false}],"at_least_one_of":[]}'::jsonb)
ON CONFLICT (pack_key, entry_type) DO UPDATE SET label = EXCLUDED.label, requires_job = EXCLUDED.requires_job, requires_technician = EXCLUDED.requires_technician, requires_equipment = EXCLUDED.requires_equipment, uses_product = EXCLUDED.uses_product, required_credentials = EXCLUDED.required_credentials, restricted_credentials = EXCLUDED.restricted_credentials, retention_years = EXCLUDED.retention_years, spec = EXCLUDED.spec;


-- Install gate: the solar pack can only be switched ON where the module is active. Other packs are untouched.
-- Re-saving config on an already-enabled install, and turning the pack OFF, are never blocked (rollback must always work).
CREATE OR REPLACE FUNCTION public.solar_install_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.pack_key = 'solar'
     AND NEW.enabled
     AND (TG_OP = 'INSERT' OR OLD.enabled IS DISTINCT FROM true)
     AND auth.uid() IS NOT NULL
     AND NOT public.solar_module_active(NEW.user_id) THEN
    RAISE EXCEPTION 'solar_module_not_available: the Solar pack is not enabled for this account' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_solar_install_gate ON trade_pack_installs;
CREATE TRIGGER trg_solar_install_gate BEFORE INSERT OR UPDATE ON trade_pack_installs
  FOR EACH ROW EXECUTE FUNCTION public.solar_install_gate();

-- =============================================================
-- 3. HELPERS
-- =============================================================

-- Last covered day of an N-year warranty (anniversary − 1 day). Mirrors warrantyEnd() in solarPipeline.ts.
CREATE OR REPLACE FUNCTION public.solar_warranty_end(p_start date, p_years integer)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_start IS NULL OR p_years IS NULL OR p_years <= 0 THEN NULL
    ELSE ((p_start + make_interval(years => p_years))::date - 1)
  END;
$$;

CREATE OR REPLACE FUNCTION public.solar_stage_transition_ok(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_from
    WHEN 'not_started' THEN p_to IN ('in_progress', 'skipped')
    WHEN 'in_progress' THEN p_to IN ('submitted')
    WHEN 'submitted' THEN p_to IN ('approved', 'corrections_required', 'rejected')
    WHEN 'corrections_required' THEN p_to IN ('in_progress', 'submitted')
    WHEN 'rejected' THEN p_to IN ('in_progress')
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.solar_stage_deps(p_stage text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_stage
    WHEN 'permit' THEN ARRAY['design']
    WHEN 'interconnection' THEN ARRAY['design']
    WHEN 'inspection' THEN ARRAY['permit']
    WHEN 'pto' THEN ARRAY['inspection', 'interconnection']
    ELSE ARRAY[]::text[]
  END;
$$;

CREATE OR REPLACE FUNCTION public.solar_claim_transition_ok(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_from
    WHEN 'draft' THEN p_to IN ('submitted', 'withdrawn')
    WHEN 'submitted' THEN p_to IN ('under_review', 'info_requested', 'approved', 'denied', 'withdrawn')
    WHEN 'under_review' THEN p_to IN ('info_requested', 'approved', 'denied', 'withdrawn')
    WHEN 'info_requested' THEN p_to IN ('submitted', 'withdrawn')
    WHEN 'approved' THEN p_to IN ('resolved')
    WHEN 'denied' THEN p_to IN ('closed', 'under_review')
    WHEN 'resolved' THEN p_to IN ('closed')
    ELSE false
  END;
$$;

-- =============================================================
-- 4. JURISDICTION PROFILES (tenant configuration — REQUIRES COUNSEL / AHJ VERIFICATION)
-- =============================================================

CREATE TABLE IF NOT EXISTS solar_jurisdiction_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  ahj_name text CHECK (ahj_name IS NULL OR char_length(ahj_name) <= 160),
  utility_name text CHECK (utility_name IS NULL OR char_length(utility_name) <= 160),
  region text CHECK (region IS NULL OR char_length(region) <= 80),
  -- {"permit": 15, "interconnection": 30, ...}: the tenant's own expected review days per stage (prefill only).
  stage_review_days jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(stage_review_days) = 'object' AND octet_length(stage_review_days::text) <= 1000),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  verified_at timestamptz,
  verified_by uuid,
  verification_note text CHECK (verification_note IS NULL OR char_length(verification_note) <= 500),
  archived_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT solar_jurisdiction_verified_note CHECK (verified_at IS NULL OR char_length(btrim(coalesce(verification_note, ''))) >= 5)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_solar_jurisdiction_name ON solar_jurisdiction_profiles (user_id, lower(btrim(name))) WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION public.solar_jurisdiction_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  r record;
  n numeric;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'solar_jurisdiction_invalid: owner cannot change' USING ERRCODE = '22023';
  END IF;
  FOR r IN SELECT key, value FROM jsonb_each(NEW.stage_review_days) LOOP
    IF r.key NOT IN ('design', 'permit', 'interconnection', 'inspection', 'pto') THEN
      RAISE EXCEPTION 'solar_jurisdiction_invalid: unknown stage "%"', r.key USING ERRCODE = '23514';
    END IF;
    IF jsonb_typeof(r.value) <> 'number' THEN
      RAISE EXCEPTION 'solar_jurisdiction_invalid: % must be a number of days', r.key USING ERRCODE = '23514';
    END IF;
    n := (r.value #>> '{}')::numeric;
    IF n <> trunc(n) OR n < 0 OR n > 365 THEN
      RAISE EXCEPTION 'solar_jurisdiction_invalid: % must be whole days from 0 to 365', r.key USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF TG_OP = 'INSERT' THEN
    IF NEW.verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'solar_jurisdiction_invalid: save the profile first, then record the review' USING ERRCODE = '23514';
    END IF;
  ELSE
    -- Any change to the rules invalidates an earlier review.
    IF OLD.verified_at IS NOT NULL AND NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at AND (
         NEW.stage_review_days IS DISTINCT FROM OLD.stage_review_days
         OR NEW.ahj_name IS DISTINCT FROM OLD.ahj_name
         OR NEW.utility_name IS DISTINCT FROM OLD.utility_name
         OR NEW.name IS DISTINCT FROM OLD.name
         OR NEW.region IS DISTINCT FROM OLD.region) THEN
      NEW.verified_at := NULL;
      NEW.verified_by := NULL;
      NEW.verification_note := NULL;
    END IF;
    IF NEW.verified_at IS NOT NULL AND OLD.verified_at IS NULL THEN
      NEW.verified_by := auth.uid();
    END IF;
  END IF;
  NEW.name := btrim(NEW.name);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_solar_jurisdiction_guard ON solar_jurisdiction_profiles;
CREATE TRIGGER trg_solar_jurisdiction_guard BEFORE INSERT OR UPDATE ON solar_jurisdiction_profiles
  FOR EACH ROW EXECUTE FUNCTION public.solar_jurisdiction_guard();

ALTER TABLE solar_jurisdiction_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_solar_jurisdiction" ON solar_jurisdiction_profiles;
CREATE POLICY "select_solar_jurisdiction" ON solar_jurisdiction_profiles FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));
DROP POLICY IF EXISTS "insert_solar_jurisdiction" ON solar_jurisdiction_profiles;
CREATE POLICY "insert_solar_jurisdiction" ON solar_jurisdiction_profiles FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND public.solar_module_active(user_id) AND public.can_manage_solar());
DROP POLICY IF EXISTS "update_solar_jurisdiction" ON solar_jurisdiction_profiles;
CREATE POLICY "update_solar_jurisdiction" ON solar_jurisdiction_profiles FOR UPDATE TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND public.solar_module_active(user_id) AND public.can_manage_solar())
  WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND public.solar_module_active(user_id) AND public.can_manage_solar());

-- =============================================================
-- 5. PROJECTS + PIPELINE STAGES
-- =============================================================

CREATE TABLE IF NOT EXISTS solar_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  install_project_id uuid REFERENCES install_projects(id) ON DELETE SET NULL,
  jurisdiction_id uuid REFERENCES solar_jurisdiction_profiles(id) ON DELETE SET NULL,
  site_address text CHECK (site_address IS NULL OR char_length(site_address) <= 300),
  system_size_kw numeric(9,3) CHECK (system_size_kw IS NULL OR (system_size_kw > 0 AND system_size_kw <= 100000)),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_hold', 'completed', 'cancelled')),
  -- Optional read-only monitoring (adapter in src/lib/tradePacks/solarMonitoring.ts). No credentials are stored here.
  monitoring_provider text NOT NULL DEFAULT 'none' CHECK (monitoring_provider IN ('none', 'mock')),
  monitoring_site_ref text CHECK (monitoring_site_ref IS NULL OR char_length(monitoring_site_ref) <= 120),
  -- Opaque reference owned by a future financing module (see solarFinancing.ts). Never put PII or account numbers here.
  financing_ref text CHECK (financing_ref IS NULL OR char_length(financing_ref) <= 120),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  archived_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_solar_projects_user_status ON solar_projects (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_solar_projects_customer ON solar_projects (customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS solar_pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES solar_projects(id) ON DELETE CASCADE,
  stage_key text NOT NULL CHECK (stage_key IN ('design', 'permit', 'interconnection', 'inspection', 'pto')),
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'submitted', 'corrections_required', 'approved', 'rejected', 'skipped')),
  owner_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  due_date date,
  reference_number text CHECK (reference_number IS NULL OR char_length(reference_number) <= 80),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  started_at timestamptz,
  submitted_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, stage_key)
);

CREATE INDEX IF NOT EXISTS idx_solar_stages_user_due ON solar_pipeline_stages (user_id, due_date) WHERE status NOT IN ('approved', 'skipped');
CREATE INDEX IF NOT EXISTS idx_solar_stages_owner ON solar_pipeline_stages (owner_id) WHERE owner_id IS NOT NULL;

-- Append-only log of every stage / claim / project status move.
CREATE TABLE IF NOT EXISTS solar_workflow_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES solar_projects(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('stage', 'claim', 'project')),
  entity_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  actor uuid,
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_solar_events_user ON solar_workflow_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_solar_events_project ON solar_workflow_events (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_solar_events_entity ON solar_workflow_events (entity_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.solar_events_block_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'solar_workflow_events is append-only' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_solar_events_block_update ON solar_workflow_events;
CREATE TRIGGER trg_solar_events_block_update BEFORE UPDATE ON solar_workflow_events
  FOR EACH ROW EXECUTE FUNCTION public.solar_events_block_update();

-- ---- project guard ----
CREATE OR REPLACE FUNCTION public.solar_project_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'solar_project_invalid: owner cannot change' USING ERRCODE = '22023';
  END IF;
  IF NEW.customer_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id)
     AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND c.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'solar_project_invalid: customer not found' USING ERRCODE = '23514';
  END IF;
  IF NEW.install_project_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.install_project_id IS DISTINCT FROM OLD.install_project_id)
     AND NOT EXISTS (SELECT 1 FROM install_projects ip WHERE ip.id = NEW.install_project_id AND ip.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'solar_project_invalid: install project not found' USING ERRCODE = '23514';
  END IF;
  IF NEW.jurisdiction_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.jurisdiction_id IS DISTINCT FROM OLD.jurisdiction_id)
     AND NOT EXISTS (SELECT 1 FROM solar_jurisdiction_profiles jp WHERE jp.id = NEW.jurisdiction_id AND jp.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'solar_project_invalid: jurisdiction profile not found' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed'
     AND EXISTS (SELECT 1 FROM solar_pipeline_stages s WHERE s.project_id = NEW.id AND s.status NOT IN ('approved', 'skipped')) THEN
    RAISE EXCEPTION 'solar_project_incomplete: every pipeline stage must be approved or skipped before completing' USING ERRCODE = '23514';
  END IF;
  NEW.name := btrim(NEW.name);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_solar_project_guard ON solar_projects;
CREATE TRIGGER trg_solar_project_guard BEFORE INSERT OR UPDATE ON solar_projects
  FOR EACH ROW EXECUTE FUNCTION public.solar_project_guard();

-- Seeds the five stages and logs status changes.
CREATE OR REPLACE FUNCTION public.solar_project_after()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO solar_pipeline_stages (user_id, project_id, stage_key, position)
    SELECT NEW.user_id, NEW.id, t.k, t.ord::smallint
    FROM unnest(ARRAY['design', 'permit', 'interconnection', 'inspection', 'pto']) WITH ORDINALITY AS t(k, ord);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO solar_workflow_events (user_id, project_id, entity_type, entity_id, from_status, to_status, actor)
    VALUES (NEW.user_id, NEW.id, 'project', NEW.id, OLD.status, NEW.status, auth.uid());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_solar_project_after ON solar_projects;
CREATE TRIGGER trg_solar_project_after AFTER INSERT OR UPDATE ON solar_projects
  FOR EACH ROW EXECUTE FUNCTION public.solar_project_after();

-- ---- stage guard ----
CREATE OR REPLACE FUNCTION public.solar_stage_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_note text := NULLIF(btrim(COALESCE(current_setting('solar.note', true), '')), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'not_started' THEN
      RAISE EXCEPTION 'solar_stage_invalid: stages start as not_started' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.user_id <> OLD.user_id OR NEW.project_id <> OLD.project_id OR NEW.stage_key <> OLD.stage_key OR NEW.position <> OLD.position THEN
    RAISE EXCEPTION 'solar_stage_invalid: identity fields cannot change' USING ERRCODE = '22023';
  END IF;

  IF NEW.owner_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id)
     AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = NEW.owner_id AND tm.account_owner_id = NEW.user_id) THEN
    RAISE EXCEPTION 'solar_stage_invalid: owner is not on this team' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT public.solar_stage_transition_ok(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'solar_stage_invalid: % cannot move to %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'not_started' AND NEW.status = 'in_progress' AND EXISTS (
         SELECT 1 FROM unnest(public.solar_stage_deps(NEW.stage_key)) AS d(k)
         WHERE NOT EXISTS (
           SELECT 1 FROM solar_pipeline_stages s
           WHERE s.project_id = NEW.project_id AND s.stage_key = d.k AND s.status IN ('approved', 'skipped'))) THEN
      RAISE EXCEPTION 'solar_stage_blocked: earlier stages must be approved or skipped first' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IN ('skipped', 'rejected', 'corrections_required') AND char_length(COALESCE(v_note, '')) < 5 THEN
      RAISE EXCEPTION 'solar_stage_invalid: a reason of at least 5 characters is required' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'in_progress' THEN NEW.started_at := COALESCE(OLD.started_at, now()); END IF;
    IF NEW.status = 'submitted' THEN NEW.submitted_at := now(); END IF;
    NEW.decided_at := CASE WHEN NEW.status IN ('approved', 'rejected', 'corrections_required', 'skipped') THEN now() ELSE NULL END;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_solar_stage_guard ON solar_pipeline_stages;
CREATE TRIGGER trg_solar_stage_guard BEFORE INSERT OR UPDATE ON solar_pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION public.solar_stage_guard();

CREATE OR REPLACE FUNCTION public.solar_stage_after()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_note text := NULLIF(btrim(COALESCE(current_setting('solar.note', true), '')), '');
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO solar_workflow_events (user_id, project_id, entity_type, entity_id, from_status, to_status, actor, note)
    VALUES (NEW.user_id, NEW.project_id, 'stage', NEW.id, OLD.status, NEW.status, auth.uid(), left(v_note, 1000));
    IF NEW.status IN ('approved', 'rejected') THEN
      PERFORM public.log_audit_event(NEW.user_id, 'solar.stage.' || NEW.status, 'solar_pipeline_stages', NEW.id::text);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_solar_stage_after ON solar_pipeline_stages;
CREATE TRIGGER trg_solar_stage_after AFTER UPDATE ON solar_pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION public.solar_stage_after();

-- ---- RLS ----
ALTER TABLE solar_projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_solar_projects" ON solar_projects;
CREATE POLICY "select_solar_projects" ON solar_projects FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));
DROP POLICY IF EXISTS "insert_solar_projects" ON solar_projects;
CREATE POLICY "insert_solar_projects" ON solar_projects FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND public.solar_module_active(user_id) AND public.can_manage_solar());
DROP POLICY IF EXISTS "update_solar_projects" ON solar_projects;
CREATE POLICY "update_solar_projects" ON solar_projects FOR UPDATE TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND public.solar_module_active(user_id) AND public.can_manage_solar())
  WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND public.solar_module_active(user_id) AND public.can_manage_solar());

ALTER TABLE solar_pipeline_stages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_solar_stages" ON solar_pipeline_stages;
CREATE POLICY "select_solar_stages" ON solar_pipeline_stages FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));
DROP POLICY IF EXISTS "update_solar_stages" ON solar_pipeline_stages;
CREATE POLICY "update_solar_stages" ON solar_pipeline_stages FOR UPDATE TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND public.solar_module_active(user_id) AND public.can_manage_solar())
  WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND public.solar_module_active(user_id) AND public.can_manage_solar());
-- Stages are created by the project trigger; `status` moves only through solar_set_stage_status().
REVOKE INSERT, DELETE, UPDATE ON solar_pipeline_stages FROM anon, authenticated;
GRANT UPDATE (owner_id, due_date, reference_number, notes) ON solar_pipeline_stages TO authenticated;

ALTER TABLE solar_workflow_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_solar_events" ON solar_workflow_events;
CREATE POLICY "select_solar_events" ON solar_workflow_events FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));
REVOKE INSERT, UPDATE, DELETE ON solar_workflow_events FROM anon, authenticated;

-- ---- status RPC ----
CREATE OR REPLACE FUNCTION public.solar_set_stage_status(p_stage_id uuid, p_to text, p_note text DEFAULT NULL, p_reference text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  s solar_pipeline_stages%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_solar() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF NOT public.solar_module_active(v_owner) THEN
    RAISE EXCEPTION 'solar_module_not_available: the Solar pack is not enabled for this account' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM solar_pipeline_stages WHERE id = p_stage_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'solar_stage_not_found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('solar.note', COALESCE(left(btrim(p_note), 1000), ''), true);
  UPDATE solar_pipeline_stages
  SET status = p_to,
      reference_number = COALESCE(NULLIF(left(btrim(p_reference), 80), ''), reference_number)
  WHERE id = s.id;
  PERFORM set_config('solar.note', '', true);

  RETURN jsonb_build_object('id', s.id, 'project_id', s.project_id, 'stage_key', s.stage_key, 'from', s.status, 'to', p_to);
END;
$$;
REVOKE ALL ON FUNCTION public.solar_set_stage_status(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.solar_set_stage_status(uuid, text, text, text) TO authenticated;

-- =============================================================
-- 6. EQUIPMENT + WARRANTY REGISTRY
-- =============================================================

CREATE TABLE IF NOT EXISTS solar_equipment_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES solar_projects(id) ON DELETE CASCADE,
  -- Optional link to the general equipment register (kept independent; this table never edits `equipment`).
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  component_kind text NOT NULL CHECK (component_kind IN ('panel', 'inverter', 'battery', 'optimizer', 'meter', 'other')),
  make text CHECK (make IS NULL OR char_length(make) <= 80),
  model text CHECK (model IS NULL OR char_length(model) <= 80),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 5000),
  serials text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (cardinality(serials) <= 1000),
  installed_on date,
  warranty_start date,
  product_warranty_years smallint CHECK (product_warranty_years IS NULL OR product_warranty_years BETWEEN 1 AND 40),
  performance_warranty_years smallint CHECK (performance_warranty_years IS NULL OR performance_warranty_years BETWEEN 1 AND 50),
  product_warranty_expires_on date,
  performance_warranty_expires_on date,
  -- Manufacturer certificate / registration end date; wins over the computed product-warranty end.
  warranty_expires_override date,
  warranty_terms text CHECK (warranty_terms IS NULL OR char_length(warranty_terms) <= 1000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'replaced', 'removed')),
  replaced_by_id uuid REFERENCES solar_equipment_units(id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT solar_units_override_after_start CHECK (warranty_expires_override IS NULL OR warranty_start IS NULL OR warranty_expires_override >= warranty_start),
  CONSTRAINT solar_units_warranty_needs_start CHECK ((product_warranty_years IS NULL AND performance_warranty_years IS NULL) OR warranty_start IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_solar_units_project ON solar_equipment_units (project_id);
CREATE INDEX IF NOT EXISTS idx_solar_units_user_expiry ON solar_equipment_units (user_id, product_warranty_expires_on) WHERE archived_at IS NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_solar_units_serials ON solar_equipment_units USING gin (serials);

CREATE OR REPLACE FUNCTION public.solar_unit_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_serials text[];
  v_distinct integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.user_id <> OLD.user_id OR NEW.project_id <> OLD.project_id) THEN
    RAISE EXCEPTION 'solar_unit_invalid: owner and project cannot change' USING ERRCODE = '22023';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM solar_projects p WHERE p.id = NEW.project_id AND p.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'solar_unit_invalid: project not found' USING ERRCODE = '23514';
  END IF;
  IF NEW.equipment_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.equipment_id IS DISTINCT FROM OLD.equipment_id)
     AND NOT EXISTS (SELECT 1 FROM equipment e WHERE e.id = NEW.equipment_id AND e.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'solar_unit_invalid: equipment record not found' USING ERRCODE = '23514';
  END IF;
  IF NEW.replaced_by_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM solar_equipment_units u WHERE u.id = NEW.replaced_by_id AND u.user_id = NEW.user_id AND u.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'solar_unit_invalid: replacement unit not found' USING ERRCODE = '23514';
  END IF;

  -- Serials: trim, drop blanks, keep first-seen order, reject duplicates (case-insensitive) and over-long values.
  SELECT COALESCE(array_agg(t.s ORDER BY t.o), ARRAY[]::text[]) INTO v_serials
  FROM (SELECT btrim(x.s) AS s, min(x.o) AS o FROM unnest(NEW.serials) WITH ORDINALITY AS x(s, o) WHERE btrim(x.s) <> '' GROUP BY btrim(x.s)) t;
  NEW.serials := v_serials;
  IF EXISTS (SELECT 1 FROM unnest(NEW.serials) AS s WHERE char_length(s) > 64) THEN
    RAISE EXCEPTION 'solar_unit_invalid: a serial number is longer than 64 characters' USING ERRCODE = '23514';
  END IF;
  SELECT count(DISTINCT upper(s)) INTO v_distinct FROM unnest(NEW.serials) AS s;
  IF v_distinct <> cardinality(NEW.serials) THEN
    RAISE EXCEPTION 'solar_duplicate_serial: the same serial appears twice in this list' USING ERRCODE = '23505';
  END IF;
  IF cardinality(NEW.serials) > NEW.quantity THEN
    RAISE EXCEPTION 'solar_unit_invalid: more serial numbers (%) than the quantity (%)', cardinality(NEW.serials), NEW.quantity USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'active' AND NEW.archived_at IS NULL AND cardinality(NEW.serials) > 0 THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text || ':solar_serials', 0));
    IF EXISTS (
      SELECT 1 FROM solar_equipment_units u
      WHERE u.user_id = NEW.user_id AND u.id <> NEW.id AND u.status = 'active' AND u.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM unnest(u.serials) a JOIN unnest(NEW.serials) b ON upper(a) = upper(b))
    ) THEN
      RAISE EXCEPTION 'solar_duplicate_serial: a serial number is already registered on another active unit' USING ERRCODE = '23505';
    END IF;
  END IF;

  NEW.product_warranty_expires_on := public.solar_warranty_end(NEW.warranty_start, NEW.product_warranty_years);
  NEW.performance_warranty_expires_on := public.solar_warranty_end(NEW.warranty_start, NEW.performance_warranty_years);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_solar_unit_guard ON solar_equipment_units;
CREATE TRIGGER trg_solar_unit_guard BEFORE INSERT OR UPDATE ON solar_equipment_units
  FOR EACH ROW EXECUTE FUNCTION public.solar_unit_guard();

ALTER TABLE solar_equipment_units ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_solar_units" ON solar_equipment_units;
CREATE POLICY "select_solar_units" ON solar_equipment_units FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));
-- Technicians in the field record serials, so any team member may add / edit units while the module is active.
DROP POLICY IF EXISTS "insert_solar_units" ON solar_equipment_units;
CREATE POLICY "insert_solar_units" ON solar_equipment_units FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND public.solar_module_active(user_id));
DROP POLICY IF EXISTS "update_solar_units" ON solar_equipment_units;
CREATE POLICY "update_solar_units" ON solar_equipment_units FOR UPDATE TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND public.solar_module_active(user_id))
  WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND public.solar_module_active(user_id));
REVOKE DELETE ON solar_equipment_units FROM anon, authenticated;

-- Units whose product warranty ends within the window (RLS applies: SECURITY INVOKER).
CREATE OR REPLACE FUNCTION public.solar_expiring_warranties(p_within_days integer DEFAULT 90)
RETURNS TABLE (unit_id uuid, project_id uuid, component_kind text, make text, model text, quantity integer, expires_on date, days_left integer)
LANGUAGE sql
STABLE
AS $$
  SELECT u.id, u.project_id, u.component_kind, u.make, u.model, u.quantity,
         COALESCE(u.warranty_expires_override, u.product_warranty_expires_on) AS expires_on,
         (COALESCE(u.warranty_expires_override, u.product_warranty_expires_on) - current_date)::integer AS days_left
  FROM solar_equipment_units u
  WHERE u.user_id = (SELECT public.get_account_owner_id())
    AND u.archived_at IS NULL AND u.status = 'active'
    AND COALESCE(u.warranty_expires_override, u.product_warranty_expires_on) BETWEEN current_date AND current_date + GREATEST(0, LEAST(COALESCE(p_within_days, 90), 3650))
  ORDER BY expires_on, u.id
  LIMIT 500;
$$;
REVOKE ALL ON FUNCTION public.solar_expiring_warranties(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.solar_expiring_warranties(integer) TO authenticated;

-- =============================================================
-- 7. WARRANTY CLAIMS
-- =============================================================

CREATE TABLE IF NOT EXISTS solar_warranty_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES solar_projects(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES solar_equipment_units(id),
  serial text CHECK (serial IS NULL OR char_length(serial) <= 64),
  failure_date date NOT NULL,
  description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 5 AND 2000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'under_review', 'info_requested', 'approved', 'denied', 'resolved', 'closed', 'withdrawn')),
  resolution text CHECK (resolution IS NULL OR resolution IN ('repair', 'replace', 'credit', 'refund')),
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  -- Snapshot of coverage on the failure date (set by the guard from the unit's warranty data).
  warranty_state text NOT NULL DEFAULT 'unknown' CHECK (warranty_state IN ('in_warranty', 'expired', 'unknown')),
  coverage_expires_on date,
  goodwill boolean NOT NULL DEFAULT false,
  manufacturer_reference text CHECK (manufacturer_reference IS NULL OR char_length(manufacturer_reference) <= 80),
  owner_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
  due_date date,
  -- Optional link to the money-recovery workflow in the existing Warranty Recovery OS (no duplication of it).
  recovery_claim_id uuid REFERENCES warranty_claims(id) ON DELETE SET NULL,
  submitted_at timestamptz,
  decided_at timestamptz,
  closed_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_solar_claims_project ON solar_warranty_claims (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_solar_claims_unit ON solar_warranty_claims (unit_id);
CREATE INDEX IF NOT EXISTS idx_solar_claims_user_open ON solar_warranty_claims (user_id, due_date) WHERE status NOT IN ('closed', 'withdrawn');

CREATE OR REPLACE FUNCTION public.solar_claim_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_note text := NULLIF(btrim(COALESCE(current_setting('solar.note', true), '')), '');
  u solar_equipment_units%ROWTYPE;
  v_end date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'solar_claim_invalid: claims start as draft' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.user_id <> OLD.user_id OR NEW.project_id <> OLD.project_id OR NEW.unit_id <> OLD.unit_id THEN
    RAISE EXCEPTION 'solar_claim_invalid: identity fields cannot change' USING ERRCODE = '22023';
  END IF;

  IF NEW.failure_date > current_date + 1 THEN
    RAISE EXCEPTION 'solar_claim_invalid: failure date is in the future' USING ERRCODE = '23514';
  END IF;
  IF NEW.owner_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id)
     AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = NEW.owner_id AND tm.account_owner_id = NEW.user_id) THEN
    RAISE EXCEPTION 'solar_claim_invalid: owner is not on this team' USING ERRCODE = '23514';
  END IF;
  IF NEW.recovery_claim_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.recovery_claim_id IS DISTINCT FROM OLD.recovery_claim_id)
     AND NOT EXISTS (SELECT 1 FROM warranty_claims wc WHERE wc.id = NEW.recovery_claim_id AND wc.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'solar_claim_invalid: recovery claim not found' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO u FROM solar_equipment_units x WHERE x.id = NEW.unit_id AND x.user_id = NEW.user_id AND x.project_id = NEW.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'solar_claim_invalid: unit not found on this project' USING ERRCODE = '23514';
  END IF;
  IF NEW.serial IS NOT NULL AND cardinality(u.serials) > 0
     AND NOT EXISTS (SELECT 1 FROM unnest(u.serials) s WHERE upper(s) = upper(NEW.serial)) THEN
    RAISE EXCEPTION 'solar_claim_invalid: serial is not registered on this unit' USING ERRCODE = '23514';
  END IF;

  -- Coverage is re-evaluated while the claim is still editable, then frozen as the filed snapshot.
  IF TG_OP = 'INSERT' OR OLD.status IN ('draft', 'info_requested') THEN
    v_end := COALESCE(u.warranty_expires_override, u.product_warranty_expires_on);
    NEW.coverage_expires_on := v_end;
    NEW.warranty_state := CASE
      WHEN v_end IS NULL THEN 'unknown'
      WHEN u.warranty_start IS NOT NULL AND NEW.failure_date < u.warranty_start THEN 'unknown'
      WHEN NEW.failure_date <= v_end THEN 'in_warranty'
      ELSE 'expired'
    END;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT public.solar_claim_transition_ok(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'solar_claim_invalid: % cannot move to %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'draft' AND NEW.status = 'submitted' AND NOT NEW.goodwill THEN
      IF NEW.warranty_state = 'unknown' THEN
        RAISE EXCEPTION 'solar_claim_coverage_unknown: register the unit warranty terms, or mark the claim as goodwill' USING ERRCODE = '23514';
      ELSIF NEW.warranty_state = 'expired' THEN
        RAISE EXCEPTION 'solar_claim_coverage_expired: the warranty had expired on the failure date; mark as goodwill to submit anyway' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.status IN ('denied', 'withdrawn') AND char_length(COALESCE(v_note, '')) < 5 THEN
      RAISE EXCEPTION 'solar_claim_invalid: a reason of at least 5 characters is required' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'resolved' AND NEW.resolution IS NULL THEN
      RAISE EXCEPTION 'solar_claim_invalid: choose a resolution (repair, replace, credit or refund)' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'submitted' THEN NEW.submitted_at := COALESCE(OLD.submitted_at, now()); END IF;
    IF NEW.status IN ('approved', 'denied') THEN NEW.decided_at := now(); END IF;
    IF NEW.status IN ('closed', 'withdrawn') THEN NEW.closed_at := now(); END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_solar_claim_guard ON solar_warranty_claims;
CREATE TRIGGER trg_solar_claim_guard BEFORE INSERT OR UPDATE ON solar_warranty_claims
  FOR EACH ROW EXECUTE FUNCTION public.solar_claim_guard();

CREATE OR REPLACE FUNCTION public.solar_claim_after()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_note text := NULLIF(btrim(COALESCE(current_setting('solar.note', true), '')), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO solar_workflow_events (user_id, project_id, entity_type, entity_id, from_status, to_status, actor)
    VALUES (NEW.user_id, NEW.project_id, 'claim', NEW.id, NULL, NEW.status, auth.uid());
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO solar_workflow_events (user_id, project_id, entity_type, entity_id, from_status, to_status, actor, note)
    VALUES (NEW.user_id, NEW.project_id, 'claim', NEW.id, OLD.status, NEW.status, auth.uid(), left(v_note, 1000));
    IF NEW.status IN ('approved', 'denied', 'resolved') THEN
      PERFORM public.log_audit_event(NEW.user_id, 'solar.claim.' || NEW.status, 'solar_warranty_claims', NEW.id::text);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_solar_claim_after ON solar_warranty_claims;
CREATE TRIGGER trg_solar_claim_after AFTER INSERT OR UPDATE ON solar_warranty_claims
  FOR EACH ROW EXECUTE FUNCTION public.solar_claim_after();

ALTER TABLE solar_warranty_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_solar_claims" ON solar_warranty_claims;
CREATE POLICY "select_solar_claims" ON solar_warranty_claims FOR SELECT TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()));
DROP POLICY IF EXISTS "insert_solar_claims" ON solar_warranty_claims;
CREATE POLICY "insert_solar_claims" ON solar_warranty_claims FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND public.solar_module_active(user_id) AND status = 'draft');
DROP POLICY IF EXISTS "update_solar_claims" ON solar_warranty_claims;
CREATE POLICY "update_solar_claims" ON solar_warranty_claims FOR UPDATE TO authenticated
  USING (user_id = (SELECT public.get_account_owner_id()) AND public.solar_module_active(user_id) AND public.can_manage_solar())
  WITH CHECK (user_id = (SELECT public.get_account_owner_id()) AND public.solar_module_active(user_id) AND public.can_manage_solar());
-- `status` / `resolution` move only through solar_set_claim_status().
REVOKE DELETE, UPDATE ON solar_warranty_claims FROM anon, authenticated;
GRANT UPDATE (owner_id, due_date, description, serial, failure_date, goodwill, manufacturer_reference, resolution_note, recovery_claim_id) ON solar_warranty_claims TO authenticated;

CREATE OR REPLACE FUNCTION public.solar_set_claim_status(p_claim_id uuid, p_to text, p_note text DEFAULT NULL, p_resolution text DEFAULT NULL, p_reference text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  c solar_warranty_claims%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_manage_solar() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF NOT public.solar_module_active(v_owner) THEN
    RAISE EXCEPTION 'solar_module_not_available: the Solar pack is not enabled for this account' USING ERRCODE = '42501';
  END IF;
  IF p_resolution IS NOT NULL AND p_resolution NOT IN ('repair', 'replace', 'credit', 'refund') THEN
    RAISE EXCEPTION 'solar_claim_invalid: unknown resolution' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM solar_warranty_claims WHERE id = p_claim_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'solar_claim_not_found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('solar.note', COALESCE(left(btrim(p_note), 1000), ''), true);
  UPDATE solar_warranty_claims
  SET status = p_to,
      resolution = COALESCE(p_resolution, resolution),
      manufacturer_reference = COALESCE(NULLIF(left(btrim(p_reference), 80), ''), manufacturer_reference)
  WHERE id = c.id;
  PERFORM set_config('solar.note', '', true);

  RETURN jsonb_build_object('id', c.id, 'project_id', c.project_id, 'from', c.status, 'to', p_to);
END;
$$;
REVOKE ALL ON FUNCTION public.solar_set_claim_status(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.solar_set_claim_status(uuid, text, text, text, text) TO authenticated;

-- =============================================================
-- 8. updated_at for the config table is handled by its guard; nothing else to schedule here.
-- =============================================================
