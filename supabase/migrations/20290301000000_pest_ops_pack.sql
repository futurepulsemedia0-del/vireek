/*
  # Pest Ops pack — service plans, callbacks/guarantee, notices, stock, region record rules

  ## Why
  The Pest Control trade pack (20271201000000_trade_packs.sql) already gives every tenant an
  append-only treatment ledger (EPA registration, quantity, target pests, areas, applicator licence
  snapshot), a product register, weekday routes and plan templates backed by Recurring Jobs.
  This migration adds only what was missing, as an OPT-IN module that is OFF by default:

    1. Module gate         feature flag `pest_pack` (default OFF) AND per-account entitlement `packs:pest`
    2. Service plans       pest_service_plans (+ append-only pest_plan_events); renew / cancel RPCs
    3. Callbacks           pest_callbacks + pest_classify_callback(): guarantee-window logic
    4. Notices             pest_visit_notices queue (pre-visit notice + customer report), worker RPCs
    5. Stock               pest_stock + append-only pest_stock_movements; usage deduction from the ledger
    6. Region record rules pest_region_profiles (tenant-chosen required fields)  -- REQUIRES COUNSEL

  ## Zero change while OFF
  - Nothing existing is altered except two additive triggers (ledger usage/void -> stock; agreement
    status -> plan status). Both return immediately unless the tenant is entitled AND has a plan /
    tracked product, so tenants without the module see identical behaviour.
  - Every new RPC calls pest_require_enabled() first; every new table is readable only by its owner
    account (get_account_owner_id()) and writable ONLY through those RPCs (no write policies).

  ## Safety model
  - Ledger deduction can never block a compliance record: the stock trigger swallows its own errors
    (RAISE WARNING) and stock may go negative (flagged for recount) rather than reject an application.
  - Movements and events are append-only (UPDATE blocked; only FK detach to NULL allowed).
  - Idempotency: movements UNIQUE(user_id, idempotency_key) ('usage:<ledger id>', 'void:<ledger id>');
    notices UNIQUE(user_id, idempotency_key); callbacks UNIQUE(callback_job_id); renewals guarded.
  - Customer contact (notice recipient) is cleared once a notice reaches a terminal state.
  - Auto-renewal is intentionally NOT automatic (renewal_due prompts staff). Auto-renewal and
    cancellation-right rules differ by jurisdiction -> REQUIRES COUNSEL.
  - Region record-keeping rules are the tenant's own choice, never asserted as legal fact -> REQUIRES COUNSEL.

  ## Depends on
  20270411000100_feature_flags (feature_flags, feature_flag_is_on), 20271201000000_trade_packs
  (trade_log_entries, trade_regulated_products, trade_pack_installs, can_manage_trade_packs),
  20270403000000_recurring_jobs (recurring_agreements, recurring_occurrences, cancel_recurring_agreement,
  set_updated_at), 20260831090000 (log_audit_event), is_vireek_staff(), get_account_owner_id().

  ## Run order
  Single file, idempotent (IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS). Safe to re-run.

  ## Enabling a tenant (staff, in this order)
    1. select public.staff_set_module_entitlement('<tenant profile id>', 'packs:pest', true, 'pilot');
    2. Staff UI -> Feature flags -> pest_pack -> add an "on" override for that tenant (or raise rollout).

  ## Scheduling (optional, run once)
    select cron.schedule('pest-plan-transitions-hourly', '17 * * * *', $$select public.pest_apply_plan_transitions()$$);
  A notice DELIVERY worker is NOT part of this migration (see pest_claim_due_notices / pest_mark_notice).

  -- rollback: DROP TRIGGER IF EXISTS trg_pest_stock_usage ON trade_log_entries; DROP TRIGGER IF EXISTS trg_pest_stock_void ON trade_log_entries; DROP TRIGGER IF EXISTS trg_pest_plan_sync ON recurring_agreements; then drop the pest_* tables and functions created here (no existing table was altered); UPDATE feature_flags SET enabled=false WHERE key='pest_pack'. Data in pest_* tables is lost on drop; export first.
*/

-- =============================================================
-- 0. FEATURE FLAG (default OFF, no rollout)
-- =============================================================

INSERT INTO feature_flags (key, name, description, enabled, rollout_pct)
VALUES ('pest_pack', 'Pest Ops pack', 'Plans, callbacks, notices, stock and region record rules for the Pest Control pack. Also needs the packs:pest entitlement.', false, 0)
ON CONFLICT (key) DO NOTHING;

-- =============================================================
-- 1. PER-ACCOUNT MODULE ENTITLEMENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS account_module_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  module_key text NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,30}:[a-z][a-z0-9_]{1,30}$'),
  enabled boolean NOT NULL DEFAULT false,
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  granted_by uuid DEFAULT auth.uid(),
  granted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, module_key)
);

ALTER TABLE account_module_entitlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_account_module_entitlements" ON account_module_entitlements;
CREATE POLICY "select_account_module_entitlements" ON account_module_entitlements FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() OR public.is_vireek_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON account_module_entitlements FROM anon, authenticated;

DROP TRIGGER IF EXISTS trg_account_module_entitlements_updated_at ON account_module_entitlements;
CREATE TRIGGER trg_account_module_entitlements_updated_at BEFORE UPDATE ON account_module_entitlements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.staff_set_module_entitlement(p_tenant uuid, p_key text, p_enabled boolean, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_vireek_staff(auth.uid()) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_key IS NULL OR p_key !~ '^[a-z][a-z0-9_]{1,30}:[a-z][a-z0-9_]{1,30}$' THEN
    RAISE EXCEPTION 'invalid_module_key' USING ERRCODE = '22023';
  END IF;
  IF p_enabled IS NULL OR NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_tenant) THEN
    RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO account_module_entitlements (user_id, module_key, enabled, note, granted_by)
  VALUES (p_tenant, p_key, p_enabled, NULLIF(btrim(COALESCE(p_note, '')), ''), auth.uid())
  ON CONFLICT (user_id, module_key) DO UPDATE
    SET enabled = EXCLUDED.enabled, note = EXCLUDED.note, granted_by = auth.uid();
  PERFORM public.log_audit_event(p_tenant, 'entitlement.' || CASE WHEN p_enabled THEN 'granted' ELSE 'revoked' END, 'account_module_entitlements', p_key);
END;
$$;

CREATE OR REPLACE FUNCTION public.has_module_entitlement(p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM account_module_entitlements e
    WHERE e.user_id = public.get_account_owner_id() AND e.module_key = p_key AND e.enabled
  );
$$;

-- Internal: entitlement AND flag for an explicit tenant (used by triggers / workers).
CREATE OR REPLACE FUNCTION public.pest_ops_enabled_for(p_owner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_owner IS NOT NULL
    AND EXISTS (SELECT 1 FROM account_module_entitlements e WHERE e.user_id = p_owner AND e.module_key = 'packs:pest' AND e.enabled)
    AND COALESCE((
      SELECT public.feature_flag_is_on(f.enabled, f.rollout_pct, o.state, p_owner, f.key)
      FROM feature_flags f
      LEFT JOIN feature_flag_overrides o ON o.flag_id = f.id AND o.tenant_id = p_owner
      WHERE f.key = 'pest_pack'
    ), false);
$$;

CREATE OR REPLACE FUNCTION public.pest_ops_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.pest_ops_enabled_for(public.get_account_owner_id());
$$;

CREATE OR REPLACE FUNCTION public.pest_require_enabled()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.pest_ops_enabled_for(v_owner) THEN
    RAISE EXCEPTION 'pest_ops_not_enabled' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;

CREATE OR REPLACE FUNCTION public.pest_require_manager()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pest_require_enabled();
BEGIN
  IF NOT public.can_manage_trade_packs() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  RETURN v_owner;
END;
$$;

-- Generic append-only guard. TG_ARGV[0] = comma list of columns that may be detached (set NULL by an FK).
CREATE OR REPLACE FUNCTION public.pest_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_cols text[] := string_to_array(COALESCE(TG_ARGV[0], ''), ',');
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
  c text;
BEGIN
  FOREACH c IN ARRAY v_cols LOOP
    IF c <> '' THEN
      IF (v_new -> c) IS DISTINCT FROM (v_old -> c) AND (v_new -> c) <> 'null'::jsonb THEN
        RAISE EXCEPTION 'pest_append_only: % cannot be changed', c USING ERRCODE = '55000';
      END IF;
      v_old := v_old - c;
      v_new := v_new - c;
    END IF;
  END LOOP;
  IF v_old <> v_new THEN
    RAISE EXCEPTION 'pest_append_only: records cannot be edited' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- =============================================================
-- 2. REGION RECORD RULES (tenant-chosen)  -- REQUIRES COUNSEL
-- =============================================================

CREATE OR REPLACE FUNCTION public.pest_record_fields()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY['application_date','application_time','site_address','customer_name','applicator_name','applicator_license',
               'product_name','epa_reg_number','quantity_applied','quantity_unit','target_pest','areas_treated',
               'application_method','dilution_rate','weather_conditions','customer_notified']::text[];
$$;

CREATE TABLE IF NOT EXISTS pest_region_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE DEFAULT public.get_account_owner_id(),
  region_code text NOT NULL CHECK (region_code ~ '^[A-Za-z]{2}(-[A-Za-z0-9]{1,3})?$'),
  required_fields text[] NOT NULL CHECK (cardinality(required_fields) BETWEEN 1 AND 16 AND required_fields <@ public.pest_record_fields()),
  retention_years integer NOT NULL CHECK (retention_years BETWEEN 1 AND 15),
  -- Set when an owner/admin confirmed the field list was reviewed against local rules. Cleared on every change.
  counsel_acknowledged_at timestamptz,
  counsel_acknowledged_by uuid,
  updated_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pest_region_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_pest_region_profiles" ON pest_region_profiles;
CREATE POLICY "select_pest_region_profiles" ON pest_region_profiles FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pest_region_profiles FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.pest_set_region_profile(p_region text, p_fields text[], p_retention integer, p_acknowledge boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pest_require_manager();
  v_fields text[];
  v_old pest_region_profiles%ROWTYPE;
  v_changed boolean := true;
  v_ack_at timestamptz;
  v_ack_by uuid;
BEGIN
  v_fields := ARRAY(SELECT DISTINCT f FROM unnest(COALESCE(p_fields, ARRAY[]::text[])) AS f ORDER BY f);
  IF cardinality(v_fields) = 0 OR NOT (v_fields <@ public.pest_record_fields()) THEN
    RAISE EXCEPTION 'invalid_fields: choose at least one known field' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_old FROM pest_region_profiles WHERE user_id = v_owner FOR UPDATE;
  IF FOUND THEN
    v_changed := v_old.region_code IS DISTINCT FROM upper(btrim(p_region))
      OR v_old.required_fields IS DISTINCT FROM v_fields
      OR v_old.retention_years IS DISTINCT FROM p_retention;
    v_ack_at := v_old.counsel_acknowledged_at;
    v_ack_by := v_old.counsel_acknowledged_by;
  END IF;
  IF p_acknowledge THEN
    v_ack_at := now();
    v_ack_by := auth.uid();
  ELSIF v_changed THEN
    v_ack_at := NULL;
    v_ack_by := NULL;
  END IF;

  INSERT INTO pest_region_profiles (user_id, region_code, required_fields, retention_years, counsel_acknowledged_at, counsel_acknowledged_by, updated_by)
  VALUES (v_owner, upper(btrim(p_region)), v_fields, p_retention, v_ack_at, v_ack_by, auth.uid())
  ON CONFLICT (user_id) DO UPDATE SET
    region_code = EXCLUDED.region_code,
    required_fields = EXCLUDED.required_fields,
    retention_years = EXCLUDED.retention_years,
    counsel_acknowledged_at = EXCLUDED.counsel_acknowledged_at,
    counsel_acknowledged_by = EXCLUDED.counsel_acknowledged_by,
    updated_by = auth.uid(),
    updated_at = now();

  PERFORM public.log_audit_event(v_owner, 'pest.region_profile.set', 'pest_region_profiles', upper(btrim(p_region)));
  RETURN jsonb_build_object('region_code', upper(btrim(p_region)), 'acknowledged', v_ack_at IS NOT NULL);
END;
$$;

-- =============================================================
-- 3. SERVICE PLANS
-- =============================================================

CREATE OR REPLACE FUNCTION public.pest_cadence_matches(p_cadence text, p_unit text, p_count integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_cadence
    WHEN 'monthly' THEN p_unit = 'month' AND p_count = 1
    WHEN 'bimonthly' THEN p_unit = 'month' AND p_count = 2
    WHEN 'quarterly' THEN p_unit = 'month' AND p_count = 3
    WHEN 'seasonal' THEN p_unit = 'month' AND p_count = 1
    WHEN 'annual' THEN p_unit = 'year' AND p_count = 1
    ELSE false
  END;
$$;

CREATE TABLE IF NOT EXISTS pest_service_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  agreement_id uuid UNIQUE REFERENCES recurring_agreements(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  cadence text NOT NULL CHECK (cadence IN ('monthly','bimonthly','quarterly','seasonal','annual')),
  season_from smallint CHECK (season_from IS NULL OR season_from BETWEEN 1 AND 12),
  season_to smallint CHECK (season_to IS NULL OR season_to BETWEEN 1 AND 12),
  term_start date NOT NULL,
  term_end date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','renewal_due','cancel_scheduled','cancelled','expired')),
  renewal_notice_days integer NOT NULL DEFAULT 30 CHECK (renewal_notice_days BETWEEN 1 AND 120),
  guarantee_days integer NOT NULL DEFAULT 30 CHECK (guarantee_days BETWEEN 0 AND 365),
  guarantee_same_target boolean NOT NULL DEFAULT true,
  guarantee_max_callbacks integer CHECK (guarantee_max_callbacks IS NULL OR guarantee_max_callbacks >= 0),
  cancel_requested_at timestamptz,
  cancel_effective_on date,
  cancel_reason text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 500),
  cancelled_by uuid,
  renewed_from_plan_id uuid REFERENCES pest_service_plans(id) ON DELETE SET NULL,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pest_plan_term_order CHECK (term_end >= term_start),
  CONSTRAINT pest_plan_season_pair CHECK ((season_from IS NULL) = (season_to IS NULL)),
  CONSTRAINT pest_plan_season_iff_seasonal CHECK ((cadence = 'seasonal') = (season_from IS NOT NULL)),
  CONSTRAINT pest_plan_cancel_info CHECK (status NOT IN ('cancel_scheduled','cancelled') OR (cancel_effective_on IS NOT NULL AND cancel_reason IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pest_plan_renewed_from ON pest_service_plans (renewed_from_plan_id) WHERE renewed_from_plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pest_plans_user_status ON pest_service_plans (user_id, status);
CREATE INDEX IF NOT EXISTS idx_pest_plans_due ON pest_service_plans (term_end) WHERE status IN ('active','renewal_due','cancel_scheduled');
CREATE INDEX IF NOT EXISTS idx_pest_plans_customer ON pest_service_plans (customer_id);

DROP TRIGGER IF EXISTS trg_pest_plans_updated_at ON pest_service_plans;
CREATE TRIGGER trg_pest_plans_updated_at BEFORE UPDATE ON pest_service_plans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS pest_plan_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL REFERENCES pest_service_plans(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('created','renewed','renewal_due','expired','paused','resumed','cancel_requested','cancelled')),
  actor uuid DEFAULT auth.uid(),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pest_plan_events_plan ON pest_plan_events (plan_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_pest_plan_events_append_only ON pest_plan_events;
CREATE TRIGGER trg_pest_plan_events_append_only BEFORE UPDATE ON pest_plan_events
  FOR EACH ROW EXECUTE FUNCTION public.pest_append_only_guard('');

ALTER TABLE pest_service_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE pest_plan_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_pest_plans" ON pest_service_plans;
CREATE POLICY "select_pest_plans" ON pest_service_plans FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_pest_plan_events" ON pest_plan_events;
CREATE POLICY "select_pest_plan_events" ON pest_plan_events FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pest_service_plans, pest_plan_events FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.pest_create_plan(
  p_agreement_id uuid,
  p_cadence text,
  p_season_from integer,
  p_season_to integer,
  p_term_start date,
  p_term_end date,
  p_renewal_notice_days integer DEFAULT 30,
  p_guarantee_days integer DEFAULT 30,
  p_guarantee_same_target boolean DEFAULT true,
  p_guarantee_max_callbacks integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pest_require_manager();
  a recurring_agreements%ROWTYPE;
  v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trade_pack_installs WHERE user_id = v_owner AND pack_key = 'pest_control' AND enabled) THEN
    RAISE EXCEPTION 'trade_pack_not_enabled: turn the Pest Control pack on first' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO a FROM recurring_agreements WHERE id = p_agreement_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agreement_not_found' USING ERRCODE = 'P0002'; END IF;
  IF a.status IN ('cancelled', 'completed') THEN RAISE EXCEPTION 'agreement_closed' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pest_service_plans WHERE agreement_id = a.id) THEN
    RAISE EXCEPTION 'plan_exists: this agreement already has a pest plan' USING ERRCODE = '23505';
  END IF;
  IF NOT public.pest_cadence_matches(p_cadence, a.interval_unit, a.interval_count) THEN
    RAISE EXCEPTION 'cadence_mismatch: the agreement interval does not match the % cadence', p_cadence USING ERRCODE = '22023';
  END IF;
  IF p_term_start IS NULL OR p_term_end IS NULL OR p_term_end < p_term_start OR p_term_start < a.start_date
     OR p_term_end > (p_term_start + interval '3 years')::date THEN
    RAISE EXCEPTION 'invalid_term: the term must start on/after the agreement start and last at most 3 years' USING ERRCODE = '22023';
  END IF;
  IF a.end_date IS NOT NULL AND p_term_end > a.end_date THEN
    RAISE EXCEPTION 'term_exceeds_agreement: the term ends after the agreement does' USING ERRCODE = '22023';
  END IF;

  INSERT INTO pest_service_plans (user_id, agreement_id, customer_id, cadence, season_from, season_to, term_start, term_end,
                                  renewal_notice_days, guarantee_days, guarantee_same_target, guarantee_max_callbacks)
  VALUES (v_owner, a.id, a.customer_id, p_cadence, p_season_from, p_season_to, p_term_start, p_term_end,
          COALESCE(p_renewal_notice_days, 30), COALESCE(p_guarantee_days, 30), COALESCE(p_guarantee_same_target, true), p_guarantee_max_callbacks)
  RETURNING id INTO v_id;

  -- Visits must stop at the end of the term unless the plan is renewed.
  IF a.end_date IS DISTINCT FROM p_term_end THEN
    UPDATE recurring_agreements SET end_date = p_term_end WHERE id = a.id;
  END IF;

  INSERT INTO pest_plan_events (user_id, plan_id, event_type, detail)
  VALUES (v_owner, v_id, 'created', jsonb_build_object('cadence', p_cadence, 'term_start', p_term_start, 'term_end', p_term_end));
  PERFORM public.log_audit_event(v_owner, 'pest.plan.created', 'pest_service_plans', v_id::text);
  RETURN jsonb_build_object('plan_id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.pest_renew_plan(p_plan_id uuid, p_new_start date, p_new_end date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pest_require_manager();
  p pest_service_plans%ROWTYPE;
  a recurring_agreements%ROWTYPE;
  v_new_plan uuid;
  v_new_agreement uuid;
BEGIN
  SELECT * INTO p FROM pest_service_plans WHERE id = p_plan_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002'; END IF;
  IF p.status NOT IN ('active', 'renewal_due', 'expired') THEN
    RAISE EXCEPTION 'plan_not_renewable: status is %', p.status USING ERRCODE = '55000';
  END IF;
  IF p_new_start IS NULL OR p_new_end IS NULL OR p_new_start <> p.term_end + 1
     OR p_new_end < p_new_start OR p_new_end > (p_new_start + interval '3 years')::date THEN
    RAISE EXCEPTION 'invalid_renewal_term: the new term must start the day after the current one ends' USING ERRCODE = '22023';
  END IF;
  IF p.agreement_id IS NULL THEN RAISE EXCEPTION 'agreement_not_found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO a FROM recurring_agreements WHERE id = p.agreement_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agreement_not_found' USING ERRCODE = 'P0002'; END IF;
  IF a.status = 'cancelled' THEN RAISE EXCEPTION 'agreement_closed' USING ERRCODE = '55000'; END IF;

  IF p.cadence = 'seasonal' THEN
    -- A new season is a new schedule anchor: new agreement + new plan, linked.
    IF EXISTS (SELECT 1 FROM pest_service_plans WHERE renewed_from_plan_id = p.id) THEN
      RAISE EXCEPTION 'already_renewed' USING ERRCODE = '23505';
    END IF;
    INSERT INTO recurring_agreements (user_id, customer_id, customer_name, customer_phone, customer_email, address, title, service_type, notes,
                                      interval_unit, interval_count, start_date, end_date, preferred_time, timezone, duration_minutes,
                                      preferred_technician_id, price_amount, auto_invoice, lead_time_days, status)
    VALUES (v_owner, a.customer_id, a.customer_name, a.customer_phone, a.customer_email, a.address, a.title, a.service_type, a.notes,
            a.interval_unit, a.interval_count, p_new_start, p_new_end, a.preferred_time, a.timezone, a.duration_minutes,
            a.preferred_technician_id, a.price_amount, a.auto_invoice, a.lead_time_days, 'active')
    RETURNING id INTO v_new_agreement;

    INSERT INTO pest_service_plans (user_id, agreement_id, customer_id, cadence, season_from, season_to, term_start, term_end,
                                    renewal_notice_days, guarantee_days, guarantee_same_target, guarantee_max_callbacks, renewed_from_plan_id)
    VALUES (v_owner, v_new_agreement, p.customer_id, p.cadence, p.season_from, p.season_to, p_new_start, p_new_end,
            p.renewal_notice_days, p.guarantee_days, p.guarantee_same_target, p.guarantee_max_callbacks, p.id)
    RETURNING id INTO v_new_plan;

    UPDATE pest_service_plans SET status = 'expired' WHERE id = p.id;
    INSERT INTO pest_plan_events (user_id, plan_id, event_type, detail)
    VALUES (v_owner, p.id, 'renewed', jsonb_build_object('next_plan_id', v_new_plan)),
           (v_owner, v_new_plan, 'created', jsonb_build_object('renewed_from', p.id, 'term_start', p_new_start, 'term_end', p_new_end));
  ELSE
    UPDATE recurring_agreements SET end_date = p_new_end, status = CASE WHEN status = 'completed' THEN 'active' ELSE status END WHERE id = a.id;
    UPDATE pest_service_plans SET term_end = p_new_end, status = CASE WHEN a.status = 'paused' THEN 'paused' ELSE 'active' END WHERE id = p.id;
    v_new_plan := p.id;
    v_new_agreement := a.id;
    INSERT INTO pest_plan_events (user_id, plan_id, event_type, detail)
    VALUES (v_owner, p.id, 'renewed', jsonb_build_object('term_start', p_new_start, 'term_end', p_new_end));
  END IF;

  PERFORM public.log_audit_event(v_owner, 'pest.plan.renewed', 'pest_service_plans', p.id::text);
  RETURN jsonb_build_object('plan_id', v_new_plan, 'agreement_id', v_new_agreement);
END;
$$;

CREATE OR REPLACE FUNCTION public.pest_cancel_plan(p_plan_id uuid, p_reason text, p_effective_on date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pest_require_manager();
  p pest_service_plans%ROWTYPE;
  a recurring_agreements%ROWTYPE;
  v_tz text := 'UTC';
  v_today date;
  v_eff date;
  v_cancelled integer := 0;
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF char_length(v_reason) < 3 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'reason_required: give a reason of 3-500 characters' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO p FROM pest_service_plans WHERE id = p_plan_id AND user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002'; END IF;
  IF p.status NOT IN ('active', 'paused', 'renewal_due', 'cancel_scheduled') THEN
    RAISE EXCEPTION 'plan_not_cancellable: status is %', p.status USING ERRCODE = '55000';
  END IF;
  IF p.agreement_id IS NOT NULL THEN
    SELECT * INTO a FROM recurring_agreements WHERE id = p.agreement_id AND user_id = v_owner FOR UPDATE;
    IF FOUND THEN v_tz := a.timezone; END IF;
  END IF;
  v_today := (now() AT TIME ZONE v_tz)::date;
  v_eff := COALESCE(p_effective_on, v_today);
  IF v_eff < v_today THEN RAISE EXCEPTION 'effective_date_in_past' USING ERRCODE = '22023'; END IF;
  IF v_eff > p.term_end THEN RAISE EXCEPTION 'effective_after_term: choose a date within the current term' USING ERRCODE = '22023'; END IF;

  IF v_eff = v_today THEN
    IF a.id IS NOT NULL AND a.status <> 'cancelled' THEN
      v_cancelled := COALESCE((public.cancel_recurring_agreement(a.id) ->> 'jobs_cancelled')::integer, 0);
    END IF;
    UPDATE pest_service_plans
       SET status = 'cancelled', cancel_requested_at = now(), cancel_effective_on = v_eff, cancel_reason = v_reason, cancelled_by = auth.uid()
     WHERE id = p.id;
    INSERT INTO pest_plan_events (user_id, plan_id, event_type, detail)
    VALUES (v_owner, p.id, 'cancelled', jsonb_build_object('effective_on', v_eff, 'jobs_cancelled', v_cancelled));
  ELSE
    IF a.id IS NOT NULL THEN
      WITH targets AS (
        SELECT o.id AS occ_id, o.job_id
        FROM recurring_occurrences o
        JOIN jobs j ON j.id = o.job_id
        WHERE o.agreement_id = a.id AND o.status = 'generated' AND o.occurrence_date > v_eff
          AND j.user_id = v_owner AND j.job_status = 'scheduled' AND j.scheduled_datetime > now()
      ), cancelled_jobs AS (
        UPDATE jobs SET job_status = 'cancelled' WHERE id IN (SELECT job_id FROM targets) RETURNING id
      )
      UPDATE recurring_occurrences SET status = 'skipped', skip_reason = 'Plan cancelled', invoice_state = 'not_applicable'
      WHERE id IN (SELECT occ_id FROM targets);
      GET DIAGNOSTICS v_cancelled = ROW_COUNT;
      UPDATE recurring_agreements SET end_date = GREATEST(LEAST(COALESCE(end_date, v_eff), v_eff), start_date) WHERE id = a.id;
    END IF;
    UPDATE pest_service_plans
       SET status = 'cancel_scheduled', cancel_requested_at = now(), cancel_effective_on = v_eff, cancel_reason = v_reason, cancelled_by = auth.uid()
     WHERE id = p.id;
    INSERT INTO pest_plan_events (user_id, plan_id, event_type, detail)
    VALUES (v_owner, p.id, 'cancel_requested', jsonb_build_object('effective_on', v_eff, 'jobs_cancelled', v_cancelled));
  END IF;

  PERFORM public.log_audit_event(v_owner, 'pest.plan.cancel', 'pest_service_plans', p.id::text);
  RETURN jsonb_build_object('status', CASE WHEN v_eff = v_today THEN 'cancelled' ELSE 'cancel_scheduled' END, 'effective_on', v_eff, 'jobs_cancelled', v_cancelled);
END;
$$;

-- Cron / service role: renewal prompts, expiry, effective-dated cancellations. Enabled tenants only.
CREATE OR REPLACE FUNCTION public.pest_apply_plan_transitions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_due integer := 0;
  v_expired integer := 0;
  v_cancelled integer := 0;
BEGIN
  FOR r IN
    SELECT p.id, p.user_id, p.status, p.term_end, p.renewal_notice_days, p.cancel_effective_on, p.agreement_id,
           (now() AT TIME ZONE COALESCE(a.timezone, 'UTC'))::date AS local_today
    FROM pest_service_plans p
    LEFT JOIN recurring_agreements a ON a.id = p.agreement_id
    WHERE p.status IN ('active', 'renewal_due', 'cancel_scheduled')
    FOR UPDATE OF p SKIP LOCKED
  LOOP
    CONTINUE WHEN NOT public.pest_ops_enabled_for(r.user_id);

    IF r.status = 'cancel_scheduled' AND r.cancel_effective_on < r.local_today THEN
      UPDATE pest_service_plans SET status = 'cancelled' WHERE id = r.id;
      IF r.agreement_id IS NOT NULL THEN
        UPDATE recurring_agreements SET status = 'cancelled' WHERE id = r.agreement_id AND status IN ('active', 'paused', 'completed');
      END IF;
      INSERT INTO pest_plan_events (user_id, plan_id, event_type, actor, detail)
      VALUES (r.user_id, r.id, 'cancelled', NULL, jsonb_build_object('effective_on', r.cancel_effective_on, 'by', 'scheduler'));
      v_cancelled := v_cancelled + 1;
    ELSIF r.status IN ('active', 'renewal_due') AND r.term_end < r.local_today THEN
      UPDATE pest_service_plans SET status = 'expired' WHERE id = r.id;
      INSERT INTO pest_plan_events (user_id, plan_id, event_type, actor, detail)
      VALUES (r.user_id, r.id, 'expired', NULL, jsonb_build_object('term_end', r.term_end));
      v_expired := v_expired + 1;
    ELSIF r.status = 'active' AND r.local_today >= r.term_end - r.renewal_notice_days THEN
      UPDATE pest_service_plans SET status = 'renewal_due' WHERE id = r.id;
      INSERT INTO pest_plan_events (user_id, plan_id, event_type, actor, detail)
      VALUES (r.user_id, r.id, 'renewal_due', NULL, jsonb_build_object('term_end', r.term_end));
      v_due := v_due + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('renewal_due', v_due, 'expired', v_expired, 'cancelled', v_cancelled);
END;
$$;

-- Keep the plan in step when its agreement is paused / resumed / cancelled / completed elsewhere.
CREATE OR REPLACE FUNCTION public.pest_plan_sync_from_agreement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p pest_service_plans%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pest_service_plans WHERE agreement_id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF NEW.status = 'paused' AND p.status IN ('active', 'renewal_due') THEN
    UPDATE pest_service_plans SET status = 'paused' WHERE id = p.id;
    INSERT INTO pest_plan_events (user_id, plan_id, event_type, detail) VALUES (p.user_id, p.id, 'paused', '{}'::jsonb);
  ELSIF NEW.status = 'active' AND p.status = 'paused' THEN
    UPDATE pest_service_plans SET status = 'active' WHERE id = p.id;
    INSERT INTO pest_plan_events (user_id, plan_id, event_type, detail) VALUES (p.user_id, p.id, 'resumed', '{}'::jsonb);
  ELSIF NEW.status = 'cancelled' AND p.status NOT IN ('cancelled', 'expired') THEN
    UPDATE pest_service_plans
       SET status = 'cancelled', cancel_effective_on = COALESCE(cancel_effective_on, CURRENT_DATE),
           cancel_reason = COALESCE(cancel_reason, 'Agreement cancelled outside the pest plan screen'), cancel_requested_at = COALESCE(cancel_requested_at, now())
     WHERE id = p.id;
    INSERT INTO pest_plan_events (user_id, plan_id, event_type, detail) VALUES (p.user_id, p.id, 'cancelled', jsonb_build_object('by', 'agreement'));
  ELSIF NEW.status = 'completed' AND p.status IN ('active', 'renewal_due') THEN
    UPDATE pest_service_plans SET status = 'expired' WHERE id = p.id;
    INSERT INTO pest_plan_events (user_id, plan_id, event_type, detail) VALUES (p.user_id, p.id, 'expired', jsonb_build_object('by', 'agreement'));
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_pest_plan_sync ON recurring_agreements;
CREATE TRIGGER trg_pest_plan_sync AFTER UPDATE OF status ON recurring_agreements
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.pest_plan_sync_from_agreement();

-- =============================================================
-- 4. CALLBACKS / GUARANTEE WINDOW
-- =============================================================

-- KEEP IN SYNC with assessCallback() in src/lib/tradePacks/pestOps/guarantee.ts.
CREATE OR REPLACE FUNCTION public.pest_classify_callback(
  p_service_date date, p_requested_on date, p_window_days integer, p_same_target boolean,
  p_max_callbacks integer, p_covered_count integer, p_original_targets text[], p_request_targets text[]
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_requested_on < p_service_date THEN RETURN 'out_of_window'; END IF;
  IF p_requested_on > p_service_date + GREATEST(COALESCE(p_window_days, 0), 0) THEN RETURN 'out_of_window'; END IF;
  IF p_same_target AND COALESCE(cardinality(p_original_targets), 0) > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM unnest(COALESCE(p_request_targets, ARRAY[]::text[])) r
      JOIN unnest(p_original_targets) o ON lower(btrim(r)) = lower(btrim(o))
    ) THEN
      RETURN 'target_mismatch';
    END IF;
  END IF;
  IF p_max_callbacks IS NOT NULL AND p_covered_count >= p_max_callbacks THEN RETURN 'callback_limit'; END IF;
  RETURN 'covered';
END;
$$;

CREATE TABLE IF NOT EXISTS pest_callbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  plan_id uuid REFERENCES pest_service_plans(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  original_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  callback_job_id uuid UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
  service_date date NOT NULL,
  requested_on date NOT NULL,
  window_days integer NOT NULL CHECK (window_days BETWEEN 0 AND 365),
  covered_until date NOT NULL,
  original_targets text[] NOT NULL DEFAULT ARRAY[]::text[],
  request_targets text[] NOT NULL DEFAULT ARRAY[]::text[],
  outcome text NOT NULL CHECK (outcome IN ('covered','out_of_window','target_mismatch','callback_limit','override')),
  billable boolean NOT NULL,
  override_reason text CHECK (override_reason IS NULL OR char_length(override_reason) BETWEEN 5 AND 500),
  reason text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pest_callback_override_reason CHECK ((outcome = 'override') = (override_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_pest_callbacks_original ON pest_callbacks (user_id, original_job_id);
CREATE INDEX IF NOT EXISTS idx_pest_callbacks_customer ON pest_callbacks (customer_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_pest_callbacks_append_only ON pest_callbacks;
CREATE TRIGGER trg_pest_callbacks_append_only BEFORE UPDATE ON pest_callbacks
  FOR EACH ROW EXECUTE FUNCTION public.pest_append_only_guard('original_job_id,callback_job_id,customer_id,plan_id');

ALTER TABLE pest_callbacks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_pest_callbacks" ON pest_callbacks;
CREATE POLICY "select_pest_callbacks" ON pest_callbacks FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pest_callbacks FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.pest_register_callback(
  p_original_job_id uuid,
  p_callback_job_id uuid,
  p_requested_on date,
  p_targets text[],
  p_timezone text DEFAULT 'UTC',
  p_override_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pest_require_enabled();
  v_orig record;
  v_cb record;
  v_plan pest_service_plans%ROWTYPE;
  v_existing pest_callbacks%ROWTYPE;
  v_perf timestamptz;
  v_service_date date;
  v_orig_targets text[];
  v_req_targets text[];
  v_window integer := 30;
  v_same boolean := true;
  v_max integer := NULL;
  v_count integer;
  v_outcome text;
  v_override text := NULLIF(btrim(COALESCE(p_override_reason, '')), '');
  v_until date;
  v_id uuid;
BEGIN
  IF v_override IS NOT NULL THEN
    PERFORM public.pest_require_manager();
    IF char_length(v_override) < 5 THEN RAISE EXCEPTION 'override_reason_required' USING ERRCODE = '22023'; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
    RAISE EXCEPTION 'invalid_timezone' USING ERRCODE = '22023';
  END IF;
  IF p_original_job_id IS NULL OR p_callback_job_id IS NULL OR p_original_job_id = p_callback_job_id THEN
    RAISE EXCEPTION 'invalid_jobs: choose two different jobs' USING ERRCODE = '22023';
  END IF;
  IF p_requested_on IS NULL OR p_requested_on > (now() AT TIME ZONE p_timezone)::date + 1 THEN
    RAISE EXCEPTION 'invalid_request_date' USING ERRCODE = '22007';
  END IF;
  v_req_targets := ARRAY(SELECT DISTINCT btrim(t) FROM unnest(COALESCE(p_targets, ARRAY[]::text[])) t WHERE btrim(t) <> '');
  IF cardinality(v_req_targets) = 0 OR cardinality(v_req_targets) > 12 THEN
    RAISE EXCEPTION 'targets_required: name 1-12 target pests' USING ERRCODE = '22023';
  END IF;

  SELECT id, customer_id INTO v_orig FROM jobs WHERE id = p_original_job_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_not_found' USING ERRCODE = '42501'; END IF;
  SELECT id, customer_id INTO v_cb FROM jobs WHERE id = p_callback_job_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_not_found' USING ERRCODE = '42501'; END IF;
  IF v_orig.customer_id IS NOT NULL AND v_cb.customer_id IS NOT NULL AND v_orig.customer_id <> v_cb.customer_id THEN
    RAISE EXCEPTION 'customer_mismatch: the jobs belong to different customers' USING ERRCODE = '22023';
  END IF;

  -- Idempotent: one registration per callback job.
  SELECT * INTO v_existing FROM pest_callbacks WHERE user_id = v_owner AND callback_job_id = p_callback_job_id;
  IF FOUND THEN
    RETURN jsonb_build_object('id', v_existing.id, 'outcome', v_existing.outcome, 'billable', v_existing.billable,
                              'covered_until', v_existing.covered_until, 'reason', v_existing.reason, 'existing', true);
  END IF;
  IF EXISTS (SELECT 1 FROM pest_callbacks WHERE user_id = v_owner AND callback_job_id = p_original_job_id) THEN
    RAISE EXCEPTION 'original_is_callback: a callback visit is not itself guaranteed' USING ERRCODE = '22023';
  END IF;

  SELECT min(performed_at) INTO v_perf FROM trade_log_entries
  WHERE user_id = v_owner AND pack_key = 'pest_control' AND job_id = p_original_job_id AND voided_at IS NULL
    AND entry_type IN ('treatment', 'chemical_application');
  IF v_perf IS NULL THEN
    RAISE EXCEPTION 'no_service_record: log the original treatment before registering a callback' USING ERRCODE = '22023';
  END IF;
  v_service_date := (v_perf AT TIME ZONE p_timezone)::date;

  SELECT COALESCE(array_agg(DISTINCT t), ARRAY[]::text[]) INTO v_orig_targets
  FROM trade_log_entries e,
       LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.data -> 'target_pests') = 'array' THEN e.data -> 'target_pests' ELSE '[]'::jsonb END) AS t
  WHERE e.user_id = v_owner AND e.pack_key = 'pest_control' AND e.job_id = p_original_job_id
    AND e.voided_at IS NULL AND e.entry_type = 'chemical_application';

  SELECT p.* INTO v_plan FROM pest_service_plans p
  JOIN recurring_occurrences o ON o.agreement_id = p.agreement_id
  WHERE o.job_id = p_original_job_id AND p.user_id = v_owner LIMIT 1;
  IF FOUND THEN
    v_window := v_plan.guarantee_days;
    v_same := v_plan.guarantee_same_target;
    v_max := v_plan.guarantee_max_callbacks;
  END IF;

  SELECT count(*) INTO v_count FROM pest_callbacks WHERE user_id = v_owner AND original_job_id = p_original_job_id AND outcome = 'covered';
  v_outcome := public.pest_classify_callback(v_service_date, p_requested_on, v_window, v_same, v_max, v_count, v_orig_targets, v_req_targets);
  v_until := v_service_date + v_window;
  IF v_outcome <> 'covered' AND v_override IS NOT NULL THEN v_outcome := 'override'; END IF;
  IF v_outcome = 'covered' THEN v_override := NULL; END IF;

  INSERT INTO pest_callbacks (user_id, plan_id, customer_id, original_job_id, callback_job_id, service_date, requested_on, window_days, covered_until,
                              original_targets, request_targets, outcome, billable, override_reason, reason)
  VALUES (v_owner, v_plan.id, COALESCE(v_orig.customer_id, v_cb.customer_id), p_original_job_id, p_callback_job_id, v_service_date, p_requested_on, v_window, v_until,
          v_orig_targets, v_req_targets, v_outcome, v_outcome NOT IN ('covered', 'override'), v_override,
          CASE v_outcome WHEN 'covered' THEN 'Covered by the guarantee through ' || v_until
                         WHEN 'override' THEN 'Manager override'
                         WHEN 'target_mismatch' THEN 'The pest is not one that service targeted'
                         WHEN 'callback_limit' THEN 'Included callbacks were used'
                         ELSE 'The guarantee ended on ' || v_until END)
  ON CONFLICT (callback_job_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT * INTO v_existing FROM pest_callbacks WHERE user_id = v_owner AND callback_job_id = p_callback_job_id;
    RETURN jsonb_build_object('id', v_existing.id, 'outcome', v_existing.outcome, 'billable', v_existing.billable,
                              'covered_until', v_existing.covered_until, 'reason', v_existing.reason, 'existing', true);
  END IF;
  PERFORM public.log_audit_event(v_owner, 'pest.callback.' || v_outcome, 'pest_callbacks', v_id::text);
  RETURN jsonb_build_object('id', v_id, 'outcome', v_outcome, 'billable', v_outcome NOT IN ('covered', 'override'),
                            'covered_until', v_until, 'days_remaining', v_until - p_requested_on, 'existing', false);
END;
$$;

-- =============================================================
-- 5. NOTICES (pre-visit notice + customer report queue)
-- =============================================================

CREATE TABLE IF NOT EXISTS pest_visit_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  plan_id uuid REFERENCES pest_service_plans(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('pre_visit','report')),
  channel text NOT NULL CHECK (channel IN ('email','sms')),
  send_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','cancelled','skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  provider_message_id text CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 200),
  -- Cleared once the notice reaches a terminal state (PII minimisation).
  recipient text CHECK (recipient IS NULL OR char_length(recipient) <= 200),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 5 AND 200),
  claimed_at timestamptz,
  sent_at timestamptz,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CONSTRAINT pest_notice_recipient_shape CHECK (
    recipient IS NULL
    OR (channel = 'email' AND recipient ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
    OR (channel = 'sms' AND recipient ~ '^\+?[0-9][0-9 ()\-]{5,18}$')
  ),
  CONSTRAINT pest_notice_pending_has_recipient CHECK (status NOT IN ('pending','sending') OR recipient IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_pest_notices_due ON pest_visit_notices (send_at) WHERE status IN ('pending','sending');
CREATE INDEX IF NOT EXISTS idx_pest_notices_job ON pest_visit_notices (job_id);

DROP TRIGGER IF EXISTS trg_pest_notices_updated_at ON pest_visit_notices;
CREATE TRIGGER trg_pest_notices_updated_at BEFORE UPDATE ON pest_visit_notices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE pest_visit_notices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_pest_notices" ON pest_visit_notices;
CREATE POLICY "select_pest_notices" ON pest_visit_notices FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pest_visit_notices FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.pest_notice_suppressed(p_owner uuid, p_channel text, p_recipient text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE p_channel
    WHEN 'email' THEN EXISTS (SELECT 1 FROM email_suppressions s WHERE s.user_id = p_owner AND s.email = lower(btrim(p_recipient)))
    ELSE EXISTS (SELECT 1 FROM dnc_suppressions d WHERE d.user_id = p_owner
                   AND regexp_replace(d.phone_number, '\D', '', 'g') = regexp_replace(p_recipient, '\D', '', 'g'))
  END;
$$;

CREATE OR REPLACE FUNCTION public.pest_queue_notice(
  p_job_id uuid, p_kind text, p_channel text, p_send_at timestamptz, p_recipient text, p_subject text, p_body text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pest_require_enabled();
  v_job record;
  v_key text;
  v_id uuid;
  v_existing record;
BEGIN
  IF p_kind NOT IN ('pre_visit', 'report') OR p_channel NOT IN ('email', 'sms') THEN
    RAISE EXCEPTION 'invalid_notice' USING ERRCODE = '22023';
  END IF;
  IF p_send_at IS NULL OR p_send_at > now() + interval '120 days' THEN
    RAISE EXCEPTION 'invalid_send_time' USING ERRCODE = '22007';
  END IF;
  SELECT id, customer_id INTO v_job FROM jobs WHERE id = p_job_id AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_not_found' USING ERRCODE = '42501'; END IF;
  IF public.pest_notice_suppressed(v_owner, p_channel, p_recipient) THEN
    RAISE EXCEPTION 'recipient_suppressed: this contact opted out' USING ERRCODE = '22023';
  END IF;

  v_key := 'notice:' || p_kind || ':' || p_job_id::text || ':' || p_channel;
  SELECT id, status INTO v_existing FROM pest_visit_notices WHERE user_id = v_owner AND idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('id', v_existing.id, 'status', v_existing.status, 'created', false);
  END IF;

  INSERT INTO pest_visit_notices (user_id, job_id, customer_id, kind, channel, send_at, recipient, subject, body, idempotency_key)
  VALUES (v_owner, p_job_id, v_job.customer_id, p_kind, p_channel, p_send_at, btrim(p_recipient), btrim(p_subject), p_body, v_key)
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id, status INTO v_existing FROM pest_visit_notices WHERE user_id = v_owner AND idempotency_key = v_key;
    RETURN jsonb_build_object('id', v_existing.id, 'status', v_existing.status, 'created', false);
  END IF;
  PERFORM public.log_audit_event(v_owner, 'pest.notice.queued', 'pest_visit_notices', v_id::text);
  RETURN jsonb_build_object('id', v_id, 'status', 'pending', 'created', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.pest_cancel_notice(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pest_require_enabled();
BEGIN
  UPDATE pest_visit_notices SET status = 'cancelled', recipient = NULL
   WHERE id = p_id AND user_id = v_owner AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'notice_not_cancellable' USING ERRCODE = '55000'; END IF;
END;
$$;

-- Worker (service_role only). Claims due notices of ENABLED tenants; suppressed contacts are skipped.
CREATE OR REPLACE FUNCTION public.pest_claim_due_notices(p_limit integer DEFAULT 20)
RETURNS TABLE (id uuid, user_id uuid, kind text, channel text, recipient text, subject text, body text, idempotency_key text, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Recover notices claimed by a worker that died.
  UPDATE pest_visit_notices n SET status = 'pending', claimed_at = NULL
   WHERE n.status = 'sending' AND n.claimed_at < now() - interval '15 minutes';

  UPDATE pest_visit_notices n SET status = 'skipped', recipient = NULL, last_error = 'recipient_suppressed'
   WHERE n.status = 'pending' AND n.send_at <= now()
     AND public.pest_notice_suppressed(n.user_id, n.channel, n.recipient);

  RETURN QUERY
  WITH due AS (
    SELECT n.id FROM pest_visit_notices n
    WHERE n.status = 'pending' AND n.send_at <= now() AND n.attempts < 5
      AND public.pest_ops_enabled_for(n.user_id)
    ORDER BY n.send_at
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE pest_visit_notices n
     SET status = 'sending', claimed_at = now(), attempts = n.attempts + 1
   FROM due
   WHERE n.id = due.id
  RETURNING n.id, n.user_id, n.kind, n.channel, n.recipient, n.subject, n.body, n.idempotency_key, n.attempts;
END;
$$;

CREATE OR REPLACE FUNCTION public.pest_mark_notice(p_id uuid, p_ok boolean, p_provider_id text DEFAULT NULL, p_error text DEFAULT NULL, p_retryable boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n pest_visit_notices%ROWTYPE;
BEGIN
  SELECT * INTO n FROM pest_visit_notices WHERE id = p_id AND status = 'sending' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_ok THEN
    UPDATE pest_visit_notices SET status = 'sent', sent_at = now(), provider_message_id = left(p_provider_id, 200), recipient = NULL, last_error = NULL WHERE id = n.id;
  ELSIF p_retryable AND n.attempts < 5 THEN
    -- Back-off 5, 15, 45, 135 minutes (mirrors retryDelayMinutes()).
    UPDATE pest_visit_notices
       SET status = 'pending', claimed_at = NULL, last_error = left(p_error, 500),
           send_at = now() + make_interval(mins => 5 * (3 ^ (n.attempts - 1))::integer)
     WHERE id = n.id;
  ELSE
    UPDATE pest_visit_notices SET status = 'failed', recipient = NULL, last_error = left(COALESCE(p_error, 'failed'), 500) WHERE id = n.id;
  END IF;
END;
$$;

-- =============================================================
-- 6. PRODUCT STOCK + USAGE DEDUCTION
-- =============================================================

-- KEEP IN SYNC with UNIT_TABLE / convertQuantity() in src/lib/tradePacks/pestOps/inventory.ts.
CREATE OR REPLACE FUNCTION public.pest_unit_family(p_unit text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_unit IN ('g','kg','oz','lb') THEN 'mass'
              WHEN p_unit IN ('ml','l','fl_oz','qt','gal') THEN 'volume'
              WHEN p_unit = 'each' THEN 'count' END;
$$;

CREATE OR REPLACE FUNCTION public.pest_unit_factor(p_unit text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE p_unit WHEN 'g' THEN 1 WHEN 'kg' THEN 1000 WHEN 'oz' THEN 28.349523125 WHEN 'lb' THEN 453.59237
                      WHEN 'ml' THEN 1 WHEN 'l' THEN 1000 WHEN 'fl_oz' THEN 29.5735295625 WHEN 'qt' THEN 946.352946
                      WHEN 'gal' THEN 3785.411784 WHEN 'each' THEN 1 END)::numeric;
$$;

CREATE OR REPLACE FUNCTION public.pest_convert_qty(p_qty numeric, p_from text, p_to text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN public.pest_unit_family(p_from) IS NULL OR public.pest_unit_family(p_from) IS DISTINCT FROM public.pest_unit_family(p_to)
              THEN NULL
              ELSE round(p_qty * public.pest_unit_factor(p_from) / public.pest_unit_factor(p_to), 4) END;
$$;

CREATE TABLE IF NOT EXISTS pest_stock (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  product_id uuid NOT NULL UNIQUE REFERENCES trade_regulated_products(id) ON DELETE CASCADE,
  unit text NOT NULL CHECK (unit IN ('oz','fl_oz','lb','gal','qt','g','kg','ml','l','each')),
  on_hand numeric(14,4) NOT NULL DEFAULT 0,
  reorder_point numeric(14,4) CHECK (reorder_point IS NULL OR reorder_point >= 0),
  tracking_started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pest_stock_user ON pest_stock (user_id);

CREATE TABLE IF NOT EXISTS pest_stock_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES trade_regulated_products(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('receipt','usage','adjustment','count','void_reversal')),
  delta numeric(14,4) NOT NULL,
  unit text NOT NULL,
  balance_after numeric(14,4) NOT NULL,
  ledger_entry_id uuid REFERENCES trade_log_entries(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 3 AND 200),
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_pest_movements_product ON pest_stock_movements (product_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_pest_movements_append_only ON pest_stock_movements;
CREATE TRIGGER trg_pest_movements_append_only BEFORE UPDATE ON pest_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.pest_append_only_guard('ledger_entry_id');
DROP TRIGGER IF EXISTS trg_pest_stock_updated_at ON pest_stock;
CREATE TRIGGER trg_pest_stock_updated_at BEFORE UPDATE ON pest_stock
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE pest_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE pest_stock_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_pest_stock" ON pest_stock;
CREATE POLICY "select_pest_stock" ON pest_stock FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
DROP POLICY IF EXISTS "select_pest_stock_movements" ON pest_stock_movements;
CREATE POLICY "select_pest_stock_movements" ON pest_stock_movements FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pest_stock, pest_stock_movements FROM anon, authenticated;

-- Internal: applies one movement atomically under a row lock; false = duplicate key or untracked product.
CREATE OR REPLACE FUNCTION public.pest_stock_apply(p_owner uuid, p_product uuid, p_kind text, p_delta numeric, p_key text, p_ledger uuid, p_note text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s pest_stock%ROWTYPE;
  v_new numeric;
  v_id bigint;
BEGIN
  SELECT * INTO s FROM pest_stock WHERE user_id = p_owner AND product_id = p_product FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  v_new := round(s.on_hand + p_delta, 4);
  INSERT INTO pest_stock_movements (user_id, product_id, kind, delta, unit, balance_after, ledger_entry_id, idempotency_key, note)
  VALUES (p_owner, p_product, p_kind, p_delta, s.unit, v_new, p_ledger, p_key, p_note)
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN false; END IF;
  UPDATE pest_stock SET on_hand = v_new WHERE id = s.id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.pest_stock_enable(p_product_id uuid, p_opening numeric, p_reorder numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pest_require_manager();
  v_prod record;
  v_id uuid;
BEGIN
  IF p_opening IS NULL OR p_opening < 0 OR p_opening > 100000000 THEN RAISE EXCEPTION 'invalid_quantity' USING ERRCODE = '22023'; END IF;
  SELECT id, unit INTO v_prod FROM trade_regulated_products WHERE id = p_product_id AND user_id = v_owner AND pack_key = 'pest_control';
  IF NOT FOUND THEN RAISE EXCEPTION 'product_not_found' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM pest_stock WHERE product_id = p_product_id) THEN
    RAISE EXCEPTION 'already_tracked' USING ERRCODE = '23505';
  END IF;
  INSERT INTO pest_stock (user_id, product_id, unit, on_hand, reorder_point) VALUES (v_owner, p_product_id, v_prod.unit, 0, p_reorder) RETURNING id INTO v_id;
  PERFORM public.pest_stock_apply(v_owner, p_product_id, 'count', round(p_opening, 4), 'open:' || p_product_id::text, NULL, 'Opening count');
  PERFORM public.log_audit_event(v_owner, 'pest.stock.enabled', 'pest_stock', v_id::text);
  RETURN jsonb_build_object('id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.pest_stock_adjust(p_product_id uuid, p_kind text, p_quantity numeric, p_unit text, p_idempotency_key text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pest_require_manager();
  s pest_stock%ROWTYPE;
  v_q numeric;
  v_delta numeric;
  v_applied boolean;
BEGIN
  IF p_kind NOT IN ('receipt', 'adjustment', 'count') THEN RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023'; END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) < 8 THEN RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023'; END IF;
  IF p_quantity IS NULL OR abs(p_quantity) > 100000000 OR (p_kind IN ('receipt', 'count') AND p_quantity < 0) OR (p_kind = 'receipt' AND p_quantity = 0) THEN
    RAISE EXCEPTION 'invalid_quantity' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO s FROM pest_stock WHERE user_id = v_owner AND product_id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stock_not_tracked' USING ERRCODE = 'P0002'; END IF;
  v_q := public.pest_convert_qty(p_quantity, p_unit, s.unit);
  IF v_q IS NULL THEN RAISE EXCEPTION 'unit_incompatible: % cannot be converted to %', p_unit, s.unit USING ERRCODE = '22023'; END IF;
  v_delta := CASE p_kind WHEN 'count' THEN round(v_q - s.on_hand, 4) ELSE v_q END;
  v_applied := public.pest_stock_apply(v_owner, p_product_id, p_kind, v_delta, 'manual:' || p_idempotency_key, NULL, left(p_note, 300));
  IF v_applied THEN PERFORM public.log_audit_event(v_owner, 'pest.stock.' || p_kind, 'pest_stock', s.id::text); END IF;
  RETURN jsonb_build_object('applied', v_applied);
END;
$$;

CREATE OR REPLACE FUNCTION public.pest_stock_set_reorder(p_product_id uuid, p_reorder numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pest_require_manager();
BEGIN
  IF p_reorder IS NOT NULL AND (p_reorder < 0 OR p_reorder > 100000000) THEN RAISE EXCEPTION 'invalid_quantity' USING ERRCODE = '22023'; END IF;
  UPDATE pest_stock SET reorder_point = p_reorder WHERE user_id = v_owner AND product_id = p_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'stock_not_tracked' USING ERRCODE = 'P0002'; END IF;
END;
$$;

-- Ledger -> stock. Never blocks the compliance record: errors become warnings.
CREATE OR REPLACE FUNCTION public.pest_stock_on_ledger_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s record;
  v_conv numeric;
BEGIN
  IF NEW.pack_key <> 'pest_control' OR NEW.entry_type <> 'chemical_application' OR NEW.product_id IS NULL THEN RETURN NULL; END IF;
  IF NOT public.pest_ops_enabled_for(NEW.user_id) THEN RETURN NULL; END IF;
  BEGIN
    SELECT unit INTO s FROM pest_stock WHERE user_id = NEW.user_id AND product_id = NEW.product_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_conv := public.pest_convert_qty((NEW.data ->> 'amount')::numeric, NEW.data ->> 'amount_unit', s.unit);
    IF v_conv IS NULL THEN
      PERFORM public.pest_stock_apply(NEW.user_id, NEW.product_id, 'usage', 0, 'usage:' || NEW.id::text, NEW.id,
                                      'unit_incompatible: ' || COALESCE(NEW.data ->> 'amount_unit', '?') || ' -> ' || s.unit);
    ELSE
      PERFORM public.pest_stock_apply(NEW.user_id, NEW.product_id, 'usage', -v_conv, 'usage:' || NEW.id::text, NEW.id, NULL);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pest_stock_usage_failed entry=% : %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_pest_stock_usage ON trade_log_entries;
CREATE TRIGGER trg_pest_stock_usage AFTER INSERT ON trade_log_entries
  FOR EACH ROW WHEN (NEW.pack_key = 'pest_control' AND NEW.entry_type = 'chemical_application')
  EXECUTE FUNCTION public.pest_stock_on_ledger_insert();

CREATE OR REPLACE FUNCTION public.pest_stock_on_ledger_void()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m record;
BEGIN
  BEGIN
    SELECT product_id, delta INTO m FROM pest_stock_movements WHERE user_id = NEW.user_id AND idempotency_key = 'usage:' || NEW.id::text;
    IF FOUND AND m.delta <> 0 THEN
      PERFORM public.pest_stock_apply(NEW.user_id, m.product_id, 'void_reversal', -m.delta, 'void:' || NEW.id::text, NEW.id, 'Entry voided');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pest_stock_void_failed entry=% : %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_pest_stock_void ON trade_log_entries;
CREATE TRIGGER trg_pest_stock_void AFTER UPDATE OF voided_at ON trade_log_entries
  FOR EACH ROW WHEN (OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL AND NEW.pack_key = 'pest_control' AND NEW.entry_type = 'chemical_application')
  EXECUTE FUNCTION public.pest_stock_on_ledger_void();

-- Backfills usage for entries logged since tracking began (e.g. a trigger warning). Idempotent.
CREATE OR REPLACE FUNCTION public.pest_stock_reconcile()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.pest_require_manager();
  e record;
  s record;
  v_conv numeric;
  v_applied integer := 0;
BEGIN
  FOR e IN
    SELECT t.id, t.product_id, t.data, t.voided_at, st.unit AS stock_unit
    FROM trade_log_entries t
    JOIN pest_stock st ON st.product_id = t.product_id AND st.user_id = t.user_id
    WHERE t.user_id = v_owner AND t.pack_key = 'pest_control' AND t.entry_type = 'chemical_application'
      AND t.created_at >= st.tracking_started_at
    ORDER BY t.created_at
  LOOP
    v_conv := public.pest_convert_qty((e.data ->> 'amount')::numeric, e.data ->> 'amount_unit', e.stock_unit);
    IF public.pest_stock_apply(v_owner, e.product_id, 'usage', COALESCE(-v_conv, 0), 'usage:' || e.id::text, e.id,
                               CASE WHEN v_conv IS NULL THEN 'unit_incompatible' END) THEN
      v_applied := v_applied + 1;
    END IF;
    IF e.voided_at IS NOT NULL AND v_conv IS NOT NULL THEN
      IF public.pest_stock_apply(v_owner, e.product_id, 'void_reversal', v_conv, 'void:' || e.id::text, e.id, 'Entry voided') THEN
        v_applied := v_applied + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('movements_added', v_applied);
END;
$$;

-- =============================================================
-- 7. GRANTS (least privilege)
-- =============================================================

REVOKE ALL ON FUNCTION public.staff_set_module_entitlement(uuid, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_set_module_entitlement(uuid, text, boolean, text) TO authenticated;

REVOKE ALL ON FUNCTION public.has_module_entitlement(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pest_ops_enabled() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_module_entitlement(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pest_ops_enabled() TO authenticated;

-- Internal helpers: not callable from the API.
REVOKE ALL ON FUNCTION public.pest_ops_enabled_for(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pest_require_enabled() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pest_require_manager() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pest_stock_apply(uuid, uuid, text, numeric, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pest_notice_suppressed(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pest_stock_on_ledger_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pest_stock_on_ledger_void() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pest_plan_sync_from_agreement() FROM PUBLIC, anon, authenticated;

-- Tenant RPCs (each re-checks module gate + permission inside).
REVOKE ALL ON FUNCTION public.pest_set_region_profile(text, text[], integer, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pest_create_plan(uuid, text, integer, integer, date, date, integer, integer, boolean, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pest_renew_plan(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pest_cancel_plan(uuid, text, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pest_register_callback(uuid, uuid, date, text[], text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pest_queue_notice(uuid, text, text, timestamptz, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pest_cancel_notice(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pest_stock_enable(uuid, numeric, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pest_stock_adjust(uuid, text, numeric, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pest_stock_set_reorder(uuid, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pest_stock_reconcile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pest_set_region_profile(text, text[], integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pest_create_plan(uuid, text, integer, integer, date, date, integer, integer, boolean, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pest_renew_plan(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pest_cancel_plan(uuid, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pest_register_callback(uuid, uuid, date, text[], text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pest_queue_notice(uuid, text, text, timestamptz, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pest_cancel_notice(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pest_stock_enable(uuid, numeric, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pest_stock_adjust(uuid, text, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pest_stock_set_reorder(uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pest_stock_reconcile() TO authenticated;

-- Cron / worker only.
REVOKE ALL ON FUNCTION public.pest_apply_plan_transitions() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pest_claim_due_notices(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pest_mark_notice(uuid, boolean, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pest_apply_plan_transitions() TO service_role;
GRANT EXECUTE ON FUNCTION public.pest_claim_due_notices(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.pest_mark_notice(uuid, boolean, text, text, boolean) TO service_role;
