/*
  # Enterprise Value & Exit-Readiness (owner-only)

  Estimates business value from the account's own data with transparent, editable methods
  (SDE / adjusted EBITDA, documented add-backs, configurable multiples), scores sell-readiness,
  keeps monthly KPI snapshots, and produces a buyer data room with expiring links and access logs.

  ALL OUTPUTS ARE ESTIMATES - not a valuation, appraisal or advice.

  ## Tables (all additive)
  exit_readiness_settings   one row per account (industry, method, multiple overrides, owner pay)
  exit_addbacks             documented add-backs / deductions (justification required)
  exit_snapshots            one row per month: readiness score, value range, driver scores
  exit_action_states        done / dismissed / in-progress markers for plan actions
  exit_dataroom_packages    FROZEN content shared with a buyer (built server-side)
  exit_dataroom_links       expiring, revocable, view-limited links (token HASH only)
  exit_dataroom_access_logs append-only access log (written only by exit_dataroom_open)

  ## Security
  - Every table is RLS-scoped by account_owner_id = public.get_account_owner_id() AND
    public.exit_is_owner() (only the real account owner, never team members, admins or billing roles).
  - Packages, links and logs have NO client write policies: they change only through
    SECURITY DEFINER RPCs. The public buyer path is exit_dataroom_open (service_role only).
  - Customer names/contacts are never put in a data room; staff are pseudonymised unless opted in.

  ## Requires (already in your project)
  public.get_account_owner_id(), profiles, team_members, memberships, membership_plans, employees,
  chart_of_accounts, journal_entries, journal_lines, ar_invoices, commercial_contracts, equipment,
  technician_credentials, technician_insurance_policies, sop_documents, sop_acknowledgements,
  job_profitability (view)
*/

-- =============================================================
-- 0. Owner helpers
-- =============================================================
CREATE OR REPLACE FUNCTION public.exit_is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'owner')
    AND public.get_account_owner_id() = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.exit_is_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_is_owner() TO authenticated;

CREATE OR REPLACE FUNCTION public._exit_owner()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.exit_is_owner() THEN
    RAISE EXCEPTION 'Only the account owner can use Exit Readiness.' USING ERRCODE = '42501';
  END IF;
  RETURN auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public._exit_owner() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.exit_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.account_owner_id IS DISTINCT FROM OLD.account_owner_id THEN
    RAISE EXCEPTION 'account_owner_id is immutable' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- =============================================================
-- 1. Settings
-- =============================================================
CREATE TABLE IF NOT EXISTS public.exit_readiness_settings (
  account_owner_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  industry_key text NOT NULL DEFAULT 'hvac'
    CHECK (industry_key IN ('hvac', 'plumbing', 'electrical', 'roofing', 'general_trades', 'custom')),
  method text NOT NULL DEFAULT 'auto' CHECK (method IN ('auto', 'sde', 'ebitda')),
  sde_low numeric(5,2), sde_mid numeric(5,2), sde_high numeric(5,2),
  ebitda_low numeric(5,2), ebitda_mid numeric(5,2), ebitda_high numeric(5,2),
  owner_market_salary_cents bigint NOT NULL DEFAULT 0
    CHECK (owner_market_salary_cents >= 0 AND owner_market_salary_cents <= 10000000000),
  owner_weekly_hours numeric(4,1) CHECK (owner_weekly_hours IS NULL OR (owner_weekly_hours >= 0 AND owner_weekly_hours <= 120)),
  readiness_adjusts boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exit_sde_multiple_valid CHECK (
    (sde_low IS NULL AND sde_mid IS NULL AND sde_high IS NULL)
    OR (sde_low > 0 AND sde_low <= sde_mid AND sde_mid <= sde_high AND sde_high <= 20)
  ),
  CONSTRAINT exit_ebitda_multiple_valid CHECK (
    (ebitda_low IS NULL AND ebitda_mid IS NULL AND ebitda_high IS NULL)
    OR (ebitda_low > 0 AND ebitda_low <= ebitda_mid AND ebitda_mid <= ebitda_high AND ebitda_high <= 20)
  )
);

DROP TRIGGER IF EXISTS trg_exit_settings_touch ON public.exit_readiness_settings;
CREATE TRIGGER trg_exit_settings_touch BEFORE INSERT OR UPDATE ON public.exit_readiness_settings
  FOR EACH ROW EXECUTE FUNCTION public.exit_touch();

ALTER TABLE public.exit_readiness_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "exit_settings_owner_all" ON public.exit_readiness_settings;
CREATE POLICY "exit_settings_owner_all" ON public.exit_readiness_settings FOR ALL TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner());

-- =============================================================
-- 2. Add-backs (documented adjustments)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.exit_addbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'owner_compensation', 'owner_perquisite', 'one_time', 'non_cash',
    'interest', 'taxes', 'depreciation', 'other', 'deduction'
  )),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 2 AND 120),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0 AND abs(amount_cents) <= 1000000000000),
  justification text NOT NULL CHECK (char_length(btrim(justification)) BETWEEN 10 AND 1000),
  evidence_ref text CHECK (evidence_ref IS NULL OR char_length(evidence_ref) <= 300),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exit_addback_sign CHECK (
    (kind = 'deduction' AND amount_cents < 0) OR (kind <> 'deduction' AND amount_cents > 0)
  )
);
CREATE INDEX IF NOT EXISTS idx_exit_addbacks_owner ON public.exit_addbacks(account_owner_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_exit_addbacks_touch ON public.exit_addbacks;
CREATE TRIGGER trg_exit_addbacks_touch BEFORE INSERT OR UPDATE ON public.exit_addbacks
  FOR EACH ROW EXECUTE FUNCTION public.exit_touch();

ALTER TABLE public.exit_addbacks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "exit_addbacks_owner_all" ON public.exit_addbacks;
CREATE POLICY "exit_addbacks_owner_all" ON public.exit_addbacks FOR ALL TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner());

-- =============================================================
-- 3. Monthly snapshots (KPI history + trends)
-- =============================================================
CREATE TABLE IF NOT EXISTS public.exit_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  period_month date NOT NULL CHECK (EXTRACT(day FROM period_month) = 1),
  readiness_score numeric(5,2) CHECK (readiness_score IS NULL OR (readiness_score >= 0 AND readiness_score <= 100)),
  value_low_cents bigint,
  value_point_cents bigint,
  value_high_cents bigint,
  driver_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_owner_id, period_month)
);

ALTER TABLE public.exit_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "exit_snapshots_owner_select" ON public.exit_snapshots;
CREATE POLICY "exit_snapshots_owner_select" ON public.exit_snapshots FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner());
-- Writes go through exit_save_snapshot() only.
REVOKE INSERT, UPDATE, DELETE ON public.exit_snapshots FROM anon, authenticated;

-- =============================================================
-- 4. Action states
-- =============================================================
CREATE TABLE IF NOT EXISTS public.exit_action_states (
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  action_key text NOT NULL CHECK (action_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'dismissed')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_owner_id, action_key)
);

DROP TRIGGER IF EXISTS trg_exit_action_states_touch ON public.exit_action_states;
CREATE TRIGGER trg_exit_action_states_touch BEFORE INSERT OR UPDATE ON public.exit_action_states
  FOR EACH ROW EXECUTE FUNCTION public.exit_touch();

ALTER TABLE public.exit_action_states ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "exit_action_states_owner_all" ON public.exit_action_states;
CREATE POLICY "exit_action_states_owner_all" ON public.exit_action_states FOR ALL TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner())
  WITH CHECK (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner());

-- =============================================================
-- 5. Data room: packages, links, access logs
-- =============================================================
CREATE TABLE IF NOT EXISTS public.exit_dataroom_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 2 AND 120),
  sections text[] NOT NULL CHECK (cardinality(sections) >= 1),
  include_names boolean NOT NULL DEFAULT false,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exit_packages_owner ON public.exit_dataroom_packages(account_owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.exit_dataroom_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES public.exit_dataroom_packages(id) ON DELETE CASCADE,
  account_owner_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES profiles(id) ON DELETE CASCADE,
  recipient_label text CHECK (recipient_label IS NULL OR char_length(recipient_label) <= 120),
  -- sha256 hex of the secret token. The token is generated in the browser, shown once, never stored.
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint text NOT NULL CHECK (char_length(token_hint) = 4),
  expires_at timestamptz NOT NULL,
  max_views integer NOT NULL DEFAULT 25 CHECK (max_views BETWEEN 1 AND 1000),
  view_count integer NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  last_viewed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exit_link_expiry CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_exit_links_owner ON public.exit_dataroom_links(account_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exit_links_package ON public.exit_dataroom_links(package_id);

CREATE TABLE IF NOT EXISTS public.exit_dataroom_access_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid REFERENCES public.exit_dataroom_links(id) ON DELETE CASCADE,
  account_owner_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  outcome text NOT NULL CHECK (outcome IN ('granted', 'expired', 'revoked', 'exhausted', 'invalid_token')),
  ip_hash text CHECK (ip_hash IS NULL OR char_length(ip_hash) <= 64),
  user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 200),
  accessed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exit_logs_owner ON public.exit_dataroom_access_logs(account_owner_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_exit_logs_link ON public.exit_dataroom_access_logs(link_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_exit_logs_ip ON public.exit_dataroom_access_logs(ip_hash, accessed_at DESC);

ALTER TABLE public.exit_dataroom_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exit_dataroom_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exit_dataroom_access_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "exit_packages_owner_select" ON public.exit_dataroom_packages;
CREATE POLICY "exit_packages_owner_select" ON public.exit_dataroom_packages FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner());
DROP POLICY IF EXISTS "exit_links_owner_select" ON public.exit_dataroom_links;
CREATE POLICY "exit_links_owner_select" ON public.exit_dataroom_links FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner());
DROP POLICY IF EXISTS "exit_logs_owner_select" ON public.exit_dataroom_access_logs;
CREATE POLICY "exit_logs_owner_select" ON public.exit_dataroom_access_logs FOR SELECT TO authenticated
  USING (account_owner_id = public.get_account_owner_id() AND public.exit_is_owner());

REVOKE ALL ON public.exit_dataroom_packages, public.exit_dataroom_links, public.exit_dataroom_access_logs FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.exit_dataroom_packages, public.exit_dataroom_links, public.exit_dataroom_access_logs FROM authenticated;
REVOKE ALL ON public.exit_readiness_settings, public.exit_addbacks, public.exit_snapshots, public.exit_action_states FROM anon;

-- =============================================================
-- 6. Metrics (value drivers) - computed from the account's own data
-- =============================================================
CREATE OR REPLACE FUNCTION public._exit_metrics(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_end date := current_date;
  v_start date := current_date - 364;
  v_month_start date := (date_trunc('month', current_date) - interval '11 months')::date;
  v_rev bigint := 0; v_exp bigint := 0; v_int bigint := 0; v_tax bigint := 0; v_da bigint := 0;
  v_months integer := 0;
  v_monthly jsonb := '[]'::jsonb;
  v_recurring bigint := 0;
  v_top1 numeric; v_top5 numeric; v_cust integer := 0;
  v_head integer := 0; v_tenure numeric; v_sep integer := 0;
  v_owner_email text;
  v_owner_share numeric;
  v_ar bigint := 0; v_inv bigint := 0;
  v_gm_rev numeric; v_gm_cost numeric; v_gm_cov numeric;
  v_by_service jsonb := '[]'::jsonb;
  v_sop integer := 0; v_cat integer := 0; v_staff integer := 0; v_acks integer := 0;
  v_cred_total integer := 0; v_cred_valid integer := 0; v_cred_exp integer := 0; v_cred_expired integer := 0;
  v_ins_total integer := 0; v_ins_valid integer := 0; v_gl boolean := false;
BEGIN
  -- Ledger: trailing 12 months of posted entries.
  SELECT
    coalesce(sum(CASE WHEN c.type = 'revenue' THEN jl.credit_cents - jl.debit_cents END), 0)::bigint,
    coalesce(sum(CASE WHEN c.type = 'expense' THEN jl.debit_cents - jl.credit_cents END), 0)::bigint,
    coalesce(sum(CASE WHEN c.type = 'expense' AND c.name ~* 'interest' THEN jl.debit_cents - jl.credit_cents END), 0)::bigint,
    coalesce(sum(CASE WHEN c.type = 'expense' AND c.name ~* '(income|corporate|federal|state)[ -]?tax' THEN jl.debit_cents - jl.credit_cents END), 0)::bigint,
    coalesce(sum(CASE WHEN c.type = 'expense' AND c.name ~* '(depreciation|amortization|amortisation)' THEN jl.debit_cents - jl.credit_cents END), 0)::bigint,
    count(DISTINCT date_trunc('month', je.entry_date))::integer
  INTO v_rev, v_exp, v_int, v_tax, v_da, v_months
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
    AND je.entry_date BETWEEN v_start AND v_end
  JOIN chart_of_accounts c ON c.id = jl.account_id AND c.user_id = p_owner
  WHERE je.user_id = p_owner AND c.type IN ('revenue', 'expense');

  SELECT coalesce(jsonb_agg(jsonb_build_object('month', to_char(s.m, 'YYYY-MM'), 'revenueCents', s.rev, 'expensesCents', s.exp_c) ORDER BY s.m), '[]'::jsonb)
  INTO v_monthly
  FROM (
    SELECT date_trunc('month', je.entry_date)::date AS m,
      coalesce(sum(CASE WHEN c.type = 'revenue' THEN jl.credit_cents - jl.debit_cents END), 0)::bigint AS rev,
      coalesce(sum(CASE WHEN c.type = 'expense' THEN jl.debit_cents - jl.credit_cents END), 0)::bigint AS exp_c
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
      AND je.entry_date >= v_month_start AND je.entry_date <= v_end
    JOIN chart_of_accounts c ON c.id = jl.account_id AND c.user_id = p_owner
    WHERE je.user_id = p_owner AND c.type IN ('revenue', 'expense')
    GROUP BY 1
  ) s;

  -- Recurring revenue: annualised active memberships.
  SELECT coalesce(sum(CASE WHEN pl.billing_interval = 'monthly' THEN pl.price_cents::bigint * 12 ELSE pl.price_cents::bigint END), 0)::bigint
  INTO v_recurring
  FROM memberships m
  JOIN membership_plans pl ON pl.id = m.plan_id
  WHERE m.user_id = p_owner AND m.status = 'active';

  -- Customer concentration: trailing-12-month invoiced revenue (ex tax) by customer.
  SELECT
    max(CASE WHEN r.rn = 1 THEN r.s END) / NULLIF(sum(r.s), 0),
    sum(CASE WHEN r.rn <= 5 THEN r.s END) / NULLIF(sum(r.s), 0),
    count(*)::integer
  INTO v_top1, v_top5, v_cust
  FROM (
    SELECT g.s, row_number() OVER (ORDER BY g.s DESC) AS rn
    FROM (
      SELECT coalesce(i.customer_id::text, 'inv:' || i.id::text) AS k, sum(i.subtotal_cents)::numeric AS s
      FROM ar_invoices i
      WHERE i.user_id = p_owner AND i.status NOT IN ('draft', 'void') AND i.issue_date BETWEEN v_start AND v_end
      GROUP BY 1
    ) g
    WHERE g.s > 0
  ) r;

  -- Workforce (employees): tenure from the date added; turnover = deactivated in 12 months.
  SELECT
    count(*) FILTER (WHERE e.active)::integer,
    avg(extract(epoch FROM (now() - e.created_at)) / 31557600.0) FILTER (WHERE e.active),
    count(*) FILTER (WHERE NOT e.active AND e.updated_at >= now() - interval '12 months')::integer
  INTO v_head, v_tenure, v_sep
  FROM employees e
  WHERE e.user_id = p_owner;

  -- Owner dependence: completed-job revenue with no technician or the owner as technician.
  SELECT lower(u.email) INTO v_owner_email FROM auth.users u WHERE u.id = p_owner;
  SELECT
    sum(CASE WHEN tm.id IS NULL OR lower(tm.member_email) = v_owner_email THEN jp.revenue_cents ELSE 0 END)::numeric
      / NULLIF(sum(jp.revenue_cents), 0)
  INTO v_owner_share
  FROM job_profitability jp
  LEFT JOIN team_members tm ON tm.id = jp.assigned_technician_id
  WHERE jp.user_id = p_owner AND jp.job_status = 'completed' AND jp.revenue_cents > 0
    AND jp.scheduled_datetime >= now() - interval '12 months';

  -- DSO.
  SELECT
    coalesce(sum(i.total_cents - i.amount_paid_cents) FILTER (WHERE i.status IN ('sent', 'partially_paid', 'overdue')), 0)::bigint,
    coalesce(sum(i.total_cents) FILTER (WHERE i.issue_date BETWEEN v_start AND v_end), 0)::bigint
  INTO v_ar, v_inv
  FROM ar_invoices i
  WHERE i.user_id = p_owner AND i.status NOT IN ('draft', 'void');

  -- Gross margin (only jobs that have cost entries).
  SELECT
    sum(jp.revenue_cents) FILTER (WHERE jp.cost_entry_count > 0)::numeric,
    sum(jp.total_cost_cents) FILTER (WHERE jp.cost_entry_count > 0)::numeric,
    count(*) FILTER (WHERE jp.cost_entry_count > 0)::numeric / NULLIF(count(*), 0)
  INTO v_gm_rev, v_gm_cost, v_gm_cov
  FROM job_profitability jp
  WHERE jp.user_id = p_owner AND jp.job_status = 'completed' AND jp.revenue_cents > 0
    AND jp.scheduled_datetime >= now() - interval '12 months';

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'service', s.service, 'revenueCents', s.rev, 'costCents', s.cost, 'jobs', s.jobs,
      'marginPct', CASE WHEN s.rev > 0 THEN round(((s.rev - s.cost) * 100.0) / s.rev, 1) END
    ) ORDER BY s.rev DESC), '[]'::jsonb)
  INTO v_by_service
  FROM (
    SELECT coalesce(nullif(btrim(jp.service_type), ''), 'Unspecified') AS service,
      sum(jp.revenue_cents)::bigint AS rev, sum(jp.total_cost_cents)::bigint AS cost, count(*)::integer AS jobs
    FROM job_profitability jp
    WHERE jp.user_id = p_owner AND jp.job_status = 'completed' AND jp.revenue_cents > 0
      AND jp.cost_entry_count > 0 AND jp.scheduled_datetime >= now() - interval '12 months'
    GROUP BY 1
    ORDER BY sum(jp.revenue_cents) DESC
    LIMIT 12
  ) s;

  -- Documentation: published SOPs + acknowledgements on the current version.
  SELECT count(*)::integer, count(DISTINCT d.category)::integer
  INTO v_sop, v_cat
  FROM sop_documents d
  WHERE d.user_id = p_owner AND d.status = 'published';

  SELECT count(*)::integer INTO v_staff
  FROM team_members t WHERE t.account_owner_id = p_owner AND t.invite_status = 'active';

  SELECT count(*)::integer INTO v_acks
  FROM sop_acknowledgements a
  JOIN sop_documents d ON d.id = a.sop_id AND d.status = 'published' AND d.published_version = a.version
  WHERE a.user_id = p_owner;

  -- Licences and insurance.
  SELECT
    count(*) FILTER (WHERE c.status <> 'revoked')::integer,
    count(*) FILTER (WHERE c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at >= current_date))::integer,
    count(*) FILTER (WHERE c.status = 'active' AND c.expires_at >= current_date AND c.expires_at < current_date + 90)::integer,
    count(*) FILTER (WHERE c.status <> 'revoked' AND c.expires_at < current_date)::integer
  INTO v_cred_total, v_cred_valid, v_cred_exp, v_cred_expired
  FROM technician_credentials c
  WHERE c.user_id = p_owner;

  SELECT
    count(*) FILTER (WHERE p.status = 'active')::integer,
    count(*) FILTER (WHERE p.status = 'active' AND p.expires_at >= current_date)::integer,
    coalesce(bool_or(p.status = 'active' AND p.expires_at >= current_date AND p.policy_type = 'general_liability'), false)
  INTO v_ins_total, v_ins_valid, v_gl
  FROM technician_insurance_policies p
  WHERE p.account_owner_id = p_owner;

  RETURN jsonb_build_object(
    'generatedAt', now(),
    'ledgerMonths', v_months,
    'financials', jsonb_build_object(
      'revenueCents', v_rev, 'expensesCents', v_exp, 'interestCents', v_int,
      'taxCents', v_tax, 'daCents', v_da, 'monthly', v_monthly),
    'recurringShare', CASE WHEN v_rev > 0 THEN least(1, v_recurring::numeric / v_rev) END,
    'recurringAnnualCents', v_recurring,
    'concentration', jsonb_build_object('top1', v_top1, 'top5', v_top5, 'customers', v_cust),
    'workforce', jsonb_build_object(
      'headcount', v_head,
      'avgTenureYears', CASE WHEN v_head > 0 THEN round(v_tenure, 2) END,
      'turnoverRate', CASE WHEN v_head + v_sep > 0 THEN round(v_sep::numeric / (v_head + v_sep), 4) END),
    'ownerDependence', jsonb_build_object('revenueShare', v_owner_share),
    'dso', CASE WHEN v_inv > 0 THEN round(greatest(v_ar, 0)::numeric / v_inv * 365, 1) END,
    'arOpenCents', greatest(v_ar, 0),
    'margin', jsonb_build_object(
      'overall', CASE WHEN v_gm_rev > 0 THEN round((v_gm_rev - v_gm_cost) / v_gm_rev, 4) END,
      'coveragePct', v_gm_cov,
      'byService', v_by_service),
    'documentation', jsonb_build_object(
      'published', v_sop, 'categories', v_cat,
      'ackRate', CASE WHEN v_sop > 0 AND v_staff > 0 THEN least(1, v_acks::numeric / (v_sop * v_staff)) END),
    'compliance', jsonb_build_object(
      'credentialsTotal', v_cred_total, 'credentialsValid', v_cred_valid,
      'credentialsExpiring', v_cred_exp, 'credentialsExpired', v_cred_expired,
      'insuranceTotal', v_ins_total, 'insuranceValid', v_ins_valid, 'hasGeneralLiability', v_gl)
  );
END;
$$;

REVOKE ALL ON FUNCTION public._exit_metrics(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.exit_get_metrics()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public._exit_metrics(public._exit_owner());
END;
$$;

REVOKE ALL ON FUNCTION public.exit_get_metrics() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_get_metrics() TO authenticated;

-- =============================================================
-- 7. Snapshots (owner saves the month's computed view)
-- =============================================================
CREATE OR REPLACE FUNCTION public.exit_save_snapshot(
  p_period date,
  p_score numeric,
  p_low bigint,
  p_point bigint,
  p_high bigint,
  p_driver_scores jsonb,
  p_metrics jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._exit_owner();
  v_month date := date_trunc('month', coalesce(p_period, current_date))::date;
  v_id uuid;
BEGIN
  IF p_score IS NOT NULL AND (p_score < 0 OR p_score > 100) THEN
    RAISE EXCEPTION 'score out of range' USING ERRCODE = '22023';
  END IF;
  IF v_month > current_date THEN
    RAISE EXCEPTION 'cannot snapshot a future month' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(coalesce(p_driver_scores, '{}'::jsonb)) <> 'object' OR jsonb_typeof(coalesce(p_metrics, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'driver scores and metrics must be JSON objects' USING ERRCODE = '22023';
  END IF;
  IF octet_length(coalesce(p_metrics, '{}'::jsonb)::text) > 200000 THEN
    RAISE EXCEPTION 'metrics too large' USING ERRCODE = '22023';
  END IF;

  INSERT INTO exit_snapshots (account_owner_id, period_month, readiness_score, value_low_cents, value_point_cents, value_high_cents, driver_scores, metrics)
  VALUES (v_owner, v_month, p_score, p_low, p_point, p_high, coalesce(p_driver_scores, '{}'::jsonb), coalesce(p_metrics, '{}'::jsonb))
  ON CONFLICT (account_owner_id, period_month) DO UPDATE SET
    readiness_score = EXCLUDED.readiness_score,
    value_low_cents = EXCLUDED.value_low_cents,
    value_point_cents = EXCLUDED.value_point_cents,
    value_high_cents = EXCLUDED.value_high_cents,
    driver_scores = EXCLUDED.driver_scores,
    metrics = EXCLUDED.metrics
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.exit_save_snapshot(date, numeric, bigint, bigint, bigint, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_save_snapshot(date, numeric, bigint, bigint, bigint, jsonb, jsonb) TO authenticated;

-- =============================================================
-- 8. Data room package builder (frozen content, no customer PII)
-- =============================================================
CREATE OR REPLACE FUNCTION public._exit_build_package(
  p_owner uuid,
  p_sections text[],
  p_include_names boolean,
  p_valuation jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_metrics jsonb := public._exit_metrics(p_owner);
  v_sections jsonb := '{}'::jsonb;
  v_part jsonb;
  v_part2 jsonb;
BEGIN
  IF 'financials' = ANY (p_sections) THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'accountCode', x.code, 'accountName', x.name, 'type', x.type, 'balanceCents', x.bal) ORDER BY x.type, x.code), '[]'::jsonb)
    INTO v_part
    FROM (
      SELECT c.code, c.name, c.type,
        CASE WHEN c.normal_balance = 'debit' THEN coalesce(sum(jl.debit_cents - jl.credit_cents), 0)
             ELSE coalesce(sum(jl.credit_cents - jl.debit_cents), 0) END::bigint AS bal
      FROM chart_of_accounts c
      JOIN journal_lines jl ON jl.account_id = c.id
      JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted' AND je.entry_date <= current_date
      WHERE c.user_id = p_owner AND c.type IN ('asset', 'liability', 'equity')
      GROUP BY c.id, c.code, c.name, c.type, c.normal_balance
    ) x
    WHERE x.bal <> 0;

    SELECT coalesce(jsonb_agg(jsonb_build_object('bucket', b.bucket, 'balanceCents', b.bal, 'invoices', b.n) ORDER BY b.bucket), '[]'::jsonb)
    INTO v_part2
    FROM (
      SELECT CASE
          WHEN current_date <= i.due_date THEN 'current'
          WHEN current_date - i.due_date <= 30 THEN '1-30'
          WHEN current_date - i.due_date <= 60 THEN '31-60'
          WHEN current_date - i.due_date <= 90 THEN '61-90'
          ELSE '90+' END AS bucket,
        sum(i.total_cents - i.amount_paid_cents)::bigint AS bal, count(*)::integer AS n
      FROM ar_invoices i
      WHERE i.user_id = p_owner AND i.status IN ('sent', 'partially_paid', 'overdue') AND i.total_cents > i.amount_paid_cents
      GROUP BY 1
    ) b;

    v_sections := v_sections || jsonb_build_object('financials', jsonb_build_object(
      'trailingTwelveMonths', v_metrics -> 'financials',
      'balanceSheet', v_part,
      'receivablesAging', v_part2));
  END IF;

  IF 'kpis' = ANY (p_sections) THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'month', to_char(s.period_month, 'YYYY-MM'), 'readinessScore', s.readiness_score,
        'valueLowCents', s.value_low_cents, 'valuePointCents', s.value_point_cents, 'valueHighCents', s.value_high_cents,
        'driverScores', s.driver_scores) ORDER BY s.period_month), '[]'::jsonb)
    INTO v_part
    FROM exit_snapshots s WHERE s.account_owner_id = p_owner;
    v_sections := v_sections || jsonb_build_object('kpis', jsonb_build_object(
      'current', v_metrics - 'financials', 'history', v_part));
  END IF;

  IF 'contracts' = ANY (p_sections) THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'name', k.contract_name, 'type', k.contract_type, 'status', k.status,
        'startDate', k.start_date, 'endDate', k.end_date, 'autoRenew', k.auto_renew,
        'billingFrequency', k.billing_frequency, 'valueCents', k.contract_value_cents,
        'hasSignedDocument', k.document_url IS NOT NULL) ORDER BY k.end_date NULLS LAST), '[]'::jsonb)
    INTO v_part
    FROM (SELECT * FROM commercial_contracts WHERE user_id = p_owner AND status <> 'draft' ORDER BY created_at DESC LIMIT 200) k;
    v_sections := v_sections || jsonb_build_object('contracts', v_part);
  END IF;

  IF 'equipment' = ANY (p_sections) THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'equipmentType', q.equipment_type, 'units', q.units, 'avgAgeYears', q.avg_age,
        'underWarranty', q.warranted) ORDER BY q.units DESC), '[]'::jsonb)
    INTO v_part
    FROM (
      SELECT e.equipment_type, count(*)::integer AS units,
        round(avg(extract(epoch FROM (now() - e.install_date::timestamptz)) / 31557600.0)::numeric, 1) AS avg_age,
        count(*) FILTER (WHERE e.warranty_expires_at >= current_date)::integer AS warranted
      FROM equipment e
      WHERE e.user_id = p_owner AND e.status = 'active'
      GROUP BY e.equipment_type
    ) q;
    v_sections := v_sections || jsonb_build_object('equipment', v_part);
  END IF;

  IF 'credentials' = ANY (p_sections) THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'holder', CASE WHEN p_include_names THEN coalesce(h.member_name, h.member_email) ELSE 'Technician ' || h.rn END,
        'type', h.credential_type, 'name', h.credential_name, 'authority', h.issuing_authority,
        'expiresAt', h.expires_at, 'status', h.status) ORDER BY h.rn, h.credential_type), '[]'::jsonb)
    INTO v_part
    FROM (
      SELECT c.credential_type, c.credential_name, c.issuing_authority, c.expires_at, c.status,
        t.member_name, t.member_email,
        dense_rank() OVER (ORDER BY c.technician_id) AS rn
      FROM technician_credentials c
      LEFT JOIN team_members t ON t.id = c.technician_id
      WHERE c.user_id = p_owner AND c.status <> 'revoked'
    ) h;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'holder', CASE WHEN p_include_names THEN coalesce(h.member_name, h.member_email) ELSE 'Technician ' || h.rn END,
        'policyType', h.policy_type, 'carrier', h.carrier, 'coverageCents', h.coverage_amount_cents,
        'expiresAt', h.expires_at, 'status', h.status) ORDER BY h.rn, h.policy_type), '[]'::jsonb)
    INTO v_part2
    FROM (
      SELECT p.policy_type, p.carrier, p.coverage_amount_cents, p.expires_at, p.status,
        t.member_name, t.member_email,
        dense_rank() OVER (ORDER BY p.technician_id) AS rn
      FROM technician_insurance_policies p
      LEFT JOIN team_members t ON t.id = p.technician_id
      WHERE p.account_owner_id = p_owner AND p.status = 'active'
    ) h;

    v_sections := v_sections || jsonb_build_object('credentials', jsonb_build_object(
      'licences', v_part, 'insurance', v_part2));
  END IF;

  IF 'valuation' = ANY (p_sections) AND p_valuation IS NOT NULL THEN
    v_sections := v_sections || jsonb_build_object('valuation', p_valuation);
  END IF;

  RETURN jsonb_build_object(
    'generatedAt', now(),
    'disclaimer', 'Estimates only. Not a valuation, appraisal, tax, legal or financial advice. Prepared by the business owner from the business''s own records; not independently verified.',
    'sections', v_sections
  );
END;
$$;

REVOKE ALL ON FUNCTION public._exit_build_package(uuid, text[], boolean, jsonb) FROM PUBLIC, anon, authenticated;

-- =============================================================
-- 9. Create / revoke data-room links (owner)
-- =============================================================
CREATE OR REPLACE FUNCTION public.exit_create_data_room(
  p_label text,
  p_sections text[],
  p_recipient text,
  p_expires_hours integer,
  p_max_views integer,
  p_include_names boolean,
  p_valuation jsonb,
  p_token_hash text,
  p_token_hint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._exit_owner();
  v_allowed text[] := ARRAY['financials', 'kpis', 'contracts', 'equipment', 'credentials', 'valuation'];
  v_content jsonb;
  v_package uuid;
  v_link uuid;
  v_expires timestamptz;
BEGIN
  IF p_label IS NULL OR char_length(btrim(p_label)) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'Name the data room (2-120 characters).' USING ERRCODE = '22023';
  END IF;
  IF p_sections IS NULL OR cardinality(p_sections) < 1 OR NOT (p_sections <@ v_allowed) THEN
    RAISE EXCEPTION 'Choose at least one valid section.' USING ERRCODE = '22023';
  END IF;
  IF p_expires_hours IS NULL OR p_expires_hours NOT BETWEEN 1 AND 720 THEN
    RAISE EXCEPTION 'Links last between 1 hour and 30 days.' USING ERRCODE = '22023';
  END IF;
  IF p_max_views IS NULL OR p_max_views NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Choose between 1 and 1000 views.' USING ERRCODE = '22023';
  END IF;
  IF p_recipient IS NOT NULL AND char_length(p_recipient) > 120 THEN
    RAISE EXCEPTION 'Recipient label too long.' USING ERRCODE = '22023';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_token_hint IS NULL OR char_length(p_token_hint) <> 4 THEN
    RAISE EXCEPTION 'Invalid link token.' USING ERRCODE = '22023';
  END IF;
  IF p_valuation IS NOT NULL AND (jsonb_typeof(p_valuation) <> 'object' OR octet_length(p_valuation::text) > 50000) THEN
    RAISE EXCEPTION 'Invalid estimate summary.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM exit_dataroom_links l
      WHERE l.account_owner_id = v_owner AND l.revoked_at IS NULL AND l.expires_at > now()) >= 25 THEN
    RAISE EXCEPTION 'You already have 25 active links. Revoke one first.' USING ERRCODE = '53400';
  END IF;

  v_content := public._exit_build_package(v_owner, p_sections, coalesce(p_include_names, false), p_valuation);
  IF octet_length(v_content::text) > 4000000 THEN
    RAISE EXCEPTION 'Package is too large. Share fewer sections.' USING ERRCODE = '54000';
  END IF;

  INSERT INTO exit_dataroom_packages (account_owner_id, label, sections, include_names, content)
  VALUES (v_owner, btrim(p_label), p_sections, coalesce(p_include_names, false), v_content)
  RETURNING id INTO v_package;

  v_expires := now() + make_interval(hours => p_expires_hours);
  INSERT INTO exit_dataroom_links (package_id, account_owner_id, recipient_label, token_hash, token_hint, expires_at, max_views)
  VALUES (v_package, v_owner, nullif(btrim(coalesce(p_recipient, '')), ''), p_token_hash, p_token_hint, v_expires, p_max_views)
  RETURNING id INTO v_link;

  RETURN jsonb_build_object('linkId', v_link, 'packageId', v_package, 'expiresAt', v_expires);
END;
$$;

REVOKE ALL ON FUNCTION public.exit_create_data_room(text, text[], text, integer, integer, boolean, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_create_data_room(text, text[], text, integer, integer, boolean, jsonb, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.exit_revoke_link(p_link_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public._exit_owner();
  v_rows integer;
BEGIN
  UPDATE exit_dataroom_links
  SET revoked_at = now()
  WHERE id = p_link_id AND account_owner_id = v_owner AND revoked_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Link not found or already revoked.' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.exit_revoke_link(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exit_revoke_link(uuid) TO authenticated;

-- =============================================================
-- 10. Public buyer access (service_role only; called by exit-dataroom-public)
-- =============================================================
CREATE OR REPLACE FUNCTION public.exit_dataroom_open(p_token_hash text, p_ip_hash text, p_user_agent text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link exit_dataroom_links%ROWTYPE;
  v_content jsonb;
  v_label text;
  v_outcome text;
  v_ua text := left(coalesce(p_user_agent, ''), 200);
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('outcome', 'invalid_token');
  END IF;

  -- Rate limit per caller (hashed IP): 30 attempts / 10 minutes.
  IF p_ip_hash IS NOT NULL AND (
    SELECT count(*) FROM exit_dataroom_access_logs
    WHERE ip_hash = p_ip_hash AND accessed_at > now() - interval '10 minutes'
  ) >= 30 THEN
    RETURN jsonb_build_object('outcome', 'rate_limited');
  END IF;

  SELECT * INTO v_link FROM exit_dataroom_links WHERE token_hash = p_token_hash FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO exit_dataroom_access_logs (link_id, account_owner_id, outcome, ip_hash, user_agent)
    VALUES (NULL, NULL, 'invalid_token', left(p_ip_hash, 64), nullif(v_ua, ''));
    RETURN jsonb_build_object('outcome', 'invalid_token');
  END IF;

  IF v_link.revoked_at IS NOT NULL THEN
    v_outcome := 'revoked';
  ELSIF v_link.expires_at <= now() THEN
    v_outcome := 'expired';
  ELSIF v_link.view_count >= v_link.max_views THEN
    v_outcome := 'exhausted';
  ELSE
    v_outcome := 'granted';
  END IF;

  INSERT INTO exit_dataroom_access_logs (link_id, account_owner_id, outcome, ip_hash, user_agent)
  VALUES (v_link.id, v_link.account_owner_id, v_outcome, left(p_ip_hash, 64), nullif(v_ua, ''));

  IF v_outcome <> 'granted' THEN
    RETURN jsonb_build_object('outcome', v_outcome);
  END IF;

  UPDATE exit_dataroom_links
  SET view_count = view_count + 1, last_viewed_at = now()
  WHERE id = v_link.id;

  SELECT p.content, p.label INTO v_content, v_label FROM exit_dataroom_packages p WHERE p.id = v_link.package_id;

  RETURN jsonb_build_object(
    'outcome', 'granted',
    'label', v_label,
    'expiresAt', v_link.expires_at,
    'viewsRemaining', v_link.max_views - v_link.view_count - 1,
    'content', v_content
  );
END;
$$;

REVOKE ALL ON FUNCTION public.exit_dataroom_open(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.exit_dataroom_open(text, text, text) TO service_role;
