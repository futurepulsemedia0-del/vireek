/*
  # Acquisition Integration Toolkit — /dashboard/acquisitions

  For operators and private-equity roll-ups that buy service businesses and fold them into one Vireek account.

  ## What this adds (purely additive — no existing table, column or policy is changed)
    acquisitions                  — one row per acquired business (Day 0 = close_date) + how its data is scoped
    acquisition_workstreams       — the 30/60/90-day integration plan (9 templated workstreams + custom ones)
    acquisition_workstream_deps   — dependencies between workstreams (cycle-proof, same acquisition only)
    acquisition_source_controls   — control totals typed in from the SELLER's system (counts + balances)
    acquisition_data_checks       — results of the automated import-vs-source checks (last 10 runs kept)
    acquisition_import_links      — which Import Wizard runs belong to which acquisition (reuses data_import_jobs)
    acquisition_baselines         — Day-One KPI baseline of the acquired business (manual or captured from live data)
    acquisition_synergies         — planned cost savings / revenue lift (annual run-rate + start month)
    acquisition_synergy_actuals   — realized amount per month, compared with plan

  ## How an acquired business is scoped (acquisitions.scope_kind)
    linked_account  the business runs on its OWN Vireek account, linked through Franchise (franchise_locations).
                    Metrics are read cross-tenant ONLY through SECURITY DEFINER functions that re-check
                    franchise_groups.owner_id = the caller's account (same technique as get_franchise_dashboard_stats).
    imported        the business's data was imported INTO this account with the Import Wizard. Its jobs/customers are
                    exactly the rows those linked import runs CREATED (data_import_row_effects), so a rolled-back
                    import disappears from the numbers automatically.
    external        nothing in Vireek yet — plan tracking and a manually entered baseline only.

  ## Security (same idiom as Locations / Regional Packs)
    - Every row carries user_id = ACCOUNT OWNER id (get_account_owner_id()), so owner + team share one tenant.
    - Read AND write: owner or a member with can_edit_business_profile (can_manage_acquisitions()).
      Purchase prices, margins and synergy plans are sensitive, so reading is gated as well.
    - Foreign ids (brand, location, team member, import run, franchise location) are ownership-checked in policies
      and again inside the RPCs. Internal helpers (acq_scope, acq_kpis_for, acq_actuals) are NOT callable by clients.

  ## Rules enforced in the database (the UI only mirrors them)
    - A workstream cannot start or finish while a dependency is still open (acq_dependency_open).
    - Dependencies must be inside one acquisition and can never form a cycle.
    - completed_at is stamped by the database; when every workstream is done/skipped the acquisition becomes
      'completed', and it re-opens if one is re-opened.
    - Creating an acquisition + its template is ONE atomic call: create_acquisition().

  ## Metric definitions (trailing 90 days, jobs dated by scheduled_datetime, falling back to created_at)
    revenue        paid invoices              margin     (revenue - job_cost_entries) / revenue, only on jobs that
    avg ticket     revenue / paid jobs                   have cost entries (coverage % is reported alongside)
    utilization    assigned jobs / (technicians x working days x target jobs per tech-day), capped at 100 — a
                   transparent job-count proxy; the target is editable per acquisition
    retention      customers served in the previous 90 days who were served again in the last 90 days
    Cancelled and no-show jobs are excluded everywhere.
*/

-- =============================================================
-- 0. PRE-FLIGHT — fail early with a readable message
-- =============================================================
DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'team_members', 'jobs', 'customers', 'job_cost_entries', 'business_brands',
                           'business_locations', 'franchise_groups', 'franchise_locations', 'data_import_jobs',
                           'data_import_row_effects'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN v_missing := v_missing || t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['get_account_owner_id', 'can_manage_business_locations', 'log_audit_event'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = t) THEN
      v_missing := v_missing || (t || '()');
    END IF;
  END LOOP;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Acquisition toolkit: missing prerequisite(s): %. Apply the earlier migrations first.', array_to_string(v_missing, ', ');
  END IF;
END $$;

-- =============================================================
-- 1. SMALL SHARED FUNCTIONS
-- =============================================================
CREATE OR REPLACE FUNCTION public.acq_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Same rule as Locations: owner, or a member with can_edit_business_profile. (plpgsql: no creation-time coupling.)
CREATE OR REPLACE FUNCTION public.can_manage_acquisitions()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN public.can_manage_business_locations();
END;
$$;
REVOKE ALL ON FUNCTION public.can_manage_acquisitions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_acquisitions() TO authenticated;

-- Never lets an audit problem block real work.
CREATE OR REPLACE FUNCTION public.acq_audit(p_owner uuid, p_action text, p_target text, p_meta jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.log_audit_event(p_owner, p_action, 'acquisitions', p_target, p_meta);
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.acq_audit(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 2. TABLES
-- =============================================================
CREATE TABLE IF NOT EXISTS public.acquisitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  legal_name text CHECK (legal_name IS NULL OR char_length(legal_name) <= 160),
  status text NOT NULL DEFAULT 'integrating' CHECK (status IN ('planned', 'integrating', 'completed', 'on_hold')),
  close_date date NOT NULL,
  scope_kind text NOT NULL DEFAULT 'imported' CHECK (scope_kind IN ('linked_account', 'imported', 'external')),
  franchise_location_id uuid REFERENCES public.franchise_locations(id) ON DELETE SET NULL,
  brand_id uuid REFERENCES public.business_brands(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.business_locations(id) ON DELETE SET NULL,
  purchase_price_cents bigint CHECK (purchase_price_cents IS NULL OR purchase_price_cents >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  target_jobs_per_tech_day numeric(4, 1) NOT NULL DEFAULT 4 CHECK (target_jobs_per_tech_day BETWEEN 0.5 AND 20),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_acquisitions_name ON public.acquisitions (user_id, lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS uq_acquisitions_franchise_location ON public.acquisitions (franchise_location_id) WHERE franchise_location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acquisitions_owner ON public.acquisitions (user_id, close_date DESC);

CREATE TABLE IF NOT EXISTS public.acquisition_workstreams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  acquisition_id uuid NOT NULL REFERENCES public.acquisitions(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'custom' CHECK (kind IN ('license_insurance', 'customer_comms', 'phone_porting', 'data_import',
    'tech_payroll_onboarding', 'accounting_tax', 'price_book', 'brand_transition', 'systems_cutover', 'custom')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR char_length(description) <= 600),
  phase text NOT NULL DEFAULT 'day_30' CHECK (phase IN ('day_30', 'day_60', 'day_90')),
  owner_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  owner_label text CHECK (owner_label IS NULL OR char_length(owner_label) <= 80),
  due_date date,
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'blocked', 'done', 'skipped')),
  sort_order integer NOT NULL DEFAULT 0,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_acq_workstream_kind ON public.acquisition_workstreams (acquisition_id, kind) WHERE kind <> 'custom';
CREATE INDEX IF NOT EXISTS idx_acq_workstreams_acq ON public.acquisition_workstreams (acquisition_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_acq_workstreams_open_due ON public.acquisition_workstreams (user_id, due_date) WHERE status NOT IN ('done', 'skipped');

CREATE TABLE IF NOT EXISTS public.acquisition_workstream_deps (
  workstream_id uuid NOT NULL REFERENCES public.acquisition_workstreams(id) ON DELETE CASCADE,
  depends_on_id uuid NOT NULL REFERENCES public.acquisition_workstreams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workstream_id, depends_on_id),
  CONSTRAINT acq_dep_not_self CHECK (workstream_id <> depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_acq_deps_depends_on ON public.acquisition_workstream_deps (depends_on_id);

CREATE TABLE IF NOT EXISTS public.acquisition_source_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  acquisition_id uuid NOT NULL REFERENCES public.acquisitions(id) ON DELETE CASCADE,
  metric_key text NOT NULL CHECK (metric_key IN ('customers_count', 'jobs_count', 'invoiced_cents', 'paid_cents', 'open_ar_cents')),
  source_value numeric(20, 2) NOT NULL CHECK (source_value >= 0),
  tolerance_pct numeric(5, 2) NOT NULL DEFAULT 0 CHECK (tolerance_pct BETWEEN 0 AND 50),
  source_label text CHECK (source_label IS NULL OR char_length(source_label) <= 120),
  as_of date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (acquisition_id, metric_key)
);

CREATE TABLE IF NOT EXISTS public.acquisition_data_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  acquisition_id uuid NOT NULL REFERENCES public.acquisitions(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  check_key text NOT NULL,
  label text NOT NULL,
  status text NOT NULL CHECK (status IN ('pass', 'warn', 'fail', 'skip')),
  source_value numeric,
  actual_value numeric,
  diff numeric,
  diff_pct numeric(10, 2),
  tolerance_pct numeric(5, 2),
  detail text,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_acq_checks_acq ON public.acquisition_data_checks (acquisition_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_acq_checks_run ON public.acquisition_data_checks (run_id);

CREATE TABLE IF NOT EXISTS public.acquisition_import_links (
  import_job_id uuid PRIMARY KEY REFERENCES public.data_import_jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  acquisition_id uuid NOT NULL REFERENCES public.acquisitions(id) ON DELETE CASCADE,
  linked_by uuid DEFAULT auth.uid(),
  linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_acq_import_links_acq ON public.acquisition_import_links (acquisition_id);

CREATE TABLE IF NOT EXISTS public.acquisition_baselines (
  acquisition_id uuid PRIMARY KEY REFERENCES public.acquisitions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  as_of date NOT NULL,
  source text NOT NULL CHECK (source IN ('manual', 'computed')),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object' AND pg_column_size(metrics) < 4096),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  captured_by uuid DEFAULT auth.uid(),
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.acquisition_synergies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  acquisition_id uuid NOT NULL REFERENCES public.acquisitions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('cost_savings', 'revenue_lift')),
  category text NOT NULL DEFAULT 'other' CHECK (category IN ('procurement', 'insurance', 'software', 'facilities', 'headcount',
    'fleet', 'pricing', 'cross_sell', 'retention', 'other')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  plan_annual_cents bigint NOT NULL CHECK (plan_annual_cents >= 0 AND plan_annual_cents <= 100000000000),
  start_date date NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'realized', 'at_risk', 'dropped')),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_acq_synergies_acq ON public.acquisition_synergies (acquisition_id);

CREATE TABLE IF NOT EXISTS public.acquisition_synergy_actuals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id(),
  synergy_id uuid NOT NULL REFERENCES public.acquisition_synergies(id) ON DELETE CASCADE,
  period_month date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
  actual_cents bigint NOT NULL CHECK (actual_cents BETWEEN -100000000000 AND 100000000000),
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (synergy_id, period_month)
);

-- =============================================================
-- 3. OWNERSHIP HELPERS (SECURITY DEFINER so policies work for every team member)
-- =============================================================
CREATE OR REPLACE FUNCTION public.acq_owns(p_acq uuid, p_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_owner = public.get_account_owner_id() AND EXISTS (SELECT 1 FROM public.acquisitions a WHERE a.id = p_acq AND a.user_id = p_owner);
$$;

CREATE OR REPLACE FUNCTION public.acq_ws_owned(p_ws uuid, p_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_owner = public.get_account_owner_id() AND EXISTS (SELECT 1 FROM public.acquisition_workstreams w WHERE w.id = p_ws AND w.user_id = p_owner);
$$;

CREATE OR REPLACE FUNCTION public.acq_synergy_owned(p_syn uuid, p_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_owner = public.get_account_owner_id() AND EXISTS (SELECT 1 FROM public.acquisition_synergies s WHERE s.id = p_syn AND s.user_id = p_owner);
$$;

CREATE OR REPLACE FUNCTION public.acq_member_in_account(p_member uuid, p_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_member IS NULL OR (p_owner = public.get_account_owner_id() AND EXISTS (SELECT 1 FROM public.team_members t WHERE t.id = p_member AND t.account_owner_id = p_owner));
$$;

CREATE OR REPLACE FUNCTION public.acq_import_job_owned(p_job uuid, p_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_owner = public.get_account_owner_id() AND EXISTS (SELECT 1 FROM public.data_import_jobs j WHERE j.id = p_job AND j.user_id = p_owner);
$$;

REVOKE ALL ON FUNCTION public.acq_owns(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.acq_ws_owned(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.acq_synergy_owned(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.acq_member_in_account(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.acq_import_job_owned(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acq_owns(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acq_ws_owned(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acq_synergy_owned(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acq_member_in_account(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acq_import_job_owned(uuid, uuid) TO authenticated;

-- =============================================================
-- 4. ROW LEVEL SECURITY
-- =============================================================
ALTER TABLE public.acquisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_workstreams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_workstream_deps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_source_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_data_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_import_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_synergies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_synergy_actuals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS acq_all ON public.acquisitions;
CREATE POLICY acq_all ON public.acquisitions FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_acquisitions())
  WITH CHECK (
    user_id = public.get_account_owner_id() AND public.can_manage_acquisitions()
    AND (brand_id IS NULL OR EXISTS (SELECT 1 FROM public.business_brands b WHERE b.id = acquisitions.brand_id AND b.user_id = acquisitions.user_id))
    AND (location_id IS NULL OR EXISTS (SELECT 1 FROM public.business_locations l WHERE l.id = acquisitions.location_id AND l.user_id = acquisitions.user_id))
    AND (franchise_location_id IS NULL OR EXISTS (
      SELECT 1 FROM public.franchise_locations fl JOIN public.franchise_groups fg ON fg.id = fl.franchise_group_id
       WHERE fl.id = acquisitions.franchise_location_id AND fg.owner_id = acquisitions.user_id))
  );

DROP POLICY IF EXISTS acq_all ON public.acquisition_workstreams;
CREATE POLICY acq_all ON public.acquisition_workstreams FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_acquisitions())
  WITH CHECK (
    user_id = public.get_account_owner_id() AND public.can_manage_acquisitions()
    AND public.acq_owns(acquisition_id, user_id)
    AND public.acq_member_in_account(owner_member_id, user_id)
  );

DROP POLICY IF EXISTS acq_all ON public.acquisition_workstream_deps;
CREATE POLICY acq_all ON public.acquisition_workstream_deps FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_acquisitions())
  WITH CHECK (
    user_id = public.get_account_owner_id() AND public.can_manage_acquisitions()
    AND public.acq_ws_owned(workstream_id, user_id) AND public.acq_ws_owned(depends_on_id, user_id)
  );

DROP POLICY IF EXISTS acq_all ON public.acquisition_source_controls;
CREATE POLICY acq_all ON public.acquisition_source_controls FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_acquisitions())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_acquisitions() AND public.acq_owns(acquisition_id, user_id));

-- Check results and baselines are written only by the SECURITY DEFINER functions below.
DROP POLICY IF EXISTS acq_select ON public.acquisition_data_checks;
CREATE POLICY acq_select ON public.acquisition_data_checks FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_acquisitions());

DROP POLICY IF EXISTS acq_select ON public.acquisition_baselines;
CREATE POLICY acq_select ON public.acquisition_baselines FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_acquisitions());

DROP POLICY IF EXISTS acq_all ON public.acquisition_import_links;
CREATE POLICY acq_all ON public.acquisition_import_links FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_acquisitions())
  WITH CHECK (
    user_id = public.get_account_owner_id() AND public.can_manage_acquisitions()
    AND public.acq_owns(acquisition_id, user_id) AND public.acq_import_job_owned(import_job_id, user_id)
  );

DROP POLICY IF EXISTS acq_all ON public.acquisition_synergies;
CREATE POLICY acq_all ON public.acquisition_synergies FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_acquisitions())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_acquisitions() AND public.acq_owns(acquisition_id, user_id));

DROP POLICY IF EXISTS acq_all ON public.acquisition_synergy_actuals;
CREATE POLICY acq_all ON public.acquisition_synergy_actuals FOR ALL TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.can_manage_acquisitions())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.can_manage_acquisitions() AND public.acq_synergy_owned(synergy_id, user_id));

-- =============================================================
-- 5. TRIGGERS
-- =============================================================
DROP TRIGGER IF EXISTS trg_acquisitions_touch ON public.acquisitions;
CREATE TRIGGER trg_acquisitions_touch BEFORE UPDATE ON public.acquisitions FOR EACH ROW EXECUTE FUNCTION public.acq_touch_updated_at();
DROP TRIGGER IF EXISTS trg_acq_workstreams_touch ON public.acquisition_workstreams;
CREATE TRIGGER trg_acq_workstreams_touch BEFORE UPDATE ON public.acquisition_workstreams FOR EACH ROW EXECUTE FUNCTION public.acq_touch_updated_at();
DROP TRIGGER IF EXISTS trg_acq_controls_touch ON public.acquisition_source_controls;
CREATE TRIGGER trg_acq_controls_touch BEFORE UPDATE ON public.acquisition_source_controls FOR EACH ROW EXECUTE FUNCTION public.acq_touch_updated_at();
DROP TRIGGER IF EXISTS trg_acq_synergies_touch ON public.acquisition_synergies;
CREATE TRIGGER trg_acq_synergies_touch BEFORE UPDATE ON public.acquisition_synergies FOR EACH ROW EXECUTE FUNCTION public.acq_touch_updated_at();
DROP TRIGGER IF EXISTS trg_acq_actuals_touch ON public.acquisition_synergy_actuals;
CREATE TRIGGER trg_acq_actuals_touch BEFORE UPDATE ON public.acquisition_synergy_actuals FOR EACH ROW EXECUTE FUNCTION public.acq_touch_updated_at();

-- Workstream: freeze parents, stamp completion, block start/finish while a dependency is open.
CREATE OR REPLACE FUNCTION public.acq_workstream_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.acquisition_id := OLD.acquisition_id;
  END IF;
  IF NEW.status IN ('done', 'skipped') THEN
    NEW.completed_at := now();
    IF TG_OP = 'UPDATE' THEN
      IF OLD.status IN ('done', 'skipped') THEN
        NEW.completed_at := COALESCE(OLD.completed_at, now());
      END IF;
    END IF;
  ELSE
    NEW.completed_at := NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IN ('in_progress', 'done') AND NEW.status IS DISTINCT FROM OLD.status THEN
      IF EXISTS (
        SELECT 1 FROM public.acquisition_workstream_deps d
          JOIN public.acquisition_workstreams w ON w.id = d.depends_on_id
         WHERE d.workstream_id = NEW.id AND w.status NOT IN ('done', 'skipped')
      ) THEN
        RAISE EXCEPTION 'acq_dependency_open' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_acq_workstream_guard ON public.acquisition_workstreams;
CREATE TRIGGER trg_acq_workstream_guard BEFORE INSERT OR UPDATE ON public.acquisition_workstreams
  FOR EACH ROW EXECUTE FUNCTION public.acq_workstream_guard();

-- Acquisition completes itself when every workstream is done/skipped, and re-opens if one is re-opened.
CREATE OR REPLACE FUNCTION public.acq_sync_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_id := OLD.acquisition_id; ELSE v_id := NEW.acquisition_id; END IF;
  IF EXISTS (SELECT 1 FROM public.acquisition_workstreams WHERE acquisition_id = v_id AND status NOT IN ('done', 'skipped')) THEN
    UPDATE public.acquisitions SET status = 'integrating' WHERE id = v_id AND status = 'completed';
  ELSIF EXISTS (SELECT 1 FROM public.acquisition_workstreams WHERE acquisition_id = v_id) THEN
    UPDATE public.acquisitions SET status = 'completed' WHERE id = v_id AND status = 'integrating';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_acq_sync_status ON public.acquisition_workstreams;
CREATE TRIGGER trg_acq_sync_status AFTER INSERT OR UPDATE OF status OR DELETE ON public.acquisition_workstreams
  FOR EACH ROW EXECUTE FUNCTION public.acq_sync_status();

-- Dependencies: same acquisition, no cycles.
CREATE OR REPLACE FUNCTION public.acq_dep_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT w.acquisition_id FROM public.acquisition_workstreams w WHERE w.id = NEW.workstream_id)
     IS DISTINCT FROM (SELECT w.acquisition_id FROM public.acquisition_workstreams w WHERE w.id = NEW.depends_on_id) THEN
    RAISE EXCEPTION 'acq_dependency_cross' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH RECURSIVE upstream AS (
      SELECT d.depends_on_id AS id FROM public.acquisition_workstream_deps d WHERE d.workstream_id = NEW.depends_on_id
      UNION
      SELECT d.depends_on_id FROM public.acquisition_workstream_deps d JOIN upstream u ON d.workstream_id = u.id
    )
    SELECT 1 FROM upstream WHERE id = NEW.workstream_id
  ) THEN
    RAISE EXCEPTION 'acq_dependency_cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_acq_dep_guard ON public.acquisition_workstream_deps;
CREATE TRIGGER trg_acq_dep_guard BEFORE INSERT ON public.acquisition_workstream_deps
  FOR EACH ROW EXECUTE FUNCTION public.acq_dep_guard();

-- Audit: status/scope/date changes and deletions (DEFINER: it calls the internal audit helper).
CREATE OR REPLACE FUNCTION public.acq_audit_acquisition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.acq_audit(OLD.user_id, 'acquisition.deleted', OLD.id::text, jsonb_build_object('name', OLD.name));
  ELSIF NEW.status IS DISTINCT FROM OLD.status OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind OR NEW.close_date IS DISTINCT FROM OLD.close_date THEN
    PERFORM public.acq_audit(NEW.user_id, 'acquisition.updated', NEW.id::text,
      jsonb_build_object('name', NEW.name, 'status', NEW.status, 'scope', NEW.scope_kind, 'close_date', NEW.close_date));
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_acq_audit ON public.acquisitions;
CREATE TRIGGER trg_acq_audit AFTER UPDATE OR DELETE ON public.acquisitions
  FOR EACH ROW EXECUTE FUNCTION public.acq_audit_acquisition();

-- =============================================================
-- 6. INTERNAL METRIC ENGINE (not callable by clients — only by the RPCs below)
-- =============================================================

-- Which rows belong to an acquisition. NULL arrays mean "no restriction" (the whole linked account).
CREATE OR REPLACE FUNCTION public.acq_scope(p_acq uuid, OUT o_kind text, OUT o_owner uuid, OUT o_data_user uuid, OUT o_job_ids uuid[], OUT o_customer_ids uuid[])
RETURNS record LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.acquisitions%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.acquisitions WHERE id = p_acq;
  IF NOT FOUND THEN RETURN; END IF;
  o_kind := a.scope_kind;
  o_owner := a.user_id;
  IF a.scope_kind = 'linked_account' THEN
    SELECT fl.location_profile_id INTO o_data_user
      FROM public.franchise_locations fl
      JOIN public.franchise_groups fg ON fg.id = fl.franchise_group_id
     WHERE fl.id = a.franchise_location_id AND fg.owner_id = a.user_id
       AND fl.status = 'active' AND fl.location_profile_id IS NOT NULL;
  ELSIF a.scope_kind = 'imported' THEN
    o_data_user := a.user_id;
    SELECT COALESCE(array_agg(e.entity_id) FILTER (WHERE e.entity_type = 'job'), ARRAY[]::uuid[]),
           COALESCE(array_agg(e.entity_id) FILTER (WHERE e.entity_type = 'customer'), ARRAY[]::uuid[])
      INTO o_job_ids, o_customer_ids
      FROM public.data_import_row_effects e
      JOIN public.acquisition_import_links l ON l.import_job_id = e.import_job_id AND l.acquisition_id = a.id
     WHERE e.user_id = a.user_id AND e.action = 'created';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.acq_scope(uuid) FROM PUBLIC, anon, authenticated;

-- Every job id that belongs to ANY imported acquisition of the account (excluded from the "parent" numbers).
CREATE OR REPLACE FUNCTION public.acq_imported_job_ids(p_owner uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(e.entity_id), ARRAY[]::uuid[])
    FROM public.data_import_row_effects e
    JOIN public.acquisition_import_links l ON l.import_job_id = e.import_job_id
   WHERE e.user_id = p_owner AND l.user_id = p_owner AND e.entity_type = 'job' AND e.action = 'created';
$$;
REVOKE ALL ON FUNCTION public.acq_imported_job_ids(uuid) FROM PUBLIC, anon, authenticated;

-- KPI bundle for one set of jobs. p_job_ids NULL = every job of p_user; p_exclude flips the array into an exclusion list.
CREATE OR REPLACE FUNCTION public.acq_kpis_for(p_user uuid, p_job_ids uuid[], p_exclude boolean, p_as_of date, p_window integer, p_target numeric)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_start date := p_as_of - p_window;
  v_prev date := p_as_of - (2 * p_window);
  v_work_days numeric := GREATEST(1, round(p_window * 5.0 / 7.0));
  r record;
  v_util numeric;
  v_margin numeric;
  v_cov numeric;
  v_avg bigint;
BEGIN
  IF p_user IS NULL THEN RETURN NULL; END IF;

  WITH sel AS (
    SELECT j.id, j.customer_id, j.assigned_technician_id, j.invoice_status,
           COALESCE(round(j.invoice_amount * 100), 0)::bigint AS cents,
           COALESCE(j.scheduled_datetime, j.created_at)::date AS d
      FROM public.jobs j
     WHERE j.user_id = p_user
       AND COALESCE(j.job_status, '') NOT IN ('cancelled', 'no_show')
       AND (p_job_ids IS NULL OR ((j.id = ANY (p_job_ids)) <> COALESCE(p_exclude, false)))
  ),
  cur AS (SELECT * FROM sel WHERE d > v_start AND d <= p_as_of),
  costs AS (
    SELECT c.job_id, sum(c.total_cost_cents)::bigint AS cost
      FROM public.job_cost_entries c
     WHERE c.user_id = p_user AND c.job_id IN (SELECT id FROM cur)
     GROUP BY c.job_id
  )
  SELECT
    (SELECT count(*) FROM cur) AS n_jobs,
    (SELECT COALESCE(sum(cents), 0) FROM cur WHERE invoice_status = 'paid') AS revenue,
    (SELECT count(*) FROM cur WHERE invoice_status = 'paid' AND cents > 0) AS paid_jobs,
    (SELECT COALESCE(sum(cents), 0) FROM sel WHERE invoice_status = 'sent' AND d <= p_as_of) AS open_ar,
    (SELECT COALESCE(sum(cur.cents), 0) FROM cur JOIN costs ON costs.job_id = cur.id WHERE cur.cents > 0) AS m_rev,
    (SELECT COALESCE(sum(costs.cost), 0) FROM cur JOIN costs ON costs.job_id = cur.id WHERE cur.cents > 0) AS m_cost,
    (SELECT count(*) FROM cur WHERE cents > 0) AS rev_jobs,
    (SELECT count(*) FROM cur JOIN costs ON costs.job_id = cur.id WHERE cur.cents > 0) AS cost_jobs,
    (SELECT count(DISTINCT assigned_technician_id) FROM cur WHERE assigned_technician_id IS NOT NULL) AS techs,
    (SELECT count(*) FROM cur WHERE assigned_technician_id IS NOT NULL) AS assigned_jobs,
    (SELECT count(DISTINCT customer_id) FROM sel WHERE customer_id IS NOT NULL AND d > v_prev AND d <= v_start) AS ret_prior,
    (SELECT count(DISTINCT p.customer_id) FROM sel p
      WHERE p.customer_id IS NOT NULL AND p.d > v_prev AND p.d <= v_start
        AND EXISTS (SELECT 1 FROM cur c2 WHERE c2.customer_id = p.customer_id)) AS ret_kept
  INTO r;

  IF r.techs > 0 AND p_target > 0 THEN
    v_util := LEAST(100, round(100.0 * r.assigned_jobs / (r.techs * v_work_days * p_target), 1));
  END IF;
  IF r.m_rev > 0 THEN v_margin := round(100.0 * (r.m_rev - r.m_cost) / r.m_rev, 1); END IF;
  IF r.rev_jobs > 0 THEN v_cov := round(100.0 * r.cost_jobs / r.rev_jobs, 1); END IF;
  IF r.paid_jobs > 0 THEN v_avg := round(r.revenue::numeric / r.paid_jobs); END IF;

  RETURN jsonb_build_object(
    'jobs_count', r.n_jobs,
    'revenue_cents', r.revenue,
    'avg_ticket_cents', v_avg,
    'open_ar_cents', r.open_ar,
    'gross_margin_pct', v_margin,
    'margin_coverage_pct', v_cov,
    'utilization_pct', v_util,
    'technicians', r.techs,
    'retention_pct', CASE WHEN r.ret_prior > 0 THEN round(100.0 * r.ret_kept / r.ret_prior, 1) END,
    'retention_at_risk', GREATEST(0, r.ret_prior - r.ret_kept),
    'retention_base', r.ret_prior
  );
END;
$$;
REVOKE ALL ON FUNCTION public.acq_kpis_for(uuid, uuid[], boolean, date, integer, numeric) FROM PUBLIC, anon, authenticated;

-- Totals used by the import-vs-source checks (whole linked account, or exactly the imported rows).
CREATE OR REPLACE FUNCTION public.acq_actuals(p_user uuid, p_job_ids uuid[], p_customer_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
BEGIN
  IF p_user IS NULL THEN RETURN NULL; END IF;
  SELECT
    (SELECT count(*) FROM public.customers c
      WHERE c.user_id = p_user AND (p_customer_ids IS NULL OR c.id = ANY (p_customer_ids))) AS n_customers,
    (SELECT count(*) FROM public.jobs j
      WHERE j.user_id = p_user AND (p_job_ids IS NULL OR j.id = ANY (p_job_ids))) AS n_jobs,
    (SELECT COALESCE(sum(round(j.invoice_amount * 100)), 0) FROM public.jobs j
      WHERE j.user_id = p_user AND (p_job_ids IS NULL OR j.id = ANY (p_job_ids))
        AND j.invoice_amount IS NOT NULL AND j.invoice_status IN ('sent', 'paid')) AS invoiced,
    (SELECT COALESCE(sum(round(j.invoice_amount * 100)), 0) FROM public.jobs j
      WHERE j.user_id = p_user AND (p_job_ids IS NULL OR j.id = ANY (p_job_ids))
        AND j.invoice_amount IS NOT NULL AND j.invoice_status = 'paid') AS paid,
    (SELECT COALESCE(sum(round(j.invoice_amount * 100)), 0) FROM public.jobs j
      WHERE j.user_id = p_user AND (p_job_ids IS NULL OR j.id = ANY (p_job_ids))
        AND j.invoice_amount IS NOT NULL AND j.invoice_status = 'sent') AS open_ar,
    (SELECT count(*) FROM public.jobs j
      WHERE j.user_id = p_user AND (p_job_ids IS NULL OR j.id = ANY (p_job_ids)) AND j.customer_id IS NULL) AS orphan_jobs,
    (SELECT COALESCE(sum(g.n - 1), 0) FROM (
        SELECT count(*) AS n FROM public.customers c
         WHERE c.user_id = p_user AND (p_customer_ids IS NULL OR c.id = ANY (p_customer_ids))
           AND length(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g')) >= 7
         GROUP BY right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10)
        HAVING count(*) > 1
      ) g) AS dup_phones
  INTO r;
  RETURN jsonb_build_object(
    'customers_count', r.n_customers, 'jobs_count', r.n_jobs, 'invoiced_cents', r.invoiced,
    'paid_cents', r.paid, 'open_ar_cents', r.open_ar, 'orphan_jobs', r.orphan_jobs, 'dup_phones', r.dup_phones
  );
END;
$$;
REVOKE ALL ON FUNCTION public.acq_actuals(uuid, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 7. RPCs (clients call these; every one re-checks the permission and the account)
-- =============================================================

-- 7a. Create an acquisition AND its 30/60/90 template atomically.
CREATE OR REPLACE FUNCTION public.create_acquisition(
  p_name text, p_legal_name text, p_close_date date, p_scope_kind text,
  p_franchise_location_id uuid, p_brand_id uuid, p_location_id uuid,
  p_purchase_price_cents bigint, p_currency text, p_notes text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_name text := btrim(COALESCE(p_name, ''));
  v_currency text := upper(COALESCE(NULLIF(btrim(p_currency), ''), 'USD'));
  v_id uuid;
  v_ws uuid;
  v_ids jsonb := '{}'::jsonb;
  t record;
  d record;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_acquisitions() THEN
    RAISE EXCEPTION 'acq_forbidden' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'acq_invalid_name' USING ERRCODE = '22023'; END IF;
  IF p_close_date IS NULL OR p_close_date < current_date - 3650 OR p_close_date > current_date + 730 THEN
    RAISE EXCEPTION 'acq_invalid_close_date' USING ERRCODE = '22023';
  END IF;
  IF p_scope_kind IS NULL OR p_scope_kind NOT IN ('linked_account', 'imported', 'external') THEN
    RAISE EXCEPTION 'acq_invalid_scope' USING ERRCODE = '22023';
  END IF;
  IF v_currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'acq_invalid_currency' USING ERRCODE = '22023'; END IF;
  IF p_purchase_price_cents IS NOT NULL AND p_purchase_price_cents < 0 THEN
    RAISE EXCEPTION 'acq_invalid_price' USING ERRCODE = '22023';
  END IF;
  IF p_scope_kind = 'linked_account' THEN
    IF p_franchise_location_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.franchise_locations fl JOIN public.franchise_groups fg ON fg.id = fl.franchise_group_id
       WHERE fl.id = p_franchise_location_id AND fg.owner_id = v_owner AND fl.status = 'active' AND fl.location_profile_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'acq_invalid_franchise_location' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_brand_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.business_brands b WHERE b.id = p_brand_id AND b.user_id = v_owner) THEN
    RAISE EXCEPTION 'acq_invalid_reference' USING ERRCODE = '22023';
  END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.business_locations l WHERE l.id = p_location_id AND l.user_id = v_owner) THEN
    RAISE EXCEPTION 'acq_invalid_reference' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.acquisitions (user_id, name, legal_name, status, close_date, scope_kind, franchise_location_id,
                                   brand_id, location_id, purchase_price_cents, currency, notes)
  VALUES (v_owner, v_name, NULLIF(btrim(p_legal_name), ''),
          CASE WHEN p_close_date > current_date THEN 'planned' ELSE 'integrating' END,
          p_close_date, p_scope_kind,
          CASE WHEN p_scope_kind = 'linked_account' THEN p_franchise_location_id ELSE NULL END,
          p_brand_id, p_location_id, p_purchase_price_cents, v_currency, NULLIF(btrim(p_notes), ''))
  RETURNING id INTO v_id;

  FOR t IN
    SELECT * FROM (VALUES
      ('license_insurance', 'Verify licenses & insurance',
       'Confirm trade/contractor licenses transfer or are reissued, and that liability, workers'' comp and auto cover is bound from Day 1.', 'day_30', 10, 10),
      ('customer_comms', 'Customer communication',
       'Announce the change by email/SMS/portal with an FAQ and a clear contact path; keep the legacy number answering.', 'day_30', 7, 20),
      ('phone_porting', 'Phone number porting',
       'Port the main and tracking numbers; keep call forwarding live until each port completes.', 'day_30', 21, 30),
      ('data_import', 'Data import, mapping & reconciliation',
       'Import customers and job history with the Import Wizard, link the runs here, then reconcile counts and balances against the seller''s totals.', 'day_30', 30, 40),
      ('tech_payroll_onboarding', 'Technician & payroll onboarding',
       'Create team accounts, collect I-9/W-4/licences, map pay rates and set up payroll for the acquired crew.', 'day_30', 30, 50),
      ('accounting_tax', 'Accounting & tax mapping',
       'Map the chart of accounts, tax classes and registrations, and bank feeds to the parent books.', 'day_60', 45, 60),
      ('price_book', 'Price book harmonization',
       'Align services, rates and membership pricing with the parent price book, with grandfathering rules for existing customers.', 'day_60', 60, 70),
      ('brand_transition', 'Brand transition (multi-brand)',
       'Keep the acquired brand under Locations -> Brands, then roll out new branding on invoices, portal, website and vehicles.', 'day_60', 60, 80),
      ('systems_cutover', 'Systems cutover',
       'Retire the legacy FSM, phone and accounting systems after a final delta sync and a signed-off cutover plan.', 'day_90', 90, 90)
    ) AS x(kind, title, descr, phase, due_off, ord)
    ORDER BY ord
  LOOP
    INSERT INTO public.acquisition_workstreams (user_id, acquisition_id, kind, title, description, phase, due_date, sort_order)
    VALUES (v_owner, v_id, t.kind, t.title, t.descr, t.phase, p_close_date + t.due_off, t.ord)
    RETURNING id INTO v_ws;
    v_ids := v_ids || jsonb_build_object(t.kind, v_ws);
  END LOOP;

  FOR d IN
    SELECT * FROM (VALUES
      ('tech_payroll_onboarding', 'license_insurance'),
      ('accounting_tax', 'data_import'),
      ('price_book', 'data_import'),
      ('brand_transition', 'customer_comms'),
      ('brand_transition', 'phone_porting'),
      ('systems_cutover', 'phone_porting'),
      ('systems_cutover', 'data_import'),
      ('systems_cutover', 'accounting_tax'),
      ('systems_cutover', 'price_book'),
      ('systems_cutover', 'tech_payroll_onboarding')
    ) AS y(child_kind, parent_kind)
  LOOP
    INSERT INTO public.acquisition_workstream_deps (user_id, workstream_id, depends_on_id)
    VALUES (v_owner, (v_ids ->> d.child_kind)::uuid, (v_ids ->> d.parent_kind)::uuid);
  END LOOP;

  PERFORM public.acq_audit(v_owner, 'acquisition.created', v_id::text,
    jsonb_build_object('name', v_name, 'scope', p_scope_kind, 'close_date', p_close_date));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_acquisition(text, text, date, text, uuid, uuid, uuid, bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_acquisition(text, text, date, text, uuid, uuid, uuid, bigint, text, text) TO authenticated;

-- 7b. Day-one dashboard: parent vs acquired baseline vs acquired now.
CREATE OR REPLACE FUNCTION public.acq_kpi_report(p_acq uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  a public.acquisitions%ROWTYPE;
  s record;
  b public.acquisition_baselines%ROWTYPE;
  v_now jsonb;
  v_parent jsonb;
  v_base jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_acquisitions() THEN
    RAISE EXCEPTION 'acq_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO a FROM public.acquisitions WHERE id = p_acq AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'acq_not_found' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO s FROM public.acq_scope(a.id);
  v_parent := public.acq_kpis_for(v_owner, public.acq_imported_job_ids(v_owner), true, current_date, 90, a.target_jobs_per_tech_day);
  IF s.o_data_user IS NOT NULL THEN
    v_now := public.acq_kpis_for(s.o_data_user, s.o_job_ids, false, current_date, 90, a.target_jobs_per_tech_day);
  END IF;

  SELECT * INTO b FROM public.acquisition_baselines WHERE acquisition_id = a.id;
  IF FOUND THEN
    v_base := jsonb_build_object('as_of', b.as_of, 'source', b.source, 'metrics', b.metrics, 'note', b.note, 'captured_at', b.captured_at);
  END IF;

  RETURN jsonb_build_object(
    'scope_kind', a.scope_kind,
    'close_date', a.close_date,
    'window_days', 90,
    'has_live_data', s.o_data_user IS NOT NULL,
    'parent', v_parent,
    'now', v_now,
    'baseline', v_base
  );
END;
$$;
REVOKE ALL ON FUNCTION public.acq_kpi_report(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acq_kpi_report(uuid) TO authenticated;

-- 7c. Baseline: enter by hand (seller's numbers)…
CREATE OR REPLACE FUNCTION public.acq_save_baseline(p_acq uuid, p_metrics jsonb, p_as_of date, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  e record;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_acquisitions() THEN
    RAISE EXCEPTION 'acq_forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.acquisitions WHERE id = p_acq AND user_id = v_owner) THEN
    RAISE EXCEPTION 'acq_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_as_of IS NULL OR p_as_of > current_date + 1 OR p_as_of < current_date - 3650 THEN
    RAISE EXCEPTION 'acq_invalid_baseline' USING ERRCODE = '22023';
  END IF;
  IF p_metrics IS NULL OR jsonb_typeof(p_metrics) <> 'object' OR p_metrics = '{}'::jsonb THEN
    RAISE EXCEPTION 'acq_invalid_baseline' USING ERRCODE = '22023';
  END IF;
  FOR e IN SELECT key, value FROM jsonb_each(p_metrics) LOOP
    IF e.key NOT IN ('revenue_cents', 'jobs_count', 'avg_ticket_cents', 'gross_margin_pct', 'utilization_pct', 'retention_pct', 'open_ar_cents')
       OR jsonb_typeof(e.value) <> 'number' THEN
      RAISE EXCEPTION 'acq_invalid_baseline' USING ERRCODE = '22023';
    END IF;
    IF e.key = 'gross_margin_pct' AND ((e.value)::text)::numeric NOT BETWEEN -100 AND 100 THEN
      RAISE EXCEPTION 'acq_invalid_baseline' USING ERRCODE = '22023';
    END IF;
    IF e.key IN ('utilization_pct', 'retention_pct') AND ((e.value)::text)::numeric NOT BETWEEN 0 AND 100 THEN
      RAISE EXCEPTION 'acq_invalid_baseline' USING ERRCODE = '22023';
    END IF;
    IF e.key NOT IN ('gross_margin_pct', 'utilization_pct', 'retention_pct') AND ((e.value)::text)::numeric < 0 THEN
      RAISE EXCEPTION 'acq_invalid_baseline' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  INSERT INTO public.acquisition_baselines (acquisition_id, user_id, as_of, source, metrics, note, captured_by, captured_at)
  VALUES (p_acq, v_owner, p_as_of, 'manual', p_metrics, NULLIF(left(btrim(COALESCE(p_note, '')), 500), ''), auth.uid(), now())
  ON CONFLICT (acquisition_id) DO UPDATE
    SET as_of = EXCLUDED.as_of, source = 'manual', metrics = EXCLUDED.metrics, note = EXCLUDED.note,
        captured_by = EXCLUDED.captured_by, captured_at = now();
  PERFORM public.acq_audit(v_owner, 'acquisition.baseline_saved', p_acq::text, jsonb_build_object('source', 'manual'));
END;
$$;
REVOKE ALL ON FUNCTION public.acq_save_baseline(uuid, jsonb, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acq_save_baseline(uuid, jsonb, date, text) TO authenticated;

-- …or freeze it from live data as of the close date (the 90 days BEFORE close).
CREATE OR REPLACE FUNCTION public.acq_capture_baseline(p_acq uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  a public.acquisitions%ROWTYPE;
  s record;
  v_as_of date;
  v_metrics jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_acquisitions() THEN
    RAISE EXCEPTION 'acq_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO a FROM public.acquisitions WHERE id = p_acq AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'acq_not_found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO s FROM public.acq_scope(a.id);
  IF s.o_data_user IS NULL THEN RAISE EXCEPTION 'acq_no_live_data' USING ERRCODE = '22023'; END IF;
  v_as_of := LEAST(a.close_date, current_date);
  v_metrics := public.acq_kpis_for(s.o_data_user, s.o_job_ids, false, v_as_of, 90, a.target_jobs_per_tech_day);

  INSERT INTO public.acquisition_baselines (acquisition_id, user_id, as_of, source, metrics, note, captured_by, captured_at)
  VALUES (p_acq, v_owner, v_as_of, 'computed', v_metrics, NULL, auth.uid(), now())
  ON CONFLICT (acquisition_id) DO UPDATE
    SET as_of = EXCLUDED.as_of, source = 'computed', metrics = EXCLUDED.metrics, note = NULL,
        captured_by = EXCLUDED.captured_by, captured_at = now();
  PERFORM public.acq_audit(v_owner, 'acquisition.baseline_saved', p_acq::text, jsonb_build_object('source', 'computed'));
END;
$$;
REVOKE ALL ON FUNCTION public.acq_capture_baseline(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acq_capture_baseline(uuid) TO authenticated;

-- 7d. Automated data checks: seller control totals vs what actually landed in Vireek.
CREATE OR REPLACE FUNCTION public.acq_run_data_checks(p_acq uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_run uuid := gen_random_uuid();
  a public.acquisitions%ROWTYPE;
  s record;
  m record;
  c record;
  v_act jsonb;
  v_actual numeric;
  v_diff numeric;
  v_pct numeric;
  v_status text;
  v_n numeric;
  v_bad numeric;
  v_links integer;
  v_rows numeric;
  v_errs numeric;
  v_failed integer;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_acquisitions() THEN
    RAISE EXCEPTION 'acq_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO a FROM public.acquisitions WHERE id = p_acq AND user_id = v_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'acq_not_found' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO s FROM public.acq_scope(a.id);
  v_act := public.acq_actuals(s.o_data_user, s.o_job_ids, s.o_customer_ids);

  -- 1) seller control totals vs actuals
  FOR m IN
    SELECT * FROM (VALUES
      ('customers_count', 'Customers', 10), ('jobs_count', 'Jobs', 20), ('invoiced_cents', 'Invoiced total', 30),
      ('paid_cents', 'Paid total', 40), ('open_ar_cents', 'Open receivables', 50)
    ) AS x(k, lbl, ord) ORDER BY ord
  LOOP
    SELECT * INTO c FROM public.acquisition_source_controls WHERE acquisition_id = a.id AND metric_key = m.k;
    IF v_act IS NULL THEN
      INSERT INTO public.acquisition_data_checks (user_id, acquisition_id, run_id, check_key, label, status, detail)
      VALUES (v_owner, a.id, v_run, m.k, m.lbl, 'skip', 'No Vireek data is linked to this acquisition yet.');
    ELSIF NOT FOUND THEN
      INSERT INTO public.acquisition_data_checks (user_id, acquisition_id, run_id, check_key, label, status, actual_value, detail)
      VALUES (v_owner, a.id, v_run, m.k, m.lbl, 'skip', (v_act ->> m.k)::numeric, 'No source control total entered yet.');
    ELSE
      v_actual := (v_act ->> m.k)::numeric;
      v_diff := v_actual - c.source_value;
      v_pct := CASE WHEN c.source_value > 0 THEN abs(v_diff) * 100 / c.source_value WHEN v_diff = 0 THEN 0 ELSE 100 END;
      v_status := CASE WHEN v_pct <= c.tolerance_pct THEN 'pass' WHEN v_pct <= GREATEST(c.tolerance_pct * 2, 1) THEN 'warn' ELSE 'fail' END;
      INSERT INTO public.acquisition_data_checks (user_id, acquisition_id, run_id, check_key, label, status, source_value, actual_value, diff, diff_pct, tolerance_pct, detail)
      VALUES (v_owner, a.id, v_run, m.k, m.lbl, v_status, c.source_value, v_actual, v_diff, round(v_pct, 2), c.tolerance_pct,
              CASE WHEN v_status = 'pass' THEN 'Matches the seller''s total within tolerance.'
                   WHEN v_diff < 0 THEN 'Vireek is LOWER than the seller''s total — rows are missing.'
                   ELSE 'Vireek is HIGHER than the seller''s total — duplicates or extra rows.' END);
    END IF;
  END LOOP;

  -- 2) integrity checks on what was imported
  IF v_act IS NOT NULL THEN
    v_n := (v_act ->> 'jobs_count')::numeric;
    v_bad := (v_act ->> 'orphan_jobs')::numeric;
    IF v_n = 0 THEN
      INSERT INTO public.acquisition_data_checks (user_id, acquisition_id, run_id, check_key, label, status, detail)
      VALUES (v_owner, a.id, v_run, 'orphan_jobs', 'Jobs linked to a customer', 'skip', 'No jobs yet.');
    ELSE
      v_pct := v_bad * 100 / v_n;
      INSERT INTO public.acquisition_data_checks (user_id, acquisition_id, run_id, check_key, label, status, source_value, actual_value, diff_pct, detail)
      VALUES (v_owner, a.id, v_run, 'orphan_jobs', 'Jobs linked to a customer',
              CASE WHEN v_pct = 0 THEN 'pass' WHEN v_pct <= 5 THEN 'warn' ELSE 'fail' END, v_n, v_n - v_bad, round(v_pct, 2),
              CASE WHEN v_bad = 0 THEN 'Every job has a customer.' ELSE v_bad::bigint || ' job(s) have no customer attached.' END);
    END IF;

    v_n := (v_act ->> 'customers_count')::numeric;
    v_bad := (v_act ->> 'dup_phones')::numeric;
    IF v_n = 0 THEN
      INSERT INTO public.acquisition_data_checks (user_id, acquisition_id, run_id, check_key, label, status, detail)
      VALUES (v_owner, a.id, v_run, 'dup_phones', 'Duplicate customer phone numbers', 'skip', 'No customers yet.');
    ELSE
      v_pct := v_bad * 100 / v_n;
      INSERT INTO public.acquisition_data_checks (user_id, acquisition_id, run_id, check_key, label, status, source_value, actual_value, diff_pct, detail)
      VALUES (v_owner, a.id, v_run, 'dup_phones', 'Duplicate customer phone numbers',
              CASE WHEN v_pct = 0 THEN 'pass' WHEN v_pct <= 3 THEN 'warn' ELSE 'fail' END, v_n, v_bad, round(v_pct, 2),
              CASE WHEN v_bad = 0 THEN 'No customers share a phone number.' ELSE v_bad::bigint || ' customer(s) share a phone number with another — review duplicates.' END);
    END IF;
  END IF;

  IF a.scope_kind = 'imported' THEN
    SELECT count(*), COALESCE(sum(j.total_rows), 0), COALESCE(sum(j.error_count), 0),
           count(*) FILTER (WHERE j.status IN ('failed', 'rolled_back', 'rolling_back'))
      INTO v_links, v_rows, v_errs, v_failed
      FROM public.acquisition_import_links l JOIN public.data_import_jobs j ON j.id = l.import_job_id
     WHERE l.acquisition_id = a.id;
    IF v_links = 0 THEN
      INSERT INTO public.acquisition_data_checks (user_id, acquisition_id, run_id, check_key, label, status, detail)
      VALUES (v_owner, a.id, v_run, 'import_errors', 'Import runs', 'warn', 'No Import Wizard runs are linked to this acquisition yet.');
    ELSE
      v_pct := CASE WHEN v_rows > 0 THEN v_errs * 100 / v_rows ELSE 0 END;
      INSERT INTO public.acquisition_data_checks (user_id, acquisition_id, run_id, check_key, label, status, source_value, actual_value, diff_pct, detail)
      VALUES (v_owner, a.id, v_run, 'import_errors', 'Import row errors',
              CASE WHEN v_failed > 0 THEN 'fail' WHEN v_pct = 0 THEN 'pass' WHEN v_pct <= 2 THEN 'warn' ELSE 'fail' END,
              v_rows, v_errs, round(v_pct, 2),
              CASE WHEN v_failed > 0 THEN v_failed || ' linked import run(s) failed or were rolled back.'
                   WHEN v_errs = 0 THEN 'All rows imported without errors.'
                   ELSE v_errs::bigint || ' row(s) failed to import — download the error file in Data Imports.' END);
    END IF;
  END IF;

  -- keep only the 10 most recent runs
  DELETE FROM public.acquisition_data_checks
   WHERE acquisition_id = a.id
     AND run_id NOT IN (
       SELECT r.run_id FROM (
         SELECT k.run_id, max(k.checked_at) AS last_at FROM public.acquisition_data_checks k
          WHERE k.acquisition_id = a.id GROUP BY k.run_id ORDER BY max(k.checked_at) DESC LIMIT 10
       ) r
     );

  PERFORM public.acq_audit(v_owner, 'acquisition.data_checks_run', a.id::text, jsonb_build_object('run_id', v_run));
  RETURN jsonb_build_object(
    'run_id', v_run,
    'pass', (SELECT count(*) FROM public.acquisition_data_checks WHERE run_id = v_run AND status = 'pass'),
    'warn', (SELECT count(*) FROM public.acquisition_data_checks WHERE run_id = v_run AND status = 'warn'),
    'fail', (SELECT count(*) FROM public.acquisition_data_checks WHERE run_id = v_run AND status = 'fail'),
    'skip', (SELECT count(*) FROM public.acquisition_data_checks WHERE run_id = v_run AND status = 'skip')
  );
END;
$$;
REVOKE ALL ON FUNCTION public.acq_run_data_checks(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acq_run_data_checks(uuid) TO authenticated;

-- 7e. Consolidated portfolio: parent + every acquired company in ONE call.
CREATE OR REPLACE FUNCTION public.acq_portfolio()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_out jsonb := '[]'::jsonb;
  v_parent jsonb;
  a record;
  s record;
  ws record;
  sy record;
  v_kpis jsonb;
  v_base jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL OR NOT public.can_manage_acquisitions() THEN
    RAISE EXCEPTION 'acq_forbidden' USING ERRCODE = '42501';
  END IF;
  v_parent := public.acq_kpis_for(v_owner, public.acq_imported_job_ids(v_owner), true, current_date, 90, 4);

  FOR a IN SELECT * FROM public.acquisitions WHERE user_id = v_owner ORDER BY close_date DESC, created_at DESC LOOP
    SELECT * INTO s FROM public.acq_scope(a.id);
    v_kpis := NULL;
    IF s.o_data_user IS NOT NULL THEN
      v_kpis := public.acq_kpis_for(s.o_data_user, s.o_job_ids, false, current_date, 90, a.target_jobs_per_tech_day);
    END IF;

    SELECT count(*) AS total,
           count(*) FILTER (WHERE status IN ('done', 'skipped')) AS done,
           count(*) FILTER (WHERE status NOT IN ('done', 'skipped') AND due_date < current_date) AS overdue,
           count(*) FILTER (WHERE status = 'blocked') AS blocked
      INTO ws FROM public.acquisition_workstreams WHERE acquisition_id = a.id;

    SELECT COALESCE(sum(q.pl) FILTER (WHERE q.kind = 'cost_savings'), 0) AS cost_plan,
           COALESCE(sum(q.ac) FILTER (WHERE q.kind = 'cost_savings'), 0) AS cost_actual,
           COALESCE(sum(q.pl) FILTER (WHERE q.kind = 'revenue_lift'), 0) AS rev_plan,
           COALESCE(sum(q.ac) FILTER (WHERE q.kind = 'revenue_lift'), 0) AS rev_actual
      INTO sy
      FROM (
        SELECT x.kind,
               round(x.plan_annual_cents / 12.0 * GREATEST(0,
                 (EXTRACT(YEAR FROM current_date)::int - EXTRACT(YEAR FROM x.start_date)::int) * 12
                 + (EXTRACT(MONTH FROM current_date)::int - EXTRACT(MONTH FROM x.start_date)::int) + 1))::bigint AS pl,
               (SELECT COALESCE(sum(z.actual_cents), 0) FROM public.acquisition_synergy_actuals z WHERE z.synergy_id = x.id)::bigint AS ac
          FROM public.acquisition_synergies x
         WHERE x.acquisition_id = a.id AND x.status <> 'dropped'
      ) q;

    SELECT bl.metrics INTO v_base FROM public.acquisition_baselines bl WHERE bl.acquisition_id = a.id;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', a.id, 'name', a.name, 'status', a.status, 'close_date', a.close_date, 'scope_kind', a.scope_kind,
      'currency', a.currency, 'purchase_price_cents', a.purchase_price_cents,
      'has_live_data', s.o_data_user IS NOT NULL, 'kpis', v_kpis, 'baseline', v_base,
      'ws_total', ws.total, 'ws_done', ws.done, 'ws_overdue', ws.overdue, 'ws_blocked', ws.blocked,
      'cost_plan_cents', sy.cost_plan, 'cost_actual_cents', sy.cost_actual,
      'rev_plan_cents', sy.rev_plan, 'rev_actual_cents', sy.rev_actual
    ));
  END LOOP;

  RETURN jsonb_build_object('parent', v_parent, 'companies', v_out);
END;
$$;
REVOKE ALL ON FUNCTION public.acq_portfolio() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acq_portfolio() TO authenticated;
