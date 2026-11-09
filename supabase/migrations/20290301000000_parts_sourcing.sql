/*
  # Parts sourcing module (flag `parts_sourcing` + per-account entitlement, default OFF)

  Extends the existing job-parts-ordering system (20271020000000_job_parts_ordering.sql),
  truck stock (20261110000000_truck_stock_replenishment.sql) and AHRI matchups
  (20271215000000_hvac_sizing_matchups.sql). Nothing existing is dropped, renamed or rewritten.

  ## Adds
  1. parts_sourcing_entitlements   per-account module switch (written only by Vireek staff RPC)
  2. parts_sourcing_settings       truck-first, ETA buffer days, optional stricter PO approval threshold
  3. parts_margin_rules            markup / minimum-margin rules (default > category > brand > part)
  4. part_cross_references         equivalent / alternate / superseded_by parts (by part id or MPN)
  5. part_equipment_models         part <-> equipment make/model (+ optional AHRI ref) linkage
  6. parts_sourcing_idempotency    idempotent PO submission
  7. parts_sourcing_audit          append-only audit trail (rows written by triggers / RPCs only)
  8. RPCs  parts_sourcing_enabled · parts_sourcing_offers · parts_sourcing_submit_order
           parts_sourcing_decide_po · parts_sourcing_request_parts · parts_sourcing_job_eta
           parts_sourcing_spend · parts_sourcing_parts_for_equipment
           parts_sourcing_save_settings · staff_set_parts_sourcing_entitlement

  ## Design decisions
  - Money is integer minor units (cents) everywhere. Pricing / margin maths lives in
    src/lib/partsSourcing.ts (pure, unit-tested); SQL returns facts.
  - The approval threshold in parts_sourcing_settings can only TIGHTEN the existing
    replenishment_settings.po_approval_threshold_cents behaviour (a draft becomes
    pending_approval); it never auto-approves anything the existing logic parked.
  - Every RPC re-checks: authenticated, module ON for the caller's account, and role
    (inventory_can_manage) where money or approvals are involved.
  - parts_sourcing_audit has no FK to auth.users on purpose: an append-only table must not
    block account deletion through ON DELETE CASCADE.

  ## Rollback (data is additive; safe to leave in place)
    UPDATE feature_flags SET enabled = false WHERE key = 'parts_sourcing';   -- instant OFF
    -- full removal (loses margin rules, cross refs, audit):
    DROP FUNCTION IF EXISTS public.parts_sourcing_enabled(), public.parts_sourcing_offers(uuid, uuid),
      public.parts_sourcing_submit_order(text, uuid[], uuid, boolean, text),
      public.parts_sourcing_decide_po(uuid, text, text), public.parts_sourcing_request_parts(uuid, text),
      public.parts_sourcing_job_eta(uuid[]), public.parts_sourcing_spend(date, date),
      public.parts_sourcing_parts_for_equipment(uuid),
      public.parts_sourcing_save_settings(boolean, integer, integer),
      public.staff_set_parts_sourcing_entitlement(uuid, boolean), public._parts_sourcing_on(uuid),
      public._ps_audit(uuid, text, text, text, jsonb), public._ps_purge_idempotency();
    DROP TABLE IF EXISTS parts_sourcing_idempotency, parts_sourcing_audit, part_equipment_models,
      part_cross_references, parts_margin_rules, parts_sourcing_settings, parts_sourcing_entitlements;
    DELETE FROM feature_flags WHERE key = 'parts_sourcing';
*/

-- =============================================================
-- 0. PREFLIGHT
-- =============================================================
DO $$
BEGIN
  IF to_regclass('public.inventory_parts') IS NULL
     OR to_regclass('public.inventory_locations') IS NULL
     OR to_regclass('public.inventory_stock_levels') IS NULL
     OR to_regclass('public.inventory_vendors') IS NULL
     OR to_regclass('public.supplier_catalog_items') IS NULL
     OR to_regclass('public.purchase_orders') IS NULL
     OR to_regclass('public.purchase_order_lines') IS NULL
     OR to_regclass('public.purchase_order_line_jobs') IS NULL
     OR to_regclass('public.jobs') IS NULL
     OR to_regclass('public.equipment') IS NULL
     OR to_regclass('public.hvac_ahri_matchups') IS NULL
     OR to_regclass('public.feature_flags') IS NULL
     OR to_regclass('public.feature_flag_overrides') IS NULL THEN
    RAISE EXCEPTION 'parts_sourcing: prerequisite tables missing. Apply job_parts_ordering, truck_stock_replenishment, hvac_sizing_matchups and feature_flags migrations first.';
  END IF;
  IF to_regprocedure('public.inventory_can_manage()') IS NULL
     OR to_regprocedure('public.get_account_owner_id()') IS NULL
     OR to_regprocedure('public._job_parts_eta(uuid)') IS NULL
     OR to_regprocedure('public._job_parts_ready(uuid)') IS NULL
     OR to_regprocedure('public._notify_owner(uuid,text,text,text,text)') IS NULL
     OR to_regprocedure('public.create_parts_orders_from_cart(uuid[],uuid,boolean,text)') IS NULL
     OR to_regprocedure('public.is_vireek_staff(uuid)') IS NULL
     OR to_regprocedure('public.feature_flag_is_on(boolean,integer,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'parts_sourcing: required helper functions are missing.';
  END IF;
END $$;

-- =============================================================
-- 1. FLAG (OFF) + ENTITLEMENT
-- =============================================================
INSERT INTO feature_flags (key, name, description, enabled, rollout_pct)
VALUES ('parts_sourcing', 'Parts sourcing',
        'Supplier comparison, margin rules, PO approvals, delivery-vs-appointment warnings and supplier spend reporting.',
        false, 0)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS parts_sourcing_entitlements (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE parts_sourcing_entitlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON parts_sourcing_entitlements FROM anon, authenticated;
GRANT SELECT ON parts_sourcing_entitlements TO authenticated;
DROP POLICY IF EXISTS ps_entitlement_select ON parts_sourcing_entitlements;
CREATE POLICY ps_entitlement_select ON parts_sourcing_entitlements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());

CREATE OR REPLACE FUNCTION public._parts_sourcing_on(p_tenant uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE((
           SELECT public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, p_tenant, f.key)
             FROM feature_flags f
             LEFT JOIN feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p_tenant
            WHERE f.key = 'parts_sourcing'), false)
     AND COALESCE((SELECT e.enabled FROM parts_sourcing_entitlements e WHERE e.user_id = p_tenant), false);
$$;
-- Internal (takes an arbitrary tenant id): never callable by clients. RLS uses parts_sourcing_enabled().
REVOKE ALL ON FUNCTION public._parts_sourcing_on(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.parts_sourcing_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT CASE WHEN auth.uid() IS NULL OR public.get_account_owner_id() IS NULL THEN false
              ELSE public._parts_sourcing_on(public.get_account_owner_id()) END;
$$;


-- =============================================================
-- 2. SETTINGS, MARGIN RULES, CROSS REFERENCES, EQUIPMENT LINKS
-- =============================================================
CREATE TABLE IF NOT EXISTS parts_sourcing_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  truck_first boolean NOT NULL DEFAULT true,
  eta_buffer_days integer NOT NULL DEFAULT 0 CHECK (eta_buffer_days BETWEEN 0 AND 30),
  approval_threshold_cents integer CHECK (approval_threshold_cents IS NULL OR approval_threshold_cents >= 0),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parts_margin_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT public.get_account_owner_id(),
  scope text NOT NULL CHECK (scope IN ('default', 'category', 'brand', 'part')),
  scope_value text CHECK (scope_value IS NULL OR char_length(btrim(scope_value)) BETWEEN 1 AND 120),
  markup_bps integer NOT NULL CHECK (markup_bps BETWEEN 0 AND 100000),
  min_margin_bps integer NOT NULL DEFAULT 0 CHECK (min_margin_bps BETWEEN 0 AND 9500),
  round_to_cents integer NOT NULL DEFAULT 1 CHECK (round_to_cents BETWEEN 1 AND 10000),
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -1000 AND 1000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'default' AND scope_value IS NULL) OR (scope <> 'default' AND scope_value IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_parts_margin_rule_scope
  ON parts_margin_rules (user_id, scope, lower(COALESCE(scope_value, ''))) WHERE active;

CREATE TABLE IF NOT EXISTS part_cross_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT public.get_account_owner_id(),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  alt_part_id uuid REFERENCES inventory_parts(id) ON DELETE CASCADE,
  alt_mpn text CHECK (alt_mpn IS NULL OR char_length(btrim(alt_mpn)) BETWEEN 1 AND 80),
  relation text NOT NULL DEFAULT 'equivalent'
    CHECK (relation IN ('equivalent', 'alternate', 'supersedes', 'superseded_by')),
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (alt_part_id IS NOT NULL OR alt_mpn IS NOT NULL),
  CHECK (alt_part_id IS DISTINCT FROM part_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_part_xref_part
  ON part_cross_references (user_id, part_id, relation, alt_part_id) WHERE alt_part_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_part_xref_mpn
  ON part_cross_references (user_id, part_id, relation, lower(alt_mpn)) WHERE alt_part_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_part_xref_alt ON part_cross_references (user_id, alt_part_id) WHERE alt_part_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS part_equipment_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE DEFAULT public.get_account_owner_id(),
  part_id uuid NOT NULL REFERENCES inventory_parts(id) ON DELETE CASCADE,
  make text CHECK (make IS NULL OR char_length(btrim(make)) BETWEEN 1 AND 80),
  model text CHECK (model IS NULL OR char_length(btrim(model)) BETWEEN 1 AND 80),
  ahri_ref_number text CHECK (ahri_ref_number IS NULL OR ahri_ref_number ~ '^[A-Za-z0-9-]{1,20}$'),
  fit_note text CHECK (fit_note IS NULL OR char_length(fit_note) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  model_norm text GENERATED ALWAYS AS (lower(regexp_replace(COALESCE(model, ''), '[^A-Za-z0-9]', '', 'g'))) STORED,
  CHECK (model IS NOT NULL OR ahri_ref_number IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_part_equipment_model
  ON part_equipment_models (user_id, part_id, lower(COALESCE(make, '')), model_norm, COALESCE(ahri_ref_number, ''));
CREATE INDEX IF NOT EXISTS idx_part_equipment_model_lookup ON part_equipment_models (user_id, model_norm) WHERE model_norm <> '';
CREATE INDEX IF NOT EXISTS idx_part_equipment_ahri ON part_equipment_models (user_id, ahri_ref_number) WHERE ahri_ref_number IS NOT NULL;

-- Stamps the owner and blocks cross-tenant references (RLS only checks the row's own user_id).
CREATE OR REPLACE FUNCTION public.ps_stamp_and_validate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row jsonb := to_jsonb(NEW);
  v_alt uuid := NULLIF(v_row ->> 'alt_part_id', '')::uuid;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.user_id := COALESCE(public.get_account_owner_id(), NEW.user_id);
  END IF;
  IF TG_TABLE_NAME IN ('part_cross_references', 'part_equipment_models') THEN
    IF NOT EXISTS (SELECT 1 FROM inventory_parts p WHERE p.id = (v_row ->> 'part_id')::uuid AND p.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'Part not found' USING ERRCODE = '42501';
    END IF;
    IF v_alt IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inventory_parts p WHERE p.id = v_alt AND p.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'Alternate part not found' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.ps_stamp_and_validate() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ps_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql
AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

-- =============================================================
-- 3. IDEMPOTENCY + APPEND-ONLY AUDIT
-- =============================================================
CREATE TABLE IF NOT EXISTS parts_sourcing_idempotency (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  idem_key text NOT NULL CHECK (idem_key ~ '^[A-Za-z0-9_-]{16,80}$'),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_ps_idem_created ON parts_sourcing_idempotency (created_at);

CREATE TABLE IF NOT EXISTS parts_sourcing_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  actor_id uuid,
  action text NOT NULL CHECK (char_length(action) <= 80),
  target_table text,
  target_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ps_audit_user_created ON parts_sourcing_audit (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.ps_audit_immutable()
RETURNS trigger LANGUAGE plpgsql
AS $$ BEGIN RAISE EXCEPTION 'parts_sourcing_audit is append-only' USING ERRCODE = '42501'; END; $$;

DROP TRIGGER IF EXISTS trg_ps_audit_immutable ON parts_sourcing_audit;
CREATE TRIGGER trg_ps_audit_immutable BEFORE UPDATE OR DELETE ON parts_sourcing_audit
  FOR EACH ROW EXECUTE FUNCTION public.ps_audit_immutable();

CREATE OR REPLACE FUNCTION public._ps_audit(p_owner uuid, p_action text, p_table text, p_target text, p_details jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  INSERT INTO parts_sourcing_audit (user_id, actor_id, action, target_table, target_id, details)
  VALUES (p_owner, auth.uid(), left(p_action, 80), p_table, p_target, COALESCE(p_details, '{}'::jsonb));
$$;
REVOKE ALL ON FUNCTION public._ps_audit(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ps_audit_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
BEGIN
  PERFORM public._ps_audit(
    (v_row ->> 'user_id')::uuid,
    lower(TG_OP) || ':' || TG_TABLE_NAME,
    TG_TABLE_NAME,
    COALESCE(v_row ->> 'id', v_row ->> 'user_id'),
    CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object('before', to_jsonb(OLD), 'after', to_jsonb(NEW)) ELSE v_row END
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.ps_audit_row() FROM PUBLIC, anon, authenticated;

-- Triggers (idempotent)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['parts_margin_rules', 'part_cross_references', 'part_equipment_models', 'parts_sourcing_settings', 'parts_sourcing_entitlements'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_ps_audit_row ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_ps_audit_row AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION public.ps_audit_row()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['parts_margin_rules', 'part_cross_references', 'part_equipment_models'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_ps_stamp ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_ps_stamp BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.ps_stamp_and_validate()', t);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS trg_ps_margin_touch ON parts_margin_rules;
CREATE TRIGGER trg_ps_margin_touch BEFORE UPDATE ON parts_margin_rules
  FOR EACH ROW EXECUTE FUNCTION public.ps_touch_updated_at();

-- =============================================================
-- 4. RLS
-- =============================================================
ALTER TABLE parts_sourcing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE parts_margin_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE part_cross_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE part_equipment_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE parts_sourcing_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE parts_sourcing_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON parts_sourcing_settings, parts_margin_rules, part_cross_references, part_equipment_models,
  parts_sourcing_idempotency, parts_sourcing_audit FROM anon, authenticated;
GRANT SELECT ON parts_sourcing_settings, parts_sourcing_audit TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON parts_margin_rules, part_cross_references, part_equipment_models TO authenticated;

-- Margin rules and settings are commercially sensitive: managers only.
DROP POLICY IF EXISTS ps_settings_select ON parts_sourcing_settings;
CREATE POLICY ps_settings_select ON parts_sourcing_settings FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.inventory_can_manage());

DROP POLICY IF EXISTS ps_rules_all ON parts_margin_rules;
CREATE POLICY ps_rules_all ON parts_margin_rules FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.inventory_can_manage() AND public.parts_sourcing_enabled())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.inventory_can_manage() AND public.parts_sourcing_enabled());

DROP POLICY IF EXISTS ps_xref_select ON part_cross_references;
CREATE POLICY ps_xref_select ON part_cross_references FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.parts_sourcing_enabled());
DROP POLICY IF EXISTS ps_xref_write ON part_cross_references;
CREATE POLICY ps_xref_write ON part_cross_references FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.inventory_can_manage() AND public.parts_sourcing_enabled())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.inventory_can_manage() AND public.parts_sourcing_enabled());

DROP POLICY IF EXISTS ps_equip_select ON part_equipment_models;
CREATE POLICY ps_equip_select ON part_equipment_models FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.parts_sourcing_enabled());
DROP POLICY IF EXISTS ps_equip_write ON part_equipment_models;
CREATE POLICY ps_equip_write ON part_equipment_models FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.inventory_can_manage() AND public.parts_sourcing_enabled())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.inventory_can_manage() AND public.parts_sourcing_enabled());

DROP POLICY IF EXISTS ps_audit_select ON parts_sourcing_audit;
CREATE POLICY ps_audit_select ON parts_sourcing_audit FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.inventory_can_manage());
-- parts_sourcing_idempotency: no policies and no grants = reachable only through SECURITY DEFINER RPCs.

-- =============================================================
-- 5. SETTINGS RPC + STAFF ENTITLEMENT
-- =============================================================
CREATE OR REPLACE FUNCTION public.staff_set_parts_sourcing_entitlement(p_tenant uuid, p_enabled boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_tenant IS NULL THEN RAISE EXCEPTION 'Tenant is required'; END IF;
  INSERT INTO parts_sourcing_entitlements (user_id, enabled, updated_by, updated_at)
  VALUES (p_tenant, COALESCE(p_enabled, false), auth.uid(), now())
  ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = auth.uid(), updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.parts_sourcing_save_settings(
  p_truck_first boolean, p_eta_buffer_days integer, p_approval_threshold_cents integer
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public._parts_sourcing_on(v_owner) THEN RAISE EXCEPTION 'Parts sourcing is not enabled' USING ERRCODE = '42501'; END IF;
  IF NOT public.inventory_can_manage() THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF p_eta_buffer_days IS NULL OR p_eta_buffer_days < 0 OR p_eta_buffer_days > 30 THEN
    RAISE EXCEPTION 'ETA buffer must be between 0 and 30 days';
  END IF;
  IF p_approval_threshold_cents IS NOT NULL AND (p_approval_threshold_cents < 0 OR p_approval_threshold_cents > 1000000000) THEN
    RAISE EXCEPTION 'Approval threshold is out of range';
  END IF;
  INSERT INTO parts_sourcing_settings (user_id, truck_first, eta_buffer_days, approval_threshold_cents, updated_by, updated_at)
  VALUES (v_owner, COALESCE(p_truck_first, true), p_eta_buffer_days, p_approval_threshold_cents, auth.uid(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET truck_first = EXCLUDED.truck_first, eta_buffer_days = EXCLUDED.eta_buffer_days,
        approval_threshold_cents = EXCLUDED.approval_threshold_cents, updated_by = auth.uid(), updated_at = now();
END;
$$;

-- =============================================================
-- 6. COMPARISON FACTS (pricing / ranking happens in src/lib/partsSourcing.ts)
-- =============================================================
CREATE OR REPLACE FUNCTION public.parts_sourcing_offers(p_part_id uuid, p_job_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_part inventory_parts%ROWTYPE;
  v_job jobs%ROWTYPE;
  v_manage boolean;
  v_truck bigint := 0;
  v_branch bigint := 0;
  v_other bigint := 0;
  v_offers jsonb;
  v_rules jsonb := '[]'::jsonb;
  v_settings jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public._parts_sourcing_on(v_owner) THEN RAISE EXCEPTION 'Parts sourcing is not enabled' USING ERRCODE = '42501'; END IF;
  v_manage := public.inventory_can_manage();

  SELECT * INTO v_part FROM inventory_parts WHERE id = p_part_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Part not found'; END IF;
  IF p_job_id IS NOT NULL THEN
    SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND user_id = v_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'Job not found'; END IF;
  END IF;

  SELECT
    COALESCE(SUM(GREATEST(sl.quantity_on_hand - sl.quantity_reserved, 0)) FILTER (
      WHERE l.location_type = 'van' AND p_job_id IS NOT NULL AND v_job.assigned_technician_id IS NOT NULL
        AND l.assigned_technician_id = v_job.assigned_technician_id), 0),
    COALESCE(SUM(GREATEST(sl.quantity_on_hand - sl.quantity_reserved, 0)) FILTER (WHERE l.location_type = 'warehouse'), 0),
    COALESCE(SUM(GREATEST(sl.quantity_on_hand - sl.quantity_reserved, 0)) FILTER (
      WHERE l.location_type = 'van'
        AND (p_job_id IS NULL OR v_job.assigned_technician_id IS NULL OR l.assigned_technician_id IS DISTINCT FROM v_job.assigned_technician_id)), 0)
    INTO v_truck, v_branch, v_other
  FROM inventory_stock_levels sl
  JOIN inventory_locations l ON l.id = sl.location_id AND l.active AND l.user_id = v_owner
  WHERE sl.part_id = p_part_id;

  WITH rel AS (
    SELECT p_part_id AS part_id, NULL::text AS mpn_norm, 'exact'::text AS relation
    UNION ALL
    SELECT x.alt_part_id, NULL, x.relation FROM part_cross_references x
     WHERE x.user_id = v_owner AND x.part_id = p_part_id AND x.alt_part_id IS NOT NULL
       AND x.relation IN ('equivalent', 'alternate', 'superseded_by')
    UNION ALL
    SELECT x.part_id, NULL, 'equivalent' FROM part_cross_references x
     WHERE x.user_id = v_owner AND x.alt_part_id = p_part_id AND x.relation = 'equivalent'
    UNION ALL
    SELECT NULL, lower(regexp_replace(x.alt_mpn, '[^A-Za-z0-9]', '', 'g')), x.relation FROM part_cross_references x
     WHERE x.user_id = v_owner AND x.part_id = p_part_id AND x.alt_part_id IS NULL
       AND x.relation IN ('equivalent', 'alternate', 'superseded_by')
    UNION ALL
    SELECT NULL, lower(regexp_replace(v_part.part_number, '[^A-Za-z0-9]', '', 'g')), 'exact'
     WHERE v_part.part_number IS NOT NULL
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.unit_cost_cents, q.vendor_name, q.catalog_item_id), '[]'::jsonb)
    INTO v_offers
  FROM (
    SELECT ci.id AS catalog_item_id, ci.vendor_id, v.name AS vendor_name, ci.sku, ci.name, ci.brand, ci.category, ci.mpn,
           ci.unit_cost_cents, ci.list_price_cents, ci.min_order_qty, ci.pack_size,
           COALESCE(ci.lead_time_days, v.lead_time_days) AS lead_time_days,
           ci.stock_status, ci.part_id, m.relation, ci.last_imported_at
    FROM supplier_catalog_items ci
    JOIN inventory_vendors v ON v.id = ci.vendor_id AND v.active AND v.user_id = v_owner
    JOIN LATERAL (
      SELECT r.relation FROM rel r
       WHERE (r.part_id IS NOT NULL AND r.part_id = ci.part_id)
          OR (r.mpn_norm IS NOT NULL AND r.mpn_norm <> '' AND (r.mpn_norm = ci.mpn_norm OR r.mpn_norm = ci.sku_norm))
       ORDER BY CASE r.relation WHEN 'exact' THEN 0 WHEN 'equivalent' THEN 1 WHEN 'superseded_by' THEN 2 ELSE 3 END
       LIMIT 1
    ) m ON true
    WHERE ci.user_id = v_owner AND ci.active AND ci.stock_status <> 'discontinued'
    ORDER BY ci.unit_cost_cents, v.name, ci.id
    LIMIT 50
  ) q;

  IF v_manage THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', r.id, 'scope', r.scope, 'scope_value', r.scope_value, 'markup_bps', r.markup_bps,
             'min_margin_bps', r.min_margin_bps, 'round_to_cents', r.round_to_cents,
             'priority', r.priority, 'active', r.active)), '[]'::jsonb)
      INTO v_rules
      FROM parts_margin_rules r WHERE r.user_id = v_owner AND r.active;
  END IF;

  SELECT jsonb_build_object(
           'truck_first', COALESCE(s.truck_first, true),
           'eta_buffer_days', COALESCE(s.eta_buffer_days, 0),
           'approval_threshold_cents', s.approval_threshold_cents)
    INTO v_settings
    FROM (SELECT 1) d LEFT JOIN parts_sourcing_settings s ON s.user_id = v_owner;

  RETURN jsonb_build_object(
    'can_manage', v_manage,
    'part', jsonb_build_object('id', v_part.id, 'part_number', v_part.part_number, 'name', v_part.name,
                               'category', v_part.category, 'unit_cost_cents', v_part.unit_cost_cents),
    'stock', jsonb_build_object('truck', v_truck, 'branch', v_branch, 'other_trucks', v_other),
    'offers', v_offers,
    'rules', v_rules,
    'settings', v_settings,
    'job', CASE WHEN p_job_id IS NULL THEN NULL ELSE jsonb_build_object(
             'id', v_job.id, 'scheduled_datetime', v_job.scheduled_datetime,
             'assigned_technician_id', v_job.assigned_technician_id) END
  );
END;
$$;

-- =============================================================
-- 7. IDEMPOTENT SUBMISSION, APPROVAL, TECHNICIAN REQUEST
-- =============================================================
CREATE OR REPLACE FUNCTION public.parts_sourcing_submit_order(
  p_idempotency_key text,
  p_cart_ids uuid[] DEFAULT NULL,
  p_job_id uuid DEFAULT NULL,
  p_hold_jobs boolean DEFAULT false,
  p_notes text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_hash text;
  v_prev parts_sourcing_idempotency%ROWTYPE;
  v_result jsonb;
  v_orders jsonb;
  v_threshold integer;
  o record;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public._parts_sourcing_on(v_owner) THEN RAISE EXCEPTION 'Parts sourcing is not enabled' USING ERRCODE = '42501'; END IF;
  IF NOT public.inventory_can_manage() THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_-]{16,80}$' THEN
    RAISE EXCEPTION 'A valid idempotency key is required';
  END IF;

  v_hash := md5(
    COALESCE((SELECT string_agg(x::text, ',' ORDER BY x) FROM unnest(p_cart_ids) x), '') || '|' ||
    COALESCE(p_job_id::text, '') || '|' || COALESCE(p_hold_jobs, false)::text || '|' || COALESCE(btrim(p_notes), ''));

  -- Serialises concurrent submissions with the same key; released at commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text || ':' || p_idempotency_key, 0));

  SELECT * INTO v_prev FROM parts_sourcing_idempotency WHERE user_id = v_owner AND idem_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prev.request_hash <> v_hash THEN
      RAISE EXCEPTION 'This idempotency key was already used for a different order' USING ERRCODE = '22023';
    END IF;
    RETURN v_prev.result || jsonb_build_object('replayed', true);
  END IF;

  v_result := public.create_parts_orders_from_cart(p_cart_ids, p_job_id, COALESCE(p_hold_jobs, false), p_notes);

  -- Optional stricter threshold: can only move a draft to pending_approval.
  SELECT s.approval_threshold_cents INTO v_threshold FROM parts_sourcing_settings s WHERE s.user_id = v_owner;
  IF v_threshold IS NOT NULL THEN
    FOR o IN SELECT NULLIF(e ->> 'po_id', '')::uuid AS po_id
               FROM jsonb_array_elements(COALESCE(v_result -> 'orders', '[]'::jsonb)) e LOOP
      IF o.po_id IS NOT NULL THEN
        UPDATE purchase_orders SET status = 'pending_approval'
         WHERE id = o.po_id AND user_id = v_owner AND status = 'draft' AND total_cents > v_threshold;
      END IF;
    END LOOP;
  END IF;

  SELECT COALESCE(jsonb_agg(
           CASE WHEN po.id IS NULL THEN t.e ELSE t.e || jsonb_build_object('status', po.status) END ORDER BY t.n), '[]'::jsonb)
    INTO v_orders
    FROM jsonb_array_elements(COALESCE(v_result -> 'orders', '[]'::jsonb)) WITH ORDINALITY AS t(e, n)
    LEFT JOIN purchase_orders po ON po.id = NULLIF(t.e ->> 'po_id', '')::uuid AND po.user_id = v_owner;
  v_result := jsonb_set(v_result, '{orders}', v_orders);

  INSERT INTO parts_sourcing_idempotency (user_id, idem_key, request_hash, result)
  VALUES (v_owner, p_idempotency_key, v_hash, v_result);

  PERFORM public._ps_audit(v_owner, 'submit_order', 'purchase_orders', NULL,
    jsonb_build_object('job_id', p_job_id, 'idempotency_key', p_idempotency_key, 'orders', v_orders));

  RETURN v_result || jsonb_build_object('replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.parts_sourcing_decide_po(p_po_id uuid, p_decision text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_po purchase_orders%ROWTYPE;
  v_status text;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public._parts_sourcing_on(v_owner) THEN RAISE EXCEPTION 'Parts sourcing is not enabled' USING ERRCODE = '42501'; END IF;
  IF NOT public.inventory_can_manage() THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN RAISE EXCEPTION 'Decision must be approve or reject'; END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 500 THEN RAISE EXCEPTION 'Note is too long (max 500 characters)'; END IF;

  SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF v_po.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Only orders waiting for approval can be decided (current status: %)', v_po.status;
  END IF;

  v_status := CASE p_decision WHEN 'approve' THEN 'sent' ELSE 'cancelled' END;
  UPDATE purchase_orders
     SET status = v_status,
         sent_at = CASE WHEN v_status = 'sent' THEN COALESCE(sent_at, now()) ELSE sent_at END,
         notes = CASE WHEN v_status = 'cancelled' AND v_note IS NOT NULL
                      THEN left(COALESCE(notes || E'\n', '') || 'Rejected: ' || v_note, 2000) ELSE notes END
   WHERE id = p_po_id;

  PERFORM public._ps_audit(v_owner, 'po_' || p_decision, 'purchase_orders', p_po_id::text,
    jsonb_build_object('po_number', v_po.po_number, 'total_cents', v_po.total_cents, 'vendor_id', v_po.vendor_id, 'note', v_note));

  RETURN jsonb_build_object('po_id', p_po_id, 'status', v_status);
END;
$$;

-- Technicians cannot create orders (inventory_can_manage gate in the existing flow). They add to the
-- cart, then ask a manager; this records the request and notifies the owner. Rate-limited per job.
CREATE OR REPLACE FUNCTION public.parts_sourcing_request_parts(p_job_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_job jobs%ROWTYPE;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_lines integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public._parts_sourcing_on(v_owner) THEN RAISE EXCEPTION 'Parts sourcing is not enabled' USING ERRCODE = '42501'; END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 300 THEN RAISE EXCEPTION 'Note is too long (max 300 characters)'; END IF;
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found'; END IF;

  SELECT count(*) INTO v_lines FROM parts_order_cart WHERE user_id = v_owner AND job_id = p_job_id;
  IF v_lines = 0 THEN RAISE EXCEPTION 'Add parts to the job cart first'; END IF;

  IF EXISTS (SELECT 1 FROM parts_sourcing_audit a
              WHERE a.user_id = v_owner AND a.action = 'request_parts' AND a.target_id = p_job_id::text
                AND a.actor_id = auth.uid() AND a.created_at > now() - interval '10 minutes') THEN
    RETURN jsonb_build_object('job_id', p_job_id, 'status', 'already_requested');
  END IF;

  PERFORM public._ps_audit(v_owner, 'request_parts', 'jobs', p_job_id::text,
    jsonb_build_object('lines', v_lines, 'note', v_note));
  PERFORM public._notify_owner(v_owner, 'parts_request', 'Parts requested for a job',
    COALESCE(v_job.customer_name, 'A job') || ': ' || v_lines || ' line(s) waiting in the cart' ||
    COALESCE(' - ' || v_note, ''), '/dashboard/parts-sourcing');
  RETURN jsonb_build_object('job_id', p_job_id, 'status', 'requested', 'lines', v_lines);
END;
$$;

-- =============================================================
-- 8. DELIVERY vs APPOINTMENT (surfaced in dispatch)
-- =============================================================
CREATE OR REPLACE FUNCTION public.parts_sourcing_job_eta(p_job_ids uuid[])
RETURNS TABLE (job_id uuid, scheduled_datetime timestamptz, eta date, parts_ready boolean, buffer_days integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT j.id, j.scheduled_datetime, public._job_parts_eta(j.id), public._job_parts_ready(j.id),
         COALESCE((SELECT s.eta_buffer_days FROM parts_sourcing_settings s WHERE s.user_id = j.user_id), 0)
    FROM jobs j
   WHERE auth.uid() IS NOT NULL
     AND j.user_id = public.get_account_owner_id()
     AND public._parts_sourcing_on(j.user_id)
     AND j.id = ANY (p_job_ids[1:300])
     AND j.scheduled_datetime IS NOT NULL;
$$;

-- =============================================================
-- 9. SUPPLIER SPEND
-- =============================================================
CREATE OR REPLACE FUNCTION public.parts_sourcing_spend(p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public._parts_sourcing_on(v_owner) THEN RAISE EXCEPTION 'Parts sourcing is not enabled' USING ERRCODE = '42501'; END IF;
  IF NOT public.inventory_can_manage() THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 731 THEN
    RAISE EXCEPTION 'Choose a valid date range (max 2 years)';
  END IF;

  WITH s AS MATERIALIZED (
    SELECT p.id, p.vendor_id, COALESCE(v.name, p.vendor_name, 'Unknown supplier') AS vendor_name,
           p.total_cents::bigint AS total_cents, COALESCE(p.sent_at, p.created_at) AS spend_at,
           COALESCE((SELECT SUM(pol.quantity_received::bigint * pol.unit_cost_cents) FROM purchase_order_lines pol
                      WHERE pol.purchase_order_id = p.id), 0) AS received_cents,
           (p.status = 'received') AS is_received,
           (p.status = 'received' AND p.received_at IS NOT NULL
              AND p.received_at::date <= COALESCE(p.original_expected_at, p.expected_at)) AS on_time
      FROM purchase_orders p
      LEFT JOIN inventory_vendors v ON v.id = p.vendor_id
     WHERE p.user_id = v_owner
       AND p.status IN ('sent', 'partially_received', 'received')
       AND COALESCE(p.sent_at, p.created_at)::date BETWEEN p_from AND p_to
  ),
  bv AS (
    SELECT vendor_id, vendor_name, count(*) AS po_count, SUM(total_cents) AS committed_cents,
           SUM(received_cents) AS received_cents,
           count(*) FILTER (WHERE is_received) AS received_pos,
           count(*) FILTER (WHERE on_time) AS on_time_pos
      FROM s GROUP BY vendor_id, vendor_name
  ),
  bm AS (
    SELECT to_char(spend_at, 'YYYY-MM') AS month, count(*) AS po_count, SUM(total_cents) AS committed_cents
      FROM s GROUP BY 1
  )
  SELECT jsonb_build_object(
           'from', p_from, 'to', p_to,
           'totals', (SELECT jsonb_build_object('po_count', count(*), 'committed_cents', COALESCE(SUM(total_cents), 0),
                                                'received_cents', COALESCE(SUM(received_cents), 0)) FROM s),
           'by_vendor', COALESCE((SELECT jsonb_agg(to_jsonb(bv) ORDER BY bv.committed_cents DESC, bv.vendor_name) FROM bv), '[]'::jsonb),
           'by_month', COALESCE((SELECT jsonb_agg(to_jsonb(bm) ORDER BY bm.month) FROM bm), '[]'::jsonb))
    INTO v_result;
  RETURN v_result;
END;
$$;

-- =============================================================
-- 10. EQUIPMENT-MODEL LINKAGE (reuses equipment + hvac_ahri_matchups)
-- =============================================================
CREATE OR REPLACE FUNCTION public.parts_sourcing_parts_for_equipment(p_equipment_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_eq equipment%ROWTYPE;
  v_mn text;
  v_out jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000'; END IF;
  IF NOT public._parts_sourcing_on(v_owner) THEN RAISE EXCEPTION 'Parts sourcing is not enabled' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_eq FROM equipment WHERE id = p_equipment_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Equipment not found'; END IF;
  v_mn := lower(regexp_replace(COALESCE(v_eq.model, ''), '[^A-Za-z0-9]', '', 'g'));

  SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
           'part_id', p.id, 'part_number', p.part_number, 'name', p.name, 'category', p.category,
           'fit_note', pm.fit_note, 'ahri_ref_number', pm.ahri_ref_number)), '[]'::jsonb)
    INTO v_out
    FROM part_equipment_models pm
    JOIN inventory_parts p ON p.id = pm.part_id AND p.user_id = v_owner AND p.active
   WHERE pm.user_id = v_owner
     AND (
       (v_mn <> '' AND pm.model_norm = v_mn
         AND (pm.make IS NULL OR v_eq.make IS NULL OR lower(pm.make) = lower(v_eq.make)))
       OR (pm.ahri_ref_number IS NOT NULL AND v_mn <> '' AND pm.ahri_ref_number IN (
             SELECT a.ahri_ref_number FROM hvac_ahri_matchups a
              WHERE a.user_id = v_owner
                AND v_mn IN (lower(regexp_replace(COALESCE(a.outdoor_model, ''), '[^A-Za-z0-9]', '', 'g')),
                             lower(regexp_replace(COALESCE(a.indoor_model, ''), '[^A-Za-z0-9]', '', 'g')),
                             lower(regexp_replace(COALESCE(a.furnace_model, ''), '[^A-Za-z0-9]', '', 'g')))))
     );
  RETURN v_out;
END;
$$;

-- =============================================================
-- 11. HOUSEKEEPING + GRANTS
-- =============================================================
CREATE OR REPLACE FUNCTION public._ps_purge_idempotency()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE n integer;
BEGIN
  DELETE FROM parts_sourcing_idempotency WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public._ps_purge_idempotency() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.parts_sourcing_enabled() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.parts_sourcing_offers(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.parts_sourcing_submit_order(text, uuid[], uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.parts_sourcing_decide_po(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.parts_sourcing_request_parts(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.parts_sourcing_job_eta(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.parts_sourcing_spend(date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.parts_sourcing_parts_for_equipment(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.parts_sourcing_save_settings(boolean, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_set_parts_sourcing_entitlement(uuid, boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.parts_sourcing_enabled() TO authenticated;
GRANT EXECUTE ON FUNCTION public.parts_sourcing_offers(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.parts_sourcing_submit_order(text, uuid[], uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.parts_sourcing_decide_po(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.parts_sourcing_request_parts(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.parts_sourcing_job_eta(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.parts_sourcing_spend(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.parts_sourcing_parts_for_equipment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.parts_sourcing_save_settings(boolean, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_set_parts_sourcing_entitlement(uuid, boolean) TO authenticated;
