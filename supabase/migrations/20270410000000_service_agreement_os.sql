/*
  # Service Agreement OS

  A 360° layer on top of the contract stack that ALREADY exists. Nothing is
  duplicated; every existing table keeps its job:

    commercial_contracts            -> the agreement header (term, value, SLA, penalty, renewal)
    contract_intelligence_profiles  -> structured terms (response times, coverage, labor/parts, escalation)
    contract_sla_breaches           -> breaches + penalties
    job_contract_coverage           -> per-job coverage verdict + SLA clock
    customer_sites / equipment      -> properties and assets
    warranty_claims                 -> manufacturer recovery (linked, not copied)
    job_profitability (view)        -> real job revenue/cost (used for agreement profitability)
    audit_log + log_audit_event()   -> audit trail (triggers below write to it)

  What is genuinely missing, and added here (all additive, IF NOT EXISTS):

    agreement_assets        which properties / equipment an agreement covers, and at what level
    agreement_services      per-service coverage: labor / parts / discount / per-visit cap
    agreement_entitlements  included visits & hours per period, overage rate
    agreement_pm_plans      preventive-maintenance schedule (frequency, next due, checklist)
    agreement_visits        consumption ledger (PM visits, included calls) - drives usage and PM due dates
    agreement_claims        claims against / recoveries for an agreement (links breaches + warranty claims)
    agreement_price_changes append-only pricing history (auto-captured when contract value changes)
    agreement_renewals      renewal pipeline (one open renewal per agreement)

  Security: every table is scoped by public.get_account_owner_id() (team members work on the
  owner's account). Child rows can only attach to a contract the caller owns
  (agreement_owns_contract), and assets/PM plans must belong to the contract's customer.
  Audit: every create/update/delete (and price/status/term changes on commercial_contracts)
  is written through the existing SECURITY DEFINER log_audit_event().
*/

-- ---------------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- True when the contract belongs to the caller's account. SECURITY DEFINER so the
-- check cannot be blinded by RLS on the contracts table itself.
CREATE OR REPLACE FUNCTION public.agreement_owns_contract(p_contract_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.commercial_contracts c
    WHERE c.id = p_contract_id AND c.user_id = public.get_account_owner_id()
  );
$$;
GRANT EXECUTE ON FUNCTION public.agreement_owns_contract(uuid) TO authenticated;

-- Generic audit trigger. TG_ARGV[0] = entity label, e.g. 'agreement_asset'.
-- Produces actions such as agreement_asset_created / _updated / _deleted.
CREATE OR REPLACE FUNCTION public.log_agreement_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  v_user uuid := (v_row ->> 'user_id')::uuid;
  v_verb text := CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END;
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
    RETURN NEW;
  END IF;
  PERFORM public.log_audit_event(v_user, TG_ARGV[0] || '_' || v_verb, TG_TABLE_NAME, v_row ->> 'id');
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. agreement_assets  (properties + equipment covered by an agreement)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreement_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  contract_id uuid NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
  site_id uuid REFERENCES customer_sites(id) ON DELETE CASCADE,
  equipment_id uuid REFERENCES equipment(id) ON DELETE CASCADE,
  coverage_level text NOT NULL DEFAULT 'full'
    CHECK (coverage_level IN ('full', 'labor_only', 'parts_only', 'inspection_only', 'excluded')),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agreement_assets_target CHECK (site_id IS NOT NULL OR equipment_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_assets_equipment
  ON agreement_assets(contract_id, equipment_id) WHERE equipment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_assets_site
  ON agreement_assets(contract_id, site_id) WHERE equipment_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_agreement_assets_user ON agreement_assets(user_id);
CREATE INDEX IF NOT EXISTS idx_agreement_assets_equipment ON agreement_assets(equipment_id) WHERE equipment_id IS NOT NULL;

-- Assets must belong to the contract's customer (blocks cross-customer / cross-tenant links).
CREATE OR REPLACE FUNCTION public.agreement_assets_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_customer uuid;
BEGIN
  SELECT customer_id INTO v_customer FROM commercial_contracts WHERE id = NEW.contract_id;
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'Link this agreement to a customer before adding covered assets.' USING ERRCODE = '23514';
  END IF;
  IF NEW.site_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM customer_sites s WHERE s.id = NEW.site_id AND s.customer_id = v_customer
  ) THEN
    RAISE EXCEPTION 'That property does not belong to the agreement''s customer.' USING ERRCODE = '23514';
  END IF;
  IF NEW.equipment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM equipment e WHERE e.id = NEW.equipment_id AND e.customer_id = v_customer
  ) THEN
    RAISE EXCEPTION 'That equipment does not belong to the agreement''s customer.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agreement_assets_validate ON agreement_assets;
CREATE TRIGGER trg_agreement_assets_validate
  BEFORE INSERT OR UPDATE OF contract_id, site_id, equipment_id ON agreement_assets
  FOR EACH ROW EXECUTE FUNCTION public.agreement_assets_validate();

-- ---------------------------------------------------------------------------
-- 2. agreement_services  (covered services, with labor / parts / discount)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreement_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  contract_id uuid NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
  service_type text NOT NULL CHECK (char_length(btrim(service_type)) BETWEEN 1 AND 120),
  coverage text NOT NULL DEFAULT 'included' CHECK (coverage IN ('included', 'discounted', 'excluded')),
  labor_covered boolean NOT NULL DEFAULT true,
  parts_covered boolean NOT NULL DEFAULT false,
  discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  per_visit_cap_cents integer CHECK (per_visit_cap_cents IS NULL OR per_visit_cap_cents >= 0),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_services_type
  ON agreement_services(contract_id, lower(btrim(service_type)));
CREATE INDEX IF NOT EXISTS idx_agreement_services_user ON agreement_services(user_id);

-- ---------------------------------------------------------------------------
-- 3. agreement_entitlements  (included visits / hours per period)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreement_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  contract_id uuid NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('pm_visit', 'service_call', 'emergency_call', 'labor_hours')),
  included_quantity numeric(8,2) NOT NULL CHECK (included_quantity >= 0),
  period text NOT NULL DEFAULT 'year' CHECK (period IN ('month', 'quarter', 'year', 'term')),
  overage_rate_cents integer CHECK (overage_rate_cents IS NULL OR overage_rate_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_agreement_entitlements_user ON agreement_entitlements(user_id);

-- ---------------------------------------------------------------------------
-- 4. agreement_pm_plans  (preventive-maintenance schedule)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreement_pm_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  contract_id uuid NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  site_id uuid REFERENCES customer_sites(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  equipment_type text CHECK (equipment_type IS NULL OR char_length(equipment_type) <= 120),
  frequency_months integer NOT NULL DEFAULT 12 CHECK (frequency_months BETWEEN 1 AND 60),
  checklist text[] NOT NULL DEFAULT '{}',
  estimated_minutes integer CHECK (estimated_minutes IS NULL OR estimated_minutes > 0),
  next_due_date date,
  last_completed_date date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreement_pm_plans_contract ON agreement_pm_plans(contract_id);
CREATE INDEX IF NOT EXISTS idx_agreement_pm_plans_due ON agreement_pm_plans(user_id, next_due_date) WHERE active;

CREATE OR REPLACE FUNCTION public.agreement_pm_plans_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_customer uuid;
BEGIN
  SELECT customer_id INTO v_customer FROM commercial_contracts WHERE id = NEW.contract_id;
  IF NEW.site_id IS NOT NULL AND (v_customer IS NULL OR NOT EXISTS (
    SELECT 1 FROM customer_sites s WHERE s.id = NEW.site_id AND s.customer_id = v_customer)) THEN
    RAISE EXCEPTION 'That property does not belong to the agreement''s customer.' USING ERRCODE = '23514';
  END IF;
  IF NEW.equipment_id IS NOT NULL AND (v_customer IS NULL OR NOT EXISTS (
    SELECT 1 FROM equipment e WHERE e.id = NEW.equipment_id AND e.customer_id = v_customer)) THEN
    RAISE EXCEPTION 'That equipment does not belong to the agreement''s customer.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agreement_pm_plans_validate ON agreement_pm_plans;
CREATE TRIGGER trg_agreement_pm_plans_validate
  BEFORE INSERT OR UPDATE OF contract_id, site_id, equipment_id ON agreement_pm_plans
  FOR EACH ROW EXECUTE FUNCTION public.agreement_pm_plans_validate();

-- ---------------------------------------------------------------------------
-- 5. agreement_visits  (consumption ledger; completing a PM visit advances the plan)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreement_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  contract_id uuid NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
  entitlement_kind text NOT NULL DEFAULT 'pm_visit'
    CHECK (entitlement_kind IN ('pm_visit', 'service_call', 'emergency_call', 'labor_hours')),
  pm_plan_id uuid REFERENCES agreement_pm_plans(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  visit_date date NOT NULL DEFAULT current_date,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'missed', 'cancelled')),
  quantity numeric(8,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  billable boolean NOT NULL DEFAULT false,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreement_visits_contract ON agreement_visits(contract_id, visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_agreement_visits_user ON agreement_visits(user_id);
CREATE INDEX IF NOT EXISTS idx_agreement_visits_plan ON agreement_visits(pm_plan_id) WHERE pm_plan_id IS NOT NULL;
-- A job can consume a given entitlement kind only once per agreement (no double counting).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_visits_job_kind
  ON agreement_visits(contract_id, job_id, entitlement_kind) WHERE job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.agreement_visits_before()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.pm_plan_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agreement_pm_plans p WHERE p.id = NEW.pm_plan_id AND p.contract_id = NEW.contract_id
  ) THEN
    RAISE EXCEPTION 'That PM plan belongs to a different agreement.' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'completed' THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());
  ELSE
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agreement_visits_before ON agreement_visits;
CREATE TRIGGER trg_agreement_visits_before
  BEFORE INSERT OR UPDATE ON agreement_visits
  FOR EACH ROW EXECUTE FUNCTION public.agreement_visits_before();

-- Completing a PM visit moves the plan forward: last_completed = visit date,
-- next_due = visit date + frequency. Never moves a plan backwards.
CREATE OR REPLACE FUNCTION public.agreement_visits_advance_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'completed' AND NEW.pm_plan_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
    UPDATE agreement_pm_plans p
    SET last_completed_date = NEW.visit_date,
        next_due_date = (NEW.visit_date + make_interval(months => p.frequency_months))::date
    WHERE p.id = NEW.pm_plan_id
      AND p.contract_id = NEW.contract_id
      AND (p.last_completed_date IS NULL OR p.last_completed_date <= NEW.visit_date);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agreement_visits_advance_plan ON agreement_visits;
CREATE TRIGGER trg_agreement_visits_advance_plan
  AFTER INSERT OR UPDATE OF status ON agreement_visits
  FOR EACH ROW EXECUTE FUNCTION public.agreement_visits_advance_plan();

-- ---------------------------------------------------------------------------
-- 6. agreement_claims  (claims against an agreement + recoveries)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreement_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  contract_id uuid NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  breach_id uuid REFERENCES contract_sla_breaches(id) ON DELETE SET NULL,
  warranty_claim_id uuid REFERENCES warranty_claims(id) ON DELETE SET NULL,
  claim_type text NOT NULL DEFAULT 'coverage_dispute'
    CHECK (claim_type IN ('coverage_dispute', 'sla_credit', 'parts_labor', 'warranty_recovery', 'other')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'under_review', 'approved', 'denied', 'settled', 'closed')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR char_length(description) <= 4000),
  claimed_cents integer CHECK (claimed_cents IS NULL OR claimed_cents >= 0),
  approved_cents integer CHECK (approved_cents IS NULL OR approved_cents >= 0),
  settled_cents integer CHECK (settled_cents IS NULL OR settled_cents >= 0),
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_notes text CHECK (resolution_notes IS NULL OR char_length(resolution_notes) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreement_claims_contract ON agreement_claims(contract_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_agreement_claims_open ON agreement_claims(user_id) WHERE status IN ('open', 'under_review');

CREATE OR REPLACE FUNCTION public.agreement_claims_before()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('denied', 'settled', 'closed') THEN
    NEW.resolved_at := COALESCE(NEW.resolved_at, now());
  ELSE
    NEW.resolved_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agreement_claims_before ON agreement_claims;
CREATE TRIGGER trg_agreement_claims_before
  BEFORE INSERT OR UPDATE ON agreement_claims
  FOR EACH ROW EXECUTE FUNCTION public.agreement_claims_before();

DROP TRIGGER IF EXISTS trigger_webhook_new_agreement_claim ON agreement_claims;
CREATE TRIGGER trigger_webhook_new_agreement_claim
  AFTER INSERT ON agreement_claims
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_customer_webhook('agreement_claim.created');

-- ---------------------------------------------------------------------------
-- 7. agreement_price_changes  (append-only pricing history)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreement_price_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  contract_id uuid NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'amendment'
    CHECK (kind IN ('initial', 'escalation', 'renewal', 'amendment', 'discount')),
  effective_date date NOT NULL DEFAULT current_date,
  previous_cents integer CHECK (previous_cents IS NULL OR previous_cents >= 0),
  new_cents integer NOT NULL CHECK (new_cents >= 0),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreement_price_changes_contract
  ON agreement_price_changes(contract_id, effective_date DESC, created_at DESC);

-- Auto-capture: any change to commercial_contracts.contract_value_cents (from ANY screen)
-- lands in the pricing history. If the app already recorded the same change in the
-- last minute (e.g. an escalation), no duplicate row is written.
CREATE OR REPLACE FUNCTION public.agreement_capture_price_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.contract_value_cents IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.contract_value_cents IS NOT DISTINCT FROM OLD.contract_value_cents THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM agreement_price_changes
    WHERE contract_id = NEW.id AND new_cents = NEW.contract_value_cents
      AND created_at > now() - interval '1 minute'
  ) THEN
    RETURN NEW;
  END IF;
  INSERT INTO agreement_price_changes (user_id, contract_id, kind, effective_date, previous_cents, new_cents, reason)
  VALUES (
    NEW.user_id, NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN 'initial' ELSE 'amendment' END,
    current_date,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.contract_value_cents END,
    NEW.contract_value_cents,
    CASE WHEN TG_OP = 'INSERT' THEN 'Agreement created' ELSE 'Contract value edited' END
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agreement_capture_price_insert ON commercial_contracts;
CREATE TRIGGER trg_agreement_capture_price_insert
  AFTER INSERT ON commercial_contracts
  FOR EACH ROW WHEN (NEW.contract_value_cents IS NOT NULL)
  EXECUTE FUNCTION public.agreement_capture_price_change();

DROP TRIGGER IF EXISTS trg_agreement_capture_price_update ON commercial_contracts;
CREATE TRIGGER trg_agreement_capture_price_update
  AFTER UPDATE OF contract_value_cents ON commercial_contracts
  FOR EACH ROW WHEN (NEW.contract_value_cents IS DISTINCT FROM OLD.contract_value_cents)
  EXECUTE FUNCTION public.agreement_capture_price_change();

-- ---------------------------------------------------------------------------
-- 8. agreement_renewals  (renewal pipeline; one open renewal per agreement)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreement_renewals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  contract_id uuid NOT NULL REFERENCES commercial_contracts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'quoted', 'accepted', 'declined', 'lapsed')),
  proposed_value_cents integer CHECK (proposed_value_cents IS NULL OR proposed_value_cents >= 0),
  proposed_start date,
  proposed_end date,
  proposed_changes text CHECK (proposed_changes IS NULL OR char_length(proposed_changes) <= 4000),
  quoted_at timestamptz,
  decided_at timestamptz,
  renewed_contract_id uuid REFERENCES commercial_contracts(id) ON DELETE SET NULL,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agreement_renewals_dates CHECK (proposed_end IS NULL OR proposed_start IS NULL OR proposed_end >= proposed_start)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_renewals_open
  ON agreement_renewals(contract_id) WHERE status IN ('pending', 'quoted');
CREATE INDEX IF NOT EXISTS idx_agreement_renewals_user ON agreement_renewals(user_id, status);

CREATE OR REPLACE FUNCTION public.agreement_renewals_before()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'quoted' THEN
    NEW.quoted_at := COALESCE(NEW.quoted_at, now());
  END IF;
  IF NEW.status IN ('accepted', 'declined', 'lapsed') THEN
    NEW.decided_at := COALESCE(NEW.decided_at, now());
  ELSE
    NEW.decided_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agreement_renewals_before ON agreement_renewals;
CREATE TRIGGER trg_agreement_renewals_before
  BEFORE INSERT OR UPDATE ON agreement_renewals
  FOR EACH ROW EXECUTE FUNCTION public.agreement_renewals_before();

-- ---------------------------------------------------------------------------
-- 9. RLS, updated_at and audit triggers (one loop keeps all tables identical)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  label text;
  tables text[] := ARRAY[
    'agreement_assets', 'agreement_services', 'agreement_entitlements', 'agreement_pm_plans',
    'agreement_visits', 'agreement_claims', 'agreement_price_changes', 'agreement_renewals'
  ];
  labels text[] := ARRAY[
    'agreement_asset', 'agreement_service', 'agreement_entitlement', 'agreement_pm_plan',
    'agreement_visit', 'agreement_claim', 'agreement_price_change', 'agreement_renewal'
  ];
  i int;
  append_only boolean;
BEGIN
  FOR i IN 1 .. array_length(tables, 1) LOOP
    t := tables[i];
    label := labels[i];
    append_only := (t = 'agreement_price_changes');

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'select_own_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id())',
      'select_own_' || t, t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'insert_own_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (user_id = public.get_account_owner_id() AND public.agreement_owns_contract(contract_id))',
      'insert_own_' || t, t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'update_own_' || t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'delete_own_' || t, t);
    IF NOT append_only THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (user_id = public.get_account_owner_id()) WITH CHECK (user_id = public.get_account_owner_id() AND public.agreement_owns_contract(contract_id))',
        'update_own_' || t, t);
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (user_id = public.get_account_owner_id())',
        'delete_own_' || t, t);

      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_touch_' || t, t);
      IF t <> 'agreement_visits' THEN
        EXECUTE format(
          'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
          'trg_touch_' || t, t);
      END IF;
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_audit_' || t, t);
    -- PM plans are advanced automatically by completed visits; audit only create/delete there
    -- (the visit itself is already audited) to keep the audit log free of system noise.
    IF t = 'agreement_pm_plans' THEN
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION public.log_agreement_audit(%L)',
        'trg_audit_' || t, t, label);
    ELSE
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION public.log_agreement_audit(%L)',
        'trg_audit_' || t, t, label);
    END IF;
  END LOOP;
END $$;

-- agreement_visits has no updated_at column; make sure a stray touch trigger never exists on it.
DROP TRIGGER IF EXISTS trg_touch_agreement_visits ON agreement_visits;

-- ---------------------------------------------------------------------------
-- 10. Audit the commercial terms that matter on the EXISTING commercial_contracts table
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_contract_commercial_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.log_audit_event(NEW.user_id, 'agreement_status_changed', 'commercial_contracts', NEW.id::text);
  END IF;
  IF NEW.contract_value_cents IS DISTINCT FROM OLD.contract_value_cents THEN
    PERFORM public.log_audit_event(NEW.user_id, 'agreement_pricing_changed', 'commercial_contracts', NEW.id::text);
  END IF;
  IF NEW.end_date IS DISTINCT FROM OLD.end_date OR NEW.auto_renew IS DISTINCT FROM OLD.auto_renew
     OR NEW.sla_response_minutes_standard IS DISTINCT FROM OLD.sla_response_minutes_standard
     OR NEW.sla_response_minutes_critical IS DISTINCT FROM OLD.sla_response_minutes_critical
     OR NEW.sla_resolution_hours IS DISTINCT FROM OLD.sla_resolution_hours
     OR NEW.penalty_percentage IS DISTINCT FROM OLD.penalty_percentage THEN
    PERFORM public.log_audit_event(NEW.user_id, 'agreement_terms_changed', 'commercial_contracts', NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_commercial_contract_terms ON commercial_contracts;
CREATE TRIGGER trg_audit_commercial_contract_terms
  AFTER UPDATE ON commercial_contracts
  FOR EACH ROW EXECUTE FUNCTION public.log_contract_commercial_change();
