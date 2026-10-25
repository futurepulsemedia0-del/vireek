/*
  # Operating Cadence Engine (/dashboard/cadence)

  Weekly management system: scorecard (auto-populated from real data) with
  owner-defined targets, quarterly priorities, issues list, accountability
  chart, weekly meetings (frozen agenda, timer, notes, action items -> tasks).

  ## Access model (enforced here, not just in the UI)
  - Everything is scoped to the account: user_id = public.get_account_owner_id().
  - "Manager" = account owner, or a team member whose effective can_view_all_jobs
    is true (custom role overrides base flag, same as AuthContext).
  - Financial metrics (revenue, margin, DSO) additionally need can_view_billing.
    They are masked server-side in cadence_scorecard() and hidden by RLS in
    cadence_snapshots / cadence_targets for everyone else.
  - Managers write everything. Other members can read, escalate issues, and
    update status of priorities/issues they own.

  ## Data sources (metrics computed in SQL, one definition, no client math)
  calls (is_voicemail, status, booking_outcome), invoices, review_requests,
  journal_* ledger, team_members + jobs. Each metric is isolated: if a source
  table/column is missing the metric is NULL instead of the whole call failing.

  Soft dependencies (added only when present): strategic_goals, tasks.
*/

-- ---------------------------------------------------------------------------
-- Permission helpers (mirror AuthContext: custom role overrides base flag)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cadence_has_perm(p_perm text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND p_perm IN ('can_view_all_jobs', 'can_view_billing')
    AND (
      NOT EXISTS (SELECT 1 FROM team_members m WHERE m.user_id = auth.uid())
      OR EXISTS (
        SELECT 1
        FROM team_members m
        LEFT JOIN custom_roles cr ON cr.id = m.custom_role_id
        WHERE m.user_id = auth.uid()
          AND COALESCE(
            (cr.permissions ->> p_perm)::boolean,
            (m.permissions ->> p_perm)::boolean,
            false
          )
      )
    );
$$;

REVOKE ALL ON FUNCTION public.cadence_has_perm(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.cadence_can_manage()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT public.cadence_has_perm('can_view_all_jobs'); $$;

CREATE OR REPLACE FUNCTION public.cadence_can_view_financials()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT public.cadence_has_perm('can_view_billing'); $$;

REVOKE ALL ON FUNCTION public.cadence_can_manage() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cadence_can_view_financials() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cadence_can_manage() TO authenticated;
GRANT EXECUTE ON FUNCTION public.cadence_can_view_financials() TO authenticated;

CREATE OR REPLACE FUNCTION public.cadence_is_financial(p_key text)
RETURNS boolean LANGUAGE sql IMMUTABLE
AS $$ SELECT p_key IN ('revenue', 'margin', 'dso'); $$;

CREATE OR REPLACE FUNCTION public.cadence_valid_tz(p text)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p IS NULL OR char_length(btrim(p)) = 0 THEN RETURN 'UTC'; END IF;
  PERFORM now() AT TIME ZONE p;
  RETURN p;
EXCEPTION WHEN OTHERS THEN
  RETURN 'UTC';
END;
$$;

-- Invoice total in cents from the line_items jsonb (defensive against bad shapes).
CREATE OR REPLACE FUNCTION public.cadence_invoice_total_cents(p_items jsonb, p_tax numeric)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT round(
    COALESCE((
      SELECT sum(
        CASE
          WHEN (e ->> 'quantity') ~ '^-?[0-9]+(\.[0-9]+)?$'
           AND (e ->> 'unit_price_cents') ~ '^-?[0-9]+(\.[0-9]+)?$'
          THEN (e ->> 'quantity')::numeric * (e ->> 'unit_price_cents')::numeric
          ELSE 0
        END)
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END
      ) AS e
    ), 0) * (1 + COALESCE(p_tax, 0) / 100)
  )::bigint;
$$;

-- ---------------------------------------------------------------------------
-- Settings (timezone defines week boundaries; one row per account)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cadence_settings (
  user_id uuid PRIMARY KEY DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'UTC' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.cadence_settings_before_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.timezone := public.cadence_valid_tz(NEW.timezone);
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN NEW.user_id := OLD.user_id; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_cadence_settings_before_write ON public.cadence_settings;
CREATE TRIGGER trigger_cadence_settings_before_write
  BEFORE INSERT OR UPDATE ON public.cadence_settings
  FOR EACH ROW EXECUTE FUNCTION public.cadence_settings_before_write();

ALTER TABLE public.cadence_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cadence_settings_select" ON public.cadence_settings;
CREATE POLICY "cadence_settings_select" ON public.cadence_settings
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "cadence_settings_insert" ON public.cadence_settings;
CREATE POLICY "cadence_settings_insert" ON public.cadence_settings
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.cadence_can_manage());

DROP POLICY IF EXISTS "cadence_settings_update" ON public.cadence_settings;
CREATE POLICY "cadence_settings_update" ON public.cadence_settings
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.cadence_can_manage())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.cadence_can_manage());

-- ---------------------------------------------------------------------------
-- Targets (owner-defined, per metric)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cadence_targets (
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  metric_key text NOT NULL CHECK (metric_key IN
    ('calls_answered', 'booked_rate', 'revenue', 'margin', 'dso', 'csat', 'utilization')),
  target_value numeric NOT NULL CHECK (target_value >= 0 AND target_value <= 1000000000000),
  direction text NOT NULL DEFAULT 'higher' CHECK (direction IN ('higher', 'lower')),
  updated_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, metric_key)
);

CREATE OR REPLACE FUNCTION public.cadence_targets_before_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  IF TG_OP = 'UPDATE' THEN NEW.user_id := OLD.user_id; NEW.metric_key := OLD.metric_key; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_cadence_targets_before_write ON public.cadence_targets;
CREATE TRIGGER trigger_cadence_targets_before_write
  BEFORE INSERT OR UPDATE ON public.cadence_targets
  FOR EACH ROW EXECUTE FUNCTION public.cadence_targets_before_write();

ALTER TABLE public.cadence_targets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cadence_targets_select" ON public.cadence_targets;
CREATE POLICY "cadence_targets_select" ON public.cadence_targets
  FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (NOT public.cadence_is_financial(metric_key) OR public.cadence_can_view_financials())
  );

DROP POLICY IF EXISTS "cadence_targets_insert" ON public.cadence_targets;
CREATE POLICY "cadence_targets_insert" ON public.cadence_targets
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND public.cadence_can_manage()
    AND (NOT public.cadence_is_financial(metric_key) OR public.cadence_can_view_financials())
  );

DROP POLICY IF EXISTS "cadence_targets_update" ON public.cadence_targets;
CREATE POLICY "cadence_targets_update" ON public.cadence_targets
  FOR UPDATE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND public.cadence_can_manage()
    AND (NOT public.cadence_is_financial(metric_key) OR public.cadence_can_view_financials())
  )
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND public.cadence_can_manage()
    AND (NOT public.cadence_is_financial(metric_key) OR public.cadence_can_view_financials())
  );

DROP POLICY IF EXISTS "cadence_targets_delete" ON public.cadence_targets;
CREATE POLICY "cadence_targets_delete" ON public.cadence_targets
  FOR DELETE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND public.cadence_can_manage()
    AND (NOT public.cadence_is_financial(metric_key) OR public.cadence_can_view_financials())
  );

-- ---------------------------------------------------------------------------
-- Weekly snapshots (trend history). Written ONLY by cadence_capture_weeks().
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cadence_snapshots (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  week_start date NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  metric_key text NOT NULL CHECK (metric_key IN
    ('calls_answered', 'booked_rate', 'revenue', 'margin', 'dso', 'csat', 'utilization')),
  value numeric,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, week_start, metric_key)
);

ALTER TABLE public.cadence_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cadence_snapshots_select" ON public.cadence_snapshots;
CREATE POLICY "cadence_snapshots_select" ON public.cadence_snapshots
  FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (NOT public.cadence_is_financial(metric_key) OR public.cadence_can_view_financials())
  );

-- ---------------------------------------------------------------------------
-- Metric computation (internal). One week, one account, all 7 metrics.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cadence_compute_week(p_owner uuid, p_week_start date, p_tz text)
RETURNS TABLE (metric_key text, value numeric, detail jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from timestamptz := (p_week_start::timestamp AT TIME ZONE p_tz);
  v_to timestamptz := ((p_week_start + 7)::timestamp AT TIME ZONE p_tz);
  v_total integer; v_answered integer; v_opps integer; v_booked integer;
  v_rev bigint; v_lrev bigint; v_lexp bigint;
  v_ar bigint; v_sales bigint;
  v_csat numeric; v_csat_n integer;
  v_cap numeric; v_jobs integer;
BEGIN
  -- Calls answered + booked rate (same definitions as pilot_management).
  BEGIN
    SELECT count(*)::integer,
           count(*) FILTER (WHERE NOT (c.status = 'missed' OR c.is_voicemail))::integer,
           count(*) FILTER (WHERE c.booking_outcome IN ('booked', 'not_booked'))::integer,
           count(*) FILTER (WHERE c.booking_outcome = 'booked')::integer
      INTO v_total, v_answered, v_opps, v_booked
      FROM calls c
     WHERE c.user_id = p_owner AND c.call_datetime >= v_from AND c.call_datetime < v_to;
    metric_key := 'calls_answered'; value := v_answered;
    detail := jsonb_build_object('total', v_total); RETURN NEXT;
    metric_key := 'booked_rate';
    value := CASE WHEN v_opps > 0 THEN round(v_booked::numeric / v_opps * 100, 1) END;
    detail := jsonb_build_object('booked', v_booked, 'opportunities', v_opps); RETURN NEXT;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    metric_key := 'calls_answered'; value := NULL; detail := '{}'::jsonb; RETURN NEXT;
    metric_key := 'booked_rate'; value := NULL; detail := '{}'::jsonb; RETURN NEXT;
  END;

  -- Revenue = invoices paid in the week (cents).
  BEGIN
    SELECT COALESCE(sum(public.cadence_invoice_total_cents(i.line_items, i.tax_percent)), 0)::bigint
      INTO v_rev
      FROM invoices i
     WHERE i.user_id = p_owner AND i.status = 'paid'
       AND i.paid_at >= v_from AND i.paid_at < v_to;
    metric_key := 'revenue'; value := v_rev; detail := '{}'::jsonb; RETURN NEXT;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    metric_key := 'revenue'; value := NULL; detail := '{}'::jsonb; RETURN NEXT;
  END;

  -- Margin = (ledger revenue - ledger expense) / ledger revenue for the week.
  BEGIN
    SELECT COALESCE(sum(CASE WHEN c.type = 'revenue' THEN jl.credit_cents - jl.debit_cents END), 0)::bigint,
           COALESCE(sum(CASE WHEN c.type = 'expense' THEN jl.debit_cents - jl.credit_cents END), 0)::bigint
      INTO v_lrev, v_lexp
      FROM chart_of_accounts c
      JOIN journal_lines jl ON jl.account_id = c.id
      JOIN journal_entries je ON je.id = jl.journal_entry_id
       AND je.status = 'posted'
       AND je.entry_date >= p_week_start AND je.entry_date < p_week_start + 7
     WHERE c.user_id = p_owner AND c.type IN ('revenue', 'expense');
    metric_key := 'margin';
    value := CASE WHEN v_lrev > 0 THEN round((v_lrev - v_lexp)::numeric / v_lrev * 100, 1) END;
    detail := jsonb_build_object('revenue_cents', v_lrev, 'expense_cents', v_lexp); RETURN NEXT;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    metric_key := 'margin'; value := NULL; detail := '{}'::jsonb; RETURN NEXT;
  END;

  -- DSO = AR at week end / credit sales over trailing 90 days * 90.
  BEGIN
    SELECT COALESCE(sum(public.cadence_invoice_total_cents(i.line_items, i.tax_percent))
             FILTER (WHERE i.paid_at IS NULL OR i.paid_at >= v_to), 0)::bigint,
           COALESCE(sum(public.cadence_invoice_total_cents(i.line_items, i.tax_percent))
             FILTER (WHERE i.sent_at >= v_to - interval '90 days'), 0)::bigint
      INTO v_ar, v_sales
      FROM invoices i
     WHERE i.user_id = p_owner AND i.status IN ('sent', 'viewed', 'paid')
       AND i.sent_at IS NOT NULL AND i.sent_at < v_to;
    metric_key := 'dso';
    value := CASE WHEN v_sales > 0 THEN round(v_ar::numeric / v_sales * 90, 1) END;
    detail := jsonb_build_object('ar_cents', v_ar, 'sales_90d_cents', v_sales); RETURN NEXT;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    metric_key := 'dso'; value := NULL; detail := '{}'::jsonb; RETURN NEXT;
  END;

  -- CSAT = average rating (1-5) of completed review requests in the week.
  BEGIN
    SELECT avg(r.rating)::numeric, count(*)::integer
      INTO v_csat, v_csat_n
      FROM review_requests r
     WHERE r.user_id = p_owner AND r.status = 'completed' AND r.rating IS NOT NULL
       AND r.completed_at >= v_from AND r.completed_at < v_to;
    metric_key := 'csat';
    value := CASE WHEN v_csat_n > 0 THEN round(v_csat, 2) END;
    detail := jsonb_build_object('responses', v_csat_n); RETURN NEXT;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    metric_key := 'csat'; value := NULL; detail := '{}'::jsonb; RETURN NEXT;
  END;

  -- Utilization = assigned, non-cancelled jobs / (sum(max_jobs_per_day) * 5 days).
  BEGIN
    SELECT COALESCE(sum(m.max_jobs_per_day), 0)
      INTO v_cap
      FROM team_members m
     WHERE m.account_owner_id = p_owner AND m.invite_status = 'active'
       AND COALESCE(m.dispatch_enabled, false) AND m.max_jobs_per_day IS NOT NULL;
    SELECT count(*)::integer
      INTO v_jobs
      FROM jobs j
     WHERE j.user_id = p_owner AND j.job_status <> 'cancelled'
       AND j.assigned_technician_id IS NOT NULL
       AND j.scheduled_datetime >= v_from AND j.scheduled_datetime < v_to;
    metric_key := 'utilization';
    value := CASE WHEN v_cap > 0 THEN round(v_jobs::numeric / (v_cap * 5) * 100, 1) END;
    detail := jsonb_build_object('jobs', v_jobs, 'capacity', v_cap * 5); RETURN NEXT;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    metric_key := 'utilization'; value := NULL; detail := '{}'::jsonb; RETURN NEXT;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.cadence_compute_week(uuid, date, text) FROM PUBLIC, anon, authenticated;

-- Live scorecard for one week (Monday). Financial metrics masked server-side.
CREATE OR REPLACE FUNCTION public.cadence_scorecard(p_week_start date)
RETURNS TABLE (metric_key text, value numeric, detail jsonb, hidden boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_fin boolean := public.cadence_can_view_financials();
  v_tz text;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_week_start IS NULL OR EXTRACT(ISODOW FROM p_week_start) <> 1 THEN
    RAISE EXCEPTION 'invalid_week_start' USING ERRCODE = '22023';
  END IF;
  SELECT s.timezone INTO v_tz FROM cadence_settings s WHERE s.user_id = v_owner;
  v_tz := public.cadence_valid_tz(COALESCE(v_tz, 'UTC'));

  RETURN QUERY
  SELECT w.metric_key,
         CASE WHEN public.cadence_is_financial(w.metric_key) AND NOT v_fin THEN NULL ELSE w.value END,
         CASE WHEN public.cadence_is_financial(w.metric_key) AND NOT v_fin THEN '{}'::jsonb ELSE w.detail END,
         (public.cadence_is_financial(w.metric_key) AND NOT v_fin)
    FROM public.cadence_compute_week(v_owner, p_week_start, v_tz) w;
END;
$$;

REVOKE ALL ON FUNCTION public.cadence_scorecard(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cadence_scorecard(date) TO authenticated;

-- Captures the last N COMPLETED weeks (missing ones + refresh of the latest).
CREATE OR REPLACE FUNCTION public.cadence_capture_weeks(p_weeks integer DEFAULT 13)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := public.get_account_owner_id();
  v_tz text; v_today date; v_cur date; v_ws date;
  i integer; v_n integer := 0;
BEGIN
  IF auth.uid() IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.cadence_can_manage() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  p_weeks := LEAST(GREATEST(COALESCE(p_weeks, 13), 1), 26);

  SELECT s.timezone INTO v_tz FROM cadence_settings s WHERE s.user_id = v_owner;
  v_tz := public.cadence_valid_tz(COALESCE(v_tz, 'UTC'));
  v_today := (now() AT TIME ZONE v_tz)::date;
  v_cur := v_today - (EXTRACT(ISODOW FROM v_today)::integer - 1);

  FOR i IN 1..p_weeks LOOP
    v_ws := v_cur - 7 * i;
    IF i > 1 AND EXISTS (
      SELECT 1 FROM cadence_snapshots s WHERE s.user_id = v_owner AND s.week_start = v_ws
    ) THEN
      CONTINUE;
    END IF;
    INSERT INTO cadence_snapshots (user_id, week_start, metric_key, value, detail, captured_at)
    SELECT v_owner, v_ws, w.metric_key, w.value, w.detail, now()
      FROM public.cadence_compute_week(v_owner, v_ws, v_tz) w
    ON CONFLICT (user_id, week_start, metric_key)
    DO UPDATE SET value = EXCLUDED.value, detail = EXCLUDED.detail, captured_at = EXCLUDED.captured_at;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.cadence_capture_weeks(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cadence_capture_weeks(integer) TO authenticated;

-- Soft FK check for optional strategic_goals link (invoker => goal's own RLS).
CREATE OR REPLACE FUNCTION public.cadence_goal_visible(p_goal uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_goal IS NULL THEN RETURN true; END IF;
  IF to_regclass('public.strategic_goals') IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM public.strategic_goals g WHERE g.id = p_goal);
END;
$$;

GRANT EXECUTE ON FUNCTION public.cadence_goal_visible(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Quarterly priorities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cadence_priorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR char_length(description) <= 4000),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  owner_name text CHECK (owner_name IS NULL OR char_length(owner_name) <= 120),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'on_track' CHECK (status IN ('on_track', 'off_track', 'done')),
  progress_pct smallint NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  goal_id uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cadence_priorities_user_status ON public.cadence_priorities (user_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_cadence_priorities_owner ON public.cadence_priorities (owner_user_id) WHERE owner_user_id IS NOT NULL;

DO $$
BEGIN
  IF to_regclass('public.strategic_goals') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cadence_priorities_goal_fk'
  ) THEN
    ALTER TABLE public.cadence_priorities
      ADD CONSTRAINT cadence_priorities_goal_fk
      FOREIGN KEY (goal_id) REFERENCES public.strategic_goals(id) ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.cadence_priorities_before_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.title := btrim(NEW.title);
  IF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
    IF NOT public.cadence_can_manage() THEN
      -- Owners who are not managers may only report status/progress.
      NEW.title := OLD.title; NEW.description := OLD.description;
      NEW.owner_user_id := OLD.owner_user_id; NEW.owner_name := OLD.owner_name;
      NEW.due_date := OLD.due_date; NEW.goal_id := OLD.goal_id;
    END IF;
  END IF;
  IF NEW.status = 'done' THEN
    NEW.progress_pct := 100;
    NEW.completed_at := COALESCE(CASE WHEN TG_OP = 'UPDATE' THEN OLD.completed_at END, now());
  ELSE
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_cadence_priorities_before_write ON public.cadence_priorities;
CREATE TRIGGER trigger_cadence_priorities_before_write
  BEFORE INSERT OR UPDATE ON public.cadence_priorities
  FOR EACH ROW EXECUTE FUNCTION public.cadence_priorities_before_write();

ALTER TABLE public.cadence_priorities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cadence_priorities_select" ON public.cadence_priorities;
CREATE POLICY "cadence_priorities_select" ON public.cadence_priorities
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "cadence_priorities_insert" ON public.cadence_priorities;
CREATE POLICY "cadence_priorities_insert" ON public.cadence_priorities
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND created_by = auth.uid()
    AND public.cadence_can_manage()
    AND public.cadence_goal_visible(goal_id)
  );

DROP POLICY IF EXISTS "cadence_priorities_update" ON public.cadence_priorities;
CREATE POLICY "cadence_priorities_update" ON public.cadence_priorities
  FOR UPDATE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (public.cadence_can_manage() OR owner_user_id = auth.uid())
  )
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND (public.cadence_can_manage() OR owner_user_id = auth.uid())
    AND public.cadence_goal_visible(goal_id)
  );

DROP POLICY IF EXISTS "cadence_priorities_delete" ON public.cadence_priorities;
CREATE POLICY "cadence_priorities_delete" ON public.cadence_priorities
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.cadence_can_manage());

-- ---------------------------------------------------------------------------
-- Issues list
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cadence_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR char_length(description) <= 4000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'discussing', 'solved', 'dropped')),
  source_type text NOT NULL DEFAULT 'manual'
    CHECK (source_type IN ('manual', 'alert', 'kpi_miss', 'comment', 'next_best_action')),
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) <= 200),
  metric_key text CHECK (metric_key IS NULL OR metric_key IN
    ('calls_answered', 'booked_rate', 'revenue', 'margin', 'dso', 'csat', 'utilization')),
  impact_cents bigint CHECK (impact_cents IS NULL OR impact_cents BETWEEN 0 AND 100000000000),
  needs_decision boolean NOT NULL DEFAULT false,
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  owner_name text CHECK (owner_name IS NULL OR char_length(owner_name) <= 120),
  resolution text CHECK (resolution IS NULL OR char_length(resolution) <= 4000),
  solved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cadence_issues_user_status ON public.cadence_issues (user_id, status, created_at DESC);
-- Escalating the same alert/KPI miss/NBA twice can never create two live issues.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cadence_issues_one_live_per_source
  ON public.cadence_issues (user_id, source_type, source_ref)
  WHERE source_ref IS NOT NULL AND status IN ('open', 'discussing');

CREATE OR REPLACE FUNCTION public.cadence_issues_before_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.title := btrim(NEW.title);
  IF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
    IF NOT public.cadence_can_manage() THEN
      NEW.title := OLD.title; NEW.source_type := OLD.source_type; NEW.source_ref := OLD.source_ref;
      NEW.metric_key := OLD.metric_key; NEW.impact_cents := OLD.impact_cents;
      NEW.owner_user_id := OLD.owner_user_id; NEW.owner_name := OLD.owner_name;
    END IF;
  END IF;
  IF NEW.status IN ('solved', 'dropped') THEN
    NEW.solved_at := COALESCE(CASE WHEN TG_OP = 'UPDATE' THEN OLD.solved_at END, now());
  ELSE
    NEW.solved_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_cadence_issues_before_write ON public.cadence_issues;
CREATE TRIGGER trigger_cadence_issues_before_write
  BEFORE INSERT OR UPDATE ON public.cadence_issues
  FOR EACH ROW EXECUTE FUNCTION public.cadence_issues_before_write();

ALTER TABLE public.cadence_issues ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cadence_issues_select" ON public.cadence_issues;
CREATE POLICY "cadence_issues_select" ON public.cadence_issues
  FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (metric_key IS NULL OR NOT public.cadence_is_financial(metric_key) OR public.cadence_can_view_financials())
  );

DROP POLICY IF EXISTS "cadence_issues_insert" ON public.cadence_issues;
CREATE POLICY "cadence_issues_insert" ON public.cadence_issues
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND created_by = auth.uid()
    AND (metric_key IS NULL OR NOT public.cadence_is_financial(metric_key) OR public.cadence_can_view_financials())
  );

DROP POLICY IF EXISTS "cadence_issues_update" ON public.cadence_issues;
CREATE POLICY "cadence_issues_update" ON public.cadence_issues
  FOR UPDATE TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (public.cadence_can_manage() OR owner_user_id = auth.uid() OR created_by = auth.uid())
  )
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND (public.cadence_can_manage() OR owner_user_id = auth.uid() OR created_by = auth.uid())
  );

DROP POLICY IF EXISTS "cadence_issues_delete" ON public.cadence_issues;
CREATE POLICY "cadence_issues_delete" ON public.cadence_issues
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.cadence_can_manage());

-- ---------------------------------------------------------------------------
-- Accountability chart (seats)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cadence_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.cadence_seats(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  holder_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  holder_name text CHECK (holder_name IS NULL OR char_length(holder_name) <= 120),
  responsibilities text[] NOT NULL DEFAULT '{}' CHECK (cardinality(responsibilities) <= 12),
  metric_keys text[] NOT NULL DEFAULT '{}' CHECK (metric_keys <@ ARRAY[
    'calls_answered', 'booked_rate', 'revenue', 'margin', 'dso', 'csat', 'utilization']::text[]),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cadence_seats_user ON public.cadence_seats (user_id, sort_order);

CREATE OR REPLACE FUNCTION public.cadence_seats_before_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.title := btrim(NEW.title);
  IF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.parent_id = NEW.id THEN
      RAISE EXCEPTION 'seat_cycle' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.cadence_seats p WHERE p.id = NEW.parent_id AND p.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'invalid_parent' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (
      WITH RECURSIVE up(id, parent_id) AS (
        SELECT s.id, s.parent_id FROM public.cadence_seats s WHERE s.id = NEW.parent_id
        UNION
        SELECT s.id, s.parent_id FROM public.cadence_seats s JOIN up ON s.id = up.parent_id
      )
      SELECT 1 FROM up WHERE up.id = NEW.id
    ) THEN
      RAISE EXCEPTION 'seat_cycle' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_cadence_seats_before_write ON public.cadence_seats;
CREATE TRIGGER trigger_cadence_seats_before_write
  BEFORE INSERT OR UPDATE ON public.cadence_seats
  FOR EACH ROW EXECUTE FUNCTION public.cadence_seats_before_write();

ALTER TABLE public.cadence_seats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cadence_seats_select" ON public.cadence_seats;
CREATE POLICY "cadence_seats_select" ON public.cadence_seats
  FOR SELECT TO authenticated USING (user_id = public.get_account_owner_id());

DROP POLICY IF EXISTS "cadence_seats_insert" ON public.cadence_seats;
CREATE POLICY "cadence_seats_insert" ON public.cadence_seats
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_account_owner_id() AND public.cadence_can_manage());

DROP POLICY IF EXISTS "cadence_seats_update" ON public.cadence_seats;
CREATE POLICY "cadence_seats_update" ON public.cadence_seats
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.cadence_can_manage())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.cadence_can_manage());

DROP POLICY IF EXISTS "cadence_seats_delete" ON public.cadence_seats;
CREATE POLICY "cadence_seats_delete" ON public.cadence_seats
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.cadence_can_manage());

-- ---------------------------------------------------------------------------
-- Meetings + action items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cadence_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  week_start date NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  agenda jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(agenda) = 'array'),
  current_segment integer NOT NULL DEFAULT 0 CHECK (current_segment >= 0),
  segment_started_at timestamptz,
  segment_elapsed_ms jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(segment_elapsed_ms) = 'array'),
  attendee_user_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(attendee_user_ids) <= 100),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 20000),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  recap_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cadence_meetings_user ON public.cadence_meetings (user_id, started_at DESC);
-- Only one live meeting per account: a double click can't start two.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cadence_meetings_one_live
  ON public.cadence_meetings (user_id) WHERE status = 'in_progress';

CREATE OR REPLACE FUNCTION public.cadence_meetings_before_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.user_id := OLD.user_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.started_at := OLD.started_at;
    NEW.agenda := OLD.agenda;
    NEW.updated_at := now();
    IF OLD.status = 'completed' THEN
      NEW.status := 'completed';
      NEW.ended_at := OLD.ended_at;
    ELSIF NEW.status = 'completed' THEN
      NEW.ended_at := COALESCE(NEW.ended_at, now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_cadence_meetings_before_write ON public.cadence_meetings;
CREATE TRIGGER trigger_cadence_meetings_before_write
  BEFORE INSERT OR UPDATE ON public.cadence_meetings
  FOR EACH ROW EXECUTE FUNCTION public.cadence_meetings_before_write();

ALTER TABLE public.cadence_meetings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cadence_meetings_select" ON public.cadence_meetings;
CREATE POLICY "cadence_meetings_select" ON public.cadence_meetings
  FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    -- Agenda embeds dollar figures, so billing-restricted members only see recaps via email.
    AND public.cadence_can_manage()
  );

DROP POLICY IF EXISTS "cadence_meetings_insert" ON public.cadence_meetings;
CREATE POLICY "cadence_meetings_insert" ON public.cadence_meetings
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND created_by = auth.uid()
    AND public.cadence_can_manage()
  );

DROP POLICY IF EXISTS "cadence_meetings_update" ON public.cadence_meetings;
CREATE POLICY "cadence_meetings_update" ON public.cadence_meetings
  FOR UPDATE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.cadence_can_manage())
  WITH CHECK (user_id = public.get_account_owner_id() AND public.cadence_can_manage());

DROP POLICY IF EXISTS "cadence_meetings_delete" ON public.cadence_meetings;
CREATE POLICY "cadence_meetings_delete" ON public.cadence_meetings
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.cadence_can_manage());

CREATE TABLE IF NOT EXISTS public.cadence_action_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT public.get_account_owner_id() REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  meeting_id uuid NOT NULL REFERENCES public.cadence_meetings(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  owner_name text CHECK (owner_name IS NULL OR char_length(owner_name) <= 120),
  due_date date,
  task_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cadence_action_items_meeting ON public.cadence_action_items (meeting_id);
CREATE INDEX IF NOT EXISTS idx_cadence_action_items_user ON public.cadence_action_items (user_id, created_at DESC);

DO $$
BEGIN
  IF to_regclass('public.tasks') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cadence_action_items_task_fk'
  ) THEN
    ALTER TABLE public.cadence_action_items
      ADD CONSTRAINT cadence_action_items_task_fk
      FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;
  END IF;
END;
$$;

ALTER TABLE public.cadence_action_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cadence_action_items_select" ON public.cadence_action_items;
CREATE POLICY "cadence_action_items_select" ON public.cadence_action_items
  FOR SELECT TO authenticated
  USING (
    user_id = public.get_account_owner_id()
    AND (public.cadence_can_manage() OR owner_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "cadence_action_items_insert" ON public.cadence_action_items;
CREATE POLICY "cadence_action_items_insert" ON public.cadence_action_items
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = public.get_account_owner_id()
    AND created_by = auth.uid()
    AND public.cadence_can_manage()
    AND EXISTS (SELECT 1 FROM public.cadence_meetings m WHERE m.id = meeting_id)
  );

DROP POLICY IF EXISTS "cadence_action_items_delete" ON public.cadence_action_items;
CREATE POLICY "cadence_action_items_delete" ON public.cadence_action_items
  FOR DELETE TO authenticated
  USING (user_id = public.get_account_owner_id() AND public.cadence_can_manage());

-- Action item -> real task, atomically. SECURITY INVOKER: the tasks RLS applies.
CREATE OR REPLACE FUNCTION public.cadence_add_action_item(
  p_meeting_id uuid,
  p_title text,
  p_owner_user_id uuid,
  p_owner_name text,
  p_due date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_title text := btrim(COALESCE(p_title, ''));
  v_name text := NULLIF(left(btrim(COALESCE(p_owner_name, '')), 120), '');
  v_tz text;
  v_task uuid;
  v_id uuid;
BEGIN
  IF char_length(v_title) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_title' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cadence_meetings m WHERE m.id = p_meeting_id) THEN
    RAISE EXCEPTION 'meeting_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT s.timezone INTO v_tz FROM cadence_settings s WHERE s.user_id = public.get_account_owner_id();
  v_tz := public.cadence_valid_tz(COALESCE(v_tz, 'UTC'));

  IF to_regclass('public.tasks') IS NOT NULL THEN
    INSERT INTO public.tasks (title, description, assigned_to, assigned_to_name, priority, due_at)
    VALUES (
      v_title,
      'Action item from the weekly meeting.',
      p_owner_user_id,
      v_name,
      'normal',
      CASE WHEN p_due IS NULL THEN NULL ELSE ((p_due::timestamp + interval '17 hours') AT TIME ZONE v_tz) END
    )
    RETURNING id INTO v_task;
  END IF;

  INSERT INTO cadence_action_items (meeting_id, title, owner_user_id, owner_name, due_date, task_id)
  VALUES (p_meeting_id, v_title, p_owner_user_id, v_name, p_due, v_task)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cadence_add_action_item(uuid, text, uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cadence_add_action_item(uuid, text, uuid, text, date) TO authenticated;
